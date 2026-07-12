/**
 * US Census Bureau Geocoder — keyless source #22 (ADR-0023). A NEW capability
 * domain: TERRITORY / GEOSPATIAL — resolve a one-line address (or a lon/lat point)
 * to its Census GEOGRAPHIES (State, County, Congressional District, Census Tract,
 * Census Block, Incorporated Place, CBSA/CSA, State Legislative Districts). This is
 * the geographic backbone of set-aside / place-of-performance analysis: a bidder
 * needs a location's congressional district + census tract to reason about HUBZone
 * / Opportunity-Zone eligibility and to file/verify a contract's place-of-performance.
 *
 * The GET source on the R2 `DataSource` port: census.ts writes ZERO fetch/coercion/
 * error/meta code — it REUSES `getJson` / `driftError` / `num`·`str` / `withMeta`,
 * and COPIES (does NOT import) the ECHO fixed-host SSRF idiom. Fully PUBLIC, KEYLESS
 * (byte-clean init — NO headers, NO UA; live-verified 2026-07-12).
 *
 *   Address → geographies:  https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress
 *                           ?address=…&benchmark=…&vintage=…&format=json
 *                           → { result:{ input, addressMatches:[ { matchedAddress,
 *                                coordinates:{x,y}, tigerLine, addressComponents,
 *                                geographies:{ …layer keys… } } ] } }
 *   Point   → geographies:  https://geocoding.geo.census.gov/geocoder/geographies/coordinates
 *                           ?x=<lon>&y=<lat>&benchmark=…&vintage=…&format=json
 *                           → { result:{ input:{ location:{x,y}, … }, geographies:{ … } } }
 *                             (NO addressMatches wrapper — a point resolves to ONE geography set)
 *
 * ★ SSRF GUARD (policy① — a verbatim copy of the ECHO fixed-host shape):
 *   (1) SINGLE fixed host constant `CENSUS_GEO_HOST` — the caller NEVER supplies a host.
 *   (2) TWO fixed endpoint-path constants (a frozen Set) — the caller NEVER supplies a
 *       path fragment; there is NO id interpolated into the path (both endpoints are
 *       query-param-only), so there is no path-segment-injection surface at all. A path
 *       outside the Set ⇒ invalid_input before any fetch.
 *   (3) `address`/`x`/`y`/`benchmark`/`vintage`/`format` ride in a module-built
 *       URLSearchParams (encoded VALUES — an embedded &/=/?/# inside `address` stays
 *       inside the value, never touching the host/path). `benchmark`/`vintage` are
 *       enum-whitelisted; `x`/`y` are re-guarded finite-in-range and sent as String().
 *       `format=json` is ALWAYS module-set (never a caller arg).
 *   (4) Construct the URL, then ASSERT `new URL(built).hostname === CENSUS_GEO_HOST`
 *       and `protocol === "https:"` ⇒ invalid_input on mismatch (belt-and-suspenders).
 *   (5) `redirect:"error"` on every getJson — a 3xx off geocoding.geo.census.gov throws;
 *       its body is never read.
 *
 * ★ HONESTY (load-bearing — 02-truthful-outputs-spec §2.1; ADR-0023 v2 AUTHORITATIVE):
 *   [B1] The layer mapper resolves each canonical layer by a SUFFIX pattern on the
 *        layer-key (never a literal versioned key — the key names ROLL: "119th
 *        Congressional Districts", "2020 Census Blocks", "2024 State Legislative
 *        Districts - Upper"). It handles >1 KEY PER SUFFIX: a historical vintage
 *        (live-verified `Census2010_Current`) returns TWO `/Congressional Districts$/`
 *        keys (113th=GEOID 0102 AND 111th=GEOID 0103 for Montgomery AL — a redistricted
 *        location with DISTINCT district GEOIDs). Single-pick-and-drop would present one
 *        as THE district and hide the other — a data-lie by omission. So when >1 key
 *        matches: pick deterministically (highest leading session/year number), surface
 *        EVERY matched layerKey (the chosen object + an `alternates[]`), AND emit a
 *        MANDATORY `_meta` note naming the N keys + the chosen one. NEVER silently drop.
 *   [M1] The drift-guard is scoped to the FOUR always-present sentinel layers only —
 *        States, Counties, Census Tracts, Congressional Districts. driftError fires ONLY
 *        when a sentinel matches ZERO keys while `geographies` is a NON-EMPTY object.
 *        Optional/vintage-dependent layers (Census Blocks, SLD-Upper/Lower, CBSA/CSA)
 *        → honest `null` on absence (live-verified: ACS2023_Current omits Census Blocks;
 *        DC omits SLD-Lower — LEGITIMATE absences, NOT drift).
 *   [M2] The vintage enum is the UNION of live-valid vintages across the four shipped
 *        benchmarks (25 distinct — enumerated via /benchmarks + /vintages 2026-07-12),
 *        so a VALID non-default pair (e.g. Public_AR_Census2020 + Census2020_Census2020,
 *        live 200) is NOT Zod-rejected. An INVALID (benchmark,vintage) pair LOUD-fails
 *        at HTTP 400 (the module relies on that backstop) and the tool DISCLOSES that
 *        vintage must be benchmark-compatible.
 *   • Genuine-empty is HTTP-200 and is NEVER thrown; a 400/500/outage is NEVER read as
 *     empty. Address: `addressMatches:[]` ⇒ matches:[], matchCount:0, complete:true.
 *     Coordinates: `geographies:{}` ⇒ all layers null, matchCount:0, complete:true. An
 *     invalid/missing benchmark/vintage or a non-numeric coord ⇒ HTTP 400 ⇒ getJson
 *     THROWS invalid_input; a 5xx/timeout ⇒ THROWS upstream_unavailable.
 *   • Multi-match (addressMatches.length > 1, live-forced: "100 Main St, Springfield"
 *     → 7 matches with DISTINCT state/CD geographies) ⇒ surface ALL matches (each with
 *     its own matchedAddress + geographies) + matchCount + a mandatory note.
 *   • The RESOLVED benchmark/vintage is echoed in EVERY response (data.vintageResolved
 *     from result.input.{benchmark.benchmarkName, vintage.vintageName}) + a mandatory
 *     "Current is a MOVING vintage" note.
 *   • GEOIDs are `str` (null-never-empty-string). Leading zeros are REAL and MUST
 *     survive: State "01", County "01101", Tract "01101000200", CD "0102" — `num()`
 *     would corrupt "01"→1, so a GEOID is NEVER num-coerced.
 *   • The KILLER caveat, in EVERY response: Census geographies are a NOMINAL input, NOT
 *     an authoritative HUBZone / Opportunity-Zone / set-aside determination.
 *   • No fabricated pagination/cursor — both tools are single-shot lookups.
 *
 * ★ `tokenizeForDisclosure` (src/disclosure.ts, C110) is DELIBERATELY N/A: the geocoder
 *   is a STRUCTURED address PARSER, not an Essie whitespace-AND/OR keyword search. A
 *   multi-word `address` is EXPECTED and is not tokenized into a co-occurrence trap — an
 *   under-specified address returns a clean genuine-empty (live-verified), not a silent
 *   broaden. There is NO upstream token-drop to disclose, so this module builds NO
 *   whitespace-split disclosure note (the lint-invariants disclosure check stays green).
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const CENSUS_BENCHMARKS: readonly ["Public_AR_Current", "Public_AR_ACS2025", "Public_AR_LUCA", "Public_AR_Census2020"];
export type CensusBenchmark = (typeof CENSUS_BENCHMARKS)[number];
export declare const CENSUS_VINTAGES: readonly ["Current_Current", "Census2010_Current", "ACS2017_Current", "ACS2018_Current", "ACS2019_Current", "Census2020_Current", "ACS2021_Current", "ACS2022_Current", "ACS2023_Current", "ACS2024_Current", "ACS2025_Current", "LUCA_Current", "Current_ACS2025", "Census2010_ACS2025", "ACS2017_ACS2025", "ACS2018_ACS2025", "ACS2019_ACS2025", "Census2020_ACS2025", "ACS2021_ACS2025", "ACS2022_ACS2025", "ACS2023_ACS2025", "ACS2024_ACS2025", "ACS2025_ACS2025", "Census2020_Census2020", "Census2010_Census2020"];
export type CensusVintage = (typeof CENSUS_VINTAGES)[number];
/**
 * GET one Census geocoder endpoint. SSRF guard: `path` ∈ the frozen 2-member Set
 * (the path-injection guard), params via a module-built URLSearchParams (encoded
 * values, no host-alteration surface), `format=json` ALWAYS module-set, then the
 * CONSTRUCTED URL's hostname === CENSUS_GEO_HOST (https) assertion. Sets
 * `redirect:"error"`; NO headers (keyless — byte-clean init). Reuses errors.ts
 * retry/timeout/taxonomy (429 → rate_limited; 5xx → upstream_unavailable; 404 →
 * not_found; 400 → invalid_input — the P6–P10 400s become the thrown error, NEVER a
 * fake-empty). Returns the parsed JSON (unknown; the caller validates the envelope).
 */
export declare function censusGet(path: string, params: URLSearchParams): Promise<unknown>;
export type GeoLayer = {
    layerKey: string;
    geoid: string | null;
    name: string | null;
};
export type GeoLayerField = (GeoLayer & {
    alternates?: GeoLayer[];
}) | null;
export type CensusGeographies = {
    state: GeoLayerField;
    county: GeoLayerField;
    congressionalDistrict: GeoLayerField;
    censusTract: GeoLayerField;
    censusBlock: GeoLayerField;
    place: GeoLayerField;
    cbsaOrCsa: GeoLayerField;
    stateLegislativeUpper: GeoLayerField;
    stateLegislativeLower: GeoLayerField;
};
/**
 * Map a `geographies` object to the STABLE canonical set by SUFFIX pattern, handling
 * >1 key per suffix ([B1]) and the sentinel drift-guard ([M1]). Returns the mapped
 * geographies + any multi-key `_meta` notes. `label` scopes the driftError;
 * `vintageName` names the vintage in the multi-key note.
 */
export declare function mapGeographies(geographies: Record<string, unknown>, label: string, vintageName: string | null): {
    geo: CensusGeographies;
    notes: string[];
};
export type AddressMatch = {
    matchedAddress: string | null;
    coordinates: {
        x: number | null;
        y: number | null;
    };
    tigerLineId: string | null;
    addressComponents: {
        street: string | null;
        city: string | null;
        state: string | null;
        zip: string | null;
    };
    geographies: CensusGeographies;
};
/**
 * Resolve a one-line US address → its matched address(es) + the Census geographies
 * that drive set-aside / place-of-performance analysis (congressional district,
 * census tract, county, state, block). Handles the addressMatches ARRAY (the
 * multi-match "which location" honesty surface — every match carries its own
 * matchedAddress + geographies). Disclose-not-refuse: an unmatched address is NOT an
 * error (matches:[], matchCount:0, complete:true + a note).
 */
export declare function geocodeAddress(args: {
    address: string;
    benchmark?: string;
    vintage?: string;
}): Promise<MetaBundle>;
/**
 * Resolve a longitude/latitude point → the Census geographies at that point (no
 * address parsing). For a caller that already holds coordinates. `x`/`longitude`
 * (required) and `y`/`latitude` (required) are aliases; the handler coalesces + re-
 * guards them finite-in-range (belt-and-suspenders behind Zod — a non-finite value ⇒
 * invalid_input PRE-fetch, 0 fetch, mirroring the LOUD 400 of a non-numeric coord but
 * caught locally). A point outside any US Census geography ⇒ geographies:{} ⇒ all
 * layers null, matchCount:0, complete:true + a note (NOT an error).
 */
export declare function geographiesByCoordinates(args: {
    x?: number;
    y?: number;
    longitude?: number;
    latitude?: number;
    benchmark?: string;
    vintage?: string;
}): Promise<MetaBundle>;
//# sourceMappingURL=census.d.ts.map