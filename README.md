# @govicon/mcp-sam-gov

> **Model Context Protocol** server for SAM.gov + USAspending.
> Drop-in tools for Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI — any MCP-aware host.

[한국어 README](./README.ko.md) · [日本語 README](./README.ja.md)

## What you get

8 tools your AI agent can call directly during a conversation:

| Tool | Purpose |
|---|---|
| `sam_search_opportunities` | Search SAM.gov opportunities (keyless HAL) |
| `sam_get_opportunity` | Pull full detail for a notice id (POCs, deadline, attachments, description) |
| `sam_fetch_description` | Get the full RFP body as plain text |
| `sam_attachment_url` | Build the public download URL for an attachment |
| `usas_search_awards` | USAspending — share-of-wallet at agency × NAICS |
| `usas_search_individual_awards` | USAspending — line-item contracts |
| `usas_search_subagency_spending` | USAspending — buyer-office breakdown |
| `usas_lookup_agency` | "VA" → "Department of Veterans Affairs" + toptier code |

**Auth:** zero. Both SAM.gov public + USAspending v2 are keyless. Pass `SAM_GOV_API_KEY` as an env var to unlock higher rate limits + the full historical archive (optional).

---

## Pre-publish install (private repo)

While this server is in private review, install + run from GitHub:

```bash
# Requires `gh auth login` (so npm can clone the private repo).
# The `prepare` script auto-builds dist/ during install.
npm install -g github:seungdo-keum/govicon-mcp-sam-gov

# After install, this binary is on your PATH:
govicon-mcp-sam-gov   # speaks MCP over stdio
```

Or clone + run from source:

```bash
gh repo clone seungdo-keum/govicon-mcp-sam-gov
cd govicon-mcp-sam-gov
npm install        # auto-builds dist/
node dist/server.js
```

Once the package goes public on npm, the install becomes:

```bash
npx -y @govicon/mcp-sam-gov   # zero-install run
```

---

## Wire it into your AI host

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "govicon-mcp-sam-gov"
    }
  }
}
```

(If you cloned instead of `npm install -g`, replace the command with `node` and add `args: ["/abs/path/to/govicon-mcp-sam-gov/dist/server.js"]`.)

Optional API key:

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "govicon-mcp-sam-gov",
      "env": { "SAM_GOV_API_KEY": "your-key-here" }
    }
  }
}
```

Restart Claude Desktop. The 8 tools appear under the 🔨 menu.

### Claude Code

Per-project (`.mcp.json` in your project root):

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "govicon-mcp-sam-gov"
    }
  }
}
```

Or globally via Claude Code's CLI:

```bash
claude mcp add sam-gov govicon-mcp-sam-gov
```

### Codex CLI

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.sam-gov]
command = "govicon-mcp-sam-gov"
args = []

# Optional API key:
# [mcp_servers.sam-gov.env]
# SAM_GOV_API_KEY = "your-key-here"
```

### Cursor

Settings → MCP → Add new MCP server:

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "govicon-mcp-sam-gov"
    }
  }
}
```

### Continue

Edit your Continue config (`~/.continue/config.json`):

```json
{
  "experimental": {
    "modelContextProtocolServer": {
      "transport": {
        "type": "stdio",
        "command": "govicon-mcp-sam-gov"
      }
    }
  }
}
```

### Gemini CLI

Edit `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "govicon-mcp-sam-gov"
    }
  }
}
```

### Anything else

If your host speaks MCP over stdio, point it at the `govicon-mcp-sam-gov` binary (or `node /path/to/dist/server.js`). No host-specific code.

---

## What the agent can do

Once wired, your assistant can answer questions like:

- "Find solicitations under NAICS 541512 in Maryland that close in the next 30 days"
- "Pull notice 5ef3db5daeb54099a96d487783a38bd0 — give me the SOW, contracting officer, and attachments"
- "Who are the top 5 recipients of VA contracts in NAICS 541519 last fiscal year?"
- "Show me Booz Allen's individual awards at DISA"
- "What's 'CMS' actually called in USAspending?"

It calls the right tool sequence automatically — no prompt engineering required on your end.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: govicon-mcp-sam-gov` | Confirm `npm install -g …` succeeded; check that npm's global `bin` is on your PATH (`npm config get prefix`) |
| Claude Desktop doesn't show the tools | Restart Claude Desktop after editing config; check `~/Library/Logs/Claude/mcp.log` |
| "permission denied" on Linux/macOS | `chmod +x $(which govicon-mcp-sam-gov)` (the package marks the bin executable, but some installers strip it) |
| `npm install` fails with "private repo" | Run `gh auth login` and `gh auth setup-git` first |
| Tools call but return empty | SAM.gov throttles aggressive callers; wait a minute. Or set `SAM_GOV_API_KEY` to use the higher-rate authenticated path |

---

## License

MIT — see [LICENSE](./LICENSE).

## Disclaimer

This server uses **publicly available** SAM.gov + USAspending endpoints. It is not affiliated with the General Services Administration, SAM.gov, USAspending.gov, or any federal agency. Federal procurement data is in the public domain.
