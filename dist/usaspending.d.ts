/**
 * USAspending v2 wrappers (keyless).
 *
 * Coverage map (every endpoint here is verified KEYLESS):
 *   Awards / Recipients
 *     - search/spending_by_category/recipient        → searchAwards
 *     - search/spending_by_award (subawards: false)  → searchIndividualAwards
 *     - search/spending_by_award (subawards: true)   → searchSubawards
 *     - search/spending_by_award (recipient filter)  → searchAwardsByRecipient
 *     - awards/{generated_internal_id}               → getAwardDetail
 *     - search/spending_by_award + awards/{id} pair  → searchExpiringContracts
 *   Aggregate analysis
 *     - search/spending_over_time                    → spendingOverTime
 *     - search/spending_by_category/psc              → searchPscSpending
 *     - search/spending_by_category/state_territory  → searchStateSpending
 *     - search/spending_by_category/cfda             → searchCfdaSpending
 *     - search/spending_by_category/federal_account  → searchFederalAccountSpending
 *     - search/spending_by_category/awarding_agency  → searchAgencySpending
 *     - search/spending_by_category/awarding_subagency → searchSubAgencySpending
 *   Agency profile
 *     - agency/{toptier_code}                        → getAgencyProfile
 *     - agency/{toptier_code}/awards                 → getAgencyAwardsSummary
 *     - agency/{toptier_code}/budget_function        → getAgencyBudgetFunction
 *   Recipient profile
 *     - recipient/ POST                              → searchRecipients
 *     - recipient/{id}                               → getRecipientProfile
 *   Reference / autocomplete (anti-hallucination)
 *     - autocomplete/funding_agency                  → lookupAgency
 *     - autocomplete/naics                           → autocompleteNaics
 *     - autocomplete/recipient                       → autocompleteRecipient
 *     - references/naics                             → naicsHierarchy
 *     - references/glossary                          → glossary
 *     - references/toptier_agencies                  → listToptierAgencies
 *
 * Total: 22 endpoints across the USAspending surface, all keyless.
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
        generatedInternalId: string;
    }[];
}>;
export declare function searchAwardsByRecipient(args: {
    recipientName: string;
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<{
    awards: {
        awardId: string;
        recipient: string;
        amount: number;
        awardingAgency: string;
        awardingSubAgency: string | undefined;
        naicsCode: string | undefined;
        naicsDescription: string | undefined;
        description: string | undefined;
        generatedInternalId: string;
    }[];
    totalRecords: number;
}>;
export declare function searchSubawards(args: {
    primeRecipientName?: string;
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<{
    subawards: {
        subAwardId: string;
        subRecipient: string;
        amount: number;
        actionDate: string;
        primeAwardId: string;
    }[];
}>;
export declare function getAwardDetail(generatedInternalId: string): Promise<{
    awardId: string;
    recipient: string;
    totalObligation: number;
    baseAndAllOptions: number;
    periodOfPerformance: {
        startDate: string | null;
        endDate: string | null;
        potentialEndDate: string | null;
    };
    description: string;
    setAsideType: string | undefined;
    setAsideDescription: string | undefined;
    competitionExtent: string | undefined;
    numberOfOffers: string | undefined;
    awardingAgency: string | undefined;
    awardingSubAgency: string | undefined;
    naicsCode: string | undefined;
    naicsDescription: string | undefined;
} | null>;
export declare function searchExpiringContracts(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    monthsUntilExpiry?: number;
    minAwardValue?: number;
    limit?: number;
}): Promise<{
    contracts: {
        awardId: string;
        recipient: string;
        amount: number;
        endDate: string;
        potentialEndDate: string | null;
        awardingAgency: string;
        awardingSubAgency: string | undefined;
        naicsCode: string | undefined;
        setAsideDescription: string | undefined;
        description: string;
        daysUntilExpiry: number;
    }[];
    searchedCount: number;
}>;
export declare function spendingOverTime(args: {
    group?: "fiscal_year" | "quarter" | "month";
    agency?: string;
    naics?: string;
    setAside?: string;
}): Promise<{
    group: string | undefined;
    timeline: {
        timePeriod: {
            fiscal_year?: string;
            quarter?: string;
            month?: string;
        };
        total: number;
        contractObligations: number;
        grantObligations: number;
        idvObligations: number;
    }[];
}>;
export declare function searchPscSpending(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<{
    psc: {
        pscCode: string;
        pscName: string;
        amount: number;
    }[];
}>;
export declare function searchStateSpending(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<{
    states: {
        stateCode: string;
        stateName: string;
        amount: number;
    }[];
}>;
export declare function searchCfdaSpending(args: {
    agency?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<{
    programs: {
        cfdaCode: string;
        programName: string;
        amount: number;
    }[];
}>;
export declare function searchFederalAccountSpending(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<{
    accounts: {
        tasCode: string;
        accountName: string;
        amount: number;
    }[];
}>;
export declare function searchAgencySpending(args: {
    naics?: string;
    fiscalYear?: number;
    setAside?: string;
    limit?: number;
}): Promise<{
    agencies: {
        name: string;
        code: string;
        slug: string;
        amount: number;
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
export declare function getAgencyProfile(toptierCode: string): Promise<{
    fiscalYear: number | undefined;
    toptierCode: string | undefined;
    name: string | undefined;
    abbreviation: string | undefined;
    mission: string | undefined;
    website: string | undefined;
    subtierAgencyCount: number | undefined;
    congressionalJustificationUrl: string | undefined;
}>;
export declare function getAgencyAwardsSummary(args: {
    toptierCode: string;
    fiscalYear?: number;
}): Promise<{
    fiscalYear: number | undefined;
    toptierCode: string | undefined;
    transactionCount: number;
    obligations: number;
    latestActionDate: string | undefined;
}>;
export declare function getAgencyBudgetFunction(args: {
    toptierCode: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<{
    toptierCode: string | undefined;
    fiscalYear: number | undefined;
    functions: {
        name: string;
        programs: {
            name: string;
            obligated: number;
            outlays: number;
        }[];
    }[];
}>;
export declare function searchRecipients(args: {
    keyword: string;
    recipientLevel?: "P" | "C" | "R";
    limit?: number;
}): Promise<{
    totalRecords: number;
    recipients: {
        id: string;
        duns: string | undefined;
        uei: string | undefined;
        name: string;
        level: string | undefined;
        totalAmount: number;
    }[];
}>;
export declare function getRecipientProfile(recipientId: string): Promise<{
    name: string;
    alternateNames: string[];
    duns: string | undefined;
    uei: string | undefined;
    recipientId: string | undefined;
    level: string | undefined;
    parentId: string | undefined;
    parentName: string | undefined;
    businessTypes: string[];
    location: {
        address_line1?: string;
        city_name?: string;
        state_code?: string;
        country_name?: string;
        zip5?: string;
    };
    totalAmount: number;
    totalTransactions: number;
}>;
export declare function lookupAgency(searchText: string): Promise<{
    matches: {
        name: string;
        abbreviation: string | undefined;
        toptierCode: string | undefined;
        isToptier: boolean;
    }[];
}>;
export declare function autocompleteNaics(args: {
    searchText: string;
    limit?: number;
}): Promise<{
    naics: {
        code: string;
        description: string;
        retired: boolean;
    }[];
}>;
export declare function autocompleteRecipient(args: {
    searchText: string;
    limit?: number;
}): Promise<{
    recipients: {
        name: string;
        uei: string | undefined;
        duns: string | undefined;
    }[];
}>;
export declare function naicsHierarchy(args: {
    naicsFilter?: string;
}): Promise<{
    hierarchy: {
        code: string;
        description: string;
        count: number;
        hasChildren: boolean;
    }[];
}>;
export declare function glossary(args: {
    limit?: number;
    search?: string;
}): Promise<{
    totalRecords: number;
    terms: {
        term: string;
        slug: string;
        definition: string;
    }[];
}>;
export declare function listToptierAgencies(args: {
    limit?: number;
}): Promise<{
    agencies: {
        name: string;
        abbreviation: string | undefined;
        toptierCode: string | undefined;
        slug: string | undefined;
        activeFiscalYear: string | undefined;
        obligatedAmount: number;
    }[];
}>;
//# sourceMappingURL=usaspending.d.ts.map