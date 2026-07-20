/**
 * CKAN `datastore_search` — keyless open data for state / local (SLED) portals.
 *
 * Second SLED family after Socrata (ADR-0006) and the FIRST source built on the
 * R2 `DataSource` port (ADR-0005): CKAN writes ZERO fetch/coercion/error code —
 * it reuses `getJson` / `driftError` / `num`·`str` / `withMeta` and COPIES (does
 * NOT import) Socrata's SSRF + honesty PATTERN. Fully PUBLIC, KEYLESS — the CKAN
 * datastore is anonymous-readable, so there is NO token anywhere in scope (no
 * `headers`, byte-clean init).
 *
 * CKAN is Socrata's sibling — another multi-portal keyless open-data platform
 * reached by swapping a hostname + a dataset id on one identical JSON Action API.
 * We keep the guard per-source (host lists, id grammar, and the response envelope
 * all differ — ADR-0006 §7) and do NOT unify with `socrata.ts`.
 *   Row query:  https://{host}/api/3/action/datastore_search?resource_id={uuid}&…
 *   Discovery:  https://{host}/api/3/action/package_search?q=…&rows=N
 *
 * Unlike SODA (a bare array, NO total), CKAN WRAPS records in an envelope that
 * carries `result.total` and `result.total_was_estimated` DIRECTLY — so no
 * count(*) companion is needed; the total is read from the body.
 *
 * ★ SSRF GUARD (policy① — the central design risk). COPY Socrata's 4-step order:
 * (1) `host` ∈ CKAN_HOSTS — a Zod enum at the server boundary (single source of
 *     truth) AND a belt-and-suspenders `Set.has` check in the fetch fn → else
 *     invalid_input BEFORE any fetch;
 * (2) `resourceId` matches the CKAN UUID grammar — the server's Zod
 *     `.length(36).regex(UUID_RE)` (NO `.trim()`, NO `i` flag) PLUS a runtime
 *     recheck in the fetch fn (M1 — parallel to the host `Set.has` recheck;
 *     Socrata re-checks datasetId too). m1: JS `$` does NOT match before a
 *     trailing `\n` (unlike Python), so the regex ALONE rejects a newline;
 *     `.length(36)` is belt-and-suspenders, not the primary newline guard.
 *     m2: the grammar is LOWERCASE hex only — every live id on every host is a
 *     36-char lowercase UUID (confirmed) — so we keep it strict (no `i` flag);
 * (3) FIXED path `https://${host}/api/3/action/datastore_search` (only `host`
 *     interpolates into the authority; `resourceId` goes through URLSearchParams,
 *     NEVER the path). Then ASSERT `new URL(built).hostname === host` and
 *     `protocol === "https:"` → invalid_input on mismatch;
 * (4) all params (`resource_id`, `q`, `filters`, `sort`, `limit`, `offset`) via
 *     URLSearchParams — encoded values, no host-alteration surface. Bad
 *     `filters`/`sort` are upstream-validated (409 → invalid_input, surfaced).
 *
 * B1 (SSRF, redirect) — `datastore_search`/`package_search` are direct-JSON
 * endpoints, so a 3xx off an allowlisted host is anomalous (migration / DNS
 * hijack / reused domain) and would otherwise be followed off-allowlist past the
 * pre-check. We set `redirect:"error"` in EVERY getJson call (getJson forwards
 * `init.redirect` to fetch verbatim — a redirect throws, its body is never read).
 *
 * Security non-goal (explicit): we expose ONLY `datastore_search` (parameterized)
 * and `package_search`. We do NOT expose `datastore_search_sql` — the raw-SQL
 * CKAN endpoint IS an injection surface and is out of scope. `filters` is a
 * CONSTRAINED object we `JSON.stringify` (Q3), never caller-supplied raw SQL/JSON.
 * We NEVER pass `total_estimation_threshold` or `include_total:false` (Q4) — we
 * always request an EXACT total; the estimate path fires only if a host is
 * server-side reconfigured, hence defensive.
 *
 * HONESTY (`_meta`) — the load-bearing B1 fix (ADR-0006 v2):
 *   - EXACT total (the default — `total_estimation_threshold` is null on all
 *     hosts → `total_was_estimated:false`): `totalAvailable = num(result.total)`
 *     (exact), `hasMore = offset + returned < total` (or the B2 hedge
 *     `returned >= limit` if `total` is absent — a host running include_total:
 *     false). Genuine-empty (records:[], total:0) → complete:true / total:0.
 *   - ESTIMATED total (`total_was_estimated:true` — rare/defensive): the estimate
 *     is a Postgres `reltuples` approximation that can land ABOVE OR BELOW the
 *     truth (live-verified 345285 vs 344504 — an OVERSHOOT), so it is NOT a lower
 *     bound and MUST NOT drive pagination. Pass `totalAvailable:null` (so
 *     buildMeta's `totalProvesTruncation` does not fire on the estimate),
 *     `hasMore = returned >= limit` (paginate by page-fullness — the anti-livelock
 *     guard), `totalIsEstimated:true`, and a `_meta.notes` disclosure carrying the
 *     estimate value.
 *   - `success:false` (even on HTTP 200) or `result`/`records` missing/non-array
 *     → THROW (never a fake empty). Modern hosts surface 404/409 (→ not_found /
 *     invalid_input via errorFromResponse); this guard covers a 200+success:false
 *     host/proxy. outage/5xx/timeout → getJson throws, never `[]`.
 *   - `num`/`str` are null-never-0 (a missing value is honest "unknown", never 0).
 *
 * ALLOWLIST — LIVE-VERIFIED 2026-07-12 (each `.gov`, government-controlled, a live
 * CKAN datastore; each carries a real datastore-active sample resource_id that
 * returned HTTP 200 + the envelope above). NO commercial-vendor domains (the
 * Socrata Tyler-Technologies M1 mistake is avoided). `data.virginia.gov` is the
 * same VA that CHURNED OFF Socrata (excluded from the SODA allowlist) — it belongs
 * HERE on CKAN. `data.ok.gov` is DEFERRED to SOURCE_BACKLOG (only a 9-row thin
 * datastore verified — require a 2nd procurement-relevant >1k-row resource before
 * adding). `catalog.data.gov` (federal harvester, no active datastore) is dropped.
 * Adding a host later = a CKAN_HOSTS SOURCE edit + a live `datastore_search?
 * limit=1` verification + an ownership note + a test-fixture note — NEVER a free
 * runtime param.
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` from this module (ckan.num === socrata.num === treasury.num === coerce.num).
export { num };
// ─── Curated allowlist (SSRF core) ────────────────────────────────
// A frozen list of live-verified (2026-07-12) CKAN datastore hosts. The Zod
// `host` enum in server.ts is built FROM this array (single source of truth), and
// the fetch fns re-check membership (belt-and-suspenders). Each entry carries a
// real sample resource_id (datastore_active) confirmed to return HTTP 200 + the
// {success, result:{records, total, total_was_estimated, fields}} envelope.
// Re-verify each with `GET https://{host}/api/3/action/datastore_search?
// resource_id={uuid}&limit=1` when touching this list.
export const CKAN_HOSTS = [
    // State of California (CDT/GovOps) — Statewide Purchase Order Data 2012–2015,
    // resource_id bb82edc5-9c78-44e2-8947-68ece26197c5 (~344,504 rows).
    "data.ca.gov",
    // Commonwealth of Virginia (VITA) — the VA that churned off Socrata. Norfolk
    // SWaM Certified Businesses, resource_id f6804560-bf9e-44a4-92bf-bf3dd7d1fd60.
    "data.virginia.gov",
    // City of Boston (DoIT) — Checkbook Explorer (city spend), resource_id
    // d22fdd5c-7e4c-41b7-a3eb-dfc57a87b245 (~101,465 rows).
    "data.boston.gov",
];
const CKAN_HOST_SET = new Set(CKAN_HOSTS);
// A CKAN datastore resource_id is EXACTLY a 36-char LOWERCASE hex UUID. m1: JS
// `$` does NOT admit a trailing "\n" (unlike Python), so this regex alone rejects
// a newline; `.length(36)` (server + the runtime recheck below) is belt-and-
// suspenders. m2: lowercase-only — no `i` flag (all live ids are lowercase).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * GET one CKAN `datastore_search` resource. SSRF guard (belt-and-suspenders
 * behind the server's Zod enum+regex): host ∈ allowlist, resourceId is a 36-char
 * lowercase UUID (M1 runtime recheck), and the CONSTRUCTED URL's hostname === host
 * (https). Sets `redirect:"error"` (B1); NO headers (keyless — the datastore is
 * anonymous). Reuses errors.ts retry/timeout/taxonomy (429 → rate_limited;
 * 5xx → upstream_unavailable; 404 → not_found; 409/400 → invalid_input). Returns
 * the parsed JSON (unknown; the caller validates the envelope shape).
 */
async function getCkanDatastore(host, resourceId, params) {
    if (!CKAN_HOST_SET.has(host)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `CKAN host ${JSON.stringify(host)} is not on the curated allowlist. Allowed: ${CKAN_HOSTS.join(", ")}.`,
            retryable: false,
        });
    }
    // M1 — runtime belt-and-suspenders on resourceId (parallel to the host Set.has
    // recheck; faithful copy of Socrata's re-check). No URLSearchParams-bypass
    // exists, but this is defense-in-depth for the SSRF path-interpolation vector.
    if (resourceId.length !== 36 || !UUID_RE.test(resourceId)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid CKAN resourceId ${JSON.stringify(resourceId)} — expected a 36-char lowercase UUID ([0-9a-f]{8}-{4}-{4}-{4}-{12}).`,
            retryable: false,
        });
    }
    params.set("resource_id", resourceId);
    const url = `https://${host}/api/3/action/datastore_search?${params.toString()}`;
    // Belt-and-suspenders: the FIXED path leaves only host to interpolate into the
    // authority; assert the built URL cannot have been steered off-host.
    const built = new URL(url);
    if (built.hostname !== host || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed CKAN URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the allowlisted host ${JSON.stringify(host)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
        });
    }
    // Shared fetch envelope (ADR-0005): keyless ⇒ NO headers key (byte-clean init);
    // B1 redirect:"error"; host-only label → ToolError.upstreamEndpoint.
    return getJson(url, { label: "ckan:" + host, redirect: "error" });
}
/**
 * GET a CKAN `package_search` (discovery). Same host allowlist + fixed path +
 * hostname assertion + redirect:"error" policy as getCkanDatastore.
 */
async function getCkanPackageSearch(host, params) {
    if (!CKAN_HOST_SET.has(host)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `CKAN host ${JSON.stringify(host)} is not on the curated allowlist. Allowed: ${CKAN_HOSTS.join(", ")}.`,
            retryable: false,
        });
    }
    const url = `https://${host}/api/3/action/package_search?${params.toString()}`;
    const built = new URL(url);
    if (built.hostname !== host || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed CKAN catalog URL host ${JSON.stringify(built.hostname)} does not match the allowlisted host ${JSON.stringify(host)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
        });
    }
    return getJson(url, { label: "ckan:" + host, redirect: "error" });
}
// ─── map + meta helpers ───────────────────────────────────────────
const VALUE_TYPING_NOTE = "Record values follow result.fields[].type (int/text/numeric/timestamp); a numeric column may arrive as a JSON number OR a string — parse client-side. A missing value is absent, never 0.";
const SOURCE_SUFFIX = "via CKAN datastore_search (keyless)";
/**
 * The `body.success === false` taxonomy (m3). Parse `body.error.__type`:
 *   "Not Found Error"   → not_found
 *   "Validation Error"  → invalid_input
 *   anything else       → schema_drift (NOT a blanket not_found/driftError of the
 *                         wrong kind — an unknown __type is genuine drift)
 * This is the DEFENSIVE guard for a host/proxy that returns HTTP 200 with
 * success:false (modern hosts surface real 404/409, handled by errorFromResponse
 * before we ever see the body).
 */
function throwCkanApiError(host, err) {
    const type = str(err?.__type);
    const message = str(err?.message);
    const label = "ckan:" + host;
    if (type === "Not Found Error") {
        throw new ToolErrorCarrier({
            kind: "not_found",
            message: `CKAN ${host} reported Not Found${message ? `: ${message}` : "."}`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    if (type === "Validation Error") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `CKAN ${host} reported a Validation Error${message ? `: ${message}` : "."}`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    throw driftError(label, `CKAN ${host} returned success:false with an unrecognized error type ${JSON.stringify(type)} — treating as schema drift.`);
}
// ─── Tool 1: ckan_query ───────────────────────────────────────────
/**
 * Query rows from an allowlisted CKAN datastore resource. The workhorse: reaches
 * every datastore-active spend/checkbook/procurement/vendor/certification table on
 * any allowlisted portal. Records pass through verbatim (values are typed per
 * result.fields[].type).
 *
 * HONESTY: CKAN's envelope carries a real `result.total`. The DEFAULT path is an
 * EXACT total (`total_was_estimated:false`) → exact totalAvailable + exact
 * hasMore. The rare ESTIMATED path (`total_was_estimated:true`) is defused per
 * ADR-0006 B1: totalAvailable:null + hasMore-by-page-fullness + totalIsEstimated +
 * an estimate note (the estimate can be above OR below the truth, so it is NOT a
 * lower bound and MUST NOT drive pagination). A genuine-empty (records:[],
 * total:0) → complete:true/total:0; success:false / a missing-or-non-array
 * `result.records` / a non-number `result.total` → THROWS (never a fake empty).
 */
export async function query(args) {
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (args.q)
        params.set("q", args.q);
    if (args.sort)
        params.set("sort", args.sort);
    // Q3 — `filters` is a constrained object WE serialize; never a caller-supplied
    // raw JSON string. A bad field still surfaces as an upstream 409 → invalid_input.
    if (args.filters !== undefined)
        params.set("filters", JSON.stringify(args.filters));
    const body = await getCkanDatastore(args.host, args.resourceId, params);
    const b = (body ?? {});
    // ── Shape guards (ORDER matters). ──
    // (1) success:false (even on HTTP 200) → taxonomy-classified throw (m3), NEVER
    //     a fake empty.
    if (b.success === false)
        throwCkanApiError(args.host, b.error);
    // (2) result / records must be an array (m5) — a missing result or a
    //     string/null `records` is drift, never `[]`.
    if (!b.result || !Array.isArray(b.result.records)) {
        throw driftError("ckan:" + args.host, `ckan:${args.host} datastore_search returned an unexpected shape (result.records must be an array).`);
    }
    // (3) a PRESENT `total` must be a number (m6) — num() cannot distinguish a
    //     non-number total from an absent one, so typeof-check BEFORE num().
    if (b.result.total !== undefined && typeof b.result.total !== "number") {
        throw driftError("ckan:" + args.host, `ckan:${args.host} datastore_search returned a non-number result.total — treating as schema drift.`);
    }
    const records = b.result.records;
    const fields = Array.isArray(b.result.fields) ? b.result.fields : [];
    const returned = records.length;
    const estimated = b.result.total_was_estimated === true;
    const filtersApplied = [];
    if (args.q)
        filtersApplied.push("q");
    if (args.filters !== undefined)
        filtersApplied.push("filters");
    if (args.sort)
        filtersApplied.push("sort");
    const notes = [VALUE_TYPING_NOTE];
    let totalAvailable;
    let hasMore;
    let totalIsEstimated;
    if (estimated) {
        // B1 — an ESTIMATE must NOT drive pagination. Pass null (so buildMeta derives
        // truncated/complete from page-fullness alone), paginate by page-fullness, and
        // disclose the estimate value + flag. The empty-trailing-page case (returned 0
        // < limit) → hasMore:false → complete:true (the anti-livelock guard).
        totalAvailable = null;
        hasMore = returned >= limit;
        totalIsEstimated = true;
        const estValue = num(b.result.total);
        notes.push(`totalAvailable is withheld because the upstream reported it as a server-reported ESTIMATE${estValue !== null ? ` ~${estValue}` : ""}; it is not exact and may be above OR below the true count — paginate by page-fullness (hasMore is inferred from whether the page filled), not by this estimate.`);
    }
    else {
        // EXACT total (the default). B2 hedge: if `total` is somehow absent (a host
        // running include_total:false), fall back to page-fullness so an unknown
        // total never lies complete:true.
        totalAvailable = num(b.result.total);
        hasMore =
            totalAvailable !== null
                ? offset + returned < totalAvailable
                : returned >= limit;
        if (totalAvailable === null) {
            notes.push("The upstream did not report result.total; completeness is inferred from page-fullness (CKAN returns a short page only when the result set is exhausted).");
        }
    }
    const nextOffset = hasMore ? offset + returned : null;
    const meta = {
        source: `${args.host} ${SOURCE_SUFFIX}`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    };
    if (totalIsEstimated !== undefined)
        meta.totalIsEstimated = totalIsEstimated;
    return withMeta({ host: args.host, resourceId: args.resourceId, fields, records }, meta);
}
/** Flatten one package_search `results[]` package into its resource rows. */
function mapPackageResources(pkg) {
    const p = (pkg ?? {});
    const datasetTitle = str(p.title);
    const resources = Array.isArray(p.resources) ? p.resources : [];
    return resources.map((res) => {
        const r = (res ?? {});
        return {
            resourceId: str(r.id),
            name: str(r.name),
            datasetTitle,
            format: str(r.format),
            // Only a queryable (datastore-active) resource can feed ckan_query.
            datastoreActive: r.datastore_active === true,
        };
    });
}
/**
 * Discover datastore resource ids via CKAN `package_search` (memoized ~10 min).
 * Returns per-RESOURCE rows `[{ resourceId, name, datasetTitle, format,
 * datastoreActive }]` + `totalAvailable = result.count` (the DATASET match count).
 * Feed a `datastoreActive:true` resource's `resourceId` to ckan_query.
 *
 * m6 — this is the catalog's PRIMARY response: a non-number `result.count` is a
 * hard schema_drift throw (nothing valid to return), never a fabricated total —
 * INSIDE the memoize callback so a bad shape is never cached as a success
 * (ADR-0005 v2 test-2 rule).
 */
export async function discoverDatasets(args) {
    const limit = args.limit ?? 20;
    const params = new URLSearchParams();
    params.set("q", args.q);
    params.set("rows", String(limit));
    const key = `ckan:package_search:${args.host}:${args.q}:${limit}`;
    const { totalAvailable, results, packagesReturned } = await memoize(key, async () => {
        const body = await getCkanPackageSearch(args.host, params);
        const b = (body ?? {});
        if (b.success === false)
            throwCkanApiError(args.host, b.error);
        if (!b.result) {
            throw driftError("ckan:" + args.host, `ckan:${args.host} package_search returned an unexpected shape (result missing).`);
        }
        // m6 — a non-number count is drift on the PRIMARY response (contrast a
        // best-effort secondary). Check stays INSIDE memoize so it is never cached.
        if (typeof b.result.count !== "number") {
            throw driftError("ckan:" + args.host, `ckan:${args.host} package_search returned a non-number result.count — treating as schema drift.`);
        }
        const total = num(b.result.count);
        const packages = Array.isArray(b.result.results) ? b.result.results : [];
        const rows = packages.flatMap(mapPackageResources);
        // packagesReturned = the number of DATASETS on this page. Truncation is a
        // DATASET question (totalAvailable is a dataset count), NOT a resource-row
        // one — the two units differ because a dataset can expose several resources.
        return { totalAvailable: total, results: rows, packagesReturned: packages.length };
    }, 10 * 60 * 1000);
    const returned = results.length;
    // [truncation honesty] complete/truncated is a DATASET question — compare the
    // DATASETS returned (packagesReturned) against the dataset total, NOT the
    // per-resource row count (which can EXCEED the dataset total, e.g. 2 datasets →
    // 14 resource rows vs count 10, and would spoof complete:true when only 2 of 10
    // datasets were shown). This tool returns the first `limit` datasets and has no
    // offset param, so nextOffset is null (raise `limit` to see more).
    const hasMore = totalAvailable !== null && packagesReturned < totalAvailable;
    const notes = [
        `package_search over ${args.host} (rows=${limit}). Feed a datastoreActive:true result's resourceId to ckan_query; a datastoreActive:false resource is a raw file blob (CSV/PDF/…) NOT in the datastore and is NOT queryable.`,
        "totalAvailable is the count of matching DATASETS (packages); the rows are per-RESOURCE (a dataset may expose several resources), so returned (resource rows) may differ from totalAvailable (datasets). complete/truncated tracks DATASETS shown vs matched.",
    ];
    if (hasMore) {
        notes.push(`Only the first ${packagesReturned} of ${totalAvailable} matching datasets are shown (this tool returns the first \`limit\` datasets and does not page); raise \`limit\` to retrieve more.`);
    }
    return withMeta({ host: args.host, query: args.q, results }, {
        source: `${args.host} package_search ${SOURCE_SUFFIX}`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied: ["q"],
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset: 0, limit, hasMore, nextOffset: null },
        notes,
    });
}
//# sourceMappingURL=ckan.js.map