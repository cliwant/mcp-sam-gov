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
 *   keyless-pretend). The other tools stay keyless — this key is scoped to
 *   this one source. (Contrast the OPTIONAL keys of datagov/bls/nvd, which lift a
 *   tier but are not required.)
 *
 * DIFFERENT HOST than census.ts (the geocoder, geocoding.geo.census.gov): the
 * DATA API is `api.census.gov/data/{year}/cbp`. This module COPIES (does NOT
 * import) the census.ts fixed-host SSRF idiom (a single host const + a
 * post-construction `new URL().hostname` assertion + `redirect:"error"`) and does
 * NOT touch census_geocode.
 *
 * Coercion/meta code is REUSED (`driftError`, `errorFromResponse`, `num`
 * coerce.ts null-never-0, `withMeta`/`buildMeta`). The ONE bespoke bit is the
 * fetch: a single `fetch(redirect:"manual")` (NOT the shared getJson) so a
 * missing/invalid-key 302 surfaces as an INSPECTABLE opaque-redirect → honest
 * invalid_input, instead of undici's redirect:"error" TypeError that
 * fetchWithRetry would mask as a retryable outage (see the fetch block). The
 * optional-key leak discipline is MIRRORED from datagovKey.ts/bls.ts — but here
 * the key is REQUIRED and rides ONLY in the `&key=` query param, NOWHERE else
 * (never the label, `_meta.source`, notes, or a log — the K-test).
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
 *          CENSUS_API_KEY + the free-signup URL. A wire 302 (a key that IS set but is
 *          invalid → the Missing-Key page) is caught via redirect:"manual" as an
 *          opaque-redirect ⇒ invalid_input "check CENSUS_API_KEY" (never a
 *          fake-empty, never a masked outage).
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
import { ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
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
// DEFENSIVE large-negative sentinel floor. Some Census products (ACS/SAIPE) encode a
// withheld/unavailable cell as a large NEGATIVE jam value (-999999999 / -888888888 /
// -666666666 …); establishment/employment/payroll counts are non-negative, so any
// value at/below this floor is a sentinel, NOT data → mapped to null.
// ★HONESTY CAVEAT: CBP itself does NOT primarily use these jam values — modern CBP
// uses NOISE INFUSION (EMP_N noise-range columns) + suppression FLAGS (EMP_N_F …),
// which this tool does NOT currently request or interpret (it surfaces values as
// reported). So this floor is a conservative cross-product guard, not CBP's confirmed
// mechanism; a keyed live verification of CBP's exact withheld-cell encoding is pending
// (no CENSUS_API_KEY was available at build time). See SUPPRESSED_NOTE.
const CENSUS_SENTINEL_FLOOR = -100000000;
// Latest PUBLISHED CBP vintage (live-verified 2026-07-20:
// api.census.gov/data/2023/cbp/variables.json → 200; /data/2024 → 404). CBP is
// released with a ~2-year lag and irregularly, so a dynamic "current year − N" is
// unsafe (it would query an unpublished vintage) — this is a hard-coded latest;
// bump it (and re-verify) when a newer /data/{year}/cbp appears. ADR-0047.
const DEFAULT_YEAR = "2023";
// ─── Honesty notes (ADR-0047 required set) ────────────────────────
const KEY_REQUIRED_NOTE = "This source REQUIRES a free CENSUS_API_KEY (the Census Data API has no keyless tier). The key is sent ONLY as the &key= query parameter to api.census.gov and is NEVER logged, echoed, or placed in this response.";
const PAYROLL_UNITS_NOTE = "annualPayrollUsd is ANNUAL payroll in US dollars, converted from the Census PAYANN field's $1,000 units (×1000). establishments and employees are integer counts (as-of the reference year).";
const SUPPRESSED_NOTE = "Disclosure protection: any large-negative jam sentinel (e.g. -999999999) is mapped to null (withheld) — NEVER a negative number and NEVER 0; a genuine 0 is preserved as 0. NOTE: modern CBP applies NOISE INFUSION (perturbed values) plus suppression flag columns (e.g. EMP_N_F) rather than jam sentinels; this tool surfaces values as reported and does not currently interpret suppression flags, so a flagged/noise-infused cell is returned as its reported number — treat exact small counts as approximate.";
const NO_PAGINATION_NOTE = "CBP returns the COMPLETE set of geographies matching the filter (no server-side pagination); totalAvailable equals the number of rows returned. Narrow with naics / geography to reduce the row count.";
// ─── The key seam (REQUIRED; value NEVER leaked past the &key= param) ──
/** Read CENSUS_API_KEY from env; trim; return the value or undefined (unset/blank). */
export function censusApiKey() {
    const raw = process.env.CENSUS_API_KEY;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed ? trimmed : undefined;
}
/** num(), but map the Census negative suppression sentinel family → null (withheld). */
function censusNum(v) {
    const n = num(v);
    if (n === null)
        return null;
    // A large-negative sentinel is a WITHHELD/suppressed cell, never data. A genuine
    // 0 (n > floor) passes through as 0.
    if (n <= CENSUS_SENTINEL_FLOOR)
        return null;
    return n;
}
/** Annual payroll: PAYANN is in $1,000 units → ×1000; null-preserving. */
function mul1000(n) {
    return n === null ? null : n * 1000;
}
/**
 * Fetch County Business Patterns rows for a NAICS × geography filter → normalized
 * establishment / employment / annual-payroll rows + honest `_meta`. REQUIRES
 * CENSUS_API_KEY (throws invalid_input pre-fetch when unset). The 2D-array body is
 * parsed by HEADER NAME (order-independent); suppressed cells map to null.
 */
export async function businessPatterns(args) {
    // ── [KEY] REQUIRED key — throw an honest config error BEFORE any fetch. ──
    const key = censusApiKey();
    if (key === undefined) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "Census Data API requires a free key. Get one at https://api.census.gov/data/key_signup.html and set CENSUS_API_KEY.",
            upstreamEndpoint: CENSUS_DATA_LABEL,
        });
    }
    // ── Validate + default the inputs (belt-and-suspenders behind the server Zod;
    //    a DIRECT handler call bypasses Zod). ──
    const yearWasDefaulted = args.year === undefined;
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
    let forClause;
    let inClause;
    let geoFilter;
    if (geography === "us") {
        forClause = "us:*";
        geoFilter = "geography:us";
    }
    else if (geography === "state") {
        forClause = args.state !== undefined ? `state:${args.state}` : "state:*";
        geoFilter = `geography:state:${args.state ?? "*"}`;
    }
    else {
        // county — requires a state (the CBP `in=state:` predicate is mandatory).
        if (args.state === undefined) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: "geography 'county' requires `state` (a 2-digit FIPS) — CBP county queries need an `in=state:NN` predicate. Pass state, e.g. state:'06'.",
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
    if (inClause !== undefined)
        params.set("in", inClause);
    if (args.naics !== undefined)
        params.set("NAICS2017", args.naics);
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
    // ── Fetch with redirect:"manual" — the KEY-ERROR DETECTION crux. A missing or
    //    invalid key makes the Census Data API 302-redirect to its "Missing Key" page
    //    (live-verified: `HTTP 302` + `Location: /data/missing_key.html` +
    //    `X-DataWebAPI-KeyError: 1`). We must NOT use redirect:"error" via getJson
    //    here: undici rejects an "error"-mode redirect with a TypeError that the
    //    shared fetchWithRetry catch reclassifies to a *retryable upstream_unavailable*
    //    — masking a key-config error as a transient outage. redirect:"manual" instead
    //    yields an INSPECTABLE opaque-redirect (type "opaqueredirect", status 0), so
    //    the missing/invalid key surfaces as an honest invalid_input. This is a
    //    SINGLE classified attempt (no auto-retry): a transient 5xx THROWS
    //    upstream_unavailable — re-invoke the tool to retry. The 5xx/404/400 taxonomy
    //    is delegated to the shared errors.ts `errorFromResponse`; a 200 non-JSON body
    //    ⇒ r.json() SyntaxError ⇒ schema_drift. The redirect is NEVER followed, so no
    //    off-host hop can occur (a stronger SSRF posture than redirect:"error"). ──
    let res;
    try {
        res = await fetch(built.toString(), {
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
        });
    }
    catch (e) {
        // Timeout/abort ⇒ non-retryable (the same aborted signal would re-reject);
        // a genuine network TypeError ⇒ retryable upstream_unavailable. NEVER empty.
        if (e instanceof Error &&
            (e.name === "TimeoutError" || e.name === "AbortError")) {
            throw new ToolErrorCarrier({
                kind: "upstream_unavailable",
                message: `Request to ${CENSUS_DATA_LABEL} timed out.`,
                retryable: false,
                upstreamEndpoint: CENSUS_DATA_LABEL,
            });
        }
        throw new ToolErrorCarrier({
            kind: "upstream_unavailable",
            message: `Network error reaching ${CENSUS_DATA_LABEL}: ${e instanceof Error ? e.message : String(e)}`,
            retryable: true,
            retryAfterSeconds: 30,
            upstreamEndpoint: CENSUS_DATA_LABEL,
        });
    }
    // [KEY] A redirect (opaque-redirect via redirect:"manual", or a raw 3xx status) ⇒
    // the missing/invalid-key "Missing Key" page ⇒ an honest key-config error, NEVER
    // a fake-empty (swallowing this as empty ⇒ RED in the fault suite).
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "Census Data API redirected the request to its 'Missing Key' page — CENSUS_API_KEY is missing or invalid. Get or check a free key at https://api.census.gov/data/key_signup.html.",
            upstreamEndpoint: CENSUS_DATA_LABEL,
        });
    }
    // [P2] 404/429/5xx/4xx ⇒ the shared errors.ts taxonomy (a DOWN service is NEVER
    // an empty result; 400 → invalid_input, 5xx → upstream_unavailable, …).
    if (!res.ok) {
        throw new ToolErrorCarrier(errorFromResponse(res, CENSUS_DATA_LABEL));
    }
    // [P4] 200 ⇒ parse JSON; a non-JSON body (an HTML error page at 200) makes
    // r.json() throw a SyntaxError ⇒ schema_drift (never read as an empty result).
    let body;
    try {
        body = await res.json();
    }
    catch (e) {
        if (e instanceof SyntaxError) {
            throw driftError(CENSUS_DATA_LABEL, "Census CBP returned a non-JSON body at HTTP 200 (likely an HTML 'Missing Key' / error page) — treating as schema drift (never read as an empty result).");
        }
        throw e;
    }
    // ── [P4] Parse the 2D array: row 0 = string[] header, rows 1..N = data. ──
    if (!Array.isArray(body) || body.length === 0) {
        throw driftError(CENSUS_DATA_LABEL, "Census CBP returned a body that is not a non-empty 2D array — treating as schema drift (never a fabricated empty).");
    }
    const header = body[0];
    if (!Array.isArray(header) ||
        header.length === 0 ||
        !header.every((h) => typeof h === "string")) {
        throw driftError(CENSUS_DATA_LABEL, "Census CBP row 0 is not a string[] header row — treating as schema drift (the 2D-array contract changed; never a fabricated empty).");
    }
    // Header-name → column index (order-independent; a missing column ⇒ index -1 ⇒
    // the field maps to null, never a positional mis-read).
    const idx = new Map();
    header.forEach((h, i) => idx.set(h, i));
    const col = (row, name) => {
        const i = idx.get(name);
        return i === undefined || i < 0 ? undefined : row[i];
    };
    const allRows = [];
    for (let i = 1; i < body.length; i++) {
        const raw = body[i];
        if (!Array.isArray(raw)) {
            throw driftError(CENSUS_DATA_LABEL, `Census CBP data row ${i} is not an array — treating as schema drift (never a fabricated empty).`);
        }
        const row = raw;
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
    const notes = [
        KEY_REQUIRED_NOTE,
        PAYROLL_UNITS_NOTE,
        SUPPRESSED_NOTE,
        NO_PAGINATION_NOTE,
    ];
    if (yearWasDefaulted) {
        notes.push(`No \`year\` was supplied, so it defaulted to ${DEFAULT_YEAR} — the latest PUBLISHED CBP vintage as of the last verification (CBP is released with a ~2-year lag). Pass an explicit \`year\` for a different vintage.`);
    }
    let rows = allRows;
    if (typeof args.limit === "number" &&
        Number.isFinite(args.limit) &&
        args.limit >= 0 &&
        args.limit < allRows.length) {
        rows = allRows.slice(0, args.limit);
        notes.push(`Returned the first ${rows.length} of ${totalAvailable} rows (client-side limit=${args.limit}); CBP has NO server-side pagination, so the remaining ${totalAvailable - rows.length} are not fetched separately — raise limit or narrow the filter to see them.`);
    }
    const filtersApplied = [
        args.naics !== undefined ? `naics:${args.naics}` : "naics:(all)",
        geoFilter,
        `year:${year}`,
    ];
    const meta = {
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
//# sourceMappingURL=census-economic.js.map