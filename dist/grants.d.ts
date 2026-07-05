/**
 * Grants.gov v1 API wrappers (keyless).
 *
 * Grants.gov hosts federal financial-assistance opportunities (grants,
 * cooperative agreements). Distinct from SAM.gov contracts but the
 * same pursuit ICP often cares about both.
 *
 * Endpoints (POST JSON, no key):
 *   - /v1/api/search2 — search opportunities
 *   - /v1/api/fetchOpportunity — single grant detail
 *
 * Documented at https://grants.gov/web/grants/s2s/grantor/schemas/grants-search-2-soap.html
 */
export type GrantStatus = "forecasted" | "posted" | "closed" | "archived";
export declare function searchGrants(args: {
    keyword?: string;
    cfda?: string;
    agency?: string;
    oppNum?: string;
    oppStatuses?: GrantStatus[];
    rows?: number;
}): Promise<import("./meta.js").MetaBundle<{
    totalRecords: number;
    grants: {
        id: string;
        opportunityNumber: string;
        title: string;
        agencyCode: string;
        agencyName: string;
        openDate: string | undefined;
        closeDate: string | undefined;
        status: string | undefined;
        docType: string | undefined;
        cfdaList: string[];
    }[];
}>>;
export declare function getGrant(args: {
    opportunityId: string;
}): Promise<{
    found: false;
    opportunityId: string;
    id?: undefined;
    opportunityNumber?: undefined;
    title?: undefined;
    agency?: undefined;
    description?: undefined;
    postingDate?: undefined;
    responseDate?: undefined;
    archiveDate?: undefined;
    awardCeiling?: undefined;
    awardFloor?: undefined;
    estimatedFunding?: undefined;
    expectedNumberOfAwards?: undefined;
    applicantTypes?: undefined;
    fundingInstruments?: undefined;
    fundingCategories?: undefined;
    cfdaPrograms?: undefined;
} | {
    found: true;
    id: number;
    opportunityNumber: string;
    title: string;
    agency: {
        code: string | undefined;
        name: string | null;
        department: string | null;
        contactName: string | null;
    };
    description: string;
    postingDate: string | undefined;
    responseDate: string | undefined;
    archiveDate: string | undefined;
    awardCeiling: number | undefined;
    awardFloor: number | undefined;
    estimatedFunding: number | undefined;
    expectedNumberOfAwards: number | undefined;
    applicantTypes: string[];
    fundingInstruments: string[];
    fundingCategories: string[];
    cfdaPrograms: {
        number: string;
        title: string;
    }[];
    opportunityId?: undefined;
}>;
//# sourceMappingURL=grants.d.ts.map