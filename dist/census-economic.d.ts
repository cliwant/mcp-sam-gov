/**
 * US Census — County Business Patterns (CBP) — the MARKET-SIZING lane
 * (ADR-0047, Wave-4 source #1). NAICS × geography establishments / employment /
 * annual payroll — the demand-side complement to BLS-QCEW + USAspending in the
 * B2G market-sizing set.
 *
 * ★ THIS IS THE SERVER'S FIRST KEY-REQUIRED SOURCE. The Census Data API removed
 *   its keyless tier — a request WITHOUT a key is 302-redirected to a "Missing
 *   Key" HTML page. So, honestly: with NO `CENSUS_API_KEY` this tool THROWS an
 *   `invalid_input` config error BEFORE any fetch (never a fake-empty, never a
 *   keyless-pretend). The other 111 tools stay keyless — this key is scoped to
 *   this one source. (Contrast the OPTIONAL keys of datagov/bls/nvd, which lift a
 *   tier but are not required.)
 *
 * DIFFERENT HOST than census.ts (the geocoder, geocoding.geo.census.gov): the
 * DATA API is `api.census.gov/data/{year}/cbp`. This module COPIES (does NOT
 * import) the census.ts fixed-host SSRF idiom (a single host const + a
 * post-construction `new URL().hostname` assertion + `redirect:"error"`) and does
 * NOT touch census_geocode.
 *
 * Zero fetch/coercion/error/meta code of its own: it REUSES `getJson`
 * (+ redirect:"error"), `driftError`, `num` (coerce.ts, null-never-0),
 * `withMeta`/`buildMeta`. The optional-key leak discipline is MIRRORED from
 * datagatekey.ts/bls.ts — but here the key is REQUIRED and rides ONLY in the
 * `&key=` query param, NOWHERE else (never the label, `_meta.source`, notes, or a
 * log — the K-test).
 *
 *   GET https://api.census.gov/data/{year}/cbp
 *       ?get=NAME,NAICS2017_LABEL,ESTAB,EMP,PAYANN,GEO_ID
 *       &for=<geoClause>            (us:* | state:* | state:NN | county:*)
 *       &in=state:NN                (county queries only)
 *       &NAICS2017=<naics>          (optional NAICS filter)
 *       &key=<CENSUS_API_KEY>       (REQUIRED)
 *   → a 2D JSON ARRAY: row 0 = column headers, rows 1..N = data. e.g.
 *     [["NAME","ESTAB","EMP","PAYANN","NAICS2017","NAICS2017_LABEL","state"],
 *      ["California","39755","...","...","5415","...","06"], ...]
 *
 * ★ HONESTY (ADR-0047 P1–P5):
 *   [KEY]  no key ⇒ invalid_input THROW pre-fetch (0 fetch); the message names
 *          CENSUS_API_KEY + the free-signup URL. A 302 at the wire (missing/invalid
 *          key redirected to the Missing-Key page) ⇒ reclassified to invalid_input
 *          "check CENSUS_API_KEY" (never a fake-empty).
 *   [P1]   CBP returns the COMPLETE geography set for the filter (no server
 *          pagination) ⇒ totalAvailable = the row count, complete:true. NEVER
 *          fabricated (RED if totalAvailable = header-length or invented).
 *   [P3]   ★the sentinel→null crux: Census suppresses/withholds cells with large
 *          NEGATIVE sentinels (-999999999 / -888888888 / -666666666 …). `censusNum`
 *          maps any value ≤ -100000000 to **null** (withheld) — NEVER a negative
 *          number, NEVER 0. A genuine 0 stays 0. `annualPayrollUsd = PAYANN×1000`
 *          (PAYANN is in $1,000 units), null-preserving.
 *   [P2]   a 302 ⇒ invalid_input (key); a header-only body ⇒ honest empty
 *          (returned:0, complete:true); a 5xx ⇒ upstream_unavailable THROW; a 200
 *          non-JSON ⇒ schema_drift.
 *   [P4]   a body that is not an array, or whose row 0 is not a string[] header
 *          row ⇒ driftError (never a fabricated empty).
 *   [SSRF] fixed host; `year` re-guarded ^\d{4}$ (it rides in the PATH); `naics`
 *          ^\d{2,6}$; `state` ^\d{2}$; geography enum {us,state,county}. All
 *          predicate VALUES ride in URLSearchParams. The key rides `&key=` ONLY.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
/** Read CENSUS_API_KEY from env; trim; return the value or undefined (unset/blank). */
export declare function censusApiKey(): string | undefined;
export type CbpRow = {
    name: string | null;
    geoId: string | null;
    naicsCode: string | null;
    naicsLabel: string | null;
    establishments: number | null;
    employees: number | null;
    annualPayrollUsd: number | null;
    state: string | null;
};
export type CensusBusinessPatternsArgs = {
    naics?: string;
    geography?: string;
    state?: string;
    year?: string;
    limit?: number;
};
/**
 * Fetch County Business Patterns rows for a NAICS × geography filter → normalized
 * establishment / employment / annual-payroll rows + honest `_meta`. REQUIRES
 * CENSUS_API_KEY (throws invalid_input pre-fetch when unset). The 2D-array body is
 * parsed by HEADER NAME (order-independent); suppressed cells map to null.
 */
export declare function businessPatterns(args: CensusBusinessPatternsArgs): Promise<MetaBundle>;
//# sourceMappingURL=census-economic.d.ts.map