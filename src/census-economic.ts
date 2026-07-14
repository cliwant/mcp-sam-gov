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

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so a num regression fails together across sources. NO local
// num/str.
export { num };

// ─── SSRF core: the single fixed host (DIFFERENT from census.ts) ──
const CENSUS_DATA_HOST = "api.census.gov";
const CENSUS_DATA_LABEL = "census:/data/cbp"; // host-only ToolError surface; NO token, NO key

// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
const YEAR_RE = /^\d{4}$/; // rides in the PATH — strict 4-digit (no path injection)
const NAICS_RE = /^\d{2,6}$/; // 2–6 digit NAICS-2017 sector/code
const STATE_FIPS_RE = /^\d{2}$/; // 2-digit state FIPS
const GEOGRAPHIES = new Set(["us", "state", "county"]);

// The Census suppression/withhold sentinel floor. Census encodes a suppressed or
// unavailable cell as a large NEGATIVE value (-999999999 / -888888888 /
// -666666666 …). Establishment/employment/payroll counts are non-negative, so any
// value at/below this floor is a sentinel, NOT data.
const CENSUS_SENTINEL_FLOOR = -100000000;

const DEFAULT_YEAR = "2022"; // the latest confirmed CBP vintage (ADR-0047)

// ─── Honesty notes (ADR-0047 required set) ────────────────────────
const KEY_REQUIRED_NOTE =
  "This source REQUIRES a free CENSUS_API_KEY (the Census Data API has no keyless tier). The key is sent ONLY as the &key= query parameter to api.census.gov and is NEVER logged, echoed, or placed in this response.";
const PAYROLL_UNITS_NOTE =
  "annualPayrollUsd is ANNUAL payroll in US dollars, converted from the Census PAYANN field's $1,000 units (×1000). establishments and employees are integer counts (as-of the reference year).";
const SUPPRESSED_NOTE =
  "Census suppresses cells for confidentiality/reliability using large negative sentinels (e.g. -999999999); such values are mapped to null (withheld) — NEVER a negative number and NEVER 0. A genuine 0 is preserved as 0.";
const NO_PAGINATION_NOTE =
  "CBP returns the COMPLETE set of geographies matching the filter (no server-side pagination); totalAvailable equals the number of rows returned. Narrow with naics / geography to reduce the row count.";

// ─── The key seam (REQUIRED; value NEVER leaked past the &key= param) ──
/** Read CENSUS_API_KEY from env; trim; return the value or undefined (unset/blank). */
export function censusApiKey(): string | undefined {
  const raw = process.env.CENSUS_API_KEY;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : undefined;
}

// ─── Curated row shape ────────────────────────────────────────────
export type CbpRow = {
  name: string | null; // the geography NAME (e.g. "California")
  geoId: string | null; // GEO_ID (a STRING — leading zeros survive)
  naicsCode: string | null; // NAICS2017 (a STRING — sector codes carry structure)
  naicsLabel: string | null; // NAICS2017_LABEL
  establishments: number | null; // ESTAB — null when suppressed (NEVER negative/0-lie)
  employees: number | null; // EMP — null when suppressed
  annualPayrollUsd: number | null; // PAYANN×1000 — null when suppressed
  state: string | null; // state FIPS (a STRING — leading zeros survive)
};

/** num(), but map the Census negative suppression sentinel family → null (withheld). */
function censusNum(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  // A large-negative sentinel is a WITHHELD/suppressed cell, never data. A genuine
  // 0 (n > floor) passes through as 0.
  if (n <= CENSUS_SENTINEL_FLOOR) return null;
  return n;
}

/** Annual payroll: PAYANN is in $1,000 units → ×1000; null-preserving. */
function mul1000(n: number | null): number | null {
  return n === null ? null : n * 1000;
}

export type CensusBusinessPatternsArgs = {
  naics?: string;
  geography?: string; // us | state | county (default us)
  state?: string; // 2-digit FIPS (required for county; optional filter for state)
  year?: string; // ^\d{4}$ (default 2022)
  limit?: number; // OPTIONAL client-side top-N slice (CBP has no server pagination)
};

/**
 * Fetch County Business Patterns rows for a NAICS × geography filter → normalized
 * establishment / employment / annual-payroll rows + honest `_meta`. REQUIRES
 * CENSUS_API_KEY (throws invalid_input pre-fetch when unset). The 2D-array body is
 * parsed by HEADER NAME (order-independent); suppressed cells map to null.
 */
export async function businessPatterns(
  args: CensusBusinessPatternsArgs,
): Promise<MetaBundle> {
  // ── [KEY] REQUIRED key — throw an honest config error BEFORE any fetch. ──
  const key = censusApiKey();
  if (key === undefined) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message:
        "Census Data API requires a free key. Get one at https://api.census.gov/data/key_signup.html and set CENSUS_API_KEY.",
      upstreamEndpoint: CENSUS_DATA_LABEL,
    });
  }

  // ── Validate + default the inputs (belt-and-suspenders behind the server Zod;
  //    a DIRECT handler call bypasses Zod). ──
  const year = args.year ?? DEFAULT_YEAR;
  if (!YEAR_RE.test(year)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid year ${JSON.stringify(year)} — expected a 4-digit year (^\\d{4}$), e.g. "2022". (year rides in the request PATH; it is strictly validated.)`,
      upstreamEndpoint: CENSUS_DATA_LABEL,
    });
  }

  const geography = args.geography ?? "us";
  if (!GEOGRAPHIES.has(geography)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid geography ${JSON.stringify(geography)} — expected one of us, state, county.`,
      upstreamEndpoint: CENSUS_DATA_LABEL,
    });
  }

  if (args.state !== undefined && !STATE_FIPS_RE.test(args.state)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid state ${JSON.stringify(args.state)} — expected a 2-digit state FIPS code (^\\d{2}$), e.g. "06" (California).`,
      upstreamEndpoint: CENSUS_DATA_LABEL,
    });
  }

  if (args.naics !== undefined && !NAICS_RE.test(args.naics)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid naics ${JSON.stringify(args.naics)} — expected a 2–6 digit NAICS-2017 code (^\\d{2,6}$), e.g. "5415" (Computer Systems Design).`,
      upstreamEndpoint: CENSUS_DATA_LABEL,
    });
  }

  // ── Resolve the geography clause (for=… [+ in=state:…]). ──
  let forClause: string;
  let inClause: string | undefined;
  let geoFilter: string;
  if (geography === "us") {
    forClause = "us:*";
    geoFilter = "geography:us";
  } else if (geography === "state") {
    forClause = args.state !== undefined ? `state:${args.state}` : "state:*";
    geoFilter = `geography:state:${args.state ?? "*"}`;
  } else {
    // county — requires a state (the CBP `in=state:` predicate is mandatory).
    if (args.state === undefined) {
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        retryable: false,
        message:
          "geography 'county' requires `state` (a 2-digit FIPS) — CBP county queries need an `in=state:NN` predicate. Pass state, e.g. state:'06'.",
        upstreamEndpoint: CENSUS_DATA_LABEL,
      });
    }
    forClause = "county:*";
    inClause = `state:${args.state}`;
    geoFilter = `geography:county:* in state:${args.state}`;
  }

  // ── Build the query (all VALUES via URLSearchParams — no host/path steer; the
  //    REQUIRED key rides ONLY here in &key=). ──
  const params = new URLSearchParams();
  params.set("get", "NAME,NAICS2017_LABEL,ESTAB,EMP,PAYANN,GEO_ID");
  params.set("for", forClause);
  if (inClause !== undefined) params.set("in", inClause);
  if (args.naics !== undefined) params.set("NAICS2017", args.naics);
  params.set("key", key);

  const url = `https://${CENSUS_DATA_HOST}/data/${year}/cbp?${params.toString()}`;
  // Belt-and-suspenders: the fixed host + strictly-validated path leave nothing to
  // steer the authority; assert the built URL cannot have been moved off-host.
  const built = new URL(url);
  if (built.hostname !== CENSUS_DATA_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Constructed Census Data URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${CENSUS_DATA_HOST} over https — refusing to fetch (SSRF safety).`,
      upstreamEndpoint: CENSUS_DATA_LABEL,
    });
  }

  // ── Fetch (redirect:"error" — a missing/invalid key 302-redirects to the
  //    Missing-Key page; we fail closed and reclassify to invalid_input). A 200
  //    non-JSON body ⇒ getJson's r.json() throws SyntaxError ⇒ schema_drift. The
  //    429/5xx/404/400 taxonomy propagates unchanged. ──
  let body: unknown;
  try {
    body = await getJson<unknown>(built.toString(), {
      label: CENSUS_DATA_LABEL,
      redirect: "error",
    });
  } catch (e) {
    if (e instanceof ToolErrorCarrier) {
      // A 3xx redirect at the wire (missing/invalid key → Census Missing-Key page)
      // ⇒ reclassify to an honest key-config error (never a fake-empty).
      const st = e.toolError.upstreamStatus;
      if (st !== undefined && st >= 300 && st < 400) {
        throw new ToolErrorCarrier({
          kind: "invalid_input",
          retryable: false,
          message:
            "Census Data API redirected the request (HTTP 3xx to the 'Missing Key' page) — CENSUS_API_KEY is missing or invalid. Check the key at https://api.census.gov/data/key_signup.html.",
          upstreamEndpoint: CENSUS_DATA_LABEL,
        });
      }
      throw e; // 5xx → upstream_unavailable, 404 → not_found, 400 → invalid_input …
    }
    if (e instanceof SyntaxError) {
      throw driftError(
        CENSUS_DATA_LABEL,
        "Census CBP returned a non-JSON body at HTTP 200 (likely an HTML 'Missing Key' / error page) — treating as schema drift (never read as an empty result).",
      );
    }
    throw e;
  }

  // ── [P4] Parse the 2D array: row 0 = string[] header, rows 1..N = data. ──
  if (!Array.isArray(body) || body.length === 0) {
    throw driftError(
      CENSUS_DATA_LABEL,
      "Census CBP returned a body that is not a non-empty 2D array — treating as schema drift (never a fabricated empty).",
    );
  }
  const header = body[0];
  if (
    !Array.isArray(header) ||
    header.length === 0 ||
    !header.every((h) => typeof h === "string")
  ) {
    throw driftError(
      CENSUS_DATA_LABEL,
      "Census CBP row 0 is not a string[] header row — treating as schema drift (the 2D-array contract changed; never a fabricated empty).",
    );
  }

  // Header-name → column index (order-independent; a missing column ⇒ index -1 ⇒
  // the field maps to null, never a positional mis-read).
  const idx = new Map<string, number>();
  (header as string[]).forEach((h, i) => idx.set(h, i));
  const col = (row: unknown[], name: string): unknown => {
    const i = idx.get(name);
    return i === undefined || i < 0 ? undefined : row[i];
  };

  const allRows: CbpRow[] = [];
  for (let i = 1; i < body.length; i++) {
    const raw = body[i];
    if (!Array.isArray(raw)) {
      throw driftError(
        CENSUS_DATA_LABEL,
        `Census CBP data row ${i} is not an array — treating as schema drift (never a fabricated empty).`,
      );
    }
    const row = raw as unknown[];
    allRows.push({
      name: str(col(row, "NAME")),
      geoId: str(col(row, "GEO_ID")),
      naicsCode: str(col(row, "NAICS2017")),
      naicsLabel: str(col(row, "NAICS2017_LABEL")),
      establishments: censusNum(col(row, "ESTAB")),
      employees: censusNum(col(row, "EMP")),
      annualPayrollUsd: mul1000(censusNum(col(row, "PAYANN"))),
      state: str(col(row, "state")),
    });
  }

  // ── [P1] The COMPLETE set for the filter (no server pagination). An OPTIONAL
  //    client-side top-N slice is disclosed (totalAvailable stays the full count,
  //    so buildMeta derives truncated/complete honestly). ──
  const totalAvailable = allRows.length;
  const notes: string[] = [
    KEY_REQUIRED_NOTE,
    PAYROLL_UNITS_NOTE,
    SUPPRESSED_NOTE,
    NO_PAGINATION_NOTE,
  ];

  let rows = allRows;
  if (
    typeof args.limit === "number" &&
    Number.isFinite(args.limit) &&
    args.limit >= 0 &&
    args.limit < allRows.length
  ) {
    rows = allRows.slice(0, args.limit);
    notes.push(
      `Returned the first ${rows.length} of ${totalAvailable} rows (client-side limit=${args.limit}); CBP has NO server-side pagination, so the remaining ${totalAvailable - rows.length} are not fetched separately — raise limit or narrow the filter to see them.`,
    );
  }

  const filtersApplied = [
    args.naics !== undefined ? `naics:${args.naics}` : "naics:(all)",
    geoFilter,
    `year:${year}`,
  ];

  const meta: Partial<ResponseMeta> = {
    // MODE only — never the key value (K-test).
    source: `api.census.gov /data/${year}/cbp (County Business Patterns; CENSUS_API_KEY)`,
    keylessMode: false, // ★KEYED — the first key-required source
    returned: rows.length,
    totalAvailable,
    filtersApplied,
    filtersDropped: [],
    fieldsUnavailable: [],
    notes,
  };

  return withMeta({ rows }, meta);
}
