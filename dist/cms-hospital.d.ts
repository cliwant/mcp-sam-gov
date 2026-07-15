/**
 * cms-hospital.ts — CMS Hospital Compare "Hospital General Information"
 * (`data.cms.gov`, the provider-data DKAN datastore-query API; ADR-0062). KEYLESS.
 *
 * WHAT IT ADDS: `cms_hospital_compare` — a healthcare-facility directory / market
 * lane: for a US state (and/or a facility-name fragment) list Medicare-certified
 * hospitals with their location, type, ownership, emergency-services flag, and CMS
 * star rating. The facility-level complement to the utilization lane
 * (cms_medicare_provider_services, who BILLS) — this is WHERE the hospitals ARE and
 * HOW CMS rates them.
 *
 * ★THE ONE-REQUEST COUNT PATTERN (the load-bearing P1 honesty — SIMPLER than
 *   cms-utilization's two-request stats-count): the DKAN datastore-query response
 *   is `{ count, results, schema, query }` — `count` is the EXACT per-filter total
 *   in the SAME body as the rows. So totalAvailable = the response's top-level
 *   `count` (VA ⇒ 96), NEVER `results.length`. A single request; no separate count
 *   sub-query is needed (or possible — the endpoint reports the total inline).
 *
 * ★THE FILTER-REQUIRED INPUT GUARD: the dataset is 5432 hospitals. An all-empty
 *   query (no state, no facilityName) is REFUSED with invalid_input (0 fetch) —
 *   hospitalType alone is NOT enough to scope; a caller MUST pin state OR
 *   facilityName.
 *
 * ★THE DKAN CONDITIONS FILTER (live-verified 2026-07-15): filters ride as
 *   `conditions[i][property]` / `conditions[i][value]` / `conditions[i][operator]`
 *   query triples, AND-combined server-side. `state` uses the exact operator `=`
 *   (VA ⇒ 96); `facilityName` + `hospitalType` use the `contains` operator (a
 *   case-insensitive substring match, live-verified — "CHILDREN" ⇒ 95). ALL
 *   filtering is server-side; NOTHING is silently dropped or client-faked.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error") / `driftError` (datasource.ts), `str`/`num` (coerce.ts,
 * null-never-empty-string / null-never-0), and `withMeta`·`buildMeta` (meta.ts,
 * offset pagination + totalAvailable). It MIRRORS cms-utilization.ts's fixed-host
 * SSRF idiom (a single host const + a post-construction hostname/protocol assertion
 * + redirect:"error" + `conditions[i][…]` bracket keys and values carried via
 * URLSearchParams) and its schema_drift catch-ladder (ToolErrorCarrier rethrow
 * FIRST so a 5xx keeps its taxonomy → SyntaxError→driftError → bare rethrow).
 *
 *   GET https://data.cms.gov/provider-data/api/1/datastore/query/{datasetId}/0
 *       ?limit=&offset=&conditions[0][property]=state&conditions[0][value]=VA&conditions[0][operator]==
 *       → { count: 96, results: [ { facility_id, facility_name, … }, … ], schema, query }
 *
 * ★ SSRF: the host is a compile-time literal (`CMS_HOST`); the dataset id + the
 *   endpoint path are MODULE literals. Every USER filter VALUE rides as a
 *   URLSearchParams VALUE (`conditions[i][value]=…`) — URLSearchParams encodes the
 *   bracket key AND the value, so a value can never break out into the path or
 *   inject a parameter. state is `^[A-Za-z]{2}$`; facilityName/hospitalType are a
 *   bounded free-text charclass; size/offset are coerced to integers. A
 *   post-construction hostname/protocol assertion + `redirect:"error"` fail closed
 *   on any off-host 3xx.
 *
 * ★ HONESTY (ADR-0062 P1–P5, live-verified 2026-07-15 on data.cms.gov):
 *   [input] require state OR facilityName — an all-empty query is REFUSED (0 fetch).
 *   [P1]    totalAvailable = the response's top-level `count` (EXACT — VA = 96), NOT
 *           the slice length. hasMore = offset+returned < count.
 *   [P2]    results:[] ⇒ honest empty (returned:0). getJson maps a 4xx/5xx via
 *           errorFromResponse and THROWS (503 ⇒ upstream_unavailable, 400 ⇒
 *           invalid_input, 404 ⇒ not_found); a 200 non-JSON/non-array body OR a body
 *           missing `count`/`results` ⇒ schema_drift (NEVER a fabricated empty).
 *   [P3]    hospital_overall_rating "1"–"5" via num(); "Not Available"/""/non-numeric
 *           ⇒ null (NEVER 0 — a data-absence-as-zero masquerade is the forbidden
 *           class). emergency_services "Yes"⇒true / "No"⇒false / else null. String
 *           fields via str() (null-never-empty-string).
 *   [P4]    results non-array OR count non-number ⇒ driftError.
 */
import { str, num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num, str };
export type Hospital = {
    facilityId: string | null;
    facilityName: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    county: string | null;
    phone: string | null;
    hospitalType: string | null;
    ownership: string | null;
    emergencyServices: boolean | null;
    overallRating: number | null;
};
/**
 * Normalize the CMS `emergency_services` "Yes"/"No" flag → boolean | null.
 * "Yes"⇒true, "No"⇒false (case-insensitive); anything else (absent/""/unrecognized)
 * ⇒ null — NEVER a fabricated false (a data-absence-as-false masquerade).
 */
export declare function emergencyBool(x: unknown): boolean | null;
export type CmsHospitalCompareArgs = {
    state?: string;
    facilityName?: string;
    hospitalType?: string;
    size?: number;
    offset?: number;
};
/**
 * Fetch CMS Hospital Compare "Hospital General Information" rows for a state and/or
 * facility-name fragment (+ optional hospitalType) → normalized hospital rows +
 * honest `_meta`. REQUIRES state OR facilityName (an all-empty query is refused). A
 * SINGLE request: the response's top-level `count` is the EXACT per-filter total
 * (P1 — never the slice length).
 */
export declare function hospitalCompare(args: CmsHospitalCompareArgs): Promise<MetaBundle>;
//# sourceMappingURL=cms-hospital.d.ts.map