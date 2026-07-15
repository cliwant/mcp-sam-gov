/**
 * cpsc.ts — CPSC CONSUMER-PRODUCT RECALLS (www.saferproducts.gov) — the consumer
 * goods / import product-safety vetting lane (ADR-0058). ONE keyless tool:
 *   • cpsc_recalls — /RestWebServices/Recall?format=json + date/product/manufacturer/
 *     recallNumber filters.
 * The third leg of the cross-agency product-safety family alongside NHTSA (vehicles)
 * and openFDA (medical/food): a manufacturer / product / hazard recall history for
 * B2G supplier and import vetting.
 *
 * ★ KEYLESS — there is NO API key at all (no parameter, no header). This module
 *   touches NO key seam (no KEY_REGISTRY / keys.ts / API_KEYS.md). It REUSES the
 *   shared `getJson` (redirect:"error") / `driftError` fetch envelope, the `str`
 *   coercion (null-never-empty-string), and `withMeta`/`buildMeta` — and mirrors
 *   nhtsa.ts / datagov-catalog.ts's fixed-host SSRF idiom + schema_drift
 *   catch-ladder verbatim.
 *
 * ★ THE HONESTY PILLARS (P1-P5, live-verified 2026-07-15):
 *   P1: the /Recall response is a BARE JSON ARRAY with NO count field and NO server
 *       pagination — it returns the COMPLETE set matching the filter. So
 *       totalAvailable = results.length and complete:true, WITH a disclosing note
 *       that CPSC reports no total-count field / no pagination. A total is NEVER
 *       fabricated (there is no upstream total to trust; the honest total is the
 *       length of the complete set).
 *   P2: an empty array `[]` ⇒ an HONEST EMPTY (returned:0, complete:true) — a filter
 *       that matches nothing is an honest no-match, NOT an error. A 4xx ⇒
 *       invalid_input; a 5xx/timeout ⇒ THROW (never a fake empty); a 200 non-JSON
 *       body OR a non-array body ⇒ schema_drift (never a fabricated empty).
 *   P3: dates stay STRINGS (via `str`); NumberOfUnits is free text ("About 6,500")
 *       kept as a STRING; nested arrays (Products/Manufacturers/Retailers/Hazards/
 *       Remedies/Injuries/ManufacturerCountries) are flattened to string arrays by
 *       extracting each object's `.Name` (★ManufacturerCountries uses `.Country`,
 *       NOT `.Name`), SKIPPING an empty `{}` object (never a fabricated entry); a
 *       genuinely-absent nested array ⇒ []; null-never-empty-string throughout.
 *   P4: the top-level body MUST be an array — a non-array (object/string/null) ⇒
 *       driftError (a broken response contract, never a fabricated empty).
 *   DEFAULT-WINDOW: with NO filter given, the unfiltered result is huge, so the tool
 *       defaults RecallDateStart to ~90 days ago and DISCLOSES the default in a note
 *       — it NEVER silently fetches the whole dataset.
 *   SSRF: fixed host `www.saferproducts.gov` (compile-time literal) + post-construction
 *       hostname/protocol assertion + redirect:"error"; every filter rides a
 *       module-built URLSearchParams (no raw passthrough); dates are ^\d{4}-\d{2}-\d{2}$;
 *       recallNumber is charclass-validated (letters/digits/hyphen only), so a
 *       `../` or `%` can never reach the fixed path.
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { str } from "./coerce.js";
import { withMeta } from "./meta.js";
// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
export const CPSC_HOST = "www.saferproducts.gov";
const CPSC_RECALL_PATH = "/RestWebServices/Recall";
// HOST+path-only label (→ ToolError.upstreamEndpoint). Keyless ⇒ no token can ever
// appear here regardless, but the label stays host+path for consistency.
const CPSC_RECALL_LABEL = "cpsc:/RestWebServices/Recall";
// ─── Input validation grammar (SSRF + injection guard) ────────────
// dates: strict YYYY-MM-DD. recallNumber: letters/digits/hyphen only — rejects
// `../`, `%`, `/`, `.`, spaces, quotes, so a value can never break out of the
// URLSearchParams-encoded query onto the fixed host/path.
export const CPSC_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const CPSC_RECALL_NUMBER_RE = /^[A-Za-z0-9-]+$/;
// The default recent-window span (days) applied when NO filter is given, so an
// unbounded whole-dataset fetch never happens silently.
const CPSC_DEFAULT_WINDOW_DAYS = 90;
const KEYLESS_NOTE = "CPSC SaferProducts is a keyless public API (www.saferproducts.gov) — no API key is required or accepted.";
// The P1 load-bearing honesty caveat carried on EVERY response.
const CPSC_NO_PAGINATION_NOTE = "CPSC returns the complete matching set (no server pagination or total-count field) — totalAvailable is the number of returned recalls (the size of the complete set), not an upstream-reported total.";
// ─── Nested-array flatteners (P3) ─────────────────────────────────
/**
 * Flatten a CPSC nested array (Products/Manufacturers/Retailers/Hazards/Remedies/
 * Injuries/ManufacturerCountries) to a string[] by extracting `field` from each
 * object via `str` (null-never-empty-string). An empty `{}` object (or one whose
 * `field` is absent/blank) is SKIPPED — never a fabricated entry. A non-array
 * (absent nested array) ⇒ [].
 */
function extractField(x, field) {
    if (!Array.isArray(x))
        return [];
    const out = [];
    for (const el of x) {
        if (el === null || typeof el !== "object")
            continue;
        const v = str(el[field]);
        if (v !== null)
            out.push(v);
    }
    return out;
}
/**
 * The recall-level numberOfUnits (P3): CPSC carries NumberOfUnits per PRODUCT as
 * FREE TEXT ("About 6,500"), so this returns the FIRST product's non-blank
 * NumberOfUnits as a STRING (never numerically coerced), or null when none is
 * present (null-never-empty-string).
 */
function firstNumberOfUnits(products) {
    if (!Array.isArray(products))
        return null;
    for (const p of products) {
        if (p === null || typeof p !== "object")
            continue;
        const v = str(p.NumberOfUnits);
        if (v !== null)
            return v;
    }
    return null;
}
/**
 * Map ONE /Recall row → the curated recall shape. Scalars via `str`
 * (null-never-empty-string; dates stay strings). Nested arrays flattened via
 * `extractField` on `.Name` — EXCEPT ManufacturerCountries, which carries `.Country`.
 */
function mapRecall(row) {
    const r = (row ?? {});
    return {
        recallNumber: str(r.RecallNumber),
        recallDate: str(r.RecallDate),
        title: str(r.Title),
        description: str(r.Description),
        url: str(r.URL),
        products: extractField(r.Products, "Name"),
        numberOfUnits: firstNumberOfUnits(r.Products),
        manufacturers: extractField(r.Manufacturers, "Name"),
        retailers: extractField(r.Retailers, "Name"),
        hazards: extractField(r.Hazards, "Name"),
        remedies: extractField(r.Remedies, "Name"),
        injuries: extractField(r.Injuries, "Name"),
        // ★ ManufacturerCountries objects carry `Country`, not `Name` (live-verified).
        manufacturerCountries: extractField(r.ManufacturerCountries, "Country"),
    };
}
/**
 * Validate the optional inputs PRE-fetch (0 network call). A DIRECT handler call
 * bypasses the server Zod, so re-guard the SSRF-relevant grammars here: dates are
 * ^\d{4}-\d{2}-\d{2}$; recallNumber is letters/digits/hyphen only. productName /
 * manufacturer are free text (they ride URLSearchParams-encoded, so injection is
 * neutralized by encoding — no charclass needed, but they are validated as strings).
 */
function validateArgs(args) {
    const dateChecks = [
        ["dateStart", args.dateStart],
        ["dateEnd", args.dateEnd],
    ];
    for (const [name, value] of dateChecks) {
        if (value !== undefined && (typeof value !== "string" || !CPSC_DATE_RE.test(value))) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid ${name} ${JSON.stringify(value)} — expected a YYYY-MM-DD date (^\\d{4}-\\d{2}-\\d{2}$), e.g. "2025-01-01".`,
                upstreamEndpoint: CPSC_RECALL_LABEL,
            });
        }
    }
    if (args.recallNumber !== undefined &&
        (typeof args.recallNumber !== "string" || !CPSC_RECALL_NUMBER_RE.test(args.recallNumber))) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid recallNumber ${JSON.stringify(args.recallNumber)} — expected letters/digits/hyphen only (^[A-Za-z0-9-]+$), e.g. "25088".`,
            upstreamEndpoint: CPSC_RECALL_LABEL,
        });
    }
    for (const [name, value] of [
        ["productName", args.productName],
        ["manufacturer", args.manufacturer],
    ]) {
        if (value !== undefined && typeof value !== "string") {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Invalid ${name} — expected a string.`,
                upstreamEndpoint: CPSC_RECALL_LABEL,
            });
        }
    }
}
// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect) ──
/**
 * GET the CPSC /Recall JSON on the FIXED host. Builds
 * `https://www.saferproducts.gov/RestWebServices/Recall?${params}`, asserts the
 * CONSTRUCTED URL's hostname === the fixed host over https (belt-and-suspenders),
 * and sets `redirect:"error"` (fail closed on any off-host 3xx). Keyless — no
 * header/token.
 */
async function getCpsc(params) {
    const url = `https://${CPSC_HOST}${CPSC_RECALL_PATH}?${params.toString()}`;
    const built = new URL(url);
    if (built.hostname !== CPSC_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Constructed CPSC URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(CPSC_HOST)} over https — refusing to fetch (SSRF safety).`,
            upstreamEndpoint: CPSC_RECALL_LABEL,
        });
    }
    return getJson(url, { label: CPSC_RECALL_LABEL, redirect: "error" });
}
/** Compute an ISO YYYY-MM-DD `days` days before now (the default-window start). */
function daysAgoIso(days) {
    return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
// ─── Tool: cpsc_recalls ───────────────────────────────────────────
/**
 * Fetch CPSC consumer-product RECALLS → curated recall rows + honest `_meta`.
 * KEYLESS. All filters are optional; with NO filter given, RecallDateStart defaults
 * to ~90 days ago (disclosed in a note) so the whole dataset is never silently
 * fetched. The response is a bare array with no total-count field / no pagination
 * ⇒ totalAvailable = the number of returned recalls, complete:true. An empty array
 * ⇒ an honest empty; a 4xx ⇒ invalid_input; a 5xx/timeout ⇒ THROW; a 200 non-JSON
 * OR a non-array body ⇒ schema_drift.
 */
export async function recalls(args) {
    validateArgs(args);
    // ── Build the query from VALIDATED typed args, key-by-key (SSRF: no raw
    //    passthrough). format=json is ALWAYS appended. ──
    const params = new URLSearchParams();
    params.set("format", "json");
    const filtersApplied = [];
    if (args.dateStart !== undefined) {
        params.set("RecallDateStart", args.dateStart);
        filtersApplied.push("dateStart");
    }
    if (args.dateEnd !== undefined) {
        params.set("RecallDateEnd", args.dateEnd);
        filtersApplied.push("dateEnd");
    }
    if (args.productName !== undefined) {
        params.set("ProductName", args.productName);
        filtersApplied.push("productName");
    }
    if (args.manufacturer !== undefined) {
        params.set("Manufacturer", args.manufacturer);
        filtersApplied.push("manufacturer");
    }
    if (args.recallNumber !== undefined) {
        params.set("RecallNumber", args.recallNumber);
        filtersApplied.push("recallNumber");
    }
    // ── DEFAULT-WINDOW: with NO filter, an unbounded fetch would return the WHOLE
    //    dataset. Bound it to a ~90-day recent window (RecallDateStart) and DISCLOSE
    //    the default — never silently fetch everything. ──
    const notes = [KEYLESS_NOTE, CPSC_NO_PAGINATION_NOTE];
    let defaultWindowApplied = false;
    if (filtersApplied.length === 0) {
        const defaultStart = daysAgoIso(CPSC_DEFAULT_WINDOW_DAYS);
        params.set("RecallDateStart", defaultStart);
        defaultWindowApplied = true;
        notes.push(`No filter was provided — to avoid silently fetching the ENTIRE recall dataset, results are bounded to a default recent window: RecallDateStart=${defaultStart} (~${CPSC_DEFAULT_WINDOW_DAYS} days ago). Pass dateStart/dateEnd, productName, manufacturer, or recallNumber for a scoped query.`);
    }
    // ── The typed catch-ladder (nhtsa.ts / datagov-catalog.ts shape, VERBATIM):
    //    a ToolErrorCarrier (host-assert / 4xx-5xx taxonomy) rethrows FIRST
    //    (preserving its kind); a 200 non-JSON `.json()` SyntaxError reclassifies to
    //    schema_drift; a bare error rethrows LAST. ──
    let body;
    try {
        body = await getCpsc(params);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(CPSC_RECALL_LABEL, "CPSC /RestWebServices/Recall returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).");
        throw e;
    }
    // ── P4: the top-level body MUST be an array (a non-array object/string/null is
    //    drift, never a fabricated empty). ──
    if (!Array.isArray(body)) {
        throw driftError(CPSC_RECALL_LABEL, "CPSC /RestWebServices/Recall shape drift — the response must be a bare JSON array.");
    }
    const recalls = body.map(mapRecall);
    const returned = recalls.length;
    return withMeta({ recalls }, {
        source: `${CPSC_HOST} /RestWebServices/Recall (CPSC consumer-product recalls; keyless)`,
        keylessMode: true,
        returned,
        // P1 — no upstream total-count field / no pagination: the complete set IS the
        // returned rows, so totalAvailable = returned and complete:true (derived).
        totalAvailable: returned,
        filtersApplied: defaultWindowApplied ? ["dateStart(default)"] : filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
//# sourceMappingURL=cpsc.js.map