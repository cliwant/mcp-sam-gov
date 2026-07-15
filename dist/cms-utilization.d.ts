/**
 * cms-utilization.ts — CMS Medicare Physician & Other Practitioners "by Provider
 * and Service" utilization (`data.cms.gov`, the data-API v1 dataset endpoint;
 * ADR-0061). KEYLESS.
 *
 * WHAT IT ADDS: `cms_medicare_provider_services` — a healthcare-market /
 * competitor-utilization lane: for a given provider (NPI) or state, what Medicare
 * Part-B services (HCPCS) did providers render, to how many beneficiaries, at what
 * submitted / Medicare-allowed / Medicare-paid amounts. The demand-side complement
 * to NPPES (who the providers ARE) — this is what they actually BILL.
 *
 * ★THE TWO-REQUEST PATTERN (the load-bearing P1 honesty — MIRRORS epa-envirofacts):
 *   the data-API's `/data` slice is a bare JSON array that reports NO total. So the
 *   EXACT total for a filter comes from a SEPARATE count sub-query — the identical
 *   `filter[...]` on the `/data-viewer/stats` endpoint returns
 *   `{ "data": { "found_rows": N, "total_rows": M } }`. This tool runs the stats
 *   count FIRST (best-effort) then the data slice: totalAvailable = found_rows (P1,
 *   the per-filter EXACT total), NEVER the returned rows' length. If the stats
 *   sub-query fails or is absent, totalAvailable falls to null + a disclosing note
 *   (never a length-faked total) and the data slice still returns.
 *
 * ★THE FILTER-REQUIRED INPUT GUARD: the table is 9.78M rows. An all-empty query
 *   (no npi, no state) is REFUSED with invalid_input (0 fetch) — providerType /
 *   hcpcsCode alone are NOT enough to scope; a caller MUST pin npi OR state.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error") / `driftError` (datasource.ts), `str`/`num` (coerce.ts,
 * null-never-empty-string / null-never-0), and `withMeta`·`buildMeta` (meta.ts,
 * offset pagination + totalAvailable). It MIRRORS census-economic.ts's fixed-host
 * SSRF idiom (a single host const + a post-construction hostname/protocol assertion
 * + redirect:"error") and epa-envirofacts.ts's count-first two-request pattern +
 * schema_drift catch-ladder (ToolErrorCarrier rethrow FIRST so a 5xx keeps its
 * taxonomy → SyntaxError→driftError → bare rethrow).
 *
 *   GET https://data.cms.gov/data-api/v1/dataset/{uuid}/data-viewer/stats
 *       ?filter[Rndrng_Prvdr_State_Abrvtn]=VA          (the COUNT sub-query)
 *       → { "data": { "found_rows": 278254, "total_rows": 9781673 } }
 *   GET https://data.cms.gov/data-api/v1/dataset/{uuid}/data
 *       ?size=&offset=&filter[Rndrng_Prvdr_State_Abrvtn]=VA     (the DATA slice)
 *       → [ { Rndrng_NPI, Rndrng_Prvdr_Last_Org_Name, …, Avg_Mdcr_Pymt_Amt }, … ]
 *
 * ★ SSRF: the host is a compile-time literal (`CMS_HOST`); the dataset UUID + the
 *   endpoint paths are MODULE literals. Every USER filter value rides as a
 *   URLSearchParams VALUE (`filter[Col]=Val`) — URLSearchParams encodes the bracket
 *   key AND the value, so a value can never break out into the path or inject a
 *   parameter. npi is `^\d{10}$`; state `^[A-Za-z]{2}$`; hcpcsCode `^[A-Za-z0-9]{1,10}$`;
 *   providerType is a bounded free-text charclass; size/offset are coerced to
 *   integers. A post-construction hostname/protocol assertion + `redirect:"error"`
 *   fail closed on any off-host 3xx.
 *
 * ★ PII NOTE: this is public PROVIDER-level AGGREGATE data — no patient identifiers.
 *   Provider name / practice address / NPI is public professional information (the
 *   same public surface as NPPES), so it is fine to surface.
 *
 * ★ HONESTY (ADR-0061 P1–P5, live-verified 2026-07-15 on data.cms.gov):
 *   [input] require npi OR state — an all-empty query is REFUSED (0 fetch) so the
 *           whole 9.78M-row table is never scanned.
 *   [P1]    totalAvailable = the stats sub-query's found_rows (EXACT — e.g. VA =
 *           278254), NOT the slice length. hasMore = offset+returned < total. Stats
 *           fails/absent ⇒ totalAvailable:null + a disclosing note.
 *   [P2]    an empty array ⇒ honest empty (returned:0). getJson maps a 4xx/5xx via
 *           errorFromResponse and THROWS (503 ⇒ upstream_unavailable, 400 ⇒
 *           invalid_input, 404 ⇒ not_found); a 200 non-array/non-JSON body ⇒
 *           schema_drift (NEVER a fabricated empty).
 *   [P3]    Tot_ / Avg_ fields via num() (numeric strings → numbers; a real 0 stays 0;
 *           absent ⇒ null, never 0-faked); NPI/codes/HCPCS/names as strings
 *           (null-never-empty-string).
 *   [P4]    a data body that is not an array ⇒ driftError; a stats body missing
 *           found_rows ⇒ totalAvailable:null (handled, not a crash).
 */
import { str, num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num, str };
export type ProviderService = {
    npi: string | null;
    providerName: string | null;
    credentials: string | null;
    providerType: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    hcpcsCode: string | null;
    hcpcsDescription: string | null;
    totalBeneficiaries: number | null;
    totalServices: number | null;
    avgSubmittedCharge: number | null;
    avgMedicareAllowed: number | null;
    avgMedicarePayment: number | null;
};
/**
 * Join the CMS Last_Org_Name + First_Name into one display name. An ORGANIZATION
 * row (entity code "O") carries the org name in Last_Org_Name with an empty
 * First_Name ⇒ just the org name. An INDIVIDUAL carries both ⇒ "Last, First".
 * Either absent ⇒ the present one; both absent ⇒ null (never a fabricated "").
 */
export declare function joinProviderName(lastOrg: unknown, first: unknown): string | null;
export type CmsMedicareProviderServicesArgs = {
    npi?: string;
    state?: string;
    providerType?: string;
    hcpcsCode?: string;
    size?: number;
    offset?: number;
};
/**
 * Fetch Medicare Part-B provider-service utilization rows for an NPI / state (+
 * optional providerType / hcpcsCode) → normalized service rows + honest `_meta`.
 * REQUIRES npi OR state (an all-empty query is refused). Runs a stats count
 * sub-query FIRST for the EXACT total (P1), then the data slice; a count failure
 * degrades to totalAvailable:null + a note (never a length-faked total).
 */
export declare function providerServices(args: CmsMedicareProviderServicesArgs): Promise<MetaBundle>;
//# sourceMappingURL=cms-utilization.d.ts.map