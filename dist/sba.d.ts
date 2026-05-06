/**
 * SBA size standards lookup — keyless, embedded.
 *
 * Source: 13 CFR §121.201 (effective 2023-03-17). The official PDF
 * table is at https://www.sba.gov/document/support-table-size-standards.
 *
 * Why embedded: SBA does not publish a stable JSON/CSV API for the
 * size-standards table. The eCFR text contains the data but parsing
 * it reliably is brittle. Embedding a curated JSON keeps the lookup
 * keyless, deterministic, fast, and offline-capable.
 *
 * Coverage: v0.4 covers ~50 of the most-used NAICS codes for federal
 * services / IT / R&D / consulting / construction. Coverage will
 * expand each release. For NAICS not in this file, callers should
 * fall back to ecfr_search(query="size standard NAICS XXXXXX",
 * titleNumber=13).
 *
 * Multi-tier handling: some NAICS (e.g. 541330 Engineering Services)
 * have multiple size standards depending on the specific work scope
 * — military aerospace, marine, etc. all have higher caps. The lookup
 * returns ALL applicable entries; the firm qualifies under ANY one
 * being satisfied.
 */
export type SizeStandardEntry = {
    /** "revenue" = average annual revenue cap (3-year avg). "employee" = average employee count cap. */
    type: "revenue" | "employee";
    /** Revenue cap in millions of USD (when type === "revenue"). */
    thresholdMillionsUsd?: number;
    /** Employee count cap (when type === "employee"). */
    thresholdEmployees?: number;
    /** Sub-industry description. May say "default" when this is the catch-all entry. */
    industry: string;
};
export type SizeStandardLookup = {
    found: true;
    naics: string;
    entries: SizeStandardEntry[];
    citation: string;
    effectiveDate: string;
    notes?: string;
} | {
    found: false;
    naics: string;
    hint: string;
    citation: string;
};
type StandardsFile = {
    $source: string;
    $effectiveDate: string;
    $citationUrl: string;
    $officialTableUrl: string;
    $coverage: string;
    $notes: string;
    standards: Record<string, SizeStandardEntry[]>;
};
/**
 * Inject data directly (used by the Cloudflare Worker build, which has no filesystem).
 * Call once at startup before any lookup; subsequent calls are no-ops if cache is set.
 */
export declare function _injectData(data: StandardsFile): void;
/**
 * Look up the SBA size standard for a given 6-digit NAICS code.
 *
 * Returns:
 *   { found: true, entries: [...], citation, effectiveDate }
 *   { found: false, hint } — caller should fall back to ecfr_search.
 */
export declare function lookupSizeStandard(naicsCode: string): SizeStandardLookup;
/**
 * Format a size-standard entry as a human-readable one-liner.
 * E.g. "$34M revenue (3-year avg)" or "1,000 employees".
 */
export declare function formatSizeStandard(e: SizeStandardEntry): string;
/**
 * High-level qualification check: given (naics, claimedRevenue?,
 * claimedEmployees?), return whether the firm qualifies as small.
 *
 * Returns:
 *   { qualifies: true | false, byEntry: [...] }
 *   or { qualifies: "indeterminate", reason } when neither metric is provided.
 */
export type QualificationCheck = {
    qualifies: true | false | "indeterminate";
    reason?: string;
    /** Per-entry result: which alternative size standard the firm qualifies under (or doesn't). */
    byEntry: Array<{
        industry: string;
        type: "revenue" | "employee";
        threshold: number;
        claimed?: number;
        qualifies: boolean | "indeterminate";
    }>;
    citation: string;
};
export declare function checkQualification(args: {
    naicsCode: string;
    averageAnnualRevenueUsd?: number;
    averageEmployees?: number;
}): QualificationCheck | {
    qualifies: "unknown";
    reason: string;
    citation: string;
};
export {};
//# sourceMappingURL=sba.d.ts.map