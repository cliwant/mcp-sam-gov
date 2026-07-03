#!/usr/bin/env node
/**
 * @cliwant/mcp-sam-gov — Model Context Protocol server for SAM.gov
 * + USAspending + Federal Register + eCFR + Grants.gov + GAO + wage/pricing.
 *
 * 45 keyless tools wrapping every public federal-contracting data
 * source that doesn't require an API key. Compatible with:
 *   - Claude Desktop  (claude_desktop_config.json)
 *   - Claude Code     (.mcp.json or `claude mcp add`)
 *   - Codex CLI       (~/.codex/config.toml)
 *   - Cursor          (Cursor settings → MCP)
 *   - Continue        (continue config)
 *   - Gemini CLI      (~/.gemini/settings.json)
 *
 * Transport: stdio JSON-RPC. Auth: zero (pass SAM_GOV_API_KEY env
 * var to unlock higher SAM.gov rate limits + archives older than
 * ~12 months — optional).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SamGovClient } from "./sam-gov/index.js";
import * as usas from "./usaspending.js";
import * as fedreg from "./federal-register.js";
import * as ecfr from "./ecfr.js";
import * as grants from "./grants.js";
import * as pricing from "./pricing.js";
import * as integrity from "./integrity.js";
import * as gao from "./gao.js";
import * as gsaCsv from "./gsa-csv.js";
import { toToolError } from "./errors.js";
import { buildMeta, isMetaBundle, withMeta, } from "./meta.js";
const SERVER_NAME = "mcp-sam-gov";
// Kept in lockstep with package.json / manifest.json / server.json.
const SERVER_VERSION = "0.6.0";
// ─── Tool input schemas (Zod) ────────────────────────────────────
const SamSearchInput = z.object({
    query: z.string().optional().describe("Free-text title query"),
    ncode: z.string().optional().describe("NAICS code, e.g. '541512'"),
    organizationName: z
        .string()
        .optional()
        .describe("Issuing agency canonical name (e.g. 'Department of Veterans Affairs'). Use sam_lookup_organization or usas_lookup_agency to resolve abbreviations."),
    state: z
        .string()
        .optional()
        .describe("Place-of-performance state, 2-letter, e.g. 'MD'"),
    setAside: z.array(z.string()).optional().describe("Set-aside codes: SBA, 8A, HZS, SDVOSBC, WOSB, EDWOSB, VSA, VSS"),
    limit: z.number().min(1).max(50).optional(),
});
const SamGetOpportunityInput = z.object({
    noticeId: z.string().describe("32-char hex notice id"),
});
const SamFetchDescriptionInput = z.object({
    noticeId: z.string().describe("32-char hex notice id"),
});
const SamAttachmentUrlInput = z.object({
    resourceId: z
        .string()
        .describe("Resource id from sam_get_opportunity → resourceLinks (URL-tail hex)"),
});
// USAspending — awards & recipients
const UsasFiltersBase = z.object({
    agency: z.string().optional().describe("Canonical agency name"),
    naics: z.string().optional(),
    fiscalYear: z.number().int().min(2007).optional(),
    setAside: z
        .enum(["SBA", "8A", "HZS", "SDVOSBC", "WOSB", "EDWOSB", "VSA", "VSS"])
        .optional(),
});
const UsasIndividualAwardsInput = UsasFiltersBase.extend({
    limit: z.number().min(1).max(50).optional(),
});
const UsasSubAgencyInput = z.object({
    agency: z.string(),
    fiscalYear: z.number().int().min(2007).optional(),
});
const UsasLookupAgencyInput = z.object({
    searchText: z.string().describe("Agency name or abbreviation"),
});
const UsasRecipientAwardsInput = z.object({
    recipientName: z.string(),
    agency: z.string().optional(),
    naics: z.string().optional(),
    fiscalYear: z.number().int().min(2007).optional(),
    limit: z.number().min(1).max(50).optional(),
});
const UsasSubawardsInput = z.object({
    primeRecipientName: z.string().optional(),
    agency: z.string().optional(),
    naics: z.string().optional(),
    fiscalYear: z.number().int().min(2007).optional(),
    limit: z.number().min(1).max(50).optional(),
});
const UsasExpiringInput = z.object({
    agency: z.string().optional(),
    naics: z.string().optional(),
    fiscalYear: z.number().int().min(2007).optional(),
    monthsUntilExpiry: z.number().min(1).max(36).optional(),
    minAwardValue: z.number().optional(),
    limit: z.number().min(1).max(20).optional(),
});
const UsasRecompetesInput = z.object({
    agency: z
        .string()
        .optional()
        .describe("Canonical awarding toptier agency name (use usas_lookup_agency)"),
    naics: z.string().optional().describe("6-digit NAICS code, e.g. '541512'"),
    pscCodes: z
        .array(z.string())
        .optional()
        .describe("Product/Service Codes to filter on, e.g. ['DA01','R425']"),
    setAside: z
        .enum(["SBA", "8A", "HZS", "SDVOSBC", "WOSB", "EDWOSB", "VSA", "VSS"])
        .optional()
        .describe("USAspending set_aside_type_code (honored server-side)"),
    windowStartDays: z
        .number()
        .int()
        .optional()
        .describe("Lower edge of the recompete window in days from today (default -90 = include contracts that ended up to 90 days ago)."),
    windowEndDays: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Upper edge of the window in days from today (default 548 ≈ 18 months)."),
    minAwardValue: z
        .number()
        .min(0)
        .optional()
        .describe("Minimum Award Amount ($) to include (default 0)."),
    includePotentialEnd: z
        .boolean()
        .optional()
        .describe("Also return the potential (option-inclusive) PoP end date + extendableDays (default false)."),
    actionDateLookbackYears: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("action_date lower bound in years (default 3). Contracts with no recorded action in this span are excluded — this bound makes the End-Date sort reach the window."),
    page: z.number().int().min(1).optional().describe("1-based page (default 1)."),
    pageSize: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Rows per page (default 25, max 100)."),
    scanBudgetPages: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Max 100-row pages to scan before giving up (default 8). If exhausted before the window ends, results are a lower bound and totalAvailable is null."),
});
const UsasAwardDetailInput = z.object({
    generatedInternalId: z
        .string()
        .describe("From spending_by_award results — e.g. CONT_AWD_*"),
});
const UsasAnalyzeIncumbentInput = z.object({
    generatedInternalId: z
        .string()
        .describe("The ONE award to analyze — generatedInternalId from usas_search_individual_awards / usas_search_awards_by_recipient / usas_search_recompetes (e.g. CONT_AWD_*)."),
    includeOtherAwards: z
        .boolean()
        .optional()
        .describe("Also return the incumbent's other awards in the same agency×NAICS via one bounded recipient search (default true)."),
    otherAwardsLimit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Cap on incumbentOtherAwards (default 15, max 50)."),
});
const UsasSpendingOverTimeInput = z.object({
    group: z.enum(["fiscal_year", "quarter", "month"]).optional(),
    agency: z.string().optional(),
    naics: z.string().optional(),
    setAside: z
        .enum(["SBA", "8A", "HZS", "SDVOSBC", "WOSB", "EDWOSB", "VSA", "VSS"])
        .optional(),
});
const UsasCategorySpendingInput = z.object({
    agency: z.string().optional(),
    naics: z.string().optional(),
    fiscalYear: z.number().int().min(2007).optional(),
    limit: z.number().min(1).max(50).optional(),
});
const UsasCfdaInput = z.object({
    agency: z.string().optional(),
    fiscalYear: z.number().int().min(2007).optional(),
    limit: z.number().min(1).max(50).optional(),
});
const UsasAgencySpendingInput = z.object({
    naics: z.string().optional(),
    fiscalYear: z.number().int().min(2007).optional(),
    setAside: z
        .enum(["SBA", "8A", "HZS", "SDVOSBC", "WOSB", "EDWOSB", "VSA", "VSS"])
        .optional(),
    limit: z.number().min(1).max(50).optional(),
});
const UsasAgencyProfileInput = z.object({
    toptierCode: z
        .string()
        .describe("3-4 digit toptier code from usas_lookup_agency (e.g. '036' for VA)"),
});
const UsasAgencyAwardsInput = UsasAgencyProfileInput.extend({
    fiscalYear: z.number().int().min(2007).optional(),
});
const UsasAgencyBudgetInput = UsasAgencyProfileInput.extend({
    fiscalYear: z.number().int().min(2007).optional(),
    limit: z.number().min(1).max(20).optional(),
});
const UsasSearchRecipientsInput = z.object({
    keyword: z.string(),
    recipientLevel: z
        .enum(["P", "C", "R"])
        .optional()
        .describe("P=parent, C=child, R=recipient"),
    limit: z.number().min(1).max(50).optional(),
});
const UsasGetRecipientInput = z.object({
    recipientId: z.string().describe("From usas_search_recipients — e.g. 'ed02855e-...-P'"),
});
const UsasAutocompleteInput = z.object({
    searchText: z.string(),
    limit: z.number().min(1).max(20).optional(),
});
const UsasNaicsHierarchyInput = z.object({
    naicsFilter: z
        .string()
        .optional()
        .describe("Filter to a specific NAICS code subtree, e.g. '541512'"),
});
const UsasGlossaryInput = z.object({
    search: z.string().optional(),
    limit: z.number().min(1).max(50).optional(),
});
const UsasListAgenciesInput = z.object({
    limit: z.number().min(1).max(150).optional(),
});
// Federal Register
const FedRegSearchInput = z.object({
    query: z.string().optional(),
    agencySlugs: z
        .array(z.string())
        .optional()
        .describe("Federal Register agency slugs, e.g. ['veterans-affairs-department']. Use fed_register_list_agencies to resolve."),
    type: z
        .enum(["RULE", "PRORULE", "NOTICE", "PRESDOCU"])
        .optional()
        .describe("Document type"),
    publicationDateFrom: z.string().optional().describe("YYYY-MM-DD"),
    publicationDateTo: z.string().optional().describe("YYYY-MM-DD"),
    effectiveDateFrom: z.string().optional().describe("YYYY-MM-DD"),
    perPage: z.number().min(1).max(100).optional(),
});
const FedRegGetDocInput = z.object({
    documentNumber: z
        .string()
        .describe("Federal Register document number, e.g. '2026-08333'"),
});
const FedRegListAgenciesInput = z.object({
    perPage: z.number().min(1).max(500).optional(),
});
// eCFR
const EcfrSearchInput = z.object({
    query: z.string(),
    titleNumber: z
        .number()
        .optional()
        .describe("CFR title (1-50). e.g. 48 = FAR (Federal Acquisition Regulation), 2 = Federal financial assistance."),
    perPage: z.number().min(1).max(20).optional(),
});
const EcfrListTitlesInput = z.object({});
// Grants.gov
const GrantsSearchInput = z.object({
    keyword: z.string().optional(),
    cfda: z.string().optional().describe("CFDA program number, e.g. '10.500'"),
    agency: z
        .string()
        .optional()
        .describe("Grants.gov agency code, e.g. 'DHS-FEMA'"),
    oppNum: z.string().optional().describe("Specific opportunity number"),
    oppStatuses: z
        .array(z.enum(["forecasted", "posted", "closed", "archived"]))
        .optional()
        .describe("Defaults to forecasted+posted"),
    rows: z.number().min(1).max(50).optional(),
});
const GrantsGetInput = z.object({
    opportunityId: z.string().describe("Grants.gov opportunity id (numeric string)"),
});
// SAM.gov organization lookup (federal hierarchy)
const SamLookupOrgInput = z.object({
    organizationId: z.string().describe("SAM.gov federal-organization id (numeric)"),
});
// Pricing tier — wage determinations + GSA CALC labor-rate benchmarks
const WageSearchInput = z.object({
    coverage: z
        .enum(["sca", "dba"])
        .describe("Which wage-determination law: 'sca' (Service Contract Act — services) or 'dba' (Davis-Bacon Act — construction). 'dba' is normalized to the API's 'dbra' index."),
    state: z
        .string()
        .optional()
        .describe("2-letter USPS state code (e.g. 'VA'), applied SERVER-SIDE. A full name is applied client-side instead."),
    county: z
        .string()
        .optional()
        .describe("County name (substring match), applied CLIENT-SIDE over the fetched page only (the API has no county filter)."),
    query: z
        .string()
        .optional()
        .describe("Matches the WD NUMBER/TITLE only — NOT occupation/job title (q=guard returns 0)."),
    activeOnly: z.boolean().optional().describe("Only currently-active WDs (default true)."),
    standardOnly: z
        .boolean()
        .optional()
        .describe("Only standard (non-non-standard) WDs (default true)."),
    limit: z.number().min(1).max(50).optional().describe("Page size (default 20, max 50)."),
    page: z.number().min(0).optional().describe("0-based page index (default 0)."),
});
const WageRatesInput = z.object({
    reference: z
        .string()
        .describe("fullReferenceNumber of the wage determination (e.g. '2015-4093' for SCA, 'IA20260028' for DBA) from sam_search_wage_determinations."),
    revision: z
        .number()
        .optional()
        .describe("Revision number. Omit to resolve the latest ACTIVE revision via /history."),
    coverage: z
        .enum(["sca", "dba"])
        .optional()
        .describe("Optional hint (sca|dba) to disambiguate the parser; inferred otherwise."),
    format: z
        .enum(["parsed", "raw", "both"])
        .optional()
        .describe("'parsed' (structured rates, default), 'raw' (the full document text), or 'both'. Use 'raw'/'both' when parseConfidence is low."),
});
const BenchmarkLaborInput = z.object({
    laborCategory: z
        .string()
        .describe("Labor category to benchmark (e.g. 'Program Manager', 'Software Engineer'). Matched exactly against CALC's labor_category."),
    businessSize: z
        .enum(["S", "O"])
        .optional()
        .describe("Business size filter: 'S' (small) or 'O' (other-than-small)."),
    educationLevel: z
        .string()
        .optional()
        .describe("Education filter — use CALC's SHORT CODES (e.g. 'HS','AA','BA','MA','PHD'); the displayed education_level field may show full words."),
    minYearsExperience: z
        .number()
        .optional()
        .describe("Minimum years of experience filter."),
    experienceRange: z
        .string()
        .optional()
        .describe("Experience range as 'min,max' (e.g. '5,10')."),
    sin: z.string().optional().describe("Schedule SIN filter (e.g. '54151S')."),
    priceRange: z
        .string()
        .optional()
        .describe("Ceiling-price range as 'min,max' (e.g. '50,150')."),
    maxSamplePages: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe("How many 20-row pages to sample for the distribution (default 3, max 10)."),
});
// Integrity / teaming
const CheckExclusionsInput = z.object({
    query: z
        .string()
        .optional()
        .describe("Firm or individual name to screen (drives the server-side exclusions text search). Provide at least one of query/uei/cage."),
    uei: z
        .string()
        .optional()
        .describe("SAM UEI to match. Used as the text query when it is the sole selector; post-filtered against results when combined with a name query."),
    cage: z
        .string()
        .optional()
        .describe("CAGE code to match (post-filtered against results, or used as the text query when sole)."),
    activeOnly: z
        .boolean()
        .optional()
        .describe("Only currently-active exclusions (default true). false includes terminated exclusions."),
    classification: z
        .enum(["Firm", "Individual", "Special Entity Designation", "any"])
        .optional()
        .describe("Filter by excluded-party classification (default 'any')."),
    page: z.number().min(0).optional().describe("0-based page index (default 0)."),
    size: z.number().min(1).max(100).optional().describe("Page size (default 25, max 100)."),
});
const TeamingPartnersInput = z.object({
    // ENUM-VALIDATED: a bogus recipient_type_names value is SILENTLY accepted by
    // USAspending (HTTP 200, 0 results), so this enum is the guardrail — only the
    // spellings LIVE-VERIFIED to narrow a populated NAICS are accepted.
    cert: z
        .enum([
        "small_business",
        "8a_program_participant",
        "woman_owned_business",
        "women_owned_small_business",
        "economically_disadvantaged_women_owned_small_business",
        "service_disabled_veteran_owned_business",
        "veteran_owned_business",
        "historically_underutilized_business_firm",
    ])
        .describe("Socioeconomic certification (award-derived, NOT the SBA registry of record). One of: small_business, 8a_program_participant, woman_owned_business, women_owned_small_business, economically_disadvantaged_women_owned_small_business, service_disabled_veteran_owned_business, veteran_owned_business, historically_underutilized_business_firm (HUBZone)."),
    naics: z.string().optional().describe("NAICS code to scope the search (e.g. '541512')."),
    agency: z
        .string()
        .optional()
        .describe("Awarding agency canonical toptier name (e.g. 'Department of Veterans Affairs'). Use usas_lookup_agency to resolve abbreviations."),
    subagency: z
        .string()
        .optional()
        .describe("Awarding sub-agency name. Requires `agency` to also be set (a subagency alone is dropped)."),
    lookbackYears: z
        .number()
        .min(1)
        .max(20)
        .optional()
        .describe("Action-date lookback window in years (default 3)."),
    excludeDebarred: z
        .boolean()
        .optional()
        .describe("Screen the top-ranked candidates via sam_check_exclusions and drop active exclusions (default true; bounded + disclosed in _meta)."),
    minAwards: z
        .number()
        .min(1)
        .optional()
        .describe("Minimum scanned award count for a firm to be listed (default 1)."),
    limit: z.number().min(1).max(50).optional().describe("Candidates per page (default 25, max 50)."),
    page: z.number().min(1).optional().describe("1-based page index (default 1)."),
    screenCap: z
        .number()
        .min(1)
        .max(25)
        .optional()
        .describe("Max candidates to exclusion-screen per page (default 10, max 25)."),
    scanPages: z
        .number()
        .min(1)
        .max(10)
        .optional()
        .describe("Award-value-sorted pages (100 rows each) to scan before aggregating by recipient (default 4, max 10)."),
});
// GAO bid-protest lookup (keyless RSS + decision-page parse)
const GaoProtestInput = z.object({
    agency: z
        .string()
        .optional()
        .describe("Client-side substring filter on the recent-protest feed (matched against the decision title + description). NOTE: filters the RECENT feed window only — not a historical agency search."),
    protester: z
        .string()
        .optional()
        .describe("Client-side substring filter on the protester name (feed title/description)."),
    solicitationNumber: z
        .string()
        .optional()
        .describe("Client-side substring filter on the solicitation number (matched in the feed description)."),
    outcome: z
        .enum(["sustained", "denied", "dismissed", "withdrawn", "any"])
        .optional()
        .describe("Filter by protest disposition (default 'any'). Determined from each decision page, so it applies only when enrich is true."),
    bNumber: z
        .string()
        .optional()
        .describe("Fetch ONE specific decision directly by GAO B-number (e.g. 'B-424377' or 'b-424249.2'), bypassing the feed. Use to pull a decision that has aged out of the recent feed window."),
    limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .describe("Max decisions to return (default 20, max 50). The feed itself carries ~25 recent legal products."),
    enrich: z
        .boolean()
        .optional()
        .describe("Fetch each decision's page to fill agency/outcome/solicitation/PDF (default true). Set false for a fast feed-only list (those fields will be null)."),
});
// GSA daily-CSV keyless backbone — batch page-completing enrichment
const SamLookupNoticeFieldsInput = z.object({
    noticeIds: z
        .array(z.string())
        .min(1)
        .max(100)
        .describe("1..100 32-char hex noticeIds (the ids returned by sam_search_opportunities) to enrich in ONE batch. Completes a whole search page's null naics/setAside/place-of-performance/deadline/type from the cached GSA daily CSV. OFF BY DEFAULT — enable by setting SAM_GOV_CSV_CACHE (a cache dir) or SAM_GOV_ENABLE_CSV=1."),
});
const TOOLS = [
    // ━━━ SAM.gov (6) ━━━
    {
        name: "sam_search_opportunities",
        description: "Search SAM.gov federal contracting opportunities (keyless HAL). Returns up to 50 active notices with title, agency, NAICS, noticeId. Use for discovery — narrow with NAICS / agency / set-aside / state.",
        inputSchema: SamSearchInput,
    },
    {
        name: "sam_get_opportunity",
        description: "Fetch full detail for a single SAM.gov notice by 32-char hex noticeId. Returns title, agency, solicitation #, POCs, response deadline, attachments (with download URLs), inline description body. Call BEFORE drafting bid/no-bid or compliance work.",
        inputSchema: SamGetOpportunityInput,
    },
    {
        name: "sam_fetch_description",
        description: "Return the full description / RFP body text for a notice as plain text. Useful when sam_get_opportunity returned a description URL instead of inline body, or for an LLM-friendly text dump.",
        inputSchema: SamFetchDescriptionInput,
    },
    {
        name: "sam_attachment_url",
        description: "Build the public download URL for an attachment resourceId. The URL returns a 303 redirect to a signed S3 URL — fetch with redirect:'follow' to get the file bytes.",
        inputSchema: SamAttachmentUrlInput,
    },
    {
        name: "sam_lookup_organization",
        description: "Resolve a SAM.gov federal-organization id to its canonical fullParentPathName (e.g. 'VETERANS AFFAIRS, DEPARTMENT OF.VETERANS AFFAIRS, DEPARTMENT OF.245-NETWORK CONTRACT OFFICE 5'). Use when sam_get_opportunity returned only an organizationId.",
        inputSchema: SamLookupOrgInput,
    },
    {
        name: "sam_lookup_notice_fields",
        description: "BATCH-complete a sam_search_opportunities page in ONE call from the GSA daily bulk CSV (keyless). The keyless HAL list endpoint NULLS each result's naics/setAside/place-of-performance/responseDeadline/type; this tool returns those fields for 1..100 noticeIds at once (naicsCode, setAside + setAsideCode, popState/popCity/popZip/popCountry, responseDeadline, type, active, title) from a cached on-disk CSV index, instead of one sam_get_opportunity detail call per notice. OFF BY DEFAULT (no forced 226 MB download): enable by setting SAM_GOV_CSV_CACHE (a cache dir) or SAM_GOV_ENABLE_CSV=1 — when disabled the tool returns data.enabled:false + a structured 'how to enable' note (never fake data, no network). HONEST: _meta carries the CSV last-modified + index build time (freshness), a noticeId absent from the current snapshot returns found:false + nulls with an explicit 'not in current CSV snapshot' disclosure (never faked), a cold first call discloses 'index warming', and a download/parse failure is a structured retryable error (never a silent empty). setAsideCode (e.g. 'SBA') matches sam_get_opportunity's setAside; the snapshot can lag live by up to ~24h — confirm real-time-critical fields with sam_get_opportunity.",
        inputSchema: SamLookupNoticeFieldsInput,
    },
    // ━━━ USAspending — Awards & Recipients (10) ━━━
    {
        name: "usas_search_awards",
        description: "Aggregate share-of-wallet on USAspending. Given an agency × NAICS × fiscal year, returns top recipients by total $ + count. Use for competitive landscape ('who wins at VA in 541512?').",
        inputSchema: UsasFiltersBase,
    },
    {
        name: "usas_search_individual_awards",
        description: "Line-item federal contracts on USAspending. Returns specific awards (recipient + $ + sub-agency + state + description). Use AFTER usas_search_awards when the user wants 'show me the actual contracts'. Each result includes a generatedInternalId for usas_get_award_detail follow-ups.",
        inputSchema: UsasIndividualAwardsInput,
    },
    {
        name: "usas_search_subagency_spending",
        description: "Break down a parent agency's spending by sub-agency / office. Surfaces which office holds the budget (e.g. VA OI&T vs VHA, DoD vs Army vs DISA).",
        inputSchema: UsasSubAgencyInput,
    },
    {
        name: "usas_lookup_agency",
        description: "Resolve a user-friendly agency reference ('VA', 'Veterans Affairs', 'DHS') to USAspending's canonical toptier name + 4-digit code. ALWAYS call this FIRST if the user uses an abbreviation — other USAspending tools require the canonical name.",
        inputSchema: UsasLookupAgencyInput,
    },
    {
        name: "usas_search_awards_by_recipient",
        description: "Pull every contract a specific recipient has won within an agency × NAICS slice. Use when the user asks 'show me Booz Allen wins at VA last year' — returns line items + naicsCode + description, not aggregates.",
        inputSchema: UsasRecipientAwardsInput,
    },
    {
        name: "usas_search_subawards",
        description: "Enumerate subcontracts on prime awards. Use for 'who teams with Leidos at DISA' or 'show small-business subs on Accenture's DHS contracts' — surfaces the prime/sub network for teaming-map artifacts.",
        inputSchema: UsasSubawardsInput,
    },
    {
        name: "usas_search_recompetes",
        description: "Recompete radar — federal contracts whose CURRENT period of performance ends inside a window around today (default -90d .. +18mo), sorted soonest-first. Use for 'what VA 541512 contracts are up for recompete in the next 18 months'. Reads the current PoP end date directly from spending_by_award (no per-award enrichment), counts (never drops) rows with missing end dates, and flags in _meta when the scan budget truncates the window (totalAvailable becomes null). Filter by agency/naics/pscCodes/setAside/minAwardValue; set includePotentialEnd for option-inclusive end dates. Public signals only — no CPARS/protest/option-intent, no composite vulnerability score.",
        inputSchema: UsasRecompetesInput,
    },
    {
        name: "usas_search_expiring_contracts",
        description: "DEPRECATED — use usas_search_recompetes. Thin backward-compatible alias: finds contracts at agency × NAICS expiring within N months and returns the legacy { contracts, searchedCount } shape. New callers should use usas_search_recompetes for the full window/pagination controls and truthful completeness metadata.",
        inputSchema: UsasExpiringInput,
    },
    {
        name: "usas_get_award_detail",
        description: "Fetch full detail for a single award by generatedInternalId (from usas_search_individual_awards). Returns period_of_performance (start/end/potential_end), base_and_all_options, set-aside type, competition extent, number_of_offers — the per-award fields the search endpoint omits.",
        inputSchema: UsasAwardDetailInput,
    },
    {
        name: "usas_analyze_incumbent",
        description: "Per-award incumbent + PUBLIC recompete-pressure analysis for ONE award (generatedInternalId). Assembles the incumbent identity, the vehicle/IDV linkage, and individual PUBLIC pressure SIGNALS — obligated-vs-ceiling consumption (pctConsumed), modification count (lower-bounded), competition extent + number of offers, set-aside, days to the current PoP end, and option-extendable days — plus, optionally, the incumbent's other awards in the same agency×NAICS. Bounded & keyless: at most 3 upstream calls (detail + 1 transactions page + 1 recipient search), no per-record fan-out. Emits pressureHints ('single_offer', 'ceiling_nearly_exhausted', 'hard_stop_no_options') as HINTS, NEVER a composite vulnerability score — CPARS/past-performance, protest history, and option-exercise intent are not public (declared in _meta.fieldsUnavailable).",
        inputSchema: UsasAnalyzeIncumbentInput,
    },
    // ━━━ USAspending — Aggregate Analysis (6) ━━━
    {
        name: "usas_spending_over_time",
        description: "Time-series aggregation of federal spending. Group by fiscal_year / quarter / month, filter by agency / NAICS / set-aside. Use for 'how has VA 541512 spending trended over the past 5 years' — returns yearly/quarterly/monthly $ rollups.",
        inputSchema: UsasSpendingOverTimeInput,
    },
    {
        name: "usas_search_psc_spending",
        description: "Spending broken down by Product Service Code (PSC). Use for 'what PSC categories see the most $ at DoD' — surfaces market structure beyond NAICS (e.g. PSC R425 = engineering support services).",
        inputSchema: UsasCategorySpendingInput,
    },
    {
        name: "usas_search_state_spending",
        description: "Spending broken down by state / territory. Use for 'where is the most federal $ flowing for NAICS 541512' — answers like 'VA $128B, MD $66B, DC $58B'.",
        inputSchema: UsasCategorySpendingInput,
    },
    {
        name: "usas_search_cfda_spending",
        description: "Spending broken down by CFDA grant program code. Use for grant analysis — 'top federal grant programs by $'. Note: CFDA is grants (award_type 02-05), not contracts. Use usas_search_psc_spending for contract market analysis.",
        inputSchema: UsasCfdaInput,
    },
    {
        name: "usas_search_federal_account_spending",
        description: "Spending broken down by federal account / Treasury Account Symbol (TAS). Use to map money to the actual budget line item (e.g. '036-0167 = Information Technology Systems, VA').",
        inputSchema: UsasCategorySpendingInput,
    },
    {
        name: "usas_search_agency_spending",
        description: "Spending broken down by awarding agency. Use for 'which agencies spend the most on NAICS 541512' — top buyers by $.",
        inputSchema: UsasAgencySpendingInput,
    },
    // ━━━ USAspending — Agency Profile (3) ━━━
    {
        name: "usas_get_agency_profile",
        description: "Get full agency profile by toptier code (3-4 digits, from usas_lookup_agency). Returns mission, abbreviation, website, subtier_agency_count, congressional_justification_url.",
        inputSchema: UsasAgencyProfileInput,
    },
    {
        name: "usas_get_agency_awards_summary",
        description: "High-level award activity for a fiscal year — transaction_count + obligations + latest_action_date. Snapshot of agency volume.",
        inputSchema: UsasAgencyAwardsInput,
    },
    {
        name: "usas_get_agency_budget_function",
        description: "Budget function breakdown for an agency × fiscal year. Returns the agency's spending by program area (e.g. VA: 'Income security for veterans' $204B, 'Hospital and medical care for veterans' $126B).",
        inputSchema: UsasAgencyBudgetInput,
    },
    // ━━━ USAspending — Recipient Profile (2) ━━━
    {
        name: "usas_search_recipients",
        description: "Search USAspending recipient list with parent/child/recipient hierarchy. Returns recipients with id, duns, uei, level (P=parent, C=child, R=recipient), total_amount. Use for 'find the recipient_id for Booz Allen' before usas_get_recipient_profile.",
        inputSchema: UsasSearchRecipientsInput,
    },
    {
        name: "usas_get_recipient_profile",
        description: "Full recipient detail by recipient_id (from usas_search_recipients). Returns alternate_names (M&A history), DUNS, UEI, parent linkage, business_types, location, total_amount, total_transactions.",
        inputSchema: UsasGetRecipientInput,
    },
    // ━━━ USAspending — Reference / Autocomplete (4) ━━━
    {
        name: "usas_autocomplete_naics",
        description: "Autocomplete NAICS codes by free-text. ANTI-HALLUCINATION GUARD — call this when the user mentions a NAICS theme but no specific code (e.g. 'computer systems design' → 541512). Avoids inventing NAICS codes.",
        inputSchema: UsasAutocompleteInput,
    },
    {
        name: "usas_autocomplete_recipient",
        description: "Autocomplete recipient names. ANTI-HALLUCINATION — confirm a recipient's exact USAspending-canonical legal name before searching by name. Returns up to 10 fuzzy matches with UEI/DUNS where available.",
        inputSchema: UsasAutocompleteInput,
    },
    {
        name: "usas_naics_hierarchy",
        description: "Navigate the NAICS hierarchy (2-digit → 4-digit → 6-digit). Returns parent/child relationships + active-contract count per code. Use to explore market scope ('what's under NAICS 541' = 'Professional, Scientific, and Technical Services').",
        inputSchema: UsasNaicsHierarchyInput,
    },
    {
        name: "usas_glossary",
        description: "USAspending glossary of 151 federal-spending terms. Use to confirm terminology ('what's a TAS?', 'what's an obligation vs outlay?') before answering compliance/budget questions.",
        inputSchema: UsasGlossaryInput,
    },
    {
        name: "usas_list_toptier_agencies",
        description: "List all toptier federal agencies with toptier_code, abbreviation, slug, current-FY obligations. Use for 'show me every cabinet department + their FY26 spending' or to find a toptier_code for usas_get_agency_*.",
        inputSchema: UsasListAgenciesInput,
    },
    // ━━━ Federal Register (3) ━━━
    {
        name: "fed_register_search_documents",
        description: "Search Federal Register documents (proposed rules, final rules, notices, presidential documents) by query / agency / type / date range. Use for regulatory-context queries ('what new VA cybersecurity rules came out this quarter?').",
        inputSchema: FedRegSearchInput,
    },
    {
        name: "fed_register_get_document",
        description: "Fetch full detail for a Federal Register document by number. Returns title, abstract, citation, publication_date, effective_on, raw_text_url (for the full body), CFR references — everything needed to ground a regulation citation.",
        inputSchema: FedRegGetDocInput,
    },
    {
        name: "fed_register_list_agencies",
        description: "List all Federal Register agencies with slugs (needed for fed_register_search_documents). Use to resolve 'what's the FedReg slug for Veterans Affairs?'",
        inputSchema: FedRegListAgenciesInput,
    },
    // ━━━ eCFR (2) ━━━
    {
        name: "ecfr_search",
        description: "Full-text search across the entire CFR (Code of Federal Regulations). Use for compliance questions — pass titleNumber=48 for FAR (Federal Acquisition Regulation), titleNumber=2 for federal financial assistance, etc. Returns excerpt + section path + ecfrUrl.",
        inputSchema: EcfrSearchInput,
    },
    {
        name: "ecfr_list_titles",
        description: "List all 50 CFR titles with name + last_amended_on date. Use to discover what's in each title (Title 48 = FAR, Title 32 = National Defense, Title 14 = Aeronautics, etc.).",
        inputSchema: EcfrListTitlesInput,
    },
    // ━━━ Grants.gov (2) ━━━
    {
        name: "grants_search",
        description: "Search Grants.gov federal grant opportunities (financial assistance, distinct from contracts on SAM.gov). Filter by keyword / CFDA / agency / opportunity number. Default status = forecasted + posted.",
        inputSchema: GrantsSearchInput,
    },
    {
        name: "grants_get_opportunity",
        description: "Fetch full detail for a single grant opportunity by id. Returns description, agency, posting/response/archive dates, award_ceiling, award_floor, estimated_funding, expected_number_of_awards, applicant_types, funding_instruments, CFDA programs.",
        inputSchema: GrantsGetInput,
    },
    // ━━━ Pricing / Wage (3) ━━━
    {
        name: "sam_search_wage_determinations",
        description: "Find the Service Contract Act (SCA) or Davis-Bacon (DBA) wage determination(s) governing a locality (keyless SAM SGS). Filter by coverage (sca|dba), state (2-letter, server-side), county (client-side), or WD number/title. Returns the structured WD list; follow with sam_get_wage_rates to read the rate table. NOTE: `query` matches WD number/title only, NOT occupation.",
        inputSchema: WageSearchInput,
    },
    {
        name: "sam_get_wage_rates",
        description: "Return the prevailing-wage + fringe/H&W rate table for a specific wage determination, PARSED from its plain-text document (SAM exposes no structured rate JSON), plus the Executive-Order minimum-wage floor. Distinguishes SCA (WD-wide Health & Welfare) vs DBA (per-craft fringe). Always returns parseConfidence and supports format:'parsed'|'raw'|'both' so you can read the raw text when parsing is low-confidence. Resolves the latest active revision via /history when `revision` is omitted.",
        inputSchema: WageRatesInput,
    },
    {
        name: "gsa_benchmark_labor_rates",
        description: "GSA CALC awarded ceiling-rate market band for a labor category (keyless). Returns a DISTRIBUTION (currentRate min/median/max + escalated medians) over a fetched sample, NOT a single price. CALC rates are CEILING/catalog and FULLY BURDENED (do not re-add wrap); the match count SATURATES at 10000 for broad queries (totalAvailable null then). Filter by businessSize/educationLevel(code)/experience/sin/priceRange to narrow.",
        inputSchema: BenchmarkLaborInput,
    },
    // ━━━ Integrity / Teaming (2) ━━━
    {
        name: "sam_check_exclusions",
        description: "Keyless SAM debarment/exclusion screening. Screen a firm or individual by name (query) and/or UEI/CAGE against the SAM exclusions index (FAPIIS). Returns excluded (true iff ≥1 ACTIVE matching record), matchCount, and per-record { name, classification, uei, cage, excludingAgency, exclusionType, exclusionProgram, isActive, activation/terminationDate, samFapiisUrl }. CRITICAL: an EMPTY result means 'no matching exclusion under these terms' — it is NOT proof of general responsibility (stated in _meta.notes). A name match is not identity-proof; verify the UEI/CAGE + dates against the FAPIIS record. Requires at least one of query/uei/cage.",
        inputSchema: CheckExclusionsInput,
    },
    {
        name: "usas_search_teaming_partners",
        description: "Small-business teaming-partner discovery by socioeconomic certification + NAICS + agency award history (keyless USAspending proxy), integrity-screened. Given a cert (enum-validated), optional naics/agency/subagency, and a lookback window, aggregates federal awardees by recipient and returns candidates ranked by agencyObligated with agencyAwardCount, mostRecentAwardDate, and sampleAwards; optionally screens the top candidates via sam_check_exclusions and drops active exclusions (excludeDebarred, default true). HONESTY: cert is AWARD-DERIVED (recorded on the firm's federal awards), NOT the SBA certification of record (which needs a keyed SAM Entity call) — verify active certification in SAM/SBS before teaming (stated in _meta). A bogus cert is rejected as invalid_input (the endpoint would silently return 0).",
        inputSchema: TeamingPartnersInput,
    },
    // ━━━ GAO — Bid Protests (1) ━━━
    {
        name: "gao_protest_lookup",
        description: "Recent GAO (Comptroller General) bid-protest decisions from the public Legal-Products RSS feed, enriched from each decision page (protester, contracting agency, decision date, outcome sustained/denied/dismissed/withdrawn, solicitation #, decision PDF). Filter client-side by agency/protester/solicitation/outcome, or pull one decision directly by bNumber. HONEST SCOPE: keyless covers only the RECENT feed window (~25 items) — GAO's faceted historical protest search (all years, by protester/agency/outcome/date) is WAF-blocked to bots and available only via a paid third-party API, so results are ALWAYS marked complete:false and are NOT the full protest history (see the accessNote).",
        inputSchema: GaoProtestInput,
    },
];
// ─── Server bootstrap ────────────────────────────────────────────
async function main() {
    const sam = new SamGovClient({
        apiKey: process.env.SAM_GOV_API_KEY?.trim() || undefined,
        logger: {
            warn: (msg, err) => {
                console.error(msg, err ?? "");
            },
        },
    });
    const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        return {
            tools: TOOLS.map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: zodToJsonSchema(t.inputSchema),
            })),
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args } = req.params;
        try {
            const raw = await runTool(name, args ?? {}, sam);
            // A handler may return either its raw domain object OR a MetaBundle
            // (via withMeta) carrying a partial `_meta`. Unwrap to `data` + finalize
            // the `_meta` sibling. `data` is byte-identical either way.
            const data = isMetaBundle(raw) ? raw.data : raw;
            const _meta = isMetaBundle(raw)
                ? buildMeta(raw.meta)
                : synthesizeDefaultMeta(name, sam);
            // Structured success envelope. Calling agent can rely on
            // `ok: true` to know the payload is in `data`, and read `_meta`
            // for completeness / provenance (see meta.ts).
            const envelope = { ok: true, data, _meta };
            return {
                content: [
                    { type: "text", text: JSON.stringify(envelope, null, 2) },
                ],
            };
        }
        catch (err) {
            // Structured error envelope. The agent can read `error.kind`
            // and `error.retryable` to decide what to do next. A Zod input-validation
            // failure (e.g. a value outside an enum like an unrecognized socioeconomic
            // cert) is a caller error → surface it as a NON-retryable `invalid_input`
            // with the field-level issues, never a generic `unknown`.
            const error = err instanceof z.ZodError
                ? {
                    kind: "invalid_input",
                    message: `Invalid input for ${name}: ${err.issues
                        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                        .join("; ")}`,
                    retryable: false,
                    upstreamEndpoint: name,
                }
                : toToolError(err, name);
            const envelope = { ok: false, error };
            return {
                content: [
                    { type: "text", text: JSON.stringify(envelope, null, 2) },
                ],
                isError: true,
            };
        }
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[mcp-sam-gov] v${SERVER_VERSION} listening on stdio (${TOOLS.length} tools).`);
}
/**
 * Minimal truthful `_meta` for handlers that don't attach their own.
 *
 * Defaults to `complete:true, truncated:false` — correct for the single-record
 * and known-complete tools (detail lookups, reference tables). List/search and
 * two-phase tools that can be capped or drop filters should instead return
 * `withMeta(...)` with the real completeness signals; those are migrated
 * incrementally (A1 landed first). The source label is keyless-aware for SAM
 * tools so provenance is honest from day one.
 */
function synthesizeDefaultMeta(toolName, sam) {
    // The wage tools carry a `sam_` prefix but hit the keyless SGS/WDOL
    // subsystems (never the keyed opportunities API), so they are always keyless.
    const isWage = toolName === "sam_search_wage_determinations" ||
        toolName === "sam_get_wage_rates";
    // sam_lookup_notice_fields also carries a `sam_` prefix but is served from the
    // keyless GSA daily CSV (never the keyed opportunities API) — always keyless.
    const isGsaCsv = toolName === "sam_lookup_notice_fields";
    const isSam = toolName.startsWith("sam_") && !isWage && !isGsaCsv;
    const keylessMode = isSam ? sam.isKeyless : true;
    let source;
    if (isWage) {
        source = "sam.gov wage-determinations (keyless)";
    }
    else if (isGsaCsv) {
        source = "gsa.gov daily bulk CSV (keyless)";
    }
    else if (toolName.startsWith("gsa_")) {
        source = "api.gsa.gov CALC v3 (keyless)";
    }
    else if (isSam) {
        source = sam.isKeyless ? "sam.gov (keyless)" : "api.sam.gov (keyed)";
    }
    else if (toolName.startsWith("usas_")) {
        source = "usaspending.gov/api/v2";
    }
    else if (toolName.startsWith("fed_register_")) {
        source = "federalregister.gov/api/v1";
    }
    else if (toolName.startsWith("ecfr_")) {
        source = "ecfr.gov/api";
    }
    else if (toolName.startsWith("grants_")) {
        source = "grants.gov/api";
    }
    else if (toolName.startsWith("gao_")) {
        source = "gao.gov Legal Products RSS + decision pages (keyless)";
    }
    else {
        source = "unknown";
    }
    return buildMeta({ source, keylessMode, complete: true, truncated: false });
}
async function runTool(name, args, sam) {
    switch (name) {
        // SAM.gov
        case "sam_search_opportunities": {
            const input = SamSearchInput.parse(args);
            const r = await sam.searchOpportunities({
                ...input,
                setAside: input.setAside,
            });
            const data = {
                totalRecords: r.totalRecords,
                returned: r.opportunitiesData.length,
                opportunities: r.opportunitiesData.map((o) => ({
                    noticeId: o.noticeId,
                    title: o.title,
                    agency: o.fullParentPathName,
                    solicitationNumber: o.solicitationNumber,
                    responseDeadline: o.responseDeadLine,
                    naics: o.naicsCode,
                    setAside: o.typeOfSetAside,
                    uiLink: o.uiLink,
                })),
            };
            // A1 — filter honesty. Contrary to the earlier assumption, the keyless
            // HAL list endpoint DOES honor the structured facets server-side —
            // VERIFIED LIVE (2026-07): `naics`, `set_aside`, `pop_state` and `q` each
            // narrow the result set AND every returned notice's detail matches the
            // filter (the earlier "ignores facets" reading tested the WRONG param
            // name `ncode`, which is silently dropped; the real param is `naics`).
            // The one facet with no keyless param is organization-name (ignored).
            // Separately, the list PAYLOAD still omits each notice's
            // naics/set-aside/place-of-performance VALUES (null even when the filter
            // applied), so filtering is real but reading those field values needs
            // sam_get_opportunity. See spec §1.2 A1, §2.4.
            if (sam.isKeyless) {
                // NOTE: these truthiness checks must mirror EXACTLY the conditions under
                // which client.searchPublic() actually appends each param (it uses
                // `if (filters.x)` / `filters.setAside?.length`). Using `!== undefined`
                // here would over-report: an empty-string facet is not sent by the
                // client, so it must not appear in filtersApplied.
                const filtersApplied = [];
                if (input.query)
                    filtersApplied.push("query");
                if (input.ncode)
                    filtersApplied.push("ncode");
                if ((input.setAside?.length ?? 0) > 0)
                    filtersApplied.push("setAside");
                if (input.state)
                    filtersApplied.push("state");
                // organization-name is the only requested facet the keyless endpoint
                // cannot honor — flag it dropped so results aren't read as org-filtered.
                const filtersDropped = input.organizationName
                    ? ["organizationName"]
                    : [];
                const notes = [];
                if (filtersApplied.length > 0) {
                    notes.push("Keyless SAM search filtered server-side by the applied facets (NAICS/set-aside/place-of-performance state/keyword) — the result count reflects them. But the keyless list payload OMITS each notice's naics/setAside/placeOfPerformance VALUES (null here); call sam_get_opportunity on a noticeId to read those values.");
                }
                else {
                    notes.push("naics/setAside/placeOfPerformance are null because the keyless list endpoint omits those values — call sam_get_opportunity for a notice to obtain them.");
                }
                if (filtersDropped.length > 0) {
                    notes.push("The organization-name filter is NOT supported by the keyless endpoint and was ignored (results are unfiltered on organization). Set SAM_GOV_API_KEY to filter by organization, or filter client-side on the returned `agency` field.");
                }
                return withMeta(data, {
                    source: "sam.gov/sgs/v1 (keyless HAL)",
                    keylessMode: true,
                    truncated: r.totalRecords > data.returned,
                    returned: data.returned,
                    totalAvailable: r.totalRecords,
                    filtersApplied,
                    filtersDropped,
                    fieldsUnavailable: ["naics", "setAside", "placeOfPerformance"],
                    notes,
                });
            }
            // Keyed path: api.sam.gov honors the structured filters and populates
            // the fields, so nothing is dropped or unavailable.
            return withMeta(data, {
                source: "api.sam.gov/opportunities/v2 (keyed)",
                keylessMode: false,
                truncated: r.totalRecords > data.returned,
                returned: data.returned,
                totalAvailable: r.totalRecords,
                filtersApplied: [],
                filtersDropped: [],
                fieldsUnavailable: [],
            });
        }
        case "sam_get_opportunity": {
            const { noticeId } = SamGetOpportunityInput.parse(args);
            const o = await sam.getOpportunity(noticeId);
            if (!o)
                return { found: false, noticeId };
            return {
                found: true,
                noticeId: o.noticeId,
                title: o.title,
                agency: o.fullParentPathName,
                solicitationNumber: o.solicitationNumber,
                responseDeadline: o.responseDeadLine,
                type: o.type,
                naics: o.naicsCode,
                setAside: o.typeOfSetAside,
                placeOfPerformance: o.placeOfPerformance,
                pointsOfContact: o.pointOfContact ?? [],
                description: o.description,
                attachments: (o.resourceLinks ?? []).map((url, idx) => ({
                    index: idx,
                    url,
                })),
                uiLink: o.uiLink,
            };
        }
        case "sam_fetch_description": {
            const { noticeId } = SamFetchDescriptionInput.parse(args);
            const o = await sam.getOpportunity(noticeId);
            if (!o)
                return { found: false, noticeId };
            const text = o.description
                ? await sam.fetchOpportunityDescription(o.description)
                : "";
            return {
                found: true,
                noticeId,
                descriptionLength: text.length,
                description: text || "(no description body available)",
            };
        }
        case "sam_attachment_url": {
            const { resourceId } = SamAttachmentUrlInput.parse(args);
            return { downloadUrl: sam.publicDownloadUrl(resourceId) };
        }
        case "sam_lookup_organization": {
            const { organizationId } = SamLookupOrgInput.parse(args);
            // SamGovClient internal method — exposed via direct fetch since
            // it's not on the public surface. Use the public sam.gov endpoint
            // directly (already keyless).
            const r = await fetch(`https://sam.gov/api/prod/federalorganizations/v1/organizations/${encodeURIComponent(organizationId)}`, {
                headers: { Accept: "application/hal+json" },
                signal: AbortSignal.timeout(10_000),
            });
            if (!r.ok) {
                return { found: false, organizationId, status: r.status };
            }
            const json = (await r.json());
            const org = json._embedded?.[0]?.org;
            return {
                found: !!org,
                organizationId,
                fullParentPathName: org?.fullParentPathName ?? "",
                agencyName: org?.agencyName ?? "",
                name: org?.name ?? "",
                type: org?.type,
                level: org?.level,
            };
        }
        case "sam_lookup_notice_fields":
            return await gsaCsv.lookupNoticeFields(SamLookupNoticeFieldsInput.parse(args));
        // USAspending — Awards & Recipients
        case "usas_search_awards":
            return await usas.searchAwards(UsasFiltersBase.parse(args));
        case "usas_search_individual_awards":
            return await usas.searchIndividualAwards(UsasIndividualAwardsInput.parse(args));
        case "usas_search_subagency_spending":
            return await usas.searchSubAgencySpending(UsasSubAgencyInput.parse(args));
        case "usas_lookup_agency":
            return await usas.lookupAgency(UsasLookupAgencyInput.parse(args).searchText);
        case "usas_search_awards_by_recipient":
            return await usas.searchAwardsByRecipient(UsasRecipientAwardsInput.parse(args));
        case "usas_search_subawards":
            return await usas.searchSubawards(UsasSubawardsInput.parse(args));
        case "usas_search_recompetes":
            return await usas.searchRecompetes(UsasRecompetesInput.parse(args));
        case "usas_search_expiring_contracts":
            return await usas.searchExpiringContracts(UsasExpiringInput.parse(args));
        case "usas_get_award_detail":
            return await usas.getAwardDetail(UsasAwardDetailInput.parse(args).generatedInternalId);
        case "usas_analyze_incumbent":
            return await usas.analyzeIncumbent(UsasAnalyzeIncumbentInput.parse(args));
        // USAspending — Aggregate
        case "usas_spending_over_time":
            return await usas.spendingOverTime(UsasSpendingOverTimeInput.parse(args));
        case "usas_search_psc_spending":
            return await usas.searchPscSpending(UsasCategorySpendingInput.parse(args));
        case "usas_search_state_spending":
            return await usas.searchStateSpending(UsasCategorySpendingInput.parse(args));
        case "usas_search_cfda_spending":
            return await usas.searchCfdaSpending(UsasCfdaInput.parse(args));
        case "usas_search_federal_account_spending":
            return await usas.searchFederalAccountSpending(UsasCategorySpendingInput.parse(args));
        case "usas_search_agency_spending":
            return await usas.searchAgencySpending(UsasAgencySpendingInput.parse(args));
        // USAspending — Agency Profile
        case "usas_get_agency_profile":
            return await usas.getAgencyProfile(UsasAgencyProfileInput.parse(args).toptierCode);
        case "usas_get_agency_awards_summary":
            return await usas.getAgencyAwardsSummary(UsasAgencyAwardsInput.parse(args));
        case "usas_get_agency_budget_function":
            return await usas.getAgencyBudgetFunction(UsasAgencyBudgetInput.parse(args));
        // USAspending — Recipient Profile
        case "usas_search_recipients":
            return await usas.searchRecipients(UsasSearchRecipientsInput.parse(args));
        case "usas_get_recipient_profile":
            return await usas.getRecipientProfile(UsasGetRecipientInput.parse(args).recipientId);
        // USAspending — Reference / Autocomplete
        case "usas_autocomplete_naics":
            return await usas.autocompleteNaics(UsasAutocompleteInput.parse(args));
        case "usas_autocomplete_recipient":
            return await usas.autocompleteRecipient(UsasAutocompleteInput.parse(args));
        case "usas_naics_hierarchy":
            return await usas.naicsHierarchy(UsasNaicsHierarchyInput.parse(args));
        case "usas_glossary":
            return await usas.glossary(UsasGlossaryInput.parse(args));
        case "usas_list_toptier_agencies":
            return await usas.listToptierAgencies(UsasListAgenciesInput.parse(args));
        // Federal Register
        case "fed_register_search_documents":
            return await fedreg.searchDocuments(FedRegSearchInput.parse(args));
        case "fed_register_get_document":
            return await fedreg.getDocument(FedRegGetDocInput.parse(args).documentNumber);
        case "fed_register_list_agencies":
            return await fedreg.listAgencies(FedRegListAgenciesInput.parse(args));
        // eCFR
        case "ecfr_search":
            return await ecfr.search(EcfrSearchInput.parse(args));
        case "ecfr_list_titles":
            return await ecfr.listTitles();
        // Grants.gov
        case "grants_search":
            return await grants.searchGrants(GrantsSearchInput.parse(args));
        case "grants_get_opportunity":
            return await grants.getGrant(GrantsGetInput.parse(args));
        // Pricing / Wage
        case "sam_search_wage_determinations":
            return await pricing.searchWageDeterminations(WageSearchInput.parse(args));
        case "sam_get_wage_rates":
            return await pricing.getWageRates(WageRatesInput.parse(args));
        case "gsa_benchmark_labor_rates":
            return await pricing.benchmarkLaborRates(BenchmarkLaborInput.parse(args));
        // Integrity / Teaming
        case "sam_check_exclusions":
            return await integrity.checkExclusions(CheckExclusionsInput.parse(args));
        case "usas_search_teaming_partners":
            return await integrity.searchTeamingPartners(TeamingPartnersInput.parse(args));
        // GAO — Bid Protests
        case "gao_protest_lookup":
            return await gao.gaoProtestLookup(GaoProtestInput.parse(args));
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
/**
 * Hand-rolled Zod → JSON Schema converter (subset we use).
 */
function zodToJsonSchema(schema) {
    const def = schema._def;
    const tn = def.typeName;
    const description = schema.description;
    if (tn === "ZodObject") {
        const shape = schema
            .shape;
        const properties = {};
        const required = [];
        for (const [key, value] of Object.entries(shape)) {
            properties[key] = zodToJsonSchema(value);
            if (!value.isOptional?.()) {
                required.push(key);
            }
        }
        return {
            type: "object",
            properties,
            ...(required.length > 0 ? { required } : {}),
            ...(description ? { description } : {}),
        };
    }
    if (tn === "ZodString")
        return { type: "string", ...(description ? { description } : {}) };
    if (tn === "ZodNumber")
        return { type: "number", ...(description ? { description } : {}) };
    if (tn === "ZodBoolean")
        return { type: "boolean", ...(description ? { description } : {}) };
    if (tn === "ZodArray") {
        const inner = schema._def
            .type;
        return {
            type: "array",
            items: zodToJsonSchema(inner),
            ...(description ? { description } : {}),
        };
    }
    if (tn === "ZodEnum") {
        const values = schema._def
            .values;
        return {
            type: "string",
            enum: values,
            ...(description ? { description } : {}),
        };
    }
    if (tn === "ZodOptional" || tn === "ZodDefault" || tn === "ZodNullable") {
        const inner = schema
            ._def.innerType;
        const innerSchema = zodToJsonSchema(inner);
        return description ? { ...innerSchema, description } : innerSchema;
    }
    return { type: "string", ...(description ? { description } : {}) };
}
main().catch((err) => {
    console.error("[mcp-sam-gov] FATAL:", err);
    process.exit(1);
});
//# sourceMappingURL=server.js.map