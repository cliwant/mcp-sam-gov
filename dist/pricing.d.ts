/**
 * Pricing tier (keyless) — labor-rate grounding for federal-contract pricing.
 *
 * Three keyless tools, every endpoint LIVE-VERIFIED 2026-07-03:
 *   - sam_search_wage_determinations → SAM SGS search (index=sca|dbra)
 *   - sam_get_wage_rates            → SAM WDOL detail (rates parsed from TEXT)
 *   - gsa_benchmark_labor_rates     → GSA CALC v3 ceiling-rate distribution
 *
 * The defining constraint of the two SAM tools: the actual wage RATES live
 * inside a plain-text `document` blob (a fixed-width wage-determination form),
 * NOT structured JSON. So `sam_get_wage_rates` parses best-effort and ALWAYS
 * exposes a `parseConfidence` + a `format:"parsed"|"raw"|"both"` escape hatch so
 * an AI can read the raw text when parsing is low-confidence. Truthfulness is
 * the product: we never fake structure and we disclose every caveat in `_meta`.
 *
 * The defining constraint of the CALC tool: it returns a DISTRIBUTION of
 * awarded CEILING (catalog) rates that are FULLY BURDENED — never a single
 * "the rate". Its total count SATURATES at 10000 (relation:"gte") for broad
 * queries and its page size is CAPPED at 20 rows server-side, so all
 * distribution stats are computed over the fetched sample and disclosed as such.
 */
export declare function searchWageDeterminations(args: {
    coverage: string;
    state?: string;
    county?: string;
    query?: string;
    activeOnly?: boolean;
    standardOnly?: boolean;
    limit?: number;
    page?: number;
}): Promise<import("./meta.js").MetaBundle<{
    determinations: {
        fullReferenceNumber: string;
        shortReferenceNumber: string | null;
        revisionNumber: number | null;
        coverage: string;
        title: string | null;
        isActive: boolean | null;
        isStandard: boolean | null;
        publishDate: string | null;
        modifiedDate: string | null;
        states: string[];
        counties: string[];
        services: string[];
        year: number | null;
        constructionTypes: {} | null;
        allReferenceNumbers: string[];
    }[];
    coverageIndex: "sca" | "dbra";
    page: number;
    limit: number;
}>>;
export declare function getWageRates(args: {
    reference: string;
    revision?: number;
    coverage?: string;
    format?: "parsed" | "raw" | "both";
}): Promise<import("./meta.js").MetaBundle<Record<string, unknown>>>;
export declare function benchmarkLaborRates(args: {
    laborCategory: string;
    businessSize?: string;
    educationLevel?: string;
    minYearsExperience?: number;
    experienceRange?: string;
    sin?: string;
    priceRange?: string;
    maxSamplePages?: number;
}): Promise<import("./meta.js").MetaBundle<{
    laborCategory: string;
    matcher: "search" | "q";
    fuzzy: boolean;
    matchCount: number;
    matchCountSaturated: boolean;
    filtersApplied: string[];
    sampleSize: number;
    currentRate: {
        min: number | null;
        median: number | null;
        max: number | null;
        n: number;
    };
    escalatedRate: {
        nextYearMedian: number | null;
        secondYearMedian: number | null;
    };
    educationLevelsInSample: string[];
    sampleRows: {
        laborCategory: string | null;
        currentRate: number | null;
        nextYearRate: number | null;
        secondYearRate: number | null;
        educationLevel: string | null;
        minYearsExperience: number | null;
        businessSize: string | null;
        securityClearance: string | boolean | null;
        worksite: string | null;
        sin: string | null;
        schedule: string | null;
        vendor: string | null;
        idvPiid: string | null;
    }[];
}>>;
//# sourceMappingURL=pricing.d.ts.map