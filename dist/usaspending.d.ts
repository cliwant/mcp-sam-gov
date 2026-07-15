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
import { type MetaBundle } from "./meta.js";
/**
 * Test-only: reset the resilience circuit breaker between OFFLINE fixtures (the
 * breaker is module-level process state; a fresh instance isolates cases).
 * Mirrors treasury.ts's `_resetTreasuryBreakerForTests`.
 */
export declare function _resetUsasBreakerForTests(): void;
export declare function searchAwards(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    setAside?: string;
}): Promise<MetaBundle<{
    totalAwards: number | null;
    totalValue: number;
    topRecipients: {
        name: string;
        value: number;
        awards: number | null;
    }[];
}>>;
export declare function searchIndividualAwards(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    setAside?: string;
    limit?: number;
}): Promise<MetaBundle<{
    awards: {
        awardId: string;
        recipient: string | null;
        amount: number | null;
        awardingAgency: string | null;
        awardingSubAgency: string | undefined;
        naicsCode: string | undefined;
        naicsDescription: string | undefined;
        placeOfPerformanceState: string | undefined;
        placeOfPerformanceCity: string | undefined;
        placeOfPerformanceCountry: string | undefined;
        placeOfPerformanceZip: string | undefined;
        description: string | undefined;
        generatedInternalId: string;
    }[];
}>>;
export declare function searchAwardsByRecipient(args: {
    recipientName: string;
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<MetaBundle<{
    awards: {
        awardId: string;
        recipient: string | null;
        amount: number | null;
        awardingAgency: string | null;
        awardingSubAgency: string | undefined;
        naicsCode: string | undefined;
        naicsDescription: string | undefined;
        placeOfPerformanceState: string | undefined;
        placeOfPerformanceCity: string | undefined;
        placeOfPerformanceCountry: string | undefined;
        placeOfPerformanceZip: string | undefined;
        description: string | undefined;
        generatedInternalId: string;
    }[];
    totalRecords: number | null;
}>>;
export declare function searchSubawards(args: {
    subRecipientName?: string;
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<MetaBundle<{
    subawards: {
        subAwardId: string;
        subRecipient: string | null;
        amount: number | null;
        actionDate: string;
        naicsCode: string | undefined;
        naicsDescription: string | undefined;
        primeAwardId: string;
    }[];
}>>;
/** A parent-award / IDV linkage as returned on awards/{id} (all optional). */
export type AwardParentIdv = {
    piid: string | null;
    generatedUniqueAwardId: string | null;
    idvTypeDescription: string | null;
    multipleOrSingleAwardDescription: string | null;
};
export declare function getAwardDetail(generatedInternalId: string): Promise<{
    awardId: string;
    recipient: string | null;
    totalObligation: number | null;
    baseAndAllOptions: number | null;
    baseExercisedOptions: number | null;
    subawardCount: number | null;
    contractAwardType: string | null;
    periodOfPerformance: {
        startDate: string | null;
        endDate: string | null;
        potentialEndDate: string | null;
    };
    description: string;
    setAsideType: string | undefined;
    setAsideDescription: string | undefined;
    competitionExtent: string | undefined;
    competitionExtentDescription: string | null;
    numberOfOffers: number | null;
    awardingAgency: string | undefined;
    awardingSubAgency: string | undefined;
    naicsCode: string | undefined;
    naicsDescription: string | undefined;
    pscCode: string | null;
    pscDescription: string | null;
    parentIdv: AwardParentIdv | null;
} | null>;
/**
 * Per-award incumbent + PUBLIC recompete-pressure analysis (design doc 04
 * §5.2). Given ONE award (`generatedInternalId`) it assembles, from keyless
 * data only:
 *   - the incumbent identity + the award's agency/NAICS/PSC/vehicle,
 *   - PUBLIC recompete-pressure SIGNALS (obligated-vs-ceiling consumption, mod
 *     count, competition extent + number of offers, set-aside, days to the
 *     current PoP end, and option-extendable days), and
 *   - (optionally) the incumbent's other awards in the same agency.
 *
 * DESIGN — bounded & keyless, NO N+1 fan-out:
 *   1 `awards/{id}` detail  +  1 `transactions/` page (mod count, capped at
 *   100 → lower bound)  +  (optional) 1 `searchAwardsByRecipient` call. That is
 *   at most 3 upstream calls regardless of award size.
 *
 * HONEST CEILING (mandatory): it emits INDIVIDUAL public signals + `pressureHints`
 * (e.g. "single_offer", "ceiling_nearly_exhausted", "hard_stop_no_options") that
 * are HINTS, never a score. It NEVER emits a composite "vulnerability score" —
 * the most decision-relevant input (past performance / CPARS), protest history,
 * and the incumbent's option-exercise intent are not public, and are declared
 * in `_meta.fieldsUnavailable`. A not-found award raises a structured not_found
 * error (never `{ok:true, data:null}`).
 */
export declare function analyzeIncumbent(args: {
    generatedInternalId: string;
    includeOtherAwards?: boolean;
    otherAwardsLimit?: number;
}): Promise<MetaBundle<{
    incumbentOtherAwards?: {
        awardId: string;
        recipient: string | null;
        amount: number | null;
        awardingAgency: string | null;
        awardingSubAgency: string | undefined;
        naicsCode: string | undefined;
        naicsDescription: string | undefined;
        placeOfPerformanceState: string | undefined;
        placeOfPerformanceCity: string | undefined;
        placeOfPerformanceCountry: string | undefined;
        placeOfPerformanceZip: string | undefined;
        description: string | undefined;
        generatedInternalId: string;
    }[] | undefined;
    award: {
        awardId: string;
        incumbent: string | null;
        awardingAgency: string | null;
        awardingSubAgency: string | null;
        naicsCode: string | null;
        pscCode: string | null;
        contractAwardType: string | null;
        startDate: string | null;
        currentEndDate: string | null;
        potentialEndDate: string | null;
    };
    signals: {
        obligatedVsCeiling: {
            obligated: number | null;
            baseAndAllOptions: number | null;
            baseExercisedOptions: number | null;
            pctConsumed: number | null;
        };
        modCount: number | null;
        modCountAtLeast: boolean;
        setAside: string | null;
        setAsideDescription: string | null;
        extentCompeted: string | null;
        extentCompetedDescription: string | null;
        numberOfOffers: number | null;
        currentEndDate: string | null;
        potentialEndDate: string | null;
        extendableDays: number | null;
        daysUntilCurrentEnd: number | null;
        vehicle: {
            contractAwardType: string | null;
            parentIdvPiid: string | null;
            idvType: string | null;
            singleOrMultiple: string | null;
        };
    };
    pressureHints: string[];
}>>;
/**
 * Recompete radar — federal contracts whose current period of performance
 * ends inside a window around today, so you can see what's coming up for
 * recompete. Replaces the broken `searchExpiringContracts` internals.
 *
 * MECHANISM (LIVE-VERIFIED 2026-07-03 across VA×541512 and DoD×541330):
 * `spending_by_award` returns the current PoP end date directly under the
 * field ALIAS `"End Date"` (the canonical string
 * "Period of Performance Current End Date" is NOT a recognized field — it
 * comes back always null, and is not in the sort mappings → HTTP 400 if you
 * sort by it). Gold-standard confirmed: search `"End Date"` ===
 * `awards/{generated_internal_id}`.period_of_performance.end_date.
 *
 * We CANNOT filter by PoP end date server-side (`time_period.date_type` only
 * supports action_date/date_signed/last_modified_date/new_awards_only). So:
 *   1. server-side SORT by `"End Date"` DESC (the alias — the only PoP-end
 *      value in the sort mappings),
 *   2. an action_date `time_period` lower bound (LOAD-BEARING: prunes inactive
 *      records and much of the far-future data-entry garbage so DESC reaches
 *      the window sooner),
 *   3. a CLIENT-SIDE window filter with pagination + a safe early-stop (DESC ⇒
 *      once a row is earlier than the window start, every later row is earlier
 *      too), bounded by `scanBudgetPages`.
 *
 * TRUTHFULNESS: rows with a null `"End Date"` are COUNTED (`missingEndDate`),
 * never silently dropped. If the scan budget is exhausted before the early-stop
 * fires, `scanTruncated` is set and `totalAvailable` becomes null (the returned
 * set is a lower bound, not the complete window). This tool emits PUBLIC
 * signals only — it never fabricates a composite "vulnerability" score;
 * past-performance/CPARS, protest history, and option-exercise intent are not
 * public and are declared in `_meta.fieldsUnavailable`.
 */
export declare function searchRecompetes(args: {
    agency?: string;
    naics?: string;
    pscCodes?: string[];
    setAside?: string;
    windowStartDays?: number;
    windowEndDays?: number;
    minAwardValue?: number;
    includePotentialEnd?: boolean;
    actionDateLookbackYears?: number;
    page?: number;
    pageSize?: number;
    scanBudgetPages?: number;
}): Promise<MetaBundle<{
    recompetes: {
        awardId: string;
        generatedInternalId: string;
        incumbent: string;
        amount: number;
        currentEndDate: string;
        daysUntilCurrentEnd: number;
        potentialEndDate?: string | null;
        extendableDays?: number | null;
        awardingAgency: string;
        awardingSubAgency: string | null;
        naicsCode: string | null;
        pscCode: string | null;
        contractAwardType: string | null;
        setAsideDescription: string | null;
        startDate: string | null;
        description: string | null;
    }[];
    page: number;
    pageSize: number;
}>>;
/**
 * DEPRECATED alias — kept working so existing callers of
 * `usas_search_expiring_contracts` don't break. Maps the old params onto
 * `searchRecompetes` and re-shapes the output to the legacy `{ contracts,
 * searchedCount }` keys the smoke/edge tests assert on. Prefer
 * `usas_search_recompetes`.
 */
export declare function searchExpiringContracts(args: {
    agency?: string;
    naics?: string;
    monthsUntilExpiry?: number;
    minAwardValue?: number;
    limit?: number;
}): Promise<MetaBundle<{
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
        description: string | undefined;
        daysUntilExpiry: number;
        generatedInternalId: string;
    }[];
    searchedCount: number;
}>>;
export declare function spendingOverTime(args: {
    group?: "fiscal_year" | "quarter" | "month";
    agency?: string;
    naics?: string;
    setAside?: string;
}): Promise<MetaBundle<{
    group: string;
    timeline: {
        timePeriod: {
            fiscal_year?: string;
            quarter?: string;
            month?: string;
        };
        total: number;
        contractObligations: number;
        grantObligations: number | null;
        idvObligations: number | null;
    }[];
}>>;
export declare function searchPscSpending(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<MetaBundle<{
    psc: {
        pscCode: string;
        pscName: string;
        amount: number;
    }[];
}>>;
export declare function searchStateSpending(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<MetaBundle<{
    states: {
        stateCode: string;
        stateName: string;
        amount: number;
    }[];
}>>;
export declare function searchCfdaSpending(args: {
    agency?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<MetaBundle<{
    programs: {
        cfdaCode: string;
        programName: string;
        amount: number;
    }[];
}>>;
export declare function searchFederalAccountSpending(args: {
    agency?: string;
    naics?: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<MetaBundle<{
    accounts: {
        tasCode: string;
        accountName: string;
        amount: number;
    }[];
}>>;
export declare function searchAgencySpending(args: {
    naics?: string;
    fiscalYear?: number;
    setAside?: string;
    limit?: number;
}): Promise<MetaBundle<{
    agencies: {
        name: string;
        code: string;
        slug: string;
        amount: number;
    }[];
}>>;
export declare function searchSubAgencySpending(args: {
    agency: string;
    fiscalYear?: number;
}): Promise<MetaBundle<{
    subAgencies: {
        name: string;
        amount: number;
        awards: number | null;
    }[];
}>>;
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
}): Promise<MetaBundle<{
    fiscalYear: number | undefined;
    toptierCode: string | undefined;
    transactionCount: number | null;
    obligations: number | null;
    latestActionDate: string | undefined;
}>>;
export declare function getAgencyBudgetFunction(args: {
    toptierCode: string;
    fiscalYear?: number;
    limit?: number;
}): Promise<MetaBundle<{
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
}>>;
export declare function searchRecipients(args: {
    keyword: string;
    recipientLevel?: "P" | "C" | "R";
    limit?: number;
}): Promise<MetaBundle<{
    totalRecords: number | null;
    recipients: {
        id: string;
        duns: string | undefined;
        uei: string | undefined;
        name: string;
        level: string | undefined;
        totalAmount: number;
    }[];
}>>;
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
}): Promise<MetaBundle<{
    naics: {
        code: string;
        description: string;
        retired: boolean;
    }[];
}>>;
export declare function autocompleteRecipient(args: {
    searchText: string;
    limit?: number;
}): Promise<MetaBundle<{
    recipients: {
        name: string;
        uei: string | undefined;
        duns: string | undefined;
    }[];
}>>;
export declare function naicsHierarchy(args: {
    naicsFilter?: string;
}): Promise<MetaBundle<{
    filter: string | null;
    found: boolean | null;
    parent: {
        code: string;
        description: string;
        count: number;
    } | null;
    hierarchy: {
        code: string;
        description: string;
        count: number;
        hasChildren: boolean;
    }[];
}>>;
export declare function glossary(args: {
    limit?: number;
    search?: string;
}): Promise<MetaBundle<{
    totalRecords: number | null;
    terms: {
        term: string;
        slug: string;
        definition: string;
    }[];
}>>;
export declare function listToptierAgencies(args: {
    limit?: number;
}): Promise<MetaBundle<{
    agencies: {
        name: string;
        abbreviation: string | undefined;
        toptierCode: string | undefined;
        slug: string | undefined;
        activeFiscalYear: string | undefined;
        obligatedAmount: number;
    }[];
}>>;
//# sourceMappingURL=usaspending.d.ts.map