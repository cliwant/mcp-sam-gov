#!/usr/bin/env node
/**
 * @cliwant/mcp-sam-gov — Model Context Protocol server for SAM.gov
 * + USAspending + Federal Register + eCFR + Grants.gov.
 *
 * 34 keyless tools wrapping every public federal-contracting data
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
import * as sba from "./sba.js";
import * as naicsXwalk from "./naics-crosswalk.js";
import * as workflows from "./workflows.js";
import * as fedRegClassifier from "./fedreg-classifier.js";
import { toToolError } from "./errors.js";
export const SERVER_NAME = "mcp-sam-gov";
export const SERVER_VERSION = "0.5.0";
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
const UsasAwardDetailInput = z.object({
    generatedInternalId: z
        .string()
        .describe("From spending_by_award results — e.g. CONT_AWD_*"),
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
// SBA size standards (13 CFR §121.201)
const SbaLookupInput = z.object({
    naicsCode: z
        .string()
        .describe("6-digit NAICS code (e.g. '541512'). Use usas_autocomplete_naics first if you don't have a code."),
});
const SbaCheckQualificationInput = z.object({
    naicsCode: z
        .string()
        .describe("6-digit NAICS code under which the firm is bidding."),
    averageAnnualRevenueUsd: z
        .number()
        .nonnegative()
        .optional()
        .describe("Firm's 3-year average annual revenue in USD. Required if the NAICS uses revenue-based size standard."),
    averageEmployees: z
        .number()
        .nonnegative()
        .optional()
        .describe("Firm's 12-month average employee count. Required if the NAICS uses employee-based size standard."),
});
// Federal Register classifier
const FedRegClassifyInput = z.object({
    documentNumber: z
        .string()
        .optional()
        .describe("Federal Register document number to fetch + classify (e.g. '2024-12345'). Provide either documentNumber OR raw {title, abstract, type, agencies, cfrReferences}. Pass documentNumber for one-shot classification of a specific notice."),
    title: z.string().optional().describe("Document title (used if documentNumber omitted)."),
    abstract: z.string().optional().describe("Document abstract (used if documentNumber omitted)."),
    type: z
        .enum(["RULE", "PRORULE", "NOTICE", "PRESDOCU", "UNKNOWN"])
        .optional()
        .describe("Federal Register type code (used if documentNumber omitted)."),
    typeDisplay: z.string().optional().describe("Human display type (e.g. 'Rule', 'Notice')."),
    agencies: z
        .array(z.object({ name: z.string().optional(), slug: z.string().optional() }))
        .optional()
        .describe("Agency objects (used if documentNumber omitted)."),
    cfrReferences: z
        .array(z.object({
        title: z.union([z.string(), z.number()]).optional(),
        part: z.string().optional(),
        chapter: z.string().optional(),
    }))
        .optional()
        .describe("CFR references (used if documentNumber omitted)."),
});
const FedRegClassifyBatchInput = z.object({
    query: z.string().optional().describe("Free-text query (passed to fed_register_search_documents)."),
    agencySlugs: z
        .array(z.string())
        .optional()
        .describe("Federal Register agency slugs (e.g. ['small-business-administration'])."),
    type: z
        .enum(["RULE", "PRORULE", "NOTICE", "PRESDOCU"])
        .optional()
        .describe("Restrict to one Federal Register type."),
    publicationDateFrom: z
        .string()
        .optional()
        .describe("ISO date YYYY-MM-DD lower bound for publication."),
    publicationDateTo: z
        .string()
        .optional()
        .describe("ISO date YYYY-MM-DD upper bound for publication."),
    perPage: z.number().int().min(1).max(50).optional().describe("Page size 1-50, default 20."),
});
// NAICS revision crosswalk
const NaicsRevisionCheckInput = z.object({
    naicsCode: z
        .string()
        .describe("6-digit NAICS code to verify. Returns validity in NAICS 2022 + any historical change (renumbered / split / retired)."),
});
// Sub-award aggregation + sub-recipient profile
const UsasAggregateSubawardsInput = z.object({
    primeRecipientName: z.string().optional(),
    agency: z.string().optional(),
    naics: z.string().optional(),
    fiscalYear: z.number().int().min(2007).optional(),
    limit: z.number().min(1).max(50).optional(),
});
const UsasGetSubRecipientProfileInput = z.object({
    subRecipientName: z
        .string()
        .describe("Sub-recipient firm name (full or partial — matches via search text)"),
    agency: z.string().optional(),
    fiscalYear: z.number().int().min(2007).optional(),
    limit: z.number().min(1).max(50).optional(),
});
// Workflow primitives (composite tools)
const WorkflowCaptureBriefInput = z.object({
    agency: z
        .string()
        .describe("Agency name or abbreviation (e.g. 'VA', 'Department of Defense')"),
    naics: z.string().describe("6-digit NAICS code (e.g. '541512')"),
    fiscalYear: z
        .number()
        .int()
        .min(2007)
        .optional()
        .describe("Default: current fiscal year"),
});
const WorkflowRecompeteRadarInput = z.object({
    agency: z.string(),
    naics: z.string(),
    monthsUntilExpiry: z.number().min(1).max(36).optional().describe("Default 12"),
    minAwardValueUsd: z.number().optional(),
});
const WorkflowVendorProfileInput = z.object({
    recipientName: z
        .string()
        .describe("Vendor name or partial — e.g. 'Booz Allen', 'Accenture Federal'"),
    fiscalYear: z.number().int().min(2007).optional(),
});
export const TOOLS = [
    // ━━━ SAM.gov (5) ━━━
    {
        name: "sam_search_opportunities",
        description: "Search SAM.gov federal contracting opportunities (keyless HAL). Returns up to 50 ACTIVE notices with title, agency, NAICS, noticeId. Use for DISCOVERY — narrow with NAICS / agency / set-aside / state. Returns SUMMARIES only — call sam_get_opportunity afterward to drill into a specific notice's full detail. For HISTORICAL / awarded contracts (not active solicitations), use usas_search_individual_awards instead.",
        inputSchema: SamSearchInput,
    },
    {
        name: "sam_get_opportunity",
        description: "Fetch full detail for a single SAM.gov notice by 32-char hex noticeId (from sam_search_opportunities). Returns title, agency, solicitation #, POCs, response deadline, attachment URLs, INLINE description body when available. Call BEFORE drafting bid/no-bid or compliance work. If description body is a URL instead of inline text, call sam_fetch_description next.",
        inputSchema: SamGetOpportunityInput,
    },
    {
        name: "sam_fetch_description",
        description: "Return the full description / RFP body text for a notice as plain text. Use when sam_get_opportunity returned a description URL instead of inline body, OR when you want an LLM-friendly text dump for analysis. Always prefer sam_get_opportunity FIRST for the structured envelope; this tool is for the raw body only.",
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
    // ━━━ USAspending — Awards & Recipients (8) ━━━
    {
        name: "usas_search_awards",
        description: "AGGREGATE share-of-wallet on USAspending. Given an agency × NAICS × fiscal year, returns TOP RECIPIENTS by total $ + transaction count (rolled up, not line items). Use for competitive landscape questions ('who wins at VA in 541512?'). For specific contracts/line items, use usas_search_individual_awards instead. For HISTORICAL awarded contracts only — for active solicitations use sam_search_opportunities.",
        inputSchema: UsasFiltersBase,
    },
    {
        name: "usas_search_individual_awards",
        description: "LINE-ITEM federal contracts on USAspending. Returns SPECIFIC AWARDS (recipient + $ + sub-agency + state + description), not aggregates. Use AFTER usas_search_awards when the user wants 'show me the actual contracts' or 'list specific awards'. Each result includes a generatedInternalId — pass it to usas_get_award_detail to fetch period_of_performance, options, set-aside fields.",
        inputSchema: UsasIndividualAwardsInput,
    },
    {
        name: "usas_search_subagency_spending",
        description: "Break down a PARENT AGENCY's spending by sub-agency / office. Surfaces which office holds the budget (e.g. inside VA: OI&T vs VHA vs VBA; inside DoD: Army vs Navy vs DISA). Use AFTER usas_lookup_agency confirms the parent agency name. For agency-vs-agency comparison (different parents), use usas_search_agency_spending.",
        inputSchema: UsasSubAgencyInput,
    },
    {
        name: "usas_lookup_agency",
        description: "Resolve a user-friendly agency reference ('VA', 'Veterans Affairs', 'DHS') to USAspending's canonical toptier name + 4-digit code. ANTI-HALLUCINATION GUARD — ALWAYS call this FIRST if the user uses an abbreviation, partial name, or non-canonical phrasing. Other USAspending tools (search_awards, agency_profile, etc.) need the canonical name to match. For SAM.gov's federal-organization hierarchy (different identifier system), use sam_lookup_organization instead.",
        inputSchema: UsasLookupAgencyInput,
    },
    {
        name: "usas_search_awards_by_recipient",
        description: "Pull every contract a specific recipient has won within an agency × NAICS slice. Use when the user asks 'show me Booz Allen wins at VA last year' — returns line items + naicsCode + description, not aggregates.",
        inputSchema: UsasRecipientAwardsInput,
    },
    {
        name: "usas_search_subawards",
        description: "Enumerate SUBCONTRACTS reported on prime awards via FFATA. Use for 'who teams with Leidos at DISA?' or 'show small-business subs on Accenture's DHS contracts' — surfaces the prime/sub network for teaming-map artifacts. Coverage caveat: FFATA reporting is self-reported quarterly by primes — top primes report most subs, mid-tier primes have notable gaps. For PRIME-level analysis use usas_search_individual_awards instead.",
        inputSchema: UsasSubawardsInput,
    },
    {
        name: "usas_search_expiring_contracts",
        description: "RECOMPETE RADAR — find federal contracts at agency × NAICS that expire within N months. End-date sorted, top 10 by value. Use for 'what VA cloud contracts are up for recompete?' or 'show 541512 contracts expiring in 6 months'. Returns each award's generatedInternalId — pipe to usas_get_award_detail for the full period_of_performance + options + set-aside fields needed for capture briefs.",
        inputSchema: UsasExpiringInput,
    },
    {
        name: "usas_get_award_detail",
        description: "Fetch full detail for a single award by generatedInternalId (from usas_search_individual_awards). Returns period_of_performance (start/end/potential_end), base_and_all_options, set-aside type, competition extent, number_of_offers — the per-award fields the search endpoint omits.",
        inputSchema: UsasAwardDetailInput,
    },
    // ━━━ USAspending — Aggregate Analysis (6) ━━━
    {
        name: "usas_spending_over_time",
        description: "Time-series aggregation of federal spending. Group by fiscal_year / quarter / month, filter by agency / NAICS / set-aside. Use for 'how has VA 541512 spending trended over the past 5 years' — returns yearly/quarterly/monthly $ rollups.",
        inputSchema: UsasSpendingOverTimeInput,
    },
    {
        name: "usas_search_psc_spending",
        description: "Spending broken down by Product Service Code (PSC). Use for CONTRACT market structure ('what PSC categories see the most $ at DoD?') — surfaces market segments beyond NAICS (e.g. PSC R425 = engineering support services, PSC D316 = IT-end user, PSC D318 = IT-data center). Sibling tool routing: NAICS-style market = this tool; geography = usas_search_state_spending; budget account = usas_search_federal_account_spending; buyer = usas_search_agency_spending; grants (not contracts) = usas_search_cfda_spending.",
        inputSchema: UsasCategorySpendingInput,
    },
    {
        name: "usas_search_state_spending",
        description: "Spending broken down by state / territory. Use for GEOGRAPHIC analysis ('where is federal $ flowing for NAICS 541512?') — typical answer pattern: 'VA $128B, MD $66B, DC $58B'. Sibling routing: state geography = this tool; market structure = usas_search_psc_spending; budget account = usas_search_federal_account_spending.",
        inputSchema: UsasCategorySpendingInput,
    },
    {
        name: "usas_search_cfda_spending",
        description: "Spending broken down by CFDA grant program code. FOR GRANTS ONLY — CFDA = financial assistance (award_type 02-05), NOT contracts. Use this for 'top federal grant programs by $'. For contract market analysis, switch to usas_search_psc_spending. For grant OPPORTUNITIES (not historical spending), use grants_search.",
        inputSchema: UsasCfdaInput,
    },
    {
        name: "usas_search_federal_account_spending",
        description: "Spending broken down by federal account / Treasury Account Symbol (TAS). Use to map money to the actual BUDGET LINE ITEM (e.g. '036-0167 = Information Technology Systems, VA'). For BUDGET / appropriations questions ('which TAS funds X?'). For market segments use usas_search_psc_spending; for buyer breakdown use usas_search_agency_spending.",
        inputSchema: UsasCategorySpendingInput,
    },
    {
        name: "usas_search_agency_spending",
        description: "Spending broken down by AWARDING AGENCY. Use for 'which agencies spend the most on NAICS 541512?' — top buyers by $. Sibling routing: BUYER = this tool; sub-agency / office breakdown = usas_search_subagency_spending; agency PROFILE / metadata = usas_get_agency_profile.",
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
        description: "Search USAspending recipient list with FULL parent/child/recipient hierarchy. Returns recipients with id, duns, uei, level (P=parent, C=child, R=recipient), total_amount. Use to FIND the recipient_id (e.g. 'find Booz Allen's parent recipient_id') before calling usas_get_recipient_profile. For QUICK fuzzy name resolution (without hierarchy), prefer usas_autocomplete_recipient — it's faster and works for anti-hallucination prep.",
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
        description: "Autocomplete NAICS codes by free-text. ANTI-HALLUCINATION GUARD — call this when the user mentions a NAICS theme but no specific code (e.g. 'computer systems design' → 541512, 'cloud computing' → 541512 or 518210). Returns top fuzzy matches with code + title. Use BEFORE any search tool that takes a NAICS code. For navigating PARENT/CHILD relationships (e.g. 'show all 6-digit NAICS under 5415'), use usas_naics_hierarchy instead.",
        inputSchema: UsasAutocompleteInput,
    },
    {
        name: "usas_autocomplete_recipient",
        description: "Autocomplete recipient names — FAST fuzzy lookup. ANTI-HALLUCINATION GUARD — call this BEFORE any tool that filters by recipient name to confirm the exact USAspending-canonical legal name (e.g. 'Booz Allen' → 'BOOZ ALLEN HAMILTON INC'). Returns up to 10 matches with UEI/DUNS. For full hierarchy + total spend (parent vs child relationships), use usas_search_recipients instead.",
        inputSchema: UsasAutocompleteInput,
    },
    {
        name: "usas_naics_hierarchy",
        description: "Navigate the NAICS hierarchy tree (2-digit → 3-digit → 4-digit → 6-digit). Returns parent/child relationships + active-contract count per code. Use for MARKET SCOPE exploration ('what 6-digit NAICS exist under 5415?', 'how many active contracts under NAICS 541?'). For free-text → code resolution, use usas_autocomplete_naics instead.",
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
        description: "Search Federal Register documents (proposed rules, final rules, notices, presidential documents) by query / agency / type / date range. Federal Register = NEW REGULATORY ACTIVITY (rules being made / changed / proposed) — time-sensitive, dated. Use for 'what new VA cybersecurity rules came out this quarter?' or 'when does the new FAR clause take effect?'. For CURRENT codified regulation text (rules as they stand right now), use ecfr_search instead.",
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
    {
        name: "fed_register_classify",
        description: "CLASSIFY a Federal Register notice into one of 5 federal-contracting-relevant classes: far_amendment / set_aside_policy / system_retirement / rule_change / admin_paperwork (or uncategorized). Heuristic + deterministic (no model call). Pass documentNumber for one-shot classification (auto-fetches), OR pass raw {title, abstract, type, agencies, cfrReferences} for in-batch use. Returns primaryClass + confidence (high/medium/low) + matched signals + per-class scores so the caller can quote evidence. Use to triage 'is this a real rule change or just a Paperwork Reduction Act notice?' before reading the full document.",
        inputSchema: FedRegClassifyInput,
    },
    {
        name: "fed_register_classify_batch",
        description: "Search Federal Register AND classify each result in one call. Wraps fed_register_search_documents → classifies every result via the same 5-class heuristic → returns documents[] + a histogram of class counts. Use for 'of the last 50 SBA notices, how many were real set-aside policy changes vs. paperwork?' Pass the same filters as fed_register_search_documents (query / agencySlugs / type / date range / perPage). Saves 1 round-trip vs. calling search + classify separately.",
        inputSchema: FedRegClassifyBatchInput,
    },
    // ━━━ eCFR (2) ━━━
    {
        name: "ecfr_search",
        description: "Full-text search across the entire CFR (Code of Federal Regulations) — the CURRENT codified regulation as it stands right now. Use for COMPLIANCE / CITATION questions — pass titleNumber=48 for FAR (Federal Acquisition Regulation), titleNumber=2 for federal financial assistance, etc. Returns excerpt + section path + ecfrUrl. For NEW regulatory activity (rules being changed), use fed_register_search_documents instead. For 'what's in title X' overview, use ecfr_list_titles first.",
        inputSchema: EcfrSearchInput,
    },
    {
        name: "ecfr_list_titles",
        description: "List all 50 CFR titles with name + last_amended_on date. Use to discover what's in each title (Title 48 = FAR, Title 32 = National Defense, Title 14 = Aeronautics, etc.).",
        inputSchema: EcfrListTitlesInput,
    },
    // ━━━ Sub-award aggregation (2) ━━━
    {
        name: "usas_aggregate_subawards",
        description: "AGGREGATE sub-awards by sub-recipient name across a filter slice. Use for 'top subs to Booz Allen FY2025' (pass primeRecipientName), 'top sub-recipients in NAICS 541512' (pass naics), or 'top subs at VA in NAICS 541512' (pass agency + naics). Returns each sub-recipient's total sub-award amount + count + distinct prime count, sorted descending. Differs from usas_search_subawards: that tool returns LINE ITEMS; this tool aggregates by sub-recipient. Coverage: aggregates from first 100 matching FFATA filings (primes self-report quarterly; coverage uneven).",
        inputSchema: UsasAggregateSubawardsInput,
    },
    {
        name: "usas_get_sub_recipient_profile",
        description: "Given a SUB-RECIPIENT firm name, return their federal sub-contracting footprint: distinct primes that used them, total sub-revenue, count of distinct prime awards. Use for 'how does IBM appear as a sub in federal data?' or 'what's our competitor's sub-tier exposure?'. For PRIME profile (firm as prime contractor), use workflow_vendor_profile or usas_get_recipient_profile instead. FFATA coverage caveat applies.",
        inputSchema: UsasGetSubRecipientProfileInput,
    },
    // ━━━ NAICS revision crosswalk (1) ━━━
    {
        name: "naics_revision_check",
        description: "Check whether a NAICS code is valid in NAICS 2022 and surface any historical change (2002 → 2007 → 2012 → 2017 → 2022 revisions). Returns validity flag + status (stable / renumbered / split / retired) + canonical 2022 successor if changed. Catches old codes still cited in legacy SOWs (e.g. 541510 retired in 2007, 511210 renumbered to 513210 in 2022, 519130 split in 2022). Use BEFORE running USAspending or SAM.gov searches with any code from a pre-2022 contract document. Coverage v0.5: ~60 federal-contracting-relevant codes; falls back to Census concordance hint for unknown codes. For free-text → code resolution, use usas_autocomplete_naics instead.",
        inputSchema: NaicsRevisionCheckInput,
    },
    // ━━━ Workflow primitives — composite tools (3) ━━━
    {
        name: "workflow_capture_brief",
        description: "COMPOSITE TOOL — federal capture intelligence for an agency × NAICS, in 1 call instead of 5-6 chained tool calls. Internally chains usas_lookup_agency → usas_search_subagency_spending → usas_search_awards → usas_search_expiring_contracts → fed_register_search_documents → sam_search_opportunities. Returns 6 sections each as { ok: true, data } or { ok: false, error } so partial failures don't block the rest. Plus a synthesized one-line summary. Use this BEFORE diving into individual tools when the user wants 'a brief on X agency in Y NAICS' — saves ~6 round-trips and avoids orchestration mistakes.",
        inputSchema: WorkflowCaptureBriefInput,
    },
    {
        name: "workflow_recompete_radar",
        description: "COMPOSITE TOOL — focused recompete intelligence in 1 call. Lighter than workflow_capture_brief — purpose-built for 'what's expiring + who holds it + any rule changes affecting recompete'. Chains usas_lookup_agency → usas_search_expiring_contracts → usas_search_awards (current FY incumbents) → fed_register_search_documents (recent rules). Use when user asks 'what's the recompete pipeline for X agency in Y NAICS over next N months?'",
        inputSchema: WorkflowRecompeteRadarInput,
    },
    {
        name: "workflow_vendor_profile",
        description: "COMPOSITE TOOL — full picture of a federal vendor in 1 call. Chains usas_autocomplete_recipient (canonicalize) → usas_search_recipients (parent/child hierarchy) → usas_search_awards_by_recipient (recent prime awards) → usas_search_subawards (where they appear as a sub). Use when user asks 'tell me about [vendor]' or 'show me Booz Allen's recent federal work'. Anti-hallucination: starts with autocomplete to confirm canonical name before downstream calls.",
        inputSchema: WorkflowVendorProfileInput,
    },
    // ━━━ SBA size standards (2) ━━━
    {
        name: "sba_size_standard_lookup",
        description: "Look up the SBA small-business size standard for a given 6-digit NAICS code (13 CFR §121.201, effective 2023-03-17). Returns the cap as either revenue ($M, 3-year avg) or employee count, plus the citation. Some NAICS have MULTIPLE entries (alternative caps for sub-industries — e.g. NAICS 541330 Engineering Services has $25.5M default but $47M for military/marine work) — qualifying under ANY one is enough. Coverage: ~50 most-used services/IT/R&D NAICS in v0.4 (full eCFR fallback noted in response). Use BEFORE bidding to confirm 'small business' eligibility.",
        inputSchema: SbaLookupInput,
    },
    {
        name: "sba_check_size_qualification",
        description: "Check whether a firm qualifies as 'small business' under SBA size standards for a given NAICS, given its avg annual revenue OR employee count. Returns qualifies: true/false/indeterminate plus per-entry breakdown. Handles multi-entry NAICS correctly (firm qualifies if ANY one alternative cap is satisfied). Provide averageAnnualRevenueUsd for revenue-based standards, averageEmployees for employee-based. Source: 13 CFR §121.201 effective 2023-03-17.",
        inputSchema: SbaCheckQualificationInput,
    },
    // ━━━ Grants.gov (2) ━━━
    {
        name: "grants_search",
        description: "Search Grants.gov federal GRANT opportunities (financial assistance — distinct from contracts on SAM.gov). Filter by keyword / CFDA / agency / opportunity number. Default status = forecasted + posted (active). For HISTORICAL grant SPENDING (not opportunities), use usas_search_cfda_spending. For CONTRACT opportunities (not grants), use sam_search_opportunities.",
        inputSchema: GrantsSearchInput,
    },
    {
        name: "grants_get_opportunity",
        description: "Fetch full detail for a single grant opportunity by id. Returns description, agency, posting/response/archive dates, award_ceiling, award_floor, estimated_funding, expected_number_of_awards, applicant_types, funding_instruments, CFDA programs.",
        inputSchema: GrantsGetInput,
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
            const data = await runTool(name, args ?? {}, sam);
            // Structured success envelope. Calling agent can rely on
            // `ok: true` to know the payload is in `data`.
            const envelope = { ok: true, data };
            return {
                content: [
                    { type: "text", text: JSON.stringify(envelope, null, 2) },
                ],
            };
        }
        catch (err) {
            // Structured error envelope. The agent can read `error.kind`
            // and `error.retryable` to decide what to do next.
            const error = toToolError(err, name);
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
export async function runTool(name, args, sam) {
    switch (name) {
        // SAM.gov
        case "sam_search_opportunities": {
            const input = SamSearchInput.parse(args);
            const r = await sam.searchOpportunities({
                ...input,
                setAside: input.setAside,
            });
            return {
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
        case "usas_search_expiring_contracts":
            return await usas.searchExpiringContracts(UsasExpiringInput.parse(args));
        case "usas_get_award_detail":
            return await usas.getAwardDetail(UsasAwardDetailInput.parse(args).generatedInternalId);
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
        case "fed_register_classify": {
            const input = FedRegClassifyInput.parse(args);
            if (input.documentNumber) {
                const doc = await fedreg.getDocument(input.documentNumber);
                const classification = fedRegClassifier.classifyDocument({
                    title: doc.title,
                    abstract: doc.abstract,
                    type: doc.type,
                    typeDisplay: doc.typeDisplay,
                    agencies: doc.agencies,
                    cfrReferences: doc.cfrReferences,
                });
                return {
                    documentNumber: doc.documentNumber,
                    title: doc.title,
                    typeDisplay: doc.typeDisplay,
                    publicationDate: doc.publicationDate,
                    classification,
                };
            }
            // Inline classification path
            return fedRegClassifier.classifyDocument({
                title: input.title,
                abstract: input.abstract,
                type: input.type,
                typeDisplay: input.typeDisplay,
                agencies: input.agencies,
                cfrReferences: input.cfrReferences,
            });
        }
        case "fed_register_classify_batch": {
            const input = FedRegClassifyBatchInput.parse(args);
            const search = await fedreg.searchDocuments({
                query: input.query,
                agencySlugs: input.agencySlugs,
                type: input.type,
                publicationDateFrom: input.publicationDateFrom,
                publicationDateTo: input.publicationDateTo,
                perPage: input.perPage ?? 20,
            });
            const batch = fedRegClassifier.classifyBatch(search.documents);
            return {
                totalRecords: search.totalRecords,
                totalPages: search.totalPages,
                sampleSize: batch.documents.length,
                histogram: batch.histogram,
                documents: batch.documents,
            };
        }
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
        // Sub-award aggregation + sub-recipient profile
        case "usas_aggregate_subawards":
            return await usas.aggregateSubawards(UsasAggregateSubawardsInput.parse(args));
        case "usas_get_sub_recipient_profile":
            return await usas.getSubRecipientProfile(UsasGetSubRecipientProfileInput.parse(args));
        // NAICS revision crosswalk
        case "naics_revision_check": {
            const { naicsCode } = NaicsRevisionCheckInput.parse(args);
            return naicsXwalk.checkNaicsRevision(naicsCode);
        }
        // Workflow primitives (composite tools)
        case "workflow_capture_brief": {
            const input = WorkflowCaptureBriefInput.parse(args);
            return await workflows.captureBrief({ ...input, sam });
        }
        case "workflow_recompete_radar": {
            const input = WorkflowRecompeteRadarInput.parse(args);
            return await workflows.recompeteRadar(input);
        }
        case "workflow_vendor_profile": {
            const input = WorkflowVendorProfileInput.parse(args);
            return await workflows.vendorProfile(input);
        }
        // SBA size standards
        case "sba_size_standard_lookup": {
            const { naicsCode } = SbaLookupInput.parse(args);
            return sba.lookupSizeStandard(naicsCode);
        }
        case "sba_check_size_qualification": {
            const input = SbaCheckQualificationInput.parse(args);
            return sba.checkQualification({
                naicsCode: input.naicsCode,
                averageAnnualRevenueUsd: input.averageAnnualRevenueUsd,
                averageEmployees: input.averageEmployees,
            });
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
/**
 * Hand-rolled Zod → JSON Schema converter (subset we use).
 */
export function zodToJsonSchema(schema) {
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