#!/usr/bin/env node
/**
 * @cliwant/mcp-sam-gov — Model Context Protocol server for SAM.gov
 * + USAspending + Federal Register + eCFR + Grants.gov + GAO + wage/pricing.
 *
 * 52 keyless tools wrapping every public federal-contracting data
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
import { SamGovClient, daysUntilResponse, applyResponseDeadlineWindow, } from "./sam-gov/index.js";
import * as usas from "./usaspending.js";
import * as fedreg from "./federal-register.js";
import * as ecfr from "./ecfr.js";
import * as far from "./far.js";
import * as grants from "./grants.js";
import * as pricing from "./pricing.js";
import * as integrity from "./integrity.js";
import * as gao from "./gao.js";
import * as gsaCsv from "./gsa-csv.js";
import * as sba from "./sba.js";
import * as treasury from "./treasury.js";
import * as edgar from "./edgar.js";
import * as socrata from "./socrata.js";
import * as ckan from "./ckan.js";
import * as echo from "./echo.js";
import * as datagov from "./datagov.js";
import * as govinfo from "./govinfo.js";
import * as fpds from "./fpds.js";
import * as nih from "./nih.js";
import * as nsf from "./nsf.js";
import * as clinicaltrials from "./clinicaltrials.js";
import * as census from "./census.js";
import * as fema from "./fema.js";
import * as fdic from "./fdic.js";
import { fetchAttachmentText } from "./attachments.js";
import { toToolError, ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { buildMeta, isMetaBundle, withMeta, } from "./meta.js";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
const SERVER_NAME = "mcp-sam-gov";
// Kept in lockstep with package.json / manifest.json / server.json.
const SERVER_VERSION = "0.7.0";
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
// Pre-solicitation shaping radar (doc 06 §3.1). Surfaces Sources Sought /
// Presolicitation / Special Notices BEFORE the RFP exists — the free, real-time
// analogue of paid agency-forecast feeds. Keyless via the notice_type facet.
const SamSearchShapingInput = z.object({
    query: z.string().optional().describe("Free-text title query"),
    ncode: z.string().optional().describe("NAICS code, e.g. '541512'"),
    organizationName: z
        .string()
        .optional()
        .describe("Issuing agency canonical name (e.g. 'Department of Veterans Affairs'). NOTE: the keyless endpoint has NO organization-name filter — it is sent best-effort and flagged in _meta.filtersDropped; filter client-side on the returned `agency`."),
    state: z
        .string()
        .optional()
        .describe("Place-of-performance state, 2-letter, e.g. 'MD'"),
    setAside: z.array(z.string()).optional().describe("Set-aside codes: SBA, 8A, HZS, SDVOSBC, WOSB, EDWOSB, VSA, VSS"),
    noticeType: z
        .array(z.enum(["r", "p", "s", "k", "i", "u"]))
        .optional()
        .describe("Pre-solicitation notice-type codes to include. r=Sources Sought, p=Presolicitation, s=Special Notice (the DEFAULT shaping window = ['r','p','s']); k=Combined Synopsis/Solicitation, i=Intent to Bundle, u=Justification (J&A) are opt-in adjacency/incumbent tells. Ranked r/p over s via noticeTypeCode."),
    responseDeadlineFrom: z
        .string()
        .optional()
        .describe("ISO date lower bound for responseDeadline. APPLIED CLIENT-SIDE over the fetched page (the keyless feed ignores rdlfrom/rdlto) — disclosed in _meta.filtersDropped. A notice with no deadline is excluded from a windowed query."),
    responseDeadlineTo: z
        .string()
        .optional()
        .describe("ISO date upper bound for responseDeadline. APPLIED CLIENT-SIDE over the fetched page (see responseDeadlineFrom)."),
    activeOnly: z
        .boolean()
        .optional()
        .describe("Only currently-active notices (default true)."),
    limit: z.number().min(1).max(50).optional().describe("Page size (default 25, max 50)."),
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
const SamFetchAttachmentTextInput = z.object({
    url: z
        .string()
        .url()
        .refine((u) => {
        try {
            const p = new URL(u);
            const h = p.hostname.toLowerCase();
            return (p.protocol === "https:" &&
                (h === "sam.gov" || h === "api.sam.gov" || h.endsWith(".sam.gov")));
        }
        catch {
            return false;
        }
    }, {
        message: "url must be an https:// SAM attachment download URL on sam.gov / api.sam.gov (from sam_get_opportunity's attachments[].url). Arbitrary hosts are refused (SSRF hygiene).",
    })
        .describe("SAM attachment download URL from sam_get_opportunity → attachments[].url / resourceLinks (https://sam.gov/api/prod/opps/v3/opportunities/resources/files/{id}/download). Must be a sam.gov / api.sam.gov host."),
    maxChars: z
        .number()
        .int()
        .min(1000)
        .max(500_000)
        .optional()
        .describe("Cap on returned text characters (default 200000, max 500000). Truncation is disclosed in _meta (truncated:true)."),
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
// FAR / DFARS clause lookup (eCFR versioner full endpoint)
const FarClauseLookupInput = z.object({
    clauseNumber: z
        .string()
        .regex(
    // Accept an optional FAR/DFARS prefix + the NN.NNN-N / NNN.NNN-NNNN core.
    /^\s*(?:d?far[s]?\b[\s.:#-]*)?\d{1,3}\.\d{3,4}-\d{1,4}\s*$/i, "clauseNumber must be a FAR/DFARS clause like '52.212-4', '252.204-7012', or '52.204-25' (an optional 'FAR '/'DFARS ' prefix is allowed).")
        .describe("FAR or DFARS clause/provision number, e.g. '52.212-4', '252.204-7012', '52.204-25'. An optional 'FAR '/'DFARS ' prefix is stripped."),
    includePrescription: z
        .boolean()
        .optional()
        .describe("Also fetch the prescribing section parsed from the clause's 'As prescribed in …' opener (the rule for WHEN the clause applies). Default true."),
    asOfDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "asOfDate must be YYYY-MM-DD.")
        .optional()
        .describe("Point-in-time codification date (YYYY-MM-DD). Defaults to Title 48's current up_to_date_as_of."),
});
// FAR compliance matrix (composes far_clause_lookup over a cited-clause list)
const FarComplianceMatrixInput = z.object({
    clauses: z
        .array(z
        .string()
        .regex(
    // Same clause grammar as FarClauseLookupInput (optional FAR/DFARS prefix).
    /^\s*(?:d?far[s]?\b[\s.:#-]*)?\d{1,3}\.\d{3,4}-\d{1,4}\s*$/i, "each clause must be a FAR/DFARS clause like '52.212-4', '252.204-7012', or '52.204-25' (an optional 'FAR '/'DFARS ' prefix is allowed)."))
        .min(1)
        .max(25)
        .describe("The FAR/DFARS clause numbers a solicitation cites (e.g. from its 52.252-2 'Clauses Incorporated by Reference' list), 1–25. Deduped case-insensitively. e.g. ['52.212-4','52.204-25','252.204-7012']."),
    asOfDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "asOfDate must be YYYY-MM-DD.")
        .optional()
        .describe("Point-in-time codification date (YYYY-MM-DD) — typically the solicitation issue date. Defaults to Title 48's current up_to_date_as_of."),
    includePrescription: z
        .boolean()
        .optional()
        .describe("Also fetch each clause's prescribing section (the 'As prescribed in …' rule for WHEN it applies). Default true."),
    flagGates: z
        .boolean()
        .optional()
        .describe("Tag resolved rows that are pass/fail award-eligibility gates (Section 889, CMMC, limitations on subcontracting) with a gate label; others get gate:null. Default true. false ⇒ all gate:null."),
});
// FAR/DFARS-scoped search (composes ecfr_search, filtered to FAR/DFARS + deduped)
const FarSearchInput = z.object({
    query: z
        .string()
        .min(1, "query must be a non-empty search string.")
        .describe("What to search FAR/DFARS text for, e.g. 'limitations on subcontracting', 'covered defense information', 'commercial item'."),
    scope: z
        .enum(["far", "dfars", "both"])
        .optional()
        .describe("Which corpus to search: 'far' (Title 48 chapter 1, the default), 'dfars' (chapter 2), or 'both'. Excludes GSAM/agency supplements."),
    dedupeVersions: z
        .boolean()
        .optional()
        .describe("Collapse each section's historical versions to the current (in-force) one. Default true. false ⇒ return all raw rows incl. historical."),
    partsOnly: z
        .array(z.number().int())
        .optional()
        .describe("Restrict results to these FAR/DFARS parts, e.g. [52] for clause text only, [12] for commercial-item policy."),
    perPage: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of DISTINCT sections to return (1–20). Default 5."),
});
// SBA size standards
const SbaSizeStandardInput = z.object({
    naics: z
        .string()
        .regex(/^\d{6}$/, "naics must be a 6-digit NAICS code (e.g. '541512').")
        .describe("6-digit NAICS code to look up the SBA small-business size standard for (e.g. '541512')."),
});
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
const IntegrityLookupInput = z.object({
    uei: z
        .string()
        .optional()
        .describe("SAM UEI of the entity to screen (PREFERRED — most precise). Provide at least one of uei/cage/name."),
    cage: z
        .string()
        .optional()
        .describe("CAGE code of the entity to screen."),
    name: z
        .string()
        .optional()
        .describe("Legal entity name to screen (drives the keyless exclusions text search; normalized-name gated). Provide at least one of uei/cage/name."),
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
// ─── US Treasury Fiscal Data (keyless) — input schemas ───────────
// ADR-0002. `dataset` is an ENUM of the 5 live-confirmed paths (F5: no free
// path → no SSRF surface). pageSize max 500 (upstream page[size] ceiling).
const TreasuryDatasetEnum = z
    .enum([
    "debt_to_penny",
    "avg_interest_rates",
    "mts_table_1",
    "rates_of_exchange",
    "debt_outstanding",
])
    .describe("Which confirmed Treasury Fiscal Data dataset to query: debt_to_penny (daily total public debt), avg_interest_rates (avg rate by security type), mts_table_1 (Monthly Treasury Statement receipts/outlays/deficit), rates_of_exchange (quarterly FX by currency), debt_outstanding (historical fiscal-year-end debt).");
const TreasuryQueryDatasetInput = z.object({
    dataset: TreasuryDatasetEnum,
    fields: z
        .string()
        .optional()
        .describe("Optional CSV column projection (e.g. 'record_date,exchange_rate'). An unknown column ⇒ upstream HTTP 400 ⇒ invalid_input (surfaced as an error, never silently dropped)."),
    filter: z
        .string()
        .optional()
        .describe("Optional CSV of upstream filters 'col:op:val' (ops: lt|lte|gt|gte|eq|in), AND-combined — e.g. 'record_date:gte:2024-01-01,country_currency_desc:eq:Canada-Dollar'."),
    sort: z
        .string()
        .optional()
        .describe("Optional CSV sort columns; prefix '-' for descending (e.g. '-record_date')."),
    pageSize: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Rows per page (upstream page[size]); 1..500, default 100."),
    pageNumber: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("1-based page number (upstream page[number]); default 1."),
});
const TreasuryDebtToPennyInput = z.object({
    latest: z
        .boolean()
        .default(true)
        .describe("true (default) ⇒ only the single most-recent day (page[size]=1). false ⇒ the startDate/endDate range, newest-first."),
    startDate: z
        .string()
        .optional()
        .describe("Range mode only: ISO YYYY-MM-DD lower bound on record_date (inclusive)."),
    endDate: z
        .string()
        .optional()
        .describe("Range mode only: ISO YYYY-MM-DD upper bound on record_date (inclusive)."),
    pageSize: z.number().int().min(1).max(500).default(100).describe("Range mode: rows per page, 1..500, default 100."),
    pageNumber: z.number().int().min(1).default(1).describe("Range mode: 1-based page number, default 1."),
});
const TreasuryMonthlyStatementInput = z.object({
    startDate: z
        .string()
        .optional()
        .describe("ISO YYYY-MM-DD lower bound on record_date (inclusive). Default: trailing ~12 months."),
    endDate: z
        .string()
        .optional()
        .describe("ISO YYYY-MM-DD upper bound on record_date (inclusive)."),
    excludeSummaryRows: z
        .boolean()
        .default(true)
        .describe("true (default) excludes fiscal-year PARENT/SUMMARY rows (parent_id/amounts all null) via the server-side filter current_month_gross_outly_amt:gt:0, so only real child line-items (and totalAvailable) remain. false includes the null-amount summary rows."),
    pageSize: z.number().int().min(1).max(500).default(100).describe("Rows per page, 1..500, default 100."),
    pageNumber: z.number().int().min(1).default(1).describe("1-based page number, default 1."),
});
const TreasuryAvgInterestRatesInput = z.object({
    securityType: z
        .string()
        .optional()
        .describe("Optional exact security_type_desc filter (e.g. 'Marketable', 'Non-marketable', 'Interest-bearing Debt')."),
    latest: z
        .boolean()
        .default(true)
        .describe("true (default) ⇒ the most-recent month's full breakdown across security types (pinned to the latest record_date, memoized). false ⇒ the startDate/endDate range."),
    startDate: z.string().optional().describe("Range mode only: ISO YYYY-MM-DD lower bound on record_date (inclusive)."),
    endDate: z.string().optional().describe("Range mode only: ISO YYYY-MM-DD upper bound on record_date (inclusive)."),
    pageSize: z.number().int().min(1).max(500).default(100).describe("Range mode: rows per page, 1..500, default 100."),
    pageNumber: z.number().int().min(1).default(1).describe("Range mode: 1-based page number, default 1."),
});
// ─── SEC EDGAR (keyless) — input schemas ─────────────────────────
// ADR-0003. Keyless capital-markets source over data.sec.gov / efts.sec.gov.
// The join key is the 10-digit SEC CIK (NOT SAM UEI/DUNS — see edgar.ts caveat).
const EdgarLookupCikInput = z.object({
    query: z
        .string()
        .min(1)
        .describe("Company ticker (exact, case-insensitive) or a company-name substring to resolve to a 10-digit SEC CIK via company_tickers.json. e.g. 'AAPL' or 'apple'. Returns up to 50 matches (found:false on none)."),
});
const EdgarCompanyFilingsInput = z.object({
    cikOrTicker: z
        .string()
        .min(1)
        .describe("A 10-digit (or unpadded) SEC CIK, or a ticker/company-name resolvable via company_tickers.json (e.g. '320193', 'CIK0000320193', 'AAPL')."),
    forms: z
        .array(z.string())
        .optional()
        .describe("Optional form-type filter (e.g. ['10-K','10-Q','8-K']); case-insensitive exact match on the filing's form. Omit for all forms."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max filings to return, 1..100, default 20 (offset pagination over the recent window)."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based offset into the (form-filtered) recent filings, default 0."),
    fullHistory: z
        .boolean()
        .optional()
        .describe("When true, ALSO fetch the older filings.files[] submission shards (newest-first, up to maxShards) and assemble the COMPLETE filing history (recent ++ shard001..N, descending order preserved). Default false ⇒ recent window only (byte-identical to omitting it). A capped/failed fan-out is disclosed as PARTIAL — never a capped set claimed complete."),
    maxShards: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Fan-out cap when fullHistory is true: at most this many older shards are fetched (newest-first), 1..100, default 10. Bounds wall-time (each shard is one throttle-gated GET, serialized through the SHARED edgar gate) + payload. When totalShards > maxShards the response is PARTIAL-BY-CAP (hasMore:true; older un-fetched shards reached by RAISING maxShards, not by nextOffset). Ignored when fullHistory is false."),
});
const EdgarCompanyFactsInput = z.object({
    cikOrTicker: z
        .string()
        .min(1)
        .describe("A 10-digit (or unpadded) SEC CIK, or a ticker/company-name resolvable via company_tickers.json (e.g. '320193', 'AAPL')."),
    concepts: z
        .array(z.string())
        .optional()
        .describe("Optional XBRL us-gaap/dei concept tags to extract (e.g. ['Assets','NetIncomeLoss']). Default: the 6 curated USD concepts (Revenues/RevenueFromContractWithCustomerExcludingAssessedTax, Assets, Liabilities, StockholdersEquity, NetIncomeLoss, CashAndCashEquivalentsAtCarryingValue). A concept absent for the filer is OMITTED (never 0)."),
    unit: z
        .string()
        .default("USD")
        .describe("XBRL unit to extract, default 'USD'. A concept present only in another unit (e.g. EarningsPerShareBasic in 'USD/shares') is reported under wrongUnit with a note — never a silent 0."),
    latest: z
        .boolean()
        .default(false)
        .describe("true ⇒ reduce each concept to its single most-recent data point (by period end). false (default) ⇒ the full reported time series."),
});
// ADR-0017. Keyless cross-filer XBRL cross-section over data.sec.gov/api/xbrl/
// frames. taxonomy/tag/unit/period are RAW PATH SEGMENTS, so the enum + the three
// regexes below ARE the SSRF guard (re-run belt-and-suspenders in the handler's
// URL builder). `limit`/`offset` window the already-fully-fetched cross-section
// CLIENT-SIDE (they do NOT reduce the fetch). taxonomy enum = live-confirmed only.
const EdgarXbrlFramesInput = z.object({
    tag: z
        .string()
        .regex(/^[A-Za-z0-9]+$/, "tag must be alphanumeric only — an EXACT XBRL concept tag (e.g. 'Assets', 'Revenues'). Slash/dot/space/percent/'..' are rejected (path-segment injection guard).")
        .describe("XBRL concept tag — EXACT, alphanumeric only (e.g. 'Assets', 'Revenues', 'NetIncomeLoss', 'EarningsPerShareBasic'). A non-matching tag ⇒ upstream 404 ⇒ found:false (never a fabricated 0)."),
    period: z
        .string()
        .regex(/^CY\d{4}(Q[1-4]I?)?$/, "period must be CY{yyyy} (annual flow, e.g. CY2023), CY{yyyy}Q{n} (quarterly flow, e.g. CY2023Q1), or CY{yyyy}Q{n}I (instant, trailing I, e.g. CY2023Q4I).")
        .describe("Calendar period frame: CY2023 (annual flow) · CY2023Q1 (quarterly flow, no I) · CY2023Q4I (instant / balance-sheet, trailing I). Instant concepts (e.g. Assets) REQUIRE the trailing I; a mismatch ⇒ 404 ⇒ found:false."),
    taxonomy: z
        .enum(edgar.FRAMES_TAXONOMIES)
        .default("us-gaap")
        .describe("XBRL taxonomy namespace (a fixed enum — the SSRF guard for this segment): 'us-gaap' (financial statements, default) or 'dei' (entity/document info, e.g. EntityCommonStockSharesOutstanding, EntityPublicFloat). Live-confirmed members only."),
    unit: z
        .string()
        .regex(/^[A-Za-z0-9-]+$/, "unit must match ^[A-Za-z0-9-]+$ — hyphen allowed (e.g. 'USD-per-shares'); slash/dot/percent forbidden (never the 'USD/shares' companyfacts key form).")
        .default("USD")
        .describe("XBRL unit of measure, as a path segment: 'USD' (default), 'shares', 'USD-per-shares' (EPS — HYPHEN, never 'USD/shares'), 'pure'. A valid-shaped but wrong unit ⇒ 404 ⇒ found:false."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("CLIENT-SIDE page size over the already-fully-fetched cross-section (1..1000, default 100). Does NOT reduce the upstream fetch — the whole frame is fetched in one call; this only windows the returned rows (page via _meta.pagination.nextOffset)."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based client-side offset into the fetched cross-section (default 0). Page via _meta.pagination.nextOffset to reach every filer."),
    includeStats: z
        .boolean()
        .default(false)
        .describe("When true, compute a summary distribution { count, min, max, sum, mean, median, p25, p75, nonFiniteExcluded } over the FULL cross-section (ALL rows, BEFORE the client-side slice), using linear-interpolated percentiles over the FINITE vals only. count===0 (no finite vals) ⇒ every stat is null (never 0/NaN/Infinity)."),
});
const EdgarFullTextSearchInput = z.object({
    q: z
        .string()
        .min(1)
        .describe("Full-text query over EDGAR filings (2001-present). Wrap a phrase in double quotes for an exact match (e.g. '\"climate risk\"')."),
    forms: z
        .array(z.string())
        .optional()
        .describe("Optional form-type filter (e.g. ['10-K','8-K'])."),
    startdt: z
        .string()
        .optional()
        .describe("Optional ISO YYYY-MM-DD filing-date lower bound (sets dateRange=custom)."),
    enddt: z
        .string()
        .optional()
        .describe("Optional ISO YYYY-MM-DD filing-date upper bound (sets dateRange=custom)."),
    ciks: z
        .array(z.string())
        .max(50)
        .optional()
        .describe("Optional: pin filings BY one or more entities, by NUMERIC SEC CIK (each is zero-padded to 10 digits — an EXACT-entity match). Multiple CIKs are AND-of-OR (any of the listed entities). A ticker/company name / CIK-0 entry is rejected as invalid_input — use `entityName` or resolve the CIK first with edgar_lookup_cik."),
    entityName: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Optional FUZZY filer-name narrowing (matches the filer's display name; NOT CIK-exact — can match related entities, e.g. multiple 'Apple*' filers). Combine with `ciks` for an exact-entity result."),
    from: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based result offset for pagination; page size is FIXED at 100 (there is no size param). Must be <= 9900 (from+100 ≤ 10000 upstream window); a larger from is rejected as invalid_input."),
});
// ADR-0026. Keyless BULK cross-filer capability on the EXISTING edgar source: the
// SEC EDGAR quarterly full-index (www.sec.gov/Archives/edgar/full-index/<year>/
// QTR<n>/master.idx). year/quarter are the ONLY path segments (bounded integers —
// the SSRF guard, re-checked belt-and-suspenders pre-fetch in edgar's
// buildFullIndexUrl). ALL other params are CLIENT-SIDE filters over the whole
// downloaded body (ZERO query string reaches the wire). The year UPPER bound
// (≤ current UTC year) is enforced at CALL time in the handler, NOT baked into Zod,
// so the tools/list snapshot stays deterministic across a year rollover.
const EdgarFilingIndexInput = z.object({
    year: z
        .number()
        .int()
        .min(1993)
        .describe("Filing year (>= 1993 — EDGAR full-index begins 1993 Q1). Must be <= the current year; a future year is rejected as invalid_input with 0 fetch. Path segment."),
    quarter: z
        .number()
        .int()
        .min(1)
        .max(4)
        .describe("Calendar quarter 1..4 (path segment QTR<quarter>). A same-year FUTURE quarter returns a well-formed EMPTY result (genuine-empty, complete:true), NOT an error."),
    formType: z
        .string()
        .min(1)
        .max(30)
        .optional()
        .describe("Optional CLIENT-SIDE filter: case-insensitive EXACT match on the Form Type column (e.g. '8-K', '10-K'). '8-K' does NOT match '8-K/A' — pass each amendment variant separately."),
    cik: z
        .union([z.string().regex(/^\d{1,10}$/), z.number().int().nonnegative()])
        .optional()
        .describe("Optional CLIENT-SIDE filter: numeric SEC CIK (1-10 digits or a number), matched leading-zero-safe via padCik on both sides (so '320193' and '0000320193' match the same filer)."),
    companyContains: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Optional CLIENT-SIDE filter: case-insensitive LITERAL substring on the Company Name column. A multi-word value matches as ONE contiguous string (NOT AND/OR-tokenized)."),
    dateFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Optional CLIENT-SIDE filter: keep filings whose Date Filed >= this ISO YYYY-MM-DD (string compare; the column is already YYYY-MM-DD)."),
    dateTo: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Optional CLIENT-SIDE filter: keep filings whose Date Filed <= this ISO YYYY-MM-DD."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Page size over the FILTERED, full-scanned matches (1..1000, default 100). Does NOT reduce the download — the whole quarter is scanned; this only windows the returned rows (page via _meta.pagination.nextOffset)."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based offset into the filtered matches (default 0)."),
});
// ─── EDGAR daily-index (ADR-0027) — input schema ─────────────────
// The per-DAY sibling of edgar_filing_index. A single required ISO `date`
// (YYYY-MM-DD) is the ONLY caller value that shapes the URL — the handler derives
// year/quarter/yyyymmdd from it and re-validates them belt-and-suspenders in
// edgar's buildDailyIndexUrl. dateFrom/dateTo are DROPPED (a single-day file has one
// date). ALL other params are CLIENT-SIDE filters over the whole downloaded body
// (ZERO query string reaches the wire). The date's EXACT calendar-day round-trip +
// the future-date rejection are enforced at CALL time in the handler (M2), so the
// tools/list snapshot stays deterministic across a day rollover.
const EdgarDailyFilingIndexInput = z.object({
    date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe("Required calendar day ISO YYYY-MM-DD (>= 1994-01-01 — EDGAR daily-index begins 1994 Q1). The handler derives year/quarter/yyyymmdd. A malformed / non-real day (2024-02-30, non-leap 2023-02-29) or a FUTURE date is rejected as invalid_input with 0 fetch. TODAY is allowed (its index may not be posted until ~22:00 US-Eastern)."),
    formType: z
        .string()
        .min(1)
        .max(30)
        .optional()
        .describe("Optional CLIENT-SIDE filter: case-insensitive EXACT match on the Form Type column (e.g. '8-K', '10-K'). '8-K' does NOT match '8-K/A' — pass each amendment variant separately."),
    cik: z
        .union([z.string().regex(/^\d{1,10}$/), z.number().int().nonnegative()])
        .optional()
        .describe("Optional CLIENT-SIDE filter: numeric SEC CIK (1-10 digits or a number), matched leading-zero-safe via padCik on both sides (so '320193' and '0000320193' match the same filer)."),
    companyContains: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Optional CLIENT-SIDE filter: case-insensitive LITERAL substring on the Company Name column. A multi-word value matches as ONE contiguous string (NOT AND/OR-tokenized)."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Page size over the FILTERED, full-scanned matches (1..1000, default 100). Does NOT reduce the download — the whole day is scanned; this only windows the returned rows (page via _meta.pagination.nextOffset)."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based offset into the filtered matches (default 0)."),
});
// ─── Socrata / SODA (keyless SLED + E-rate) — input schemas ──────
// ADR-0004. First SLED source. `domain` is a curated allowlist ENUM (the SSRF
// core — no free host); `datasetId` is a strict 4x4 with .length(9) (M2 — blocks
// a trailing-newline the regex `$` would admit). SoQL params are raw upstream-
// validated strings (a bad column ⇒ upstream 400 ⇒ invalid_input, surfaced).
const SocrataDomainEnum = z
    .enum(socrata.SOCRATA_DOMAINS)
    .describe("Which allowlisted Socrata portal to query (curated .gov hosts + USAC E-rate .org; the SSRF host allowlist — no free host). e.g. data.ny.gov, data.texas.gov, data.wa.gov, opendata.usac.org.");
const SocrataQueryInput = z.object({
    domain: SocrataDomainEnum,
    datasetId: z
        // M2 — a strict 4x4. NOTE: deliberately NO .trim(): Zod applies .trim()
        // BEFORE .length(9), so `.trim().length(9)` (the ADR's literal wording)
        // would STRIP a trailing "\n" to a valid 9-char id and ACCEPT it —
        // empirically confirmed — defeating the very newline rejection M2 wants.
        // Dropping .trim() makes .length(9) see the raw string, so any trailing
        // char (incl. "\n", which the regex `$` alone would admit) is rejected.
        .string()
        .length(9)
        .regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/)
        .describe("The dataset's Socrata 4x4 id, e.g. 'kwxv-fwze' (from socrata_discover_datasets). Exactly [a-z0-9]{4}-[a-z0-9]{4} (9 chars; no surrounding whitespace)."),
    select: z
        .string()
        .optional()
        .describe("Optional SoQL $select (column projection / aggregate), e.g. 'agency,SUM(amount)'."),
    where: z
        .string()
        .optional()
        .describe("Optional SoQL $where filter, e.g. \"fiscal_year='2024' AND amount>1000\". A bad column ⇒ upstream HTTP 400 ⇒ invalid_input (surfaced, never silent)."),
    order: z
        .string()
        .optional()
        .describe("Optional SoQL $order, e.g. 'amount DESC'."),
    q: z
        .string()
        .optional()
        .describe("Optional SoQL $q full-text search across the row."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Rows per page ($limit), 1..1000, default 100."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based row offset ($offset) for pagination, default 0."),
    withTotal: z
        .boolean()
        .default(true)
        .describe("true (default) ⇒ issue a count(*) companion query so totalAvailable is exact. false ⇒ skip it (one fewer request); totalAvailable is null and a note discloses results may be truncated at $limit."),
});
const SocrataDiscoverDatasetsInput = z.object({
    q: z
        .string()
        .min(1)
        .describe("Keyword(s) to find datasets, e.g. 'procurement', 'vendor payments', 'checkbook'."),
    domain: SocrataDomainEnum.optional().describe("Optional: scope discovery to ONE allowlisted portal. Omit to search the whole allowlist. NOTE: the federated catalog does not index every host (e.g. USAC E-rate returns 0) — those remain queryable via socrata_query with a known 4x4."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max datasets to return, 1..100, default 20."),
});
// ─── CKAN datastore_search (keyless SLED) — input schemas ───────
// ADR-0006. Second SLED source; FIRST on the R2 DataSource port. `host` is a
// curated allowlist ENUM (the SSRF core — no free host); `resourceId` is a strict
// 36-char lowercase UUID with .length(36) (m1 — the regex `$` already blocks a
// trailing "\n"; length is belt-and-suspenders; NO .trim(), NO `i` flag). `filters`
// is a CONSTRAINED object we JSON.stringify (Q3 — never a raw string). A bad
// filter field / sort ⇒ upstream 409 ⇒ invalid_input (surfaced, never silent).
const CkanHostEnum = z
    .enum(ckan.CKAN_HOSTS)
    .describe("Which allowlisted CKAN portal to query (curated .gov hosts — the SSRF host allowlist, no free host): data.ca.gov (CA), data.virginia.gov (VA — eVA), data.boston.gov (City of Boston Checkbook).");
const CkanQueryInput = z.object({
    host: CkanHostEnum,
    resourceId: z
        // m1 — a strict 36-char lowercase UUID. NO .trim() (Zod trims BEFORE
        // .length, which would strip a trailing "\n" to a valid id and defeat the
        // guard); the regex `$` alone rejects a trailing newline in JS, and
        // .length(36) is belt-and-suspenders. Lowercase-only ⇒ no `i` flag.
        .string()
        .length(36)
        .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        .describe("The datastore resource_id, a 36-char lowercase UUID e.g. 'bb82edc5-9c78-44e2-8947-68ece26197c5' (from ckan_discover_datasets, a datastoreActive:true resource)."),
    q: z
        .string()
        .optional()
        .describe("Optional full-text search across the record (CKAN `q`)."),
    filters: z
        .record(z.string(), z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]))
        .optional()
        .describe("Optional structured field filters, e.g. {\"Fiscal Year\":\"2013-2014\"}. A constrained object (string/number/array values only) that we JSON.stringify; a bad field ⇒ upstream HTTP 409 ⇒ invalid_input (surfaced, never silent)."),
    sort: z
        .string()
        .optional()
        .describe("Optional sort, e.g. '_id asc' or 'amount desc'. A bad field ⇒ 409 ⇒ invalid_input."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Rows per page, 1..1000, default 100."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based row offset for pagination, default 0."),
});
const CkanDiscoverDatasetsInput = z.object({
    host: CkanHostEnum,
    q: z
        .string()
        .min(1)
        .describe("Keyword(s) to find datasets, e.g. 'procurement', 'checkbook', 'vendor'."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Max datasets (packages) to return, 1..100, default 20."),
});
// ─── FDIC BankFind Suite (keyless institution directory + financials) ──────────
// ADR-0028. First OFF-EDGAR entity source. KEYLESS, fixed host api.fdic.gov +
// FIXED endpoint constants (the SSRF core — no free host/path). Structured
// inputs → a server-side filters/search builder (NAME/CITY route through FDIC's
// full-text `search`, NOT `filters` — M1). name/city char-class is a sanity
// boundary; the injection defense is the module's backslash-first phrase-escape
// (M2). sortBy is a Zod enum + a Set.has recheck in the builder (an unknown sort
// field is invalid_input before fetch).
// name/city char-class — includes `( ) #` so real bank names like 'Mizuho Bank
// (USA)' are NOT false-rejected (S2); these are literal inside the phrase-quoted
// + escaped `search` value, never ES metachars there.
const FdicNameCity = z
    .string()
    .regex(/^[A-Za-z0-9 .,&'\/()#\-]+$/)
    .describe("Free-text bank name / city fragment (letters, digits, spaces and . , & ' / ( ) # -). Matched by FDIC's case-insensitive full-text `search` (token match; a multi-word value is matched per-token, may be broader than a literal substring).");
const FdicSearchInstitutionsInput = z.object({
    state: z
        .string()
        .regex(/^[A-Z]{2}$/)
        .optional()
        .describe("Filter by 2-letter US state code (uppercase; → STALP filter). e.g. 'VA'."),
    activeOnly: z
        .boolean()
        .optional()
        .describe("Filter to active (true → ACTIVE:1) or inactive (false → ACTIVE:0) institutions; omit for both."),
    cert: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Filter by FDIC certificate number (the STABLE entity key; → CERT filter)."),
    name: FdicNameCity.optional().describe("Filter by institution NAME via FDIC full-text `search` (case-insensitive token match; NOT case-sensitive exact-keyword — that is why we route to `search`, not `filters`)."),
    city: FdicNameCity.optional().describe("Filter by CITY via FDIC full-text `search` (case-insensitive token match)."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Rows per page, 1..1000, default 100."),
    offset: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .default(0)
        .describe("0-based row offset for pagination, 0..100000, default 0."),
    sortBy: z
        .enum(["NAME", "CERT", "ASSET", "ESTYMD", "STALP", "CITY", "ACTIVE"])
        .optional()
        .describe("Optional sort field (an allowlisted enum; an unknown field is rejected before fetch)."),
    sortOrder: z
        .enum(["ASC", "DESC"])
        .default("ASC")
        .describe("Sort direction when sortBy is set, ASC (default) or DESC."),
});
const FdicInstitutionFinancialsInput = z.object({
    cert: z
        .number()
        .int()
        .min(1)
        .describe("REQUIRED FDIC certificate number of the institution (→ CERT filter). From fdic_search_institutions."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Rows per page, 1..1000, default 100."),
    offset: z
        .number()
        .int()
        .min(0)
        .max(100000)
        .default(0)
        .describe("0-based row offset for pagination, 0..100000, default 0."),
    sortBy: z
        .enum(["REPDTE", "ASSET", "DEP", "NETINC"])
        .default("REPDTE")
        .describe("Sort field (allowlisted enum; default REPDTE = report date)."),
    sortOrder: z
        .enum(["ASC", "DESC"])
        .default("DESC")
        .describe("Sort direction, default DESC (newest quarter first)."),
});
// ─── OpenFEMA (keyless disaster declarations + emergency-assistance spend) ──────
// ADR-0016. KEYLESS, fixed host www.fema.gov + a PINNED dataset registry
// {entityName, version} (the SSRF core — no free host/path/version). Filters are
// MODULE-BUILT from a per-tool, LIVE-VERIFIED field whitelist into an OData
// `$filter` (NO raw `$filter` arg exists — no injection surface); the module
// ALWAYS sends `$inlinecount=allpages` so metadata.count is the EXACT filtered
// total. Per-dataset field names DIFFER (M1): the PA tool's `state` maps to
// `stateAbbreviation`, the declarations tool's `state` maps to `state` — a shared
// user-facing arg over two different real OData fields. limit → $top (≤1000),
// offset → $skip.
// A 2-letter US state/territory code (uppercase; e.g. CA, LA, PR, DC). A bad value
// is NOT an SSRF vector (the fixed host + dataset registry are) — it just returns
// an honest genuine-empty (metadata.count:0), never a silent unfiltered set.
const FemaStateSchema = z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .describe("2-letter US state / territory code (e.g. 'CA', 'LA', 'PR', 'DC'). Uppercase per FEMA; a bad code returns an honest empty (count 0).");
// ISO date 'YYYY-MM-DD' or a full ISO datetime. A bare date = midnight-UTC start.
const FemaDateSchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?)?$/)
    .describe("ISO date 'YYYY-MM-DD' or full ISO datetime; a bare date is midnight-UTC start of that day.");
const FemaSearchPublicAssistanceInput = z.object({
    state: FemaStateSchema.optional().describe("Filter by applicant state (→ stateAbbreviation eq 'XX'). 2-letter code."),
    disasterNumber: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter by FEMA disaster number (→ disasterNumber eq N)."),
    applicantId: z
        .string()
        .min(1)
        .optional()
        .describe("Filter by applicant id (→ applicantId eq '...'). e.g. '015-UF5E0-00'."),
    damageCategoryCode: z
        .string()
        .min(1)
        .max(2)
        .optional()
        .describe("Filter by PA damage category code (→ damageCategoryCode eq 'X'). e.g. 'B' = Emergency Protective Measures, 'C'–'G' = permanent work."),
    incidentType: z
        .string()
        .min(1)
        .optional()
        .describe("Filter by incident type (→ incidentType eq '...'). e.g. 'Flood', 'Hurricane', 'Severe Storm'."),
    minProjectAmount: z
        .number()
        .optional()
        .describe("Minimum project amount (→ projectAmount ge N)."),
    maxProjectAmount: z
        .number()
        .optional()
        .describe("Maximum project amount (→ projectAmount le N)."),
    declaredDateFrom: FemaDateSchema.optional().describe("Earliest declaration date, inclusive (→ declarationDate ge 'ISO')."),
    declaredDateTo: FemaDateSchema.optional().describe("Latest declaration date, inclusive (→ declarationDate le 'ISO')."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Rows per page ($top), 1..1000, default 100."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based row offset ($skip) for pagination, default 0."),
});
const FemaDisasterDeclarationsInput = z.object({
    state: FemaStateSchema.optional().describe("Filter by state (→ state eq 'XX'). 2-letter code."),
    incidentType: z
        .string()
        .min(1)
        .optional()
        .describe("Filter by incident type (→ incidentType eq '...'). e.g. 'Flood', 'Hurricane', 'Winter Storm'."),
    declarationType: z
        .enum(["DR", "EM", "FM"])
        .optional()
        .describe("Filter by declaration type (→ declarationType eq 'XX'): DR (major disaster), EM (emergency), FM (fire management)."),
    fyDeclared: z
        .number()
        .int()
        .optional()
        .describe("Filter by fiscal year declared (→ fyDeclared eq N). e.g. 2024."),
    disasterNumber: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Filter by FEMA disaster number (→ disasterNumber eq N)."),
    declaredDateFrom: FemaDateSchema.optional().describe("Earliest declaration date, inclusive (→ declarationDate ge 'ISO')."),
    declaredDateTo: FemaDateSchema.optional().describe("Latest declaration date, inclusive (→ declarationDate le 'ISO')."),
    paProgramDeclared: z
        .boolean()
        .optional()
        .describe("Filter to declarations where the Public Assistance program was declared (→ paProgramDeclared eq true/false)."),
    iaProgramDeclared: z
        .boolean()
        .optional()
        .describe("Filter to declarations where the Individual Assistance program was declared (→ iaProgramDeclared eq true/false)."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Rows per page ($top), 1..1000, default 100."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based row offset ($skip) for pagination, default 0."),
});
// ─── EPA ECHO REST (keyless facility compliance/enforcement) — input schemas ──
// ADR-0009. KEYLESS, single fixed host (echodata.epa.gov) + three fixed service
// paths (the SSRF core — no free host/path). `state` is a curated US state/
// territory ENUM: it scopes the query (national is ~5.6M rows) AND is the
// silent-zero guard (ECHO does NOT validate filter VALUES, so an unknown value
// returns QueryRows:0 — indistinguishable from a genuine-empty). M2 (LIVE-verified
// 2026-07-12): `sic` DOES narrow (a real filter); `naics` is DROPPED upstream —
// exposed as BEST-EFFORT, disclosed in _meta.filtersDropped + notes, never
// silently presented as filtered.
const EchoStateEnum = z
    .enum(echo.ECHO_STATES)
    .describe("US state / territory 2-letter code to scope the search (REQUIRED — an unscoped national query is ~5.6M rows; the enum is also the SSRF value guard + the silent-zero guard). e.g. 'DC', 'TX', 'CA', 'PR'.");
const EchoSearchFacilitiesInput = z.object({
    state: EchoStateEnum,
    naics: z
        .string()
        .regex(/^[0-9]{2,6}$/)
        .optional()
        .describe("BEST-EFFORT industry filter (2–6 digit NAICS). WARNING: ECHO DROPS the NAICS filter upstream (live-verified 2026-07-12) — the returned facilities are NOT guaranteed to match this code; it is reported in _meta.filtersDropped + a note. Use `sic` (which DOES narrow) to scope by industry."),
    sic: z
        .string()
        .regex(/^[0-9]{2,4}$/)
        .optional()
        .describe("Industry filter (2–4 digit SIC code). A REAL filter — ECHO narrows by SIC (live-verified). A code with no facilities returns 0 (silent-zero — verify the code)."),
    facilityName: z
        .string()
        .min(1)
        .optional()
        .describe("Facility-name substring filter (p_fn). NOTE: not validated by ECHO — a typo silently returns 0 results, not an error."),
    majorOnly: z
        .boolean()
        .optional()
        .describe("true ⇒ only EPA 'major' facilities (p_maj=Y)."),
    federalOnly: z
        .boolean()
        .optional()
        .describe("true ⇒ only federal facilities (p_ff=Y)."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Facilities per page (→ responseset), 1..1000, default 100."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based offset for pagination, default 0. MUST be an exact multiple of `limit` (ECHO pages on fixed boundaries; a non-multiple ⇒ invalid_input)."),
});
const EchoFacilityReportInput = z.object({
    registryId: z
        .string()
        .regex(/^[0-9]{9,12}$/)
        .describe("The facility's FRS RegistryID (from echo_search_facilities rows' RegistryID) — an all-digit id, 9–12 digits (e.g. '110059768461'). A bad/unknown id ⇒ not_found (never a fabricated report)."),
});
// ─── api.data.gov keyed trio (Regulations.gov + Congress.gov) — input schemas ──
// ADR-0007. The project's FIRST KEYED source. The key is read from env
// (DATA_GOV_API_KEY, else the public DEMO_KEY) and travels ONLY in the X-Api-Key
// header — NEVER in a param here. M4 (Zod-first): page/limit bounds + sort/type
// enums + ISO date-time formats are validated LOCALLY so bad params fail as
// invalid_input BEFORE any fetch (Regulations.gov's page[number] is HARD-capped at
// 40 = a 10,000-record ceiling; page[size] must be 5..250).
const RegulationsSearchInput = z.object({
    searchTerm: z
        .string()
        .optional()
        .describe("Full-text search term (filter[searchTerm]), e.g. 'artificial intelligence'."),
    query: z
        .string()
        .optional()
        .describe("Alias for `searchTerm` (either is accepted; both feed filter[searchTerm])."),
    agencyId: z
        .string()
        .optional()
        .describe("Filter by posting agency acronym (filter[agencyId]), e.g. 'EPA', 'FDA'."),
    docketId: z
        .string()
        .optional()
        .describe("Filter by docket id (filter[docketId]), e.g. 'EPA-HQ-OAR-2021-0257'."),
    documentType: z
        .enum(datagov.REGULATIONS_DOCUMENT_TYPES)
        .optional()
        .describe("Filter by document type (documents only): Rule / Proposed Rule / Notice / Supporting & Related Material / Other."),
    withinCommentPeriod: z
        .boolean()
        .optional()
        .describe("true ⇒ only documents currently open for comment (documents only; filter[withinCommentPeriod])."),
    postedDateGe: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Posted on/after this date, YYYY-MM-DD (filter[postedDate][ge])."),
    postedDateLe: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Posted on/before this date, YYYY-MM-DD (filter[postedDate][le])."),
    sort: z
        .enum(datagov.REGULATIONS_SORTS)
        .optional()
        .describe("Sort order (default '-postedDate'). Live-verified set: -postedDate/postedDate/-lastModifiedDate/lastModifiedDate/-commentEndDate (non-exhaustive)."),
    pageNumber: z
        .number()
        .int()
        .min(1)
        .max(40)
        .default(1)
        .describe("1-based page number, 1..40 (HARD cap — page[number] max is 40; the reachable window is 40×pageSize ≤ 10,000 records)."),
    pageSize: z
        .number()
        .int()
        .min(5)
        .max(250)
        .default(25)
        .describe("Records per page (page[size]), 5..250, default 25."),
});
const CongressSearchBillsInput = z.object({
    query: z
        .string()
        .optional()
        .describe("Keyword — NOTE: Congress.gov /v3/bill has NO keyword search, so this is NOT applied (disclosed in _meta.filtersDropped). Use congress/billType/date filters instead."),
    congress: z
        .number()
        .int()
        .min(1)
        .max(999)
        .optional()
        .describe("Congress number, e.g. 118 (scopes the path to /v3/bill/{congress})."),
    billType: z
        .enum(datagov.CONGRESS_BILL_TYPES)
        .optional()
        .describe("Bill type: hr/s/hjres/sjres/hconres/sconres/hres/sres. Requires `congress` (path /v3/bill/{congress}/{billType})."),
    fromDateTime: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("Filter to bills updated at/after this ISO-8601 date-time with offset, e.g. '2024-01-01T00:00:00Z'."),
    toDateTime: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe("Filter to bills updated at/before this ISO-8601 date-time with offset, e.g. '2024-12-31T23:59:59Z'."),
    offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("0-based record offset for pagination, default 0."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(250)
        .default(20)
        .describe("Records per page, 1..250, default 20."),
});
const CongressGetBillInput = z.object({
    congress: z
        .number()
        .int()
        .min(1)
        .max(999)
        .describe("Congress number, e.g. 117."),
    billType: z
        .enum(datagov.CONGRESS_BILL_TYPES)
        .describe("Bill type: hr/s/hjres/sjres/hconres/sconres/hres/sres."),
    billNumber: z
        .number()
        .int()
        .min(1)
        .describe("Bill number, e.g. 3076 (for H.R.3076)."),
});
// ─── GovInfo (api.govinfo.gov — the api.data.gov keyed trio's 3rd API) ─
// ADR-0010. Same DATA_GOV_API_KEY/DEMO_KEY/X-Api-Key discipline as the datagov
// trio (shared datagovKey.ts seam). `collection` is grammar-checked here AND
// validated against the live /collections catalog in the handler (the silent-empty
// guard). The novel piece is the OPAQUE `offsetMark` cursor: continuation rides in
// _meta.nextCursor (passed back as pageMark), never a numeric offset.
const GovinfoListCollectionsInput = z.object({});
const GovinfoSearchPackagesInput = z.object({
    collection: z
        .string()
        .regex(govinfo.GOVINFO_COLLECTION_RE, "collection must be an uppercase alpha GovInfo code like BILLS/CFR/FR/PLAW ([A-Z]{2,10}).")
        .describe("GovInfo collection code (uppercase alpha), e.g. BILLS, PLAW, CREC, USCODE, CFR, FR, BUDGET, GAOREPORTS. Validated against the live /collections catalog — an unknown code returns invalid_input listing valid codes (never a misleading empty). Use govinfo_list_collections to discover codes."),
    startDate: z
        .string()
        .regex(govinfo.GOVINFO_DATE_RE, "startDate must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ.")
        .describe("Lower bound on lastModified (the record's last-update date, NOT dateIssued), YYYY-MM-DD (normalized to T00:00:00Z) or a full ISO datetime. e.g. '2024-01-01'."),
    endDate: z
        .string()
        .regex(govinfo.GOVINFO_DATE_RE, "endDate must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ.")
        .optional()
        .describe("Optional upper bound on lastModified (same format as startDate)."),
    pageSize: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe("Rows per page (upstream pageSize), 1..1000, default 100."),
    pageMark: z
        .string()
        .regex(govinfo.GOVINFO_PAGE_MARK_RE, 'pageMark must be "*" or the opaque _meta.nextCursor from the previous page (≤4096 base64/URL-safe chars).')
        .default("*")
        .describe('Opaque continuation cursor. Default "*" (first page). To page, pass back the previous response\'s _meta.nextCursor (NOT a numeric offset — GovInfo uses an opaque cursor).'),
});
const GovinfoGetPackageInput = z.object({
    packageId: z
        .string()
        .regex(govinfo.GOVINFO_PACKAGE_ID_RE, "packageId must be a GovInfo id like BILLS-118hr1enr / CFR-2023-title1-vol1 ([A-Za-z0-9][A-Za-z0-9._-]{2,}).")
        .describe("GovInfo packageId from govinfo_search_packages (e.g. 'BILLS-118hr1enr', 'PLAW-117publ58', 'CFR-2023-title1-vol1', 'GAOREPORTS-GAO-24-106221')."),
});
// ─── FPDS-NG (www.fpds.gov ezSearch ATOM — keyless XML/ATOM) ─── ADR-0012
// The FIRST XML/ATOM source. Structured filters ONLY (NO raw-q — a typo'd field
// name is a SILENT ZERO in FPDS, so the module builds the fielded `q`). At least
// one filter is REQUIRED (refuse a bare unbounded scan). Dates are ISO
// YYYY-MM-DD (reformatted to YYYY/MM/DD internally). `offset` is the 0-indexed
// page start (page size fixed at 10); keyless deep-paging past ~200K is
// unreliable so it is capped at 600000.
const FPDS_ISO_DATE = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be ISO YYYY-MM-DD.");
const FpdsSearchAwardsInput = z
    .object({
    naics: z
        .string()
        .optional()
        .describe("Principal NAICS code (→ PRINCIPAL_NAICS_CODE), e.g. '541511'."),
    vendorName: z
        .string()
        .optional()
        .describe("Vendor/contractor name phrase (→ VENDOR_NAME), e.g. 'LOCKHEED MARTIN'."),
    piid: z
        .string()
        .optional()
        .describe("Contract/order PIID (→ PIID) — returns that action's full base+mod chain."),
    departmentId: z
        .string()
        .optional()
        .describe("4-digit contracting DEPARTMENT_ID, e.g. '9700' (DoD), '4700' (GSA)."),
    contractingAgencyName: z
        .string()
        .optional()
        .describe("Contracting agency name phrase (→ CONTRACTING_AGENCY_NAME), e.g. 'DEPT OF DEFENSE'."),
    signedDateFrom: FPDS_ISO_DATE.optional().describe("Signed-date range START (ISO YYYY-MM-DD); pair with signedDateTo (→ SIGNED_DATE:[from,to])."),
    signedDateTo: FPDS_ISO_DATE.optional().describe("Signed-date range END (ISO YYYY-MM-DD); pair with signedDateFrom."),
    lastModifiedFrom: FPDS_ISO_DATE.optional().describe("Last-modified range START (ISO YYYY-MM-DD); pair with lastModifiedTo (→ LAST_MOD_DATE:[from,to])."),
    lastModifiedTo: FPDS_ISO_DATE.optional().describe("Last-modified range END (ISO YYYY-MM-DD); pair with lastModifiedFrom."),
    keyword: z
        .string()
        .optional()
        .describe("Free-text keyword (bare full-text term; FPDS FIELD: operators are stripped for safety)."),
    offset: z
        .number()
        .int()
        .min(0)
        .max(600_000)
        .default(0)
        .describe("0-indexed page start (page size fixed at 10). Keyless deep-paging past ~200K is unreliable."),
})
    .refine((a) => a.naics !== undefined ||
    a.vendorName !== undefined ||
    a.piid !== undefined ||
    a.departmentId !== undefined ||
    a.contractingAgencyName !== undefined ||
    (a.signedDateFrom !== undefined && a.signedDateTo !== undefined) ||
    (a.lastModifiedFrom !== undefined && a.lastModifiedTo !== undefined) ||
    a.keyword !== undefined, {
    message: "Provide at least one filter (naics, vendorName, piid, departmentId, contractingAgencyName, a signedDate range, a lastModified range, or keyword) — a bare unbounded FPDS scan is refused.",
});
// ─── NIH RePORTER v2 (api.reporter.nih.gov — keyless POST/JSON) ─── ADR-0014
// The R2 getJson port's FIRST non-GET consumer. A NEW capability axis: federal
// research-GRANT funding footprint by organization / UEI / state (recipient
// enrichment, joinable to SAM/USAspending via primary_uei). The SSRF surface is
// a compile-time-CONSTANT URL; all filters ride in the MODULE-BUILT POST body.
// Only LIVE-CONFIRMED-narrowing criteria are exposed (M1): orgStates / orgNames /
// fiscalYears. agency_ic_codes is EXCLUDED (it silently no-ops upstream). The
// 15,000-record retrieval window is enforced by offset .max(14_999) (offset ≥
// 15,000 ⇒ invalid_input, 0 fetch) + limit .max(500) — a cap on RETRIEVAL, not
// on the exact meta.total count.
const NIH_CURRENT_YEAR = new Date().getUTCFullYear();
const NihSearchProjectsInput = z.object({
    orgStates: z
        .array(z.enum(nih.NIH_ORG_STATES))
        .max(20)
        .optional()
        .describe("Recipient-organization US state/territory 2-letter USPS codes (UPPERCASE — the enum is the SSRF value guard + the silent-zero guard: a lowercase 'ca' or an unknown 'ZZ' silently returns zeros, so a typo is an invalid_input, never read as 'no NIH funding'). LIVE-CONFIRMED to narrow. e.g. ['CA','MA']. Max 20."),
    orgNames: z
        .array(z.string().min(1).max(512))
        .max(20)
        .optional()
        .describe("Recipient-organization name filter values (each ≤512 chars, max 20). LIVE-CONFIRMED to narrow. e.g. ['MASSACHUSETTS INSTITUTE OF TECHNOLOGY']. A value matching no org returns a genuine total:0."),
    fiscalYears: z
        .array(z.number().int().min(1985).max(NIH_CURRENT_YEAR + 1))
        .max(20)
        .optional()
        .describe(`NIH fiscal years to include (int array, ${1985}..${NIH_CURRENT_YEAR + 1}, max 20). LIVE-CONFIRMED to narrow. e.g. [2023,2024].`),
    limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe("Projects per page (upstream hard cap 500), 1..500, default 50."),
    offset: z
        .number()
        .int()
        .min(0)
        .max(14_999)
        .default(0)
        .describe("0-based offset into the result set. HARD-CAPPED at 14,999: NIH caps keyless retrieval at the first 15,000 records (offset 0..14,999), so offset ≥ 15,000 is refused (invalid_input) — narrow criteria to reach records beyond the window. The count (totalAvailable) stays EXACT past the window."),
});
// ─── NSF Awards API (api.nsf.gov — keyless GET) ─── ADR-0020 (source #20)
// The grant-SIBLING of NIH RePORTER on a DIFFERENT agency: federal research-GRANT
// award records with recipient / PI / UEI enrichment, strengthening the WEAK
// entity/recipient layer (ueiNumber/parentUeiNumber join to SAM/USAspending). The
// SSRF surface is a compile-time-CONSTANT host+path; all filters ride in a
// module-built URLSearchParams from a validated whitelist. Only LIVE-CONFIRMED-
// narrowing filters ship (M1); agency + printFields are EXCLUDED (agency = the
// NSF-only-corpus zeros-out foot-gun; printFields = a proven no-op). The 10,000-
// record retrieval window (offset+rpp ≤ 10,000) is enforced by offset .max(9999)
// + a module-side outgoing-rpp clamp. Dates are STRICT mm/dd/yyyy (a wrong format
// is silently mis-parsed by NSF); a multi-word keyword is OR-tokenized (disclosed).
const NSF_UEI_RE = /^[A-Za-z0-9]{12}$/;
const NSF_MMDDYYYY_RE = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;
const NsfSearchAwardsInput = z.object({
    keyword: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Free-text search over title/abstract. NOTE: NSF OR-tokenizes a MULTI-WORD keyword (matches ANY word, not the phrase — 'machine learning' = machine OR learning, a far broader set; disclosed in _meta.notes). Use a single distinctive word or add a scoping filter for a precise set."),
    awardeeStateCode: z
        .enum(nsf.NSF_STATES)
        .optional()
        .describe("Awardee-organization US state/territory 2-letter USPS code (UPPERCASE — the enum is the SSRF value guard + the silent-zero guard: a non-state typo silently returns 0 awards on NSF, indistinguishable from 'no NSF funding', so it is an invalid_input). LIVE-CONFIRMED to narrow. e.g. 'CA'."),
    awardeeName: z
        .string()
        .min(2)
        .max(200)
        .optional()
        .describe("Awardee-organization name filter (2..200 chars). LIVE-CONFIRMED to narrow (a top recipient like 'Johns Hopkins University' may still saturate at the 10,000 count cap)."),
    ueiNumber: z
        .string()
        .regex(NSF_UEI_RE)
        .optional()
        .describe("Awardee UEI — a 12-char alphanumeric SAM/USAspending Unique Entity ID (uppercase-normalized before sending). LIVE-CONFIRMED an EXACT recipient-graph filter (the clean SAM/USAspending join). e.g. 'FTMTDMBR29C7' (Johns Hopkins)."),
    parentUeiNumber: z
        .string()
        .regex(NSF_UEI_RE)
        .optional()
        .describe("Parent-organization UEI — a 12-char alphanumeric UEI for the awardee's parent entity (uppercase-normalized). LIVE-CONFIRMED an EXACT narrow (the parent-org roll-up join). e.g. 'GS4PNKTRNKL3'."),
    pdPIName: z
        .string()
        .min(2)
        .max(120)
        .optional()
        .describe("Principal-investigator name filter (2..120 chars). LIVE-CONFIRMED to narrow. e.g. 'Bell'."),
    dateStart: z
        .string()
        .regex(NSF_MMDDYYYY_RE)
        .optional()
        .describe("Award ACTION-date lower bound (the initial award/obligation date, NOT the project startDate — live-verified). STRICT mm/dd/yyyy; a wrong format (yyyy-mm-dd) is silently mis-parsed by NSF (not an error), so it is rejected. e.g. '01/01/2024'."),
    dateEnd: z
        .string()
        .regex(NSF_MMDDYYYY_RE)
        .optional()
        .describe("Award ACTION-date upper bound. STRICT mm/dd/yyyy (same semantics/foot-gun as dateStart). e.g. '12/31/2024'."),
    limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(25)
        .describe("Awards per page (→ NSF rpp), 1..100, default 25. The OUTGOING page size is clamped so offset+rpp ≤ 10,000 (crossing NSF's retrieval window triggers a FATAL)."),
    offset: z
        .number()
        .int()
        .min(0)
        .max(9999)
        .default(0)
        .describe("0-based offset. HARD-CAPPED at 9,999: NSF caps keyless retrieval at the first 10,000 records (offset+rpp ≤ 10,000), so offset ≥ 10,000 is refused (invalid_input) — narrow criteria to bring the set under 10,000."),
});
const NsfGetAwardInput = z.object({
    awardId: z
        .string()
        .regex(/^\d{5,9}$/)
        .describe("NSF award id — an all-digit id (5..9 digits; NSF ids are 7-digit numeric, live-verified). Returns the ONE full award record INCLUDING abstractText; a nonexistent id ⇒ found:false (never a fabricated record). e.g. '2545697'."),
});
// ─── ClinicalTrials.gov API v2 (ADR-0021, source #21) ────────────
const ClinicaltrialsSearchStudiesInput = z.object({
    "query.term": z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Broad free-text search across the study record. MULTI-WORD is AND-conjunctive — ALL tokens must co-occur ('breast cancer' = breast AND cancer; disclosed in _meta.notes). LIVE-CONFIRMED to narrow. e.g. 'cancer'."),
    sponsor: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Lead-sponsor / collaborator NAME search (→ query.spons; a fuzzy full-text name search, NOT an exact-entity join — the name is free text, not a UEI). MULTI-WORD is AND-conjunctive. LIVE-CONFIRMED to narrow. e.g. 'Pfizer'."),
    condition: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Condition / disease filter (→ query.cond). MULTI-WORD is AND-conjunctive. LIVE-CONFIRMED to narrow. e.g. 'diabetes'."),
    location: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Study-location filter (→ query.locn), e.g. a country or city. LIVE-CONFIRMED to narrow. e.g. 'Germany'."),
    overallStatus: z
        .enum(clinicaltrials.CT_STATUSES)
        .optional()
        .describe("Recruitment/overall status (→ filter.overallStatus). A frozen 14-value enum (COMPLETED, RECRUITING, TERMINATED, …); an unlisted value LOUD-fails at HTTP 400 upstream, so it is rejected pre-fetch. LIVE-CONFIRMED to narrow. e.g. 'RECRUITING'."),
    funderType: z
        .enum(clinicaltrials.CT_FUNDER_TYPES)
        .optional()
        .describe("Funding-source facet (→ aggFilters=funderType:<v>) — the FEDERAL-funding axis. A frozen 4-value enum: nih, fed, industry, other (the B2G-relevant nih/fed narrow to federally-sponsored trials). An UNLISTED value silently returns totalCount:0 at HTTP 200 (a fake-empty trap), so it is rejected pre-fetch (invalid_input). funderType is an OVERLAPPING facet — counts MUST NOT be summed into a total."),
    pageSize: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(20)
        .describe("Studies per page, 1..1000, default 20 (ClinicalTrials.gov clamps a larger request to 1000)."),
    pageToken: z
        .string()
        .min(1)
        .max(4096)
        .regex(clinicaltrials.CT_TOKEN_RE)
        .optional()
        .describe("Opaque continuation cursor — pass back the _meta.nextCursor from the previous page. Pagination is a cursor, NOT a numeric offset (offset/nextOffset are null); nextCursor:null means the last page. A bad token loud-fails at HTTP 400."),
});
const ClinicaltrialsGetStudyInput = z.object({
    nctId: z
        .string()
        .regex(clinicaltrials.CT_NCT_RE)
        .describe("NCT id — the form NCT followed by exactly 8 digits (e.g. NCT02403869). Returns the ONE full study record INCLUDING briefSummary; a nonexistent id ⇒ found:false (never a fabricated record). Injection-safe (validated before the path is built)."),
});
// ADR-0024 — the facet-counts field enum is DERIVED from clinicaltrials.CT_FACET_FIELDS
// (single source of truth; the handler re-validates each element against the frozen
// Set INLINE — the [ssrf] re-guard). 1..11 whitelisted ENUM fields, comma-joined
// module-built into fields=<v1,v2,…> (NO raw passthrough); a non-member ⇒ invalid_input
// pre-fetch (0 fetch). No filter/scope/page param (they HTTP-400 here).
const ClinicaltrialsFacetCountsInput = z.object({
    fields: z
        .array(z.enum(clinicaltrials.CT_FACET_FIELDS))
        .min(1)
        .max(clinicaltrials.CT_FACET_FIELDS.length)
        .describe("1..11 ClinicalTrials.gov ENUM facet fields (deduped in-handler): OverallStatus, StudyType, Phase, LeadSponsorClass (★ the funding-SOURCE-class distribution — NIH/FED/OTHER_GOV/INDUSTRY/…, distinct from the search tool's 4-value funderType filter), Sex, DesignAllocation, DesignPrimaryPurpose, DesignInterventionModel, DesignMasking, DesignObservationalModel, DesignTimePerspective. Each returns the EXACT whole-registry per-value study-count distribution. An unlisted field ⇒ invalid_input pre-fetch (0 fetch). Phase is ARRAY-valued (counts OVERLAP — see _meta)."),
});
// ─── US Census Geocoder (keyless source #22) — input schemas ──────
// ADR-0023. KEYLESS, single fixed host (geocoding.geo.census.gov) + two fixed
// endpoint paths (the SSRF core — no free host/path; NO id in the path). benchmark /
// vintage are frozen enums (the Zod source of truth = census.CENSUS_BENCHMARKS /
// census.CENSUS_VINTAGES). [M2] CENSUS_VINTAGES is the UNION of live-valid vintages
// across the four benchmarks (25 distinct) so a VALID non-default pair is not Zod-
// rejected; an INVALID (benchmark,vintage) pair fails-closed at HTTP 400. GEOIDs are
// strings (leading zeros survive). Coordinate finiteness is re-guarded in the handler.
const CensusBenchmarkEnum = z
    .enum(census.CENSUS_BENCHMARKS)
    .optional()
    .describe("Address-range benchmark (default Public_AR_Current — a MOVING benchmark). One of Public_AR_Current / Public_AR_ACS2025 / Public_AR_LUCA / Public_AR_Census2020. vintage MUST be compatible with this benchmark (a matrix); an incompatible pair fails-closed with an HTTP 400.");
const CensusVintageEnum = z
    .enum(census.CENSUS_VINTAGES)
    .optional()
    .describe("Geography vintage (default Current_Current — a MOVING vintage; the same address may return a different tract/CD across cycles). The valid vintage set DEPENDS on the benchmark (a matrix — this enum is the UNION across all four benchmarks); an incompatible (benchmark, vintage) pair fails-closed with an HTTP 400 (invalid_input), never a silent mis-resolution. e.g. Census2020_Census2020 (with Public_AR_Census2020), Census2010_Current.");
const CensusGeocodeAddressInput = z.object({
    address: z
        .string()
        .min(1)
        .max(500)
        .describe("A one-line US address, e.g. '600 Dexter Ave, Montgomery, AL 36104'. An unmatched/under-specified address is NOT an error — it returns matches:[] / matchCount:0 (a genuine empty; add city, state, ZIP). An ambiguous address may return MULTIPLE matches, each with its own matchedAddress + geographies."),
    benchmark: CensusBenchmarkEnum,
    vintage: CensusVintageEnum,
});
const CensusGeographiesByCoordinatesInput = z
    .object({
    longitude: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe("Longitude (x), a finite number in [-180, 180]. Alias of `x`. e.g. -86.301883."),
    latitude: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe("Latitude (y), a finite number in [-90, 90]. Alias of `y`. e.g. 32.377612."),
    x: z
        .number()
        .min(-180)
        .max(180)
        .optional()
        .describe("Longitude — the Census API's own name for longitude (alias of `longitude`)."),
    y: z
        .number()
        .min(-90)
        .max(90)
        .optional()
        .describe("Latitude — the Census API's own name for latitude (alias of `latitude`)."),
    benchmark: CensusBenchmarkEnum,
    vintage: CensusVintageEnum,
})
    .refine((v) => v.longitude !== undefined || v.x !== undefined, {
    message: "longitude (or its alias x) is required.",
    path: ["longitude"],
})
    .refine((v) => v.latitude !== undefined || v.y !== undefined, {
    message: "latitude (or its alias y) is required.",
    path: ["latitude"],
});
// Build a ToolDef whose `handler` is type-checked against the schema's inferred
// input `I` at the call site (e.g. `input.searchText` is known-present). The
// `I` binding is erased to `any` in the ToolDef[] array, so entries without a
// handler need not use this helper.
function defineTool(d) {
    return d;
}
const TOOLS = [
    // ━━━ SAM.gov (8) ━━━
    defineTool({
        name: "sam_search_opportunities",
        description: "Search SAM.gov federal contracting opportunities (keyless HAL). Returns up to 50 active notices with title, agency, NAICS, noticeId. Use for discovery — narrow with NAICS / agency / set-aside / state.",
        inputSchema: SamSearchInput,
        handler: async (input, { sam }) => {
            const r = await sam.searchOpportunities({
                ...input,
                setAside: input.setAside,
            });
            // OUTAGE HONESTY (C19). r.degraded is set ONLY when EVERY access tier
            // threw (HAL down / network / 5xx-after-retry) — a total outage, NOT a
            // confirmed zero. searchOpportunities otherwise returns the real result
            // (incl. a genuine 0). Emit an explicitly-incomplete `_meta`: we do NOT
            // know the count (totalAvailable:null, NEVER 0), the source is flagged
            // degraded, the data count is null (not a fake 0 that reads as a real
            // count), and a note tells the AI to retry rather than conclude "no
            // matching notices". The genuine-zero + healthy paths below are UNCHANGED.
            if (r.degraded) {
                return withMeta({
                    totalRecords: null,
                    returned: 0,
                    opportunities: [],
                }, {
                    source: "sam.gov/sgs/v1 (keyless HAL) (DEGRADED — search backend unavailable)",
                    keylessMode: sam.isKeyless,
                    complete: false,
                    totalAvailable: null,
                    returned: 0,
                    filtersApplied: [],
                    filtersDropped: [],
                    fieldsUnavailable: [],
                    notes: [
                        r.degraded.reason +
                            " This is a service outage, not a confirmed zero — retry.",
                    ],
                });
            }
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
                // ── GSA-CSV inline enrichment (opt-in, non-blocking) ──────────────
                // The keyless HAL list payload nulls each row's naics/setAside/PoP/
                // deadline/type. When the GSA-CSV backbone is ENABLED and its index is
                // already warm, fill those nulls from today's snapshot in ONE lookup —
                // instead of N sam_get_opportunity detail calls. HARD guarantees:
                //   - DISABLED (default) → resolveCsvConfig().enabled is false, so we
                //     never enter this branch: `data`, fieldsUnavailable and notes are
                //     byte-for-byte the pre-enrichment behavior, and ZERO network hits
                //     the CSV.
                //   - NON-BLOCKING → tryGetReadyIndex returns the already-loaded index
                //     or null immediately (kicking a background warm); a cold CSV NEVER
                //     stalls the search on a 225 MB download.
                //   - A CSV error can't fail the search: tryGetReadyIndex swallows and
                //     returns null → we degrade to the un-enriched page + a note.
                const csvCfg = gsaCsv.resolveCsvConfig();
                // Widen the opportunities element type so the enriched rows (which may
                // carry the added type/placeOfPerformance keys) are assignable; the
                // original `data` (narrower) widens into this cleanly.
                let enrichedData = data;
                // The fields still null after enrichment (rebuilt truthfully below).
                let fieldsUnavailable = ["naics", "setAside", "placeOfPerformance"];
                const enrichmentNotes = [];
                let source = "sam.gov/sgs/v1 (keyless HAL)";
                let freshness = undefined;
                if (csvCfg.enabled) {
                    const ready = data.returned > 0 ? gsaCsv.tryGetReadyIndex(csvCfg) : null;
                    if (ready) {
                        const outcome = gsaCsv.enrichSearchOpportunities(enrichedData.opportunities, ready);
                        enrichedData = { ...data, opportunities: outcome.opportunities };
                        freshness = outcome.freshness;
                        source = "sam.gov/sgs/v1 (keyless HAL) + gsa-csv (daily bulk CSV snapshot)";
                        // Rebuild fieldsUnavailable: a field is only "unavailable" if it was
                        // NOT filled on the whole page. Fields filled from the CSV drop off.
                        // (naics/setAside/placeOfPerformance are the originally-null trio.)
                        fieldsUnavailable = ["naics", "setAside", "placeOfPerformance"].filter((f) => !outcome.fieldsFilled.has(f));
                        const filledList = [...outcome.fieldsFilled];
                        if (filledList.length > 0) {
                            enrichmentNotes.push(`naics/set-aside/place-of-performance for results present in today's GSA CSV snapshot were enriched from the GSA daily bulk CSV (source: gsa-csv) — filled fields this page: ${filledList.join(", ")}. set-aside here is the CSV short code (e.g. 'SBA') that matches sam_get_opportunity's setAside. Confirm real-time values (e.g. a just-amended deadline) with sam_get_opportunity.`);
                        }
                        else {
                            enrichmentNotes.push("GSA-CSV enrichment ran but filled no fields on this page (the matched snapshot rows carried no non-empty naics/set-aside/place-of-performance) — values remain null; fetch sam_get_opportunity.");
                        }
                        if (outcome.missingCount > 0) {
                            enrichmentNotes.push(`${outcome.missingCount} of ${data.returned} results were not in the current CSV snapshot (too new or archived) — their naics/set-aside/PoP remain null; fetch sam_get_opportunity for those noticeIds.`);
                        }
                        enrichmentNotes.push(`GSA CSV freshness — snapshot last-modified: ${outcome.freshness.csvLastModified ?? "unknown"}; index built: ${outcome.freshness.indexBuiltAt}; index age: ${outcome.freshness.indexAgeHours ?? "unknown"}h. The snapshot can lag the live HAL by up to ~24h.`);
                    }
                    else if (data.returned > 0) {
                        // Enabled, rows exist that COULD be enriched, but the index isn't
                        // warm yet (cold cache / background refresh in flight). Return the
                        // normal HAL page un-enriched and disclose the pending warm — never
                        // block on the download. Gated on returned>0: on a genuinely-empty
                        // (returned===0) page there are NO rows to enrich, so a "retry for an
                        // enriched page" note would be misleading — a retry cannot add rows.
                        // That case falls through with the plain un-enriched source/notes
                        // (the empty page is a complete, honest result).
                        source = "sam.gov/sgs/v1 (keyless HAL) + gsa-csv (index warming)";
                        enrichmentNotes.push("GSA-CSV enrichment pending — the CSV index is warming (a background download/build was kicked off); naics/set-aside/place-of-performance were NOT enriched this call. Retry shortly for an enriched page, or fetch sam_get_opportunity now.");
                    }
                }
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
                notes.push(...enrichmentNotes);
                // freshness is surfaced structurally in `data` (the ResponseMeta type
                // has no typed freshness field, mirroring sam_lookup_notice_fields) —
                // present only when enrichment actually ran.
                const dataOut = freshness !== undefined
                    ? { ...enrichedData, freshness }
                    : enrichedData;
                return withMeta(dataOut, {
                    source,
                    keylessMode: true,
                    truncated: r.totalRecords > data.returned,
                    returned: data.returned,
                    totalAvailable: r.totalRecords,
                    filtersApplied,
                    filtersDropped,
                    fieldsUnavailable,
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
        },
    }),
    defineTool({
        name: "sam_search_shaping",
        description: "PRE-SOLICITATION shaping radar (keyless HAL). Surfaces Sources Sought / Presolicitation / Special Notices BEFORE the RFP exists — the free, real-time analogue of paid agency-forecast feeds. Closes the pre-solicitation lifecycle gap: catch a requirement while it's still shapeable (submit capabilities, influence NAICS/set-aside/PWS). Defaults to noticeType ['r','p','s']; opt into k/i/u for combined-synopsis / intent-to-bundle / J&A tells. Each notice carries noticeTypeCode (rank r/p over s), postedDate, responseDeadline + daysUntilResponse (null when no deadline — counted, not hidden), and a uiLink. HONEST KEYLESS LIMITS: naics/setAside/placeOfPerformance are null in the list rows (call sam_get_opportunity(noticeId) for those); and a responseDeadlineFrom/To window is applied CLIENT-SIDE over the fetched page (the feed ignores rdlfrom/rdlto) and disclosed in _meta. data.totalRecords is the TRUE server-side count for the type+facet filter.",
        inputSchema: SamSearchShapingInput,
        handler: async (input, { sam }) => {
            // Default shaping window = Sources Sought + Presolicitation + Special
            // Notice. These are the notice types that exist BEFORE an RFP — the
            // whole point of the radar.
            const noticeType = input.noticeType ?? ["r", "p", "s"];
            const wantWindow = input.responseDeadlineFrom !== undefined ||
                input.responseDeadlineTo !== undefined;
            // Map noticeType → filters.ptype so the client sends the keyless
            // `notice_type` facet (server-side filter, VERIFIED LIVE). We deliberately
            // do NOT pass responseDeadlineFrom/To to the client — the keyless feed
            // IGNORES rdlfrom/rdlto, so the window is applied client-side below and
            // disclosed. activeOnly is honored by searchPublic's is_active=true.
            const r = await sam.searchOpportunities({
                query: input.query,
                ncode: input.ncode,
                organizationName: input.organizationName,
                state: input.state,
                setAside: input.setAside,
                ptype: noticeType,
                limit: input.limit ?? 25,
            });
            // OUTAGE HONESTY (C19). r.degraded ⇒ the keyless feed was totally down
            // (all tiers threw), NOT a genuine "no shaping notices". Emit an
            // explicitly-incomplete `_meta` (complete:false, totalAvailable:null,
            // degraded source, retry note) and a null data count instead of the
            // silent "0 pre-solicitation notices, complete" lie. noticeTypesRequested
            // is still echoed so the caller knows what was attempted. The genuine-zero
            // path + the client-side response-deadline window disclosure below are
            // UNCHANGED.
            if (r.degraded) {
                return withMeta({
                    totalRecords: null,
                    returned: 0,
                    noticeTypesRequested: noticeType,
                    notices: [],
                }, {
                    source: "sam.gov/api/prod/sgs/v1/search (keyless HAL, notice_type filter) (DEGRADED — search backend unavailable)",
                    keylessMode: true,
                    complete: false,
                    totalAvailable: null,
                    returned: 0,
                    filtersApplied: [],
                    filtersDropped: [],
                    fieldsUnavailable: [],
                    notes: [
                        r.degraded.reason +
                            " This is a service outage, not a confirmed zero — retry.",
                    ],
                });
            }
            // Shape each keyless list row. naics/setAside/PoP are NULL in the keyless
            // list payload (fieldsUnavailable) — NOT fabricated. noticeTypeCode
            // (type.code) lets the AI rank r/p over s; daysUntilResponse is a whole-day
            // count (null when no deadline — counted, not hidden).
            const now = new Date();
            const allNotices = r.opportunitiesData.map((o) => ({
                noticeId: o.noticeId,
                title: o.title,
                noticeType: o.type ?? null, // type.value (human label)
                noticeTypeCode: o.baseType ?? null, // type.code (r/p/s/…)
                agency: o.fullParentPathName,
                solicitationNumber: o.solicitationNumber,
                postedDate: o.postedDate,
                responseDeadline: o.responseDeadLine ?? null,
                daysUntilResponse: daysUntilResponse(o.responseDeadLine, now),
                naics: o.naicsCode, // null in keyless list rows
                setAside: o.typeOfSetAside, // null in keyless list rows
                uiLink: o.uiLink,
            }));
            // Response-deadline WINDOW — CLIENT-SIDE over the fetched page (the feed
            // ignores rdlfrom/rdlto). A notice with no deadline is excluded from a
            // windowed query. Disclosed via filtersDropped + a note below.
            const notices = wantWindow
                ? applyResponseDeadlineWindow(allNotices, input.responseDeadlineFrom, input.responseDeadlineTo)
                : allNotices;
            const data = {
                totalRecords: r.totalRecords, // TRUE server-side count for type+facets
                returned: notices.length,
                noticeTypesRequested: noticeType,
                notices,
            };
            // _meta honesty. filtersApplied lists what the FEED honored server-side
            // (mirror EXACTLY searchPublic's append conditions). Always: noticeType.
            const filtersApplied = ["noticeType"];
            if (input.query)
                filtersApplied.push("query");
            if (input.ncode)
                filtersApplied.push("ncode");
            if ((input.setAside?.length ?? 0) > 0)
                filtersApplied.push("setAside");
            if (input.state)
                filtersApplied.push("state");
            // filtersDropped: organization-name has NO keyless param (ignored), and a
            // requested response-deadline window is applied client-side (feed ignores
            // rdlfrom/rdlto) — both must be disclosed so the AI never treats the page
            // as server-filtered on them.
            const filtersDropped = [];
            if (input.organizationName)
                filtersDropped.push("organizationName");
            if (wantWindow)
                filtersDropped.push("responseDeadline");
            const notes = [
                "Pre-solicitation shaping radar: notice_type is filtered SERVER-SIDE by the keyless feed (r=Sources Sought, p=Presolicitation, s=Special Notice by default; k/i/u opt-in). totalRecords is the TRUE server-side count for the type+facet filter.",
            ];
            if (wantWindow) {
                notes.push("response-deadline window applied client-side over the fetched page (the keyless feed ignores rdlfrom/rdlto); widen limit or narrow via NAICS/agency for completeness. Notices with no deadline are excluded from a windowed query.");
            }
            if (input.organizationName) {
                notes.push("The organization-name filter is NOT supported by the keyless endpoint and was ignored (results are unfiltered on organization). Filter client-side on the returned `agency`, or set SAM_GOV_API_KEY.");
            }
            notes.push("naics/setAside/placeOfPerformance are null in the keyless list rows — call sam_get_opportunity(noticeId) for per-notice NAICS/set-aside/place-of-performance.");
            // truncated when the server has more than we returned OR a client-side
            // deadline window trimmed the page (either way the caller isn't seeing the
            // complete in-scope set).
            const truncated = r.totalRecords > data.returned ||
                (wantWindow && allNotices.length !== notices.length);
            return withMeta(data, {
                source: "sam.gov/api/prod/sgs/v1/search (keyless HAL, notice_type filter)",
                keylessMode: true,
                truncated,
                returned: data.returned,
                totalAvailable: r.totalRecords,
                filtersApplied,
                filtersDropped,
                fieldsUnavailable: ["naics", "setAside", "placeOfPerformance"],
                notes,
            });
        },
    }),
    defineTool({
        name: "sam_get_opportunity",
        description: "Fetch full detail for a single SAM.gov notice by 32-char hex noticeId. Returns title, agency, solicitation #, POCs, response deadline, attachments (with download URLs), inline description body. Call BEFORE drafting bid/no-bid or compliance work.",
        inputSchema: SamGetOpportunityInput,
        handler: async (input, { sam }) => {
            const { noticeId } = input;
            const o = await sam.getOpportunity(noticeId);
            if (!o)
                return { found: false, noticeId };
            const data = {
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
            // A HEALTHY notice returns EXACTLY as before (plain object → the server
            // synthesizes a default complete:true `_meta`) — no crying wolf. ONLY
            // when an enrichment sub-fetch DEGRADED (an outage, not a genuine empty)
            // do we attach a degraded `_meta` disclosing that the empty field is
            // UNKNOWN, not confirmed-absent. One failing sub-fetch does not flag the
            // other: notes carry exactly one entry per degraded bucket.
            if (o.enrichmentDegraded?.length) {
                const notes = o.enrichmentDegraded.map((bucket) => bucket === "attachments"
                    ? "The attachment list could not be fetched (a service issue) — this notice MAY have attachments not shown here; retry. This is NOT a confirmation it has none."
                    : "The awarding-organization path could not be resolved (a service issue) — it is unavailable here, not absent.");
                return withMeta(data, {
                    source: sam.isKeyless ? "sam.gov (keyless)" : "api.sam.gov (keyed)",
                    keylessMode: sam.isKeyless,
                    complete: false,
                    degraded: {
                        attempted: o.enrichmentDegraded.length,
                        succeeded: 0,
                        failed: o.enrichmentDegraded.length,
                    },
                    notes,
                });
            }
            return data;
        },
    }),
    defineTool({
        name: "sam_fetch_description",
        description: "Return the full description / RFP body text for a notice as plain text. Useful when sam_get_opportunity returned a description URL instead of inline body, or for an LLM-friendly text dump.",
        inputSchema: SamFetchDescriptionInput,
        handler: async (input, { sam }) => {
            const { noticeId } = input;
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
        },
    }),
    defineTool({
        name: "sam_attachment_url",
        description: "Build the public download URL for an attachment resourceId. The URL returns a 303 redirect to a signed S3 URL — fetch with redirect:'follow' to get the file bytes.",
        inputSchema: SamAttachmentUrlInput,
        handler: async (input, { sam }) => ({
            downloadUrl: sam.publicDownloadUrl(input.resourceId),
        }),
    }),
    defineTool({
        name: "sam_fetch_attachment_text",
        description: "Extract the TEXT of a SAM notice attachment (the actual RFP / SOW / Q&A / wage tables) by its download URL — so an AI can read the real solicitation, not just its metadata. Give it a sam_get_opportunity attachments[].url (resourceLinks). Keyless. Handles PDF (via pdfjs) + text/HTML; returns { format, text, pages, filename, sizeBytes, truncated, extracted }. HONEST: a DOCX / binary that can't be read keyless returns text:null + a note (never fabricated); a corrupt/encrypted PDF returns text:null + an extractionError note (never a crash); a DOWN fetch throws a retryable upstream_unavailable (never empty text); a 404 throws not_found. Only sam.gov / api.sam.gov URLs are fetched (SSRF hygiene). maxChars caps the text (default 200000) and truncation is disclosed.",
        inputSchema: SamFetchAttachmentTextInput,
        handler: (input) => fetchAttachmentText(input),
    }),
    defineTool({
        name: "sam_lookup_organization",
        description: "Resolve a SAM.gov federal-organization id to its canonical fullParentPathName (e.g. 'VETERANS AFFAIRS, DEPARTMENT OF.VETERANS AFFAIRS, DEPARTMENT OF.245-NETWORK CONTRACT OFFICE 5'). Use when sam_get_opportunity returned only an organizationId.",
        inputSchema: SamLookupOrgInput,
        handler: async (input, { sam }) => {
            const { organizationId } = input;
            // SamGovClient internal method — exposed via direct fetch since
            // it's not on the public surface. Use the public sam.gov endpoint
            // directly (already keyless).
            const orgUrl = `https://sam.gov/api/prod/federalorganizations/v1/organizations/${encodeURIComponent(organizationId)}`;
            let r;
            try {
                r = await fetch(orgUrl, {
                    headers: { Accept: "application/hal+json" },
                    signal: AbortSignal.timeout(10_000),
                });
            }
            catch (e) {
                // A network-level fault (DNS, connection reset, timeout) is an OUTAGE, not
                // absence — classify as retryable rather than letting it surface as the
                // generic `unknown` (which an agent won't retry).
                if (e instanceof ToolErrorCarrier)
                    throw e;
                throw new ToolErrorCarrier({
                    kind: "upstream_unavailable",
                    message: `SAM federalorganizations lookup for '${organizationId}' failed: ${e.message}. This is an outage, not a missing organization. Retry.`,
                    retryable: true,
                    retryAfterSeconds: 30,
                    upstreamEndpoint: "sam:federalorganizations",
                });
            }
            if (!r.ok) {
                // 404 = the organization genuinely does not exist → a real negative (the
                // tool's found:false contract), NOT an error.
                if (r.status === 404) {
                    return { found: false, organizationId, status: 404 };
                }
                // Every OTHER non-2xx is an upstream fault, not absence — classify via the
                // shared errorFromResponse matrix (400/403→invalid_input non-retryable,
                // 429→rate_limited with Retry-After, 5xx→upstream_unavailable retryable;
                // carries upstreamStatus) so a down/blocking service is NEVER read as "org
                // not found" (the fetch-failure-as-absent masquerade).
                throw new ToolErrorCarrier(errorFromResponse(r, "sam:federalorganizations"));
            }
            // This endpoint signals a NONEXISTENT org id with a 200 + EMPTY body
            // (live-verified 2026-07-06) — a genuine absence. Read text first so an
            // empty/degraded body never crashes `r.json()` into a mislabeled `unknown`.
            const orgText = await r.text();
            if (!orgText.trim()) {
                return { found: false, organizationId, status: 200 };
            }
            let orgJson;
            try {
                orgJson = JSON.parse(orgText);
            }
            catch {
                // A non-empty, non-JSON 200 (e.g. an HTML error/interstitial page from the
                // CDN/WAF) is a DEGRADED response — do NOT fabricate found:false on garbage;
                // surface it as schema_drift so the caller knows it's unconfirmed, not absent.
                throw new ToolErrorCarrier({
                    kind: "schema_drift",
                    message: `SAM federalorganizations returned a 200 with a non-JSON body for '${organizationId}' — unexpected shape; cannot confirm whether the organization exists.`,
                    retryable: false,
                    upstreamEndpoint: "sam:federalorganizations",
                });
            }
            const org = orgJson._embedded?.[0]?.org;
            return {
                found: !!org,
                organizationId,
                fullParentPathName: org?.fullParentPathName ?? "",
                agencyName: org?.agencyName ?? "",
                name: org?.name ?? "",
                type: org?.type,
                level: org?.level,
            };
        },
    }),
    defineTool({
        name: "sam_lookup_notice_fields",
        description: "BATCH-complete a sam_search_opportunities page in ONE call from the GSA daily bulk CSV (keyless). The keyless HAL list endpoint NULLS each result's naics/setAside/place-of-performance/responseDeadline/type; this tool returns those fields for 1..100 noticeIds at once (naicsCode, setAside + setAsideCode, popState/popCity/popZip/popCountry, responseDeadline, type, active, title) from a cached on-disk CSV index, instead of one sam_get_opportunity detail call per notice. OFF BY DEFAULT (no forced 226 MB download): enable by setting SAM_GOV_CSV_CACHE (a cache dir) or SAM_GOV_ENABLE_CSV=1 — when disabled the tool returns data.enabled:false + a structured 'how to enable' note (never fake data, no network). HONEST: _meta carries the CSV last-modified + index build time (freshness), a noticeId absent from the current snapshot returns found:false + nulls with an explicit 'not in current CSV snapshot' disclosure (never faked), a cold first call discloses 'index warming', and a download/parse failure is a structured retryable error (never a silent empty). setAsideCode (e.g. 'SBA') matches sam_get_opportunity's setAside; the snapshot can lag live by up to ~24h — confirm real-time-critical fields with sam_get_opportunity.",
        inputSchema: SamLookupNoticeFieldsInput,
        handler: (input) => gsaCsv.lookupNoticeFields(input),
    }),
    // ━━━ USAspending — Awards & Recipients (10) ━━━
    defineTool({
        name: "usas_search_awards",
        description: "Aggregate share-of-wallet on USAspending. Given an agency × NAICS × fiscal year, returns top recipients by total $ + count. Use for competitive landscape ('who wins at VA in 541512?').",
        inputSchema: UsasFiltersBase,
        handler: (input) => usas.searchAwards(input),
    }),
    defineTool({
        name: "usas_search_individual_awards",
        description: "Line-item federal contracts on USAspending. Returns specific awards (recipient + $ + sub-agency + state + description). Use AFTER usas_search_awards when the user wants 'show me the actual contracts'. Each result includes a generatedInternalId for usas_get_award_detail follow-ups.",
        inputSchema: UsasIndividualAwardsInput,
        handler: (input) => usas.searchIndividualAwards(input),
    }),
    defineTool({
        name: "usas_search_subagency_spending",
        description: "Break down a parent agency's spending by sub-agency / office. Surfaces which office holds the budget (e.g. VA OI&T vs VHA, DoD vs Army vs DISA).",
        inputSchema: UsasSubAgencyInput,
        handler: (input) => usas.searchSubAgencySpending(input),
    }),
    defineTool({
        name: "usas_lookup_agency",
        description: "Resolve a user-friendly agency reference ('VA', 'Veterans Affairs', 'DHS') to USAspending's canonical toptier name + 4-digit code. ALWAYS call this FIRST if the user uses an abbreviation — other USAspending tools require the canonical name.",
        inputSchema: UsasLookupAgencyInput,
        handler: (input) => usas.lookupAgency(input.searchText),
    }),
    defineTool({
        name: "usas_search_awards_by_recipient",
        description: "Pull every contract a specific recipient has won within an agency × NAICS slice. Use when the user asks 'show me Booz Allen wins at VA last year' — returns line items + naicsCode + description, not aggregates.",
        inputSchema: UsasRecipientAwardsInput,
        handler: (input) => usas.searchAwardsByRecipient(input),
    }),
    defineTool({
        name: "usas_search_subawards",
        description: "Enumerate subcontracts on prime awards. Use for 'who teams with Leidos at DISA' or 'show small-business subs on Accenture's DHS contracts' — surfaces the prime/sub network for teaming-map artifacts.",
        inputSchema: UsasSubawardsInput,
        handler: (input) => usas.searchSubawards(input),
    }),
    defineTool({
        name: "usas_search_recompetes",
        description: "Recompete radar — federal contracts whose CURRENT period of performance ends inside a window around today (default -90d .. +18mo), sorted soonest-first. Use for 'what VA 541512 contracts are up for recompete in the next 18 months'. Reads the current PoP end date directly from spending_by_award (no per-award enrichment), counts (never drops) rows with missing end dates, and flags in _meta when the scan budget truncates the window (totalAvailable becomes null). Filter by agency/naics/pscCodes/setAside/minAwardValue; set includePotentialEnd for option-inclusive end dates. Public signals only — no CPARS/protest/option-intent, no composite vulnerability score.",
        inputSchema: UsasRecompetesInput,
        handler: (input) => usas.searchRecompetes(input),
    }),
    defineTool({
        name: "usas_search_expiring_contracts",
        description: "DEPRECATED — use usas_search_recompetes. Thin backward-compatible alias: finds contracts at agency × NAICS expiring within N months and returns the legacy { contracts, searchedCount } shape. New callers should use usas_search_recompetes for the full window/pagination controls and truthful completeness metadata.",
        inputSchema: UsasExpiringInput,
        handler: (input) => usas.searchExpiringContracts(input),
    }),
    defineTool({
        name: "usas_get_award_detail",
        description: "Fetch full detail for a single award by generatedInternalId (from usas_search_individual_awards). Returns period_of_performance (start/end/potential_end), base_and_all_options, set-aside type, competition extent, number_of_offers — the per-award fields the search endpoint omits.",
        inputSchema: UsasAwardDetailInput,
        handler: (input) => usas.getAwardDetail(input.generatedInternalId),
    }),
    defineTool({
        name: "usas_analyze_incumbent",
        description: "Per-award incumbent + PUBLIC recompete-pressure analysis for ONE award (generatedInternalId). Assembles the incumbent identity, the vehicle/IDV linkage, and individual PUBLIC pressure SIGNALS — obligated-vs-ceiling consumption (pctConsumed), modification count (lower-bounded), competition extent + number of offers, set-aside, days to the current PoP end, and option-extendable days — plus, optionally, the incumbent's other awards in the same agency×NAICS. Bounded & keyless: at most 3 upstream calls (detail + 1 transactions page + 1 recipient search), no per-record fan-out. Emits pressureHints ('single_offer', 'ceiling_nearly_exhausted', 'hard_stop_no_options') as HINTS, NEVER a composite vulnerability score — CPARS/past-performance, protest history, and option-exercise intent are not public (declared in _meta.fieldsUnavailable).",
        inputSchema: UsasAnalyzeIncumbentInput,
        handler: (input) => usas.analyzeIncumbent(input),
    }),
    // ━━━ USAspending — Aggregate Analysis (6) ━━━
    defineTool({
        name: "usas_spending_over_time",
        description: "Time-series aggregation of federal CONTRACT spending (award types A/B/C/D — grants, IDVs, loans, and other obligation types are EXCLUDED, matching the other usas_search_*_spending tools; disclosed in _meta). Group by fiscal_year / quarter / month, filter by agency / NAICS / set-aside. Use for 'how has VA 541512 contract spending trended over the past 5 years' — returns yearly/quarterly/monthly $ rollups of contract obligations (grantObligations/idvObligations are null, NOT 0, to avoid implying an agency has no grant/IDV spending).",
        inputSchema: UsasSpendingOverTimeInput,
        handler: (input) => usas.spendingOverTime(input),
    }),
    defineTool({
        name: "usas_search_psc_spending",
        description: "Spending broken down by Product Service Code (PSC). Use for 'what PSC categories see the most $ at DoD' — surfaces market structure beyond NAICS (e.g. PSC R425 = engineering support services).",
        inputSchema: UsasCategorySpendingInput,
        handler: (input) => usas.searchPscSpending(input),
    }),
    defineTool({
        name: "usas_search_state_spending",
        description: "Spending broken down by state / territory. Use for 'where is the most federal $ flowing for NAICS 541512' — answers like 'VA $128B, MD $66B, DC $58B'.",
        inputSchema: UsasCategorySpendingInput,
        handler: (input) => usas.searchStateSpending(input),
    }),
    defineTool({
        name: "usas_search_cfda_spending",
        description: "Spending broken down by CFDA grant program code. Use for grant analysis — 'top federal grant programs by $'. Note: CFDA is grants (award_type 02-05), not contracts. Use usas_search_psc_spending for contract market analysis.",
        inputSchema: UsasCfdaInput,
        handler: (input) => usas.searchCfdaSpending(input),
    }),
    defineTool({
        name: "usas_search_federal_account_spending",
        description: "Spending broken down by federal account / Treasury Account Symbol (TAS). Use to map money to the actual budget line item (e.g. '036-0167 = Information Technology Systems, VA').",
        inputSchema: UsasCategorySpendingInput,
        handler: (input) => usas.searchFederalAccountSpending(input),
    }),
    defineTool({
        name: "usas_search_agency_spending",
        description: "Spending broken down by awarding agency. Use for 'which agencies spend the most on NAICS 541512' — top buyers by $.",
        inputSchema: UsasAgencySpendingInput,
        handler: (input) => usas.searchAgencySpending(input),
    }),
    // ━━━ USAspending — Agency Profile (3) ━━━
    defineTool({
        name: "usas_get_agency_profile",
        description: "Get full agency profile by toptier code (3-4 digits, from usas_lookup_agency). Returns mission, abbreviation, website, subtier_agency_count, congressional_justification_url.",
        inputSchema: UsasAgencyProfileInput,
        handler: (input) => usas.getAgencyProfile(input.toptierCode),
    }),
    defineTool({
        name: "usas_get_agency_awards_summary",
        description: "High-level award activity for a fiscal year — transaction_count + obligations + latest_action_date. SCOPE: obligations/transaction_count span ALL award types (contracts, grants, direct payments incl. benefits, loans) — NOT prime contracts only. For benefit-heavy agencies (VA/SSA/HHS) this is dominated by direct benefit payments (e.g. VA FY2024 ~$238B all-awards vs ~$67B prime contracts), so do NOT read it as the contract/procurement market; for procurement-heavy agencies (DoD/DHS) it closely tracks contract spending. For contracts-only obligations use usas_spending_over_time (contractObligations) — it takes the agency canonical NAME, so resolve it from this toptierCode via usas_get_agency_profile first.",
        inputSchema: UsasAgencyAwardsInput,
        handler: (input) => usas.getAgencyAwardsSummary(input),
    }),
    defineTool({
        name: "usas_get_agency_budget_function",
        description: "Budget function breakdown for an agency × fiscal year. Returns the agency's spending by program area (e.g. VA: 'Income security for veterans' $204B, 'Hospital and medical care for veterans' $126B).",
        inputSchema: UsasAgencyBudgetInput,
        handler: (input) => usas.getAgencyBudgetFunction(input),
    }),
    // ━━━ USAspending — Recipient Profile (2) ━━━
    defineTool({
        name: "usas_search_recipients",
        description: "Search USAspending recipient list with parent/child/recipient hierarchy. Returns recipients with id, duns, uei, level (P=parent, C=child, R=recipient), total_amount. Use for 'find the recipient_id for Booz Allen' before usas_get_recipient_profile.",
        inputSchema: UsasSearchRecipientsInput,
        handler: (input) => usas.searchRecipients(input),
    }),
    defineTool({
        name: "usas_get_recipient_profile",
        description: "Full recipient detail by recipient_id (from usas_search_recipients). Returns alternate_names (M&A history), DUNS, UEI, parent linkage, business_types, location, total_amount, total_transactions.",
        inputSchema: UsasGetRecipientInput,
        handler: (input) => usas.getRecipientProfile(input.recipientId),
    }),
    // ━━━ USAspending — Reference / Autocomplete (5) ━━━
    defineTool({
        name: "usas_autocomplete_naics",
        description: "Autocomplete NAICS codes by free-text. ANTI-HALLUCINATION GUARD — call this when the user mentions a NAICS theme but no specific code (e.g. 'computer systems design' → 541512). Avoids inventing NAICS codes.",
        inputSchema: UsasAutocompleteInput,
        handler: (input) => usas.autocompleteNaics(input),
    }),
    defineTool({
        name: "usas_autocomplete_recipient",
        description: "Autocomplete recipient names. ANTI-HALLUCINATION — confirm a recipient's exact USAspending-canonical legal name before searching by name. Returns up to 10 fuzzy matches with UEI/DUNS where available.",
        inputSchema: UsasAutocompleteInput,
        handler: (input) => usas.autocompleteRecipient(input),
    }),
    defineTool({
        name: "usas_naics_hierarchy",
        description: "Navigate the NAICS hierarchy (2→4→6 digit) + active-contract count per code. No naicsFilter ⇒ the top-level 2-digit sectors. With naicsFilter=<code> ⇒ that node is in `parent` and its DIRECT children are in `hierarchy` (drill into any row where hasChildren:true by re-calling with its code). A 6-digit leaf returns hierarchy:[] with the node in `parent` (found:true); a nonexistent code returns hierarchy:[] with parent:null (found:false). Use to explore market scope (e.g. what's under NAICS 54 = Professional, Scientific, and Technical Services).",
        inputSchema: UsasNaicsHierarchyInput,
        handler: (input) => usas.naicsHierarchy(input),
    }),
    defineTool({
        name: "usas_glossary",
        description: "USAspending glossary of 151 federal-spending terms. Use to confirm terminology ('what's a TAS?', 'what's an obligation vs outlay?') before answering compliance/budget questions.",
        inputSchema: UsasGlossaryInput,
        handler: (input) => usas.glossary(input),
    }),
    defineTool({
        name: "usas_list_toptier_agencies",
        description: "List all toptier federal agencies with toptier_code, abbreviation, slug, current-FY obligations. Use for 'show me every cabinet department + their FY26 spending' or to find a toptier_code for usas_get_agency_*.",
        inputSchema: UsasListAgenciesInput,
        handler: (input) => usas.listToptierAgencies(input),
    }),
    // ━━━ Federal Register (3) ━━━
    defineTool({
        name: "fed_register_search_documents",
        description: "Search Federal Register documents (proposed rules, final rules, notices, presidential documents) by query / agency / type / date range. Use for regulatory-context queries ('what new VA cybersecurity rules came out this quarter?').",
        inputSchema: FedRegSearchInput,
        handler: (input) => fedreg.searchDocuments(input),
    }),
    defineTool({
        name: "fed_register_get_document",
        description: "Fetch full detail for a Federal Register document by number. Returns title, abstract, citation, publication_date, effective_on, raw_text_url (for the full body), CFR references — everything needed to ground a regulation citation.",
        inputSchema: FedRegGetDocInput,
        handler: (input) => fedreg.getDocument(input.documentNumber),
    }),
    defineTool({
        name: "fed_register_list_agencies",
        description: "List all Federal Register agencies with slugs (needed for fed_register_search_documents). Use to resolve 'what's the FedReg slug for Veterans Affairs?'",
        inputSchema: FedRegListAgenciesInput,
        handler: (input) => fedreg.listAgencies(input),
    }),
    // ━━━ eCFR (5) ━━━
    defineTool({
        name: "ecfr_search",
        description: "Full-text search across the entire CFR (Code of Federal Regulations). Use for compliance questions — pass titleNumber=48 for FAR (Federal Acquisition Regulation), titleNumber=2 for federal financial assistance, etc. Returns excerpt + section path + ecfrUrl.",
        inputSchema: EcfrSearchInput,
        handler: (input) => ecfr.search(input),
    }),
    defineTool({
        name: "ecfr_list_titles",
        description: "List all 50 CFR titles with name + last_amended_on date. Use to discover what's in each title (Title 48 = FAR, Title 32 = National Defense, Title 14 = Aeronautics, etc.).",
        inputSchema: EcfrListTitlesInput,
        handler: () => ecfr.listTitles(),
    }),
    defineTool({
        name: "far_clause_lookup",
        description: "Authoritative FAR/DFARS clause text + its PRESCRIPTION (the 'As prescribed in …' rule for when the clause applies), from the eCFR versioner-full endpoint (Title 48). Use this — NOT ecfr_search — for an EXACT clause number: full-text search mis-ranks '52.212-4' (returns GSAM 552.212-4 above the real FAR clause). Returns heading, revision date, clause/provision kind, regulation (FAR/DFARS/GSAM), full text, the prescribing section, and ecfrUrl. Every response carries farOverhaulRisk — a structural currency caveat that eCFR reflects only the CODIFIED FAR, so a clause may be superseded by a Revolutionary-FAR-Overhaul agency class deviation not shown here. A genuinely-absent clause returns a not_found error (never a fake empty clause). Keyless.",
        inputSchema: FarClauseLookupInput,
        handler: (input) => far.farClauseLookup(input),
    }),
    defineTool({
        name: "far_compliance_matrix",
        description: "Turn a solicitation's cited FAR/DFARS clause list into a proposal-ready compliance matrix (for a Section L/M response). COMPOSES far_clause_lookup over 1–25 clauses (deduped case-insensitively): each resolved row carries the clause text + prescription + regulation + a gate flag marking pass/fail award-eligibility GATES (Section 889 52.204-24/25/26, limitations on subcontracting 52.219-14, DFARS cyber 252.204-7012/7020/7021 incl. CMMC) + the farOverhaulRisk currency caveat. TRUTHFUL by construction: a clause that genuinely isn't in Title 48 (HTTP 404) goes to `unresolved`, while a clause that couldn't be fetched (eCFR down/5xx/rate-limited) goes to a SEPARATE `errored` bucket — a DOWN service is never reported as 'clause doesn't exist'; `summary.total` proves no clause is dropped. Does NOT parse the PDF solicitation to extract the clause list, and gives NO legal advice or compliance verdict. Keyless.",
        inputSchema: FarComplianceMatrixInput,
        handler: (input) => far.farComplianceMatrix(input),
    }),
    defineTool({
        name: "far_search",
        description: "FAR/DFARS-scoped semantic search — the 'which clauses touch topic X' front-door that feeds far_clause_lookup. COMPOSES ecfr_search but fixes its two compliance flaws: (1) it filters to FAR (Title 48 chapter 1) or DFARS (chapter 2), EXCLUDING GSAM/agency supplements (so 'limitations on subcontracting' no longer mis-ranks GSAM 552.x over FAR 52.x), and (2) it collapses eCFR's ~5-versions-per-section HISTORICAL duplicates to the CURRENT in-force version (endsOn==null). scope: far (default) | dfars | both. dedupeVersions (default true; false shows all historical rows). partsOnly restricts to given parts (e.g. [52] clause text). Returns distinct sections with regulation/section/headingPath/excerpt/score/ecfrUrl/effectiveOn/endsOn/isCurrent, distinctSections, and the farOverhaulRisk caveat. TRUTHFUL: dedupe never drops a distinct section (the raw→distinct collapse is disclosed); a kept-historical row is marked isCurrent:false; a search-endpoint outage THROWS (never a fake 0 results); totalAvailable is null (a deduped view has no clean upstream count). Keyless.",
        inputSchema: FarSearchInput,
        handler: (input) => far.farSearch(input),
    }),
    // ━━━ SBA — Size Standards (1) ━━━
    defineTool({
        name: "sba_size_standard",
        description: "SBA small-business size standard for a 6-digit NAICS (keyless sba.gov naics.json). Answers 'is a firm SMALL for this NAICS?' — the gate for set-aside eligibility and for vetting a usas_search_teaming_partners candidate. Returns standardType (receipts | employees | assets [financial institutions] | receipts+assets), a normalized threshold (receipts/assets in DOLLARS — the dataset's $millions figure ×1,000,000; employees as a count), the unit, and any SBA footnote. HONESTY: the dataset carries no effective-date field, so the value is 'as published as of retrieval' (asOf) and _meta.notes flags that SBA adjusts standards periodically — re-verify at sba.gov for high-stakes eligibility. An unknown NAICS returns found:false (never a fabricated standard).",
        inputSchema: SbaSizeStandardInput,
        handler: (input) => sba.sizeStandard(input),
    }),
    // ━━━ Grants.gov (2) ━━━
    defineTool({
        name: "grants_search",
        description: "Search Grants.gov federal grant opportunities (financial assistance, distinct from contracts on SAM.gov). Filter by keyword / CFDA / agency / opportunity number. Default status = forecasted + posted. KEYWORD: Grants.gov OR-matches multi-word keywords (returns grants containing ANY word), so a multi-word keyword BROADENS results — pass ONE specific term for relevance (phrase quoting returns 0); narrow with cfda/agency/oppStatuses.",
        inputSchema: GrantsSearchInput,
        handler: (input) => grants.searchGrants(input),
    }),
    defineTool({
        name: "grants_get_opportunity",
        description: "Fetch full detail for a single grant opportunity by id. Returns found:true with description, agency, posting/response/archive dates, award_ceiling, award_floor, estimated_funding, expected_number_of_awards, applicant_types, funding_instruments, CFDA programs. `agency` is { code, name (the REAL posting/sub-tier agency, e.g. 'Food and Nutrition Service'), department (the top-tier agency, e.g. 'Department of Agriculture'), contactName (the program officer — NOT the agency) } — Grants.gov's raw `agencyName` field is actually the contact person, so this tool sources the real agency from agencyDetails; `name` may be null if the record carries no structured agency. A NONEXISTENT id returns { found:false, opportunityId } — never a fabricated grant with empty fields (Grants.gov answers a bad id with a hollow 200, which this tool detects). Check `found` before reading the other fields.",
        inputSchema: GrantsGetInput,
        handler: (input) => grants.getGrant(input),
    }),
    // ━━━ Pricing / Wage (3) ━━━
    defineTool({
        name: "sam_search_wage_determinations",
        description: "Find the Service Contract Act (SCA) or Davis-Bacon (DBA) wage determination(s) governing a locality (keyless SAM SGS). Filter by coverage (sca|dba), state (2-letter, server-side), county (client-side), or WD number/title. Returns the structured WD list; follow with sam_get_wage_rates to read the rate table. NOTE: `query` matches WD number/title only, NOT occupation.",
        inputSchema: WageSearchInput,
        handler: (input) => pricing.searchWageDeterminations(input),
    }),
    defineTool({
        name: "sam_get_wage_rates",
        description: "Return the prevailing-wage + fringe/H&W rate table for a specific wage determination, PARSED from its plain-text document (SAM exposes no structured rate JSON), plus the Executive-Order minimum-wage floor. Distinguishes SCA (WD-wide Health & Welfare) vs DBA (per-craft fringe). Always returns parseConfidence and supports format:'parsed'|'raw'|'both' so you can read the raw text when parsing is low-confidence. Resolves the latest active revision via /history when `revision` is omitted.",
        inputSchema: WageRatesInput,
        handler: (input) => pricing.getWageRates(input),
    }),
    defineTool({
        name: "gsa_benchmark_labor_rates",
        description: "GSA CALC awarded ceiling-rate market band for a labor category (keyless). Returns a DISTRIBUTION (currentRate min/median/max + escalated medians) over a fetched sample, NOT a single price. CALC rates are CEILING/catalog and FULLY BURDENED (do not re-add wrap); the match count SATURATES at 10000 for broad queries (totalAvailable null then). Filter by businessSize/educationLevel(code)/experience/sin to narrow.",
        inputSchema: BenchmarkLaborInput,
        handler: (input) => pricing.benchmarkLaborRates(input),
    }),
    // ━━━ Integrity / Teaming (3) ━━━
    defineTool({
        name: "sam_check_exclusions",
        description: "Keyless SAM debarment/exclusion screening. Screen a firm or individual by name (query) and/or UEI/CAGE against the SAM exclusions index (FAPIIS). Returns excluded (true iff ≥1 ACTIVE matching record), matchCount, and per-record { name, classification, uei, cage, excludingAgency, exclusionType, exclusionProgram, isActive, activation/terminationDate, samFapiisUrl }. CRITICAL: an EMPTY result means 'no matching exclusion under these terms' — it is NOT proof of general responsibility (stated in _meta.notes). A name match is not identity-proof; verify the UEI/CAGE + dates against the FAPIIS record. Requires at least one of query/uei/cage.",
        inputSchema: CheckExclusionsInput,
        handler: (input) => integrity.checkExclusions(input),
    }),
    defineTool({
        name: "sam_integrity_lookup",
        description: "Keyless ONE-CALL integrity screen — 'any integrity red flags on this entity?'. Composes the keyless government-wide EXCLUSION verdict (via sam_check_exclusions) with an honest pointer to the FAPIIS / Responsibility-Qualification record. Requires at least one of uei/cage/name (uei preferred; name maps to the exclusions text search). Returns { entity, exclusions:{excluded,activeCount,records}, fapiisRecords, fapiisUrl, integrityFlag }. integrityFlag is 'excluded' when ≥1 ACTIVE matching exclusion is found, else 'review_fapiis' — it NEVER returns 'clear' keylessly, because FAPIIS records (terminations for default/cause, non-responsibility determinations, self-reported criminal/civil/administrative proceedings) have NO keyless machine API, so absence of an exclusion is NOT proof of integrity. fapiisRecords is ALWAYS null (never faked; record-level retrieval needs an optional SAM Entity key) with _meta.fieldsUnavailable:['fapiisRecords']; fapiisUrl deep-links the viewable SAM page. An upstream exclusions failure surfaces as the classified error, never a fake clearance.",
        inputSchema: IntegrityLookupInput,
        handler: (input) => integrity.integrityLookup(input),
    }),
    defineTool({
        name: "usas_search_teaming_partners",
        description: "Small-business teaming-partner discovery by socioeconomic certification + NAICS + agency award history (keyless USAspending proxy), integrity-screened. Given a cert (enum-validated), optional naics/agency/subagency, and a lookback window, aggregates federal awardees by recipient and returns candidates ranked by agencyObligated with agencyAwardCount, mostRecentAwardDate, and sampleAwards; optionally screens the top candidates via sam_check_exclusions and drops active exclusions (excludeDebarred, default true). HONESTY: cert is AWARD-DERIVED (recorded on the firm's federal awards), NOT the SBA certification of record (which needs a keyed SAM Entity call) — verify active certification in SAM/SBS before teaming (stated in _meta). A bogus cert is rejected as invalid_input (the endpoint would silently return 0).",
        inputSchema: TeamingPartnersInput,
        handler: (input) => integrity.searchTeamingPartners(input),
    }),
    // ━━━ GAO — Bid Protests (1) ━━━
    defineTool({
        name: "gao_protest_lookup",
        description: "Recent GAO (Comptroller General) bid-protest decisions from the public Legal-Products RSS feed, enriched from each decision page (protester, contracting agency, decision date, outcome sustained/denied/dismissed/withdrawn, solicitation #, decision PDF). Filter client-side by agency/protester/solicitation/outcome, or pull one decision directly by bNumber. HONEST SCOPE: keyless covers only the RECENT feed window (~25 items) — GAO's faceted historical protest search (all years, by protester/agency/outcome/date) is WAF-blocked to bots and available only via a paid third-party API, so results are ALWAYS marked complete:false and are NOT the full protest history (see the accessNote).",
        inputSchema: GaoProtestInput,
        handler: (input) => gao.gaoProtestLookup(input),
    }),
    // ━━━ US Treasury — Fiscal Data (keyless) (4) ━━━ ADR-0002
    defineTool({
        name: "treasury_query_dataset",
        description: "Escape-hatch query over 5 confirmed US Treasury Fiscal Data datasets (keyless): debt_to_penny, avg_interest_rates, mts_table_1 (Monthly Treasury Statement), rates_of_exchange, debt_outstanding. Choose `dataset` (enum — no free path), and optionally project `fields` (CSV), `filter` (CSV 'col:op:val', ops lt|lte|gt|gte|eq|in, AND-combined), and `sort` (CSV, '-' = desc), with page[size]/page[number] pagination. Returns raw rows plus a truthful `_meta` (totalAvailable = upstream total-count, offset pagination). Value/amount fields are raw upstream strings — the string \"null\"/empty means 'no value', never 0. Covers rates_of_exchange + debt_outstanding without a dedicated tool.",
        inputSchema: TreasuryQueryDatasetInput,
        handler: (input) => treasury.queryDataset(input),
    }),
    defineTool({
        name: "treasury_debt_to_penny",
        description: "Daily total US public debt outstanding ('Debt to the Penny', keyless Treasury Fiscal Data). Returns record_date + totalPublicDebtOutstanding, debtHeldByPublic, intragovernmentalHoldings (USD). `latest` (default true) ⇒ the single most-recent day; set latest=false with startDate/endDate (ISO YYYY-MM-DD) for a date range, newest-first. Amounts are coerced to number|null (a null amount is 'no value reported', never 0).",
        inputSchema: TreasuryDebtToPennyInput,
        handler: (input) => treasury.debtToPenny(input),
    }),
    defineTool({
        name: "treasury_monthly_statement",
        description: "Monthly Treasury Statement (MTS table 1, keyless): federal receipts, outlays, and deficit/surplus by month. Returns record_date, classification, grossReceipts, grossOutlays, deficitSurplus (USD, number|null). `startDate`/`endDate` (ISO YYYY-MM-DD) filter record_date (default: trailing ~12 months). By default excludeSummaryRows=true drops the fiscal-year parent/summary header rows (whose amounts are all null) via a server-side filter, so totalAvailable and rows reflect real child line-items only; set excludeSummaryRows=false to include them. Highest-value budget-analysis tool.",
        inputSchema: TreasuryMonthlyStatementInput,
        handler: (input) => treasury.monthlyStatement(input),
    }),
    defineTool({
        name: "treasury_avg_interest_rates",
        description: "Average interest rate the US Treasury pays by security type/description (keyless Treasury Fiscal Data). Returns record_date, securityType, securityDescription, avgInterestRatePercent (percent, number|null). `latest` (default true) returns the most-recent month's full breakdown across security types (pinned to the latest record_date, memoized 5 min); set latest=false with startDate/endDate for a range. Optional `securityType` narrows by exact security_type_desc (e.g. 'Marketable', 'Non-marketable').",
        inputSchema: TreasuryAvgInterestRatesInput,
        handler: (input) => treasury.avgInterestRates(input),
    }),
    // ━━━ SEC EDGAR — filings / XBRL facts / CIK / full-text / frames / full-index / daily-index (keyless) (7) ━━━ ADR-0003 / ADR-0017 / ADR-0026 / ADR-0027
    defineTool({
        name: "edgar_lookup_cik",
        description: "Resolve a company ticker or name to its 10-digit SEC CIK (keyless, via SEC company_tickers.json). Input `query` (exact ticker or a title substring) ⇒ up to 50 { cik, ticker, title } matches; found:false on none. The CIK is the join key for edgar_company_filings/edgar_company_facts. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS — there is no authoritative CIK↔UEI join.",
        inputSchema: EdgarLookupCikInput,
        handler: (input) => edgar.lookupCik(input),
    }),
    defineTool({
        name: "edgar_company_filings",
        description: "A company's SEC filings (keyless, from data.sec.gov submissions). Input `cikOrTicker` (CIK or resolvable ticker/name), optional `forms` (e.g. ['10-K','8-K']), `limit` (≤100, default 20), `offset`, `fullHistory` (default false), `maxShards` (1..100, default 10). Returns filings with the REAL primary-document archive URL. By default returns the recent window (up to 1 year OR 1000 filings, whichever is more); set `fullHistory:true` to ALSO fetch the older filings.files[] shards (newest-first up to `maxShards`) and assemble the COMPLETE history (recent ++ shard001..N, descending, no re-sort). HONESTY: totalAvailable = recent + Σ ALL older-shard counts (the grand total, incl un-fetched shards — never recomputed down), so a capped/failed fan-out reads complete:false; a note discloses COMPLETE vs PARTIAL-BY-CAP (RAISE maxShards for older un-fetched shards — pagination does NOT reach them) vs PARTIAL-BY-FAILURE (a 404/bad-CIK/transient shard is skipped, missing filings disclosed, never fabricated); fullHistory serializes N shard GETs through the shared EDGAR throttle gate. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS.",
        inputSchema: EdgarCompanyFilingsInput,
        handler: (input) => edgar.companyFilings(input),
    }),
    defineTool({
        name: "edgar_company_facts",
        description: "Curated XBRL financial facts for a filer (keyless, from data.sec.gov companyfacts). Input `cikOrTicker`, optional `concepts` (default: 6 curated USD concepts — Revenues/RevenueFromContractWithCustomerExcludingAssessedTax, Assets, Liabilities, StockholdersEquity, NetIncomeLoss, CashAndCashEquivalentsAtCarryingValue), `unit` (default USD), `latest`. A concept absent for the filer is OMITTED (never 0); a concept present only in another unit (e.g. EPS in USD/shares) is reported under wrongUnit with a note.",
        inputSchema: EdgarCompanyFactsInput,
        handler: (input) => edgar.companyFacts(input),
    }),
    defineTool({
        name: "edgar_full_text_search",
        description: "Full-text search across EDGAR filings, 2001-present (keyless, efts.sec.gov). Input `q` (phrase in double-quotes for exact), optional `forms`, `startdt`/`enddt` (ISO), `ciks` (pin filings BY entities — numeric 10-digit SEC CIKs, zero-padded, exact-entity match), `entityName` (FUZZY filer-name narrowing — can match related filers, e.g. multiple 'Apple*'), `from` (offset; page size FIXED at 100 — no size param). Returns { accession, form, filingDate, entityNames, ciks, filingIndexUrl }. HONESTY: totalAvailable = the true match count, or a LOWER BOUND (totalIsLowerBound:true) when SEC reports ≥10000; a 0-result set with ciks/entityName applied is NOT proof of absence (verify the CIK via edgar_lookup_cik by name/ticker); from > 9900 is rejected (10000-result window). NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS.",
        inputSchema: EdgarFullTextSearchInput,
        handler: (input) => edgar.fullTextSearch(input),
    }),
    defineTool({
        name: "edgar_xbrl_frames",
        description: "Keyless cross-filer XBRL cross-section (SEC EDGAR frames, data.sec.gov). In ONE call, return EVERY filer's reported value for a single us-gaap/dei concept in a single calendar period — the complete cross-section — for peer benchmarking + distribution stats. Input `tag` (EXACT alnum concept, e.g. 'Assets'), `period` (CY2023 annual · CY2023Q1 quarterly · CY2023Q4I instant/trailing-I), optional `taxonomy` (us-gaap|dei), `unit` (default USD; EPS uses 'USD-per-shares'), `limit`/`offset` (CLIENT-SIDE window over the fully-fetched set), `includeStats`. Rows: { accn, cik, entityName, loc, end, val, start? } (start only for duration concepts). HONESTY: totalAvailable = SEC's own pts (asserted === data.length, else schema_drift THROW — no fake completeness); the whole frame is fetched upstream in one call and limit/offset is a disclosed client-side page (never a subset labeled complete); a tag/unit/period mismatch ⇒ 404 ⇒ found:false (NEVER a fabricated val:0); val is null-never-0; includeStats covers the FULL set with linear-interpolated percentiles (count===0 ⇒ all-null, never 0/NaN). taxonomy/tag/unit/period are validated path segments (enum+regex, re-checked pre-fetch) — no injection surface. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS.",
        inputSchema: EdgarXbrlFramesInput,
        handler: (input) => edgar.xbrlFrames(input),
    }),
    defineTool({
        name: "edgar_filing_index",
        description: "Bulk cross-filer SEC filing index for a quarter (keyless, from the www.sec.gov EDGAR full-index master.idx). Reads the WHOLE quarter's index (every filer's every filing — CIK|Company|Form|Date|Filename, ~370K rows), FULL-SCANS it, and returns offset-paginated filings matching CLIENT-SIDE filters with the EXACT total. Input `year` (>=1993, <= current year), `quarter` (1..4); optional `formType` (exact form, e.g. '8-K'), `cik` (numeric, leading-zero-safe), `companyContains` (LITERAL case-insensitive substring), `dateFrom`/`dateTo` (ISO YYYY-MM-DD), `limit` (<=1000, def 100), `offset`. Returns { year, quarter, indexFile, returned, totalAvailable, filings:[{ cik, cikPadded, companyName, formType, dateFiled, filename, filingUrl }] }. This is the BULK-ENUMERATION primitive (the per-filer edgar tools need a CIK you already hold; this sweeps a whole quarter by form/date/company, e.g. 'every 8-K in 2024 Q1'). HONESTY: totalAvailable is the EXACT match count over the full quarter scan — never a page length, never a byte-capped subset (SEC ignores HTTP Range); a 0-match result is a genuine EXACT ZERO (complete:true), NOT a truncation; a bounds-valid but unpublished quarter returns HTTP 403 and is surfaced as an AMBIGUOUS both-causes error (quarter-not-published OR the 10 req/s rate-block), never a bare rate-limit and never a fake-empty; a non-index / all-malformed body is refused as schema_drift; a future year / bad quarter is rejected pre-fetch (invalid_input, 0 fetch). The CURRENT quarter grows daily (totalAvailable is exact AS-OF-snapshot). filingUrl is a resolvable archive URL. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS — there is no authoritative CIK↔UEI join.",
        inputSchema: EdgarFilingIndexInput,
        handler: (input) => edgar.filingIndex(input),
    }),
    defineTool({
        name: "edgar_daily_filing_index",
        description: "Per-DAY cross-filer SEC filing index (keyless, from the www.sec.gov EDGAR daily-index master.YYYYMMDD.idx). The per-day sibling of edgar_filing_index (~30× smaller): reads ONE calendar day's index (every filer's every filing that day — CIK|Company|Form|Date|File Name, ~8K rows), FULL-SCANS it, and returns offset-paginated filings matching CLIENT-SIDE filters with the EXACT total. Answers the monitoring/alerting question the quarterly tool cannot ('every 8-K filed on 2024-01-03', 'watch a CIK day-by-day'). Input `date` (required ISO YYYY-MM-DD, >=1994-01-01, not future); optional `formType` (exact form, e.g. '8-K'), `cik` (numeric, leading-zero-safe), `companyContains` (LITERAL case-insensitive substring), `limit` (<=1000, def 100), `offset`. Returns { found, date, year, quarter, indexFile, returned, totalAvailable, filings:[{ cik, cikPadded, companyName, formType, dateFiled, filename, filingUrl }] }. HONESTY: totalAvailable is the EXACT match count over the full day scan — never a page length, never a byte-capped subset (SEC ignores HTTP Range). The daily-index's pervasive-403 empty model is disambiguated via the quarter's index.json existence oracle, RECENCY-AWARE: a day NEWER than the newest published index (weekend/holiday/not-yet-disseminated recent trading day) ⇒ found:false, complete:FALSE, retryable not-yet-disseminated note (NEVER a confident empty); an unlisted day INSIDE the covered range (a real weekend/holiday) ⇒ found:false, complete:true genuine-absent; a LISTED day whose .idx 403s ⇒ honest rate_limited; the oracle itself inconclusive ⇒ ambiguous both-causes upstream_unavailable. A non-real/future date is rejected pre-fetch (invalid_input, 0 fetch); a non-index / all-malformed body is refused as schema_drift. dateFiled is normalized to ISO from the compact YYYYMMDD column. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS — there is no authoritative CIK↔UEI join.",
        inputSchema: EdgarDailyFilingIndexInput,
        handler: (input) => edgar.dailyFilingIndex(input),
    }),
    // ━━━ Socrata / SODA — keyless SLED + E-rate open data (2) ━━━ ADR-0004
    defineTool({
        name: "socrata_query",
        description: "Query rows from an allowlisted Socrata/SODA open-data portal (keyless; ~a dozen US state portals + USAC E-rate on one identical API — state spend/checkbook/contract/vendor-payment datasets). Input `domain` (curated allowlist enum — the SSRF host guard), `datasetId` (4x4, from socrata_discover_datasets), optional SoQL `select`/`where`/`order`/`q`, `limit` (≤1000, def 100), `offset`, `withTotal` (def true). HONESTY: SODA's row response has no total, so a count(*) companion supplies an exact totalAvailable; if it fails the rows still return with totalAvailable:null + a note (hasMore is then inferred from page-fill, never a false complete). Genuine-empty ⇒ complete:true/total:0; an outage/400/404 THROWS (never a fake empty). Value fields are strings.",
        inputSchema: SocrataQueryInput,
        handler: (input) => socrata.query(input),
    }),
    defineTool({
        name: "socrata_discover_datasets",
        description: "Find Socrata dataset 4x4 ids by keyword via the Socrata catalog (keyless, api.us.socrata.com). Input `q` (e.g. 'procurement', 'vendor payments'), optional `domain` (scope to one allowlisted portal; omit to search the whole allowlist), `limit` (≤100, def 20). Returns [{ id, name, description, domain, updatedAt, link }] + totalAvailable = the catalog resultSetSize. Feed a result's `id` to socrata_query as `datasetId`. NOTE: the federated catalog does not index every allowlisted host (e.g. USAC E-rate) — those stay queryable via socrata_query with a known 4x4.",
        inputSchema: SocrataDiscoverDatasetsInput,
        handler: (input) => socrata.discoverDatasets(input),
    }),
    // ━━━ CKAN datastore_search — keyless SLED open data (2) ━━━ ADR-0006
    defineTool({
        name: "ckan_query",
        description: "Query rows from an allowlisted CKAN datastore resource (keyless; the FIRST source on the R2 DataSource port — state/city spend/checkbook/procurement/vendor tables on the identical CKAN Action API). Input `host` (curated allowlist enum — the SSRF host guard: data.ca.gov, data.virginia.gov, data.boston.gov), `resourceId` (36-char lowercase UUID, from ckan_discover_datasets), optional `q` (full-text), `filters` (constrained object {field:value} we JSON.stringify), `sort`, `limit` (≤1000, def 100), `offset`. HONESTY: CKAN's envelope carries a real result.total — the DEFAULT is an EXACT total (exact totalAvailable + hasMore); the rare estimated total (total_was_estimated:true) is disclosed via totalIsEstimated + a note and does NOT drive pagination (it can be above OR below the truth). Genuine-empty ⇒ complete:true/total:0; an outage/404/409 or success:false THROWS (never a fake empty). Values are typed per result.fields[].type.",
        inputSchema: CkanQueryInput,
        handler: (input) => ckan.query(input),
    }),
    defineTool({
        name: "ckan_discover_datasets",
        description: "Find CKAN datastore resource ids by keyword via package_search (keyless). Input `host` (allowlisted enum), `q` (e.g. 'procurement', 'checkbook'), `limit` (≤100, def 20). Returns per-resource rows [{ resourceId, name, datasetTitle, format, datastoreActive }] + totalAvailable = the matching DATASET count. Feed a datastoreActive:true result's `resourceId` to ckan_query (a datastoreActive:false resource is a raw file blob NOT in the datastore, not queryable).",
        inputSchema: CkanDiscoverDatasetsInput,
        handler: (input) => ckan.discoverDatasets(input),
    }),
    // ━━━ FDIC BankFind Suite — keyless institution directory + financials (2) ━━━ ADR-0028
    defineTool({
        name: "fdic_search_institutions",
        description: "Search the FDIC-insured-institution directory (keyless FDIC BankFind, api.fdic.gov/banks/institutions) — a regulated-entity directory for B2G counterparty / bank due-diligence. Structured filters: `state` (2-letter, → STALP), `activeOnly` (→ ACTIVE 1/0), `cert` (→ CERT, the STABLE entity key), plus `name`/`city` matched via FDIC's case-insensitive full-text `search` param (NOT `filters` — `filters=NAME:\"chase\"` is case-sensitive exact-keyword and returns a false-empty; `search=NAME:chase` finds JPMorgan Chase etc.). `limit` (≤1000, def 100), `offset` (≤100000), `sortBy` (allowlisted enum NAME/CERT/ASSET/ESTYMD/STALP/CITY/ACTIVE), `sortOrder` (ASC/DESC). Returns { institutions:[{ name, city, state, cert, assetUSD, active, establishedDate, id }] }. HONESTY: totalAvailable is the EXACT meta.total (stable across offset — never the page length); ASSET is published in $thousands and normalized to whole USD ×1000 (null-never-0 — a real 0 stays 0, absent → null); the ONLY honest empty is meta.total:0/data:[] ⇒ complete:true/total:0, every other envelope (400 errors[]/404/non-JSON/missing meta or data) THROWS (never a fake empty); a multi-word name/city is matched per-token (disclosed); the point-in-time snapshot build time is disclosed. NOTE: FDIC keys on CERT, not SAM UEI/DUNS.",
        inputSchema: FdicSearchInstitutionsInput,
        handler: (input) => fdic.searchInstitutions(input),
    }),
    defineTool({
        name: "fdic_institution_financials",
        description: "Quarterly financial time-series for ONE FDIC-insured institution by certificate number (keyless FDIC BankFind, api.fdic.gov/banks/financials). Input `cert` (REQUIRED FDIC certificate number, from fdic_search_institutions), `limit` (≤1000, def 100), `offset` (≤100000), `sortBy` (allowlisted enum REPDTE/ASSET/DEP/NETINC, def REPDTE), `sortOrder` (def DESC → newest quarter first). Returns { cert, financials:[{ cert, reportDate, assetUSD, depositsUSD, netIncomeUSD, id }] } (e.g. CERT 10363 → 169 quarterly rows). HONESTY: totalAvailable is the EXACT meta.total (stable across offset — page via offset for the full history); ASSET/DEP/NETINC are published in $thousands and normalized to whole USD ×1000 (null-never-0); the ONLY honest empty is meta.total:0/data:[] ⇒ complete:true/total:0, every other envelope THROWS (never a fake empty); the snapshot build time is disclosed.",
        inputSchema: FdicInstitutionFinancialsInput,
        handler: (input) => fdic.institutionFinancials(input),
    }),
    // ━━━ OpenFEMA — keyless disaster declarations + emergency-assistance spend (2) ━━━ ADR-0016
    defineTool({
        name: "fema_search_public_assistance",
        description: "Search FEMA Public Assistance funded projects — federal emergency-assistance spend to state/local/tribal applicants (keyless OpenFEMA, dataset PublicAssistanceFundedProjectsDetails v2, ~800k rows). Structured filters (module-built into an OData $filter; each LIVE-VERIFIED to narrow): `state` (→ stateAbbreviation), `disasterNumber`, `applicantId`, `damageCategoryCode` (e.g. 'B' = Emergency Protective Measures), `incidentType`, `minProjectAmount`/`maxProjectAmount` (projectAmount ge/le), `declaredDateFrom`/`declaredDateTo` (declarationDate ge/le). `limit` (≤1000, def 100 → $top), `offset` (→ $skip). HONESTY: the module ALWAYS sends $inlinecount=allpages so totalAvailable is the EXACT filtered total (metadata.count), never the page length; amount fields are number|null (a real 0 stays 0, absent → null); genuine-empty ⇒ complete:true/total:0; an outage/400/404 THROWS (never a fake empty).",
        inputSchema: FemaSearchPublicAssistanceInput,
        handler: (input) => fema.searchPublicAssistance(input),
    }),
    defineTool({
        name: "fema_disaster_declarations",
        description: "Look up FEMA disaster / emergency declarations by state, type, incident, year, or date (keyless OpenFEMA, dataset DisasterDeclarationsSummaries v2, ~70k rows). Structured filters (module-built into an OData $filter; each LIVE-VERIFIED to narrow): `state` (→ state), `incidentType` (e.g. 'Flood'), `declarationType` (DR/EM/FM), `fyDeclared`, `disasterNumber`, `declaredDateFrom`/`declaredDateTo` (declarationDate ge/le), `paProgramDeclared`/`iaProgramDeclared` (booleans). `limit` (≤1000, def 100 → $top), `offset` (→ $skip). HONESTY: the module ALWAYS sends $inlinecount=allpages so totalAvailable is the EXACT filtered total (metadata.count), never the page length; genuine-empty ⇒ complete:true/total:0; an outage/400/404 THROWS (never a fake empty). NOTE: per-dataset OData field names differ — 'state' here is the real field, whereas the public-assistance tool maps 'state' to 'stateAbbreviation'.",
        inputSchema: FemaDisasterDeclarationsInput,
        handler: (input) => fema.disasterDeclarations(input),
    }),
    // ━━━ FPDS-NG — federal contract AWARD ACTIONS (keyless ATOM) (1) ━━━ ADR-0012
    // The FIRST XML/ATOM source (bounded, ReDoS-safe hand-parser — the far.ts/gao.ts
    // lineage; NOT the getJson port). FPDS is the system-of-record USAspending
    // derives from — this closes the action-level / mod-level latest-truth gap.
    defineTool({
        name: "fpds_search_awards",
        description: "Search FPDS-NG federal contract AWARD ACTIONS (keyless ATOM) — the AUTHORITATIVE system-of-record for contract actions (each modification is its own transaction), the source USAspending.gov derives from (and lags 1-2 days). Structured filters ONLY, AND-combined (NO raw query — a typo'd FPDS field name is a SILENT ZERO, so the tool builds the fielded q): naics (PRINCIPAL_NAICS_CODE), vendorName, piid, departmentId, contractingAgencyName, signedDate range (from/to ISO), lastModified range, keyword. At least one filter is REQUIRED. Returns award/IDV rows { piid, modNumber, parentIdvPiid, actionType, signedDate, vendorName, vendorUei, ultimateParentUei, obligatedAmount, totalObligatedAmount, naics, psc, placeOfPerformanceState, extentCompeted, setAside, businessSize, socioeconomic, … } (content root is award OR IDV — both parse). HONESTY: page size is FIXED at 10; for >10 results totalAvailable is a LOWER BOUND (totalIsLowerBound:true; true count ∈ [total, total+9]) and you MUST paginate by pagination.hasMore (page-fullness), NEVER by totalAvailable (keyless deep-paging is capped ~200K far below the advertised total). Genuine-empty (offset 0) ⇒ complete:true/total:0 + a silent-zero disclosure; an empty page at offset>0 ⇒ totalAvailable:null/complete:false (deep-paging ceiling, ambiguous); an HTML/non-feed body or an all-null-piid page ⇒ schema_drift (never a fake empty); an outage/5xx/timeout THROWS. Amounts are number|null (a 0.00 obligation and negative de-obligations are REAL, absent ⇒ null). Prefer usas_* tools for spending rollups / sub-award graphs.",
        inputSchema: FpdsSearchAwardsInput,
        handler: (input) => fpds.searchAwards(input),
    }),
    // ━━━ NIH RePORTER v2 — keyless federal research-GRANT projects (1) ━━━ ADR-0014
    // The R2 getJson port's FIRST non-GET consumer (POST + JSON body). A NEW axis:
    // federal research-funding footprint by organization / UEI / state (recipient
    // enrichment, joinable to SAM/USAspending via primary_uei). SSRF surface = a
    // compile-time-constant URL; all filters ride in the module-built POST body.
    // Only live-confirmed-narrowing criteria ship (M1); agency_ic_codes is excluded
    // (silent no-op). The 15,000-record retrieval window is disclosed, not hidden.
    defineTool({
        name: "nih_reporter_search_projects",
        description: "Search awarded NIH RePORTER research-GRANT projects (keyless; api.reporter.nih.gov v2, POST/JSON — the FIRST non-GET getJson-port consumer) — the NEW federal research-funding recipient-enrichment axis (who receives NIH research money, by organization / state, joinable to SAM/USAspending via primary_uei). Structured, LIVE-CONFIRMED-narrowing criteria ONLY, AND-combined in a module-built body (NO raw passthrough): orgStates (UPPERCASE 2-letter USPS enum — the SSRF + silent-zero guard; a lowercase/unknown code silently returns zeros), orgNames (≤512 each, ≤20), fiscalYears (int array 1985..currentYear+1, ≤20), limit (1..500, def 50), offset (0..14,999, def 0). Returns { projects:[{ projectNum, projectTitle, fiscalYear, awardAmount, organization:{ name, state, primaryUei, primaryDuns, ueis, duns }, principalInvestigators, contactPiName, fundingIc }] } + honest _meta. HONESTY: (M2) records are RESEARCH GRANTS, NOT procurement contracts — primary_uei joins to SAM/USAspending recipients but the award nature differs (disclosed in every _meta.notes); totalAvailable = the EXACT meta.total (NEVER the page size, NEVER a lower bound); NIH caps keyless retrieval at the first 15,000 records (offset 0..14,999) — offset ≥ 15,000 ⇒ invalid_input, and past the window the count stays exact while records are UNREACHABLE (disclosed in a note; nextOffset is never a dead-end). Disclose-not-refuse: an unscoped query still returns the first page + the exact total + a narrow-your-criteria note. agencyIcCodes is intentionally NOT a filter (NIH silently drops it — it would be a false 'applied'). Genuine-empty (total:0) ⇒ complete:true/total:0; an outage/5xx/timeout THROWS; a 400 (bad offset/limit/type) ⇒ invalid_input; a 200 body that isn't {meta,results} or a non-numeric meta.total ⇒ schema_drift (never a fake empty). awardAmount is number|null (a real $0 award is 0, an absent amount is null).",
        inputSchema: NihSearchProjectsInput,
        handler: (input) => nih.searchProjects(input),
    }),
    // ━━━ NSF Awards API — keyless federal research-GRANT awards (2) ━━━ ADR-0020
    // Source #20. The grant-SIBLING of NIH RePORTER on a DIFFERENT agency: NSF
    // research-grant awards with recipient / PI / UEI enrichment, strengthening the
    // WEAK entity/recipient layer (ueiNumber/parentUeiNumber join to SAM/USAspending).
    // SSRF surface = a compile-time-constant host+path; all filters ride in a
    // module-built URLSearchParams from a validated whitelist. HONESTY: totalCount is
    // EXACT below 10,000 and SATURATES at 10,000 (ES track_total_hits ⇒ totalIsLower-
    // Bound + a note); the offset+rpp ≤ 10,000 retrieval window is clamped/disclosed;
    // a multi-word keyword is OR-tokenized (disclosed, M1); a serviceNotification at
    // HTTP 200 loud-fails (never a fake empty); grant≠contract in every response.
    defineTool({
        name: "nsf_search_awards",
        description: "Search awarded NSF research-GRANT awards (keyless; api.nsf.gov/services/v1/awards.json) — the NEW federal research-funding recipient-enrichment axis (who receives NSF research money, by organization / UEI / PI / state, joinable to SAM/USAspending via ueiNumber/parentUeiNumber). The grant-SIBLING of nih_reporter_search_projects on a different agency. LIVE-CONFIRMED-narrowing filters ONLY, module-built into a URLSearchParams query (NO raw passthrough): keyword (free text; MULTI-WORD is OR-tokenized — 'machine learning' = machine OR learning, disclosed in _meta.notes), awardeeStateCode (UPPERCASE 2-letter USPS enum — the SSRF + silent-zero guard; a non-state typo silently returns 0), awardeeName, ueiNumber (12-char UEI — an EXACT SAM/USAspending join), parentUeiNumber (parent-org roll-up), pdPIName, dateStart/dateEnd (STRICT mm/dd/yyyy on the award ACTION date — a wrong format is silently mis-parsed), limit (1..100, def 25 → rpp), offset (0..9999). Returns { awards:[{ id, title, agency, cfdaNumber, transType, awardee:{ name, city, stateCode, ueiNumber, parentUeiNumber }, performanceSite, principalInvestigator:{ fullName, firstName, lastName, middleInitial, email, id }, coPrincipalInvestigators, programOfficer, amounts:{ fundsObligatedAmt, estimatedTotalAmt, fundsObligatedByYear }, dates, program, activeAward, historicalAward }] } (abstract EXCLUDED — use nsf_get_award) + honest _meta. HONESTY: NSF Awards are RESEARCH GRANTS, NOT procurement contracts (ueiNumber joins to SAM/USAspending but the award nature differs — disclosed every response); totalAvailable = the EXACT metadata.totalCount below 10,000 and SATURATES at 10,000 (an ES track_total_hits cap ⇒ totalIsLowerBound:true + a note — the true total is ≥10,000 and only the first 10,000 are retrievable); NSF caps keyless retrieval at offset+rpp ≤ 10,000 (offset ≥ 10,000 ⇒ invalid_input; the outgoing rpp is clamped so a page never crosses the window). fundsObligatedAmt/estimatedTotalAmt arrive as STRINGS → number|null (a real $0 is 0, absent is null). Genuine-empty (totalCount:0) ⇒ complete:true/total:0; a serviceNotification at HTTP 200 (bad param / deep offset) ⇒ invalid_input/upstream_unavailable THROWS (never a fake empty); an outage/5xx/timeout THROWS; a 200 body that isn't {response:{award,metadata}} or a non-numeric totalCount ⇒ schema_drift. Feed a row's id to nsf_get_award for the full record + abstractText.",
        inputSchema: NsfSearchAwardsInput,
        handler: (input) => nsf.searchAwards(input),
    }),
    defineTool({
        name: "nsf_get_award",
        description: "Fetch ONE NSF award by its numeric award id (keyless; api.nsf.gov/services/v1/awards.json). Input `awardId` (all-digit, 5..9 digits — NSF ids are 7-digit numeric, live-verified; numeric-only is injection-safe). Returns { found, award:{ …the FULL curated record INCLUDING abstractText… } } + honest _meta. A nonexistent id ⇒ a genuine empty (totalCount:0) ⇒ found:false / award:null (NEVER a fabricated record). HONESTY: NSF Awards are RESEARCH GRANTS, NOT procurement contracts (ueiNumber joins to SAM/USAspending but the award nature differs — disclosed every response); fundsObligatedAmt/estimatedTotalAmt arrive as STRINGS → number|null (a real $0 is 0, absent is null); a serviceNotification at HTTP 200 ⇒ invalid_input/upstream_unavailable THROWS; an outage/5xx ⇒ THROWS; a 200 body that isn't {response:{award,metadata}} ⇒ schema_drift (never a fabricated record).",
        inputSchema: NsfGetAwardInput,
        handler: (input) => nsf.getAward(input),
    }),
    // ━━━ ClinicalTrials.gov API v2 — keyless clinical-study registrations (2) ━━━ ADR-0021
    // Source #21. The trial-REGISTRATION sibling of the research-GRANT sources (NIH
    // RePORTER / NSF Awards): leadSponsor / collaborators / organization are the
    // pharma/biotech/university/agency entities that ALSO receive federal money.
    // SSRF surface = a compile-time host literal (CT_BASE) + a single audited getCT
    // helper ([M2]); the single-study nctId is ^NCT\d{8}$-validated before the path
    // is built. HONESTY: countTotal=true is ALWAYS sent (the exact filter-respecting
    // uncapped total — a missing totalCount ⇒ schema_drift, NEVER studies.length);
    // an OPAQUE nextPageToken cursor (terminal = token absent, passed back verbatim);
    // funderType is a 4-value enum RE-VALIDATED IN THE HANDLER ([M1] — an invalid
    // value silently fake-empties at HTTP 200); multi-word term/sponsor/condition is
    // AND-tokenized (disclosed); trial≠federal-award caveat in every response.
    defineTool({
        name: "clinicaltrials_search_studies",
        description: "Search federally-registered clinical-research studies with LEAD-SPONSOR / COLLABORATOR / ORGANIZATION / FUNDING-SOURCE entity enrichment (keyless; clinicaltrials.gov/api/v2/studies) — the trial-REGISTRATION axis of the research-funding entity layer (the sponsor/collaborator NAMES overlap the pharma/biotech/university/agency entities in NIH RePORTER / NSF Awards / SAM / USAspending). LIVE-CONFIRMED-narrowing filters ONLY, module-built into a URLSearchParams query (NO raw passthrough): query.term (broad free-text), sponsor (→query.spons — a fuzzy sponsor NAME search), condition (→query.cond), location (→query.locn), overallStatus (a frozen 14-value enum → filter.overallStatus), funderType (a frozen 4-value enum nih/fed/industry/other → aggFilters — the FEDERAL-funding axis), pageSize (1..1000, def 20), pageToken (the OPAQUE cursor). Returns { studies:[{ nctId, briefTitle, orgStudyId, organization:{ name, class }, leadSponsor:{ name, class }, collaborators:[{ name, class }], fundingClass, overallStatus, startDate, studyType, phases, conditions }] } (briefSummary EXCLUDED — use clinicaltrials_get_study) + honest _meta. HONESTY: countTotal=true is ALWAYS sent ⇒ totalAvailable = the EXACT filter-respecting UNCAPPED total (NEVER studies.length; a missing/non-number totalCount ⇒ schema_drift; a genuine 0 ⇒ 0, never null); pagination is an OPAQUE cursor (offset/nextOffset null; nextCursor = nextPageToken passed back verbatim as pageToken; terminal = token absent; a bad token ⇒ HTTP 400 THROWS). funderType is re-validated IN the handler — an UNLISTED value silently returns totalCount:0 at HTTP 200 (a fake-empty trap) ⇒ invalid_input pre-fetch (0 fetch); funderType is an OVERLAPPING facet (counts MUST NOT be summed). A MULTI-WORD query.term/sponsor/condition is AND-conjunctive (ALL tokens must co-occur — disclosed). A registered trial is NOT a federal award and leadSponsor.name is FREE TEXT (not a UEI) ⇒ a NOMINAL name match only (disclosed every response). Genuine-empty (totalCount:0, no token) ⇒ complete:true/total:0; a bad overallStatus/pageToken/nctId ⇒ HTTP 400/404 THROWS; an outage/5xx ⇒ THROWS (never a fake empty). Feed a row's nctId to clinicaltrials_get_study for the full record + briefSummary.",
        inputSchema: ClinicaltrialsSearchStudiesInput,
        handler: (input) => clinicaltrials.searchStudies(input),
    }),
    defineTool({
        name: "clinicaltrials_get_study",
        description: "Fetch ONE clinical study by its NCT id (keyless; clinicaltrials.gov/api/v2/studies/{nctId}). Input `nctId` (the form NCT followed by exactly 8 digits, e.g. NCT02403869 — validated before the path is built, injection-safe). Returns { found, nctId, study:{ …the FULL curated entity record INCLUDING briefSummary… } } + honest _meta. A nonexistent id ⇒ HTTP 404 ⇒ found:false / study:null (NEVER a fabricated record). HONESTY: a registered trial is NOT a federal award and leadSponsor.name is FREE TEXT (not a UEI) ⇒ a NOMINAL name match only (disclosed every response); a 200 body missing protocolSection ⇒ schema_drift; an outage/5xx ⇒ THROWS.",
        inputSchema: ClinicaltrialsGetStudyInput,
        handler: (input) => clinicaltrials.getStudy(input),
    }),
    // ── ADR-0024: the aggregate/statistical SIBLING (+1 tool). EXACT per-value study
    //    counts over the WHOLE registry for whitelisted ENUM fields (/stats/field/values,
    //    the SAME fixed host + audited getCT). HONESTY: [M1] _meta.totalAvailable/returned
    //    count DISTINCT FIELD VALUES (not studies — a mandatory unit note); [M2] the
    //    whole-registry scope note carries NO frozen registry size; the returned<unique⇒
    //    truncated invariant discloses the 250-cap the instant it binds (never for v1
    //    ENUMs); a non-ENUM shape for a whitelisted field ⇒ schema_drift; Phase is
    //    ARRAY-valued (overlap/not-a-partition note); the facet-scoped trial≠award caveat
    //    every response. NO free-text ⇒ no tokenization.
    defineTool({
        name: "clinicaltrials_facet_counts",
        description: "Aggregate/statistical view: EXACT per-value STUDY counts over the WHOLE ClinicalTrials.gov registry for one or more whitelisted ENUM fields (keyless; clinicaltrials.gov/api/v2/stats/field/values) — the DISTRIBUTION sibling of clinicaltrials_search_studies (which gives the exact FILTERED total for a query). Input `fields`: 1..11 ENUM fields (deduped) — OverallStatus, StudyType, Phase, LeadSponsorClass (★ the funding-SOURCE-class distribution: NIH/FED/OTHER_GOV/INDUSTRY/OTHER/NETWORK/INDIV/UNKNOWN/AMBIG — richer than, and distinct from, the search tool's 4-value funderType filter), Sex, DesignAllocation, DesignPrimaryPurpose, DesignInterventionModel, DesignMasking, DesignObservationalModel, DesignTimePerspective. Module-built comma-joined into fields=<…> (NO raw passthrough). Returns { facets:[{ field, fieldPath, valueType, uniqueValuesCount, missingStudiesCount, returned, truncated, overlapping, values:[{ value, studiesCount }] }] } + honest _meta. HONESTY: each studiesCount/uniqueValuesCount is EXACT (typeof-checked to a NUMBER before num() — a non-number ⇒ schema_drift, NEVER a silent 0); a non-ENUM shape for a whitelisted field (e.g. a BOOLEAN {trueCount,falseCount}) ⇒ schema_drift (never read as empty). [M1] _meta.totalAvailable/returned count DISTINCT FIELD VALUES across the requested facet(s), NOT studies (a mandatory unit note points to facets[].values[].studiesCount / clinicaltrials_search_studies for a study count). These counts cover the ENTIRE registry and are NOT filterable — /stats/field/values rejects query.*/filter.*/countTotal/pageSize (HTTP 400) — a scope note cross-links the search tool for filtered totals. The returned<uniqueValuesCount⇒truncated invariant discloses the endpoint's hard 250-value cap the instant it binds (never for these v1 ENUM fields — all complete). Phase is ARRAY-valued (a study can carry several) ⇒ overlapping:true + a not-a-partition note (counts MUST NOT be summed); scalar fields partition the registry minus missingStudiesCount. A high missingStudiesCount ⇒ a note that the shown buckets cover a MINORITY of the registry. MANDATORY CAVEAT every response: a facet count is a distribution over trial REGISTRATIONS, NOT federal awards; LeadSponsorClass is the funding-SOURCE class, not a UEI-keyed award join. An unlisted field ⇒ invalid_input pre-fetch (0 fetch); a 404/400/5xx ⇒ THROWS (never a fake-empty distribution).",
        inputSchema: ClinicaltrialsFacetCountsInput,
        handler: (input) => clinicaltrials.facetCounts(input),
    }),
    // ━━━ EPA ECHO REST — keyless facility environmental compliance/enforcement (2) ━━━ ADR-0009
    // A NEW capability axis: facility & competitor environmental compliance-risk
    // screening / due diligence. KEYLESS (keylessMode:true, byte-clean init), single
    // fixed host + three fixed service paths (the SSRF core). The two-step QueryID
    // pagination is HIDDEN in-call (the ephemeral globally-recycled QueryID is never
    // exposed); the 200-with-error-body failure mode is guarded FIRST (never a fake
    // empty). M2: sic narrows (real filter), naics is dropped upstream (best-effort +
    // disclosed in _meta.filtersDropped/notes).
    defineTool({
        name: "echo_search_facilities",
        description: "Search EPA-regulated facilities by US state (+ optional sic / facilityName / majorOnly / federalOnly) with compliance/enforcement screening fields (EPA ECHO, keyless) — the NEW facility environmental compliance-risk / due-diligence axis (CAA/CWA/RCRA/SDWA violation, inspection, penalty, SNC history). Input `state` (REQUIRED enum — the SSRF + silent-zero guard), `sic` (2–4 digits, a REAL filter), `naics` (2–6 digits, BEST-EFFORT — ECHO DROPS it upstream, reported in _meta.filtersDropped + a note), `facilityName` (substring; a typo silently returns 0), `majorOnly`/`federalOnly` (bool), `limit` (≤1000, def 100), `offset` (multiple of limit). Returns { state, facilities:[…verbatim rows incl. RegistryID…], summary:{ queryRows, programCounts, totalPenalties } } + honest _meta. HONESTY: totalAvailable = the EXACT QueryRows total (NEVER the page size); a hidden two-step QueryID pagination fetches the rows (the QueryID is ephemeral/globally-recycled, never exposed); genuine-empty ⇒ complete:true/total:0; a queryset-limit overflow / bad query ⇒ invalid_input; an outage/5xx ⇒ THROWS (never a fake empty). Feed a row's RegistryID to echo_facility_report.",
        inputSchema: EchoSearchFacilitiesInput,
        handler: (input) => echo.searchFacilities(input),
    }),
    defineTool({
        name: "echo_facility_report",
        description: "Fetch the EPA ECHO Detailed Facility Report (DFR) for ONE facility by its FRS RegistryID (keyless) — the per-facility compliance / enforcement / inspection / permit deep-dive for competitor or acquisition-target due diligence. Input `registryId` (all-digit FRS id, 9–12 digits, from echo_search_facilities rows). Returns { registryId, report:{…verbatim compliance/enforcement/permit detail…} } + single-record _meta (complete:true, no pagination). A bad/unknown RegistryID ⇒ not_found (never a fabricated report).",
        inputSchema: EchoFacilityReportInput,
        handler: (input) => echo.facilityReport(input),
    }),
    // ━━━ api.data.gov keyed trio — Regulations.gov + Congress.gov (4) ━━━ ADR-0007
    // The project's FIRST KEYED source. The key (DATA_GOV_API_KEY, else the public
    // DEMO_KEY) travels ONLY in the X-Api-Key header — never the URL/label/_meta.
    // keylessMode:false (genuinely keyed); a DEMO_KEY note discloses the shared
    // ~10 req/hr ceiling + the free-key upgrade path.
    defineTool({
        name: "regulations_search_documents",
        description: "Search Regulations.gov rulemaking DOCUMENTS (rules, proposed rules, notices) — the flagship of the api.data.gov keyed source (JSON:API; DATA_GOV_API_KEY or the shared DEMO_KEY). Input `searchTerm`/`query`, filters (agencyId, docketId, documentType, withinCommentPeriod, postedDateGe/Le YYYY-MM-DD), `sort` (def -postedDate), `pageNumber` (1..40 HARD cap), `pageSize` (5..250, def 25). Returns { documents:[{ id, documentType, title, agencyId, docketId, postedDate, commentEndDate, openForComment, withinCommentPeriod, frDocNum, objectId }] } + honest _meta. HONESTY: totalAvailable = meta.totalElements (the EXACT real total, ~millions), NOT the capped totalPages; page[number] is hard-capped at 40 (10,000-record ceiling) — at the ceiling hasMore stays true but nextOffset is null + a note says how to reach the rest (narrow filters / seek by lastModifiedDate). Genuine-empty ⇒ complete:true/total:0; an outage/4xx THROWS (never a fake empty).",
        inputSchema: RegulationsSearchInput,
        handler: (input) => datagov.searchDocuments(input),
    }),
    defineTool({
        name: "regulations_search_comments",
        description: "Search Regulations.gov public COMMENTS on rulemakings — the killer B2G dataset (who is lobbying which rule). Same JSON:API envelope + input shape as regulations_search_documents (searchTerm/query, agencyId, docketId, postedDateGe/Le, sort, pageNumber 1..40, pageSize 5..250) against /v4/comments. Returns { comments:[{ id, documentType, title, agencyId, docketId, postedDate, objectId }] } + honest _meta (same totalElements-exact total + 40-page/10,000-record ceiling handling as documents).",
        inputSchema: RegulationsSearchInput,
        handler: (input) => datagov.searchComments(input),
    }),
    defineTool({
        name: "congress_search_bills",
        description: "Search Congress.gov BILLS/legislation (api.data.gov keyed; DATA_GOV_API_KEY or DEMO_KEY). Input optional `congress` (e.g. 118), `billType` (hr/s/hjres/sjres/hconres/sconres/hres/sres — requires `congress`), `fromDateTime`/`toDateTime` (ISO-8601 with offset), `offset`, `limit` (≤250, def 20). Returns { bills:[{ congress, type, number, title, originChamber, latestAction, updateDate, url }] } + _meta with totalAvailable = pagination.count (EXACT). NOTE: /v3/bill has no keyword search, so a `query` arg is NOT applied and is disclosed in _meta.filtersDropped. Outage/4xx THROWS (never a fake empty).",
        inputSchema: CongressSearchBillsInput,
        handler: (input) => datagov.searchBills(input),
    }),
    defineTool({
        name: "congress_get_bill",
        description: "Fetch ONE Congress.gov bill by id via /v3/bill/{congress}/{billType}/{billNumber} (api.data.gov keyed; DATA_GOV_API_KEY or DEMO_KEY). Input `congress` (int), `billType` (enum), `billNumber` (int). Returns { bill:{…} } + single-record _meta. A nonexistent bill ⇒ not_found (never fabricated).",
        inputSchema: CongressGetBillInput,
        handler: (input) => datagov.getBill(input),
    }),
    // ━━━ GovInfo (api.govinfo.gov) — the api.data.gov keyed trio's 3rd API (3) ━━━ ADR-0010
    // GPO-authoritative bulk publications (BILLS/PLAW/USCODE/CREC/CFR-FR editions/
    // BUDGET/GAOREPORTS) with PDF/XML/MODS downloads + provenance. 2nd consumer of the
    // shared api.data.gov env-key adapter (datagovKey.ts) — key ONLY in the X-Api-Key
    // header, keylessMode:false, DEMO_KEY disclosure. The novel piece is the OPAQUE
    // offsetMark cursor: continuation rides in _meta.nextCursor (passed back as
    // pageMark); pagination.offset/nextOffset are null (no numeric offset). The raw
    // upstream nextPage URL (which embeds pageSize+api_key) is NEVER surfaced.
    defineTool({
        name: "govinfo_list_collections",
        description: "List the GovInfo collection catalog (GPO-authoritative publications; api.data.gov keyed — DATA_GOV_API_KEY or the shared DEMO_KEY). No input. Returns { collections:[{ collectionCode, collectionName, packageCount, granuleCount }] } + _meta (complete:true, totalAvailable = collection count). The discovery entry-point: feed a collectionCode to govinfo_search_packages. Memoized ~6h; also the validator source for search_packages' collection arg. packageCount = whole packages; granuleCount = sub-package granules (a missing count is null, never 0).",
        inputSchema: GovinfoListCollectionsInput,
        handler: () => govinfo.listCollections(),
    }),
    defineTool({
        name: "govinfo_search_packages",
        description: "Search GovInfo packages in a collection modified since a date (GPO-authoritative bulk publications; api.data.gov keyed). Input `collection` (uppercase code — validated against the live catalog; an unknown code ⇒ invalid_input listing valid codes, NEVER a misleading empty), `startDate`/`endDate?` (YYYY-MM-DD or ISO datetime; filters by lastModified — the record UPDATE date, NOT dateIssued — disclosed in _meta), `pageSize?` (1..1000, def 100), `pageMark?` (opaque cursor, def '*'). Returns { collection, packages:[{ packageId, title, dateIssued, lastModified, docClass, congress, packageLink }] } + cursor _meta. HONESTY: totalAvailable = count (the EXACT real total, NOT the page size); GovInfo uses an OPAQUE cursor, so pagination.offset/nextOffset are null — continue by passing _meta.nextCursor back as `pageMark` (hasMore:false / nextCursor:null = last page). The raw upstream nextPage URL is never surfaced (it embeds the key). Genuine-empty ⇒ complete:true/total:0; outage/4xx THROWS (never a fake empty). CFR/ECFR/FR collections carry a note routing to the ecfr_*/fed_register_* tools for point lookups.",
        inputSchema: GovinfoSearchPackagesInput,
        handler: (input) => govinfo.searchPackages(input),
    }),
    defineTool({
        name: "govinfo_get_package",
        description: "Fetch ONE GovInfo package's summary (metadata + download links txt/xml/pdf/mods/premis/zip + related links) by packageId (api.data.gov keyed). Input `packageId` (from govinfo_search_packages, e.g. 'BILLS-118hr1enr', 'PLAW-117publ58', 'CFR-2023-title1-vol1'). Returns { found:true, packageId, package:{…} } + single-record _meta (complete:true). A nonexistent packageId ⇒ found:false (HTTP 404, never a fabricated summary). Any api_key embedded in a download link is stripped key-free before the payload is surfaced.",
        inputSchema: GovinfoGetPackageInput,
        handler: (input) => govinfo.getPackage(input),
    }),
    // ━━━ US Census Geocoder — keyless territory/geospatial (2) ━━━ ADR-0023
    // A NEW capability domain (territory/geospatial) serving the WEAK set-aside /
    // place-of-performance layer. KEYLESS (keylessMode:true, byte-clean init), single
    // fixed host + two fixed endpoint paths (the SSRF core — no id in the path). The
    // layer mapper resolves each canonical geography by SUFFIX pattern (the key names
    // ROLL: "119th Congressional Districts") and handles >1 KEY PER SUFFIX ([B1] — a
    // historical vintage returns 111th+113th CDs with DISTINCT GEOIDs; both surfaced +
    // a note, never silently dropped). Drift-guard scoped to 4 sentinels ([M1]); the
    // vintage enum is the (benchmark,vintage) UNION ([M2]); GEOIDs stay strings.
    defineTool({
        name: "census_geocode_address",
        description: "Resolve a one-line US address → its matched address(es) + the Census GEOGRAPHIES that drive set-aside / place-of-performance analysis (US Census Geocoder, keyless; geocoding.geo.census.gov/geocoder/geographies/onelineaddress) — the NEW territory/geospatial domain. Input `address` (≤500 chars), optional `benchmark` (default Public_AR_Current) / `vintage` (default Current_Current). Returns { matches:[{ matchedAddress, coordinates:{x,y}, tigerLineId, addressComponents, geographies:{ state, county, congressionalDistrict, censusTract, censusBlock, place, cbsaOrCsa, stateLegislativeUpper, stateLegislativeLower } }], matchCount, vintageResolved } + honest _meta. Each geography = { layerKey (the RAW vintage-versioned key, e.g. '119th Congressional Districts'), geoid (a STRING — leading zeros survive: '0102'), name }. HONESTY: genuine-empty (addressMatches:[]) ⇒ matchCount:0/complete:true (NOT an error; verify spelling + add city/state/ZIP); MULTIPLE matches are ALL surfaced (each with its own geographies) + a note; a historical vintage can return >1 layer per type (e.g. 111th+113th Congressional Districts with DISTINCT GEOIDs for a redistricted place) ⇒ BOTH surfaced (chosen + alternates[]) + a mandatory note (NEVER silently dropped); the resolved benchmark/vintage is echoed + a 'Current is a MOVING vintage' note; an invalid/missing benchmark/vintage ⇒ HTTP 400 THROWS (never a fake empty); an outage/5xx ⇒ THROWS. MANDATORY CAVEAT every response: these are a NOMINAL input, NOT an authoritative HUBZone / Opportunity-Zone / set-aside determination (those require SBA's HUBZone map / Treasury's OZ-tract list). Feed censusTract.geoid / county.geoid onward to those authoritative sources.",
        inputSchema: CensusGeocodeAddressInput,
        handler: (input) => census.geocodeAddress(input),
    }),
    defineTool({
        name: "census_geographies_by_coordinates",
        description: "Resolve a longitude/latitude point → the Census GEOGRAPHIES at that point, no address parsing (US Census Geocoder, keyless; geocoding.geo.census.gov/geocoder/geographies/coordinates). For a caller that already holds coordinates. Input `longitude`/`x` (required, -180..180) + `latitude`/`y` (required, -90..90) — x=longitude, y=latitude (the Census API's own names; `longitude`/`latitude` are the clearer aliases), optional `benchmark`/`vintage`. Returns { found, coordinates:{x,y}, geographies:{ state, county, congressionalDistrict, censusTract, censusBlock, place, cbsaOrCsa, stateLegislativeUpper, stateLegislativeLower }, vintageResolved } + honest _meta. HONESTY: a point outside any US Census geography (offshore / out-of-US) ⇒ geographies all null / found:false / complete:true (an honest empty geographies:{}, NOT an error); coordinate finiteness is re-guarded PRE-fetch (a non-finite x/y ⇒ invalid_input, 0 fetch); a historical vintage's >1-layer-per-type is surfaced with alternates[] + a note (same [B1] multi-key handling as the address tool); GEOIDs are STRINGS (leading zeros survive); the resolved benchmark/vintage is echoed + a moving-vintage note; a bad benchmark/vintage ⇒ HTTP 400 THROWS; an outage/5xx ⇒ THROWS. MANDATORY CAVEAT every response: these are a NOMINAL input, NOT an authoritative HUBZone / Opportunity-Zone / set-aside determination.",
        inputSchema: CensusGeographiesByCoordinatesInput,
        handler: (input) => census.geographiesByCoordinates(input),
    }),
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
            // and `error.retryable` to decide what to do next. Classification is
            // centralized in `toToolError`, which maps a Zod input-validation failure
            // (e.g. a value outside an enum, or a limit above the max) to a
            // NON-retryable `invalid_input` with readable field-level issues — never a
            // generic `unknown` carrying Zod's raw JSON dump.
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
    else if (toolName.startsWith("sba_")) {
        source = "sba.gov naics.json (keyless)";
    }
    else if (toolName.startsWith("gao_")) {
        source = "gao.gov Legal Products RSS + decision pages (keyless)";
    }
    else if (toolName.startsWith("fpds_")) {
        source = "www.fpds.gov ezSearch ATOM (FPDS-NG, keyless)";
    }
    else {
        source = "unknown";
    }
    return buildMeta({ source, keylessMode, complete: true, truncated: false });
}
export async function runTool(name, args, sam) {
    // R1 (ADR-0001) — registry dispatch. Every tool's TOOLS[] entry carries a
    // co-located `handler`: route through it by parsing `args` with the entry's
    // own schema, then calling the handler. Its return value flows into
    // CallTool's existing envelope logic (isMetaBundle? buildMeta :
    // synthesizeDefaultMeta) byte-identically. The legacy dispatch `switch` is
    // gone (all 52 tools migrated) — an unknown name has no entry and throws.
    const entry = TOOLS.find((t) => t.name === name);
    if (entry?.handler) {
        const input = entry.inputSchema.parse(args);
        return await entry.handler(input, { sam });
    }
    throw new Error(`Unknown tool: ${name}`);
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
// Start the stdio server ONLY when run directly (node dist/server.js / the
// mcp-sam-gov bin) — NOT when imported (the fault-injection tests import
// runTool to exercise the REAL tool-dispatch over a mocked fetch). Preserves
// the launch: `node dist/server.js` → argv[1] === this file → main() runs;
// smoke-test.mjs's spawn("node", ["dist/server.js"]) is the same (a subprocess
// whose argv[1] is dist/server.js); an `import { runTool }` sets argv[1] to the
// importing script → no match → main() does NOT run, the server is not spawned.
// Was this module run DIRECTLY (node dist/server.js / the mcp-sam-gov bin), or
// merely IMPORTED (the fault-injection tests import runTool over a mocked fetch)?
// Only the direct case starts the stdio server. Canonicalize BOTH sides through
// realpathSync before comparing, so it holds no matter how symlinks land:
//   - the `mcp-sam-gov` bin is a symlink to dist/server.js on Unix/macOS, and npm
//     installs the package dir itself via a symlink — argv[1] must be realpath'd;
//   - under `--preserve-symlinks-main`, Node keeps import.meta.url as the symlink
//     path, so THAT side must be realpath'd too.
// Realpath'ing both and comparing as file:// URLs (pathToFileURL normalizes
// Windows drive-casing/slashes) makes the check robust across every real launch.
const invokedDirectly = (() => {
    const argv1 = process.argv[1];
    if (!argv1)
        return false;
    const canonical = (p) => {
        try {
            return pathToFileURL(realpathSync(p)).href;
        }
        catch {
            return pathToFileURL(p).href; // not a real path → best-effort raw
        }
    };
    try {
        return canonical(argv1) === canonical(fileURLToPath(import.meta.url));
    }
    catch {
        return import.meta.url === pathToFileURL(argv1).href; // extreme fallback
    }
})();
if (invokedDirectly) {
    main().catch((err) => {
        console.error("[mcp-sam-gov] FATAL:", err);
        process.exit(1);
    });
}
//# sourceMappingURL=server.js.map