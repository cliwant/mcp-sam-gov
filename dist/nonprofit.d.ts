/**
 * nonprofit.ts — US TAX-EXEMPT NONPROFITS (IRS Form 990) — the nonprofit /
 * grantee / subcontractor vetting lane (ADR-0060). Who a tax-exempt organization
 * IS (EIN, NTEE code, subsection, ruling date, status) and what its Form 990
 * FINANCIALS look like (revenue, expenses, assets, liabilities by tax year) —
 * the 501(c) signal no contract/spending/grant/lobbying source carries.
 *
 * ★ PROVENANCE — THIS IS NOT A .gov API (must be disclosed). The DATA is IRS Form
 *   990 filings — FEDERAL tax-exempt PUBLIC RECORDS — but the API is **ProPublica
 *   Nonprofit Explorer**, operated by **ProPublica** (a non-profit newsroom) which
 *   republishes those records KEYLESS. The IRS itself offers NO clean query API
 *   (only bulk downloads / a web UI). So every response's `_meta.source` AND a note
 *   name "IRS Form 990 data via ProPublica Nonprofit Explorer" — the tool NEVER
 *   presents itself as a government API.
 *
 * ★ KEYLESS — no key of any kind. Anonymous GETs return HTTP 200. There is NO
 *   KEY_REGISTRY / keys.ts / API_KEYS.md entry for this source.
 *
 * The module writes ZERO fetch/coercion/error/meta code of its own: it REUSES
 * `getJson` (the shared fetch envelope, redirect:"error") / `driftError` /
 * `num`·`str` (coerce.ts, null-never-0/empty) / `withMeta`·`buildMeta`.
 *
 *   SEARCH  GET https://projects.propublica.org/nonprofits/api/v2/search.json
 *       ?q=&state[id]=&ntee[id]=&page=
 *     → { total_results, organizations:[{ ein, name, sub_name, city, state,
 *          ntee_code, subseccd, score }], num_pages, cur_page, per_page,
 *          page_offset }
 *   DETAIL  GET https://projects.propublica.org/nonprofits/api/v2/organizations/{ein}.json
 *     → { organization:{ ein, name, address, city, state, zipcode, ntee_code,
 *          subsection_code, ruling_date, exempt_organization_status_code,
 *          foundation_code }, filings_with_data:[{ tax_prd_yr, formtype, pdf_url,
 *          totrevenue, totfuncexpns, totassetsend, totliabend }] }
 *
 * ★ HONESTY (ADR-0060 P1–P5):
 *   [P1]   SEARCH totalAvailable = `total_results` (the API's REAL total for the
 *          query) — NEVER organizations.length. Page pagination (page is 0-based):
 *          hasMore = (cur_page+1) < num_pages; the next page number is surfaced in
 *          a note. DETAIL totalAvailable = filings.length (the COMPLETE filing set
 *          from the one detail doc — no pagination). Reverting the search total to
 *          organizations.length must go RED.
 *   [P2]   SEARCH a genuine no-match (organizations:[]) ⇒ honest empty (returned:0,
 *          complete:true). DETAIL an unknown EIN (HTTP 404) ⇒ not_found (NEVER a
 *          fabricated empty org). A 4xx ⇒ invalid_input; a 5xx/timeout ⇒
 *          upstream_unavailable THROW; a 200 non-JSON ⇒ schema_drift.
 *   [P3]   The four Form 990 figures (totrevenue/totfuncexpns/totassetsend/
 *          totliabend) ride `num()` — a genuine 0 STAYS 0, an absent figure ⇒ null
 *          (NEVER 0-faked). EIN + the codes are strings; ruling_date is a string.
 *   [P4]   SEARCH `organizations` non-array OR `total_results` non-number ⇒
 *          driftError. DETAIL `organization` non-object OR `filings_with_data`
 *          non-array ⇒ driftError (never a fabricated empty/total).
 *   [SSRF] fixed host `projects.propublica.org`; a post-construction hostname/
 *          protocol assert + `redirect:"error"`; the query VALUES ride
 *          URLSearchParams (incl. the `state[id]`/`ntee[id]` bracket keys);
 *          `ein` charclass `^\d{1,9}$` (path segment); `state` `^[A-Za-z]{2}$`;
 *          `ntee` an integer 1..10.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const NONPROFIT_HOST = "projects.propublica.org";
export type NonprofitOrgSummary = {
    ein: string | null;
    name: string | null;
    city: string | null;
    state: string | null;
    nteeCode: string | null;
    subsectionCode: string | null;
};
export type NonprofitOrganization = {
    ein: string | null;
    name: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    nteeCode: string | null;
    subsectionCode: string | null;
    rulingDate: string | null;
    statusCode: string | null;
};
export type NonprofitFiling = {
    taxYear: number | null;
    formType: string | null;
    revenueUsd: number | null;
    expensesUsd: number | null;
    assetsUsd: number | null;
    liabilitiesUsd: number | null;
    pdfUrl: string | null;
};
export type NonprofitSearchArgs = {
    query?: string;
    state?: string;
    ntee?: number;
    page?: number;
};
/**
 * Search US tax-exempt nonprofits (IRS Form 990) via ProPublica Nonprofit Explorer
 * (`/nonprofits/api/v2/search.json`) → curated org summaries + honest `_meta`.
 * KEYLESS. ★PROVENANCE: this is ProPublica (a non-profit newsroom) republishing
 * IRS Form 990 public records — NOT a .gov API. ★totalAvailable is the API's REAL
 * `total_results` — never organizations.length; page-based (0-indexed) pagination.
 */
export declare function search(args: NonprofitSearchArgs): Promise<MetaBundle>;
export type NonprofitFinancialsArgs = {
    ein: string;
};
/**
 * Fetch ONE nonprofit's IRS Form 990 profile + financials via ProPublica Nonprofit
 * Explorer (`/nonprofits/api/v2/organizations/{ein}.json`) → curated organization +
 * filings + honest `_meta`. KEYLESS. ★PROVENANCE: ProPublica (a non-profit newsroom)
 * republishing IRS Form 990 public records — NOT a .gov API. An unknown EIN (HTTP
 * 404) ⇒ not_found (never a fabricated empty org). The four Form 990 figures ride
 * num() (null-never-0). totalAvailable = filings.length (the COMPLETE set).
 */
export declare function financials(args: NonprofitFinancialsArgs): Promise<MetaBundle>;
//# sourceMappingURL=nonprofit.d.ts.map