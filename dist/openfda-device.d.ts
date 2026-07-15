/**
 * openfda-device.ts — openFDA 510(k) DEVICE CLEARANCES (api.fda.gov) — the
 * MEDICAL-DEVICE REGULATORY lane (ADR-0056). The FDA's premarket-notification
 * (510(k)) clearances: the applicant, the device, the clearance number (K-number),
 * the decision (date + description), the clearance type, the product code, the
 * advisory committee, and geography.
 *
 * ★ THIS IS THE SAME SOURCE + ENVELOPE + CRUX as openfda.ts (ADR-0054). Same host
 *   (api.fda.gov), same response envelope `{ meta:{ results:{ skip, limit, total }},
 *   results:[…] }`, same ★no-match→HTTP-404-NOT_FOUND-as-honest-empty crux, same
 *   optional query-key K-test, same fixed-host SSRF idiom, same structured-only
 *   (no raw Lucene passthrough) search assembly. It REUSES openfda.ts's `fetchOpenfda`
 *   (the SSRF-guarded classified fetch) and `readOpenfdaError` (the error-body reader)
 *   verbatim — the 404-reclassification logic is NOT reinvented — plus `luceneQuote`
 *   (the phrase-escape), `openfdaApiKey` (the optional-key env seam), and `OPENFDA_HOST`.
 *
 *   GET https://api.fda.gov/device/510k.json
 *       ?search=<lucene>&limit=<1..100>&skip=<offset>[&api_key=<KEY>]
 *   → { meta:{ disclaimer, results:{ skip, limit, total }}, results:[ {…} ] }
 *     (live total ~175507).
 *
 * ★ HONESTY (mirrors openfda.ts exactly):
 *   [P1]  totalAvailable = `meta.results.total` EXACT (e.g. 175507), NEVER
 *         results.length. skip/limit offset pagination:
 *         hasMore = skip + returned < total; nextOffset = hasMore ? skip+returned : null.
 *   [★P2] a 404 whose body is `{error:{code:"NOT_FOUND"}}` (a no-match query OR an
 *         unknown field) ⇒ HONEST EMPTY (returned:0, totalAvailable:0) — NOT thrown,
 *         NOT not_found. Any OTHER 4xx (e.g. a 400 syntax error) ⇒ invalid_input
 *         surfacing openFDA's message. 5xx/timeout ⇒ upstream_unavailable THROW. A
 *         200 non-JSON body ⇒ schema_drift. (Reuses openfda.ts's exact fetch path.)
 *   [P3]  dates (`decision_date`, YYYY-MM-DD) and every scalar surfaced as a STRING
 *         via `str` (null-never-empty-string) — no numeric coercion; never fabricated.
 *   [P4]  `meta.results` or `results` absent / non-array ⇒ driftError (never a
 *         fabricated empty).
 *   [K-test] OPTIONAL OPENFDA_API_KEY: when set it rides `&api_key=` ONLY (openFDA has
 *         no header option — the query-key is inherent). Mitigation: the `label` is
 *         host+path ONLY (`openfda:/device/510k`, NO query), so no token reaches
 *         ToolError.upstreamEndpoint; `_meta.source` names the MODE only; the key is
 *         ABSENT from the serialized {data,_meta}, notes, and any log. Unset ⇒ keyless.
 *   [SSRF] fixed host `api.fda.gov` (fetchOpenfda asserts hostname/protocol +
 *         redirect:"error"); all filter VALUES are Lucene-escaped + phrase-quoted and
 *         ride URLSearchParams `search=`; limit/skip are integers; state is charclass
 *         `^[A-Za-z]{2}$`. No raw Lucene passthrough — structured only, injection-safe.
 */
import { type MetaBundle } from "./meta.js";
export type OpenfdaClearance = {
    applicant: string | null;
    deviceName: string | null;
    kNumber: string | null;
    decisionDate: string | null;
    decisionDescription: string | null;
    clearanceType: string | null;
    productCode: string | null;
    advisoryCommittee: string | null;
    state: string | null;
};
/** The structured filter set → openFDA `field:value` clauses (510(k) fields). */
export type OpenfdaDeviceFilters = {
    applicant?: string;
    deviceName?: string;
    productCode?: string;
    clearanceType?: string;
    kNumber?: string;
    state?: string;
};
/**
 * Assemble the openFDA `search=` Lucene string from structured 510(k) filters — each
 * value Lucene-escaped + phrase-quoted (reusing openfda.ts's `luceneQuote`), joined by
 * ` AND `. Returns "" when no filter is present (openFDA then returns the whole
 * collection). The clause → field mapping is FIXED here; a caller can never inject a
 * raw field:value (no raw Lucene passthrough).
 */
export declare function buildDeviceSearch(f: OpenfdaDeviceFilters): string;
export type OpenfdaDeviceClearancesArgs = OpenfdaDeviceFilters & {
    limit?: number;
    skip?: number;
};
/**
 * Search openFDA 510(k) DEVICE CLEARANCES with structured filters → curated clearance
 * rows + honest `_meta`. KEYLESS (an OPTIONAL OPENFDA_API_KEY only raises the rate
 * limit). totalAvailable = meta.results.total (EXACT); skip/limit offset pagination.
 * ★A no-match query (openFDA HTTP 404 NOT_FOUND) ⇒ an honest empty, never a throw.
 */
export declare function deviceClearances(args: OpenfdaDeviceClearancesArgs): Promise<MetaBundle>;
//# sourceMappingURL=openfda-device.d.ts.map