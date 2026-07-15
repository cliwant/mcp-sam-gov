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
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { str, num } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercions (single audited copy in ./coerce.js) so a
// regression fails together across sources. NO local num/str.
export { num, str };
// ─── SSRF core: the single fixed host + module-literal path pieces ──
const EPA_HOST = "data.epa.gov";
const EPA_TABLE = "tri_facility";
// HOST+path label — surfaces in ToolError.upstreamEndpoint; keyless, so no token
// can ever appear here.
const EPA_LABEL = "epa-envirofacts:/efservice/tri_facility";
// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
// state rides as a PATH SEGMENT → strictly 2 ASCII letters (the efservice filter is
// case-insensitive; live-verified `va` === `VA`).
const STATE_RE = /^[A-Za-z]{2}$/;
// facilityName / county ride as PATH SEGMENTS after `.../CONTAINING/`. Allow only
// letters / digits / space / & / - / . (a superset of real facility names); this
// REJECTS `/` (path injection) and any other separator. `..` path-traversal is
// rejected explicitly below (the charclass permits a lone `.`, so `..` must be
// caught separately).
const NAME_RE = /^[A-Za-z0-9 &.\-]+$/;
const NAME_MAX = 100;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 25;
// ─── Honesty notes (ADR-0059 required set) ────────────────────────
const CLOSED_NOTE = "`closed` is the normalized EPA fac_closed_ind ('0'/'N' → false = active, '1'/'Y' → true = closed); an unrecognized value is null (unknown), NEVER a fabricated false. A closed facility no longer actively reports to TRI.";
const NOMINAL_NOTE = "These are EPA TRI (Toxics Release Inventory) REPORTING facilities for the geography — a nominal environmental-footprint screen, NOT a compliance, enforcement, or violation determination. Use ECHO / enforcement sources for compliance status.";
const COUNT_FALLBACK_NOTE = "The count sub-query (…/count/JSON) failed or did not report TOTALQUERYRESULTS, so totalAvailable is null (unknown) — it was NOT faked from the returned row count. hasMore is a heuristic (a full page ⇒ likely more); re-page with offset to confirm.";
/**
 * Normalize EPA's fac_closed_ind to a boolean. Live values are "0" (active) / "1"
 * (closed); the schema also documents "N"/"Y". Anything else ⇒ null (unknown) —
 * NEVER a fabricated false (P3).
 */
export function normalizeClosed(v) {
    const s = str(v);
    if (s === null)
        return null;
    const t = s.toUpperCase();
    if (t === "1" || t === "Y" || t === "YES" || t === "TRUE")
        return true;
    if (t === "0" || t === "N" || t === "NO" || t === "FALSE")
        return false;
    return null;
}
/** Map ONE efservice row → the curated facility shape (every scalar via `str`). */
function mapFacility(row) {
    const r = (row ?? {});
    return {
        triFacilityId: str(r.tri_facility_id),
        facilityName: str(r.facility_name),
        streetAddress: str(r.street_address),
        city: str(r.city_name),
        county: str(r.county_name),
        state: str(r.state_abbr),
        zip: str(r.zip_code),
        region: str(r.region),
        closed: normalizeClosed(r.fac_closed_ind),
    };
}
// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect:"error") ──
/**
 * GET one efservice JSON resource at a MODULE-BUILT path (all user values already
 * charclass-validated + encodeURIComponent-encoded by the caller). Builds
 * `https://${EPA_HOST}${path}` on the FIXED host, asserts the CONSTRUCTED URL's
 * hostname === the host over https (belt-and-suspenders), and sets
 * `redirect:"error"` (an off-host 3xx must NOT be followed). Keyless — no headers.
 */
async function getEpa(path) {
    const url = `https://${EPA_HOST}${path}`;
    const built = new URL(url);
    if (built.hostname !== EPA_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed EPA Envirofacts URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(EPA_HOST)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
            upstreamEndpoint: EPA_LABEL,
        });
    }
    return getJson(built.toString(), { label: EPA_LABEL, redirect: "error" });
}
/** Validate + encode ONE user path-segment value (facilityName / county). */
function validateName(value, field) {
    if (value.length > NAME_MAX || !NAME_RE.test(value) || value.includes("..")) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid ${field} ${JSON.stringify(value)} — allowed: letters, digits, space, & - . (≤${NAME_MAX} chars); '/' and '..' are rejected (it rides in the request PATH as a segment; it is strictly validated to prevent path injection).`,
            upstreamEndpoint: EPA_LABEL,
        });
    }
    return encodeURIComponent(value);
}
/**
 * Look up EPA TRI reporting facilities by state / facilityName / county →
 * normalized facility rows + honest `_meta`. Requires at least `state` OR
 * `facilityName` (an all-empty query is refused). Runs a count sub-query FIRST for
 * the EXACT total (P1), then the data slice; a count failure degrades to
 * totalAvailable:null + a note (never a length-faked total).
 */
export async function triFacilities(args) {
    // ── [input guard] require at least state OR facilityName (never scan the whole
    //    national table). ──
    const hasState = args.state !== undefined && args.state !== "";
    const hasName = args.facilityName !== undefined && args.facilityName !== "";
    if (!hasState && !hasName) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "epa_tri_facilities requires at least `state` (2-letter, e.g. 'VA') OR `facilityName` — an all-empty query would scan the entire national TRI table and is refused. Add a filter and retry.",
            upstreamEndpoint: EPA_LABEL,
        });
    }
    // ── Validate + build the filter path segments (SSRF: charclass + encode each). ──
    const segments = ["efservice", EPA_TABLE];
    const filtersApplied = [];
    if (hasState) {
        const state = args.state;
        if (!STATE_RE.test(state)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid state ${JSON.stringify(state)} — expected a 2-letter state code (^[A-Za-z]{2}$), e.g. "VA" (it rides in the request PATH; it is strictly validated).`,
                upstreamEndpoint: EPA_LABEL,
            });
        }
        segments.push("state_abbr", encodeURIComponent(state));
        filtersApplied.push(`state:${state}`);
    }
    if (hasName) {
        const enc = validateName(args.facilityName, "facilityName");
        segments.push("facility_name", "CONTAINING", enc);
        filtersApplied.push(`facilityName~${args.facilityName}`);
    }
    if (args.county !== undefined && args.county !== "") {
        const enc = validateName(args.county, "county");
        segments.push("county_name", "CONTAINING", enc);
        filtersApplied.push(`county~${args.county}`);
    }
    // ── Coerce limit / offset to non-negative integers (belt-and-suspenders behind
    //    the server Zod; a DIRECT handler call bypasses Zod). ──
    let limit = LIMIT_DEFAULT;
    if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
        limit = Math.trunc(args.limit);
        if (limit < LIMIT_MIN)
            limit = LIMIT_MIN;
        if (limit > LIMIT_MAX)
            limit = LIMIT_MAX;
    }
    let offset = 0;
    if (typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset > 0) {
        offset = Math.trunc(args.offset);
    }
    const filterPath = "/" + segments.join("/");
    // ── (1) The COUNT sub-query FIRST (best-effort — the EXACT total, P1). Any
    //    failure (network/5xx/drift/missing field) degrades to totalAvailable:null +
    //    a disclosing note; it NEVER throws and NEVER fakes the total from the slice
    //    length. ──
    let totalAvailable = null;
    let countFailed = false;
    try {
        const countBody = await getEpa(`${filterPath}/count/JSON`);
        if (Array.isArray(countBody) &&
            countBody.length > 0 &&
            countBody[0] !== null &&
            typeof countBody[0] === "object") {
            const t = num(countBody[0].TOTALQUERYRESULTS);
            if (t !== null && t >= 0) {
                totalAvailable = t;
            }
            else {
                countFailed = true; // present body but no usable TOTALQUERYRESULTS (P4)
            }
        }
        else {
            countFailed = true; // count body not the expected [{...}] shape
        }
    }
    catch {
        countFailed = true; // any count error ⇒ degrade, never propagate (P1)
    }
    // ── (2) The DATA slice — the authoritative request. efservice rows are INCLUSIVE
    //    on both ends: rows/{offset}:{offset+limit-1}. Its errors follow P2. ──
    const end = offset + limit - 1;
    const dataPath = `${filterPath}/rows/${offset}:${end}/JSON`;
    // Catch-ladder (datagov-catalog shape, VERBATIM): preserve the 4xx/5xx/timeout
    // ToolErrorCarrier taxonomy FIRST; reclassify a 200 non-JSON SyntaxError to
    // schema_drift SECOND; bare-rethrow LAST.
    let body;
    try {
        body = await getEpa(dataPath);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(EPA_LABEL, "EPA Envirofacts returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).");
        throw e;
    }
    // [P4] the data body MUST be an array (a non-array 200 is drift, never a
    // fabricated empty).
    if (!Array.isArray(body)) {
        throw driftError(EPA_LABEL, "EPA Envirofacts shape drift — the /rows/…/JSON response must be a JSON array of facilities.");
    }
    const facilities = body.map(mapFacility);
    const returned = facilities.length;
    // ── [P1] pagination. total known ⇒ hasMore = offset+returned < total; total
    //    unknown (count degraded) ⇒ a full page is the honest heuristic for "more". ──
    const hasMore = totalAvailable !== null
        ? offset + returned < totalAvailable
        : returned === limit;
    const nextOffset = hasMore ? offset + returned : null;
    const notes = [CLOSED_NOTE, NOMINAL_NOTE];
    if (countFailed)
        notes.push(COUNT_FALLBACK_NOTE);
    const meta = {
        source: `${EPA_HOST} EPA Envirofacts /efservice/${EPA_TABLE} (TRI facilities; keyless)`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    };
    return withMeta({ facilities }, meta);
}
//# sourceMappingURL=epa-envirofacts.js.map