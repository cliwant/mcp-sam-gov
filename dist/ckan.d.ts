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
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const CKAN_HOSTS: readonly ["data.ca.gov", "data.virginia.gov", "data.boston.gov"];
export type CkanHost = (typeof CKAN_HOSTS)[number];
export type CkanRecord = Record<string, unknown>;
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
export declare function query(args: {
    host: CkanHost;
    resourceId: string;
    q?: string;
    filters?: Record<string, string | number | Array<string | number>>;
    sort?: string;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
export type CkanDiscoveredResource = {
    resourceId: string | null;
    name: string | null;
    datasetTitle: string | null;
    format: string | null;
    datastoreActive: boolean;
};
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
export declare function discoverDatasets(args: {
    host: CkanHost;
    q: string;
    limit?: number;
}): Promise<MetaBundle>;
//# sourceMappingURL=ckan.d.ts.map