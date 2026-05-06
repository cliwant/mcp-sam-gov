/**
 * Cloudflare Worker — hosted demo for mcp-sam-gov.
 *
 * This is a HTTP-JSON wrapper around a subset of the keyless tools so
 * external evaluators can try them without running the stdio MCP server
 * locally. It is NOT a full Streamable-HTTP MCP transport — those need
 * @modelcontextprotocol/sdk's StreamableHTTPServerTransport, which is
 * Node-flavored and not yet runtime-clean for Workers. Doing that
 * properly is a separate piece of work tracked in HANDOFF.
 *
 * Endpoints:
 *   GET  /                  → service banner + tool list
 *   GET  /tools             → JSON list of available tools + schemas
 *   POST /tools/:name       → invoke a tool with JSON body args
 *
 * Available tools in this hosted demo (pure-keyless, Worker-safe):
 *   - sam_search_opportunities
 *   - usas_lookup_agency
 *   - usas_autocomplete_naics
 *   - usas_autocomplete_recipient
 *   - fed_register_search_documents
 *   - fed_register_list_agencies
 *   - fed_register_classify
 *   - sba_size_standard_lookup       (uses injected data)
 *   - sba_check_size_qualification    (uses injected data)
 *   - naics_revision_check            (uses injected data)
 *
 * NOT exposed (Node-only or stateful):
 *   - sam_get_opportunity / sam_fetch_description / sam_attachment_url
 *     (uses the SAM.gov HAL JSON via SamGovClient with an internal
 *     per-process retry/cache; safe to add later by injecting a
 *     fetch-only adapter)
 *   - usas_search_awards / sub-awards / vendor profile
 *     (require longer timeouts + multi-step state; safe to add later)
 *   - workflow_* composite tools
 *     (each fans out 4-6 upstream calls — Worker CPU budget concerns;
 *     safe to add behind a `?expand=true` query later)
 *
 * The keyless subset is enough to demonstrate the surface to an evaluator.
 *
 * Deploy:
 *   cd worker && wrangler deploy
 */

import * as usas from "../src/usaspending.js";
import * as fedreg from "../src/federal-register.js";
import * as sba from "../src/sba.js";
import * as naicsXwalk from "../src/naics-crosswalk.js";
import * as fedRegClassifier from "../src/fedreg-classifier.js";
import { sbaSizeStandards, naicsRevisionChanges } from "./data.js";

// Inject embedded JSON into the loaders ONCE at module load.
// This bypasses readFileSync / fs which doesn't exist in Workers.
sba._injectData(sbaSizeStandards as never);
naicsXwalk._injectData(naicsRevisionChanges as never);

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

const TOOLS: Record<string, { description: string; handler: ToolHandler }> = {
  usas_lookup_agency: {
    description:
      "Resolve an agency name/abbreviation to USAspending toptier_code + slug.",
    handler: async (a) => usas.lookupAgency((a.searchText as string) ?? ""),
  },
  usas_autocomplete_naics: {
    description: "Anti-hallucination: free-text NAICS resolver.",
    handler: async (a) =>
      usas.autocompleteNaics({
        searchText: (a.searchText as string) ?? "",
        limit: (a.limit as number | undefined) ?? 10,
      }),
  },
  usas_autocomplete_recipient: {
    description: "Anti-hallucination: free-text federal recipient resolver.",
    handler: async (a) =>
      usas.autocompleteRecipient({
        searchText: (a.searchText as string) ?? "",
        limit: (a.limit as number | undefined) ?? 10,
      }),
  },
  fed_register_search_documents: {
    description: "Search the Federal Register.",
    handler: async (a) =>
      fedreg.searchDocuments(a as Parameters<typeof fedreg.searchDocuments>[0]),
  },
  fed_register_list_agencies: {
    description: "List Federal Register agency slugs.",
    handler: async (a) =>
      fedreg.listAgencies({ perPage: (a.perPage as number | undefined) ?? 100 }),
  },
  fed_register_classify: {
    description: "Classify a Federal Register notice into 1 of 5 classes.",
    handler: async (a) =>
      fedRegClassifier.classifyDocument(
        a as Parameters<typeof fedRegClassifier.classifyDocument>[0],
      ),
  },
  sba_size_standard_lookup: {
    description: "Look up SBA size standard for a 6-digit NAICS.",
    handler: async (a) => sba.lookupSizeStandard((a.naicsCode as string) ?? ""),
  },
  sba_check_size_qualification: {
    description: "Check small-business eligibility under SBA standards.",
    handler: async (a) =>
      sba.checkQualification(a as Parameters<typeof sba.checkQualification>[0]),
  },
  naics_revision_check: {
    description: "Check NAICS code validity in 2022 + historical changes.",
    handler: async (a) =>
      naicsXwalk.checkNaicsRevision((a.naicsCode as string) ?? ""),
  },
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });

export default {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return json({}, 204);

    if (url.pathname === "/" || url.pathname === "") {
      return json({
        service: "mcp-sam-gov-hosted-demo",
        version: "0.5.0",
        upstream: "https://github.com/cliwant/mcp-sam-gov",
        notes:
          "HTTP-JSON wrapper around a subset of keyless tools. For the full 46-tool MCP surface, install the npm package and run the stdio server.",
        endpoints: {
          "GET /tools": "List available tools",
          "POST /tools/:name": "Invoke tool with JSON body",
        },
        availableTools: Object.keys(TOOLS),
      });
    }

    if (url.pathname === "/tools" && req.method === "GET") {
      return json({
        tools: Object.entries(TOOLS).map(([name, t]) => ({
          name,
          description: t.description,
        })),
      });
    }

    const toolMatch = url.pathname.match(/^\/tools\/([a-z0-9_]+)$/);
    if (toolMatch && req.method === "POST") {
      const name = toolMatch[1]!;
      const tool = TOOLS[name];
      if (!tool) {
        return json(
          { ok: false, error: { kind: "not_found", message: `Unknown tool: ${name}` } },
          404,
        );
      }
      let body: Record<string, unknown> = {};
      try {
        const text = await req.text();
        body = text ? JSON.parse(text) : {};
      } catch {
        return json(
          { ok: false, error: { kind: "invalid_input", message: "Body must be JSON." } },
          400,
        );
      }
      try {
        const data = await tool.handler(body);
        return json({ ok: true, data });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json(
          { ok: false, error: { kind: "upstream", message, retryable: true } },
          502,
        );
      }
    }

    return json({ ok: false, error: { kind: "not_found", message: "Route not found." } }, 404);
  },
};
