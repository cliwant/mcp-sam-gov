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

/** A `filters` term `FIELD:VALUE` — asserts the field ∈ its allowlist (P4). The
 *  value is a constrained non-string (STALP/ACTIVE/CERT) → no quoting needed.
 *  Exported for the allowlist-bypass fault fixture (§7(b)). */
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
  return `${field}:${value}`;
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
  const hasMore = offset + returned < totalAvailable;
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
  const hasMore = offset + returned < totalAvailable;
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
  const hasMore = offset + returned < totalAvailable;
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
