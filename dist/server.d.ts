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
import { z } from "zod";
import { SamGovClient } from "./sam-gov/index.js";
export declare const SERVER_NAME = "mcp-sam-gov";
export declare const SERVER_VERSION = "0.5.0";
type ToolDef = {
    name: string;
    description: string;
    inputSchema: z.ZodTypeAny;
};
export declare const TOOLS: ToolDef[];
export declare function runTool(name: string, args: Record<string, unknown>, sam: SamGovClient): Promise<unknown>;
/**
 * Hand-rolled Zod → JSON Schema converter (subset we use).
 */
export declare function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown>;
export {};
//# sourceMappingURL=server.d.ts.map