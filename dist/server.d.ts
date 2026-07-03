#!/usr/bin/env node
/**
 * @cliwant/mcp-sam-gov — Model Context Protocol server for SAM.gov
 * + USAspending + Federal Register + eCFR + Grants.gov + GAO + wage/pricing.
 *
 * 42 keyless tools wrapping every public federal-contracting data
 * source that doesn't require an API key. (NOTE: a sibling PR adds 2
 * integrity tools bumping the pre-this count 41→43; this PR adds ONLY the GAO
 * tool 41→42. The header count MUST be reconciled at merge to 44 if both land.)
 * Compatible with:
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
export {};
//# sourceMappingURL=server.d.ts.map