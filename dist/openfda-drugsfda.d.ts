/**
 * openfda-drugsfda.ts — openFDA DRUG APPROVALS (Drugs@FDA, api.fda.gov) — the
 * PHARMA REGULATORY-APPROVAL lane. FDA-approved drug applications (NDA/ANDA/BLA):
 * the sponsor, the application number, each approved product (brand/generic name,
 * dosage form, route, marketing status), and the submission/approval history.
 * Answers "what drugs did sponsor X get approved, and which are still marketed" —
 * pharma vendor product/approval intelligence.
 *
 * ★ SAME SOURCE + ENVELOPE + CRUX as openfda.ts / openfda-device.ts (ADR-0054/0056).
 *   Same host (api.fda.gov), same envelope `{ meta:{ results:{ skip,limit,total }},
 *   results:[…] }`, same ★no-match→HTTP-404-NOT_FOUND-as-honest-empty crux, same
 *   optional query-key K-test, same fixed-host SSRF idiom, same structured-only (no
 *   raw Lucene passthrough) search. REUSES openfda.ts's `fetchOpenfda`,
 *   `readOpenfdaError`, `luceneQuote`, `openfdaApiKey`, `OPENFDA_HOST` verbatim.
 *
 *   GET https://api.fda.gov/drug/drugsfda.json?search=<lucene>&limit=&skip=[&api_key=]
 *   → { meta:{ results:{ skip,limit,total }}, results:[ { application_number,
 *       sponsor_name, products:[…], submissions:[…] } ] }.
 *
 * ★ HONESTY (mirrors the siblings exactly): [P1] totalAvailable = meta.results.total
 *   EXACT (never results.length); skip/limit offset pagination. [★P2] 404 NOT_FOUND
 *   ⇒ honest empty (never thrown); other 4xx ⇒ invalid_input surfacing openFDA's
 *   message; 5xx/429 ⇒ THROW. [P3] every scalar via `str` (null-never-""); nested
 *   products/submissions arrays default to [] and each field is str (never fabricated).
 *   [P4] meta.results / results absent-or-mis-shaped ⇒ driftError. [K-test] the
 *   OPTIONAL OPENFDA_API_KEY rides ONLY &api_key=; label/source name mode only.
 *   [SSRF] fixed host; all VALUES Lucene-escaped + phrase-quoted via URLSearchParams.
 */
import { type MetaBundle } from "./meta.js";
export type DrugsfdaProduct = {
    brandName: string | null;
    genericIngredients: {
        name: string | null;
        strength: string | null;
    }[];
    dosageForm: string | null;
    route: string | null;
    marketingStatus: string | null;
};
export type DrugsfdaSubmission = {
    submissionType: string | null;
    submissionNumber: string | null;
    submissionStatus: string | null;
    submissionStatusDate: string | null;
    submissionClass: string | null;
};
export type DrugsfdaApplication = {
    applicationNumber: string | null;
    sponsorName: string | null;
    products: DrugsfdaProduct[];
    submissions: DrugsfdaSubmission[];
};
export type DrugsfdaFilters = {
    sponsorName?: string;
    brandName?: string;
    activeIngredient?: string;
    applicationNumber?: string;
};
export declare function buildDrugsfdaSearch(f: DrugsfdaFilters): string;
export type DrugApprovalsArgs = DrugsfdaFilters & {
    limit?: number;
    skip?: number;
};
/**
 * Search openFDA Drugs@FDA drug-approval applications with structured filters →
 * curated application rows (sponsor, application number, approved products, submission
 * history) + honest `_meta`. KEYLESS (OPTIONAL OPENFDA_API_KEY only raises the rate
 * limit). totalAvailable = meta.results.total (EXACT); skip/limit pagination. A
 * no-match query (openFDA HTTP 404 NOT_FOUND) ⇒ an honest empty, never a throw.
 */
export declare function drugApprovals(args: DrugApprovalsArgs): Promise<MetaBundle>;
//# sourceMappingURL=openfda-drugsfda.d.ts.map