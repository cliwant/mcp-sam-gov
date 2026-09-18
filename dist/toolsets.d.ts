/**
 * Toolset profiles for MCP_SAM_GOV_TOOLSETS.
 *
 * Each of the 152 registered tools belongs to exactly one named toolset.
 * A user may load a subset by setting the env var (comma- or space-separated,
 * case-insensitive). Unset or "all" → all 152 tools loaded (default; byte-
 * identical to today's behaviour). Unknown names → stderr warning, ignored;
 * if no valid name remains → fall back to all, with a stderr warning.
 *
 * Available toolsets:
 *   core        — SAM.gov discovery/awards/wage determinations/integrity,
 *                 Grants.gov, all USAspending, FPDS, GAO, FAR/eCFR/Federal
 *                 Register, SBA, api_key_status, feedback
 *   sled        — State/local (SLED): OpenGov, Bonfire, ArcGIS, Socrata,
 *                 data.gov/CKAN, Tableau, Open Checkbook, search.gov domains
 *   vetting     — Partner due-diligence: OFAC, FAC, FDIC, EPA ECHO/TRI,
 *                 CourtListener, nonprofit (IRS 990), Senate LDA lobbying
 *   disclosure  — SEC EDGAR financial filings and XBRL frames
 *   regulatory  — Regulations.gov, Congress.gov, GovInfo
 *   pricing     — GSA, BLS, Treasury, BEA, Census business-patterns, FRED, DOL
 *   health      — CMS, NPPES, NIH, NSF, ClinicalTrials.gov, openFDA
 *   safety      — NHTSA vehicle recalls, CPSC consumer-product recalls
 *   geo         — Census geocode, FEMA disasters, NWS alerts, USITC HTS,
 *                 CBP border wait times, data.gov catalog
 *   cyber       — NVD CVE, CISA KEV, NIST SP 800-53
 */
/** Every valid toolset name. */
export declare const ALL_TOOLSET_NAMES: readonly ["core", "sled", "vetting", "disclosure", "regulatory", "pricing", "health", "safety", "geo", "cyber"];
export type ToolsetName = typeof ALL_TOOLSET_NAMES[number];
/**
 * Canonical mapping: tool name → toolset.
 * Every registered tool must appear exactly once.
 * Tests enforce: union === all 152 tools, no entry for an unregistered name.
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
 * @param envValue  The raw value of MCP_SAM_GOV_TOOLSETS (undefined / empty = all).
 * @param toolNames The complete list of registered tool names (from TOOLS).
 */
export declare function resolveToolsets(envValue: string | undefined, toolNames: readonly string[]): ResolveResult;
//# sourceMappingURL=toolsets.d.ts.map