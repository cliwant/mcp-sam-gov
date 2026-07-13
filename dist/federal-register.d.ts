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
export type FedRegDocumentType = "RULE" | "PRORULE" | "NOTICE" | "PRESDOCU" | "UNKNOWN";
export declare function searchDocuments(args: {
    query?: string;
    agencySlugs?: string[];
    type?: "RULE" | "PRORULE" | "NOTICE" | "PRESDOCU";
    publicationDateFrom?: string;
    publicationDateTo?: string;
    effectiveDateFrom?: string;
    perPage?: number;
}): Promise<import("./meta.js").MetaBundle<{
    totalRecords: number;
    totalRecordsSaturated: boolean;
    totalPages: number;
    totalPagesSaturated: boolean;
    documents: {
        documentNumber: string;
        title: string;
        type: FedRegDocumentType;
        typeDisplay: string;
        abstract: string;
        htmlUrl: string;
        pdfUrl: string | undefined;
        publicationDate: string;
        effectiveDate: string | undefined;
        agencies: {
            name: string;
            slug: string;
        }[];
    }[];
}>>;
export declare function getDocument(documentNumber: string): Promise<{
    documentNumber: string;
    title: string;
    type: FedRegDocumentType;
    typeDisplay: string;
    abstract: string;
    htmlUrl: string;
    pdfUrl: string | undefined;
    rawTextUrl: string | undefined;
    publicationDate: string;
    effectiveDate: string | undefined;
    citation: string | undefined;
    pageCount: number | undefined;
    agencies: {
        name: string;
        slug: string;
    }[];
    cfrReferences: {
        title: string;
        part: string | undefined;
        chapter: string | undefined;
    }[];
}>;
export declare function listAgencies(args: {
    perPage?: number;
}): Promise<{
    agencies: {
        id: number;
        name: string;
        shortName: string | undefined;
        slug: string;
        description: string;
        parentId: number | null | undefined;
    }[];
}>;
/**
 * The mandatory pre-publication caveat — rides `_meta.notes` on EVERY response.
 * A public-inspection doc is FILED, not PUBLISHED: no final FR citation/page yet,
 * and it may CHANGE or be WITHDRAWN before publication. Load-bearing honesty:
 * presenting a PI doc as the authoritative published rule is the forbidden lie.
 */
export declare const PRE_PUBLICATION_CAVEAT = "These are PRE-PUBLICATION documents on PUBLIC INSPECTION \u2014 filed with the Office of the Federal Register but NOT YET published. This is a LEADING INDICATOR, not the authoritative published rule/notice: there is NO final Federal Register citation or page number yet, and the content CAN CHANGE or be WITHDRAWN before its publication_date. After the publication_date, cross-check fed_register_get_document (by document_number) for the authoritative published version.";
/** Discloses how `leadDays` is derived (null-never-0). */
export declare const LEADDAYS_METHOD_NOTE = "leadDays = publication_date minus the calendar date of filed_at, in whole days (the pre-publication head-start); null when either date is missing/unparseable, a genuine same-day filing is 0, a negative value (publication before filing) is a surfaced-verbatim anomaly.";
/** Discloses the special-vs-regular distinction (never conflated). */
export declare const SPECIAL_REGULAR_NOTE = "filing_type 'special' = filed OFF-CYCLE for immediate/emergency public inspection (a stronger, SOONER signal \u2014 often same/next-day publication); 'regular' = filed for the next regular business-day inspection. Surfaced verbatim; the two are not conflated.";
export type FedRegPublicInspectionMode = "current" | "date" | "search";
export type FedRegPublicInspectionInput = {
    mode?: FedRegPublicInspectionMode;
    date?: string;
    term?: string;
    type?: "RULE" | "PRORULE" | "NOTICE" | "PRESDOCU";
    agency?: string;
    specialOnly?: boolean;
    limit?: number;
    offset?: number;
};
type RawAgency = {
    raw_name?: string;
    name?: string;
    id?: number;
    url?: string;
    json_url?: string;
    parent_id?: number | null;
    slug?: string;
};
type RawInspectionRow = {
    document_number?: string;
    type?: string;
    title?: string;
    filed_at?: string;
    publication_date?: string;
    filing_type?: string;
    agencies?: RawAgency[];
    agency_names?: string[];
    docket_numbers?: string[];
    html_url?: string;
    pdf_url?: string;
    raw_text_url?: string;
    json_url?: string;
    num_pages?: number;
    subject_1?: string;
    subject_2?: string;
    subject_3?: string;
};
type InspectionEnvelope = {
    count: number;
    results: RawInspectionRow[];
    special_filings_updated_at?: string;
    regular_filings_updated_at?: string;
    total_pages?: number;
    next_page_url?: string;
};
/**
 * `leadDays` = publication_date − the CALENDAR DATE of filed_at, in whole days.
 * tz-immune (compares the sliced YYYY-MM-DD strings — both on FR's Eastern basis,
 * so no -04:00/-05:00 DST off-by-one). NULL-NEVER-0: null when either date is
 * missing/unparseable; a genuine same-day filing survives as 0; a negative
 * (publication before filing — a data anomaly) is surfaced VERBATIM, never
 * clamped or nulled.
 */
export declare function computeLeadDays(filedAt: string | null | undefined, publicationDate: string | null | undefined): number | null;
/**
 * SSRF host re-assertion (defense-in-depth; ADR-0043 §Q7). The only caller
 * values that reach the wire are `date` (→ conditions[available_on]) and `term`
 * (→ conditions[term]), both URLSearchParams QUERY params on the fixed host — no
 * caller-controlled PATH segment. Re-assert the constructed URL is https on
 * www.federalregister.gov; anything else → invalid_input (never fetched).
 */
export declare function assertFedRegHost(urlStr: string): void;
/**
 * Build the wire URL per mode. ★The date rides `conditions[available_on]` (a
 * QUERY param), NEVER a `/{date}.json` path segment (fact 6: that path silently
 * returns a WRONG unrelated doc). `term` rides `conditions[term]`. Both via
 * URLSearchParams. `new URL` + host re-assert closes host-escape/downgrade.
 */
export declare function buildPublicInspectionUrl(mode: FedRegPublicInspectionMode, opts?: {
    date?: string;
    term?: string;
}): string;
/**
 * Envelope-shape guard (M2). The list envelopes (`current`/`date`/`search`) are
 * `{count:number, results:array, …}`. `fetchJson` casts `as T` without checking,
 * so a 200 body of the wrong shape would map to garbage. Throw a `schema_drift`
 * ToolErrorCarrier (NOT a plain Error — `toToolError` has no branch for a bare
 * Error, so it would degrade to `unknown`). The two `*_filings_updated_at` stamps
 * are OPTIONAL (S4: a zero-result day omits them) and are NOT asserted here.
 */
export declare function assertInspectionEnvelope(json: unknown, endpoint: string): asserts json is InspectionEnvelope;
/**
 * `fed_register_public_inspection` — the pre-publication leading indicator.
 * mode {current, date, search}; fetch-once + client-side window; every response
 * carries the pre-publication caveat + the leadDays/special-vs-regular notes.
 */
export declare function publicInspection(input: FedRegPublicInspectionInput): Promise<import("./meta.js").MetaBundle<{
    mode: FedRegPublicInspectionMode;
    asOfDate: string | null;
    specialFilingsUpdatedAt: string | null;
    regularFilingsUpdatedAt: string | null;
    servedTotal: number;
    totalAvailable: number;
    returned: number;
    documents: {
        documentNumber: string | null;
        type: string | null;
        typeCode: FedRegDocumentType;
        title: string | null;
        filedAt: string | null;
        publicationDate: string | null;
        leadDays: number | null;
        filingType: string | null;
        isSpecialFiling: boolean;
        agencies: {
            rawName: string | null;
            name: string | null;
            id: number | null;
            slug: string | null;
            url: string | null;
            jsonUrl: string | null;
            parentId: number | null;
        }[];
        htmlUrl: string | null;
        pdfUrl: string | null;
        rawTextUrl: string | null;
        docketNumbers: string[];
        numPages: number | null;
        subjects: string[];
    }[];
}>>;
export {};
//# sourceMappingURL=federal-register.d.ts.map