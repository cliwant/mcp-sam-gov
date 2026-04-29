/**
 * Minimal USAspending v2 wrappers for the MCP server.
 *
 * Why we don't depend on a separate `@govicon/usaspending` package:
 * the surface here is small (4 endpoints, ~120 LOC) and tightly
 * coupled to the MCP tool shape. If usage grows we'll extract.
 *
 * USAspending endpoints used:
 *   - /search/spending_by_category/recipient
 *   - /search/spending_by_category/awarding_subagency
 *   - /search/spending_by_award (with subawards: false | true)
 *   - /autocomplete/funding_agency
 *
 * All endpoints are KEYLESS — USAspending is a public federal
 * spending transparency API, no registration needed.
 */
export type UsasFilters = Record<string, unknown>;
export declare function searchAwards(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    setAside?: string;
}): Promise<{
    totalAwards: number;
    totalValue: number;
    topRecipients: {
        name: string;
        value: number;
        awards: number;
    }[];
}>;
export declare function searchIndividualAwards(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    setAside?: string;
    limit?: number;
}): Promise<{
    awards: {
        awardId: string;
        recipient: string;
        amount: number;
        awardingAgency: string;
        awardingSubAgency: string | undefined;
        placeOfPerformanceState: string | undefined;
        description: string | undefined;
    }[];
}>;
export declare function searchSubAgencySpending(args: {
    agency: string;
    fiscalYear?: number;
}): Promise<{
    subAgencies: {
        name: string;
        amount: number;
        awards: number;
    }[];
}>;
export declare function lookupAgency(searchText: string): Promise<{
    matches: {
        name: string;
        abbreviation: string | undefined;
        toptierCode: string | undefined;
        isToptier: boolean;
    }[];
}>;
//# sourceMappingURL=usaspending.d.ts.map