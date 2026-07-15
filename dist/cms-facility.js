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
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { str } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js) so a
// regression fails together across sources. NO local str.
export { str };
// ─── SSRF core: the single fixed host + module-literal endpoint prefix ──
const CMS_HOST = "data.cms.gov";
// HOST-only label — surfaces in ToolError.upstreamEndpoint; keyless, so no token
// can ever appear here.
const CMS_LABEL = "cms-facility:data.cms.gov";
const CMS_PATH_PREFIX = "/provider-data/api/1/datastore/query";
const CMS_PATH_SUFFIX = "/0";
const FACILITY_DATASETS = {
    nursing_home: {
        id: "4pq5-n9py",
        nameColumn: "provider_name",
        label: 'CMS "Provider Information" (Nursing Home / Long-Term Care; ~14,695 Medicare/Medicaid-certified nursing homes)',
    },
    home_health: {
        id: "6jpm-sxkc",
        nameColumn: "provider_name",
        label: 'CMS "Home Health Care Agencies" (~12,460 Medicare-certified home health agencies)',
    },
    hospice: {
        id: "yc9t-dgbk",
        nameColumn: "facility_name",
        label: 'CMS "Hospice Provider Information" (~6,852 Medicare-certified hospices)',
    },
    dialysis: {
        id: "23ew-n7w9",
        nameColumn: "facility_name",
        label: 'CMS "Dialysis Facility" (~7,490 Medicare-certified dialysis facilities)',
    },
};
// The valid enum keys — a belt-and-suspenders re-guard behind the server Zod (a
// DIRECT handler call bypasses Zod). An unknown key ⇒ invalid_input, 0 fetch.
const FACILITY_TYPES = Object.keys(FACILITY_DATASETS);
// ─── Coalescing candidate orders (the field-name variance across datasets) ──
// Each output field probes these source columns IN ORDER; the first non-null (via
// str(), which nulls ""/whitespace/"null") wins; null if NONE present. NEVER an
// empty string, NEVER a fabricated value.
const NAME_FIELDS = ["provider_name", "facility_name", "legal_business_name"];
const ADDRESS_FIELDS = ["address", "provider_address", "address_line_1"];
const OWNERSHIP_FIELDS = ["ownership_type", "type_of_ownership", "profit_or_nonprofit"];
// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
const STATE_RE = /^[A-Za-z]{2}$/; // 2-letter state/territory abbreviation
// facilityName rides as a URLSearchParams VALUE (encoded), so this bound is a sanity
// guard, not an SSRF necessity: letters/digits/space and common punctuation only
// (facility names carry apostrophes, &, /, -, .).
const FACILITY_NAME_RE = /^[A-Za-z0-9 &.,()/'-]{1,100}$/;
const SIZE_MIN = 1;
const SIZE_MAX = 100;
const SIZE_DEFAULT = 25;
// DKAN condition operators (live-verified). state = exact; name = substring.
const OP_EQUALS = "=";
const OP_CONTAINS = "contains";
// ─── Honesty notes (ADR-0063 required set) ────────────────────────
const COALESCE_NOTE = "Field names vary across the four CMS provider-data datasets — `name`, `address`, and `ownership` are COALESCED over per-dataset candidate columns (name: provider_name/facility_name/legal_business_name; address: address/provider_address/address_line_1; ownership: ownership_type/type_of_ownership/profit_or_nonprofit). A field absent in the chosen dataset is null (unknown), NEVER an empty string and NEVER fabricated.";
const FILTER_NOTE = "Filters are applied SERVER-SIDE via DKAN conditions (AND-combined): `state` is an EXACT match; `facilityName` is a case-insensitive SUBSTRING (contains) match against the dataset's primary-name column — so a facilityName fragment may match several facilities. totalAvailable is the upstream's EXACT count for this filter set, not the returned-row count.";
/**
 * Coalesce a row's value over a candidate column order → string | null.
 * Returns the FIRST column whose str() is non-null (str nulls ""/whitespace/"null");
 * null if NONE — NEVER an empty string, NEVER a fabricated value (P3).
 */
export function coalesceField(row, fields) {
    for (const f of fields) {
        const v = str(row[f]);
        if (v !== null)
            return v;
    }
    return null;
}
/** Map ONE datastore-query row → the curated facility shape for `facilityType`. */
function mapFacility(row, facilityType) {
    const r = (row ?? {});
    return {
        // [P3] name/address/ownership coalesced over candidate columns; null-never-empty.
        name: coalesceField(r, NAME_FIELDS),
        address: coalesceField(r, ADDRESS_FIELDS),
        city: str(r.citytown),
        state: str(r.state),
        zip: str(r.zip_code),
        // Echo the input facilityType (the caller's chosen lane).
        facilityType,
        ownership: coalesceField(r, OWNERSHIP_FIELDS),
    };
}
// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect:"error") ──
/**
 * GET one data.cms.gov provider-data JSON resource at a MODULE-BUILT URL. The dataset
 * id is a VETTED value from FACILITY_DATASETS (never the user string); the endpoint
 * path is built from module literals; all user filter VALUES are already carried in
 * the URLSearchParams `query`. Asserts the CONSTRUCTED URL's hostname === the fixed
 * host over https, and sets `redirect:"error"` (an off-host 3xx must NOT be
 * followed). Keyless — no headers.
 */
async function getCms(datasetId, query) {
    const path = `${CMS_PATH_PREFIX}/${datasetId}${CMS_PATH_SUFFIX}`;
    const url = `https://${CMS_HOST}${path}?${query.toString()}`;
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
 * Fetch CMS provider-data facility rows for a `facilityType` (+ optional state /
 * facility-name fragment) → normalized facility rows + honest `_meta`. The
 * facilityType (a Zod enum) indexes the FACILITY_DATASETS constant map to a vetted
 * dataset id — the user value never enters the path. A SINGLE request: the response's
 * top-level `count` is the EXACT per-filter total (P1 — never the slice length).
 */
export async function facilityDirectory(args) {
    // ── [SSRF/input] resolve facilityType → the vetted dataset (belt-and-suspenders
    //    behind the server Zod enum; a DIRECT handler call bypasses Zod). An unknown/
    //    absent facilityType ⇒ invalid_input, 0 fetch. ──
    const ft = args.facilityType;
    if (ft === undefined || !Object.prototype.hasOwnProperty.call(FACILITY_DATASETS, ft)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid or missing facilityType ${JSON.stringify(ft)} — expected one of: ${FACILITY_TYPES.join(", ")}.`,
            upstreamEndpoint: CMS_LABEL,
        });
    }
    const facilityType = ft;
    const dataset = FACILITY_DATASETS[facilityType];
    // ── Validate + build the DKAN conditions (SSRF: charclass + URLSearchParams
    //    value). URLSearchParams encodes both the bracket key and the value. Each
    //    condition is an (property, value, operator) triple indexed by position. ──
    const query = new URLSearchParams();
    const filtersApplied = [`facilityType:${facilityType}`];
    let ci = 0;
    const pushCondition = (property, value, operator) => {
        query.set(`conditions[${ci}][property]`, property);
        query.set(`conditions[${ci}][value]`, value);
        query.set(`conditions[${ci}][operator]`, operator);
        ci += 1;
    };
    if (args.state !== undefined && args.state !== "") {
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
    if (args.facilityName !== undefined && args.facilityName !== "") {
        const name = args.facilityName;
        if (!FACILITY_NAME_RE.test(name)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid facilityName ${JSON.stringify(name)} — allowed: letters, digits, space, & . , ( ) / ' - (≤100 chars). It is a case-insensitive substring match.`,
                upstreamEndpoint: CMS_LABEL,
            });
        }
        // The name column varies per dataset (provider_name vs facility_name).
        pushCondition(dataset.nameColumn, name, OP_CONTAINS);
        filtersApplied.push(`facilityName~${name}`);
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
    // ── The single request. Catch-ladder (cms-hospital shape): preserve the
    //    4xx/5xx/timeout ToolErrorCarrier taxonomy FIRST; reclassify a 200 non-JSON
    //    SyntaxError to schema_drift SECOND; bare-rethrow LAST. ──
    let body;
    try {
        body = await getCms(dataset.id, query);
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
    if (typeof b.count !== "number" ||
        !Number.isFinite(b.count) ||
        !Array.isArray(b.results)) {
        throw driftError(CMS_LABEL, "CMS provider-data shape drift — the response must carry a numeric `count` and an array `results` of facility rows.");
    }
    const totalAvailable = b.count;
    const facilities = b.results.map((row) => mapFacility(row, facilityType));
    const returned = facilities.length;
    // ── [P1] pagination. hasMore = offset+returned < total (the EXACT count). ──
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    const DATASET_NOTE = `Source dataset: ${dataset.label} — data.cms.gov provider-data datastore "${dataset.id}". A CMS-published snapshot, not a live/real-time feed. Update the dataset id if CMS re-publishes it.`;
    const meta = {
        source: `${CMS_HOST} CMS provider-data facility directory — ${facilityType} (keyless)`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit: size, hasMore, nextOffset },
        notes: [DATASET_NOTE, COALESCE_NOTE, FILTER_NOTE],
    };
    return withMeta({ facilities }, meta);
}
//# sourceMappingURL=cms-facility.js.map