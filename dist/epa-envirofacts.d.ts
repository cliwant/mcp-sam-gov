/**
 * epa-envirofacts.ts — EPA Envirofacts RESTful data service (`data.epa.gov`,
 * `/efservice`), the `tri_facility` table (ADR-0059). KEYLESS.
 *
 * WHAT IT ADDS: `epa_tri_facilities` — a location/compliance lane: look up EPA
 * Toxics Release Inventory (TRI) reporting facilities by state / facility-name /
 * county. This is the demand-side environmental-footprint complement to the
 * market-sizing (Census CBP) and macro (FRED) sources — a place-of-performance
 * environmental screen for a given geography.
 *
 * ★THE TWO-REQUEST PATTERN (the load-bearing P1 honesty): the efservice REST API
 *   embeds filters as PATH SEGMENTS and reports NO total in the data slice. So the
 *   EXACT total comes from a SEPARATE count sub-query — the identical filter path
 *   with a `/count/JSON` tail returns `[{"TOTALQUERYRESULTS": 1247}]`. This tool
 *   runs the count FIRST (best-effort) then the data slice: totalAvailable =
 *   TOTALQUERYRESULTS (P1, EXACT), NEVER the returned rows' length. If the count
 *   sub-query fails or is absent, totalAvailable falls to null + a disclosing note
 *   (never a length-faked total) and the data slice still returns.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error") / `driftError` (datasource.ts), `str`/`num` (coerce.ts,
 * null-never-empty-string / null-never-0), and `withMeta`·`buildMeta` (meta.ts,
 * offset pagination + totalAvailable). It MIRRORS census-economic.ts's
 * fixed-host SSRF idiom (a single host const + a post-construction hostname/
 * protocol assertion + redirect:"error") and datagov-catalog.ts's schema_drift
 * catch-ladder (ToolErrorCarrier rethrow FIRST so a 5xx keeps its taxonomy →
 * SyntaxError→driftError → bare rethrow).
 *
 *   GET https://data.epa.gov/efservice/tri_facility/state_abbr/{ST}
 *       [/facility_name/CONTAINING/{NAME}] [/county_name/CONTAINING/{COUNTY}]
 *       /count/JSON               → [{ "TOTALQUERYRESULTS": <int> }]  (the total)
 *   GET …same filter path… /rows/{offset}:{offset+limit-1}/JSON
 *       → [{ tri_facility_id, facility_name, street_address, city_name,
 *            county_name, state_abbr, zip_code, region, fac_closed_ind, … }, …]
 *
 * ★ SSRF (the load-bearing guard — values ride as PATH SEGMENTS, not query params):
 *   the host is a compile-time literal (`EPA_HOST`); the table + column names + the
 *   `CONTAINING` operator + `rows`/`count`/`JSON` are all MODULE literals. Every
 *   USER value is BOTH charclass-validated (state `^[A-Za-z]{2}$`; facilityName/
 *   county letters/digits/space/&/-/. only, rejecting `/` and `..` path-traversal)
 *   AND `encodeURIComponent`-encoded before it joins the path. `offset`/`limit` are
 *   coerced to non-negative integers. A post-construction hostname/protocol
 *   assertion + `redirect:"error"` fail closed on any off-host 3xx.
 *
 * ★ HONESTY (ADR-0059 P1–P5, live-verified 2026-07-15 on data.epa.gov):
 *   [input] require at least `state` OR `facilityName` — an all-empty query is
 *           REFUSED with invalid_input (0 fetch) so the whole national table is
 *           never scanned.
 *   [P1]    totalAvailable = the count sub-query's TOTALQUERYRESULTS (EXACT — e.g.
 *           VA = 1247), NOT the slice length. hasMore = offset+returned < total.
 *           Count fails/absent ⇒ totalAvailable:null + a disclosing note.
 *   [P2]    an empty array ⇒ honest empty (returned:0, complete:true). getJson maps
 *           a 4xx/5xx via errorFromResponse and THROWS (503 ⇒ upstream_unavailable,
 *           400 ⇒ invalid_input, 404 ⇒ not_found); a 200 non-array/non-JSON body ⇒
 *           schema_drift (NEVER a fabricated empty).
 *   [P3]    fac_closed_ind ("0"/"1" live; "N"/"Y" per the schema) ⇒ a normalized
 *           boolean `closed` — an UNRECOGNIZED value ⇒ null (never a fabricated
 *           false). Addresses/names are strings via `str` (null-never-empty-string).
 *   [P4]    a data body that is not an array ⇒ driftError; a count body missing
 *           TOTALQUERYRESULTS ⇒ totalAvailable:null (handled, not a crash).
 */
import { str, num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num, str };
export type TriFacility = {
    triFacilityId: string | null;
    facilityName: string | null;
    streetAddress: string | null;
    city: string | null;
    county: string | null;
    state: string | null;
    zip: string | null;
    region: string | null;
    closed: boolean | null;
};
/**
 * Normalize EPA's fac_closed_ind to a boolean. Live values are "0" (active) / "1"
 * (closed); the schema also documents "N"/"Y". Anything else ⇒ null (unknown) —
 * NEVER a fabricated false (P3).
 */
export declare function normalizeClosed(v: unknown): boolean | null;
export type EpaTriFacilitiesArgs = {
    state?: string;
    facilityName?: string;
    county?: string;
    limit?: number;
    offset?: number;
};
/**
 * Look up EPA TRI reporting facilities by state / facilityName / county →
 * normalized facility rows + honest `_meta`. Requires at least `state` OR
 * `facilityName` (an all-empty query is refused). Runs a count sub-query FIRST for
 * the EXACT total (P1), then the data slice; a count failure degrades to
 * totalAvailable:null + a note (never a length-faked total).
 */
export declare function triFacilities(args: EpaTriFacilitiesArgs): Promise<MetaBundle>;
//# sourceMappingURL=epa-envirofacts.d.ts.map