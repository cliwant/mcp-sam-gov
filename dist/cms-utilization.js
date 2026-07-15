/**
 * cms-utilization.ts — CMS Medicare Physician & Other Practitioners "by Provider
 * and Service" utilization (`data.cms.gov`, the data-API v1 dataset endpoint;
 * ADR-0061). KEYLESS.
 *
 * WHAT IT ADDS: `cms_medicare_provider_services` — a healthcare-market /
 * competitor-utilization lane: for a given provider (NPI) or state, what Medicare
 * Part-B services (HCPCS) did providers render, to how many beneficiaries, at what
 * submitted / Medicare-allowed / Medicare-paid amounts. The demand-side complement
 * to NPPES (who the providers ARE) — this is what they actually BILL.
 *
 * ★THE TWO-REQUEST PATTERN (the load-bearing P1 honesty — MIRRORS epa-envirofacts):
 *   the data-API's `/data` slice is a bare JSON array that reports NO total. So the
 *   EXACT total for a filter comes from a SEPARATE count sub-query — the identical
 *   `filter[...]` on the `/data-viewer/stats` endpoint returns
 *   `{ "data": { "found_rows": N, "total_rows": M } }`. This tool runs the stats
 *   count FIRST (best-effort) then the data slice: totalAvailable = found_rows (P1,
 *   the per-filter EXACT total), NEVER the returned rows' length. If the stats
 *   sub-query fails or is absent, totalAvailable falls to null + a disclosing note
 *   (never a length-faked total) and the data slice still returns.
 *
 * ★THE FILTER-REQUIRED INPUT GUARD: the table is 9.78M rows. An all-empty query
 *   (no npi, no state) is REFUSED with invalid_input (0 fetch) — providerType /
 *   hcpcsCode alone are NOT enough to scope; a caller MUST pin npi OR state.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error") / `driftError` (datasource.ts), `str`/`num` (coerce.ts,
 * null-never-empty-string / null-never-0), and `withMeta`·`buildMeta` (meta.ts,
 * offset pagination + totalAvailable). It MIRRORS census-economic.ts's fixed-host
 * SSRF idiom (a single host const + a post-construction hostname/protocol assertion
 * + redirect:"error") and epa-envirofacts.ts's count-first two-request pattern +
 * schema_drift catch-ladder (ToolErrorCarrier rethrow FIRST so a 5xx keeps its
 * taxonomy → SyntaxError→driftError → bare rethrow).
 *
 *   GET https://data.cms.gov/data-api/v1/dataset/{uuid}/data-viewer/stats
 *       ?filter[Rndrng_Prvdr_State_Abrvtn]=VA          (the COUNT sub-query)
 *       → { "data": { "found_rows": 278254, "total_rows": 9781673 } }
 *   GET https://data.cms.gov/data-api/v1/dataset/{uuid}/data
 *       ?size=&offset=&filter[Rndrng_Prvdr_State_Abrvtn]=VA     (the DATA slice)
 *       → [ { Rndrng_NPI, Rndrng_Prvdr_Last_Org_Name, …, Avg_Mdcr_Pymt_Amt }, … ]
 *
 * ★ SSRF: the host is a compile-time literal (`CMS_HOST`); the dataset UUID + the
 *   endpoint paths are MODULE literals. Every USER filter value rides as a
 *   URLSearchParams VALUE (`filter[Col]=Val`) — URLSearchParams encodes the bracket
 *   key AND the value, so a value can never break out into the path or inject a
 *   parameter. npi is `^\d{10}$`; state `^[A-Za-z]{2}$`; hcpcsCode `^[A-Za-z0-9]{1,10}$`;
 *   providerType is a bounded free-text charclass; size/offset are coerced to
 *   integers. A post-construction hostname/protocol assertion + `redirect:"error"`
 *   fail closed on any off-host 3xx.
 *
 * ★ PII NOTE: this is public PROVIDER-level AGGREGATE data — no patient identifiers.
 *   Provider name / practice address / NPI is public professional information (the
 *   same public surface as NPPES), so it is fine to surface.
 *
 * ★ HONESTY (ADR-0061 P1–P5, live-verified 2026-07-15 on data.cms.gov):
 *   [input] require npi OR state — an all-empty query is REFUSED (0 fetch) so the
 *           whole 9.78M-row table is never scanned.
 *   [P1]    totalAvailable = the stats sub-query's found_rows (EXACT — e.g. VA =
 *           278254), NOT the slice length. hasMore = offset+returned < total. Stats
 *           fails/absent ⇒ totalAvailable:null + a disclosing note.
 *   [P2]    an empty array ⇒ honest empty (returned:0). getJson maps a 4xx/5xx via
 *           errorFromResponse and THROWS (503 ⇒ upstream_unavailable, 400 ⇒
 *           invalid_input, 404 ⇒ not_found); a 200 non-array/non-JSON body ⇒
 *           schema_drift (NEVER a fabricated empty).
 *   [P3]    Tot_ / Avg_ fields via num() (numeric strings → numbers; a real 0 stays 0;
 *           absent ⇒ null, never 0-faked); NPI/codes/HCPCS/names as strings
 *           (null-never-empty-string).
 *   [P4]    a data body that is not an array ⇒ driftError; a stats body missing
 *           found_rows ⇒ totalAvailable:null (handled, not a crash).
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
const CMS_LABEL = "cms-utilization:data.cms.gov";
// ★THE DATASET UUID — a SPECIFIC ANNUAL VINTAGE of "Medicare Physician & Other
// Practitioners — by Provider and Service" (9,781,673 rows at build time, the most
// recent published year). ★UPDATE YEARLY: CMS publishes a NEW uuid for each new
// calendar year of utilization; this constant pins ONE vintage. The active vintage
// is surfaced to the caller in a _meta note (VINTAGE_NOTE) so a consumer never
// mistakes it for "current" or an unspecified year.
const CMS_DATASET_UUID = "92396110-2aed-4d63-a6a2-5d6207d46a29";
// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
const NPI_RE = /^\d{10}$/; // a 10-digit National Provider Identifier
const STATE_RE = /^[A-Za-z]{2}$/; // 2-letter state/territory abbreviation
const HCPCS_RE = /^[A-Za-z0-9]{1,10}$/; // HCPCS/CPT code, e.g. "97110", "G0463"
// providerType is a specialty label, e.g. "Physical Therapist in Private Practice".
// It rides as a URLSearchParams VALUE (encoded), so this bound is a sanity guard,
// not an SSRF necessity: letters/digits/space and common punctuation only.
const PROVIDER_TYPE_RE = /^[A-Za-z0-9 &.,()/'-]{1,100}$/;
const SIZE_MIN = 1;
const SIZE_MAX = 100;
const SIZE_DEFAULT = 25;
// ─── Honesty notes (ADR-0061 required set) ────────────────────────
const VINTAGE_NOTE = `Source dataset: CMS "Medicare Physician & Other Practitioners — by Provider and Service" (data.cms.gov dataset ${CMS_DATASET_UUID}) — a SPECIFIC ANNUAL VINTAGE (the most recent published year at build time), NOT a live/current or a multi-year figure. Amounts and service counts are as-of that reference year. CMS publishes a new dataset id each year.`;
const AGGREGATE_NOTE = "These are public PROVIDER-level AGGREGATE utilization figures (no patient identifiers). Averages (avgSubmittedCharge / avgMedicareAllowed / avgMedicarePayment) are per-service means for the provider+HCPCS row; totalBeneficiaries is CMS-rounded and suppressed below 11 in the source. This is a utilization snapshot, NOT a fraud, quality, or fitness determination.";
const COUNT_FALLBACK_NOTE = "The count sub-query (…/data-viewer/stats) failed or did not report found_rows, so totalAvailable is null (unknown) — it was NOT faked from the returned row count. hasMore is a heuristic (a full page ⇒ likely more); re-page with offset to confirm.";
/**
 * Join the CMS Last_Org_Name + First_Name into one display name. An ORGANIZATION
 * row (entity code "O") carries the org name in Last_Org_Name with an empty
 * First_Name ⇒ just the org name. An INDIVIDUAL carries both ⇒ "Last, First".
 * Either absent ⇒ the present one; both absent ⇒ null (never a fabricated "").
 */
export function joinProviderName(lastOrg, first) {
    const last = str(lastOrg);
    const firstName = str(first);
    if (last !== null && firstName !== null)
        return `${last}, ${firstName}`;
    return last ?? firstName ?? null;
}
/** Map ONE data-API row → the curated provider-service shape. */
function mapService(row) {
    const r = (row ?? {});
    return {
        npi: str(r.Rndrng_NPI),
        providerName: joinProviderName(r.Rndrng_Prvdr_Last_Org_Name, r.Rndrng_Prvdr_First_Name),
        credentials: str(r.Rndrng_Prvdr_Crdntls),
        providerType: str(r.Rndrng_Prvdr_Type),
        city: str(r.Rndrng_Prvdr_City),
        state: str(r.Rndrng_Prvdr_State_Abrvtn),
        zip: str(r.Rndrng_Prvdr_Zip5),
        hcpcsCode: str(r.HCPCS_Cd),
        hcpcsDescription: str(r.HCPCS_Desc),
        totalBeneficiaries: num(r.Tot_Benes),
        totalServices: num(r.Tot_Srvcs),
        avgSubmittedCharge: num(r.Avg_Sbmtd_Chrg),
        avgMedicareAllowed: num(r.Avg_Mdcr_Alowd_Amt),
        avgMedicarePayment: num(r.Avg_Mdcr_Pymt_Amt),
    };
}
// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect:"error") ──
/**
 * GET one data.cms.gov JSON resource at a MODULE-BUILT URL (the dataset UUID + the
 * endpoint path are literals; all user filter VALUES are already carried in the
 * URLSearchParams `query`). Asserts the CONSTRUCTED URL's hostname === the fixed
 * host over https, and sets `redirect:"error"` (an off-host 3xx must NOT be
 * followed). Keyless — no headers.
 */
async function getCms(path, query) {
    const url = `https://${CMS_HOST}${path}?${query.toString()}`;
    const built = new URL(url);
    if (built.hostname !== CMS_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed CMS data-API URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(CMS_HOST)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
            upstreamEndpoint: CMS_LABEL,
        });
    }
    return getJson(built.toString(), { label: CMS_LABEL, redirect: "error" });
}
/**
 * Fetch Medicare Part-B provider-service utilization rows for an NPI / state (+
 * optional providerType / hcpcsCode) → normalized service rows + honest `_meta`.
 * REQUIRES npi OR state (an all-empty query is refused). Runs a stats count
 * sub-query FIRST for the EXACT total (P1), then the data slice; a count failure
 * degrades to totalAvailable:null + a note (never a length-faked total).
 */
export async function providerServices(args) {
    // ── [input guard] require npi OR state (never scan the whole 9.78M-row table).
    //    providerType / hcpcsCode alone are NOT sufficient to scope. ──
    const hasNpi = args.npi !== undefined && args.npi !== "";
    const hasState = args.state !== undefined && args.state !== "";
    if (!hasNpi && !hasState) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "cms_medicare_provider_services requires at least `npi` (10-digit) OR `state` (2-letter) — an all-empty query would scan the entire 9.78M-row Medicare utilization table and is refused. providerType/hcpcsCode alone are not enough; add npi or state and retry.",
            upstreamEndpoint: CMS_LABEL,
        });
    }
    // ── Validate + build the filter params (SSRF: charclass + URLSearchParams value).
    //    URLSearchParams encodes both the bracket key and the value. ──
    const filters = new URLSearchParams();
    const filtersApplied = [];
    if (hasNpi) {
        const npi = args.npi;
        if (!NPI_RE.test(npi)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid npi ${JSON.stringify(npi)} — expected a 10-digit National Provider Identifier (^\\d{10}$).`,
                upstreamEndpoint: CMS_LABEL,
            });
        }
        filters.set("filter[Rndrng_NPI]", npi);
        filtersApplied.push(`npi:${npi}`);
    }
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
        filters.set("filter[Rndrng_Prvdr_State_Abrvtn]", state.toUpperCase());
        filtersApplied.push(`state:${state.toUpperCase()}`);
    }
    if (args.providerType !== undefined && args.providerType !== "") {
        const pt = args.providerType;
        if (!PROVIDER_TYPE_RE.test(pt)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid providerType ${JSON.stringify(pt)} — allowed: letters, digits, space, & . , ( ) / ' - (≤100 chars).`,
                upstreamEndpoint: CMS_LABEL,
            });
        }
        filters.set("filter[Rndrng_Prvdr_Type]", pt);
        filtersApplied.push(`providerType:${pt}`);
    }
    if (args.hcpcsCode !== undefined && args.hcpcsCode !== "") {
        const hcpcs = args.hcpcsCode;
        if (!HCPCS_RE.test(hcpcs)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid hcpcsCode ${JSON.stringify(hcpcs)} — expected an alphanumeric HCPCS/CPT code (^[A-Za-z0-9]{1,10}$), e.g. "97110" or "G0463".`,
                upstreamEndpoint: CMS_LABEL,
            });
        }
        filters.set("filter[HCPCS_Cd]", hcpcs.toUpperCase());
        filtersApplied.push(`hcpcsCode:${hcpcs.toUpperCase()}`);
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
    if (typeof args.offset === "number" && Number.isFinite(args.offset) && args.offset > 0) {
        offset = Math.trunc(args.offset);
    }
    const dataBase = `/data-api/v1/dataset/${CMS_DATASET_UUID}/data`;
    const statsPath = `/data-api/v1/dataset/${CMS_DATASET_UUID}/data-viewer/stats`;
    // ── (1) The COUNT sub-query FIRST (best-effort — the EXACT total, P1). The stats
    //    body is `{ data: { found_rows, total_rows } }`. Any failure (network/5xx/
    //    drift/missing field) degrades to totalAvailable:null + a disclosing note; it
    //    NEVER throws and NEVER fakes the total from the slice length. ──
    let totalAvailable = null;
    let countFailed = false;
    try {
        const statsBody = await getCms(statsPath, filters);
        const dataObj = statsBody !== null &&
            typeof statsBody === "object" &&
            typeof statsBody.data === "object" &&
            statsBody.data !== null
            ? statsBody.data
            : undefined;
        if (dataObj !== undefined) {
            const t = num(dataObj.found_rows);
            if (t !== null && t >= 0) {
                totalAvailable = t;
            }
            else {
                countFailed = true; // present body but no usable found_rows (P4)
            }
        }
        else {
            countFailed = true; // stats body not the expected { data: {…} } shape
        }
    }
    catch {
        countFailed = true; // any count error ⇒ degrade, never propagate (P1)
    }
    // ── (2) The DATA slice — the authoritative request (a bare JSON array). ──
    const dataQuery = new URLSearchParams(filters);
    dataQuery.set("size", String(size));
    dataQuery.set("offset", String(offset));
    // Catch-ladder (epa-envirofacts / datagov-catalog shape): preserve the
    // 4xx/5xx/timeout ToolErrorCarrier taxonomy FIRST; reclassify a 200 non-JSON
    // SyntaxError to schema_drift SECOND; bare-rethrow LAST.
    let body;
    try {
        body = await getCms(dataBase, dataQuery);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(CMS_LABEL, "CMS data-API returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).");
        throw e;
    }
    // [P4] the data body MUST be an array (a non-array 200 is drift, never a
    // fabricated empty).
    if (!Array.isArray(body)) {
        throw driftError(CMS_LABEL, "CMS data-API shape drift — the /data response must be a JSON array of provider-service rows.");
    }
    const services = body.map(mapService);
    const returned = services.length;
    // ── [P1] pagination. total known ⇒ hasMore = offset+returned < total; total
    //    unknown (count degraded) ⇒ a full page is the honest heuristic for "more". ──
    const hasMore = totalAvailable !== null
        ? offset + returned < totalAvailable
        : returned === size;
    const nextOffset = hasMore ? offset + returned : null;
    const notes = [VINTAGE_NOTE, AGGREGATE_NOTE];
    if (countFailed)
        notes.push(COUNT_FALLBACK_NOTE);
    const meta = {
        source: `${CMS_HOST} CMS Medicare Physician & Other Practitioners — by Provider and Service (keyless)`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit: size, hasMore, nextOffset },
        notes,
    };
    return withMeta({ services }, meta);
}
//# sourceMappingURL=cms-utilization.js.map