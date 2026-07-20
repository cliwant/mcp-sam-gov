/**
 * openfda.ts — openFDA recall/enforcement records (api.fda.gov) — the
 * PRODUCT-SAFETY / RECALL lane (ADR-0054). Drug / device / food recall
 * enforcement reports: the recalling firm, the product, the reason, the FDA
 * classification (Class I/II/III), status, and geography.
 *
 * ★ THIS IS A KEYLESS TOOL WITH AN *OPTIONAL* RATE-LIMIT KEY. openFDA works
 *   keyless (~1000 requests/day); a free OPENFDA_API_KEY only RAISES the rate
 *   limit. So — unlike Census/FRED/BEA/DOL (key-REQUIRED, throw without it) —
 *   this tool NEVER throws for a missing key. When OPENFDA_API_KEY IS set it
 *   rides ONLY the `&api_key=` query param (openFDA has NO header option — query
 *   only). See the K-test discipline below.
 *
 *   GET https://api.fda.gov/{category}/enforcement.json
 *       ?search=<lucene>&limit=<1..100>&skip=<offset>[&api_key=<KEY>]
 *     category ∈ {drug, device, food}
 *   → { meta: { disclaimer, results: { skip, limit, total } }, results: [ {...} ] }
 *
 * This module COPIES (does NOT import) the census-economic.ts bespoke-fetch idiom
 * (a single classified `fetch` rather than the shared getJson) — the reason is
 * the ★P2 CRUX below: a no-match query returns HTTP 404, and getJson→
 * fetchWithRetry throws a `not_found` ToolErrorCarrier that DISCARDS the body, so
 * we could not distinguish a genuine no-match (→ honest empty) from a real 404.
 * A bespoke fetch returns the Response so we can READ the 404 body and reclassify
 * `{error:{code:"NOT_FOUND"}}` → an honest empty. Coercion/meta code is REUSED
 * (`str` coerce.ts null-never-empty-string, `driftError`, `errorFromResponse`,
 * `withMeta`/`buildMeta` with skip/limit offset pagination). NO local str/num.
 *
 * ★ HONESTY (ADR-0054 P1–P5):
 *   [P1]  totalAvailable = `meta.results.total` EXACT (the REAL total, e.g. drug
 *         17793), NEVER results.length. skip/limit offset pagination:
 *         hasMore = skip + returned < total; nextOffset = hasMore ? skip+returned : null.
 *   [★P2] a 404 whose body is `{error:{code:"NOT_FOUND"}}` (a no-match query OR an
 *         unknown field) ⇒ HONEST EMPTY (returned:0, totalAvailable:0) — NOT thrown,
 *         NOT not_found. Any OTHER 4xx (e.g. a 400 syntax error) ⇒ invalid_input
 *         surfacing openFDA's error message. 5xx/timeout ⇒ upstream_unavailable
 *         THROW. A 200 non-JSON body ⇒ schema_drift. (Reverting the
 *         404-NOT_FOUND-as-empty handling ⇒ RED.)
 *   [P3]  dates (`recall_initiation_date`, YYYYMMDD) and every scalar surfaced as a
 *         STRING via `str` (null-never-empty-string) — no numeric coercion; never
 *         fabricated.
 *   [P4]  `meta.results` or `results` absent / non-array ⇒ driftError (never a
 *         fabricated empty).
 *   [K-test] OPTIONAL key: when OPENFDA_API_KEY is set it rides `&api_key=` ONLY,
 *         so the key WILL appear in the raw fetch URL (an unavoidable openFDA
 *         constraint — no header option). Mitigation: the `label` is host+path
 *         ONLY (`openfda:/{category}/enforcement`, NO query), so no token can reach
 *         ToolError.upstreamEndpoint; `_meta.source` names the MODE only; the key is
 *         ABSENT from the serialized {data,_meta}, notes, and any log. Unset ⇒
 *         keyless (no api_key param at all).
 *   [SSRF] fixed host `api.fda.gov`; `category` is an ENUM (→ the path segment);
 *         all filter VALUES are Lucene-escaped + phrase-quoted and ride
 *         URLSearchParams `search=`; limit/skip are integers; state is charclass
 *         `^[A-Za-z]{2}$`. A post-construction hostname/protocol assertion +
 *         `redirect:"error"` lock it (no raw Lucene passthrough — structured only,
 *         injection-safe).
 */
import { type MetaBundle } from "./meta.js";
export declare const OPENFDA_HOST = "api.fda.gov";
export declare const OPENFDA_CATEGORIES: readonly ["drug", "device", "food"];
export type OpenfdaCategory = (typeof OPENFDA_CATEGORIES)[number];
export declare const OPENFDA_CLASSIFICATIONS: readonly ["Class I", "Class II", "Class III"];
/** Read OPENFDA_API_KEY from env; trim; return the value or undefined (unset/blank). */
export declare function openfdaApiKey(): string | undefined;
export type OpenfdaRecall = {
    recallingFirm: string | null;
    productDescription: string | null;
    reasonForRecall: string | null;
    classification: string | null;
    status: string | null;
    state: string | null;
    city: string | null;
    recallInitiationDate: string | null;
    recallNumber: string | null;
    voluntaryMandated: string | null;
    distributionPattern: string | null;
};
/**
 * Quote a filter value as a Lucene phrase term. Wrapping in double quotes makes a
 * multi-word value (e.g. "Class I", "johnson & johnson") match as a phrase and
 * closes every operator-injection surface; within the quoted term only `"` and
 * `\` are special, so we backslash-escape BOTH (a `"` in the value can never break
 * out of the quotes). There is NO raw Lucene passthrough — the tool assembles the
 * whole `search=` string from validated typed args.
 */
export declare function luceneQuote(v: string): string;
/** The structured filter set → openFDA `field:value` clauses. */
export type OpenfdaFilters = {
    firm?: string;
    product?: string;
    reason?: string;
    classification?: string;
    status?: string;
    state?: string;
};
/**
 * Assemble the openFDA `search=` Lucene string from structured filters — each
 * value Lucene-escaped + phrase-quoted, joined by ` AND `. Returns "" when no
 * filter is present (openFDA then returns the whole category). The mapping of
 * clause → field is FIXED here; a caller can never inject a raw field:value.
 */
export declare function buildSearch(f: OpenfdaFilters): string;
/**
 * A SINGLE classified `fetch` to api.fda.gov (NOT the shared getJson — we must
 * READ a 404 body to distinguish a NOT_FOUND no-match from a real outage; see the
 * ★P2 crux in the caller). Builds the URL on the FIXED host from `params`, asserts
 * the constructed URL cannot have been steered off-host (belt-and-suspenders), and
 * sets `redirect:"error"` (fail closed on any off-host 3xx — a redirect could
 * carry the api_key away). Returns the raw Response for the caller to classify. A
 * timeout/abort ⇒ non-retryable upstream_unavailable; a network TypeError ⇒
 * retryable upstream_unavailable; a redirect TypeError ⇒ schema_drift (never a
 * fake-empty). `label` is host+path only.
 */
export declare function fetchOpenfda(url: string, label: string): Promise<Response>;
/** Best-effort read of an openFDA error body `{error:{code,message}}`. null on any failure. */
export declare function readOpenfdaError(res: Response): Promise<{
    code: string | null;
    message: string | null;
}>;
export type OpenfdaEnforcementArgs = OpenfdaFilters & {
    category?: string;
    limit?: number;
    skip?: number;
};
/**
 * Search openFDA recall/enforcement records for a category (drug/device/food) with
 * structured filters → curated recall rows + honest `_meta`. KEYLESS (an OPTIONAL
 * OPENFDA_API_KEY only raises the rate limit). totalAvailable = meta.results.total
 * (EXACT); skip/limit offset pagination. ★A no-match query (openFDA HTTP 404
 * NOT_FOUND) ⇒ an honest empty, never a throw.
 */
export declare function enforcement(args: OpenfdaEnforcementArgs): Promise<MetaBundle>;
/** openFDA caps `skip` at 25000 (skip>25000 → HTTP 400 "Skip value must 25000 or less").
 *  The last reachable page is skip=25000, so at most ~25000+limit records are enumerable
 *  via offset paging — datasets larger than that have an UNREACHABLE tail. */
export declare const OPENFDA_MAX_SKIP = 25000;
/** Ceiling- and empty-aware pagination. `hasMore` is false on an empty page (returned:0,
 *  the fema/nvd guard) OR when the next offset would exceed OPENFDA_MAX_SKIP (advertising a
 *  skip>25000 nextOffset is a poison cursor — following it 400s). `ceilingHit` is true when
 *  more rows exist upstream but lie beyond the reachable skip window (must be disclosed). */
export declare function openfdaPageMeta(skip: number, returned: number, totalAvailable: number | null): {
    hasMore: boolean;
    nextOffset: number | null;
    ceilingHit: boolean;
};
/** The ceiling disclosure (records beyond the skip window are permanently unreachable). */
export declare const OPENFDA_CEILING_NOTE = "openFDA caps pagination at skip=25000: records beyond ~25000+limit are NOT reachable via this API, so totalAvailable exceeds the paginable window here and the tail is unreachable. Narrow the query (add filters or a date range) to bring the matching set within the first 25000 records.";
/** Skip-aware total for a 404 NOT_FOUND: openFDA returns the SAME 404 for a genuine
 *  zero-match (only provable at skip 0) and an OVER-SKIP (skip past the end). So skip===0
 *  ⇒ a true total of 0; a skip>0 404 is AMBIGUOUS ⇒ totalAvailable unknown (null). */
export declare function openfdaEmptyTotal(skip: number): number | null;
/** Disclosure for a skip>0 404 (ambiguous over-skip vs no-match; total unknown). */
export declare const OPENFDA_OVERSKIP_NOTE = "Returned 0 at this offset: the skip is at/past the end of the result set (or a genuine no-match). openFDA returns an IDENTICAL HTTP 404 for both, so the true total is UNKNOWN at a non-zero skip (totalAvailable is null, not 0) \u2014 re-query at skip:0 for the exact total. This is NOT a confirmed empty result set.";
//# sourceMappingURL=openfda.d.ts.map