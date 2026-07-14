/**
 * datagov-catalog.ts — data.gov v4 Catalog API (`api.gsa.gov/technology/datagov/v4`)
 * federal DATASET DISCOVERY (ADR-0046, resilience-initiative Phase 3).
 *
 * WHAT IT ADDS: data.gov RETIRED its CKAN `package_search` endpoint in 2025; the
 * v4 Catalog API is its replacement. This restores federal open-dataset DISCOVERY
 * across all publishing agencies (hundreds of thousands of datasets) as a NEW
 * keyless-first source. It is a SEPARATE host from datagov.ts's api.data.gov trio
 * (Regulations.gov / Congress.gov), but it shares the IDENTICAL api.data.gov key
 * (`api.gsa.gov` accepts the same DATA_GOV_API_KEY / DEMO_KEY via `X-Api-Key`), so
 * it REUSES the audited `datagovKey.ts` key seam verbatim (keyHeader / keyModeLabel
 * / pushKeyNote) — keylessMode:false (genuinely keyed, mirroring the regulations trio).
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error", the X-Api-Key header) / `driftError` / `str` (coerce.ts,
 * null-never-empty-string) / `withMeta`·`buildMeta` / `ResponseMeta.nextCursor`,
 * and MIRRORS datagov.ts's `searchDockets` schema_drift catch-ladder verbatim.
 *
 * ★ SSRF: the host is a compile-time literal (`DATAGOV_CATALOG_HOST`); every filter
 *   (`_q`/`organization`/`_size`/`_format`) rides in a MODULE-BUILT `URLSearchParams`
 *   assembled key-by-key from validated typed args — NO raw-query passthrough. The
 *   opaque `cursor` is charclass-validated (`^[A-Za-z0-9+/=_-]{1,4096}$`, rejecting
 *   `../` / spaces / `%`) BEFORE it rides the `after=` query param. A post-construction
 *   hostname/protocol assertion + `redirect:"error"` lock it (fail closed on any
 *   off-host 3xx — a 3xx off api.gsa.gov could carry the X-Api-Key header away).
 *
 * ★ THE HONESTY PILLARS (P1-P4, captured live 2026-07-14 — the v4 facts):
 *   P1 (NO total): the v4 search response is `{ after, results, sort }` — it reports
 *     NO match count. `totalAvailable = null` (NEVER results.length, NEVER a fabricated
 *     total). Pagination is an OPAQUE `after` cursor: `hasMore = after is a non-empty
 *     string`; `nextCursor = hasMore ? after : null` (passed back VERBATIM as the next
 *     `cursor` argument). offset/nextOffset are null (a numeric offset is meaningless).
 *   P2: getJson→fetchWithRetry THROWS on 429 (rate_limited — very likely at DEMO_KEY's
 *     ~10/hr), 5xx (upstream_unavailable), timeout — NEVER a fake empty. A genuine
 *     no-match (results:[], no after) ⇒ honest empty (datasets:[], returned:0,
 *     nextCursor:null, complete:true).
 *   P3: every scalar via `str` (null-never-empty-string — a missing accessLevel /
 *     license / landingPage is null, NEVER "").
 *   P4: `body.results` absent/non-array ⇒ driftError; a 200 non-JSON body ⇒ schema_drift
 *     via the catch-ladder (ToolErrorCarrier rethrow FIRST so a 429/5xx keeps its
 *     taxonomy → SyntaxError→driftError → bare rethrow).
 *   accessLevel is surfaced VERBATIM (public / restricted public / non-public), null
 *     when absent — the consumer judges the dataset's openness (this tool only
 *     DISCOVERS datasets; it does not ingest distributions).
 */
import { type MetaBundle } from "./meta.js";
export declare const DATAGOV_CATALOG_HOST = "api.gsa.gov";
export declare const DATAGOV_CURSOR_RE: RegExp;
export type CatalogDistribution = {
    title: string | null;
    format: string | null;
};
export type CatalogDataset = {
    id: string | null;
    title: string | null;
    organization: string | null;
    description: string | null;
    accessLevel: string | null;
    license: string | null;
    landingPage: string | null;
    modified: string | null;
    lastHarvested: string | null;
    keywords: string[];
    themes: string[];
    distributions: CatalogDistribution[];
    identifier: string | null;
};
export type DatagovSearchDatasetsArgs = {
    query?: string;
    organization?: string;
    limit?: number;
    cursor?: string;
};
/**
 * Search the data.gov v4 dataset catalog (the CKAN-retirement replacement).
 * Filters: `query` (→_q), `organization` (publisher slug), `limit` (→_size),
 * `cursor` (→after, the opaque continuation). The query is MODULE-BUILT from
 * validated typed args through URLSearchParams (NO raw passthrough); `_format=json`
 * is ALWAYS appended. Returns curated dataset rows + honest `_meta`: totalAvailable
 * is NULL (the v4 API reports no count — P1), the opaque-cursor continuation, the
 * accessLevel openness field surfaced verbatim, and the DEMO_KEY rate disclosure.
 */
export declare function searchDatasets(args: DatagovSearchDatasetsArgs): Promise<MetaBundle>;
//# sourceMappingURL=datagov-catalog.d.ts.map