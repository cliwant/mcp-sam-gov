/**
 * cms-supplier.ts — two CMS supplier/vetting lanes on `data.cms.gov` (the SAME
 * data-API v1 dataset endpoint + the SAME two-request stats-count pattern as
 * cms-utilization.ts / ADR-0061; ADR-0064). KEYLESS.
 *
 * WHAT IT ADDS
 *   1. `cms_dmepos_suppliers` — CMS "Medicare Durable Medical Equipment,
 *      Devices & Supplies by Supplier": for a given supplier (NPI) or state, the
 *      DMEPOS supplier's identity + aggregate Medicare figures (HCPCS codes,
 *      beneficiaries, claims, services, submitted / Medicare-allowed / -paid
 *      amounts). A supplier-market / competitor-utilization lane on the SUPPLY
 *      side (who bills Medicare for equipment).
 *   2. `cms_revoked_providers` — CMS "Revoked Medicare Providers & Suppliers":
 *      the legally-published debarment / revocation list (7,059 rows), with the
 *      revoked provider's identity, provider type, revocation reason, effective
 *      date, and re-enrollment-bar expiration. A vetting / due-diligence lane in
 *      the SAME class as the OFAC / SAM-exclusions lists already shipped —
 *      surfacing the names IS the point (this is a public exclusion list).
 *
 * ★THE TWO-REQUEST PATTERN (the load-bearing P1 honesty — MIRRORS cms-utilization):
 *   the data-API's `/data` slice is a bare JSON array that reports NO total. So the
 *   EXACT total for a filter comes from a SEPARATE count sub-query — the identical
 *   `filter[...]` on the `/data-viewer/stats` endpoint returns
 *   `{ "data": { "found_rows": N, "total_rows": M } }`. Each tool runs the stats
 *   count FIRST (best-effort) then the data slice: totalAvailable = found_rows (P1,
 *   the per-filter EXACT total), NEVER the returned rows' length. If the stats
 *   sub-query fails or is absent, totalAvailable falls to null + a disclosing note
 *   (never a length-faked total) and the data slice still returns.
 *
 * ★THE FILTER-REQUIRED INPUT GUARD (dmepos only): the supplier table is large; an
 *   all-empty query (no npi, no state) is REFUSED with invalid_input (0 fetch) — a
 *   caller MUST pin npi OR state. The revocation list is only ~7K rows, so it is
 *   safe to page unfiltered (all its filters are optional).
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error") / `driftError` (datasource.ts), `str`/`num` (coerce.ts,
 * null-never-empty-string / null-never-0), and `withMeta`·`buildMeta` (meta.ts).
 * It MIRRORS cms-utilization.ts's fixed-host SSRF idiom (a single host const + a
 * post-construction hostname/protocol assertion + redirect:"error") and its
 * count-first two-request pattern + schema_drift catch-ladder.
 *
 * ★ SSRF: the host is a compile-time literal (`CMS_HOST`); the dataset UUIDs + the
 *   endpoint paths are MODULE literals. Every USER filter value rides as a
 *   URLSearchParams VALUE (`filter[Col]=Val`) — URLSearchParams encodes the bracket
 *   key AND the value, so a value can never break out into the path or inject a
 *   parameter. npi is `^\d{10}$`; state `^[A-Za-z]{2}$`; lastName is a bounded
 *   free-text charclass; size/offset are coerced to integers. A post-construction
 *   hostname/protocol assertion + `redirect:"error"` fail closed on any off-host 3xx.
 *
 * ★ HONESTY (ADR-0064 P1–P5, live-verified 2026-07-15 on data.cms.gov):
 *   [P1] totalAvailable = the stats sub-query's found_rows (EXACT), NOT the slice
 *        length. hasMore = offset+returned < total. Stats fails/absent ⇒
 *        totalAvailable:null + a disclosing note (never length-faked).
 *   [P2] empty array ⇒ honest empty (returned:0). dmepos all-empty input ⇒
 *        invalid_input (0 fetch). getJson maps a 4xx (⇒ invalid_input / not_found)
 *        / 5xx (⇒ upstream_unavailable) and THROWS; a 200 non-array/non-JSON body ⇒
 *        schema_drift (NEVER a fabricated empty).
 *   [P3] aggregates via num() (numeric strings → numbers; a real 0 stays 0; absent
 *        ⇒ null, never 0-faked); NPI / codes / reasons / dates as strings
 *        (null-never-empty-string); a coalesced name ⇒ null if none.
 *   [P4] a data body that is not an array ⇒ driftError; a stats body missing
 *        found_rows ⇒ totalAvailable:null (handled, not a crash).
 */
import { str, num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num, str };
/**
 * Join the CMS Last_Name_Org + First_Name into one display name. An ORGANIZATION
 * supplier (entity code "O") carries the org name in Last_Name_Org with an empty
 * First_Name ⇒ just the org name. An INDIVIDUAL carries both ⇒ "Last, First".
 * Either absent ⇒ the present one; both absent ⇒ null (never a fabricated "").
 */
export declare function joinSupplierName(lastOrg: unknown, first: unknown): string | null;
export type DmeposSupplier = {
    npi: string | null;
    supplierName: string | null;
    credentials: string | null;
    entityType: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    totalHcpcsCodes: number | null;
    totalBeneficiaries: number | null;
    totalClaims: number | null;
    totalServices: number | null;
    submittedCharges: number | null;
    medicareAllowed: number | null;
    medicarePayment: number | null;
};
export type CmsDmeposSuppliersArgs = {
    npi?: string;
    state?: string;
    size?: number;
    offset?: number;
};
/**
 * Fetch DMEPOS supplier rows for an NPI / state → normalized supplier rows +
 * honest `_meta`. REQUIRES npi OR state (an all-empty query is refused). Runs a
 * stats count sub-query FIRST for the EXACT total (P1), then the data slice; a count
 * failure degrades to totalAvailable:null + a note (never a length-faked total).
 */
export declare function dmeposSuppliers(args: CmsDmeposSuppliersArgs): Promise<MetaBundle>;
/**
 * Coalesce the revoked-provider display name: an ORGANIZATION carries ORG_NAME ⇒
 * use it. An INDIVIDUAL carries FIRST_NAME + LAST_NAME ⇒ "First Last" (either
 * present alone ⇒ that one). None present ⇒ null (never a fabricated "").
 */
export declare function coalesceRevokedName(org: unknown, first: unknown, last: unknown): string | null;
export type RevokedProvider = {
    enrollmentId: string | null;
    npi: string | null;
    name: string | null;
    state: string | null;
    providerType: string | null;
    revocationReason: string | null;
    revocationEffectiveDate: string | null;
    reenrollmentBarExpiration: string | null;
};
export type CmsRevokedProvidersArgs = {
    npi?: string;
    state?: string;
    lastName?: string;
    size?: number;
    offset?: number;
};
/**
 * Fetch CMS revocation-list rows (all filters optional — the ~7K-row list is safe
 * to page unfiltered) → normalized revocation rows + honest `_meta`. Runs a stats
 * count sub-query FIRST for the EXACT total (P1), then the data slice; a count
 * failure degrades to totalAvailable:null + a note (never a length-faked total).
 */
export declare function revokedProviders(args: CmsRevokedProvidersArgs): Promise<MetaBundle>;
//# sourceMappingURL=cms-supplier.d.ts.map