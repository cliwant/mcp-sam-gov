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

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME `num`
// from this module (census.num === coerce.num === echo.num === …). NO local num/str.
export { num };

// ─── SSRF core: the single fixed host + two fixed endpoint paths ──
const CENSUS_GEO_HOST = "geocoding.geo.census.gov";
const CENSUS_GEO_BASE = `https://${CENSUS_GEO_HOST}/geocoder`;

// The ONLY two endpoint paths we ever build (frozen constants — the caller never
// supplies a path fragment; NO id is interpolated into the path). A path outside this
// Set ⇒ invalid_input (the path-injection guard — mirror ECHO_SERVICES).
const PATH_ONELINE = "/geographies/onelineaddress"; // address → addressMatches[].geographies
const PATH_COORDINATES = "/geographies/coordinates"; // lon/lat → geographies
const CENSUS_PATHS: ReadonlySet<string> = new Set([
  PATH_ONELINE,
  PATH_COORDINATES,
]);

// ─── Frozen enums (the Zod source of truth + in-handler re-guard) ──
// Live-enumerated via /benchmarks (2026-07-12): 4 benchmarks.
export const CENSUS_BENCHMARKS = [
  "Public_AR_Current",
  "Public_AR_ACS2025",
  "Public_AR_LUCA",
  "Public_AR_Census2020",
] as const;
export type CensusBenchmark = (typeof CENSUS_BENCHMARKS)[number];

// [M2] The UNION of live-valid vintages across ALL four benchmarks (live-enumerated
// via /vintages?benchmark=<b> 2026-07-12 — 25 distinct). The valid vintage set is a
// (benchmark, vintage) MATRIX, so this enum is intentionally the UNION: it must NOT
// reject a VALID non-default pair (e.g. Census2020_Census2020, live 200). An INVALID
// pair fails-closed at HTTP 400 (the module relies on the LOUD 400 backstop).
export const CENSUS_VINTAGES = [
  // Public_AR_Current (11)
  "Current_Current",
  "Census2010_Current",
  "ACS2017_Current",
  "ACS2018_Current",
  "ACS2019_Current",
  "Census2020_Current",
  "ACS2021_Current",
  "ACS2022_Current",
  "ACS2023_Current",
  "ACS2024_Current",
  "ACS2025_Current",
  // Public_AR_LUCA (1)
  "LUCA_Current",
  // Public_AR_ACS2025 (11)
  "Current_ACS2025",
  "Census2010_ACS2025",
  "ACS2017_ACS2025",
  "ACS2018_ACS2025",
  "ACS2019_ACS2025",
  "Census2020_ACS2025",
  "ACS2021_ACS2025",
  "ACS2022_ACS2025",
  "ACS2023_ACS2025",
  "ACS2024_ACS2025",
  "ACS2025_ACS2025",
  // Public_AR_Census2020 (2)
  "Census2020_Census2020",
  "Census2010_Census2020",
] as const;
export type CensusVintage = (typeof CENSUS_VINTAGES)[number];

const DEFAULT_BENCHMARK: CensusBenchmark = "Public_AR_Current";
const DEFAULT_VINTAGE: CensusVintage = "Current_Current";

// ─── Notes (honesty disclosures — ADR-0023 required set) ──────────
// The KILLER caveat — in EVERY response (§Honesty #4).
const HUBZONE_OZ_CAVEAT =
  "Census geographies are a NOMINAL input, NOT an authoritative HUBZone / Opportunity-Zone / set-aside determination. censusTract.geoid is the tract-level identifier used to look up Opportunity-Zone status (Treasury's designated-OZ-tract list), and county/censusTract are inputs to a HUBZone determination (SBA's HUBZone map / qualified-tract & qualified-county lists) — but an authoritative eligibility finding requires those SBA/Treasury sources, not this geocoder.";
const BENCHMARK_VINTAGE_NOTE =
  "vintage must be COMPATIBLE with the chosen benchmark (the valid vintage set is a (benchmark, vintage) matrix); an incompatible pair fails-closed with an HTTP 400 (invalid_input), never a silent mis-resolution.";
const GEOID_STRING_NOTE =
  "GEOIDs are STRINGS with real leading zeros (State '01', County '01101', Tract '01101000200', CD '0102') — they are never numeric (a leading zero must survive); a missing value is null, never an empty string.";

// ─── fetch layer (SSRF-guarded; reuses the R2 getJson port) ───────
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
export async function censusGet(
  path: string,
  params: URLSearchParams,
): Promise<unknown> {
  if (!CENSUS_PATHS.has(path)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Census geocoder path ${JSON.stringify(path)} is not one of the two fixed endpoint paths (${PATH_ONELINE} / ${PATH_COORDINATES}) — refusing to fetch (SSRF path guard).`,
      retryable: false,
    });
  }
  // `format=json` is ALWAYS module-set — never a caller arg (structural guarantee).
  params.set("format", "json");
  const url = `${CENSUS_GEO_BASE}${path}?${params.toString()}`;
  // Belt-and-suspenders: the FIXED host + FIXED path leave nothing to steer the
  // authority; assert the built URL cannot have been moved off-host.
  const built = new URL(url);
  if (built.hostname !== CENSUS_GEO_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed Census URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${CENSUS_GEO_HOST} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
    });
  }
  // Shared fetch envelope: keyless ⇒ NO headers key (byte-clean init); redirect:"error";
  // the label surfaces as ToolError.upstreamEndpoint — host+path only, no token.
  return getJson(url, { label: "census:" + path, redirect: "error" });
}

// ─── The vintage-versioned layer mapper (the §Honesty #2 / [B1] core) ──
export type GeoLayer = {
  layerKey: string; // the RAW upstream key (carries the session/vintage prefix)
  geoid: string | null;
  name: string | null;
};
// A canonical layer field: the chosen object, with `alternates[]` present ONLY when
// >1 upstream key matched the suffix (the multi-key [B1] surface — never a drop).
export type GeoLayerField = (GeoLayer & { alternates?: GeoLayer[] }) | null;

export type CensusGeographies = {
  state: GeoLayerField; // /^States$/                    — GEOID 2-digit  (sentinel)
  county: GeoLayerField; // /^Counties$/                  — GEOID 5-digit  (sentinel; HUBZone county input)
  congressionalDistrict: GeoLayerField; // /Congressional Districts$/ — layerKey carries the SESSION (sentinel; PoP CD)
  censusTract: GeoLayerField; // /Census Tracts$/              — GEOID 11-digit (sentinel; OZ / HUBZone-tract KEY)
  censusBlock: GeoLayerField; // /Census Blocks$/              — GEOID 15-digit (optional)
  place: GeoLayerField; // /Incorporated Places$/        — (optional)
  cbsaOrCsa: GeoLayerField; // /Statistical Areas?$/         — metro/market context (optional)
  stateLegislativeUpper: GeoLayerField; // /State Legislative Districts - Upper$/ (optional)
  stateLegislativeLower: GeoLayerField; // /State Legislative Districts - Lower$/ (optional; absent for DC — honest null)
};

type LayerSpec = {
  field: keyof CensusGeographies;
  re: RegExp;
  label: string;
  sentinel: boolean; // [M1] one of the four always-present drift sentinels
};

// The canonical layer specs, resolved by SUFFIX PATTERN (never a literal versioned
// key). Order = the emitted field order. The FOUR sentinels ([M1]) are marked.
const LAYER_SPECS: readonly LayerSpec[] = [
  { field: "state", re: /^States$/, label: "States", sentinel: true },
  { field: "county", re: /^Counties$/, label: "Counties", sentinel: true },
  {
    field: "congressionalDistrict",
    re: /Congressional Districts$/,
    label: "Congressional Districts",
    sentinel: true,
  },
  {
    field: "censusTract",
    re: /Census Tracts$/,
    label: "Census Tracts",
    sentinel: true,
  },
  {
    field: "censusBlock",
    re: /Census Blocks$/,
    label: "Census Blocks",
    sentinel: false,
  },
  {
    field: "place",
    re: /Incorporated Places$/,
    label: "Incorporated Places",
    sentinel: false,
  },
  {
    field: "cbsaOrCsa",
    re: /Statistical Areas?$/,
    label: "Statistical Areas (CBSA/CSA)",
    sentinel: false,
  },
  {
    field: "stateLegislativeUpper",
    re: /State Legislative Districts - Upper$/,
    label: "State Legislative Districts - Upper",
    sentinel: false,
  },
  {
    field: "stateLegislativeLower",
    re: /State Legislative Districts - Lower$/,
    label: "State Legislative Districts - Lower",
    sentinel: false,
  },
];

/** The leading integer of a layer key ("113th …" → 113, "2012 …" → 2012), else -1. */
function leadingNumber(key: string): number {
  const m = /^(\d+)/.exec(key.trim());
  return m ? Number(m[1]) : -1;
}

/** Build a GeoLayer from a raw layer key + its first entry (GEOID/NAME are str). */
function toGeoLayer(
  layerKey: string,
  entry: Record<string, unknown>,
): GeoLayer {
  return {
    layerKey,
    geoid: str(entry.GEOID), // NEVER num — leading zeros must survive ("01" ≠ 1)
    name: str(entry.NAME),
  };
}

/**
 * Map a `geographies` object to the STABLE canonical set by SUFFIX pattern, handling
 * >1 key per suffix ([B1]) and the sentinel drift-guard ([M1]). Returns the mapped
 * geographies + any multi-key `_meta` notes. `label` scopes the driftError;
 * `vintageName` names the vintage in the multi-key note.
 */
export function mapGeographies(
  geographies: Record<string, unknown>,
  label: string,
  vintageName: string | null,
): { geo: CensusGeographies; notes: string[] } {
  const allKeys = Object.keys(geographies);
  const nonEmpty = allKeys.length > 0;
  const geo = {} as CensusGeographies;
  const notes: string[] = [];

  for (const spec of LAYER_SPECS) {
    // ALL keys matching this suffix that carry a usable (non-empty array) value.
    const matched = allKeys.filter((k) => {
      if (!spec.re.test(k)) return false;
      const v = geographies[k];
      return Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null;
    });

    if (matched.length === 0) {
      // [M1] a SENTINEL absent from a NON-EMPTY geographies object ⇒ schema drift
      // (the four sentinels are live-observed present in EVERY non-empty 200).
      // Optional layers absent ⇒ honest null (never drift).
      if (spec.sentinel && nonEmpty) {
        throw driftError(
          label,
          `census: expected sentinel layer "${spec.label}" matched ZERO keys in a non-empty geographies object (keys: ${JSON.stringify(allKeys)}) — treating as schema drift (the layer-key suffix may have changed).`,
        );
      }
      geo[spec.field] = null;
      continue;
    }

    // [B1] Deterministic pick: highest leading session/year number, tiebreak by the
    // key string DESC (so the choice is stable). NEVER silently drop the others.
    const ordered = [...matched].sort((a, b) => {
      const na = leadingNumber(a);
      const nb = leadingNumber(b);
      if (na !== nb) return nb - na;
      return a < b ? 1 : a > b ? -1 : 0;
    });
    const layers = ordered.map((k) =>
      toGeoLayer(k, (geographies[k] as Record<string, unknown>[])[0]!),
    );
    const chosen = layers[0]!;

    if (layers.length > 1) {
      const alternates = layers.slice(1);
      geo[spec.field] = { ...chosen, alternates };
      // MANDATORY multi-key note ([B1]) — name every matched key + the chosen one.
      notes.push(
        `vintage ${vintageName ?? "(unknown)"} returned ${layers.length} "${spec.label}" layers: ${ordered
          .map((k) => JSON.stringify(k))
          .join(", ")}; showing "${chosen.layerKey}" (highest session/year) as ${spec.field}, the other ${layers.length - 1} in ${spec.field}.alternates[] — a redistricted location can carry DISTINCT GEOIDs across these, so do NOT treat the shown one as the sole answer.`,
      );
    } else {
      geo[spec.field] = chosen;
    }
  }

  return { geo, notes };
}

// ─── Curated per-match / per-point shapes ─────────────────────────
export type AddressMatch = {
  matchedAddress: string | null; // WHAT the geocoder matched (the verify surface)
  coordinates: { x: number | null; y: number | null };
  tigerLineId: string | null;
  addressComponents: {
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  };
  geographies: CensusGeographies;
};

/** Build one curated AddressMatch from a raw addressMatches[i] + its geographies. */
function buildAddressMatch(
  m: Record<string, unknown>,
  label: string,
  vintageName: string | null,
): { match: AddressMatch; notes: string[] } {
  const coordsRaw = (m.coordinates ?? {}) as Record<string, unknown>;
  const tiger = (m.tigerLine ?? {}) as Record<string, unknown>;
  const ac = (m.addressComponents ?? {}) as Record<string, unknown>;
  const g = m.geographies;
  const geoObj =
    g !== null && typeof g === "object" && !Array.isArray(g)
      ? (g as Record<string, unknown>)
      : {};
  const { geo, notes } = mapGeographies(geoObj, label, vintageName);
  // A one-line street from the parsed components (fromAddress + streetName + suffixType).
  const street =
    [str(ac.fromAddress), str(ac.streetName), str(ac.suffixType)]
      .filter((p) => p !== null)
      .join(" ") || null;
  return {
    match: {
      matchedAddress: str(m.matchedAddress),
      coordinates: { x: num(coordsRaw.x), y: num(coordsRaw.y) },
      tigerLineId: str(tiger.tigerLineId),
      addressComponents: {
        street,
        city: str(ac.city),
        state: str(ac.state),
        zip: str(ac.zip),
      },
      geographies: geo,
    },
    notes,
  };
}

/** Echo the RESOLVED benchmark/vintage from result.input (the ACTUAL pair upstream used). */
function resolvedVintage(
  input: Record<string, unknown> | undefined,
): { benchmark: string | null; vintage: string | null } {
  const b = (input?.benchmark ?? {}) as Record<string, unknown>;
  const v = (input?.vintage ?? {}) as Record<string, unknown>;
  return { benchmark: str(b.benchmarkName), vintage: str(v.vintageName) };
}

/** The mandatory "resolved + moving vintage" note (echoes the actual resolved pair). */
function movingVintageNote(res: {
  benchmark: string | null;
  vintage: string | null;
}): string {
  return `Resolved to benchmark ${JSON.stringify(res.benchmark)} / vintage ${JSON.stringify(res.vintage)}. 'Current' is a MOVING vintage — these geographies reflect today's resolution and may change as the Census Bureau refreshes (the same address can return a different tract/CD across cycles); the congressional-district layerKey reflects the current congressional session (redistricting changes it).`;
}

// ─── Enum re-guards (belt-and-suspenders behind the server's Zod enums) ──
function guardBenchmark(benchmark: string): void {
  if (!(CENSUS_BENCHMARKS as readonly string[]).includes(benchmark)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid benchmark ${JSON.stringify(benchmark)} — expected one of ${JSON.stringify(CENSUS_BENCHMARKS)}.`,
      retryable: false,
    });
  }
}
function guardVintage(vintage: string): void {
  if (!(CENSUS_VINTAGES as readonly string[]).includes(vintage)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid vintage ${JSON.stringify(vintage)} — expected one of the ${CENSUS_VINTAGES.length} live-valid vintages (it must also be COMPATIBLE with the chosen benchmark; an incompatible pair fails-closed with a 400).`,
      retryable: false,
    });
  }
}

const SOURCE = `${CENSUS_GEO_HOST} via US Census Geocoder (keyless)`;

// ─── Tool 1: census_geocode_address ───────────────────────────────
/**
 * Resolve a one-line US address → its matched address(es) + the Census geographies
 * that drive set-aside / place-of-performance analysis (congressional district,
 * census tract, county, state, block). Handles the addressMatches ARRAY (the
 * multi-match "which location" honesty surface — every match carries its own
 * matchedAddress + geographies). Disclose-not-refuse: an unmatched address is NOT an
 * error (matches:[], matchCount:0, complete:true + a note).
 */
export async function geocodeAddress(args: {
  address: string;
  benchmark?: string;
  vintage?: string;
}): Promise<MetaBundle> {
  const benchmark = args.benchmark ?? DEFAULT_BENCHMARK;
  const vintage = args.vintage ?? DEFAULT_VINTAGE;
  guardBenchmark(benchmark); // re-guard behind Zod (a direct handler call bypasses it)
  guardVintage(vintage);
  if (typeof args.address !== "string" || args.address.trim() === "") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: "address is required (a non-empty one-line US address).",
      retryable: false,
    });
  }

  const params = new URLSearchParams();
  params.set("address", args.address); // URLSearchParams-encoded VALUE (no param smuggle)
  params.set("benchmark", benchmark); // ALWAYS sent (REQUIRED — a missing benchmark 400s)
  params.set("vintage", vintage); // ALWAYS sent (REQUIRED — a missing vintage 400s)

  const body = await censusGet(PATH_ONELINE, params);
  const result = (body as { result?: unknown } | null | undefined)?.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw driftError(
      "census:" + PATH_ONELINE,
      "census: onelineaddress returned an unexpected shape (missing result object).",
    );
  }
  const r = result as Record<string, unknown>;
  const addressMatches = r.addressMatches;
  if (!Array.isArray(addressMatches)) {
    throw driftError(
      "census:" + PATH_ONELINE,
      "census: onelineaddress returned a non-array addressMatches with no error — treating as schema drift (never a fake empty).",
    );
  }
  const res = resolvedVintage(r.input as Record<string, unknown> | undefined);

  const notes: string[] = [movingVintageNote(res), HUBZONE_OZ_CAVEAT, BENCHMARK_VINTAGE_NOTE, GEOID_STRING_NOTE];

  // Genuine-empty (200 addressMatches:[]) — honest complete:true / matchCount:0 (NOT
  // an error; DISTINCT from the LOUD 400 of a bad benchmark/vintage).
  if (addressMatches.length === 0) {
    notes.push(
      "No address match — the address did not geocode. Verify spelling and add city, state, and ZIP (an under-specified address returns 0, a genuine empty, not an error).",
    );
    return withMeta(
      {
        matches: [] as AddressMatch[],
        matchCount: 0,
        benchmark,
        vintage,
        vintageResolved: res,
      },
      {
        source: SOURCE,
        keylessMode: true,
        returned: 0,
        totalAvailable: 0,
        filtersApplied: ["benchmark", "vintage"],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
      } satisfies Partial<ResponseMeta>,
    );
  }

  const matches: AddressMatch[] = [];
  for (const m of addressMatches) {
    const built = buildAddressMatch(
      (m ?? {}) as Record<string, unknown>,
      "census:" + PATH_ONELINE,
      res.vintage,
    );
    matches.push(built.match);
    for (const n of built.notes) if (!notes.includes(n)) notes.push(n);
  }

  // Multi-match disclosure (§Honesty #5) — surface ALL matches + matchCount + a note.
  // NOTE: an upstream cap on addressMatches was NOT observed (live-forced 7 matches for
  // "100 Main St, Springfield"); no cap has been seen, so complete:true. If a future
  // cap is found, surface truncated:true.
  if (matches.length > 1) {
    notes.push(
      `${matches.length} addresses matched — the geographies are listed PER match; matchedAddress shows what each resolved to. Refine the address (add ZIP / unit / state) if the intended location is ambiguous.`,
    );
  }

  return withMeta(
    {
      matches,
      matchCount: matches.length,
      benchmark,
      vintage,
      vintageResolved: res,
    },
    {
      source: SOURCE,
      keylessMode: true,
      returned: matches.length,
      totalAvailable: matches.length,
      filtersApplied: ["benchmark", "vintage"],
      filtersDropped: [],
      fieldsUnavailable: [],
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool 2: census_geographies_by_coordinates ────────────────────
/**
 * Resolve a longitude/latitude point → the Census geographies at that point (no
 * address parsing). For a caller that already holds coordinates. `x`/`longitude`
 * (required) and `y`/`latitude` (required) are aliases; the handler coalesces + re-
 * guards them finite-in-range (belt-and-suspenders behind Zod — a non-finite value ⇒
 * invalid_input PRE-fetch, 0 fetch, mirroring the LOUD 400 of a non-numeric coord but
 * caught locally). A point outside any US Census geography ⇒ geographies:{} ⇒ all
 * layers null, matchCount:0, complete:true + a note (NOT an error).
 */
export async function geographiesByCoordinates(args: {
  x?: number;
  y?: number;
  longitude?: number;
  latitude?: number;
  benchmark?: string;
  vintage?: string;
}): Promise<MetaBundle> {
  const benchmark = args.benchmark ?? DEFAULT_BENCHMARK;
  const vintage = args.vintage ?? DEFAULT_VINTAGE;
  guardBenchmark(benchmark);
  guardVintage(vintage);

  const xVal = args.x ?? args.longitude;
  const yVal = args.y ?? args.latitude;
  if (xVal === undefined || yVal === undefined) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: "both x (longitude) and y (latitude) are required.",
      retryable: false,
    });
  }
  // Coordinate FINITENESS re-guard (belt-and-suspenders behind the Zod min/max — a live
  // x=NaN is a misclassified upstream 500 the pre-fetch guard prevents; 0 fetch).
  if (!Number.isFinite(xVal) || xVal < -180 || xVal > 180) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid x (longitude) ${JSON.stringify(xVal)} — expected a finite number in [-180, 180].`,
      retryable: false,
    });
  }
  if (!Number.isFinite(yVal) || yVal < -90 || yVal > 90) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid y (latitude) ${JSON.stringify(yVal)} — expected a finite number in [-90, 90].`,
      retryable: false,
    });
  }

  const params = new URLSearchParams();
  params.set("x", String(xVal));
  params.set("y", String(yVal));
  params.set("benchmark", benchmark);
  params.set("vintage", vintage);

  const body = await censusGet(PATH_COORDINATES, params);
  const result = (body as { result?: unknown } | null | undefined)?.result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw driftError(
      "census:" + PATH_COORDINATES,
      "census: coordinates returned an unexpected shape (missing result object).",
    );
  }
  const r = result as Record<string, unknown>;
  const geographiesRaw = r.geographies;
  // A missing / non-object (null / array) geographies with no error ⇒ hard drift (an
  // empty OBJECT {} is a GENUINE out-of-US empty, handled below — NOT drift).
  if (
    geographiesRaw === null ||
    typeof geographiesRaw !== "object" ||
    Array.isArray(geographiesRaw)
  ) {
    throw driftError(
      "census:" + PATH_COORDINATES,
      "census: coordinates returned a non-object geographies with no error — treating as schema drift (never a fake empty).",
    );
  }
  const res = resolvedVintage(r.input as Record<string, unknown> | undefined);
  const loc = (r.input as { location?: unknown } | undefined)?.location as
    | Record<string, unknown>
    | undefined;
  const coordinates = {
    x: num(loc?.x) ?? xVal,
    y: num(loc?.y) ?? yVal,
  };

  const notes: string[] = [movingVintageNote(res), HUBZONE_OZ_CAVEAT, BENCHMARK_VINTAGE_NOTE, GEOID_STRING_NOTE];

  const geoObj = geographiesRaw as Record<string, unknown>;
  // Genuine-empty (200 geographies:{}) — an out-of-US point. All canonical layers null,
  // matchCount:0, complete:true (NOT thrown; DISTINCT from the LOUD 400 of a bad coord).
  if (Object.keys(geoObj).length === 0) {
    const empty = {} as CensusGeographies;
    for (const spec of LAYER_SPECS) empty[spec.field] = null;
    notes.push(
      "The point is not within a US Census geography (offshore / outside the US) — an honest empty (geographies:{}), not an error.",
    );
    return withMeta(
      {
        found: false,
        coordinates,
        geographies: empty,
        benchmark,
        vintage,
        vintageResolved: res,
      },
      {
        source: SOURCE,
        keylessMode: true,
        returned: 0,
        totalAvailable: 0,
        filtersApplied: ["benchmark", "vintage"],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
      } satisfies Partial<ResponseMeta>,
    );
  }

  const { geo, notes: multiKeyNotes } = mapGeographies(
    geoObj,
    "census:" + PATH_COORDINATES,
    res.vintage,
  );
  for (const n of multiKeyNotes) if (!notes.includes(n)) notes.push(n);

  return withMeta(
    {
      found: true,
      coordinates,
      geographies: geo,
      benchmark,
      vintage,
      vintageResolved: res,
    },
    {
      source: SOURCE,
      keylessMode: true,
      returned: 1,
      totalAvailable: 1,
      filtersApplied: ["benchmark", "vintage"],
      filtersDropped: [],
      fieldsUnavailable: [],
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
