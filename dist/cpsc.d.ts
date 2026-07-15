/**
 * cpsc.ts — CPSC CONSUMER-PRODUCT RECALLS (www.saferproducts.gov) — the consumer
 * goods / import product-safety vetting lane (ADR-0058). ONE keyless tool:
 *   • cpsc_recalls — /RestWebServices/Recall?format=json + date/product/manufacturer/
 *     recallNumber filters.
 * The third leg of the cross-agency product-safety family alongside NHTSA (vehicles)
 * and openFDA (medical/food): a manufacturer / product / hazard recall history for
 * B2G supplier and import vetting.
 *
 * ★ KEYLESS — there is NO API key at all (no parameter, no header). This module
 *   touches NO key seam (no KEY_REGISTRY / keys.ts / API_KEYS.md). It REUSES the
 *   shared `getJson` (redirect:"error") / `driftError` fetch envelope, the `str`
 *   coercion (null-never-empty-string), and `withMeta`/`buildMeta` — and mirrors
 *   nhtsa.ts / datagov-catalog.ts's fixed-host SSRF idiom + schema_drift
 *   catch-ladder verbatim.
 *
 * ★ THE HONESTY PILLARS (P1-P5, live-verified 2026-07-15):
 *   P1: the /Recall response is a BARE JSON ARRAY with NO count field and NO server
 *       pagination — it returns the COMPLETE set matching the filter. So
 *       totalAvailable = results.length and complete:true, WITH a disclosing note
 *       that CPSC reports no total-count field / no pagination. A total is NEVER
 *       fabricated (there is no upstream total to trust; the honest total is the
 *       length of the complete set).
 *   P2: an empty array `[]` ⇒ an HONEST EMPTY (returned:0, complete:true) — a filter
 *       that matches nothing is an honest no-match, NOT an error. A 4xx ⇒
 *       invalid_input; a 5xx/timeout ⇒ THROW (never a fake empty); a 200 non-JSON
 *       body OR a non-array body ⇒ schema_drift (never a fabricated empty).
 *   P3: dates stay STRINGS (via `str`); NumberOfUnits is free text ("About 6,500")
 *       kept as a STRING; nested arrays (Products/Manufacturers/Retailers/Hazards/
 *       Remedies/Injuries/ManufacturerCountries) are flattened to string arrays by
 *       extracting each object's `.Name` (★ManufacturerCountries uses `.Country`,
 *       NOT `.Name`), SKIPPING an empty `{}` object (never a fabricated entry); a
 *       genuinely-absent nested array ⇒ []; null-never-empty-string throughout.
 *   P4: the top-level body MUST be an array — a non-array (object/string/null) ⇒
 *       driftError (a broken response contract, never a fabricated empty).
 *   DEFAULT-WINDOW: with NO filter given, the unfiltered result is huge, so the tool
 *       defaults RecallDateStart to ~90 days ago and DISCLOSES the default in a note
 *       — it NEVER silently fetches the whole dataset.
 *   SSRF: fixed host `www.saferproducts.gov` (compile-time literal) + post-construction
 *       hostname/protocol assertion + redirect:"error"; every filter rides a
 *       module-built URLSearchParams (no raw passthrough); dates are ^\d{4}-\d{2}-\d{2}$;
 *       recallNumber is charclass-validated (letters/digits/hyphen only), so a
 *       `../` or `%` can never reach the fixed path.
 */
import { type MetaBundle } from "./meta.js";
export declare const CPSC_HOST = "www.saferproducts.gov";
export declare const CPSC_DATE_RE: RegExp;
export declare const CPSC_RECALL_NUMBER_RE: RegExp;
export type CpscRecall = {
    recallNumber: string | null;
    recallDate: string | null;
    title: string | null;
    description: string | null;
    url: string | null;
    products: string[];
    numberOfUnits: string | null;
    manufacturers: string[];
    retailers: string[];
    hazards: string[];
    remedies: string[];
    injuries: string[];
    manufacturerCountries: string[];
};
export type CpscRecallsArgs = {
    dateStart?: string;
    dateEnd?: string;
    productName?: string;
    manufacturer?: string;
    recallNumber?: string;
};
/**
 * Fetch CPSC consumer-product RECALLS → curated recall rows + honest `_meta`.
 * KEYLESS. All filters are optional; with NO filter given, RecallDateStart defaults
 * to ~90 days ago (disclosed in a note) so the whole dataset is never silently
 * fetched. The response is a bare array with no total-count field / no pagination
 * ⇒ totalAvailable = the number of returned recalls, complete:true. An empty array
 * ⇒ an honest empty; a 4xx ⇒ invalid_input; a 5xx/timeout ⇒ THROW; a 200 non-JSON
 * OR a non-array body ⇒ schema_drift.
 */
export declare function recalls(args: CpscRecallsArgs): Promise<MetaBundle>;
//# sourceMappingURL=cpsc.d.ts.map