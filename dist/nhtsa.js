/**
 * nhtsa.ts — NHTSA VEHICLE SAFETY (api.nhtsa.gov) — the vehicle / parts /
 * fleet supplier PRODUCT-SAFETY vetting lane (ADR-0057). Two keyless tools:
 *   • nhtsa_recalls    — /recalls/recallsByVehicle?make=&model=&modelYear=
 *   • nhtsa_complaints — /complaints/complaintsByVehicle?make=&model=&modelYear=
 * The cross-agency product-safety family alongside openFDA (medical) / CPSC
 * (consumer goods): a manufacturer/component/safety-signal history for B2G
 * supplier vetting.
 *
 * ★ KEYLESS — there is NO API key at all (no parameter, no header). This module
 *   touches NO key seam (no KEY_REGISTRY / keys.ts / API_KEYS.md). It REUSES the
 *   shared `getJson` (redirect:"error") / `driftError` fetch envelope, the `num`/
 *   `str` coercions (null-never-empty-string; a genuine 0 stays 0), and
 *   `withMeta`/`buildMeta` — and mirrors datagov-catalog.ts's fixed-host SSRF
 *   idiom + schema_drift catch-ladder verbatim.
 *
 * ★ PII — the complaints upstream response carries a `vin` field (an individual
 *   vehicle identifier). It is DELIBERATELY OMITTED from the curated output
 *   entirely — never surfaced, logged, or stored. The B2G value is the
 *   manufacturer / component / safety signal, NOT the VIN.
 *
 * ★ THE HONESTY PILLARS (P1/P3/P4 live-verified 2026-07-15; P2 corrected +
 *   re-verified 2026-07-20):
 *   P1: totalAvailable = `Count` (recalls) / `count` (complaints) — the REAL total.
 *       NHTSA returns the COMPLETE filtered set (no pagination), so in the normal
 *       case Count === results.length ⇒ complete:true. totalAvailable is NEVER
 *       fabricated: a PRESENT numeric Count is trusted verbatim; a MISSING Count
 *       falls back to results.length WITH an honest note (never invented).
 *   P2: ★NHTSA returns HTTP 400 (NOT 200) + {Count/count:0, results:[]} (Message
 *       "Results returned successfully") for a VALID make/model/year that simply
 *       has ZERO records (live-verified 2026-07-20). getNhtsa reads the body and
 *       reclassifies THAT idiom as an HONEST EMPTY (returned:0, totalAvailable:0,
 *       complete:true) with a note; any OTHER 400 ⇒ invalid_input, a 404 ⇒
 *       not_found, a 5xx/timeout ⇒ THROW (never a fake empty), a 200 non-JSON
 *       body ⇒ schema_drift.
 *   P3: booleans (crash/fire/parkIt/parkOutSide/overTheAirUpdate) preserved AS
 *       booleans (a non-boolean ⇒ null, never a fabricated false); counts
 *       (numberOfInjuries/numberOfDeaths) via `num` (a genuine 0 stays 0, NEVER
 *       null-for-0); dates as strings via `str`; Count/count via `num`.
 *   P4: `results` non-array ⇒ driftError; a Count/count that is PRESENT but a
 *       non-number ⇒ driftError (a broken total contract, never a fabricated empty).
 *   SSRF: fixed host `api.nhtsa.gov` (compile-time literal) + post-construction
 *       hostname/protocol assertion + redirect:"error"; make/model ride
 *       URLSearchParams (module-built, no raw passthrough); modelYear is
 *       ^\d{4}$; make/model are charclass-validated (letters/digits/space/hyphen,
 *       so a `../` or `%` can never reach the fixed path).
 */
import { ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { driftError, isRedirectError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
export const NHTSA_HOST = "api.nhtsa.gov";
const RECALLS_PATH = "/recalls/recallsByVehicle";
const COMPLAINTS_PATH = "/complaints/complaintsByVehicle";
// HOST+path-only labels (→ ToolError.upstreamEndpoint). Keyless ⇒ no token can
// ever appear here regardless, but the labels stay host+path for consistency.
const RECALLS_LABEL = "nhtsa:/recalls/recallsByVehicle";
const COMPLAINTS_LABEL = "nhtsa:/complaints/complaintsByVehicle";
// ─── Input validation grammar (SSRF + injection guard) ────────────
// modelYear: exactly 4 digits. make/model: letters/digits/space/hyphen only —
// rejects `../`, `%`, `/`, `.`, quotes, so a value can never break out of the
// URLSearchParams-encoded query onto the fixed host/path.
export const NHTSA_MODEL_YEAR_RE = /^\d{4}$/;
export const NHTSA_MAKE_MODEL_RE = /^[A-Za-z0-9 -]+$/;
const KEYLESS_NOTE = "NHTSA is a keyless public API (api.nhtsa.gov) — no API key is required or accepted.";
const COMPLETE_SET_NOTE = "NHTSA returns the COMPLETE set of matching records for this make/model/modelYear (no pagination) — totalAvailable is the upstream Count, and returned should equal it.";
// ─── Shared coercions ─────────────────────────────────────────────
/** A genuine boolean preserved; anything else ⇒ null (never a fabricated false). */
function bool(x) {
    return typeof x === "boolean" ? x : null;
}
/**
 * Validate the shared make/model/modelYear inputs (belt-and-suspenders behind the
 * server Zod; a DIRECT handler call bypasses Zod). Rejects a bad value PRE-fetch
 * (0 network call) so a `../`/`%` can never reach the fixed host/path.
 */
function validateVehicleArgs(args, label) {
    const checks = [
        ["make", args.make, NHTSA_MAKE_MODEL_RE],
        ["model", args.model, NHTSA_MAKE_MODEL_RE],
        ["modelYear", args.modelYear, NHTSA_MODEL_YEAR_RE],
    ];
    for (const [name, value, re] of checks) {
        if (typeof value !== "string" || !re.test(value)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: name === "modelYear"
                    ? `Invalid modelYear ${JSON.stringify(value)} — expected a 4-digit year (^\\d{4}$), e.g. "2020".`
                    : `Invalid ${name} ${JSON.stringify(value)} — expected letters/digits/space/hyphen only (^[A-Za-z0-9 -]+$), e.g. "honda".`,
                upstreamEndpoint: label,
            });
        }
    }
}
// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect) ──
/**
 * ★ NHTSA's "400-for-empty" idiom. A VALID make/model/year that simply has ZERO
 * records returns HTTP 400 with a body `{Count/count:0, ..., results:[]}` and
 * `Message/message:"Results returned successfully"` (live-verified 2026-07-20:
 * `make=tesla&model=model 3&modelYear=2015` → HTTP 400, Count 0). Recalls use
 * `Count`/`Message`, complaints use lowercase `count`/`message` — accept either.
 * This is a genuine no-match, NOT a bad request; the caller reclassifies it to an
 * honest empty. (A 400 that is NOT this idiom stays a real invalid_input.)
 */
function isNhtsaEmptyIdiom(body) {
    if (body === null || typeof body !== "object")
        return false;
    const b = body;
    const rawCount = b.Count ?? b.count;
    return num(rawCount) === 0 && Array.isArray(b.results) && b.results.length === 0;
}
/**
 * GET one NHTSA JSON resource on the FIXED host. Bespoke `fetch` (NOT the shared
 * getJson) because we must READ a non-2xx body: NHTSA returns HTTP 400 for a valid
 * query with zero records (the ★400-for-empty idiom above), and getJson would
 * throw invalid_input and DISCARD the body — turning "zero recalls" (a valid,
 * high-value answer) into a phantom "Bad request". Asserts the constructed URL's
 * hostname === the fixed host over https (belt-and-suspenders) + `redirect:"error"`
 * (fail closed on any off-host 3xx). Keyless — no header/token. Non-2xx that is NOT
 * the empty idiom keeps the standard taxonomy (400→invalid_input, 404→not_found,
 * 429→rate_limited, 5xx→upstream_unavailable); a 200 non-JSON body ⇒ schema_drift.
 */
async function getNhtsa(path, label, params) {
    const url = `https://${NHTSA_HOST}${path}?${params.toString()}`;
    const built = new URL(url);
    if (built.hostname !== NHTSA_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Constructed NHTSA URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(NHTSA_HOST)} over https — refusing to fetch (SSRF safety).`,
            upstreamEndpoint: label,
        });
    }
    let res;
    try {
        res = await fetch(built.toString(), {
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
        });
    }
    catch (e) {
        if (isRedirectError(e)) {
            throw driftError(label, `NHTSA returned an off-host redirect (redirect:"error") while fetching ${label} — refusing to follow it (SSRF safety).`);
        }
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
            throw new ToolErrorCarrier({
                kind: "upstream_unavailable",
                retryable: false,
                message: `Request to ${label} timed out.`,
                upstreamEndpoint: label,
            });
        }
        throw new ToolErrorCarrier({
            kind: "upstream_unavailable",
            retryable: true,
            retryAfterSeconds: 30,
            message: `Network error reaching ${label}: ${e instanceof Error ? e.message : String(e)}`,
            upstreamEndpoint: label,
        });
    }
    if (!res.ok) {
        // ★P2 CRUX: read the body — a 400 that is NHTSA's empty idiom is an HONEST
        // no-match (returned via resolveTotal as Count 0 → total 0), NOT an error.
        let body = null;
        try {
            body = await res.json();
        }
        catch {
            body = null;
        }
        if (res.status === 400 && isNhtsaEmptyIdiom(body))
            return body;
        // Any other non-2xx keeps the standard taxonomy (never a fabricated empty).
        // errorFromResponse returns a plain ToolError → wrap it in the carrier to throw.
        throw new ToolErrorCarrier(errorFromResponse(res, label));
    }
    try {
        return await res.json();
    }
    catch {
        throw driftError(label, `NHTSA ${label} returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).`);
    }
}
/** Build the shared make/model/modelYear query (module-built; no raw passthrough). */
function vehicleParams(args) {
    const params = new URLSearchParams();
    params.set("make", args.make);
    params.set("model", args.model);
    params.set("modelYear", args.modelYear);
    return params;
}
/**
 * Build the vehicle query and fetch through getNhtsa, which fully classifies the
 * response: the ★400-for-empty idiom → an honest empty; every other non-2xx → the
 * standard taxonomy; a 200 non-JSON body → schema_drift. A thin wrapper — getNhtsa
 * owns the error contract.
 */
async function fetchNhtsa(path, label, args) {
    return await getNhtsa(path, label, vehicleParams(args));
}
/**
 * Resolve the total from a Count/count field (P1/P4). A PRESENT numeric value is
 * trusted verbatim; a MISSING (undefined/null) value falls back to results.length
 * WITH an honest note (never fabricated); a PRESENT non-number ⇒ driftError (a
 * broken total contract). Returns the total + the fallback flag.
 */
function resolveTotal(rawCount, returned, label) {
    if (rawCount === undefined || rawCount === null) {
        // P1 fallback — missing Count ⇒ results.length + an honest note.
        return { total: returned, fellBack: true };
    }
    const n = num(rawCount);
    if (n === null) {
        // P4 — a PRESENT non-number Count is a broken contract, never a fake empty.
        throw driftError(label, `NHTSA ${label} shape drift — the total count field is present but non-numeric.`);
    }
    return { total: n, fellBack: false };
}
/** Map ONE /recallsByVehicle row → the curated recall shape. Booleans via `bool`. */
function mapRecall(row) {
    const r = (row ?? {});
    return {
        campaignNumber: str(r.NHTSACampaignNumber),
        manufacturer: str(r.Manufacturer),
        component: str(r.Component),
        summary: str(r.Summary),
        consequence: str(r.Consequence),
        remedy: str(r.Remedy),
        reportReceivedDate: str(r.ReportReceivedDate),
        parkIt: bool(r.parkIt),
        parkOutside: bool(r.parkOutSide),
        overTheAirUpdate: bool(r.overTheAirUpdate),
    };
}
/**
 * Map ONE /complaintsByVehicle row → the curated complaint shape. ★The `vin` field
 * is DELIBERATELY OMITTED (PII — never read into the output). Counts via `num` (a
 * genuine 0 stays 0); booleans via `bool`.
 */
function mapComplaint(row) {
    const r = (row ?? {});
    return {
        odiNumber: str(r.odiNumber),
        manufacturer: str(r.manufacturer),
        component: str(r.components),
        summary: str(r.summary),
        crash: bool(r.crash),
        fire: bool(r.fire),
        numberOfInjuries: num(r.numberOfInjuries),
        numberOfDeaths: num(r.numberOfDeaths),
        dateOfIncident: str(r.dateOfIncident),
        dateComplaintFiled: str(r.dateComplaintFiled),
        // ★ NO vin — the PII field is never surfaced, logged, or stored.
    };
}
const FILTERS_APPLIED = ["make", "model", "modelYear"];
// ─── Tool: nhtsa_recalls ──────────────────────────────────────────
/**
 * Fetch NHTSA safety RECALLS for a make/model/modelYear → curated recall rows +
 * honest `_meta`. KEYLESS. totalAvailable = the upstream `Count` (the REAL total —
 * NHTSA returns the complete set, no pagination). A no-match (Count 0) ⇒ an honest
 * empty; a 4xx ⇒ invalid_input; a 5xx/timeout ⇒ THROW; a 200 non-JSON ⇒ drift.
 */
export async function recalls(args) {
    validateVehicleArgs(args, RECALLS_LABEL);
    const body = await fetchNhtsa(RECALLS_PATH, RECALLS_LABEL, args);
    const b = (body ?? {});
    // P4 — results MUST be an array (a missing/string/null results is drift).
    if (!Array.isArray(b.results)) {
        throw driftError(RECALLS_LABEL, `NHTSA ${RECALLS_LABEL} shape drift — results must be an array.`);
    }
    const recalls = b.results.map(mapRecall);
    const returned = recalls.length;
    const { total, fellBack } = resolveTotal(b.Count, returned, RECALLS_LABEL);
    const notes = [KEYLESS_NOTE, COMPLETE_SET_NOTE];
    if (fellBack)
        notes.push("NHTSA did not report a Count field — totalAvailable falls back to the number of returned rows (results.length); the true total may differ.");
    return withMeta({ recalls }, {
        source: `${NHTSA_HOST} /recalls/recallsByVehicle (NHTSA vehicle safety recalls; keyless)`,
        keylessMode: true,
        returned,
        totalAvailable: total,
        filtersApplied: FILTERS_APPLIED,
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
// ─── Tool: nhtsa_complaints ───────────────────────────────────────
/**
 * Fetch NHTSA consumer COMPLAINTS for a make/model/modelYear → curated complaint
 * rows (★NO vin — PII omitted) + honest `_meta`. KEYLESS. totalAvailable = the
 * upstream `count` (the REAL total). A no-match ⇒ honest empty; a 4xx ⇒
 * invalid_input; a 5xx/timeout ⇒ THROW; a 200 non-JSON ⇒ drift.
 */
export async function complaints(args) {
    validateVehicleArgs(args, COMPLAINTS_LABEL);
    const body = await fetchNhtsa(COMPLAINTS_PATH, COMPLAINTS_LABEL, args);
    const b = (body ?? {});
    // P4 — results MUST be an array (a missing/string/null results is drift).
    if (!Array.isArray(b.results)) {
        throw driftError(COMPLAINTS_LABEL, `NHTSA ${COMPLAINTS_LABEL} shape drift — results must be an array.`);
    }
    const complaints = b.results.map(mapComplaint);
    const returned = complaints.length;
    const { total, fellBack } = resolveTotal(b.count, returned, COMPLAINTS_LABEL);
    const notes = [
        KEYLESS_NOTE,
        COMPLETE_SET_NOTE,
        "The NHTSA complaint VIN (an individual vehicle identifier) is intentionally EXCLUDED from this output (PII). The B2G signal is the manufacturer/component/crash/fire/injury/death safety history.",
    ];
    if (fellBack)
        notes.push("NHTSA did not report a count field — totalAvailable falls back to the number of returned rows (results.length); the true total may differ.");
    return withMeta({ complaints }, {
        source: `${NHTSA_HOST} /complaints/complaintsByVehicle (NHTSA vehicle safety complaints; keyless)`,
        keylessMode: true,
        returned,
        totalAvailable: total,
        filtersApplied: FILTERS_APPLIED,
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
//# sourceMappingURL=nhtsa.js.map