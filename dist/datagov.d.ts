/**
 * datagov.ts — the api.data.gov KEYED trio (slice 1: Regulations.gov +
 * Congress.gov). ADR-0007.
 *
 * This is the project's FIRST KEYED (non-keyless) source — every prior source
 * (Treasury, EDGAR, Socrata, CKAN) is anonymous. It exercises policy② ("keyless-
 * first, but when a free public key is required, research + automate its
 * issuance"), so the load-bearing concern is a SAFE env-key adapter whose secret
 * can NEVER leak into a ToolError, a URL, a log, or `_meta`. Built on the R2
 * `DataSource` port (ADR-0005) exactly like CKAN — it writes ZERO fetch/coercion/
 * error/meta code (reuses `getJson`/`driftError`/`num`·`str`/`withMeta`) and
 * COPIES (does not import) the Socrata/CKAN SSRF + honesty PATTERN.
 *
 * ★ THE KEY-SECURITY DISCIPLINE (ADR-0007 §2 — the load-bearing rules):
 *  1. The key travels in `headers:{ "X-Api-Key": <key> }` ONLY — NEVER in the
 *     URL/query (no `?api_key=`). Live-verified: the `X-Api-Key` header works for
 *     BOTH api.regulations.gov and api.congress.gov, so the key is structurally
 *     absent from the request URL (→ never in a CDN/proxy/access log, never in
 *     `getJson`'s `label`, never in `ToolError.upstreamEndpoint`).
 *  2. `label` is HOST+PATH only (e.g. "regulations:/v4/documents",
 *     "congress:/v3/bill") — never the full URL, never a token. This is what
 *     reaches `ToolError.upstreamEndpoint`.
 *  3. `_meta.source`/`notes` are host + key-MODE only ("…(DEMO_KEY)" /
 *     "…(DATA_GOV_API_KEY)") — never the URL, never the key value, never the
 *     `X-Api-Key` header.
 *  4. Headers are never logged/echoed; upstream `next`/`pagination.next` URLs are
 *     NEVER surfaced verbatim — pagination is re-derived NUMERICALLY.
 *  5. Never commit the key — read from env only; the DEMO_KEY fallback is a
 *     literal public constant (safe in source), the real key never is.
 *
 * ★ KEYLESS-FIRST UX (policy② / §3): DATA_GOV_API_KEY from env, else the public
 * literal "DEMO_KEY" + a `_meta.notes` disclosure of the ~10 req/hr shared ceiling
 * and the free-key signup path. `keylessMode:false` (this is the FIRST source to
 * report it — it is genuinely keyed).
 *
 * ★ SSRF (§4): two fixed hosts (constants, no free host param); all caller params
 * via URLSearchParams; path segments that interpolate caller input (Congress
 * `/v3/bill/{congress}/{billType}/{billNumber}`) are Zod-constrained to int/enum;
 * post-construction `hostname===host && https` assertion; `redirect:"error"`.
 *
 * ★ HONESTY (§5): totals are EXACT integers read from the PRIMARY container
 * (`meta.totalElements` / `pagination.count`) with container guards (a null/absent
 * container or a non-number total → `driftError`, NOT a TypeError/upstream_unavail);
 * the primary array (`data`/`bills`) must be an array or → `driftError`; a
 * genuine-empty (0 results) → complete:true/total:0; an outage/5xx/timeout throws
 * (never a fake empty). Regulations.gov's 40-page/10,000-record HARD CAP is
 * handled with the EDGAR window-cap pattern (B1): `hasMore:true` (more genuinely
 * exists) BUT `nextOffset:null` (no reachable continuation) + a disclosing note.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const REGULATIONS_HOST = "api.regulations.gov";
export declare const CONGRESS_HOST = "api.congress.gov";
export declare const REGULATIONS_SORTS: readonly ["-postedDate", "postedDate", "-lastModifiedDate", "lastModifiedDate", "-commentEndDate"];
export type RegulationsSort = (typeof REGULATIONS_SORTS)[number];
export declare const REGULATIONS_DOCUMENT_TYPES: readonly ["Rule", "Proposed Rule", "Notice", "Supporting & Related Material", "Other"];
export type RegulationsDocumentType = (typeof REGULATIONS_DOCUMENT_TYPES)[number];
export declare const REGULATIONS_DOCKET_TYPES: readonly ["Rulemaking", "Nonrulemaking"];
export type RegulationsDocketType = (typeof REGULATIONS_DOCKET_TYPES)[number];
export declare const REGULATIONS_DOCKET_SORTS: readonly ["-lastModifiedDate", "lastModifiedDate", "title", "-title"];
export type RegulationsDocketSort = (typeof REGULATIONS_DOCKET_SORTS)[number];
export declare const CONGRESS_BILL_TYPES: readonly ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"];
export type CongressBillType = (typeof CONGRESS_BILL_TYPES)[number];
type RegulationsSearchArgs = {
    searchTerm?: string;
    query?: string;
    agencyId?: string;
    docketId?: string;
    documentType?: RegulationsDocumentType;
    withinCommentPeriod?: boolean;
    postedDateGe?: string;
    postedDateLe?: string;
    sort?: RegulationsSort;
    pageNumber?: number;
    pageSize?: number;
};
/** Tool: regulations_search_documents. */
export declare function searchDocuments(args: RegulationsSearchArgs): Promise<MetaBundle>;
/** Tool: regulations_search_comments. */
export declare function searchComments(args: RegulationsSearchArgs): Promise<MetaBundle>;
type RegulationsSearchDocketsArgs = {
    searchTerm?: string;
    query?: string;
    agencyId?: string;
    docketType?: RegulationsDocketType;
    lastModifiedDateGe?: string;
    lastModifiedDateLe?: string;
    sort?: RegulationsDocketSort;
    limit?: number;
    pageNumber?: number;
};
type RegulationsGetDocketArgs = {
    docketId: string;
};
/**
 * Tool: regulations_search_dockets (`GET /v4/dockets`). Lists rulemaking/
 * nonrulemaking docket CONTAINERS with the same 40-page/10,000-record ceiling and
 * `totalElements`-exact total doctrine as regulationsSearch.
 *
 * ★ min-5 floor (ADR-0044): the API 400s on page[size]<5. The friendly `limit`
 * exposes 1..250; the wire page[size] is `max(5, limit)` and a `limit<5` returns
 * the first `limit` of the fetched rows client-side (disclosed) — `totalAvailable`
 * stays the EXACT server total.
 */
export declare function searchDockets(args: RegulationsSearchDocketsArgs): Promise<MetaBundle>;
/**
 * Tool: regulations_get_docket (`GET /v4/dockets/{docketId}`). Single-docket
 * detail — the ONLY view carrying `rin`. `docketId` is charclass-validated at the
 * Zod layer (S1); it is the only caller value reaching a path segment.
 */
export declare function getDocket(args: RegulationsGetDocketArgs): Promise<MetaBundle>;
type CongressSearchBillsArgs = {
    query?: string;
    congress?: number;
    billType?: CongressBillType;
    fromDateTime?: string;
    toDateTime?: string;
    offset?: number;
    limit?: number;
};
/**
 * Tool: congress_search_bills. Lists bills via `/v3/bill`, `/v3/bill/{congress}`,
 * or `/v3/bill/{congress}/{billType}` (congress/billType are Zod-constrained PATH
 * segments — §4). Numeric offset/limit pagination; `totalAvailable =
 * pagination.count` (EXACT). `nextOffset` is re-derived NUMERICALLY (never the
 * upstream `pagination.next` URL — §2 rule 4).
 *
 * HONESTY on `query`: the Congress.gov `/v3/bill` endpoint has NO keyword-search
 * parameter, so a supplied `query` is NOT sent and is disclosed in
 * `filtersDropped` (a filter we cannot honor is surfaced, never silently ignored).
 */
export declare function searchBills(args: CongressSearchBillsArgs): Promise<MetaBundle>;
type CongressGetBillArgs = {
    congress: number;
    billType: CongressBillType;
    billNumber: number;
};
/**
 * Tool: congress_get_bill. Fetches one bill via
 * `/v3/bill/{congress}/{billType}/{billNumber}` (all three path segments are
 * Zod-constrained to int/enum — §4, no injection). Single-record honest `_meta`
 * (complete:true). A 404 (nonexistent bill) → not_found (never fabricated).
 */
export declare function getBill(args: CongressGetBillArgs): Promise<MetaBundle>;
//# sourceMappingURL=datagov.d.ts.map