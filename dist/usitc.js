/**
 * USITC Harmonized Tariff Schedule (HTS) — the IMPORT-TARIFF / supply-chain PRICE
 * lane on a NEW keyless REST source (ADR-0039). Source #30; tool snapshot 102 →
 * 103. A Price-lane sibling of pricing.ts: it extends the THIN Price lane with a
 * NON-labor cost input — a good's HTS classification + its Column-1 General /
 * Special (preferential/FTA) / Column-2 duty-rate TEXT + the Section 301/232 /
 * Chapter-99 additional-duty provisions. Fully PUBLIC open data; KEYLESS (no key,
 * no header gate); no PII (product/tariff/classification data only).
 *
 * ONE tool — `hts_lookup`: a single `query` (a KEYWORD or an HTS NUMBER — both
 * ride `keyword=`) → the matching classification rows across the HTS hierarchy.
 *   Wire: GET https://hts.usitc.gov/reststop/search?keyword=<query>
 *   Body: a BARE JSON ARRAY (NO envelope, NO total, NO server pagination) of rows
 *   { htsno, statisticalSuffix, description, indent, units[], footnotes[],
 *     general, other, special, additionalDuties, quotaQuantity, effectivePeriod,
 *     status, … }.
 *
 * ★ THE DUTY-RATE HONESTY CRUX (P0 — load-bearing).
 * `general` (Column-1 General), `special` (Special/preferential), `other`
 * (Column-2) are AUTHORITATIVE VERBATIM TEXT — surfaced via `str` (trim only),
 * NEVER via `num`. `num("Free")`→null, `num("35%")`→NaN→null; a coerced 0/null
 * would render a FALSE "duty-free" (the money-lie class, inverted — here the
 * authoritative value IS text and coercion DESTROYS it). This module deliberately
 * does NOT import `num`, so no rate field can ever be numeric (the absence of
 * `num` is itself the guard; ofac.ts/pricing.ts omit it too). An empty `special`
 * ("") → str→null, disclosed as "no special-program rate" — NEVER read as Free.
 *
 * HONESTY (writes ZERO fetch/coerce/error/meta code — REUSES getJson/throughGate/
 * driftError + coerce.str + withMeta/buildMeta):
 *   P1 (completeness) — NO upstream total + NO server pagination (the `offset`
 *      param is IGNORED). `totalAvailable = served array.length` (the EXACT count
 *      the endpoint served — honest relative to what the source returns); paging is
 *      CLIENT-SIDE over the held array (never trust a server offset). The M2
 *      disclosure states there is no fixed cap and a single-char/common fragment
 *      can serve 10,000–16,000+ rows (several MB).
 *   ★M1 (hierarchy) — the duty rate is stated ONCE at a shallower level (usually the
 *      6/8-digit subheading) and inherits DOWNWARD to the blank statistical-suffix
 *      lines. A header/blank row's empty rate stays `null` (never fabricated); the
 *      hierarchy note tells the consumer to read UP to the nearest ANCESTOR line
 *      (SHALLOWER indent, same htsno prefix) with a non-empty rate — never to read
 *      the (blank) deepest line as no/unknown duty.
 *   ★M2 (no false ceiling) — the completeness note NEVER claims a "~900" cap; a
 *      MINIMUM query floor (≥3 non-whitespace chars) rejects a 1–2 char query as
 *      invalid_input BEFORE the fetch (closes the multi-MB "s"/"e" path); a
 *      belt-and-suspenders size bound (HTS_MAX_ROWS) discloses a very-large result.
 *   P2 (empty-vs-outage) — a no-match `[ ]` (HTTP 200) ⇒ honest empty; a
 *      400(→S2)/404/5xx/timeout/non-array/HTML(SyntaxError→schema_drift) ⇒ THROW
 *      (never a fake empty). The SyntaxError→schema_drift wrap mirrors fdic.ts.
 *   ★S1 (additionalDuties) — the per-line `additionalDuties` field is frequently
 *      null even when Section 301/232 duties apply; the additional duty rides the
 *      separate Chapter-99 (`isChapter99`) rows + the footnotes — disclosed.
 *   ★S2 (transient 400) — the query is PRE-VALIDATED (≥3 chars, control-stripped,
 *      ≤100), so an HTTP 400 is not a caller fault: it is remapped to
 *      upstream_unavailable (transient, retryable) for this source.
 *   ★S3 (fieldsUnavailable) — per-line empty rate fields are NOT hoisted into
 *      top-level `_meta.fieldsUnavailable` (rate nullity is per-line-normal per M1);
 *      that field is reserved for a field genuinely absent across the WHOLE response.
 *
 * SSRF — fixed host `hts.usitc.gov` (compile-time constant + Set.has recheck),
 * FIXED path `/reststop/search` (never caller free-text), the `query` value rides
 * `keyword=` via URLSearchParams (percent-encoded — a crafted `../exportList` /
 * `x&format=…` / off-host value cannot alter the host/path or inject a param); the
 * value is control-stripped + length-bounded (≥3, ≤100); a post-construction
 * hostname/protocol assert + `redirect:"error"` fail closed.
 *
 * Not-a-customs-ruling caveat (the Price-lane honesty boundary — the analog of
 * pricing.ts's "not the rate paid" + the FAC/OFAC *_NOT_DETERMINATION_NOTE): every
 * response carries HTS_NOT_A_RULING_NOTE.
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, throughGate, driftError } from "./datasource.js";
import { str } from "./coerce.js";
import { withMeta } from "./meta.js";
// NOTE: `num` is DELIBERATELY NOT imported. The three duty-rate fields
// (general/special/other) are authoritative VERBATIM TEXT and must NEVER be
// coerced to a number (num("Free")→null / num("35%")→NaN = a destroyed rate / a
// false duty-free). The absence of `num` in this module is the honesty guard —
// no rate field can ever be numeric. (num-parity: usitc.ts OMITS `export { num }`
// exactly like ofac.ts / pricing.ts — consistent, not a regression.)
// ─── Fixed host allowlist + path (SSRF core — compile-time CONSTANTS) ──────────
// Single-entry allowlist, structured for a later host-add exactly like CMS_HOSTS.
export const USITC_HOSTS = ["hts.usitc.gov"];
const USITC_HOST = USITC_HOSTS[0];
const USITC_HOST_SET = new Set(USITC_HOSTS);
// The FIXED search path — the TOOL chooses it; NEVER caller free-text (the
// `exportList` range-export path is a separate DEFERRED constant, never selected
// by caller input).
const USITC_SEARCH_PATH = "/reststop/search";
// HOST-only label. Surfaces in ToolError.upstreamEndpoint; keyless → no token.
const USITC_LABEL = "usitc:" + USITC_HOST;
// The throughGate KEY — host-scoped. Grep-confirmed unique (no other source uses
// `usitc`). A modest self-throttle as courtesy to the single shared USITC host.
const USITC_GATE_KEY = "usitc";
const USITC_MIN_INTERVAL_MS = 200;
// ─── Query bounds (M2 floor + SSRF cap) + client-side paging bounds ────────────
// ★M2 — a MINIMUM query floor: a query with < 3 non-whitespace chars is rejected
// BEFORE the fetch (a 1–2 char / single-char fragment can force a 10,000–16,000+
// row / multi-MB fetch+parse against the single shared host).
const HTS_MIN_QUERY_CHARS = 3;
// SSRF length cap — the `keyword` value rides URLSearchParams; a length bound keeps
// the wire clean.
const HTS_MAX_QUERY_LEN = 100;
const HTS_DEFAULT_LIMIT = 50;
const HTS_MAX_LIMIT = 200;
// ★M2 belt-and-suspenders — a hard row-count ceiling. When the served array
// exceeds this we still set `totalAvailable` to the TRUE served length but return
// only the client-side page + an explicit "result set is very large" disclosure.
export const HTS_MAX_ROWS = 5000;
// ─── Disclosure constants (honesty obligations — verbatim, fault-asserted) ─────
/**
 * ★ The mandatory not-a-customs-ruling caveat carried on EVERY hts_lookup response
 * (mirrors pricing.ts's CALC caveats + FAC_NOT_DETERMINATION_NOTE /
 * OFAC_NOT_DETERMINATION_NOTE). Kept verbatim so the fault suite can assert it.
 */
export const HTS_NOT_A_RULING_NOTE = "Harmonized Tariff Schedule data (USITC HTS). These are the PUBLISHED schedule rates — Column-1 General, Special (preferential/FTA), and Column-2 — NOT a binding CBP classification ruling and NOT a landed-cost quote. The duty actually owed depends on the good's correct classification, its COUNTRY OF ORIGIN, the applicable trade program/FTA, and ADDITIONAL duties (Section 301/232, antidumping/countervailing, and any Chapter 99 [`99..`] provisions returned alongside the base line). Rate values are VERBATIM text (`Free`, a percentage, a specific `$/unit`, or a compound rate) — read them in context, never as a bare number. Confirm the classification and obtain a binding ruling via CBP (CROSS / eRulings) before pricing an import.";
/**
 * ★M1 — the hierarchy rate-inheritance disclosure. The rate inherits DOWNWARD; the
 * consumer must read UP to the nearest ANCESTOR line (NOT the blank deepest line).
 * Carried on EVERY response. RED if this ever says "read the deepest line".
 */
export const HTS_HIERARCHY_NOTE = "A lookup returns rows across hierarchy levels. The duty rate is stated at one level (usually the 6/8-digit subheading) and APPLIES TO ALL DEEPER statistical-suffix lines below it, which are typically blank. To find the rate for a specific statistical line, read UP to the nearest ANCESTOR line (SHALLOWER indent, same htsno prefix) that has a non-empty rate — never conclude a blank deepest line means no/unknown duty.";
/**
 * ★M2 — the completeness disclosure. NO server total, NO working pagination (the
 * `offset` param is ignored); `totalAvailable` is the EXACT served array length;
 * paging is client-side. NO "~900" ceiling — a single-char/common fragment can
 * serve 10,000–16,000+ rows / several MB. Carried on EVERY response.
 */
export const HTS_COMPLETENESS_NOTE = "The USITC HTS search endpoint returns the FULL match set for a query with NO server-side total and NO working pagination (the `offset` param is IGNORED); `totalAvailable` is the EXACT length of the array the endpoint served for this query, and paging is applied CLIENT-SIDE over that held array. There is NO fixed row cap — a single-character or common fragment can return 10,000–16,000+ rows (several MB) in one response — so narrow the query (a more specific keyword or a fuller HTS number) for a targeted classification.";
/**
 * ★S1 / P4 — the additional-duty disclosure. `additionalDuties` is frequently null
 * even when Section 301/232 duties apply; the real additional duty rides the
 * Chapter-99 rows + the footnotes. Carried on EVERY response.
 */
export const HTS_ADDITIONAL_DUTY_NOTE = "The per-line `additionalDuties` field is frequently null even when Section 301/232 additional duties apply — it is NOT a reliable signal for their absence. Additional duties are carried by the separate Chapter-99 rows (`isChapter99:true`, htsno beginning `99`) returned alongside the base line and by the per-line `footnotes`; check those, not `additionalDuties`. A Chapter-99 provision STACKS on top of the base-line rate — the base classification's landed duty is NOT complete without checking them.";
/** Conditional — surfaced when a returned line has an empty Special rate. */
export const HTS_EMPTY_SPECIAL_NOTE = "One or more lines have an empty Special (preferential/FTA/GSP) rate, surfaced as `specialPreferential: null` — this means NO special-program rate is published for that line (the Column-1 General rate applies unless a specific trade program qualifies). An empty/null Special is NEVER 'Free'.";
/** Conditional — surfaced when a returned line is a Chapter-99 provision. */
export const HTS_CHAPTER99_PRESENT_NOTE = "This result set includes Chapter-99 rows (`isChapter99:true`, htsno beginning `99`) — ADDITIONAL-duty provisions (Section 301/232, safeguards, temporary/other special duties) that STACK on top of the base-line rate; include them when computing landed duty.";
/** ★M2 belt — surfaced when the served array exceeds HTS_MAX_ROWS. */
export const HTS_LARGE_RESULT_NOTE = `This result set is VERY LARGE (over ${HTS_MAX_ROWS.toLocaleString()} rows served in one response); only the requested \`limit\`/\`offset\` page is returned (client-side) while \`totalAvailable\` reflects the TRUE served length. Narrow the query (a more specific keyword or a fuller HTS number) for a targeted, complete result set.`;
/** Conditional — surfaced when a returned description had `<il>` markup stripped. */
export const HTS_MARKUP_NOTE = "Line descriptions had USITC inline markup (`<il>…</il>`) stripped to plain text (the inner text is preserved); the semantic content is unchanged.";
const SOURCE = "hts.usitc.gov/reststop/search (USITC HTS, keyless)";
// ─── invalid_input helper ──────────────────────────────────────────────────────
function invalidInput(message) {
    return new ToolErrorCarrier({
        kind: "invalid_input",
        message,
        retryable: false,
        upstreamEndpoint: USITC_LABEL,
    });
}
/** Strip C0 control chars + DEL and trim (URLSearchParams encodes the rest). */
function sanitizeQuery(v) {
    let out = "";
    for (const ch of v) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f)
            continue;
        out += ch;
    }
    return out.trim();
}
/**
 * Minimal, documented HTS markup strip: `<il>…</il>` → inner text preserved.
 * Only these presentation tags are removed (never the inner text). Returns
 * `{ value, stripped }` so the handler can disclose that a strip occurred.
 */
function stripHtsMarkup(raw) {
    const s = str(raw);
    if (s === null)
        return { value: null, stripped: false };
    if (!/<\/?il>/i.test(s))
        return { value: s, stripped: false };
    const cleaned = s.replace(/<\/?il>/gi, "").replace(/\s+/g, " ").trim();
    return { value: cleaned === "" ? null : cleaned, stripped: true };
}
// ─── SSRF-guarded fetch layer ──────────────────────────────────────────────────
/**
 * GET the HTS search endpoint. SSRF: host ∈ allowlist (belt-and-suspenders),
 * FIXED path constant (no caller value on the path), the CONSTRUCTED URL's
 * hostname === host over https, `redirect:"error"` (off-host 3xx fails closed).
 * Keyless — NO headers. Returns the parsed JSON (the caller validates the array).
 *
 * Error mapping:
 *   - a ToolErrorCarrier from the taxonomy propagates, EXCEPT ★S2: an HTTP 400 on
 *     the PRE-VALIDATED query is remapped invalid_input → upstream_unavailable
 *     (transient, retryable — a validated ≥3-char/control-stripped/≤100 query is
 *     not a caller fault; live USITC 400s transiently and recovers on retry).
 *   - a 200 non-JSON body makes getJson's r.json() throw a SyntaxError →
 *     driftError (schema_drift), the fdic.ts getFdic pattern.
 */
async function getHts(query) {
    // Belt-and-suspenders host recheck (behind the const host).
    if (!USITC_HOST_SET.has(USITC_HOST)) {
        throw invalidInput(`USITC host ${JSON.stringify(USITC_HOST)} is not on the curated allowlist.`);
    }
    const params = new URLSearchParams();
    params.set("keyword", query); // percent-encoded — cannot alter host/path/params.
    const url = `https://${USITC_HOST}${USITC_SEARCH_PATH}?${params.toString()}`;
    const built = new URL(url);
    if (built.hostname !== USITC_HOST || built.protocol !== "https:") {
        throw invalidInput(`Constructed USITC URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match ${USITC_HOST} over https — refusing to fetch (SSRF safety).`);
    }
    try {
        return await throughGate(USITC_GATE_KEY, USITC_MIN_INTERVAL_MS, () => getJson(url, { label: USITC_LABEL, redirect: "error" }));
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier) {
            // ★S2 — a transient HTTP 400 on an ALREADY-VALIDATED query is not a caller
            // fault; remap to a retryable upstream_unavailable (never invalid_input).
            if (e.toolError.upstreamStatus === 400) {
                throw new ToolErrorCarrier({
                    kind: "upstream_unavailable",
                    message: `USITC HTS returned HTTP 400 for an already-validated query — treating as a TRANSIENT upstream error (retryable), not a caller fault (the query was control-stripped, length-bounded, and ≥${HTS_MIN_QUERY_CHARS} chars before the fetch).`,
                    retryable: true,
                    retryAfterSeconds: 15,
                    upstreamEndpoint: USITC_LABEL,
                });
            }
            throw e;
        }
        // A 200 non-JSON body (a maintenance/wrong-route HTML page) makes r.json()
        // throw a raw SyntaxError → reclassify as schema_drift (never a fake empty).
        if (e instanceof SyntaxError) {
            throw driftError(USITC_LABEL, "USITC HTS returned a non-JSON body at HTTP 200 — treating as schema drift.");
        }
        throw e;
    }
}
function rec(x) {
    return x !== null && typeof x === "object" && !Array.isArray(x)
        ? x
        : {};
}
/** Map ONE raw HTS row → a curated line. Rates are str-only (NEVER num). */
function mapLine(raw) {
    const r = rec(raw);
    const htsno = str(r.htsno);
    const desc = stripHtsMarkup(r.description);
    const units = Array.isArray(r.units)
        ? r.units.map(str).filter((u) => u !== null)
        : [];
    const footnotes = Array.isArray(r.footnotes) ? r.footnotes : [];
    const line = {
        htsno,
        statisticalSuffix: str(r.statisticalSuffix),
        indent: str(r.indent),
        description: desc.value,
        units,
        // ★ THE CRUX — verbatim str, NEVER num. An empty ("") rate → str→null (a
        // header/blank row stays null; the M1 note points the consumer UP an ancestor).
        columnOneGeneral: str(r.general),
        specialPreferential: str(r.special),
        columnTwo: str(r.other),
        additionalDuties: str(r.additionalDuties),
        footnotes,
        quotaQuantity: str(r.quotaQuantity),
        effectivePeriod: r.effectivePeriod ?? null,
        status: str(r.status),
        isChapter99: htsno !== null && htsno.startsWith("99"),
    };
    return { line, markupStripped: desc.stripped };
}
/**
 * hts_lookup — keyless USITC HTS classification + duty-rate lookup. A single
 * `query` (a keyword OR an HTS number) → the matching classification rows across
 * the hierarchy, with the Column-1 General / Special / Column-2 duty-rate TEXT +
 * the Chapter-99 additional-duty provisions. The full array is fetched ONCE and
 * paginated CLIENT-SIDE (the server serves no total and ignores `offset`).
 */
export async function htsLookup(args) {
    // ── Validate the query (M2 floor + SSRF cap) — BEFORE any fetch. ──
    const rawQuery = args.query === undefined || args.query === null ? "" : String(args.query);
    const query = sanitizeQuery(rawQuery);
    const nonWs = query.replace(/\s+/g, "");
    if (nonWs.length < HTS_MIN_QUERY_CHARS) {
        throw invalidInput(`\`query\` must have at least ${HTS_MIN_QUERY_CHARS} non-whitespace characters (after trimming/control-stripping) — a shorter query (a single character or common fragment) can make the USITC HTS endpoint serve 10,000–16,000+ rows / several MB in one response. Use a more specific keyword or a fuller HTS number.`);
    }
    if (query.length > HTS_MAX_QUERY_LEN) {
        throw invalidInput(`\`query\` is too long (${query.length} chars; max ${HTS_MAX_QUERY_LEN}).`);
    }
    // ── Client-side paging bounds (belt-and-suspenders behind Zod). ──
    const limit = args.limit ?? HTS_DEFAULT_LIMIT;
    const offset = args.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > HTS_MAX_LIMIT) {
        throw invalidInput(`limit ${JSON.stringify(args.limit)} out of range — use 1..${HTS_MAX_LIMIT}.`);
    }
    if (!Number.isInteger(offset) || offset < 0) {
        throw invalidInput(`offset ${JSON.stringify(args.offset)} out of range — use a non-negative integer.`);
    }
    // ── Fetch the FULL array once (P1 — no server total / no server pagination). ──
    const body = await getHts(query);
    // ★P2 — a success body that is NOT a JSON array is drift, never a fake empty.
    if (!Array.isArray(body)) {
        throw driftError(USITC_LABEL, `${USITC_LABEL} returned an unexpected shape — GET ${USITC_SEARCH_PATH} must return a bare JSON ARRAY of HTS rows. Treating as schema drift (never a fake empty).`);
    }
    // ★P1 — totalAvailable is the EXACT served array length (honest relative to what
    // the endpoint returns); paging is CLIENT-SIDE over the held array (the server
    // IGNORES offset — never trust a server offset).
    const totalAvailable = body.length;
    const page = body.slice(offset, offset + limit);
    const mapped = page.map(mapLine);
    const lines = mapped.map((m) => m.line);
    const returned = lines.length;
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    // ── Notes (mandatory + conditional). ──
    const notes = [
        HTS_NOT_A_RULING_NOTE,
        HTS_HIERARCHY_NOTE, // ★M1 — upward-ancestor inheritance
        HTS_COMPLETENESS_NOTE, // ★M2 — no "~900" ceiling; exact served length
        HTS_ADDITIONAL_DUTY_NOTE, // ★S1 / P4
    ];
    if (lines.some((l) => l.specialPreferential === null))
        notes.push(HTS_EMPTY_SPECIAL_NOTE);
    if (lines.some((l) => l.isChapter99))
        notes.push(HTS_CHAPTER99_PRESENT_NOTE);
    if (mapped.some((m) => m.markupStripped))
        notes.push(HTS_MARKUP_NOTE);
    // ★M2 belt — a very-large served array.
    if (totalAvailable > HTS_MAX_ROWS)
        notes.push(HTS_LARGE_RESULT_NOTE);
    return withMeta({ query, lines }, {
        source: SOURCE,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied: ["query"],
        filtersDropped: [],
        // ★S3 — per-line empty rate fields are NOT hoisted here (rate nullity is
        // per-line-normal per M1); this is reserved for a field genuinely absent
        // across the WHOLE response.
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    });
}
//# sourceMappingURL=usitc.js.map