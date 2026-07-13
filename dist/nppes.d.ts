/**
 * NPPES NPI Registry — CMS/HHS healthcare-provider identity/credentialing lane
 * (keyless). Source #27 on the R2 `getJson` port (ADR-0036).
 *
 * ONE tool `nppes_lookup_provider` over the CMS/HHS National Plan & Provider
 * Enumeration System (`https://npiregistry.cms.hhs.gov/api/?version=2.1`) — the
 * authoritative PUBLIC registry of every US healthcare provider (individual
 * NPI-1 + organization NPI-2). The B2G unlock: vet a healthcare
 * subcontractor/provider/org for a VA/HHS/CMS contract — validate an NPI,
 * confirm taxonomy (specialty), enumeration status (Active), practice state, and
 * org/name match for credentialing / teaming due-diligence.
 *
 * TWO modes, inferred from `number` (NO mode flag):
 *   - EXACT-NPI (`number` supplied): validate `^\d{10}$` + the CMS Luhn
 *     (Luhn over `80840` + the first 9 digits, 14 total) CLIENT-SIDE →
 *     `invalid_input` on failure (a typo must NEVER fake a not-found; NPPES
 *     validates ONLY length, so the Luhn pre-check is LOAD-BEARING). ★ M1: the
 *     outgoing query carries `number` (+`version`) as the SOLE param — a
 *     co-supplied filter is NEVER forwarded (NPPES AND-combines a number with
 *     filters, so `number=<active NPI>&last_name=Zztypo` → result_count:0, a
 *     FALSE "does not exist"). Co-filters are dropped from the wire and surfaced
 *     as a CLIENT-SIDE post-match annotation (`data.filterMatch`).
 *   - SEARCH: by first_name / last_name / organization_name /
 *     taxonomy_description / city / postal_code (REQUIRED-one set), refined by
 *     state / enumeration_type (REFINERS — never sufficient alone, S2),
 *     paginated (limit ≤ 200, skip ≤ 1000 — our POLICY reach cap, S3).
 *
 * HONESTY (writes ZERO fetch/coerce/error/meta code — REUSES getJson/throughGate/
 * driftError + coerce.num/str + withMeta/buildMeta):
 *   P1 result_count === results.length (else driftError); NPPES exposes NO
 *      grand-total field → totalAvailable is a LOWER BOUND on a full page
 *      (totalIsLowerBound) + the ≤200/≤1000 policy caps disclosed.
 *   P2 `^\d{10}$` + CMS-Luhn → invalid_input (typo never fakes not-found); a
 *      genuine {result_count:0} → honest found:false; a {Errors:[…]} 200 body
 *      (NO results key — the NSF serviceNotification twin) → THROW; any
 *      4xx/5xx/timeout/off-host-redirect/non-JSON → THROW.
 *   P3 active = basic.status === "A" (deactivated/absent ⇒ NOT active); epochs
 *      (created_epoch/last_updated_epoch, ms numeric STRINGS) via coerce.num
 *      (null-never-0).
 *   P4 no silent filter drop (per-mode filtersApplied/filtersDropped; the M1
 *      exact-mode drop disclosed via filterMatch + a note).
 *
 * SSRF (the NSF fixed-host idiom, COPIED not imported): host + path + version are
 * compile-time CONSTANTS; every caller input rides in a MODULE-BUILT
 * URLSearchParams assembled key-by-key from validated typed args (NO raw-query
 * passthrough) + a post-construction hostname/protocol assert + redirect:"error".
 *
 * PII boundary (S3): NPPES public professional-registration data is IN-SCOPE per
 * the shipped NSF-PI-name precedent (src/nsf.ts surfaces PI names/emails),
 * bounded to a per-query targeted lookup (the ≤1,200 reach is a courtesy cap;
 * cross-query enumeration is NOT architecturally prevented, matching NSF). The
 * mandatory not-a-fitness/cross-check-SAM+OFAC caveat rides EVERY response.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const NPPES_STATES: readonly ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "AS", "GU", "MP", "PR", "VI"];
export type NppesState = (typeof NPPES_STATES)[number];
/**
 * ★ S3 — the mandatory not-a-fitness-determination caveat carried in EVERY
 * response (mirrors OFAC_NOT_DETERMINATION_NOTE). Kept verbatim so the fault
 * suite can assert it. It discloses (1) not a determination + cross-check SAM/OFAC;
 * (2) individual (NPI-1) records may surface personal/home addresses + phone/fax
 * verbatim, with NO enrichment or cross-source join.
 */
export declare const NPPES_NOT_DETERMINATION_NOTE = "Public professional-registration data (CMS NPPES NPI Registry). Confirms enumeration / identity / taxonomy only \u2014 it is NOT a fitness, exclusion, licensure, or sanctions determination. Cross-check SAM exclusions + OFAC for debarment/sanctions and the state licensing board for licensure. Individual (NPI-1) records may include personal / home practice or mailing addresses plus telephone/fax surfaced VERBATIM from the public registry; this tool performs NO enrichment and NO cross-source join on them.";
/** ★ S3 — the per-query reach-cap POLICY disclosure carried on EVERY response. */
export declare const NPPES_REACH_CAP_NOTE = "This vetting tool reaches at most the first ~1,200 matches per query (limit \u2264 200, skip \u2264 1,000) as a deliberate targeted-lookup boundary \u2014 NPPES itself no longer enforces a skip ceiling. This is a PER-QUERY cap only; cross-query enumeration (iterating name/city/postal filters) is NOT architecturally prevented (inherent to any search API), matching the NSF precedent. Narrow your filters (name + state + taxonomy) for a complete, targeted result set rather than paging deeper.";
export type NppesAddress = {
    purpose: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    telephone: string | null;
    fax: string | null;
    countryCode: string | null;
    countryName: string | null;
    addressType: string | null;
};
export type NppesTaxonomy = {
    code: string | null;
    desc: string | null;
    primary: boolean | null;
    state: string | null;
    license: string | null;
    taxonomyGroup: string | null;
};
export type NppesProvider = {
    number: string | null;
    enumerationType: string | null;
    active: boolean;
    status: string | null;
    basic: {
        firstName: string | null;
        lastName: string | null;
        middleName: string | null;
        namePrefix: string | null;
        nameSuffix: string | null;
        credential: string | null;
        sex: string | null;
        soleProprietor: string | null;
        organizationName: string | null;
        organizationalSubpart: string | null;
        authorizedOfficialFirstName: string | null;
        authorizedOfficialLastName: string | null;
        authorizedOfficialMiddleName: string | null;
        authorizedOfficialTitleOrPosition: string | null;
        authorizedOfficialTelephoneNumber: string | null;
        status: string | null;
        enumerationDate: string | null;
        certificationDate: string | null;
        lastUpdated: string | null;
    };
    taxonomies: NppesTaxonomy[];
    addresses: NppesAddress[];
    /** ★ S1 — additional practice sites, surfaced as their own array (a provider
     *  can practice in a state that appears ONLY here). NEVER merged into addresses[]. */
    practiceLocations: NppesAddress[];
    identifiers: unknown[];
    otherNames: unknown[];
    endpoints: unknown[];
    createdEpoch: number | null;
    lastUpdatedEpoch: number | null;
};
/**
 * Validate the CMS NPI check digit: the Luhn algorithm over `80840` + the first 9
 * NPI digits (14 digits total, ISO/IEC 7812) must reproduce the 10th NPI digit.
 * `npi` MUST already be `^\d{10}$`. A Luhn-FAILING 10-digit string is provably
 * NOT a valid NPI ⇒ invalid_input (a typo must NOT read as found:false).
 */
export declare function cmsLuhnValid(npi: string): boolean;
export type NppesLookupArgs = {
    number?: string;
    enumeration_type?: string;
    first_name?: string;
    last_name?: string;
    organization_name?: string;
    taxonomy_description?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    limit?: number;
    skip?: number;
};
/**
 * `nppes_lookup_provider` — keyless NPPES NPI Registry lookup. Mode inferred from
 * `number`: EXACT-NPI detail (Luhn-validated, number-only wire, M1 co-filter
 * annotation) OR a filtered SEARCH (required-one gate + refiners, S2; ≤200/≤1000
 * pagination policy caps, S3). NEVER fakes a not-found: a typo'd NPI ⇒
 * invalid_input; a {Errors} body ⇒ THROW; a genuine {result_count:0} ⇒ honest
 * found:false / empty. The not-a-fitness caveat + reach-cap policy ride EVERY
 * response.
 */
export declare function lookupProvider(args: NppesLookupArgs): Promise<MetaBundle<unknown>>;
//# sourceMappingURL=nppes.d.ts.map