/**
 * cms-facility.ts — CMS "facility directory" across FOUR provider-data datasets
 * (`data.cms.gov`, the provider-data DKAN datastore-query API; ADR-0063). KEYLESS.
 *
 * WHAT IT ADDS: `cms_facility_directory` — a healthcare-facility directory / market
 * lane that generalizes cms_hospital_compare (ADR-0062) BEYOND hospitals: a caller
 * picks a `facilityType` (nursing_home | home_health | hospice | dialysis) and the
 * tool routes to the RIGHT CMS provider-data dataset, returning each facility's
 * name / address / city / state / zip / ownership. The facility-level complement to
 * the utilization and hospital lanes — WHERE these Medicare-certified facilities are.
 *
 * ★THE facilityType → DATASET-ID CONSTANT MAP (the load-bearing SSRF guard): the
 *   USER value never enters the URL path. `facilityType` is a Zod ENUM; it indexes a
 *   MODULE-CONSTANT map to a VETTED dataset id (e.g. nursing_home → "4pq5-n9py") that
 *   is spliced into the path. An unknown facilityType is blocked by the enum
 *   (invalid_input) BEFORE any fetch — only one of four compile-time ids can ever
 *   reach the path.
 *
 * ★THE ONE-REQUEST COUNT PATTERN (P1 honesty, inherited from cms-hospital): the DKAN
 *   datastore-query response is `{ count, results, schema, query }` — `count` is the
 *   EXACT per-filter total in the SAME body as the rows. So totalAvailable = the
 *   response's top-level `count` (nursing_home ⇒ 14695), NEVER `results.length`.
 *
 * ★FIELD-NAME VARIANCE ACROSS DATASETS (the one genuinely-new complexity vs.
 *   cms-hospital) — live-verified 2026-07-15. The facility NAME, ADDRESS, and
 *   OWNERSHIP columns are NAMED DIFFERENTLY per dataset, so each is COALESCED over a
 *   fixed candidate order (null if none present — NEVER an empty string, NEVER
 *   fabricated):
 *     name      : provider_name → facility_name → legal_business_name
 *     address   : address → provider_address → address_line_1
 *     ownership : ownership_type → type_of_ownership → profit_or_nonprofit
 *   (city = citytown, state = state, zip = zip_code are uniform across all four.)
 *   Per-dataset verified columns:
 *     nursing_home 4pq5-n9py: provider_name / provider_address / ownership_type
 *     home_health  6jpm-sxkc: provider_name / address          / type_of_ownership
 *     hospice      yc9t-dgbk: facility_name / address_line_1    / ownership_type
 *     dialysis     23ew-n7w9: facility_name / address_line_1    / profit_or_nonprofit
 *   ★ADR-0063 said nursing_home's address is `address`; it is actually
 *    `provider_address` (probed live) — the coalescing candidate list covers it.
 *
 * ★THE facilityName FILTER COLUMN also varies: the `contains` filter targets the
 *   dataset's OWN primary-name column (provider_name for nursing_home/home_health,
 *   facility_name for hospice/dialysis) — stored per-type in the constant map.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error") / `driftError` (datasource.ts), `str` (coerce.ts,
 * null-never-empty-string), and `withMeta`·`buildMeta` (meta.ts, offset pagination
 * + totalAvailable). It MIRRORS cms-hospital.ts's fixed-host SSRF idiom (a single
 * host const + a post-construction hostname/protocol assertion + redirect:"error" +
 * `conditions[i][…]` bracket keys and values carried via URLSearchParams) and its
 * schema_drift catch-ladder (ToolErrorCarrier rethrow FIRST → SyntaxError→driftError
 * → bare rethrow).
 *
 *   GET https://data.cms.gov/provider-data/api/1/datastore/query/{datasetId}/0
 *       ?limit=&offset=&conditions[0][property]=state&conditions[0][value]=VA&conditions[0][operator]==
 *       → { count: 383, results: [ { provider_name, provider_address, … }, … ], schema, query }
 *
 * ★ SSRF: the host is a compile-time literal (`CMS_HOST`); the dataset id is chosen
 *   by a Zod-enum key from a MODULE-CONSTANT map (never the user string). Every USER
 *   filter VALUE rides as a URLSearchParams VALUE (`conditions[i][value]=…`) — the
 *   bracket key AND the value are encoded, so a value can never break out of the
 *   path or inject a parameter. state is `^[A-Za-z]{2}$`; facilityName is a bounded
 *   free-text charclass; size/offset are coerced to integers. A post-construction
 *   hostname/protocol assertion + `redirect:"error"` fail closed on any off-host 3xx.
 *
 * ★ HONESTY (ADR-0063 P1–P5, live-verified 2026-07-15 on data.cms.gov):
 *   [P1] totalAvailable = the response's top-level `count` (EXACT per-filter total),
 *        NOT the slice length. hasMore = offset+returned < count.
 *   [P2] results:[] ⇒ honest empty (returned:0). An invalid facilityType is blocked
 *        by the Zod enum (invalid_input). getJson maps a 4xx/5xx via
 *        errorFromResponse and THROWS (503 ⇒ upstream_unavailable, 400 ⇒
 *        invalid_input, 404 ⇒ not_found); a 200 non-JSON body OR a body missing
 *        `count`/`results` ⇒ schema_drift (NEVER a fabricated empty).
 *   [P3] name/address/ownership are COALESCED over the candidate order — null if none
 *        (NEVER an empty string, NEVER fabricated). String fields via str().
 *   [P4] results non-array OR count non-number ⇒ driftError.
 */
import { str } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { str };
type FacilityType = "nursing_home" | "home_health" | "hospice" | "dialysis";
export type Facility = {
    name: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    facilityType: FacilityType;
    ownership: string | null;
};
/**
 * Coalesce a row's value over a candidate column order → string | null.
 * Returns the FIRST column whose str() is non-null (str nulls ""/whitespace/"null");
 * null if NONE — NEVER an empty string, NEVER a fabricated value (P3).
 */
export declare function coalesceField(row: Record<string, unknown>, fields: string[]): string | null;
export type CmsFacilityDirectoryArgs = {
    facilityType?: string;
    state?: string;
    facilityName?: string;
    size?: number;
    offset?: number;
};
/**
 * Fetch CMS provider-data facility rows for a `facilityType` (+ optional state /
 * facility-name fragment) → normalized facility rows + honest `_meta`. The
 * facilityType (a Zod enum) indexes the FACILITY_DATASETS constant map to a vetted
 * dataset id — the user value never enters the path. A SINGLE request: the response's
 * top-level `count` is the EXACT per-filter total (P1 — never the slice length).
 */
export declare function facilityDirectory(args: CmsFacilityDirectoryArgs): Promise<MetaBundle>;
//# sourceMappingURL=cms-facility.d.ts.map