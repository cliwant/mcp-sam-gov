/**
 * gsa-perdiem.ts — GSA Federal Travel Per-Diem lookup (`api.gsa.gov`, base
 * `/travel/perdiem/v2`) — ADR-0050. The lodging + M&IE rate ceilings the federal
 * government reimburses for official travel, by city/state or ZIP for a given year.
 *
 * WHAT IT ADDS: a NEW travel-cost lane (the per-diem authority) on the SAME
 * `api.gsa.gov` host as datagov-catalog.ts, so it REUSES the audited `datagovKey.ts`
 * key seam VERBATIM (keyHeader / keyModeLabel / pushKeyNote) — keyless by default via
 * the shared DEMO_KEY, upgraded by DATA_GOV_API_KEY. The key rides ONLY in the
 * X-Api-Key header — NEVER the URL / label / _meta / a log (the K-test). This module
 * writes ZERO fetch/coercion/error/meta code: it REUSES `getJson` (redirect:"error",
 * the X-Api-Key header) / `driftError` / `num`·`str` (coerce.ts) / `withMeta`·
 * `buildMeta`, and MIRRORS the datagov-catalog schema_drift catch-ladder verbatim.
 *
 * ★ SSRF: the host is a compile-time literal (`GSA_PERDIEM_HOST`). The two lookup
 *   modes ride FIXED path templates; every caller value (city/state/zip/year) is
 *   charclass-validated THEN `encodeURIComponent`-escaped into a single path segment
 *   (no raw passthrough, no query steer). A post-construction hostname/protocol
 *   assertion + `redirect:"error"` lock it (fail closed on any off-host 3xx — a 3xx
 *   off api.gsa.gov could carry the X-Api-Key header away).
 *
 * ★ HONESTY (ADR-0050 P1–P5, live-verified 2026-07-15):
 *   [INPUT] EITHER (city + state) OR zip — supplying BOTH, or NEITHER, ⇒ invalid_input
 *           with 0 fetch (an ambiguous/empty lookup is a caller error, never a guess).
 *   [P1]    the API returns the COMPLETE rate set for the lookup (no pagination) ⇒
 *           totalAvailable = the flattened row count, complete:true. NEVER fabricated.
 *   [P2]    `errors` non-null ⇒ invalid_input surfacing the message (never a fake
 *           empty); a genuine no-match (rates:[] / rate:[]) ⇒ honest empty (returned:0,
 *           complete:true); a 429 (DEMO_KEY ~10/hr) ⇒ rate_limited THROW honoring
 *           Retry-After; a 5xx ⇒ upstream_unavailable THROW; a 200 non-JSON ⇒
 *           schema_drift. A DOWN service is NEVER a returned:0.
 *   [P3]    `value` (monthly max lodging $) / `meals` (M&IE cap $) via `num` (null-
 *           never-0 — a genuine 0 stays 0). `standardRate` / `isOconus` are STRING
 *           booleans "true"/"false" ⇒ coerced to a real boolean (an unrecognized value
 *           ⇒ null, never a fabricated false). The months array is preserved AS-IS
 *           (never padded/fabricated to 12).
 *   [P4]    `rates` / a group's `rate` / `months.month` absent or non-array ⇒
 *           driftError (never a fabricated empty).
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
// The SHARED api.data.gov key seam (ADR-0010 §2). api.gsa.gov accepts the SAME
// DATA_GOV_API_KEY / DEMO_KEY via the X-Api-Key header — this is another consumer
// of the audited key discipline (a key-leak regression now fails this suite too).
import { keyHeader, keyModeLabel, pushKeyNote } from "./datagovKey.js";
// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
export const GSA_PERDIEM_HOST = "api.gsa.gov";
const GSA_PERDIEM_BASE = "/travel/perdiem/v2";
// HOST+path label — surfaces in ToolError.upstreamEndpoint; the key rides ONLY in
// the X-Api-Key header, so no token can ever appear here.
const GSA_PERDIEM_LABEL = "gsa-perdiem:/travel/perdiem/v2/rates";
const GSA_PERDIEM_SOURCE = (mode) => `${GSA_PERDIEM_HOST} via GSA Federal Travel Per-Diem API (${mode})`;
// The default per-diem fiscal year (ADR-0050 — the current confirmed vintage).
export const DEFAULT_PERDIEM_YEAR = "2025";
// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
// Each rides in a single PATH segment (encodeURIComponent-escaped), so these are
// belt-and-suspenders against a Zod-bypassing direct handler call.
const CITY_RE = /^[A-Za-z .'\-]{1,60}$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const ZIP_RE = /^\d{5}$/;
const YEAR_RE = /^\d{4}$/;
// ─── Honesty notes (ADR-0050 required set) ────────────────────────
const RATE_MEANING_NOTE = "lodgingUsd (from the API's monthly `value`) is the MAX nightly lodging reimbursement ceiling for that month — it VARIES SEASONALLY, hence a per-month array; mealsUsd (from `meals`) is the daily Meals & Incidental Expenses (M&IE) ceiling. Both are integer US dollars. A withheld/absent figure is null, NEVER 0 (a genuine 0 is preserved).";
const STANDARD_RATE_NOTE = "standardRate:true means this location falls under the CONUS STANDARD rate (not an individually-set non-standard rate). standardRate/isOconus are booleans coerced from the API's string 'true'/'false'.";
const NO_PAGINATION_NOTE = "The per-diem API returns the COMPLETE rate set for the lookup (no pagination); totalAvailable equals the number of rows returned.";
// ─── STRING-boolean coercion (null-never-fabricate) ───────────────
/** Coerce the API's string 'true'/'false' → a real boolean; anything else ⇒ null. */
function strBool(v) {
    if (typeof v === "boolean")
        return v;
    if (typeof v === "string") {
        const s = v.trim().toLowerCase();
        if (s === "true")
            return true;
        if (s === "false")
            return false;
    }
    return null;
}
/**
 * Map one `months.month[]` entry → the curated per-month shape. `value` and the
 * month `number` via `num` (null-never-0); `long` (month name) via `str`.
 */
function mapMonth(m) {
    const it = (m ?? {});
    return {
        month: num(it.number),
        monthName: str(it.long),
        lodgingUsd: num(it.value),
    };
}
// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect) ──
/**
 * GET one GSA per-diem JSON resource. `path` is a fully-assembled, pre-escaped
 * path (NO query params — the key rides in the X-Api-Key header only). Builds
 * `https://${GSA_PERDIEM_HOST}${path}` on the FIXED host, asserts the CONSTRUCTED
 * URL's hostname === the host over https (belt-and-suspenders), sets
 * `redirect:"error"` (an off-host 3xx must NOT be followed — it could carry the
 * X-Api-Key header to a foreign host), and attaches the key ONLY in the header.
 */
async function getGsaPerdiem(path) {
    const url = `https://${GSA_PERDIEM_HOST}${path}`;
    const built = new URL(url);
    if (built.hostname !== GSA_PERDIEM_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed GSA per-diem URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(GSA_PERDIEM_HOST)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
            upstreamEndpoint: GSA_PERDIEM_LABEL,
        });
    }
    // The key rides in the X-Api-Key header ONLY (never the URL/label/_meta);
    // redirect:"error" (fail closed on any off-host 3xx).
    return getJson(url, {
        label: GSA_PERDIEM_LABEL,
        headers: keyHeader(),
        redirect: "error",
    });
}
/**
 * Look up GSA Federal Travel per-diem rates by EITHER (city + state) OR zip, for a
 * given `year` (default 2025). Returns flattened rate rows (each outer state/year
 * group × inner city/rate) + honest `_meta`: totalAvailable = the row count (no
 * pagination — P1), lodging/meals as null-never-0 dollars (P3), standardRate/isOconus
 * as real booleans, the months array preserved as-is. The DEMO_KEY rate disclosure
 * rides in the notes.
 */
export async function perdiemRates(args) {
    const label = GSA_PERDIEM_LABEL;
    const year = args.year ?? DEFAULT_PERDIEM_YEAR;
    // ── [INPUT] EITHER (city + state) OR zip — never both, never neither. This is a
    //    caller-shape check (0 fetch): an ambiguous or empty lookup is invalid_input,
    //    never a silent guess. ──
    const hasCityState = args.city !== undefined || args.state !== undefined;
    const hasZip = args.zip !== undefined;
    if (hasCityState && hasZip) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "Provide EITHER (city + state) OR zip — not both. City/state and ZIP are two distinct lookup modes; supplying both is ambiguous.",
            upstreamEndpoint: label,
        });
    }
    if (!hasCityState && !hasZip) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: "Provide a lookup key: EITHER (city + state, e.g. city:'Washington', state:'DC') OR zip (e.g. zip:'20001').",
            upstreamEndpoint: label,
        });
    }
    // ── Validate + default the inputs (belt-and-suspenders behind the server Zod;
    //    a DIRECT handler call bypasses Zod). year rides in the PATH regardless. ──
    if (!YEAR_RE.test(year)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid year ${JSON.stringify(year)} — expected a 4-digit year (^\\d{4}$), e.g. "2025". (year rides in the request PATH; it is strictly validated.)`,
            upstreamEndpoint: label,
        });
    }
    let path;
    const filtersApplied = [`year:${year}`];
    let lookupMode;
    if (hasZip) {
        const zip = args.zip;
        if (!ZIP_RE.test(zip)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid zip ${JSON.stringify(zip)} — expected a 5-digit ZIP code (^\\d{5}$), e.g. "20001".`,
                upstreamEndpoint: label,
            });
        }
        lookupMode = `zip:${zip}`;
        filtersApplied.push(lookupMode);
        // Fixed template; each segment encodeURIComponent-escaped (belt-and-suspenders
        // behind the charclass — no path injection, no query steer).
        path = `${GSA_PERDIEM_BASE}/rates/zip/${encodeURIComponent(zip)}/year/${encodeURIComponent(year)}`;
    }
    else {
        // city + state — BOTH are required together for this mode.
        if (args.city === undefined || args.state === undefined) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: "The city lookup mode requires BOTH city AND state (e.g. city:'Washington', state:'DC'). Provide both, or use zip instead.",
                upstreamEndpoint: label,
            });
        }
        const city = args.city;
        const state = args.state;
        if (!CITY_RE.test(city)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid city ${JSON.stringify(city)} — expected 1–60 letters/spaces/.'- (^[A-Za-z .'\\-]{1,60}$), e.g. "Washington".`,
                upstreamEndpoint: label,
            });
        }
        if (!STATE_RE.test(state)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid state ${JSON.stringify(state)} — expected a 2-letter state code (^[A-Za-z]{2}$), e.g. "DC", "CA".`,
                upstreamEndpoint: label,
            });
        }
        lookupMode = `city:${city}, state:${state}`;
        filtersApplied.push(`city:${city}`, `state:${state}`);
        path = `${GSA_PERDIEM_BASE}/rates/city/${encodeURIComponent(city)}/state/${encodeURIComponent(state)}/year/${encodeURIComponent(year)}`;
    }
    // ── The typed catch-ladder (datagov-catalog searchDatasets shape, VERBATIM).
    //    Preserve the 429/404/5xx/400/timeout ToolErrorCarrier taxonomy FIRST
    //    (LOAD-BEARING: the DEMO_KEY-~10/hr 429→rate_limited frontier would regress to
    //    schema_drift under a broader catch); reclassify a 200 non-JSON `.json()`
    //    SyntaxError to schema_drift SECOND; bare-rethrow LAST. The host-assert
    //    ToolErrorCarrier is also rethrown first. ──
    let body;
    try {
        body = await getGsaPerdiem(path);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(label, "GSA per-diem returned a non-JSON body at HTTP 200 — schema drift.");
        throw e;
    }
    const b = (body ?? {});
    // ── [P2] `errors` non-null ⇒ a lookup problem ⇒ invalid_input surfacing the
    //    message (NEVER a fake empty — swallowing this as empty ⇒ RED). ──
    if (b.errors !== null && b.errors !== undefined) {
        const msg = typeof b.errors === "string" ? b.errors : JSON.stringify(b.errors);
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `GSA per-diem reported a lookup error for ${lookupMode} (year ${year}): ${msg}`,
            upstreamEndpoint: label,
        });
    }
    // ── [P4] `rates` MUST be an array (a missing/object/null rates is drift, never a
    //    fabricated empty — a TypeError must never mask drift as upstream_unavailable). ──
    if (!Array.isArray(b.rates)) {
        throw driftError(label, "GSA per-diem shape drift — response.rates must be an array.");
    }
    // ── Flatten: each outer state/year group × its inner rate[]. ──
    const rows = [];
    for (const group of b.rates) {
        const g = (group ?? {});
        // [P4] a group's `rate` MUST be an array (never a fabricated empty).
        if (!Array.isArray(g.rate)) {
            throw driftError(label, "GSA per-diem shape drift — a rates[].rate must be an array.");
        }
        const gState = str(g.state);
        const gYear = num(g.year);
        const gOconus = strBool(g.isOconus);
        for (const rate of g.rate) {
            const r = (rate ?? {});
            const monthsObj = (r.months ?? {});
            // [P4] months.month MUST be an array (never padded/fabricated to 12).
            if (!Array.isArray(monthsObj.month)) {
                throw driftError(label, "GSA per-diem shape drift — a rate's months.month must be an array.");
            }
            rows.push({
                city: str(r.city),
                county: str(r.county),
                state: gState,
                zip: str(r.zip),
                year: gYear,
                isOconus: gOconus,
                standardRate: strBool(r.standardRate),
                mealsUsd: num(r.meals),
                monthlyLodgingUsd: monthsObj.month.map(mapMonth),
            });
        }
    }
    const returned = rows.length;
    const notes = [RATE_MEANING_NOTE, STANDARD_RATE_NOTE, NO_PAGINATION_NOTE];
    pushKeyNote(notes);
    return withMeta({ rates: rows }, {
        source: GSA_PERDIEM_SOURCE(keyModeLabel()),
        keylessMode: false, // keyed via the api.data.gov X-Api-Key (DEMO_KEY default)
        returned,
        // [P1] the COMPLETE set for the lookup (no pagination) ⇒ totalAvailable = the
        // row count; complete is DERIVED true by buildMeta (returned === total).
        totalAvailable: returned,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
//# sourceMappingURL=gsa-perdiem.js.map