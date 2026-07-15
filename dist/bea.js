/**
 * bea.ts — BEA (Bureau of Economic Analysis) Regional Economic Accounts — the
 * REGIONAL / SUB-NATIONAL economic lane (ADR-0051). County / state / MSA GDP by
 * industry (CAGDP2 / SAGDP2N) and personal income (CAINC1 / SAINC1) — the
 * place-of-performance market context that neither the national FRED macro series
 * nor the Census establishment counts carry.
 *
 * ★ THIS IS THE SERVER'S THIRD KEY-REQUIRED SOURCE (Census CBP #1, FRED #2). The
 *   BEA Data API has NO keyless tier: every request needs `UserID=`. So, honestly:
 *   with NO `BEA_API_KEY` this tool THROWS an `invalid_input` config error BEFORE
 *   any fetch (never a fake-empty, never a keyless-pretend). The other tools
 *   stay keyless — this key is scoped to this one source. (Contrast the OPTIONAL
 *   keys of datagov/bls/nvd, which lift a tier but are not required.)
 *
 * This module MIRRORS the census-economic.ts / fred.ts key-required precedent: a
 * `beaApiKey()` env seam, a pre-fetch `invalid_input` THROW when unset, the
 * fixed-host SSRF assert + `redirect:"error"`, and a data-absence-sentinel→null
 * idiom (Census's negative floor / FRED's `"."` — here BEA's string suppression
 * codes `(NA) (D) (NM) (L) *`). It REUSES `getJson` (the shared fetch envelope) /
 * `driftError` / `num`·`str` (coerce.ts, null-never-0/empty) / `withMeta`·`buildMeta`.
 * The key rides ONLY in the `UserID=` query param, NOWHERE else (never the label,
 * `_meta.source`, notes, or a log — the K-test).
 *
 *   GET https://apps.bea.gov/api/data
 *       ?UserID=<BEA_API_KEY>        (REQUIRED)
 *       &method=GetData&datasetname=Regional&ResultFormat=json  (fixed)
 *       &TableName=<tableName>       (e.g. CAGDP2, SAGDP2N, CAINC1)
 *       &GeoFips=<geoFips>           (STATE | county FIPS | MSA)
 *       &LineCode=<lineCode>         (industry line, or ALL)
 *       &Year=<year>                 (YYYY | LAST5 | ALL)
 *       &Frequency=<frequency>       (A | Q)
 *   → { BEAAPI:{ Results:{ Statistic, UnitOfMeasure, Dimensions:[…],
 *        Data:[{ Code, GeoFips, GeoName, TimePeriod, CL_UNIT, UNIT_MULT,
 *                DataValue, NoteRef }], Notes:[{ NoteRef, NoteText }] } } }
 *
 * ★ HONESTY (ADR-0051 P1–P5):
 *   [KEY]  no key ⇒ invalid_input THROW pre-fetch (0 fetch); the message names
 *          BEA_API_KEY + the free-signup URL.
 *   [P1]   BEA GetData returns the COMPLETE set for the filter (no server
 *          pagination) ⇒ totalAvailable = the row count, complete:true. NEVER
 *          fabricated.
 *   [★P2]  ★the crux: a missing/invalid key (and any bad-parameter request) returns
 *          HTTP **200** carrying `BEAAPI.Results.Error` — NOT an HTTP error status.
 *          The catch-ladder checks `Results.Error` FIRST (BEFORE the Data-array
 *          drift check) and throws invalid_input SURFACING `APIErrorDescription`
 *          (+ code) — NEVER read as an empty result. `Data:[]` (a genuine empty
 *          array) ⇒ honest empty (returned:0, complete:true). A 5xx/timeout ⇒
 *          upstream_unavailable THROW. A 200 non-JSON ⇒ schema_drift.
 *   [★P3]  `DataValue` is a STRING WITH COMMAS ("1,234,567") — strip commas then
 *          `num()`. The suppression/not-available sentinels `(NA) (D) (NM) (L) *`
 *          (and any non-numeric after the comma-strip) map to **null** (withheld),
 *          NEVER 0 — a real "0" stays 0. `UNIT_MULT` (power-of-10 multiplier) is
 *          reported as `unitMult` and `CL_UNIT` as `unitOfMeasure`; the raw value is
 *          surfaced WITH the multiplier — it is NEVER multiplied in (that would lose
 *          precision and double-count against the disclosed multiplier).
 *   [P4]   `BEAAPI` / `Results` / `Data` absent or non-array ⇒ driftError — BUT
 *          ONLY after the Results.Error check (an Error response is P2, not drift).
 *   [SSRF] fixed host `apps.bea.gov`; `tableName` ^[A-Za-z0-9]{2,20}$; `geoFips`
 *          ^[A-Za-z0-9]{2,10}$; `lineCode` ^([0-9]{1,4}|ALL)$; `year`
 *          ^\d{4}$|LAST5|ALL; `frequency` {A,Q}. All VALUES ride URLSearchParams;
 *          the key rides `UserID=` ONLY.
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so a `num` regression fails together across sources. NO local
// num/str; the sentinel/comma-strip map is a WRAPPER around num, not a fork.
export { num };
// ─── SSRF core: the single fixed host + base path ─────────────────
export const BEA_HOST = "apps.bea.gov";
const BEA_PATH = "/api/data";
// HOST+path label — surfaces in ToolError.upstreamEndpoint; the key rides ONLY in
// the UserID= query param, so no token can ever appear here.
const BEA_LABEL = "bea:/api/data";
// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
const TABLE_RE = /^[A-Za-z0-9]{2,20}$/; // e.g. CAGDP2, SAGDP2N, CAINC1
const GEOFIPS_RE = /^[A-Za-z0-9]{2,10}$/; // STATE | county FIPS | MSA code
const LINECODE_RE = /^([0-9]{1,4}|ALL)$/; // industry line, or ALL
const YEAR_RE = /^\d{4}$/; // a single 4-digit year
const YEAR_KEYWORDS = new Set(["LAST5", "ALL"]);
const FREQUENCIES = new Set(["A", "Q"]);
const DEFAULT_YEAR = "LAST5";
const DEFAULT_FREQUENCY = "A";
// BEA encodes a suppressed / not-available cell as one of these string codes in
// DataValue: (NA)=not available, (D)=disclosure-suppressed, (NM)=not meaningful,
// (L)=less than half the unit, *=statistically insignificant. Any of these — and
// any non-numeric value after the comma-strip — is a data-absence marker, NEVER a
// number and NEVER 0.
const BEA_SUPPRESSION = new Set(["(NA)", "(D)", "(NM)", "(L)", "*"]);
// ─── Honesty notes (ADR-0051 required set) ────────────────────────
const KEY_REQUIRED_NOTE = "This source REQUIRES a free BEA_API_KEY (the BEA Data API has no keyless tier). The key is sent ONLY as the UserID= query parameter to apps.bea.gov and is NEVER logged, echoed, or placed in this response.";
const DATAVALUE_NOTE = "dataValue is parsed from BEA's comma-formatted DataValue string ('1,234,567' → 1234567). BEA suppression/not-available codes ((NA)/(D)/(NM)/(L)/*) map to null (withheld) — NEVER 0 (a genuine 0 is preserved as 0).";
const UNIT_MULT_NOTE = "unitMult is BEA's UNIT_MULT (a power-of-10 multiplier) and unitOfMeasure is CL_UNIT (the unit label). The raw dataValue is surfaced ALONGSIDE unitMult and is NOT multiplied by it — apply unitMult yourself if a scaled figure is needed (multiplying here would lose precision and double-count).";
const NO_PAGINATION_NOTE = "BEA GetData returns the COMPLETE set of rows matching the filter (no server-side pagination); totalAvailable equals the number of rows returned. Narrow with geoFips / lineCode / year to reduce the row count.";
// ─── The key seam (REQUIRED; value NEVER leaked past the UserID= param) ──
/** Read BEA_API_KEY from env; trim; return the value or undefined (unset/blank). */
export function beaApiKey() {
    const raw = process.env.BEA_API_KEY;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed ? trimmed : undefined;
}
/**
 * num(), but for BEA's comma-formatted DataValue string. Strips a suppression code
 * ((NA)/(D)/(NM)/(L)/*) → null, otherwise removes thousands commas and defers to
 * num (so "1,234,567" ⇒ 1234567, a genuine "0" ⇒ 0, and any residual non-numeric
 * ⇒ null — NEVER a fabricated 0).
 */
export function beaDataValue(v) {
    if (typeof v === "string") {
        const s = v.trim();
        if (s === "" || BEA_SUPPRESSION.has(s))
            return null;
        return num(s.replace(/,/g, ""));
    }
    return num(v);
}
/**
 * Fetch BEA Regional Economic Accounts rows for a table × geography × line filter
 * → normalized rows + summarized BEA Notes + honest `_meta`. REQUIRES BEA_API_KEY
 * (throws invalid_input pre-fetch when unset). ★A missing/invalid key (and any bad
 * parameter) surfaces as an HTTP-200 `BEAAPI.Results.Error` carrier which is
 * detected and thrown as invalid_input BEFORE the Data-array shape check.
 */
export async function regionalData(args) {
    // ── [KEY] REQUIRED key — throw an honest config error BEFORE any fetch. ──
    const key = beaApiKey();
    if (key === undefined) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "BEA Regional Economic Accounts requires a free API key. Get one at https://apps.bea.gov/API/signup/ and set BEA_API_KEY.",
            upstreamEndpoint: BEA_LABEL,
        });
    }
    // ── Validate + default the inputs (belt-and-suspenders behind the server Zod;
    //    a DIRECT handler call bypasses Zod). All ride in the query string. ──
    const tableName = args.tableName ?? "";
    if (!TABLE_RE.test(tableName)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid tableName ${JSON.stringify(tableName)} — expected a BEA Regional table code (^[A-Za-z0-9]{2,20}$), e.g. "CAGDP2" (county GDP by industry), "SAGDP2N" (state GDP), "CAINC1" (personal income).`,
            upstreamEndpoint: BEA_LABEL,
        });
    }
    const geoFips = args.geoFips ?? "";
    if (!GEOFIPS_RE.test(geoFips)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid geoFips ${JSON.stringify(geoFips)} — expected a BEA GeoFips selector (^[A-Za-z0-9]{2,10}$), e.g. "STATE" (all states), a county FIPS like "06075", or an MSA code.`,
            upstreamEndpoint: BEA_LABEL,
        });
    }
    const lineCode = args.lineCode ?? "";
    if (!LINECODE_RE.test(lineCode)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid lineCode ${JSON.stringify(lineCode)} — expected an integer industry line (^[0-9]{1,4}$), e.g. "1", or "ALL" for every line.`,
            upstreamEndpoint: BEA_LABEL,
        });
    }
    const year = args.year ?? DEFAULT_YEAR;
    if (!YEAR_KEYWORDS.has(year) && !YEAR_RE.test(year)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid year ${JSON.stringify(year)} — expected a 4-digit year (^\\d{4}$), "LAST5", or "ALL".`,
            upstreamEndpoint: BEA_LABEL,
        });
    }
    const frequency = args.frequency ?? DEFAULT_FREQUENCY;
    if (!FREQUENCIES.has(frequency)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid frequency ${JSON.stringify(frequency)} — expected one of A (annual), Q (quarterly).`,
            upstreamEndpoint: BEA_LABEL,
        });
    }
    // ── Build the query (all VALUES via URLSearchParams — no host/path steer; the
    //    REQUIRED key rides ONLY here in UserID=). ──
    const params = new URLSearchParams();
    params.set("UserID", key);
    params.set("method", "GetData");
    params.set("datasetname", "Regional");
    params.set("ResultFormat", "json");
    params.set("TableName", tableName);
    params.set("GeoFips", geoFips);
    params.set("LineCode", lineCode);
    params.set("Year", year);
    params.set("Frequency", frequency);
    const url = `https://${BEA_HOST}${BEA_PATH}?${params.toString()}`;
    // Belt-and-suspenders: the fixed host + strictly-validated query leave nothing to
    // steer the authority; assert the built URL cannot have been moved off-host.
    const built = new URL(url);
    if (built.hostname !== BEA_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Constructed BEA URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${BEA_HOST} over https — refusing to fetch (SSRF safety).`,
            upstreamEndpoint: BEA_LABEL,
        });
    }
    // ── Fetch through the shared envelope. The key rides UserID= ONLY (never the
    //    label/_meta); redirect:"error" fails closed on any off-host 3xx (it could
    //    carry the key away). A 5xx/timeout ⇒ upstream_unavailable THROW; a 200
    //    non-JSON body ⇒ getJson's r.json() throws a SyntaxError ⇒ we reclassify to
    //    schema_drift. ★A missing/invalid key returns HTTP 200 with an Error carrier,
    //    so it does NOT surface here — it is detected in the parse ladder below. ──
    let body;
    try {
        body = await getJson(url, { label: BEA_LABEL, redirect: "error" });
    }
    catch (e) {
        if (e instanceof SyntaxError) {
            throw driftError(BEA_LABEL, "BEA /api/data returned a non-JSON body at HTTP 200 — treating as schema drift (never read as an empty result).");
        }
        throw e; // 5xx → upstream_unavailable, 404 → not_found, 429 → rate_limited …
    }
    // ── [P4] Navigate BEAAPI.Results. An absent BEAAPI/Results is drift — BUT the
    //    Results.Error check (P2) comes FIRST below, since an error RESPONSE also
    //    carries BEAAPI.Results (with an Error member, not a Data array). ──
    const beaapi = body?.BEAAPI;
    if (beaapi === null || typeof beaapi !== "object") {
        throw driftError(BEA_LABEL, "BEA response is missing the `BEAAPI` envelope — treating as schema drift (never a fabricated empty).");
    }
    const results = beaapi.Results;
    if (results === null || typeof results !== "object") {
        throw driftError(BEA_LABEL, "BEA response is missing `BEAAPI.Results` — treating as schema drift (never a fabricated empty).");
    }
    // ── [★P2] The CRUX: a missing/invalid key (or any bad parameter) returns HTTP
    //    200 carrying `BEAAPI.Results.Error` — checked HERE, BEFORE the Data-array
    //    drift check, so an error response is surfaced as invalid_input CARRYING the
    //    APIErrorDescription (+ code), NEVER read as an empty result. ──
    const errNode = results.Error;
    if (errNode !== undefined && errNode !== null) {
        const errObj = (Array.isArray(errNode) ? errNode[0] : errNode);
        const code = str(errObj?.APIErrorCode);
        const desc = str(errObj?.APIErrorDescription);
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: desc
                ? `BEA rejected the request${code ? ` (APIErrorCode ${code})` : ""}: ${desc}. Check BEA_API_KEY and the tableName / geoFips / lineCode / year parameters.`
                : `BEA rejected the request${code ? ` (APIErrorCode ${code})` : ""} — check BEA_API_KEY and the tableName / geoFips / lineCode / year parameters.`,
            upstreamEndpoint: BEA_LABEL,
        });
    }
    // ── [P4] `Data` MUST be an array (a missing/non-array is drift, never a
    //    fabricated empty). An EMPTY array is a genuine honest-empty (below). ──
    const data = results.Data;
    if (!Array.isArray(data)) {
        throw driftError(BEA_LABEL, "BEA `BEAAPI.Results.Data` is missing or not an array — treating as schema drift (never a fabricated empty).");
    }
    // ── [P3] Map each Data row (comma-stripped/​sentinel→null DataValue; UNIT_MULT /
    //    CL_UNIT reported, NOT applied). ──
    const rows = data.map((raw) => {
        const row = (raw ?? {});
        return {
            geoFips: str(row.GeoFips),
            geoName: str(row.GeoName),
            timePeriod: str(row.TimePeriod),
            lineCode: str(row.Code),
            dataValue: beaDataValue(row.DataValue),
            unitOfMeasure: str(row.CL_UNIT),
            unitMult: num(row.UNIT_MULT),
            noteRef: str(row.NoteRef),
        };
    });
    // ── Summarize the BEA Notes (footnotes). A missing/non-array Notes ⇒ []. ──
    const notesNode = results.Notes;
    const notes = Array.isArray(notesNode)
        ? notesNode.map((raw) => {
            const n = (raw ?? {});
            return { noteRef: str(n.NoteRef), noteText: str(n.NoteText) };
        })
        : [];
    // ── [P1] The COMPLETE set for the filter (no server pagination). ──
    const totalAvailable = rows.length;
    const meta = {
        // MODE only — never the key value (K-test).
        source: "apps.bea.gov /api/data (BEA Regional Economic Accounts; BEA_API_KEY)",
        keylessMode: false, // ★KEYED — the third key-required source
        returned: rows.length,
        totalAvailable,
        filtersApplied: [
            `tableName:${tableName}`,
            `geoFips:${geoFips}`,
            `lineCode:${lineCode}`,
            `year:${year}`,
            `frequency:${frequency}`,
        ],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes: [KEY_REQUIRED_NOTE, DATAVALUE_NOTE, UNIT_MULT_NOTE, NO_PAGINATION_NOTE],
    };
    return withMeta({ rows, notes }, meta);
}
//# sourceMappingURL=bea.js.map