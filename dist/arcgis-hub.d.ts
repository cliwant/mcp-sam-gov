/**
 * arcgis-hub.ts — ArcGIS Hub dataset DISCOVERY (`hub.arcgis.com/api/v3/datasets`),
 * a NEW keyless-first SLED-discovery platform (loop cycle 9).
 *
 * WHAT IT ADDS: a large fraction of US state/local/regional/tribal (SLED) open
 * data — especially GIS / infrastructure / permits / boundaries / procurement —
 * is published on ArcGIS Hub, NOT on Socrata or CKAN. This tool DISCOVERS those
 * datasets (keyword search over the whole Hub) so a B2G researcher can find what
 * fragmented local data exists. It is the ArcGIS sibling of
 * `socrata_discover_datasets` / `datagov_search_datasets`.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error") / `driftError` / `num`·`str` (coerce.ts, null-never-0 /
 * null-never-empty-string) / `withMeta`·`buildMeta`, mirroring datagov-catalog.ts.
 * KEYLESS: no key seam (no token is ever read/sent).
 *
 * ★ SSRF: the host is a compile-time literal (`ARCGIS_HUB_HOST`). Every input
 *   (`q` / `filter[openData]` / `page[size]` / `page[start]`) rides in a
 *   MODULE-BUILT `URLSearchParams` assembled key-by-key from validated typed args
 *   — NO raw-query / raw-host passthrough (this is a FIXED-host catalog search, so
 *   there is no per-jurisdiction host vector like socrata_query has). A
 *   post-construction hostname/protocol assertion + `redirect:"error"` lock it.
 *
 * ★ PROVENANCE (the crux — different trust posture from our other sources): ArcGIS
 *   Hub is a GLOBAL, OPEN publishing platform. Anyone — a US city, a foreign
 *   government, an NGO, a company — can publish, so results are NOT all US and NOT
 *   all governmental. This tool is therefore explicitly a DISCOVERY aid, NOT a
 *   curated official-source allowlist (unlike `socrata_query`, whose hosts are a
 *   vetted allowlist). Each result surfaces `owner`/`orgName`/`source`/`region`
 *   VERBATIM so the consumer can VET the publisher, and every response carries the
 *   global-platform disclosure. `openDataOnly` (default true) biases toward items
 *   the publisher designated as open data. DISCOVERY ONLY — to read rows, follow
 *   the dataset on its own ArcGIS endpoint (a guarded row-query tool is a planned
 *   addition; ArcGIS feature services live on arbitrary hosts, which needs its own
 *   SSRF design).
 *
 * ★ HONESTY PILLARS (captured live 2026-07-19):
 *   P1 (real total): the v3 response carries `meta.total` (== `meta.stats.totalCount`)
 *     — the EXACT match count across the Hub. `totalAvailable = num(meta.total)`
 *     (NEVER data.length); a page is `truncated` when `offset + returned < total`.
 *     Pagination is a 1-based record offset (`page[start] = offset + 1`).
 *   P2: getJson→fetchWithRetry THROWS on 429 (rate_limited) / 5xx
 *     (upstream_unavailable) / timeout — NEVER a fake empty. A genuine no-match
 *     (`data:[]`, total 0) ⇒ honest empty (datasets:[], returned:0, total:0,
 *     complete:true).
 *   P3: every scalar via `str` (null-never-empty) / booleans preserved / `num`
 *     for counts (null-never-0). A missing owner/source/region is null, never "".
 *   P4: `body.data` absent/non-array ⇒ driftError; a 200 non-JSON body ⇒
 *     schema_drift via the catch-ladder (ToolErrorCarrier rethrow FIRST so a
 *     429/5xx keeps its taxonomy → SyntaxError→driftError → bare rethrow).
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const ARCGIS_HUB_HOST = "hub.arcgis.com";
export type HubDataset = {
    id: string | null;
    name: string | null;
    description: string | null;
    owner: string | null;
    orgName: string | null;
    source: string | null;
    region: string | null;
    type: string | null;
    sector: string | null;
    keywords: string[];
    downloadable: boolean | null;
    hasApi: boolean | null;
    created: string | null;
    modified: string | null;
    landingPage: string | null;
    itemId: string | null;
};
export type ArcgisHubDiscoverArgs = {
    query: string;
    openDataOnly?: boolean;
    limit?: number;
    offset?: number;
};
/**
 * Search ArcGIS Hub datasets by keyword. Filters: `query` (→q, REQUIRED, ≥2
 * non-whitespace chars), `openDataOnly` (default true → filter[openData]=true,
 * biases toward publisher-designated open data), `limit` (→page[size]), `offset`
 * (→page[start]=offset+1, 1-based). The query is MODULE-BUILT from validated typed
 * args (NO raw passthrough). Returns curated dataset rows + honest `_meta`:
 * totalAvailable = the EXACT Hub match count (meta.total, P1), the global-platform
 * provenance disclosure, and per-row publisher fields for vetting.
 */
export declare function discoverDatasets(args: ArcgisHubDiscoverArgs): Promise<MetaBundle>;
//# sourceMappingURL=arcgis-hub.d.ts.map