# @govicon/mcp-sam-gov

> **MCP server + Claude Skill** for SAM.gov + USAspending.
> Two distribution formats from one repo:
>
> 1. **MCP server** (universal) — works with Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI, or any MCP-aware host
> 2. **Claude Code Plugin / Skill** (Claude Code only) — `/plugin install` registers BOTH the MCP server *and* a workflow-guide skill that teaches Claude when + how to use the tools

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

## Pick your install path

There are two separate install flows depending on what you're using:

| Flow | Use when | Format |
|---|---|---|
| **A. MCP server** | You're on Claude Desktop, Codex CLI, Cursor, Continue, Gemini CLI, or any non-Claude-Code MCP host | Standalone npm package + manual host config |
| **B. Claude Plugin** | You're using Claude Code (the CLI) | `/plugin install` registers the MCP server **and** the SKILL.md workflow guide together |

Flow A works everywhere. Flow B is a Claude-Code-specific superset that adds the workflow-guide skill on top of the same MCP server.

---

## Flow A — MCP server (any host)

`npm install -g github:...` direct is **broken on Windows** for this style
of package due to a long-standing npm bug with git-deps + symlinks (the
github clone gets evicted from npm's tmp cache before extraction
completes, leaving a dangling symlink). Use **clone + local global-install**
on every OS — it works identically everywhere.

### A.1 — Recommended: clone + install (Windows / macOS / Linux)

```bash
# Requires `gh auth login` (private repo clone permission).
gh repo clone seungdo-keum/govicon-mcp-sam-gov
cd govicon-mcp-sam-gov
npm install --omit=dev   # runtime deps only — dist/ is pre-built and committed
npm install -g .         # registers `govicon-mcp-sam-gov` on PATH globally

# After install, this binary is on your PATH:
govicon-mcp-sam-gov   # speaks MCP over stdio
```

Then [wire it into your AI host](#wire-it-into-your-ai-host) using the
`govicon-mcp-sam-gov` command.

### A.2 — Alternative: direct path (no global install)

Skip the `npm install -g .` step and point your MCP host at the absolute
path to `dist/server.js`:

```jsonc
{
  "mcpServers": {
    "sam-gov": {
      "command": "node",
      "args": ["C:\\Users\\you\\govicon-mcp-sam-gov\\dist\\server.js"]
    }
  }
}
```

### A.3 — Once we publish to npm proper

```bash
npx -y @govicon/mcp-sam-gov   # zero-install run
```

---

## Flow B — Claude Code plugin (MCP server + Skill workflow guide)

If you use **Claude Code** (the CLI), install via the plugin system to get
both the MCP server *and* a [SKILL.md workflow guide](./skills/sam-gov/SKILL.md)
that teaches Claude when + how to use the 8 tools (with worked examples
for opportunity discovery, recompete radar, teaming maps, etc.).

### Install via `/plugin`

In a Claude Code session:

```
/plugin install seungdo-keum/govicon-mcp-sam-gov
```

This single command:
1. Clones the repo to your Claude plugin dir.
2. Reads `.claude-plugin/plugin.json` to register the plugin.
3. Reads `.mcp.json` to register the `sam-gov` MCP server (uses the global `govicon-mcp-sam-gov` binary — install Flow A first to put it on PATH, OR edit `.mcp.json` to use a `node`-with-absolute-path command).
4. Loads `skills/sam-gov/SKILL.md` so Claude auto-triggers it on relevant queries ("find SAM.gov opportunities", "analyze federal contracts", etc.).

### What you get with the plugin (vs MCP server alone)

| Capability | Flow A (MCP only) | Flow B (Plugin) |
|---|---|---|
| 8 SAM.gov + USAspending tools | ✅ | ✅ |
| Workflow guidance ("when do I use which tool?") | ❌ — Claude infers from tool descriptions | ✅ — explicit SKILL.md walks through 4 named workflows |
| Auto-trigger on natural language | Depends on host | ✅ — skill `description` field tunes activation |
| Anti-hallucination guardrails ("never invent noticeIds", "demo-* IDs are fictional") | ❌ | ✅ — codified in skill body |
| Multi-step playbooks (recompete radar, teaming map) | ❌ | ✅ |
| Works on Claude Desktop / Codex / Cursor / Gemini | ✅ | ❌ — Claude Code only |

For non-Claude-Code hosts, stick with Flow A.

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
| `MODULE_NOT_FOUND ...dist/server.js` after `npm install -g github:...` on Windows | npm bug with git-dep symlinks. Don't use `npm install -g github:...`; use the clone + `npm install -g .` recipe above. |
| `EPERM: operation not permitted, rmdir` during install | A previous failed install left dangling files. Run: `rmdir /s /q "%APPDATA%\npm\node_modules\@govicon"` then retry. |
| `'tsc' is not recognized` during install | You're hitting the (now-removed) prepare hook from an old version of the package. `git pull` + reinstall. |
| `command not found: govicon-mcp-sam-gov` | Confirm `npm install -g .` succeeded; check that npm's global `bin` is on your PATH (`npm config get prefix`) |
| Claude Desktop doesn't show the tools | Restart Claude Desktop after editing config; check `~/Library/Logs/Claude/mcp.log` (macOS) or `%APPDATA%\Claude\logs\mcp*.log` (Windows) |
| "permission denied" on Linux/macOS | `chmod +x $(which govicon-mcp-sam-gov)` |
| `npm install` fails with "private repo" | Run `gh auth login` and `gh auth setup-git` first |
| Tools call but return empty | SAM.gov throttles aggressive callers; wait a minute. Or set `SAM_GOV_API_KEY` for the higher-rate authenticated path |

---

## License

MIT — see [LICENSE](./LICENSE).

## Disclaimer

This server uses **publicly available** SAM.gov + USAspending endpoints. It is not affiliated with the General Services Administration, SAM.gov, USAspending.gov, or any federal agency. Federal procurement data is in the public domain.
