/**
 * FAR / DFARS clause lookup (keyless) — the authoritative clause text + its
 * prescription, from the eCFR **versioner full** endpoint.
 *
 * Why this exists (and why NOT `ecfr_search`)
 * -------------------------------------------
 * The shipped full-text `ecfr_search` mis-ranks EXACT clause numbers: a bare
 * `52.212-4` query returns GSAM **552**.212-4 above the real FAR 52.212-4
 * (doc-09 §1.2). A proposal writer needs the AUTHORITATIVE clause text AND the
 * rule that says WHEN it applies ("As prescribed in …") — the exact pair. The
 * clean path is the versioner full endpoint, which `src/ecfr.ts` does not call:
 *
 *   GET /api/versioner/v1/full/{date}/title-48.xml?section={clause}
 *
 * keyless, HTTP 200 (~40 KB XML) for a real clause, clean HTTP 404
 * `{"error":"No matching content found."}` for an absent one. Title 48 = FAR.
 * `{date}` defaults to Title 48 `up_to_date_as_of` (from listTitles, cached).
 *
 * TRUTHFULNESS invariants (a reviewer WILL try to break these):
 *   - A DOWN/failing eCFR service must NEVER read as "clause not found": only a
 *     genuine HTTP 404 maps to `not_found`; any other fetch error propagates
 *     with fetchWithRetry's classification (retryable 5xx/network/etc.).
 *   - A genuinely-absent clause is `not_found` (retryable:false), NEVER a fake
 *     empty clause. Clause text is never silently dropped or fabricated.
 *   - A prescription-section fetch failure is NON-FATAL: `prescription:null` +
 *     disclosed in `_meta.notes`; it never crashes the clause result.
 *   - `farOverhaulRisk` carries NO fabricated FAR-case numbers/dates — only the
 *     fixed structural caveat + the real authoritative-list / deviation URLs.
 *
 * Self-contained: imports only fetchWithRetry (+ ToolErrorCarrier) from
 * ./errors.js, memoize from ./cache.js, listTitles from ./ecfr.js, and withMeta
 * from ./meta.js — the versioner XML parse lives here (ecfr.ts's stripHtml is
 * private and stays private).
 */

import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
import { memoize } from "./cache.js";
import { listTitles } from "./ecfr.js";
import { withMeta } from "./meta.js";

const ECFR = "https://www.ecfr.gov/api";

/** The regulation family a clause number belongs to (from its prefix). */
type Regulation = "FAR" | "DFARS" | "GSAM" | "other";

/**
 * Fetch a versioner-full XML document as text. Mirrors ecfr.ts's fetchJson
 * shape (fetchWithRetry + a 15s AbortSignal) but asks for XML and returns the
 * raw body — the versioner endpoint serves `title-48.xml`. fetchWithRetry
 * throws a classified ToolErrorCarrier on any non-2xx (404 → not_found, 5xx →
 * upstream_unavailable, network → upstream_unavailable), which callers here
 * either map (404 on the CLAUSE) or let propagate.
 */
async function fetchText(url: string): Promise<string> {
  const r = await fetchWithRetry(
    url,
    {
      headers: { Accept: "application/xml" },
      signal: AbortSignal.timeout(15_000),
    },
    `ecfr:${url.split("/api/")[1] ?? url}`,
  );
  return await r.text();
}

/**
 * Strip XML tags → clean, paragraph-preserving plain text. The versioner body
 * is block XML (`<P>`, `<HD1>`, `<EXTRACT>`, `<I>`…); we drop the tags but keep
 * paragraph boundaries as spaces so the clause reads as continuous prose, then
 * decode the handful of numeric/entity refs the feed uses (—, &, ", ', <, >).
 */
function stripXml(s: string): string {
  return s
    // Block-level closers become a space so paragraphs don't run together.
    .replace(/<\/(P|HD1|HEAD|EXTRACT|CITA|EDNOTE|PSPACE|HED|DIV8|LI)>/gi, " ")
    // Drop every remaining tag.
    .replace(/<[^>]+>/g, " ")
    // Decode the entities the eCFR XML actually emits.
    .replace(/&#8212;|&mdash;/gi, "—")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8217;|&rsquo;/gi, "’")
    .replace(/&#8220;|&ldquo;/gi, "“")
    .replace(/&#8221;|&rdquo;/gi, "”")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // Collapse whitespace.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalize a raw clauseNumber to its bare `NN.NNN-N` / `NNN.NNN-NNNN` core:
 * strip a leading `FAR`/`DFARS` (case-insensitive) and surrounding
 * whitespace/stray punctuation. Returns "" if nothing usable remains.
 */
function normalizeClauseNumber(raw: string): string {
  return (raw ?? "")
    .trim()
    // Leading regulation prefix (FAR 52.212-4 / DFARS 252.204-7012).
    .replace(/^\s*(?:d?far[s]?)\b[\s.:#-]*/i, "")
    // Strip anything that isn't part of a clause number (keep digits . -).
    .replace(/[^\d.\-]/g, "")
    .trim();
}

const CLAUSE_RE = /^\d{1,3}\.\d{3,4}-\d{1,4}$/;

/** Regulation family from the clause-number prefix (deterministic, no fetch). */
function regulationFor(clauseNumber: string): Regulation {
  if (/^252\./.test(clauseNumber)) return "DFARS";
  if (/^2\d\d\./.test(clauseNumber)) return "DFARS";
  if (/^552\./.test(clauseNumber)) return "GSAM";
  if (/^52\./.test(clauseNumber)) return "FAR";
  return "other";
}

/**
 * The RFO (Revolutionary FAR Overhaul) currency caveat — an ALWAYS-PRESENT
 * structural flag, NOT a per-clause claim. eCFR reflects the CODIFIED FAR only;
 * the RFO is replacing FAR parts via agency class deviations that may not appear
 * in eCFR, so a clause can be current in the CFR yet operationally superseded.
 *
 * This is the HONEST design (doc-09 §3 baked unverified FAR-case numbers/dates
 * as [가설] — those go stale/wrong). We ship the never-stale-wrong version: no
 * fabricated specifics, only the fixed caveat + the real authoritative-list and
 * deviation URLs (all VERIFIED HTTP 200, 2026-07-04). `appliesTo` scopes the
 * caveat to the clause's own regulation family.
 */
function buildFarOverhaulRisk(regulation: Regulation) {
  return {
    note:
      "eCFR reflects the CODIFIED FAR only. The Revolutionary FAR Overhaul (RFO) is actively replacing FAR parts via agency class deviations that may NOT appear in eCFR — so this clause text can be technically current in the CFR yet operationally superseded. Verify the controlling deviation before relying on it.",
    authoritativeList: "https://www.acquisition.gov/far-overhaul",
    deviationSources: [
      "https://www.acquisition.gov/far-overhaul",
      "https://www.acquisition.gov/dfars",
      "https://www.acq.osd.mil/dpap/dars/",
    ],
    appliesTo: regulation,
  };
}

/** Title 48 currency metadata, cached (titles.json changes infrequently). */
async function title48Currency(): Promise<{
  upToDateAsOf: string | null;
  latestAmendedOn: string | null;
}> {
  return memoize("far:title48-currency", async () => {
    const { titles } = await listTitles();
    const t48 = titles.find((t) => t.number === 48);
    return {
      upToDateAsOf: t48?.upToDateAsOf ?? null,
      latestAmendedOn: t48?.latestAmendedOn ?? null,
    };
  });
}

/** Extract the first `<HEAD>…</HEAD>` inner text (tags stripped). */
function firstHead(xml: string): string | null {
  const m = xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/i);
  if (!m || m[1] === undefined) return null;
  const h = stripXml(m[1]);
  return h.length > 0 ? h : null;
}

/**
 * Does this body look like a REAL eCFR Title-48 section, vs an empty body, a
 * CDN/WAF HTML interstitial, or a truncated proxy response? (Defect-2 guard.)
 * Real versioner section XML carries an uppercase `<HEAD>…</HEAD>` plus
 * substantive text. The `<HEAD>` test is CASE-SENSITIVE on purpose: an HTML
 * challenge page uses lowercase `<head>`, and empty/truncated bodies carry
 * neither — so a hollow 200 fails this check and is refused rather than parsed
 * into a fake `complete:true` clause.
 */
function looksLikeSectionXml(xml: string): boolean {
  return /<HEAD>/.test(xml) && stripXml(xml).length >= 20;
}

/**
 * Fetch + parse ONE Title-48 section as a prescription reference (its heading +
 * stripped text). NON-FATAL by contract: returns null on ANY failure so a
 * prescription problem never sinks the clause result. Memoized by URL.
 */
async function fetchPrescription(
  baseSection: string,
  asOfDate: string,
): Promise<{ section: string; heading: string | null; text: string } | null> {
  const url = `${ECFR}/versioner/v1/full/${asOfDate}/title-48.xml?section=${baseSection}`;
  try {
    const xml = await memoize(`far:section:${asOfDate}:${baseSection}`, async () => {
      const body = await fetchText(url);
      // A hollow/interstitial 200 is a fetch FAILURE, not an empty prescription
      // (Defect-2, non-fatal path). Throw so it is NOT cached and becomes null.
      if (!looksLikeSectionXml(body))
        throw new Error("non-section prescription body");
      return body;
    });
    const heading = firstHead(xml);
    const text = stripXml(xml);
    return { section: baseSection, heading, text };
  } catch {
    // Any failure (404/5xx/network/parse/hollow-body) → null; caller discloses it.
    return null;
  }
}

export async function farClauseLookup(args: {
  clauseNumber: string;
  includePrescription?: boolean;
  asOfDate?: string;
}) {
  const clauseNumber = normalizeClauseNumber(args.clauseNumber ?? "");
  const includePrescription = args.includePrescription ?? true;

  // Defense-in-depth: the server Zod schema already rejects a non-matching
  // clauseNumber, but guard here too so far.ts is safe called directly.
  if (!CLAUSE_RE.test(clauseNumber)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid FAR/DFARS clause number '${args.clauseNumber}'. Expected a clause like 52.212-4, 252.204-7012, or 52.204-25 (optionally prefixed 'FAR'/'DFARS').`,
      retryable: false,
      upstreamEndpoint: "ecfr:versioner/v1/full/title-48",
    });
  }

  const regulation = regulationFor(clauseNumber);

  // asOfDate defaults to Title 48's up_to_date_as_of (cached).
  const currency = await title48Currency();
  const asOfDate = args.asOfDate ?? currency.upToDateAsOf ?? "";
  // Guard (Defect 1): never query a blank/invalid date. If currency could NOT be
  // resolved (titles.json returns 200 but Title 48 — or its up_to_date_as_of —
  // is missing/renamed → upToDateAsOf:null, WITHOUT throwing) AND the caller gave
  // no asOfDate, asOfDate is "". The versioner 404s on a blank-date URL, and that
  // 404 would be mislabeled "clause not found" — a lie about a real, existing
  // clause. This is a currency-RESOLUTION failure, not an absent clause.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new ToolErrorCarrier({
      kind: "schema_drift",
      message: `Could not resolve Title 48's current codification date from the eCFR titles endpoint (up_to_date_as_of unavailable) and no asOfDate was supplied. Refusing to query a blank date — the versioner would return HTTP 404, which must NOT be reported as a missing clause. Retry shortly, or pass an explicit asOfDate (YYYY-MM-DD).`,
      retryable: true,
      upstreamEndpoint: "ecfr:versioner/v1/titles.json",
    });
  }
  const isCurrent =
    currency.upToDateAsOf !== null && asOfDate === currency.upToDateAsOf;

  // ── Fetch the CLAUSE XML (memoized by URL). ─────────────────────────────
  const clauseUrl = `${ECFR}/versioner/v1/full/${asOfDate}/title-48.xml?section=${clauseNumber}`;
  let xml: string;
  try {
    xml = await memoize(`far:section:${asOfDate}:${clauseNumber}`, async () => {
      const body = await fetchText(clauseUrl);
      // Guard (Defect 2): a 200 with an empty body, a CDN/WAF HTML interstitial,
      // or a truncated proxy response must NOT be parsed into a hollow
      // `complete:true` clause (heading/text empty, yet ok:true). Require real
      // Title-48 section XML. Throwing HERE (inside the memoize producer) keeps
      // the bad body OUT of the cache so a retry re-fetches cleanly.
      if (!looksLikeSectionXml(body)) {
        throw new ToolErrorCarrier({
          kind: "upstream_unavailable",
          message: `The eCFR versioner returned HTTP 200 for ${clauseNumber} (as of ${asOfDate}) but the body was not a parseable Title 48 section (empty, truncated, or a CDN/WAF interstitial). Refusing to emit a hollow clause. Retry shortly.`,
          retryable: true,
          upstreamStatus: 200,
          upstreamEndpoint: "ecfr:versioner/v1/full/title-48",
        });
      }
      return body;
    });
  } catch (e) {
    // A genuine 404 → not_found NAMING the clause (never null/empty). Any OTHER
    // error (5xx/network/timeout) PROPAGATES with its classification so a DOWN
    // service is never misread as "clause not found".
    if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
      throw new ToolErrorCarrier({
        kind: "not_found",
        message: `FAR/DFARS clause ${clauseNumber} not found in Title 48 as of ${asOfDate}. (The eCFR versioner returned HTTP 404 "No matching content found" — the clause number may be wrong, reserved, or removed in this edition.)`,
        retryable: false,
        upstreamStatus: 404,
        upstreamEndpoint: "ecfr:versioner/v1/full/title-48",
      });
    }
    throw e;
  }

  // ── Parse the clause body. ──────────────────────────────────────────────
  const rawHead = firstHead(xml);
  // Strip a leading clause number if the HEAD duplicates it
  // ("52.212-4 Contract Terms…" → "Contract Terms…").
  const heading =
    rawHead != null
      ? rawHead.replace(new RegExp(`^${clauseNumber}\\s*[.:\\-—]?\\s*`), "").trim() ||
        rawHead
      : null;

  const revMatch = xml.match(/\(([A-Z]{3}\.?\s+\d{4})\)/);
  const revision = revMatch?.[1] ?? null;

  const preMatch = xml.match(
    /As prescribed in (\d{1,3}\.\d+(?:\([a-z0-9]+\))*)/i,
  );
  const prescribedIn = preMatch?.[1] ?? null;

  // Detect clause vs provision from the prescribing verb. DFARS uses BOTH
  // "insert the following …" and "use the following …" (Defect 3: the narrow
  // /insert/-only regex silently mislabeled DFARS provisions as clauses). When
  // NEITHER verb is present, default to "clause" but DISCLOSE it as inferred
  // (see the note pushed below) rather than assert it.
  const kindMatch = xml.match(/(?:insert|use) the following (clause|provision)/i);
  const kindDetected = kindMatch?.[1]?.toLowerCase() as
    | "clause"
    | "provision"
    | undefined;
  const kind: "clause" | "provision" = kindDetected ?? "clause";

  const text = stripXml(xml);

  // ── Optional prescription section (non-fatal). ──────────────────────────
  const notes: string[] = [];
  let prescription:
    | { section: string; heading: string | null; text: string }
    | null = null;
  let prescriptionDegraded = false;

  if (includePrescription && prescribedIn) {
    // Trim any trailing subparagraph to the base section: 12.301(b)(3) → 12.301.
    const baseSection = prescribedIn.replace(/\(.*$/, "");
    prescription = await fetchPrescription(baseSection, asOfDate);
    if (prescription === null) {
      prescriptionDegraded = true;
      notes.push(
        `The prescribing section ${baseSection} (from "As prescribed in ${prescribedIn}") could NOT be fetched — prescription is null. This is a partial result: the clause text above is complete, but the "when does this clause apply?" rule was not retrieved (fetch it directly at ${ECFR}/versioner/v1/full/${asOfDate}/title-48.xml?section=${baseSection}, or via ecfr on ${`https://www.ecfr.gov/current/title-48/section-${baseSection}`}).`,
      );
    }
  } else if (includePrescription && !prescribedIn) {
    notes.push(
      "No 'As prescribed in …' pointer was found in this clause's text, so no prescription section was fetched (prescription:null). Some provisions/clauses carry the prescription in the parent subpart rather than an inline opener.",
    );
  }

  // Disclose when `kind` was inferred rather than read from a verb (Defect 3):
  // an undetected verb defaults to "clause", which would silently mislabel a
  // provision — so the consumer is told the field is a default, not an assertion.
  if (kindDetected === undefined) {
    notes.push(
      'The instrument kind (clause vs provision) could NOT be determined from the text — no "insert/use the following clause/provision" verb was found — so kind defaults to "clause". Verify against the section heading if the clause-vs-provision distinction matters.',
    );
  }

  const ecfrUrl = `https://www.ecfr.gov/current/title-48/section-${clauseNumber}`;

  const farOverhaulRisk = buildFarOverhaulRisk(regulation);

  // Currency disclosures.
  if (!isCurrent) {
    notes.push(
      currency.upToDateAsOf
        ? `asOfDate ${asOfDate} is NOT Title 48's current codification date (${currency.upToDateAsOf}); this is a point-in-time read of the FAR as of ${asOfDate}, which may differ from the clause in force today.`
        : `Title 48's current codification date could not be confirmed from titles.json, so isCurrent is false; treat ${asOfDate} as the requested point-in-time edition.`,
    );
  }
  // The RFO caveat is ALWAYS surfaced (structural, never per-clause-fabricated).
  notes.push(
    `RFO caveat: eCFR carries the CODIFIED ${regulation} only. The Revolutionary FAR Overhaul is replacing FAR parts via agency class deviations that may not appear here — verify the controlling deviation (farOverhaulRisk.authoritativeList) before relying on this clause.`,
  );

  // Currency + provenance live in `data` (top-level), NOT in the meta partial:
  // the project's buildMeta (meta.ts) finalizes a FIXED-shape ResponseMeta and
  // drops unknown keys, so asOfDate/isCurrent/farOverhaulRisk passed via _meta
  // would be silently discarded. The design note anticipated this — carry them
  // where they actually survive. The honest completeness/degradation signals
  // (complete, fieldsUnavailable, notes) DO belong in _meta and are set there.
  const data = {
    clauseNumber,
    kind,
    regulation,
    heading,
    revision,
    text,
    prescribedIn,
    prescription,
    ecfrUrl,
    // Point-in-time provenance for THIS read (mirrors the design note's _meta
    // fields; placed in data so they are not dropped by buildMeta).
    asOfDate,
    titleUpToDateAsOf: currency.upToDateAsOf,
    titleLatestAmendedOn: currency.latestAmendedOn,
    isCurrent,
    // Always-present structural currency caveat (never fabricated specifics).
    farOverhaulRisk,
  };

  return withMeta(data, {
    source: "ecfr:versioner/full",
    keylessMode: true,
    // A single authoritative clause record.
    returned: 1,
    totalAvailable: 1,
    // A missing prescription is a genuine partial result → not complete.
    complete: prescriptionDegraded ? false : undefined,
    // fieldsUnavailable ONLY when we tried and failed to get the prescription.
    fieldsUnavailable: prescriptionDegraded ? ["prescription"] : [],
    filtersApplied: [],
    filtersDropped: [],
    notes,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// far_compliance_matrix — RFP cited-clause list → proposal-ready matrix.
//
// COMPOSES farClauseLookup: fan it out (bounded concurrency) over a deduped
// clause list and assemble a Section-L/M-ready matrix — each clause's text +
// prescription + whether it is a pass/fail eligibility GATE + the same currency
// caveat farClauseLookup carries.
//
// TRUTHFULNESS — the load-bearing split (the C19 lesson): each clause has THREE
// possible outcomes and "absent" is NEVER conflated with "couldn't fetch":
//   1. resolved         → a full row in `rows[]`.
//   2. not_found (404)  → `unresolved[]` (the clause genuinely isn't in Title 48).
//   3. any other error  → `errored[]` (a DOWN/failing eCFR — retryable — must NOT
//                          read as "clause doesn't exist"; invalid_input too).
// Every input clause lands in EXACTLY one bucket; summary.total proves it. Gate
// tags come ONLY from the verified static GATE_MAP — never guessed.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Eligibility-gate map (STATIC, verified live 2026-07-04 — headings confirmed).
 * A resolved row whose clauseNumber is a key here is a pass/fail award-eligibility
 * gate; the value is the disclosed label. Kept deliberately SMALL and defensible:
 * NEVER invent a gate meaning for a clause not in this map.
 */
const GATE_MAP: Record<string, string> = {
  "52.204-24":
    "Section 889 — covered-telecom/video-surveillance prohibition (award-eligibility gate)",
  "52.204-25":
    "Section 889 — covered-telecom/video-surveillance prohibition (award-eligibility gate)",
  "52.204-26":
    "Section 889 — covered-telecom/video-surveillance prohibition (award-eligibility gate)",
  "52.219-14":
    "Limitations on Subcontracting — set-aside compliance gate",
  "252.204-7012":
    "Safeguarding Covered Defense Information + cyber incident reporting (CUI cyber gate)",
  "252.204-7020": "NIST SP 800-171 DoD Assessment (cyber gate)",
  "252.204-7021": "CMMC compliance (cyber gate)",
};

/** Hard ceiling on clauses processed per call (after dedupe). Mirrors the Zod cap. */
const MATRIX_MAX_CLAUSES = 25;
/** Bounded fan-out width — small pool so we never fire 25 eCFR fetches at once. */
const MATRIX_CONCURRENCY = 5;

/** One resolved matrix row: farClauseLookup's honest fields + a gate flag. */
type MatrixRow = {
  clauseNumber: string;
  kind: "clause" | "provision";
  regulation: Regulation;
  heading: string | null;
  revision: string | null;
  prescribedIn: string | null;
  prescription:
    | { section: string; heading: string | null; text: string }
    | null;
  text: string;
  ecfrUrl: string;
  farOverhaulRisk: ReturnType<typeof buildFarOverhaulRisk>;
  /** The eligibility-gate label (from GATE_MAP), or null when not a mapped gate. */
  gate: string | null;
};

/** A clause that did not resolve, with a disclosed reason. */
type UnresolvedClause = { clauseNumber: string; reason: string };

/**
 * Run an async mapper over `items` with at most `width` in flight at once. A
 * lightweight promise pool (worker-draining a shared cursor): each worker pulls
 * the next index until the list is exhausted, so results are written back by
 * original index. Preserves input order and never fires more than `width`
 * concurrent fetches. Never rejects — the mapper itself must not throw (callers
 * here wrap each unit in try/catch).
 */
async function mapPool<T, R>(
  items: readonly T[],
  width: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(width, items.length));
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await mapper(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export async function farComplianceMatrix(args: {
  clauses: string[];
  asOfDate?: string;
  includePrescription?: boolean;
  flagGates?: boolean;
}) {
  const includePrescription = args.includePrescription ?? true;
  const flagGates = args.flagGates !== false; // default true; only false disables

  // ── Normalize + dedupe case-insensitively, then cap AFTER dedupe. ─────────
  // normalizeClauseNumber already lowercases nothing (clause numbers are digits),
  // but it strips FAR/DFARS prefixes + stray chars so "52.212-4", "FAR 52.212-4",
  // and " 52.212-4 " collapse to one key. We keep the FIRST spelling's normalized
  // form and preserve input order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const raw of args.clauses ?? []) {
    const norm = normalizeClauseNumber(raw ?? "");
    // Keep even a non-matching normalized token: farClauseLookup will classify it
    // as invalid_input → errored (NOT silently dropped). Dedupe on the normalized
    // key so a malformed value that appears twice is only reported once.
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(norm);
  }
  const clauses = deduped.slice(0, MATRIX_MAX_CLAUSES);
  const total = clauses.length;

  // ── Resolve currency ONCE up front (avoid resolving it 25×). ──────────────
  // farClauseLookup would resolve this per call; we resolve it here and pass an
  // explicit asOfDate into each call. If currency can't be resolved AND no
  // asOfDate was supplied, refuse with a SINGLE schema_drift rather than letting
  // 25 identical ones bubble up (and a blank-date URL must never 404 into a fake
  // "not found"). This mirrors farClauseLookup's Defect-1 guard.
  const currency = await title48Currency();
  const asOfDate = args.asOfDate ?? currency.upToDateAsOf ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new ToolErrorCarrier({
      kind: "schema_drift",
      message: `Could not resolve Title 48's current codification date from the eCFR titles endpoint (up_to_date_as_of unavailable) and no asOfDate was supplied. Refusing to build a matrix against a blank date — the versioner would return HTTP 404, which must NOT be reported as missing clauses. Retry shortly, or pass an explicit asOfDate (YYYY-MM-DD).`,
      retryable: true,
      upstreamEndpoint: "ecfr:versioner/v1/titles.json",
    });
  }

  // ── Fan out farClauseLookup with bounded concurrency, catching EACH clause
  // individually so one failure never sinks the matrix. ─────────────────────
  type Outcome =
    | { status: "resolved"; row: MatrixRow }
    | { status: "unresolved"; entry: UnresolvedClause }
    | { status: "errored"; entry: UnresolvedClause };

  const outcomes = await mapPool<string, Outcome>(
    clauses,
    MATRIX_CONCURRENCY,
    async (clauseNumber): Promise<Outcome> => {
      try {
        const res = await farClauseLookup({
          clauseNumber,
          asOfDate,
          includePrescription,
        });
        const d = res.data;
        const gate = flagGates ? GATE_MAP[d.clauseNumber] ?? null : null;
        const row: MatrixRow = {
          clauseNumber: d.clauseNumber,
          kind: d.kind,
          regulation: d.regulation,
          heading: d.heading,
          revision: d.revision,
          prescribedIn: d.prescribedIn,
          prescription: d.prescription,
          text: d.text,
          ecfrUrl: d.ecfrUrl,
          farOverhaulRisk: d.farOverhaulRisk,
          gate,
        };
        return { status: "resolved", row };
      } catch (e) {
        const kind =
          e instanceof ToolErrorCarrier ? e.toolError.kind : "unknown";
        const reason =
          e instanceof ToolErrorCarrier
            ? e.toolError.message
            : e instanceof Error
              ? e.message
              : String(e);
        // A genuine 404 (absent clause) → unresolved. ANY OTHER kind (a fetch/
        // service problem: upstream_unavailable / schema_drift / rate_limited /
        // invalid_input / unknown) → errored. A DOWN eCFR must NEVER read as
        // "clause doesn't exist".
        if (kind === "not_found") {
          return {
            status: "unresolved",
            entry: { clauseNumber, reason },
          };
        }
        return { status: "errored", entry: { clauseNumber, reason } };
      }
    },
  );

  const rows: MatrixRow[] = [];
  const unresolved: UnresolvedClause[] = [];
  const errored: UnresolvedClause[] = [];
  for (const o of outcomes) {
    if (o.status === "resolved") rows.push(o.row);
    else if (o.status === "unresolved") unresolved.push(o.entry);
    else errored.push(o.entry);
  }

  // ── Summary (must be internally consistent). ──────────────────────────────
  const resolved = rows.length;
  const far = rows.filter((r) => r.regulation === "FAR").length;
  const dfars = rows.filter((r) => r.regulation === "DFARS").length;
  const gsam = rows.filter((r) => r.regulation === "GSAM").length;
  const other = rows.filter((r) => r.regulation === "other").length;
  const gates = rows.filter((r) => r.gate !== null).length;
  const summary = {
    total, // deduped input count === resolved + unresolved.length + errored.length
    resolved,
    unresolved: unresolved.length,
    errored: errored.length,
    far,
    dfars,
    gsam,
    other,
    gates,
  };

  // ── Disclosing notes — one per non-empty bucket + a single currency caveat. ─
  const notes: string[] = [];
  // Disclose the cap if it dropped clauses (the MCP Zod schema rejects >25, so
  // this only fires for a direct call — but a silent drop is never acceptable).
  if (deduped.length > total) {
    notes.push(
      `Input had ${deduped.length} distinct clauses; capped at ${MATRIX_MAX_CLAUSES} — the ${deduped.length - total} beyond the cap were NOT processed (they appear in NONE of rows/unresolved/errored). Split the list across calls to cover them all.`,
    );
  }
  if (unresolved.length > 0) {
    notes.push(
      `${unresolved.length} clause(s) not found in Title 48 as of ${asOfDate} (listed in unresolved). The clause number(s) may be wrong, reserved, or removed in this edition — this IS a real answer, not a service problem.`,
    );
  }
  if (errored.length > 0) {
    notes.push(
      `${errored.length} clause(s) could not be fetched due to a service issue (listed in errored) — retry. This is NOT a confirmation they don't exist; a DOWN/failing eCFR is distinct from a genuinely-absent clause.`,
    );
  }
  // Surface the RFO currency caveat ONCE if any resolved row is FAR/DFARS (reuse
  // farClauseLookup's wording — eCFR carries only the CODIFIED FAR/DFARS).
  if (rows.some((r) => r.regulation === "FAR" || r.regulation === "DFARS")) {
    notes.push(
      `RFO caveat: eCFR carries the CODIFIED FAR/DFARS only. The Revolutionary FAR Overhaul is replacing FAR parts via agency class deviations that may not appear here — verify the controlling deviation (each row's farOverhaulRisk.authoritativeList) before relying on a clause.`,
    );
  }

  const data = { asOfDate, rows, unresolved, errored, summary };

  return withMeta(data, {
    source: "ecfr:versioner/full (matrix over far_clause_lookup)",
    keylessMode: true,
    returned: rows.length,
    // A compliance matrix has NO upstream "match count" — it's a lookup over a
    // caller-supplied clause list, and the requested count is `summary.total`.
    // Use null (not `total`): with returned<total when clauses FAIL, buildMeta
    // would force `truncated:true` (meta.ts:104), falsely signalling a cap when
    // the missing clauses are actually disclosed in unresolved/errored. complete
    // is already explicit-false in that case; truncated must stay false.
    totalAvailable: null,
    // Explicit false whenever ANY clause didn't resolve; undefined lets buildMeta
    // derive true for the all-resolved case.
    complete:
      unresolved.length === 0 && errored.length === 0 ? undefined : false,
    // ONLY the errored/outage bucket counts as degradation — a genuine not_found
    // is a real answer, not a fetch failure.
    degraded: errored.length
      ? { attempted: total, succeeded: resolved, failed: errored.length }
      : undefined,
    filtersApplied: [],
    filtersDropped: [],
    notes,
  });
}
