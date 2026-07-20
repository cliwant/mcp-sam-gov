/**
 * openfda-device.ts — openFDA 510(k) DEVICE CLEARANCES (api.fda.gov) — the
 * MEDICAL-DEVICE REGULATORY lane (ADR-0056). The FDA's premarket-notification
 * (510(k)) clearances: the applicant, the device, the clearance number (K-number),
 * the decision (date + description), the clearance type, the product code, the
 * advisory committee, and geography.
 *
 * ★ THIS IS THE SAME SOURCE + ENVELOPE + CRUX as openfda.ts (ADR-0054). Same host
 *   (api.fda.gov), same response envelope `{ meta:{ results:{ skip, limit, total }},
 *   results:[…] }`, same ★no-match→HTTP-404-NOT_FOUND-as-honest-empty crux, same
 *   optional query-key K-test, same fixed-host SSRF idiom, same structured-only
 *   (no raw Lucene passthrough) search assembly. It REUSES openfda.ts's `fetchOpenfda`
 *   (the SSRF-guarded classified fetch) and `readOpenfdaError` (the error-body reader)
 *   verbatim — the 404-reclassification logic is NOT reinvented — plus `luceneQuote`
 *   (the phrase-escape), `openfdaApiKey` (the optional-key env seam), and `OPENFDA_HOST`.
 *
 *   GET https://api.fda.gov/device/510k.json
 *       ?search=<lucene>&limit=<1..100>&skip=<offset>[&api_key=<KEY>]
 *   → { meta:{ disclaimer, results:{ skip, limit, total }}, results:[ {…} ] }
 *     (live total ~175507).
 *
 * ★ HONESTY (mirrors openfda.ts exactly):
 *   [P1]  totalAvailable = `meta.results.total` EXACT (e.g. 175507), NEVER
 *         results.length. skip/limit offset pagination:
 *         hasMore = skip + returned < total; nextOffset = hasMore ? skip+returned : null.
 *   [★P2] a 404 whose body is `{error:{code:"NOT_FOUND"}}` (a no-match query OR an
 *         unknown field) ⇒ HONEST EMPTY (returned:0, totalAvailable:0) — NOT thrown,
 *         NOT not_found. Any OTHER 4xx (e.g. a 400 syntax error) ⇒ invalid_input
 *         surfacing openFDA's message. 5xx/timeout ⇒ upstream_unavailable THROW. A
 *         200 non-JSON body ⇒ schema_drift. (Reuses openfda.ts's exact fetch path.)
 *   [P3]  dates (`decision_date`, YYYY-MM-DD) and every scalar surfaced as a STRING
 *         via `str` (null-never-empty-string) — no numeric coercion; never fabricated.
 *   [P4]  `meta.results` or `results` absent / non-array ⇒ driftError (never a
 *         fabricated empty).
 *   [K-test] OPTIONAL OPENFDA_API_KEY: when set it rides `&api_key=` ONLY (openFDA has
 *         no header option — the query-key is inherent). Mitigation: the `label` is
 *         host+path ONLY (`openfda:/device/510k`, NO query), so no token reaches
 *         ToolError.upstreamEndpoint; `_meta.source` names the MODE only; the key is
 *         ABSENT from the serialized {data,_meta}, notes, and any log. Unset ⇒ keyless.
 *   [SSRF] fixed host `api.fda.gov` (fetchOpenfda asserts hostname/protocol +
 *         redirect:"error"); all filter VALUES are Lucene-escaped + phrase-quoted and
 *         ride URLSearchParams `search=`; limit/skip are integers; state is charclass
 *         `^[A-Za-z]{2}$`. No raw Lucene passthrough — structured only, injection-safe.
 */
import { ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { driftError } from "./datasource.js";
import { str } from "./coerce.js";
import { withMeta } from "./meta.js";
import { OPENFDA_HOST, fetchOpenfda, readOpenfdaError, luceneQuote, openfdaApiKey, openfdaPageMeta, openfdaEmptyTotal, OPENFDA_CEILING_NOTE, OPENFDA_OVERSKIP_NOTE, } from "./openfda.js";
// state filter charclass (a 2-letter US state/territory postal code).
const STATE_RE = /^[A-Za-z]{2}$/;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** host+path-only label (→ ToolError.upstreamEndpoint); NEVER carries the key. */
const DEVICE_LABEL = "openfda:/device/510k";
// ─── Honesty notes (ADR-0056 required set) ────────────────────────
const NOT_DETERMINATION_NOTE = "openFDA 510(k) device clearances are FDA-published premarket-notification records; treat the decision/date/clearance-type as of the source's last publication. This is reference data, not a live regulatory determination.";
const KEYLESS_NOTE = "Keyless: no OPENFDA_API_KEY is set. openFDA allows ~1000 requests/day without a key; a free key raises the rate limit (get one at https://open.fda.gov/apis/authentication/).";
const KEYED_NOTE = "OPENFDA_API_KEY is set — it rides ONLY the &api_key= query parameter to api.fda.gov (openFDA has no header option), raising the rate limit. Its value is NEVER logged, echoed, or placed in this response.";
const NO_FILTER_NOTE = "No structured filters were applied — this is an unscoped scan of the WHOLE 510(k) device-clearance collection. Add applicant / deviceName / productCode / clearanceType / kNumber / state to scope the result set.";
/** Map ONE openFDA 510(k) result row → the curated shape. Every scalar via `str`. */
function mapClearance(row) {
    const r = (row ?? {});
    return {
        applicant: str(r.applicant),
        deviceName: str(r.device_name),
        kNumber: str(r.k_number),
        decisionDate: str(r.decision_date),
        decisionDescription: str(r.decision_description),
        clearanceType: str(r.clearance_type),
        productCode: str(r.product_code),
        advisoryCommittee: str(r.advisory_committee),
        state: str(r.state),
    };
}
/**
 * Assemble the openFDA `search=` Lucene string from structured 510(k) filters — each
 * value Lucene-escaped + phrase-quoted (reusing openfda.ts's `luceneQuote`), joined by
 * ` AND `. Returns "" when no filter is present (openFDA then returns the whole
 * collection). The clause → field mapping is FIXED here; a caller can never inject a
 * raw field:value (no raw Lucene passthrough).
 */
export function buildDeviceSearch(f) {
    const clauses = [];
    if (f.applicant !== undefined)
        clauses.push(`applicant:${luceneQuote(f.applicant)}`);
    if (f.deviceName !== undefined)
        clauses.push(`device_name:${luceneQuote(f.deviceName)}`);
    if (f.productCode !== undefined)
        clauses.push(`product_code:${luceneQuote(f.productCode)}`);
    if (f.clearanceType !== undefined)
        clauses.push(`clearance_type:${luceneQuote(f.clearanceType)}`);
    if (f.kNumber !== undefined)
        clauses.push(`k_number:${luceneQuote(f.kNumber)}`);
    if (f.state !== undefined)
        clauses.push(`state:${luceneQuote(f.state.toUpperCase())}`);
    return clauses.join(" AND ");
}
/**
 * Search openFDA 510(k) DEVICE CLEARANCES with structured filters → curated clearance
 * rows + honest `_meta`. KEYLESS (an OPTIONAL OPENFDA_API_KEY only raises the rate
 * limit). totalAvailable = meta.results.total (EXACT); skip/limit offset pagination.
 * ★A no-match query (openFDA HTTP 404 NOT_FOUND) ⇒ an honest empty, never a throw.
 */
export async function deviceClearances(args) {
    // ── Validate + default the inputs (belt-and-suspenders behind the server Zod; a
    //    DIRECT handler call bypasses Zod). ──
    if (args.state !== undefined && !STATE_RE.test(args.state)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid state ${JSON.stringify(args.state)} — expected a 2-letter US state/territory postal code (^[A-Za-z]{2}$), e.g. "CA".`,
            upstreamEndpoint: DEVICE_LABEL,
        });
    }
    const limit = clampLimit(args.limit);
    const skip = clampSkip(args.skip);
    // ── Assemble the query (structured-only; all VALUES via URLSearchParams — no
    //    host/path steer). The OPTIONAL key rides ONLY here in &api_key=. ──
    const filters = {
        applicant: args.applicant,
        deviceName: args.deviceName,
        productCode: args.productCode,
        clearanceType: args.clearanceType,
        kNumber: args.kNumber,
        state: args.state,
    };
    const search = buildDeviceSearch(filters);
    const filtersApplied = [];
    if (args.applicant !== undefined)
        filtersApplied.push("applicant");
    if (args.deviceName !== undefined)
        filtersApplied.push("deviceName");
    if (args.productCode !== undefined)
        filtersApplied.push("productCode");
    if (args.clearanceType !== undefined)
        filtersApplied.push("clearanceType");
    if (args.kNumber !== undefined)
        filtersApplied.push("kNumber");
    if (args.state !== undefined)
        filtersApplied.push("state");
    const params = new URLSearchParams();
    if (search !== "")
        params.set("search", search);
    params.set("limit", String(limit));
    params.set("skip", String(skip));
    const key = openfdaApiKey();
    if (key !== undefined)
        params.set("api_key", key); // OPTIONAL — &api_key= ONLY
    const url = `https://${OPENFDA_HOST}/device/510k.json?${params.toString()}`;
    // ── Fetch + classify. ★P2 CRUX: a 404 whose body is {error:{code:"NOT_FOUND"}} is
    //    a genuine no-match (or an unknown field) ⇒ an HONEST EMPTY, never a thrown
    //    not_found. Any OTHER 4xx (e.g. 400 syntax) ⇒ invalid_input surfacing openFDA's
    //    message; a 5xx/429 ⇒ the shared taxonomy THROWS. (fetchOpenfda/readOpenfdaError
    //    are the SAME helpers as openfda.ts — the 404-reclassify logic is not reinvented.) ──
    const res = await fetchOpenfda(url, DEVICE_LABEL);
    if (res.status === 404) {
        const { code, message } = await readOpenfdaError(res);
        if (code === "NOT_FOUND") {
            // Honest empty — NOT thrown, NOT not_found (the openFDA no-match idiom).
            return emptyResult(limit, skip, filtersApplied, key !== undefined);
        }
        // A non-NOT_FOUND 404 ⇒ the shared not_found taxonomy (never a fake-empty).
        throw new ToolErrorCarrier({
            ...errorFromResponse(res, DEVICE_LABEL),
            message: message
                ? `openFDA returned HTTP 404 at ${DEVICE_LABEL}: ${message}`
                : `Resource not found at ${DEVICE_LABEL} (HTTP 404).`,
        });
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        // A 4xx OTHER than 404/429 (e.g. 400 syntax) ⇒ invalid_input surfacing the
        // openFDA error message (a caller-fixable request, never a fake-empty).
        const { message } = await readOpenfdaError(res);
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: message
                ? `openFDA rejected the request (HTTP ${res.status}) at ${DEVICE_LABEL}: ${message}`
                : `Bad request (HTTP ${res.status}) at ${DEVICE_LABEL}.`,
            upstreamStatus: res.status,
            upstreamEndpoint: DEVICE_LABEL,
        });
    }
    if (!res.ok) {
        // 429 → rate_limited; 5xx → upstream_unavailable (a DOWN service is NEVER an empty
        // result). Delegated to the shared errors.ts taxonomy.
        throw new ToolErrorCarrier(errorFromResponse(res, DEVICE_LABEL));
    }
    // ── 200 ⇒ parse JSON; a non-JSON body ⇒ r.json() SyntaxError ⇒ schema_drift (never
    //    read as an empty result). ──
    let body;
    try {
        body = await res.json();
    }
    catch (e) {
        if (e instanceof SyntaxError) {
            throw driftError(DEVICE_LABEL, `openFDA ${DEVICE_LABEL} returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).`);
        }
        throw e;
    }
    // ── [P4] meta.results (the total carrier) and results (the rows) MUST be present +
    //    well-shaped; anything else is drift, never a fabricated empty. ──
    const b = (body ?? {});
    const meta = (b.meta ?? {});
    const metaResults = meta.results;
    if (metaResults === undefined ||
        metaResults === null ||
        typeof metaResults !== "object") {
        throw driftError(DEVICE_LABEL, `openFDA ${DEVICE_LABEL} shape drift — meta.results (the skip/limit/total carrier) is missing.`);
    }
    if (!Array.isArray(b.results)) {
        throw driftError(DEVICE_LABEL, `openFDA ${DEVICE_LABEL} shape drift — results must be an array.`);
    }
    const clearances = b.results.map(mapClearance);
    const returned = clearances.length;
    // ── [P1] totalAvailable = meta.results.total EXACT (the REAL total), NEVER
    //    results.length. skip/limit offset pagination. ──
    const rawTotal = metaResults.total;
    const totalAvailable = typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : null;
    const { hasMore, nextOffset, ceilingHit } = openfdaPageMeta(skip, returned, totalAvailable);
    const notes = [NOT_DETERMINATION_NOTE, keyNote(key !== undefined)];
    if (ceilingHit)
        notes.push(OPENFDA_CEILING_NOTE);
    if (filtersApplied.length === 0)
        notes.push(NO_FILTER_NOTE);
    return withMeta({ clearances }, {
        // MODE only — never the key value (K-test).
        source: `${OPENFDA_HOST} /device/510k (openFDA 510(k) device clearances; ${key !== undefined ? "OPENFDA_API_KEY rate-limit key applied" : "keyless"})`,
        keylessMode: true, // a keyless tool; the optional key only raises the rate limit
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset: skip, limit, hasMore, nextOffset },
        notes,
    });
}
// ─── Small helpers ────────────────────────────────────────────────
function keyNote(hasKey) {
    return hasKey ? KEYED_NOTE : KEYLESS_NOTE;
}
/** An honest empty result (★P2: a 404 NOT_FOUND no-match) — returned:0, total:0. */
function emptyResult(limit, skip, filtersApplied, hasKey) {
    return withMeta({ clearances: [] }, {
        source: `${OPENFDA_HOST} /device/510k (openFDA 510(k) device clearances; ${hasKey ? "OPENFDA_API_KEY rate-limit key applied" : "keyless"})`,
        keylessMode: true,
        returned: 0,
        totalAvailable: openfdaEmptyTotal(skip),
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset: skip, limit, hasMore: false, nextOffset: null },
        notes: [
            skip === 0
                ? "No 510(k) device clearances matched this query (openFDA returned HTTP 404 NOT_FOUND at skip 0 — the source's honest no-match). This is an exact empty (total 0), not an error."
                : OPENFDA_OVERSKIP_NOTE,
            NOT_DETERMINATION_NOTE,
            keyNote(hasKey),
        ],
    });
}
function clampLimit(v) {
    if (typeof v !== "number" || !Number.isFinite(v))
        return DEFAULT_LIMIT;
    const n = Math.floor(v);
    if (n < 1)
        return 1;
    if (n > MAX_LIMIT)
        return MAX_LIMIT;
    return n;
}
function clampSkip(v) {
    if (typeof v !== "number" || !Number.isFinite(v))
        return 0;
    const n = Math.floor(v);
    return n < 0 ? 0 : n;
}
//# sourceMappingURL=openfda-device.js.map