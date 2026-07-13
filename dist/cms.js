/**
 * CMS Open Payments — the healthcare industry→physician payment TRANSPARENCY lane
 * on a NEW **DKAN 2.x** datastore adapter (keyless). Source #28 (ADR-0037).
 *
 * A third data-portal family after Socrata SODA (src/socrata.ts) and CKAN Action
 * API (src/ckan.ts) — the DKAN DCAT-metastore + `/api/1/datastore/query` pair.
 * Scoped this cycle to the single confirmed host `openpaymentsdata.cms.gov`, whose
 * flagship datasets are the CMS Open Payments (Physician Payments Sunshine Act,
 * Social Security Act §1128G / 42 CFR Part 403 subpart I) tables: every reported
 * payment / other-transfer-of-value / ownership interest from drug & device
 * manufacturers (and GPOs) to physicians, non-physician practitioners, and
 * teaching hospitals. The B2G unlock: healthcare-COI / industry-financial-
 * relationship vetting + healthcare market intelligence — the money/COI question
 * NPPES (provider identity, src/nppes.ts) cannot answer.
 *
 * TWO tools (mirror the Socrata/CKAN discovery+query split):
 *   - cms_search_datasets — DKAN DCAT metastore discovery. `GET /api/1/metastore/
 *     schemas/dataset/items` returns the FULL catalog ARRAY in one shot (the server
 *     IGNORES limit/offset/page — M2). We fetch it ONCE and do ALL q-substring
 *     filtering + limit/offset slicing CLIENT-SIDE against the in-memory array, so
 *     totalAvailable is the EXACT post-q catalog size and pagination is honest
 *     against the KNOWN length (never a false-more, never a dead-end offset).
 *   - cms_query_dataset — DKAN datastore query by datasetId + distribution index,
 *     with server-side `conditions` filters, an EXACT `count`, offset/limit ≤ 500
 *     pagination, a `properties` projection, and `results:false` = the count/schema
 *     column-discovery mode. Rows pass through VERBATIM (values are text strings).
 *
 * HONESTY (writes ZERO fetch/coerce/error/meta code — REUSES getJson/throughGate/
 * driftError + coerce.num/str + withMeta/buildMeta):
 *   P1 `count` is the EXACT grand total (num-guarded) → totalAvailable=count, real
 *      offset pagination; a PRESENT non-number count in results-mode ⇒ driftError.
 *      limit ≤ 500 is the HARD API cap (Zod .max(500); a higher limit ⇒ invalid_input
 *      client-side, so the API's own 400 is never reached).
 *   P2 empty (`{count:0, results:[]}`) ⇒ honest complete:true; a 400 (bad column /
 *      bad limit) / 404 (bad datasetId/index) / HTML (SPA/WAF) / 5xx / timeout /
 *      non-JSON ⇒ THROW (never a fake empty).
 *   P3 money/amounts (total_amount_of_payment_usdollars, …) are text STRINGS →
 *      surfaced verbatim; coerce.num is null-never-0 (a missing/""/"-" amount → null,
 *      NEVER 0 — the pricing.ts money-lie precedent).
 *   P4 `conditions` are server-side + self-policing: a bad column → the API 400s →
 *      invalid_input; every requested condition either applies or the call errors,
 *      so filtersDropped is ALWAYS empty (no silent-drop path).
 *   P-drift (M1) — the results-array drift guard is CONDITIONED on the effective
 *      `results` mode: results:true (default) REQUIRES Array.isArray(body.results) +
 *      the schema anchor; results:false EXPECTS results ABSENT (rows:[], no throw)
 *      and uses schema presence + a number-typed count as the drift anchor. The
 *      schema block (keyed by the DISTRIBUTION id) is the anchor — fields are read
 *      from Object.values(schema)[0].fields.
 *
 * SSRF (the CKAN/Socrata fixed-host idiom, COPIED not imported). The load-bearing
 * risk: `datasetId` + `index` interpolate into the URL PATH
 * (`/api/1/datastore/query/{datasetId}/{index}`), so URLSearchParams does NOT
 * protect them. Validate datasetId against the strict 36-char LOWERCASE UUID
 * grammar (the CKAN UUID_RE verbatim — rejects %2F, "..", uppercase, a trailing
 * "\n") and index as a small non-negative int BEFORE interpolation; every OTHER
 * param (conditions[i][*], properties[], limit, offset, count, results) rides the
 * query string via URLSearchParams. Host is a compile-time constant; a
 * post-construction hostname/protocol assert + redirect:"error" fail closed.
 *
 * PII / scope boundary (NPPES precedent): Open Payments NAMES individual physicians
 * + payment amounts AND is a federal transparency-BY-LAW public dataset — IN-SCOPE
 * per the NPPES/NSF-PI precedent, bounded to targeted vetting (per-query limit ≤ 500
 * + an offset reach cap S3, no enrichment, NO covered_recipient_npi→NPPES auto-join,
 * a mandatory not-a-COI-finding / cross-check-SAM+OFAC+LEIE caveat on every response).
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, throughGate, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` from this module (cms.num === coerce.num — a num regression fails together).
export { num };
// ─── Fixed host allowlist (SSRF core — compile-time CONSTANTS) ────
// Single-entry allowlist, structured for a later host-add exactly like CKAN_HOSTS.
// A future DKAN gov portal is a one-line edit + a live `?limit=1` verification.
export const CMS_HOSTS = ["openpaymentsdata.cms.gov"];
const CMS_HOST = CMS_HOSTS[0];
const CMS_HOST_SET = new Set(CMS_HOSTS);
// HOST-only label. Surfaces in ToolError.upstreamEndpoint; keyless → no token.
const CMS_LABEL = "cms:" + CMS_HOST;
// Modest self-throttle (courteous to a single public gov host; matches the
// NPPES/ECHO/CKAN defensive posture — no documented hard rate limit).
const CMS_GATE_MIN_INTERVAL_MS = 200;
// ─── Grammars + caps (SSRF + honesty guards) ─────────────────────
// A DKAN datasetId is EXACTLY a 36-char LOWERCASE hex UUID (the CKAN UUID_RE
// verbatim). m1: JS `$` does NOT admit a trailing "\n" (unlike Python) — the regex
// alone rejects a newline; `.length(36)` is belt-and-suspenders. m2: lowercase-only
// (no `i` flag) — every live DKAN id is a 36-char lowercase UUID.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A DKAN column name is snake_case lowercase alnum (verified). A bad one 400s
// upstream anyway, but we validate to keep the wire clean and the PATH unbreakable.
const COLUMN_RE = /^[a-z0-9_]+$/;
const MAX_COLUMN_LEN = 128;
const MAX_VALUE_LEN = 200;
// The `conditions[i][operator]` ENUM (DKAN 400s an unknown operator).
export const CMS_OPERATORS = ["=", "<>", "<", ">", "<=", ">=", "like", "in"];
const CMS_OPERATOR_SET = new Set(CMS_OPERATORS);
const CMS_MAX_LIMIT = 500; // the HARD DKAN cap (400s over it — no silent clamp).
const CMS_DEFAULT_LIMIT = 100;
const CMS_MAX_INDEX = 50; // distributions are single-digit.
const CMS_MAX_CONDITIONS = 10; // bound URL length.
// ★ S3 — our OWN server POLICY offset/reach cap (mirrors NPPES_MAX_SKIP). Open
// Payments names individual physicians + dollar amounts (MORE sensitive than
// NPPES), so we impose a deliberate targeted-lookup boundary. The EXACT count
// SIZES a harvest; it does not BOUND it — this cap does.
const CMS_MAX_OFFSET = 2000;
// ─── Disclosure constants (honesty obligations — verbatim, fault-asserted) ──
/**
 * ★ The mandatory not-a-determination caveat carried on EVERY cms_query_dataset /
 * cms_search_datasets response (mirrors NPPES_NOT_DETERMINATION_NOTE /
 * OFAC_NOT_DETERMINATION_NOTE). Kept verbatim so the fault suite can assert it.
 */
export const CMS_OPEN_PAYMENTS_NOT_DETERMINATION_NOTE = "Public transparency-by-law data (CMS Open Payments, Physician Payments Sunshine Act). Reports reported industry payments / transfers of value / ownership interests ONLY — it is NOT a conflict-of-interest finding, a fitness/exclusion determination, or evidence of wrongdoing (many payments are routine and lawful). Individual records name physicians, teaching hospitals, and dollar amounts verbatim from the public dataset; this tool performs NO enrichment and NO cross-source join (e.g. it does NOT auto-join covered_recipient_npi to NPPES). Cross-check SAM exclusions + OFAC for debarment/sanctions and the OIG-LEIE for healthcare exclusions.";
/** ★ S3 — the per-query reach-cap POLICY disclosure carried on EVERY response. */
export const CMS_OPEN_PAYMENTS_REACH_CAP_NOTE = "This vetting tool reaches at most the first ~2,500 rows per query (limit ≤ 500, offset ≤ 2,000) as a deliberate targeted-lookup boundary — Open Payments names individual physicians AND dollar amounts, so the reach is bounded like NPPES. The EXACT count sizes a result set but does not bound a harvest; this is a PER-QUERY cap only (cross-query iteration is inherent to any datastore API). Narrow your `conditions` (recipient_state / specialty / manufacturer) for a complete, targeted result set, or use the metastore distribution downloadURL for a bulk pull.";
const VALUE_TYPING_NOTE = "Row value fields follow schema.fields[].type; every Open Payments column is text, so a numeric column (e.g. total_amount_of_payment_usdollars) arrives as a STRING verbatim — a missing amount is absent, never 0 (coerce with null-never-0 semantics).";
const SOURCE = "openpaymentsdata.cms.gov (CMS Open Payments, DKAN datastore, keyless)";
// ─── invalid_input helper ─────────────────────────────────────────
function invalidInput(message) {
    return new ToolErrorCarrier({
        kind: "invalid_input",
        message,
        retryable: false,
        upstreamEndpoint: CMS_LABEL,
    });
}
/** Strip C0 control chars + DEL and trim (URLSearchParams encodes the rest). */
function sanitizeText(v) {
    let out = "";
    for (const ch of v) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f)
            continue;
        out += ch;
    }
    return out.trim();
}
// ─── SSRF-guarded fetch layer ─────────────────────────────────────
/**
 * GET a DKAN datastore query. SSRF: host ∈ allowlist (belt-and-suspenders behind
 * the server's Zod), datasetId is a 36-char lowercase UUID + index is a small
 * non-negative int (BOTH re-checked here BEFORE they interpolate into the PATH),
 * and the CONSTRUCTED URL's hostname === host (https). redirect:"error" (off-host
 * 3xx fails closed). Keyless — NO headers. Returns parsed JSON (caller validates).
 */
async function getDatastore(datasetId, index, params) {
    if (!CMS_HOST_SET.has(CMS_HOST)) {
        throw invalidInput(`CMS host ${JSON.stringify(CMS_HOST)} is not on the curated allowlist.`);
    }
    // ★ PATH-interpolation guards (load-bearing — datasetId + index ride the PATH).
    if (datasetId.length !== 36 || !UUID_RE.test(datasetId)) {
        throw invalidInput(`Invalid CMS datasetId ${JSON.stringify(datasetId)} — expected a 36-char lowercase UUID ([0-9a-f]{8}-{4}-{4}-{4}-{12}); it interpolates into the URL path, so a %2F/../uppercase/newline id is refused (SSRF safety).`);
    }
    if (!Number.isInteger(index) || index < 0 || index > CMS_MAX_INDEX) {
        throw invalidInput(`Invalid CMS index ${JSON.stringify(index)} — expected a non-negative integer 0..${CMS_MAX_INDEX} (the distribution index; it interpolates into the URL path).`);
    }
    const url = `https://${CMS_HOST}/api/1/datastore/query/${datasetId}/${index}?${params.toString()}`;
    const built = new URL(url);
    if (built.hostname !== CMS_HOST || built.protocol !== "https:") {
        throw invalidInput(`Constructed CMS URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match ${CMS_HOST} over https — refusing to fetch (SSRF safety).`);
    }
    // ★ W3-2 — the SyntaxError→schema_drift catch-ladder (fema.ts:262-275 shape).
    // getJson's r.json() runs OUTSIDE fetchWithRetry, so a 200 non-JSON body (a DKAN
    // SPA/WAF/maintenance HTML masquerade) throws a raw SyntaxError; toToolError has
    // NO schema_drift branch → it would degrade to kind:"unknown". Preserve the
    // fetchWithRetry taxonomy (429/404/5xx/400/timeout ToolErrorCarrier) FIRST (a
    // broader catch would reclassify a 429 to schema_drift), reclassify the SyntaxError
    // SECOND, bare-rethrow LAST.
    try {
        return await throughGate(CMS_HOST, CMS_GATE_MIN_INTERVAL_MS, () => getJson(url, { label: CMS_LABEL, redirect: "error" }));
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(CMS_LABEL, "CMS DKAN datastore returned a non-JSON body at HTTP 200 — schema drift.");
        throw e;
    }
}
/**
 * GET the DKAN DCAT metastore catalog (fixed path; no id interpolation).
 *
 * ★ D1 — `?show-reference-ids` is REQUIRED (not optional). The FLAT default endpoint
 * (`…/items` with no params) returns each distribution as a top-level bag of keys
 * (downloadURL/format/mediaType/title) with NO distribution `identifier` and NO
 * nested `data` object — so mapDataset's `{identifier, data:{downloadURL,…}}` reader
 * would resolve distId + downloadURL + mediaType + title to NULL for every row
 * (dropping the real advertised bulk-download URL the reach-cap note points callers
 * to). ONLY `?show-reference-ids` carries BOTH the distribution `identifier` AND the
 * nested `data:{downloadURL,mediaType,title}` block. It is an ORTHOGONAL
 * reference-expansion flag — the endpoint STILL ignores limit/offset/page and ships
 * the full catalog in one shot, so the M2 client-side-slice behavior is unchanged.
 */
async function getMetastore() {
    const url = `https://${CMS_HOST}/api/1/metastore/schemas/dataset/items?show-reference-ids`;
    const built = new URL(url);
    if (built.hostname !== CMS_HOST || built.protocol !== "https:") {
        throw invalidInput(`Constructed CMS metastore URL host ${JSON.stringify(built.hostname)} does not match ${CMS_HOST} over https — refusing to fetch (SSRF safety).`);
    }
    // ★ W3-2 — the IDENTICAL SyntaxError→schema_drift catch-ladder as getDatastore
    // (fema.ts:262-275 shape). A 200 non-JSON metastore body (HTML/WAF) throws a raw
    // SyntaxError from r.json() → without this it degrades to kind:"unknown". Preserve
    // the ToolErrorCarrier taxonomy FIRST, reclassify SECOND, bare-rethrow LAST.
    try {
        return await throughGate(CMS_HOST, CMS_GATE_MIN_INTERVAL_MS, () => getJson(url, { label: CMS_LABEL, redirect: "error" }));
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(CMS_LABEL, "CMS DKAN metastore returned a non-JSON body at HTTP 200 — schema drift.");
        throw e;
    }
}
function rec(x) {
    return x !== null && typeof x === "object" && !Array.isArray(x)
        ? x
        : {};
}
/**
 * Read the fields block from the DKAN schema (keyed by the DISTRIBUTION id, distinct
 * from the datasetId — §fact 8). `Object.values(schema)[0].fields` is the drift
 * anchor. Returns the mapped fields, or `null` when the anchor is missing/malformed
 * (the caller turns a null anchor into driftError — never a fake empty).
 */
function readFields(schema) {
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
        return null;
    }
    const distributions = Object.values(schema);
    if (distributions.length === 0)
        return null;
    const first = rec(distributions[0]);
    const fields = first.fields;
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
        return null;
    }
    const out = [];
    for (const [name, def] of Object.entries(fields)) {
        const d = rec(def);
        out.push({
            name,
            type: str(d.type),
            mysqlType: str(d.mysql_type),
            description: str(d.description),
        });
    }
    return out;
}
/**
 * Query a DKAN datastore distribution by datasetId + index. Server-side `conditions`
 * filters (self-policing — a bad column 400s → invalid_input, so filtersDropped is
 * always empty), an EXACT `count` (real offset pagination), a `properties`
 * projection, and `results:false` = the count/schema column-discovery mode (M1/S1:
 * rows omitted, pagination disabled — no livelock). count=true is ALWAYS on the wire
 * (S2 — never a caller toggle). Rows pass through VERBATIM (strings). A 400 (bad
 * column/limit) / 404 (bad datasetId/index) / HTML / 5xx / timeout ⇒ THROW.
 */
export async function queryDataset(args) {
    // NO .trim() — the CKAN/Socrata precedent: a trailing "\n" must reach the
    // length(36)+UUID_RE guard (trimming would strip it and admit a newline-suffixed id).
    const datasetId = args.datasetId === undefined || args.datasetId === null ? "" : String(args.datasetId);
    const index = args.index ?? 0;
    const limit = args.limit ?? CMS_DEFAULT_LIMIT;
    const offset = args.offset ?? 0;
    const results = args.results ?? true;
    // ── Client-side caps (belt-and-suspenders behind Zod; SSRF: no fetch on reject). ──
    if (!Number.isInteger(limit) || limit < 1 || limit > CMS_MAX_LIMIT) {
        throw invalidInput(`limit ${JSON.stringify(args.limit)} out of range — DKAN caps a datastore page at ${CMS_MAX_LIMIT} (the API 400s over it; this tool rejects it loudly). Use 1..${CMS_MAX_LIMIT}.`);
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > CMS_MAX_OFFSET) {
        throw invalidInput(`offset ${JSON.stringify(args.offset)} out of range — this vetting tool caps reach at offset ≤ ${CMS_MAX_OFFSET} (a deliberate targeted-lookup POLICY boundary; Open Payments names physicians + amounts). Narrow your conditions rather than paging deeper.`);
    }
    // ── Build + validate the wire query (SSRF: key-by-key from typed args). ──
    const params = new URLSearchParams();
    // S2 — ALWAYS emit count=true (never a caller toggle; mirror the ckan.ts
    // always-exact-total doctrine).
    params.set("count", "true");
    params.set("results", results ? "true" : "false");
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    const filtersApplied = [];
    // conditions (server-side, self-policing — a bad column 400s, never a silent drop).
    const conditions = args.conditions ?? [];
    if (conditions.length > CMS_MAX_CONDITIONS) {
        throw invalidInput(`Too many conditions (${conditions.length}) — cap is ${CMS_MAX_CONDITIONS} to bound URL length.`);
    }
    conditions.forEach((c, i) => {
        const property = sanitizeText(String(c.property ?? ""));
        if (property.length === 0 || property.length > MAX_COLUMN_LEN || !COLUMN_RE.test(property)) {
            throw invalidInput(`Invalid condition[${i}].property ${JSON.stringify(c.property)} — a DKAN column is snake_case lowercase alnum (^[a-z0-9_]+$).`);
        }
        const operator = c.operator === undefined ? "=" : String(c.operator);
        if (!CMS_OPERATOR_SET.has(operator)) {
            throw invalidInput(`Invalid condition[${i}].operator ${JSON.stringify(c.operator)} — expected one of ${CMS_OPERATORS.join(" ")}.`);
        }
        const rawValue = typeof c.value === "number" ? String(c.value) : sanitizeText(String(c.value ?? ""));
        if (rawValue.length > MAX_VALUE_LEN) {
            throw invalidInput(`condition[${i}].value is too long (max ${MAX_VALUE_LEN} chars).`);
        }
        params.set(`conditions[${i}][property]`, property);
        params.set(`conditions[${i}][value]`, rawValue);
        params.set(`conditions[${i}][operator]`, operator);
        filtersApplied.push(`${property} ${operator} ${rawValue}`);
    });
    // properties projection (column subset — same snake_case grammar).
    const properties = args.properties ?? [];
    properties.forEach((p, i) => {
        const col = sanitizeText(String(p ?? ""));
        if (col.length === 0 || col.length > MAX_COLUMN_LEN || !COLUMN_RE.test(col)) {
            throw invalidInput(`Invalid properties[${i}] ${JSON.stringify(p)} — a DKAN column is snake_case lowercase alnum (^[a-z0-9_]+$).`);
        }
        params.append("properties[]", col);
    });
    if (properties.length > 0)
        filtersApplied.push("properties");
    const body = await getDatastore(datasetId, index, params);
    const b = rec(body);
    // ── Schema anchor (the drift anchor, keyed by the distribution id). ──
    const fields = readFields(b.schema);
    if (fields === null) {
        throw driftError(CMS_LABEL, `${CMS_LABEL} datastore query returned a body without a usable schema anchor (Object.values(schema)[0].fields missing) — treating as schema drift, never a fake empty.`);
    }
    const notes = [VALUE_TYPING_NOTE];
    let rows;
    let totalAvailable;
    let hasMore;
    let returned;
    // ── count (P1/S2): a PRESENT non-number count in either mode ⇒ driftError; an
    //    ABSENT count in results:true ⇒ hedge (never fabricate a total). ──
    const rawCount = b.count;
    const countPresent = rawCount !== undefined;
    const countIsNumber = typeof rawCount === "number" && Number.isFinite(rawCount);
    if (countPresent && !countIsNumber) {
        throw driftError(CMS_LABEL, `${CMS_LABEL} datastore query returned a non-number \`count\` — treating as schema drift (typeof-checked BEFORE num()).`);
    }
    if (results) {
        // ★ M1 — results:true (default): REQUIRE Array.isArray(body.results) else drift.
        if (!Array.isArray(b.results)) {
            throw driftError(CMS_LABEL, `${CMS_LABEL} datastore query (results:true) returned a body whose \`results\` is missing or not an array — treating as schema drift, never a fake empty.`);
        }
        rows = b.results.map(rec);
        returned = rows.length;
        if (countIsNumber) {
            totalAvailable = num(rawCount);
            hasMore = totalAvailable !== null ? offset + returned < totalAvailable : returned >= limit;
        }
        else {
            // S2 belt-and-suspenders — count absent from a results-mode body: hedge with
            // page-fullness, never fabricate a total.
            totalAvailable = null;
            hasMore = returned >= limit;
            notes.push("The upstream did not report `count` on this results:true response; totalAvailable is withheld (null) and completeness is inferred from page-fullness (a short page means the result set is exhausted) — never a fabricated total.");
        }
    }
    else {
        // ★ M1/S1 — results:false: EXPECT `results` ABSENT (rows omitted, NOT results:[]).
        // Drift anchor = schema presence (already checked) + a number-typed count. Do
        // NOT throw on an absent `results`. Pagination is DISABLED (no livelock — S1).
        if (!countIsNumber) {
            throw driftError(CMS_LABEL, `${CMS_LABEL} datastore query (results:false) returned a body without a number-typed \`count\` — the count/schema-discovery anchor is absent; treating as schema drift.`);
        }
        rows = [];
        returned = 0;
        totalAvailable = num(rawCount);
        hasMore = false; // S1 — results:false is a count/schema mode; no rows to page.
        notes.push("results:false is a COUNT/SCHEMA-discovery mode: no rows are returned and pagination is disabled (hasMore:false). To page rows, set results:true with limit/offset. totalAvailable is the EXACT match count and `fields` describes every column.");
    }
    const nextOffset = hasMore ? offset + returned : null;
    notes.push(CMS_OPEN_PAYMENTS_NOT_DETERMINATION_NOTE, CMS_OPEN_PAYMENTS_REACH_CAP_NOTE);
    const meta = {
        source: SOURCE,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        // P4 — a bad column 400s upstream (→ invalid_input); a filter is never silently
        // dropped, so filtersDropped is provably always empty for this source.
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    };
    return withMeta({ datasetId, index, results, fields, rows }, meta);
}
/** Map ONE DCAT metastore item → a curated discovery row. */
function mapDataset(raw) {
    const r = rec(raw);
    const rawDist = Array.isArray(r.distribution) ? r.distribution : [];
    const distributions = rawDist.map((d, i) => {
        const dd = rec(d);
        const data = rec(dd.data);
        return {
            index: i,
            distId: str(dd.identifier),
            title: str(data.title),
            mediaType: str(data.mediaType),
            downloadURL: str(data.downloadURL),
        };
    });
    const keyword = Array.isArray(r.keyword)
        ? (r.keyword.map(str).filter((k) => k !== null))
        : [];
    return {
        datasetId: str(r.identifier),
        title: str(r.title),
        description: str(r.description),
        distributions,
        keyword,
        modified: str(r.modified),
    };
}
/** Case-insensitive substring match over title + description. */
function matchesQ(d, q) {
    const needle = q.toLowerCase();
    return ((d.title !== null && d.title.toLowerCase().includes(needle)) ||
        (d.description !== null && d.description.toLowerCase().includes(needle)));
}
/**
 * Discover DKAN datasets via the DCAT metastore. ★ M2 — the metastore IGNORES
 * limit/offset/page and always ships the ENTIRE catalog array in one response, so we
 * fetch it ONCE and apply ALL q-substring filtering + limit/offset slicing
 * CLIENT-SIDE against the in-memory array: totalAvailable = the EXACT post-q catalog
 * size (never null), hasMore = offset + returned < filteredLength, nextOffset
 * against the KNOWN length (never a server offset — no false-more, no dead-end).
 */
export async function searchDatasets(args) {
    const q = args.q !== undefined && args.q !== null ? sanitizeText(String(args.q)) : "";
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw invalidInput(`limit ${JSON.stringify(args.limit)} out of range — use 1..100.`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
        throw invalidInput(`offset ${JSON.stringify(args.offset)} out of range — use a non-negative integer.`);
    }
    const body = await getMetastore();
    // ★ M2 — the metastore is a BARE ARRAY (no envelope, no total). A non-array body
    // is drift, never a fake empty.
    if (!Array.isArray(body)) {
        throw driftError(CMS_LABEL, `${CMS_LABEL} metastore returned an unexpected shape (GET /api/1/metastore/schemas/dataset/items must be a JSON array of DCAT datasets).`);
    }
    const all = body.map(mapDataset);
    const filtered = q === "" ? all : all.filter((d) => matchesQ(d, q));
    const filteredLength = filtered.length; // EXACT post-q catalog size (M2).
    const page = filtered.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < filteredLength;
    const nextOffset = hasMore ? offset + returned : null;
    const filtersApplied = q === "" ? [] : ["q"];
    const notes = [
        "The DKAN metastore returns the entire dataset catalog in one response; q/limit/offset are applied CLIENT-SIDE and totalAvailable is the exact catalog size (post-q).",
        "Feed a result's datasetId + a distribution index to cms_query_dataset (use results:false there for the column schema before pulling rows).",
        CMS_OPEN_PAYMENTS_NOT_DETERMINATION_NOTE,
    ];
    return withMeta({ query: q === "" ? null : q, results: page }, {
        source: `${CMS_HOST} DKAN metastore (CMS Open Payments, keyless)`,
        keylessMode: true,
        returned,
        totalAvailable: filteredLength,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    });
}
//# sourceMappingURL=cms.js.map