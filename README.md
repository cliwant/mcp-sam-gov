<div align="center">

# @cliwant/mcp-sam-gov

### **$4 trillion of public federal data, one `npm install` away.**

The most comprehensive **keyless** MCP server for US federal contracting + spending + regulation. **41 tools** (incl. SBA size standards + composite workflow primitives) that work today, in any AI agent.

[![npm](https://img.shields.io/npm/v/@cliwant/mcp-sam-gov?color=cb3837&label=%40cliwant%2Fmcp-sam-gov&logo=npm)](https://www.npmjs.com/package/@cliwant/mcp-sam-gov)
[![mcp-registry](https://img.shields.io/badge/MCP%20Registry-active-2ea44f?logo=anthropic)](https://registry.modelcontextprotocol.io/v0/servers?search=cliwant)
[![Glama score](https://glama.ai/mcp/servers/cliwant/mcp-sam-gov/badges/score.svg)](https://glama.ai/mcp/servers/cliwant/mcp-sam-gov)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Daily smoke](https://github.com/cliwant/mcp-sam-gov/actions/workflows/daily-smoke.yml/badge.svg)](https://github.com/cliwant/mcp-sam-gov/actions/workflows/daily-smoke.yml)

[English](./README.md) · [한국어](./README.ko.md) · [日本語](./README.ja.md)

</div>

---

## See it in action

```text
👤  user        Find active SAM.gov solicitations under NAICS 541512 closing this month
                                                                                          
🤖  Claude     → sam_search_opportunities { ncode: "541512", limit: 5 }                  
✓  47,478 active opportunities indexed                                                  
                                                                                          
   • 5ef3db5d…  VA Bulk Oxygen Tank Rental         closes 2026-05-15  ($1.05M)         
   • a000339c…  Articulating Boom Lifts             closes 2026-05-30  ($310K)          
   • be9c24ef…  CMOP Hazardous Waste Removal        closes 2026-06-12  ($2.7M)          

👤  user        Pull the SOW + contracting officer for the first one
                                                                                          
🤖  Claude     → sam_get_opportunity { noticeId: "5ef3db5d…" }                          
✓  Department of Veterans Affairs · Combined Synopsis/Solicitation                       
   POC:           Rebecca Gobble  <rebecca.gobble@va.gov>  +1-410-642-2411                 
   Set-aside:     Total Small Business                                                    
   Attachments:   1   ↓ 36C24526Q0460_1.docx (172 KB)                                     
   SOW preview:   "RFQ# 36C24526Q0460 — Bulk Oxygen Tank Rental, Fill, Telemetry…"        
```

**Zero API key. Zero registration. Zero signup.** Just plug it in and ask.

---

## Why this exists

| Status quo | With this MCP |
|---|---|
| GovWin: $30K-$100K/yr per seat | Free, MIT license |
| API key registration → wait 24h → quota tier shopping | `npm install` → working in 60s |
| 5 separate vendor APIs / scrapers | 1 unified surface, 41 tools |
| LLMs hallucinate NAICS codes / agency names | Anti-hallucination autocomplete guards built-in |
| Brittle scraping breaks weekly | Daily live smoke test ([badge above](#)) |
| Procurement officer → IT ticket → 3-week wait | Claude Desktop double-click install |

The federal data this wraps is **public domain**. There is no good reason it should cost a five-figure subscription to query.

---

## What this gives Claude (and other AI agents)

| Domain | What you can ask | Tools |
|---|---|---|
| 🔍 **Active opportunities** | "Find SAM.gov solicitations under NAICS 541512 closing this month" | 5 SAM.gov tools |
| 💰 **Awards & recipients** | "Show me Booz Allen wins at VA last fiscal year" | 8 USAspending tools |
| 📊 **Aggregate analysis** | "Top 10 PSC categories at DoD by spending FY26" | 6 USAspending tools |
| 🏛 **Agency profiles** | "What's VA's mission? FY25 budget breakdown?" | 3 USAspending tools |
| 🏢 **Recipient profiles** | "Pull Booz Allen's full recipient profile + alternate names" | 2 USAspending tools |
| 🧠 **Anti-hallucination** | NAICS / recipient / agency autocomplete + glossary | 5 USAspending tools |
| 📜 **Federal Register** | "What VA cybersecurity rules were published this quarter?" | 3 tools |
| ⚖️ **Regulations (FAR/CFR)** | "Find FAR sections about SDVOSB set-aside" | 2 eCFR tools |
| 🎓 **Federal grants** | "Cybersecurity grants posted in the last 30 days" | 2 Grants.gov tools |
| 🏷 **SBA size standards** | "Do we qualify as small business under NAICS 541512 with $28M revenue?" | 2 SBA tools (v0.4) |
| ⚡ **Composite workflows** | "Give me a capture brief on VA in NAICS 541512" | 3 workflow primitives (v0.4) |

**41 tools total. Zero API keys. p50 latency 257ms, p95 766ms** (live benchmarks against federal APIs).

### Composite workflow primitives (new in v0.4)

For the most common chains, single-call composite tools save ~6 round-trips per query:

| Tool | What it does | Replaces |
|---|---|---|
| `workflow_capture_brief` | 6-section federal capture intelligence in 1 call | 6 chained calls |
| `workflow_recompete_radar` | Contracts expiring + current incumbents + relevant rule changes | 4 chained calls |
| `workflow_vendor_profile` | Full vendor picture — canonical name, hierarchy, recent awards, sub-award trail | 4 chained calls |

Each composite handles partial failures gracefully (per-section `{ ok, data | error }` envelope) and synthesizes a one-line summary the agent can use as the "tl;dr".

See [cookbook/](./cookbook/) for working recipes for each.

---

## How do I install it? Pick the path that matches you.

### 🟢 Path 1 — Claude Desktop, one-click (no terminal needed)

Best for non-developers. Just download a file and double-click.

1. Download **`mcp-sam-gov.mcpb`** from the [latest release](https://github.com/cliwant/mcp-sam-gov/releases/latest).
2. Double-click the file. Claude Desktop opens with an "Install Extension" dialog.
3. Click **Install**.
4. Done. Start a new conversation and ask "Find active SAM.gov opportunities under NAICS 541512".

That's it. No PowerShell, no `npm`, nothing.

> Requires Claude Desktop ≥ 1.0 (which ships its own Node.js runtime).

### 🟡 Path 2 — Claude Code, one command

If you already use Claude Code (the CLI):

```bash
/plugin install cliwant/mcp-sam-gov
```

This installs the MCP server **plus** a [SKILL.md](./skills/sam-gov/SKILL.md) workflow guide that teaches Claude when + how to use each of the 36 tools.

### 🔵 Path 3 — Manual install for any MCP host (Codex, Cursor, Continue, Gemini)

For Codex CLI / Cursor / Continue / Gemini CLI / anything that speaks MCP:

```bash
gh repo clone cliwant/mcp-sam-gov
cd mcp-sam-gov
npm install --omit=dev
npm install -g .
```

After install, the binary `mcp-sam-gov` is on your PATH. Add this to your host config:

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "mcp-sam-gov"
    }
  }
}
```

Specific config locations per host: see [Host configurations](#host-configurations) below.

### ⚪ Path 4 — Direct path (zero install, just point at the file)

Skip installation entirely:

```bash
gh repo clone cliwant/mcp-sam-gov
cd mcp-sam-gov
npm install --omit=dev   # only runtime deps; dist/ is pre-built
```

Then point your host config at the absolute path:

```jsonc
{
  "mcpServers": {
    "sam-gov": {
      "command": "node",
      "args": ["C:\\Users\\you\\mcp-sam-gov\\dist\\server.js"]
    }
  }
}
```

---

## Host configurations

### Claude Desktop

`%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "sam-gov": { "command": "mcp-sam-gov" }
  }
}
```

(Or skip this entirely — use Path 1's `.mcpb` and it auto-configures.)

Restart Claude Desktop fully (system tray quit on Windows / Quit menu on macOS), then look for the 🔨 icon. You should see "sam-gov (36 tools)".

### Claude Code

Per-project `.mcp.json`:

```json
{ "mcpServers": { "sam-gov": { "command": "mcp-sam-gov" } } }
```

Or globally:

```bash
claude mcp add sam-gov mcp-sam-gov
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.sam-gov]
command = "mcp-sam-gov"
args = []
```

### Cursor

Settings → MCP → Add new MCP server:

```json
{ "mcpServers": { "sam-gov": { "command": "mcp-sam-gov" } } }
```

### Continue

`~/.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServer": {
      "transport": { "type": "stdio", "command": "mcp-sam-gov" }
    }
  }
}
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{ "mcpServers": { "sam-gov": { "command": "mcp-sam-gov" } } }
```

### Anything else

If your host speaks MCP over stdio, point it at `mcp-sam-gov`. No host-specific code.

---

## What questions can I ask?

Once installed, you can ask in natural language. The agent picks the right tool sequence automatically.

### Discovery
- "NAICS 541512 의 메릴랜드 입찰 중 30일 안에 마감되는 것 찾아줘"
- "Find active SAM.gov solicitations under NAICS 541512, MD only, closing in 30 days"
- "What's the canonical NAICS code for 'computer systems design'?"

### RFP analysis
- "Pull noticeId 5ef3db5daeb54099a96d487783a38bd0 — give me the SOW, contracting officer, and attachments"
- "Show me the full RFP body for that notice"

### Competitive landscape
- "Top 5 recipients of VA contracts in NAICS 541519 last fiscal year"
- "Show me Booz Allen's individual awards at DISA"
- "Who are the sub-contractors on Leidos' VA contracts?"
- "What's CMS in USAspending? (resolve the abbreviation)"

### Trends & aggregation
- "How has VA 541512 spending trended over the last 5 fiscal years?"
- "Top 10 states by federal contracting spend in 541512"
- "Top PSC categories at DoD by spending"
- "Federal grant programs in cybersecurity by total $"

### Agency intelligence (capture brief)
- "Give me a capture brief on VA: mission, FY26 budget breakdown, top sub-agencies"
- "What's VA's transaction volume for FY25?"

### Recompete radar
- "VA 541512 contracts expiring in next 12 months over $1M"
- "Pull period of performance for award CONT_AWD_..."

### Regulatory
- "Find FAR sections about SDVOSB set-aside requirements"
- "What new VA cybersecurity rules were published this quarter?"
- "Is there a Federal Register doc number 2026-08333? Pull the citation."

### Grants
- "Cybersecurity grants posted in the last 30 days"
- "Pull grant id 361238"

---

## Optional — higher rate limits + archives

The MCP server runs **keyless** by default. For higher SAM.gov rate limits + the full archive (notices older than ~12 months), set `SAM_GOV_API_KEY` in your host's env block:

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "mcp-sam-gov",
      "env": { "SAM_GOV_API_KEY": "your-key-here" }
    }
  }
}
```

Get a free key at [sam.gov/SAM/pages/public/searchKeyData.jsf](https://sam.gov/SAM/pages/public/searchKeyData.jsf). The agent doesn't need to know — the key path is transparent.

---

## Tool catalog (36 tools)

<details>
<summary><b>SAM.gov — opportunities + attachments (5 tools)</b></summary>

- `sam_search_opportunities` — keyless HAL search (~47K active)
- `sam_get_opportunity` — full detail by 32-char hex noticeId (POCs + attachments + body)
- `sam_fetch_description` — full RFP body as plain text
- `sam_attachment_url` — public download URL for resourceId
- `sam_lookup_organization` — federal-organization id → fullParentPathName
</details>

<details>
<summary><b>USAspending — awards + recipients (8 tools)</b></summary>

- `usas_search_awards` — share-of-wallet at agency × NAICS
- `usas_search_individual_awards` — line items (returns generatedInternalId)
- `usas_search_subagency_spending` — buyer-office breakdown
- `usas_lookup_agency` — abbreviation → canonical name
- `usas_search_awards_by_recipient` — recipient win history
- `usas_search_subawards` — supply-chain / teaming
- `usas_search_expiring_contracts` — recompete radar
- `usas_get_award_detail` — period of performance, options, set-aside, competition
</details>

<details>
<summary><b>USAspending — aggregate analysis (6 tools)</b></summary>

- `usas_spending_over_time` — fiscal_year / quarter / month time series
- `usas_search_psc_spending` — PSC market structure
- `usas_search_state_spending` — geographic distribution
- `usas_search_cfda_spending` — grant programs
- `usas_search_federal_account_spending` — Treasury Account Symbols (TAS)
- `usas_search_agency_spending` — top buying agencies for NAICS / set-aside
</details>

<details>
<summary><b>USAspending — agency profile (3 tools)</b></summary>

- `usas_get_agency_profile` — mission, abbreviation, website
- `usas_get_agency_awards_summary` — transaction count + obligations
- `usas_get_agency_budget_function` — budget breakdown by program area
</details>

<details>
<summary><b>USAspending — recipient profile (2 tools)</b></summary>

- `usas_search_recipients` — list with parent/child hierarchy
- `usas_get_recipient_profile` — full detail (DUNS, UEI, alternate names, totals)
</details>

<details>
<summary><b>USAspending — reference / autocomplete (5 tools)</b></summary>

- `usas_autocomplete_naics` — anti-hallucination NAICS guard
- `usas_autocomplete_recipient` — anti-hallucination recipient guard
- `usas_naics_hierarchy` — navigate NAICS tree
- `usas_glossary` — 151 federal-spending terms
- `usas_list_toptier_agencies` — list all toptier agencies + obligations
</details>

<details>
<summary><b>Federal Register — rules + notices (3 tools)</b></summary>

- `fed_register_search_documents` — search by query / agency / type / date
- `fed_register_get_document` — citation, body URL, CFR refs
- `fed_register_list_agencies` — agency slugs reference
</details>

<details>
<summary><b>eCFR — Code of Federal Regulations (2 tools)</b></summary>

- `ecfr_search` — full-text search (titleNumber=48 for FAR)
- `ecfr_list_titles` — all 50 CFR titles + last-amended dates
</details>

<details>
<summary><b>Grants.gov — federal grants (2 tools)</b></summary>

- `grants_search` — opportunity search
- `grants_get_opportunity` — full grant detail
</details>

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Claude Desktop 🔨 menu doesn't show `sam-gov` | Fully quit Claude Desktop (system tray on Windows / Quit menu on macOS) and reopen. Check `%APPDATA%\Claude\logs\mcp*.log` |
| `command not found: mcp-sam-gov` | Confirm `npm install -g .` succeeded; check that npm's global bin is on PATH (`npm config get prefix`) |
| `MODULE_NOT_FOUND ...dist/server.js` after `npm install -g github:...` | npm bug with git-dep symlinks on Windows. Use the clone + `npm install -g .` recipe (Path 3) instead. |
| `EPERM: operation not permitted, rmdir` during install | Previous failed install left dangling files. Run `rmdir /s /q "%APPDATA%\npm\node_modules\@cliwant"` (or `@govicon` if you installed an early version) then retry. |
| `npm install` fails with "private repo" / 404 | The repo is now public — should not happen. If it does, try `git clone https://github.com/cliwant/mcp-sam-gov.git` directly. |
| Tools return empty results | SAM.gov rate-limits aggressive callers. Wait 1 minute. Or set `SAM_GOV_API_KEY` for the higher-rate authenticated path. |
| "Tool error: USAspending POST returned 400" | Usually means a field has a wrong type (e.g. fiscal year as string). Check the tool input schema in your host's tool browser. |

---

## Use as a TypeScript / JavaScript library (no MCP)

Beyond the MCP server, this package also exports the underlying federal-data
clients as importable modules. Useful if you're building your own SaaS, AI
agent, or CLI and want programmatic access without spawning an MCP server.

```bash
npm install @cliwant/mcp-sam-gov
```

```ts
// SAM.gov client
import { SamGovClient } from "@cliwant/mcp-sam-gov/sam-gov";

const sam = new SamGovClient(); // keyless
const result = await sam.searchOpportunities({ ncode: "541512", limit: 5 });
const opp = await sam.getOpportunity("5ef3db5daeb54099a96d487783a38bd0");
```

```ts
// USAspending wrappers (22 functions)
import * as usas from "@cliwant/mcp-sam-gov/usaspending";

const recompete = await usas.searchExpiringContracts({
  agency: "Department of Veterans Affairs",
  naics: "541512",
  monthsUntilExpiry: 12,
});
const recipient = await usas.getRecipientProfile("ed02855e-60d7-2540-...-P");
```

```ts
// Federal Register / eCFR / Grants.gov
import * as fedreg from "@cliwant/mcp-sam-gov/federal-register";
import * as ecfr from "@cliwant/mcp-sam-gov/ecfr";
import * as grants from "@cliwant/mcp-sam-gov/grants";

const farResults = await ecfr.search({ query: "SDVOSB", titleNumber: 48 });
```

This is the canonical home for the Cliwant federal-data libraries — there
is no separate library package. Two earlier repos (`govicon-sam-gov` and
`govicon-mcp-sam-gov`) have been archived and consolidated here. All
client code lives in `src/sam-gov/`, `src/usaspending.ts`,
`src/federal-register.ts`, `src/ecfr.ts`, `src/grants.ts`.

## License

MIT — see [LICENSE](./LICENSE).

## Disclaimer

This server uses **publicly available** federal API endpoints. It is not affiliated with the General Services Administration, SAM.gov, USAspending.gov, the Office of the Federal Register, the National Archives, Grants.gov, or any federal agency. Federal procurement, spending, and regulation data is in the public domain.
