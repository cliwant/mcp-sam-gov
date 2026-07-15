/**
 * dol.ts — US Department of Labor Data API v4 (apiprod.dol.gov) — the LABOR
 * ENFORCEMENT lane (ADR-0053). WHD wage/hour violations, OSHA inspections, ILAB
 * child/forced-labor reports, MSHA mine safety … — the compliance/enforcement
 * signal no contract/spending/market source carries.
 *
 * TWO tools with a DELIBERATE key split (the honest reflection of the live API):
 *   • `dol_list_datasets` (KEYLESS) — GET /v4/datasets. The dataset CATALOG (and
 *     /v4/agencies) is keyless; this tool needs NO key. It returns the machine
 *     inventory (name / tablename / api_url / agency / …) you page + filter to find
 *     an endpoint, then feed its `apiUrl` into dol_get_dataset.
 *   • `dol_get_dataset` (KEY-REQUIRED, DOL_API_KEY) — GET
 *     /v4/get/{agency}/{endpoint}/json?… . The DATA endpoint has NO keyless tier, so
 *     with NO `DOL_API_KEY` this tool THROWS an invalid_input config error BEFORE any
 *     fetch (0 network call; the message names DOL_API_KEY + dol.gov/developer).
 *   So DOL is the 4th REQUIRED key — but ONLY for the data tool; the catalog tool
 *   (and every other tool on the server) stays keyless.
 *
 * ★LIVE-VERIFIED WIRE FACTS (2026-07-15):
 *   - Host `apiprod.dol.gov` (AWS API Gateway) + base `/v4`.
 *   - /v4/datasets is KEYLESS 200 → `{ datasets:[…], meta:{ current_page, next_page,
 *     prev_page, total_pages, total_count } }`. `limit` is the PER-PAGE size (limit=1000
 *     returns the whole 42-row catalog in one page, total_pages:1); server-side agency
 *     filtering is NOT honored (verified: ?agency=ILAB still returned the full 42) — so
 *     agency/query filtering is CLIENT-SIDE over the fetched catalog.
 *   - The DATA route is the QUERY-STYLE form `/v4/get/{agency}/{endpoint}/{format}?…`
 *     (NOT the path-style `/…/limit/N/offset/O/format/json`): the query-style URL
 *     reached the DOL app and returned a proper `401 {"…key…missing…"}` on a bad key,
 *     whereas the path-style URL only ever hit the AWS gateway's generic
 *     `403 {"message":"Missing Authentication Token"}` (an unmatched route). The DOL
 *     API User Guide (dataportal.dol.gov/pdf/dol-api-user-guide.pdf) confirms the
 *     `/get/<agency>/<api_url>/<format>?limit=&offset=&filter_object=&…` template and
 *     that `<endpoint>` is the dataset's **api_url** (NOT its tablename).
 *
 * ★UNVERIFIED (key-gated — coded DEFENSIVELY, honestly disclosed): the DATA response
 *   body shape could not be observed live (every /v4/get call is 401 without a real
 *   key, and the User Guide shows no body example). So `dol_get_dataset` accepts EITHER
 *   a bare row array `[…]` OR `{ data:[…] }` OR `{ results:[…] }`; a top-level count
 *   (`total_count`/`total`/`count`, or `meta.total_count`) is used for totalAvailable
 *   ONLY if actually present, else `totalAvailable = null` (an HONEST unknown — never
 *   `returned` passed off as the total). Records are surfaced VERBATIM (each dataset
 *   has its own enforcement schema; blind coercion would distort compliance data — a
 *   JSON `0` stays `0`, a JSON `null` stays `null`, field names are preserved as-is).
 *
 * ★HONESTY (ADR-0053 P1–P4 + KEY + SSRF):
 *   [KEY]  dol_get_dataset with NO DOL_API_KEY ⇒ invalid_input THROW pre-fetch (0
 *          fetch); the message names DOL_API_KEY + dol.gov/developer. The key rides the
 *          `X-API-KEY` HEADER ONLY — NEVER the URL / label / _meta / notes / a log (the
 *          K-test). dol_list_datasets is keyless (no key read, no header).
 *   [P1]   catalog: totalAvailable = meta.total_count (the API's real catalog total)
 *          for an unfiltered scan; when a CLIENT-SIDE filter is applied it is the
 *          filtered-set size (exact — the whole catalog is fetched in one page). data:
 *          totalAvailable = a real count field when present, else null; offset/limit
 *          pagination in both.
 *   [P2]   data: 401/403 (missing/invalid key) ⇒ invalid_input reclassified with the
 *          DOL_API_KEY guidance (the AWS "Missing Authentication Token" is a key problem
 *          here) — never empty. 400 ⇒ invalid_input. empty rows ⇒ honest empty
 *          (returned:0). 429 ⇒ rate_limited THROW (Retry-After honored). 5xx/timeout ⇒
 *          upstream_unavailable THROW. 200 non-JSON ⇒ schema_drift.
 *   [P3]   records verbatim (null-never-0 comes for free — JSON preserves 0/null and
 *          every original field name; the tool never introduces a fabricated 0).
 *   [P4]   the expected array (catalog `datasets`; data's row array) absent/non-array
 *          ⇒ driftError. A ToolErrorCarrier (401/5xx/…) is a P2 outcome, rethrown
 *          BEFORE the drift check.
 *   [SSRF] fixed host `apiprod.dol.gov` + a post-construction hostname/https assert +
 *          `redirect:"error"`; agency/endpoint charclass `^[A-Za-z0-9_]+$` (they ride
 *          in the PATH); limit/offset integers; filterValue/fields ride URLSearchParams;
 *          the key rides the X-API-KEY header only.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const DOL_HOST = "apiprod.dol.gov";
/** Read DOL_API_KEY from env; trim; return the value or undefined (unset/blank). */
export declare function dolApiKey(): string | undefined;
export type DolListDatasetsArgs = {
    agency?: string;
    query?: string;
    limit?: number;
    offset?: number;
};
export type DolDataset = {
    name: string | null;
    tablename: string | null;
    apiUrl: string | null;
    agency: string | null;
    agencyAbbr: string | null;
    description: string | null;
    frequency: string | null;
    datasetType: number | null;
    category: string | null;
};
/**
 * List the DOL Data API v4 dataset catalog (KEYLESS). Fetches the WHOLE catalog in
 * one page, applies optional CLIENT-SIDE `agency` (abbr/name) + `query` (substring over
 * name/description/tags) filters, then offset/limit-slices the filtered set. Honest
 * `_meta`: totalAvailable = the catalog's real total (unfiltered) or the filtered-set
 * size (exact — the whole catalog is in hand); offset pagination over the filtered set.
 */
export declare function listDatasets(args: DolListDatasetsArgs): Promise<MetaBundle>;
export type DolGetDatasetArgs = {
    agency?: string;
    table?: string;
    limit?: number;
    offset?: number;
    filterField?: string;
    filterValue?: string;
    fields?: string[];
};
/**
 * Fetch records from one DOL dataset (KEY-REQUIRED). `agency` (abbr) + `table` (the
 * dataset's api_url endpoint) ride the request PATH; limit/offset/filter ride the query;
 * the DOL_API_KEY rides the X-API-KEY header ONLY. Records are surfaced VERBATIM. Honest
 * `_meta`: totalAvailable is a real count field when present, else null (offset
 * pagination). Unset key ⇒ invalid_input THROW pre-fetch (0 fetch).
 */
export declare function getDataset(args: DolGetDatasetArgs): Promise<MetaBundle>;
//# sourceMappingURL=dol.d.ts.map