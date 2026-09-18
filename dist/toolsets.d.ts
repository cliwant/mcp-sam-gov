/**
 * Toolset profiles for MCP_SAM_GOV_TOOLSETS.
 *
 * Each of the 152 registered tools belongs to exactly one named toolset.
 * A user may load a subset by setting the env var (comma- or space-separated,
 * case-insensitive). Unset or "all" → all 152 tools loaded (default; byte-
 * identical to today's behaviour). Unknown names → stderr warning AND a note
 * in the server instructions; if no valid name remains → fall back to all,
 * with a stderr warning and an instructions note.
 *
 * `feedback` and `api_key_status` are always loaded in every profile.
 * Their toolset mapping is "core" (so a one-set-per-tool mapping is maintained),
 * but `resolveToolsets` always injects them into any profile's loaded set.
 * They are listed in the README table as "always loaded".
 *
 * Available toolsets:
 *   core        — SAM.gov discovery/awards/wage determinations/exclusions/integrity,
 *                 Grants.gov, all USAspending, FPDS, GAO, FAR/eCFR/Federal Register,
 *                 SBA, OFAC, GSA labor-rate benchmarks; api_key_status + feedback
 *                 (always loaded in every profile)
 *   sled        — State/local (SLED): OpenGov, Bonfire, ArcGIS, Socrata,
 *                 data.gov/CKAN, Tableau, Open Checkbook, search.gov domains
 *   vetting     — Partner due-diligence: FAC, FDIC, EPA ECHO/TRI,
 *                 CourtListener, nonprofit (IRS 990), Senate LDA lobbying
 *   disclosure  — SEC EDGAR financial filings and XBRL frames
 *   regulatory  — Regulations.gov, Congress.gov, GovInfo
 *   pricing     — GSA per-diem, BLS, Treasury, BEA, Census business-patterns,
 *                 FRED, DOL, USITC HTS
 *   health      — CMS, NPPES, NIH, NSF, ClinicalTrials.gov, openFDA
 *   safety      — NHTSA vehicle recalls, CPSC consumer-product recalls
 *   geo         — Census geocode, FEMA disasters, NWS alerts, CBP border wait
 *                 times, data.gov catalog
 *   cyber       — NVD CVE, CISA KEV, NIST SP 800-53
 */
/** Every valid toolset name. */
export declare const ALL_TOOLSET_NAMES: readonly ["core", "sled", "vetting", "disclosure", "regulatory", "pricing", "health", "safety", "geo", "cyber"];
export type ToolsetName = typeof ALL_TOOLSET_NAMES[number];
/**
 * Short 2–4 word description for each toolset, shown in the server instructions
 * when a profile is active so agents know what other sets exist.
 */
export declare const TOOLSET_HINTS: Readonly<Record<ToolsetName, string>>;
/**
 * Tools that are always loaded regardless of the active profile.
 * Their toolset mapping is "core" (one-set-per-tool), but resolveToolsets
 * injects them into every profile's loaded set.
 */
export declare const ALWAYS_LOADED_TOOLS: ReadonlySet<string>;
/**
 * Canonical mapping: tool name → toolset.
 * Every registered tool must appear exactly once.
 * Tests enforce: union === all 152 tools, no entry for an unregistered name.
 *
 * After moves (review 2026-09-18):
 *   ofac_screen_entity       vetting → core  (govcon users screen SAM exclusions + OFAC together)
 *   gsa_benchmark_labor_rates pricing → core  (proposal pricing; needed in core govcon workflows)
 *   hts_lookup               geo → pricing    (tariff/duty data; groups with cost/rate tools)
 *
 * Resulting counts: core=60, sled=13, vetting=16, disclosure=8, regulatory=9,
 *   pricing=15, health=17, safety=3, geo=8, cyber=3.  Total=152.
 */
export declare const TOOL_TOOLSET_MAP: Readonly<Record<string, ToolsetName>>;
export type ResolveResult = {
    /** Tools that are loaded (by name). */
    loaded: Set<string>;
    /** Valid toolset names that were requested. */
    sets: string[];
    /** Names that were not recognised as valid toolset names. */
    unknown: string[];
    /** True if we fell back to all because no valid name survived. */
    fellBack: boolean;
};
/**
 * Parse MCP_SAM_GOV_TOOLSETS and return the set of tool names to expose.
 *
 * Pure: takes the env value and the full tool-name list as inputs, reads
 * nothing from `process.env`, and has no side-effects. Call sites (server.ts)
 * are responsible for logging any warnings to stderr.
 *
 * `feedback` and `api_key_status` are always injected into `loaded` regardless
 * of the requested profile (ALWAYS_LOADED_TOOLS invariant).
 *
 * @param envValue  The raw value of MCP_SAM_GOV_TOOLSETS (undefined / empty = all).
 * @param toolNames The complete list of registered tool names (from TOOLS).
 */
export declare function resolveToolsets(envValue: string | undefined, toolNames: readonly string[]): ResolveResult;
/**
 * Filter a tool list to only those in the loaded set.
 * Exported so server.ts can call this and tests can import and verify the logic
 * without mutating dist/server.js.
 */
export declare function filterToolsFor<T extends {
    name: string;
}>(tools: readonly T[], loaded: ReadonlySet<string>): T[];
/**
 * Build the structured tool_not_loaded error envelope.
 * Exported so server.ts can call this and tests can import and verify the logic
 * without mutating dist/server.js.
 *
 * @param toolName   The name of the tool that was called but not loaded.
 * @param loadedSets The currently loaded toolset names (from ResolveResult.sets).
 */
export declare function toolNotLoadedEnvelope(toolName: string, loadedSets: readonly string[]): {
    ok: false;
    error: {
        kind: "tool_not_loaded";
        message: string;
        retryable: false;
    };
};
//# sourceMappingURL=toolsets.d.ts.map