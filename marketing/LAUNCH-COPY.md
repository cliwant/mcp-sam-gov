# Launch copy — English, impact-first

Drafts for LinkedIn, X/Twitter, Reddit, Show HN, and Product Hunt.
Use the framing intentionally — "build-in-public" voice for first
launches, "production-ready" voice once we have ≥ 50 stars.

---

## LinkedIn — long-form (build-in-public, ~1500 chars)

> **Federal contracting data is public domain. So why does it cost $30,000 a year to query?**
>
> Last week I started building an open-source MCP server that lets Claude (or ChatGPT, Codex, Cursor, Continue, Gemini CLI — any AI agent) search every active US federal opportunity, RFP, contract, recipient, and regulation. **Without an API key. Without registration. Without a vendor.**
>
> Today it's live: **`@cliwant/mcp-sam-gov`** — 36 tools across 5 federal data sources:
>
> 🔍 **SAM.gov** — 47,000+ active opportunities, full RFP attachments, contracting officer lookup
> 💰 **USAspending.gov** — every contract awarded since 2007, share-of-wallet by NAICS, recipient win history, sub-agency breakdown, time-series trends
> 📜 **Federal Register** — every rule, notice, proclamation, with CFR cross-references
> ⚖️ **eCFR** — full-text search across all 50 CFR titles, including FAR (Title 48) for compliance work
> 🎓 **Grants.gov** — every federal grant opportunity
>
> All keyless. All MIT-licensed. One npm install.
>
> **Why this matters for federal contractors**:
> Your AI agent can now read a SAM.gov RFP, pull the full SOW + attachments, look up who currently holds similar contracts at that agency, find expiring competitors, draft a bid/no-bid memo, and cite the relevant FAR section — in one conversation. The data is already public. The integration was the missing piece.
>
> **What I'm asking for**:
> Honest feedback. If you're in capture, BD, proposal management, or you build AI for the GovCon space — try it and tell me what's missing or broken. PRs welcome.
>
> Install (Claude Desktop one-click): https://github.com/cliwant/mcp-sam-gov/releases/latest
> npm: https://www.npmjs.com/package/@cliwant/mcp-sam-gov
> Repo: https://github.com/cliwant/mcp-sam-gov
>
> Built with the help of every federal API team that decided to publish a public endpoint. 🇺🇸

---

## X / Twitter — 6-tweet thread

**Tweet 1 (hook + visual)**
> US federal contracting data is public domain. So why does GovWin charge $30K-$100K/year to query it?
>
> Spent the week building an open-source MCP server that gives Claude / ChatGPT / Cursor full access to SAM.gov + USAspending + Federal Register + eCFR + Grants.gov.
>
> 36 tools. Zero API keys. Zero registration.
>
> [attach 30-sec demo gif]
>
> 🧵 1/6

**Tweet 2 (the package)**
> `npm install @cliwant/mcp-sam-gov`
>
> Or for non-developers: download a `.mcpb` file, double-click → Claude Desktop installs all 36 tools.
>
> Works in: Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI, any MCP-aware host.
>
> 2/6

**Tweet 3 (what it covers)**
> 🔍 SAM.gov — 47K+ active opportunities, full RFP body, contracting officer, attachments
> 💰 USAspending — every award since 2007, NAICS / PSC / state breakdowns, recipient win history
> 📜 Federal Register — rules, proclamations
> ⚖️ eCFR — FAR (Title 48) full-text search
> 🎓 Grants.gov
>
> 3/6

**Tweet 4 (the why)**
> Federal contractors pay $30K+/yr per seat for tools that wrap public APIs. The data has always been free. The integration layer was the bottleneck.
>
> This is the integration layer. MIT licensed.
>
> Daily live smoke test in CI — schema drift gets caught within 24h.
>
> 4/6

**Tweet 5 (anti-hallucination)**
> The trick that makes this trustworthy with LLMs:
>
> Anti-hallucination autocomplete guards. Before any agent can search by NAICS code, recipient name, or agency abbreviation, the tool offers a verified autocomplete.
>
> Result: it says "Department of Veterans Affairs", not "Department of Veterans".
>
> 5/6

**Tweet 6 (CTA)**
> If you work in federal contracting + AI:
>
> 🔗 https://github.com/cliwant/mcp-sam-gov
> 📦 https://www.npmjs.com/package/@cliwant/mcp-sam-gov
> 📋 36 tools listed: https://github.com/cliwant/mcp-sam-gov#tool-catalog
>
> Issues / PRs welcome. Looking for federal contractors to dogfood.
>
> 6/6

---

## Reddit r/govcon — value post

**Title:** Open-source toolkit: AI agents that actually search SAM.gov, USAspending, FAR — no API key, MIT

**Body:**
> Hey r/govcon. I spent the last week building something I wished existed.
>
> If you've used Claude / ChatGPT / Cursor for capture work, you know the pain: the agent hallucinates NAICS codes, makes up notice IDs, can't actually pull a SOW. The data exists — SAM.gov, USAspending, Federal Register, eCFR, Grants.gov are all public — but the AI tools can't reach it without a vendor in the middle.
>
> I built an open-source MCP server that gives any AI agent direct access to all five data sources. 36 tools, no API key required.
>
> **What it does:**
> - **SAM.gov**: search 47K+ active opportunities, pull full RFP body + attachments, look up contracting officers
> - **USAspending**: search awards by agency × NAICS × fiscal year, recipient win history, sub-awards, expiring contracts (recompete radar), spending trends over time
> - **Federal Register**: search rules/notices by agency, full citations
> - **eCFR**: full-text search across all 50 CFR titles (Title 48 = FAR for compliance work)
> - **Grants.gov**: search opportunities, full grant details
>
> **Anti-hallucination guards** built-in: NAICS codes, recipient names, and agency abbreviations all go through autocomplete first.
>
> **Install paths**:
> - Claude Desktop one-click: download a `.mcpb` from the releases page
> - Claude Code: `/plugin install cliwant/mcp-sam-gov`
> - Anywhere else: `npm install @cliwant/mcp-sam-gov`
>
> **What I'm hoping for**:
> Real feedback from people doing capture / proposal / BD work. What's broken? What's missing? What workflow do you wish your AI could do but can't right now?
>
> MIT license. Free forever. No telemetry, no tracking, no vendor lock.
>
> Repo: https://github.com/cliwant/mcp-sam-gov
> Discussion: happy to take feedback in this thread or as GitHub issues.

---

## Reddit r/LocalLLaMA — technical framing

**Title:** Built a 36-tool MCP server for US federal data (SAM.gov, USAspending, FAR, ...) — keyless, MIT

**Body:**
> Sharing in case it's useful. MCP server that wraps every keyless US federal data source under one stdio JSON-RPC interface.
>
> **Tools surface (36)**:
> - 5 SAM.gov (search, get, fetch description, attachment URL, organization lookup)
> - 24 USAspending (awards, recipients, sub-awards, time-series, NAICS / PSC / state / CFDA / federal-account, agency profile, recipient profile, autocomplete)
> - 3 Federal Register (search, get, list agencies)
> - 2 eCFR (search, list 50 CFR titles)
> - 2 Grants.gov (search, get)
>
> **Architecture**:
> - Node.js + TypeScript, Vercel AI SDK style
> - Zod-validated input schemas exposed via MCP `tools/list`
> - Structured error envelope: `{ ok: true, data }` or `{ ok: false, error: { kind, retryable, retryAfterSeconds, ... } }`
> - `Retry-After`-aware exponential backoff on 429/5xx
> - 5-min in-memory TTL cache for autocomplete + reference lookups
> - Daily live smoke test via GitHub Actions (auto-opens issue on schema drift)
> - Anti-hallucination guards via autocomplete (NAICS, recipient, agency)
>
> **Distribution**:
> - npm: `@cliwant/mcp-sam-gov`
> - MCP Registry: `io.github.cliwant/mcp-sam-gov`
> - `.mcpb` Claude Desktop one-click install
> - Claude Code Plugin (with bundled SKILL.md)
>
> Repo: https://github.com/cliwant/mcp-sam-gov
>
> Latency benchmarks (live, p50/p95): 250 / 750 ms across all 36 tools. CI runs the full smoke daily.
>
> Open to PRs and bug reports.

---

## Hacker News — Show HN (save for ≥ 50 stars + 1 case study)

**Title:** Show HN: Open-source MCP server for SAM.gov + USAspending — 36 tools, no API key

**Top comment (preempt the discussion)**:
> Hi HN. Author here. Background: GovWin / Sweetspot / GovDash sell access to federal contracting data starting around $30K/year per seat. The underlying data is public domain — SAM.gov, USAspending.gov, Federal Register, eCFR, Grants.gov.
>
> Built this so any AI agent (Claude Desktop, Cursor, Codex CLI, etc.) can query all five sources directly via MCP. 36 tools. No API key. MIT.
>
> Specifically interested in:
> - Edge cases. The federal API schemas drift; daily CI smoke catches most. What did I miss?
> - Tool gaps. USAspending alone has ~80 endpoints; I wrap 22. What did I leave out that you actually needed?
> - For the GovCon folks: would the workflow `search → pull SOW → recompete radar → compliance citation` actually save you time, or is the missing piece something else?

---

## Product Hunt — for v0.5+

(Skip until we have ≥ 100 stars + ≥ 5 case studies. Product Hunt rewards traction signals.)

---

## Email outreach to specific firms (for design partners)

**Subject:** Free federal data toolkit for your AI capture work — 60 sec to install

> Hi [name],
>
> Saw [their LinkedIn / their tweet / their company's recent SAM.gov activity]. I built an open-source MCP server that gives Claude / ChatGPT direct access to SAM.gov, USAspending, Federal Register, eCFR, and Grants.gov — keyless, no registration, MIT.
>
> Specifically thought of you because [their NAICS / their agency focus / their recompete pattern].
>
> 60-second install for Claude Desktop: https://github.com/cliwant/mcp-sam-gov/releases/latest
>
> I'm not selling anything. I want to know whether the 36 tools cover the workflow your team actually does, or whether I should keep building. 15 min next week if you've got it?
>
> [signature]

---

## Reusable assets

**Repo URLs**:
- GitHub: https://github.com/cliwant/mcp-sam-gov
- npm: https://www.npmjs.com/package/@cliwant/mcp-sam-gov
- MCP Registry: https://registry.modelcontextprotocol.io/v0/servers?search=cliwant
- Glama: https://glama.ai/mcp/servers/cliwant/mcp-sam-gov
- Latest release: https://github.com/cliwant/mcp-sam-gov/releases/latest

**One-line elevator pitches**:
- Engineer: "36-tool MCP server, 5 federal data sources, all keyless, MIT."
- Federal contractor: "AI agents that actually pull live SAM.gov data. Free. No vendor lock-in."
- Investor: "Replaces the $30K/year API-wrapper category with $0 OSS infrastructure."

**Talking points (hostile audience)**:
- "But this just wraps free APIs": Yes — that's the point. The wrapper layer was the bottleneck.
- "Won't last when the APIs change": Daily CI smoke test + auto-issue on schema drift. Average detection lag: 24h.
- "What's the business model": OSS is distribution. Cliwant runs other federal-AI products. This is the data layer.
- "Why isn't this on Product Hunt": Will be when there's real traction. PH rewards signal-heavy launches.
