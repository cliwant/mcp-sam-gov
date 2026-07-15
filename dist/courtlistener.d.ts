/**
 * courtlistener.ts — US FEDERAL COURT OPINIONS via CourtListener (ADR-0055) — the
 * LITIGATION / case-law lane. Federal court decisions (opinions/clusters) — who
 * sued whom in which court, the nature of suit, the disposition — the judicial
 * signal no contract/spending/lobbying source carries (e.g. bid-protest and
 * contract-claim opinions from the US Court of Federal Claims `uscfc` and the
 * Federal Circuit `cafc`).
 *
 * ★ PROVENANCE — THIS IS NOT A .gov API (must be disclosed). The DATA is US federal
 *   court PUBLIC RECORDS, but the API is **CourtListener**, operated by the **Free
 *   Law Project** (a non-profit) which republishes those records KEYLESS. The .gov
 *   primary source (PACER) is PAYWALLED. So every response's `_meta.source` AND a
 *   note name CourtListener/Free Law Project and disclose the PACER-paywall — the
 *   tool never presents itself as a government API.
 *
 * ★ THIS IS A KEYLESS TOOL WITH AN *OPTIONAL* RATE-LIMIT TOKEN (the lda.ts /
 *   socrata app-token lineage, NOT the census/fred/bea key-REQUIRED lineage).
 *   Anonymous GETs return HTTP 200 — it works with NO token. A free
 *   COURTLISTENER_API_TOKEN only RAISES the shared rate limit; when set it rides
 *   ONLY as the `Authorization: Token <value>` request header (never the
 *   URL/label/_meta/notes/log — the K-test). When unset, NO auth header is sent
 *   (genuine keyless). This mirrors lda.ts's optional-Authorization discipline.
 *
 *   GET https://www.courtlistener.com/api/rest/v4/search/
 *       ?q=&court=&filed_after=&filed_before=&type=o&order_by=<order>[&cursor=]
 *   → { count, next, previous, results:[{ caseName, court, court_id, dateFiled,
 *        docketNumber, suitNature, status, judge, citation, absolute_url, … }] }
 *
 * ★ HONESTY (ADR-0055 P1–P5):
 *   [P1]  totalAvailable = `count` (the API's REAL total for the filter, e.g. the
 *         uscfc opinion corpus ~10595) — NEVER results.length. ★CURSOR pagination:
 *         `next` is a FULL URL carrying an opaque `cursor=` param (NOT page/offset).
 *         We EXTRACT the `cursor` value out of `next` and return it as `nextCursor`
 *         (offset/nextOffset null — a numeric offset is meaningless); hasMore = next
 *         is a non-null string. CourtListener v4 stops counting on deep cursor pages
 *         (`count:null`) — that is DISCLOSED (totalAvailable:null + a note), never
 *         fabricated as results.length.
 *   [P2]  a genuine no-match (results:[]) ⇒ honest empty (returned:0). A 400 (bad
 *         param) ⇒ invalid_input surfacing the API's message. A 429 (unauth
 *         throttle) ⇒ rate_limited THROW (Retry-After honored, never routed around).
 *         A 5xx/timeout ⇒ upstream_unavailable THROW. A 200 non-JSON ⇒ schema_drift.
 *   [P3]  dates are strings; `citation` may be an array/object ⇒ flattened to a safe
 *         string / string[] (never fabricated); judge / natureOfSuit / docketNumber
 *         are null when absent (never empty-string); every scalar null-never-empty.
 *   [P4]  `results` non-array, or `count` neither a number NOR null ⇒ driftError
 *         (never a fabricated empty/total).
 *   [K-test] OPTIONAL token: when COURTLISTENER_API_TOKEN is set it rides ONLY the
 *         `Authorization: Token …` header — NEVER the URL/label/_meta/notes/log.
 *         Unset ⇒ anonymous (no auth header at all).
 *   [SSRF] fixed host `www.courtlistener.com`; a post-construction hostname/protocol
 *         assert + `redirect:"error"`; `court` charclass `^[a-z0-9]+$`; the dates
 *         charclass `^\d{4}-\d{2}-\d{2}$`; every VALUE rides URLSearchParams. The
 *         `cursor` is opaque but charclass-guarded; and when we EXTRACT the cursor
 *         from a `next` URL we RE-ASSERT that URL's host is courtlistener.com — an
 *         off-host `next` is REFUSED (schema_drift), never followed.
 */
import { type MetaBundle } from "./meta.js";
export declare const COURTLISTENER_HOST = "www.courtlistener.com";
export declare const COURTLISTENER_CURSOR_RE: RegExp;
/**
 * The optional Authorization header (keyless-first, lda.ts/socrata app-token
 * lineage). Present ONLY when COURTLISTENER_API_TOKEN is set (non-blank); the value
 * is NEVER logged / never placed in the URL, label, `_meta`, or a note. When unset,
 * `{}` (no header ⇒ genuine anonymous).
 */
export declare function courtlistenerAuthHeader(): Record<string, string>;
/** true iff a CourtListener token is configured (for the `_meta` note — never the value). */
export declare function courtlistenerTokenPresent(): boolean;
export type CourtlistenerOpinion = {
    caseName: string | null;
    court: string | null;
    courtId: string | null;
    dateFiled: string | null;
    docketNumber: string | null;
    natureOfSuit: string | null;
    status: string | null;
    judge: string | null;
    citation: string | string[] | null;
    absoluteUrl: string | null;
};
/**
 * Flatten CourtListener's `citation` (which may be a string, an array of strings,
 * or an object) to a safe `string | string[] | null` — NEVER fabricated. An array
 * ⇒ the non-null strings (or null when none); a string ⇒ that string; an object ⇒
 * its non-null string VALUES (or null when none); absent ⇒ null. `[object Object]`
 * can never leak (we never `String()` an object).
 */
export declare function flattenCitation(x: unknown): string | string[] | null;
/**
 * Extract the opaque `cursor` value from a CourtListener `next` URL. RE-ASSERTS the
 * `next` URL's host is courtlistener.com — an OFF-HOST `next` is REFUSED (drift),
 * never parsed/followed (SSRF: a poisoned `next` could otherwise steer the next
 * page off-host). Returns the decoded cursor string, or null when `next` is null /
 * carries no cursor. A non-string / unparseable `next` ⇒ null (treated as "no more").
 */
export declare function extractNextCursor(next: unknown, label: string): string | null;
export type CourtlistenerSearchOpinionsArgs = {
    query?: string;
    court?: string;
    dateFiledAfter?: string;
    dateFiledBefore?: string;
    natureOfSuit?: string;
    cursor?: string;
    order?: string;
};
/**
 * Search US federal court opinions via CourtListener (`/api/rest/v4/search/`,
 * type=o) → curated opinion rows + honest `_meta`. KEYLESS (an optional
 * COURTLISTENER_API_TOKEN only raises the rate limit, sent as the Authorization
 * header only). ★PROVENANCE: this is CourtListener/Free Law Project (a non-profit),
 * NOT a .gov API — PACER (the .gov source) is paywalled. totalAvailable is the
 * API's REAL `count`; CURSOR pagination (nextCursor extracted from `next`).
 */
export declare function searchOpinions(args: CourtlistenerSearchOpinionsArgs): Promise<MetaBundle>;
//# sourceMappingURL=courtlistener.d.ts.map