<div align="center">

# @cliwant/mcp-sam-gov

### **$4 trillion of public federal data, one `npm install` away.**

The most comprehensive **keyless** MCP server for US federal contracting + spending + regulation + partner vetting. **111 tools across 31 keyless federal data sources** that work today, in any AI agent.

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
| 5+ separate vendor APIs / scrapers | 1 unified surface, 111 tools across 31 sources |
| LLMs hallucinate NAICS codes / agency names | Anti-hallucination autocomplete guards built-in |
| Brittle scraping breaks weekly | Daily live smoke test ([badge above](#)) |
| Procurement officer → IT ticket → 3-week wait | Claude Desktop double-click install |

The federal data this wraps is **public domain**. There is no good reason it should cost a five-figure subscription to query.

---

## What this gives Claude (and other AI agents)

| Domain | What you can ask | Sources |
|---|---|---|
| 🔍 **Opportunities & solicitations** | "Find SAM.gov solicitations under NAICS 541512 closing this month" — read the SOW, POCs, attachments | SAM.gov, Grants.gov |
| 💰 **Spending, awards & competition** | "Show me Booz Allen wins at VA last fiscal year; top 10 PSC categories at DoD" | USAspending, FPDS, GAO |
| 🕵️ **Entity & partner vetting** | "Screen this firm: OFAC sanctions, SAM exclusions, single-audit findings, bank health, EPA compliance" | OFAC, SAM, FAC, FDIC, EPA ECHO |
| 📈 **Financial disclosure (SEC)** | "Pull this public company's revenue trend and latest 10-K filings" | SEC EDGAR |
| ⚖️ **Regulatory & legislative** | "What VA cybersecurity rules were published this quarter? Any open Regulations.gov dockets?" | Federal Register, Regulations.gov, eCFR, FAR/DFARS, Congress.gov, GovInfo |
| 💲 **Pricing, labor & fiscal** | "GSA CALC labor-rate band for a systems analyst; SCA wage determination for this county; CPI escalation" | GSA CALC, SAM WDs, BLS, US Treasury |
| 🏥 **Health & research funding** | "NIH/NSF grants on this topic; recruiting clinical trials; industry payments to this physician" | NIH RePORTER, NSF, ClinicalTrials.gov, CMS Open Payments, NPPES |
| 🛡 **Cyber compliance** | "Is this CVE on the CISA KEV must-patch list?" | NVD, CISA KEV |
| 🌐 **Trade, geo & disaster** | "HTS tariff for this product; Census tract for this address; FEMA declarations in this state" | USITC HTS, US Census, FEMA, Socrata, CKAN |
| 🎓 **Grants & datasets** | "Cybersecurity grants posted in the last 30 days; discover federal open datasets" | Grants.gov, data.gov |

**111 tools across 31 keyless federal data sources. Zero API keys.** (An earlier 52-tool build measured roughly p50 ~0.25s / p95 ~0.8s against production federal APIs; latency varies by source and upstream load — treat it as fast, not a benchmarked guarantee.)

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

This installs the MCP server **plus** a [SKILL.md](./skills/sam-gov/SKILL.md) workflow guide that teaches Claude when + how to use each of the 111 tools.

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

Restart Claude Desktop fully (system tray quit on Windows / Quit menu on macOS), then look for the 🔨 icon. You should see "sam-gov (111 tools)".

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

### Regulatory & legislative
- "Find FAR sections about SDVOSB set-aside requirements"
- "Turn this RFP's cited FAR/DFARS clause list into a Section L/M compliance matrix"
- "What new VA cybersecurity rules were published this quarter?"
- "Any Federal Register documents on the public-inspection desk from DoD today?"
- "Search Regulations.gov dockets on 'contractor cybersecurity' and pull the public comments"
- "Discover federal open datasets about 'wildfire' on data.gov"
- "Is there a Federal Register doc number 2026-08333? Pull the citation."

### Partner & entity vetting
- "Screen 'Acme Defense LLC' against the OFAC sanctions list and SAM exclusions"
- "Look up NPI 1234567890 in NPPES — is this provider active?"
- "Does this subcontractor have adverse Single Audit findings in the Federal Audit Clearinghouse?"
- "How healthy is the bank on cert #3510 — risk ratios and quarterly financials?"
- "Pull this public company's revenue trend and latest 10-K from SEC EDGAR"
- "Any EPA compliance/enforcement flags for this facility?"

### Compliance & eligibility
- "What's the SBA small-business size standard for NAICS 541512?"
- "Search the eCFR for the exact text of a rule"
- "What's the US import duty rate (HTS) for lithium-ion batteries?"

### Pricing, labor & fiscal
- "GSA CALC ceiling-rate band for a senior systems analyst"
- "Find the SCA wage determination for Baltimore County, MD and give me the fringe rates"
- "How much has CPI-U risen over the last 3 years for an escalation clause?"
- "What's the current total US public debt (Debt to the Penny)?"

### Cyber
- "Is CVE-2021-44228 (Log4Shell) on the CISA KEV must-patch list, and what's the due date?"

### Health & research funding
- "NIH RePORTER projects on mRNA vaccines funded last year"
- "Recruiting clinical trials for diabetes sponsored by industry"
- "Industry payments to physicians in CA from the CMS Open Payments Research dataset"

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

### `DATA_GOV_API_KEY` — the api.data.gov / api.gsa.gov family

A handful of sources ride the shared **api.data.gov** gateway — Congress.gov, GovInfo, Regulations.gov, FAC, NPPES, and the data.gov v4 dataset catalog. They work **keyless** out of the box via the public `DEMO_KEY` (a low shared hourly quota). Set `DATA_GOV_API_KEY` to raise those limits substantially:

```json
{
  "mcpServers": {
    "sam-gov": {
      "command": "mcp-sam-gov",
      "env": { "DATA_GOV_API_KEY": "your-key-here" }
    }
  }
}
```

Get one free (instant, no wait) at [api.data.gov/signup](https://api.data.gov/signup). The same key is accepted across all api.data.gov / api.gsa.gov sources. Like the SAM key, it is sent only on the wire (never logged); unset simply means `DEMO_KEY`. BLS sources similarly accept an optional free `BLS_API_KEY` to lift their daily quota.

### Keys & higher limits — the full inventory

**Most tools are keyless.** Only **Census** (`census_business_patterns`) and **FRED** (`fred_search_series`, `fred_series_observations`) *require* a key — those sources have no keyless tier, so the tool throws without one. The other five keys are *optional*: they only raise a rate limit or unlock a single filter. **Every key below is free.**

| Env var | Required? | What it unlocks | Free signup |
|---|---|---|---|
| `CENSUS_API_KEY` | **Required** | `census_business_patterns` (no keyless tier — throws without it) | [api.census.gov/data/key_signup.html](https://api.census.gov/data/key_signup.html) |
| `FRED_API_KEY` | **Required** | the 2 FRED tools (no keyless tier — throw without it) | [fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html) |
| `DATA_GOV_API_KEY` | Optional | higher limits on all api.data.gov sources (Regulations.gov, FAC, NPPES, CMS, data.gov catalog, GSA per-diem) — lifts the shared `DEMO_KEY` cap | [api.data.gov/signup](https://api.data.gov/signup/) |
| `SAM_GOV_API_KEY` | Optional | authenticated SAM.gov v2 search + the organization-name filter | [open.gsa.gov/api/get-opportunities-public-api](https://open.gsa.gov/api/get-opportunities-public-api/) |
| `BLS_API_KEY` | Optional | the BLS v2 tier (~500 queries/day vs keyless ~25/day) | [data.bls.gov/registrationEngine](https://data.bls.gov/registrationEngine/) |
| `NVD_API_KEY` | Optional | a higher NVD rate limit (`cve_lookup`) | [nvd.nist.gov/developers/request-an-api-key](https://nvd.nist.gov/developers/request-an-api-key) |
| `SOCRATA_APP_TOKEN` | Optional | higher Socrata throttling limits | [evergreen.data.socrata.com/signup](https://evergreen.data.socrata.com/signup) |

**Two ways to set any key** — pick one:

1. **Host env block** — the `"env": { … }` object shown in the examples above.
2. **A `.env` file** in the server's working directory — configure your keys **once**:
   ```
   CENSUS_API_KEY=your-key-here
   FRED_API_KEY=your-key-here
   # optional — raise limits / unlock filters
   SAM_GOV_API_KEY=your-key-here
   ```
   The server auto-loads `.env` at startup. A real environment variable always wins over `.env` (standard precedence), and `.env` is git-ignored so your keys never get committed.

**Ask the server which keys it needs.** The keyless **`api_key_status`** tool lists every key, whether it's required or optional, the free signup URL + what it unlocks, and whether each is **currently configured** (a boolean — the key value is never shown). Creating the account at the signup URL is your one manual step; the server automates *discovery* (`api_key_status`) and *configuration* (`.env`). To confirm a key actually works, call that source's own tool.

---

## Tool catalog (111 tools)

Grouped by workflow. Every tool is keyless by default; a handful gain higher limits from an optional free key (noted above). Descriptions are condensed — each tool's own `inputSchema` carries the full contract and honesty caveats.

<details>
<summary><b>Opportunities & solicitations — SAM.gov + Grants.gov (10 tools)</b></summary>

- `sam_search_opportunities` — keyless HAL search of active SAM.gov contracting opportunities
- `sam_search_shaping` — pre-solicitation radar (Sources Sought / Presol / Special Notices before the RFP exists)
- `sam_get_opportunity` — full detail by 32-char hex noticeId (POCs + attachments + body)
- `sam_fetch_description` — full RFP body as plain text
- `sam_fetch_attachment_text` — extract attachment text (RFP / SOW / Q&A / wage tables) from PDF + DOCX + text/HTML
- `sam_attachment_url` — build the public download URL for an attachment resourceId
- `sam_lookup_organization` — federal-organization id → canonical fullParentPathName
- `sam_lookup_notice_fields` — batch-fill nulled naics/set-aside/PoP/deadline for 1–100 noticeIds from the opt-in GSA daily CSV
- `grants_search` — Grants.gov federal grant opportunities (financial assistance, distinct from SAM contracts)
- `grants_get_opportunity` — full detail for a single grant opportunity by id
</details>

<details>
<summary><b>Spending, awards & competition — USAspending + FPDS + GAO (29 tools)</b></summary>

- `usas_search_awards` — aggregate share-of-wallet at agency × NAICS
- `usas_search_individual_awards` — line-item federal contracts (returns generatedInternalId)
- `usas_get_award_detail` — full award detail: period of performance, options, set-aside, competition
- `usas_search_awards_by_recipient` — every contract a recipient won in an agency × NAICS slice
- `usas_search_subawards` — enumerate subcontracts on prime awards (supply chain / teaming)
- `usas_search_recompetes` — recompete radar (PoP ending in a window, soonest-first, no silent drops)
- `usas_search_expiring_contracts` — **deprecated** alias of `usas_search_recompetes` (legacy shape)
- `usas_analyze_incumbent` — per-award incumbent + public recompete-pressure hints (labels, not a score)
- `usas_search_teaming_partners` — small-business teaming discovery by cert × NAICS × agency, exclusion-screened
- `usas_spending_over_time` — contract-spending time series (fiscal_year / quarter / month)
- `usas_search_agency_spending` — spending broken down by awarding agency
- `usas_search_subagency_spending` — break a parent agency down by sub-agency / office
- `usas_search_psc_spending` — spending by Product Service Code (PSC)
- `usas_search_cfda_spending` — spending by CFDA grant-program code
- `usas_search_state_spending` — spending by state / territory
- `usas_search_federal_account_spending` — spending by federal account / Treasury Account Symbol (TAS)
- `usas_search_recipients` — recipient list with parent/child hierarchy
- `usas_get_recipient_profile` — full recipient detail (UEI, alternate names, totals)
- `usas_get_agency_profile` — agency profile by toptier code (mission, abbreviation, website)
- `usas_get_agency_awards_summary` — award activity for a fiscal year (transaction count + obligations)
- `usas_get_agency_budget_function` — budget-function breakdown for an agency × fiscal year
- `usas_list_toptier_agencies` — all toptier agencies + current-FY obligations
- `usas_lookup_agency` — resolve 'VA' / 'DHS' → canonical toptier name + 4-digit code
- `usas_autocomplete_naics` — anti-hallucination NAICS guard
- `usas_autocomplete_recipient` — anti-hallucination recipient guard
- `usas_naics_hierarchy` — navigate the NAICS tree (2→4→6) + active-contract count per code
- `usas_glossary` — 151 federal-spending terms
- `fpds_search_awards` — FPDS-NG federal contract award actions (the authoritative award-action feed)
- `gao_protest_lookup` — recent GAO bid-protest decisions from the public Legal-Products RSS feed (recent window only)
</details>

<details>
<summary><b>Entity & partner vetting — OFAC · SAM · FAC · FDIC · EPA (14 tools)</b></summary>

- `ofac_screen_entity` — keyless OFAC denied-party / sanctions screening
- `sam_check_exclusions` — keyless SAM debarment/exclusion screening by name and/or UEI/CAGE
- `sam_integrity_lookup` — one-call integrity screen (exclusion verdict + honest FAPIIS pointer)
- `fac_search_audits` — Single Audit summaries from the Federal Audit Clearinghouse
- `fac_get_findings` — drill into the audit-RISK findings for an entity
- `fdic_search_institutions` — search the FDIC-insured-institution directory
- `fdic_institution_financials` — quarterly financial time-series for one institution (by cert #)
- `fdic_risk_ratios` — counterparty risk ratios for one institution
- `fdic_institution_history` — structural-change event log (mergers, charter changes)
- `fdic_branch_deposits` — branch-deposit footprint
- `fdic_bank_failures` — historical bank failures & assistance transactions
- `fdic_industry_summary` — industry & state banking-sector annual aggregates
- `echo_search_facilities` — search EPA-regulated facilities by state with compliance/enforcement screening
- `echo_facility_report` — EPA ECHO Detailed Facility Report for one facility (by FRS RegistryID)
</details>

<details>
<summary><b>Financial disclosure — SEC EDGAR (8 tools)</b></summary>

- `edgar_lookup_cik` — resolve a company ticker or name to its 10-digit SEC CIK
- `edgar_company_filings` — a company's SEC filings
- `edgar_company_facts` — curated XBRL financial facts for a filer
- `edgar_company_concept` — one filer × one XBRL concept × the complete reported time-series
- `edgar_xbrl_frames` — cross-filer XBRL cross-section (one concept across all filers for a period)
- `edgar_full_text_search` — full-text search across EDGAR filings, 2001–present
- `edgar_filing_index` — bulk cross-filer filing index for a quarter
- `edgar_daily_filing_index` — per-day cross-filer filing index
</details>

<details>
<summary><b>Regulatory & legislative — Federal Register · Regulations.gov · eCFR · FAR · Congress · GovInfo (18 tools)</b></summary>

- `fed_register_search_documents` — search Federal Register documents by query / agency / type / date
- `fed_register_get_document` — full detail for a document by number (citation, body URL, CFR refs)
- `fed_register_public_inspection` — the Federal Register public-inspection desk (pre-publication)
- `fed_register_list_agencies` — Federal Register agency slugs reference
- `regulations_search_dockets` — search Regulations.gov rulemaking dockets
- `regulations_search_documents` — search Regulations.gov rulemaking documents (rules, proposed rules, notices)
- `regulations_search_comments` — search public comments on rulemakings
- `regulations_get_docket` — fetch one Regulations.gov docket by id
- `ecfr_search` — full-text search across the entire CFR (titleNumber=48 for FAR)
- `ecfr_list_titles` — all 50 CFR titles + last-amended dates
- `far_clause_lookup` — authoritative FAR/DFARS clause text + its prescription (exact clause number)
- `far_search` — FAR/DFARS-scoped search (excludes GSAM, collapses to current in-force version)
- `far_compliance_matrix` — cited-clause list → proposal-ready Section L/M compliance matrix (eligibility gates flagged)
- `congress_search_bills` — search Congress.gov bills / legislation
- `congress_get_bill` — one bill by congress / type / number
- `govinfo_search_packages` — search GovInfo (GPO-authoritative) packages in a collection
- `govinfo_get_package` — one GovInfo package summary + download links (txt/xml/pdf/mods)
- `govinfo_list_collections` — the GovInfo collection catalog
</details>

<details>
<summary><b>Pricing, labor & fiscal — GSA CALC · SAM WDs · BLS · US Treasury (10 tools)</b></summary>

- `gsa_benchmark_labor_rates` — GSA CALC awarded ceiling-rate market band for a labor category (a distribution, not one price)
- `sam_search_wage_determinations` — find SCA / Davis-Bacon wage determinations for a locality
- `sam_get_wage_rates` — prevailing-wage + fringe / H&W rate table parsed from a WD, plus the EO minimum-wage floor
- `bls_timeseries` — BLS time series (CPI-U / ECI escalation, PPI, employment) — the pricing/escalation layer
- `bls_oews_wages` — benchmark occupational wages & employment (BLS OEWS) by area × occupation
- `bls_qcew` — county × NAICS market size / wages / location quotient (competition density)
- `treasury_debt_to_penny` — daily total US public debt outstanding (Treasury Fiscal Data)
- `treasury_avg_interest_rates` — average interest rate the Treasury pays by security type
- `treasury_monthly_statement` — Monthly Treasury Statement: receipts, outlays, deficit/surplus by month
- `treasury_query_dataset` — escape-hatch query over 5 confirmed Treasury Fiscal Data datasets
</details>

<details>
<summary><b>Health & research funding — NIH · NSF · ClinicalTrials · CMS · NPPES (9 tools)</b></summary>

- `nih_reporter_search_projects` — awarded NIH RePORTER research-grant projects
- `nsf_search_awards` — awarded NSF research-grant awards
- `nsf_get_award` — one NSF award by its numeric award id
- `clinicaltrials_search_studies` — federally-registered clinical studies with sponsor/funder enrichment
- `clinicaltrials_get_study` — one clinical study by NCT id (incl. brief summary)
- `clinicaltrials_facet_counts` — exact per-value study-count distribution over the whole registry
- `cms_search_datasets` — discover CMS Open Payments (Sunshine Act) datasets
- `cms_query_dataset` — query a CMS Open Payments datastore distribution (industry→physician payments)
- `nppes_lookup_provider` — CMS/HHS NPPES NPI Registry provider lookup
</details>

<details>
<summary><b>Cyber compliance — NVD + CISA KEV (2 tools)</b></summary>

- `cve_lookup` — look up NIST NVD CVE records
- `cisa_kev_lookup` — filter the CISA Known Exploited Vulnerabilities catalog (binding BOD 22-01 remediation due-dates)
</details>

<details>
<summary><b>Trade & tariffs — USITC (1 tool)</b></summary>

- `hts_lookup` — US import-tariff classification + duty rates from the USITC Harmonized Tariff Schedule
</details>

<details>
<summary><b>Geo, disaster & state/local open data — Census · FEMA · Socrata · CKAN (8 tools)</b></summary>

- `census_geocode_address` — resolve a one-line US address → matched address + Census geographies (tract, CD, place)
- `census_geographies_by_coordinates` — resolve a longitude/latitude point → Census geographies
- `fema_disaster_declarations` — FEMA disaster / emergency declarations by state, type, incident, year
- `fema_search_public_assistance` — FEMA Public Assistance funded projects
- `socrata_discover_datasets` — find Socrata dataset 4x4 ids by keyword
- `socrata_query` — query rows from an allowlisted Socrata/SODA open-data portal
- `ckan_discover_datasets` — find CKAN datastore resource ids by keyword
- `ckan_query` — query rows from an allowlisted CKAN datastore resource (state/city spend/checkbook)
</details>

<details>
<summary><b>Dataset discovery — data.gov (1 tool)</b></summary>

- `datagov_search_datasets` — search the data.gov v4 catalog for federal open datasets across all publishing agencies
</details>

<details>
<summary><b>Small business — SBA (1 tool)</b></summary>

- `sba_size_standard` — SBA small-business size standard for a 6-digit NAICS (set-aside eligibility gate)
</details>

---

## Reliability & offline snapshots

This server is built around one rule: **honest failure over confident fabrication.** Everything below is about *availability* of public data — none of it bypasses access controls.

**Keyless-first, and a down source *throws*.** Every source works with no API key. When a source is rate-limited, blocked, or down, the tool returns a **typed error** (`rate_limited` / `upstream_unavailable` / `schema_drift` / …) — it never invents rows and never reports a DOWN service as "0 results" or "not found". A genuine empty result and an outage are always distinguishable.

**Offline snapshots (on by default).** Some reference data changes slowly — the toptier-agency list, the top-level NAICS tree, the USAspending glossary, SBA size standards, the latest Treasury "Debt to the Penny." By default, when a live federal source is briefly unreachable from your egress, the server falls back to a **public, weekly-refreshed snapshot** of that slow-changing reference data, hosted at `raw.githubusercontent.com/cliwant/mcp-sam-gov/snapshots`. It only fetches on a **live hard-failure** (an outage / IP-reputation block), never during normal operation — public data, no telemetry. A served snapshot is **never presented as live** — the response carries `_meta.dataPath: "snapshot"` plus an `asOf` timestamp, and `complete` is forced off, so an AI agent (and you) always see the staleness. A rate limit (429) is always **honored**, never routed around onto the mirror.

- **Disable it (pure live-only):** set `SAMGOV_SNAPSHOT_BASE_URL=off`. Then no snapshot path is ever added and behavior is byte-for-byte identical to a live-only client.
- **Point at your own mirror:** set `SAMGOV_SNAPSHOT_BASE_URL` to your base URL to host the snapshots yourself instead of using the public default.

  ```json
  { "mcpServers": { "sam-gov": { "command": "mcp-sam-gov",
      "env": { "SAMGOV_SNAPSHOT_BASE_URL": "off" } } } }
  ```

- **Build the snapshots:** run `node scripts/build-snapshots.mjs` from any clean, non-blocked egress (a laptop / home / clean CI runner). It **self-diagnoses per-source reachability**, prints a reachability table, and writes a `manifest.json`. On partial coverage it refreshes only the sources it can reach and **leaves the last-good file in place** for the rest (stale-but-honest, never blanked). It exits non-zero only when *zero* sources were reachable (a fully blocked egress — the signal to re-run from a cleaner one).

- **The honest boundary.** This covers **public-data availability only.** The snapshot builder ingests only public, redistributable (public-domain / CC0) data, and the reader refuses to serve any envelope not marked `accessLevel: "public"`. It **honors rate limits** (a 429 is never routed around), uses **no proxies, no IP rotation, no auth/paywall/CAPTCHA bypass**, and refuses off-host redirects. If a source is blocked, the honest remedy is to build from a cleaner egress — not to evade the block.

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
// USAspending wrappers
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
