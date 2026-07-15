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
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { str, num } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercions (single audited copy in ./coerce.js) so a
// regression fails together across sources. NO local num/str.
export { num, str };
// ─── SSRF core: the single fixed host + module-literal path pieces ──
const CMS_HOST = "data.cms.gov";
// HOST-only label — surfaces in ToolError.upstreamEndpoint; keyless, so no token
// can ever appear here.
const CMS_LABEL = "cms-hospital:data.cms.gov";
// ★THE DATASET ID — CMS Hospital Compare "Hospital General Information" (5432
// Medicare-certified hospitals at build time). ★UPDATE IF CMS RE-IDs IT: the
// provider-data datastore keys this dataset by a short slug; CMS has historically
// kept it stable, but a re-publish could change it. The active dataset is surfaced
// to the caller in a _meta note (DATASET_NOTE) so a consumer never mistakes the
// vintage.
const CMS_HOSPITAL_DATASET_ID = "xubh-q36u";
const CMS_HOSPITAL_PATH = `/provider-data/api/1/datastore/query/${CMS_HOSPITAL_DATASET_ID}/0`;
// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
const STATE_RE = /^[A-Za-z]{2}$/; // 2-letter state/territory abbreviation
// facilityName / hospitalType ride as URLSearchParams VALUES (encoded), so these
// bounds are a sanity guard, not an SSRF necessity: letters/digits/space and common
// punctuation only (facility names carry apostrophes, &, /, -, .).
const FACILITY_NAME_RE = /^[A-Za-z0-9 &.,()/'-]{1,100}$/;
const HOSPITAL_TYPE_RE = /^[A-Za-z0-9 &.,()/'-]{1,100}$/;
const SIZE_MIN = 1;
const SIZE_MAX = 100;
const SIZE_DEFAULT = 25;
// DKAN condition operators (live-verified). state = exact; name/type = substring.
const OP_EQUALS = "=";
const OP_CONTAINS = "contains";
// ─── Honesty notes (ADR-0062 required set) ────────────────────────
const DATASET_NOTE = `Source dataset: CMS Hospital Compare "Hospital General Information" (data.cms.gov provider-data datastore "${CMS_HOSPITAL_DATASET_ID}", ~5,432 Medicare-certified hospitals) — a CMS-published snapshot, not a live/real-time feed. Update the dataset id if CMS re-publishes it.`;
const FILTER_NOTE = "Filters are applied SERVER-SIDE via DKAN conditions (AND-combined): `state` is an EXACT match; `facilityName` and `hospitalType` are case-insensitive SUBSTRING (contains) matches — so a facilityName fragment may match several hospitals. totalAvailable is the upstream's EXACT count for this filter set, not the returned-row count.";
const RATING_NOTE = "hospital_overall_rating is CMS's 1–5 star summary rating; \"Not Available\" (and any non-numeric) maps to overallRating:null (unknown), NEVER 0. This is a summary rating, NOT a clinical-quality or fitness determination.";
/**
 * Normalize the CMS `emergency_services` "Yes"/"No" flag → boolean | null.
 * "Yes"⇒true, "No"⇒false (case-insensitive); anything else (absent/""/unrecognized)
 * ⇒ null — NEVER a fabricated false (a data-absence-as-false masquerade).
 */
export function emergencyBool(x) {
    const s = str(x);
    if (s === null)
        return null;
    const low = s.toLowerCase();
    if (low === "yes")
        return true;
    if (low === "no")
        return false;
    return null;
}
/** Map ONE datastore-query row → the curated hospital shape. */
function mapHospital(row) {
    const r = (row ?? {});
    return {
        facilityId: str(r.facility_id),
        facilityName: str(r.facility_name),
        address: str(r.address),
        city: str(r.citytown),
        state: str(r.state),
        zip: str(r.zip_code),
        county: str(r.countyparish),
        phone: str(r.telephone_number),
        hospitalType: str(r.hospital_type),
        ownership: str(r.hospital_ownership),
        emergencyServices: emergencyBool(r.emergency_services),
        // [P3] "1"–"5" → number; "Not Available"/""/non-numeric → null (NEVER 0).
        // num() returns null for a non-numeric string (Number("Not Available")=NaN) and
        // for "" — exactly the P3 contract.
        overallRating: num(r.hospital_overall_rating),
    };
}
// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect:"error") ──
/**
 * GET one data.cms.gov provider-data JSON resource at a MODULE-BUILT URL (the
 * dataset id + the endpoint path are literals; all user filter VALUES are already
 * carried in the URLSearchParams `query`). Asserts the CONSTRUCTED URL's hostname
 * === the fixed host over https, and sets `redirect:"error"` (an off-host 3xx must
 * NOT be followed). Keyless — no headers.
 */
async function getCms(query) {
    const url = `https://${CMS_HOST}${CMS_HOSPITAL_PATH}?${query.toString()}`;
    const built = new URL(url);
    if (built.hostname !== CMS_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed CMS provider-data URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(CMS_HOST)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
            upstreamEndpoint: CMS_LABEL,
        });
    }
    return getJson(built.toString(), { label: CMS_LABEL, redirect: "error" });
}
/**
 * Fetch CMS Hospital Compare "Hospital General Information" rows for a state and/or
 * facility-name fragment (+ optional hospitalType) → normalized hospital rows +
 * honest `_meta`. REQUIRES state OR facilityName (an all-empty query is refused). A
 * SINGLE request: the response's top-level `count` is the EXACT per-filter total
 * (P1 — never the slice length).
 */
export async function hospitalCompare(args) {
    // ── [input guard] require state OR facilityName (never scan the whole dataset).
    //    hospitalType alone is NOT sufficient to scope. ──
    const hasState = args.state !== undefined && args.state !== "";
    const hasFacilityName = args.facilityName !== undefined && args.facilityName !== "";
    if (!hasState && !hasFacilityName) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "cms_hospital_compare requires at least `state` (2-letter) OR `facilityName` — an all-empty query would scan the entire ~5,432-hospital table and is refused. hospitalType alone is not enough; add state or facilityName and retry.",
            upstreamEndpoint: CMS_LABEL,
        });
    }
    // ── Validate + build the DKAN conditions (SSRF: charclass + URLSearchParams
    //    value). URLSearchParams encodes both the bracket key and the value. Each
    //    condition is an (property, value, operator) triple indexed by position. ──
    const query = new URLSearchParams();
    const filtersApplied = [];
    let ci = 0;
    const pushCondition = (property, value, operator) => {
        query.set(`conditions[${ci}][property]`, property);
        query.set(`conditions[${ci}][value]`, value);
        query.set(`conditions[${ci}][operator]`, operator);
        ci += 1;
    };
    if (hasState) {
        const state = args.state;
        if (!STATE_RE.test(state)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid state ${JSON.stringify(state)} — expected a 2-letter state/territory code (^[A-Za-z]{2}$), e.g. "VA".`,
                upstreamEndpoint: CMS_LABEL,
            });
        }
        pushCondition("state", state.toUpperCase(), OP_EQUALS);
        filtersApplied.push(`state:${state.toUpperCase()}`);
    }
    if (hasFacilityName) {
        const name = args.facilityName;
        if (!FACILITY_NAME_RE.test(name)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid facilityName ${JSON.stringify(name)} — allowed: letters, digits, space, & . , ( ) / ' - (≤100 chars). It is a case-insensitive substring match.`,
                upstreamEndpoint: CMS_LABEL,
            });
        }
        pushCondition("facility_name", name, OP_CONTAINS);
        filtersApplied.push(`facilityName~${name}`);
    }
    if (args.hospitalType !== undefined && args.hospitalType !== "") {
        const ht = args.hospitalType;
        if (!HOSPITAL_TYPE_RE.test(ht)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid hospitalType ${JSON.stringify(ht)} — allowed: letters, digits, space, & . , ( ) / ' - (≤100 chars). It is a case-insensitive substring match, e.g. "Acute".`,
                upstreamEndpoint: CMS_LABEL,
            });
        }
        pushCondition("hospital_type", ht, OP_CONTAINS);
        filtersApplied.push(`hospitalType~${ht}`);
    }
    // ── Coerce size / offset to bounded integers (belt-and-suspenders behind the
    //    server Zod; a DIRECT handler call bypasses Zod). ──
    let size = SIZE_DEFAULT;
    if (typeof args.size === "number" && Number.isFinite(args.size)) {
        size = Math.trunc(args.size);
        if (size < SIZE_MIN)
            size = SIZE_MIN;
        if (size > SIZE_MAX)
            size = SIZE_MAX;
    }
    let offset = 0;
    if (typeof args.offset === "number" &&
        Number.isFinite(args.offset) &&
        args.offset > 0) {
        offset = Math.trunc(args.offset);
    }
    query.set("limit", String(size));
    query.set("offset", String(offset));
    // ── The single request. Catch-ladder (cms-utilization shape): preserve the
    //    4xx/5xx/timeout ToolErrorCarrier taxonomy FIRST; reclassify a 200 non-JSON
    //    SyntaxError to schema_drift SECOND; bare-rethrow LAST. ──
    let body;
    try {
        body = await getCms(query);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(CMS_LABEL, "CMS provider-data API returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).");
        throw e;
    }
    // [P4] the body MUST be an object with a numeric `count` and an array `results`
    // (a non-array results OR a non-number count is drift, never a fabricated empty).
    const b = (body ?? {});
    if (typeof b.count !== "number" || !Number.isFinite(b.count) || !Array.isArray(b.results)) {
        throw driftError(CMS_LABEL, "CMS provider-data shape drift — the response must carry a numeric `count` and an array `results` of hospital rows.");
    }
    const totalAvailable = b.count;
    const hospitals = b.results.map(mapHospital);
    const returned = hospitals.length;
    // ── [P1] pagination. hasMore = offset+returned < total (the EXACT count). ──
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    const meta = {
        source: `${CMS_HOST} CMS Hospital Compare — Hospital General Information (keyless)`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit: size, hasMore, nextOffset },
        notes: [DATASET_NOTE, FILTER_NOTE, RATING_NOTE],
    };
    return withMeta({ hospitals }, meta);
}
//# sourceMappingURL=cms-hospital.js.map