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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  SamGovClient,
  daysUntilResponse,
  applyResponseDeadlineWindow,
  type SamSetAside,
  type SamProcurementType,
} from "./sam-gov/index.js";
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
import * as datagovCatalog from "./datagov-catalog.js";
import * as govinfo from "./govinfo.js";
import * as fpds from "./fpds.js";
import * as nih from "./nih.js";
import * as nsf from "./nsf.js";
import * as clinicaltrials from "./clinicaltrials.js";
import * as census from "./census.js";
import * as censusEconomic from "./census-economic.js";
import * as epaEnvirofacts from "./epa-envirofacts.js";
import * as cmsUtilization from "./cms-utilization.js";
import * as cmsHospital from "./cms-hospital.js";
import * as cmsFacility from "./cms-facility.js";
import * as cmsSupplier from "./cms-supplier.js";
import * as fred from "./fred.js";
import * as bea from "./bea.js";
import * as gsaPerdiem from "./gsa-perdiem.js";
import * as dol from "./dol.js";
import * as lda from "./lda.js";
import * as courtlistener from "./courtlistener.js";
import * as nonprofit from "./nonprofit.js";
import * as fema from "./fema.js";
import * as fdic from "./fdic.js";
import * as bls from "./bls.js";
import * as ofac from "./ofac.js";
import * as nvd from "./nvd.js";
import * as nppes from "./nppes.js";
import * as cms from "./cms.js";
import * as fac from "./fac.js";
import * as usitc from "./usitc.js";
import * as openfda from "./openfda.js";
import * as openfdaDevice from "./openfda-device.js";
import * as nhtsa from "./nhtsa.js";
import * as cpsc from "./cpsc.js";
import { fetchAttachmentText } from "./attachments.js";
import * as keys from "./keys.js";
import { toToolError, ToolErrorCarrier, errorFromResponse } from "./errors.js";
import {
  buildMeta,
  isMetaBundle,
  withMeta,
  type ResponseMeta,
} from "./meta.js";
import { pathToFileURL, fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const SERVER_NAME = "mcp-sam-gov";
// Kept in lockstep with package.json / manifest.json / server.json.
// Keep in sync with package.json "version" (asserted at release; see CHANGELOG).
const SERVER_VERSION = "1.4.0";

// ─── Tool input schemas (Zod) ────────────────────────────────────

const SamSearchInput = z.object({
  query: z.string().optional().describe("Free-text title query"),
  ncode: z.string().optional().describe("NAICS code, e.g. '541512'"),
  organizationName: z
    .string()
    .optional()
    .describe(
      "Issuing agency canonical name (e.g. 'Department of Veterans Affairs'). Use sam_lookup_organization or usas_lookup_agency to resolve abbreviations.",
    ),
  state: z
    .string()
    .optional()
    .describe("Place-of-performance state, 2-letter, e.g. 'MD'"),
  setAside: z.array(z.string()).optional().describe(
    "Set-aside codes: SBA, 8A, HZS, SDVOSBC, WOSB, EDWOSB, VSA, VSS",
  ),
  limit: z.number().min(1).max(50).optional(),
  offset: z.number().min(0).optional().describe("Page offset into the result set (default 0)."),
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
    .describe(
      "Issuing agency canonical name (e.g. 'Department of Veterans Affairs'). NOTE: the keyless endpoint has NO organization-name filter — it is sent best-effort and flagged in _meta.filtersDropped; filter client-side on the returned `agency`.",
    ),
  state: z
    .string()
    .optional()
    .describe("Place-of-performance state, 2-letter, e.g. 'MD'"),
  setAside: z.array(z.string()).optional().describe(
    "Set-aside codes: SBA, 8A, HZS, SDVOSBC, WOSB, EDWOSB, VSA, VSS",
  ),
  noticeType: z
    .array(z.enum(["r", "p", "s", "k", "i", "u"]))
    .optional()
    .describe(
      "Pre-solicitation notice-type codes to include. r=Sources Sought, p=Presolicitation, s=Special Notice (the DEFAULT shaping window = ['r','p','s']); k=Combined Synopsis/Solicitation, i=Intent to Bundle, u=Justification (J&A) are opt-in adjacency/incumbent tells. Ranked r/p over s via noticeTypeCode.",
    ),
  responseDeadlineFrom: z
    .string()
    .optional()
    .describe(
      "ISO date lower bound for responseDeadline. APPLIED CLIENT-SIDE over the fetched page (the keyless feed ignores rdlfrom/rdlto) — disclosed in _meta.filtersDropped. A notice with no deadline is excluded from a windowed query.",
    ),
  responseDeadlineTo: z
    .string()
    .optional()
    .describe(
      "ISO date upper bound for responseDeadline. APPLIED CLIENT-SIDE over the fetched page (see responseDeadlineFrom).",
    ),
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
    .describe(
      "Resource id from sam_get_opportunity → resourceLinks (URL-tail hex)",
    ),
});

const SamFetchAttachmentTextInput = z.object({
  url: z
    .string()
    .url()
    .refine(
      (u) => {
        try {
          const p = new URL(u);
          const h = p.hostname.toLowerCase();
          return (
            p.protocol === "https:" &&
            (h === "sam.gov" || h === "api.sam.gov" || h.endsWith(".sam.gov"))
          );
        } catch {
          return false;
        }
      },
      {
        message:
          "url must be an https:// SAM attachment download URL on sam.gov / api.sam.gov (from sam_get_opportunity's attachments[].url). Arbitrary hosts are refused (SSRF hygiene).",
      },
    )
    .describe(
      "SAM attachment download URL from sam_get_opportunity → attachments[].url / resourceLinks (https://sam.gov/api/prod/opps/v3/opportunities/resources/files/{id}/download). Must be a sam.gov / api.sam.gov host.",
    ),
  maxChars: z
    .number()
    .int()
    .min(1000)
    .max(500_000)
    .optional()
    .describe(
      "Cap on returned text characters (default 200000, max 500000). Truncation is disclosed in _meta (truncated:true).",
    ),
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
  agency: z
    .string()
    .describe(
      "Canonical agency NAME (e.g. 'Department of Veterans Affairs'), NOT a toptier code — this filter matches by name; a numeric code silently matches nothing. Resolve via usas_lookup_agency / usas_list_toptier_agencies.",
    ),
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
  // DRIFT/SEMANTICS FIX (dogfooding 2026-07-16): this filters the SUBAWARDEE name,
  // NOT the prime. On spending_by_award{subawards:true} the only keyless recipient
  // filter is `recipient_search_text`, which USAspending matches against the
  // SUB-recipient (live-verified: recipient_search_text:["Leidos"] returns rows
  // whose Sub-Awardee Name IS Leidos, under OTHER primes). The old name
  // `primeRecipientName` promised the opposite. Renamed to `subRecipientName`; the
  // #182 unknown-key guard makes the old name fail loud with the valid-key list.
  subRecipientName: z.string().optional(),
  agency: z.string().optional(),
  naics: z.string().optional(),
  fiscalYear: z.number().int().min(2007).optional(),
  limit: z.number().min(1).max(50).optional(),
});

const UsasExpiringInput = z.object({
  agency: z.string().optional(),
  naics: z.string().optional(),
  // M2 (W3-1 honesty): `fiscalYear` removed. The recompete radar windows on the
  // current PoP end date around TODAY, not an obligation FY, so it was
  // inapplicable — advertised here, then validated and silently discarded by
  // searchExpiringContracts (never forwarded) with empty filtersDropped. Dropping
  // it from the schema stops the validated-then-discarded arg at the door.
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
    .describe(
      "Lower edge of the recompete window in days from today (default -90 = include contracts that ended up to 90 days ago).",
    ),
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
    .describe(
      "Also return the potential (option-inclusive) PoP end date + extendableDays (default false).",
    ),
  actionDateLookbackYears: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "action_date lower bound in years (default 3). Contracts with no recorded action in this span are excluded — this bound makes the End-Date sort reach the window.",
    ),
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
    .describe(
      "Max 100-row pages to scan before giving up (default 8). If exhausted before the window ends, results are a lower bound and totalAvailable is null.",
    ),
});

const UsasAwardDetailInput = z.object({
  generatedInternalId: z
    .string()
    .describe("From spending_by_award results — e.g. CONT_AWD_*"),
});

const UsasAnalyzeIncumbentInput = z.object({
  generatedInternalId: z
    .string()
    .describe(
      "The ONE award to analyze — generatedInternalId from usas_search_individual_awards / usas_search_awards_by_recipient / usas_search_recompetes (e.g. CONT_AWD_*).",
    ),
  includeOtherAwards: z
    .boolean()
    .optional()
    .describe(
      "Also return the incumbent's other awards in the same agency×NAICS via one bounded recipient search (default true).",
    ),
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
  agency: z
    .string()
    .optional()
    .describe(
      "Canonical agency NAME (e.g. 'Department of Veterans Affairs'), NOT a toptier code — this filter matches by name; a numeric code silently matches nothing. Resolve via usas_lookup_agency.",
    ),
  naics: z.string().optional(),
  fiscalYear: z.number().int().min(2007).optional(),
  limit: z.number().min(1).max(50).optional(),
});

const UsasCfdaInput = z.object({
  agency: z
    .string()
    .optional()
    .describe(
      "Canonical agency NAME (e.g. 'Department of Veterans Affairs'), NOT a toptier code — this filter matches by name; a numeric code silently matches nothing. Resolve via usas_lookup_agency.",
    ),
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
    .describe(
      "3-4 digit toptier code from usas_lookup_agency (e.g. '036' for VA)",
    ),
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
    .describe(
      "Federal Register agency slugs, e.g. ['veterans-affairs-department']. Use fed_register_list_agencies to resolve.",
    ),
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

const FedRegPublicInspectionInput = z.object({
  mode: z
    .enum(["current", "date", "search"])
    .optional()
    .describe(
      "Retrieval surface (default current): 'current' = all documents on public inspection now; 'date' = a specific inspection day (requires `date`); 'search' = server-side full-text over the on-inspection set (via `term`).",
    ),
  date: z
    .string()
    .optional()
    .describe(
      "YYYY-MM-DD; REQUIRED iff mode='date'. Rides conditions[available_on] as a query param (never a path segment). Validated (real calendar date, 1994..currentYear+1) before any fetch.",
    ),
  term: z
    .string()
    .optional()
    .describe(
      "Full-text query; VALID only in mode='search'. Rides conditions[term] (server-side).",
    ),
  type: z
    .enum(["RULE", "PRORULE", "NOTICE", "PRESDOCU"])
    .optional()
    .describe("Client-side document-type filter (applied in all modes)."),
  agency: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional()
    .describe(
      "Client-side agency-slug filter; matches ANY of a doc's agencies[].slug. Resolve slugs via fed_register_list_agencies.",
    ),
  specialOnly: z
    .boolean()
    .optional()
    .describe(
      "Client-side filter keeping only filing_type='special' (off-cycle/emergency — a stronger, sooner signal).",
    ),
  limit: z.number().min(1).max(200).optional().describe("Page size (default 20)."),
  offset: z.number().min(0).optional().describe("Page offset (default 0)."),
});

// eCFR
const EcfrSearchInput = z.object({
  query: z.string(),
  titleNumber: z
    .number()
    .optional()
    .describe(
      "CFR title (1-50). e.g. 48 = FAR (Federal Acquisition Regulation), 2 = Federal financial assistance.",
    ),
  perPage: z.number().min(1).max(20).optional(),
});

const EcfrListTitlesInput = z.object({});

// FAR / DFARS clause lookup (eCFR versioner full endpoint)
const FarClauseLookupInput = z.object({
  clauseNumber: z
    .string()
    .regex(
      // Accept an optional FAR/DFARS prefix + the NN.NNN-N / NNN.NNN-NNNN core.
      /^\s*(?:d?far[s]?\b[\s.:#-]*)?\d{1,3}\.\d{3,4}-\d{1,4}\s*$/i,
      "clauseNumber must be a FAR/DFARS clause like '52.212-4', '252.204-7012', or '52.204-25' (an optional 'FAR '/'DFARS ' prefix is allowed).",
    )
    .describe(
      "FAR or DFARS clause/provision number, e.g. '52.212-4', '252.204-7012', '52.204-25'. An optional 'FAR '/'DFARS ' prefix is stripped.",
    ),
  includePrescription: z
    .boolean()
    .optional()
    .describe(
      "Also fetch the prescribing section parsed from the clause's 'As prescribed in …' opener (the rule for WHEN the clause applies). Default true.",
    ),
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "asOfDate must be YYYY-MM-DD.")
    .optional()
    .describe(
      "Point-in-time codification date (YYYY-MM-DD). Defaults to Title 48's current up_to_date_as_of.",
    ),
});

// FAR compliance matrix (composes far_clause_lookup over a cited-clause list)
const FarComplianceMatrixInput = z.object({
  clauses: z
    .array(
      z
        .string()
        .regex(
          // Same clause grammar as FarClauseLookupInput (optional FAR/DFARS prefix).
          /^\s*(?:d?far[s]?\b[\s.:#-]*)?\d{1,3}\.\d{3,4}-\d{1,4}\s*$/i,
          "each clause must be a FAR/DFARS clause like '52.212-4', '252.204-7012', or '52.204-25' (an optional 'FAR '/'DFARS ' prefix is allowed).",
        ),
    )
    .min(1)
    .max(25)
    .describe(
      "The FAR/DFARS clause numbers a solicitation cites (e.g. from its 52.252-2 'Clauses Incorporated by Reference' list), 1–25. Deduped case-insensitively. e.g. ['52.212-4','52.204-25','252.204-7012'].",
    ),
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "asOfDate must be YYYY-MM-DD.")
    .optional()
    .describe(
      "Point-in-time codification date (YYYY-MM-DD) — typically the solicitation issue date. Defaults to Title 48's current up_to_date_as_of.",
    ),
  includePrescription: z
    .boolean()
    .optional()
    .describe(
      "Also fetch each clause's prescribing section (the 'As prescribed in …' rule for WHEN it applies). Default true.",
    ),
  flagGates: z
    .boolean()
    .optional()
    .describe(
      "Tag resolved rows that are pass/fail award-eligibility gates (Section 889, CMMC, limitations on subcontracting) with a gate label; others get gate:null. Default true. false ⇒ all gate:null.",
    ),
});

// FAR/DFARS-scoped search (composes ecfr_search, filtered to FAR/DFARS + deduped)
const FarSearchInput = z.object({
  query: z
    .string()
    .min(1, "query must be a non-empty search string.")
    .describe(
      "What to search FAR/DFARS text for, e.g. 'limitations on subcontracting', 'covered defense information', 'commercial item'.",
    ),
  scope: z
    .enum(["far", "dfars", "both"])
    .optional()
    .describe(
      "Which corpus to search: 'far' (Title 48 chapter 1, the default), 'dfars' (chapter 2), or 'both'. Excludes GSAM/agency supplements.",
    ),
  dedupeVersions: z
    .boolean()
    .optional()
    .describe(
      "Collapse each section's historical versions to the current (in-force) one. Default true. false ⇒ return all raw rows incl. historical.",
    ),
  partsOnly: z
    .array(z.number().int())
    .optional()
    .describe(
      "Restrict results to these FAR/DFARS parts, e.g. [52] for clause text only, [12] for commercial-item policy.",
    ),
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
    .describe(
      "6-digit NAICS code to look up the SBA small-business size standard for (e.g. '541512').",
    ),
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
    .describe(
      "Which wage-determination law: 'sca' (Service Contract Act — services) or 'dba' (Davis-Bacon Act — construction). 'dba' is normalized to the API's 'dbra' index.",
    ),
  state: z
    .string()
    .optional()
    .describe(
      "2-letter USPS state code (e.g. 'VA'), applied SERVER-SIDE. A full name is applied client-side instead.",
    ),
  county: z
    .string()
    .optional()
    .describe(
      "County name (substring match), applied CLIENT-SIDE over the fetched page only (the API has no county filter).",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Matches the WD NUMBER/TITLE only — NOT occupation/job title (q=guard returns 0).",
    ),
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
    .describe(
      "fullReferenceNumber of the wage determination (e.g. '2015-4093' for SCA, 'IA20260028' for DBA) from sam_search_wage_determinations.",
    ),
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
    .describe(
      "'parsed' (structured rates, default), 'raw' (the full document text), or 'both'. Use 'raw'/'both' when parseConfidence is low.",
    ),
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
    .describe(
      "Education filter — use CALC's SHORT CODES (e.g. 'HS','AA','BA','MA','PHD'); the displayed education_level field may show full words.",
    ),
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
    .describe(
      "Firm or individual name to screen (drives the server-side exclusions text search). Provide at least one of query/uei/cage.",
    ),
  uei: z
    .string()
    .optional()
    .describe(
      "SAM UEI to match. Used as the text query when it is the sole selector; post-filtered against results when combined with a name query.",
    ),
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
    .describe(
      "SAM UEI of the entity to screen (PREFERRED — most precise). Provide at least one of uei/cage/name.",
    ),
  cage: z
    .string()
    .optional()
    .describe("CAGE code of the entity to screen."),
  name: z
    .string()
    .optional()
    .describe(
      "Legal entity name to screen (drives the keyless exclusions text search; normalized-name gated). Provide at least one of uei/cage/name.",
    ),
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
    .describe(
      "Socioeconomic certification (award-derived, NOT the SBA registry of record). One of: small_business, 8a_program_participant, woman_owned_business, women_owned_small_business, economically_disadvantaged_women_owned_small_business, service_disabled_veteran_owned_business, veteran_owned_business, historically_underutilized_business_firm (HUBZone).",
    ),
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

// OFAC denied-party sanctions screening (keyless bulk SDN + Consolidated lists)
const OfacScreenInput = z.object({
  name: z
    .string()
    .describe(
      "REQUIRED. The entity / individual / vessel / aircraft name to screen against OFAC's published SDN + Consolidated lists. Trimmed; empty is rejected (invalid_input) — never a no-op empty screen.",
    ),
  type: z
    .enum(["individual", "entity", "vessel", "aircraft"])
    .optional()
    .describe(
      "Optional post-filter on the matched party's OFAC type. A blank OFAC type is inferred as 'entity' (disclosed). Omit to screen all types. Only trims the returned matches — it never turns a real name hit into no_name_match.",
    ),
  program: z
    .string()
    .optional()
    .describe(
      "Optional case-insensitive filter to one sanctions PROGRAM code (e.g. 'CUBA', 'IRAN', 'SDGT'). Applied LOCALLY to matched rows (never on the wire); only trims returned matches (a hit under another program still yields potential_matches).",
    ),
  list: z
    .enum(["sdn", "consolidated", "all"])
    .optional()
    .describe(
      "Which OFAC list(s) to screen: 'sdn' (SDN + its AKAs), 'consolidated' (non-SDN programs + AKAs), or 'all' (default — the correct default for a real screen). Every list required for the scope loads-or-throws (a partial set is never screened).",
    ),
  minMatchQuality: z
    .enum(["exact", "strong", "weak"])
    .optional()
    .describe(
      "Floor of match quality to RETURN (default 'weak'). This ONLY trims the returned matches[]; existence is computed at the lowest quality FIRST, so result is 'potential_matches' whenever ANY match exists regardless of this value (suppressed matches are disclosed).",
    ),
  limit: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .describe("Max matches returned (default 50, max 200). Over-limit truncation is disclosed, never silent."),
});

// ━━━ NVD + CISA KEV — the IT/cyber-compliance lane (2) ━━━ ADR-0035
// cve_lookup: NVD CVE detail/search JOINED with CISA KEV status.
const CveLookupInput = z.object({
  cveId: z
    .string()
    .optional()
    .describe(
      "Exact CVE identifier CVE-YYYY-NNNN (^CVE-\\d{4}-\\d+$, validated client-side). Exact-lookup mode; a malformed cveId is rejected (invalid_input) — a malformed cveId 404s upstream. At least one of cveId/keyword/cpeName/cvssV3Severity/a date range is REQUIRED.",
    ),
  keyword: z
    .string()
    .optional()
    .describe(
      "Free-text keyword search (NVD keywordSearch) over CVE descriptions (e.g. 'log4j', 'apache struts'). Control chars stripped, length-capped; rides only as a query param (SSRF-safe).",
    ),
  cpeName: z
    .string()
    .optional()
    .describe(
      "A CPE 2.3 formatted string to match affected products (cpe:2.3:[aho]:… — e.g. cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*). Non-CPE input is rejected (invalid_input).",
    ),
  cvssV3Severity: z
    .enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"])
    .optional()
    .describe("Filter to a CVSS v3 base severity band (LOW|MEDIUM|HIGH|CRITICAL)."),
  pubStartDate: z
    .string()
    .optional()
    .describe(
      "Publication-date window START (ISO YYYY-MM-DD). PAIRED with pubEndDate (both required together — NVD 404s a lone bound). A span >120 days is clamped forward to 120 days BEFORE the request and disclosed.",
    ),
  pubEndDate: z
    .string()
    .optional()
    .describe("Publication-date window END (ISO YYYY-MM-DD). Paired with pubStartDate."),
  lastModStartDate: z
    .string()
    .optional()
    .describe(
      "Last-modified window START (ISO YYYY-MM-DD). PAIRED with lastModEndDate (both required together). A span >120 days is clamped + disclosed.",
    ),
  lastModEndDate: z
    .string()
    .optional()
    .describe("Last-modified window END (ISO YYYY-MM-DD). Paired with lastModStartDate."),
  kevOnly: z
    .boolean()
    .optional()
    .describe(
      "When true, return ONLY rows listed in the CISA KEV catalog. ★If the KEV catalog cannot be loaded, this THROWS (a KEV-membership filter is unanswerable without a loaded catalog) — it NEVER returns a silently-empty set (which would falsely read as 'none on the mandatory-remediation list').",
    ),
  resultsPerPage: z
    .number()
    .min(1)
    .max(2000)
    .optional()
    .describe("Rows per page (default 50, max 2000 — NVD's cap). Over-cap is refused, never silently clamped."),
  startIndex: z
    .number()
    .min(0)
    .optional()
    .describe("Zero-based page offset (default 0). Pagination derives from NVD's exact totalResults, never the page length."),
});

// cisa_kev_lookup: filter the KEV catalog standalone.
const CisaKevLookupInput = z.object({
  cveId: z
    .string()
    .optional()
    .describe("Exact CVE identifier CVE-YYYY-NNNN to check for KEV membership. A miss returns found:false + the not-in-KEV≠safe caveat (absence is NOT a safety clearance)."),
  vendorProject: z
    .string()
    .optional()
    .describe("Case-insensitive substring filter on the vendor/project (e.g. 'Microsoft', 'Apache')."),
  product: z
    .string()
    .optional()
    .describe("Case-insensitive substring filter on the product (e.g. 'Log4j', 'Exchange Server')."),
  ransomwareOnly: z
    .boolean()
    .optional()
    .describe("When true, keep only entries with knownRansomwareCampaignUse === 'Known'."),
  addedSince: z
    .string()
    .optional()
    .describe("Keep only entries with dateAdded >= this ISO date (YYYY-MM-DD)."),
  dueBefore: z
    .string()
    .optional()
    .describe("Keep only entries with dueDate < this ISO date (YYYY-MM-DD) — the CISA-mandated remediation deadline."),
  limit: z
    .number()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max matches returned (default 100, max 1000)."),
  offset: z.number().min(0).optional().describe("Zero-based page offset (default 0)."),
});

// ━━━ NPPES NPI Registry — the healthcare-provider identity/credentialing lane (1) ━━━ ADR-0036
// nppes_lookup_provider: exact NPI detail OR search over CMS/HHS's keyless public
// registry of every US healthcare provider (npiregistry.cms.hhs.gov/api, version=2.1
// REQUIRED). Mode is inferred from `number` (no mode flag). ★M1: an exact NPI is
// looked up by number ALONE on the wire (a co-supplied filter AND-combines and would
// falsely zero a real active provider → found:false); co-filters are checked
// client-side and disclosed via data.filterMatch. ★S2: the required-one gate is
// {number, first_name, last_name, organization_name, taxonomy_description, city,
// postal_code}; state + enumeration_type are REFINERS ONLY (rejected alone). The
// grammars (10-digit NPI + CMS Luhn, USPS state enum, NPI-1/NPI-2 enum, trailing-`*`
// wildcard ≥2 leading chars) are the SSRF + silent-foot-gun guards.
const NppesLookupInput = z.object({
  number: z
    .string()
    .regex(/^\d{10}$/)
    .optional()
    .describe(
      "Exact NPI — 10 digits (^\\d{10}$). Triggers EXACT-NPI mode: the wire query carries number (+version) ALONE (any co-supplied filter is DROPPED from the wire and checked client-side, disclosed in data.filterMatch — NPPES AND-combines a number with filters, so a mismatched filter would falsely zero a real active provider). Also client-side CMS-Luhn-validated (Luhn over 80840+first-9): a typo'd NPI ⇒ invalid_input, NEVER a fake 'does not exist'. e.g. '1104130236'.",
    ),
  enumeration_type: z
    .enum(["NPI-1", "NPI-2"])
    .optional()
    .describe(
      "REFINER only (NPI-1 = individual, NPI-2 = organization). Never sufficient alone (⇒ invalid_input) — must accompany a required criterion.",
    ),
  first_name: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Individual provider first name (a required-one criterion). A trailing '*' wildcard needs ≥2 leading literal chars. e.g. 'John'."),
  last_name: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Individual provider last name (a required-one criterion). Trailing '*' wildcard: ≥2 leading chars. e.g. 'Smith'."),
  organization_name: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Organization (NPI-2) name (a required-one criterion). Trailing '*' wildcard: ≥2 leading chars. e.g. 'Mayo Clinic'."),
  taxonomy_description: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Provider taxonomy/specialty description (a required-one criterion). e.g. 'Internal Medicine'."),
  city: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Address city (a required-one criterion). e.g. 'Baltimore'."),
  postal_code: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Address postal/ZIP code (a required-one criterion; a prefix like '212' is allowed). e.g. '21218'."),
  state: z
    .enum(nppes.NPPES_STATES)
    .optional()
    .describe(
      "US state/territory 2-letter USPS code — a REFINER only (never sufficient alone ⇒ invalid_input; NPPES rejects 'state' as the sole criterion). e.g. 'MD'.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Providers per page, 1..200, default 10. NPPES silently clamps >200; this tool rejects it loudly. Search mode only."),
  skip: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      "0-based pagination offset, 0..1000 (default 0). ★POLICY cap: this vetting tool reaches at most the first ~1,200 matches/query (a deliberate targeted-lookup boundary — NPPES itself no longer enforces a skip ceiling); skip > 1000 ⇒ invalid_input. Search mode only.",
    ),
});

// ━━━ CMS Open Payments — the healthcare spend/transparency lane (2) ━━━ ADR-0037
// A NEW keyless DKAN 2.x datastore adapter (a sibling of ckan/socrata) over
// openpaymentsdata.cms.gov. ★M2: the DCAT metastore ignores limit/offset — the
// whole catalog is sliced CLIENT-SIDE (totalAvailable is the exact post-q size).
// ★M1: the results-array drift guard is conditioned on the effective `results` mode
// (results:false omits rows). ★S2: `count` is NOT a caller toggle (always count=true
// on the wire). ★S3: offset ≤ 2000 reach cap (PII boundary, mirrors NPPES).
// SSRF (load-bearing): datasetId (36-char lowercase UUID) + index interpolate into
// the URL PATH — the Zod grammars are the primary path-injection guard.
const CmsSearchDatasetsInput = z.object({
  q: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Client-side case-insensitive substring filter over each dataset's title + description (the DKAN metastore returns the ENTIRE catalog in one response; q is applied client-side and totalAvailable is the exact post-filter catalog size). e.g. 'research payment'.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Datasets per page, 1..100, default 20 (client-side slice of the full catalog)."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based pagination offset (default 0), applied client-side against the known catalog length (never a server offset)."),
});

const CmsQueryDatasetInput = z.object({
  datasetId: z
    .string()
    .length(36)
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    .describe(
      "REQUIRED — the DKAN datasetId, a 36-char LOWERCASE UUID. ★SSRF: it interpolates into the URL PATH, so this strict grammar (no uppercase, no %2F/../, no trailing newline) is the load-bearing path-injection guard. e.g. 'f0d1de67-6852-4093-a036-c9328c256a05' (2025 Research Payment Data).",
    ),
  index: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe("Distribution index (default 0 = the primary CSV). Also interpolates into the URL path (int 0..50)."),
  conditions: z
    .array(
      z.object({
        property: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-z0-9_]+$/)
          .describe("Column name (snake_case lowercase alnum). A bad column ⇒ HTTP 400 ⇒ invalid_input (never a silent drop). e.g. 'recipient_state'."),
        value: z
          .union([z.string().max(200), z.number()])
          .describe("Filter value. e.g. 'CA'."),
        operator: z
          .enum(["=", "<>", "<", ">", "<=", ">=", "like", "in"])
          .optional()
          .describe("Comparison operator (default '='). AND-combined across conditions."),
      }),
    )
    .max(10)
    .optional()
    .describe("Server-side filters (≤10, AND-combined) that provably narrow the EXACT count. Each either applies or the call errors — filtersDropped is always empty."),
  properties: z
    .array(z.string().min(1).max(128).regex(/^[a-z0-9_]+$/))
    .optional()
    .describe("Optional column projection (snake_case column names). Omit for all columns."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Rows per page, 1..500, default 100. 500 is the HARD DKAN cap (the API 400s over it; this tool rejects >500 loudly)."),
  offset: z
    .number()
    .int()
    .min(0)
    .max(2000)
    .optional()
    .describe("0-based row offset (default 0). ★POLICY reach cap ≤ 2000 (a deliberate targeted-lookup boundary — Open Payments names physicians + amounts); offset > 2000 ⇒ invalid_input."),
  results: z
    .boolean()
    .optional()
    .describe("Default true (return rows). Set false for COUNT/SCHEMA-discovery mode: no rows, pagination disabled, but the EXACT count + every column's schema are returned. (`count` is NOT a toggle — count=true is always on the wire.)"),
});

// ─── FAC (Federal Audit Clearinghouse) Single Audit — ADR-0038 ──────
// ★ PII crux: the tools expose ONLY structured, validated filters — NO caller
// `select`/`order`/free-column param (that is why v1 uses purpose-built tools,
// not a generic fac_query). The select-allowlist is a hardcoded module constant
// in fac.ts; no caller value can name a column (PostgREST would project a
// personal-contact column the instant `select=` named it).
const FacSearchAuditsInput = z.object({
  auditeeUei: z
    .string()
    .regex(/^[A-Z0-9]{12}$/)
    .optional()
    .describe(
      "Filter by 12-char SAM UEI (^[A-Z0-9]{12}$; → auditee_uei=eq. — the PRIMARY join key to SAM/USAspending/EDGAR). e.g. 'ZQGGHJH74DW7'.",
    ),
  auditeeState: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .describe("Filter by 2-letter US state code (uppercase; → auditee_state=eq.). e.g. 'CA'."),
  auditYear: z
    .number()
    .int()
    .min(2016)
    .max(2100)
    .optional()
    .describe("Filter by audit year (int, → audit_year=eq.). e.g. 2024."),
  totalExpendedMin: z
    .number()
    .finite()
    .optional()
    .describe("Minimum total federal awards expended (USD, → total_amount_expended=gte.)."),
  totalExpendedMax: z
    .number()
    .finite()
    .optional()
    .describe("Maximum total federal awards expended (USD, → total_amount_expended=lte.)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Rows per page, 1..100, default 25."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("0-based row offset for pagination (default 0)."),
});

const FacGetFindingsInput = z
  .object({
    auditeeUei: z
      .string()
      .regex(/^[A-Z0-9]{12}$/)
      .optional()
      .describe("Filter by 12-char SAM UEI (^[A-Z0-9]{12}$; → auditee_uei=eq.)."),
    reportId: z
      .string()
      .regex(/^[0-9A-Za-z-]+$/)
      .max(64)
      .optional()
      .describe("Filter by FAC report_id (^[0-9A-Za-z-]+$; → report_id=eq. — from a fac_search_audits row)."),
    auditYear: z
      .number()
      .int()
      .min(2016)
      .max(2100)
      .optional()
      .describe("Filter by audit year (int, → audit_year=eq.)."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(50)
      .describe("Rows per page, 1..100, default 50."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("0-based row offset for pagination (default 0)."),
  })
  .refine((v) => v.auditeeUei !== undefined || v.reportId !== undefined, {
    message:
      "fac_get_findings requires at least one of `auditeeUei` or `reportId` (an empty query would scan the whole 670K-row findings table).",
    path: ["auditeeUei"],
  });

// GAO bid-protest lookup (keyless RSS + decision-page parse)
const GaoProtestInput = z.object({
  agency: z
    .string()
    .optional()
    .describe(
      "Client-side substring filter on the recent-protest feed (matched against the decision title + description). NOTE: filters the RECENT feed window only — not a historical agency search.",
    ),
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
    .describe(
      "Filter by protest disposition (default 'any'). Determined from each decision page, so it applies only when enrich is true.",
    ),
  bNumber: z
    .string()
    .optional()
    .describe(
      "Fetch ONE specific decision directly by GAO B-number (e.g. 'B-424377' or 'b-424249.2'), bypassing the feed. Use to pull a decision that has aged out of the recent feed window.",
    ),
  limit: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe("Max decisions to return (default 20, max 50). The feed itself carries ~25 recent legal products."),
  enrich: z
    .boolean()
    .optional()
    .describe(
      "Fetch each decision's page to fill agency/outcome/solicitation/PDF (default true). Set false for a fast feed-only list (those fields will be null).",
    ),
});

// GSA daily-CSV keyless backbone — batch page-completing enrichment
const SamLookupNoticeFieldsInput = z.object({
  noticeIds: z
    .array(z.string())
    .min(1)
    .max(100)
    .describe(
      "1..100 32-char hex noticeIds (the ids returned by sam_search_opportunities) to enrich in ONE batch. Completes a whole search page's null naics/setAside/place-of-performance/deadline/type from the cached GSA daily CSV. OFF BY DEFAULT — enable by setting SAM_GOV_CSV_CACHE (a cache dir) or SAM_GOV_ENABLE_CSV=1.",
    ),
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
  .describe(
    "Which confirmed Treasury Fiscal Data dataset to query: debt_to_penny (daily total public debt), avg_interest_rates (avg rate by security type), mts_table_1 (Monthly Treasury Statement receipts/outlays/deficit), rates_of_exchange (quarterly FX by currency), debt_outstanding (historical fiscal-year-end debt).",
  );

const TreasuryQueryDatasetInput = z.object({
  dataset: TreasuryDatasetEnum,
  fields: z
    .string()
    .optional()
    .describe(
      "Optional CSV column projection (e.g. 'record_date,exchange_rate'). An unknown column ⇒ upstream HTTP 400 ⇒ invalid_input (surfaced as an error, never silently dropped).",
    ),
  filter: z
    .string()
    .optional()
    .describe(
      "Optional CSV of upstream filters 'col:op:val' (ops: lt|lte|gt|gte|eq|in), AND-combined — e.g. 'record_date:gte:2024-01-01,country_currency_desc:eq:Canada-Dollar'.",
    ),
  sort: z
    .string()
    .optional()
    .describe(
      "Optional CSV sort columns; prefix '-' for descending (e.g. '-record_date').",
    ),
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
    .describe(
      "true (default) ⇒ only the single most-recent day (page[size]=1). false ⇒ the startDate/endDate range, newest-first.",
    ),
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
    .describe(
      "true (default) excludes fiscal-year PARENT/SUMMARY rows (parent_id/amounts all null) via the server-side filter current_month_gross_outly_amt:gt:0, so only real child line-items (and totalAvailable) remain. false includes the null-amount summary rows.",
    ),
  pageSize: z.number().int().min(1).max(500).default(100).describe("Rows per page, 1..500, default 100."),
  pageNumber: z.number().int().min(1).default(1).describe("1-based page number, default 1."),
});

const TreasuryAvgInterestRatesInput = z.object({
  securityType: z
    .string()
    .optional()
    .describe(
      "Optional exact security_type_desc filter (e.g. 'Marketable', 'Non-marketable', 'Interest-bearing Debt').",
    ),
  latest: z
    .boolean()
    .default(true)
    .describe(
      "true (default) ⇒ the most-recent month's full breakdown across security types (pinned to the latest record_date, memoized). false ⇒ the startDate/endDate range.",
    ),
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
    .describe(
      "Company ticker (exact, case-insensitive) or a company-name substring to resolve to a 10-digit SEC CIK via company_tickers.json. e.g. 'AAPL' or 'apple'. Returns up to 50 matches (found:false on none).",
    ),
});

const EdgarCompanyFilingsInput = z.object({
  cikOrTicker: z
    .string()
    .min(1)
    .describe(
      "A 10-digit (or unpadded) SEC CIK, or a ticker/company-name resolvable via company_tickers.json (e.g. '320193', 'CIK0000320193', 'AAPL').",
    ),
  forms: z
    .array(z.string())
    .optional()
    .describe(
      "Optional form-type filter (e.g. ['10-K','10-Q','8-K']); case-insensitive exact match on the filing's form. Omit for all forms.",
    ),
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
    .describe(
      "When true, ALSO fetch the older filings.files[] submission shards (newest-first, up to maxShards) and assemble the COMPLETE filing history (recent ++ shard001..N, descending order preserved). Default false ⇒ recent window only (byte-identical to omitting it). A capped/failed fan-out is disclosed as PARTIAL — never a capped set claimed complete.",
    ),
  maxShards: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Fan-out cap when fullHistory is true: at most this many older shards are fetched (newest-first), 1..100, default 10. Bounds wall-time (each shard is one throttle-gated GET, serialized through the SHARED edgar gate) + payload. When totalShards > maxShards the response is PARTIAL-BY-CAP (hasMore:true; older un-fetched shards reached by RAISING maxShards, not by nextOffset). Ignored when fullHistory is false.",
    ),
});

const EdgarCompanyFactsInput = z.object({
  cikOrTicker: z
    .string()
    .min(1)
    .describe(
      "A 10-digit (or unpadded) SEC CIK, or a ticker/company-name resolvable via company_tickers.json (e.g. '320193', 'AAPL').",
    ),
  concepts: z
    .array(z.string())
    .optional()
    .describe(
      "Optional XBRL us-gaap/dei concept tags to extract (e.g. ['Assets','NetIncomeLoss']). Default: the 6 curated USD concepts (Revenues/RevenueFromContractWithCustomerExcludingAssessedTax, Assets, Liabilities, StockholdersEquity, NetIncomeLoss, CashAndCashEquivalentsAtCarryingValue). A concept absent for the filer is OMITTED (never 0).",
    ),
  unit: z
    .string()
    .default("USD")
    .describe(
      "XBRL unit to extract, default 'USD'. A concept present only in another unit (e.g. EarningsPerShareBasic in 'USD/shares') is reported under wrongUnit with a note — never a silent 0.",
    ),
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
    .regex(
      /^[A-Za-z0-9]+$/,
      "tag must be alphanumeric only — an EXACT XBRL concept tag (e.g. 'Assets', 'Revenues'). Slash/dot/space/percent/'..' are rejected (path-segment injection guard).",
    )
    .describe(
      "XBRL concept tag — EXACT, alphanumeric only (e.g. 'Assets', 'Revenues', 'NetIncomeLoss', 'EarningsPerShareBasic'). A non-matching tag ⇒ upstream 404 ⇒ found:false (never a fabricated 0).",
    ),
  period: z
    .string()
    .regex(
      /^CY\d{4}(Q[1-4]I?)?$/,
      "period must be CY{yyyy} (annual flow, e.g. CY2023), CY{yyyy}Q{n} (quarterly flow, e.g. CY2023Q1), or CY{yyyy}Q{n}I (instant, trailing I, e.g. CY2023Q4I).",
    )
    .describe(
      "Calendar period frame: CY2023 (annual flow) · CY2023Q1 (quarterly flow, no I) · CY2023Q4I (instant / balance-sheet, trailing I). Instant concepts (e.g. Assets) REQUIRE the trailing I; a mismatch ⇒ 404 ⇒ found:false.",
    ),
  taxonomy: z
    .enum(edgar.FRAMES_TAXONOMIES)
    .default("us-gaap")
    .describe(
      "XBRL taxonomy namespace (a fixed enum — the SSRF guard for this segment): 'us-gaap' (financial statements, default) or 'dei' (entity/document info, e.g. EntityCommonStockSharesOutstanding, EntityPublicFloat). Live-confirmed members only.",
    ),
  unit: z
    .string()
    .regex(
      /^[A-Za-z0-9-]+$/,
      "unit must match ^[A-Za-z0-9-]+$ — hyphen allowed (e.g. 'USD-per-shares'); slash/dot/percent forbidden (never the 'USD/shares' companyfacts key form).",
    )
    .default("USD")
    .describe(
      "XBRL unit of measure, as a path segment: 'USD' (default), 'shares', 'USD-per-shares' (EPS — HYPHEN, never 'USD/shares'), 'pure'. A valid-shaped but wrong unit ⇒ 404 ⇒ found:false.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe(
      "CLIENT-SIDE page size over the already-fully-fetched cross-section (1..1000, default 100). Does NOT reduce the upstream fetch — the whole frame is fetched in one call; this only windows the returned rows (page via _meta.pagination.nextOffset).",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "0-based client-side offset into the fetched cross-section (default 0). Page via _meta.pagination.nextOffset to reach every filer.",
    ),
  includeStats: z
    .boolean()
    .default(false)
    .describe(
      "When true, compute a summary distribution { count, min, max, sum, mean, median, p25, p75, nonFiniteExcluded } over the FULL cross-section (ALL rows, BEFORE the client-side slice), using linear-interpolated percentiles over the FINITE vals only. count===0 (no finite vals) ⇒ every stat is null (never 0/NaN/Infinity).",
    ),
});

const EdgarFullTextSearchInput = z.object({
  q: z
    .string()
    .min(1)
    .describe(
      "Full-text query over EDGAR filings (2001-present). Wrap a phrase in double quotes for an exact match (e.g. '\"climate risk\"').",
    ),
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
    .describe(
      "Optional: pin filings BY one or more entities, by NUMERIC SEC CIK (each is zero-padded to 10 digits — an EXACT-entity match). Multiple CIKs are AND-of-OR (any of the listed entities). A ticker/company name / CIK-0 entry is rejected as invalid_input — use `entityName` or resolve the CIK first with edgar_lookup_cik.",
    ),
  entityName: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Optional FUZZY filer-name narrowing (matches the filer's display name; NOT CIK-exact — can match related entities, e.g. multiple 'Apple*' filers). Combine with `ciks` for an exact-entity result.",
    ),
  from: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "0-based result offset for pagination; page size is FIXED at 100 (there is no size param). Must be <= 9900 (from+100 ≤ 10000 upstream window); a larger from is rejected as invalid_input.",
    ),
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
    .describe(
      "Filing year (>= 1993 — EDGAR full-index begins 1993 Q1). Must be <= the current year; a future year is rejected as invalid_input with 0 fetch. Path segment.",
    ),
  quarter: z
    .number()
    .int()
    .min(1)
    .max(4)
    .describe(
      "Calendar quarter 1..4 (path segment QTR<quarter>). A same-year FUTURE quarter returns a well-formed EMPTY result (genuine-empty, complete:true), NOT an error.",
    ),
  formType: z
    .string()
    .min(1)
    .max(30)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter: case-insensitive EXACT match on the Form Type column (e.g. '8-K', '10-K'). '8-K' does NOT match '8-K/A' — pass each amendment variant separately.",
    ),
  cik: z
    .union([z.string().regex(/^\d{1,10}$/), z.number().int().nonnegative()])
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter: numeric SEC CIK (1-10 digits or a number), matched leading-zero-safe via padCik on both sides (so '320193' and '0000320193' match the same filer).",
    ),
  companyContains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter: case-insensitive LITERAL substring on the Company Name column. A multi-word value matches as ONE contiguous string (NOT AND/OR-tokenized).",
    ),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter: keep filings whose Date Filed >= this ISO YYYY-MM-DD (string compare; the column is already YYYY-MM-DD).",
    ),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter: keep filings whose Date Filed <= this ISO YYYY-MM-DD.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe(
      "Page size over the FILTERED, full-scanned matches (1..1000, default 100). Does NOT reduce the download — the whole quarter is scanned; this only windows the returned rows (page via _meta.pagination.nextOffset).",
    ),
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
    .describe(
      "Required calendar day ISO YYYY-MM-DD (>= 1994-01-01 — EDGAR daily-index begins 1994 Q1). The handler derives year/quarter/yyyymmdd. A malformed / non-real day (2024-02-30, non-leap 2023-02-29) or a FUTURE date is rejected as invalid_input with 0 fetch. TODAY is allowed (its index may not be posted until ~22:00 US-Eastern).",
    ),
  formType: z
    .string()
    .min(1)
    .max(30)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter: case-insensitive EXACT match on the Form Type column (e.g. '8-K', '10-K'). '8-K' does NOT match '8-K/A' — pass each amendment variant separately.",
    ),
  cik: z
    .union([z.string().regex(/^\d{1,10}$/), z.number().int().nonnegative()])
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter: numeric SEC CIK (1-10 digits or a number), matched leading-zero-safe via padCik on both sides (so '320193' and '0000320193' match the same filer).",
    ),
  companyContains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter: case-insensitive LITERAL substring on the Company Name column. A multi-word value matches as ONE contiguous string (NOT AND/OR-tokenized).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe(
      "Page size over the FILTERED, full-scanned matches (1..1000, default 100). Does NOT reduce the download — the whole day is scanned; this only windows the returned rows (page via _meta.pagination.nextOffset).",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("0-based offset into the filtered matches (default 0)."),
});

// ADR-0041. Keyless WITHIN-SOURCE DEPTH on the existing edgar source: one filer ×
// one XBRL concept × the COMPLETE reported time-series (data.sec.gov/api/xbrl/
// companyconcept/CIK{cik10}/{taxonomy}/{Concept}.json). cik (via resolveCik→padCik) +
// taxonomy (enum) + concept (alnum regex) are the THREE validated PATH SEGMENTS (the
// SSRF guard, re-checked belt-and-suspenders pre-fetch in edgar's buildConceptUrl).
// `unit` is a BODY key filtered CLIENT-SIDE (NOT a path segment — no unit regex);
// unit/form/fy/canonicalOnly/limit/offset are all client-side over the fully-fetched set.
const EdgarCompanyConceptInput = z.object({
  cikOrTicker: z
    .string()
    .min(1)
    .describe(
      "A 10-digit (or unpadded) SEC CIK, or a ticker/company-name resolvable via company_tickers.json (e.g. '320193', 'CIK0000320193', 'AAPL').",
    ),
  concept: z
    .string()
    .regex(
      /^[A-Za-z0-9]+$/,
      "concept must be alphanumeric only — an EXACT XBRL tag (e.g. 'Assets', 'Revenues', 'NetIncomeLoss'). Slash/dot/space/percent/'..' are rejected (path-segment injection guard).",
    )
    .describe(
      "XBRL concept tag — EXACT, alphanumeric CamelCase (e.g. 'Assets', 'Revenues', 'NetIncomeLoss', 'Liabilities'). A tag the filer never reported ⇒ upstream 404 ⇒ found:false (never a fabricated 0).",
    ),
  taxonomy: z
    .enum(edgar.CONCEPT_TAXONOMIES)
    .default("us-gaap")
    .describe(
      "XBRL taxonomy namespace (a fixed enum — the SSRF guard for this segment): 'us-gaap' (financial statements, default), 'dei' (entity/document info, e.g. EntityCommonStockSharesOutstanding), or 'ifrs-full' (IFRS filers, e.g. a foreign private issuer). Live-confirmed members only.",
    ),
  unit: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter on the returned units{} keys (NOT a path segment — 'USD', 'shares', 'USD/shares', 'EUR', 'pure'). Restricts rows to that unit but STILL discloses the other units via unitsAvailable + a note. A unit not present ⇒ 0 rows + the available-units note (never a fabricated pick).",
    ),
  form: z
    .string()
    .min(1)
    .max(30)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter: case-insensitive EXACT match on a row's `form` (e.g. '10-K' for annual values only, '10-Q' for quarterly).",
    ),
  fy: z
    .number()
    .int()
    .optional()
    .describe("Optional CLIENT-SIDE filter: keep only rows whose fiscal year `fy` equals this integer (e.g. 2023)."),
  canonicalOnly: z
    .boolean()
    .default(false)
    .describe(
      "When true, reduce to ONE row per distinct (unit,start,end) period — the frame-tagged canonical value, or (for a not-yet-consolidated period) the latest-filed row (marked canonical:false). SUPERSEDED/amendment rows are REMOVED (fully disclosed via a note). Default false ⇒ ALL rows incl. the amendment/restatement history. A same-`end` different-`start` pair is a DIFFERENT period (both kept), NOT a duplicate.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(100)
    .describe(
      "CLIENT-SIDE page size over the already-fully-fetched, (unit,start,end)-keyed time-series (1..1000, default 100). Does NOT reduce the upstream fetch (SEC does not paginate companyconcept); page via _meta.pagination.nextOffset.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("0-based client-side offset into the filtered time-series (default 0)."),
});

// ─── Socrata / SODA (keyless SLED + E-rate) — input schemas ──────
// ADR-0004. First SLED source. `domain` is a curated allowlist ENUM (the SSRF
// core — no free host); `datasetId` is a strict 4x4 with .length(9) (M2 — blocks
// a trailing-newline the regex `$` would admit). SoQL params are raw upstream-
// validated strings (a bad column ⇒ upstream 400 ⇒ invalid_input, surfaced).
const SocrataDomainEnum = z
  .enum(socrata.SOCRATA_DOMAINS)
  .describe(
    "Which allowlisted Socrata portal to query (curated .gov hosts + USAC E-rate .org; the SSRF host allowlist — no free host). e.g. data.ny.gov, data.texas.gov, data.wa.gov, opendata.usac.org.",
  );

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
    .describe(
      "The dataset's Socrata 4x4 id, e.g. 'kwxv-fwze' (from socrata_discover_datasets). Exactly [a-z0-9]{4}-[a-z0-9]{4} (9 chars; no surrounding whitespace).",
    ),
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
    .describe(
      "true (default) ⇒ issue a count(*) companion query so totalAvailable is exact. false ⇒ skip it (one fewer request); totalAvailable is null and a note discloses results may be truncated at $limit.",
    ),
});

const SocrataDiscoverDatasetsInput = z.object({
  q: z
    .string()
    .min(1)
    .describe("Keyword(s) to find datasets, e.g. 'procurement', 'vendor payments', 'checkbook'."),
  domain: SocrataDomainEnum.optional().describe(
    "Optional: scope discovery to ONE allowlisted portal. Omit to search the whole allowlist. NOTE: the federated catalog does not index every host (e.g. USAC E-rate returns 0) — those remain queryable via socrata_query with a known 4x4.",
  ),
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
  .describe(
    "Which allowlisted CKAN portal to query (curated .gov hosts — the SSRF host allowlist, no free host): data.ca.gov (CA), data.virginia.gov (VA — eVA), data.boston.gov (City of Boston Checkbook).",
  );

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
    .describe(
      "The datastore resource_id, a 36-char lowercase UUID e.g. 'bb82edc5-9c78-44e2-8947-68ece26197c5' (from ckan_discover_datasets, a datastoreActive:true resource).",
    ),
  q: z
    .string()
    .optional()
    .describe("Optional full-text search across the record (CKAN `q`)."),
  filters: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]),
    )
    .optional()
    .describe(
      "Optional structured field filters, e.g. {\"Fiscal Year\":\"2013-2014\"}. A constrained object (string/number/array values only) that we JSON.stringify; a bad field ⇒ upstream HTTP 409 ⇒ invalid_input (surfaced, never silent).",
    ),
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
  .describe(
    "Free-text bank name / city fragment (letters, digits, spaces and . , & ' / ( ) # -). Matched by FDIC's case-insensitive full-text `search` (token match; a multi-word value is matched per-token, may be broader than a literal substring).",
  );

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
  name: FdicNameCity.optional().describe(
    "Filter by institution NAME via FDIC full-text `search` (case-insensitive token match; NOT case-sensitive exact-keyword — that is why we route to `search`, not `filters`).",
  ),
  city: FdicNameCity.optional().describe(
    "Filter by CITY via FDIC full-text `search` (case-insensitive token match).",
  ),
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

// ADR-0029 — the 3rd FDIC tool (source 23 unchanged; snapshot 89→90) reading
// /banks/failures. v2 (cycle-33) live review: the state field is PSTALP (NOT
// STALP — a false-empty landmine), and /failures IGNORES the `search` param (a
// name/city query floods the whole dataset) → NO name/city filter here; name
// lookup is the 2-step CERT linkage via fdic_search_institutions.
const FdicBankFailuresInput = z.object({
  state: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .describe(
      "Filter by 2-letter US state code (uppercase; → PSTALP filter — the /failures state field is PSTALP, NOT STALP). e.g. 'CA'.",
    ),
  failYear: z
    .number()
    .int()
    .min(1934)
    .max(new Date().getUTCFullYear())
    .optional()
    .describe(
      "Filter by year of failure (→ FAILYR filter). 1934..current UTC year. e.g. 2023 → the 5 real 2023 failures (Silicon Valley Bank, Signature Bank, First Republic Bank, Heartland Tri-State Bank, Citizens Bank).",
    ),
  cert: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Filter by FDIC certificate number (the STABLE entity key; → CERT filter). Resolve a bank's CERT via fdic_search_institutions.",
    ),
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
    .enum(["FAILDATE", "COST", "QBFASSET", "QBFDEP", "NAME", "FAILYR"])
    .default("FAILDATE")
    .describe("Sort field (allowlisted enum; default FAILDATE = failure date). An unknown field is rejected before fetch."),
  sortOrder: z
    .enum(["ASC", "DESC"])
    .default("DESC")
    .describe("Sort direction, default DESC (most-recent failures first)."),
});

// ADR-0030 — the 4th FDIC tool (source 23 unchanged; snapshot 90→91) reading
// /banks/history, the institution-level STRUCTURAL-CHANGE event log (mergers,
// absorptions, failures, name/location/charter/regulator changes, branch open/close,
// etc.) — completing the FDIC entity cluster. Live review: the state field is PSTALP
// (NOT STALP — a false-empty landmine), and /history's `search` param returns 0 for
// INSTNAME (a false-empty) → NO name/city filter; name lookup is the 2-step CERT
// linkage via fdic_search_institutions. All inputs optional, AND-combined; `cert` is
// the primary path.
const FdicInstitutionHistoryInput = z.object({
  cert: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Filter by FDIC certificate number (the STABLE entity key; → CERT filter — the PRIMARY lookup). Resolve a bank's CERT via fdic_search_institutions. e.g. 3510 → Bank of America's 13,794-row structural-change history.",
    ),
  changeCode: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Filter by FDIC structural-change code (→ CHANGECODE filter). e.g. 223 = Merger (Without Assistance), 211 = Failure (Whole Institution), 721 = Branch Closing, 520 = Change in Physical Location, 110 = New Institution. Each row also carries FDIC's own changeDescription (CHANGECODE_DESC).",
    ),
  effYear: z
    .number()
    .int()
    .min(1782)
    .max(new Date().getUTCFullYear())
    .optional()
    .describe(
      "Filter by the year the structural change took effect (→ EFFYEAR filter). 1782..current UTC year (1782 = the oldest observed EFFYEAR).",
    ),
  state: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .describe(
      "Filter by 2-letter US state code (uppercase; → PSTALP filter — the /history state field is PSTALP, NOT STALP). e.g. 'CA'.",
    ),
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
    .enum(["EFFDATE", "PROCDATE", "CHANGECODE", "TRANSNUM"])
    .default("EFFDATE")
    .describe("Sort field (allowlisted enum; default EFFDATE = effective date). An unknown field is rejected before fetch."),
  sortOrder: z
    .enum(["ASC", "DESC"])
    .default("DESC")
    .describe("Sort direction, default DESC (newest structural change first)."),
});

// ADR-0031 — the 5th FDIC tool (source 23 unchanged; snapshot 91→92) reading
// /banks/summary, the FDIC's OWN aggregate/statistical roll-ups (the FIRST
// AGGREGATE tool on this source; the 4 existing are per-ENTITY on CERT). Live
// review: the state field is STALP (NOT PSTALP — a per-endpoint difference), the
// number-of-institutions field is BANKS (NOT NUMINST), /summary serves NO ratio
// fields, and NIM is net interest INCOME in $thousands (NOT the margin ratio). Each
// row crosses charter (CB_SI) × geography (STALP), where STALP ∈ {USA,US,OT,PI} are
// geographic ROLL-UPS surfaced via a derived scope/isRollup so a roll-up never
// masquerades as a state. NO name/city filter (the `search` param is a no-op). A
// non-int year is rejected pre-fetch (a malformed year is a live HTTP-200 total:0
// false-empty). All inputs optional, AND-combined.
const FdicIndustrySummaryInput = z.object({
  year: z
    .number()
    .int()
    .min(1934)
    .max(new Date().getUTCFullYear())
    .optional()
    .describe(
      "Filter by aggregate YEAR (→ YEAR filter). 1934..current UTC year. e.g. 2023 → the 121 (charter × geography) aggregate rows for 2023. A non-int is rejected pre-fetch (a malformed year is a live HTTP-200 total:0 false-empty).",
    ),
  state: z
    .string()
    .regex(/^[A-Z]{2,3}$/)
    .optional()
    .describe(
      "Filter by geography via the STALP code (uppercase 2-or-3 letters; → STALP filter — the /summary state field is STALP, NOT PSTALP). Accepts a jurisdiction USPS code (TX, CA, DC, GU, PR…) OR a ROLL-UP code: USA (all states+territories), US (states+DC), OT (all territories), PI (Pacific Islands). The output scope/isRollup disambiguates every returned row.",
    ),
  charterClass: z
    .enum(["CB", "SI"])
    .optional()
    .describe(
      "Filter by charter class (→ CB_SI filter): CB = commercial banks, SI = savings institutions. Omit to return BOTH charter rows for the geography — there is NO pre-combined 'all institutions' row (a geography's total = its CB row + its SI row).",
    ),
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
    .enum(["YEAR", "ASSET", "DEP", "NETINC", "BANKS"])
    .default("YEAR")
    .describe("Sort field (allowlisted enum; default YEAR = aggregate year). An unknown field is rejected before fetch."),
  sortOrder: z
    .enum(["ASC", "DESC"])
    .default("DESC")
    .describe("Sort direction, default DESC (newest year / largest first)."),
});

// ADR-0040 — the 6th & 7th FDIC tools (source 30 unchanged; snapshot 103→105) —
// WITHIN-SOURCE DEPTH on the already-wired src/fdic.ts adapter. (6) fdic_risk_ratios
// projects the curated counterparty RISK-RATIO catalog on the ALREADY-wired
// /banks/financials endpoint (per-field units in the output key; percent ratios
// verbatim via num, tier-1 capital ×1000; ★M1 the CBLR RBCRWAJ=0 sentinel → null via
// FDIC's CBLRIND flag + a per-row cblrFramework, never a false 0% capital). (7)
// fdic_branch_deposits reads /banks/sod (Summary of Deposits) — ONE new fixed endpoint
// constant. Both keyed on the numeric CERT; C118-quoted state; NO name/city search.
const FdicRiskRatiosInput = z.object({
  cert: z
    .number()
    .int()
    .min(1)
    .describe(
      "REQUIRED FDIC certificate number of the institution (→ CERT filter). From fdic_search_institutions.",
    ),
  reportDate: z
    .number()
    .int()
    .min(19000101)
    .max(29991231)
    .optional()
    .describe(
      "Optional report date (→ REPDTE filter), a quarter-end as a YYYYMMDD integer (e.g. 20240630). Omit for the full quarterly ratio time-series.",
    ),
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
    .enum(["REPDTE", "ROA", "ROE", "RBCRWAJ", "EEFFR"])
    .default("REPDTE")
    .describe("Sort field (allowlisted enum; default REPDTE = report date). An unknown field is rejected before fetch."),
  sortOrder: z
    .enum(["ASC", "DESC"])
    .default("DESC")
    .describe("Sort direction, default DESC (newest quarter first)."),
});

const FdicBranchDepositsInput = z.object({
  cert: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Filter by FDIC certificate number (the STABLE entity key; → CERT filter). Resolve a bank's CERT via fdic_search_institutions.",
    ),
  state: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional()
    .describe(
      "Filter by 2-letter branch state code (uppercase; → STALPBR filter — the SOD branch-state field). e.g. 'OR'. C118-quoted so Oregon is Lucene-operator-safe.",
    ),
  year: z
    .number()
    .int()
    .min(1934)
    .max(new Date().getUTCFullYear())
    .optional()
    .describe(
      "Filter by Summary-of-Deposits survey YEAR (→ YEAR filter), the annual June-30 snapshot year. 1934..current UTC year.",
    ),
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
    .enum(["YEAR", "DEPSUMBR"])
    .default("YEAR")
    .describe("Sort field (allowlisted enum; default YEAR = snapshot year). An unknown field is rejected before fetch."),
  sortOrder: z
    .enum(["ASC", "DESC"])
    .default("DESC")
    .describe("Sort direction, default DESC (newest snapshot / largest deposits first)."),
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
  state: FemaStateSchema.optional().describe(
    "Filter by applicant state (→ stateAbbreviation eq 'XX'). 2-letter code.",
  ),
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
  declaredDateFrom: FemaDateSchema.optional().describe(
    "Earliest declaration date, inclusive (→ declarationDate ge 'ISO').",
  ),
  declaredDateTo: FemaDateSchema.optional().describe(
    "Latest declaration date, inclusive (→ declarationDate le 'ISO').",
  ),
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
  state: FemaStateSchema.optional().describe(
    "Filter by state (→ state eq 'XX'). 2-letter code.",
  ),
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
  declaredDateFrom: FemaDateSchema.optional().describe(
    "Earliest declaration date, inclusive (→ declarationDate ge 'ISO').",
  ),
  declaredDateTo: FemaDateSchema.optional().describe(
    "Latest declaration date, inclusive (→ declarationDate le 'ISO').",
  ),
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

const FemaSearchHazardMitigationInput = z.object({
  state: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by state (→ state eq '...'). Accepts EITHER a 2-letter code ('AL', like the other FEMA tools) OR the full name ('Alabama'); the module maps a 2-letter code to the full name this dataset requires."),
  programArea: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by mitigation program (→ programArea eq '...'): HMGP (Hazard Mitigation Grant Program), FMA (Flood Mitigation Assistance), PDM (Pre-Disaster Mitigation), BRIC (Building Resilient Infrastructure and Communities), LPDM, FMA-SL."),
  disasterNumber: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Filter by FEMA disaster number (→ disasterNumber eq N)."),
  status: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by project status (→ status eq '...'). e.g. 'Closed', 'Open'."),
  programFy: z
    .number()
    .int()
    .optional()
    .describe("Filter by program fiscal year (→ programFy eq N). e.g. 2005."),
  region: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Filter by FEMA region number 1–10 (→ region eq N)."),
  minProjectAmount: z
    .number()
    .optional()
    .describe("Minimum project amount (→ projectAmount ge N)."),
  maxProjectAmount: z
    .number()
    .optional()
    .describe("Maximum project amount (→ projectAmount le N)."),
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
  .describe(
    "US state / territory 2-letter code to scope the search (REQUIRED — an unscoped national query is ~5.6M rows; the enum is also the SSRF value guard + the silent-zero guard). e.g. 'DC', 'TX', 'CA', 'PR'.",
  );

const EchoSearchFacilitiesInput = z.object({
  state: EchoStateEnum,
  naics: z
    .string()
    .regex(/^[0-9]{2,6}$/)
    .optional()
    .describe(
      "BEST-EFFORT industry filter (2–6 digit NAICS). WARNING: ECHO DROPS the NAICS filter upstream (live-verified 2026-07-12) — the returned facilities are NOT guaranteed to match this code; it is reported in _meta.filtersDropped + a note. Use `sic` (which DOES narrow) to scope by industry.",
    ),
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
    .describe(
      "The facility's FRS RegistryID (from echo_search_facilities rows' RegistryID) — an all-digit id, 9–12 digits (e.g. '110059768461'). A bad/unknown id ⇒ not_found (never a fabricated report).",
    ),
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

// ADR-0044 — Regulations.gov DOCKETS (the rulemaking/nonrulemaking CONTAINER +
// its cross-source `rin` join key). Within-source depth on the SAME api.data.gov
// keyed adapter. The docketType enum + ISO date formats fail LOCALLY as
// invalid_input BEFORE any fetch; `limit` exposes a friendly count while the wire
// page[size] floor of 5 is handled by the handler (a limit<5 is client-sliced).
const RegulationsSearchDocketsInput = z.object({
  searchTerm: z
    .string()
    .optional()
    .describe("Full-text search term (filter[searchTerm]) over docket title/abstract, e.g. 'endangered species'."),
  query: z
    .string()
    .optional()
    .describe("Alias for `searchTerm` (either is accepted; both feed filter[searchTerm])."),
  agencyId: z
    .string()
    .optional()
    .describe("Filter by owning agency acronym (filter[agencyId]), e.g. 'EPA', 'BLM', 'TREAS-FINCEN'."),
  docketType: z
    .enum(datagov.REGULATIONS_DOCKET_TYPES)
    .optional()
    .describe("Filter by docket type: Rulemaking / Nonrulemaking (filter[docketType])."),
  lastModifiedDateGe: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Docket last modified on/after this date, YYYY-MM-DD (filter[lastModifiedDate][ge])."),
  lastModifiedDateLe: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Docket last modified on/before this date, YYYY-MM-DD (filter[lastModifiedDate][le])."),
  sort: z
    .enum(datagov.REGULATIONS_DOCKET_SORTS)
    .optional()
    .describe("Sort order (default '-lastModifiedDate'). Set: -lastModifiedDate/lastModifiedDate/title/-title (first two DEMO_KEY-verified)."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .default(20)
    .describe("Requested rows, 1..250, default 20. NOTE: the API's page[size] floor is 5 — a limit<5 fetches page[size]=5 upstream and returns the first `limit` rows client-side (disclosed in _meta.notes); totalAvailable stays the EXACT server total."),
  pageNumber: z
    .number()
    .int()
    .min(1)
    .max(40)
    .default(1)
    .describe("1-based page number, 1..40 (HARD cap — page[number] max is 40; the reachable window is 40×page[size] ≤ 10,000 records)."),
});

const RegulationsGetDocketInput = z.object({
  docketId: z
    .string()
    .regex(
      /^[A-Za-z0-9_.-]+$/,
      "docketId may contain only letters, digits, '_', '.', '-' (no slashes/spaces/%).",
    )
    .refine((v) => /[A-Za-z0-9]/.test(v), "docketId must contain an alphanumeric")
    .describe("The docket id — the ONLY path-segment value, charclass-validated (rejects '../', '%2F', spaces, pure-dot) — e.g. 'BLM-2026-0001', 'TREAS-FINCEN-2008-0008'. A bad id ⇒ invalid_input (0 fetch); a nonexistent id ⇒ not_found (never a fabricated docket)."),
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

// ─── data.gov v4 Catalog API (api.gsa.gov — CKAN-retirement replacement) ─
// ADR-0046, resilience Phase 3. Federal dataset DISCOVERY. Same DATA_GOV_API_KEY/
// DEMO_KEY/X-Api-Key discipline as the datagov trio (shared datagovKey.ts seam),
// but a DIFFERENT host (api.gsa.gov). The opaque `cursor` is charclass-validated
// here AND re-guarded in the handler (a bad token ⇒ invalid_input, 0 fetch).
const DatagovSearchDatasetsInput = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("Free-text search over the dataset catalog (→ q), e.g. 'wildfire'. LIVE-CONFIRMED to narrow (2026-07-16: the v4 API param is `q`; the old `_q` is silently ignored)."),
  organization: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Publisher organization SLUG filter (→ organization), e.g. 'epa-gov', 'noaa-gov'. An org catalog lists that agency's published datasets."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Datasets per page (→ _size), 1..100, default 20."),
  cursor: z
    .string()
    .min(1)
    .max(4096)
    .regex(datagovCatalog.DATAGOV_CURSOR_RE)
    .optional()
    .describe("Opaque continuation cursor (→ after) — pass back the _meta.nextCursor from the previous page. Pagination is a cursor, NOT a numeric offset (offset/nextOffset are null); nextCursor:null means the last page. A bad token (spaces/'../'/'%') ⇒ invalid_input pre-fetch."),
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
    .regex(
      govinfo.GOVINFO_COLLECTION_RE,
      "collection must be an uppercase alpha GovInfo code like BILLS/CFR/FR/PLAW ([A-Z]{2,10}).",
    )
    .describe(
      "GovInfo collection code (uppercase alpha), e.g. BILLS, PLAW, CREC, USCODE, CFR, FR, BUDGET, GAOREPORTS. Validated against the live /collections catalog — an unknown code returns invalid_input listing valid codes (never a misleading empty). Use govinfo_list_collections to discover codes.",
    ),
  startDate: z
    .string()
    .regex(
      govinfo.GOVINFO_DATE_RE,
      "startDate must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ.",
    )
    .describe(
      "Lower bound on lastModified (the record's last-update date, NOT dateIssued), YYYY-MM-DD (normalized to T00:00:00Z) or a full ISO datetime. e.g. '2024-01-01'.",
    ),
  endDate: z
    .string()
    .regex(
      govinfo.GOVINFO_DATE_RE,
      "endDate must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ.",
    )
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
    .regex(
      govinfo.GOVINFO_PAGE_MARK_RE,
      'pageMark must be "*" or the opaque _meta.nextCursor from the previous page (≤4096 base64/URL-safe chars).',
    )
    .default("*")
    .describe(
      'Opaque continuation cursor. Default "*" (first page). To page, pass back the previous response\'s _meta.nextCursor (NOT a numeric offset — GovInfo uses an opaque cursor).',
    ),
});

const GovinfoGetPackageInput = z.object({
  packageId: z
    .string()
    .regex(
      govinfo.GOVINFO_PACKAGE_ID_RE,
      "packageId must be a GovInfo id like BILLS-118hr1enr / CFR-2023-title1-vol1 ([A-Za-z0-9][A-Za-z0-9._-]{2,}).",
    )
    .describe(
      "GovInfo packageId from govinfo_search_packages (e.g. 'BILLS-118hr1enr', 'PLAW-117publ58', 'CFR-2023-title1-vol1', 'GAOREPORTS-GAO-24-106221').",
    ),
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
    signedDateFrom: FPDS_ISO_DATE.optional().describe(
      "Signed-date range START (ISO YYYY-MM-DD); pair with signedDateTo (→ SIGNED_DATE:[from,to]).",
    ),
    signedDateTo: FPDS_ISO_DATE.optional().describe(
      "Signed-date range END (ISO YYYY-MM-DD); pair with signedDateFrom.",
    ),
    lastModifiedFrom: FPDS_ISO_DATE.optional().describe(
      "Last-modified range START (ISO YYYY-MM-DD); pair with lastModifiedTo (→ LAST_MOD_DATE:[from,to]).",
    ),
    lastModifiedTo: FPDS_ISO_DATE.optional().describe(
      "Last-modified range END (ISO YYYY-MM-DD); pair with lastModifiedFrom.",
    ),
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
  .refine(
    (a) =>
      a.naics !== undefined ||
      a.vendorName !== undefined ||
      a.piid !== undefined ||
      a.departmentId !== undefined ||
      a.contractingAgencyName !== undefined ||
      (a.signedDateFrom !== undefined && a.signedDateTo !== undefined) ||
      (a.lastModifiedFrom !== undefined && a.lastModifiedTo !== undefined) ||
      a.keyword !== undefined,
    {
      message:
        "Provide at least one filter (naics, vendorName, piid, departmentId, contractingAgencyName, a signedDate range, a lastModified range, or keyword) — a bare unbounded FPDS scan is refused.",
    },
  );

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
    .describe(
      "Recipient-organization US state/territory 2-letter USPS codes (UPPERCASE — the enum is the SSRF value guard + the silent-zero guard: a lowercase 'ca' or an unknown 'ZZ' silently returns zeros, so a typo is an invalid_input, never read as 'no NIH funding'). LIVE-CONFIRMED to narrow. e.g. ['CA','MA']. Max 20.",
    ),
  orgNames: z
    .array(z.string().min(1).max(512))
    .max(20)
    .optional()
    .describe(
      "Recipient-organization name filter values (each ≤512 chars, max 20). LIVE-CONFIRMED to narrow. e.g. ['MASSACHUSETTS INSTITUTE OF TECHNOLOGY']. A value matching no org returns a genuine total:0.",
    ),
  fiscalYears: z
    .array(z.number().int().min(1985).max(NIH_CURRENT_YEAR + 1))
    .max(20)
    .optional()
    .describe(
      `NIH fiscal years to include (int array, ${1985}..${NIH_CURRENT_YEAR + 1}, max 20). LIVE-CONFIRMED to narrow. e.g. [2023,2024].`,
    ),
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
    .describe(
      "0-based offset into the result set. HARD-CAPPED at 14,999: NIH caps keyless retrieval at the first 15,000 records (offset 0..14,999), so offset ≥ 15,000 is refused (invalid_input) — narrow criteria to reach records beyond the window. The count (totalAvailable) stays EXACT past the window.",
    ),
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
    .describe(
      "Free-text search over title/abstract. NOTE: NSF OR-tokenizes a MULTI-WORD keyword (matches ANY word, not the phrase — 'machine learning' = machine OR learning, a far broader set; disclosed in _meta.notes). Use a single distinctive word or add a scoping filter for a precise set.",
    ),
  awardeeStateCode: z
    .enum(nsf.NSF_STATES)
    .optional()
    .describe(
      "Awardee-organization US state/territory 2-letter USPS code (UPPERCASE — the enum is the SSRF value guard + the silent-zero guard: a non-state typo silently returns 0 awards on NSF, indistinguishable from 'no NSF funding', so it is an invalid_input). LIVE-CONFIRMED to narrow. e.g. 'CA'.",
    ),
  awardeeName: z
    .string()
    .min(2)
    .max(200)
    .optional()
    .describe(
      "Awardee-organization name filter (2..200 chars). LIVE-CONFIRMED to narrow (a top recipient like 'Johns Hopkins University' may still saturate at the 10,000 count cap).",
    ),
  ueiNumber: z
    .string()
    .regex(NSF_UEI_RE)
    .optional()
    .describe(
      "Awardee UEI — a 12-char alphanumeric SAM/USAspending Unique Entity ID (uppercase-normalized before sending). LIVE-CONFIRMED an EXACT recipient-graph filter (the clean SAM/USAspending join). e.g. 'FTMTDMBR29C7' (Johns Hopkins).",
    ),
  parentUeiNumber: z
    .string()
    .regex(NSF_UEI_RE)
    .optional()
    .describe(
      "Parent-organization UEI — a 12-char alphanumeric UEI for the awardee's parent entity (uppercase-normalized). LIVE-CONFIRMED an EXACT narrow (the parent-org roll-up join). e.g. 'GS4PNKTRNKL3'.",
    ),
  pdPIName: z
    .string()
    .min(2)
    .max(120)
    .optional()
    .describe(
      "Principal-investigator name filter (2..120 chars). LIVE-CONFIRMED to narrow. e.g. 'Bell'.",
    ),
  dateStart: z
    .string()
    .regex(NSF_MMDDYYYY_RE)
    .optional()
    .describe(
      "Award ACTION-date lower bound (the initial award/obligation date, NOT the project startDate — live-verified). STRICT mm/dd/yyyy; a wrong format (yyyy-mm-dd) is silently mis-parsed by NSF (not an error), so it is rejected. e.g. '01/01/2024'.",
    ),
  dateEnd: z
    .string()
    .regex(NSF_MMDDYYYY_RE)
    .optional()
    .describe(
      "Award ACTION-date upper bound. STRICT mm/dd/yyyy (same semantics/foot-gun as dateStart). e.g. '12/31/2024'.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe(
      "Awards per page (→ NSF rpp), 1..100, default 25. The OUTGOING page size is clamped so offset+rpp ≤ 10,000 (crossing NSF's retrieval window triggers a FATAL).",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .default(0)
    .describe(
      "0-based offset. HARD-CAPPED at 9,999: NSF caps keyless retrieval at the first 10,000 records (offset+rpp ≤ 10,000), so offset ≥ 10,000 is refused (invalid_input) — narrow criteria to bring the set under 10,000.",
    ),
});
const NsfGetAwardInput = z.object({
  awardId: z
    .string()
    .regex(/^\d{5,9}$/)
    .describe(
      "NSF award id — an all-digit id (5..9 digits; NSF ids are 7-digit numeric, live-verified). Returns the ONE full award record INCLUDING abstractText; a nonexistent id ⇒ found:false (never a fabricated record). e.g. '2545697'.",
    ),
});
// ─── ClinicalTrials.gov API v2 (ADR-0021, source #21) ────────────
const ClinicaltrialsSearchStudiesInput = z.object({
  "query.term": z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Broad free-text search across the study record. MULTI-WORD is AND-conjunctive — ALL tokens must co-occur ('breast cancer' = breast AND cancer; disclosed in _meta.notes). LIVE-CONFIRMED to narrow. e.g. 'cancer'.",
    ),
  sponsor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Lead-sponsor / collaborator NAME search (→ query.spons; a fuzzy full-text name search, NOT an exact-entity join — the name is free text, not a UEI). MULTI-WORD is AND-conjunctive. LIVE-CONFIRMED to narrow. e.g. 'Pfizer'.",
    ),
  condition: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Condition / disease filter (→ query.cond). MULTI-WORD is AND-conjunctive. LIVE-CONFIRMED to narrow. e.g. 'diabetes'.",
    ),
  location: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Study-location filter (→ query.locn), e.g. a country or city. LIVE-CONFIRMED to narrow. e.g. 'Germany'.",
    ),
  overallStatus: z
    .enum(clinicaltrials.CT_STATUSES)
    .optional()
    .describe(
      "Recruitment/overall status (→ filter.overallStatus). A frozen 14-value enum (COMPLETED, RECRUITING, TERMINATED, …); an unlisted value LOUD-fails at HTTP 400 upstream, so it is rejected pre-fetch. LIVE-CONFIRMED to narrow. e.g. 'RECRUITING'.",
    ),
  funderType: z
    .enum(clinicaltrials.CT_FUNDER_TYPES)
    .optional()
    .describe(
      "Funding-source facet (→ aggFilters=funderType:<v>) — the FEDERAL-funding axis. A frozen 4-value enum: nih, fed, industry, other (the B2G-relevant nih/fed narrow to federally-sponsored trials). An UNLISTED value silently returns totalCount:0 at HTTP 200 (a fake-empty trap), so it is rejected pre-fetch (invalid_input). funderType is an OVERLAPPING facet — counts MUST NOT be summed into a total.",
    ),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(20)
    .describe(
      "Studies per page, 1..1000, default 20 (ClinicalTrials.gov clamps a larger request to 1000).",
    ),
  pageToken: z
    .string()
    .min(1)
    .max(4096)
    .regex(clinicaltrials.CT_TOKEN_RE)
    .optional()
    .describe(
      "Opaque continuation cursor — pass back the _meta.nextCursor from the previous page. Pagination is a cursor, NOT a numeric offset (offset/nextOffset are null); nextCursor:null means the last page. A bad token loud-fails at HTTP 400.",
    ),
});
const ClinicaltrialsGetStudyInput = z.object({
  nctId: z
    .string()
    .regex(clinicaltrials.CT_NCT_RE)
    .describe(
      "NCT id — the form NCT followed by exactly 8 digits (e.g. NCT02403869). Returns the ONE full study record INCLUDING briefSummary; a nonexistent id ⇒ found:false (never a fabricated record). Injection-safe (validated before the path is built).",
    ),
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
    .describe(
      "1..11 ClinicalTrials.gov ENUM facet fields (deduped in-handler): OverallStatus, StudyType, Phase, LeadSponsorClass (★ the funding-SOURCE-class distribution — NIH/FED/OTHER_GOV/INDUSTRY/…, distinct from the search tool's 4-value funderType filter), Sex, DesignAllocation, DesignPrimaryPurpose, DesignInterventionModel, DesignMasking, DesignObservationalModel, DesignTimePerspective. Each returns the EXACT whole-registry per-value study-count distribution. An unlisted field ⇒ invalid_input pre-fetch (0 fetch). Phase is ARRAY-valued (counts OVERLAP — see _meta).",
    ),
});

// ─── USITC Harmonized Tariff Schedule (hts.usitc.gov — keyless REST) ─── ADR-0039
// The IMPORT-TARIFF / supply-chain PRICE lane: a good's HTS classification + its
// Column-1 General / Special (preferential/FTA) / Column-2 duty-rate TEXT + the
// Chapter-99 additional-duty provisions. Fixed host `hts.usitc.gov` + FIXED path
// `/reststop/search` (the SSRF core — no free host/path); the single `query` rides
// `keyword=` via URLSearchParams (percent-encoded). ★M2 — a MINIMUM query floor
// (≥3 non-whitespace chars) is enforced at BOTH the Zod boundary (below) and a
// handler belt, so a 1–2 char query is rejected before the fetch (a single char can
// serve 10,000–16,000+ rows / several MB). The full array is fetched once and paged
// CLIENT-SIDE (the endpoint serves no total and IGNORES offset).
const HtsLookupInput = z.object({
  query: z
    .string()
    .trim()
    .min(3)
    .max(100)
    .describe(
      "REQUIRED — a KEYWORD (e.g. 'laptop', 'cotton shirt') OR an HTS number (e.g. '8471.30' or '8471.30.01.00'); both ride the `keyword=` search. Must be ≥3 non-whitespace chars (a 1–2 char/single-char fragment can make USITC serve 10,000–16,000+ rows / several MB). Returns the matching classification rows across the HTS hierarchy with the Column-1 General / Special / Column-2 duty-rate TEXT + Chapter-99 additional-duty provisions.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Rows per page (CLIENT-SIDE slice over the served array), 1..200, default 50."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("0-based row offset for CLIENT-SIDE pagination over the served array (the endpoint has no server-side pagination), default 0."),
});

// ─── BLS Public Data API v1/v2 (api.bls.gov — keyless POST/JSON) ─── ADR-0032
// A NEW capability axis: the PRICING / ESCALATION layer (CPI-U & ECI drive EPA-
// clause escalation; PPI benchmarks materials; CES gives labor-rate context). The
// SECOND POST-batch getJson-port consumer (after NIH). SSRF surface = a compile-
// time-CONSTANT host+path; seriesids ride in the module-built POST body. `series`
// is a FROZEN 9-key curated enum (the SSRF value guard + the units-label source);
// `seriesId` is the raw passthrough, charclass-validated ^[A-Z0-9]{1,20}$. Years
// are bounded ints (1900..currentYear+1); the span is clamped to the tier cap
// (v1 ~10y) BEFORE the fetch + disclosed. An OPTIONAL free BLS_API_KEY rides ONLY
// in the POST body (v2, ~500/day) — never a URL/header/label/_meta/log.
const BlsTimeseriesInput = z.object({
  series: z
    .array(z.enum(bls.BLS_SERIES_KEYS))
    .max(bls.BLS_SERIES_KEYS.length)
    .optional()
    .describe(
      "One or more CURATED series enum keys (typo-proof; each carries a meaning + units label): cpi_u_all (CPI-U all items NSA, index), cpi_u_core (CPI-U core NSA, index), ppi_final_demand (PPI final demand NSA, index), eci_total_comp (ECI total comp — ★12-MO % CHANGE, not an index), eci_wages (ECI wages — ★12-MO % CHANGE), unemployment_rate (SA, percent), labor_force_participation (SA, percent), employment_total_nonfarm (SA, thousands of persons), avg_hourly_earnings (SA, dollars/hour). NSA CPI-U is the escalation/EPA-clause reference. At least one of series/seriesId is required; both may be combined.",
    ),
  seriesId: z
    .array(z.string().regex(/^[A-Z0-9]{1,20}$/))
    .max(bls.BLS_SERIES_KEYS.length + 50)
    .optional()
    .describe(
      "One or more RAW BLS series IDs (power-user passthrough for the un-curatable space — OEWS area×occupation, local-area unemployment LAUCN…, SA/regional CPI variants). Charclass ^[A-Z0-9]{1,20}$ (uppercase alnum; punctuation/whitespace/lowercase rejected — SSRF + 'verify the ID' honesty). A raw ID has units:null (consult BLS). A nonexistent/typo'd ID returns BLS success + empty data (the ambiguity is disclosed, not asserted as 'no data'). At least one of series/seriesId is required.",
    ),
  startYear: z
    .number()
    .int()
    .min(1900)
    .max(bls.YEAR_MAX)
    .optional()
    .describe(
      `Inclusive start year (1900..${bls.YEAR_MAX}). Default: endYear − 9 (a ~10-year window). The span is CLAMPED to the active tier's cap (v1 ~10 years/query) BEFORE the request and disclosed in _meta.notes (never a silently truncated range).`,
    ),
  endYear: z
    .number()
    .int()
    .min(1900)
    .max(bls.YEAR_MAX)
    .optional()
    .describe(
      `Inclusive end year (1900..${bls.YEAR_MAX}). Default: the current year. Must be ≥ startYear.`,
    ),
});

// ─── BLS OEWS — occupational wage benchmarking (2nd tool on api.bls.gov) ── ADR-0033
// The LEVEL layer next to bls_timeseries's ESCALATION layer: mean/median annual &
// hourly wages + employment by SOC occupation × geography. OEWS series IDs are 25
// chars — they EXCEED the bls_timeseries raw-seriesId cap (^[A-Z0-9]{1,20}$), so
// this tool BUILDS the 25-char ID INTERNALLY from validated structured inputs
// (area/occupation/datatype), reusing the same POST/JSON transport + honesty
// layer. NO year input (OEWS serves only the latest annual release). The module
// re-validates every component (belt-and-suspenders behind these schemas).
const BlsOewsWagesInput = z.object({
  occupation: z
    .array(z.enum(bls.BLS_OEWS_OCCUPATION_KEYS))
    .max(bls.BLS_OEWS_OCCUPATION_KEYS.length)
    .optional()
    .describe(
      "One or more CURATED occupation enum keys (typo-proof; each carries an SOC + official label): all_occupations, software_developer (15-1252), computer_systems_analyst, info_security_analyst, management_analyst, project_mgmt_specialist, logistician, accountant_auditor, general_ops_manager, civil_engineer, electrical_engineer, mechanical_engineer, industrial_engineer, lawyer, technical_writer, admin_assistant. The ~830-SOC long tail is reachable via `soc`. At least one of occupation/soc is required.",
    ),
  soc: z
    .array(z.string().regex(/^\d{6}$/))
    .max(50)
    .optional()
    .describe(
      "One or more RAW 6-digit SOC codes (the long-tail passthrough) — HYPHENLESS (use 151252, not 15-1252; the hyphen is rejected). A raw soc that matches a curated occupation is auto-labeled; otherwise key/label are null. At least one of occupation/soc is required.",
    ),
  area: z
    .array(z.string())
    .max(51)
    .optional()
    .describe(
      'One or more geographies (default ["national"]). Each element is "national", a 2-letter USPS state code (e.g. CA, TX, DC — the curated state enum), OR a 5-digit CBSA metropolitan code (^\\d{5}$, e.g. 19100 for Dallas-Fort Worth). Resolved internally to the OEWS areatype + zero-padded area code; an unknown token is rejected (invalid_input, never a malformed series ID on the wire).',
    ),
  datatype: z
    .array(z.enum(bls.BLS_OEWS_DATATYPE_KEYS))
    .max(bls.BLS_OEWS_DATATYPE_KEYS.length)
    .optional()
    .describe(
      'One or more measures (default ["annual_mean"]): annual_mean (dollars/year), annual_median (dollars/year), hourly_mean (dollars/hour), hourly_median (dollars/hour), employment (count jobs). Each row carries measure.units from this map (H3 — never mislabel).',
    ),
});

// ─── BLS QCEW — county×NAICS market-size / wages / location-quotient ── ADR-0042
// A THIRD BLS tool but a SECOND, DIFFERENT, keyless, un-rate-limited BLS DOMAIN:
// the QCEW Open Data Access CSV files on data.bls.gov/cew (NOT the rate-limited
// api.bls.gov/publicAPI timeseries API the two tools above share). SSRF surface =
// a compile-time-CONSTANT host + charclass-validated path segments (year `^\d{4}$`,
// quarter `^[1-4]$`, mode enum {area,industry}, area `^[0-9A-Za-z]{1,6}$`, industry
// DIGIT-ONLY `^[0-9]{1,6}$` — a hyphenated NAICS 31-33 404s). Client-side filters
// (ownership/aggregationLevel/sizeCode/narrow) NEVER touch the URL. Honesty crux:
// the block/code/field-scoped disclosure→null (never 0). NO BLS_API_KEY on this
// keyless path; a NEW self-throttle gate key ("bls_qcew"), NOT "bls".
const BlsQcewInput = z.object({
  mode: z
    .enum(["area", "industry"])
    .describe(
      "REQUIRED — the slice shape: 'area' (all industries × ownership × aggregation levels for ONE area_fips) or 'industry' (all areas for ONE NAICS). A fixed enum interpolated as a LITERAL path segment.",
    ),
  area: z
    .string()
    .regex(/^[0-9A-Za-z]{1,6}$/)
    .optional()
    .describe(
      "The area_fips (^[0-9A-Za-z]{1,6}$): county 01005, statewide 01000, national US000, MSA C1018, CSA CS122. REQUIRED when mode=area (the path segment). When mode=industry it is an OPTIONAL client-side narrow (keep only rows for this area_fips).",
    ),
  industry: z
    .string()
    .regex(/^[0-9]{1,6}$/)
    .optional()
    .describe(
      "The NAICS code (DIGIT-ONLY ^[0-9]{1,6}$): 5415, or the aggregate 10. REQUIRED when mode=industry (the path segment). When mode=area it is an OPTIONAL client-side narrow (keep only rows for this NAICS). A hyphenated NAICS supersector (31-33, 44-45) 404s on QCEW — pass its digit aggregate code, never the hyphenated form.",
    ),
  year: z
    .number()
    .int()
    .min(1990)
    .max(bls.YEAR_MAX)
    .describe(
      `REQUIRED — the 4-digit year (1990..${bls.YEAR_MAX}). QCEW Open Data coverage begins ~1990; a pre-coverage or future year is an honest per-tuple HTTP 404 (found:false), NOT zero establishments.`,
    ),
  quarter: z
    .enum(["1", "2", "3", "4"])
    .describe(
      "REQUIRED — the quarter '1'|'2'|'3'|'4' (all four live-servable). The annual 'a' is not enabled this build.",
    ),
  ownership: z
    .string()
    .regex(/^[0-9A-Za-z]{1,3}$/)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter on own_code (e.g. 0=Total, 1=Federal, 2=State, 3=Local, 5=Private). Never on the URL (no SSRF surface).",
    ),
  aggregationLevel: z
    .string()
    .regex(/^[0-9A-Za-z]{1,3}$/)
    .optional()
    .describe(
      "Optional CLIENT-SIDE filter on agglvl_code (e.g. 70=total-all-industries, 78=6-digit-NAICS-by-ownership). Filter to ONE agglvl_code for a coherent, non-double-counted total.",
    ),
  sizeCode: z
    .string()
    .regex(/^[0-9A-Za-z]{1,3}$/)
    .optional()
    .describe("Optional CLIENT-SIDE filter on size_code."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(50)
    .describe("Rows per page (CLIENT-SIDE window over the fetched-once slice), 1..1000, default 50."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("0-based row offset for CLIENT-SIDE pagination over the filtered set (QCEW has no server-side pagination), default 0."),
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
  .describe(
    "Address-range benchmark (default Public_AR_Current — a MOVING benchmark). One of Public_AR_Current / Public_AR_ACS2025 / Public_AR_LUCA / Public_AR_Census2020. vintage MUST be compatible with this benchmark (a matrix); an incompatible pair fails-closed with an HTTP 400.",
  );
const CensusVintageEnum = z
  .enum(census.CENSUS_VINTAGES)
  .optional()
  .describe(
    "Geography vintage (default Current_Current — a MOVING vintage; the same address may return a different tract/CD across cycles). The valid vintage set DEPENDS on the benchmark (a matrix — this enum is the UNION across all four benchmarks); an incompatible (benchmark, vintage) pair fails-closed with an HTTP 400 (invalid_input), never a silent mis-resolution. e.g. Census2020_Census2020 (with Public_AR_Census2020), Census2010_Current.",
  );

const CensusGeocodeAddressInput = z.object({
  address: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "A one-line US address, e.g. '600 Dexter Ave, Montgomery, AL 36104'. An unmatched/under-specified address is NOT an error — it returns matches:[] / matchCount:0 (a genuine empty; add city, state, ZIP). An ambiguous address may return MULTIPLE matches, each with its own matchedAddress + geographies.",
    ),
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
      .describe(
        "Longitude (x), a finite number in [-180, 180]. Alias of `x`. e.g. -86.301883.",
      ),
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe(
        "Latitude (y), a finite number in [-90, 90]. Alias of `y`. e.g. 32.377612.",
      ),
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

// ─── US Census County Business Patterns (CBP) — the FIRST key-required source ──
const CensusBusinessPatternsInput = z.object({
  naics: z
    .string()
    .regex(/^\d{2,6}$/)
    .optional()
    .describe(
      "A NAICS-2017 code (2–6 digits), e.g. '5415' (Computer Systems Design & Related Services) or '54' (Professional/Scientific/Technical). Omit to aggregate across all sectors. Validated ^\\d{2,6}$.",
    ),
  geography: z
    .enum(["us", "state", "county"])
    .optional()
    .describe(
      "The geography level (default 'us'). 'state' returns one row per state (or a single state when `state` is given); 'county' returns every county in a state and REQUIRES `state`.",
    ),
  state: z
    .string()
    .regex(/^\d{2}$/)
    .optional()
    .describe(
      "A 2-digit state FIPS code, e.g. '06' (California), '48' (Texas). Optional filter for geography='state'; REQUIRED for geography='county' (the CBP `in=state:` predicate). Validated ^\\d{2}$.",
    ),
  year: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe(
      "The CBP data year (default '2022', the latest confirmed vintage). Validated ^\\d{4}$ (it rides in the request path).",
    ),
  limit: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "OPTIONAL client-side top-N cap on the returned rows. CBP has NO server-side pagination, so this slices AFTER the full set is fetched and DISCLOSES the omission (totalAvailable stays the full count). Omit to return every matching row.",
    ),
});

// ─── EPA Envirofacts TRI facilities (ADR-0059) — keyless, PATH-segment SSRF ──
// data.epa.gov /efservice/tri_facility. Two requests: a count sub-query for the
// EXACT total (P1) + the data slice. All user values ride as PATH SEGMENTS, so each
// is charclass-validated + encodeURIComponent-encoded (the load-bearing SSRF guard).
const EpaTriFacilitiesInput = z
  .object({
    state: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe(
        "A 2-letter US state/territory code, e.g. 'VA', 'CA', 'PR' (→ state_abbr; case-insensitive). Provide at least this OR `facilityName`. Validated ^[A-Za-z]{2}$ (it rides in the request path).",
      ),
    facilityName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9 &.\-]+$/)
      .optional()
      .describe(
        "A partial facility-name match (→ facility_name/CONTAINING/…; case-insensitive), e.g. 'chemical', 'boeing'. Provide at least this OR `state`. Allowed: letters/digits/space/& - . (≤100 chars); '/' and '..' rejected (path-injection guard).",
      ),
    county: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9 &.\-]+$/)
      .optional()
      .describe(
        "A partial county-name match (→ county_name/CONTAINING/…), e.g. 'FAIRFAX'. Optional additional filter; same charclass as facilityName.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max facilities to return (1–100, default 25). Offset-paginated."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
  })
  .refine((v) => v.state !== undefined || v.facilityName !== undefined, {
    message: "Provide at least `state` or `facilityName` (an all-empty query would scan the whole national TRI table and is refused).",
    path: ["state"],
  });

// ─── CMS Medicare provider-service utilization (ADR-0061) — keyless, two-request ──
// data.cms.gov /data-api/v1/dataset/{uuid}. Two requests: a stats count sub-query
// for the EXACT total (P1 — found_rows) + the data slice (a bare JSON array). Filter
// VALUES ride via URLSearchParams (bracket key + value encoded). REQUIRE npi OR
// state (the 9.78M-row table is never scanned unscoped).
const CmsMedicareProviderServicesInput = z
  .object({
    npi: z
      .string()
      .regex(/^\d{10}$/)
      .optional()
      .describe(
        "A 10-digit National Provider Identifier (→ Rndrng_NPI), e.g. '1003000126'. Provide at least this OR `state`. Validated ^\\d{10}$.",
      ),
    state: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe(
        "A 2-letter US state/territory code (→ Rndrng_Prvdr_State_Abrvtn), e.g. 'VA', 'CA'. Provide at least this OR `npi`. Validated ^[A-Za-z]{2}$.",
      ),
    providerType: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9 &.,()/'-]+$/)
      .optional()
      .describe(
        "An optional specialty filter matching the CMS provider type EXACTLY (→ Rndrng_Prvdr_Type), e.g. 'Family Practice', 'Physical Therapist in Private Practice'. Allowed: letters/digits/space/& . , ( ) / ' - (≤100 chars).",
      ),
    hcpcsCode: z
      .string()
      .regex(/^[A-Za-z0-9]{1,10}$/)
      .optional()
      .describe(
        "An optional HCPCS/CPT service code filter (→ HCPCS_Cd), e.g. '97110', 'G0463'. Validated ^[A-Za-z0-9]{1,10}$.",
      ),
    size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max provider-service rows to return (1–100, default 25). Offset-paginated."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
  })
  .refine((v) => v.npi !== undefined || v.state !== undefined, {
    message: "Provide at least `npi` or `state` (an all-empty query would scan the entire 9.78M-row Medicare utilization table and is refused; providerType/hcpcsCode alone are not enough to scope).",
    path: ["npi"],
  });

// ─── CMS Hospital Compare "Hospital General Information" (ADR-0062) — keyless ──
// data.cms.gov /provider-data/api/1/datastore/query/{datasetId}/0. A SINGLE request:
// the response's top-level `count` is the EXACT per-filter total (P1). Filters ride
// as DKAN conditions[] triples via URLSearchParams (bracket key + value encoded).
// REQUIRE state OR facilityName (the ~5,432-hospital table is never scanned unscoped).
const CmsHospitalCompareInput = z
  .object({
    state: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe(
        "A 2-letter US state/territory code (→ state, EXACT match), e.g. 'VA', 'CA'. Provide at least this OR `facilityName`. Validated ^[A-Za-z]{2}$.",
      ),
    facilityName: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9 &.,()/'-]+$/)
      .optional()
      .describe(
        "A hospital-name fragment (→ facility_name, case-insensitive SUBSTRING/contains match), e.g. 'children'. Provide at least this OR `state`. Allowed: letters/digits/space/& . , ( ) / ' - (≤100 chars).",
      ),
    hospitalType: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9 &.,()/'-]+$/)
      .optional()
      .describe(
        "An optional hospital-type filter (→ hospital_type, case-insensitive SUBSTRING/contains match), e.g. 'Acute', 'Critical Access'. Allowed: letters/digits/space/& . , ( ) / ' - (≤100 chars).",
      ),
    size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max hospital rows to return (1–100, default 25). Offset-paginated."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
  })
  .refine((v) => v.state !== undefined || v.facilityName !== undefined, {
    message: "Provide at least `state` or `facilityName` (an all-empty query would scan the entire ~5,432-hospital table and is refused; hospitalType alone is not enough to scope).",
    path: ["state"],
  });

// ─── CMS Facility Directory (data.cms.gov provider-data, ADR-0063) — KEYLESS ──
// A four-dataset facility directory generalizing cms_hospital_compare beyond
// hospitals. `facilityType` is a Zod ENUM that indexes a MODULE-CONSTANT map to a
// VETTED dataset id (nursing_home → 4pq5-n9py, home_health → 6jpm-sxkc, hospice →
// yc9t-dgbk, dialysis → 23ew-n7w9) — the user value never enters the URL path. A
// SINGLE request: the response's top-level `count` is the EXACT per-filter total
// (P1). Filters ride as DKAN conditions[] triples via URLSearchParams. name/address/
// ownership columns vary per dataset → coalesced (null if none).
const CmsFacilityDirectoryInput = z.object({
  facilityType: z
    .enum(["nursing_home", "home_health", "hospice", "dialysis"])
    .describe(
      "REQUIRED — which CMS provider-data dataset to search: 'nursing_home' (~14,695), 'home_health' (~12,460), 'hospice' (~6,852), or 'dialysis' (~7,490). Selects the dataset id via a constant map (the value never enters the URL path).",
    ),
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe(
      "An optional 2-letter US state/territory code (→ state, EXACT match), e.g. 'VA', 'TX'. Validated ^[A-Za-z]{2}$.",
    ),
  facilityName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9 &.,()/'-]+$/)
    .optional()
    .describe(
      "An optional facility-name fragment (case-insensitive SUBSTRING/contains match against the dataset's primary-name column). Allowed: letters/digits/space/& . , ( ) / ' - (≤100 chars).",
    ),
  size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max facility rows to return (1–100, default 25). Offset-paginated."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
});

// ─── CMS DMEPOS by Supplier (data.cms.gov data-API, ADR-0064) — KEYLESS ──
// SAME host/endpoint/two-request-stats-count pattern as cms_medicare_provider_services.
// REQUIRE npi OR state (the supplier table is never scanned unscoped). Filter VALUES
// ride as URLSearchParams filter[Col]=Val (bracket key + value encoded — the SSRF guard).
const CmsDmeposSuppliersInput = z
  .object({
    npi: z
      .string()
      .regex(/^\d{10}$/)
      .optional()
      .describe(
        "A 10-digit supplier National Provider Identifier (→ Suplr_NPI), e.g. '1003000126'. Provide at least this OR `state`. Validated ^\\d{10}$.",
      ),
    state: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe(
        "A 2-letter US state/territory code (→ Suplr_Prvdr_State_Abrvtn), e.g. 'VA', 'CA'. Provide at least this OR `npi`. Validated ^[A-Za-z]{2}$.",
      ),
    size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max supplier rows to return (1–100, default 25). Offset-paginated."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
  })
  .refine((v) => v.npi !== undefined || v.state !== undefined, {
    message: "Provide at least `npi` or `state` (an all-empty query would scan the entire DMEPOS supplier table and is refused).",
    path: ["npi"],
  });

// ─── CMS Revoked Medicare Providers & Suppliers (data.cms.gov data-API, ADR-0064) ──
// KEYLESS. A legally-published revocation/exclusion register (~7,059 rows) — the same
// vetting class as the OFAC / SAM exclusion lists. ALL filters optional (small table —
// pagination is fine unfiltered). SAME two-request stats-count P1 pattern.
const CmsRevokedProvidersInput = z.object({
  npi: z
    .string()
    .regex(/^\d{10}$/)
    .optional()
    .describe(
      "An optional 10-digit National Provider Identifier (→ NPI), e.g. '1003000126'. Validated ^\\d{10}$.",
    ),
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe(
      "An optional 2-letter US state/territory code (→ STATE_CD, EXACT match), e.g. 'FL', 'CA'. Validated ^[A-Za-z]{2}$.",
    ),
  lastName: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9 .,'-]+$/)
    .optional()
    .describe(
      "An optional last-name filter (→ LAST_NAME, EXACT match). Allowed: letters/digits/space/. , ' - (≤100 chars).",
    ),
  size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max revocation rows to return (1–100, default 25). Offset-paginated."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
});

// ─── FRED (Federal Reserve Economic Data) — the SECOND key-required source ──
// ADR-0048. Macro context (GDP/CPI/rates/unemployment/PPI). REQUIRES a free
// FRED_API_KEY; without it both tools throw an honest config error (the other 112
// tools stay keyless). The key rides &api_key= ONLY. Missing observations ('.') → null.
const FredSearchSeriesInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "The FRED search_text — free-text terms to discover economic series, e.g. 'unemployment rate', 'CPI', 'GDP', '10-year treasury'. Required.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Max series to return (default 25, max 1000). Offset-paginated."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
});

const FredSeriesObservationsInput = z.object({
  seriesId: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .describe(
      "A FRED series id, e.g. 'GDP', 'CPIAUCSL' (CPI), 'UNRATE' (unemployment), 'DGS10' (10-yr Treasury), 'PPIACO' (PPI). Discover ids with fred_search_series. Validated ^[A-Za-z0-9._-]+$. Required.",
    ),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Earliest observation date (YYYY-MM-DD). Maps to FRED observation_start."),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Latest observation date (YYYY-MM-DD). Maps to FRED observation_end."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .describe("Max observations to return (default 100, max 100000). Offset-paginated."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
  sortOrder: z
    .enum(["asc", "desc"])
    .optional()
    .describe("Observation date order: 'asc' (oldest first, FRED default) or 'desc' (newest first)."),
});

// ─── openFDA recall/enforcement (api.fda.gov) — KEYLESS + OPTIONAL rate-limit key ──
// ADR-0054. Drug/device/food recall enforcement records. Structured filters ONLY
// (no raw Lucene passthrough — injection-safe); the tool assembles the openFDA
// `search=` string with proper escaping. totalAvailable = meta.results.total (P1);
// a no-match query (openFDA HTTP 404 NOT_FOUND) ⇒ an honest empty (P2). An OPTIONAL
// OPENFDA_API_KEY only raises the rate limit (keyless works ~1000/day).
const OpenfdaEnforcementInput = z.object({
  category: z
    .enum(["drug", "device", "food"])
    .optional()
    .describe(
      "The recall category (default 'drug'): 'drug', 'device', or 'food'. Selects the openFDA /{category}/enforcement endpoint.",
    ),
  firm: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Recalling firm name filter (→ recalling_firm), e.g. 'pfizer'. Matched as an escaped Lucene phrase.",
    ),
  product: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Product description filter (→ product_description), e.g. 'insulin'. Matched as an escaped Lucene phrase.",
    ),
  reason: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Reason-for-recall filter (→ reason_for_recall), e.g. 'contamination'. Matched as an escaped Lucene phrase.",
    ),
  classification: z
    .enum(["Class I", "Class II", "Class III"])
    .optional()
    .describe(
      "FDA recall classification filter: 'Class I' (most serious), 'Class II', or 'Class III'.",
    ),
  status: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Recall status filter (→ status), e.g. 'Ongoing', 'Terminated', 'Completed'.",
    ),
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe(
      "2-letter US state/territory postal code filter (→ state), e.g. 'CA'. Validated ^[A-Za-z]{2}$.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max recall records to return (default 25, max 100). Offset-paginated via skip."),
  skip: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
});

// ─── openFDA 510(k) device clearances (api.fda.gov) — KEYLESS + OPTIONAL rate-limit key ──
// ADR-0056. FDA premarket-notification (510(k)) device clearances — SAME source/envelope/
// crux as openfda_enforcement (structured filters ONLY — the tool assembles + escapes the
// search= string, injection-safe). totalAvailable = meta.results.total (P1); a no-match
// query (openFDA HTTP 404 NOT_FOUND) ⇒ an honest empty (P2). An OPTIONAL OPENFDA_API_KEY
// only raises the rate limit (keyless works ~1000/day).
const OpenfdaDeviceClearancesInput = z.object({
  applicant: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Applicant / manufacturer name filter (→ applicant), e.g. 'medtronic'. Matched as an escaped Lucene phrase.",
    ),
  deviceName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Device name filter (→ device_name), e.g. 'catheter'. Matched as an escaped Lucene phrase.",
    ),
  productCode: z
    .string()
    .min(1)
    .optional()
    .describe(
      "FDA product code filter (→ product_code), e.g. 'DXN'. Matched as an escaped Lucene phrase.",
    ),
  clearanceType: z
    .string()
    .min(1)
    .optional()
    .describe(
      "510(k) clearance type filter (→ clearance_type), e.g. 'Traditional', 'Special', 'Abbreviated'. Matched as an escaped Lucene phrase.",
    ),
  kNumber: z
    .string()
    .min(1)
    .optional()
    .describe(
      "510(k) clearance number (K-number) filter (→ k_number), e.g. 'K123456'. Matched as an escaped Lucene phrase.",
    ),
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe(
      "2-letter US state/territory postal code filter (→ state), e.g. 'CA'. Validated ^[A-Za-z]{2}$.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max clearance records to return (default 25, max 100). Offset-paginated via skip."),
  skip: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
});

// ─── NHTSA vehicle safety (api.nhtsa.gov) — KEYLESS vehicle/parts supplier vetting ──
// ADR-0057. Two tools (recalls + complaints) share make/model/modelYear inputs. NO
// API key at all. ★The complaints VIN (PII) is excluded from the output. modelYear is
// ^\d{4}$; make/model are letters/digits/space/hyphen only (SSRF/injection guard).
const NhtsaVehicleInput = z.object({
  make: z
    .string()
    .regex(/^[A-Za-z0-9 -]+$/)
    .describe(
      "Vehicle make (required), e.g. 'honda', 'ford'. Letters/digits/space/hyphen only (^[A-Za-z0-9 -]+$).",
    ),
  model: z
    .string()
    .regex(/^[A-Za-z0-9 -]+$/)
    .describe(
      "Vehicle model (required), e.g. 'accord', 'f-150'. Letters/digits/space/hyphen only (^[A-Za-z0-9 -]+$).",
    ),
  modelYear: z
    .string()
    .regex(/^\d{4}$/)
    .describe("4-digit model year (required), e.g. '2020'. Validated ^\\d{4}$."),
});

// ─── CPSC consumer-product recalls (www.saferproducts.gov) — KEYLESS goods/import vetting ──
// ADR-0058. One tool. NO API key at all. The response is a bare JSON ARRAY with no
// total-count field / no pagination (totalAvailable = the returned count). All filters
// optional; with NO filter the tool defaults RecallDateStart to ~90 days ago (disclosed)
// rather than fetch the whole dataset. dates are ^\d{4}-\d{2}-\d{2}$; recallNumber is
// letters/digits/hyphen only (SSRF/injection guard).
const CpscRecallsInput = z.object({
  dateStart: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Recall date range START (optional), YYYY-MM-DD, e.g. '2025-01-01' (→ RecallDateStart). Validated ^\\d{4}-\\d{2}-\\d{2}$.",
    ),
  dateEnd: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      "Recall date range END (optional), YYYY-MM-DD, e.g. '2025-01-31' (→ RecallDateEnd). Validated ^\\d{4}-\\d{2}-\\d{2}$.",
    ),
  productName: z
    .string()
    .optional()
    .describe("Product name substring filter (optional), e.g. 'helmet' (→ ProductName)."),
  manufacturer: z
    .string()
    .optional()
    .describe("Manufacturer name substring filter (optional) (→ Manufacturer)."),
  recallNumber: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .optional()
    .describe(
      "A specific CPSC recall number (optional), e.g. '25088' (→ RecallNumber). Letters/digits/hyphen only (^[A-Za-z0-9-]+$).",
    ),
});

// ─── BEA Regional Economic Accounts (apps.bea.gov) — the THIRD key-required source ──
// ADR-0051. County/state/MSA GDP-by-industry (CAGDP2/SAGDP2N) + personal income
// (CAINC1/SAINC1) — the regional/sub-national place-of-performance lane. REQUIRES a
// free BEA_API_KEY; without it the tool throws an honest config error (the other 116
// tools stay keyless). ★A missing/invalid key returns HTTP 200 with a
// BEAAPI.Results.Error carrier (NOT an HTTP error), detected pre-drift. The key rides
// UserID= ONLY. DataValue is a comma string; suppression codes ((NA)/(D)/…) → null.
const BeaRegionalDataInput = z.object({
  tableName: z
    .string()
    .regex(/^[A-Za-z0-9]{2,20}$/)
    .describe(
      "A BEA Regional table code (2–20 alphanumerics), e.g. 'CAGDP2' (county GDP by industry), 'SAGDP2N' (state GDP by industry), 'CAINC1'/'SAINC1' (personal income). Validated ^[A-Za-z0-9]{2,20}$. Required.",
    ),
  geoFips: z
    .string()
    .regex(/^[A-Za-z0-9]{2,10}$/)
    .describe(
      "The BEA GeoFips selector: 'STATE' (all states), a county FIPS like '06075', or an MSA code. Validated ^[A-Za-z0-9]{2,10}$. Required.",
    ),
  lineCode: z
    .string()
    .regex(/^([0-9]{1,4}|ALL)$/)
    .describe(
      "The industry/statistic line code — an integer (1–4 digits), e.g. '1', or 'ALL' for every line in the table. Validated ^([0-9]{1,4}|ALL)$. Required.",
    ),
  year: z
    .string()
    .regex(/^(\d{4}|LAST5|ALL)$/)
    .optional()
    .describe(
      "The data year: a 4-digit year (e.g. '2022'), 'LAST5' (the latest 5 years, default), or 'ALL'. Validated ^(\\d{4}|LAST5|ALL)$.",
    ),
  frequency: z
    .enum(["A", "Q"])
    .optional()
    .describe("Data frequency: 'A' (annual, default) or 'Q' (quarterly)."),
});

// ─── GSA Federal Travel Per-Diem (api.gsa.gov) — travel-cost lane ──
// ADR-0050. Lodging + M&IE reimbursement ceilings by city/state OR zip for a year.
// KEYLESS by default via the shared DEMO_KEY (datagovKey.ts seam); DATA_GOV_API_KEY
// lifts the rate. EITHER (city+state) OR zip — both/neither ⇒ invalid_input, 0 fetch.
const GsaPerdiemRatesInput = z
  .object({
    city: z
      .string()
      .regex(/^[A-Za-z .'\-]{1,60}$/)
      .optional()
      .describe(
        "The city name (e.g. 'Washington', 'San Francisco'). Requires `state`. Validated ^[A-Za-z .'\\-]{1,60}$. Use EITHER (city + state) OR zip — not both.",
      ),
    state: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe(
        "The 2-letter state/territory code (e.g. 'DC', 'CA'). Required with `city`. Validated ^[A-Za-z]{2}$.",
      ),
    zip: z
      .string()
      .regex(/^\d{5}$/)
      .optional()
      .describe(
        "A 5-digit ZIP code (e.g. '20001'). The alternative lookup mode to city+state. Validated ^\\d{5}$. Use EITHER zip OR (city + state) — not both.",
      ),
    year: z
      .string()
      .regex(/^\d{4}$/)
      .optional()
      .describe(
        "The per-diem fiscal year (default '2025'). Validated ^\\d{4}$ (it rides in the request path).",
      ),
  })
  .describe(
    "Look up GSA per-diem rates by EITHER (city + state) OR zip. Supplying both, or neither, ⇒ invalid_input.",
  );

// ─── US DOL Data API v4 (apiprod.dol.gov) — the labor-enforcement lane ──
// ADR-0053. A DELIBERATE key split: dol_list_datasets (the CATALOG) is KEYLESS;
// dol_get_dataset (the DATA endpoint) is the 4th REQUIRED key (DOL_API_KEY, no keyless
// tier — throws pre-fetch without it). The key rides the X-API-KEY HEADER ONLY. The
// data envelope is key-gated/unverified ⇒ records are surfaced verbatim + totalAvailable
// defaults null (never `returned` faked as the total). agency/query filter is CLIENT-SIDE.
const DolListDatasetsInput = z.object({
  agency: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe(
      "CLIENT-SIDE filter by agency abbreviation (e.g. 'WHD', 'OSHA', 'ILAB', 'ETA') or a substring of the agency name. The DOL catalog API does not filter server-side, so this is applied to the fetched catalog.",
    ),
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "CLIENT-SIDE free-text filter (substring over dataset name / description / category / table / endpoint), e.g. 'child labor', 'wage', 'inspection'.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Datasets to return per page (default 25, max 200). Offset-paginated over the (filtered) catalog."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
});

const DolGetDatasetInput = z.object({
  agency: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .describe(
      "The agency abbreviation (the `agencyAbbr` from dol_list_datasets), e.g. 'WHD', 'OSHA', 'ILAB'. Rides in the request PATH. Validated ^[A-Za-z0-9_]+$. Required.",
    ),
  table: z
    .string()
    .regex(/^[A-Za-z0-9_]+$/)
    .describe(
      "The dataset endpoint — the `apiUrl` field from dol_list_datasets (the DOL 'api_url', NOT the tablename), e.g. 'Child_Labor_Report__2016_to_2022'. Rides in the request PATH. Validated ^[A-Za-z0-9_]+$. Required.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Max records to return (default 10, max 100). Offset-paginated."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Row offset for pagination (default 0). Page with _meta.pagination.nextOffset."),
  filterField: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional: a dataset field name to filter on (paired with filterValue → a DOL filter_object equality filter). Supply BOTH or NEITHER."),
  filterValue: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional: the value the filterField must equal. Supply BOTH filterField and filterValue, or NEITHER."),
  fields: z
    .array(z.string().min(1))
    .optional()
    .describe("Optional: best-effort column selection (a subset of field names to return). Not documented for v4; the API ignores or 400s an unsupported selection (surfaced honestly)."),
});

// ─── US Senate LDA lobbying filings (lda.senate.gov) — the lobbying/B2G lane ──
// ADR-0052. Who is paid HOW MUCH to lobby WHICH federal agency on WHICH issue.
// KEYLESS (anonymous 200); an optional free LDA_API_KEY only raises the rate limit
// and rides the Authorization: Token … header ONLY. `count` is the REAL total
// (~1.95M) — never results.length; page-based pagination (page/pageSize ≤25). All
// filter VALUES ride URLSearchParams; filingYear/page/pageSize charclass/range-guarded.
const LdaSearchFilingsInput = z.object({
  registrantName: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by the registrant (the lobbying firm / in-house filer) name, e.g. 'Akin Gump'. Substring match, upstream-validated."),
  clientName: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by the client name (who the lobbying is FOR), e.g. 'Google'. Substring match, upstream-validated."),
  lobbyistName: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by an individual lobbyist's name. Substring match, upstream-validated."),
  filingYear: z
    .string()
    .regex(/^\d{4}$/)
    .optional()
    .describe("Filter by filing year, a 4-digit year (e.g. '2024'). Validated ^\\d{4}$."),
  filingType: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by the filing type short code (e.g. 'Q1' Q1 report, 'RR' registration, 'YE' year-end). A bad code ⇒ upstream HTTP 400 ⇒ invalid_input (surfaced)."),
  agency: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by the federal government entity lobbied (maps to government_entity — the B2G signal), e.g. 'DEPARTMENT OF DEFENSE'."),
  issue: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by the specific lobbying issues text (maps to filing_specific_lobbying_issues), e.g. 'appropriations'."),
  page: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe("1-based page number (default 1). Page with the next page number from _meta.notes / when _meta.pagination.hasMore."),
  pageSize: z
    .number()
    .int()
    .min(1)
    .max(25)
    .default(25)
    .describe("Filings per page, 1..25 (the LDA API caps at 25), default 25."),
});

// ─── US federal court opinions (www.courtlistener.com) — the litigation lane ──
// ADR-0055. Federal court decisions (opinions) — the judicial signal no contract/
// spending/lobbying source carries (e.g. uscfc bid-protest / contract-claim opinions).
// ★PROVENANCE: CourtListener (Free Law Project, a non-profit), NOT a .gov API —
// PACER (the .gov source) is paywalled. KEYLESS (anonymous 200); an optional free
// COURTLISTENER_API_TOKEN only raises the rate limit, riding the Authorization: Token
// … header ONLY (the lda/socrata app-token lineage). `count` is the REAL total —
// never results.length; CURSOR pagination (nextCursor extracted from `next`). court/
// dates charclass-guarded; all filter VALUES ride URLSearchParams; type=o is FIXED.
const CourtlistenerSearchOpinionsInput = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe("Full-text query (maps to q), e.g. 'bid protest' or a party name. Matches across the opinion text/metadata."),
  court: z
    .string()
    .regex(/^[a-z0-9]+$/)
    .optional()
    .describe("A CourtListener court id (lowercase alphanumerics ^[a-z0-9]+$), e.g. 'uscfc' (US Court of Federal Claims — contract claims/bid protests), 'cafc' (Federal Circuit — contract/patent appeals), 'scotus'."),
  dateFiledAfter: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Only opinions filed on/after this ISO date (→ filed_after), e.g. '2020-01-01'. Validated ^\\d{4}-\\d{2}-\\d{2}$."),
  dateFiledBefore: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Only opinions filed on/before this ISO date (→ filed_before), e.g. '2024-12-31'. Validated ^\\d{4}-\\d{2}-\\d{2}$."),
  natureOfSuit: z
    .string()
    .min(1)
    .optional()
    .describe("Nature-of-suit text — folded into the q full-text query (the v4 opinions search has no verified dedicated filter), so it matches the text anywhere in the document (disclosed in _meta.notes)."),
  cursor: z
    .string()
    .min(1)
    .optional()
    .describe("Opaque continuation token for the NEXT page — pass back the _meta.nextCursor from the previous response (CourtListener uses CURSOR pagination, not page/offset)."),
  order: z
    .string()
    .min(1)
    .default("dateFiled desc")
    .describe("Sort order (maps to order_by), default 'dateFiled desc' (most recent first). E.g. 'dateFiled asc', 'score desc'."),
});

// ─── US tax-exempt nonprofits (projects.propublica.org) — the nonprofit lane ──
// ADR-0060. IRS Form 990 public records republished KEYLESS by ProPublica Nonprofit
// Explorer (a non-profit newsroom) — NOT a .gov API (the IRS has no clean query
// API). ★PROVENANCE disclosed in _meta.source + a note. KEYLESS (no key of any
// kind). search: q/state[id]/ntee[id]/page (0-based); total_results is the REAL
// total — never organizations.length. All VALUES ride URLSearchParams (incl. the
// bracket keys); state/ntee charclass/range-guarded.
const NonprofitSearchInput = z.object({
  query: z
    .string()
    .min(1)
    .optional()
    .describe("Full-text query (maps to q) — an organization name or keyword, e.g. 'american red cross'. Matches across the org name/metadata."),
  state: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .optional()
    .describe("Filter by a 2-letter US state/territory code (maps to state[id]), e.g. 'VA'. Validated ^[A-Za-z]{2}$."),
  ntee: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Filter by NTEE major category, an integer 1..10 (maps to ntee[id]) — the National Taxonomy of Exempt Entities top-level group (e.g. 1 Arts, 3 Environment, 8 Health)."),
  page: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("0-BASED page number (default 0). Page with cur_page+1 from _meta.notes / when _meta.pagination.hasMore."),
});

// nonprofit_financials — one org's Form 990 profile + financials by EIN. KEYLESS.
// ein rides the URL PATH ⇒ digits-only ^\d{1,9}$. An unknown EIN (404) ⇒ not_found.
const NonprofitFinancialsInput = z.object({
  ein: z
    .string()
    .regex(/^\d{1,9}$/)
    .describe("The organization's EIN (Employer Identification Number), 1..9 digits, e.g. '530196605' (American National Red Cross). Validated ^\\d{1,9}$; rides the URL path."),
});

// api_key_status takes no input — it is a pure status query over process.env.
const ApiKeyStatusInput = z.object({});

// ─── Tool catalog ────────────────────────────────────────────────

type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  // R1 (ADR-0001) — co-located dispatch handler. runTool routes every tool
  // through its handler (parse with `inputSchema`, then call); all 52 tools
  // now define one and the dispatch `switch` is gone (unknown ⇒ throws).
  // The handler may return a raw domain object OR a MetaBundle (via `withMeta`)
  // — CallTool's envelope logic unwraps both identically. Typed `any` here and
  // type-checked against the schema's inferred input by `defineTool`.
  handler?: (input: any, ctx: { sam: SamGovClient }) => Promise<unknown>;
};

// Build a ToolDef whose `handler` is type-checked against the schema's inferred
// input `I` at the call site (e.g. `input.searchText` is known-present). The
// `I` binding is erased to `any` in the ToolDef[] array, so entries without a
// handler need not use this helper.
function defineTool<I>(d: {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  handler?: (input: I, ctx: { sam: SamGovClient }) => Promise<unknown>;
}): ToolDef {
  return d as ToolDef;
}

// Exported for the offline registry-introspection fault fixtures (W3-1): the
// harness asserts a tool's advertised inputSchema/description directly (e.g.
// usas_search_expiring_contracts no longer carries `fiscalYear`; usas_search_awards
// no longer promises "+ count"). Export-only — does NOT change tools/list output
// or any dispatch behavior (main() stays entry-point-gated).
export const TOOLS: ToolDef[] = [
  // ━━━ SAM.gov (8) ━━━
  defineTool({
    name: "sam_search_opportunities",
    description:
      "Search SAM.gov federal contracting opportunities (keyless HAL). Returns up to 50 active notices with title, agency, NAICS, noticeId. Use for discovery — narrow with NAICS / agency / set-aside / state.",
    inputSchema: SamSearchInput,
    handler: async (input, { sam }) => {
      const r = await sam.searchOpportunities({
        ...input,
        setAside: input.setAside as SamSetAside[] | undefined,
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
        return withMeta(
          {
            totalRecords: null,
            returned: 0,
            opportunities: [],
          },
          {
            source:
              "sam.gov/sgs/v1 (keyless HAL) (DEGRADED — search backend unavailable)",
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
          },
        );
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
        const filtersApplied: string[] = [];
        if (input.query) filtersApplied.push("query");
        if (input.ncode) filtersApplied.push("ncode");
        if ((input.setAside?.length ?? 0) > 0) filtersApplied.push("setAside");
        if (input.state) filtersApplied.push("state");
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
        let enrichedData: {
          totalRecords: number;
          returned: number;
          opportunities: gsaCsv.SearchOppRow[];
        } = data;
        // The fields still null after enrichment (rebuilt truthfully below).
        let fieldsUnavailable = ["naics", "setAside", "placeOfPerformance"];
        const enrichmentNotes: string[] = [];
        let source = "sam.gov/sgs/v1 (keyless HAL)";
        let freshness: unknown = undefined;

        if (csvCfg.enabled) {
          const ready = data.returned > 0 ? gsaCsv.tryGetReadyIndex(csvCfg) : null;
          if (ready) {
            const outcome = gsaCsv.enrichSearchOpportunities(
              enrichedData.opportunities,
              ready,
            );
            enrichedData = { ...data, opportunities: outcome.opportunities };
            freshness = outcome.freshness;
            source = "sam.gov/sgs/v1 (keyless HAL) + gsa-csv (daily bulk CSV snapshot)";

            // Rebuild fieldsUnavailable: a field is only "unavailable" if it was
            // NOT filled on the whole page. Fields filled from the CSV drop off.
            // (naics/setAside/placeOfPerformance are the originally-null trio.)
            fieldsUnavailable = ["naics", "setAside", "placeOfPerformance"].filter(
              (f) => !outcome.fieldsFilled.has(f),
            );

            const filledList = [...outcome.fieldsFilled];
            if (filledList.length > 0) {
              enrichmentNotes.push(
                `naics/set-aside/place-of-performance for results present in today's GSA CSV snapshot were enriched from the GSA daily bulk CSV (source: gsa-csv) — filled fields this page: ${filledList.join(", ")}. set-aside here is the CSV short code (e.g. 'SBA') that matches sam_get_opportunity's setAside. Confirm real-time values (e.g. a just-amended deadline) with sam_get_opportunity.`,
              );
            } else {
              enrichmentNotes.push(
                "GSA-CSV enrichment ran but filled no fields on this page (the matched snapshot rows carried no non-empty naics/set-aside/place-of-performance) — values remain null; fetch sam_get_opportunity.",
              );
            }
            if (outcome.missingCount > 0) {
              enrichmentNotes.push(
                `${outcome.missingCount} of ${data.returned} results were not in the current CSV snapshot (too new or archived) — their naics/set-aside/PoP remain null; fetch sam_get_opportunity for those noticeIds.`,
              );
            }
            enrichmentNotes.push(
              `GSA CSV freshness — snapshot last-modified: ${outcome.freshness.csvLastModified ?? "unknown"}; index built: ${outcome.freshness.indexBuiltAt}; index age: ${outcome.freshness.indexAgeHours ?? "unknown"}h. The snapshot can lag the live HAL by up to ~24h.`,
            );
          } else if (data.returned > 0) {
            // Enabled, rows exist that COULD be enriched, but the index isn't
            // warm yet (cold cache / background refresh in flight). Return the
            // normal HAL page un-enriched and disclose the pending warm — never
            // block on the download. Gated on returned>0: on a genuinely-empty
            // (returned===0) page there are NO rows to enrich, so a "retry for an
            // enriched page" note would be misleading — a retry cannot add rows.
            // That case falls through with the plain un-enriched source/notes
            // (the empty page is a complete, honest result).
            source = "sam.gov/sgs/v1 (keyless HAL) + gsa-csv (index warming)";
            enrichmentNotes.push(
              "GSA-CSV enrichment pending — the CSV index is warming (a background download/build was kicked off); naics/set-aside/place-of-performance were NOT enriched this call. Retry shortly for an enriched page, or fetch sam_get_opportunity now.",
            );
          }
        }

        const notes: string[] = [];
        if (filtersApplied.length > 0) {
          notes.push(
            "Keyless SAM search filtered server-side by the applied facets (NAICS/set-aside/place-of-performance state/keyword) — the result count reflects them. But the keyless list payload OMITS each notice's naics/setAside/placeOfPerformance VALUES (null here); call sam_get_opportunity on a noticeId to read those values.",
          );
        } else {
          notes.push(
            "naics/setAside/placeOfPerformance are null because the keyless list endpoint omits those values — call sam_get_opportunity for a notice to obtain them.",
          );
        }
        if (filtersDropped.length > 0) {
          notes.push(
            "The organization-name filter is NOT supported by the keyless endpoint and was ignored (results are unfiltered on organization). Set SAM_GOV_API_KEY to filter by organization, or filter client-side on the returned `agency` field.",
          );
        }
        notes.push(...enrichmentNotes);

        // freshness is surfaced structurally in `data` (the ResponseMeta type
        // has no typed freshness field, mirroring sam_lookup_notice_fields) —
        // present only when enrichment actually ran.
        const dataOut =
          freshness !== undefined
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
    description:
      "PRE-SOLICITATION shaping radar (keyless HAL). Surfaces Sources Sought / Presolicitation / Special Notices BEFORE the RFP exists — the free, real-time analogue of paid agency-forecast feeds. Closes the pre-solicitation lifecycle gap: catch a requirement while it's still shapeable (submit capabilities, influence NAICS/set-aside/PWS). Defaults to noticeType ['r','p','s']; opt into k/i/u for combined-synopsis / intent-to-bundle / J&A tells. Each notice carries noticeTypeCode (rank r/p over s), postedDate, responseDeadline + daysUntilResponse (null when no deadline — counted, not hidden), and a uiLink. HONEST KEYLESS LIMITS: naics/setAside/placeOfPerformance are null in the list rows (call sam_get_opportunity(noticeId) for those); and a responseDeadlineFrom/To window is applied CLIENT-SIDE over the fetched page (the feed ignores rdlfrom/rdlto) and disclosed in _meta. data.totalRecords is the TRUE server-side count for the type+facet filter.",
    inputSchema: SamSearchShapingInput,
    handler: async (input, { sam }) => {
      // Default shaping window = Sources Sought + Presolicitation + Special
      // Notice. These are the notice types that exist BEFORE an RFP — the
      // whole point of the radar.
      const noticeType = input.noticeType ?? ["r", "p", "s"];
      const wantWindow =
        input.responseDeadlineFrom !== undefined ||
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
        setAside: input.setAside as SamSetAside[] | undefined,
        ptype: noticeType as SamProcurementType[],
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
        return withMeta(
          {
            totalRecords: null,
            returned: 0,
            noticeTypesRequested: noticeType,
            notices: [],
          },
          {
            source:
              "sam.gov/api/prod/sgs/v1/search (keyless HAL, notice_type filter) (DEGRADED — search backend unavailable)",
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
          },
        );
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
        ? applyResponseDeadlineWindow(
            allNotices,
            input.responseDeadlineFrom,
            input.responseDeadlineTo,
          )
        : allNotices;

      const data = {
        totalRecords: r.totalRecords, // TRUE server-side count for type+facets
        returned: notices.length,
        noticeTypesRequested: noticeType,
        notices,
      };

      // _meta honesty. filtersApplied lists what the FEED honored server-side
      // (mirror EXACTLY searchPublic's append conditions). Always: noticeType.
      const filtersApplied: string[] = ["noticeType"];
      if (input.query) filtersApplied.push("query");
      if (input.ncode) filtersApplied.push("ncode");
      if ((input.setAside?.length ?? 0) > 0) filtersApplied.push("setAside");
      if (input.state) filtersApplied.push("state");

      // filtersDropped: organization-name has NO keyless param (ignored), and a
      // requested response-deadline window is applied client-side (feed ignores
      // rdlfrom/rdlto) — both must be disclosed so the AI never treats the page
      // as server-filtered on them.
      const filtersDropped: string[] = [];
      if (input.organizationName) filtersDropped.push("organizationName");
      if (wantWindow) filtersDropped.push("responseDeadline");

      const notes: string[] = [
        "Pre-solicitation shaping radar: notice_type is filtered SERVER-SIDE by the keyless feed (r=Sources Sought, p=Presolicitation, s=Special Notice by default; k/i/u opt-in). totalRecords is the TRUE server-side count for the type+facet filter.",
      ];
      if (wantWindow) {
        notes.push(
          "response-deadline window applied client-side over the fetched page (the keyless feed ignores rdlfrom/rdlto); widen limit or narrow via NAICS/agency for completeness. Notices with no deadline are excluded from a windowed query.",
        );
      }
      if (input.organizationName) {
        notes.push(
          "The organization-name filter is NOT supported by the keyless endpoint and was ignored (results are unfiltered on organization). Filter client-side on the returned `agency`, or set SAM_GOV_API_KEY.",
        );
      }
      notes.push(
        "naics/setAside/placeOfPerformance are null in the keyless list rows — call sam_get_opportunity(noticeId) for per-notice NAICS/set-aside/place-of-performance.",
      );

      // truncated when the server has more than we returned OR a client-side
      // deadline window trimmed the page (either way the caller isn't seeing the
      // complete in-scope set).
      const truncated =
        r.totalRecords > data.returned ||
        (wantWindow && allNotices.length !== notices.length);

      return withMeta(data, {
        source:
          "sam.gov/api/prod/sgs/v1/search (keyless HAL, notice_type filter)",
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
    description:
      "Fetch full detail for a single SAM.gov notice by 32-char hex noticeId. Returns title, agency, solicitation #, POCs, response deadline, attachments (with download URLs), inline description body. Call BEFORE drafting bid/no-bid or compliance work.",
    inputSchema: SamGetOpportunityInput,
    handler: async (input, { sam }) => {
      const { noticeId } = input;
      const o = await sam.getOpportunity(noticeId);
      if (!o) return { found: false, noticeId };
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
        const notes = o.enrichmentDegraded.map((bucket) =>
          bucket === "attachments"
            ? "The attachment list could not be fetched (a service issue) — this notice MAY have attachments not shown here; retry. This is NOT a confirmation it has none."
            : "The awarding-organization path could not be resolved (a service issue) — it is unavailable here, not absent.",
        );
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
    description:
      "Return the full description / RFP body text for a notice as plain text. Useful when sam_get_opportunity returned a description URL instead of inline body, or for an LLM-friendly text dump.",
    inputSchema: SamFetchDescriptionInput,
    handler: async (input, { sam }) => {
      const { noticeId } = input;
      const o = await sam.getOpportunity(noticeId);
      if (!o) return { found: false, noticeId };
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
    description:
      "Build the public download URL for an attachment resourceId. The URL returns a 303 redirect to a signed S3 URL — fetch with redirect:'follow' to get the file bytes.",
    inputSchema: SamAttachmentUrlInput,
    handler: async (input, { sam }) => ({
      downloadUrl: sam.publicDownloadUrl(input.resourceId),
    }),
  }),
  defineTool({
    name: "sam_fetch_attachment_text",
    description:
      "Extract the TEXT of a SAM notice attachment (the actual RFP / SOW / Q&A / wage tables) by its download URL — so an AI can read the real solicitation, not just its metadata. Give it a sam_get_opportunity attachments[].url (resourceLinks). Keyless. Handles PDF (via pdfjs) + text/HTML; returns { format, text, pages, filename, sizeBytes, truncated, extracted }. HONEST: a DOCX / binary that can't be read keyless returns text:null + a note (never fabricated); a corrupt/encrypted PDF returns text:null + an extractionError note (never a crash); a DOWN fetch throws a retryable upstream_unavailable (never empty text); a 404 throws not_found. Only sam.gov / api.sam.gov URLs are fetched (SSRF hygiene). maxChars caps the text (default 200000) and truncation is disclosed.",
    inputSchema: SamFetchAttachmentTextInput,
    handler: (input) => fetchAttachmentText(input),
  }),
  defineTool({
    name: "sam_lookup_organization",
    description:
      "Resolve a SAM.gov federal-organization id to its canonical fullParentPathName (e.g. 'VETERANS AFFAIRS, DEPARTMENT OF.VETERANS AFFAIRS, DEPARTMENT OF.245-NETWORK CONTRACT OFFICE 5'). Use when sam_get_opportunity returned only an organizationId.",
    inputSchema: SamLookupOrgInput,
    handler: async (input, { sam }) => {
      const { organizationId } = input;
      // SamGovClient internal method — exposed via direct fetch since
      // it's not on the public surface. Use the public sam.gov endpoint
      // directly (already keyless).
      const orgUrl = `https://sam.gov/api/prod/federalorganizations/v1/organizations/${encodeURIComponent(organizationId)}`;
      let r: Response;
      try {
        r = await fetch(orgUrl, {
          headers: { Accept: "application/hal+json" },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        // A network-level fault (DNS, connection reset, timeout) is an OUTAGE, not
        // absence — classify as retryable rather than letting it surface as the
        // generic `unknown` (which an agent won't retry).
        if (e instanceof ToolErrorCarrier) throw e;
        throw new ToolErrorCarrier({
          kind: "upstream_unavailable",
          message: `SAM federalorganizations lookup for '${organizationId}' failed: ${(e as Error).message}. This is an outage, not a missing organization. Retry.`,
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
      type Resp = {
        _embedded?: {
          org?: {
            fullParentPathName?: string;
            agencyName?: string;
            name?: string;
            type?: string;
            level?: number;
          };
        }[];
      };
      let orgJson: Resp;
      try {
        orgJson = JSON.parse(orgText) as Resp;
      } catch {
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
    description:
      "BATCH-complete a sam_search_opportunities page in ONE call from the GSA daily bulk CSV (keyless). The keyless HAL list endpoint NULLS each result's naics/setAside/place-of-performance/responseDeadline/type; this tool returns those fields for 1..100 noticeIds at once (naicsCode, setAside + setAsideCode, popState/popCity/popZip/popCountry, responseDeadline, type, active, title) from a cached on-disk CSV index, instead of one sam_get_opportunity detail call per notice. OFF BY DEFAULT (no forced 226 MB download): enable by setting SAM_GOV_CSV_CACHE (a cache dir) or SAM_GOV_ENABLE_CSV=1 — when disabled the tool returns data.enabled:false + a structured 'how to enable' note (never fake data, no network). HONEST: _meta carries the CSV last-modified + index build time (freshness), a noticeId absent from the current snapshot returns found:false + nulls with an explicit 'not in current CSV snapshot' disclosure (never faked), a cold first call discloses 'index warming', and a download/parse failure is a structured retryable error (never a silent empty). setAsideCode (e.g. 'SBA') matches sam_get_opportunity's setAside; the snapshot can lag live by up to ~24h — confirm real-time-critical fields with sam_get_opportunity.",
    inputSchema: SamLookupNoticeFieldsInput,
    handler: (input) => gsaCsv.lookupNoticeFields(input),
  }),

  // ━━━ USAspending — Awards & Recipients (10) ━━━
  defineTool({
    name: "usas_search_awards",
    description:
      "Aggregate share-of-wallet on USAspending. Given an agency × NAICS × fiscal year, returns top recipients by total obligated $ ONLY — per-recipient award COUNTS are NOT returned by this endpoint (`awards`/`totalAwards` are null, not 0); for real per-recipient contract counts use usas_search_awards_by_recipient (its _meta.totalAvailable) or usas_get_recipient_profile. Use for competitive landscape ('who wins at VA in 541512?').",
    inputSchema: UsasFiltersBase,
    handler: (input) => usas.searchAwards(input),
  }),
  defineTool({
    name: "usas_search_individual_awards",
    description:
      "Line-item federal contracts on USAspending. Returns specific awards (recipient + $ + sub-agency + state + description). Use AFTER usas_search_awards when the user wants 'show me the actual contracts'. Each result includes a generatedInternalId for usas_get_award_detail follow-ups.",
    inputSchema: UsasIndividualAwardsInput,
    handler: (input) => usas.searchIndividualAwards(input),
  }),
  defineTool({
    name: "usas_search_subagency_spending",
    description:
      "Break down a parent agency's spending by sub-agency / office. Surfaces which office holds the budget (e.g. VA OI&T vs VHA, DoD vs Army vs DISA).",
    inputSchema: UsasSubAgencyInput,
    handler: (input) => usas.searchSubAgencySpending(input),
  }),
  defineTool({
    name: "usas_lookup_agency",
    description:
      "Resolve a user-friendly agency reference ('VA', 'Veterans Affairs', 'DHS') to USAspending's canonical toptier name + 4-digit code. ALWAYS call this FIRST if the user uses an abbreviation — other USAspending tools require the canonical name.",
    inputSchema: UsasLookupAgencyInput,
    handler: (input) => usas.lookupAgency(input.searchText),
  }),
  defineTool({
    name: "usas_search_awards_by_recipient",
    description:
      "Pull every contract a specific recipient has won within an agency × NAICS slice. Use when the user asks 'show me Booz Allen wins at VA last year' — returns line items + naicsCode + description, not aggregates.",
    inputSchema: UsasRecipientAwardsInput,
    handler: (input) => usas.searchAwardsByRecipient(input),
  }),
  defineTool({
    name: "usas_search_subawards",
    description:
      "Enumerate federal subawards (subcontracts), optionally filtered by SUBAWARDEE name. Use for 'where does Leidos appear as a SUBcontractor, and under which primes' — surfaces the prime/sub network for teaming-map artifacts. NOTE: subRecipientName matches the SUB-recipient, NOT the prime (the keyless spending_by_award subaward view has no prime-name filter); to see the subs UNDER a specific prime, resolve that prime's awards first (usas_search_awards → usas_get_award_detail) and read their sub network. Each row carries subRecipient (the subawardee), amount, actionDate, the prime award id, and the prime award's NAICS.",
    inputSchema: UsasSubawardsInput,
    handler: (input) => usas.searchSubawards(input),
  }),
  defineTool({
    name: "usas_search_recompetes",
    description:
      "Recompete radar — federal contracts whose CURRENT period of performance ends inside a window around today (default -90d .. +18mo), sorted soonest-first. Use for 'what VA 541512 contracts are up for recompete in the next 18 months'. Reads the current PoP end date directly from spending_by_award (no per-award enrichment), counts (never drops) rows with missing end dates, and flags in _meta when the scan budget truncates the window (totalAvailable becomes null). Filter by agency/naics/pscCodes/setAside/minAwardValue; set includePotentialEnd for option-inclusive end dates. Public signals only — no CPARS/protest/option-intent, no composite vulnerability score.",
    inputSchema: UsasRecompetesInput,
    handler: (input) => usas.searchRecompetes(input),
  }),
  defineTool({
    name: "usas_search_expiring_contracts",
    description:
      "DEPRECATED — use usas_search_recompetes. Thin backward-compatible alias: finds contracts at agency × NAICS expiring within N months and returns the legacy { contracts, searchedCount } shape. New callers should use usas_search_recompetes for the full window/pagination controls and truthful completeness metadata.",
    inputSchema: UsasExpiringInput,
    handler: (input) => usas.searchExpiringContracts(input),
  }),
  defineTool({
    name: "usas_get_award_detail",
    description:
      "Fetch full detail for a single award by generatedInternalId (from usas_search_individual_awards). Returns period_of_performance (start/end/potential_end), base_and_all_options, set-aside type, competition extent, number_of_offers — the per-award fields the search endpoint omits.",
    inputSchema: UsasAwardDetailInput,
    handler: (input) => usas.getAwardDetail(input.generatedInternalId),
  }),
  defineTool({
    name: "usas_analyze_incumbent",
    description:
      "Per-award incumbent + PUBLIC recompete-pressure analysis for ONE award (generatedInternalId). Assembles the incumbent identity, the vehicle/IDV linkage, and individual PUBLIC pressure SIGNALS — obligated-vs-ceiling consumption (pctConsumed), modification count (lower-bounded), competition extent + number of offers, set-aside, days to the current PoP end, and option-extendable days — plus, optionally, the incumbent's other awards in the same agency×NAICS. Bounded & keyless: at most 3 upstream calls (detail + 1 transactions page + 1 recipient search), no per-record fan-out. Emits pressureHints ('single_offer', 'ceiling_nearly_exhausted', 'hard_stop_no_options') as HINTS, NEVER a composite vulnerability score — CPARS/past-performance, protest history, and option-exercise intent are not public (declared in _meta.fieldsUnavailable).",
    inputSchema: UsasAnalyzeIncumbentInput,
    handler: (input) => usas.analyzeIncumbent(input),
  }),

  // ━━━ USAspending — Aggregate Analysis (6) ━━━
  defineTool({
    name: "usas_spending_over_time",
    description:
      "Time-series aggregation of federal CONTRACT spending (award types A/B/C/D — grants, IDVs, loans, and other obligation types are EXCLUDED, matching the other usas_search_*_spending tools; disclosed in _meta). Group by fiscal_year / quarter / month, filter by agency / NAICS / set-aside. Use for 'how has VA 541512 contract spending trended over the past 5 years' — returns yearly/quarterly/monthly $ rollups of contract obligations (grantObligations/idvObligations are null, NOT 0, to avoid implying an agency has no grant/IDV spending).",
    inputSchema: UsasSpendingOverTimeInput,
    handler: (input) => usas.spendingOverTime(input),
  }),
  defineTool({
    name: "usas_search_psc_spending",
    description:
      "Spending broken down by Product Service Code (PSC). Use for 'what PSC categories see the most $ at DoD' — surfaces market structure beyond NAICS (e.g. PSC R425 = engineering support services).",
    inputSchema: UsasCategorySpendingInput,
    handler: (input) => usas.searchPscSpending(input),
  }),
  defineTool({
    name: "usas_search_state_spending",
    description:
      "Spending broken down by state / territory. Use for 'where is the most federal $ flowing for NAICS 541512' — answers like 'VA $128B, MD $66B, DC $58B'.",
    inputSchema: UsasCategorySpendingInput,
    handler: (input) => usas.searchStateSpending(input),
  }),
  defineTool({
    name: "usas_search_cfda_spending",
    description:
      "Spending broken down by CFDA grant program code. Use for grant analysis — 'top federal grant programs by $'. Note: CFDA is grants (award_type 02-05), not contracts. Use usas_search_psc_spending for contract market analysis.",
    inputSchema: UsasCfdaInput,
    handler: (input) => usas.searchCfdaSpending(input),
  }),
  defineTool({
    name: "usas_search_federal_account_spending",
    description:
      "Spending broken down by federal account / Treasury Account Symbol (TAS). Use to map money to the actual budget line item (e.g. '036-0167 = Information Technology Systems, VA').",
    inputSchema: UsasCategorySpendingInput,
    handler: (input) => usas.searchFederalAccountSpending(input),
  }),
  defineTool({
    name: "usas_search_agency_spending",
    description:
      "Spending broken down by awarding agency. Use for 'which agencies spend the most on NAICS 541512' — top buyers by $.",
    inputSchema: UsasAgencySpendingInput,
    handler: (input) => usas.searchAgencySpending(input),
  }),

  // ━━━ USAspending — Agency Profile (3) ━━━
  defineTool({
    name: "usas_get_agency_profile",
    description:
      "Get full agency profile by toptier code (3-4 digits, from usas_lookup_agency). Returns mission, abbreviation, website, subtier_agency_count, congressional_justification_url.",
    inputSchema: UsasAgencyProfileInput,
    handler: (input) => usas.getAgencyProfile(input.toptierCode),
  }),
  defineTool({
    name: "usas_get_agency_awards_summary",
    description:
      "High-level award activity for a fiscal year — transaction_count + obligations + latest_action_date. SCOPE: obligations/transaction_count span ALL award types (contracts, grants, direct payments incl. benefits, loans) — NOT prime contracts only. For benefit-heavy agencies (VA/SSA/HHS) this is dominated by direct benefit payments (e.g. VA FY2024 ~$238B all-awards vs ~$67B prime contracts), so do NOT read it as the contract/procurement market; for procurement-heavy agencies (DoD/DHS) it closely tracks contract spending. For contracts-only obligations use usas_spending_over_time (contractObligations) — it takes the agency canonical NAME, so resolve it from this toptierCode via usas_get_agency_profile first.",
    inputSchema: UsasAgencyAwardsInput,
    handler: (input) => usas.getAgencyAwardsSummary(input),
  }),
  defineTool({
    name: "usas_get_agency_budget_function",
    description:
      "Budget function breakdown for an agency × fiscal year. Returns the agency's spending by program area (e.g. VA: 'Income security for veterans' $204B, 'Hospital and medical care for veterans' $126B).",
    inputSchema: UsasAgencyBudgetInput,
    handler: (input) => usas.getAgencyBudgetFunction(input),
  }),

  // ━━━ USAspending — Recipient Profile (2) ━━━
  defineTool({
    name: "usas_search_recipients",
    description:
      "Search USAspending recipient list with parent/child/recipient hierarchy. Returns recipients with id, duns, uei, level (P=parent, C=child, R=recipient), total_amount. Use for 'find the recipient_id for Booz Allen' before usas_get_recipient_profile.",
    inputSchema: UsasSearchRecipientsInput,
    handler: (input) => usas.searchRecipients(input),
  }),
  defineTool({
    name: "usas_get_recipient_profile",
    description:
      "Full recipient detail by recipient_id (from usas_search_recipients). Returns alternate_names (M&A history), DUNS, UEI, parent linkage, business_types, location, total_amount, total_transactions.",
    inputSchema: UsasGetRecipientInput,
    handler: (input) => usas.getRecipientProfile(input.recipientId),
  }),

  // ━━━ USAspending — Reference / Autocomplete (5) ━━━
  defineTool({
    name: "usas_autocomplete_naics",
    description:
      "Autocomplete NAICS codes by free-text. ANTI-HALLUCINATION GUARD — call this when the user mentions a NAICS theme but no specific code (e.g. 'computer systems design' → 541512). Avoids inventing NAICS codes.",
    inputSchema: UsasAutocompleteInput,
    handler: (input) => usas.autocompleteNaics(input),
  }),
  defineTool({
    name: "usas_autocomplete_recipient",
    description:
      "Autocomplete recipient names. ANTI-HALLUCINATION — confirm a recipient's exact USAspending-canonical legal name before searching by name. Returns up to 10 fuzzy matches with UEI/DUNS where available.",
    inputSchema: UsasAutocompleteInput,
    handler: (input) => usas.autocompleteRecipient(input),
  }),
  defineTool({
    name: "usas_naics_hierarchy",
    description:
      "Navigate the NAICS hierarchy (2→4→6 digit) + active-contract count per code. No naicsFilter ⇒ the top-level 2-digit sectors. With naicsFilter=<code> ⇒ that node is in `parent` and its DIRECT children are in `hierarchy` (drill into any row where hasChildren:true by re-calling with its code). A 6-digit leaf returns hierarchy:[] with the node in `parent` (found:true); a nonexistent code returns hierarchy:[] with parent:null (found:false). Use to explore market scope (e.g. what's under NAICS 54 = Professional, Scientific, and Technical Services).",
    inputSchema: UsasNaicsHierarchyInput,
    handler: (input) => usas.naicsHierarchy(input),
  }),
  defineTool({
    name: "usas_glossary",
    description:
      "USAspending glossary of 151 federal-spending terms. Use to confirm terminology ('what's a TAS?', 'what's an obligation vs outlay?') before answering compliance/budget questions.",
    inputSchema: UsasGlossaryInput,
    handler: (input) => usas.glossary(input),
  }),
  defineTool({
    name: "usas_list_toptier_agencies",
    description:
      "List all toptier federal agencies with toptier_code, abbreviation, slug, current-FY obligations. Use for 'show me every cabinet department + their FY26 spending' or to find a toptier_code for usas_get_agency_*.",
    inputSchema: UsasListAgenciesInput,
    handler: (input) => usas.listToptierAgencies(input),
  }),

  // ━━━ Federal Register (4) ━━━
  defineTool({
    name: "fed_register_search_documents",
    description:
      "Search Federal Register documents (proposed rules, final rules, notices, presidential documents) by query / agency / type / date range. Use for regulatory-context queries ('what new VA cybersecurity rules came out this quarter?').",
    inputSchema: FedRegSearchInput,
    handler: (input) => fedreg.searchDocuments(input),
  }),
  defineTool({
    name: "fed_register_get_document",
    description:
      "Fetch full detail for a Federal Register document by number. Returns title, abstract, citation, publication_date, effective_on, raw_text_url (for the full body), CFR references — everything needed to ground a regulation citation.",
    inputSchema: FedRegGetDocInput,
    handler: (input) => fedreg.getDocument(input.documentNumber),
  }),
  defineTool({
    name: "fed_register_list_agencies",
    description:
      "List all Federal Register agencies with slugs (needed for fed_register_search_documents). Use to resolve 'what's the FedReg slug for Veterans Affairs?'",
    inputSchema: FedRegListAgenciesInput,
    handler: (input) => fedreg.listAgencies(input),
  }),
  defineTool({
    name: "fed_register_public_inspection",
    description:
      "Federal Register PUBLIC INSPECTION desk — documents FILED with the Office of the Federal Register but NOT YET published (a pre-publication LEADING INDICATOR, ~1-to-several days ahead of the official publication_date). mode: 'current' (all on inspection now), 'date' (a specific available_on day), 'search' (full-text over the on-inspection set). Returns per-doc leadDays (pre-publication head-start), filing_type special-vs-regular, and unflattened agencies. NOTE: a public-inspection doc is NOT the authoritative published rule (no FR citation/page yet; may change or be withdrawn) — after publication_date cross-check fed_register_get_document.",
    inputSchema: FedRegPublicInspectionInput,
    handler: (input) => fedreg.publicInspection(input),
  }),

  // ━━━ eCFR (5) ━━━
  defineTool({
    name: "ecfr_search",
    description:
      "Full-text search across the entire CFR (Code of Federal Regulations). Use for compliance questions — pass titleNumber=48 for FAR (Federal Acquisition Regulation), titleNumber=2 for federal financial assistance, etc. Returns excerpt + section path + ecfrUrl.",
    inputSchema: EcfrSearchInput,
    handler: (input) => ecfr.search(input),
  }),
  defineTool({
    name: "ecfr_list_titles",
    description:
      "List all 50 CFR titles with name + last_amended_on date. Use to discover what's in each title (Title 48 = FAR, Title 32 = National Defense, Title 14 = Aeronautics, etc.).",
    inputSchema: EcfrListTitlesInput,
    handler: () => ecfr.listTitles(),
  }),
  defineTool({
    name: "far_clause_lookup",
    description:
      "Authoritative FAR/DFARS clause text + its PRESCRIPTION (the 'As prescribed in …' rule for when the clause applies), from the eCFR versioner-full endpoint (Title 48). Use this — NOT ecfr_search — for an EXACT clause number: full-text search mis-ranks '52.212-4' (returns GSAM 552.212-4 above the real FAR clause). Returns heading, revision date, clause/provision kind, regulation (FAR/DFARS/GSAM), full text, the prescribing section, and ecfrUrl. Every response carries farOverhaulRisk — a structural currency caveat that eCFR reflects only the CODIFIED FAR, so a clause may be superseded by a Revolutionary-FAR-Overhaul agency class deviation not shown here. A genuinely-absent clause returns a not_found error (never a fake empty clause). Keyless.",
    inputSchema: FarClauseLookupInput,
    handler: (input) => far.farClauseLookup(input),
  }),
  defineTool({
    name: "far_compliance_matrix",
    description:
      "Turn a solicitation's cited FAR/DFARS clause list into a proposal-ready compliance matrix (for a Section L/M response). COMPOSES far_clause_lookup over 1–25 clauses (deduped case-insensitively): each resolved row carries the clause text + prescription + regulation + a gate flag marking pass/fail award-eligibility GATES (Section 889 52.204-24/25/26, limitations on subcontracting 52.219-14, DFARS cyber 252.204-7012/7020/7021 incl. CMMC) + the farOverhaulRisk currency caveat. TRUTHFUL by construction: a clause that genuinely isn't in Title 48 (HTTP 404) goes to `unresolved`, while a clause that couldn't be fetched (eCFR down/5xx/rate-limited) goes to a SEPARATE `errored` bucket — a DOWN service is never reported as 'clause doesn't exist'; `summary.total` proves no clause is dropped. Does NOT parse the PDF solicitation to extract the clause list, and gives NO legal advice or compliance verdict. Keyless.",
    inputSchema: FarComplianceMatrixInput,
    handler: (input) => far.farComplianceMatrix(input),
  }),
  defineTool({
    name: "far_search",
    description:
      "FAR/DFARS-scoped semantic search — the 'which clauses touch topic X' front-door that feeds far_clause_lookup. COMPOSES ecfr_search but fixes its two compliance flaws: (1) it filters to FAR (Title 48 chapter 1) or DFARS (chapter 2), EXCLUDING GSAM/agency supplements (so 'limitations on subcontracting' no longer mis-ranks GSAM 552.x over FAR 52.x), and (2) it collapses eCFR's ~5-versions-per-section HISTORICAL duplicates to the CURRENT in-force version (endsOn==null). scope: far (default) | dfars | both. dedupeVersions (default true; false shows all historical rows). partsOnly restricts to given parts (e.g. [52] clause text). Returns distinct sections with regulation/section/headingPath/excerpt/score/ecfrUrl/effectiveOn/endsOn/isCurrent, distinctSections, and the farOverhaulRisk caveat. TRUTHFUL: dedupe never drops a distinct section (the raw→distinct collapse is disclosed); a kept-historical row is marked isCurrent:false; a search-endpoint outage THROWS (never a fake 0 results); totalAvailable is null (a deduped view has no clean upstream count). Keyless.",
    inputSchema: FarSearchInput,
    handler: (input) => far.farSearch(input),
  }),

  // ━━━ SBA — Size Standards (1) ━━━
  defineTool({
    name: "sba_size_standard",
    description:
      "SBA small-business size standard for a 6-digit NAICS (keyless sba.gov naics.json). Answers 'is a firm SMALL for this NAICS?' — the gate for set-aside eligibility and for vetting a usas_search_teaming_partners candidate. Returns standardType (receipts | employees | assets [financial institutions] | receipts+assets), a normalized threshold (receipts/assets in DOLLARS — the dataset's $millions figure ×1,000,000; employees as a count), the unit, and any SBA footnote. HONESTY: the dataset carries no effective-date field, so the value is 'as published as of retrieval' (asOf) and _meta.notes flags that SBA adjusts standards periodically — re-verify at sba.gov for high-stakes eligibility. An unknown NAICS returns found:false (never a fabricated standard).",
    inputSchema: SbaSizeStandardInput,
    handler: (input) => sba.sizeStandard(input),
  }),

  // ━━━ Grants.gov (2) ━━━
  defineTool({
    name: "grants_search",
    description:
      "Search Grants.gov federal grant opportunities (financial assistance, distinct from contracts on SAM.gov). Filter by keyword / CFDA / agency / opportunity number. Default status = forecasted + posted. KEYWORD: Grants.gov OR-matches multi-word keywords (returns grants containing ANY word), so a multi-word keyword BROADENS results — pass ONE specific term for relevance (phrase quoting returns 0); narrow with cfda/agency/oppStatuses.",
    inputSchema: GrantsSearchInput,
    handler: (input) => grants.searchGrants(input),
  }),
  defineTool({
    name: "grants_get_opportunity",
    description:
      "Fetch full detail for a single grant opportunity by id. Returns found:true with description, agency, posting/response/archive dates, award_ceiling, award_floor, estimated_funding, expected_number_of_awards, applicant_types, funding_instruments, CFDA programs. `agency` is { code, name (the REAL posting/sub-tier agency, e.g. 'Food and Nutrition Service'), department (the top-tier agency, e.g. 'Department of Agriculture'), contactName (the program officer — NOT the agency) } — Grants.gov's raw `agencyName` field is actually the contact person, so this tool sources the real agency from agencyDetails; `name` may be null if the record carries no structured agency. A NONEXISTENT id returns { found:false, opportunityId } — never a fabricated grant with empty fields (Grants.gov answers a bad id with a hollow 200, which this tool detects). Check `found` before reading the other fields.",
    inputSchema: GrantsGetInput,
    handler: (input) => grants.getGrant(input),
  }),

  // ━━━ Pricing / Wage (3) ━━━
  defineTool({
    name: "sam_search_wage_determinations",
    description:
      "Find the Service Contract Act (SCA) or Davis-Bacon (DBA) wage determination(s) governing a locality (keyless SAM SGS). Filter by coverage (sca|dba), state (2-letter, server-side), county (client-side), or WD number/title. Returns the structured WD list; follow with sam_get_wage_rates to read the rate table. NOTE: `query` matches WD number/title only, NOT occupation.",
    inputSchema: WageSearchInput,
    handler: (input) => pricing.searchWageDeterminations(input),
  }),
  defineTool({
    name: "sam_get_wage_rates",
    description:
      "Return the prevailing-wage + fringe/H&W rate table for a specific wage determination, PARSED from its plain-text document (SAM exposes no structured rate JSON), plus the Executive-Order minimum-wage floor. Distinguishes SCA (WD-wide Health & Welfare) vs DBA (per-craft fringe). Always returns parseConfidence and supports format:'parsed'|'raw'|'both' so you can read the raw text when parsing is low-confidence. Resolves the latest active revision via /history when `revision` is omitted.",
    inputSchema: WageRatesInput,
    handler: (input) => pricing.getWageRates(input),
  }),
  defineTool({
    name: "gsa_benchmark_labor_rates",
    description:
      "GSA CALC awarded ceiling-rate market band for a labor category (keyless). Returns a DISTRIBUTION (currentRate min/median/max + escalated medians) over a fetched sample, NOT a single price. CALC rates are CEILING/catalog and FULLY BURDENED (do not re-add wrap); the match count SATURATES at 10000 for broad queries (totalAvailable null then). Filter by businessSize/educationLevel(code)/experience/sin to narrow.",
    inputSchema: BenchmarkLaborInput,
    handler: (input) => pricing.benchmarkLaborRates(input),
  }),

  // ━━━ Integrity / Teaming (3) ━━━
  defineTool({
    name: "sam_check_exclusions",
    description:
      "Keyless SAM debarment/exclusion screening. Screen a firm or individual by name (query) and/or UEI/CAGE against the SAM exclusions index (FAPIIS). Returns excluded (true iff ≥1 ACTIVE matching record), matchCount, and per-record { name, classification, uei, cage, excludingAgency, exclusionType, exclusionProgram, isActive, activation/terminationDate, samFapiisUrl }. CRITICAL: an EMPTY result means 'no matching exclusion under these terms' — it is NOT proof of general responsibility (stated in _meta.notes). A name match is not identity-proof; verify the UEI/CAGE + dates against the FAPIIS record. Requires at least one of query/uei/cage.",
    inputSchema: CheckExclusionsInput,
    handler: (input) => integrity.checkExclusions(input),
  }),
  defineTool({
    name: "sam_integrity_lookup",
    description:
      "Keyless ONE-CALL integrity screen — 'any integrity red flags on this entity?'. Composes the keyless government-wide EXCLUSION verdict (via sam_check_exclusions) with an honest pointer to the FAPIIS / Responsibility-Qualification record. Requires at least one of uei/cage/name (uei preferred; name maps to the exclusions text search). Returns { entity, exclusions:{excluded,activeCount,records}, fapiisRecords, fapiisUrl, integrityFlag }. integrityFlag is 'excluded' when ≥1 ACTIVE matching exclusion is found, else 'review_fapiis' — it NEVER returns 'clear' keylessly, because FAPIIS records (terminations for default/cause, non-responsibility determinations, self-reported criminal/civil/administrative proceedings) have NO keyless machine API, so absence of an exclusion is NOT proof of integrity. fapiisRecords is ALWAYS null (never faked; record-level retrieval needs an optional SAM Entity key) with _meta.fieldsUnavailable:['fapiisRecords']; fapiisUrl deep-links the viewable SAM page. An upstream exclusions failure surfaces as the classified error, never a fake clearance.",
    inputSchema: IntegrityLookupInput,
    handler: (input) => integrity.integrityLookup(input),
  }),
  defineTool({
    name: "usas_search_teaming_partners",
    description:
      "Small-business teaming-partner discovery by socioeconomic certification + NAICS + agency award history (keyless USAspending proxy), integrity-screened. Given a cert (enum-validated), optional naics/agency/subagency, and a lookback window, aggregates federal awardees by recipient and returns candidates ranked by agencyObligated with agencyAwardCount, mostRecentAwardDate, and sampleAwards; optionally screens the top candidates via sam_check_exclusions and drops active exclusions (excludeDebarred, default true). HONESTY: cert is AWARD-DERIVED (recorded on the firm's federal awards), NOT the SBA certification of record (which needs a keyed SAM Entity call) — verify active certification in SAM/SBS before teaming (stated in _meta). A bogus cert is rejected as invalid_input (the endpoint would silently return 0).",
    inputSchema: TeamingPartnersInput,
    handler: (input) => integrity.searchTeamingPartners(input),
  }),
  // ━━━ OFAC — Denied-Party Sanctions Screening (1) ━━━ ADR-0034
  defineTool({
    name: "ofac_screen_entity",
    description:
      "Keyless OFAC denied-party sanctions screening — the legally-required leg that SAM exclusions does NOT cover (31 CFR ch. V, strict-liability). Screens a `name` against OFAC's published SDN + Consolidated bulk lists (primary names AND AKAs from ALT.CSV joined by ent_num AND a.k.a./f.k.a./n.k.a. aliases mined from SDN/CONS Remarks — so an alias-only party like 'BNC' for BANCO NACIONAL DE CUBA is caught). Optional post-filters: type (individual|entity|vessel|aircraft), program (e.g. CUBA/IRAN/SDGT), list (sdn|consolidated|all, default all), minMatchQuality (exact|strong|weak, default weak), limit. Returns result ('potential_matches' | 'no_name_match' — NEVER 'clear'), matchCount, and per-match { name, matchedVia (primary|aka(alt)|aka(remarks)), akaType, matchQuality, list, programs, type, entNum, ofacSearchUrl }. ★SAFETY: this is a NAME SCREEN, NOT a legal determination — a no_name_match is NOT a clearance (transliterations/variants can miss a real hit) and a weak/strong hit is a REVIEW CANDIDATE requiring human adjudication against OFAC's Sanctions List Search. Every fetch failure / SSRF reject / parse drift / floor-fail THROWS (a download failure is NEVER read as a clear). minMatchQuality/type/program only trim returned matches — result reflects existence at any quality. Snapshot freshness (publish date + cache age) rides in _meta.",
    inputSchema: OfacScreenInput,
    handler: (input) => ofac.screenEntity(input),
  }),
  // ━━━ NVD + CISA KEV — the IT/CYBER-COMPLIANCE lane (2) ━━━ ADR-0035
  // Opens the FedRAMP/CMMC/SBOM IT-compliance lane the server lacked: NIST NVD
  // CVE/CVSS severity JOINED with the CISA KEV mandatory-remediation catalog.
  // Keyless (an OPTIONAL free NVD_API_KEY lifts the rate; header-only, never
  // logged). Never-fake: a genuine totalResults:0/found:false is honest, but any
  // 403/429/404/5xx/timeout/redirect-off-host THROWS; a KEV outage degrades
  // kev.listed to null (never false), and a kevOnly filter during an outage THROWS.
  defineTool({
    name: "cve_lookup",
    description:
      "Look up NIST NVD CVE records (keyless; services.nvd.nist.gov CVE API 2.0) — exact by `cveId` (CVE-YYYY-NNNN) OR search by `keyword`/`cpeName`/`cvssV3Severity`/a publication or last-modified date range — each row JOINED with its CISA KEV (Known Exploited Vulnerabilities) status. THE B2G unlock for FedRAMP/CMMC/SBOM IT-compliance: CVSS severity AND whether CISA mandates remediation by a date, in one row. Returns { results:[{ cveId, vulnStatus, rejected, published, lastModified, description, cvssMetrics:[{version,source,type,baseScore,baseSeverity,vectorString,exploitabilityScore,impactScore}], primaryCvss:{version,baseScore,baseSeverity,type}|null, cwes, references, kev }] } + honest _meta. Optional `kevOnly` (KEV-listed rows only), `resultsPerPage` (≤2000, def 50), `startIndex`. CVSS HONESTY: every metrics key matching ^cvssMetric (V2/V30/V31/V40) is surfaced as its own cvssMetrics[] element — versions are NEVER conflated and ssvcV203/non-CVSS keys are excluded; V2 baseSeverity reads from the metric level; primaryCvss is the highest-version metric, preferring type:'Primary' but FALLING BACK to the highest Secondary (a real CNA score is never dropped), null ONLY when no CVSS exists (Rejected/Awaiting) — base scores are null-never-0. KEV HONESTY: kev is {listed:true,dateAdded,dueDate,ransomware,requiredAction,catalogVersion} | {listed:false,note} | {listed:null,status:'unavailable'}; a not-listed result carries the not-in-KEV≠safe caveat (absence is NOT a clearance); if the KEV catalog cannot load, kev.listed degrades to NULL (never false) with fieldsUnavailable:['kev'], and a kevOnly filter during that outage THROWS (a KEV-membership filter is unanswerable without the catalog). PAGINATION is from NVD's EXACT totalResults, never page length. A genuine totalResults:0 is an honest found:false; a 403/429 rate breach THROWS rate_limited with the NVD_API_KEY tier disclosure; 404/5xx/timeout/off-host-redirect THROW (never a fake-empty). An OPTIONAL free NVD_API_KEY (env; https://nvd.nist.gov/developers/request-an-api-key) lifts the rate and is sent ONLY in the apiKey header — never a URL/label/_meta/log.",
    inputSchema: CveLookupInput,
    handler: (input) => nvd.cveLookup(input),
  }),
  defineTool({
    name: "cisa_kev_lookup",
    description:
      "Filter the CISA Known Exploited Vulnerabilities (KEV) catalog standalone (keyless; www.cisa.gov feed, cached) — the mandatory-remediation list carrying BINDING due-dates under BOD 22-01 / its 2026 successor BOD 26-04. Works even when NVD is rate-limited (a separate host, no key). Filters (all optional, AND-combined, client-side): `cveId` (exact KEV membership check), `vendorProject`/`product` (case-insensitive substring), `ransomwareOnly` (knownRansomwareCampaignUse === 'Known'), `addedSince`/`dueBefore` (ISO YYYY-MM-DD); `limit` (≤1000, def 100), `offset`. Returns { catalogVersion, dateReleased, count, found?, matches:[{ cveID, vendorProject, product, vulnerabilityName, dateAdded, dueDate, knownRansomwareCampaignUse, shortDescription, requiredAction, cwes, nvdUrl }] } + honest _meta. ★HONESTY: knownRansomwareCampaignUse and requiredAction are surfaced VERBATIM (never defaulted); dueDate is the CISA-mandated remediation deadline. A cveId NOT in the catalog ⇒ found:false — but the not-in-KEV≠safe caveat rides on EVERY response: KEV is a CURATED SUBSET of confirmed in-the-wild exploitation, so absence means CISA has not catalogued it, NOT that the component is unexploited/safe. A catalog download failure / floor-fail / count-drift THROWS (a truncated/near-empty catalog must never read as 'nothing is exploited') — never a fake-empty. The snapshot freshness (catalogVersion + release date + cache age) is disclosed.",
    inputSchema: CisaKevLookupInput,
    handler: (input) => nvd.cisaKevLookup(input),
  }),
  // ━━━ NPPES NPI Registry — Healthcare-Provider Vetting (1) ━━━ ADR-0036
  defineTool({
    name: "nppes_lookup_provider",
    description:
      "Keyless CMS/HHS NPPES NPI Registry lookup — the authoritative PUBLIC registry of every US healthcare provider (individual NPI-1 + organization NPI-2), for VA/HHS/CMS subcontractor/provider/teaming due-diligence (validate an NPI, confirm taxonomy/specialty, enumeration status, practice state, org/name match). Host npiregistry.cms.hhs.gov/api (version=2.1). Mode is inferred from `number` (no mode flag). EXACT-NPI mode (`number` given): the NPI is CMS-Luhn-validated client-side (Luhn over 80840+first-9) ⇒ a typo'd NPI is invalid_input, NEVER a fake 'does not exist'; ★the wire query carries `number` (+version) ALONE — any co-supplied filter (last_name/state/…) is DROPPED from the wire and checked CLIENT-SIDE (disclosed in data.filterMatch:{field:bool} + data.filtersDropped), because NPPES AND-combines a number with filters and a mismatch would falsely zero a real active provider into found:false. SEARCH mode: required-one of { first_name, last_name, organization_name, taxonomy_description, city, postal_code } (state + enumeration_type are REFINERS ONLY — rejected alone); a trailing '*' wildcard on a name/org field needs ≥2 leading literal chars. Returns EXACT-mode { found, provider:{ number, enumerationType, active, status, basic{…individual OR org fields, null-never-fabricated…}, taxonomies[{code,desc,primary,state,license,taxonomyGroup}], addresses[{purpose,address1,city,state,postalCode,telephone,fax,countryCode}], practiceLocations[…same, SEPARATE from addresses], identifiers[], otherNames[], endpoints[], createdEpoch, lastUpdatedEpoch }, filterMatch? } OR SEARCH-mode { providers:[…] } + honest _meta. HONESTY: active = basic.status==='A' (a deactivated/absent NPI is NOT active); epochs are ms numeric STRINGS → number|null (null-never-0); addresses[] and practiceLocations[] are kept SEPARATE (a provider can practice in a state that appears ONLY in practiceLocations); NPPES exposes NO match total, so a full page ⇒ totalAvailable is a disclosed LOWER BOUND (totalIsLowerBound) + a ~1,200-row-per-query reach cap (limit ≤ 200, skip ≤ 1,000 — OUR policy, a PER-QUERY cap only; cross-query enumeration is not architecturally prevented). A genuine {result_count:0} ⇒ honest found:false/empty; a {Errors:[…]} 200 body (no results key) ⇒ THROWS invalid_input (never a fake empty); any 4xx/5xx/timeout/off-host-redirect ⇒ THROWS; result_count !== results.length ⇒ schema_drift. ★NOT a fitness/exclusion/licensure/sanctions determination — cross-check SAM exclusions + OFAC; individual (NPI-1) records may surface personal/home addresses + phone/fax verbatim with NO enrichment. The caveat + reach-cap disclosure ride EVERY response.",
    inputSchema: NppesLookupInput,
    handler: (input) => nppes.lookupProvider(input),
  }),
  // ━━━ CMS Open Payments — Healthcare Spend/Transparency (DKAN, keyless) (2) ━━━ ADR-0037
  defineTool({
    name: "cms_search_datasets",
    description:
      "Discover CMS Open Payments datasets on the keyless DKAN DCAT metastore (openpaymentsdata.cms.gov) — the Physician Payments Sunshine Act transparency catalog (industry→physician/teaching-hospital payments, other transfers of value, ownership interests). Returns { query, results:[{ datasetId, title, description, distributions:[{index, distId, title, mediaType, downloadURL}], keyword, modified }] } + honest _meta. Feed a result's datasetId + a distribution index to cms_query_dataset (use results:false there to enumerate the column schema before pulling rows). Optional `q` (case-insensitive title/description substring), `limit` (≤100, def 20), `offset`. ★HONESTY: the DKAN metastore IGNORES limit/offset/page and returns the ENTIRE catalog in one response, so q/limit/offset are applied CLIENT-SIDE against the in-memory array and totalAvailable is the EXACT post-q catalog size (never fabricated, never null) — hasMore is computed against the KNOWN catalog length (no false-more, no dead-end offset). The flagship targets are '2025 Research Payment Data', the General-Payment, and Ownership datasets. A non-array metastore body / HTML / 5xx / timeout THROWS (never a fake empty). NOT a determination — see cms_query_dataset's caveat.",
    inputSchema: CmsSearchDatasetsInput,
    handler: (input) => cms.searchDatasets(input),
  }),
  defineTool({
    name: "cms_query_dataset",
    description:
      "Query a CMS Open Payments DKAN datastore distribution by datasetId + index (keyless; openpaymentsdata.cms.gov) — the healthcare industry-financial-relationship / COI-vetting + market-intelligence lane NPPES (provider identity) cannot answer. GET /api/1/datastore/query/{datasetId}/{index} with server-side `conditions` filters, an EXACT `count`, offset/limit pagination, and a `properties` projection. Returns { datasetId, index, results (mode), fields:[{name,type,mysqlType,description}] (from the DKAN schema), rows:[…verbatim…] } + honest _meta. A confirmed target: 2025 Research Payment Data 'f0d1de67-6852-4093-a036-c9328c256a05' index 0 (count 931959; + a recipient_state='CA' condition → 92097). ★HONESTY: `count` is the EXACT grand total (P1) → totalAvailable=count + real offset pagination (NOT a page-length lower bound); `conditions` are server-side and self-policing — a valid column narrows the count, a BAD column ⇒ HTTP 400 ⇒ invalid_input, so filtersDropped is ALWAYS empty (no silent-drop path, P4); limit ≤ 500 is the HARD API cap (a higher limit ⇒ invalid_input, no silent clamp); every column is text, so amounts (total_amount_of_payment_usdollars, …) arrive as STRINGS surfaced verbatim (a missing amount is null-never-0, P3). ★results:false = a COUNT/SCHEMA-discovery mode: no rows, pagination disabled (no livelock), but the EXACT count + every column's schema returned (count=true is ALWAYS on the wire — not a caller toggle). A genuine {count:0} ⇒ honest empty; a 400 (bad column/limit) / 404 (bad datasetId/index) / HTML (SPA/WAF) / 5xx / timeout / a missing schema anchor or non-array results (in results:true) ⇒ THROW (never a fake empty). ★SSRF: datasetId (36-char lowercase UUID) + index interpolate into the URL PATH (validated before interpolation). ★PII: Open Payments is PUBLIC transparency-BY-LAW data (in-scope per the NPPES precedent) naming physicians + amounts verbatim — bounded to targeted vetting (offset ≤ 2000 reach cap), NO enrichment, NO covered_recipient_npi→NPPES auto-join. NOT a conflict-of-interest finding / fitness / exclusion determination — cross-check SAM exclusions + OFAC + the OIG-LEIE. The caveat + reach-cap disclosure ride EVERY response.",
    inputSchema: CmsQueryDatasetInput,
    handler: (input) => cms.queryDataset(input),
  }),
  // ━━━ FAC Federal Audit Clearinghouse — Single Audit audit-risk vetting (2) ━━━ ADR-0038
  defineTool({
    name: "fac_search_audits",
    description:
      "Search entity Single Audit summaries from the Federal Audit Clearinghouse (keyless via the api.data.gov DEMO_KEY; api.fac.gov PostgREST `general` table) — the SUBCONTRACTOR / teaming AUDIT-RISK vetting entry point (2 CFR 200 Subpart F / Single Audit Act; every entity expending ≥$750K/yr in federal awards). Structured filters (all optional, AND-combined): `auditeeUei` (12-char SAM UEI — the PRIMARY join key to SAM/USAspending/EDGAR, → auditee_uei), `auditeeState` (2-letter → auditee_state), `auditYear` (int → audit_year), `totalExpendedMin`/`totalExpendedMax` (USD → total_amount_expended gte/lte). `limit` (≤100, def 25), `offset`. Returns { audits:[{ report_id, auditee_uei, audit_year, auditee_name, auditee_ein, auditee_state, auditee_city, total_amount_expended, fac_accepted_date }] } + honest _meta. Feed a row's report_id (or the UEI) to fac_get_findings for the audit-RISK flags. ★PII: a HARDCODED select-allowlist surfaces ONLY entity + audit-summary fields and DELIBERATELY EXCLUDES the auditee's personal-contact columns (email/phone/certifying-official name) — the vetting subject is the ENTITY; there is NO caller `select`/column param. HONESTY: totalAvailable is the EXACT Content-Range total (a response header under Prefer:count=exact; a '*'/absent/non-numeric denominator ⇒ totalAvailable:null + a page-fullness hedge, NEVER 0); total_amount_expended is null-never-0 (a missing amount is null, never 0); a bad column ⇒ PostgREST 400 ⇒ invalid_input (filtersDropped is ALWAYS empty); a genuine [] ⇒ honest empty; 400/403/5xx/timeout/HTML/non-array THROW (206 = success, never a fake empty). NOT a debarment/exclusion/fitness determination — an audit finding is the auditor's opinion; cross-check SAM exclusions + OFAC. Keyless-first via DEMO_KEY (~10 req/hr shared ceiling; set DATA_GOV_API_KEY for production — never logged).",
    inputSchema: FacSearchAuditsInput,
    handler: (input) => fac.searchAudits(input),
  }),
  defineTool({
    name: "fac_get_findings",
    description:
      "Drill into the audit-RISK findings for an entity from the Federal Audit Clearinghouse (keyless via the api.data.gov DEMO_KEY; api.fac.gov PostgREST `findings` table) — the risk-detail step after fac_search_audits. At least ONE of `auditeeUei` (12-char UEI → auditee_uei) or `reportId` (→ report_id, from a fac_search_audits row) is REQUIRED (an empty query is refused, never a whole-table scan); optional `auditYear` (int), `limit` (≤100, def 50), `offset`. Returns { findings:[{ report_id, auditee_uei, audit_year, award_reference, reference_number, is_material_weakness, is_modified_opinion, is_questioned_costs, is_repeat_finding, is_significant_deficiency, is_other_findings, is_other_matters, type_requirement, prior_finding_ref_numbers, riskFlags:{materialWeakness, modifiedOpinion, questionedCosts, repeatFinding, significantDeficiency, otherFindings, otherMatters} }] } + honest _meta. ★RISK-FLAG HONESTY: the is_* flags are surfaced VERBATIM as the auditor reported them (\"Y\"/\"N\") PLUS a typed riskFlags tri-state (\"Y\"→true / \"N\"→false / blank/absent/other → null=UNKNOWN) — a null flag is NEVER rendered as false/\"no material weakness\" (the false-CLEAR class). ★EMPTY ≠ CLEAN: an empty findings list does NOT confirm a clean audit — the entity may not have filed a Single Audit (below the $750K threshold), the audit may predate FAC coverage, or the UEI may be wrong; a disclosure note fires on any empty result telling you to confirm an ACCEPTED audit exists via fac_search_audits. ★PII: a HARDCODED select-allowlist (NO caller column param) surfaces only entity + audit-risk fields — no personal contact. totalAvailable is the EXACT Content-Range total ('*'/absent ⇒ null + hedge, never 0); a bad column ⇒ 400 ⇒ invalid_input; 400/403/5xx/timeout/HTML/non-array THROW (206 = success). NOT a debarment/determination — cross-check SAM exclusions + OFAC + the specific finding text. Keyless-first via DEMO_KEY (~10 req/hr; set DATA_GOV_API_KEY — never logged).",
    inputSchema: FacGetFindingsInput,
    handler: (input) => fac.getFindings(input),
  }),
  // ━━━ GAO — Bid Protests (1) ━━━
  defineTool({
    name: "gao_protest_lookup",
    description:
      "Recent GAO (Comptroller General) bid-protest decisions from the public Legal-Products RSS feed, enriched from each decision page (protester, contracting agency, decision date, outcome sustained/denied/dismissed/withdrawn, solicitation #, decision PDF). Filter client-side by agency/protester/solicitation/outcome, or pull one decision directly by bNumber. HONEST SCOPE: keyless covers only the RECENT feed window (~25 items) — GAO's faceted historical protest search (all years, by protester/agency/outcome/date) is WAF-blocked to bots and available only via a paid third-party API, so results are ALWAYS marked complete:false and are NOT the full protest history (see the accessNote).",
    inputSchema: GaoProtestInput,
    handler: (input) => gao.gaoProtestLookup(input),
  }),
  // ━━━ US Treasury — Fiscal Data (keyless) (4) ━━━ ADR-0002
  defineTool({
    name: "treasury_query_dataset",
    description:
      "Escape-hatch query over 5 confirmed US Treasury Fiscal Data datasets (keyless): debt_to_penny, avg_interest_rates, mts_table_1 (Monthly Treasury Statement), rates_of_exchange, debt_outstanding. Choose `dataset` (enum — no free path), and optionally project `fields` (CSV), `filter` (CSV 'col:op:val', ops lt|lte|gt|gte|eq|in, AND-combined), and `sort` (CSV, '-' = desc), with page[size]/page[number] pagination. Returns raw rows plus a truthful `_meta` (totalAvailable = upstream total-count, offset pagination). Value/amount fields are raw upstream strings — the string \"null\"/empty means 'no value', never 0. Covers rates_of_exchange + debt_outstanding without a dedicated tool.",
    inputSchema: TreasuryQueryDatasetInput,
    handler: (input) => treasury.queryDataset(input),
  }),
  defineTool({
    name: "treasury_debt_to_penny",
    description:
      "Daily total US public debt outstanding ('Debt to the Penny', keyless Treasury Fiscal Data). Returns record_date + totalPublicDebtOutstanding, debtHeldByPublic, intragovernmentalHoldings (USD). `latest` (default true) ⇒ the single most-recent day; set latest=false with startDate/endDate (ISO YYYY-MM-DD) for a date range, newest-first. Amounts are coerced to number|null (a null amount is 'no value reported', never 0).",
    inputSchema: TreasuryDebtToPennyInput,
    handler: (input) => treasury.debtToPenny(input),
  }),
  defineTool({
    name: "treasury_monthly_statement",
    description:
      "Monthly Treasury Statement (MTS table 1, keyless): federal receipts, outlays, and deficit/surplus by month. Returns record_date, classification, grossReceipts, grossOutlays, deficitSurplus (USD, number|null). `startDate`/`endDate` (ISO YYYY-MM-DD) filter record_date (default: trailing ~12 months). By default excludeSummaryRows=true drops the fiscal-year parent/summary header rows (whose amounts are all null) via a server-side filter, so totalAvailable and rows reflect real child line-items only; set excludeSummaryRows=false to include them. Highest-value budget-analysis tool.",
    inputSchema: TreasuryMonthlyStatementInput,
    handler: (input) => treasury.monthlyStatement(input),
  }),
  defineTool({
    name: "treasury_avg_interest_rates",
    description:
      "Average interest rate the US Treasury pays by security type/description (keyless Treasury Fiscal Data). Returns record_date, securityType, securityDescription, avgInterestRatePercent (percent, number|null). `latest` (default true) returns the most-recent month's full breakdown across security types (pinned to the latest record_date, memoized 5 min); set latest=false with startDate/endDate for a range. Optional `securityType` narrows by exact security_type_desc (e.g. 'Marketable', 'Non-marketable').",
    inputSchema: TreasuryAvgInterestRatesInput,
    handler: (input) => treasury.avgInterestRates(input),
  }),
  // ━━━ SEC EDGAR — filings / XBRL facts / CIK / full-text / frames / full-index / daily-index / companyconcept (keyless) (8) ━━━ ADR-0003 / ADR-0017 / ADR-0026 / ADR-0027 / ADR-0041
  defineTool({
    name: "edgar_lookup_cik",
    description:
      "Resolve a company ticker or name to its 10-digit SEC CIK (keyless, via SEC company_tickers.json). Input `query` (exact ticker or a title substring) ⇒ up to 50 { cik, ticker, title } matches; found:false on none. The CIK is the join key for edgar_company_filings/edgar_company_facts. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS — there is no authoritative CIK↔UEI join.",
    inputSchema: EdgarLookupCikInput,
    handler: (input) => edgar.lookupCik(input),
  }),
  defineTool({
    name: "edgar_company_filings",
    description:
      "A company's SEC filings (keyless, from data.sec.gov submissions). Input `cikOrTicker` (CIK or resolvable ticker/name), optional `forms` (e.g. ['10-K','8-K']), `limit` (≤100, default 20), `offset`, `fullHistory` (default false), `maxShards` (1..100, default 10). Returns filings with the REAL primary-document archive URL. By default returns the recent window (up to 1 year OR 1000 filings, whichever is more); set `fullHistory:true` to ALSO fetch the older filings.files[] shards (newest-first up to `maxShards`) and assemble the COMPLETE history (recent ++ shard001..N, descending, no re-sort). HONESTY: totalAvailable = recent + Σ ALL older-shard counts (the grand total, incl un-fetched shards — never recomputed down), so a capped/failed fan-out reads complete:false; a note discloses COMPLETE vs PARTIAL-BY-CAP (RAISE maxShards for older un-fetched shards — pagination does NOT reach them) vs PARTIAL-BY-FAILURE (a 404/bad-CIK/transient shard is skipped, missing filings disclosed, never fabricated); fullHistory serializes N shard GETs through the shared EDGAR throttle gate. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS.",
    inputSchema: EdgarCompanyFilingsInput,
    handler: (input) => edgar.companyFilings(input),
  }),
  defineTool({
    name: "edgar_company_facts",
    description:
      "Curated XBRL financial facts for a filer (keyless, from data.sec.gov companyfacts). Input `cikOrTicker`, optional `concepts` (default: 6 curated USD concepts — Revenues/RevenueFromContractWithCustomerExcludingAssessedTax, Assets, Liabilities, StockholdersEquity, NetIncomeLoss, CashAndCashEquivalentsAtCarryingValue), `unit` (default USD), `latest`. A concept absent for the filer is OMITTED (never 0); a concept present only in another unit (e.g. EPS in USD/shares) is reported under wrongUnit with a note.",
    inputSchema: EdgarCompanyFactsInput,
    handler: (input) => edgar.companyFacts(input),
  }),
  defineTool({
    name: "edgar_full_text_search",
    description:
      "Full-text search across EDGAR filings, 2001-present (keyless, efts.sec.gov). Input `q` (phrase in double-quotes for exact), optional `forms`, `startdt`/`enddt` (ISO), `ciks` (pin filings BY entities — numeric 10-digit SEC CIKs, zero-padded, exact-entity match), `entityName` (FUZZY filer-name narrowing — can match related filers, e.g. multiple 'Apple*'), `from` (offset; page size FIXED at 100 — no size param). Returns { accession, form, filingDate, entityNames, ciks, filingIndexUrl }. HONESTY: totalAvailable = the true match count, or a LOWER BOUND (totalIsLowerBound:true) when SEC reports ≥10000; a 0-result set with ciks/entityName applied is NOT proof of absence (verify the CIK via edgar_lookup_cik by name/ticker); from > 9900 is rejected (10000-result window). NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS.",
    inputSchema: EdgarFullTextSearchInput,
    handler: (input) => edgar.fullTextSearch(input),
  }),
  defineTool({
    name: "edgar_xbrl_frames",
    description:
      "Keyless cross-filer XBRL cross-section (SEC EDGAR frames, data.sec.gov). In ONE call, return EVERY filer's reported value for a single us-gaap/dei concept in a single calendar period — the complete cross-section — for peer benchmarking + distribution stats. Input `tag` (EXACT alnum concept, e.g. 'Assets'), `period` (CY2023 annual · CY2023Q1 quarterly · CY2023Q4I instant/trailing-I), optional `taxonomy` (us-gaap|dei), `unit` (default USD; EPS uses 'USD-per-shares'), `limit`/`offset` (CLIENT-SIDE window over the fully-fetched set), `includeStats`. Rows: { accn, cik, entityName, loc, end, val, start? } (start only for duration concepts). HONESTY: totalAvailable = SEC's own pts (asserted === data.length, else schema_drift THROW — no fake completeness); the whole frame is fetched upstream in one call and limit/offset is a disclosed client-side page (never a subset labeled complete); a tag/unit/period mismatch ⇒ 404 ⇒ found:false (NEVER a fabricated val:0); val is null-never-0; includeStats covers the FULL set with linear-interpolated percentiles (count===0 ⇒ all-null, never 0/NaN). taxonomy/tag/unit/period are validated path segments (enum+regex, re-checked pre-fetch) — no injection surface. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS.",
    inputSchema: EdgarXbrlFramesInput,
    handler: (input) => edgar.xbrlFrames(input),
  }),
  defineTool({
    name: "edgar_filing_index",
    description:
      "Bulk cross-filer SEC filing index for a quarter (keyless, from the www.sec.gov EDGAR full-index master.idx). Reads the WHOLE quarter's index (every filer's every filing — CIK|Company|Form|Date|Filename, ~370K rows), FULL-SCANS it, and returns offset-paginated filings matching CLIENT-SIDE filters with the EXACT total. Input `year` (>=1993, <= current year), `quarter` (1..4); optional `formType` (exact form, e.g. '8-K'), `cik` (numeric, leading-zero-safe), `companyContains` (LITERAL case-insensitive substring), `dateFrom`/`dateTo` (ISO YYYY-MM-DD), `limit` (<=1000, def 100), `offset`. Returns { year, quarter, indexFile, returned, totalAvailable, filings:[{ cik, cikPadded, companyName, formType, dateFiled, filename, filingUrl }] }. This is the BULK-ENUMERATION primitive (the per-filer edgar tools need a CIK you already hold; this sweeps a whole quarter by form/date/company, e.g. 'every 8-K in 2024 Q1'). HONESTY: totalAvailable is the EXACT match count over the full quarter scan — never a page length, never a byte-capped subset (SEC ignores HTTP Range); a 0-match result is a genuine EXACT ZERO (complete:true), NOT a truncation; a bounds-valid but unpublished quarter returns HTTP 403 and is surfaced as an AMBIGUOUS both-causes error (quarter-not-published OR the 10 req/s rate-block), never a bare rate-limit and never a fake-empty; a non-index / all-malformed body is refused as schema_drift; a future year / bad quarter is rejected pre-fetch (invalid_input, 0 fetch). The CURRENT quarter grows daily (totalAvailable is exact AS-OF-snapshot). filingUrl is a resolvable archive URL. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS — there is no authoritative CIK↔UEI join.",
    inputSchema: EdgarFilingIndexInput,
    handler: (input) => edgar.filingIndex(input),
  }),
  defineTool({
    name: "edgar_daily_filing_index",
    description:
      "Per-DAY cross-filer SEC filing index (keyless, from the www.sec.gov EDGAR daily-index master.YYYYMMDD.idx). The per-day sibling of edgar_filing_index (~30× smaller): reads ONE calendar day's index (every filer's every filing that day — CIK|Company|Form|Date|File Name, ~8K rows), FULL-SCANS it, and returns offset-paginated filings matching CLIENT-SIDE filters with the EXACT total. Answers the monitoring/alerting question the quarterly tool cannot ('every 8-K filed on 2024-01-03', 'watch a CIK day-by-day'). Input `date` (required ISO YYYY-MM-DD, >=1994-01-01, not future); optional `formType` (exact form, e.g. '8-K'), `cik` (numeric, leading-zero-safe), `companyContains` (LITERAL case-insensitive substring), `limit` (<=1000, def 100), `offset`. Returns { found, date, year, quarter, indexFile, returned, totalAvailable, filings:[{ cik, cikPadded, companyName, formType, dateFiled, filename, filingUrl }] }. HONESTY: totalAvailable is the EXACT match count over the full day scan — never a page length, never a byte-capped subset (SEC ignores HTTP Range). The daily-index's pervasive-403 empty model is disambiguated via the quarter's index.json existence oracle, RECENCY-AWARE: a day NEWER than the newest published index (weekend/holiday/not-yet-disseminated recent trading day) ⇒ found:false, complete:FALSE, retryable not-yet-disseminated note (NEVER a confident empty); an unlisted day INSIDE the covered range (a real weekend/holiday) ⇒ found:false, complete:true genuine-absent; a LISTED day whose .idx 403s ⇒ honest rate_limited; the oracle itself inconclusive ⇒ ambiguous both-causes upstream_unavailable. A non-real/future date is rejected pre-fetch (invalid_input, 0 fetch); a non-index / all-malformed body is refused as schema_drift. dateFiled is normalized to ISO from the compact YYYYMMDD column. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS — there is no authoritative CIK↔UEI join.",
    inputSchema: EdgarDailyFilingIndexInput,
    handler: (input) => edgar.dailyFilingIndex(input),
  }),
  defineTool({
    name: "edgar_company_concept",
    description:
      "One filer × one XBRL concept × the COMPLETE reported time-series (keyless, from data.sec.gov companyconcept). The focused financial-TREND / entity-vetting primitive BETWEEN edgar_company_facts (many curated concepts for one filer) and edgar_xbrl_frames (one concept across ALL filers for one period) — 'track THIS filer's Assets/Revenues/NetIncomeLoss OVER TIME, and was it ever revised?'. Input `cikOrTicker` (CIK or resolvable ticker/name), `concept` (EXACT alnum XBRL tag, e.g. 'Assets'), optional `taxonomy` (us-gaap|dei|ifrs-full, def us-gaap), `unit` (CLIENT-SIDE key filter), `form`/`fy` (client-side), `canonicalOnly` (def false), `limit`/`offset`. Returns { found, cik, entityName, taxonomy, concept, label, description, unitsAvailable:[{unit,count}], rows:[{ unit, start, end, val, accn, fy, fp, form, filed, frame, canonical }] }. HONESTY: (M1) period identity is the (start,end) PAIR — every row carries `start` (null for INSTANT concepts, the ISO date for DURATION/flow concepts); the SAME `end` with a DIFFERENT `start` is a different-duration fact (a 3-month quarter vs the 12-month year), NOT a revision — a revision is only multiple rows sharing the same (start,end) with a differing accn/filed/val. DEFAULT returns ALL rows incl. the amendment/restatement history + a per-row `canonical` (frame-tagged = SEC's consolidated value); `canonicalOnly:true` dedups to one canonical row per (unit,start,end), fully disclosed, never a silent drop. Every row is unit-tagged (a USD amount is NEVER conflated with a share count); unitsAvailable discloses ALL units with their RAW counts even under a unit filter; val is null-never-0. A bad CIK/taxonomy/concept ⇒ upstream 404 ⇒ found:false (NEVER a fabricated val:0); a 5xx/timeout/non-JSON/units-shape-drift THROWS; a `unit` not present ⇒ honest empty + the available-units note (unit is CLIENT-SIDE, not a path segment). cik/taxonomy/concept are validated path segments (regex+enum, re-checked pre-fetch) — no injection surface. NOTE: EDGAR keys on CIK, NOT SAM UEI/DUNS — there is no authoritative CIK↔UEI join.",
    inputSchema: EdgarCompanyConceptInput,
    handler: (input) => edgar.companyConcept(input),
  }),
  // ━━━ Socrata / SODA — keyless SLED + E-rate open data (2) ━━━ ADR-0004
  defineTool({
    name: "socrata_query",
    description:
      "Query rows from an allowlisted Socrata/SODA open-data portal (keyless; ~a dozen US state portals + USAC E-rate on one identical API — state spend/checkbook/contract/vendor-payment datasets). Input `domain` (curated allowlist enum — the SSRF host guard), `datasetId` (4x4, from socrata_discover_datasets), optional SoQL `select`/`where`/`order`/`q`, `limit` (≤1000, def 100), `offset`, `withTotal` (def true). HONESTY: SODA's row response has no total, so a count(*) companion supplies an exact totalAvailable; if it fails the rows still return with totalAvailable:null + a note (hasMore is then inferred from page-fill, never a false complete). Genuine-empty ⇒ complete:true/total:0; an outage/400/404 THROWS (never a fake empty). Value fields are strings.",
    inputSchema: SocrataQueryInput,
    handler: (input) => socrata.query(input),
  }),
  defineTool({
    name: "socrata_discover_datasets",
    description:
      "Find Socrata dataset 4x4 ids by keyword via the Socrata catalog (keyless, api.us.socrata.com). Input `q` (e.g. 'procurement', 'vendor payments'), optional `domain` (scope to one allowlisted portal; omit to search the whole allowlist), `limit` (≤100, def 20). Returns [{ id, name, description, domain, updatedAt, link }] + totalAvailable = the catalog resultSetSize. Feed a result's `id` to socrata_query as `datasetId`. NOTE: the federated catalog does not index every allowlisted host (e.g. USAC E-rate) — those stay queryable via socrata_query with a known 4x4.",
    inputSchema: SocrataDiscoverDatasetsInput,
    handler: (input) => socrata.discoverDatasets(input),
  }),
  // ━━━ CKAN datastore_search — keyless SLED open data (2) ━━━ ADR-0006
  defineTool({
    name: "ckan_query",
    description:
      "Query rows from an allowlisted CKAN datastore resource (keyless; the FIRST source on the R2 DataSource port — state/city spend/checkbook/procurement/vendor tables on the identical CKAN Action API). Input `host` (curated allowlist enum — the SSRF host guard: data.ca.gov, data.virginia.gov, data.boston.gov), `resourceId` (36-char lowercase UUID, from ckan_discover_datasets), optional `q` (full-text), `filters` (constrained object {field:value} we JSON.stringify), `sort`, `limit` (≤1000, def 100), `offset`. HONESTY: CKAN's envelope carries a real result.total — the DEFAULT is an EXACT total (exact totalAvailable + hasMore); the rare estimated total (total_was_estimated:true) is disclosed via totalIsEstimated + a note and does NOT drive pagination (it can be above OR below the truth). Genuine-empty ⇒ complete:true/total:0; an outage/404/409 or success:false THROWS (never a fake empty). Values are typed per result.fields[].type.",
    inputSchema: CkanQueryInput,
    handler: (input) => ckan.query(input),
  }),
  defineTool({
    name: "ckan_discover_datasets",
    description:
      "Find CKAN datastore resource ids by keyword via package_search (keyless). Input `host` (allowlisted enum), `q` (e.g. 'procurement', 'checkbook'), `limit` (≤100, def 20). Returns per-resource rows [{ resourceId, name, datasetTitle, format, datastoreActive }] + totalAvailable = the matching DATASET count. Feed a datastoreActive:true result's `resourceId` to ckan_query (a datastoreActive:false resource is a raw file blob NOT in the datastore, not queryable).",
    inputSchema: CkanDiscoverDatasetsInput,
    handler: (input) => ckan.discoverDatasets(input),
  }),
  // ━━━ FDIC BankFind Suite — keyless institution directory + financials + failures + history + industry aggregates (5) ━━━ ADR-0028 / ADR-0029 / ADR-0030 / ADR-0031
  defineTool({
    name: "fdic_search_institutions",
    description:
      "Search the FDIC-insured-institution directory (keyless FDIC BankFind, api.fdic.gov/banks/institutions) — a regulated-entity directory for B2G counterparty / bank due-diligence. Structured filters: `state` (2-letter, → STALP), `activeOnly` (→ ACTIVE 1/0), `cert` (→ CERT, the STABLE entity key), plus `name`/`city` matched via FDIC's case-insensitive full-text `search` param (NOT `filters` — `filters=NAME:\"chase\"` is case-sensitive exact-keyword and returns a false-empty; `search=NAME:chase` finds JPMorgan Chase etc.). `limit` (≤1000, def 100), `offset` (≤100000), `sortBy` (allowlisted enum NAME/CERT/ASSET/ESTYMD/STALP/CITY/ACTIVE), `sortOrder` (ASC/DESC). Returns { institutions:[{ name, city, state, cert, assetUSD, active, establishedDate, id }] }. HONESTY: totalAvailable is the EXACT meta.total (stable across offset — never the page length); ASSET is published in $thousands and normalized to whole USD ×1000 (null-never-0 — a real 0 stays 0, absent → null); the ONLY honest empty is meta.total:0/data:[] ⇒ complete:true/total:0, every other envelope (400 errors[]/404/non-JSON/missing meta or data) THROWS (never a fake empty); a multi-word name/city is matched per-token (disclosed); the point-in-time snapshot build time is disclosed. NOTE: FDIC keys on CERT, not SAM UEI/DUNS.",
    inputSchema: FdicSearchInstitutionsInput,
    handler: (input) => fdic.searchInstitutions(input),
  }),
  defineTool({
    name: "fdic_institution_financials",
    description:
      "Quarterly financial time-series for ONE FDIC-insured institution by certificate number (keyless FDIC BankFind, api.fdic.gov/banks/financials). Input `cert` (REQUIRED FDIC certificate number, from fdic_search_institutions), `limit` (≤1000, def 100), `offset` (≤100000), `sortBy` (allowlisted enum REPDTE/ASSET/DEP/NETINC, def REPDTE), `sortOrder` (def DESC → newest quarter first). Returns { cert, financials:[{ cert, reportDate, assetUSD, depositsUSD, netIncomeUSD, id }] } (e.g. CERT 10363 → 169 quarterly rows). HONESTY: totalAvailable is the EXACT meta.total (stable across offset — page via offset for the full history); ASSET/DEP/NETINC are published in $thousands and normalized to whole USD ×1000 (null-never-0); the ONLY honest empty is meta.total:0/data:[] ⇒ complete:true/total:0, every other envelope THROWS (never a fake empty); the snapshot build time is disclosed.",
    inputSchema: FdicInstitutionFinancialsInput,
    handler: (input) => fdic.institutionFinancials(input),
  }),
  defineTool({
    name: "fdic_bank_failures",
    description:
      "Historical FDIC-insured bank failures & assistance transactions (keyless FDIC BankFind, api.fdic.gov/banks/failures) — B2G counterparty / entity due-diligence: a failed or FDIC-assisted institution is a red flag, and CERT links a failure back to fdic_search_institutions / fdic_institution_financials. Exact-key filters: `state` (2-letter → PSTALP — NOTE the /failures state field is PSTALP, NOT STALP), `failYear` (→ FAILYR; e.g. 2023 → the 5 real 2023 failures incl. Silicon Valley Bank & First Republic Bank), `cert` (→ CERT, the STABLE entity key). `limit` (≤1000, def 100), `offset` (≤100000), `sortBy` (allowlisted enum FAILDATE/COST/QBFASSET/QBFDEP/NAME/FAILYR, def FAILDATE), `sortOrder` (def DESC → most-recent first). Returns { failures:[{ name, cert, failDate, failYear, city, state, resolutionType, resolutionFund, estimatedLossUSD, depositsUSD, assetsUSD, id }] }. NO name/city filter — FDIC's /failures `search` param is IGNORED (it returns the whole dataset), so name/city are SHOWN in each row but NOT searchable; to find a specific bank's failure, resolve its CERT via fdic_search_institutions then filter here by `cert`. HONESTY: totalAvailable is the EXACT meta.total (stable across offset — never the page length); failDate is normalized from FDIC's M/D/YYYY to ISO YYYY-MM-DD (an unrecognized value is surfaced raw + disclosed, never nulled/fabricated); COST/QBFDEP/QBFASSET are $thousands normalized to whole USD ×1000 (null-never-0 — a genuine 0 = a fully-assisted no-loss stays 0, a NEGATIVE COST = a net DIF recovery/gain not a loss, absent → null); the ONLY honest empty is meta.total:0/data:[] ⇒ complete:true/total:0, every other envelope (400 errors[]/404/non-JSON/missing meta or data) THROWS (never a fake empty); the point-in-time snapshot build time is disclosed. NOTE: FDIC keys on CERT, not SAM UEI/DUNS.",
    inputSchema: FdicBankFailuresInput,
    handler: (input) => fdic.bankFailures(input),
  }),
  defineTool({
    name: "fdic_institution_history",
    description:
      "Institution-level STRUCTURAL-CHANGE event log for FDIC-insured banks (keyless FDIC BankFind, api.fdic.gov/banks/history) — the full lineage of mergers, absorptions, consolidations, failures, name/location/charter/regulator changes, branch open/close, trust-power grants & FRS-membership changes. Completes the FDIC entity cluster (directory + financials + failures + history). Killer feature: CERT-linked MERGER LINEAGE — a merger/failure row carries the acquiring / outgoing / surviving institution's CERT + name, each linking back to fdic_search_institutions / fdic_institution_financials / fdic_bank_failures. Exact-key filters (all optional, AND-combined): `cert` (→ CERT, the STABLE entity key & PRIMARY lookup; e.g. 3510 → Bank of America's 13,794 rows), `changeCode` (→ CHANGECODE; e.g. 223 = merger, 211 = failure, 721 = branch closing, 520 = location change), `effYear` (→ EFFYEAR), `state` (2-letter → PSTALP — NOTE the /history state field is PSTALP, NOT STALP). `limit` (≤1000, def 100), `offset` (≤100000), `sortBy` (allowlisted enum EFFDATE/PROCDATE/CHANGECODE/TRANSNUM, def EFFDATE), `sortOrder` (def DESC → newest change first). Returns { history:[{ cert, instName, state, changeCode, changeDescription, effectiveDate, processDate, effYear, transNum, acquirerCert, acquirerName, outgoingCert, outgoingName, survivingCert, survivingName, id }] }. NO name/city filter — FDIC's /history `search` param returns 0 for INSTNAME (a false-empty), so names are SHOWN in each row but NOT searchable; to find a specific bank's history, resolve its CERT via fdic_search_institutions then filter here by `cert`. HONESTY: totalAvailable is the EXACT meta.total (stable across offset — never the page length); changeDescription is FDIC's OWN co-served CHANGECODE_DESC passed through verbatim (the numeric changeCode is authoritative — never a hand-map); effectiveDate/processDate are normalized from FDIC's YYYY-MM-DDT00:00:00 to ISO YYYY-MM-DD (an unrecognized value is surfaced raw + disclosed, never nulled/fabricated); the acquirer/outgoing/surviving CERTs are null on a non-merger event (null-never-0 — a real absence, never a fabricated 0; *_UNINUM's 0 sentinel is NOT surfaced); the ONLY honest empty is meta.total:0/data:[] ⇒ complete:true/total:0, every other envelope (400 errors[]/404/non-JSON/missing meta or data) THROWS (never a fake empty); the point-in-time snapshot build time is disclosed. NOTE: FDIC keys on CERT, not SAM UEI/DUNS.",
    inputSchema: FdicInstitutionHistoryInput,
    handler: (input) => fdic.institutionHistory(input),
  }),
  defineTool({
    name: "fdic_industry_summary",
    description:
      "FDIC industry & state banking-sector ANNUAL AGGREGATES — the FDIC's own roll-ups (keyless FDIC BankFind, api.fdic.gov/banks/summary). The FIRST aggregate/statistical FDIC tool (the other 4 are per-ENTITY, keyed on CERT): total assets, deposits, net income, equity & net interest income + structural counts (institutions, offices, branches, employees) for the whole US banking industry OR one state/territory in one year, split by charter class. Answers 'how big is the US (or a state's) banking industry this year, and how many institutions?' — a question the entity tools cannot express without summing thousands of rows. Exact-key filters (all optional, AND-combined): `year` (→ YEAR; e.g. 2023 → 121 rows), `state` (2-or-3-letter → STALP — NOTE the /summary state field is STALP, NOT PSTALP; accepts a jurisdiction code TX/CA/DC/GU/PR… OR a ROLL-UP code USA/US/OT/PI), `charterClass` (CB = commercial banks, SI = savings institutions; omit for both — there is NO combined row). `limit` (≤1000, def 100), `offset` (≤100000), `sortBy` (allowlisted enum YEAR/ASSET/DEP/NETINC/BANKS, def YEAR), `sortOrder` (def DESC → newest year / largest first). Returns { summary:[{ year, charterClass, charterClassCode, geography, stateCode, stateFips, scope, isRollup, institutionCount, officeCount, branchCount, employeeCount, totalAssetsUSD, totalDepositsUSD, netIncomeUSD, totalEquityUSD, netInterestIncomeUSD, id }] }. ★ROLL-UP HONESTY: each row crosses charter × geography; STALP ∈ {USA,US,OT,PI} are GEOGRAPHIC AGGREGATES (scope national_total/national_states_dc/territories_total/pacific_islands, isRollup:true), every other STALP is a jurisdiction (isRollup:false) — NEVER sum a roll-up row with jurisdiction rows or across scopes (national_total = national_states_dc + territories_total; a geography's total = its CB row + its SI row), read the national_total (USA) row directly for one national figure; a roll-up is NOT a state. ★NIM is net interest INCOME (a $ sum surfaced as netInterestIncomeUSD), NOT the margin ratio; this endpoint has NO ratio fields (ROA/ROE — derive from netIncomeUSD/totalAssetsUSD/totalEquityUSD). NO name/city filter — FDIC's /summary `search` param is ignored (returns the whole year); drill to institutions via fdic_search_institutions. HONESTY: totalAvailable is the EXACT meta.total (stable across offset — never the page length); money (ASSET/DEP/NETINC/EQ/NIM) is $thousands → whole USD ×1000 (null-never-0 — a genuine 0 like American Samoa's zero commercial banks stays 0, absent → null), counts (BANKS/OFFICES/BRANCHES/employees) pass through un-scaled (a count ×1000 is a fabrication); a non-int year is rejected pre-fetch (a malformed year is a live HTTP-200 total:0 false-empty); the ONLY honest empty is meta.total:0/data:[] ⇒ complete:true/total:0, every other envelope (400 errors[]/404/non-JSON/missing meta or data) THROWS (never a fake empty); the point-in-time snapshot build time is disclosed. NOTE: FDIC keys on CERT, not SAM UEI/DUNS.",
    inputSchema: FdicIndustrySummaryInput,
    handler: (input) => fdic.industrySummary(input),
  }),
  // ━━━ FDIC BankFind Suite — WITHIN-SOURCE DEPTH: counterparty risk ratios + branch deposits (2) ━━━ ADR-0040
  defineTool({
    name: "fdic_risk_ratios",
    description:
      "FDIC counterparty RISK RATIOS for ONE institution by certificate number (keyless FDIC BankFind, api.fdic.gov/banks/financials) — the SOUNDNESS lane the balance-sheet tools cannot express: profitability (ROA/pretax ROA/ROE), net interest margin, efficiency ratio, asset quality (net charge-offs to loans), capital adequacy (leverage, tier-1 risk-based, total risk-based ratios) + the tier-1 capital LEVEL. Input `cert` (REQUIRED FDIC certificate number, from fdic_search_institutions), `reportDate` (optional YYYYMMDD quarter-end → REPDTE; omit for the full quarterly time-series), `limit` (≤1000, def 100), `offset` (≤100000), `sortBy` (allowlisted enum REPDTE/ROA/ROE/RBCRWAJ/EEFFR, def REPDTE), `sortOrder` (def DESC → newest quarter first). Returns { cert, ratios:[{ cert, reportDate, cblrFramework, returnOnAssetsPct, preTaxReturnOnAssetsPct, returnOnEquityPct, netInterestMarginPct, efficiencyRatioPct, netChargeOffsToLoansPct, leverageRatioPct, tier1RiskBasedCapitalRatioPct, totalRiskBasedCapitalRatioPct, tier1CapitalUSD, id }] }. ★UNITS-IN-THE-KEY: every *Pct field is an FDIC-published PERCENTAGE surfaced VERBATIM (no scaling, no recompute) — do NOT read it as a dollar amount or ×1000-scale it; tier1CapitalUSD is a DOLLAR amount (FDIC publishes it in $thousands, normalized ×1000). ★NULL-NEVER-0: a not-reported ratio is null (never 0% — a false 'no return / no capital'). ★CBLR (community-bank-leverage) banks (cblrFramework:true) do NOT report the risk-based capital ratios — FDIC returns a literal 0 for the total risk-based ratio, which this tool maps to null for BOTH tier1RiskBasedCapitalRatioPct and totalRiskBasedCapitalRatioPct (a null there is a normal framework artifact, read alongside leverageRatioPct — NOT a 0% capital red flag). No ratio is recomputed; each is exactly FDIC's published Call-Report figure. HONESTY: totalAvailable is the EXACT meta.total (stable across offset); the ONLY honest empty is meta.total:0/data:[] ⇒ complete:true/total:0, every other envelope (400 errors[]/404/non-JSON/missing meta or data) THROWS (never a fake empty); the snapshot build time is disclosed. NOTE: reported regulatory metrics, NOT a soundness rating or failure prediction; FDIC keys on CERT, not SAM UEI/DUNS.",
    inputSchema: FdicRiskRatiosInput,
    handler: (input) => fdic.riskRatios(input),
  }),
  defineTool({
    name: "fdic_branch_deposits",
    description:
      "FDIC branch-deposit footprint — the Summary of Deposits (keyless FDIC BankFind, api.fdic.gov/banks/sod): the annual June-30 branch-office deposit distribution ('where does this bank hold deposits, and how concentrated?'). Exact-key filters (all optional, AND-combined; ≥1 recommended): `cert` (→ CERT, the STABLE entity key), `state` (2-letter → STALPBR, the branch-state field, C118-quoted so Oregon is operator-safe), `year` (→ YEAR, the June-30 snapshot year). `limit` (≤1000, def 100), `offset` (≤100000), `sortBy` (allowlisted enum YEAR/DEPSUMBR, def YEAR), `sortOrder` (def DESC → newest snapshot / largest deposits first). Returns { branches:[{ cert, institutionName, branchNumber, branchName, city, state, zip, address, depositsUSD, year, id }] } (e.g. CERT 10004 → 74 branch-year rows). HONESTY: totalAvailable is the EXACT meta.total (stable across offset — never the page length); depositsUSD is DEPSUMBR published in $thousands, normalized to whole USD ×1000 (null-never-0 — a real 0 stays 0, absent → null); a bad/mistyped filter field can never reach the wire (server-side allowlist by construction — FDIC would otherwise return a silent total:0 false-empty, not an error); the ONLY honest empty is meta.total:0/data:[] ⇒ complete:true/total:0, every other envelope (400 errors[]/404/non-JSON/missing meta or data) THROWS (never a fake empty); the DISTINCT annual snapshot build time is disclosed. Branch facility data only (name/address/city/state/zip/deposits) — no personal/officer PII. NOTE: SOD is an annual June-30 snapshot; FDIC keys on CERT, not SAM UEI/DUNS.",
    inputSchema: FdicBranchDepositsInput,
    handler: (input) => fdic.branchDeposits(input),
  }),
  // ━━━ USITC Harmonized Tariff Schedule — keyless import-tariff / duty-rate lookup (1) ━━━ ADR-0039
  defineTool({
    name: "hts_lookup",
    description:
      "Look up US import-tariff classification + duty rates from the USITC Harmonized Tariff Schedule (keyless; hts.usitc.gov/reststop/search) — the IMPORT-TARIFF / supply-chain PRICE lane a product-reseller / supply-chain bidder needs to price a hardware or commodity contract (extends the THIN Price lane with a NON-labor cost input, a sibling of gsa_benchmark_labor_rates). A single `query` serves BOTH modes: a KEYWORD (e.g. 'laptop', 'cotton shirt') OR an HTS number (e.g. '8471.30' / '8471.30.01.00') — both ride the `keyword=` search. Returns { query, lines:[{ htsno, statisticalSuffix, indent, description, units, columnOneGeneral, specialPreferential, columnTwo, additionalDuties, footnotes, quotaQuantity, effectivePeriod, status, isChapter99 }] } + honest _meta. ★DUTY-RATE HONESTY (the crux): columnOneGeneral (Column-1 General), specialPreferential (Special/preferential/FTA), and columnTwo (Column-2) are AUTHORITATIVE VERBATIM TEXT surfaced as strings — 'Free', a percentage ('35%'), a specific rate ('0.47¢/kg'), a compound/range, or null — NEVER coerced to a number (a coerced 0/NaN would fabricate a false 'duty-free'); an empty Special ('') → null = NO special-program rate published (NEVER read as Free). ★HIERARCHY (M1): a lookup returns rows across levels; the rate is stated ONCE at a shallower level (usually the 6/8-digit subheading) and inherits DOWNWARD to the blank statistical-suffix lines — to find a specific line's rate, read UP to the nearest ANCESTOR line (shallower indent, same htsno prefix) with a non-empty rate; a blank deepest line is NOT no/unknown duty. ★ADDITIONAL DUTIES (S1): the per-line `additionalDuties` is frequently null even when Section 301/232 duties apply — the real additional duty rides the Chapter-99 rows (isChapter99:true, htsno beginning '99') returned alongside the base line + the footnotes; they STACK on the base rate. ★COMPLETENESS (M2): the endpoint returns the FULL match array with NO server-side total and NO working pagination (offset is IGNORED) → totalAvailable is the EXACT served array length and paging is CLIENT-SIDE; there is no fixed cap (a single-char/common fragment can return 10,000–16,000+ rows / several MB), so `query` must be ≥3 non-whitespace chars (a 1–2 char query is rejected invalid_input before the fetch). `limit` (≤200, def 50), `offset`. A no-match ⇒ honest empty; a 404/5xx/timeout/non-array/HTML(→schema_drift) ⇒ THROWS (never a fake empty); a transient 400 on the validated query ⇒ upstream_unavailable (retryable). NOT a binding CBP classification ruling and NOT a landed-cost quote — the duty owed depends on country of origin + trade program + Section 301/232 / Chapter-99 additional duties + footnotes; confirm via CBP (CROSS / eRulings). The not-a-ruling caveat rides EVERY response.",
    inputSchema: HtsLookupInput,
    handler: (input) => usitc.htsLookup(input),
  }),
  // ━━━ BLS Public Data API v1/v2 — keyless US labor/price time series (1) ━━━ ADR-0032
  // A NEW capability axis: the PRICING / ESCALATION layer (CPI-U & ECI EPA-clause
  // escalation, PPI materials benchmarking, CES labor-rate context). The SECOND
  // POST-batch getJson-port consumer (after NIH). SSRF surface = a compile-time-
  // constant host+path; seriesids ride in the module-built POST body. Honesty crux:
  // the "-" unavailable marker → null-never-0 with the footnote reason surfaced; a
  // non-SUCCESS status THROWS (never a fake-empty); per-series units are labeled;
  // the span is clamped to the tier cap + disclosed. An OPTIONAL free BLS_API_KEY
  // rides ONLY in the POST body (v2) — never a URL/header/label/_meta/log.
  defineTool({
    name: "bls_timeseries",
    description:
      "Fetch US Bureau of Labor Statistics time series — the PRICING / ESCALATION layer (keyless; api.bls.gov Public Data API v1, POST/JSON batch). CPI-U & ECI drive federal contract escalation / economic-price-adjustment (EPA) clauses; PPI benchmarks materials pricing; CES employment/wages give labor-rate context (next to gsa_benchmark_labor_rates + sam wage determinations). Inputs (at least one of series/seriesId REQUIRED; both combinable): `series` — a FROZEN 9-key CURATED enum (typo-proof; each carries meaning + units): cpi_u_all/cpi_u_core (CPI-U index, NSA — the escalation reference), ppi_final_demand (PPI index), eci_total_comp/eci_wages (★12-MONTH % CHANGE, NOT an index — a consumer misreads 3.4 as an index level otherwise), unemployment_rate/labor_force_participation (percent, SA), employment_total_nonfarm (thousands of persons, SA), avg_hourly_earnings (dollars/hour, SA). `seriesId` — raw BLS IDs (charclass ^[A-Z0-9]{1,20}$; the OEWS/local-area/regional passthrough; units:null for a raw ID). `startYear`/`endYear` (1900..currentYear+1; default a ~10-year window; span CLAMPED to the tier cap ~10y and disclosed). Returns { series:[{ seriesId, key, meaning, units, observations:[{ year, period, periodName, value, valueUnavailable, footnotes, latest }], observationCount, coveredRange }] } + honest _meta. HONESTY: each `value` is PARSED number|null — the BLS \"-\" unavailable marker (e.g. the 2025 lapse-in-appropriations gap) → null NEVER 0, with valueUnavailable:true + the footnote reason on the observation AND lifted into _meta.notes (a data gap is DISCLOSED, never a silent null and never a fabricated 0); a genuine \"0\" stays 0. A non-SUCCESS status THROWS (never a fake-empty): REQUEST_NOT_PROCESSED (the v1 ~25/day limit) ⇒ rate_limited with the tier disclosure; REQUEST_FAILED ⇒ upstream_unavailable/invalid_input surfacing message[]. A non-JSON 200 or a SUCCESS body missing Results.series ⇒ schema_drift. An empty data[] on SUCCESS ⇒ observations:[] + an ambiguity note (a curated key = a genuine empty range; a raw seriesId = EITHER genuine-empty OR a nonexistent/typo'd ID — verify it). Every response discloses the active tier (v1 keyless ~25/day, 25 series/query, ~10y span | v2 with a free BLS_API_KEY ~500/day) + the per-series units caveat. An OPTIONAL free BLS_API_KEY (env; https://data.bls.gov/registrationEngine/) lifts to v2 and is sent ONLY in the request body — never a URL/header/log.",
    inputSchema: BlsTimeseriesInput,
    handler: (input) => bls.timeseries(input),
  }),
  // ━━━ BLS OEWS — keyless occupational wage benchmarking (2nd BLS tool) ━━━ ADR-0033
  // The LEVEL layer next to bls_timeseries's ESCALATION layer: mean/median annual &
  // hourly wages + employment by SOC occupation × geography — the highest-value B2G
  // BLS slice (labor-rate benchmarking) that bls_timeseries structurally cannot reach
  // (OEWS IDs are 25 chars > the raw-seriesId 20-char cap). BUILDS the 25-char series
  // ID INTERNALLY from validated structured inputs; REUSES the same POST/JSON transport
  // + parseBlsBody status-throw + mapObservation ("-"→null-never-0) + tier/key seam.
  defineTool({
    name: "bls_oews_wages",
    description:
      "Benchmark US occupational wages & employment from BLS OEWS (Occupational Employment & Wage Statistics) — the LEVEL layer for labor-rate benchmarking (keyless; api.bls.gov Public Data API, POST/JSON batch). The actual mean/median annual & hourly wage a labor category commands, by area — next to gsa_benchmark_labor_rates (GSA CALC), sam wage determinations, and bls_timeseries (the CPI/ECI escalation layer). OEWS series IDs are 25 chars (area×occupation×industry×datatype), EXCEEDING bls_timeseries's raw-seriesId cap, so this tool BUILDS the ID INTERNALLY from validated structured inputs. Inputs (at least one of occupation/soc REQUIRED; all arrays batch into ONE POST — the cartesian product area×occupation×datatype is capped at the active tier's series cap and refused over-cap WITH THE COUNT NAMED, never silently truncated): `occupation` — a CURATED 16-key SOC enum (typo-proof; e.g. software_developer=15-1252, civil_engineer=17-2051, management_analyst=13-1111); `soc` — raw 6-digit HYPHENLESS SOC codes for the ~830-SOC long tail (use 151252, not 15-1252); `area` — default [\"national\"]; each is \"national\", a 2-letter USPS state code (CA/TX/DC…), or a 5-digit CBSA metro code (19100 = Dallas-Fort Worth); `datatype` — default [\"annual_mean\"]: annual_mean/annual_median (dollars/year), hourly_mean/hourly_median (dollars/hour), employment (count jobs). NO year input — OEWS is ANNUAL and the API serves only the latest release; the tool requests a recent window internally and DISCLOSES the reference year. Returns { results:[{ area:{type,code,label}, occupation:{soc,key,label}, measure:{key,code,units}, value:number|null, valueUnavailable, referenceYear, referencePeriod, footnotes, seriesId }] } + honest _meta. HONESTY: (H1) OEWS is an ANNUAL point-in-time snapshot (reference May <year>, period A01), NOT monthly/current-quarter — disclosed every call; (H2) a built ID that returns empty/absent ⇒ value:null, valueUnavailable:FALSE (the occupation is not surveyed/estimated there OR the cell is suppressed for confidentiality) + the not-published note + the surfaced upstream \"Series does not exist\" message + the ID in fieldsUnavailable — NEVER a fabricated 0; a PRESENT \"-\" in-band value ⇒ null + valueUnavailable:true + footnote; (H3) each row's measure.units labels the datatype (never read an employment count as a wage); (H4) the API returns real numerics (no top-code); a non-SUCCESS status THROWS (REQUEST_NOT_PROCESSED ⇒ rate_limited with the tier disclosure; a non-JSON 200 ⇒ schema_drift). Every response discloses the active tier. An OPTIONAL free BLS_API_KEY lifts to v2 and is sent ONLY in the request body — never a URL/header/log.",
    inputSchema: BlsOewsWagesInput,
    handler: (input) => bls.oewsWages(input),
  }),
  // ━━━ BLS QCEW — county×NAICS market-size / wages / location-quotient (3rd BLS tool) ━━━ ADR-0042
  // A SECOND, DIFFERENT, keyless, un-rate-limited BLS DOMAIN (data.bls.gov/cew — the
  // QCEW Open Data Access CSV, NOT the rate-limited api.bls.gov/publicAPI timeseries
  // API). Answers the market-size / competition-density question no existing tool can:
  // establishment COUNT (market size / competitor density), county×NAICS employment,
  // avg weekly wage (labor cost), and the LOCATION QUOTIENT (concentration vs national).
  // Honesty crux: a suppressed employment/wage 0-sentinel → null (never 0), block/code/
  // field-scoped (base/lq/oty each keyed on its OWN *_disclosure_code; qtrly_estabs /
  // lq_qtrly_estabs / oty_qtrly_estabs_chg stay disclosed under 'N'). Symmetric CSV
  // column-drift + a POST-parse quoted-header assertion → schema_drift. A per-tuple 404
  // → honest empty. NEW gate key "bls_qcew"; NO BLS_API_KEY on this keyless path.
  defineTool({
    name: "bls_qcew",
    description:
      "BLS QCEW (Quarterly Census of Employment & Wages) — county×NAICS MARKET-SIZE / wages / location-quotient (keyless; data.bls.gov/cew Open Data Access CSV, a SECOND un-rate-limited BLS domain — NOT the ~25/day api.bls.gov timeseries API). Answers the market-size / competition-density question no other tool can: for ONE area_fips (county/state/metro/US) OR ONE NAICS × quarter — establishment COUNT (market size / competitor density), county×NAICS employment, average weekly wage (labor cost), and the LOCATION QUOTIENT (lq_* = concentration vs the national average; >1.00 = more concentrated / higher competition density). Inputs: `mode` (REQUIRED {area,industry}); `area` (area_fips ^[0-9A-Za-z]{1,6}$ — REQUIRED path segment for mode=area, else an optional client-side narrow); `industry` (NAICS ^[0-9]{1,6}$ DIGIT-ONLY — REQUIRED path segment for mode=industry, else an optional narrow; a hyphenated 31-33 404s, use the digit aggregate); `year` (REQUIRED 1990..current), `quarter` (REQUIRED 1|2|3|4); client-side `ownership`(own_code)/`aggregationLevel`(agglvl_code)/`sizeCode`; `limit` (≤1000, def 50)/`offset`. Wire: GET data.bls.gov/cew/data/api/{year}/{quarter}/{mode}/{code}.csv. Returns { found, mode, area|industry, year, quarter, rows:[{ area_fips, own_code, industry_code, agglvl_code, size_code, base:{ disclosed, disclosureCode, qtrly_estabs, month1/2/3_emplvl, total_qtrly_wages, taxable_qtrly_wages, qtrly_contributions, avg_wkly_wage }, locationQuotient:{ disclosed, disclosureCode, lq_qtrly_estabs, lq_… }, overTheYear:{ disclosed, disclosureCode, oty_qtrly_estabs_chg, oty_…_pct_chg } }] } + honest _meta. ★DISCLOSURE-SUPPRESSION HONESTY (the crux): each row carries THREE disclosure codes (base/lq/oty), each governing its block. QCEW encodes a SUPPRESSED (confidential) employment/wage value as a literal 0 — so under 'N' the confidential emplvl/wage/avg-wkly fields map to null (WITHHELD, never a fabricated $0), while the establishment COUNT (qtrly_estabs / lq_qtrly_estabs) AND its over-the-year change (oty_qtrly_estabs_chg / _pct_chg) stay DISCLOSED (real); under '-' the WHOLE block incl. the estabs field(s) → null; under blank a genuine reported/NEGATIVE 0 SURVIVES (the disclosed federal taxable=0/contrib=0 and the oty_*_chg=0 'no change'). NEVER a blanket 0→null. A null carries disclosed:false + the raw disclosureCode; a suppression note fires whenever any page row is suppressed. HONESTY: totalAvailable is the EXACT filtered row count (fetch-once + client-side limit/offset — QCEW does not paginate; never the page length); a per-tuple HTTP 404 ⇒ honest empty (found:false, the HTML 404 body NEVER parsed as CSV); a 5xx/timeout ⇒ THROW; a 200 non-CSV / a renamed/±column header / a wrong field-count row ⇒ schema_drift THROW (symmetric drift guard). The file MIXES aggregation levels + ownerships — a do-NOT-sum-across-agglvl/ownership note rides every response. PUBLIC AGGREGATE stats (the suppression mechanism keeps small-cell data non-identifying — no PII). Keyless, un-rate-limited; NO BLS_API_KEY is read.",
    inputSchema: BlsQcewInput,
    handler: (input) => bls.qcew(input),
  }),
  // ━━━ OpenFEMA — keyless disaster declarations + emergency-assistance spend (3) ━━━ ADR-0016
  defineTool({
    name: "fema_search_public_assistance",
    description:
      "Search FEMA Public Assistance funded projects — federal emergency-assistance spend to state/local/tribal applicants (keyless OpenFEMA, dataset PublicAssistanceFundedProjectsDetails v2, ~800k rows). Structured filters (module-built into an OData $filter; each LIVE-VERIFIED to narrow): `state` (→ stateAbbreviation), `disasterNumber`, `applicantId`, `damageCategoryCode` (e.g. 'B' = Emergency Protective Measures), `incidentType`, `minProjectAmount`/`maxProjectAmount` (projectAmount ge/le), `declaredDateFrom`/`declaredDateTo` (declarationDate ge/le). `limit` (≤1000, def 100 → $top), `offset` (→ $skip). HONESTY: the module ALWAYS sends $inlinecount=allpages so totalAvailable is the EXACT filtered total (metadata.count), never the page length; amount fields are number|null (a real 0 stays 0, absent → null); genuine-empty ⇒ complete:true/total:0; an outage/400/404 THROWS (never a fake empty).",
    inputSchema: FemaSearchPublicAssistanceInput,
    handler: (input) => fema.searchPublicAssistance(input),
  }),
  defineTool({
    name: "fema_disaster_declarations",
    description:
      "Look up FEMA disaster / emergency declarations by state, type, incident, year, or date (keyless OpenFEMA, dataset DisasterDeclarationsSummaries v2, ~70k rows). Structured filters (module-built into an OData $filter; each LIVE-VERIFIED to narrow): `state` (→ state), `incidentType` (e.g. 'Flood'), `declarationType` (DR/EM/FM), `fyDeclared`, `disasterNumber`, `declaredDateFrom`/`declaredDateTo` (declarationDate ge/le), `paProgramDeclared`/`iaProgramDeclared` (booleans). `limit` (≤1000, def 100 → $top), `offset` (→ $skip). HONESTY: the module ALWAYS sends $inlinecount=allpages so totalAvailable is the EXACT filtered total (metadata.count), never the page length; genuine-empty ⇒ complete:true/total:0; an outage/400/404 THROWS (never a fake empty). NOTE: per-dataset OData field names differ — 'state' here is the real field, whereas the public-assistance tool maps 'state' to 'stateAbbreviation'.",
    inputSchema: FemaDisasterDeclarationsInput,
    handler: (input) => fema.disasterDeclarations(input),
  }),
  defineTool({
    name: "fema_search_hazard_mitigation",
    description:
      "Search FEMA Hazard Mitigation Assistance projects — the disaster-RESILIENCE grant axis (HMGP/FMA/PDM/BRIC mitigation grants to state/local/tribal subrecipients, distinct from the disaster-RECOVERY spend in fema_search_public_assistance). Keyless OpenFEMA, dataset HazardMitigationAssistanceProjects v4, ~56k rows. Structured filters (module-built into an OData $filter; each LIVE-VERIFIED to narrow): `state` (→ state — the FULL state NAME, e.g. 'Alabama', NOT the 2-letter code), `programArea` (HMGP/FMA/PDM/BRIC/LPDM/FMA-SL), `disasterNumber`, `status` (e.g. 'Closed'), `programFy`, `region` (FEMA region 1–10), `minProjectAmount`/`maxProjectAmount` (projectAmount ge/le). `limit` (≤1000, def 100 → $top), `offset` (→ $skip). HONESTY: the module ALWAYS sends $inlinecount=allpages so totalAvailable is the EXACT filtered total (metadata.count), never the page length; amount fields (projectAmount/federalShareObligated/initialObligationAmount/netValueBenefits) are number|null (a real 0 stays 0, absent → null); genuine-empty ⇒ complete:true/total:0; an outage/400/404 THROWS (never a fake empty). NOTE: 'state' here is the full name (this dataset 400s on a 2-letter code), whereas fema_search_public_assistance maps 'state' to the 2-letter 'stateAbbreviation'.",
    inputSchema: FemaSearchHazardMitigationInput,
    handler: (input) => fema.searchHazardMitigation(input),
  }),
  // ━━━ FPDS-NG — federal contract AWARD ACTIONS (keyless ATOM) (1) ━━━ ADR-0012
  // The FIRST XML/ATOM source (bounded, ReDoS-safe hand-parser — the far.ts/gao.ts
  // lineage; NOT the getJson port). FPDS is the system-of-record USAspending
  // derives from — this closes the action-level / mod-level latest-truth gap.
  defineTool({
    name: "fpds_search_awards",
    description:
      "Search FPDS-NG federal contract AWARD ACTIONS (keyless ATOM) — the AUTHORITATIVE system-of-record for contract actions (each modification is its own transaction), the source USAspending.gov derives from (and lags 1-2 days). Structured filters ONLY, AND-combined (NO raw query — a typo'd FPDS field name is a SILENT ZERO, so the tool builds the fielded q): naics (PRINCIPAL_NAICS_CODE), vendorName, piid, departmentId, contractingAgencyName, signedDate range (from/to ISO), lastModified range, keyword. At least one filter is REQUIRED. Returns award/IDV rows { piid, modNumber, parentIdvPiid, actionType, signedDate, vendorName, vendorUei, ultimateParentUei, obligatedAmount, totalObligatedAmount, naics, psc, placeOfPerformanceState, extentCompeted, setAside, businessSize, socioeconomic, … } (content root is award OR IDV — both parse). HONESTY: page size is FIXED at 10; for >10 results totalAvailable is a LOWER BOUND (totalIsLowerBound:true; true count ∈ [total, total+9]) and you MUST paginate by pagination.hasMore (page-fullness), NEVER by totalAvailable (keyless deep-paging is capped ~200K far below the advertised total). Genuine-empty (offset 0) ⇒ complete:true/total:0 + a silent-zero disclosure; an empty page at offset>0 ⇒ totalAvailable:null/complete:false (deep-paging ceiling, ambiguous); an HTML/non-feed body or an all-null-piid page ⇒ schema_drift (never a fake empty); an outage/5xx/timeout THROWS. Amounts are number|null (a 0.00 obligation and negative de-obligations are REAL, absent ⇒ null). Prefer usas_* tools for spending rollups / sub-award graphs.",
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
    description:
      "Search awarded NIH RePORTER research-GRANT projects (keyless; api.reporter.nih.gov v2, POST/JSON — the FIRST non-GET getJson-port consumer) — the NEW federal research-funding recipient-enrichment axis (who receives NIH research money, by organization / state, joinable to SAM/USAspending via primary_uei). Structured, LIVE-CONFIRMED-narrowing criteria ONLY, AND-combined in a module-built body (NO raw passthrough): orgStates (UPPERCASE 2-letter USPS enum — the SSRF + silent-zero guard; a lowercase/unknown code silently returns zeros), orgNames (≤512 each, ≤20), fiscalYears (int array 1985..currentYear+1, ≤20), limit (1..500, def 50), offset (0..14,999, def 0). Returns { projects:[{ projectNum, projectTitle, fiscalYear, awardAmount, organization:{ name, state, primaryUei, primaryDuns, ueis, duns }, principalInvestigators, contactPiName, fundingIc }] } + honest _meta. HONESTY: (M2) records are RESEARCH GRANTS, NOT procurement contracts — primary_uei joins to SAM/USAspending recipients but the award nature differs (disclosed in every _meta.notes); totalAvailable = the EXACT meta.total (NEVER the page size, NEVER a lower bound); NIH caps keyless retrieval at the first 15,000 records (offset 0..14,999) — offset ≥ 15,000 ⇒ invalid_input, and past the window the count stays exact while records are UNREACHABLE (disclosed in a note; nextOffset is never a dead-end). Disclose-not-refuse: an unscoped query still returns the first page + the exact total + a narrow-your-criteria note. agencyIcCodes is intentionally NOT a filter (NIH silently drops it — it would be a false 'applied'). Genuine-empty (total:0) ⇒ complete:true/total:0; an outage/5xx/timeout THROWS; a 400 (bad offset/limit/type) ⇒ invalid_input; a 200 body that isn't {meta,results} or a non-numeric meta.total ⇒ schema_drift (never a fake empty). awardAmount is number|null (a real $0 award is 0, an absent amount is null).",
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
    description:
      "Search awarded NSF research-GRANT awards (keyless; api.nsf.gov/services/v1/awards.json) — the NEW federal research-funding recipient-enrichment axis (who receives NSF research money, by organization / UEI / PI / state, joinable to SAM/USAspending via ueiNumber/parentUeiNumber). The grant-SIBLING of nih_reporter_search_projects on a different agency. LIVE-CONFIRMED-narrowing filters ONLY, module-built into a URLSearchParams query (NO raw passthrough): keyword (free text; MULTI-WORD is OR-tokenized — 'machine learning' = machine OR learning, disclosed in _meta.notes), awardeeStateCode (UPPERCASE 2-letter USPS enum — the SSRF + silent-zero guard; a non-state typo silently returns 0), awardeeName, ueiNumber (12-char UEI — an EXACT SAM/USAspending join), parentUeiNumber (parent-org roll-up), pdPIName, dateStart/dateEnd (STRICT mm/dd/yyyy on the award ACTION date — a wrong format is silently mis-parsed), limit (1..100, def 25 → rpp), offset (0..9999). Returns { awards:[{ id, title, agency, cfdaNumber, transType, awardee:{ name, city, stateCode, ueiNumber, parentUeiNumber }, performanceSite, principalInvestigator:{ fullName, firstName, lastName, middleInitial, email, id }, coPrincipalInvestigators, programOfficer, amounts:{ fundsObligatedAmt, estimatedTotalAmt, fundsObligatedByYear }, dates, program, activeAward, historicalAward }] } (abstract EXCLUDED — use nsf_get_award) + honest _meta. HONESTY: NSF Awards are RESEARCH GRANTS, NOT procurement contracts (ueiNumber joins to SAM/USAspending but the award nature differs — disclosed every response); totalAvailable = the EXACT metadata.totalCount below 10,000 and SATURATES at 10,000 (an ES track_total_hits cap ⇒ totalIsLowerBound:true + a note — the true total is ≥10,000 and only the first 10,000 are retrievable); NSF caps keyless retrieval at offset+rpp ≤ 10,000 (offset ≥ 10,000 ⇒ invalid_input; the outgoing rpp is clamped so a page never crosses the window). fundsObligatedAmt/estimatedTotalAmt arrive as STRINGS → number|null (a real $0 is 0, absent is null). Genuine-empty (totalCount:0) ⇒ complete:true/total:0; a serviceNotification at HTTP 200 (bad param / deep offset) ⇒ invalid_input/upstream_unavailable THROWS (never a fake empty); an outage/5xx/timeout THROWS; a 200 body that isn't {response:{award,metadata}} or a non-numeric totalCount ⇒ schema_drift. Feed a row's id to nsf_get_award for the full record + abstractText.",
    inputSchema: NsfSearchAwardsInput,
    handler: (input) => nsf.searchAwards(input),
  }),
  defineTool({
    name: "nsf_get_award",
    description:
      "Fetch ONE NSF award by its numeric award id (keyless; api.nsf.gov/services/v1/awards.json). Input `awardId` (all-digit, 5..9 digits — NSF ids are 7-digit numeric, live-verified; numeric-only is injection-safe). Returns { found, award:{ …the FULL curated record INCLUDING abstractText… } } + honest _meta. A nonexistent id ⇒ a genuine empty (totalCount:0) ⇒ found:false / award:null (NEVER a fabricated record). HONESTY: NSF Awards are RESEARCH GRANTS, NOT procurement contracts (ueiNumber joins to SAM/USAspending but the award nature differs — disclosed every response); fundsObligatedAmt/estimatedTotalAmt arrive as STRINGS → number|null (a real $0 is 0, absent is null); a serviceNotification at HTTP 200 ⇒ invalid_input/upstream_unavailable THROWS; an outage/5xx ⇒ THROWS; a 200 body that isn't {response:{award,metadata}} ⇒ schema_drift (never a fabricated record).",
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
    description:
      "Search federally-registered clinical-research studies with LEAD-SPONSOR / COLLABORATOR / ORGANIZATION / FUNDING-SOURCE entity enrichment (keyless; clinicaltrials.gov/api/v2/studies) — the trial-REGISTRATION axis of the research-funding entity layer (the sponsor/collaborator NAMES overlap the pharma/biotech/university/agency entities in NIH RePORTER / NSF Awards / SAM / USAspending). LIVE-CONFIRMED-narrowing filters ONLY, module-built into a URLSearchParams query (NO raw passthrough): query.term (broad free-text), sponsor (→query.spons — a fuzzy sponsor NAME search), condition (→query.cond), location (→query.locn), overallStatus (a frozen 14-value enum → filter.overallStatus), funderType (a frozen 4-value enum nih/fed/industry/other → aggFilters — the FEDERAL-funding axis), pageSize (1..1000, def 20), pageToken (the OPAQUE cursor). Returns { studies:[{ nctId, briefTitle, orgStudyId, organization:{ name, class }, leadSponsor:{ name, class }, collaborators:[{ name, class }], fundingClass, overallStatus, startDate, studyType, phases, conditions }] } (briefSummary EXCLUDED — use clinicaltrials_get_study) + honest _meta. HONESTY: countTotal=true is ALWAYS sent ⇒ totalAvailable = the EXACT filter-respecting UNCAPPED total (NEVER studies.length; a missing/non-number totalCount ⇒ schema_drift; a genuine 0 ⇒ 0, never null); pagination is an OPAQUE cursor (offset/nextOffset null; nextCursor = nextPageToken passed back verbatim as pageToken; terminal = token absent; a bad token ⇒ HTTP 400 THROWS). funderType is re-validated IN the handler — an UNLISTED value silently returns totalCount:0 at HTTP 200 (a fake-empty trap) ⇒ invalid_input pre-fetch (0 fetch); funderType is an OVERLAPPING facet (counts MUST NOT be summed). A MULTI-WORD query.term/sponsor/condition is AND-conjunctive (ALL tokens must co-occur — disclosed). A registered trial is NOT a federal award and leadSponsor.name is FREE TEXT (not a UEI) ⇒ a NOMINAL name match only (disclosed every response). Genuine-empty (totalCount:0, no token) ⇒ complete:true/total:0; a bad overallStatus/pageToken/nctId ⇒ HTTP 400/404 THROWS; an outage/5xx ⇒ THROWS (never a fake empty). Feed a row's nctId to clinicaltrials_get_study for the full record + briefSummary.",
    inputSchema: ClinicaltrialsSearchStudiesInput,
    handler: (input) => clinicaltrials.searchStudies(input),
  }),
  defineTool({
    name: "clinicaltrials_get_study",
    description:
      "Fetch ONE clinical study by its NCT id (keyless; clinicaltrials.gov/api/v2/studies/{nctId}). Input `nctId` (the form NCT followed by exactly 8 digits, e.g. NCT02403869 — validated before the path is built, injection-safe). Returns { found, nctId, study:{ …the FULL curated entity record INCLUDING briefSummary… } } + honest _meta. A nonexistent id ⇒ HTTP 404 ⇒ found:false / study:null (NEVER a fabricated record). HONESTY: a registered trial is NOT a federal award and leadSponsor.name is FREE TEXT (not a UEI) ⇒ a NOMINAL name match only (disclosed every response); a 200 body missing protocolSection ⇒ schema_drift; an outage/5xx ⇒ THROWS.",
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
    description:
      "Aggregate/statistical view: EXACT per-value STUDY counts over the WHOLE ClinicalTrials.gov registry for one or more whitelisted ENUM fields (keyless; clinicaltrials.gov/api/v2/stats/field/values) — the DISTRIBUTION sibling of clinicaltrials_search_studies (which gives the exact FILTERED total for a query). Input `fields`: 1..11 ENUM fields (deduped) — OverallStatus, StudyType, Phase, LeadSponsorClass (★ the funding-SOURCE-class distribution: NIH/FED/OTHER_GOV/INDUSTRY/OTHER/NETWORK/INDIV/UNKNOWN/AMBIG — richer than, and distinct from, the search tool's 4-value funderType filter), Sex, DesignAllocation, DesignPrimaryPurpose, DesignInterventionModel, DesignMasking, DesignObservationalModel, DesignTimePerspective. Module-built comma-joined into fields=<…> (NO raw passthrough). Returns { facets:[{ field, fieldPath, valueType, uniqueValuesCount, missingStudiesCount, returned, truncated, overlapping, values:[{ value, studiesCount }] }] } + honest _meta. HONESTY: each studiesCount/uniqueValuesCount is EXACT (typeof-checked to a NUMBER before num() — a non-number ⇒ schema_drift, NEVER a silent 0); a non-ENUM shape for a whitelisted field (e.g. a BOOLEAN {trueCount,falseCount}) ⇒ schema_drift (never read as empty). [M1] _meta.totalAvailable/returned count DISTINCT FIELD VALUES across the requested facet(s), NOT studies (a mandatory unit note points to facets[].values[].studiesCount / clinicaltrials_search_studies for a study count). These counts cover the ENTIRE registry and are NOT filterable — /stats/field/values rejects query.*/filter.*/countTotal/pageSize (HTTP 400) — a scope note cross-links the search tool for filtered totals. The returned<uniqueValuesCount⇒truncated invariant discloses the endpoint's hard 250-value cap the instant it binds (never for these v1 ENUM fields — all complete). Phase is ARRAY-valued (a study can carry several) ⇒ overlapping:true + a not-a-partition note (counts MUST NOT be summed); scalar fields partition the registry minus missingStudiesCount. A high missingStudiesCount ⇒ a note that the shown buckets cover a MINORITY of the registry. MANDATORY CAVEAT every response: a facet count is a distribution over trial REGISTRATIONS, NOT federal awards; LeadSponsorClass is the funding-SOURCE class, not a UEI-keyed award join. An unlisted field ⇒ invalid_input pre-fetch (0 fetch); a 404/400/5xx ⇒ THROWS (never a fake-empty distribution).",
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
    description:
      "Search EPA-regulated facilities by US state (+ optional sic / facilityName / majorOnly / federalOnly) with compliance/enforcement screening fields (EPA ECHO, keyless) — the NEW facility environmental compliance-risk / due-diligence axis (CAA/CWA/RCRA/SDWA violation, inspection, penalty, SNC history). Input `state` (REQUIRED enum — the SSRF + silent-zero guard), `sic` (2–4 digits, a REAL filter), `naics` (2–6 digits, BEST-EFFORT — ECHO DROPS it upstream, reported in _meta.filtersDropped + a note), `facilityName` (substring; a typo silently returns 0), `majorOnly`/`federalOnly` (bool), `limit` (≤1000, def 100), `offset` (multiple of limit). Returns { state, facilities:[…verbatim rows incl. RegistryID…], summary:{ queryRows, programCounts, totalPenalties } } + honest _meta. HONESTY: totalAvailable = the EXACT QueryRows total (NEVER the page size); a hidden two-step QueryID pagination fetches the rows (the QueryID is ephemeral/globally-recycled, never exposed); genuine-empty ⇒ complete:true/total:0; a queryset-limit overflow / bad query ⇒ invalid_input; an outage/5xx ⇒ THROWS (never a fake empty). Feed a row's RegistryID to echo_facility_report.",
    inputSchema: EchoSearchFacilitiesInput,
    handler: (input) => echo.searchFacilities(input),
  }),
  defineTool({
    name: "echo_facility_report",
    description:
      "Fetch the EPA ECHO Detailed Facility Report (DFR) for ONE facility by its FRS RegistryID (keyless) — the per-facility compliance / enforcement / inspection / permit deep-dive for competitor or acquisition-target due diligence. Input `registryId` (all-digit FRS id, 9–12 digits, from echo_search_facilities rows). Returns { registryId, report:{…verbatim compliance/enforcement/permit detail…} } + single-record _meta (complete:true, no pagination). A bad/unknown RegistryID ⇒ not_found (never a fabricated report).",
    inputSchema: EchoFacilityReportInput,
    handler: (input) => echo.facilityReport(input),
  }),
  // ━━━ api.data.gov keyed trio — Regulations.gov + Congress.gov (6) ━━━ ADR-0007/0044
  // The project's FIRST KEYED source. The key (DATA_GOV_API_KEY, else the public
  // DEMO_KEY) travels ONLY in the X-Api-Key header — never the URL/label/_meta.
  // keylessMode:false (genuinely keyed); a DEMO_KEY note discloses the shared
  // ~10 req/hr ceiling + the free-key upgrade path. ADR-0044 adds the two docket
  // tools (the rulemaking CONTAINER + its `rin` cross-source join key).
  defineTool({
    name: "regulations_search_documents",
    description:
      "Search Regulations.gov rulemaking DOCUMENTS (rules, proposed rules, notices) — the flagship of the api.data.gov keyed source (JSON:API; DATA_GOV_API_KEY or the shared DEMO_KEY). Input `searchTerm`/`query`, filters (agencyId, docketId, documentType, withinCommentPeriod, postedDateGe/Le YYYY-MM-DD), `sort` (def -postedDate), `pageNumber` (1..40 HARD cap), `pageSize` (5..250, def 25). Returns { documents:[{ id, documentType, title, agencyId, docketId, postedDate, commentEndDate, openForComment, withinCommentPeriod, frDocNum, objectId }] } + honest _meta. HONESTY: totalAvailable = meta.totalElements (the EXACT real total, ~millions), NOT the capped totalPages; page[number] is hard-capped at 40 (10,000-record ceiling) — at the ceiling hasMore stays true but nextOffset is null + a note says how to reach the rest (narrow filters / seek by lastModifiedDate). Genuine-empty ⇒ complete:true/total:0; an outage/4xx THROWS (never a fake empty).",
    inputSchema: RegulationsSearchInput,
    handler: (input) => datagov.searchDocuments(input),
  }),
  defineTool({
    name: "regulations_search_comments",
    description:
      "Search Regulations.gov public COMMENTS on rulemakings — the killer B2G dataset (who is lobbying which rule). Same JSON:API envelope + input shape as regulations_search_documents (searchTerm/query, agencyId, docketId, postedDateGe/Le, sort, pageNumber 1..40, pageSize 5..250) against /v4/comments. Returns { comments:[{ id, documentType, title, agencyId, docketId, postedDate, objectId }] } + honest _meta (same totalElements-exact total + 40-page/10,000-record ceiling handling as documents).",
    inputSchema: RegulationsSearchInput,
    handler: (input) => datagov.searchComments(input),
  }),
  defineTool({
    name: "congress_search_bills",
    description:
      "Search Congress.gov BILLS/legislation (api.data.gov keyed; DATA_GOV_API_KEY or DEMO_KEY). Input optional `congress` (e.g. 118), `billType` (hr/s/hjres/sjres/hconres/sconres/hres/sres — requires `congress`), `fromDateTime`/`toDateTime` (ISO-8601 with offset), `offset`, `limit` (≤250, def 20). Returns { bills:[{ congress, type, number, title, originChamber, latestAction, updateDate, url }] } + _meta with totalAvailable = pagination.count (EXACT). NOTE: /v3/bill has no keyword search, so a `query` arg is NOT applied and is disclosed in _meta.filtersDropped. Outage/4xx THROWS (never a fake empty).",
    inputSchema: CongressSearchBillsInput,
    handler: (input) => datagov.searchBills(input),
  }),
  defineTool({
    name: "congress_get_bill",
    description:
      "Fetch ONE Congress.gov bill by id via /v3/bill/{congress}/{billType}/{billNumber} (api.data.gov keyed; DATA_GOV_API_KEY or DEMO_KEY). Input `congress` (int), `billType` (enum), `billNumber` (int). Returns { bill:{…} } + single-record _meta. A nonexistent bill ⇒ not_found (never fabricated).",
    inputSchema: CongressGetBillInput,
    handler: (input) => datagov.getBill(input),
  }),
  defineTool({
    name: "regulations_search_dockets",
    description:
      "Search Regulations.gov DOCKETS — the rulemaking/nonrulemaking CONTAINER that groups every document + comment under one regulatory action (api.data.gov keyed; DATA_GOV_API_KEY or the shared DEMO_KEY). Input `searchTerm`/`query`, filters (agencyId, docketType Rulemaking/Nonrulemaking, lastModifiedDateGe/Le YYYY-MM-DD), `sort` (def -lastModifiedDate), `limit` (1..250, def 20), `pageNumber` (1..40 HARD cap). Returns { dockets:[{ docketId, title, agencyId, docketType, lastModifiedDate, objectId, id }] } + honest _meta. HONESTY: totalAvailable = meta.totalElements (the EXACT real total, ~277k), NOT the capped totalPages (a 40 sentinel — deriving a total from totalPages lies); page[number] is hard-capped at 40 (10,000-record ceiling) — at the ceiling hasMore stays true but nextOffset is null + a note on how to reach the rest (narrow filters). The API's page[size] floor is 5, so a limit<5 fetches 5 and returns the first `limit` rows client-side (disclosed; totalAvailable stays exact). NOTE: `rin` is NULL in list rows — call regulations_get_docket for a docket's rin. DEMO_KEY ~10 req/hr (every call, incl. errors, decrements) — set DATA_GOV_API_KEY for 1000/hr. Genuine-empty ⇒ complete:true/total:0; outage/4xx/429 THROWS (never a fake empty).",
    inputSchema: RegulationsSearchDocketsInput,
    handler: (input) => datagov.searchDockets(input),
  }),
  defineTool({
    name: "regulations_get_docket",
    description:
      "Fetch ONE Regulations.gov docket by id via /v4/dockets/{docketId} (api.data.gov keyed; DATA_GOV_API_KEY or DEMO_KEY) — the detail view where `rin` lives. Input `docketId` (e.g. 'BLM-2026-0001'; the ONLY path-segment value, charclass-validated — a bad id ⇒ invalid_input, 0 fetch). Returns { docket:{ docketId, title, agencyId, docketType, rin, dkAbstract, keywords, program, shortTitle, effectiveDate, modifyDate, objectId, id } } + single-record _meta (returned:1, totalAvailable:null, complete:true). HONESTY: `rin` (Regulatory Identifier Number) is the cross-source JOIN KEY to the Federal Register (fed_register_search_documents) and the Unified Agenda — null-when-absent (never '', e.g. many Nonrulemaking dockets have no assigned RIN), which is NOT a join failure. A nonexistent id ⇒ not_found (or schema_drift if the API returns a 200 error-envelope) — never a fabricated docket. DEMO_KEY ~10 req/hr; set DATA_GOV_API_KEY for 1000/hr.",
    inputSchema: RegulationsGetDocketInput,
    handler: (input) => datagov.getDocket(input),
  }),
  // ━━━ data.gov v4 Catalog API (api.gsa.gov) — CKAN-retirement replacement (1) ━━━ ADR-0046
  // Resilience Phase 3. data.gov RETIRED the CKAN package_search endpoint in 2025;
  // the v4 Catalog API restores federal open-dataset DISCOVERY as a NEW keyed source.
  // A DIFFERENT host (api.gsa.gov) than the datagov trio, but the SAME api.data.gov
  // key (X-Api-Key header, shared datagovKey.ts seam) — keylessMode:false. The v4
  // API reports NO match count ⇒ totalAvailable is NULL (P1, never results.length);
  // pagination is an OPAQUE `after` cursor (nextCursor passed back verbatim); the
  // dcat.accessLevel openness field is surfaced verbatim.
  defineTool({
    name: "datagov_search_datasets",
    description:
      "Search the data.gov DATASET CATALOG for federal open datasets across all publishing agencies (api.gsa.gov v4 Catalog API, keyed — DATA_GOV_API_KEY or the shared DEMO_KEY) — the replacement for the CKAN package_search endpoint data.gov RETIRED in 2025, restoring federal dataset DISCOVERY. Input `query` (→_q free-text), `organization` (publisher slug, e.g. 'epa-gov'), `limit` (1..100, def 20 → _size), `cursor` (the OPAQUE continuation → after). Returns { datasets:[{ id (slug), title, organization, description, accessLevel, license, landingPage, modified, lastHarvested, keywords, themes, distributions:[{ title, format }], identifier }] } + honest _meta. HONESTY: the v4 API reports NO total match count ⇒ totalAvailable is NULL (NEVER results.length, NEVER a fabricated total — a note discloses it); pagination is an OPAQUE cursor (offset/nextOffset null; nextCursor = the `after` token passed back verbatim as `cursor`; nextCursor:null / hasMore:false = last page). accessLevel is surfaced VERBATIM (public / restricted public / non-public) — the openness signal, null-when-absent (this tool DISCOVERS datasets; it does not ingest distributions). A genuine no-match (results:[], no cursor) ⇒ complete:true/returned:0; a 429 (DEMO_KEY ~10 req/hr, hit quickly) ⇒ rate_limited THROWS; a 5xx/timeout ⇒ upstream_unavailable THROWS; a 200 non-JSON / a non-array results ⇒ schema_drift (never a fake empty). DEMO_KEY ~10 req/hr shared ceiling — set DATA_GOV_API_KEY (free at api.data.gov/signup) for 1000/hr. The key rides ONLY in the X-Api-Key header (never the URL/_meta).",
    inputSchema: DatagovSearchDatasetsInput,
    handler: (input) => datagovCatalog.searchDatasets(input),
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
    description:
      "List the GovInfo collection catalog (GPO-authoritative publications; api.data.gov keyed — DATA_GOV_API_KEY or the shared DEMO_KEY). No input. Returns { collections:[{ collectionCode, collectionName, packageCount, granuleCount }] } + _meta (complete:true, totalAvailable = collection count). The discovery entry-point: feed a collectionCode to govinfo_search_packages. Memoized ~6h; also the validator source for search_packages' collection arg. packageCount = whole packages; granuleCount = sub-package granules (a missing count is null, never 0).",
    inputSchema: GovinfoListCollectionsInput,
    handler: () => govinfo.listCollections(),
  }),
  defineTool({
    name: "govinfo_search_packages",
    description:
      "Search GovInfo packages in a collection modified since a date (GPO-authoritative bulk publications; api.data.gov keyed). Input `collection` (uppercase code — validated against the live catalog; an unknown code ⇒ invalid_input listing valid codes, NEVER a misleading empty), `startDate`/`endDate?` (YYYY-MM-DD or ISO datetime; filters by lastModified — the record UPDATE date, NOT dateIssued — disclosed in _meta), `pageSize?` (1..1000, def 100), `pageMark?` (opaque cursor, def '*'). Returns { collection, packages:[{ packageId, title, dateIssued, lastModified, docClass, congress, packageLink }] } + cursor _meta. HONESTY: totalAvailable = count (the EXACT real total, NOT the page size); GovInfo uses an OPAQUE cursor, so pagination.offset/nextOffset are null — continue by passing _meta.nextCursor back as `pageMark` (hasMore:false / nextCursor:null = last page). The raw upstream nextPage URL is never surfaced (it embeds the key). Genuine-empty ⇒ complete:true/total:0; outage/4xx THROWS (never a fake empty). CFR/ECFR/FR collections carry a note routing to the ecfr_*/fed_register_* tools for point lookups.",
    inputSchema: GovinfoSearchPackagesInput,
    handler: (input) => govinfo.searchPackages(input),
  }),
  defineTool({
    name: "govinfo_get_package",
    description:
      "Fetch ONE GovInfo package's summary (metadata + download links txt/xml/pdf/mods/premis/zip + related links) by packageId (api.data.gov keyed). Input `packageId` (from govinfo_search_packages, e.g. 'BILLS-118hr1enr', 'PLAW-117publ58', 'CFR-2023-title1-vol1'). Returns { found:true, packageId, package:{…} } + single-record _meta (complete:true). A nonexistent packageId ⇒ found:false (HTTP 404, never a fabricated summary). Any api_key embedded in a download link is stripped key-free before the payload is surfaced.",
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
    description:
      "Resolve a one-line US address → its matched address(es) + the Census GEOGRAPHIES that drive set-aside / place-of-performance analysis (US Census Geocoder, keyless; geocoding.geo.census.gov/geocoder/geographies/onelineaddress) — the NEW territory/geospatial domain. Input `address` (≤500 chars), optional `benchmark` (default Public_AR_Current) / `vintage` (default Current_Current). Returns { matches:[{ matchedAddress, coordinates:{x,y}, tigerLineId, addressComponents, geographies:{ state, county, congressionalDistrict, censusTract, censusBlock, place, cbsaOrCsa, stateLegislativeUpper, stateLegislativeLower } }], matchCount, vintageResolved } + honest _meta. Each geography = { layerKey (the RAW vintage-versioned key, e.g. '119th Congressional Districts'), geoid (a STRING — leading zeros survive: '0102'), name }. HONESTY: genuine-empty (addressMatches:[]) ⇒ matchCount:0/complete:true (NOT an error; verify spelling + add city/state/ZIP); MULTIPLE matches are ALL surfaced (each with its own geographies) + a note; a historical vintage can return >1 layer per type (e.g. 111th+113th Congressional Districts with DISTINCT GEOIDs for a redistricted place) ⇒ BOTH surfaced (chosen + alternates[]) + a mandatory note (NEVER silently dropped); the resolved benchmark/vintage is echoed + a 'Current is a MOVING vintage' note; an invalid/missing benchmark/vintage ⇒ HTTP 400 THROWS (never a fake empty); an outage/5xx ⇒ THROWS. MANDATORY CAVEAT every response: these are a NOMINAL input, NOT an authoritative HUBZone / Opportunity-Zone / set-aside determination (those require SBA's HUBZone map / Treasury's OZ-tract list). Feed censusTract.geoid / county.geoid onward to those authoritative sources.",
    inputSchema: CensusGeocodeAddressInput,
    handler: (input) => census.geocodeAddress(input),
  }),
  defineTool({
    name: "census_geographies_by_coordinates",
    description:
      "Resolve a longitude/latitude point → the Census GEOGRAPHIES at that point, no address parsing (US Census Geocoder, keyless; geocoding.geo.census.gov/geocoder/geographies/coordinates). For a caller that already holds coordinates. Input `longitude`/`x` (required, -180..180) + `latitude`/`y` (required, -90..90) — x=longitude, y=latitude (the Census API's own names; `longitude`/`latitude` are the clearer aliases), optional `benchmark`/`vintage`. Returns { found, coordinates:{x,y}, geographies:{ state, county, congressionalDistrict, censusTract, censusBlock, place, cbsaOrCsa, stateLegislativeUpper, stateLegislativeLower }, vintageResolved } + honest _meta. HONESTY: a point outside any US Census geography (offshore / out-of-US) ⇒ geographies all null / found:false / complete:true (an honest empty geographies:{}, NOT an error); coordinate finiteness is re-guarded PRE-fetch (a non-finite x/y ⇒ invalid_input, 0 fetch); a historical vintage's >1-layer-per-type is surfaced with alternates[] + a note (same [B1] multi-key handling as the address tool); GEOIDs are STRINGS (leading zeros survive); the resolved benchmark/vintage is echoed + a moving-vintage note; a bad benchmark/vintage ⇒ HTTP 400 THROWS; an outage/5xx ⇒ THROWS. MANDATORY CAVEAT every response: these are a NOMINAL input, NOT an authoritative HUBZone / Opportunity-Zone / set-aside determination.",
    inputSchema: CensusGeographiesByCoordinatesInput,
    handler: (input) => census.geographiesByCoordinates(input),
  }),
  // ━━━ US Census County Business Patterns — market sizing (1) ━━━ ADR-0047
  // ★The server's FIRST KEY-REQUIRED source: the Census Data API removed its
  // keyless tier, so WITHOUT a CENSUS_API_KEY this tool throws an honest
  // invalid_input config error (most other tools are keyless — see api_key_status). NAICS×geography
  // establishments / employment / annual payroll — the demand-side market-sizing
  // lane. Census negative suppression sentinels (-999999999 …) map to null (never
  // a negative number / never 0). The 2D-array body is parsed by header name.
  defineTool({
    name: "census_business_patterns",
    description:
      "Market sizing by NAICS × geography — establishments, employment, and annual payroll from the US Census County Business Patterns (CBP) API (api.census.gov/data/{year}/cbp). ★REQUIRES a free CENSUS_API_KEY: the Census Data API has NO keyless tier, so without the key this tool THROWS an honest config error (get one at https://api.census.gov/data/key_signup.html; call api_key_status to see every source's key requirement). Input: optional `naics` (2–6 digit NAICS-2017, e.g. '5415'; omit to aggregate all sectors), `geography` (us|state|county, default us; county REQUIRES `state`), `state` (2-digit FIPS, e.g. '06'), `year` (default '2022'), optional `limit` (client-side top-N; CBP has no server pagination). Returns { rows:[{ name, geoId, naicsCode, naicsLabel, establishments, employees, annualPayrollUsd, state }] } + honest _meta. HONESTY: establishments/employees are integer counts and annualPayrollUsd is annual US dollars (×1000 from the source's $1,000-unit PAYANN); large-negative suppression sentinels map to null — NEVER a negative number and NEVER 0 (a genuine 0 stays 0; note CBP primarily uses noise-infusion + suppression flags, surfaced as reported — see the tool's suppression note); geoId/naicsCode/state are STRINGS (leading zeros survive). CBP returns the COMPLETE geography set for the filter (no pagination) ⇒ totalAvailable = the row count, complete:true. A missing/invalid key ⇒ invalid_input (a 302 to the Missing-Key page); a header-only body ⇒ honest empty (returned:0); a 5xx ⇒ THROWS; a 200 non-JSON ⇒ schema_drift. The key rides ONLY in the &key= query param — never logged or echoed.",
    inputSchema: CensusBusinessPatternsInput,
    handler: (input) => censusEconomic.businessPatterns(input),
  }),
  // ━━━ EPA Envirofacts TRI facilities — environmental footprint (1) ━━━ ADR-0059
  // KEYLESS (data.epa.gov /efservice/tri_facility). ★Two requests: a count
  // sub-query yields the EXACT total (P1 — TOTALQUERYRESULTS, e.g. VA=1247), then
  // the data slice. All user values ride as PATH SEGMENTS → each is
  // charclass-validated + encodeURIComponent-encoded (the load-bearing SSRF guard).
  defineTool({
    name: "epa_tri_facilities",
    description:
      "Look up EPA Toxics Release Inventory (TRI) reporting facilities by state / facility-name / county — an environmental-footprint / place-of-performance screen (EPA Envirofacts, keyless; data.epa.gov/efservice/tri_facility). Input: `state` (2-letter, e.g. 'VA'), `facilityName` (partial match, e.g. 'chemical'), `county` (partial match) — provide at least `state` OR `facilityName` (an all-empty query is refused); optional `limit` (1–100, default 25), `offset`. Returns { facilities:[{ triFacilityId, facilityName, streetAddress, city, county, state, zip, region, closed }] } + honest _meta. ★HONESTY: totalAvailable is the EXACT count from a SEPARATE count sub-query (…/count/JSON → TOTALQUERYRESULTS), NEVER the returned-rows length; if that count fails, totalAvailable is null + a disclosing note (never length-faked). offset/limit pagination (hasMore = offset+returned < total). `closed` normalizes fac_closed_ind ('0'/'N'→false, '1'/'Y'→true, unrecognized→null — never a fabricated false); addresses/names are null-never-empty-string. A genuine no-match ⇒ honest empty (returned:0); a 4xx ⇒ invalid_input/not_found; a 5xx ⇒ THROWS; a 200 non-array/non-JSON ⇒ schema_drift. These are nominal TRI reporters, NOT a compliance/enforcement determination. KEYLESS — no key is sent.",
    inputSchema: EpaTriFacilitiesInput,
    handler: (input) => epaEnvirofacts.triFacilities(input),
  }),
  // ━━━ CMS Medicare provider-service utilization — healthcare market (1) ━━━ ADR-0061
  // KEYLESS (data.cms.gov /data-api/v1/dataset/{uuid}). ★Two requests: a stats
  // count sub-query yields the EXACT per-filter total (P1 — found_rows, e.g.
  // VA=278254), then the data slice (a bare JSON array). All filter VALUES ride via
  // URLSearchParams (bracket key + value encoded — the SSRF guard). REQUIRE npi OR
  // state (the 9.78M-row table is never scanned unscoped). The dataset UUID is a
  // SPECIFIC ANNUAL VINTAGE (surfaced in a _meta note; update yearly).
  defineTool({
    name: "cms_medicare_provider_services",
    description:
      "Look up Medicare Part-B provider utilization — for a given provider (NPI) or state, the HCPCS services rendered, beneficiaries served, and submitted / Medicare-allowed / Medicare-paid amounts (CMS 'Medicare Physician & Other Practitioners — by Provider and Service', keyless; data.cms.gov data-API). The demand-side complement to nppes_lookup_provider (who providers ARE → what they BILL) for healthcare-market / competitor / teaming due-diligence. Input: `npi` (10-digit) OR `state` (2-letter) — at least ONE is REQUIRED (the table is 9.78M rows; an all-empty query is refused; providerType/hcpcsCode alone are NOT enough to scope); optional `providerType` (exact CMS specialty, e.g. 'Family Practice'), `hcpcsCode` (e.g. '97110', 'G0463'), `size` (1–100, default 25), `offset`. Returns { services:[{ npi, providerName, credentials, providerType, city, state, zip, hcpcsCode, hcpcsDescription, totalBeneficiaries, totalServices, avgSubmittedCharge, avgMedicareAllowed, avgMedicarePayment }] } + honest _meta. ★HONESTY: totalAvailable is the EXACT count from a SEPARATE stats sub-query (…/data-viewer/stats → found_rows, e.g. VA=278254), NEVER the returned-rows length; if that count fails, totalAvailable is null + a disclosing note (never length-faked). offset/size pagination (hasMore = offset+returned < total). Aggregate/payment values are numeric-string → number|null (a genuine 0 stays 0, absent → null, never 0-faked); NPI/HCPCS/names are null-never-empty-string. A genuine no-match ⇒ honest empty (returned:0); a 4xx ⇒ invalid_input/not_found; a 5xx ⇒ THROWS; a 200 non-array/non-JSON ⇒ schema_drift. These are public PROVIDER-level AGGREGATE figures (no patient identifiers) for ONE annual vintage (the dataset year is disclosed in _meta) — a utilization snapshot, NOT a fraud/quality/fitness determination. KEYLESS — no key is sent.",
    inputSchema: CmsMedicareProviderServicesInput,
    handler: (input) => cmsUtilization.providerServices(input),
  }),
  // ━━━ CMS Hospital Compare — Hospital General Information (1) ━━━ ADR-0062
  // KEYLESS (data.cms.gov /provider-data/api/1/datastore/query/{datasetId}). A
  // SINGLE request: the response's top-level `count` is the EXACT per-filter total
  // (P1 — VA=96), never the slice length. Filters ride as DKAN conditions[] triples
  // via URLSearchParams (bracket key + value encoded — the SSRF guard): state is an
  // EXACT match, facilityName/hospitalType are case-insensitive substring matches,
  // AND-combined server-side. REQUIRE state OR facilityName (never scanned unscoped).
  defineTool({
    name: "cms_hospital_compare",
    description:
      "Look up Medicare-certified hospitals by US state and/or facility-name fragment — location, type, ownership, emergency-services flag, and CMS star rating (CMS Hospital Compare 'Hospital General Information', keyless; data.cms.gov provider-data datastore-query API, ~5,432 hospitals). A healthcare-facility directory / market-map lane (WHERE hospitals are and HOW CMS rates them). Input: `state` (2-letter, EXACT) OR `facilityName` (a name fragment, case-insensitive substring/contains match) — at least ONE is REQUIRED (an all-empty query is refused; hospitalType alone is NOT enough to scope); optional `hospitalType` (substring, e.g. 'Acute', 'Critical Access'), `size` (1–100, default 25), `offset`. Returns { hospitals:[{ facilityId, facilityName, address, city, state, zip, county, phone, hospitalType, ownership, emergencyServices, overallRating }] } + honest _meta. ★HONESTY: totalAvailable is the response's EXACT top-level `count` for the filter set (VA=96), NEVER the returned-rows length; offset/size pagination (hasMore = offset+returned < count). overallRating is CMS's 1–5 star rating as a number; 'Not Available'/blank/non-numeric ⇒ null (NEVER 0). emergencyServices normalizes 'Yes'⇒true / 'No'⇒false / else null (never a fabricated false). IDs/names/addresses are null-never-empty-string. A genuine no-match ⇒ honest empty (returned:0); a 4xx ⇒ invalid_input/not_found; a 5xx ⇒ THROWS; a 200 non-array body or one missing count/results ⇒ schema_drift. Filters are applied SERVER-SIDE (AND-combined) — nothing is silently dropped. This is a summary star rating, NOT a clinical-quality or fitness determination. KEYLESS — no key is sent.",
    inputSchema: CmsHospitalCompareInput,
    handler: (input) => cmsHospital.hospitalCompare(input),
  }),
  // ━━━ CMS Facility Directory — 4 provider-data datasets (1) ━━━ ADR-0063
  // KEYLESS (data.cms.gov /provider-data/api/1/datastore/query/{datasetId}). A
  // generalization of cms_hospital_compare beyond hospitals: facilityType (a Zod
  // enum) indexes a CONSTANT map to a VETTED dataset id — the user value never enters
  // the path (the load-bearing SSRF guard). A SINGLE request: the response's top-level
  // `count` is the EXACT per-filter total (P1). name/address/ownership columns vary
  // per dataset → coalesced (null if none — never empty-string, never fabricated).
  defineTool({
    name: "cms_facility_directory",
    description:
      "Look up Medicare/Medicaid-certified healthcare FACILITIES by type — nursing homes, home health agencies, hospices, or dialysis facilities — with their name, address, city, state, zip, and ownership (CMS provider-data, keyless; data.cms.gov datastore-query API, four datasets). A healthcare-facility directory / market-map lane that generalizes cms_hospital_compare beyond hospitals. Input: `facilityType` (REQUIRED enum — 'nursing_home' ~14,695 / 'home_health' ~12,460 / 'hospice' ~6,852 / 'dialysis' ~7,490; selects the dataset id via a constant map, the value never enters the URL path), optional `state` (2-letter, EXACT), `facilityName` (a name fragment, case-insensitive substring/contains match against the dataset's primary-name column), `size` (1–100, default 25), `offset`. Returns { facilities:[{ name, address, city, state, zip, facilityType, ownership }] } + honest _meta. ★HONESTY: totalAvailable is the response's EXACT top-level `count` for the filter set, NEVER the returned-rows length; offset/size pagination (hasMore = offset+returned < count). name/address/ownership column names DIFFER across the four datasets, so each is COALESCED over per-dataset candidates (name: provider_name/facility_name/legal_business_name; address: address/provider_address/address_line_1; ownership: ownership_type/type_of_ownership/profit_or_nonprofit) — a field absent in the chosen dataset is null (unknown), NEVER an empty string and NEVER fabricated. facilityType is echoed on each row. A genuine no-match ⇒ honest empty (returned:0); an invalid facilityType ⇒ invalid_input (blocked by the enum); a 4xx ⇒ invalid_input/not_found; a 5xx ⇒ THROWS; a 200 non-array body or one missing count/results ⇒ schema_drift. Filters are applied SERVER-SIDE (AND-combined) — nothing is silently dropped. This is a facility directory, NOT a clinical-quality or fitness determination. KEYLESS — no key is sent.",
    inputSchema: CmsFacilityDirectoryInput,
    handler: (input) => cmsFacility.facilityDirectory(input),
  }),
  // ━━━ CMS DMEPOS by Supplier — supply-side utilization (1) ━━━ ADR-0064
  // KEYLESS (data.cms.gov /data-api/v1/dataset/{uuid}). ★Two requests: a stats count
  // sub-query yields the EXACT per-filter total (P1 — found_rows), then the data slice
  // (a bare JSON array). All filter VALUES ride via URLSearchParams (bracket key +
  // value encoded — the SSRF guard). REQUIRE npi OR state (the supplier table is never
  // scanned unscoped). The dataset UUID is a SPECIFIC ANNUAL VINTAGE (update yearly).
  defineTool({
    name: "cms_dmepos_suppliers",
    description:
      "Look up Medicare DMEPOS (Durable Medical Equipment, Devices & Supplies) SUPPLIERS — for a given supplier (NPI) or state, the supplier's identity plus aggregate Medicare figures: HCPCS codes billed, beneficiaries served, claims, services, and submitted / Medicare-allowed / Medicare-paid amounts (CMS 'Medicare DMEPOS — by Supplier', keyless; data.cms.gov data-API). The supply-side complement to cms_medicare_provider_services for healthcare-market / competitor / teaming due-diligence on equipment suppliers. Input: `npi` (10-digit) OR `state` (2-letter) — at least ONE is REQUIRED (an all-empty query is refused; the supplier table is never scanned unscoped); optional `size` (1–100, default 25), `offset`. Returns { suppliers:[{ npi, supplierName, credentials, entityType, city, state, zip, totalHcpcsCodes, totalBeneficiaries, totalClaims, totalServices, submittedCharges, medicareAllowed, medicarePayment }] } + honest _meta. ★HONESTY: totalAvailable is the EXACT count from a SEPARATE stats sub-query (…/data-viewer/stats → found_rows), NEVER the returned-rows length; if that count fails, totalAvailable is null + a disclosing note (never length-faked). offset/size pagination (hasMore = offset+returned < total). Aggregate/payment values are numeric-string → number|null (a genuine 0 stays 0, absent → null, never 0-faked); NPI/entityType/names are null-never-empty-string; supplierName joins Last_Name_Org + First_Name ('Last, First' for individuals, the org name alone for organizations). A genuine no-match ⇒ honest empty (returned:0); a 4xx ⇒ invalid_input/not_found; a 5xx ⇒ THROWS; a 200 non-array/non-JSON ⇒ schema_drift. These are public SUPPLIER-level AGGREGATE figures (no patient identifiers) for ONE annual vintage (disclosed in _meta) — a utilization snapshot, NOT a fraud/quality/fitness determination. KEYLESS — no key is sent.",
    inputSchema: CmsDmeposSuppliersInput,
    handler: (input) => cmsSupplier.dmeposSuppliers(input),
  }),
  // ━━━ CMS Revoked Medicare Providers & Suppliers — vetting/exclusion list (1) ━━━ ADR-0064
  // KEYLESS (data.cms.gov /data-api/v1/dataset/{uuid}). A legally-published
  // revocation/exclusion register (~7,059 rows) — the SAME vetting class as the OFAC /
  // SAM exclusion lists already shipped (surfacing the names IS the point). ALL filters
  // optional (small table — pagination is fine unfiltered). SAME two-request stats-count
  // P1 pattern; filter VALUES ride via URLSearchParams (bracket key + value encoded).
  defineTool({
    name: "cms_revoked_providers",
    description:
      "Search CMS's PUBLIC 'Revoked Medicare Providers & Suppliers' list — the legally-published register of Medicare enrollment revocations, with the revoked provider/supplier's identity, provider type, revocation reason, effective date, and re-enrollment-bar expiration (CMS 'Revoked Providers and Suppliers', keyless; data.cms.gov data-API, ~7,059 rows). A vetting / due-diligence lane in the SAME class as the OFAC / SAM-exclusions lists — for screening a counterparty before teaming or subcontracting. Input (ALL optional — the ~7K-row list is safe to page unfiltered): `npi` (10-digit → NPI), `state` (2-letter → STATE_CD, exact), `lastName` (→ LAST_NAME, exact), `size` (1–100, default 25), `offset`. Returns { revocations:[{ enrollmentId, npi, name, state, providerType, revocationReason, revocationEffectiveDate, reenrollmentBarExpiration }] } + honest _meta (which notes this is CMS's public revocation/exclusion list — a due-diligence signal, NOT a current-eligibility, guilt, or fitness determination). ★HONESTY: totalAvailable is the EXACT count from a SEPARATE stats sub-query (…/data-viewer/stats → found_rows), NEVER the returned-rows length; if that count fails, totalAvailable is null + a disclosing note (never length-faked). offset/size pagination (hasMore = offset+returned < total). name coalesces ORG_NAME (organizations) else FIRST_NAME + LAST_NAME (individuals) — null if none, never a fabricated empty; NPI/reasons/dates are strings (null-never-empty-string). A genuine no-match ⇒ honest empty (returned:0); a 4xx ⇒ invalid_input/not_found; a 5xx ⇒ THROWS; a 200 non-array/non-JSON ⇒ schema_drift. KEYLESS — no key is sent.",
    inputSchema: CmsRevokedProvidersInput,
    handler: (input) => cmsSupplier.revokedProviders(input),
  }),
  // ━━━ FRED (Federal Reserve Economic Data) — macro context (2) ━━━ ADR-0048
  // ★The server's SECOND KEY-REQUIRED source: FRED has NO keyless tier, so WITHOUT
  // a FRED_API_KEY both tools throw an honest invalid_input config error (the other
  // 112 tools stay keyless). GDP/CPI/rates/unemployment/PPI — the macro backdrop for
  // bid escalation / market timing. A missing observation ('.') maps to null (never 0).
  defineTool({
    name: "fred_search_series",
    description:
      "Discover FRED economic series (GDP, CPI, interest rates, unemployment, PPI…) by free-text search (FRED /fred/series/search; api.stlouisfed.org). ★REQUIRES a free FRED_API_KEY: FRED has NO keyless tier, so without the key this tool THROWS an honest config error (get one at https://fred.stlouisfed.org/docs/api/api_key.html; fred_series_observations shares this key — call api_key_status to see every source's key requirement). Input: `query` (the search_text, required, e.g. 'unemployment rate' / 'CPI' / '10-year treasury'), optional `limit` (default 25, max 1000), `offset`. Returns { series:[{ id, title, frequency, frequencyShort, units, seasonalAdjustment, observationStart, observationEnd, lastUpdated, popularity }] } + honest _meta. Feed `id` into fred_series_observations for the time series. HONESTY: totalAvailable is FRED's EXACT reported `count` (offset pagination via hasMore/nextOffset — never fabricated); every scalar is null-never-empty-string; a genuine no-match ⇒ honest empty (returned:0); a 400 (bad/missing key) ⇒ invalid_input CARRYING FRED's error_message; a 5xx ⇒ THROWS; a 200 non-JSON / non-array `seriess` ⇒ schema_drift. The key rides ONLY in the &api_key= query param — never logged or echoed.",
    inputSchema: FredSearchSeriesInput,
    handler: (input) => fred.searchSeries(input),
  }),
  defineTool({
    name: "fred_series_observations",
    description:
      "Fetch a FRED series' time series of date/value observations (FRED /fred/series/observations; api.stlouisfed.org). ★REQUIRES a free FRED_API_KEY (FRED has NO keyless tier — without it this tool THROWS an honest config error; get one at https://fred.stlouisfed.org/docs/api/api_key.html). Input: `seriesId` (required, e.g. 'GDP', 'CPIAUCSL', 'UNRATE', 'DGS10', 'PPIACO'; discover with fred_search_series), optional `startDate`/`endDate` (YYYY-MM-DD), `limit` (default 100, max 100000), `offset`, `sortOrder` (asc|desc). Returns { observations:[{ date, value }] } + honest _meta. ★MISSING-VALUE HONESTY (the crux): FRED encodes a missing observation as the literal '.', which maps to value:null (missing) — NEVER 0; a genuine reported 0 is preserved as 0. HONESTY: totalAvailable is FRED's EXACT `count` (offset pagination via hasMore/nextOffset — never fabricated); a 400 (bad seriesId / missing key) ⇒ invalid_input CARRYING FRED's error_message (never a fake empty); a genuine empty ⇒ honest empty; a 5xx ⇒ THROWS; a 200 non-JSON / non-array `observations` ⇒ schema_drift. seriesId is charclass-validated (^[A-Za-z0-9._-]+$) and dates are YYYY-MM-DD; the key rides ONLY in the &api_key= query param.",
    inputSchema: FredSeriesObservationsInput,
    handler: (input) => fred.seriesObservations(input),
  }),
  // ━━━ openFDA recall/enforcement (api.fda.gov) — product-safety recalls (1) ━━━ ADR-0054
  // KEYLESS with an OPTIONAL OPENFDA_API_KEY (raises the rate limit; keyless works
  // ~1000/day — it NEVER throws for a missing key, unlike the key-REQUIRED sources).
  // Structured filters ONLY (no raw Lucene passthrough — the tool assembles + escapes
  // the search= string, injection-safe). ★P1: totalAvailable = meta.results.total
  // (EXACT). ★P2 crux: a no-match query returns openFDA HTTP 404 NOT_FOUND ⇒ an honest
  // empty, never a throw. The optional key rides &api_key= ONLY.
  defineTool({
    name: "openfda_enforcement",
    description:
      "Search openFDA recall/enforcement records — drug/device/food product recalls with the recalling firm, product, reason, FDA classification (Class I/II/III), status, and geography (openFDA /{category}/enforcement.json; api.fda.gov). KEYLESS (an OPTIONAL free OPENFDA_API_KEY only RAISES the rate limit — keyless works at ~1000 requests/day; it NEVER throws for a missing key; get one at https://open.fda.gov/apis/authentication/; call api_key_status to see every source's key requirement). Input: `category` (drug|device|food, default drug), and STRUCTURED filters — `firm` (→recalling_firm), `product` (→product_description), `reason` (→reason_for_recall), `classification` (Class I|II|III), `status` (e.g. Ongoing/Terminated/Completed), `state` (2-letter, e.g. 'CA') — the tool safely assembles + escapes these into the openFDA search= Lucene string (NO raw passthrough — injection-safe), plus `limit` (1..100, default 25) and `skip` (offset ≥0). Returns { recalls:[{ recallingFirm, productDescription, reasonForRecall, classification, status, state, city, recallInitiationDate, recallNumber, voluntaryMandated, distributionPattern }] } + honest _meta. HONESTY: totalAvailable is openFDA's EXACT meta.results.total (skip/limit pagination via hasMore/nextOffset — never results.length); every scalar (dates included, recall_initiation_date is a YYYYMMDD string) is null-never-empty-string. ★A no-match query returns openFDA HTTP 404 NOT_FOUND ⇒ an HONEST EMPTY (returned:0, totalAvailable:0), NOT an error; a 400 syntax error ⇒ invalid_input surfacing openFDA's message; a 5xx ⇒ THROWS; a 200 non-JSON ⇒ schema_drift. The optional key rides ONLY the &api_key= query param — never logged or echoed.",
    inputSchema: OpenfdaEnforcementInput,
    handler: (input) => openfda.enforcement(input),
  }),
  // ━━━ openFDA 510(k) device clearances (api.fda.gov) — medical-device regulatory (1) ━━━ ADR-0056
  // KEYLESS with an OPTIONAL OPENFDA_API_KEY (raises the rate limit; keyless works
  // ~1000/day — never throws for a missing key). SAME source/envelope/crux as
  // openfda_enforcement (reuses openfda.ts's fetchOpenfda/readOpenfdaError/luceneQuote).
  // Structured filters ONLY (no raw Lucene passthrough — the tool assembles + escapes the
  // search= string, injection-safe). ★P1: totalAvailable = meta.results.total (EXACT,
  // ~175507). ★P2 crux: a no-match query returns openFDA HTTP 404 NOT_FOUND ⇒ an honest
  // empty, never a throw. The optional key rides &api_key= ONLY.
  defineTool({
    name: "openfda_device_clearances",
    description:
      "Search openFDA 510(k) DEVICE CLEARANCES — the FDA's premarket-notification (510(k)) clearances for medical devices, with the applicant/manufacturer, device name, clearance number (K-number), decision (date + description), clearance type, product code, advisory committee, and geography (openFDA /device/510k.json; api.fda.gov). KEYLESS (an OPTIONAL free OPENFDA_API_KEY only RAISES the rate limit — keyless works at ~1000 requests/day; it NEVER throws for a missing key; get one at https://open.fda.gov/apis/authentication/; call api_key_status to see every source's key requirement). Input: STRUCTURED filters — `applicant` (→applicant), `deviceName` (→device_name), `productCode` (→product_code), `clearanceType` (→clearance_type, e.g. Traditional/Special/Abbreviated), `kNumber` (→k_number, e.g. 'K123456'), `state` (2-letter, e.g. 'CA') — the tool safely assembles + escapes these into the openFDA search= Lucene string (NO raw passthrough — injection-safe), plus `limit` (1..100, default 25) and `skip` (offset ≥0). Returns { clearances:[{ applicant, deviceName, kNumber, decisionDate, decisionDescription, clearanceType, productCode, advisoryCommittee, state }] } + honest _meta. HONESTY: totalAvailable is openFDA's EXACT meta.results.total (skip/limit pagination via hasMore/nextOffset — never results.length); every scalar (dates included, decision_date is a YYYY-MM-DD string) is null-never-empty-string. ★A no-match query returns openFDA HTTP 404 NOT_FOUND ⇒ an HONEST EMPTY (returned:0, totalAvailable:0), NOT an error; a 400 syntax error ⇒ invalid_input surfacing openFDA's message; a 5xx ⇒ THROWS; a 200 non-JSON ⇒ schema_drift. The optional key rides ONLY the &api_key= query param — never logged or echoed.",
    inputSchema: OpenfdaDeviceClearancesInput,
    handler: (input) => openfdaDevice.deviceClearances(input),
  }),
  // ━━━ NHTSA vehicle safety (api.nhtsa.gov) — vehicle/parts supplier vetting (2) ━━━ ADR-0057
  // ★KEYLESS — no API key at all (no parameter, no header). The cross-agency
  // product-safety family alongside openFDA (medical). Both tools share
  // make/model/modelYear inputs and return the COMPLETE matching set (no pagination
  // ⇒ totalAvailable = the upstream Count/count, complete:true). ★The complaints VIN
  // (an individual-vehicle PII identifier) is EXCLUDED from the output.
  defineTool({
    name: "nhtsa_recalls",
    description:
      "Look up NHTSA vehicle safety RECALLS for a specific vehicle — the manufacturer's recall campaigns with the affected component, the safety consequence, the remedy, and 'do not drive'/'park outside'/over-the-air-update flags (NHTSA /recalls/recallsByVehicle; api.nhtsa.gov). KEYLESS — no API key is required or accepted. Input: `make` (required, e.g. 'honda'), `model` (required, e.g. 'accord'), `modelYear` (required, 4-digit, e.g. '2020'). Returns { recalls:[{ campaignNumber, manufacturer, component, summary, consequence, remedy, reportReceivedDate, parkIt, parkOutside, overTheAirUpdate }] } + honest _meta. HONESTY: totalAvailable is NHTSA's EXACT Count and NHTSA returns the COMPLETE set for the vehicle (no pagination) ⇒ complete:true; a no-match (Count 0 / a bad make/model) ⇒ an HONEST EMPTY (returned:0), NOT an error; a 4xx ⇒ invalid_input; a 5xx/timeout ⇒ THROWS; a 200 non-JSON ⇒ schema_drift. The park-it/park-outside/over-the-air-update flags are preserved as booleans (never a fabricated false); dates are strings; every scalar is null-never-empty-string. Fixed host api.nhtsa.gov (SSRF-guarded); make/model are letters/digits/space/hyphen only and modelYear is ^\\d{4}$.",
    inputSchema: NhtsaVehicleInput,
    handler: (input) => nhtsa.recalls(input),
  }),
  defineTool({
    name: "nhtsa_complaints",
    description:
      "Look up NHTSA consumer COMPLAINTS for a specific vehicle — owner-filed safety complaints with the affected component, crash/fire flags, injury/death counts, and incident/filing dates (NHTSA /complaints/complaintsByVehicle; api.nhtsa.gov). KEYLESS — no API key is required or accepted. Input: `make` (required, e.g. 'honda'), `model` (required, e.g. 'accord'), `modelYear` (required, 4-digit, e.g. '2020'). Returns { complaints:[{ odiNumber, manufacturer, component, summary, crash, fire, numberOfInjuries, numberOfDeaths, dateOfIncident, dateComplaintFiled }] } + honest _meta. ★PRIVACY: the NHTSA complaint VIN (an individual-vehicle identifier) is INTENTIONALLY EXCLUDED from the output — the B2G signal is the manufacturer/component/crash/fire/injury/death safety history, not the VIN. HONESTY: totalAvailable is NHTSA's EXACT count and NHTSA returns the COMPLETE set for the vehicle (no pagination) ⇒ complete:true; a no-match ⇒ an HONEST EMPTY (returned:0), NOT an error; crash/fire preserved as booleans (never a fabricated false); numberOfInjuries/numberOfDeaths via numeric coercion (a genuine 0 stays 0, NEVER null-for-0); dates are strings; a 4xx ⇒ invalid_input; a 5xx/timeout ⇒ THROWS; a 200 non-JSON ⇒ schema_drift. Fixed host api.nhtsa.gov (SSRF-guarded); make/model are letters/digits/space/hyphen only and modelYear is ^\\d{4}$.",
    inputSchema: NhtsaVehicleInput,
    handler: (input) => nhtsa.complaints(input),
  }),
  // ━━━ CPSC consumer-product recalls (www.saferproducts.gov) — goods/import vetting (1) ━━━ ADR-0058
  // ★KEYLESS — no API key at all (no parameter, no header). The third leg of the
  // cross-agency product-safety family alongside NHTSA (vehicles) and openFDA
  // (medical). The response is a bare JSON ARRAY with NO total-count field and NO
  // pagination ⇒ totalAvailable = the returned count, complete:true. All filters are
  // optional; with NO filter the tool bounds results to a ~90-day default window
  // (disclosed) rather than silently fetch the entire dataset.
  defineTool({
    name: "cpsc_recalls",
    description:
      "Look up U.S. CPSC consumer-product RECALLS — the recall title, hazard description, remedy, affected products, manufacturers, retailers, injuries, and country of manufacture (CPSC SaferProducts /RestWebServices/Recall; www.saferproducts.gov). The consumer-goods / import product-safety lane alongside nhtsa_recalls (vehicles) and openfda (medical). KEYLESS — no API key is required or accepted. Inputs (ALL optional): `dateStart`/`dateEnd` (YYYY-MM-DD recall date range), `productName` (substring), `manufacturer` (substring), `recallNumber` (a specific CPSC recall number). Returns { recalls:[{ recallNumber, recallDate, title, description, url, products:[names], numberOfUnits, manufacturers:[names], retailers:[names], hazards:[descriptions], remedies:[descriptions], injuries:[names], manufacturerCountries:[names] }] } + honest _meta. HONESTY: the CPSC response is a bare array with NO count field and NO pagination — it returns the COMPLETE matching set, so totalAvailable = the number of returned recalls and complete:true (never a fabricated total). ★With NO filter given, results are bounded to a DEFAULT ~90-day recent window (RecallDateStart, disclosed in _meta.notes) rather than a silent whole-dataset fetch. An empty result ⇒ an HONEST EMPTY (returned:0), NOT an error; a 4xx ⇒ invalid_input; a 5xx/timeout ⇒ THROWS; a 200 non-JSON OR a non-array body ⇒ schema_drift. Nested arrays are flattened to name/description strings (an empty {} object is skipped, never fabricated); NumberOfUnits is free text kept as a string; dates are strings; every scalar is null-never-empty-string. Fixed host www.saferproducts.gov (SSRF-guarded); dates are ^\\d{4}-\\d{2}-\\d{2}$ and recallNumber is letters/digits/hyphen only.",
    inputSchema: CpscRecallsInput,
    handler: (input) => cpsc.recalls(input),
  }),
  // ━━━ BEA Regional Economic Accounts (apps.bea.gov) — regional GDP/income (1) ━━━ ADR-0051
  // ★The server's THIRD KEY-REQUIRED source: the BEA Data API has NO keyless tier, so
  // WITHOUT a BEA_API_KEY this tool throws an honest invalid_input config error (the
  // most other tools stay keyless — see api_key_status). County/state/MSA GDP-by-industry + personal income —
  // the regional place-of-performance lane. ★The P2 crux: a missing/invalid key returns
  // HTTP 200 carrying BEAAPI.Results.Error (NOT an HTTP error status), which is detected
  // BEFORE the Data-array drift check and surfaced as invalid_input (never a fake empty).
  // DataValue is a comma-formatted string; suppression codes ((NA)/(D)/(NM)/(L)/*) → null.
  defineTool({
    name: "bea_regional_data",
    description:
      "Regional (county / state / MSA) economic data — GDP by industry and personal income — from the US Bureau of Economic Analysis (BEA) Regional Economic Accounts (apps.bea.gov/api/data, dataset 'Regional'). ★REQUIRES a free BEA_API_KEY: the BEA Data API has NO keyless tier, so without the key this tool THROWS an honest config error (get one at https://apps.bea.gov/API/signup/; call api_key_status to see every source's key requirement). Input: `tableName` (required, e.g. 'CAGDP2' county GDP by industry, 'SAGDP2N' state GDP, 'CAINC1'/'SAINC1' personal income), `geoFips` (required — 'STATE' for all states, a county FIPS like '06075', or an MSA code), `lineCode` (required — an integer industry line like '1', or 'ALL'), optional `year` ('LAST5' default, a 4-digit year, or 'ALL'), `frequency` ('A' annual default, or 'Q'). Returns { rows:[{ geoFips, geoName, timePeriod, lineCode, dataValue, unitOfMeasure, unitMult, noteRef }], notes:[{ noteRef, noteText }] } + honest _meta. ★HONESTY (the crux): a missing/invalid key — or ANY bad parameter — returns HTTP 200 carrying an Error object (NOT an HTTP error status); this is detected and surfaced as invalid_input carrying BEA's APIErrorDescription — NEVER a fake empty. dataValue is parsed from BEA's comma-formatted string ('1,234,567'→1234567); BEA suppression/not-available codes ((NA)/(D)/(NM)/(L)/*) map to null — NEVER 0 (a genuine 0 stays 0). unitMult (a power-of-10 multiplier) and unitOfMeasure are reported ALONGSIDE the raw dataValue — the value is NOT multiplied in (apply unitMult yourself). BEA returns the COMPLETE set for the filter (no pagination) ⇒ totalAvailable = the row count, complete:true; a genuine empty Data:[] ⇒ honest empty (returned:0); a 5xx ⇒ THROWS; a 200 non-JSON ⇒ schema_drift. The key rides ONLY in the UserID= query param — never logged or echoed.",
    inputSchema: BeaRegionalDataInput,
    handler: (input) => bea.regionalData(input),
  }),
  // ━━━ GSA Federal Travel Per-Diem (api.gsa.gov) — travel-cost lane (1) ━━━ ADR-0050
  // The lodging + M&IE reimbursement ceilings the federal government pays for official
  // travel, by city/state OR zip for a year. SAME host (api.gsa.gov) + SAME api.data.gov
  // key seam (datagovKey.ts, X-Api-Key header) as datagov_search_datasets — KEYLESS by
  // default via the shared DEMO_KEY, keylessMode:false. EITHER (city+state) OR zip; both
  // or neither ⇒ invalid_input, 0 fetch. `value` (monthly lodging) / `meals` are null-
  // never-0; standardRate/isOconus are STRING booleans coerced to real booleans.
  defineTool({
    name: "gsa_perdiem_rates",
    description:
      "Look up GSA Federal Travel PER-DIEM rates — the max lodging + Meals & Incidental Expenses (M&IE) reimbursement ceilings for official U.S. government travel (api.gsa.gov /travel/perdiem/v2, keyed — DATA_GOV_API_KEY or the shared DEMO_KEY). Input: EITHER `city` (e.g. 'Washington') + `state` (2-letter, e.g. 'DC') OR `zip` (5-digit) — supplying BOTH, or NEITHER, ⇒ invalid_input with 0 fetch; optional `year` (default '2025'). Returns { rates:[{ city, county, state, zip, year, isOconus, standardRate, mealsUsd, monthlyLodgingUsd:[{ month (1-12), monthName, lodgingUsd }] }] } + honest _meta. HONESTY: lodgingUsd (the API's monthly `value`) is the MAX nightly lodging ceiling for that month — it VARIES SEASONALLY (hence a per-month array), and mealsUsd is the daily M&IE ceiling; both are integer US dollars, null-when-withheld (NEVER 0 — a genuine 0 is preserved). standardRate/isOconus are booleans coerced from the API's string 'true'/'false' (an unrecognized value ⇒ null, never a fabricated false); the months array is preserved AS-IS (never padded to 12). The API returns the COMPLETE rate set (no pagination) ⇒ totalAvailable = the row count, complete:true. A genuine no-match (rates:[]/rate:[]) ⇒ honest empty (returned:0); the API's `errors` field non-null ⇒ invalid_input carrying the message (never a fake empty); a 429 (DEMO_KEY ~10 req/hr, hit quickly) ⇒ rate_limited THROWS; a 5xx/timeout ⇒ upstream_unavailable THROWS; a 200 non-JSON ⇒ schema_drift. DEMO_KEY ~10 req/hr shared ceiling — set DATA_GOV_API_KEY (free at api.data.gov/signup) for 1000/hr. The key rides ONLY in the X-Api-Key header (never the URL/_meta).",
    inputSchema: GsaPerdiemRatesInput,
    handler: (input) => gsaPerdiem.perdiemRates(input),
  }),
  // ━━━ US DOL Data API v4 (apiprod.dol.gov) — the labor-enforcement lane (2) ━━━ ADR-0053
  // A DELIBERATE key split: dol_list_datasets (the dataset CATALOG) is KEYLESS;
  // dol_get_dataset (the DATA endpoint) is the server's 4th REQUIRED key (DOL_API_KEY —
  // the data endpoint has NO keyless tier, so without the key it THROWS pre-fetch). The
  // key rides the X-API-KEY HEADER ONLY. The data-record envelope is key-gated/unverified
  // ⇒ records are surfaced VERBATIM + totalAvailable defaults null (never `returned` faked
  // as the total). agency/query filtering on the catalog is CLIENT-SIDE.
  defineTool({
    name: "dol_list_datasets",
    description:
      "List the US Department of Labor Data API v4 dataset catalog (apiprod.dol.gov /v4/datasets) — the machine inventory of DOL enforcement/statistics datasets (WHD wage & hour, OSHA inspections, ILAB child/forced-labor reports, MSHA mine safety, ETA …). KEYLESS: the catalog needs NO API key (only dol_get_dataset does). Input (all optional): `agency` (CLIENT-SIDE filter by agency abbreviation like 'WHD'/'OSHA'/'ILAB', or an agency-name substring), `query` (CLIENT-SIDE free-text substring over dataset name/description/category/table/endpoint), `limit` (default 25, max 200), `offset`. Returns { datasets:[{ name, tablename, apiUrl, agency, agencyAbbr, description, frequency, datasetType, category }] } + honest _meta. ★Feed a row's `apiUrl` (the DOL 'api_url' endpoint) + its `agencyAbbr` into dol_get_dataset to fetch that dataset's records. HONESTY: agency/query filtering is CLIENT-SIDE (the DOL catalog API does not filter server-side, verified live); totalAvailable is the catalog's REAL total (meta.total_count) for an unfiltered scan, or the exact filtered-set size (the whole catalog is fetched in one page); offset pagination. Every scalar is null-never-empty-string. A non-array `datasets` / 200 non-JSON ⇒ schema_drift; a 5xx ⇒ THROWS.",
    inputSchema: DolListDatasetsInput,
    handler: (input) => dol.listDatasets(input),
  }),
  defineTool({
    name: "dol_get_dataset",
    description:
      "Fetch records from ONE US DOL dataset (apiprod.dol.gov /v4/get/{agency}/{endpoint}/json). ★REQUIRES a free DOL_API_KEY: the DOL DATA endpoint has NO keyless tier, so without the key this tool THROWS an honest config error (get one at https://dataportal.dol.gov/registration; the dataset CATALOG — dol_list_datasets — and agency list stay keyless). Input: `agency` (required — the `agencyAbbr` from dol_list_datasets, e.g. 'WHD', 'OSHA', 'ILAB'; rides the PATH, ^[A-Za-z0-9_]+$), `table` (required — the dataset's `apiUrl` endpoint from dol_list_datasets, e.g. 'Child_Labor_Report__2016_to_2022'; rides the PATH, ^[A-Za-z0-9_]+$), optional `limit` (default 10, max 100), `offset`, `filterField`+`filterValue` (a paired equality filter → a DOL filter_object), `fields` (best-effort column selection). Returns { records:[…verbatim dataset rows…] } + honest _meta. HONESTY: records are surfaced VERBATIM (the data-record envelope is key-gated and unverified, so field names/values are preserved as-is — a genuine 0 stays 0, a missing field stays null; the tool never coerces or fabricates). totalAvailable is a real count field ONLY when the response carries one, else null (an honest unknown — `returned` is NEVER passed off as the total); offset pagination (a full page ⇒ hasMore, page forward to confirm). A missing/invalid key (401/403) ⇒ invalid_input carrying the DOL_API_KEY guidance (never empty); a 400 ⇒ invalid_input; a genuine empty ⇒ honest empty (returned:0); a 429 ⇒ rate_limited THROWS (Retry-After honored); a 5xx/timeout ⇒ upstream_unavailable THROWS; a 200 non-JSON / no row array ⇒ schema_drift. The key rides ONLY in the X-API-KEY request header — never the URL / _meta / a log.",
    inputSchema: DolGetDatasetInput,
    handler: (input) => dol.getDataset(input),
  }),
  // ━━━ US Senate LDA lobbying filings (lda.senate.gov) — the lobbying/B2G lane (1) ━━━ ADR-0052
  // Who is paid HOW MUCH to lobby WHICH federal agency on WHICH issue — the
  // registrant→client→government-entity signal no contract/spending source carries.
  // KEYLESS (anonymous 200); the OPTIONAL free LDA_API_KEY only raises the rate limit
  // and rides the Authorization: Token … header ONLY (the socrata app-token lineage —
  // NOT key-required). ★count is the API's REAL total (~1.95M) — never results.length;
  // page-based pagination. income/expenses are null-or-decimal-string ⇒ null-never-0.
  defineTool({
    name: "lda_search_filings",
    description:
      "Search US Senate LDA (Lobbying Disclosure Act) filings — who is paid HOW MUCH to lobby WHICH federal agency on WHICH issue (lda.senate.gov/api/v1/filings, KEYLESS — anonymous access works; an optional free LDA_API_KEY only raises the rate limit). All inputs optional: `registrantName` (the lobbying firm/in-house filer), `clientName` (who it's for), `lobbyistName`, `filingYear` (4-digit), `filingType` (short code, e.g. 'Q1'/'RR'/'YE'), `agency` (the federal government_entity lobbied — the B2G signal), `issue` (specific lobbying issues text), `page` (1-based, default 1), `pageSize` (1..25, default 25). Returns { filings:[{ filingUuid, filingType, filingYear, filingPeriod, incomeUsd, expensesUsd, registrant, client, lobbyingActivities:[{ issueCode, description, governmentEntities:[names] }], documentUrl, postedDate, terminationDate }] } + honest _meta. HONESTY: totalAvailable is the API's REAL total match count (the corpus is ~1.95M filings) — NOT the rows on this page; pagination is page-based (pass the next page number when hasMore). incomeUsd/expensesUsd are parsed from the null-or-decimal-string income/expenses — null (not reported) ⇒ null, NEVER 0 (a genuine 0 stays 0); a filing reports EITHER income OR expenses, so the other is typically null. Missing lobbying_activities/government_entities ⇒ empty arrays (never fabricated). A genuine no-match (results:[]) ⇒ honest empty (returned:0); a 400 (bad filter) ⇒ invalid_input surfacing the API's message; a 429 ⇒ rate_limited THROWS (Retry-After honored, never routed around); a 5xx/timeout ⇒ upstream_unavailable THROWS; a 200 non-JSON / non-array results / non-number count ⇒ schema_drift. The optional key rides ONLY in the Authorization: Token header (never the URL/_meta).",
    inputSchema: LdaSearchFilingsInput,
    handler: (input) => lda.searchFilings(input),
  }),
  // ━━━ US federal court opinions (www.courtlistener.com) — the litigation lane (1) ━━━ ADR-0055
  // Federal court decisions — the judicial signal no contract/spending/lobbying source
  // carries (uscfc bid-protest/contract-claim opinions, cafc contract/patent appeals).
  // ★PROVENANCE: CourtListener (Free Law Project, a non-profit), NOT a .gov API — PACER
  // (the .gov source) is paywalled. KEYLESS (anonymous 200); the OPTIONAL free
  // COURTLISTENER_API_TOKEN only raises the rate limit, riding the Authorization: Token …
  // header ONLY. ★count is the API's REAL total — never results.length; CURSOR pagination
  // (nextCursor extracted from `next`, host re-asserted). type=o FIXED.
  defineTool({
    name: "courtlistener_search_opinions",
    description:
      "Search US FEDERAL COURT OPINIONS (case law / litigation) via CourtListener (www.courtlistener.com/api/rest/v4/search, type=o). ★PROVENANCE: the DATA is US federal court PUBLIC RECORDS, but the API is CourtListener, run by the Free Law Project (a NON-PROFIT) — this is NOT a .gov API; CourtListener republishes these records KEYLESS because the .gov primary source (PACER) is PAYWALLED. KEYLESS (anonymous access works; an optional free COURTLISTENER_API_TOKEN only raises the rate limit; get one at https://www.courtlistener.com/help/api/rest/; call api_key_status to see every source's key requirement). All inputs optional: `query` (full-text → q), `court` (a court id, ^[a-z0-9]+$ — e.g. 'uscfc' US Court of Federal Claims for contract claims/bid protests, 'cafc' Federal Circuit for contract/patent appeals, 'scotus'), `dateFiledAfter`/`dateFiledBefore` (ISO ^\\d{4}-\\d{2}-\\d{2}$ → filed_after/filed_before), `natureOfSuit` (folded into the q query — no verified dedicated filter, disclosed in notes), `cursor` (opaque continuation — pass back _meta.nextCursor), `order` (→ order_by, default 'dateFiled desc'). Returns { opinions:[{ caseName, court, courtId, dateFiled, docketNumber, natureOfSuit, status, judge, citation, absoluteUrl }] } + honest _meta. HONESTY: totalAvailable is the API's REAL `count` (the total match count for the filter) — NOT the rows on this page; pagination is an OPAQUE CURSOR (offset/nextOffset are null/meaningless — pass _meta.nextCursor back as `cursor`; nextCursor:null/hasMore:false = last page). CourtListener v4 stops counting on deep cursor pages (count:null) ⇒ totalAvailable:null is DISCLOSED, never faked as results.length. dateFiled is a date STRING; citation may be an array/object ⇒ flattened to a safe string/string[] (never fabricated); judge/natureOfSuit/docketNumber are null when absent (never ''); absoluteUrl is the full https://www.courtlistener.com link. A genuine no-match (results:[]) ⇒ honest empty (returned:0); a 400 (bad param) ⇒ invalid_input surfacing the API's message; a 429 (unauth throttle) ⇒ rate_limited THROWS (Retry-After honored, never routed around); a 5xx/timeout ⇒ upstream_unavailable THROWS; a 200 non-JSON / non-array results / a count that is neither a number nor null ⇒ schema_drift; an off-host `next` is REFUSED (SSRF). The optional token rides ONLY in the Authorization: Token header (never the URL/_meta).",
    inputSchema: CourtlistenerSearchOpinionsInput,
    handler: (input) => courtlistener.searchOpinions(input),
  }),
  // ━━━ US tax-exempt nonprofits (projects.propublica.org) — the nonprofit lane (2) ━━━ ADR-0060
  // Who a 501(c) org IS (EIN, NTEE, subsection, ruling date, status) + its Form 990
  // FINANCIALS (revenue/expenses/assets/liabilities by year) — the nonprofit/grantee/
  // subcontractor vetting signal no contract/spending/grant/lobbying source carries.
  // ★PROVENANCE: IRS Form 990 public records republished KEYLESS by ProPublica Nonprofit
  // Explorer (a non-profit newsroom), NOT a .gov API (the IRS has no clean query API).
  // KEYLESS (no key). search total_results is the REAL total — never organizations.length;
  // financials totalAvailable = filings.length (the complete set). Money via num (null-never-0).
  defineTool({
    name: "nonprofit_search",
    description:
      "Search US TAX-EXEMPT NONPROFITS (501(c) organizations) by IRS Form 990 data via ProPublica Nonprofit Explorer (projects.propublica.org/nonprofits/api/v2/search). ★PROVENANCE: the DATA is IRS Form 990 filings — FEDERAL tax-exempt PUBLIC RECORDS — but the API is ProPublica Nonprofit Explorer, run by ProPublica (a NON-PROFIT newsroom) — this is NOT a .gov API; ProPublica republishes these records KEYLESS because the IRS itself has no clean query API (only bulk downloads / a web UI). KEYLESS (no key of any kind). All inputs optional: `query` (full-text org name/keyword → q), `state` (2-letter code → state[id], ^[A-Za-z]{2}$), `ntee` (NTEE major category, integer 1..10 → ntee[id]), `page` (0-BASED, default 0). Returns { organizations:[{ ein, name, city, state, nteeCode, subsectionCode }] } + honest _meta. HONESTY: totalAvailable is the API's REAL total_results (the total match count for the query) — NOT the organizations on this page; pagination is page-based and 0-INDEXED (pass page=cur_page+1 when hasMore). ein/nteeCode/subsectionCode are strings (never num-coerced). A genuine no-match (organizations:[]) ⇒ honest empty (returned:0, complete:true); a 4xx ⇒ invalid_input; a 429 ⇒ rate_limited THROWS (Retry-After honored, never routed around); a 5xx/timeout ⇒ upstream_unavailable THROWS; a 200 non-JSON / non-array organizations / non-number total_results ⇒ schema_drift. Data is IRS Form 990 data via ProPublica Nonprofit Explorer, disclosed in _meta.source and a note.",
    inputSchema: NonprofitSearchInput,
    handler: (input) => nonprofit.search(input),
  }),
  defineTool({
    name: "nonprofit_financials",
    description:
      "Fetch ONE US tax-exempt nonprofit's IRS Form 990 profile + FINANCIALS by EIN via ProPublica Nonprofit Explorer (projects.propublica.org/nonprofits/api/v2/organizations/{ein}.json). ★PROVENANCE: the DATA is IRS Form 990 filings (federal tax-exempt public records) but the API is ProPublica Nonprofit Explorer, run by ProPublica (a NON-PROFIT newsroom) — NOT a .gov API; ProPublica republishes these records KEYLESS because the IRS has no clean query API. KEYLESS (no key). Input: `ein` (required — the Employer Identification Number, 1..9 digits ^\\d{1,9}$, e.g. '530196605' American National Red Cross; rides the URL path). Returns { organization:{ ein, name, address, city, state, zip, nteeCode, subsectionCode, rulingDate, statusCode }, filings:[{ taxYear, formType, revenueUsd, expensesUsd, assetsUsd, liabilitiesUsd, pdfUrl }] } + honest _meta. HONESTY: the four Form 990 figures (revenueUsd/expensesUsd/assetsUsd/liabilitiesUsd, from totrevenue/totfuncexpns/totassetsend/totliabend) ride null-never-0 coercion — a genuine reported 0 stays 0, an absent figure ⇒ null (NEVER 0-faked); ein/codes are strings; rulingDate is a date string. totalAvailable = filings.length (the COMPLETE Form 990 filing set from the one detail document — no pagination). An unknown EIN (HTTP 404) ⇒ not_found (NEVER a fabricated empty org); a 4xx ⇒ invalid_input; a 429 ⇒ rate_limited THROWS; a 5xx/timeout ⇒ upstream_unavailable THROWS; a 200 non-JSON / non-object organization / non-array filings_with_data ⇒ schema_drift. Data is IRS Form 990 data via ProPublica Nonprofit Explorer, disclosed in _meta.source and a note.",
    inputSchema: NonprofitFinancialsInput,
    handler: (input) => nonprofit.financials(input),
  }),
  // ━━━ Self-service key discovery (1) ━━━
  // KEYLESS. A local status query — reads process.env (+ any .env auto-loaded at
  // startup) and reports, per key, whether it is set (a BOOLEAN — the key VALUE is
  // NEVER read into the output). Makes the 4-required + 6-optional key situation
  // discoverable without reading source or docs.
  defineTool({
    name: "api_key_status",
    description:
      "List every API key this server can use, whether each is REQUIRED or OPTIONAL, the free signup URL + what it unlocks, and whether it is CURRENTLY configured — a boolean only; the key VALUE is NEVER shown. KEYLESS (no input). Most sources are keyless; four sources need a key — Census (census_business_patterns), FRED (2 tools), and BEA (bea_regional_data) require one outright, and DOL's DATA endpoint (dol_get_dataset) needs one too (its catalog, dol_list_datasets, stays keyless) — the other 6 keys are OPTIONAL (raise a rate limit or unlock one filter). Keys can be set as host env vars OR in a `.env` file in the server's working directory (auto-loaded at startup; real env wins over .env). Returns { keys:[{ envVar, sources[], required, signupUrl, unlocks, note, currentlySet }], requiredMissing:[envVars], optionalMissing:[envVars], allKeysFree:true }. This tool tells you the CONFIG state; to verify a key actually WORKS, call that source's own tool. Getting a key (creating the account at the signup URL) is your step — the server automates discovery + configuration, not signup.",
    inputSchema: ApiKeyStatusInput,
    handler: async () => keys.apiKeyStatus(),
  }),
];

// ─── Server bootstrap ────────────────────────────────────────────

async function main() {
  // Auto-load API keys from a `.env` in the working directory BEFORE anything
  // reads process.env (tools read env at call time; SamGovClient below reads
  // SAM_GOV_API_KEY immediately). Real env wins over .env (precedence); no .env
  // present ⇒ zero change ⇒ byte-identical startup. We log only the COUNT — never
  // which keys or their values.
  const loadedFromEnvFile = keys.loadDotEnv();
  if (loadedFromEnvFile > 0) {
    console.error(
      `[mcp-sam-gov] loaded ${loadedFromEnvFile} key(s) from .env`,
    );
  }

  const sam = new SamGovClient({
    apiKey: process.env.SAM_GOV_API_KEY?.trim() || undefined,
    logger: {
      warn: (msg, err) => {
        console.error(msg, err ?? "");
      },
    },
  });

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

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
      const _meta: ResponseMeta = isMetaBundle(raw)
        ? buildMeta(raw.meta)
        : synthesizeDefaultMeta(name, sam);
      // Structured success envelope. Calling agent can rely on
      // `ok: true` to know the payload is in `data`, and read `_meta`
      // for completeness / provenance (see meta.ts).
      const envelope = { ok: true as const, data, _meta };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
        ],
      };
    } catch (err) {
      // Structured error envelope. The agent can read `error.kind`
      // and `error.retryable` to decide what to do next. Classification is
      // centralized in `toToolError`, which maps a Zod input-validation failure
      // (e.g. a value outside an enum, or a limit above the max) to a
      // NON-retryable `invalid_input` with readable field-level issues — never a
      // generic `unknown` carrying Zod's raw JSON dump.
      const error = toToolError(err, name);
      const envelope = { ok: false as const, error };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mcp-sam-gov] v${SERVER_VERSION} listening on stdio (${TOOLS.length} tools).`,
  );
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
function synthesizeDefaultMeta(
  toolName: string,
  sam: SamGovClient,
): ResponseMeta {
  // The wage tools carry a `sam_` prefix but hit the keyless SGS/WDOL
  // subsystems (never the keyed opportunities API), so they are always keyless.
  const isWage =
    toolName === "sam_search_wage_determinations" ||
    toolName === "sam_get_wage_rates";
  // sam_lookup_notice_fields also carries a `sam_` prefix but is served from the
  // keyless GSA daily CSV (never the keyed opportunities API) — always keyless.
  const isGsaCsv = toolName === "sam_lookup_notice_fields";
  const isSam = toolName.startsWith("sam_") && !isWage && !isGsaCsv;
  const keylessMode = isSam ? sam.isKeyless : true;
  let source: string;
  if (isWage) {
    source = "sam.gov wage-determinations (keyless)";
  } else if (isGsaCsv) {
    source = "gsa.gov daily bulk CSV (keyless)";
  } else if (toolName.startsWith("gsa_")) {
    source = "api.gsa.gov CALC v3 (keyless)";
  } else if (isSam) {
    source = sam.isKeyless ? "sam.gov (keyless)" : "api.sam.gov (keyed)";
  } else if (toolName.startsWith("usas_")) {
    source = "usaspending.gov/api/v2";
  } else if (toolName.startsWith("fed_register_")) {
    source = "federalregister.gov/api/v1";
  } else if (toolName.startsWith("ecfr_")) {
    source = "ecfr.gov/api";
  } else if (toolName.startsWith("grants_")) {
    source = "grants.gov/api";
  } else if (toolName.startsWith("sba_")) {
    source = "sba.gov naics.json (keyless)";
  } else if (toolName.startsWith("gao_")) {
    source = "gao.gov Legal Products RSS + decision pages (keyless)";
  } else if (toolName.startsWith("fpds_")) {
    source = "www.fpds.gov ezSearch ATOM (FPDS-NG, keyless)";
  } else if (toolName === "api_key_status") {
    source = "local (process.env + .env)";
  } else {
    source = "unknown";
  }
  return buildMeta({ source, keylessMode, complete: true, truncated: false });
}

// Unwrap a tool's inputSchema down to its underlying ZodObject so we can read the
// set of declared top-level keys. Tools wrap the object in .refine()/.superRefine()
// (ZodEffects), or occasionally .optional()/.default()/.nullable(), so peel those
// layers. Returns null if no ZodObject is reachable (then unknown-key rejection is
// skipped for that tool — fail open, never fail closed on our own introspection).
function objectSchemaOf(schema: z.ZodTypeAny): z.AnyZodObject | null {
  let s: unknown = schema;
  for (let i = 0; i < 20; i++) {
    const def = (s as { _def?: { typeName?: string } } | undefined)?._def;
    if (!def) break;
    const tn = def.typeName;
    if (tn === "ZodObject") return s as z.AnyZodObject;
    if (tn === "ZodEffects") { s = (def as { schema?: unknown }).schema; continue; }
    if (tn === "ZodOptional" || tn === "ZodDefault" || tn === "ZodNullable") {
      s = (def as { innerType?: unknown }).innerType;
      continue;
    }
    break;
  }
  return null;
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  sam: SamGovClient,
): Promise<unknown> {
  // R1 (ADR-0001) — registry dispatch. Every tool's TOOLS[] entry carries a
  // co-located `handler`: route through it by parsing `args` with the entry's
  // own schema, then calling the handler. Its return value flows into
  // CallTool's existing envelope logic (isMetaBundle? buildMeta :
  // synthesizeDefaultMeta) byte-identically. The legacy dispatch `switch` is
  // gone (all 52 tools migrated) — an unknown name has no entry and throws.
  const entry = TOOLS.find((t) => t.name === name);
  if (entry?.handler) {
    // HONESTY (dogfooding 2026-07-15): reject UNKNOWN top-level input keys LOUD
    // instead of Zod's default silent-strip. A misspelled filter (naicsCode↔naics,
    // keyword↔query) was otherwise dropped and the tool scanned the WHOLE corpus,
    // returning an authoritative-looking WRONG answer with no error. We name the
    // unknown key(s) and list the valid ones so the mistake self-corrects. Skip
    // when the schema intentionally accepts extras (unknownKeys==="passthrough").
    const obj = objectSchemaOf(entry.inputSchema);
    if (obj && obj._def.unknownKeys !== "passthrough" && args && typeof args === "object") {
      const known = new Set(Object.keys(obj.shape));
      const unknown = Object.keys(args).filter((k) => !known.has(k));
      if (unknown.length > 0) {
        throw new ToolErrorCarrier({
          kind: "invalid_input",
          message:
            `Unknown input ${unknown.length > 1 ? "keys" : "key"} for ${name}: ` +
            `${unknown.map((k) => `'${k}'`).join(", ")}. ` +
            `Valid keys: ${[...known].sort().join(", ")}.`,
          retryable: false,
        });
      }
    }
    const input = entry.inputSchema.parse(args);
    return await entry.handler(input, { sam });
  }
  throw new Error(`Unknown tool: ${name}`);
}

/**
 * Hand-rolled Zod → JSON Schema converter (subset we use).
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  const tn = def.typeName;
  const description = (schema as unknown as { description?: string }).description;

  if (tn === "ZodObject") {
    const shape = (schema as unknown as { shape: Record<string, z.ZodTypeAny> })
      .shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (
        !(value as unknown as { isOptional: () => boolean }).isOptional?.()
      ) {
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
  if (tn === "ZodString") return { type: "string", ...(description ? { description } : {}) };
  if (tn === "ZodNumber") return { type: "number", ...(description ? { description } : {}) };
  if (tn === "ZodBoolean") return { type: "boolean", ...(description ? { description } : {}) };
  if (tn === "ZodArray") {
    const inner = (schema as unknown as { _def: { type: z.ZodTypeAny } })._def
      .type;
    return {
      type: "array",
      items: zodToJsonSchema(inner),
      ...(description ? { description } : {}),
    };
  }
  if (tn === "ZodEnum") {
    const values = (schema as unknown as { _def: { values: string[] } })._def
      .values;
    return {
      type: "string",
      enum: values,
      ...(description ? { description } : {}),
    };
  }
  if (tn === "ZodOptional" || tn === "ZodDefault" || tn === "ZodNullable") {
    const inner = (schema as unknown as { _def: { innerType: z.ZodTypeAny } })
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
  if (!argv1) return false;
  const canonical = (p: string): string => {
    try {
      return pathToFileURL(realpathSync(p)).href;
    } catch {
      return pathToFileURL(p).href; // not a real path → best-effort raw
    }
  };
  try {
    return canonical(argv1) === canonical(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(argv1).href; // extreme fallback
  }
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[mcp-sam-gov] FATAL:", err);
    process.exit(1);
  });
}
