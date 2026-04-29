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
export {};
//# sourceMappingURL=server.d.ts.map