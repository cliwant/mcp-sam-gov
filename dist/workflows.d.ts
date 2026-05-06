/**
 * Workflow primitives — composite tools that chain 4-7 underlying
 * tool calls into one structured response.
 *
 * Why: agents can chain individual tools, but orchestration is fragile
 * (LLM picks wrong order, loses context between calls, mishandles
 * partial failures). These primitives encode the canonical chain
 * once + handle partial-failure gracefully.
 *
 * Each primitive returns:
 *   - successful sections fully expanded
 *   - failed sections wrapped in { error } so the agent can decide
 *     whether to retry or surface the gap
 *   - a `summary` string the agent can use as a one-liner
 */
import { SamGovClient } from "./sam-gov/index.js";
import { type ToolError } from "./errors.js";
type SectionResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: ToolError;
};
/**
 * captureBrief — federal capture intelligence, 6 sections, 1 call.
 *
 * Chain:
 *   1. usas_lookup_agency            → canonical agency name + toptier code
 *   2. usas_search_subagency_spending → which office actually buys
 *   3. usas_search_awards            → top recipients (competitive map)
 *   4. usas_search_expiring_contracts → recompete pile next 12 months
 *   5. fed_register_search_documents → recent regulatory activity
 *   6. sam_search_opportunities      → active live opps right now
 *
 * Partial-failure tolerant: if step 5 (Federal Register) fails, the
 * other 5 sections still return useful data with section 5 wrapped
 * in { ok: false, error }.
 */
export declare function captureBrief(args: {
    agency: string;
    naics: string;
    fiscalYear?: number;
    sam: SamGovClient;
}): Promise<{
    inputs: {
        agency: string;
        naics: string;
        fiscalYear: number;
    };
    agency: SectionResult<{
        canonical: string;
        toptierCode: string;
        abbreviation?: string;
        matches: number;
    }>;
    subagencyBreakdown: SectionResult<unknown>;
    topRecipients: SectionResult<unknown>;
    recompetePile: SectionResult<unknown>;
    recentRegulatoryActivity: SectionResult<unknown>;
    activeOpportunities: SectionResult<unknown>;
    summary: string;
}>;
/**
 * recompeteRadar — focused recompete intelligence for a specific NAICS x agency.
 *
 * Lighter than captureBrief — purpose-built for "what's expiring + who holds it".
 *
 * Chain:
 *   1. usas_lookup_agency          → canonical name
 *   2. usas_search_expiring_contracts → contracts ending in N months
 *   3. usas_search_awards (current FY) → who currently dominates
 *   4. fed_register_search_documents → any rule changes that affect recompetes
 */
export declare function recompeteRadar(args: {
    agency: string;
    naics: string;
    monthsUntilExpiry?: number;
    minAwardValueUsd?: number;
}): Promise<{
    inputs: {
        agency: string;
        naics: string;
        monthsUntilExpiry: number;
        minAwardValueUsd?: number;
    };
    agency: SectionResult<{
        canonical: string;
        toptierCode: string;
    }>;
    expiringContracts: SectionResult<unknown>;
    currentTopRecipients: SectionResult<unknown>;
    rulesAffectingRecompete: SectionResult<unknown>;
    summary: string;
}>;
/**
 * vendorProfile — full picture of a federal vendor in 1 call.
 *
 * Chain:
 *   1. usas_autocomplete_recipient → confirm canonical name
 *   2. usas_search_recipients      → parent / child / total spend
 *   3. usas_search_awards_by_recipient → recent line items
 *   4. usas_search_subawards (where they appear as a sub) → teaming network
 */
export declare function vendorProfile(args: {
    recipientName: string;
    fiscalYear?: number;
}): Promise<{
    inputs: {
        recipientName: string;
        fiscalYear: number;
    };
    canonical: SectionResult<{
        canonicalName: string;
        matches: Array<{
            name: string;
            uei?: string;
            duns?: string;
        }>;
    }>;
    recipientHierarchy: SectionResult<unknown>;
    recentAwards: SectionResult<unknown>;
    subawardAppearances: SectionResult<unknown>;
    summary: string;
}>;
export {};
//# sourceMappingURL=workflows.d.ts.map