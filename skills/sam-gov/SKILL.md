---
name: sam-gov
description: Query and analyze US federal contracting data from SAM.gov (active opportunities, RFP attachments, contracting officers) and USAspending.gov (awards, recipients, sub-agency spending). Use when the user asks about federal contracts, GovCon opportunities, SAM.gov notices, contracting officers, RFP / SOW analysis, agency spending, recompete signals, recipient win history, subawards, or any US Government procurement question.
when_to_use: federal contracting, SAM.gov search, GovCon opportunities, RFP attachments, USAspending awards, contracting officer lookup, NAICS code search, agency spending analysis, recompete radar, capture brief, bid no-bid, set-aside contracts (SDVOSB / 8(a) / WOSB / HUBZone), federal procurement
disable-model-invocation: false
user-invocable: true
---

# SAM.gov + USAspending skill

This skill teaches Claude how to use the **`sam-gov` MCP server** (8 tools wrapped from `@govicon/mcp-sam-gov`) to answer US federal contracting questions end-to-end.

> **Setup requirement:** the `sam-gov` MCP server must be reachable. If you installed via `/plugin install seungdo-keum/govicon-mcp-sam-gov`, the bundled `.mcp.json` registers the server automatically. Otherwise see the [repo README](https://github.com/seungdo-keum/govicon-mcp-sam-gov) for manual MCP setup.

## Available tools

The MCP server exposes 8 tools you should treat as the **only** sources of truth for SAM.gov + USAspending data — never invent notice IDs, contracting officer names, or award amounts.

| Tool | When to call |
|---|---|
| `mcp__sam-gov__sam_search_opportunities` | "Find solicitations…", "What's open at VA…", any discovery query. Filters: `query`, `ncode` (NAICS), `organizationName` (agency), `state`, `setAside`, `limit`. |
| `mcp__sam-gov__sam_get_opportunity` | After search — pull full detail for ONE notice by 32-char hex `noticeId`. Returns POCs, deadline, attachments, inline body. |
| `mcp__sam-gov__sam_fetch_description` | When the user asks for the full SOW / RFP body text. Returns plain-text. |
| `mcp__sam-gov__sam_attachment_url` | Build the public download URL for an attachment `resourceId`. |
| `mcp__sam-gov__usas_search_awards` | Aggregate share-of-wallet at agency × NAICS. "Who wins the most at VA in 541512?" |
| `mcp__sam-gov__usas_search_individual_awards` | Line-item contracts (recipient + $ + sub-agency + state + description). "Show me the actual contracts." |
| `mcp__sam-gov__usas_search_subagency_spending` | Buyer-office breakdown ("OI&T vs VHA"). |
| `mcp__sam-gov__usas_lookup_agency` | **ALWAYS call FIRST** when the user uses an agency abbreviation ("VA", "DHS", "CMS"). USAspending requires the canonical toptier name. |

The exact tool names depend on the host — Claude Code prefixes MCP tools as `mcp__<server>__<tool>`, while bare MCP hosts use just `<tool>`. Use whichever your host gives you.

## Standard workflows

### Workflow 1 — Discover + qualify a single opportunity
1. `sam_search_opportunities` with the user's NAICS / agency / state filter.
2. For the most promising hit: `sam_get_opportunity` with its noticeId.
3. If they ask for SOW depth: `sam_fetch_description` to dump full RFP text.
4. If they want to read the attachments: surface the URLs from step 2's `attachments` array.

### Workflow 2 — Competitive landscape ("who wins at agency X")
1. If the agency is an abbreviation: `usas_lookup_agency` first to get canonical name.
2. `usas_search_awards` with the canonical agency name + NAICS + fiscal year.
3. If they want line items: `usas_search_individual_awards` with the same filters.
4. If they want office-level detail: `usas_search_subagency_spending` for the parent agency.

### Workflow 3 — Recompete radar
1. `usas_search_individual_awards` filtered by agency × NAICS to find existing contracts.
2. Surface end-dates + recipients to identify upcoming recompetes.
3. Cross-reference with `sam_search_opportunities` (same NAICS) to find pre-RFP shaping (Sources Sought / Pre-solicitation notices).

### Workflow 4 — Teaming / supply-chain map
1. `usas_search_individual_awards` to find prime awards at the target agency.
2. `usas_search_subagency_spending` to identify which office buys most.
3. Recommend the user follow up with `usas_search_individual_awards` filtered by recipient name to surface a target prime's win history.

## Output discipline

- **Cite tool calls inline** when surfacing facts: "VA awarded $410M to Booz Allen across 28 contracts in FY26 (`usas_search_awards`)."
- **Never invent** notice IDs, solicitation numbers, contact emails, or contract amounts. If the tool returns nothing, say so plainly.
- Notice IDs starting with `demo-` are fictional fixtures shipped only by the studio's hosted demo — they are NOT real SAM.gov assets and do not exist on sam.gov.
- For RFP body text, quote at most one short snippet (< 15 words) — point users to `sam_attachment_url` for the full document.

## Common pitfalls

- ❌ "VA" passed directly as `agency` to USAspending tools → returns nothing. ✅ `usas_lookup_agency("VA")` first to get `Department of Veterans Affairs`.
- ❌ Searching for opportunities without a `ncode` or `query` filter — tens of thousands of results, useless. ✅ Always narrow to a NAICS, agency, or keyword.
- ❌ Quoting a noticeId from training data — they expire and rotate. ✅ Always do a fresh `sam_search_opportunities` first.
- ❌ Calling `sam_fetch_description` before `sam_get_opportunity` — you don't have the noticeId yet.

## Optional — higher rate limits + archives

The MCP server runs **keyless** by default (uses SAM.gov public HAL endpoints + USAspending v2). For higher rate limits + access to historical archives older than ~12 months, the operator can set `SAM_GOV_API_KEY` in the MCP server's `env` block. The agent does not need to know about this — the MCP server handles the auth path transparently.
