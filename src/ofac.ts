/**
 * @cliwant/mcp-sam-gov/ofac — OFAC denied-party sanctions screening (keyless).
 *
 * Why this exists (ADR-0034)
 * --------------------------
 * OFAC denied-party screening is legally REQUIRED on every federal
 * transaction/award (31 CFR ch. V; strict-liability civil penalties). The
 * server already wires SAM exclusions (`sam_check_exclusions`), but SAM
 * exclusions do NOT cover OFAC/BIS sanctions — a different list with a different
 * legal basis. This module closes that gap with ONE screening tool
 * (`ofac_screen_entity`) over OFAC's keyless bulk-download lists:
 *   - SDN.CSV        (primary Specially-Designated-Nationals names)
 *   - ALT.CSV        (SDN AKA / alternate names, joined to SDN by ent_num)
 *   - CONS_PRIM.CSV  (Consolidated non-SDN program primary names)
 *   - CONS_ALT.CSV   (Consolidated AKA names)
 *
 * ★ THE load-bearing SAFETY invariant — NEVER FAKE A "CLEAR"
 * ----------------------------------------------------------
 * A FALSE "no match / clear" could authorize an ILLEGAL transaction. Therefore:
 *   - `result` is `"potential_matches" | "no_name_match"` — NEVER "clear"
 *     (screening ≠ legal clearance; mirrors integrity.ts's never-"clear" gate).
 *   - A `no_name_match` is reachable ONLY when every REQUIRED list loaded,
 *     parsed, and passed its plausibility floor AND zero name matches at ANY
 *     quality were found. ANY fetch failure / SSRF reject / parse drift /
 *     floor-fail / empty-final-host THROWS a classified error — it is NEVER
 *     rendered as `no_name_match`.
 *
 * Doctrine reuse (do NOT edit those modules):
 *   - integrity.ts   — the normalized-name-match gate + never-"clear".
 *   - attachments.ts — the redirect-final-host SSRF revalidation + size guard.
 *   - gsa-csv.ts      — the exported RFC-4180 `parseRecordFields` (the private
 *                      record-assembler is REPLICATED here per M6; NO gsa-csv edit).
 *   - datasource.ts   — `throughGate` self-throttle + `driftError`.
 *   - coerce.ts        convention (`-0-`/""/"null" ⇒ null, never 0/"").
 *
 * SSRF (M4/M5): the legacy treasury.gov paths 2-hop-redirect
 * (treasury.gov → sanctionslistservice.ofac.treas.gov → GovCloud S3). We follow
 * the redirect (default cap) and fail-closed-allowlist ONLY the FINAL host — the
 * region-pinned GovCloud bucket. A commercial-partition squat of the same bucket
 * name (`…s3.amazonaws.com`) is REJECTED (no `us-gov` marker); an empty/hidden
 * final host is UNCONDITIONALLY rejected (OFAC always redirects — no
 * `!res.redirected` escape hatch). On any host reject we THROW `invalid_input`
 * and NEVER read the body.
 */

import { parseRecordFields } from "./gsa-csv.js";
import { throughGate, driftError } from "./datasource.js";
import { ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { withMeta, type MetaBundle } from "./meta.js";

// ─── Endpoints (compile-time CONSTANTS — no caller value ever on the wire) ──

/** The 4 keyless OFAC bulk-download lists (legacy treasury.gov paths). */
export const OFAC_URLS = {
  sdn: "https://www.treasury.gov/ofac/downloads/sdn.csv",
  alt: "https://www.treasury.gov/ofac/downloads/alt.csv",
  cons_prim: "https://www.treasury.gov/ofac/downloads/consolidated/cons_prim.csv",
  cons_alt: "https://www.treasury.gov/ofac/downloads/consolidated/cons_alt.csv",
} as const;

export type OfacListKey = keyof typeof OFAC_URLS;

/** Browser-ish UA — OFAC serves the keyless bulk files to a normal client. */
const OFAC_UA =
  "Mozilla/5.0 (compatible; @cliwant/mcp-sam-gov; +https://github.com/cliwant/mcp-sam-gov)";

/** Fetch timeout for a (multi-MB) list download. */
const FETCH_TIMEOUT_MS = 30_000;

/** Self-throttle: space consecutive OFAC fetches (one shared budget, 4 files). */
const OFAC_GATE_MIN_INTERVAL_MS = 250;

/**
 * Hard per-list read cap. SDN is ~5.6 MB today; this bounds memory and catches a
 * drifted giant (the 125 MB SDN_ADVANCED.XML is off-path but the guard is cheap)
 * while leaving SDN generous growth headroom. Applied to BOTH the declared
 * content-length (pre-check) AND the streamed read (abort past this bound), not
 * content-length alone (S3 §S3).
 */
const MAX_LIST_BYTES = 16 * 1024 * 1024;

/** Cache TTL — the lists update ~daily; a 6 h TTL serves a warm cache instantly. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * ★ M4 — the ONE allowed final host: the region-pinned OFAC GovCloud bucket.
 * The bucket NAME (`wc2h-sls-prod-public-published`) is registrable in the
 * COMMERCIAL AWS partition, so a bucket-prefix + `.amazonaws.com` check ALONE
 * would admit a `…s3.amazonaws.com` squat serving an attacker CSV (that omits
 * the target ⇒ false CLEAR). We therefore ALSO require the `.s3.us-gov-`
 * GovCloud region marker.
 */
export const OFAC_S3_HOST =
  "wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com";

/** Fail-closed final-host allowlist (M4). Empty host ⇒ false (M5, in caller). */
export function isOfacS3Host(host: string): boolean {
  if (!host) return false;
  if (host === OFAC_S3_HOST) return true;
  // At minimum: the pinned bucket prefix + the GovCloud region marker + the AWS
  // suffix (admits region/dualstack GovCloud host-forms; REJECTS the commercial
  // squat which lacks `.s3.us-gov-`).
  return (
    host.startsWith("wc2h-sls-prod-public-published.") &&
    host.includes(".s3.us-gov-") &&
    host.endsWith(".amazonaws.com")
  );
}

/** Per-list plausibility floors (M1) — two orders of magnitude apart. */
export const FLOORS: Record<OfacListKey, number> = {
  sdn: 10_000, // live ~19,143
  alt: 10_000, // live ~20,318
  cons_prim: 150, // live ~442 — MUST NOT share SDN's floor
  cons_alt: 300, // live ~1,072
};

/** Which schema each list uses. */
const LIST_KIND: Record<OfacListKey, "primary" | "alt"> = {
  sdn: "primary",
  alt: "alt",
  cons_prim: "primary",
  cons_alt: "alt",
};

/** Human list label surfaced on each match. */
const LIST_LABEL: Record<OfacListKey, "SDN" | "Consolidated"> = {
  sdn: "SDN",
  alt: "SDN",
  cons_prim: "Consolidated",
  cons_alt: "Consolidated",
};

/** Column counts: primary (SDN/CONS_PRIM) = 12; alt (ALT/CONS_ALT) = 5. */
const PRIMARY_COLS = 12;
const ALT_COLS = 5;

/** ent_num (column 0) is a non-negative integer by OFAC's spec — the shape anchor. */
const ENT_NUM_RE = /^\d+$/;

// ─── ★ H1 — the mandatory never-"clear" caveat (verbatim constant) ──────────

/**
 * Rides in `_meta.notes` on EVERY response (potential_matches AND no_name_match).
 * Kept verbatim so the fault suite can assert it. A screen is NOT a determination.
 */
export const OFAC_NOT_DETERMINATION_NOTE =
  "This screens OFAC's published SDN + Consolidated lists as-of the snapshot date below; it is NOT OFAC's official Sanctions List Search, NOT a compliance/blocking determination, and NOT legal advice. A potential_match requires human adjudication against OFAC's Sanctions List Search + counsel; a no_name_match means no name match was found IN THIS SNAPSHOT — it is NOT a clearance and does NOT prove a party is not sanctioned (transliterations, variants, and typos can miss a real hit).";

// ─── Value coercion (the `-0- ` sentinel ⇒ null, never ""/0) ────────────────

/** A parsed cell: trim; the `-0-`/`-0- ` sentinel and ""/whitespace ⇒ null. */
function cell(raw: string | undefined): string | null {
  if (raw === undefined || raw === null) return null;
  const t = raw.trim();
  if (t === "" || t === "-0-") return null;
  return t;
}

// ─── Normalized name match (mirror integrity.ts's normName gate) ────────────

/**
 * Normalize a name for matching: uppercase → strip punctuation → drop trailing
 * entity suffixes (LLC/INC/CORP/…) → collapse whitespace. Byte-for-byte the
 * integrity.ts doctrine, applied to the query AND every primary + AKA name.
 */
export function normName(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, " ")
    .replace(
      /\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC|PC)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim();
}

export type MatchQuality = "exact" | "strong" | "weak";

/** Whole-token list of a normalized (single-space-collapsed) name. */
function tokensOf(norm: string): string[] {
  if (norm === "") return [];
  return norm.split(" ").filter((t) => t.length > 0);
}

/**
 * Grade the match between a normalized query and a normalized index name.
 *   - exact:  the normalized strings are equal.
 *   - strong: one is a whole-token superset of the other, OR one normalized
 *             string contains the other (word-order / suffix noise).
 *   - weak:   ≥1 shared token of length ≥ 3 (the transliteration / common-name
 *             false-positive zone — a REVIEW candidate, never an assertion).
 *   - null:   no relationship.
 */
export function classifyMatch(
  queryNorm: string,
  entryNorm: string,
): MatchQuality | null {
  if (queryNorm === "" || entryNorm === "") return null;
  if (queryNorm === entryNorm) return "exact";
  const qt = tokensOf(queryNorm);
  const et = tokensOf(entryNorm);
  const eSet = new Set(et);
  const qSet = new Set(qt);
  const allQinE = qt.length > 0 && qt.every((t) => eSet.has(t));
  const allEinQ = et.length > 0 && et.every((t) => qSet.has(t));
  if (allQinE || allEinQ) return "strong";
  // Substring containment is "strong" ONLY when the CONTAINED (shorter) string is
  // a substantial fragment. Without a floor, a tiny sub-word substring graded
  // "strong" ("TS" ⊂ "WIDGETS", "IBB" ⊂ "QUIBBLEFARB", "D" ⊂ "WIDGETS") —
  // overstating confidence and flooding nearly every input with false "strong"
  // matches (alert fatigue). Whole-token containment is already handled above by
  // allQinE/allEinQ; this mid-word tier is for the space-stripped joined form and
  // must clear the same ≥3 bar the token "weak" tier uses — here a slightly higher
  // floor since a contiguous substring is a weaker signal than a shared whole token.
  if (
    Math.min(queryNorm.length, entryNorm.length) >= 5 &&
    (entryNorm.includes(queryNorm) || queryNorm.includes(entryNorm))
  ) {
    return "strong";
  }
  for (const t of qt) {
    if (t.length >= 3 && eSet.has(t)) return "weak";
  }
  return null;
}

const QUALITY_RANK: Record<MatchQuality, number> = { weak: 0, strong: 1, exact: 2 };

// ─── Parsed record types ────────────────────────────────────────────────────

export type OfacEntityType =
  | "individual"
  | "entity"
  | "vessel"
  | "aircraft"
  | null;

/** A parsed a.k.a./f.k.a./n.k.a. alias mined from a primary row's Remarks. */
type RemarksAka = { name: string; akaType: "aka" | "fka" | "nka" };

/** A parsed primary (SDN / CONS_PRIM) record. */
export type PrimaryRecord = {
  entNum: string;
  name: string;
  normName: string;
  /** Raw SDN_Type ("individual"/"vessel"/"aircraft"/entity/null). */
  type: OfacEntityType;
  /** true when `type` was INFERRED "entity" from a blank (`-0-`) type cell. */
  typeInferred: boolean;
  programs: string[];
  title: string | null;
  remarks: string | null;
  list: "SDN" | "Consolidated";
  remarksAkas: RemarksAka[];
};

/** A parsed alt (ALT / CONS_ALT) record. */
export type AltRecord = {
  entNum: string;
  altNum: string | null;
  akaType: "aka" | "fka" | "nka" | null;
  name: string;
  remarks: string | null;
  list: "SDN" | "Consolidated";
};

// ─── B1 + M6 — record assembler (RFC-4180, replicated from gsa-csv.ts) ───────

/**
 * ★ B1 — strip a trailing `0x1A` (SUB / EOF sentinel) byte and any terminal
 * newlines BEFORE record assembly, so the last genuine content row is not
 * followed by a bogus empty/`\r\n\x1a`-only record (which would trip the strict
 * column-count drift check → schema_drift on 100% of live cold loads).
 */
function stripTrailingSub(body: string): string {
  return body.replace(/[\r\n\x1a]+$/g, "");
}

/** Is a parsed record an empty (whitespace/sentinel-only) non-content row? */
function isEmptyRecord(fields: string[]): boolean {
  return fields.every((f) => f.trim() === "");
}

/**
 * ★ M6 — assemble physical lines into LOGICAL CSV records, correctly re-joining
 * a record whose quoted field (Remarks) contains a newline. Replicates
 * gsa-csv.ts's PRIVATE `makeRecordAssembler` using `parseRecordFields`' returned
 * `inQuotes` flag (NO gsa-csv edit). Empty content rows are skipped (B1).
 *
 * ★ SYMMETRIC-DRIFT — we pass `maxCol = cols` (12 primary / 5 alt), NOT `cols-1`.
 * `parseRecordFields` STOPS STORING fields past `maxCol` (while still scanning for
 * quote parity), so `cols-1` would CAP a too-many-columns row at exactly `cols`
 * stored fields — silently PASSING the downstream `rec.length !== cols` check on a
 * column-ADDITION drift (e.g. OFAC prepends a `record_id`: every row → cols+1
 * fields, SDN_Name shifts, and every real party screens as no_name_match = a
 * blanket false CLEAR). With `maxCol = cols`, a genuine `cols`-field row still
 * materializes exactly `cols` fields, but a >`cols`-field row materializes
 * `cols+1` fields → trips the drift check → schema_drift. The guard is now
 * symmetric (too-few AND too-many both THROW), honoring the "exactly N columns or
 * THROW" contract in BOTH directions.
 */
function assembleRecords(body: string, cols: number): string[][] {
  const maxCol = cols;
  const text = stripTrailingSub(body);
  const lines = text.split("\n");
  const records: string[][] = [];
  let pending: string | null = null;
  for (const line of lines) {
    const candidate: string = pending === null ? line : pending + "\n" + line;
    const res = parseRecordFields(candidate, maxCol);
    if (res.inQuotes) {
      // A newline fell inside a quoted field → keep accumulating this record.
      pending = candidate;
      continue;
    }
    pending = null;
    if (isEmptyRecord(res.fields)) continue; // B1 — not a genuine content row
    records.push(res.fields);
  }
  if (pending !== null) {
    const res = parseRecordFields(pending, maxCol);
    if (!isEmptyRecord(res.fields)) records.push(res.fields);
  }
  return records;
}

// ─── Field-level parsers ────────────────────────────────────────────────────

/** SDN_Type mapping. Blank (`-0-`) ⇒ "entity" (inferred, disclosed). */
function mapType(raw: string | null): { type: OfacEntityType; inferred: boolean } {
  if (raw === null) return { type: "entity", inferred: true };
  const t = raw.toLowerCase();
  if (t === "individual") return { type: "individual", inferred: false };
  if (t === "vessel") return { type: "vessel", inferred: false };
  if (t === "aircraft") return { type: "aircraft", inferred: false };
  if (t === "entity") return { type: "entity", inferred: false };
  return { type: null, inferred: false };
}

/** Bracket-split a Program cell (`CUBA] [SDNTK` ⇒ ["CUBA","SDNTK"]). [] never faked. */
function parsePrograms(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(/\]\s*\[|\[|\]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** ALT alt_type ("aka"/"fka"/"nka") → normalized, else null. */
function mapAltType(raw: string | null): "aka" | "fka" | "nka" | null {
  if (raw === null) return null;
  const t = raw.toLowerCase();
  if (t === "aka" || t === "a.k.a." || t === "a.k.a") return "aka";
  if (t === "fka" || t === "f.k.a." || t === "f.k.a") return "fka";
  if (t === "nka" || t === "n.k.a." || t === "n.k.a") return "nka";
  return null;
}

/**
 * ★ B2 — mine a primary row's free-text Remarks for embedded aliases: the
 * `a.k.a./f.k.a./n.k.a. '<name>'` (or `"<name>"`) markers. The flagship "BNC"
 * (a documented alias of BANCO NACIONAL DE CUBA) lives ONLY in SDN Remarks, NOT
 * in ALT.CSV — indexing these is the false-CLEAR blocker for such aliases.
 */
const REMARKS_AKA_RE = /\b([afn])\.k\.a\.\s*['"]([^'"]+)['"]/gi;

function parseRemarksAkas(remarks: string | null): RemarksAka[] {
  if (remarks === null) return [];
  const out: RemarksAka[] = [];
  REMARKS_AKA_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REMARKS_AKA_RE.exec(remarks)) !== null) {
    const marker = (m[1] ?? "").toLowerCase();
    const akaType = marker === "a" ? "aka" : marker === "f" ? "fka" : "nka";
    const name = (m[2] ?? "").trim();
    if (name.length > 0) out.push({ name, akaType });
  }
  return out;
}

// ─── List body parsers (strict column validation; no floor here) ────────────

/**
 * Parse a primary (SDN / CONS_PRIM) list body into records. Every genuine
 * content row MUST have exactly 12 columns — a short/drifted row THROWS
 * `schema_drift` (a truncated download or a drifted file must NEVER read as a
 * near-empty "clear"). HEADERLESS (S1): every record is indexed (no header-skip).
 */
export function parsePrimaryList(
  body: string,
  list: "SDN" | "Consolidated",
  label: string,
): PrimaryRecord[] {
  const records = assembleRecords(body, PRIMARY_COLS);
  const out: PrimaryRecord[] = [];
  let rowNo = 0;
  for (const rec of records) {
    rowNo++;
    if (rec.length !== PRIMARY_COLS) {
      throw driftError(
        label,
        `OFAC ${label} content row ${rowNo} has ${rec.length} column(s), expected exactly ${PRIMARY_COLS} — the download was truncated (too few) or the file schema drifted (a column added/removed, too many). Refusing to screen a drifted list (a truncated OR column-shifted parse must never read as a clear).`,
      );
    }
    // ★ Belt-and-suspenders shape assert: ent_num (column 0) is a non-negative
    // integer by OFAC's spec. A non-numeric column 0 on a genuine content row
    // means a leading-column INSERTION/REPLACEMENT shifted every field (which can
    // otherwise keep the field COUNT at `cols`) → schema_drift, never a false clear.
    const entRaw = (rec[0] ?? "").trim();
    if (!ENT_NUM_RE.test(entRaw)) {
      throw driftError(
        label,
        `OFAC ${label} content row ${rowNo} has a non-numeric ent_num ${JSON.stringify(entRaw)} in column 0 — the file schema drifted (a leading-column insertion/replacement shifts SDN_Name off index 1). Refusing to screen (a shifted parse must never read as a clear).`,
      );
    }
    const entNum = entRaw;
    const name = cell(rec[1]);
    if (name === null) continue; // a nameless row is not screenable
    const { type, inferred } = mapType(cell(rec[2]));
    const remarks = cell(rec[11]);
    out.push({
      entNum,
      name,
      normName: normName(name),
      type,
      typeInferred: inferred,
      programs: parsePrograms(cell(rec[3])),
      title: cell(rec[4]),
      remarks,
      list,
      remarksAkas: parseRemarksAkas(remarks),
    });
  }
  return out;
}

/**
 * Parse an alt (ALT / CONS_ALT) list body into records. Every genuine content
 * row MUST have exactly 5 columns — a drifted row THROWS `schema_drift`.
 * HEADERLESS (S1).
 */
export function parseAltList(
  body: string,
  list: "SDN" | "Consolidated",
  label: string,
): AltRecord[] {
  const records = assembleRecords(body, ALT_COLS);
  const out: AltRecord[] = [];
  let rowNo = 0;
  for (const rec of records) {
    rowNo++;
    if (rec.length !== ALT_COLS) {
      throw driftError(
        label,
        `OFAC ${label} content row ${rowNo} has ${rec.length} column(s), expected exactly ${ALT_COLS} — the download was truncated (too few) or the file schema drifted (a column added/removed, too many). Refusing to screen a drifted alias list (a truncated OR column-shifted parse would miss an AKA = a false clear).`,
      );
    }
    // ★ Shape assert (see parsePrimaryList): ent_num (column 0) is a non-negative
    // integer; a non-numeric column 0 means a leading-column shift → schema_drift.
    const entRaw = (rec[0] ?? "").trim();
    if (!ENT_NUM_RE.test(entRaw)) {
      throw driftError(
        label,
        `OFAC ${label} content row ${rowNo} has a non-numeric ent_num ${JSON.stringify(entRaw)} in column 0 — the alias file schema drifted (a leading-column shift). Refusing to screen (a shifted parse must never read as a clear).`,
      );
    }
    const name = cell(rec[3]);
    if (name === null) continue;
    out.push({
      entNum: entRaw,
      altNum: cell(rec[1]),
      akaType: mapAltType(cell(rec[2])),
      name,
      remarks: cell(rec[4]),
      list,
    });
  }
  return out;
}

// ─── The screenable name index (primary + AKA) ──────────────────────────────

export type MatchedVia = "primary" | "aka(alt)" | "aka(remarks)";

/** One screenable name entry (a primary name OR an alias) → its base party. */
export type NameEntry = {
  name: string;
  normName: string;
  matchedVia: MatchedVia;
  akaType: "aka" | "fka" | "nka" | null;
  base: PrimaryRecord;
};

/** A minimal base for an alt whose ent_num has no matching primary (recall-safe). */
function syntheticBase(alt: AltRecord): PrimaryRecord {
  return {
    entNum: alt.entNum,
    name: alt.name,
    normName: normName(alt.name),
    type: null,
    typeInferred: false,
    programs: [],
    title: null,
    remarks: alt.remarks,
    list: alt.list,
    remarksAkas: [],
  };
}

/** Build the primary + AKA name entries for ONE scope (primaries + its alts). */
export function buildScopeEntries(
  primaries: PrimaryRecord[],
  alts: AltRecord[],
): NameEntry[] {
  const byEnt = new Map<string, PrimaryRecord>();
  for (const p of primaries) {
    if (p.entNum !== "" && !byEnt.has(p.entNum)) byEnt.set(p.entNum, p);
  }
  const entries: NameEntry[] = [];
  for (const p of primaries) {
    entries.push({
      name: p.name,
      normName: p.normName,
      matchedVia: "primary",
      akaType: null,
      base: p,
    });
    for (const a of p.remarksAkas) {
      entries.push({
        name: a.name,
        normName: normName(a.name),
        matchedVia: "aka(remarks)",
        akaType: a.akaType,
        base: p,
      });
    }
  }
  for (const alt of alts) {
    const base = byEnt.get(alt.entNum) ?? syntheticBase(alt);
    entries.push({
      name: alt.name,
      normName: normName(alt.name),
      matchedVia: "aka(alt)",
      akaType: alt.akaType,
      base,
    });
  }
  return entries;
}

// ─── The match executor (pure — over a prebuilt entry list) ─────────────────

export type ScreenMatch = {
  name: string;
  matchedVia: MatchedVia;
  akaType: "aka" | "fka" | "nka" | null;
  matchQuality: MatchQuality;
  list: "SDN" | "Consolidated";
  programs: string[];
  type: OfacEntityType;
  entNum: string | null;
  title: string | null;
  remarks: string | null;
  typeInferred: boolean;
  ofacSearchUrl: string;
};

export type ScreenArgs = {
  name: string;
  type?: OfacEntityType;
  program?: string;
  minMatchQuality?: MatchQuality;
  limit?: number;
};

export type ScreenComputation = {
  result: "potential_matches" | "no_name_match";
  matchCount: number;
  returnedCount: number;
  suppressedCount: number;
  highestSuppressedQuality: MatchQuality | null;
  matches: ScreenMatch[];
  anyTypeInferred: boolean;
};

/**
 * ★ M2 — existence-first screening over a prebuilt name index.
 *
 * Matches are computed at the LOWEST (weak) quality FIRST, so `result` is
 * `potential_matches` whenever ≥1 name match exists at ANY quality — INDEPENDENT
 * of `minMatchQuality` and of the `type`/`program` post-filters. Those only trim
 * the RETURNED `matches[]`; when they suppress a match, `suppressedCount` and the
 * highest suppressed quality are disclosed. `result` is NEVER `no_name_match`
 * while a name match exists.
 */
export function computeScreen(
  entries: NameEntry[],
  args: ScreenArgs,
): ScreenComputation {
  const queryNorm = normName(args.name);
  const minQ = args.minMatchQuality ?? "weak";
  const minRank = QUALITY_RANK[minQ];
  const limit = Math.min(200, Math.max(1, Math.floor(args.limit ?? 50)));
  const typeFilter = args.type;
  const programFilter = args.program ? args.program.trim().toUpperCase() : null;

  type Scored = { entry: NameEntry; quality: MatchQuality };
  const all: Scored[] = [];
  for (const entry of entries) {
    const q = classifyMatch(queryNorm, entry.normName);
    if (q !== null) all.push({ entry, quality: q });
  }

  // Existence-first: matchCount is the TOTAL name matches at any quality, before
  // ANY of type / program / minMatchQuality trimming.
  const matchCount = all.length;

  // Trim the RETURNED set by type / program / minMatchQuality (disclosed).
  const passesType = (s: Scored) =>
    typeFilter === undefined || s.entry.base.type === typeFilter;
  const passesProgram = (s: Scored) =>
    programFilter === null ||
    s.entry.base.programs.some((p) => p.toUpperCase() === programFilter);
  const passesMinQ = (s: Scored) => QUALITY_RANK[s.quality] >= minRank;

  const returnedPool = all.filter(
    (s) => passesType(s) && passesProgram(s) && passesMinQ(s),
  );
  returnedPool.sort((a, b) => {
    if (QUALITY_RANK[b.quality] !== QUALITY_RANK[a.quality]) {
      return QUALITY_RANK[b.quality] - QUALITY_RANK[a.quality];
    }
    return a.entry.name.localeCompare(b.entry.name);
  });
  const returned = returnedPool.slice(0, limit);

  // The highest quality among the matches we did NOT return (min-quality OR
  // filter OR limit suppression) — so an AI knows what it is not seeing.
  const returnedSet = new Set(returned);
  let highestSuppressedQuality: MatchQuality | null = null;
  for (const s of all) {
    if (returnedSet.has(s)) continue;
    if (
      highestSuppressedQuality === null ||
      QUALITY_RANK[s.quality] > QUALITY_RANK[highestSuppressedQuality]
    ) {
      highestSuppressedQuality = s.quality;
    }
  }

  const matches: ScreenMatch[] = returned.map((s) => {
    const b = s.entry.base;
    return {
      name: s.entry.name,
      matchedVia: s.entry.matchedVia,
      akaType: s.entry.akaType,
      matchQuality: s.quality,
      list: b.list,
      programs: b.programs,
      type: b.type,
      entNum: b.entNum === "" ? null : b.entNum,
      title: b.title,
      remarks: b.remarks,
      typeInferred: b.typeInferred,
      ofacSearchUrl:
        b.entNum !== ""
          ? `https://sanctionssearch.ofac.treas.gov/Details.aspx?id=${encodeURIComponent(b.entNum)}`
          : "https://sanctionssearch.ofac.treas.gov/",
    };
  });

  return {
    result: matchCount > 0 ? "potential_matches" : "no_name_match",
    matchCount,
    returnedCount: matches.length,
    suppressedCount: matchCount - matches.length,
    highestSuppressedQuality,
    matches,
    anyTypeInferred: matches.some((m) => m.typeInferred),
  };
}

// ─── Fetch one list (SSRF-validated, size-capped, streamed) ─────────────────

/** A loaded + parsed list snapshot held in the module cache. */
type LoadedList<T> = {
  records: T[];
  fetchedAt: number;
  lastModified: string | null;
  pathDate: string | null;
};

/** Pull the `/YYYY-MM-DD/` snapshot-date segment out of the signed S3 path. */
function pathDateOf(url: string): string | null {
  const m = /\/(\d{4}-\d{2}-\d{2})\//.exec(url);
  return m ? (m[1] ?? null) : null;
}

/** Concatenate streamed chunks into one Uint8Array. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Read the response body with a HARD byte cap — abort past `maxBytes` rather
 * than trusting content-length alone (S3 §S3). Streams via `res.body` when
 * available (real S3), else falls back to `arrayBuffer()` + a post-read cap
 * (the offline fetch-mock, which exposes no stream). NEVER called until the
 * FINAL host passed the SSRF allowlist.
 */
async function readCappedBody(
  res: Response,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const tooBig = () =>
    new ToolErrorCarrier({
      kind: "invalid_input",
      message: `OFAC ${label} body exceeded the ${Math.round(maxBytes / 1048576)} MB read cap — refusing to buffer it (a drifted giant, not the ~7 MB bulk lists). Verify the pinned endpoint.`,
      retryable: false,
      upstreamEndpoint: label,
    });
  const body = (res as { body?: unknown }).body as
    | ReadableStream<Uint8Array>
    | null
    | undefined;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw tooBig();
        }
        chunks.push(value);
      }
    }
    return concatChunks(chunks, total);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw tooBig();
  return buf;
}

/**
 * Fetch ONE OFAC list. Order (S3): fetch(follow) → check status → validate the
 * FINAL host → size-check → THEN read (capped). Every failure THROWS a
 * classified error (never a fake empty).
 */
async function fetchListBody(
  url: string,
  label: string,
): Promise<{ body: string; lastModified: string | null; pathDate: string | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": OFAC_UA, Accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e) {
    // Network / timeout / abort ⇒ retryable OUTAGE (THROW — never no_name_match).
    throw new ToolErrorCarrier({
      kind: "upstream_unavailable",
      message: `Network error fetching OFAC ${label}: ${(e as Error).message}. The service is unavailable, NOT an empty list — retry (never read a fetch failure as a clear).`,
      retryable: true,
      retryAfterSeconds: 30,
      upstreamEndpoint: label,
    });
  }

  if (!res.ok) {
    // 404/429/5xx/4xx ⇒ the errors.ts taxonomy. A DOWN endpoint NEVER reads empty.
    throw new ToolErrorCarrier(errorFromResponse(res, label));
  }

  // ★ M4/M5 — re-validate the FINAL host (fail-closed). Compute it in try/catch
  // (→ "" on throw); accept ONLY when isOfacS3Host. An empty final host is
  // UNCONDITIONALLY rejected (OFAC always redirects — no `!res.redirected`
  // escape hatch). On rejection THROW invalid_input and NEVER read the body.
  const finalHost = (() => {
    try {
      return new URL(res.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (!isOfacS3Host(finalHost)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `OFAC ${label} redirected to an unexpected final host ${JSON.stringify(finalHost)} — refusing to read the body (SSRF: the final host must be OFAC's region-pinned GovCloud bucket ${OFAC_S3_HOST}). A bucket rotation manifests here as a loud, SAFE failure (never a fake clear) requiring a pinned-constant update.`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }

  // Size guard (content-length) BEFORE buffering — belt to the streamed cap.
  const declaredLen = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_LIST_BYTES) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `OFAC ${label} declares ${Math.round(declaredLen / 1048576)} MB, over this tool's ${Math.round(MAX_LIST_BYTES / 1048576)} MB per-list cap — refusing (a drifted giant, not the ~7 MB bulk lists).`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }

  const bytes = await readCappedBody(res, MAX_LIST_BYTES, label);
  const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  return {
    body,
    lastModified: res.headers.get("last-modified"),
    pathDate: pathDateOf(res.url),
  };
}

// ─── Module cache (per-list, TTL, single in-flight promise per list) ────────

const primaryCache = new Map<OfacListKey, LoadedList<PrimaryRecord>>();
const altCache = new Map<OfacListKey, LoadedList<AltRecord>>();
const inFlight = new Map<OfacListKey, Promise<void>>();

/** TEST-ONLY: drop the per-list caches so a fault case can re-point the mock. */
export function _resetOfacCacheForTests(): void {
  primaryCache.clear();
  altCache.clear();
  inFlight.clear();
  indexMemo.scope = null;
}

/**
 * Ensure ONE list is loaded, parsed, and above its floor. A warm cache within
 * TTL is served instantly; a past-TTL cache is refreshed but, if the refresh
 * FAILS while a prior (real) copy exists, the stale copy is kept (real data, not
 * a fabricated clear — disclosed via age). A COLD miss whose fetch fails THROWS.
 * A below-floor parse THROWS `schema_drift` (M1). Fetches route through the
 * shared `ofac` self-throttle gate.
 */
async function ensureList(key: OfacListKey): Promise<void> {
  const kind = LIST_KIND[key];
  const cached =
    kind === "primary" ? primaryCache.get(key) : altCache.get(key);
  if (cached && Date.now() - cached.fetchedAt <= CACHE_TTL_MS) return;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const load = (async () => {
    let fetched: {
      body: string;
      lastModified: string | null;
      pathDate: string | null;
    };
    try {
      fetched = await throughGate("ofac", OFAC_GATE_MIN_INTERVAL_MS, () =>
        fetchListBody(OFAC_URLS[key], `ofac:${key}`),
      );
    } catch (e) {
      // A refresh failure with a prior REAL copy → keep the stale copy (honest,
      // disclosed by age). A COLD miss → propagate the THROW (never a clear).
      if (cached) return;
      throw e;
    }

    const label = `ofac:${key}`;
    const floor = FLOORS[key];
    if (kind === "primary") {
      const records = parsePrimaryList(fetched.body, LIST_LABEL[key], label);
      if (records.length < floor) {
        throw driftError(
          label,
          `OFAC ${label} parsed ${records.length} row(s), below the plausibility floor of ${floor.toLocaleString()} — the download is truncated or drifted. Refusing to screen (a near-empty list must never read as a clear).`,
        );
      }
      primaryCache.set(key, {
        records,
        fetchedAt: Date.now(),
        lastModified: fetched.lastModified,
        pathDate: fetched.pathDate,
      });
    } else {
      const records = parseAltList(fetched.body, LIST_LABEL[key], label);
      if (records.length < floor) {
        throw driftError(
          label,
          `OFAC ${label} parsed ${records.length} alias row(s), below the plausibility floor of ${floor.toLocaleString()} — the download is truncated or drifted. Refusing to screen (missing aliases would be a false clear).`,
        );
      }
      altCache.set(key, {
        records,
        fetchedAt: Date.now(),
        lastModified: fetched.lastModified,
        pathDate: fetched.pathDate,
      });
    }
    indexMemo.scope = null; // the index must be rebuilt from the fresh list
  })();

  inFlight.set(key, load);
  try {
    await load;
  } finally {
    inFlight.delete(key);
  }
}

// ─── Scope resolution + index memo ──────────────────────────────────────────

export type ListArg = "sdn" | "consolidated" | "all";

/** The lists REQUIRED to screen a given `list` scope (M3 — all-or-throw). */
function requiredLists(list: ListArg): OfacListKey[] {
  if (list === "sdn") return ["sdn", "alt"];
  if (list === "consolidated") return ["cons_prim", "cons_alt"];
  return ["sdn", "alt", "cons_prim", "cons_alt"];
}

// One memoized built index per scope-signature (rebuilt when a list refreshes).
const indexMemo: {
  scope: ListArg | null;
  signature: string;
  entries: NameEntry[];
} = { scope: null, signature: "", entries: [] };

function scopeSignature(list: ListArg): string {
  return requiredLists(list)
    .map((k) => {
      const c =
        LIST_KIND[k] === "primary" ? primaryCache.get(k) : altCache.get(k);
      return `${k}:${c?.fetchedAt ?? 0}`;
    })
    .join("|");
}

/** Build (or reuse) the screenable index for a scope from the loaded lists. */
function indexForScope(list: ListArg): NameEntry[] {
  const sig = scopeSignature(list);
  if (indexMemo.scope === list && indexMemo.signature === sig) {
    return indexMemo.entries;
  }
  const entries: NameEntry[] = [];
  if (list === "sdn" || list === "all") {
    entries.push(
      ...buildScopeEntries(
        primaryCache.get("sdn")?.records ?? [],
        altCache.get("alt")?.records ?? [],
      ),
    );
  }
  if (list === "consolidated" || list === "all") {
    entries.push(
      ...buildScopeEntries(
        primaryCache.get("cons_prim")?.records ?? [],
        altCache.get("cons_alt")?.records ?? [],
      ),
    );
  }
  indexMemo.scope = list;
  indexMemo.signature = sig;
  indexMemo.entries = entries;
  return entries;
}

// ─── Freshness helpers ──────────────────────────────────────────────────────

function publishedDateOf(list: LoadedList<unknown> | undefined): string | null {
  if (!list) return null;
  if (list.pathDate) return list.pathDate;
  if (list.lastModified) {
    const t = Date.parse(list.lastModified);
    if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

// ─── The tool ───────────────────────────────────────────────────────────────

/** Runtime enum re-checks (defense-in-depth over the server's Zod enums). */
const VALID_TYPES = new Set(["individual", "entity", "vessel", "aircraft"]);
const VALID_LISTS = new Set(["sdn", "consolidated", "all"]);
const VALID_QUALITIES = new Set(["exact", "strong", "weak"]);

export type OfacScreenArgs = {
  name: string;
  type?: string;
  program?: string;
  list?: string;
  minMatchQuality?: string;
  limit?: number;
};

/**
 * ★ `ofac_screen_entity` — keyless OFAC denied-party name screening.
 *
 * NEVER FAKE A CLEAR: every fetch failure / SSRF reject / parse drift /
 * floor-fail THROWS; a `no_name_match` is reached ONLY when all required lists
 * loaded + passed floors AND zero matches at any quality. `result` is never
 * "clear".
 */
export async function screenEntity(
  args: OfacScreenArgs,
): Promise<MetaBundle<unknown>> {
  const name = (args.name ?? "").trim();
  if (name === "") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message:
        "ofac_screen_entity requires a non-empty `name` to screen (an empty screen is never a no-op clear).",
      retryable: false,
      upstreamEndpoint: "ofac",
    });
  }

  // Runtime enum re-checks — an off-enum value must be a loud invalid_input, not
  // a silently-accepted empty screen (the integrity.ts silent-accept trap).
  if (args.type !== undefined && !VALID_TYPES.has(args.type)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Unknown type '${args.type}'. Use one of: individual, entity, vessel, aircraft (or omit to screen all types).`,
      retryable: false,
      upstreamEndpoint: "ofac",
    });
  }
  const list = (args.list ?? "all") as ListArg;
  if (!VALID_LISTS.has(list)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Unknown list '${args.list}'. Use one of: sdn, consolidated, all (default all).`,
      retryable: false,
      upstreamEndpoint: "ofac",
    });
  }
  const minMatchQuality = (args.minMatchQuality ?? "weak") as MatchQuality;
  if (!VALID_QUALITIES.has(minMatchQuality)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Unknown minMatchQuality '${args.minMatchQuality}'. Use one of: exact, strong, weak (default weak).`,
      retryable: false,
      upstreamEndpoint: "ofac",
    });
  }

  // ★ M3 — every REQUIRED list loads-or-throws (fail-closed). A partial set / an
  // AKA list that failed to load is NEVER screened (an AKA-only hit would miss =
  // false clear). Loaded sequentially through the shared throttle gate.
  const needed = requiredLists(list);
  for (const key of needed) {
    await ensureList(key);
  }

  const entries = indexForScope(list);
  const comp = computeScreen(entries, {
    name,
    type: (args.type as OfacEntityType) ?? undefined,
    program: args.program,
    minMatchQuality,
    limit: args.limit,
  });

  // Freshness — the S3 last-modified / signed-path date, plus the cache age.
  const loadedCounts: Record<string, number> = {};
  let oldestFetchedAt = Infinity;
  let publishedDate: string | null = null;
  const listLabels: string[] = [];
  for (const key of needed) {
    const c =
      LIST_KIND[key] === "primary" ? primaryCache.get(key) : altCache.get(key);
    loadedCounts[key] = c?.records.length ?? 0;
    if (c) {
      oldestFetchedAt = Math.min(oldestFetchedAt, c.fetchedAt);
      publishedDate = publishedDate ?? publishedDateOf(c);
    }
    const lbl = LIST_LABEL[key];
    if (!listLabels.includes(lbl)) listLabels.push(lbl);
  }
  const fetchedAtMs = Number.isFinite(oldestFetchedAt)
    ? oldestFetchedAt
    : Date.now();
  const ageHours =
    Math.round(((Date.now() - fetchedAtMs) / 3_600_000) * 10) / 10;
  const cacheStale = Date.now() - fetchedAtMs > CACHE_TTL_MS;

  const snapshot = {
    publishedDate,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    ageHours,
    lists: listLabels,
    counts: {
      sdn: loadedCounts.sdn ?? null,
      alt: loadedCounts.alt ?? null,
      consolidatedPrimary: loadedCounts.cons_prim ?? null,
      consolidatedAlt: loadedCounts.cons_alt ?? null,
    },
  };

  const data = {
    query: {
      name,
      normalizedName: normName(name),
      type: args.type ?? null,
      program: args.program ?? null,
      list,
      minMatchQuality,
    },
    result: comp.result,
    matchCount: comp.matchCount,
    returnedCount: comp.returnedCount,
    suppressedCount: comp.suppressedCount,
    matches: comp.matches,
    snapshot,
  };

  // ── Honest _meta (the mandatory caveat rides on EVERY response) ──
  const notes: string[] = [OFAC_NOT_DETERMINATION_NOTE];
  notes.push(
    `Snapshot published ${publishedDate ?? "unknown"}; loaded ${ageHours}h ago (cache TTL 6h). Lists screened: ${listLabels.join(" + ")} — counts SDN ${snapshot.counts.sdn ?? "n/a"}, ALT ${snapshot.counts.alt ?? "n/a"}, Consolidated-primary ${snapshot.counts.consolidatedPrimary ?? "n/a"}, Consolidated-alt ${snapshot.counts.consolidatedAlt ?? "n/a"}.`,
  );
  if (cacheStale) {
    notes.push(
      `This snapshot is STALE (loaded ${ageHours}h ago, past the 6h TTL) — a refresh could not complete, so a previously-loaded copy was served. Re-run to refresh; do not treat a stale no_name_match as current.`,
    );
  }
  if (comp.result === "potential_matches") {
    notes.push(
      `${comp.matchCount} potential name match(es) found at some quality (exact/strong/weak). A weak/strong hit is a REVIEW CANDIDATE, not a confirmed match — OFAC name matching is inexact (transliterations, common names). Adjudicate every match against OFAC's Sanctions List Search (ofacSearchUrl) before acting.`,
    );
  } else {
    notes.push(
      "no_name_match: no name matched across the required list(s) IN THIS SNAPSHOT. This is NOT a clearance — OFAC publishes transliterations and low-quality variants this normalized screen cannot fully catch, and a very-new designation may post after the snapshot. It does not prove a party is not sanctioned.",
    );
  }
  if (comp.suppressedCount > 0) {
    notes.push(
      `${comp.suppressedCount} match(es) were found but NOT returned (trimmed by minMatchQuality='${minMatchQuality}', the type/program filter, or the limit). The highest suppressed match quality was '${comp.highestSuppressedQuality}'. Lower minMatchQuality, drop the type/program filter, or raise limit to see them — result already reflects that matches EXIST.`,
    );
  }
  if (comp.anyTypeInferred) {
    notes.push(
      "One or more matches have type='entity' INFERRED from a blank OFAC type field (OFAC leaves the type blank for organizations); it is not an explicitly-tagged type.",
    );
  }

  return withMeta(data, {
    source: `OFAC published SDN + Consolidated bulk lists (keyless) as-of ${publishedDate ?? "unknown"}`,
    keylessMode: true,
    complete: comp.suppressedCount === 0,
    truncated: comp.suppressedCount > 0,
    returned: comp.returnedCount,
    totalAvailable: comp.matchCount,
    filtersApplied: [
      `list(${list})`,
      `minMatchQuality(${minMatchQuality})`,
      ...(args.type ? [`type(${args.type})`] : []),
      ...(args.program ? [`program(${args.program})`] : []),
    ],
    filtersDropped: [],
    fieldsUnavailable: [],
    notes,
  });
}
