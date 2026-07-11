/**
 * FPDS-NG (Federal Procurement Data System) — federal contract AWARD-ACTION
 * records from the keyless public ATOM feed. The FIRST XML/ATOM source in the
 * server (everything else is JSON via the getJson port; ADR-0012).
 *
 * WHY THIS EXISTS
 * ---------------
 * FPDS-NG is the AUTHORITATIVE system-of-record for federal contract ACTIONS
 * (each modification is its own transaction). USAspending.gov DERIVES its
 * contract data FROM FPDS via a nightly ETL — it lags FPDS by 1-2 days and
 * reshapes/enriches fields (sub-awards, Treasury-account linkage, a synthetic
 * unique award id). This tool closes the "action-level / mod-level latest-truth"
 * gap our usas_* tools (the transformed, lagged derivative) cannot.
 *
 * LIVE-VERIFIED 2026-07-12 (keyless, real HTTP probes, no key/cookie/session):
 *   GET https://www.fpds.gov/ezsearch/FEEDS/ATOM?FEEDNAME=PUBLIC&templateName=1.5.3&q=<Q>&start=<N>
 *   → HTTP 200 application/xml, an Atom 1.0 <feed>. Page size is FIXED at 10.
 *   The legacy ezSearch HTML variant (/ezsearch/search.do?...&feed=ATOM) 301s to
 *   sam.gov — the concrete justification for redirect:"error" + host-pinning.
 *
 * XML PARSE (bounded, fuzz-safe, dependency-free — the far.ts/gao.ts lineage):
 *   - entry slicer is an indexOf WALK ONLY (never a lazy regex — O(N) not O(N^2)
 *     on an unterminated <entry>), capped at MAX_ENTRIES.
 *   - leaf/attribute extractors are anchored, character-class ([^<]/[^"]) bounded
 *     regexes — no nested quantifiers, ReDoS-safe by construction.
 *   - attribute extraction is ELEMENT-SCOPED (M2): the attr is read from THAT
 *     element's own attr string, never a global description="…" scan (many FPDS
 *     elements share the `description`/`name` attribute names).
 *
 * HONESTY (the whole reason to ship this): the advertised total is a LOWER BOUND
 * (±10) for >10 results, keyless deep-paging is capped (~200K) far below the
 * advertised total, and a typo'd field name is a SILENT ZERO. All disclosed via
 * totalIsLowerBound + _meta.notes; hasMore is page-fullness (never offset<total).
 */
import { errorFromResponse, ToolErrorCarrier, } from "./errors.js";
import { driftError } from "./datasource.js";
import { num } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js) so
// the fault suite's num-parity guard resolves the SAME `num` (fpds.num ===
// coerce.num === treasury.num === socrata.num — a num regression fails together).
export { num };
// ─── Fixed endpoint (SSRF core) ───────────────────────────────────
const FPDS_HOST = "www.fpds.gov";
const FPDS_PATH = "/ezsearch/FEEDS/ATOM";
const FPDS_ORIGIN_PATH = `https://${FPDS_HOST}${FPDS_PATH}`;
const FPDS_LABEL = "www.fpds.gov";
// WAF-friendly browser-ish UA (mirrors gao.ts convention).
const FPDS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const PAGE_SIZE = 10;
/** Hard cap on entries sliced per feed (page size is 10; anything past a small
 *  ceiling is drift/hostile). Bounds the parser against a megabyte of <entry>s. */
const MAX_ENTRIES = 25;
const LEAF_MAX = 8000; // bounded leaf text length (ReDoS-safe [^<]{0,LEAF_MAX})
const ATTR_MAX = 1000; // bounded attribute value length ([^"]{0,ATTR_MAX})
// ─── Disclosure notes (honesty obligations, §4 / M1 / B1) ─────────
/** M1 anti-livelock — MUST accompany every multi-page (rel="last") response. */
const ANTI_LIVELOCK_NOTE = "IMPORTANT: do NOT paginate using totalAvailable. Use pagination.hasMore (page-fullness: returned===10) as the SOLE continuation signal. The advertised total is a lower bound (true count ∈ [totalAvailable, totalAvailable+9]); FPDS keyless deep-paging is capped (~200K reachable) far below the advertised total — narrow filters (agency/date/naics) to reach specific records.";
/** The §1e silent-zero disclosure — MUST accompany every genuine-empty response. */
const SILENT_ZERO_NOTE = 'FPDS returns an empty feed (HTTP 200) for BOTH a genuine zero-match AND an unrecognized field name / malformed query. If you expected results, re-check the filters (naics=PRINCIPAL_NAICS_CODE, contractingAgencyName, vendorName, piid, departmentId, signedDate*) and the date-range YYYY-MM-DD syntax.';
/** B1 — an empty page reached via deep paging (start>0) is AMBIGUOUS, not a total:0. */
const CEILING_AMBIGUITY_NOTE = "0 results at this offset — AMBIGUOUS between the natural end of a short result set and FPDS's keyless deep-paging ceiling (empty pages appear somewhere past ~200K even when many more records exist). Not a reliable total:0; narrow the query with filters instead of deep-paging.";
/** The canonical-vs-derived disclosure (FPDS is source-of-record; USAspending is the lagged derivative). */
const FPDS_VS_USAS_NOTE = "FPDS-NG is the AUTHORITATIVE system-of-record for federal contract ACTIONS (each modification is its own transaction). USAspending.gov derives its contract data FROM FPDS via a nightly ETL — it may lag FPDS by 1-2 days and reshapes/enriches fields (sub-awards, Treasury-account linkage, a synthetic unique award id). For latest mod-level / action-level truth, FPDS is the source; for spending rollups and sub-award graphs, prefer the usas_* tools.";
// FPDS derivations that live only in USAspending, never in the action feed.
const FIELDS_UNAVAILABLE = [
    "subAwards",
    "federalAccountLinkage",
    "generatedUniqueAwardId",
];
// ═══════════════════════════════════════════════════════════════════
// Fetch — a LOCAL single-attempt getText (the redirect must be caught on
// attempt 1; see below). Reuses errors.ts (errorFromResponse/ToolErrorCarrier)
// + datasource.driftError.
// ═══════════════════════════════════════════════════════════════════
/** Is a thrown error the redirect:"error" TypeError (undici: cause "unexpected
 *  redirect")? The live search.do→sam.gov 301 is the concrete case (§1a). */
function isRedirectError(e) {
    if (!(e instanceof TypeError))
        return false;
    const causeMsg = e.cause && typeof e.cause.message === "string"
        ? (e.cause.message)
        : "";
    return /redirect/i.test(causeMsg) || /redirect/i.test(e.message);
}
/**
 * GET the ATOM feed as text. SINGLE attempt on purpose (m-redirect): a
 * redirect:"error" fault throws a TypeError which — if routed through the shared
 * fetchWithRetry — would be retried 3× and surfaced as a retryable
 * upstream_unavailable, exactly what m-redirect forbids. So we do the fetch here
 * and classify: an off-host redirect (the search.do→sam.gov 301) is a
 * NON-RETRYABLE schema_drift naming the redirect; a 5xx/429/404/timeout is
 * classified via errorFromResponse / a network ToolError and THROWS (never a fake
 * empty). fetchWithRetry is imported for parity/reference but not used on the
 * redirect path for this reason.
 */
async function getText(url, label) {
    const init = {
        headers: {
            "User-Agent": FPDS_UA,
            Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
    };
    let r;
    try {
        r = await fetch(url, init);
    }
    catch (e) {
        if (isRedirectError(e)) {
            // Fail closed — NEVER follow the off-host redirect, NEVER read its body,
            // and do NOT let it masquerade as a retryable outage (a non-retryable
            // schema_drift, single attempt).
            throw driftError(label, `FPDS fetch hit an off-host redirect (the legacy /ezsearch/search.do UI 301-redirects to sam.gov). Refused to follow it (redirect:"error"). This is NOT an empty result — use the /ezsearch/FEEDS/ATOM machine feed.`);
        }
        // timeout / abort / network — retryable upstream, but THROWS (never fake-empty).
        const toolErr = {
            kind: "upstream_unavailable",
            message: `Network error reaching ${label}: ${e instanceof Error ? e.message : String(e)}`,
            retryable: true,
            retryAfterSeconds: 30,
            upstreamEndpoint: label,
        };
        throw new ToolErrorCarrier(toolErr);
    }
    if (!r.ok) {
        // 404/429/5xx/4xx → the errors.ts taxonomy. A DOWN service NEVER reads empty.
        throw new ToolErrorCarrier(errorFromResponse(r, label));
    }
    return r.text();
}
// ═══════════════════════════════════════════════════════════════════
// q builder — structured filters → a fielded FPDS `q`. NO raw-q passthrough
// (a typo'd field name would be a silent zero). m-inject: strip embedded
// double-quotes from phrase values; strip FIELD: operators from free keywords.
// ═══════════════════════════════════════════════════════════════════
/** A phrase value goes inside FIELD:"value" — strip embedded double-quotes so a
 *  crafted value cannot close the quote and inject a second FPDS field token. */
function cleanPhrase(v) {
    return v.replace(/"/g, "").replace(/\s+/g, " ").trim();
}
/** The bare keyword is UNquoted — strip embedded quotes AND FIELD: operators
 *  (UPPERCASE-word + colon) so a caller cannot inject FPDS query operators. */
function cleanKeyword(v) {
    return v
        .replace(/"/g, " ")
        .replace(/\b[A-Z][A-Z0-9_]{1,}:/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/** YYYY-MM-DD → YYYY/MM/DD (the FPDS date-range syntax). Format is Zod-validated. */
function toFpdsDate(iso) {
    return iso.replace(/-/g, "/");
}
/** Build the fielded `q` string from structured filters (AND-combined by space). */
export function buildQuery(args) {
    const tokens = [];
    const filters = [];
    const phrase = (field, val, label) => {
        if (val === undefined)
            return;
        const c = cleanPhrase(val);
        if (c.length === 0)
            return;
        tokens.push(`${field}:"${c}"`);
        filters.push(label);
    };
    phrase("PRINCIPAL_NAICS_CODE", args.naics, "naics");
    phrase("VENDOR_NAME", args.vendorName, "vendorName");
    phrase("PIID", args.piid, "piid");
    phrase("DEPARTMENT_ID", args.departmentId, "departmentId");
    phrase("CONTRACTING_AGENCY_NAME", args.contractingAgencyName, "contractingAgencyName");
    if (args.signedDateFrom !== undefined && args.signedDateTo !== undefined) {
        tokens.push(`SIGNED_DATE:[${toFpdsDate(args.signedDateFrom)},${toFpdsDate(args.signedDateTo)}]`);
        filters.push("signedDate");
    }
    if (args.lastModifiedFrom !== undefined && args.lastModifiedTo !== undefined) {
        tokens.push(`LAST_MOD_DATE:[${toFpdsDate(args.lastModifiedFrom)},${toFpdsDate(args.lastModifiedTo)}]`);
        filters.push("lastModifiedDate");
    }
    if (args.keyword !== undefined) {
        const k = cleanKeyword(args.keyword);
        if (k.length > 0) {
            tokens.push(k);
            filters.push("keyword");
        }
    }
    return { q: tokens.join(" "), filters };
}
/**
 * Construct the SSRF-safe feed URL. Everything except `q`+`start` is fixed
 * (host, path, FEEDNAME, templateName); the caller-influenced values go through
 * URLSearchParams (which percent-encodes ` " : [ ] , & #`), so a value can add
 * a query param but CANNOT alter the host or path. Then a belt-and-suspenders
 * hostname/protocol assertion (verbatim ckan.ts pattern).
 */
export function buildSearchUrl(q, start) {
    const params = new URLSearchParams();
    params.set("FEEDNAME", "PUBLIC");
    params.set("templateName", "1.5.3");
    params.set("q", q);
    params.set("start", String(start));
    const url = `${FPDS_ORIGIN_PATH}?${params.toString()}`;
    const built = new URL(url);
    if (built.hostname !== FPDS_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed FPDS URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${FPDS_HOST} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
            upstreamEndpoint: FPDS_LABEL,
        });
    }
    return url;
}
// ═══════════════════════════════════════════════════════════════════
// XML parse — bounded, ReDoS-safe, dependency-free.
// ═══════════════════════════════════════════════════════════════════
/** Decode the handful of XML entities FPDS emits (CDATA handled separately). */
function decode(s) {
    return s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&#x27;/g, "'")
        // &amp; LAST so an already-decoded entity is not double-decoded.
        .replace(/&amp;/g, "&")
        .trim();
}
// Compiled-regex caches (bounded, anchored, character-class — ReDoS-safe).
const elCache = new Map();
function elRe(name) {
    let re = elCache.get(name);
    if (!re) {
        // <ns1:NAME [attrs]>leaf</ns1:NAME> — leaf is [^<]{0,LEAF_MAX} (cannot cross a
        // tag boundary, cannot backtrack catastrophically).
        re = new RegExp(`<ns1:${name}\\b([^>]*)>([^<]{0,${LEAF_MAX}})</ns1:${name}>`);
        elCache.set(name, re);
    }
    return re;
}
const attrCache = new Map();
function attrRe(name) {
    let re = attrCache.get(name);
    if (!re) {
        re = new RegExp(`\\b${name}="([^"]{0,${ATTR_MAX}})"`);
        attrCache.set(name, re);
    }
    return re;
}
/** First <ns1:NAME …>text</ns1:NAME> within `scope`; returns its text + own
 *  attr string (for M2 element-scoped attribute reads). Missing → null text. */
function el(scope, name) {
    const m = elRe(name).exec(scope);
    if (!m)
        return null;
    const raw = m[2] ?? "";
    return { attrs: m[1] ?? "", text: raw === "" ? "" : decode(raw) };
}
/** The text of the first <ns1:NAME> leaf, or null when absent. */
function leafText(scope, name) {
    const l = el(scope, name);
    if (!l || l.text === null || l.text === "")
        return null;
    return l.text;
}
/** M2 — read attribute `attr` ONLY from element `name`'s own attr string
 *  (never a global scan across the entry, where the wrong element would win). */
function elAttr(scope, name, attr) {
    const l = el(scope, name);
    if (!l)
        return null;
    const m = attrRe(attr).exec(l.attrs);
    return m && m[1] !== undefined ? decode(m[1]) : null;
}
/** A named amount leaf coerced null-never-0 (real "0.00"→0 and negatives kept). */
function leafNum(scope, name) {
    const l = el(scope, name);
    return l ? num(l.text) : null;
}
/** Slice a nested container block <ns1:NAME …>…</ns1:NAME> (for path
 *  disambiguation: referencedIDVID vs awardContractID, PoP-state vs vendor-state). */
function blockOf(scope, name) {
    const openLit = `<ns1:${name}`;
    const closeLit = `</ns1:${name}>`;
    let from = 0;
    for (;;) {
        const s = scope.indexOf(openLit, from);
        if (s === -1)
            return null;
        // Boundary: the char after the element name must NOT be a name char (avoid
        // <ns1:referencedIDVID matching inside <ns1:referencedIDVMultipleOrSingle).
        const nextCh = scope.charAt(s + openLit.length);
        if (nextCh === ">" || nextCh === " " || nextCh === "\t" || nextCh === "\n" || nextCh === "\r" || nextCh === "/") {
            const e = scope.indexOf(closeLit, s);
            if (e === -1)
                return null;
            return scope.slice(s, e + closeLit.length);
        }
        from = s + openLit.length;
    }
}
/** CDATA-aware text of the Atom <title> (m-cdata — the title uses <![CDATA[…]]>).
 *  Strips the CDATA MARKERS (never a String.replace with the captured content —
 *  that would interpret a `$1` inside an FPDS amount like "$107,271" as a
 *  back-reference and corrupt the title). Keeps leading text + CDATA content. */
function atomTitle(entry) {
    const m = /<title\b[^>]*>([\s\S]{0,4000}?)<\/title>/.exec(entry);
    if (!m || m[1] === undefined)
        return null;
    const inner = m[1].replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "");
    const t = decode(inner);
    return t.length > 0 ? t : null;
}
/** The entry's rel="alternate" HTML link (the FPDS display URL; NEVER fetched). */
function alternateHref(entry) {
    const link = /<link\b[^>]*\brel="alternate"[^>]*>/.exec(entry);
    if (!link)
        return null;
    const href = /\bhref="([^"]{0,2000})"/.exec(link[0]);
    return href && href[1] !== undefined ? decode(href[1]) : null;
}
/** "true"/"false" leaf → boolean; absent → null (never a fabricated false). */
function boolLeaf(scope, name) {
    const t = leafText(scope, name);
    if (t === null)
        return null;
    if (t === "true")
        return true;
    if (t === "false")
        return false;
    return null;
}
/** Parse ONE entry block (content root is <ns1:award> OR <ns1:IDV>; the flat
 *  extractor is not path-sensitive so both roots parse identically). */
function parseEntry(entry) {
    const recordType = /<ns1:IDV\b/.test(entry) ? "idv" : "award";
    // parentIdvPiid: the PIID INSIDE referencedIDVID (an award's parent vehicle);
    // scoped so it is never confused with the award's own (first) PIID.
    const refIdv = blockOf(entry, "referencedIDVID");
    const vendorLoc = blockOf(entry, "vendorLocation");
    const pop = blockOf(entry, "placeOfPerformance");
    return {
        recordType,
        title: atomTitle(entry),
        piid: leafText(entry, "PIID"),
        modNumber: leafText(entry, "modNumber"),
        parentIdvPiid: refIdv ? leafText(refIdv, "PIID") : null,
        actionType: elAttr(entry, "contractActionType", "description"),
        reasonForModification: elAttr(entry, "reasonForModification", "description"),
        signedDate: leafText(entry, "signedDate"),
        contractingDepartmentId: leafText(entry, "agencyID"),
        contractingDepartmentName: elAttr(entry, "agencyID", "name"),
        contractingOfficeAgencyId: leafText(entry, "contractingOfficeAgencyID"),
        contractingOfficeAgencyName: elAttr(entry, "contractingOfficeAgencyID", "name"),
        vendorName: leafText(entry, "vendorName"),
        vendorUei: leafText(entry, "UEI"),
        ultimateParentUei: leafText(entry, "ultimateParentUEI"),
        ultimateParentUeiName: leafText(entry, "ultimateParentUEIName"),
        cageCode: leafText(entry, "cageCode"),
        vendorCity: vendorLoc ? leafText(vendorLoc, "city") : null,
        vendorState: vendorLoc ? leafText(vendorLoc, "state") : null,
        businessSize: elAttr(entry, "contractingOfficerBusinessSizeDetermination", "description"),
        obligatedAmount: leafNum(entry, "obligatedAmount"),
        totalObligatedAmount: leafNum(entry, "totalObligatedAmount"),
        baseAndAllOptionsValue: leafNum(entry, "baseAndAllOptionsValue"),
        naics: leafText(entry, "principalNAICSCode"),
        naicsDescription: elAttr(entry, "principalNAICSCode", "description"),
        psc: leafText(entry, "productOrServiceCode"),
        pscDescription: elAttr(entry, "productOrServiceCode", "description"),
        description: leafText(entry, "descriptionOfContractRequirement"),
        placeOfPerformanceState: pop ? leafText(pop, "stateCode") : null,
        placeOfPerformanceCity: pop ? leafText(pop, "city") : null,
        extentCompeted: elAttr(entry, "extentCompeted", "description"),
        offersReceived: leafNum(entry, "numberOfOffersReceived"),
        setAside: elAttr(entry, "typeOfSetAside", "description") ?? elAttr(entry, "idvTypeOfSetAside", "description"),
        socioeconomic: {
            smallBusiness: boolLeaf(entry, "isSmallBusiness"),
            womenOwned: boolLeaf(entry, "isWomenOwned"),
            veteranOwned: boolLeaf(entry, "isVeteranOwned"),
        },
        fpdsHtmlUrl: alternateHref(entry),
    };
}
/** Slice <entry>…</entry> blocks with an indexOf WALK ONLY (O(N), never a lazy
 *  regex), capped at MAX_ENTRIES. An unterminated <entry> stops the walk. */
function sliceEntries(xml) {
    const out = [];
    let pos = 0;
    while (out.length < MAX_ENTRIES) {
        const s = xml.indexOf("<entry", pos);
        if (s === -1)
            break;
        const e = xml.indexOf("</entry>", s);
        if (e === -1)
            break; // tolerate truncation — never hang
        out.push(xml.slice(s, e));
        pos = e + 8; // len("</entry>")
    }
    return out;
}
/** The `start` of the rel="last" link, or null when absent (≤10 results). */
function lastStart(xml) {
    const link = /<link\b[^>]*\brel="last"[^>]*>/.exec(xml);
    if (!link)
        return null;
    const m = /[?&](?:amp;)?start=(\d{1,9})/.exec(link[0]);
    if (!m || m[1] === undefined)
        return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
}
/** Is this body an Atom <feed> (not an HTML error page / redirect target)? */
function looksLikeAtomFeed(xml) {
    const head = xml.slice(0, 4000);
    if (/<!doctype html/i.test(head) || /<html[\s>]/i.test(head))
        return false;
    return /<feed\b/.test(head) && head.includes("http://www.w3.org/2005/Atom");
}
// ═══════════════════════════════════════════════════════════════════
// Tool — fpds_search_awards
// ═══════════════════════════════════════════════════════════════════
export async function searchAwards(args) {
    const start = args.offset ?? 0;
    const { q, filters } = buildQuery(args);
    const url = buildSearchUrl(q, start);
    const xml = await getText(url, FPDS_LABEL);
    // Feed guard FIRST — an FPDS/edge HTML error page or a redirect target served
    // as 200 is schema DRIFT, never a fake-empty result.
    if (!looksLikeAtomFeed(xml)) {
        throw driftError(FPDS_LABEL, "FPDS returned HTTP 200 but the body is not an Atom <feed> (an HTML error page, an interstitial, or a redirect target). Refusing to report it as an empty result.");
    }
    const advertisedLastStart = lastStart(xml);
    const awards = sliceEntries(xml).map(parseEntry);
    const returned = awards.length;
    // M3 — namespace-drift guard: a non-empty feed where EVERY entry yields a null
    // piid means the ns1: prefix / award schema drifted. Never return hollow rows.
    if (returned > 0 && awards.every((a) => a.piid === null)) {
        throw driftError(FPDS_LABEL, "non-empty ATOM feed but all entries yielded null piid — ns1: prefix / award schema drifted (refusing to return a page of hollow records).");
    }
    // hasMore is page-fullness ONLY (never offset<total) — the advertised total
    // over-promises reachable pages (deep-paging ceiling).
    const hasMore = returned === PAGE_SIZE;
    const nextOffset = hasMore ? start + PAGE_SIZE : null;
    const pagination = { offset: start, limit: PAGE_SIZE, nextOffset, hasMore };
    const notes = [];
    let totalAvailable;
    let totalIsLowerBound;
    let complete;
    if (advertisedLastStart !== null) {
        // Multi-page: totalAvailable is a KNOWN LOWER BOUND (true count ∈ [N, N+9]).
        totalAvailable = advertisedLastStart + 1;
        totalIsLowerBound = true;
        complete = undefined; // buildMeta derives from pagination.hasMore
        notes.push(ANTI_LIVELOCK_NOTE);
    }
    else if (returned === 0) {
        if (start === 0) {
            // Genuine-empty (page 0, no rel="last"): an honest exact zero.
            totalAvailable = 0;
            complete = true;
            notes.push(SILENT_ZERO_NOTE);
        }
        else {
            // B1 ceiling-hit: an empty page reached via deep paging is AMBIGUOUS.
            totalAvailable = null;
            complete = false;
            notes.push(CEILING_AMBIGUITY_NOTE);
        }
    }
    else {
        // ≤10 results (no rel="last"): this is the last page → total is EXACT.
        totalAvailable = start + returned;
        complete = start === 0 ? undefined : false;
    }
    notes.push(FPDS_VS_USAS_NOTE);
    const meta = {
        source: "www.fpds.gov ezSearch ATOM (FPDS-NG, keyless)",
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied: filters,
        filtersDropped: [],
        fieldsUnavailable: FIELDS_UNAVAILABLE,
        pagination,
        notes,
    };
    if (totalIsLowerBound !== undefined)
        meta.totalIsLowerBound = totalIsLowerBound;
    if (complete !== undefined)
        meta.complete = complete;
    return withMeta({ query: q, returned, totalAvailable, awards }, meta);
}
//# sourceMappingURL=fpds.js.map