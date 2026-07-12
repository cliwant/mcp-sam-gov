/**
 * OpenFEMA — keyless federal disaster declarations + emergency-assistance spend
 * (ADR-0016). A NEW DOMAIN: federal disaster declarations + FEMA Public Assistance
 * grants to state/local/tribal applicants (the SLED emergency-spend / B2G-adjacent
 * angle). Fully PUBLIC, KEYLESS (no key, no token, no header — OpenFEMA is
 * unauthenticated). Nth consumer of the fetch/map/meta shape after treasury /
 * edgar / socrata / ckan.
 *   Row query: https://www.fema.gov/api/open/{version}/{EntityName}?{OData params}
 *
 * REUSE (writes ZERO fetch/coercion/error code): `getJson`+`redirect:"error"`
 * (datasource.ts), `num`/`str` (coerce.ts), `driftError` (datasource.ts),
 * `withMeta`/`buildMeta` (meta.ts), the errors.ts taxonomy. COPIES (does NOT
 * import) the socrata/ckan fixed-host SSRF + honesty PATTERN. NEW (small): the
 * OData `$filter` builder (structured args → escaped filter string) + the
 * `FEMA_DATASETS` registry (entityName+version+per-tool field-whitelist pins).
 *
 * ★ THE TOTAL-HONESTY CRUX — `metadata.count` (`$inlinecount=allpages`).
 * OpenFEMA reports the exact FILTERED total in `metadata.count` — a real JSON
 * NUMBER — but ONLY when the query carries `$inlinecount=allpages`. WITHOUT it,
 * `metadata.count` is `0` — a SENTINEL, not the real total (live-verified
 * 2026-07-12: `?$top=1` → count:0; `?$top=1&$inlinecount=allpages` → count:70049).
 * So `getOpenFema` ALWAYS sets `$inlinecount=allpages` (inside the fetch fn, not
 * the caller — no code path can omit it) and reads `metadata.count` as
 * `totalAvailable`. Reading count off a query that omitted inlinecount would
 * report `totalAvailable:0` on a full page — a data-absence-as-zero lie. The count
 * is EXACT (respects the filter), so `hasMore`/`complete` are exact — NO
 * totalIsLowerBound / totalIsEstimated hedge.
 *
 * ★ Entity-keyed envelope (the shape quirk). Results live under `body[EntityName]`
 * (e.g. `body.DisasterDeclarationsSummaries`), NOT a fixed `results`/`data`. The
 * dataset registry carries the entity name, known ahead of the fetch. `metadata`
 * carries the exact filtered `count`.
 *
 * ★ SSRF guard (policy① — mirror socrata.ts / ckan.ts fixed-host). Fixed host
 * `www.fema.gov` + a CURATED dataset registry pinning `{entityName, version}` (no
 * free host, no free path, no free version — HMA's live v2→v4 drift is exactly why
 * version is pinned, never a caller param):
 *   1. `datasetKey` ∈ the frozen `FEMA_DATASETS` registry (belt-and-suspenders
 *      recheck in the fetch fn → invalid_input before any fetch);
 *   2. construct `https://www.fema.gov/api/open/${version}/${entityName}?${params}`
 *      (host + path segments come ONLY from the pinned registry entry — nothing
 *      caller-supplied interpolates into the path), then ASSERT the built URL's
 *      hostname === "www.fema.gov" and protocol === "https:" (else invalid_input);
 *   3. OData params via URLSearchParams — `$inlinecount`/`$top`/`$skip` set by the
 *      module; `$filter` is MODULE-BUILT from structured args against a per-tool
 *      field whitelist (NO raw caller `$filter` — no tool exposes one). String
 *      values escape a single-quote by DOUBLING it (`'`→`''`, e.g. `O'Brien` →
 *      `'O''Brien'`) then wrap in `'...'`; numbers are unquoted; booleans render
 *      `true`/`false`. An un-whitelisted field is rejected (invalid_input) — zero
 *      filter-injection surface AND guaranteed-valid, live-verified field names;
 *   4. `redirect:"error"` on every fetch — a direct-JSON endpoint 3xx is anomalous
 *      → fail closed, never follow off-host.
 *
 * ★ Silent-filter trap AVOIDED (unlike ECHO). A bad `$filter`/`$orderby` field is
 * NOT silently ignored — OpenFEMA returns HTTP 400 (live-verified). We never
 * present unfiltered-as-filtered. We still module-build `$filter` from a per-tool
 * whitelist (belt-and-suspenders: no 400 in normal use + no injection surface).
 *
 * ★ 200-HTML maintenance-page guard (ADR-0016 OQ1). FEMA's Drupal can serve an
 * "experiencing technical difficulties" HTML page. Observed failures were HTTP 404
 * (→ not_found, thrown before r.json()); but IF an outage returns that page at
 * HTTP 200, getJson's r.json() throws a SyntaxError. `getOpenFema` catches it →
 * `driftError` (never a fake-empty, and a clean classification). Shared getJson
 * stays byte-identical (the shape-drift check stays at the call site).
 *
 * ★ PER-DATASET FIELD NAMES DIFFER — live-verified (ADR-0016 M1). `state eq 'CA'`
 * works on DisasterDeclarationsSummaries (1689) but `stateAbbreviation` → HTTP 400
 * there; conversely `stateAbbreviation eq 'LA'` works on
 * PublicAssistanceFundedProjectsDetails (39444) but `state` → HTTP 400 there. Each
 * tool maps its user-facing `state` arg to ITS dataset's real OData field. Every
 * shipped filter below NARROWS its dataset (live-verified 2026-07-12); a field
 * that 400s or is silently ignored is NOT shipped.
 *
 * HMA v4 (HazardMitigationAssistanceProjects) is a 3rd-tool backlog item (per
 * ADR-0016 §3) — slice 1 ships the 2 core tools.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const FEMA_HOST = "www.fema.gov";
/**
 * The frozen dataset registry (SSRF core — no free host, no free path, no free
 * version). Each entry's count + fields are LIVE-VERIFIED keyless (2026-07-12).
 * Adding a dataset later = a registry edit + a live
 * `$top=1&$inlinecount=allpages` verify (entity key, version, count) + a test
 * note — NEVER a free runtime param. Re-verify periodically against
 * `/api/open/v1/DataSets` (versions drift: HMA already moved v2→v4).
 */
export declare const FEMA_DATASETS: {
    public_assistance: {
        entityName: string;
        version: string;
        filterFields: Set<string>;
        amountFields: string[];
    };
    disaster_declarations: {
        entityName: string;
        version: string;
        filterFields: Set<string>;
        amountFields: never[];
    };
};
export type FemaDatasetKey = keyof typeof FEMA_DATASETS;
type FilterOp = "eq" | "ge" | "le";
export type FilterClause = {
    field: string;
    op: FilterOp;
    type: "string";
    value: string;
} | {
    field: string;
    op: FilterOp;
    type: "number";
    value: number;
} | {
    field: string;
    op: FilterOp;
    type: "boolean";
    value: boolean;
};
/** OData string-literal escaping: double every single-quote (`'` → `''`). This is
 *  the ONLY escaping OData needs for a `'...'` literal — zero injection surface. */
export declare function escapeODataString(v: string): string;
/**
 * Build the `$filter` string from structured clauses against the dataset's
 * whitelist. Each clause's field MUST be in `FEMA_DATASETS[datasetKey].filterFields`
 * (belt-and-suspenders — the tool functions only ever pass whitelisted fields, but
 * an un-whitelisted field is a hard invalid_input, never silently dropped). Returns
 * null when there are no clauses (⇒ no `$filter` param).
 */
export declare function buildFilter(datasetKey: FemaDatasetKey, clauses: FilterClause[]): string | null;
export type FemaRow = Record<string, unknown>;
/**
 * Search FEMA Public Assistance funded projects (SLED emergency spend to state /
 * local / tribal applicants). Dataset PublicAssistanceFundedProjectsDetails v2.
 * Structured filters → module-built `$filter` (each field LIVE-VERIFIED to narrow):
 *   state → stateAbbreviation eq · disasterNumber eq · applicantId eq ·
 *   damageCategoryCode eq (e.g. "B" = Emergency Protective Measures) ·
 *   incidentType eq · minProjectAmount → projectAmount ge · maxProjectAmount →
 *   projectAmount le · declaredDateFrom/To → declarationDate ge/le.
 * Rows carry projectAmount / federalShareObligated / totalObligated /
 * mitigationAmount as number|null. Honest `_meta` (totalAvailable = exact filtered
 * metadata.count).
 */
export declare function searchPublicAssistance(args: {
    state?: string;
    disasterNumber?: number;
    applicantId?: string;
    damageCategoryCode?: string;
    incidentType?: string;
    minProjectAmount?: number;
    maxProjectAmount?: number;
    declaredDateFrom?: string;
    declaredDateTo?: string;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
/**
 * Look up FEMA disaster / emergency declarations. Dataset
 * DisasterDeclarationsSummaries v2. Structured filters → module-built `$filter`
 * (each field LIVE-VERIFIED to narrow):
 *   state → state eq · incidentType eq (e.g. "Flood") · declarationType eq
 *   (DR/EM/FM) · fyDeclared eq · disasterNumber eq · declaredDateFrom/To →
 *   declarationDate ge/le · paProgramDeclared / iaProgramDeclared → eq true/false
 *   (BOOLEAN — `eq 1` 400s upstream).
 * Honest `_meta` (totalAvailable = exact filtered metadata.count).
 */
export declare function disasterDeclarations(args: {
    state?: string;
    incidentType?: string;
    declarationType?: string;
    fyDeclared?: number;
    disasterNumber?: number;
    declaredDateFrom?: string;
    declaredDateTo?: string;
    paProgramDeclared?: boolean;
    iaProgramDeclared?: boolean;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
//# sourceMappingURL=fema.d.ts.map