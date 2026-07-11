/**
 * govinfo.ts — GovInfo (`api.govinfo.gov`) — GPO-authoritative bulk publications
 * (BILLS, PLAW, USCODE, CREC, CFR/FR editions, BUDGET, GAOREPORTS, …) with
 * PDF/XML/MODS downloads + provenance. ADR-0010. This COMPLETES the api.data.gov
 * KEYED trio (ADR-0007 shipped Regulations.gov + Congress.gov; GovInfo was deferred
 * there for its opaque cursor).
 *
 * ★ HIGHEST-REUSE SLICE: the 2nd consumer of the shipped api.data.gov env-key
 * adapter (imported from the shared `./datagovKey.js` seam — §2). It writes ZERO new
 * key/fetch/coercion/error code: it REUSES `getJson`/`driftError`/`num`·`str` and
 * COPIES (does not import) the Socrata/CKAN/datagov SSRF + honesty PATTERN. The one
 * genuinely-novel piece is GovInfo's OPAQUE `offsetMark` cursor (§3 of the ADR).
 *
 * ★ KEY-SECURITY (§2 — inherited verbatim from ADR-0007 via datagovKey.ts):
 *  1. The key rides in `headers:{ "X-Api-Key": <key> }` ONLY — NEVER the URL/query
 *     (GovInfo also accepts `?api_key=`; we DELIBERATELY reject that form — it would
 *     embed the secret in the request URL AND in the echoed `nextPage`).
 *  2. `label` is HOST+PATH only ("govinfo:/collections" / "govinfo:/packages") —
 *     never the full URL, never a token.
 *  3. `_meta.source`/`notes` are host + key-MODE only — never the URL/key/header.
 *  4. The upstream `nextPage`/`previousPage` URLs are NEVER surfaced verbatim (they
 *     embed pageSize + api_key) — the cursor is re-derived by extracting ONLY the
 *     `offsetMark` value via `URL.searchParams`. `get_package` download links that
 *     embed `api_key` are stripped key-free before the payload is surfaced.
 *
 * ★ OPAQUE-CURSOR HONESTY (§3 — the novel pattern, "opaque-cursor pass-back"):
 *   - `totalAvailable = num(count)` — the EXACT real total (no lower-bound/estimate).
 *   - `hasMore` = `nextPage` present (⇔ a next cursor exists).
 *   - `_meta.nextCursor` = the next page's `offsetMark`, extracted from `nextPage`;
 *     `nextOffset:null` + `offset:null` ALWAYS (a numeric offset is meaningless for
 *     an opaque cursor). Continue by passing `nextCursor` back as `pageMark`.
 *   - M3 phantom-empty guard: `packages:[]` WITH `nextPage` present ⇒ `hasMore:false,
 *     nextCursor:null` (never follow into an empty cursor loop).
 *   - M4 complete: passed EXPLICITLY — `false` whenever `pageMark !== "*"` (a
 *     continuation, not the whole set); `true` only when `pageMark === "*" && !hasMore`
 *     (a single first-page call that IS the full result).
 *   - M6 nextPage parse-error: a malformed `nextPage` ⇒ schema_drift WITHOUT the raw
 *     value in the message (it may hold the real key); a valid `nextPage` lacking a
 *     usable `offsetMark` ⇒ graceful no-more.
 *   - NO 10k reachability wall (unlike EDGAR/Regulations): GovInfo's cursor traverses
 *     the ENTIRE result set, so there is no "unreachable remainder" caveat.
 *
 * ★ SSRF (§4 — copy the single-fixed-host shape): one fixed host `api.govinfo.gov`;
 * fixed service-path bases; the interpolated path segments (`collection`/`date`/
 * `packageId`) are grammar-constrained; `pageMark`/`pageSize` ride through
 * URLSearchParams; post-construction `hostname==="api.govinfo.gov" && https`
 * assertion; `redirect:"error"`. ★ ECHO-trap mitigation: `collection` is validated
 * against the memoized `/collections` catalog (a well-formed-but-unknown code could
 * return a silent `count:0`); M5 — if that catalog fetch FAILS, the error is
 * PROPAGATED (never bypass validation into a possibly-silent-empty data query).
 *
 * ★ HONESTY (§5): genuine-empty (`count:0`, valid inputs) ⇒ complete:true/total:0;
 * outage/5xx/timeout/401/403/404/429 ⇒ getJson THROWS (never `[]`); a 200 with a
 * missing/non-number `count`, or `packages`/`collections` NOT an array ⇒ driftError
 * (container-guarded — a TypeError must never mask drift as upstream_unavailable).
 * `num`/`str` are null-never-0.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const GOVINFO_HOST = "api.govinfo.gov";
export declare const GOVINFO_COLLECTION_RE: RegExp;
export declare const GOVINFO_DATE_RE: RegExp;
export declare const GOVINFO_PACKAGE_ID_RE: RegExp;
export declare const GOVINFO_PAGE_MARK_RE: RegExp;
export type GovinfoCollection = {
    collectionCode: string | null;
    collectionName: string | null;
    packageCount: number | null;
    granuleCount: number | null;
};
/**
 * The discovery entry-point: the GovInfo collection catalog (a single definitive
 * read — complete:true, totalAvailable = collections.length). Memoized ~6h; the
 * SAME memoized catalog validates `collection` in govinfo_search_packages.
 */
export declare function listCollections(_args?: Record<string, never>): Promise<MetaBundle>;
export type GovinfoPackage = {
    packageId: string | null;
    title: string | null;
    dateIssued: string | null;
    lastModified: string | null;
    docClass: string | null;
    congress: string | null;
    packageLink: string | null;
};
type GovinfoSearchArgs = {
    collection: string;
    startDate: string;
    endDate?: string;
    pageSize?: number;
    pageMark?: string;
};
/**
 * The workhorse + the sole carrier of the opaque-cursor pattern. Packages in a
 * collection modified since `startDate` (lastModified facet). `collection` is
 * grammar-checked THEN validated against the memoized `/collections` catalog (M5 —
 * a catalog-fetch failure PROPAGATES, never bypasses validation). Continuation is
 * via `_meta.nextCursor` passed back as `pageMark` (default "*" = first page).
 */
export declare function searchPackages(args: GovinfoSearchArgs): Promise<MetaBundle>;
/**
 * The drill-down: one package's metadata + download links (txt/xml/pdf/mods/premis/
 * zip) + related links. A 404 (nonexistent packageId) ⇒ honest found:false (never a
 * fabricated summary). Any `api_key` embedded in a download/related link is stripped
 * key-free before the payload is surfaced (M1/M2).
 */
export declare function getPackage(args: {
    packageId: string;
}): Promise<MetaBundle>;
//# sourceMappingURL=govinfo.d.ts.map