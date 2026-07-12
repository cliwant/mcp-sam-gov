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
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
declare const INST_FILTER_FIELDS: ReadonlySet<string>;
declare const FIN_FILTER_FIELDS: ReadonlySet<string>;
declare const INST_SEARCH_FIELDS: ReadonlySet<string>;
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
export declare function escapeSearch(v: string): string;
/** The filter-field allowlists, exported so the fault suite can drive the
 *  belt-and-suspenders field-guard directly (the tool functions only ever pass
 *  hardcoded fields, so this defense-in-depth check is otherwise unreachable). */
export { INST_FILTER_FIELDS, FIN_FILTER_FIELDS, INST_SEARCH_FIELDS };
/** A `filters` term `FIELD:VALUE` — asserts the field ∈ its allowlist (P4). The
 *  value is a constrained non-string (STALP/ACTIVE/CERT) → no quoting needed.
 *  Exported for the allowlist-bypass fault fixture (§7(b)). */
export declare function filterTerm(field: string, value: string, allowed: ReadonlySet<string>): string;
/** A `search` term `FIELD:<escaped>` (M1 route for NAME/CITY) — asserts the field
 *  ∈ the search allowlist and M2-escapes the value UNQUOTED (see escapeSearch: NO
 *  surrounding quotes — quotes collapse match_phrase recall → false-empties).
 *  Exported for the allowlist-bypass fault fixture (§7(b)). */
export declare function searchTerm(field: string, value: string): string;
/**
 * Build the institutions `filters` string (STALP/ACTIVE/CERT only — NAME/CITY go
 * through `search`, M1). Terms joined with ` AND `. Returns "" when there is no
 * structured filter clause. Exported for the fault fixtures.
 */
export declare function buildInstFilters(inp: {
    state?: string;
    activeOnly?: boolean;
    cert?: number;
}): string;
/**
 * ★M1 + ★M2 — build the institutions `search` string (FDIC full-text; NAME/CITY
 * only). Each value is char-class-validated at the server boundary, then here
 * M2-escaped UNQUOTED (backslash-first; NO surrounding quotes — see escapeSearch).
 * Terms joined with ` AND ` (live-verified: `search=NAME:first AND CITY:richmond`
 * → both must match). Returns "" when neither is present. Exported for the M1/M2
 * fault fixtures.
 */
export declare function buildInstSearch(inp: {
    name?: string;
    city?: string;
}): string;
/** Build the financials `filters` string — the sole filter is the numeric
 *  `CERT:<int>` (zero string inputs → zero injection surface). */
export declare function buildFinFilters(inp: {
    cert: number;
}): string;
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
export type FdicFinancials = {
    cert: number | null;
    reportDate: number | null;
    assetUSD: number | null;
    depositsUSD: number | null;
    netIncomeUSD: number | null;
    id: string | null;
};
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
export declare function searchInstitutions(args: {
    state?: string;
    activeOnly?: boolean;
    cert?: number;
    name?: string;
    city?: string;
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortOrder?: string;
}): Promise<MetaBundle>;
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
export declare function institutionFinancials(args: {
    cert: number;
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortOrder?: string;
}): Promise<MetaBundle>;
declare const FDIC_FAILURES_FILTER_FIELDS: ReadonlySet<string>;
export { FDIC_FAILURES_FILTER_FIELDS };
/**
 * Build the failures `filters` string — EXACT-KEY terms only: `state`→`PSTALP:<s>`
 * (★F1), `failYear`→`FAILYR:<year>` (emit the integer's digits — FAILYR is a
 * string field but the digits filter cleanly, live-verified), `cert`→`CERT:<int>`.
 * There is NO name/city term (★F2 — /failures ignores `search` and NAME/CITY only
 * filter as brittle exact-uppercase foot-guns). Terms joined with ` AND `. Returns
 * "" when there is no structured filter clause. Exported for the fault fixtures.
 */
export declare function buildFailFilters(inp: {
    state?: string;
    failYear?: number;
    cert?: number;
}): string;
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
export declare function normFailDate(raw: unknown): {
    value: string | null;
    normalized: boolean;
};
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
export declare function bankFailures(args: {
    state?: string;
    failYear?: number;
    cert?: number;
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortOrder?: string;
}): Promise<MetaBundle>;
declare const FDIC_HISTORY_FILTER_FIELDS: ReadonlySet<string>;
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
export declare function buildHistFilters(inp: {
    cert?: number;
    changeCode?: number;
    effYear?: number;
    state?: string;
}): string;
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
export declare function normHistDate(raw: unknown): {
    value: string | null;
    normalized: boolean;
};
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
export declare function institutionHistory(args: {
    cert?: number;
    changeCode?: number;
    effYear?: number;
    state?: string;
    limit?: number;
    offset?: number;
    sortBy?: string;
    sortOrder?: string;
}): Promise<MetaBundle>;
//# sourceMappingURL=fdic.d.ts.map