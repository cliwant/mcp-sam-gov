/**
 * lda.ts — US Senate LDA (Lobbying Disclosure Act) filings — the LOBBYING / B2G
 * influence lane (ADR-0052). Who is paid HOW MUCH to lobby WHICH federal agency
 * on WHICH issue — the registrant→client→government-entity signal that no
 * contract/spending/grant source carries.
 *
 * ★ THIS IS A KEYLESS SOURCE WITH AN OPTIONAL KEY (the socrata.ts app-token
 *   lineage, NOT the census/fred/bea key-required lineage). The LDA REST API
 *   (lda.senate.gov/api/v1) serves anonymous GETs at HTTP 200 — it works with NO
 *   key. A free `LDA_API_KEY` only RAISES the shared rate limit; when set it rides
 *   ONLY as the `Authorization: Token <value>` request header (never the
 *   URL/label/_meta/notes/log — the K-test). When unset, NO auth header is sent
 *   (genuine keyless). This mirrors socrata's optional `X-App-Token` discipline.
 *
 * The module writes ZERO fetch/coercion/error/meta code of its own: it REUSES
 * `getJson` (the shared fetch envelope, redirect:"error") / `driftError` /
 * `num`·`str` (coerce.ts, null-never-0/empty) / `withMeta`·`buildMeta`.
 *
 *   GET https://lda.senate.gov/api/v1/filings/
 *       ?filing_year=&filing_type=&registrant_name=&client_name=&lobbyist_name=
 *        &filing_specific_lobbying_issues=&government_entity=&page=&page_size=
 *   → { count, next, previous, results:[{ filing_uuid, filing_type,
 *        filing_type_display, filing_year, filing_period, filing_period_display,
 *        filing_document_url, income, expenses, dt_posted, termination_date,
 *        registrant:{name,…}|string, client:{name,…}|string,
 *        lobbying_activities:[{ general_issue_code, general_issue_code_display,
 *          description, government_entities:[{ name }] }], … }] }
 *
 * ★ HONESTY (ADR-0052 P1–P5):
 *   [P1]   `count` is the API's REAL total (~1.95M) ⇒ totalAvailable = num(count),
 *          NEVER results.length. Page-based pagination (page/page_size, 1-based):
 *          returned = results.length, hasMore = page*pageSize < count, and the next
 *          page number is surfaced in a note. Reverting totalAvailable to
 *          results.length must go RED.
 *   [P2]   getJson → fetchWithRetry taxonomy: a 400 (bad filter/param) ⇒
 *          invalid_input SURFACING the API's error body (re-read once on the error
 *          path); a 5xx/timeout ⇒ upstream_unavailable THROW; a 429 ⇒ rate_limited
 *          THROW honoring Retry-After (NEVER routed around); a genuine no-match
 *          (results:[]) ⇒ honest empty (returned:0); a 200 non-JSON ⇒ schema_drift.
 *   [P3]   `income`/`expenses` are null-or-decimal-string ⇒ num() (null ⇒ null — NOT
 *          reported ≠ 0; a genuine "0" stays 0). A missing `lobbying_activities` /
 *          `government_entities` ⇒ empty arrays (never fabricated).
 *   [P4]   `results` non-array or `count` non-number ⇒ driftError (never a
 *          fabricated empty/total).
 *   [SSRF] fixed host `lda.senate.gov`; a post-construction hostname/protocol
 *          assert + `redirect:"error"`; every filter VALUE rides URLSearchParams;
 *          `filingYear` / `page` / `pageSize` are charclass/range-guarded pre-fetch.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const LDA_HOST = "lda.senate.gov";
/**
 * The optional Authorization header (keyless-first, socrata app-token lineage).
 * Present ONLY when LDA_API_KEY is set (non-blank); the value is NEVER logged /
 * never placed in the URL, label, `_meta`, or a note. When unset, `{}` (no header).
 */
export declare function ldaAuthHeader(): Record<string, string>;
/** true iff an LDA API key is configured (for the `_meta` note — never the value). */
export declare function ldaKeyPresent(): boolean;
export type LdaLobbyingActivity = {
    issueCode: string | null;
    description: string | null;
    governmentEntities: string[];
};
export type LdaFiling = {
    filingUuid: string | null;
    filingType: string | null;
    filingYear: number | null;
    filingPeriod: string | null;
    incomeUsd: number | null;
    expensesUsd: number | null;
    registrant: string | null;
    client: string | null;
    lobbyingActivities: LdaLobbyingActivity[];
    documentUrl: string | null;
    postedDate: string | null;
    terminationDate: string | null;
};
/**
 * The registrant/client value may be an OBJECT carrying `name` (with address
 * fields) OR a plain string. Defensively resolve either to the display name (or
 * null when absent) — never fabricate, never surface the whole address object.
 */
export declare function nameOf(x: unknown): string | null;
export type LdaSearchFilingsArgs = {
    registrantName?: string;
    clientName?: string;
    lobbyistName?: string;
    filingYear?: string;
    filingType?: string;
    agency?: string;
    issue?: string;
    page?: number;
    pageSize?: number;
};
/**
 * Search US Senate LDA lobbying filings (`/api/v1/filings/`) → curated filing rows
 * + honest `_meta`. KEYLESS (an optional LDA_API_KEY only raises the rate limit,
 * sent as the Authorization header only). ★totalAvailable is the API's REAL `count`
 * (~1.95M corpus) — never results.length; page-based pagination. income/expenses
 * null-or-decimal-string → null-never-0.
 */
export declare function searchFilings(args: LdaSearchFilingsArgs): Promise<MetaBundle>;
//# sourceMappingURL=lda.d.ts.map