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
}): Promise<{
    totalRecords: number;
    totalPages: number;
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
}>;
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
//# sourceMappingURL=federal-register.d.ts.map