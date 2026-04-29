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
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SamGovClient, type SamSetAside } from "./sam-gov/index.js";
import * as usas from "./usaspending.js";
import * as fedreg from "./federal-register.js";
import * as ecfr from "./ecfr.js";
import * as grants from "./grants.js";
import { toToolError } from "./errors.js";

const SERVER_NAME = "mcp-sam-gov";
const SERVER_VERSION = "0.3.0";

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

// ─── Tool catalog ────────────────────────────────────────────────

type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
};

const TOOLS: ToolDef[] = [
  // ━━━ SAM.gov (5) ━━━
  {
    name: "sam_search_opportunities",
    description:
      "Search SAM.gov federal contracting opportunities (keyless HAL). Returns up to 50 active notices with title, agency, NAICS, noticeId. Use for discovery — narrow with NAICS / agency / set-aside / state.",
    inputSchema: SamSearchInput,
  },
  {
    name: "sam_get_opportunity",
    description:
      "Fetch full detail for a single SAM.gov notice by 32-char hex noticeId. Returns title, agency, solicitation #, POCs, response deadline, attachments (with download URLs), inline description body. Call BEFORE drafting bid/no-bid or compliance work.",
    inputSchema: SamGetOpportunityInput,
  },
  {
    name: "sam_fetch_description",
    description:
      "Return the full description / RFP body text for a notice as plain text. Useful when sam_get_opportunity returned a description URL instead of inline body, or for an LLM-friendly text dump.",
    inputSchema: SamFetchDescriptionInput,
  },
  {
    name: "sam_attachment_url",
    description:
      "Build the public download URL for an attachment resourceId. The URL returns a 303 redirect to a signed S3 URL — fetch with redirect:'follow' to get the file bytes.",
    inputSchema: SamAttachmentUrlInput,
  },
  {
    name: "sam_lookup_organization",
    description:
      "Resolve a SAM.gov federal-organization id to its canonical fullParentPathName (e.g. 'VETERANS AFFAIRS, DEPARTMENT OF.VETERANS AFFAIRS, DEPARTMENT OF.245-NETWORK CONTRACT OFFICE 5'). Use when sam_get_opportunity returned only an organizationId.",
    inputSchema: SamLookupOrgInput,
  },

  // ━━━ USAspending — Awards & Recipients (8) ━━━
  {
    name: "usas_search_awards",
    description:
      "Aggregate share-of-wallet on USAspending. Given an agency × NAICS × fiscal year, returns top recipients by total $ + count. Use for competitive landscape ('who wins at VA in 541512?').",
    inputSchema: UsasFiltersBase,
  },
  {
    name: "usas_search_individual_awards",
    description:
      "Line-item federal contracts on USAspending. Returns specific awards (recipient + $ + sub-agency + state + description). Use AFTER usas_search_awards when the user wants 'show me the actual contracts'. Each result includes a generatedInternalId for usas_get_award_detail follow-ups.",
    inputSchema: UsasIndividualAwardsInput,
  },
  {
    name: "usas_search_subagency_spending",
    description:
      "Break down a parent agency's spending by sub-agency / office. Surfaces which office holds the budget (e.g. VA OI&T vs VHA, DoD vs Army vs DISA).",
    inputSchema: UsasSubAgencyInput,
  },
  {
    name: "usas_lookup_agency",
    description:
      "Resolve a user-friendly agency reference ('VA', 'Veterans Affairs', 'DHS') to USAspending's canonical toptier name + 4-digit code. ALWAYS call this FIRST if the user uses an abbreviation — other USAspending tools require the canonical name.",
    inputSchema: UsasLookupAgencyInput,
  },
  {
    name: "usas_search_awards_by_recipient",
    description:
      "Pull every contract a specific recipient has won within an agency × NAICS slice. Use when the user asks 'show me Booz Allen wins at VA last year' — returns line items + naicsCode + description, not aggregates.",
    inputSchema: UsasRecipientAwardsInput,
  },
  {
    name: "usas_search_subawards",
    description:
      "Enumerate subcontracts on prime awards. Use for 'who teams with Leidos at DISA' or 'show small-business subs on Accenture's DHS contracts' — surfaces the prime/sub network for teaming-map artifacts.",
    inputSchema: UsasSubawardsInput,
  },
  {
    name: "usas_search_expiring_contracts",
    description:
      "Find federal contracts at agency × NAICS that expire within N months. Recompete radar — end-date sorted, top 10 by value. Use for 'what VA cloud contracts are up for recompete' or 'show 541512 contracts expiring in 6 months'.",
    inputSchema: UsasExpiringInput,
  },
  {
    name: "usas_get_award_detail",
    description:
      "Fetch full detail for a single award by generatedInternalId (from usas_search_individual_awards). Returns period_of_performance (start/end/potential_end), base_and_all_options, set-aside type, competition extent, number_of_offers — the per-award fields the search endpoint omits.",
    inputSchema: UsasAwardDetailInput,
  },

  // ━━━ USAspending — Aggregate Analysis (6) ━━━
  {
    name: "usas_spending_over_time",
    description:
      "Time-series aggregation of federal spending. Group by fiscal_year / quarter / month, filter by agency / NAICS / set-aside. Use for 'how has VA 541512 spending trended over the past 5 years' — returns yearly/quarterly/monthly $ rollups.",
    inputSchema: UsasSpendingOverTimeInput,
  },
  {
    name: "usas_search_psc_spending",
    description:
      "Spending broken down by Product Service Code (PSC). Use for 'what PSC categories see the most $ at DoD' — surfaces market structure beyond NAICS (e.g. PSC R425 = engineering support services).",
    inputSchema: UsasCategorySpendingInput,
  },
  {
    name: "usas_search_state_spending",
    description:
      "Spending broken down by state / territory. Use for 'where is the most federal $ flowing for NAICS 541512' — answers like 'VA $128B, MD $66B, DC $58B'.",
    inputSchema: UsasCategorySpendingInput,
  },
  {
    name: "usas_search_cfda_spending",
    description:
      "Spending broken down by CFDA grant program code. Use for grant analysis — 'top federal grant programs by $'. Note: CFDA is grants (award_type 02-05), not contracts. Use usas_search_psc_spending for contract market analysis.",
    inputSchema: UsasCfdaInput,
  },
  {
    name: "usas_search_federal_account_spending",
    description:
      "Spending broken down by federal account / Treasury Account Symbol (TAS). Use to map money to the actual budget line item (e.g. '036-0167 = Information Technology Systems, VA').",
    inputSchema: UsasCategorySpendingInput,
  },
  {
    name: "usas_search_agency_spending",
    description:
      "Spending broken down by awarding agency. Use for 'which agencies spend the most on NAICS 541512' — top buyers by $.",
    inputSchema: UsasAgencySpendingInput,
  },

  // ━━━ USAspending — Agency Profile (3) ━━━
  {
    name: "usas_get_agency_profile",
    description:
      "Get full agency profile by toptier code (3-4 digits, from usas_lookup_agency). Returns mission, abbreviation, website, subtier_agency_count, congressional_justification_url.",
    inputSchema: UsasAgencyProfileInput,
  },
  {
    name: "usas_get_agency_awards_summary",
    description:
      "High-level award activity for a fiscal year — transaction_count + obligations + latest_action_date. Snapshot of agency volume.",
    inputSchema: UsasAgencyAwardsInput,
  },
  {
    name: "usas_get_agency_budget_function",
    description:
      "Budget function breakdown for an agency × fiscal year. Returns the agency's spending by program area (e.g. VA: 'Income security for veterans' $204B, 'Hospital and medical care for veterans' $126B).",
    inputSchema: UsasAgencyBudgetInput,
  },

  // ━━━ USAspending — Recipient Profile (2) ━━━
  {
    name: "usas_search_recipients",
    description:
      "Search USAspending recipient list with parent/child/recipient hierarchy. Returns recipients with id, duns, uei, level (P=parent, C=child, R=recipient), total_amount. Use for 'find the recipient_id for Booz Allen' before usas_get_recipient_profile.",
    inputSchema: UsasSearchRecipientsInput,
  },
  {
    name: "usas_get_recipient_profile",
    description:
      "Full recipient detail by recipient_id (from usas_search_recipients). Returns alternate_names (M&A history), DUNS, UEI, parent linkage, business_types, location, total_amount, total_transactions.",
    inputSchema: UsasGetRecipientInput,
  },

  // ━━━ USAspending — Reference / Autocomplete (4) ━━━
  {
    name: "usas_autocomplete_naics",
    description:
      "Autocomplete NAICS codes by free-text. ANTI-HALLUCINATION GUARD — call this when the user mentions a NAICS theme but no specific code (e.g. 'computer systems design' → 541512). Avoids inventing NAICS codes.",
    inputSchema: UsasAutocompleteInput,
  },
  {
    name: "usas_autocomplete_recipient",
    description:
      "Autocomplete recipient names. ANTI-HALLUCINATION — confirm a recipient's exact USAspending-canonical legal name before searching by name. Returns up to 10 fuzzy matches with UEI/DUNS where available.",
    inputSchema: UsasAutocompleteInput,
  },
  {
    name: "usas_naics_hierarchy",
    description:
      "Navigate the NAICS hierarchy (2-digit → 4-digit → 6-digit). Returns parent/child relationships + active-contract count per code. Use to explore market scope ('what's under NAICS 541' = 'Professional, Scientific, and Technical Services').",
    inputSchema: UsasNaicsHierarchyInput,
  },
  {
    name: "usas_glossary",
    description:
      "USAspending glossary of 151 federal-spending terms. Use to confirm terminology ('what's a TAS?', 'what's an obligation vs outlay?') before answering compliance/budget questions.",
    inputSchema: UsasGlossaryInput,
  },
  {
    name: "usas_list_toptier_agencies",
    description:
      "List all toptier federal agencies with toptier_code, abbreviation, slug, current-FY obligations. Use for 'show me every cabinet department + their FY26 spending' or to find a toptier_code for usas_get_agency_*.",
    inputSchema: UsasListAgenciesInput,
  },

  // ━━━ Federal Register (3) ━━━
  {
    name: "fed_register_search_documents",
    description:
      "Search Federal Register documents (proposed rules, final rules, notices, presidential documents) by query / agency / type / date range. Use for regulatory-context queries ('what new VA cybersecurity rules came out this quarter?').",
    inputSchema: FedRegSearchInput,
  },
  {
    name: "fed_register_get_document",
    description:
      "Fetch full detail for a Federal Register document by number. Returns title, abstract, citation, publication_date, effective_on, raw_text_url (for the full body), CFR references — everything needed to ground a regulation citation.",
    inputSchema: FedRegGetDocInput,
  },
  {
    name: "fed_register_list_agencies",
    description:
      "List all Federal Register agencies with slugs (needed for fed_register_search_documents). Use to resolve 'what's the FedReg slug for Veterans Affairs?'",
    inputSchema: FedRegListAgenciesInput,
  },

  // ━━━ eCFR (2) ━━━
  {
    name: "ecfr_search",
    description:
      "Full-text search across the entire CFR (Code of Federal Regulations). Use for compliance questions — pass titleNumber=48 for FAR (Federal Acquisition Regulation), titleNumber=2 for federal financial assistance, etc. Returns excerpt + section path + ecfrUrl.",
    inputSchema: EcfrSearchInput,
  },
  {
    name: "ecfr_list_titles",
    description:
      "List all 50 CFR titles with name + last_amended_on date. Use to discover what's in each title (Title 48 = FAR, Title 32 = National Defense, Title 14 = Aeronautics, etc.).",
    inputSchema: EcfrListTitlesInput,
  },

  // ━━━ Grants.gov (2) ━━━
  {
    name: "grants_search",
    description:
      "Search Grants.gov federal grant opportunities (financial assistance, distinct from contracts on SAM.gov). Filter by keyword / CFDA / agency / opportunity number. Default status = forecasted + posted.",
    inputSchema: GrantsSearchInput,
  },
  {
    name: "grants_get_opportunity",
    description:
      "Fetch full detail for a single grant opportunity by id. Returns description, agency, posting/response/archive dates, award_ceiling, award_floor, estimated_funding, expected_number_of_awards, applicant_types, funding_instruments, CFDA programs.",
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
      const data = await runTool(name, args ?? {}, sam);
      // Structured success envelope. Calling agent can rely on
      // `ok: true` to know the payload is in `data`.
      const envelope = { ok: true as const, data };
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(envelope, null, 2) },
        ],
      };
    } catch (err) {
      // Structured error envelope. The agent can read `error.kind`
      // and `error.retryable` to decide what to do next.
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

async function runTool(
  name: string,
  args: Record<string, unknown>,
  sam: SamGovClient,
): Promise<unknown> {
  switch (name) {
    // SAM.gov
    case "sam_search_opportunities": {
      const input = SamSearchInput.parse(args);
      const r = await sam.searchOpportunities({
        ...input,
        setAside: input.setAside as SamSetAside[] | undefined,
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
      if (!o) return { found: false, noticeId };
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
      const r = await fetch(
        `https://sam.gov/api/prod/federalorganizations/v1/organizations/${encodeURIComponent(organizationId)}`,
        {
          headers: { Accept: "application/hal+json" },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!r.ok) {
        return { found: false, organizationId, status: r.status };
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
      const json = (await r.json()) as Resp;
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
      return await usas.searchIndividualAwards(
        UsasIndividualAwardsInput.parse(args),
      );
    case "usas_search_subagency_spending":
      return await usas.searchSubAgencySpending(UsasSubAgencyInput.parse(args));
    case "usas_lookup_agency":
      return await usas.lookupAgency(
        UsasLookupAgencyInput.parse(args).searchText,
      );
    case "usas_search_awards_by_recipient":
      return await usas.searchAwardsByRecipient(
        UsasRecipientAwardsInput.parse(args),
      );
    case "usas_search_subawards":
      return await usas.searchSubawards(UsasSubawardsInput.parse(args));
    case "usas_search_expiring_contracts":
      return await usas.searchExpiringContracts(UsasExpiringInput.parse(args));
    case "usas_get_award_detail":
      return await usas.getAwardDetail(
        UsasAwardDetailInput.parse(args).generatedInternalId,
      );

    // USAspending — Aggregate
    case "usas_spending_over_time":
      return await usas.spendingOverTime(
        UsasSpendingOverTimeInput.parse(args),
      );
    case "usas_search_psc_spending":
      return await usas.searchPscSpending(
        UsasCategorySpendingInput.parse(args),
      );
    case "usas_search_state_spending":
      return await usas.searchStateSpending(
        UsasCategorySpendingInput.parse(args),
      );
    case "usas_search_cfda_spending":
      return await usas.searchCfdaSpending(UsasCfdaInput.parse(args));
    case "usas_search_federal_account_spending":
      return await usas.searchFederalAccountSpending(
        UsasCategorySpendingInput.parse(args),
      );
    case "usas_search_agency_spending":
      return await usas.searchAgencySpending(
        UsasAgencySpendingInput.parse(args),
      );

    // USAspending — Agency Profile
    case "usas_get_agency_profile":
      return await usas.getAgencyProfile(
        UsasAgencyProfileInput.parse(args).toptierCode,
      );
    case "usas_get_agency_awards_summary":
      return await usas.getAgencyAwardsSummary(
        UsasAgencyAwardsInput.parse(args),
      );
    case "usas_get_agency_budget_function":
      return await usas.getAgencyBudgetFunction(
        UsasAgencyBudgetInput.parse(args),
      );

    // USAspending — Recipient Profile
    case "usas_search_recipients":
      return await usas.searchRecipients(UsasSearchRecipientsInput.parse(args));
    case "usas_get_recipient_profile":
      return await usas.getRecipientProfile(
        UsasGetRecipientInput.parse(args).recipientId,
      );

    // USAspending — Reference / Autocomplete
    case "usas_autocomplete_naics":
      return await usas.autocompleteNaics(UsasAutocompleteInput.parse(args));
    case "usas_autocomplete_recipient":
      return await usas.autocompleteRecipient(
        UsasAutocompleteInput.parse(args),
      );
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
      return await fedreg.getDocument(
        FedRegGetDocInput.parse(args).documentNumber,
      );
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
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

main().catch((err) => {
  console.error("[mcp-sam-gov] FATAL:", err);
  process.exit(1);
});
