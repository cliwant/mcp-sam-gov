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
import { fetchWithRetry } from "./errors.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
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
//# sourceMappingURL=federal-register.js.map