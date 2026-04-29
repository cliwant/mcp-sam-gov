#!/usr/bin/env node
/**
 * @govicon/mcp-sam-gov — Model Context Protocol server for SAM.gov
 * + USAspending federal data.
 *
 * Drop-in MCP server compatible with:
 *   - Claude Desktop  (claude_desktop_config.json)
 *   - Claude Code     (~/.config/claude-code/mcp.json or per-project)
 *   - Codex CLI       (~/.codex/config.toml)
 *   - Cursor          (Cursor settings → MCP)
 *   - Continue        (continue config)
 *   - Gemini CLI      (~/.gemini/settings.json)
 *
 * Transport: stdio JSON-RPC (the universal MCP transport — works
 * everywhere). HTTP/SSE transport is NOT included to keep the binary
 * minimal; if you need it, fork or wrap with `mcp-proxy`.
 *
 * Tools exposed:
 *   sam_search_opportunities      — keyless SAM.gov HAL search
 *   sam_get_opportunity           — single notice by id (description + POCs + attachments)
 *   sam_fetch_description         — pull the full RFP body
 *   sam_attachment_url            — build the public download URL for a resourceId
 *   usas_search_awards            — share-of-wallet at agency × NAICS
 *   usas_search_individual_awards — line-item contracts
 *   usas_search_subagency_spending — buyer-office breakdown
 *   usas_lookup_agency            — "VA" → "Department of Veterans Affairs"
 *
 * Auth: zero. SAM.gov public + USAspending are both keyless. Pass
 * SAM_GOV_API_KEY env var to unlock higher rate limits + archive.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SamGovClient, type SamSetAside } from "./sam-gov/index.js";
import {
  lookupAgency,
  searchAwards,
  searchIndividualAwards,
  searchSubAgencySpending,
} from "./usaspending.js";

const SERVER_NAME = "govicon-mcp-sam-gov";
const SERVER_VERSION = "0.1.0";

// ─── Tool input schemas (Zod) ────────────────────────────────────

const SamSearchInput = z.object({
  query: z.string().optional().describe("Free-text title query"),
  ncode: z
    .string()
    .optional()
    .describe("NAICS code, e.g. '541512'"),
  organizationName: z
    .string()
    .optional()
    .describe("Issuing agency, e.g. 'Department of Veterans Affairs'"),
  state: z
    .string()
    .optional()
    .describe("Place-of-performance state, 2-letter, e.g. 'MD'"),
  setAside: z
    .array(z.string())
    .optional()
    .describe("Set-aside codes, e.g. ['SDVOSBC', 'WOSB']"),
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
      "Resource id from getOpportunity → resourceLinks (the URL-tail hex)",
    ),
});

const UsasSearchAwardsInput = z.object({
  agency: z.string().optional(),
  naics: z.string().optional(),
  fiscalYear: z.number().int().min(2007).optional(),
  setAside: z
    .enum(["SBA", "8A", "HZS", "SDVOSBC", "WOSB", "EDWOSB", "VSA", "VSS"])
    .optional(),
});

const UsasSearchIndividualInput = UsasSearchAwardsInput.extend({
  limit: z.number().min(1).max(50).optional(),
});

const UsasSubAgencyInput = z.object({
  agency: z.string(),
  fiscalYear: z.number().int().min(2007).optional(),
});

const UsasLookupAgencyInput = z.object({
  searchText: z.string().describe("Agency name or abbreviation"),
});

// ─── Tool catalog ────────────────────────────────────────────────

const TOOLS = [
  {
    name: "sam_search_opportunities",
    description:
      "Search SAM.gov federal contracting opportunities (keyless). Returns up to 50 active notices with title, agency, NAICS, and noticeId. Use to discover pursuits matching NAICS / agency / set-aside / state filters.",
    inputSchema: SamSearchInput,
  },
  {
    name: "sam_get_opportunity",
    description:
      "Fetch full detail for a single SAM.gov notice by 32-char hex noticeId. Returns title, agency, solicitation #, POCs, response deadline, attachments, and inline description body. Use BEFORE drafting bid/no-bid or compliance work.",
    inputSchema: SamGetOpportunityInput,
  },
  {
    name: "sam_fetch_description",
    description:
      "Return the full description / RFP body text for a notice as plain text. Useful when sam_get_opportunity returned a description URL instead of inline body, or when you need an LLM-friendly text dump.",
    inputSchema: SamFetchDescriptionInput,
  },
  {
    name: "sam_attachment_url",
    description:
      "Build the public download URL for an attachment resourceId. The URL returns a 303 redirect to a signed S3 URL — fetch with redirect:'follow' to get the file bytes.",
    inputSchema: SamAttachmentUrlInput,
  },
  {
    name: "usas_search_awards",
    description:
      "Aggregate share-of-wallet on USAspending. Given an agency × NAICS × fiscal year, returns top recipients by total $ + count. Use for competitive landscape questions ('who wins at VA in 541512?').",
    inputSchema: UsasSearchAwardsInput,
  },
  {
    name: "usas_search_individual_awards",
    description:
      "Line-item federal contracts on USAspending. Returns specific awards (recipient + $ + sub-agency + state + description). Use AFTER usas_search_awards when the user wants 'show me the actual contracts'.",
    inputSchema: UsasSearchIndividualInput,
  },
  {
    name: "usas_search_subagency_spending",
    description:
      "Break down a parent agency's spending by sub-agency / office. Surfaces which office controls the budget (e.g. VA OI&T vs VHA, DoD vs Army vs DISA).",
    inputSchema: UsasSubAgencyInput,
  },
  {
    name: "usas_lookup_agency",
    description:
      "Resolve a user-friendly agency reference ('VA', 'Veterans Affairs', 'DHS') to USAspending's canonical toptier name + 4-digit code. ALWAYS call this FIRST if the user uses an abbreviation — other USAspending tools require the canonical name.",
    inputSchema: UsasLookupAgencyInput,
  },
];

// ─── Server bootstrap ────────────────────────────────────────────

async function main() {
  const sam = new SamGovClient({
    apiKey: process.env.SAM_GOV_API_KEY?.trim() || undefined,
    logger: {
      warn: (msg, err) => {
        // Log to stderr so MCP host doesn't confuse it with JSON-RPC.
        // eslint-disable-next-line no-console
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
      const result = await runTool(name, args ?? {}, sam);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Tool error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(
    `[govicon-mcp-sam-gov] v${SERVER_VERSION} listening on stdio (${TOOLS.length} tools).`,
  );
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  sam: SamGovClient,
): Promise<unknown> {
  switch (name) {
    case "sam_search_opportunities": {
      const input = SamSearchInput.parse(args);
      const r = await sam.searchOpportunities({
        ...input,
        // Cast through after MCP host validates — SamSetAside is a
        // const-string union; we leave broad string here for UX.
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
    case "usas_search_awards":
      return await searchAwards(UsasSearchAwardsInput.parse(args));
    case "usas_search_individual_awards":
      return await searchIndividualAwards(
        UsasSearchIndividualInput.parse(args),
      );
    case "usas_search_subagency_spending":
      return await searchSubAgencySpending(UsasSubAgencyInput.parse(args));
    case "usas_lookup_agency": {
      const { searchText } = UsasLookupAgencyInput.parse(args);
      return await lookupAgency(searchText);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Hand-rolled Zod → JSON Schema converter for the small subset we use
 * (z.object, z.string, z.number, z.array, z.enum, z.optional, .describe).
 * Avoids the ~50KB `zod-to-json-schema` dep for this minimal surface.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as unknown as { _def: { typeName: string } })._def;
  const tn = def.typeName;
  const description = (schema as unknown as { description?: string }).description;

  if (tn === "ZodObject") {
    const shape = (
      schema as unknown as { shape: Record<string, z.ZodTypeAny> }
    ).shape;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const child = zodToJsonSchema(value);
      properties[key] = child;
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
  if (tn === "ZodString") {
    return { type: "string", ...(description ? { description } : {}) };
  }
  if (tn === "ZodNumber") {
    return { type: "number", ...(description ? { description } : {}) };
  }
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
  // Fallback — let the MCP host tolerate it.
  return { type: "string", ...(description ? { description } : {}) };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[govicon-mcp-sam-gov] FATAL:", err);
  process.exit(1);
});
