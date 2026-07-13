/**
 * Federal Register API v1 wrappers (keyless, no registration).
 *
 * Federal Register is the daily journal of the US federal government —
 * proposed rules, final rules, presidential documents, public notices.
 * Critical context for any federal contracting question that touches
 * regulation, set-aside policy, or new acquisition guidance.
 *
 * Endpoints:
 *   - documents.json — search across documents (filters: agencies,
 *     conditions, type, date range)
 *   - documents/{number}.json — single document detail (full body URL,
 *     abstract, citation, effective date)
 *   - agencies.json — agency reference list
 *
 * All endpoints are public + keyless (no API key, no registration).
 * Rate-limit: documented as ~1000 req/hour per IP (informal).
 */
import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
import { num, str } from "./coerce.js";
const FED_REG = "https://www.federalregister.gov/api/v1";
async function fetchJson(url) {
    const r = await fetchWithRetry(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
    }, `federal-register:${url.split("/api/v1/")[1] ?? url}`);
    return (await r.json());
}
const TYPE_MAP = {
    Rule: "RULE",
    "Proposed Rule": "PRORULE",
    Notice: "NOTICE",
    "Presidential Document": "PRESDOCU",
};
export async function searchDocuments(args) {
    const url = new URL(`${FED_REG}/documents.json`);
    url.searchParams.set("per_page", String(args.perPage ?? 10));
    if (args.query) {
        url.searchParams.set("conditions[term]", args.query);
    }
    for (const slug of args.agencySlugs ?? []) {
        url.searchParams.append("conditions[agencies][]", slug);
    }
    if (args.type) {
        url.searchParams.append("conditions[type][]", args.type);
    }
    if (args.publicationDateFrom) {
        url.searchParams.set("conditions[publication_date][gte]", args.publicationDateFrom);
    }
    if (args.publicationDateTo) {
        url.searchParams.set("conditions[publication_date][lte]", args.publicationDateTo);
    }
    if (args.effectiveDateFrom) {
        url.searchParams.set("conditions[effective_date][gte]", args.effectiveDateFrom);
    }
    const json = await fetchJson(url.toString());
    // The Federal Register API HARD-CAPS `count` at 10,000 (50 pages × 200) —
    // LIVE-VERIFIED 2026-07-06: an empty/nonsense term → count 0, but ANY broad term
    // AND the no-term "all documents ever" query both return exactly 10,000 (the FR
    // has published FAR more than 10k documents since 1994). So a count of 10,000 is
    // a SATURATION FLOOR ("≥10,000"), NOT an exact total — reporting it as exact
    // overstates precision and understates the true count.
    const FR_COUNT_CAP = 10000;
    const rawCount = json.count ?? 0;
    const countSaturated = rawCount >= FR_COUNT_CAP;
    const data = {
        totalRecords: rawCount,
        // true ⇒ totalRecords is a FLOOR (≥10,000), not an exact count (API cap).
        totalRecordsSaturated: countSaturated,
        totalPages: json.total_pages ?? 0,
        // total_pages ALSO saturates at the API cap (50) for the same broad queries —
        // flag it so a consumer never estimates the true dataset size from a capped
        // page count either.
        totalPagesSaturated: countSaturated,
        documents: (json.results ?? []).map((d) => ({
            documentNumber: d.document_number ?? "",
            title: d.title ?? "",
            type: TYPE_MAP[d.type ?? ""] ?? "UNKNOWN",
            typeDisplay: d.type ?? "",
            abstract: d.abstract ?? "",
            htmlUrl: d.html_url ?? "",
            pdfUrl: d.pdf_url,
            publicationDate: d.publication_date ?? "",
            effectiveDate: d.effective_on,
            agencies: (d.agencies ?? []).map((a) => ({
                name: a.name ?? "",
                slug: a.slug ?? "",
            })),
        })),
    };
    // Truthful `_meta` (spec §1.2 A5, §2.3). The Federal Register API reports a
    // match total (`count`) — REAL below the 10,000 cap, a saturation FLOOR at it
    // (handled below). A5: an unknown/misspelled agency slug is silently ignored by
    // the API and yields zero rows that look identical to "no matching rules" —
    // call that out so the AI can re-check the slug against fed_register_list_agencies
    // instead of concluding no such rule exists.
    const returned = data.documents.length;
    const notes = [];
    if (countSaturated) {
        notes.push(`The Federal Register API caps its match count at ${FR_COUNT_CAP.toLocaleString()} (and total_pages at 50) — both are FLOORS, not exact totals: this query matches AT LEAST ${FR_COUNT_CAP.toLocaleString()} documents (the true total is unknown and likely higher). totalAvailable is null (not ${FR_COUNT_CAP.toLocaleString()}); narrow with agency/type/publicationDate filters to bring the result set BELOW ${FR_COUNT_CAP.toLocaleString()} for an exact count.`);
    }
    if ((args.agencySlugs?.length ?? 0) > 0) {
        notes.push(`Filtered by agency slug(s): ${args.agencySlugs.join(", ")}. An unknown or misspelled slug is silently ignored by the API and yields zero results indistinguishable from "no matching documents" — verify slugs via fed_register_list_agencies if the result is unexpectedly empty.`);
    }
    return withMeta(data, {
        source: "federalregister.gov/api/v1",
        keylessMode: true,
        returned,
        // The REAL total when known; null (unknown exact) when the count saturated at
        // the FR cap — never a capped number presented as the real total.
        totalAvailable: countSaturated ? null : rawCount,
        truncated: countSaturated ? true : returned < rawCount,
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
export async function getDocument(documentNumber) {
    const json = await fetchJson(`${FED_REG}/documents/${encodeURIComponent(documentNumber)}.json`);
    return {
        documentNumber: json.document_number ?? "",
        title: json.title ?? "",
        type: TYPE_MAP[json.type ?? ""] ?? "UNKNOWN",
        typeDisplay: json.type ?? "",
        abstract: json.abstract ?? "",
        htmlUrl: json.html_url ?? "",
        pdfUrl: json.pdf_url,
        rawTextUrl: json.raw_text_url,
        publicationDate: json.publication_date ?? "",
        effectiveDate: json.effective_on,
        citation: json.citation,
        pageCount: json.page_length,
        agencies: (json.agencies ?? []).map((a) => ({
            name: a.name ?? "",
            slug: a.slug ?? "",
        })),
        cfrReferences: (json.cfr_references ?? []).map((c) => ({
            title: c.title ?? "",
            part: c.part,
            chapter: c.chapter,
        })),
    };
}
export async function listAgencies(args) {
    return memoize(`fedreg:agencies:${args.perPage ?? 100}`, async () => {
        const json = await fetchJson(`${FED_REG}/agencies.json?per_page=${args.perPage ?? 100}`);
        return {
            agencies: (json ?? []).map((a) => ({
                id: a.id ?? 0,
                name: a.name ?? "",
                shortName: a.short_name,
                slug: a.slug ?? "",
                description: a.description ?? "",
                parentId: a.parent_id,
            })),
        };
    });
}
// ─────────────────────────────────────────────────────────────────────────────
// Public Inspection desk — the "filed but NOT YET published" leading indicator
// (ADR-0043). Additive: everything below is NEW; `fetchJson`/`TYPE_MAP`/the three
// existing tools above are UNTOUCHED. Documents FILED with the Office of the
// Federal Register are on PUBLIC INSPECTION hours-to-days BEFORE their official
// `publication_date` — the earliest legal signal of an upcoming rule/notice.
// ─────────────────────────────────────────────────────────────────────────────
const PI_BASE = `${FED_REG}/public-inspection-documents`;
const PI_HOST = "www.federalregister.gov";
/**
 * The mandatory pre-publication caveat — rides `_meta.notes` on EVERY response.
 * A public-inspection doc is FILED, not PUBLISHED: no final FR citation/page yet,
 * and it may CHANGE or be WITHDRAWN before publication. Load-bearing honesty:
 * presenting a PI doc as the authoritative published rule is the forbidden lie.
 */
export const PRE_PUBLICATION_CAVEAT = "These are PRE-PUBLICATION documents on PUBLIC INSPECTION — filed with the Office of the Federal Register but NOT YET published. This is a LEADING INDICATOR, not the authoritative published rule/notice: there is NO final Federal Register citation or page number yet, and the content CAN CHANGE or be WITHDRAWN before its publication_date. After the publication_date, cross-check fed_register_get_document (by document_number) for the authoritative published version.";
/** Discloses how `leadDays` is derived (null-never-0). */
export const LEADDAYS_METHOD_NOTE = "leadDays = publication_date minus the calendar date of filed_at, in whole days (the pre-publication head-start); null when either date is missing/unparseable, a genuine same-day filing is 0, a negative value (publication before filing) is a surfaced-verbatim anomaly.";
/** Discloses the special-vs-regular distinction (never conflated). */
export const SPECIAL_REGULAR_NOTE = "filing_type 'special' = filed OFF-CYCLE for immediate/emergency public inspection (a stronger, SOONER signal — often same/next-day publication); 'regular' = filed for the next regular business-day inspection. Surfaced verbatim; the two are not conflated.";
const PI_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * `leadDays` = publication_date − the CALENDAR DATE of filed_at, in whole days.
 * tz-immune (compares the sliced YYYY-MM-DD strings — both on FR's Eastern basis,
 * so no -04:00/-05:00 DST off-by-one). NULL-NEVER-0: null when either date is
 * missing/unparseable; a genuine same-day filing survives as 0; a negative
 * (publication before filing — a data anomaly) is surfaced VERBATIM, never
 * clamped or nulled.
 */
export function computeLeadDays(filedAt, publicationDate) {
    if (filedAt === null ||
        filedAt === undefined ||
        publicationDate === null ||
        publicationDate === undefined) {
        return null;
    }
    const filedDate = String(filedAt).slice(0, 10);
    const pubDate = String(publicationDate).slice(0, 10);
    if (!PI_DATE_RE.test(filedDate) || !PI_DATE_RE.test(pubDate))
        return null;
    const fp = filedDate.split("-");
    const pp = pubDate.split("-");
    const ms = Date.UTC(Number(pp[0]), Number(pp[1]) - 1, Number(pp[2])) -
        Date.UTC(Number(fp[0]), Number(fp[1]) - 1, Number(fp[2]));
    return Math.round(ms / 86_400_000);
}
/**
 * SSRF host re-assertion (defense-in-depth; ADR-0043 §Q7). The only caller
 * values that reach the wire are `date` (→ conditions[available_on]) and `term`
 * (→ conditions[term]), both URLSearchParams QUERY params on the fixed host — no
 * caller-controlled PATH segment. Re-assert the constructed URL is https on
 * www.federalregister.gov; anything else → invalid_input (never fetched).
 */
export function assertFedRegHost(urlStr) {
    let u;
    try {
        u = new URL(urlStr);
    }
    catch {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Refusing to fetch a non-URL public-inspection target.`,
            retryable: false,
            upstreamEndpoint: "federal-register:public-inspection",
        });
    }
    if (u.protocol !== "https:" || u.hostname !== PI_HOST) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Refusing to fetch a non-${PI_HOST} public-inspection URL (${u.protocol}//${u.hostname}).`,
            retryable: false,
            upstreamEndpoint: "federal-register:public-inspection",
        });
    }
}
/**
 * Build the wire URL per mode. ★The date rides `conditions[available_on]` (a
 * QUERY param), NEVER a `/{date}.json` path segment (fact 6: that path silently
 * returns a WRONG unrelated doc). `term` rides `conditions[term]`. Both via
 * URLSearchParams. `new URL` + host re-assert closes host-escape/downgrade.
 */
export function buildPublicInspectionUrl(mode, opts = {}) {
    let url;
    if (mode === "current") {
        url = new URL(`${PI_BASE}/current.json`);
    }
    else if (mode === "date") {
        url = new URL(`${PI_BASE}.json`);
        url.searchParams.set("conditions[available_on]", opts.date ?? "");
    }
    else {
        url = new URL(`${PI_BASE}.json`);
        if (opts.term)
            url.searchParams.set("conditions[term]", opts.term);
        // per_page ≫ any observed on-inspection count (live ≤95) → one page.
        url.searchParams.set("per_page", "1000");
    }
    const built = url.toString();
    assertFedRegHost(built);
    return built;
}
/**
 * Envelope-shape guard (M2). The list envelopes (`current`/`date`/`search`) are
 * `{count:number, results:array, …}`. `fetchJson` casts `as T` without checking,
 * so a 200 body of the wrong shape would map to garbage. Throw a `schema_drift`
 * ToolErrorCarrier (NOT a plain Error — `toToolError` has no branch for a bare
 * Error, so it would degrade to `unknown`). The two `*_filings_updated_at` stamps
 * are OPTIONAL (S4: a zero-result day omits them) and are NOT asserted here.
 */
export function assertInspectionEnvelope(json, endpoint) {
    const j = json;
    if (json === null ||
        typeof json !== "object" ||
        typeof j?.count !== "number" ||
        !Array.isArray(j?.results)) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `Federal Register public-inspection envelope drift at ${endpoint}: expected {count:number, results:array}.`,
            retryable: false,
            upstreamEndpoint: endpoint,
        });
    }
}
function mapInspectionRow(r) {
    const typeVerbatim = str(r.type);
    return {
        documentNumber: str(r.document_number),
        type: typeVerbatim,
        typeCode: TYPE_MAP[r.type ?? ""] ?? "UNKNOWN",
        title: str(r.title),
        filedAt: str(r.filed_at),
        publicationDate: str(r.publication_date),
        // null-never-0; same-day survives as 0; negative anomaly verbatim.
        leadDays: computeLeadDays(r.filed_at, r.publication_date),
        filingType: str(r.filing_type),
        isSpecialFiling: r.filing_type === "special",
        // agencies[] surfaced UNFLATTENED — a doc can name multiple agencies.
        agencies: (Array.isArray(r.agencies) ? r.agencies : []).map((a) => ({
            rawName: str(a.raw_name),
            name: str(a.name),
            id: num(a.id),
            slug: str(a.slug),
            url: str(a.url),
            jsonUrl: str(a.json_url),
            parentId: num(a.parent_id),
        })),
        htmlUrl: str(r.html_url),
        pdfUrl: str(r.pdf_url),
        rawTextUrl: str(r.raw_text_url),
        docketNumbers: (Array.isArray(r.docket_numbers) ? r.docket_numbers : [])
            .map((s) => str(s))
            .filter((s) => s !== null),
        numPages: num(r.num_pages),
        subjects: [r.subject_1, r.subject_2, r.subject_3]
            .map((s) => str(s))
            .filter((s) => s !== null),
    };
}
/**
 * `fed_register_public_inspection` — the pre-publication leading indicator.
 * mode {current, date, search}; fetch-once + client-side window; every response
 * carries the pre-publication caveat + the leadDays/special-vs-regular notes.
 */
export async function publicInspection(input) {
    const mode = input.mode ?? "current";
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    // `term` is only meaningful in search mode — never silently full-text a
    // non-search mode.
    if (input.term && mode !== "search") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `\`term\` is only valid in mode='search' (got mode='${mode}').`,
            retryable: false,
            upstreamEndpoint: "federal-register:public-inspection",
        });
    }
    // ── mode=date validation: regex + real-calendar round-trip (S1) + plausibility
    //    bound (S5), ALL pre-fetch. An off-calendar available_on (2026-02-30)
    //    returns HTTP 500 that fetchWithRetry would mis-taxonomize as a retryable
    //    outage — so a bad date MUST be rejected with `invalid_input` and ZERO fetch.
    let asOfDate = null;
    if (mode === "date") {
        const date = input.date;
        if (!date || !PI_DATE_RE.test(date)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                message: `mode='date' requires a \`date\` matching YYYY-MM-DD (got ${JSON.stringify(date)}).`,
                retryable: false,
                upstreamEndpoint: "federal-register:public-inspection:date",
            });
        }
        const parts = date.split("-");
        const y = Number(parts[0]);
        const m = Number(parts[1]);
        const d = Number(parts[2]);
        const dt = new Date(Date.UTC(y, m - 1, d));
        if (dt.getUTCFullYear() !== y ||
            dt.getUTCMonth() !== m - 1 ||
            dt.getUTCDate() !== d) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                message: `date '${date}' is not a real calendar date (off-calendar available_on returns HTTP 500 upstream — rejected before any fetch).`,
                retryable: false,
                upstreamEndpoint: "federal-register:public-inspection:date",
            });
        }
        const currentYear = new Date().getUTCFullYear();
        if (y < 1994 || y > currentYear + 1) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                message: `date year ${y} is outside the plausible window [1994, ${currentYear + 1}].`,
                retryable: false,
                upstreamEndpoint: "federal-register:public-inspection:date",
            });
        }
        asOfDate = date;
    }
    const url = buildPublicInspectionUrl(mode, {
        date: asOfDate ?? undefined,
        term: input.term,
    });
    const endpoint = `federal-register:public-inspection:${mode}`;
    // M2: a 200 body that is NOT valid JSON → fetchJson's `.json()` throws a
    // SyntaxError → reclassify as `schema_drift` THROW (never a fake empty). A
    // ToolErrorCarrier from fetchWithRetry (503/404/429) is rethrown UNCHANGED.
    let json;
    try {
        json = await fetchJson(url);
    }
    catch (e) {
        if (e instanceof SyntaxError) {
            throw new ToolErrorCarrier({
                kind: "schema_drift",
                message: `Federal Register public-inspection returned a 200 non-JSON body at ${endpoint}.`,
                retryable: false,
                upstreamEndpoint: endpoint,
            });
        }
        throw e;
    }
    assertInspectionEnvelope(json, endpoint);
    const env = json;
    const rawRows = env.results;
    const servedTotal = env.count;
    // S4: both freshness stamps are OPTIONAL — null-safe (absent → null).
    const specialFilingsUpdatedAt = str(env.special_filings_updated_at);
    const regularFilingsUpdatedAt = str(env.regular_filings_updated_at);
    // Client-side filters (uniform across all modes — dodges the API quirks where
    // available_on ignores type/per_page and the date-in-path trap).
    let rows = rawRows.map(mapInspectionRow);
    if (input.type)
        rows = rows.filter((r) => r.typeCode === input.type);
    if (input.agency)
        rows = rows.filter((r) => r.agencies.some((a) => a.slug === input.agency));
    if (input.specialOnly)
        rows = rows.filter((r) => r.isSpecialFiling === true);
    const filteredTotal = rows.length;
    const hasClientFilter = Boolean(input.type || input.agency || input.specialOnly);
    // Overflow (S2): search corpus > per_page (server paginated; we fetched one
    // page). Live-UNREACHABLE at the ~75-doc corpus, defensive-only.
    const overflow = mode === "search" && servedTotal > rawRows.length;
    let totalAvailable;
    let totalIsLowerBound = false;
    if (overflow && hasClientFilter) {
        // A client filter over ONLY the fetched first page → the exact server total
        // (all types) would MISREPRESENT the filtered set. Report the filtered
        // first-page count as a documented LOWER BOUND.
        totalAvailable = filteredTotal;
        totalIsLowerBound = true;
    }
    else if (overflow) {
        // No client filter → the server's exact total is honest (returned rows are
        // the lower bound, disclosed via truncated + note).
        totalAvailable = servedTotal;
    }
    else {
        // The exact count of the client-filtered set (never the page length).
        totalAvailable = filteredTotal;
    }
    const pageRows = rows.slice(offset, offset + limit);
    const returned = pageRows.length;
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    const notes = [
        PRE_PUBLICATION_CAVEAT,
        LEADDAYS_METHOD_NOTE,
        SPECIAL_REGULAR_NOTE,
    ];
    notes.push(`Served ${servedTotal} document(s); after client filters (type/agency/specialOnly) → ${totalAvailable}${totalIsLowerBound ? "+ (lower bound)" : ""} pageable. The full ${mode} set was fetched in ONE request; limit/offset is a client-side window over the fetched rows.`);
    notes.push("Filters type/agency/specialOnly are applied CLIENT-SIDE over the fetched set; date (→ conditions[available_on]) and term (→ conditions[term]) are server-side query params.");
    if (pageRows.some((r) => typeof r.leadDays === "number" && r.leadDays < 0)) {
        notes.push("At least one row has a NEGATIVE leadDays (publication_date precedes the filing date) — a source data anomaly, surfaced verbatim (not clamped/nulled).");
    }
    if (filteredTotal === 0) {
        notes.push(`No documents on public inspection for mode='${mode}'${asOfDate ? ` (available_on=${asOfDate})` : ""}${hasClientFilter ? " matching the requested filters" : ""}. This is an honest empty result, not an error.`);
    }
    if (overflow) {
        notes.push(hasClientFilter
            ? `Server matched ${servedTotal} before client filters but only the first ${rawRows.length} rows were retrieved — totalAvailable is a LOWER BOUND on the client-filtered set. Narrow with a more specific term/type.`
            : `Only the first ${rawRows.length} of ${servedTotal} documents were retrieved (server pagination) — totalAvailable is the exact server total; returned rows are a lower bound. Narrow with a more specific term/type.`);
    }
    const filtersApplied = ["mode"];
    if (asOfDate)
        filtersApplied.push("date");
    if (input.term)
        filtersApplied.push("term");
    if (input.type)
        filtersApplied.push("type");
    if (input.agency)
        filtersApplied.push("agency");
    if (input.specialOnly)
        filtersApplied.push("specialOnly");
    const data = {
        mode,
        asOfDate,
        specialFilingsUpdatedAt,
        regularFilingsUpdatedAt,
        servedTotal,
        totalAvailable,
        returned,
        documents: pageRows,
    };
    return withMeta(data, {
        source: "www.federalregister.gov/api/v1/public-inspection-documents (keyless)",
        keylessMode: true,
        returned,
        totalAvailable,
        ...(totalIsLowerBound ? { totalIsLowerBound: true } : {}),
        ...(overflow ? { truncated: true } : {}),
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    });
}
//# sourceMappingURL=federal-register.js.map