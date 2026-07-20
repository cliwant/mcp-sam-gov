/**
 * FDIC BankFind Suite — keyless FDIC-insured-institution directory + regulated-
 * entity financials (ADR-0028). The FIRST OFF-EDGAR entity source: an
 * FDIC-insured-institution directory (`/banks/institutions`) + quarterly
 * financial time-series (`/banks/financials`) for B2G counterparty / entity
 * due-diligence. Source 22 → 23; tool snapshot 87 → 89. Fully PUBLIC, KEYLESS —
 * no key param, no auth, no PII (institution NAME is an ORG name; the curated
 * projections exclude every officer/contact field).
 *
 * R2 consumer — reuses the shipped `DataSource` port EXACTLY like ckan.ts /
 * socrata.ts: `getJson` / `driftError` / `throughGate` (datasource.ts), `num`·
 * `str` (coerce.ts), `withMeta` / `buildMeta` (meta.ts). It writes ZERO fetch /
 * coercion / error / pagination code, and COPIES (does not import) the SSRF +
 * honesty PATTERN.
 *   Directory:  https://api.fdic.gov/banks/institutions?filters=…&search=…&fields=…
 *   Financials: https://api.fdic.gov/banks/financials?filters=CERT:<int>&fields=…
 *
 * SUCCESS envelope (live-verified 2026-07-13, SEC-style UA, HTTP 200 JSON):
 *   { "meta": { "total": <EXACT int>, "parameters": {…}, "index": { "name":…,
 *     "createTimestamp":… } }, "data": [ { "data": {<record>}, "score":… } ] }
 * `meta.total` is the EXACT match count, STABLE across `offset` (honest exact-
 * total pagination). Records are nested under `data[].data`. Two OTHER envelopes
 * exist: a QUERY-ERROR `{ "errors":[{status,detail}] }` (HTTP 400) and a
 * ROUTING `{ "message","statusCode" }` (HTTP 404) — both handled by the port's
 * taxonomy (they THROW before the drift-guard ever runs).
 *
 * ★ SSRF GUARD (policy① — the central design risk). Fixed host `api.fdic.gov`,
 * `https` only. The path is a FIXED endpoint constant the TOOL chooses
 * (`institutions` | `financials`) — NO caller value on the path. Every param
 * (`filters` / `search` / `fields` / `sort_by` / `sort_order` / `limit` /
 * `offset` / `format`) goes through URLSearchParams, built server-side from
 * allowlisted structured inputs with escaped values. Belt-and-suspenders builder
 * assertion (mirrors ckan/socrata): `new URL(url).hostname === "api.fdic.gov"`
 * and `protocol === "https:"` → else invalid_input. `limit`/`offset` are bounded
 * ints (no unbounded paging). `redirect:"error"` on every getJson (a future 3xx
 * off `api.fdic.gov` throws rather than being silently followed off-host).
 *
 * ★ HONESTY DESIGN (P1–P4; ADR §4 + the v2 review) — closing the landmines:
 *   (A/P4) filter-FIELD names are compile-time constants behind NAMED structured
 *     inputs; a caller can never supply a field name, so a typo'd field can never
 *     reach the wire as a false genuine-empty. Belt-and-suspenders: the builder
 *     asserts every emitted filter field ∈ its allowlist (institutions
 *     {STALP,ACTIVE,CERT}; financials {CERT}); every emitted SEARCH field ∈
 *     {NAME,CITY}; every sortBy ∈ the per-endpoint sort allowlist (a Set.has
 *     recheck behind the server's Zod enum) → an unknown sort field is
 *     invalid_input BEFORE fetch (live: `sort_by=NOTAFIELD` + a sort_order → HTTP
 *     400, so the pre-fetch guard is load-bearing).
 *   ★M1 (BLOCKER) — `name`/`city` route through FDIC's full-text `search` param,
 *     NOT `filters=NAME/CITY:"…"`. The `filters` DSL treats NAME/CITY as
 *     case-sensitive EXACT-keyword (live: `filters=NAME:"chase"` → total 0 — a
 *     confident false-empty), whereas `search=NAME:chase` is a case-insensitive
 *     full-text token match (live: 43) that combines cleanly with `filters` (live:
 *     `search=NAME:first` + `filters=STALP:VA AND ACTIVE:1` → 9). We emit BOTH
 *     `filters=` (STALP/ACTIVE/CERT) and `search=` (NAME/CITY) when present.
 *     Disclosed in `_meta.notes`.
 *   ★M2 (v2 fix — the search value is UNQUOTED) — the `search` term is built
 *     `NAME:<escaped>` (NO surrounding quotes). Quoting a single token makes FDIC
 *     run a `match_phrase` that COLLAPSES recall to zero for real brand-name banks
 *     (live: `NAME:"Axos"`→0 but `NAME:Axos`→1 — Axos Bank CERT 35546 exists), the
 *     exact M1 false-empty class. The value is instead backslash-escaped for the
 *     UNQUOTED Lucene reserved chars the char-class allows (`( ) & / -` + `\`; see
 *     escapeSearch) — belt-and-suspenders on the Zod-bypass path. The `search`
 *     param is provably non-injectable for WIDENING (default-AND token semantics —
 *     `OR`/`&&` never form a union; live: `NAME:zzz OR STALP:VA`→0), so no quotes
 *     are needed for security either.
 *   ★S1 — a multi-word name/city `search` value is matched PER-TOKEN by FDIC's
 *     full-text index (may be BROADER than a literal substring — a record sharing
 *     only ONE token can match; live: `search=NAME:First Community`→225 incl.
 *     "First State Bank"). We disclose this in `_meta.notes` whenever a name/city
 *     value contains a space.
 *   (P1) EXACT total → honest pagination: `totalAvailable = num(meta.total)`
 *     (stable across offset); `records = data.map(d => d.data)`; `hasMore =
 *     offset + returned < totalAvailable`; `nextOffset`. Via withMeta/buildMeta.
 *   (P2) 3-envelope drift-guard: require `meta` object AND `data` Array AND
 *     `typeof meta.total === "number"` → else driftError (rejects the errors[] /
 *     message+statusCode shapes at HTTP 200). A non-JSON 200 body (json parse
 *     throw) → reclassified to driftError. The ONLY honest empty = HTTP 200 +
 *     `meta.total:0` + `data:[]` → returned:0, totalAvailable:0, complete:true.
 *     Everything else THROWS — never a fake-empty.
 *   (P3) $thousands→USD ×1000, null-never-0: FDIC publishes ASSET/DEP/NETINC in
 *     $thousands; `assetUSD = num(rec.ASSET) === null ? null : num(rec.ASSET) *
 *     1000` (the null-guard PRECEDES the ×1000, so an absent value stays null,
 *     never 0). Disclosed in `_meta.notes`. CERT/REPDTE/ACTIVE via `num`;
 *     NAME/CITY/STALP/ID/ESTYMD via `str`.
 *   (B) Returned-fields disclosure: the union of keys across `data[].data`; any
 *     projected field absent from ALL records (when returned > 0) →
 *     `_meta.fieldsUnavailable` + a note (a field FDIC silently stops returning
 *     surfaces instead of vanishing).
 *   Snapshot-freshness: `meta.index.{name,createTimestamp}` → `_meta.notes`
 *     ("point-in-time snapshot, not a live-this-second read"; the institutions
 *     and financials indexes carry DIFFERENT snapshot times).
 *
 * ★ A1 — provenance `source` is set INLINE in each tool's withMeta partial (like
 * ckan.ts). There is NO `fdic_` branch in server.ts's synthesizeDefaultMeta (both
 * tools return a MetaBundle, so that switch is never consulted — it would be dead
 * code shipping blank provenance).
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError, throughGate } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js) so
// the fault suite's num-parity guard resolves fdic.num === coerce.num, exactly
// like ckan.num / socrata.num.
export { num };

// ─── Constants (SSRF core) ─────────────────────────────────────────
const FDIC_HOST = "api.fdic.gov";
// One host = one rate budget. ~5 req/s; conservative — FDIC publishes no hard
// ceiling, so stay polite. The gate label is host-only (getJson contract).
const FDIC_MIN_INTERVAL_MS = 200;
const LABEL = "fdic:" + FDIC_HOST; // → ToolError.upstreamEndpoint (host-only)
// The throughGate KEY — host-scoped so BOTH endpoints share one rate budget.
const GATE_KEY = "fdic";

// Fixed endpoint constants — the TOOL chooses these; NO caller value on the path.
const ENDPOINT_INSTITUTIONS = "institutions";
const ENDPOINT_FINANCIALS = "financials";

// Fixed field projections (every field live-verified valid → none silently
// dropped by a typo). The output maps each to a typed key.
const INST_FIELDS = "NAME,CITY,STALP,CERT,ASSET,ACTIVE,ESTYMD,ID";
const FIN_FIELDS = "CERT,REPDTE,ASSET,DEP,NETINC,ID";
// The raw FDIC field names, for the returned-fields (B) disclosure.
const INST_PROJECTION = [
  "NAME",
  "CITY",
  "STALP",
  "CERT",
  "ASSET",
  "ACTIVE",
  "ESTYMD",
  "ID",
] as const;
const FIN_PROJECTION = ["CERT", "REPDTE", "ASSET", "DEP", "NETINC", "ID"] as const;

// Filter-FIELD allowlists (P4 belt-and-suspenders). NAME/CITY are NOT here — they
// route through `search` (M1). These fields carry only constrained non-string
// values (STALP a 2-letter code, ACTIVE 0/1, CERT an int) so they need no quoting.
const INST_FILTER_FIELDS: ReadonlySet<string> = new Set(["STALP", "ACTIVE", "CERT"]);
const FIN_FILTER_FIELDS: ReadonlySet<string> = new Set(["CERT"]);
// SEARCH-FIELD allowlist (M1) — free-text NAME/CITY only (phrase-quoted + escaped).
const INST_SEARCH_FIELDS: ReadonlySet<string> = new Set(["NAME", "CITY"]);
// sortBy allowlists (mirror the server's Zod enums; a Set.has recheck in the
// builder → an unknown sort field is invalid_input BEFORE fetch).
const INST_SORT_FIELDS: ReadonlySet<string> = new Set([
  "NAME",
  "CERT",
  "ASSET",
  "ESTYMD",
  "STALP",
  "CITY",
  "ACTIVE",
]);
const FIN_SORT_FIELDS: ReadonlySet<string> = new Set([
  "REPDTE",
  "ASSET",
  "DEP",
  "NETINC",
]);

// ─── Value escaping + builders (SSRF / injection discipline) ───────

/**
 * ★M2 (v2 fix) — escape an UNQUOTED `search` value: backslash FIRST (so a
 * pre-existing `\` becomes a literal `\\` and we never double-process the escapes
 * we add), then backslash-escape the Lucene reserved chars the char-class ALLOWS
 * and that are meaningful UNQUOTED — grouping `(` `)`, the boolean-forming `&`
 * (`&&`), the regex delimiter `/`, and the prefix/NOT operator `-`. There are NO
 * surrounding quotes: FDIC's `search` treats a quoted single token as a
 * `match_phrase` that COLLAPSES recall to ZERO for real brand-name banks (live:
 * `NAME:"Axos"`→0 but `NAME:Axos`→1) — the exact M1 false-empty class this design
 * exists to prevent. Quotes are also gratuitous for security: the SSRF review
 * proved the `search` param is non-injectable for WIDENING (default-AND token
 * semantics — `OR`/`&&` never form a union; live: `NAME:zzz OR STALP:VA`→0 vs
 * STALP:VA→5998), and a field-pivot needs `:`, which the Zod char-class rejects.
 * So this escape is belt-and-suspenders for the Zod-bypass path (`:` and `"` are
 * char-class-rejected on the validated path). Live-verified 2026-07-13 that the
 * escape preserves recall (`Farmers & Merchants`→181, `First-Citizens`→85,
 * `Mizuho Bank \(USA\)`→1). Exported for the direct-builder fault fixture.
 */
export function escapeSearch(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/[()&/\-]/g, "\\$&");
}

/** The filter-field allowlists, exported so the fault suite can drive the
 *  belt-and-suspenders field-guard directly (the tool functions only ever pass
 *  hardcoded fields, so this defense-in-depth check is otherwise unreachable). */
export { INST_FILTER_FIELDS, FIN_FILTER_FIELDS, INST_SEARCH_FIELDS };

/** A `filters` term `FIELD:VALUE` — asserts the field ∈ its allowlist (P4). A
 *  NON-NUMERIC value is DOUBLE-QUOTED; a numeric value stays bare. This quoting is
 *  LOAD-BEARING for correctness: the FDIC `filters` DSL is Lucene-style, so a
 *  BAREWORD state code that collides with a boolean operator is mis-parsed. Live-
 *  verified 2026-07-13: `PSTALP:OR` (Oregon, unquoted) → HTTP 400 parse_exception (a
 *  HARD-FAIL that throws, NOT an honest empty), whereas `PSTALP:"OR"` → 4289 rows.
 *  OR is the only 2-letter US state code that collides with a Lucene operator, but
 *  quoting is EQUIVALENT for every non-operator value (live: `STALP:CA` === `STALP:"CA"`
 *  === 1287; `PSTALP:CA`(failures) === 265; `PSTALP:CA`(history) === 35892) so it is
 *  uniformly safe for all state filters and fixes all 4 FDIC tools at once (they all
 *  call this). Numeric fields (CERT/CHANGECODE/FAILYR/EFFYEAR/ACTIVE) stay bare — the
 *  values are `^\d+$` by construction and a number never collides with an operator.
 *  The value is escaped backslash-first then `"` (defensive — `^[A-Z]{2}$`-constrained
 *  state values contain neither, and no other field routes a free string through here).
 *  This is the `filters`-DSL path ONLY; the `search` param (searchTerm/escapeSearch)
 *  is a DIFFERENT surface and stays correctly UNQUOTED (C116). Exported for the
 *  allowlist-bypass fault fixture (§7(b)). */
export function filterTerm(
  field: string,
  value: string,
  allowed: ReadonlySet<string>,
): string {
  if (!allowed.has(field)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `FDIC filter field ${JSON.stringify(field)} is not on the allowlist — refusing to build an un-allowlisted filter (P4 / SSRF safety).`,
      retryable: false,
    });
  }
  // ★OR-fix — a non-numeric value is double-quoted so a Lucene-operator-colliding
  // state code (e.g. OR = Oregon) is parsed as a literal term, not a boolean
  // operator (bare `PSTALP:OR` → live HTTP 400). Numeric values stay bare.
  const emitted = /^\d+$/.test(value)
    ? value
    : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `${field}:${emitted}`;
}

/** A `search` term `FIELD:<escaped>` (M1 route for NAME/CITY) — asserts the field
 *  ∈ the search allowlist and M2-escapes the value UNQUOTED (see escapeSearch: NO
 *  surrounding quotes — quotes collapse match_phrase recall → false-empties).
 *  Exported for the allowlist-bypass fault fixture (§7(b)). */
export function searchTerm(field: string, value: string): string {
  if (!INST_SEARCH_FIELDS.has(field)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `FDIC search field ${JSON.stringify(field)} is not on the allowlist — refusing to build an un-allowlisted search (P4 / SSRF safety).`,
      retryable: false,
    });
  }
  return `${field}:${escapeSearch(value)}`;
}

/**
 * Build the institutions `filters` string (STALP/ACTIVE/CERT only — NAME/CITY go
 * through `search`, M1). Terms joined with ` AND `. Returns "" when there is no
 * structured filter clause. Exported for the fault fixtures.
 */
export function buildInstFilters(inp: {
  state?: string;
  activeOnly?: boolean;
  cert?: number;
}): string {
  const terms: string[] = [];
  if (inp.state !== undefined) terms.push(filterTerm("STALP", inp.state, INST_FILTER_FIELDS));
  if (inp.activeOnly !== undefined)
    terms.push(filterTerm("ACTIVE", inp.activeOnly ? "1" : "0", INST_FILTER_FIELDS));
  if (inp.cert !== undefined) terms.push(filterTerm("CERT", String(inp.cert), INST_FILTER_FIELDS));
  return terms.join(" AND ");
}

/**
 * ★M1 + ★M2 — build the institutions `search` string (FDIC full-text; NAME/CITY
 * only). Each value is char-class-validated at the server boundary, then here
 * M2-escaped UNQUOTED (backslash-first; NO surrounding quotes — see escapeSearch).
 * Terms joined with ` AND ` (live-verified: `search=NAME:first AND CITY:richmond`
 * → both must match). Returns "" when neither is present. Exported for the M1/M2
 * fault fixtures.
 */
export function buildInstSearch(inp: { name?: string; city?: string }): string {
  const terms: string[] = [];
  if (inp.name !== undefined) terms.push(searchTerm("NAME", inp.name));
  if (inp.city !== undefined) terms.push(searchTerm("CITY", inp.city));
  return terms.join(" AND ");
}

/** Build the financials `filters` string — the sole filter is the numeric
 *  `CERT:<int>` (zero string inputs → zero injection surface). */
export function buildFinFilters(inp: { cert: number }): string {
  return filterTerm("CERT", String(inp.cert), FIN_FILTER_FIELDS);
}

/**
 * Resolve the sort params against the per-endpoint allowlist (belt-and-suspenders
 * behind the server's Zod enum). An unknown sortBy is invalid_input BEFORE any
 * fetch (never `sort_by=NOTAFIELD` on the wire — FDIC 400s it when a sort_order
 * accompanies it). Returns {} when no sortBy (institutions may omit sorting).
 */
function sortParams(
  sortBy: string | undefined,
  sortOrder: string | undefined,
  allowed: ReadonlySet<string>,
  endpoint: string,
): { sort_by?: string; sort_order?: string } {
  if (sortBy === undefined) return {};
  if (!allowed.has(sortBy)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `FDIC ${endpoint} sortBy ${JSON.stringify(sortBy)} is not an allowed sort field. Allowed: ${[...allowed].join(", ")}.`,
      retryable: false,
    });
  }
  return { sort_by: sortBy, sort_order: sortOrder === "DESC" ? "DESC" : "ASC" };
}

// ─── fetch layer ──────────────────────────────────────────────────

/**
 * GET one FDIC BankFind endpoint through the shared port. SSRF guard: the path is
 * a FIXED endpoint constant (`institutions` | `financials`) — no caller value —
 * and the CONSTRUCTED URL's hostname === api.fdic.gov over https. One shared gate
 * `throughGate("fdic", 200, …)` around EVERY fetch (one host = one rate budget) +
 * `redirect:"error"` (B1) + NO headers (keyless — byte-clean init). A JSON-parse
 * throw from a non-JSON 200 body (an HTML/error page) is reclassified to
 * driftError; a ToolErrorCarrier from the 429/5xx/404/400 taxonomy propagates
 * unchanged. Returns the parsed JSON (unknown; the caller validates the envelope).
 */
async function getFdic(endpoint: string, params: URLSearchParams): Promise<unknown> {
  const url = `https://${FDIC_HOST}/banks/${endpoint}?${params.toString()}`;
  const built = new URL(url);
  if (built.hostname !== FDIC_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed FDIC URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${FDIC_HOST} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
    });
  }
  try {
    return await throughGate(GATE_KEY, FDIC_MIN_INTERVAL_MS, () =>
      getJson(url, { label: LABEL, redirect: "error" }),
    );
  } catch (e) {
    // Preserve the structured taxonomy (404/429/5xx/400/timeout) unchanged.
    if (e instanceof ToolErrorCarrier) throw e;
    // A 200 non-JSON body makes getJson's r.json() throw a SyntaxError → classify
    // as schema_drift (an honest THROW), never a fake-empty. getJson stays
    // byte-identical (the reclassification is at THIS call site — the fema pattern).
    if (e instanceof SyntaxError) {
      throw driftError(
        LABEL,
        "FDIC returned a non-JSON body at HTTP 200 — treating as schema drift.",
      );
    }
    throw e;
  }
}

// ─── envelope parse (P2 3-envelope drift-guard) + map helpers ──────
type FdicEnvelope = {
  records: Record<string, unknown>[];
  totalAvailable: number;
  indexName: string | null;
  indexCreated: string | null;
};

/**
 * ★P2 — the 3-envelope drift-guard on the parsed 200 body. Require the SUCCESS
 * shape: `meta` is an object AND `data` is an Array (rejects the errors[] QUERY-
 * ERROR shape and the message+statusCode ROUTING shape at HTTP 200), AND `typeof
 * meta.total === "number"` (before num; a non-number/absent total is drift, never
 * a fake empty). Records are nested under `data[].data`. Reads the snapshot-
 * freshness `meta.index.{name,createTimestamp}`.
 */
function parseEnvelope(body: unknown): FdicEnvelope {
  const b = (body ?? {}) as { meta?: unknown; data?: unknown };
  if (b.meta === null || typeof b.meta !== "object" || !Array.isArray(b.data)) {
    throw driftError(
      LABEL,
      "FDIC BankFind returned an unexpected shape (expected { meta:{…}, data:[…] }) — treating as schema drift (rejects the errors[] / message+statusCode envelopes served at HTTP 200).",
    );
  }
  const meta = b.meta as { total?: unknown; index?: unknown };
  if (typeof meta.total !== "number") {
    throw driftError(
      LABEL,
      "FDIC BankFind returned a non-number meta.total — treating as schema drift (num() alone cannot distinguish a non-number total from an absent one).",
    );
  }
  const totalAvailable = num(meta.total);
  if (totalAvailable === null) {
    throw driftError(LABEL, "FDIC BankFind meta.total is not a finite number — treating as schema drift.");
  }
  const records = (b.data as Array<{ data?: unknown }>).map((d) =>
    d && typeof d === "object" && d.data && typeof d.data === "object"
      ? (d.data as Record<string, unknown>)
      : {},
  );
  const idx = (meta.index ?? {}) as { name?: unknown; createTimestamp?: unknown };
  return {
    records,
    totalAvailable,
    indexName: str(idx.name),
    indexCreated: str(idx.createTimestamp),
  };
}

/** ★B — the union of keys across the raw records; a projected field absent from
 *  ALL records (when returned > 0) is surfaced (never silently vanished). */
function fieldsUnavailable(
  records: Record<string, unknown>[],
  projection: readonly string[],
): string[] {
  if (records.length === 0) return [];
  const present = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) present.add(k);
  return projection.filter((f) => !present.has(f));
}

/** ★P3 — $thousands → whole USD with the null-guard BEFORE the ×1000 (an absent
 *  value stays null, never 0). */
function thousandsToUsd(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : n * 1000;
}

export type FdicInstitution = {
  name: string | null;
  city: string | null;
  state: string | null;
  cert: number | null;
  assetUSD: number | null;
  active: number | null;
  establishedDate: string | null;
  id: string | null;
};

function mapInstitution(rec: Record<string, unknown>): FdicInstitution {
  return {
    name: str(rec.NAME),
    city: str(rec.CITY),
    state: str(rec.STALP),
    cert: num(rec.CERT),
    assetUSD: thousandsToUsd(rec.ASSET),
    active: num(rec.ACTIVE),
    establishedDate: str(rec.ESTYMD),
    id: str(rec.ID),
  };
}

export type FdicFinancials = {
  cert: number | null;
  reportDate: number | null;
  assetUSD: number | null;
  depositsUSD: number | null;
  netIncomeUSD: number | null;
  id: string | null;
};

function mapFinancials(rec: Record<string, unknown>): FdicFinancials {
  return {
    cert: num(rec.CERT),
    reportDate: num(rec.REPDTE),
    assetUSD: thousandsToUsd(rec.ASSET),
    depositsUSD: thousandsToUsd(rec.DEP),
    netIncomeUSD: thousandsToUsd(rec.NETINC),
    id: str(rec.ID),
  };
}

// ─── shared disclosure notes ───────────────────────────────────────
const ASSET_NOTE =
  "FDIC publishes ASSET/DEP/NETINC in $thousands; normalized here to whole USD (×1,000). A real 0 stays 0; an absent value is null (never 0).";
const NAME_CITY_SEARCH_NOTE =
  "name/city use FDIC's full-text `search` (case-insensitive token match); a multi-word value is matched per-token and may be BROADER than a literal substring (it can match records sharing only some tokens) — verify counts.";

function freshnessNote(name: string | null, created: string | null): string {
  return `Served from FDIC search-index snapshot ${name ?? "(unnamed)"}${created ? ` built ${created}` : ""} — a point-in-time snapshot, not a live-this-second read; the institutions and financials indexes carry DIFFERENT snapshot times.`;
}

// ─── Tool 1: fdic_search_institutions ──────────────────────────────
/**
 * Search the FDIC-insured-institution directory (`/banks/institutions`).
 * Structured inputs: `state` (STALP filter), `activeOnly` (ACTIVE filter), `cert`
 * (CERT filter) → the `filters` param; `name`/`city` → the full-text `search`
 * param (M1; case-insensitive token match, UNQUOTED + M2-escaped). Plus
 * `limit`/`offset`/`sortBy`/`sortOrder`. Fixed field projection.
 *
 * HONESTY: EXACT `meta.total` → exact totalAvailable + hasMore (P1); the 3-
 * envelope drift-guard makes the ONLY honest empty `200 + total:0 + data:[]`,
 * everything else THROWS (P2); ASSET is $thousands → whole USD ×1000 null-never-0
 * (P3); a projected field absent from all records → fieldsUnavailable (B); the
 * snapshot build time is disclosed. name/city search + multi-word per-token are
 * disclosed (M1/S1).
 */
export async function searchInstitutions(args: {
  state?: string;
  activeOnly?: boolean;
  cert?: number;
  name?: string;
  city?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: string;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;

  const filters = buildInstFilters({
    state: args.state,
    activeOnly: args.activeOnly,
    cert: args.cert,
  });
  const search = buildInstSearch({ name: args.name, city: args.city });
  const sort = sortParams(args.sortBy, args.sortOrder, INST_SORT_FIELDS, "institutions");

  const params = new URLSearchParams();
  if (filters) params.set("filters", filters);
  if (search) params.set("search", search);
  params.set("fields", INST_FIELDS);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sort.sort_by) {
    params.set("sort_by", sort.sort_by);
    params.set("sort_order", sort.sort_order as string);
  }
  params.set("format", "json");

  const body = await getFdic(ENDPOINT_INSTITUTIONS, params);
  const env = parseEnvelope(body);
  const records = env.records.map(mapInstitution);
  const returned = records.length;
  const totalAvailable = env.totalAvailable;
  const hasMore = returned > 0 && offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  const filtersApplied: string[] = [];
  if (args.state !== undefined) filtersApplied.push("state");
  if (args.activeOnly !== undefined) filtersApplied.push("activeOnly");
  if (args.cert !== undefined) filtersApplied.push("cert");
  if (args.name !== undefined) filtersApplied.push("name");
  if (args.city !== undefined) filtersApplied.push("city");
  if (sort.sort_by) filtersApplied.push("sort");

  const notes: string[] = [freshnessNote(env.indexName, env.indexCreated), ASSET_NOTE];
  if (args.name !== undefined || args.city !== undefined) {
    notes.push(NAME_CITY_SEARCH_NOTE);
    // ★S1 — a multi-word name/city value is matched PER-TOKEN (phrase-quoting does
    // NOT phrase-scope the `search` param). Disclose whenever a value has a space.
    const multi: string[] = [];
    if (args.name !== undefined && /\s/.test(args.name.trim())) multi.push("name");
    if (args.city !== undefined && /\s/.test(args.city.trim())) multi.push("city");
    if (multi.length > 0) {
      notes.push(
        `Multi-word ${multi.join(" and ")} is matched PER-TOKEN by FDIC's full-text index (the tokens are AND-combined but each is fuzzy — a record sharing only ONE token can match, e.g. \`search=NAME:First Community\` returns "First State Bank"); results may be BROADER than a literal substring — verify counts.`,
      );
    }
  }
  const fu = fieldsUnavailable(env.records, INST_PROJECTION);
  if (fu.length > 0) {
    notes.push(
      `Requested field(s) ${fu.join(", ")} were not returned by FDIC for any record — possible schema drift / rename.`,
    );
  }

  return withMeta(
    { institutions: records },
    {
      source: "api.fdic.gov/banks/institutions (BankFind, keyless)",
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: fu,
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool 2: fdic_institution_financials ───────────────────────────
/**
 * Quarterly financial time-series for ONE FDIC-insured institution by `cert`
 * (`/banks/financials`). The sole filter is the numeric `CERT:<int>` (zero string
 * inputs → zero injection surface). `sortBy` defaults to REPDTE + `sortOrder`
 * DESC → newest quarter first. Fixed field projection. Consumes the IDENTICAL
 * fetch → 3-envelope guard → pagination machinery as tool 1.
 *
 * HONESTY: EXACT `meta.total` → exact totalAvailable + hasMore (P1; live: CERT
 * 10363 → total 169, stable across offset); the 3-envelope drift-guard (P2);
 * ASSET/DEP/NETINC $thousands → whole USD ×1000 null-never-0 (P3); the
 * fieldsUnavailable disclosure (B); the snapshot build time is disclosed.
 */
export async function institutionFinancials(args: {
  cert: number;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: string;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  // Financials default to REPDTE DESC (newest first) when the server's Zod default
  // did not supply one (defensive — the server always defaults sortBy=REPDTE).
  const sort = sortParams(
    args.sortBy ?? "REPDTE",
    args.sortOrder ?? "DESC",
    FIN_SORT_FIELDS,
    "financials",
  );

  const params = new URLSearchParams();
  params.set("filters", buildFinFilters({ cert: args.cert }));
  params.set("fields", FIN_FIELDS);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sort.sort_by) {
    params.set("sort_by", sort.sort_by);
    params.set("sort_order", sort.sort_order as string);
  }
  params.set("format", "json");

  const body = await getFdic(ENDPOINT_FINANCIALS, params);
  const env = parseEnvelope(body);
  const records = env.records.map(mapFinancials);
  const returned = records.length;
  const totalAvailable = env.totalAvailable;
  const hasMore = returned > 0 && offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  const notes: string[] = [freshnessNote(env.indexName, env.indexCreated), ASSET_NOTE];
  const fu = fieldsUnavailable(env.records, FIN_PROJECTION);
  if (fu.length > 0) {
    notes.push(
      `Requested field(s) ${fu.join(", ")} were not returned by FDIC for any record — possible schema drift / rename.`,
    );
  }

  return withMeta(
    { cert: args.cert, financials: records },
    {
      source: "api.fdic.gov/banks/financials (BankFind, keyless)",
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied: ["cert", "sort"],
      filtersDropped: [],
      fieldsUnavailable: fu,
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ═══════════════════════════════════════════════════════════════════
// Tool 3: fdic_bank_failures (ADR-0029) — the historical failed / FDIC-assisted
// institution list (`/banks/failures`). B2G counterparty-risk: a failed or
// FDIC-assisted institution is a due-diligence red flag; `CERT` links a failure
// back to fdic_search_institutions / fdic_institution_financials. Reuses the
// C116-hardened adapter VERBATIM (getFdic / parseEnvelope 3-envelope-guard /
// filter-field allowlist-by-construction / sortBy enum+Set.has / EXACT meta.total
// pagination / snapshot-freshness / $thousands→USD ×1000 null-never-0). The NEW
// surface is exactly three things, all forced by the v2 (cycle-33) live review:
//   ★F1 — the state field on /failures is PSTALP, NOT STALP (live: `STALP:CA`→
//     total 0 = the unknown-field false-empty landmine; `PSTALP:CA`→265). We map
//     state→PSTALP in the filter, the allowlist, the projection, and the output.
//   ★F2 — the `search` param is IGNORED on /failures (live: `search=NAME:…` AND
//     no-params BOTH return total 4115 = the whole dataset = a false-FLOOD). So
//     this tool has NO name/city filter and NEVER emits `search=` — it does NOT
//     reuse searchTerm/escapeSearch. NAME/CITY stay in the PROJECTION (surfaced
//     per row) but are not filterable; name-based lookup is the honest 2-step CERT
//     linkage (resolve CERT in fdic_search_institutions → filter here by cert).
//   ★F3 — FAILDATE is `M/D/YYYY` (not financials' YYYYMMDD): normFailDate does an
//     EXACT Date.UTC round-trip → ISO YYYY-MM-DD (an unrecognized value is
//     surfaced RAW + disclosed, never nulled/fabricated); COST can be a genuine 0
//     (fully-assisted, no DIF loss) or NEGATIVE (a net DIF recovery/gain) —
//     thousandsToUsd keeps both faithfully (null-guard BEFORE the ×1000).
// ═══════════════════════════════════════════════════════════════════

// Fixed endpoint constant — the TOOL chooses it; NO caller value on the path (SSRF core).
const ENDPOINT_FAILURES = "failures";

// Fixed field projection (every field live-verified 2026-07-13). NAME/CITY are
// PROJECTED (surfaced per output row) but NOT filterable (F2).
const FAIL_FIELDS = "NAME,CERT,FAILDATE,FAILYR,CITY,PSTALP,COST,RESTYPE,SAVR,QBFDEP,QBFASSET,ID";
const FAIL_PROJECTION = [
  "NAME",
  "CERT",
  "FAILDATE",
  "FAILYR",
  "CITY",
  "PSTALP",
  "COST",
  "RESTYPE",
  "SAVR",
  "QBFDEP",
  "QBFASSET",
  "ID",
] as const;

// ★F1 — the failures filter-FIELD allowlist (P4 belt-and-suspenders). The state
// field is PSTALP (NOT STALP — that is a false-empty landmine). NAME/CITY are NOT
// here (F2 — /failures has no working name/city filter). These fields carry only
// constrained non-string values (PSTALP a 2-letter code, FAILYR a year, CERT an
// int) → no quoting needed.
const FDIC_FAILURES_FILTER_FIELDS: ReadonlySet<string> = new Set(["PSTALP", "FAILYR", "CERT"]);
// sortBy allowlist (mirrors the server's Zod enum; a Set.has recheck in sortParams
// → an unknown sort field is invalid_input BEFORE fetch).
const FAIL_SORT_FIELDS: ReadonlySet<string> = new Set([
  "FAILDATE",
  "COST",
  "QBFASSET",
  "QBFDEP",
  "NAME",
  "FAILYR",
]);

// Exported so the fault suite can drive the belt-and-suspenders field-guard directly.
export { FDIC_FAILURES_FILTER_FIELDS };

/**
 * Build the failures `filters` string — EXACT-KEY terms only: `state`→`PSTALP:<s>`
 * (★F1), `failYear`→`FAILYR:<year>` (emit the integer's digits — FAILYR is a
 * string field but the digits filter cleanly, live-verified), `cert`→`CERT:<int>`.
 * There is NO name/city term (★F2 — /failures ignores `search` and NAME/CITY only
 * filter as brittle exact-uppercase foot-guns). Terms joined with ` AND `. Returns
 * "" when there is no structured filter clause. Exported for the fault fixtures.
 */
export function buildFailFilters(inp: {
  state?: string;
  failYear?: number;
  cert?: number;
}): string {
  const terms: string[] = [];
  if (inp.state !== undefined)
    terms.push(filterTerm("PSTALP", inp.state, FDIC_FAILURES_FILTER_FIELDS));
  if (inp.failYear !== undefined)
    terms.push(filterTerm("FAILYR", String(inp.failYear), FDIC_FAILURES_FILTER_FIELDS));
  if (inp.cert !== undefined)
    terms.push(filterTerm("CERT", String(inp.cert), FDIC_FAILURES_FILTER_FIELDS));
  return terms.join(" AND ");
}

/**
 * ★F3 — normalize FDIC's `FAILDATE` (`M/D/YYYY`, e.g. `3/10/2023`) to ISO
 * `YYYY-MM-DD`. Parse `^(\d{1,2})/(\d{1,2})/(\d{4})$`, then validate the calendar
 * day with the EXACT 3-component Date.UTC round-trip (rejects JS's silent
 * roll-overs like `2/30/2023`→Mar-02). On success → the padded ISO string
 * (`normalized:true`). If the value does NOT match the pattern or fails the
 * round-trip → surface the RAW upstream value UNCHANGED (`normalized:false`; NEVER
 * null or fabricate a present date — the handler discloses the raw passthrough); a
 * genuinely-absent value (null/undefined) → null. Live-confirmed 4115/4115 rows
 * normalize (1934–2026), so the raw-passthrough branch is defensive-only. Exported
 * for the fault fixtures.
 */
export function normFailDate(raw: unknown): { value: string | null; normalized: boolean } {
  // A non-string (absent/null/numeric) → honest str coercion (null for absent);
  // never String()-fabricate "null"/"undefined"/"[object Object]".
  if (typeof raw !== "string") return { value: str(raw), normalized: false };
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    const y = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d) {
      return {
        value: `${m[3]}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
        normalized: true,
      };
    }
  }
  // Present but unrecognized → surface the raw value verbatim (defensive; never taken live).
  return { value: raw, normalized: false };
}

export type FdicFailure = {
  name: string | null;
  cert: number | null;
  failDate: string | null;
  failYear: string | null;
  city: string | null;
  state: string | null;
  resolutionType: string | null;
  resolutionFund: string | null;
  estimatedLossUSD: number | null;
  depositsUSD: number | null;
  assetsUSD: number | null;
  id: string | null;
};

function mapFailure(rec: Record<string, unknown>): FdicFailure {
  return {
    name: str(rec.NAME),
    cert: num(rec.CERT),
    failDate: normFailDate(rec.FAILDATE).value,
    failYear: str(rec.FAILYR),
    city: str(rec.CITY),
    state: str(rec.PSTALP), // ★F1 — PSTALP, NOT STALP
    resolutionType: str(rec.RESTYPE),
    resolutionFund: str(rec.SAVR),
    estimatedLossUSD: thousandsToUsd(rec.COST),
    depositsUSD: thousandsToUsd(rec.QBFDEP),
    assetsUSD: thousandsToUsd(rec.QBFASSET),
    id: str(rec.ID),
  };
}

// ─── failures disclosure notes ─────────────────────────────────────
const FAIL_DATE_NOTE = "failDate is normalized from FDIC's M/D/YYYY to ISO YYYY-MM-DD.";
const FAIL_COST_NOTE =
  "COST is FDIC's estimated loss to the Deposit Insurance Fund; COST/QBFDEP/QBFASSET are $thousands, normalized here to whole USD (×1,000). A genuine 0 = a fully-assisted resolution with NO DIF loss (a real 0, not absence); a NEGATIVE value = a net DIF recovery/gain (NOT a loss); an absent value is null (never 0).";
const FAIL_SCOPE_NOTE =
  "Historical FDIC-insured institution failures / assistance transactions; a bank ABSENT here has no recorded FDIC failure (it may be active, acquired non-failed, or never FDIC-insured) — cross-check with fdic_search_institutions.";
const FAIL_CERT_NOTE =
  "To find a specific institution's failure, resolve its CERT via fdic_search_institutions, then filter here by `cert`; name/city are shown but not searchable on this endpoint (FDIC's /failures `search` param is ignored and would return the whole dataset).";

/**
 * Historical FDIC bank failures / assistance transactions (`/banks/failures`).
 * Exact-key structured inputs: `state` (→ PSTALP filter, ★F1), `failYear` (→
 * FAILYR), `cert` (→ CERT) → the `filters` param; plus `limit`/`offset`/`sortBy`/
 * `sortOrder` (default FAILDATE DESC → most-recent failures first). Fixed field
 * projection. NO name/city filter and NEVER a `search=` param (★F2). Consumes the
 * IDENTICAL fetch → 3-envelope guard → pagination machinery as tools 1 & 2.
 *
 * HONESTY: EXACT `meta.total` → exact totalAvailable + hasMore (P1); the 3-
 * envelope drift-guard makes the ONLY honest empty `200 + total:0 + data:[]`,
 * everything else THROWS (P2); COST/QBFDEP/QBFASSET are $thousands → whole USD
 * ×1000 null-never-0 (P3; genuine 0 stays 0, negative = a net recovery, absent →
 * null); failDate normalized M/D/YYYY→ISO (unrecognized → raw + disclosed, never
 * nulled/fabricated); a projected field absent from all records → fieldsUnavailable
 * (B); the snapshot build time is disclosed.
 */
export async function bankFailures(args: {
  state?: string;
  failYear?: number;
  cert?: number;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: string;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  // Default FAILDATE DESC (most-recent first) when the server's Zod default did not
  // supply one (defensive — the server always defaults sortBy=FAILDATE/DESC).
  const sort = sortParams(
    args.sortBy ?? "FAILDATE",
    args.sortOrder ?? "DESC",
    FAIL_SORT_FIELDS,
    "failures",
  );

  const filters = buildFailFilters({ state: args.state, failYear: args.failYear, cert: args.cert });

  const params = new URLSearchParams();
  if (filters) params.set("filters", filters);
  params.set("fields", FAIL_FIELDS);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sort.sort_by) {
    params.set("sort_by", sort.sort_by);
    params.set("sort_order", sort.sort_order as string);
  }
  params.set("format", "json");

  const body = await getFdic(ENDPOINT_FAILURES, params);
  const env = parseEnvelope(body);
  const records = env.records.map(mapFailure);
  const returned = records.length;
  const totalAvailable = env.totalAvailable;
  const hasMore = returned > 0 && offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  const filtersApplied: string[] = [];
  if (args.state !== undefined) filtersApplied.push("state");
  if (args.failYear !== undefined) filtersApplied.push("failYear");
  if (args.cert !== undefined) filtersApplied.push("cert");
  if (sort.sort_by) filtersApplied.push("sort");

  const notes: string[] = [
    freshnessNote(env.indexName, env.indexCreated),
    FAIL_DATE_NOTE,
    FAIL_COST_NOTE,
    FAIL_SCOPE_NOTE,
    FAIL_CERT_NOTE,
  ];
  // ★F3 — disclose any present-but-unrecognized FAILDATE surfaced raw (defensive;
  // live 4115/4115 normalize, so this branch essentially never fires).
  const anyRawFailDate = env.records.some((rec) => {
    const fd = normFailDate(rec.FAILDATE);
    return !fd.normalized && fd.value !== null;
  });
  if (anyRawFailDate) {
    notes.push(
      "One or more FAILDATE values did not match FDIC's M/D/YYYY format (or failed the calendar round-trip) and were surfaced RAW (not normalized to ISO) — never nulled or fabricated.",
    );
  }
  const fu = fieldsUnavailable(env.records, FAIL_PROJECTION);
  if (fu.length > 0) {
    notes.push(
      `Requested field(s) ${fu.join(", ")} were not returned by FDIC for any record — possible schema drift / rename.`,
    );
  }

  return withMeta(
    { failures: records },
    {
      source: "api.fdic.gov/banks/failures (BankFind, keyless)",
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: fu,
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ═══════════════════════════════════════════════════════════════════
// Tool 4: fdic_institution_history (ADR-0030) — the institution-level STRUCTURAL-
// CHANGE event log (`/banks/history`): mergers, absorptions, consolidations,
// failures, name/location/charter/regulator changes, branch open/close, trust-power
// grants, FRS membership changes. It COMPLETES the FDIC entity cluster (institutions
// directory + financials time-series + failures resolution events + history full
// structural lineage). Reuses the C116-hardened adapter VERBATIM (getFdic /
// parseEnvelope 3-envelope-guard / filter-field allowlist-by-construction / sortBy
// enum+Set.has / EXACT meta.total pagination / snapshot-freshness). It does NOT use
// searchTerm/escapeSearch (no name search) or thousandsToUsd (no money field). The
// NEW surface is exactly four things, all live-verified 2026-07-13:
//   ★F1-analog — the state field on /history is PSTALP, NOT STALP (live: `STALP:CA`
//     → total 0 = the unknown-field false-empty landmine; `PSTALP:CA`→35892). We map
//     state→PSTALP in the filter, the allowlist, the projection, and the output.
//   ★F2-analog — the `search` param does NOT work for name on /history (live:
//     `search=INSTNAME:chase` AND `search=INSTNAME:zzzznomatch` BOTH return total 0
//     = a false-EMPTY). So this tool has NO name/city filter and NEVER emits
//     `search=`. INSTNAME + the counterparty names are PROJECTED (surfaced per row)
//     but not filterable; name-based lookup is the honest 2-step CERT linkage
//     (resolve CERT in fdic_search_institutions → filter here by cert).
//   ★Q1 — CHANGECODE is NOT opaque: FDIC co-serves an authoritative CHANGECODE_DESC
//     INLINE in every record (27 distinct codes sampled, 0 nulls). We surface BOTH
//     the numeric changeCode (authoritative) AND changeDescription = the co-served
//     CHANGECODE_DESC PROJECTED verbatim (NOT a static embedded hand-map — strictly
//     more honest, zero-drift, auto-covers every code). A null DESC (never observed)
//     stays null via str, surfaced by fieldsUnavailable — never invented.
//   ★Q2 — EFFDATE/PROCDATE are `YYYY-MM-DDT00:00:00` (a THIRD date format in this
//     source): normHistDate strips the time + does an EXACT Date.UTC round-trip → ISO
//     YYYY-MM-DD (an unrecognized value is surfaced RAW + disclosed, never nulled/
//     fabricated); a 9999-* value is FDIC's "not-applicable/open" sentinel (surfaced
//     verbatim + disclosed).
//   ★Q3 — the ACQ_/OUT_/SUR_ counterparty CERT-triad is the headline value: on a
//     merger/failure row it carries the acquiring/outgoing/surviving institution's
//     CERT + INSTNAME, and each CERT links straight back to the CERT-keyed tools. On
//     a NON-merger row (e.g. a 520 location change) the *_CERT/*_INSTNAME fields are
//     live-verified ABSENT → num/str pass them through as null (an honest "no
//     counterparty"), NEVER a fabricated 0. We use *_CERT (the clean null-when-N/A
//     linkage key), NOT *_UNINUM (which carries a 0 sentinel for "none" = a
//     misleading fake identifier; live: ACQ_UNINUM:0 on a 520 row).
// ═══════════════════════════════════════════════════════════════════

// Fixed endpoint constant — the TOOL chooses it; NO caller value on the path (SSRF core).
const ENDPOINT_HISTORY = "history";

// Fixed field projection on the wire (all 16 fields; every one live-verified valid).
// The counterparty triad ACQ_/OUT_/SUR_ is REQUESTED here but is event-conditional
// (absent on non-merger rows) — it is deliberately EXCLUDED from HIST_PROJECTION
// (the fieldsUnavailable check) below.
const HIST_FIELDS =
  "CERT,INSTNAME,PSTALP,CHANGECODE,CHANGECODE_DESC,EFFDATE,PROCDATE,EFFYEAR,TRANSNUM,ACQ_CERT,ACQ_INSTNAME,OUT_CERT,OUT_INSTNAME,SUR_CERT,SUR_INSTNAME,ID";
// ★Q3-NUANCE — the fieldsUnavailable "projected-field-absent-from-ALL-records"
// check is scoped to the ALWAYS-PRESENT fields ONLY. The ACQ_/OUT_/SUR_ counterparty
// triad is LEGITIMATELY event-conditional (a page of all-non-merger rows — e.g.
// branch closings — would correctly omit them), so including them here would fire a
// spurious "schema drift" on the expected shape. Their nullness is disclosed via
// COUNTERPARTY_NOTE (Q3), NOT fieldsUnavailable.
const HIST_PROJECTION = [
  "CERT",
  "INSTNAME",
  "PSTALP",
  "CHANGECODE",
  "CHANGECODE_DESC",
  "EFFDATE",
  "PROCDATE",
  "EFFYEAR",
  "TRANSNUM",
  "ID",
] as const;

// ★F1-analog — the history filter-FIELD allowlist (P4 belt-and-suspenders). The
// state field is PSTALP (NOT STALP — a false-empty landmine). NAME/CITY are NOT
// here (F2-analog — /history has no working name/city filter). These fields carry
// only constrained non-string values (PSTALP a 2-letter code, EFFYEAR a year, CERT
// / CHANGECODE ints) → no quoting needed.
const FDIC_HISTORY_FILTER_FIELDS: ReadonlySet<string> = new Set([
  "CERT",
  "CHANGECODE",
  "EFFYEAR",
  "PSTALP",
]);
// sortBy allowlist (mirrors the server's Zod enum; a Set.has recheck in sortParams
// → an unknown sort field is invalid_input BEFORE fetch; live `sort_by=NOTAFIELD`
// → 400, so the pre-fetch guard is load-bearing).
const HIST_SORT_FIELDS: ReadonlySet<string> = new Set([
  "EFFDATE",
  "PROCDATE",
  "CHANGECODE",
  "TRANSNUM",
]);

// Exported so the fault suite can drive the belt-and-suspenders field-guard directly.
export { FDIC_HISTORY_FILTER_FIELDS };

/**
 * Build the history `filters` string — EXACT-KEY terms only: `cert`→`CERT:<int>`
 * (the PRIMARY lookup), `changeCode`→`CHANGECODE:<int>`, `effYear`→`EFFYEAR:<year>`
 * (emit the integer's digits — EFFYEAR is a string field but the digits filter
 * cleanly, live-verified), `state`→`PSTALP:<state>` (★F1-analog — PSTALP, NEVER
 * STALP). There is NO name/city term (★F2-analog — /history's `search` param
 * returns 0 for INSTNAME; this tool never emits `search=`). Terms joined with
 * ` AND `. Returns "" when there is no structured filter clause. Exported for the
 * fault fixtures.
 */
export function buildHistFilters(inp: {
  cert?: number;
  changeCode?: number;
  effYear?: number;
  state?: string;
}): string {
  const terms: string[] = [];
  if (inp.cert !== undefined)
    terms.push(filterTerm("CERT", String(inp.cert), FDIC_HISTORY_FILTER_FIELDS));
  if (inp.changeCode !== undefined)
    terms.push(filterTerm("CHANGECODE", String(inp.changeCode), FDIC_HISTORY_FILTER_FIELDS));
  if (inp.effYear !== undefined)
    terms.push(filterTerm("EFFYEAR", String(inp.effYear), FDIC_HISTORY_FILTER_FIELDS));
  if (inp.state !== undefined)
    terms.push(filterTerm("PSTALP", inp.state, FDIC_HISTORY_FILTER_FIELDS));
  return terms.join(" AND ");
}

/**
 * ★Q2 — normalize FDIC's `EFFDATE`/`PROCDATE` (`YYYY-MM-DDT00:00:00`, e.g.
 * `2002-07-01T00:00:00`) to ISO `YYYY-MM-DD`. Match
 * `^(\d{4})-(\d{2})-(\d{2})T00:00:00$`, extract y/m/d, then validate the calendar
 * day with the EXACT 3-component Date.UTC round-trip (`getUTCFullYear/Month+1/Date`
 * all match — rejects JS's silent roll-overs). On success → the ISO date
 * (`normalized:true`; the month/day are already zero-padded by the `\d{2}` capture).
 * If the value does NOT match the pattern or fails the round-trip → surface the RAW
 * upstream value UNCHANGED (`normalized:false`; NEVER null or fabricate a present
 * date — the handler discloses the raw passthrough); a genuinely-absent value
 * (null/undefined/"") → str-coerced (null for absent, "" preserved). Live-confirmed
 * 0/2000 nulls and 0 non-`T00:00:00` and old rows (1782 → `1782-01-01T00:00:00`)
 * conform, so the raw-passthrough branch is defensive-only. The `9999-12-31T00:00:00`
 * sentinel round-trips fine to `9999-12-31` (disclosed by the handler's sentinel
 * note). Exported for the fault fixtures.
 */
export function normHistDate(raw: unknown): { value: string | null; normalized: boolean } {
  // A non-string (absent/null/numeric) → honest str coercion (null for absent);
  // never String()-fabricate "null"/"undefined"/"[object Object]".
  if (typeof raw !== "string") return { value: str(raw), normalized: false };
  const m = /^(\d{4})-(\d{2})-(\d{2})T00:00:00$/.exec(raw);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === mo && dt.getUTCDate() === d) {
      return { value: `${m[1]}-${m[2]}-${m[3]}`, normalized: true };
    }
  }
  // Present but unrecognized → surface the raw value verbatim (defensive; never taken live).
  return { value: raw, normalized: false };
}

export type FdicHistory = {
  cert: number | null;
  instName: string | null;
  state: string | null;
  changeCode: number | null;
  changeDescription: string | null;
  effectiveDate: string | null;
  processDate: string | null;
  effYear: string | null;
  transNum: number | null;
  acquirerCert: number | null;
  acquirerName: string | null;
  outgoingCert: number | null;
  outgoingName: string | null;
  survivingCert: number | null;
  survivingName: string | null;
  id: string | null;
};

function mapHistory(rec: Record<string, unknown>): FdicHistory {
  return {
    cert: num(rec.CERT),
    instName: str(rec.INSTNAME),
    state: str(rec.PSTALP), // ★F1-analog — PSTALP, NOT STALP
    changeCode: num(rec.CHANGECODE),
    // ★Q1 — changeDescription is FDIC's OWN co-served CHANGECODE_DESC, passed
    // through verbatim (NOT a hand-map); the numeric changeCode is authoritative.
    changeDescription: str(rec.CHANGECODE_DESC),
    effectiveDate: normHistDate(rec.EFFDATE).value,
    processDate: normHistDate(rec.PROCDATE).value,
    effYear: str(rec.EFFYEAR),
    transNum: num(rec.TRANSNUM),
    // ★Q3 — counterparty triad from *_CERT (NOT *_UNINUM's 0 sentinel). On a
    // non-merger row these are ABSENT → num/str → null (never a fabricated 0/"").
    acquirerCert: num(rec.ACQ_CERT),
    acquirerName: str(rec.ACQ_INSTNAME),
    outgoingCert: num(rec.OUT_CERT),
    outgoingName: str(rec.OUT_INSTNAME),
    survivingCert: num(rec.SUR_CERT),
    survivingName: str(rec.SUR_INSTNAME),
    id: str(rec.ID),
  };
}

// ─── history disclosure notes ──────────────────────────────────────
const HIST_DATE_NOTE =
  "effectiveDate/processDate are normalized from FDIC's YYYY-MM-DDT00:00:00 to ISO YYYY-MM-DD.";
const HIST_CHANGEDESC_NOTE =
  "changeDescription is FDIC's own CHANGECODE_DESC, co-served with the numeric code in each record; the numeric changeCode is authoritative.";
const HIST_COUNTERPARTY_NOTE =
  "acquirer/outgoing/surviving identify the merger counterparties; each Cert links back to fdic_search_institutions / fdic_institution_financials / fdic_bank_failures; null = no counterparty for this event type.";
const HIST_SCOPE_NOTE =
  "Structural-change events for FDIC-insured institutions; a bank ABSENT here (for a given CERT) has no recorded structural change — cross-check with fdic_search_institutions. Name/city are surfaced (instName + counterparty names) but NOT searchable on this endpoint (FDIC's /history `search` param returns 0 for INSTNAME); to find an institution's history, resolve its CERT via fdic_search_institutions, then filter here by `cert`.";

/**
 * Institution-level structural-change event log (`/banks/history`). Exact-key
 * structured inputs: `cert` (→ CERT filter, the PRIMARY lookup), `changeCode` (→
 * CHANGECODE), `effYear` (→ EFFYEAR), `state` (→ PSTALP filter, ★F1-analog) → the
 * `filters` param; plus `limit`/`offset`/`sortBy`/`sortOrder` (default EFFDATE DESC
 * → newest structural change first). Fixed field projection. NO name/city filter and
 * NEVER a `search=` param (★F2-analog). Consumes the IDENTICAL fetch → 3-envelope
 * guard → pagination machinery as tools 1–3.
 *
 * HONESTY: EXACT `meta.total` → exact totalAvailable + hasMore (P1; live: CERT 3510
 * → total 13794, stable across offset); the 3-envelope drift-guard makes the ONLY
 * honest empty `200 + total:0 + data:[]`, everything else THROWS (P2); changeDescription
 * is FDIC's co-served CHANGECODE_DESC passed through verbatim (Q1, never hand-mapped);
 * effectiveDate/processDate normalized YYYY-MM-DDT00:00:00→ISO (unrecognized → raw +
 * disclosed, never nulled/fabricated; 9999-* sentinel disclosed) (Q2); the ACQ_/OUT_/
 * SUR_ counterparty CERT-triad is null-never-0 and uses *_CERT not *_UNINUM's 0
 * sentinel (Q3); a projected always-present field absent from all records →
 * fieldsUnavailable (B); the snapshot build time is disclosed.
 */
export async function institutionHistory(args: {
  cert?: number;
  changeCode?: number;
  effYear?: number;
  state?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: string;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  // Default EFFDATE DESC (newest structural change first) when the server's Zod
  // default did not supply one (defensive — the server always defaults sortBy=EFFDATE/DESC).
  const sort = sortParams(
    args.sortBy ?? "EFFDATE",
    args.sortOrder ?? "DESC",
    HIST_SORT_FIELDS,
    "history",
  );

  const filters = buildHistFilters({
    cert: args.cert,
    changeCode: args.changeCode,
    effYear: args.effYear,
    state: args.state,
  });

  const params = new URLSearchParams();
  if (filters) params.set("filters", filters);
  params.set("fields", HIST_FIELDS);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sort.sort_by) {
    params.set("sort_by", sort.sort_by);
    params.set("sort_order", sort.sort_order as string);
  }
  params.set("format", "json");

  const body = await getFdic(ENDPOINT_HISTORY, params);
  const env = parseEnvelope(body);
  const records = env.records.map(mapHistory);
  const returned = records.length;
  const totalAvailable = env.totalAvailable;
  const hasMore = returned > 0 && offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  const filtersApplied: string[] = [];
  if (args.cert !== undefined) filtersApplied.push("cert");
  if (args.changeCode !== undefined) filtersApplied.push("changeCode");
  if (args.effYear !== undefined) filtersApplied.push("effYear");
  if (args.state !== undefined) filtersApplied.push("state");
  if (sort.sort_by) filtersApplied.push("sort");

  const notes: string[] = [
    freshnessNote(env.indexName, env.indexCreated),
    HIST_DATE_NOTE,
    HIST_CHANGEDESC_NOTE,
    HIST_COUNTERPARTY_NOTE,
    HIST_SCOPE_NOTE,
  ];
  // ★Q2 — disclose any present-but-unrecognized EFFDATE/PROCDATE surfaced raw
  // (defensive; live all conform, so this branch essentially never fires).
  const anyRawDate = env.records.some((rec) =>
    (["EFFDATE", "PROCDATE"] as const).some((f) => {
      const nd = normHistDate(rec[f]);
      return !nd.normalized && nd.value !== null && nd.value !== "";
    }),
  );
  if (anyRawDate) {
    notes.push(
      "One or more effectiveDate/processDate values did not match FDIC's YYYY-MM-DDT00:00:00 format (or failed the calendar round-trip) and were surfaced RAW (not normalized to ISO) — never nulled or fabricated.",
    );
  }
  // ★Q2 sentinel — a 9999-* effectiveDate/processDate is FDIC's "not-applicable /
  // open" sentinel (normally on the un-projected ACQDATE/ENDDATE, but flagged here
  // should it ever surface on the projected dates). It round-trips to itself.
  const anySentinel = env.records.some((rec) =>
    (["EFFDATE", "PROCDATE"] as const).some(
      (f) => typeof rec[f] === "string" && (rec[f] as string).startsWith("9999"),
    ),
  );
  if (anySentinel) {
    notes.push(
      "One or more effectiveDate/processDate values carry FDIC's 9999-* 'not-applicable / open' sentinel — surfaced verbatim, not treated as a real event date.",
    );
  }
  const fu = fieldsUnavailable(env.records, HIST_PROJECTION);
  if (fu.length > 0) {
    notes.push(
      `Requested field(s) ${fu.join(", ")} were not returned by FDIC for any record — possible schema drift / rename.`,
    );
  }

  return withMeta(
    { history: records },
    {
      source: "api.fdic.gov/banks/history (BankFind, keyless)",
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: fu,
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ═══════════════════════════════════════════════════════════════════
// Tool 5: fdic_industry_summary (ADR-0031) — the FDIC's OWN aggregate/statistical
// roll-ups (`/banks/summary`): industry-wide and per-state ANNUAL aggregate financials
// (total assets, deposits, net income, equity, net interest income) + structural
// counts (institutions, offices, branches, employees), grouped by CHARTER CLASS
// (commercial banks vs savings institutions). ★NEW CAPABILITY TYPE for the source —
// the FIRST AGGREGATE / statistical tool (the 4 existing tools are all per-ENTITY,
// keyed on CERT). Answers "how big is the US (or a state's) banking industry this
// year, and how many institutions?" — a question NONE of the 4 entity tools can
// express without manually summing thousands of institution rows. Reuses the
// C116/C118-hardened adapter VERBATIM (getFdic / parseEnvelope 3-envelope guard /
// filterTerm allowlist-by-construction + Set.has / sortParams enum+Set.has / EXACT
// meta.total pagination / snapshot-freshness / $thousands→USD ×1000 null-never-0 /
// the C118-quoted filterTerm). It does NOT use searchTerm/escapeSearch (no name
// search — /summary's `search` param is a no-op that returns the whole year). The NEW
// surface is exactly four things, all live-verified 2026-07-13:
//   ★S1 — TWO cross-cut dimensions (NOT one): (1) charter class CB_SI (CB=commercial
//     banks, SI=savings institutions — every row is scoped to EXACTLY ONE; there is NO
//     pre-combined "all institutions" row), and (2) geography STALP (a MIX of
//     per-jurisdiction leaf rows AND geographic ROLL-UP rows).
//   ★S2 (the honesty crux) — the roll-up-vs-jurisdiction split. STALP ∈ {USA,US,OT,PI}
//     are GEOGRAPHIC AGGREGATES (scope national_total / national_states_dc /
//     territories_total / pacific_islands, isRollup:true); every other STALP is a
//     single jurisdiction (isRollup:false). Surfaced as derived scope+isRollup on
//     EVERY row + a MANDATORY disclosure: NEVER sum a roll-up row with jurisdiction
//     rows or across scopes (live-proven: Σ jurisdictions = USA; USA − US = OT). A
//     roll-up row must NEVER masquerade as a state.
//   ★S3 — the aggregate FIELD NAMES: number-of-institutions is BANKS (NOT NUMINST);
//     /summary serves NO ratio fields at all (ROA/ROE/NIMY/ERNAST absent) — only
//     $-aggregates + integer COUNTS.
//   ★S4 (the NIM foot-gun) — on /summary NIM is net interest INCOME in $thousands
//     (Alabama CB 2023 → 7,457,074 = $7.5B; USA CB → 660,219,591 = $660B), NOT the
//     net-interest-margin percentage. It MUST be ×1000-scaled like every money field
//     AND relabeled net interest income (netInterestIncomeUSD). Money
//     (ASSET/DEP/NETINC/EQ/NIM) ×1000 with the null-guard BEFORE the multiply; counts
//     (BANKS/OFFICES/BRANCHES/NUMEMP) pass through un-scaled (a count ×1000 is a
//     fabrication). A genuine 0 (American Samoa CB BANKS:0/ASSET:0/NIM:0) stays 0; an
//     absent value (American Samoa SI has NO BANKS key) stays null (never 0).
//   The state filter field is STALP (NOT PSTALP — a per-endpoint difference from
//   /failures & /history), C118-quoted so Oregon `STALP:"OR"` is operator-safe. NO
//   name/city filter, NEVER a `search=` param. The unknown-filter-field false-empty
//   (200/total:0) is neutralized by the allowlist-by-construction; the malformed-year
//   false-empty (YEAR:notanum → total:0) is guarded by Zod .int() at the boundary.
// ═══════════════════════════════════════════════════════════════════

// Fixed endpoint constant — the TOOL chooses it; NO caller value on the path (SSRF core).
const ENDPOINT_SUMMARY = "summary";

// Fixed field projection on the wire (every field live-verified present + non-null on
// both a leaf row (CA CB) and a roll-up row (USA CB); genuine 0/absent handled by the
// map). NO ratio fields (they do not exist on /summary).
const SUMMARY_FIELDS =
  "YEAR,CB_SI,STNAME,STALP,STNUM,BANKS,OFFICES,BRANCHES,NUMEMP,ASSET,DEP,NETINC,EQ,NIM,ID";
const SUMMARY_PROJECTION = [
  "YEAR",
  "CB_SI",
  "STNAME",
  "STALP",
  "STNUM",
  "BANKS",
  "OFFICES",
  "BRANCHES",
  "NUMEMP",
  "ASSET",
  "DEP",
  "NETINC",
  "EQ",
  "NIM",
  "ID",
] as const;

// ★S3 — the summary filter-FIELD allowlist (P4 belt-and-suspenders). ONLY these three
// (a caller never supplies a field name — they are compile-time constants behind named
// inputs). YEAR is numeric (emitted bare by filterTerm); STALP/CB_SI are non-numeric
// (C118-double-quoted). An un-allowlisted field → invalid_input pre-fetch (guards the
// live HTTP-200 total:0 unknown-field false-empty).
const FDIC_SUMMARY_FILTER_FIELDS: ReadonlySet<string> = new Set(["YEAR", "STALP", "CB_SI"]);
// sortBy allowlist (mirrors the server's Zod enum; a Set.has recheck in sortParams →
// an unknown sort field is invalid_input BEFORE fetch; live `sort_by=NOTAFIELD` → 400,
// so the pre-fetch guard is load-bearing).
const SUMMARY_SORT_FIELDS: ReadonlySet<string> = new Set(["YEAR", "ASSET", "DEP", "NETINC", "BANKS"]);

// Exported so the fault suite can drive the belt-and-suspenders field-guard directly.
export { FDIC_SUMMARY_FILTER_FIELDS };

// ★S2 — the explicit roll-up STALP set (the honesty discriminator; live-verified
// exhaustive over all 121 rows of 2023, and structurally by FIPS STNUM ∈ {0,99,98,97}).
const ROLLUP_STALP: ReadonlySet<string> = new Set(["USA", "US", "OT", "PI"]);

/**
 * ★CRUX-1 (S2) — derive the geographic SCOPE from the raw STALP, using the explicit
 * roll-up set (a fixed 4-element discriminator, NOT a fragile numeric threshold).
 * A non-roll-up value (incl. null / any future/unknown STALP) falls through to
 * "jurisdiction" and is surfaced by the ALWAYS-projected raw STNAME/STALP/STNUM — a
 * caller can always see the literal label, never a silently-mislabeled aggregate.
 * Exported for the fault fixtures.
 */
export function scopeOf(stalp: string | null): string {
  switch (stalp) {
    case "USA":
      return "national_total"; // STNUM 0  — 50 states + DC + all territories (grand total)
    case "US":
      return "national_states_dc"; // STNUM 99 — 50 states + DC, EXCL territories
    case "OT":
      return "territories_total"; // STNUM 98 — all US territories
    case "PI":
      return "pacific_islands"; // STNUM 97 — Pacific-island territories (⊂ OT)
    default:
      return "jurisdiction"; // a single state / DC / individual territory (or an absent/unknown STALP)
  }
}

/**
 * ★CRUX-1b (S1) — map the raw CB_SI charter code to a readable class. An UNMAPPED
 * value returns the raw code (never fabricated); a genuinely-absent (null) value stays
 * null. Exported for the fault fixtures.
 */
export function charterClassOf(code: string | null): string | null {
  if (code === "CB") return "commercial_banks";
  if (code === "SI") return "savings_institutions";
  return code; // unmapped → the raw code (never invented); null → null
}

/**
 * Build the summary `filters` string — EXACT-KEY terms only: `year`→`YEAR:<int>`
 * (numeric → emitted BARE by filterTerm; a non-int is guarded pre-fetch by Zod .int()),
 * `state`→`STALP:"<code>"` (★S2 — STALP is the /summary state field, NOT PSTALP;
 * C118-double-quoted so Oregon `STALP:"OR"` is Lucene-operator-safe), `charterClass`
 * →`CB_SI:"<v>"` (quoted). There is NO name/city term (★/summary's `search` is a no-op
 * that returns the whole year — this tool never emits `search=`). Terms joined with
 * ` AND `. Returns "" when there is no structured filter clause. Exported for the fault
 * fixtures.
 */
export function buildSummaryFilters(inp: {
  year?: number;
  state?: string;
  charterClass?: string;
}): string {
  const terms: string[] = [];
  if (inp.year !== undefined)
    terms.push(filterTerm("YEAR", String(inp.year), FDIC_SUMMARY_FILTER_FIELDS));
  if (inp.state !== undefined)
    terms.push(filterTerm("STALP", inp.state, FDIC_SUMMARY_FILTER_FIELDS));
  if (inp.charterClass !== undefined)
    terms.push(filterTerm("CB_SI", inp.charterClass, FDIC_SUMMARY_FILTER_FIELDS));
  return terms.join(" AND ");
}

export type FdicIndustrySummary = {
  year: number | null;
  charterClass: string | null;
  charterClassCode: string | null;
  geography: string | null;
  stateCode: string | null;
  stateFips: string | null;
  scope: string;
  isRollup: boolean;
  institutionCount: number | null;
  officeCount: number | null;
  branchCount: number | null;
  employeeCount: number | null;
  totalAssetsUSD: number | null;
  totalDepositsUSD: number | null;
  netIncomeUSD: number | null;
  totalEquityUSD: number | null;
  netInterestIncomeUSD: number | null;
  id: string | null;
};

function mapSummary(rec: Record<string, unknown>): FdicIndustrySummary {
  const stateCode = str(rec.STALP);
  const charterClassCode = str(rec.CB_SI);
  const scope = scopeOf(stateCode); // ★S2 — derived from the explicit roll-up set
  return {
    year: num(rec.YEAR), // YEAR is a string field ("2023") → num parses the digits
    charterClass: charterClassOf(charterClassCode), // ★S1 — CB→commercial_banks, SI→savings_institutions (unmapped→raw)
    charterClassCode,
    geography: str(rec.STNAME),
    stateCode,
    stateFips: str(rec.STNUM),
    scope,
    isRollup: scope !== "jurisdiction", // ★S2 — a roll-up must NEVER masquerade as a state
    // ★S4 / P3 — COUNT fields pass through via num (NEVER ×1000; a count ×1000 is a
    // fabrication). A genuine 0 (American Samoa CB BANKS:0) stays 0; an absent value
    // (American Samoa SI has no BANKS key) stays null (never 0).
    institutionCount: num(rec.BANKS),
    officeCount: num(rec.OFFICES),
    branchCount: num(rec.BRANCHES),
    employeeCount: num(rec.NUMEMP),
    // ★S4 / P3 — MONEY fields ($thousands → whole USD ×1000, null-guard BEFORE the
    // multiply; a genuine 0 stays 0, absent → null).
    totalAssetsUSD: thousandsToUsd(rec.ASSET),
    totalDepositsUSD: thousandsToUsd(rec.DEP),
    netIncomeUSD: thousandsToUsd(rec.NETINC),
    totalEquityUSD: thousandsToUsd(rec.EQ),
    // ★S4 — NIM is net interest INCOME ($thousands), NOT the margin ratio: scaled ×1000
    // and relabeled income (never surfaced as a "margin").
    netInterestIncomeUSD: thousandsToUsd(rec.NIM),
    id: str(rec.ID),
  };
}

// ─── summary disclosure notes ──────────────────────────────────────
// ★S2 — the load-bearing roll-up double-count-prevention disclosure (P4/P1 frontier).
const SUMMARY_ROLLUP_NOTE =
  "Rows cross charter class (CB_SI) × geography (STALP); STALP ∈ {USA,US,OT,PI} are ROLL-UP totals (isRollup:true, scope national_total/national_states_dc/territories_total/pacific_islands) — NEVER sum a roll-up row with jurisdiction rows, and NEVER sum across scopes: national_total (USA) = national_states_dc (US) + territories_total (OT), and pacific_islands (PI) is a SUBSET of territories (live-proven: Σ jurisdictions = USA; USA − US = OT). A geography's total = its CB row + its SI row (there is NO pre-combined charter row). Filter by state/charterClass or by isRollup to avoid double-counting; to get one national figure read the national_total (USA) row directly rather than summing states — a roll-up row is NOT a state.";
// ★S1 — the charter-class split (no combined row).
const SUMMARY_CHARTER_NOTE =
  "Each row covers ONE charter class: CB = commercial_banks, SI = savings_institutions. There is NO pre-combined 'all institutions' row — a geography's all-FDIC-insured total for a year = its CB row + its SI row (omit charterClass to fetch both).";
// ★S4 / P3 — money vs count units + the NIM foot-gun + the no-ratios fact.
const SUMMARY_UNITS_NOTE =
  "ASSET/DEP/NETINC/EQ/NIM are $thousands, normalized here to whole USD (×1,000); NIM is net interest INCOME (a dollar sum, surfaced as netInterestIncomeUSD), NOT the net-interest-margin ratio. BANKS/OFFICES/BRANCHES/EMPLOYEES are COUNTS (not scaled). This endpoint provides NO ratio fields (ROA/ROE); derive them from netIncomeUSD / totalAssetsUSD / totalEquityUSD if needed. A real 0 stays 0; an absent value is null (never 0).";
// ★ name-search scope (no institution-name search on /summary).
const SUMMARY_SCOPE_NOTE =
  "This is FDIC's aggregate roll-up endpoint; it has no institution-name search (FDIC's /summary `search` param is ignored and returns the whole year). To drill from an industry aggregate to individual institutions, use fdic_search_institutions (filter by state) or fdic_institution_financials (by CERT).";

/**
 * FDIC industry & state banking-sector ANNUAL aggregates (`/banks/summary`) — the
 * FIRST aggregate/statistical FDIC tool. Exact-key structured inputs (all optional,
 * AND-combined): `year` (→ YEAR filter), `state` (→ STALP filter, ★S2 — STALP NOT
 * PSTALP; accepts a jurisdiction code OR a roll-up code USA/US/OT/PI), `charterClass`
 * (→ CB_SI filter; CB/SI) → the `filters` param; plus `limit`/`offset`/`sortBy`/
 * `sortOrder` (default YEAR DESC → newest aggregate year first). Fixed field
 * projection. NO name/city filter and NEVER a `search=` param. Consumes the IDENTICAL
 * fetch → 3-envelope guard → pagination machinery as tools 1–4.
 *
 * HONESTY: EXACT `meta.total` → exact totalAvailable + hasMore (P1; live YEAR:2023 →
 * 121, stable across offset); the 3-envelope drift-guard makes the ONLY honest empty
 * `200 + total:0 + data:[]`, everything else THROWS (P2); money (ASSET/DEP/NETINC/EQ/
 * NIM) is $thousands → whole USD ×1000 null-never-0, counts (BANKS/OFFICES/BRANCHES/
 * NUMEMP) pass through un-scaled (P3; a genuine 0 stays 0, absent → null); ★NIM is net
 * interest INCOME (scaled + relabeled netInterestIncomeUSD), NOT the margin ratio (S4);
 * ★scope/isRollup are derived per row from the explicit roll-up STALP set so a roll-up
 * never masquerades as a state (S2); charterClass is derived from CB_SI (S1); a
 * projected field absent from all records → fieldsUnavailable (B); the snapshot build
 * time is disclosed.
 */
export async function industrySummary(args: {
  year?: number;
  state?: string;
  charterClass?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: string;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  // Default YEAR DESC (newest aggregate year first) when the server's Zod default did
  // not supply one (defensive — the server always defaults sortBy=YEAR/DESC).
  const sort = sortParams(args.sortBy ?? "YEAR", args.sortOrder ?? "DESC", SUMMARY_SORT_FIELDS, "summary");

  const filters = buildSummaryFilters({
    year: args.year,
    state: args.state,
    charterClass: args.charterClass,
  });

  const params = new URLSearchParams();
  if (filters) params.set("filters", filters);
  params.set("fields", SUMMARY_FIELDS);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sort.sort_by) {
    params.set("sort_by", sort.sort_by);
    params.set("sort_order", sort.sort_order as string);
  }
  params.set("format", "json");

  const body = await getFdic(ENDPOINT_SUMMARY, params);
  const env = parseEnvelope(body);
  const records = env.records.map(mapSummary);
  const returned = records.length;
  const totalAvailable = env.totalAvailable;
  const hasMore = returned > 0 && offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  const filtersApplied: string[] = [];
  if (args.year !== undefined) filtersApplied.push("year");
  if (args.state !== undefined) filtersApplied.push("state");
  if (args.charterClass !== undefined) filtersApplied.push("charterClass");
  if (sort.sort_by) filtersApplied.push("sort");

  const notes: string[] = [
    freshnessNote(env.indexName, env.indexCreated),
    SUMMARY_ROLLUP_NOTE,
    SUMMARY_CHARTER_NOTE,
    SUMMARY_UNITS_NOTE,
    SUMMARY_SCOPE_NOTE,
  ];
  const fu = fieldsUnavailable(env.records, SUMMARY_PROJECTION);
  if (fu.length > 0) {
    // /banks/summary is a 2-D roll-up: some count fields (e.g. BANKS/OFFICES/
    // BRANCHES) are STRUCTURALLY absent for certain roll-up/territory rows
    // (e.g. the Pacific-Islands roll-up carries no bank/branch count) — that is
    // a legitimate structural absence, NOT necessarily a schema change. Disclose
    // the absence honestly without falsely diagnosing "schema drift".
    notes.push(
      `Requested field(s) ${fu.join(", ")} were not returned by FDIC for any record in this result set — for /banks/summary this is usually a structural absence (some count fields are not reported for certain roll-up or territory rows), though it can also indicate a schema change; the affected values are surfaced as null, never fabricated.`,
    );
  }

  return withMeta(
    { summary: records },
    {
      source: "api.fdic.gov/banks/summary (BankFind, keyless)",
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: fu,
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ═══════════════════════════════════════════════════════════════════
// Tool 6: fdic_risk_ratios (ADR-0040) — the FDIC counterparty-SOUNDNESS lane, a
// WITHIN-SOURCE DEPTH tool on the ALREADY-WIRED `/banks/financials` endpoint (NO new
// endpoint constant). The 5 existing FDIC tools surface only $-aggregates (assets /
// deposits / net income); this tool projects the CURATED RISK-RATIO catalog
// (profitability ROA/ROE, margin NIM, cost efficiency, capital adequacy leverage /
// tier-1 / total risk-based, asset quality net charge-offs) + the tier-1 capital
// LEVEL, keyed on CERT. Reuses the C116/C118-hardened adapter VERBATIM (getFdic /
// parseEnvelope 3-envelope guard / filterTerm allowlist + Set.has / sortParams
// enum+Set.has / EXACT meta.total pagination / freshness / thousandsToUsd / num). The
// NEW surface is the PER-FIELD-UNITS ratio catalog + honesty, all live-verified
// 2026-07-13:
//   ★P3 UNITS-IN-THE-KEY — a MODULE-CONSTANT catalog fieldCode→{outputKey,label,unit,
//     route}. The 9 PERCENT ratios (ROA/ROAPTX/ROE/NIMY/EEFFR/NTLNLSR/RBC1AAJ/RBC1RWAJ/
//     RBCRWAJ) route through `num` and are surfaced VERBATIM (NO scale, NO recompute);
//     the ONE $-amount (RBCT1J, tier-1 capital in $thousands) routes through
//     thousandsToUsd → tier1CapitalUSD (×1000). The unit rides the output KEY (…Pct /
//     …USD) AND the mandatory RATIO_UNITS_NOTE — a consumer never reads a 77.98%
//     efficiency ratio as a dollar amount or ×1000-scales a percent.
//   ★P3 NULL-NEVER-0 — a not-reported ratio → null (via `num`, which maps BOTH JSON
//     null and undefined → null), NEVER 0 (a false "no return / no capital"). FDIC
//     returns a not-reported ratio as an EXPLICIT null (key present, value null), NOT
//     an absent key — so we read every ratio via `num(rec.CODE)`, NEVER via
//     `'CODE' in rec` / `=== undefined` / hasOwnProperty (S2).
//   ★M1 (the BLOCKER) — the CBLR `RBCRWAJ=0` sentinel. LIVE: 37% of banks are
//     Community-Bank-Leverage-Ratio filers (CBLRIND:1) that return RBCRWAJ as a
//     LITERAL 0 (not null) while RBC1RWAJ is null and the leverage ratio RBC1AAJ is
//     populated + solvent. Routing RBCRWAJ verbatim through num yields num(0)=0 = a
//     false "0% total capital / insolvent" on healthy banks. FIX (CBLR-scoped, no
//     recompute, NO blanket 0→null): CBLRIND is added to the projection; when
//     CBLRIND===1 we map BOTH totalRiskBasedCapitalRatioPct AND
//     tier1RiskBasedCapitalRatioPct to null ("not applicable — CBLR framework") and
//     surface a per-row cblrFramework:boolean. Detection is via FDIC's OWN CBLRIND
//     flag — never a derived/recomputed ratio. Genuine zeros on OTHER fields
//     (NTLNLSR:0 = zero net charge-offs; /sod DEPSUMBR:0) are UNTOUCHED — this is NOT
//     a blanket 0→null.
//   ★P3 NO-RECOMPUTE — every ratio is FDIC's published value surfaced verbatim; the
//     tool never computes ROE=NETINC/EQ (or any ratio) itself (a computed ratio would
//     diverge from FDIC's official figure = a fabrication).
//   ★S2 per-code not-reported marker — each catalog entry carries an explicit
//     `notReported` marker ('null' | 'zero-sentinel-when-CBLR'): FDIC's not-reported
//     encoding is FIELD-SPECIFIC (RBC1RWAJ uses JSON null; RBCRWAJ uses a literal-0
//     sentinel in the CBLR cohort; NTLNLSR/EEFFR/NIMY 0 are GENUINE zeros). Any newly
//     added code MUST be live-validated for its 0/null encoding before shipping —
//     never assume the ROA/ROE null path generalizes.
// ═══════════════════════════════════════════════════════════════════

// ★P3 — the per-field UNIT of a catalog ratio: a PERCENT (surfaced verbatim via num,
// no scale) or a $-amount FDIC publishes in $thousands (×1000 via thousandsToUsd).
type RatioUnit = "percent" | "usd-thousands";
// ★S2 — the FIELD-SPECIFIC not-reported encoding marker. 'null' = FDIC returns an
// explicit JSON null when not reported (the ROA/ROE/… path). 'zero-sentinel-when-CBLR'
// = FDIC returns a LITERAL 0 sentinel for the risk-based capital ratios when the bank
// files under the CBLR framework (the M1 blocker) — a 0 there is NOT a real 0%.
type RatioNotReported = "null" | "zero-sentinel-when-CBLR";
type RatioEntry = {
  code: string; // the FDIC field code (live-verified valid — a typo would silently drop off the wire)
  outputKey: string; // the output key WITH its unit suffix (…Pct / …USD)
  label: string; // human label (from the FDIC RIS / Call-Report data dictionary)
  unit: RatioUnit;
  notReported: RatioNotReported;
};

// ★P3 — the CURATED ratio catalog (a MODULE CONSTANT). Every code live-verified valid
// + its unit pinned from the FDIC data dictionary AND the live values. Do NOT include
// ROAA/ROEA (invalid codes — silently dropped from the record). Exported for the
// catalog-shape fault fixture.
const RATIO_CATALOG: readonly RatioEntry[] = [
  { code: "ROA", outputKey: "returnOnAssetsPct", label: "Return on assets", unit: "percent", notReported: "null" },
  { code: "ROAPTX", outputKey: "preTaxReturnOnAssetsPct", label: "Pretax return on assets", unit: "percent", notReported: "null" },
  { code: "ROE", outputKey: "returnOnEquityPct", label: "Return on equity", unit: "percent", notReported: "null" },
  { code: "NIMY", outputKey: "netInterestMarginPct", label: "Net interest margin", unit: "percent", notReported: "null" },
  { code: "EEFFR", outputKey: "efficiencyRatioPct", label: "Efficiency ratio (noninterest expense / revenue)", unit: "percent", notReported: "null" },
  { code: "NTLNLSR", outputKey: "netChargeOffsToLoansPct", label: "Net charge-offs to loans & leases", unit: "percent", notReported: "null" },
  { code: "RBC1AAJ", outputKey: "leverageRatioPct", label: "Leverage (core capital) ratio", unit: "percent", notReported: "null" },
  // ★M1 — the two risk-based capital ratios carry the CBLR literal-0 / null sentinel.
  { code: "RBC1RWAJ", outputKey: "tier1RiskBasedCapitalRatioPct", label: "Tier-1 risk-based capital ratio", unit: "percent", notReported: "zero-sentinel-when-CBLR" },
  { code: "RBCRWAJ", outputKey: "totalRiskBasedCapitalRatioPct", label: "Total risk-based capital ratio", unit: "percent", notReported: "zero-sentinel-when-CBLR" },
  { code: "RBCT1J", outputKey: "tier1CapitalUSD", label: "Tier-1 (core) capital", unit: "usd-thousands", notReported: "null" },
] as const;

export { RATIO_CATALOG };

// Fixed field projection on the wire (CERT/REPDTE/ID + CBLRIND [★M1 sentinel detection]
// + every catalog code). Built FROM the catalog so a catalog edit can never drift from
// the wire projection.
const RATIO_CODES: readonly string[] = RATIO_CATALOG.map((e) => e.code);
const RATIO_FIELDS = ["CERT", "REPDTE", "CBLRIND", ...RATIO_CODES, "ID"].join(",");
// The returned-fields (B) disclosure projection. FDIC returns a not-reported ratio as
// an EXPLICIT null (key PRESENT) — so a code shows in Object.keys even when null, and
// fieldsUnavailable fires ONLY on a genuinely-absent key (real schema drift / a code
// FDIC does not publish for these rows), never on a normal not-reported null.
const RATIO_PROJECTION = ["CERT", "REPDTE", "CBLRIND", ...RATIO_CODES, "ID"] as const;

// ★S1 — the ratio filter-FIELD allowlist (P4 belt-and-suspenders). CERT + optional
// REPDTE, both NUMERIC (emitted bare by filterTerm). Do NOT reuse FIN_FILTER_FIELDS
// ({CERT}) — it would THROW on REPDTE. Exported for the fault fixture.
const RATIO_FILTER_FIELDS: ReadonlySet<string> = new Set(["CERT", "REPDTE"]);
// sortBy allowlist (mirrors the server's Zod enum; a Set.has recheck in sortParams →
// an unknown sort field is invalid_input BEFORE fetch).
const RATIO_SORT_FIELDS: ReadonlySet<string> = new Set(["REPDTE", "ROA", "ROE", "RBCRWAJ", "EEFFR"]);

export { RATIO_FILTER_FIELDS };

/**
 * Build the risk-ratio `filters` string — `cert`→`CERT:<int>` (REQUIRED, numeric →
 * bare) + optional `reportDate`→`REPDTE:<int>` (numeric → bare, a YYYYMMDD quarter-end).
 * Both fields are on RATIO_FILTER_FIELDS (NOT FIN_FILTER_FIELDS, which is {CERT} and
 * would throw on REPDTE — S1). Terms joined with ` AND `. Exported for the fault fixtures.
 */
export function buildRatioFilters(inp: { cert: number; reportDate?: number }): string {
  const terms: string[] = [];
  terms.push(filterTerm("CERT", String(inp.cert), RATIO_FILTER_FIELDS));
  if (inp.reportDate !== undefined)
    terms.push(filterTerm("REPDTE", String(inp.reportDate), RATIO_FILTER_FIELDS));
  return terms.join(" AND ");
}

/**
 * ★M1 — detect the Community Bank Leverage Ratio framework via FDIC's OWN `CBLRIND`
 * flag (CBLRIND===1). A CBLR filer does NOT report risk-based capital ratios: FDIC
 * returns RBCRWAJ as a LITERAL 0 sentinel (not null) and RBC1RWAJ as null. Detection is
 * strictly the flag — NO derived/recomputed ratio, NO blanket 0→null. Exported for the
 * fault fixture. (num maps a string/number/null CBLRIND consistently; an absent CBLRIND
 * → null → not CBLR → the ratios pass through verbatim.)
 */
export function isCblrFramework(rec: Record<string, unknown>): boolean {
  return num(rec.CBLRIND) === 1;
}

export type FdicRiskRatios = {
  cert: number | null;
  reportDate: number | null;
  cblrFramework: boolean;
  returnOnAssetsPct: number | null;
  preTaxReturnOnAssetsPct: number | null;
  returnOnEquityPct: number | null;
  netInterestMarginPct: number | null;
  efficiencyRatioPct: number | null;
  netChargeOffsToLoansPct: number | null;
  leverageRatioPct: number | null;
  tier1RiskBasedCapitalRatioPct: number | null;
  totalRiskBasedCapitalRatioPct: number | null;
  tier1CapitalUSD: number | null;
  id: string | null;
};

/**
 * ★P3 + ★M1 — map ONE `/financials` record to the ratio row. The catalog drives the
 * per-field route: a PERCENT code → `num` VERBATIM (no scale, null-never-0); the
 * $-amount RBCT1J → `thousandsToUsd` (×1000, null-guard BEFORE the multiply). ★M1: when
 * the bank files under CBLR (CBLRIND===1) the two `zero-sentinel-when-CBLR` codes
 * (RBCRWAJ / RBC1RWAJ) map to NULL (never the 0 sentinel / never a false 0% capital);
 * a per-row `cblrFramework` explains the null. Genuine zeros on the other codes
 * (NTLNLSR:0 …) are surfaced verbatim by `num` — this is NOT a blanket 0→null.
 */
function mapRiskRatios(rec: Record<string, unknown>): FdicRiskRatios {
  const cblr = isCblrFramework(rec);
  const r: Record<string, number | null> = {};
  for (const entry of RATIO_CATALOG) {
    // ★M1 — CBLR-scoped sentinel → null (BOTH risk-based capital ratios), never 0.
    if (cblr && entry.notReported === "zero-sentinel-when-CBLR") {
      r[entry.outputKey] = null;
      continue;
    }
    // ★P3 — $-amount ×1000 (thousandsToUsd); percent verbatim (num, no scale). Both
    // are null-never-0 (num / thousandsToUsd map null/undefined/""/"null" → null).
    r[entry.outputKey] =
      entry.unit === "usd-thousands" ? thousandsToUsd(rec[entry.code]) : num(rec[entry.code]);
  }
  // Each key is guaranteed populated by the catalog loop above; `?? null` only
  // satisfies noUncheckedIndexedAccess (an unexpected catalog-key drift → null,
  // never undefined — still null-never-0).
  return {
    cert: num(rec.CERT),
    reportDate: num(rec.REPDTE),
    cblrFramework: cblr,
    returnOnAssetsPct: r.returnOnAssetsPct ?? null,
    preTaxReturnOnAssetsPct: r.preTaxReturnOnAssetsPct ?? null,
    returnOnEquityPct: r.returnOnEquityPct ?? null,
    netInterestMarginPct: r.netInterestMarginPct ?? null,
    efficiencyRatioPct: r.efficiencyRatioPct ?? null,
    netChargeOffsToLoansPct: r.netChargeOffsToLoansPct ?? null,
    leverageRatioPct: r.leverageRatioPct ?? null,
    tier1RiskBasedCapitalRatioPct: r.tier1RiskBasedCapitalRatioPct ?? null,
    totalRiskBasedCapitalRatioPct: r.totalRiskBasedCapitalRatioPct ?? null,
    tier1CapitalUSD: r.tier1CapitalUSD ?? null,
    id: str(rec.ID),
  };
}

// ─── risk-ratio disclosure notes ───────────────────────────────────
// ★P3 + ★M1 — units in the key + the corrected CBLR honesty (does NOT promise every
// shown 0 is real; a null capital ratio on a CBLR bank is a normal framework artifact).
const RATIO_UNITS_NOTE =
  "Each *Pct field is an FDIC-published PERCENTAGE surfaced verbatim (ROA/ROE/margin/efficiency/capital ratios) — do NOT read it as a dollar amount and do NOT ×1000-scale it. tier1CapitalUSD is a DOLLAR amount (FDIC publishes it in $thousands; normalized here ×1,000). A null ratio means FDIC did not report that ratio for this bank/period — it is NOT 0% (never read a null ratio as 'no return / no capital'). Banks reporting under the Community Bank Leverage Ratio (CBLR) framework (cblrFramework:true) do NOT report the risk-based capital ratios: FDIC returns a literal 0 for the total risk-based ratio, which this tool maps to null for BOTH tier1RiskBasedCapitalRatioPct and totalRiskBasedCapitalRatioPct — a null risk-based capital ratio here is frequently a NORMAL framework artifact (read it alongside the populated leverageRatioPct), not a red flag or a real 0% capital reading. Ratios are surfaced exactly as FDIC computes them; none is recomputed.";
const RATIO_NOT_DETERMINATION_NOTE =
  "FDIC risk ratios are reported regulatory metrics from the bank's Call Report, NOT a soundness rating, safety-and-soundness examination result, or failure prediction. A single-period ratio is a snapshot; read the time-series and cross-check the institution's condition (fdic_search_institutions for status, fdic_bank_failures for resolution history, fdic_institution_history for structural changes). FDIC keys on CERT, not SAM UEI/DUNS.";
const RATIO_EMPTY_NOTE =
  "No financial report is on record for this CERT/period — this does NOT mean the bank is unsound or unrated; the CERT may be wrong, or the bank may not have filed for this period. Confirm the CERT via fdic_search_institutions.";

/**
 * FDIC counterparty RISK RATIOS for ONE institution by `cert` (`/banks/financials` —
 * the ALREADY-wired endpoint; NO new endpoint constant). Structured inputs: `cert`
 * (REQUIRED → CERT), optional `reportDate` (→ REPDTE, a YYYYMMDD quarter-end), plus
 * `limit`/`offset`/`sortBy` (allowlist {REPDTE,ROA,ROE,RBCRWAJ,EEFFR}, default REPDTE)/
 * `sortOrder` (default DESC → newest quarter first). Consumes the IDENTICAL fetch →
 * 3-envelope guard → pagination machinery as tools 1–5.
 *
 * HONESTY: EXACT `meta.total` → exact totalAvailable + hasMore (P1); the 3-envelope
 * drift-guard makes the ONLY honest empty `200 + total:0 + data:[]`, everything else
 * THROWS (P2); ★P3 percent ratios surfaced VERBATIM via num (null-never-0, NO scale, NO
 * recompute), the ONE $-amount (RBCT1J) via thousandsToUsd → tier1CapitalUSD; ★M1 the
 * CBLR risk-based capital ratios map to null (never the 0 sentinel) with a per-row
 * cblrFramework flag; a projected field absent from all records → fieldsUnavailable (B);
 * the snapshot build time is disclosed.
 */
export async function riskRatios(args: {
  cert: number;
  reportDate?: number;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: string;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  // Default REPDTE DESC (newest quarter first) when the server's Zod default did not
  // supply one (defensive — the server always defaults sortBy=REPDTE/DESC).
  const sort = sortParams(
    args.sortBy ?? "REPDTE",
    args.sortOrder ?? "DESC",
    RATIO_SORT_FIELDS,
    "financials",
  );

  const params = new URLSearchParams();
  params.set("filters", buildRatioFilters({ cert: args.cert, reportDate: args.reportDate }));
  params.set("fields", RATIO_FIELDS);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sort.sort_by) {
    params.set("sort_by", sort.sort_by);
    params.set("sort_order", sort.sort_order as string);
  }
  params.set("format", "json");

  const body = await getFdic(ENDPOINT_FINANCIALS, params);
  const env = parseEnvelope(body);
  const records = env.records.map(mapRiskRatios);
  const returned = records.length;
  const totalAvailable = env.totalAvailable;
  const hasMore = returned > 0 && offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  const filtersApplied: string[] = ["cert"];
  if (args.reportDate !== undefined) filtersApplied.push("reportDate");
  if (sort.sort_by) filtersApplied.push("sort");

  const notes: string[] = [
    freshnessNote(env.indexName, env.indexCreated),
    RATIO_UNITS_NOTE,
    RATIO_NOT_DETERMINATION_NOTE,
  ];
  if (totalAvailable === 0) notes.push(RATIO_EMPTY_NOTE);
  const fu = fieldsUnavailable(env.records, RATIO_PROJECTION);
  if (fu.length > 0) {
    notes.push(
      `Requested field(s) ${fu.join(", ")} were not returned by FDIC for any record in this result set — the affected values are surfaced as null (never fabricated); this can be a ratio FDIC does not publish for these institution(s)/period(s), or a schema change.`,
    );
  }

  return withMeta(
    { cert: args.cert, ratios: records },
    {
      source: "api.fdic.gov/banks/financials (BankFind, keyless)",
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: fu,
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ═══════════════════════════════════════════════════════════════════
// Tool 7: fdic_branch_deposits (ADR-0040) — the FDIC branch-deposit footprint
// (`/banks/sod`, Summary of Deposits): the annual June-30 branch-office deposit
// distribution ("where does this bank hold deposits, and how concentrated?"). ONE new
// fixed endpoint constant `ENDPOINT_SOD = "sod"` on getFdic's `/banks/${endpoint}`
// template (NO caller value on the path). Reuses the C116/C118-hardened adapter VERBATIM
// (getFdic / parseEnvelope 3-envelope guard / filterTerm allowlist + Set.has + the C118
// non-numeric quote / sortParams enum+Set.has / EXACT meta.total pagination / freshness /
// thousandsToUsd / num / str), live-verified 2026-07-13:
//   ★S1 — the SOD filter-FIELD allowlist is {CERT, STALPBR, YEAR} (its OWN Set — NOT
//     FIN_FILTER_FIELDS). LOAD-BEARING: a bad /sod filter field silently returns
//     total:0 (a FALSE-empty, NOT a 400), so an un-allowlisted/mistyped/injected field
//     must be rejected BY CONSTRUCTION before the wire.
//   ★C118 — the state field STALPBR is non-numeric → filterTerm DOUBLE-QUOTES it
//     (Oregon `STALPBR:"OR"` is Lucene-operator-safe; bare `STALPBR:OR` → live HTTP 400).
//   ★P3 — DEPSUMBR (branch deposits, $thousands) → thousandsToUsd → depositsUSD
//     (null-guard BEFORE the ×1000); a GENUINE 0 stays 0, an absent value → null. YEAR
//     is a JSON integer via num; names/city/address/zip via str.
//   ★freshness — the /sod index is a DISTINCT ANNUAL snapshot (sod_*), far less fresh
//     than the quarterly /financials index — disclosed via freshnessNote + a snapshot note.
//   No PII — bank-BRANCH facility data (branch name/address/city/state/zip/deposits),
//   public commercial-bank infrastructure; no officer/personal-contact fields.
// ═══════════════════════════════════════════════════════════════════

// Fixed endpoint constant — the TOOL chooses it; NO caller value on the path (SSRF core).
const ENDPOINT_SOD = "sod";

// Fixed field projection on the wire (every field live-verified valid).
const SOD_FIELDS = "CERT,NAMEFULL,BRNUM,NAMEBR,CITYBR,STALPBR,ZIPBR,ADDRESBR,DEPSUMBR,YEAR,ID";
const SOD_PROJECTION = [
  "CERT",
  "NAMEFULL",
  "BRNUM",
  "NAMEBR",
  "CITYBR",
  "STALPBR",
  "ZIPBR",
  "ADDRESBR",
  "DEPSUMBR",
  "YEAR",
  "ID",
] as const;

// ★S1 — the SOD filter-FIELD allowlist (P4 belt-and-suspenders; LOAD-BEARING — a bad
// /sod field is a silent total:0 false-empty, NOT a 400). CERT/YEAR numeric (bare),
// STALPBR non-numeric (C118-quoted). Do NOT reuse FIN_FILTER_FIELDS ({CERT} — would
// throw on STALPBR/YEAR). Exported for the fault fixture.
const SOD_FILTER_FIELDS: ReadonlySet<string> = new Set(["CERT", "STALPBR", "YEAR"]);
// sortBy allowlist (mirrors the server's Zod enum; a Set.has recheck in sortParams →
// an unknown sort field is invalid_input BEFORE fetch; live `sort_by=NOTAFIELD` → 400).
const SOD_SORT_FIELDS: ReadonlySet<string> = new Set(["YEAR", "DEPSUMBR"]);

export { SOD_FILTER_FIELDS };

/**
 * Build the /sod `filters` string — `cert`→`CERT:<int>` (numeric → bare), `state`→
 * `STALPBR:"<code>"` (★C118 non-numeric → DOUBLE-QUOTED; Oregon `STALPBR:"OR"` is
 * operator-safe), `year`→`YEAR:<int>` (numeric → bare). All fields on SOD_FILTER_FIELDS
 * (★S1). Terms joined with ` AND `. Returns "" when there is no structured filter clause.
 * Exported for the fault fixtures.
 */
export function buildSodFilters(inp: { cert?: number; state?: string; year?: number }): string {
  const terms: string[] = [];
  if (inp.cert !== undefined) terms.push(filterTerm("CERT", String(inp.cert), SOD_FILTER_FIELDS));
  if (inp.state !== undefined) terms.push(filterTerm("STALPBR", inp.state, SOD_FILTER_FIELDS));
  if (inp.year !== undefined) terms.push(filterTerm("YEAR", String(inp.year), SOD_FILTER_FIELDS));
  return terms.join(" AND ");
}

export type FdicBranchDeposit = {
  cert: number | null;
  institutionName: string | null;
  branchNumber: number | null;
  branchName: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  address: string | null;
  depositsUSD: number | null;
  year: number | null;
  id: string | null;
};

function mapBranchDeposit(rec: Record<string, unknown>): FdicBranchDeposit {
  return {
    cert: num(rec.CERT),
    institutionName: str(rec.NAMEFULL),
    branchNumber: num(rec.BRNUM),
    branchName: str(rec.NAMEBR),
    city: str(rec.CITYBR),
    state: str(rec.STALPBR),
    zip: str(rec.ZIPBR),
    address: str(rec.ADDRESBR),
    // ★P3 — DEPSUMBR is $thousands → whole USD ×1000 (null-guard BEFORE the multiply);
    // a GENUINE 0 stays 0, an absent value → null (never 0).
    depositsUSD: thousandsToUsd(rec.DEPSUMBR),
    year: num(rec.YEAR),
    id: str(rec.ID),
  };
}

// ─── /sod disclosure notes ─────────────────────────────────────────
const SOD_UNITS_NOTE =
  "depositsUSD is FDIC's DEPSUMBR (branch-office deposits), published in $thousands and normalized here to whole USD (×1,000). A real 0 stays 0; an absent value is null (never 0).";
const SOD_SNAPSHOT_NOTE =
  "Summary of Deposits is an ANNUAL June-30 branch-office snapshot (a DISTINCT index, far less fresh than the quarterly /financials data). Branch name/city/address are shown per row but the endpoint filters only by cert/state/year — resolve a bank's CERT via fdic_search_institutions.";
const SOD_EMPTY_NOTE =
  "No Summary-of-Deposits branch records match — the bank may report no branches for this year, or the CERT/state/year filter may not match; SOD is an annual June-30 snapshot. Confirm the CERT via fdic_search_institutions.";

/**
 * FDIC branch-deposit footprint (`/banks/sod`, Summary of Deposits). Structured inputs
 * (all optional, AND-combined; ≥1 recommended): `cert` (→ CERT), `state` (→ STALPBR,
 * ★C118-quoted), `year` (→ YEAR), plus `limit`/`offset`/`sortBy` (allowlist
 * {YEAR,DEPSUMBR}, default YEAR)/`sortOrder` (default DESC → newest snapshot first).
 * Consumes the IDENTICAL fetch → 3-envelope guard → pagination machinery as tools 1–6.
 *
 * HONESTY: EXACT `meta.total` → exact totalAvailable + hasMore (P1; live: CERT 10004 →
 * 74, STALPBR:"OR" → 31093); the 3-envelope drift-guard makes the ONLY honest empty
 * `200 + total:0 + data:[]`, everything else THROWS (P2); ★the /sod false-empty landmine
 * (a bad filter field → silent total:0) is neutralized by the S1 allowlist-by-
 * construction; DEPSUMBR is $thousands → whole USD ×1000 null-never-0 (P3; a genuine 0
 * stays 0, absent → null); a projected field absent from all records → fieldsUnavailable
 * (B); the DISTINCT annual snapshot build time is disclosed.
 */
export async function branchDeposits(args: {
  cert?: number;
  state?: string;
  year?: number;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortOrder?: string;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  // Default YEAR DESC (newest snapshot first) when the server's Zod default did not
  // supply one (defensive — the server always defaults sortBy=YEAR/DESC).
  const sort = sortParams(args.sortBy ?? "YEAR", args.sortOrder ?? "DESC", SOD_SORT_FIELDS, "sod");

  const filters = buildSodFilters({ cert: args.cert, state: args.state, year: args.year });

  const params = new URLSearchParams();
  if (filters) params.set("filters", filters);
  params.set("fields", SOD_FIELDS);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (sort.sort_by) {
    params.set("sort_by", sort.sort_by);
    params.set("sort_order", sort.sort_order as string);
  }
  params.set("format", "json");

  const body = await getFdic(ENDPOINT_SOD, params);
  const env = parseEnvelope(body);
  const records = env.records.map(mapBranchDeposit);
  const returned = records.length;
  const totalAvailable = env.totalAvailable;
  const hasMore = returned > 0 && offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  const filtersApplied: string[] = [];
  if (args.cert !== undefined) filtersApplied.push("cert");
  if (args.state !== undefined) filtersApplied.push("state");
  if (args.year !== undefined) filtersApplied.push("year");
  if (sort.sort_by) filtersApplied.push("sort");

  const notes: string[] = [
    freshnessNote(env.indexName, env.indexCreated),
    SOD_UNITS_NOTE,
    SOD_SNAPSHOT_NOTE,
  ];
  if (totalAvailable === 0) notes.push(SOD_EMPTY_NOTE);
  const fu = fieldsUnavailable(env.records, SOD_PROJECTION);
  if (fu.length > 0) {
    notes.push(
      `Requested field(s) ${fu.join(", ")} were not returned by FDIC for any record — possible schema drift / rename.`,
    );
  }

  return withMeta(
    { branches: records },
    {
      source: "api.fdic.gov/banks/sod (BankFind Summary of Deposits, keyless)",
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: fu,
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
