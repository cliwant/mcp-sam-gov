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
 *     fetch (0 network call; the message names DOL_API_KEY + dataportal.dol.gov/registration).
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
 *          fetch); the message names DOL_API_KEY + dataportal.dol.gov/registration. The key rides the
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
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js) so a
// `num` regression fails together across sources. NO local num/str.
export { num };
// ─── SSRF core: the single fixed host + base path ─────────────────
export const DOL_HOST = "apiprod.dol.gov";
const DOL_DATASETS_PATH = "/v4/datasets";
// HOST+path labels — surface in ToolError.upstreamEndpoint; the key rides ONLY in the
// X-API-KEY header, so no token can ever appear here.
const DOL_DATASETS_LABEL = "dol:/v4/datasets";
const DOL_GET_LABEL = "dol:/v4/get";
// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
// agency (abbr) + endpoint (api_url / tablename) ride in the request PATH — strict
// alnum+underscore rejects '/', '.', '..', spaces, and any path-steering char.
const AGENCY_RE = /^[A-Za-z0-9_]+$/;
const ENDPOINT_RE = /^[A-Za-z0-9_]+$/;
// The whole DOL dataset catalog is small (~42 rows) and returns in a single page when
// `limit` is large. Fetch it in one page so agency/query filtering is over the COMPLETE
// catalog (and totalAvailable on a filtered result is exact). meta.total_count is the
// ground truth — if the catalog ever exceeds this, the honest short-fetch is disclosed.
const CATALOG_FETCH_LIMIT = 1000;
const DEFAULT_GET_LIMIT = 10;
const MAX_GET_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;
// ─── Honesty notes ────────────────────────────────────────────────
const KEY_REQUIRED_NOTE = "dol_get_dataset REQUIRES a free DOL_API_KEY (the DOL data endpoint has no keyless tier; the CATALOG — dol_list_datasets — and agency list are keyless). Get a key at https://dataportal.dol.gov/registration. The key is sent ONLY in the X-API-KEY request header and is NEVER logged, echoed, or placed in this response.";
const DATA_ENVELOPE_NOTE = "The DOL data-record envelope is key-gated and could not be verified live, so records are returned VERBATIM (each dataset has its own enforcement schema — field names and values are preserved as-is; a value is NOT coerced, so a genuine 0 stays 0 and a missing field stays null).";
const DATA_NO_TOTAL_NOTE = "totalAvailable is null: the DOL data endpoint reports no match count in a form this tool could verify. Page with limit/offset — when a full page is returned hasMore is true (page forward to confirm); an empty next page means the end. `returned` is NEVER passed off as the total.";
const CATALOG_ENDPOINT_NOTE = "Feed a row's `apiUrl` (the dataset endpoint) plus its `agencyAbbr` into dol_get_dataset to fetch that dataset's records. agency/query filtering here is CLIENT-SIDE (the DOL catalog API does not filter server-side).";
// ─── The key seam (REQUIRED for the data tool; value NEVER leaked past the header) ──
/** Read DOL_API_KEY from env; trim; return the value or undefined (unset/blank). */
export function dolApiKey() {
    const raw = process.env.DOL_API_KEY;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed ? trimmed : undefined;
}
// ─── SSRF-guarded URL builder (fixed host + hostname assertion) ────
/**
 * Build + assert an apiprod.dol.gov URL on the FIXED host. `path` is a fixed/validated
 * path; `params` (URLSearchParams, encoded) carry all caller VALUES. Asserts the
 * CONSTRUCTED URL's hostname === the fixed host over https (belt-and-suspenders behind
 * the fixed literal), throwing invalid_input on any mismatch (SSRF safety).
 */
function buildDolUrl(path, label, params) {
    const qs = params.toString();
    const url = `https://${DOL_HOST}${path}${qs ? `?${qs}` : ""}`;
    const built = new URL(url);
    if (built.hostname !== DOL_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Constructed DOL URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${DOL_HOST} over https — refusing to fetch (SSRF safety).`,
            upstreamEndpoint: label,
        });
    }
    return url;
}
/** Map ONE catalog `datasets[]` row → the curated dataset shape (every scalar via str/num). */
function mapDataset(row) {
    const r = (row ?? {});
    const agency = (r.agency ?? {});
    const category = (r.category ?? {});
    return {
        name: str(r.name),
        tablename: str(r.tablename),
        apiUrl: str(r.api_url),
        agency: str(agency.name),
        agencyAbbr: str(agency.abbr),
        description: str(r.description),
        frequency: str(r.frequency),
        datasetType: num(r.dataset_type),
        category: str(r.category_name ?? category.name),
    };
}
/**
 * List the DOL Data API v4 dataset catalog (KEYLESS). Fetches the WHOLE catalog in
 * one page, applies optional CLIENT-SIDE `agency` (abbr/name) + `query` (substring over
 * name/description/tags) filters, then offset/limit-slices the filtered set. Honest
 * `_meta`: totalAvailable = the catalog's real total (unfiltered) or the filtered-set
 * size (exact — the whole catalog is in hand); offset pagination over the filtered set.
 */
export async function listDatasets(args) {
    const label = DOL_DATASETS_LABEL;
    const limit = clampLimit(args.limit, DEFAULT_LIST_LIMIT, 200);
    const offset = clampOffset(args.offset);
    // Fetch the whole catalog in one page (KEYLESS — no key read, no header).
    const params = new URLSearchParams();
    params.set("limit", String(CATALOG_FETCH_LIMIT));
    const url = buildDolUrl(DOL_DATASETS_PATH, label, params);
    let body;
    try {
        body = await getJson(url, { label, redirect: "error" });
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(label, "DOL /v4/datasets returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).");
        throw e;
    }
    // [P4] `datasets` MUST be an array (a missing/non-array is drift, never a fabricated empty).
    const b = (body ?? {});
    if (!Array.isArray(b.datasets)) {
        throw driftError(label, "DOL /v4/datasets shape drift — `datasets` must be an array.");
    }
    const meta = (b.meta ?? {});
    const catalogTotal = num(meta.total_count); // the API's real catalog total (P1)
    const fetched = b.datasets.map(mapDataset);
    // ── Optional CLIENT-SIDE filters (the DOL catalog API does not filter server-side). ──
    const filtersApplied = [];
    let filtered = fetched;
    if (args.agency !== undefined && args.agency.trim() !== "") {
        const needle = args.agency.trim().toLowerCase();
        filtered = filtered.filter((d) => (d.agencyAbbr !== null && d.agencyAbbr.toLowerCase() === needle) ||
            (d.agency !== null && d.agency.toLowerCase().includes(needle)));
        filtersApplied.push(`agency:${args.agency.trim()}`);
    }
    if (args.query !== undefined && args.query.trim() !== "") {
        const q = args.query.trim().toLowerCase();
        // Substring over name + description + category (the human-searchable text).
        filtered = filtered.filter((d) => [d.name, d.description, d.category, d.tablename, d.apiUrl]
            .filter((v) => v !== null)
            .some((v) => v.toLowerCase().includes(q)));
        filtersApplied.push(`query:${args.query.trim()}`);
    }
    const anyFilter = filtersApplied.length > 0;
    // [P1] totalAvailable: unfiltered ⇒ the API's real catalog total; filtered ⇒ the
    // filtered-set size (EXACT — the whole catalog was fetched in one page). NEVER the
    // page length passed off as a total.
    const totalAvailable = anyFilter
        ? filtered.length
        : catalogTotal !== null
            ? catalogTotal
            : filtered.length;
    const page = filtered.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < filtered.length;
    const nextOffset = hasMore ? offset + returned : null;
    const notes = [CATALOG_ENDPOINT_NOTE];
    // Honest disclosure if the catalog ever exceeds one fetch page (client-side filtering
    // would then be over a subset). Does not happen at the current ~42-row catalog.
    if (catalogTotal !== null && fetched.length < catalogTotal) {
        notes.push(`Only the first ${fetched.length} of ${catalogTotal} catalog datasets were retrieved; any agency/query filtering (and totalAvailable) is over that subset. Narrow with agency/query.`);
    }
    return withMeta({ datasets: page }, {
        source: `${DOL_HOST} /v4/datasets (US DOL Data API v4 catalog; keyless)`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    });
}
/**
 * Fetch records from one DOL dataset (KEY-REQUIRED). `agency` (abbr) + `table` (the
 * dataset's api_url endpoint) ride the request PATH; limit/offset/filter ride the query;
 * the DOL_API_KEY rides the X-API-KEY header ONLY. Records are surfaced VERBATIM. Honest
 * `_meta`: totalAvailable is a real count field when present, else null (offset
 * pagination). Unset key ⇒ invalid_input THROW pre-fetch (0 fetch).
 */
export async function getDataset(args) {
    const label = DOL_GET_LABEL;
    // ── [KEY] REQUIRED key — throw an honest config error BEFORE any fetch. ──
    const key = dolApiKey();
    if (key === undefined) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "The DOL data endpoint requires a free DOL_API_KEY (the dataset CATALOG, dol_list_datasets, is keyless). Get one at https://dataportal.dol.gov/registration and set DOL_API_KEY.",
            upstreamEndpoint: label,
        });
    }
    // ── Validate inputs (belt-and-suspenders behind the server Zod; a DIRECT handler
    //    call bypasses Zod — agency/table ride in the PATH). ──
    const agency = args.agency ?? "";
    if (!AGENCY_RE.test(agency)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid agency ${JSON.stringify(agency)} — expected an agency abbreviation (^[A-Za-z0-9_]+$), e.g. "WHD", "OSHA", "ILAB". Discover it as agencyAbbr from dol_list_datasets. (agency rides in the request PATH; it is strictly validated.)`,
            upstreamEndpoint: label,
        });
    }
    const table = args.table ?? "";
    if (!ENDPOINT_RE.test(table)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid table ${JSON.stringify(table)} — expected a dataset endpoint (^[A-Za-z0-9_]+$), the dataset's api_url from dol_list_datasets. (table rides in the request PATH; it is strictly validated.)`,
            upstreamEndpoint: label,
        });
    }
    // filterField/filterValue are paired — one without the other is a caller error.
    if ((args.filterField !== undefined) !== (args.filterValue !== undefined)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "filterField and filterValue must be supplied TOGETHER (a field to filter on plus the value to match).",
            upstreamEndpoint: label,
        });
    }
    const limit = clampLimit(args.limit, DEFAULT_GET_LIMIT, MAX_GET_LIMIT);
    const offset = clampOffset(args.offset);
    // ── Build the query (all VALUES via URLSearchParams — no host/path steer). The
    //    format is a PATH segment (/json per the DOL User Guide); the key rides the
    //    X-API-KEY HEADER, never the query. ──
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    const filtersApplied = [];
    if (args.filterField !== undefined && args.filterValue !== undefined) {
        // DOL's documented filter mechanism: a JSON filter_object (field/operator/value).
        params.set("filter_object", JSON.stringify({
            field: args.filterField,
            operator: "eq",
            value: args.filterValue,
        }));
        filtersApplied.push(`${args.filterField}:${args.filterValue}`);
    }
    if (args.fields !== undefined && args.fields.length > 0) {
        // Best-effort column selection (not documented for v4; the API ignores or 400s an
        // unsupported param — the 400 path surfaces it honestly).
        params.set("fields", args.fields.join(","));
        filtersApplied.push(`fields:${args.fields.join(",")}`);
    }
    const path = `/v4/get/${agency}/${table}/json`;
    const url = buildDolUrl(path, label, params);
    // ── Fetch through the shared envelope: the key rides the X-API-KEY header ONLY;
    //    redirect:"error" (fail closed on any off-host 3xx — it could carry the key
    //    away). The 401/403 key-error and 400 are reclassified below. ──
    let body;
    try {
        body = await getJson(url, {
            label,
            headers: { "X-API-KEY": key },
            redirect: "error",
        });
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier) {
            const status = e.toolError.upstreamStatus;
            // [P2/KEY] 401/403 (missing/invalid key — the AWS "Missing Authentication Token"
            // or the DOL app's key-rejection) ⇒ invalid_input carrying the DOL_API_KEY
            // guidance, NEVER an empty result.
            if (status === 401 || status === 403) {
                throw new ToolErrorCarrier({
                    kind: "invalid_input",
                    retryable: false,
                    message: "DOL rejected the request as unauthorized (HTTP 401/403) — DOL_API_KEY is missing or invalid. Check the key (free at https://dataportal.dol.gov/registration).",
                    upstreamStatus: status,
                    upstreamEndpoint: label,
                });
            }
            throw e; // 400 → invalid_input, 429 → rate_limited, 5xx → upstream_unavailable, 404 → not_found …
        }
        if (e instanceof SyntaxError)
            throw driftError(label, "DOL /v4/get returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).");
        throw e;
    }
    // ── [P4] Resolve the row array DEFENSIVELY (envelope unverified — key-gated): a bare
    //    array, or `{ data:[…] }`, or `{ results:[…] }`. None ⇒ driftError. ──
    const rows = resolveRows(body);
    if (rows === null) {
        throw driftError(label, "DOL /v4/get body carries no row array (expected a bare array, or a `data`/`results` array) — schema drift (never a fabricated empty).");
    }
    // [P4] Every row must be a JSON object; surface it VERBATIM (P3 — preserve field
    // names + values; a JSON 0 stays 0, a JSON null stays null, no coercion).
    const records = [];
    for (let i = 0; i < rows.length; i++) {
        const raw = rows[i];
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
            throw driftError(label, `DOL /v4/get record ${i} is not a JSON object — schema drift (never a fabricated empty).`);
        }
        records.push({ ...raw });
    }
    // ── [P1] totalAvailable: use a real count field ONLY if present (defensive across
    //    the unverified envelope), else null (an honest unknown — never `returned`). ──
    const totalAvailable = resolveCount(body);
    const returned = records.length;
    // Unknown total ⇒ a FULL page suggests more (page forward to confirm — an empty next
    // page is the end); a partial page is the last. Never over-claims a fabricated total.
    const hasMore = totalAvailable !== null
        ? offset + returned < totalAvailable
        : returned > 0 && returned === limit;
    const nextOffset = hasMore ? offset + returned : null;
    const notes = [KEY_REQUIRED_NOTE, DATA_ENVELOPE_NOTE];
    if (totalAvailable === null)
        notes.push(DATA_NO_TOTAL_NOTE);
    return withMeta({ records }, {
        source: `${DOL_HOST} /v4/get/${agency}/${table} (US DOL Data API v4; DOL_API_KEY)`,
        keylessMode: false, // ★KEYED — the data endpoint has no keyless tier
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    });
}
/** Defensively resolve the row array from the (unverified) DOL data envelope. null ⇒ none. */
function resolveRows(body) {
    if (Array.isArray(body))
        return body;
    const b = (body ?? {});
    if (Array.isArray(b.data))
        return b.data;
    if (Array.isArray(b.results))
        return b.results;
    return null;
}
/**
 * Defensively read a real total-count field from the (unverified) DOL data envelope.
 * Checks the common carriers (top-level total_count/total/count, or meta.total_count);
 * returns null when NONE is present (an honest unknown — never a fabricated total).
 */
function resolveCount(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body))
        return null;
    const b = body;
    const meta = (b.meta ?? {});
    for (const v of [b.total_count, b.total, b.count, meta.total_count]) {
        const n = num(v);
        if (n !== null)
            return n;
    }
    return null;
}
// ─── Small shared clamps (defensive, behind the server Zod bounds) ──
function clampLimit(v, def, max) {
    if (typeof v !== "number" || !Number.isFinite(v))
        return def;
    const n = Math.floor(v);
    if (n < 1)
        return 1;
    if (n > max)
        return max;
    return n;
}
function clampOffset(v) {
    if (typeof v !== "number" || !Number.isFinite(v))
        return 0;
    const n = Math.floor(v);
    return n < 0 ? 0 : n;
}
//# sourceMappingURL=dol.js.map