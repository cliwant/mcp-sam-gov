---
name: sam-gov
description: Query and analyze US federal contracting + spending + regulation data. 36 keyless tools across SAM.gov (active opportunities, RFPs, attachments, contacting officers), USAspending.gov (awards, recipients, sub-agencies, time-series, NAICS/PSC analysis), Federal Register (rules, notices), eCFR (regulations including FAR/DFARS), and Grants.gov (federal grants). Use when the user asks about federal contracts, GovCon opportunities, SAM.gov notices, contracting officers, RFP / SOW analysis, agency spending, recompete signals, recipient win history, subawards, federal regulations, FAR clauses, federal grants, or any US Government procurement / spending question.
when_to_use: federal contracting, SAM.gov search, GovCon opportunities, RFP attachments, USAspending awards, contracting officer lookup, NAICS code search, PSC code analysis, agency spending, recompete radar, capture brief, bid no-bid, set-aside contracts (SDVOSB / 8(a) / WOSB / HUBZone), federal procurement, Federal Register rules, FAR DFARS regulation, eCFR compliance, grants.gov, federal grants, CFDA programs
disable-model-invocation: false
user-invocable: true
---

# SAM.gov + USAspending + Federal Register + eCFR + Grants.gov skill

This skill teaches Claude how to use the **`sam-gov` MCP server** (36 keyless tools wrapped from `@cliwant/mcp-sam-gov`) to answer the full surface of US federal contracting / spending / regulation questions end-to-end.

> **Setup requirement:** the `sam-gov` MCP server must be reachable. If you installed via `/plugin install seungdo-keum/mcp-sam-gov`, the bundled `.mcp.json` registers the server automatically. Otherwise see the [repo README](https://github.com/cliwant/mcp-sam-gov) for manual MCP setup.

## Available tools — 36 total, all keyless

The MCP server exposes **the only sources of truth** for federal contracting + spending + regulation data — never invent notice IDs, contracting officer names, award amounts, NAICS codes, or regulation citations.

### SAM.gov — opportunities + attachments (5 tools)
| Tool | When to call |
|---|---|
| `sam_search_opportunities` | "Find solicitations…", "What's open at VA…", any discovery query. Filters: `query`, `ncode` (NAICS), `organizationName`, `state`, `setAside`, `limit`. |
| `sam_get_opportunity` | After search — full detail for ONE notice by 32-char hex `noticeId`. POCs, deadline, attachments, inline body. |
| `sam_fetch_description` | Full SOW / RFP body as plain text. |
| `sam_attachment_url` | Build the public download URL for an attachment `resourceId`. |
| `sam_lookup_organization` | Resolve a SAM.gov federal-organization id to its full path name. |

### USAspending — awards + recipients (8 tools)
| Tool | When to call |
|---|---|
| `usas_search_awards` | Aggregate share-of-wallet at agency × NAICS. "Who wins the most at VA in 541512?" |
| `usas_search_individual_awards` | Line-item contracts. "Show me the actual contracts." Returns `generatedInternalId` for follow-up. |
| `usas_search_subagency_spending` | Buyer-office breakdown ("OI&T vs VHA"). |
| `usas_lookup_agency` | **ALWAYS call FIRST** when user uses an agency abbreviation ("VA", "DHS", "CMS"). |
| `usas_search_awards_by_recipient` | Recipient win history at agency × NAICS slice. "Show Booz Allen wins at VA last year." |
| `usas_search_subawards` | Supply-chain / teaming partners. "Who teams with Leidos at DISA?" |
| `usas_search_expiring_contracts` | Recompete radar — contracts expiring in next N months. |
| `usas_get_award_detail` | Per-award rich detail (period_of_performance, options, set-aside, competition extent) by `generatedInternalId`. |

### USAspending — aggregate analysis (6 tools)
| Tool | When to call |
|---|---|
| `usas_spending_over_time` | Time-series — group by fiscal_year / quarter / month. "How has VA 541512 spending trended?" |
| `usas_search_psc_spending` | PSC (Product Service Code) market structure. |
| `usas_search_state_spending` | Geographic — top states by federal $. |
| `usas_search_cfda_spending` | Grant program (CFDA) breakdown. |
| `usas_search_federal_account_spending` | Map money to budget line items (Treasury Account Symbols). |
| `usas_search_agency_spending` | Top buying agencies for a NAICS / set-aside. |

### USAspending — agency profile (3 tools)
| Tool | When to call |
|---|---|
| `usas_get_agency_profile` | Agency mission, abbreviation, website, subtier count. By `toptierCode`. |
| `usas_get_agency_awards_summary` | High-level award activity (transaction count + obligations) by FY. |
| `usas_get_agency_budget_function` | Budget breakdown by program area. |

### USAspending — recipient profile (2 tools)
| Tool | When to call |
|---|---|
| `usas_search_recipients` | Recipient list with parent/child hierarchy. Returns `id` for follow-up. |
| `usas_get_recipient_profile` | Full detail by recipient_id (DUNS, UEI, alternate names, business types, location, totals). |

### USAspending — reference / autocomplete (5 tools)
| Tool | When to call |
|---|---|
| `usas_autocomplete_naics` | **ANTI-HALLUCINATION GUARD** — confirm NAICS codes before using them. |
| `usas_autocomplete_recipient` | **ANTI-HALLUCINATION GUARD** — confirm exact recipient legal name. |
| `usas_naics_hierarchy` | Navigate NAICS tree (2-digit → 6-digit). |
| `usas_glossary` | 151 federal-spending terms. Confirm terminology before answering. |
| `usas_list_toptier_agencies` | List all toptier agencies + current FY obligations. |

### Federal Register — rules + notices (3 tools)
| Tool | When to call |
|---|---|
| `fed_register_search_documents` | Search rules / notices / proclamations by agency / type / date. |
| `fed_register_get_document` | Full doc detail (body URL, citation, CFR refs) by document_number. |
| `fed_register_list_agencies` | List Federal Register agencies + slugs. |

### eCFR — Code of Federal Regulations (2 tools)
| Tool | When to call |
|---|---|
| `ecfr_search` | Full-text search across CFR. Pass `titleNumber=48` for FAR (Federal Acquisition Regulation), `titleNumber=2` for federal financial assistance. |
| `ecfr_list_titles` | List all 50 CFR titles with last-amended dates. |

### Grants.gov — federal grants (2 tools)
| Tool | When to call |
|---|---|
| `grants_search` | Search federal grant opportunities by keyword / CFDA / agency. |
| `grants_get_opportunity` | Full grant detail (description, dates, award ceiling, applicant types, CFDA programs). |

The exact tool names depend on the host — Claude Code prefixes MCP tools as `mcp__<server>__<tool>`, while bare MCP hosts use just `<tool>`. Use whichever your host gives you.

## 7 standard workflows

### Workflow 1 — Discover + qualify a single opportunity
1. `sam_search_opportunities` with NAICS / agency / state filter.
2. For most promising hit: `sam_get_opportunity` with its noticeId.
3. SOW depth: `sam_fetch_description` for full RFP text.
4. Attachments: surface URLs from step 2's `attachments` array.
5. (Optional) Cross-check the issuing agency with `usas_get_agency_profile` for context.

### Workflow 2 — Competitive landscape ("who wins at agency X")
1. If agency is an abbreviation: `usas_lookup_agency` first to get canonical name.
2. `usas_search_awards` with canonical name + NAICS + fiscal year.
3. Line items: `usas_search_individual_awards`.
4. Office-level: `usas_search_subagency_spending`.
5. (Optional) Time-series: `usas_spending_over_time` to see trend.

### Workflow 3 — Recompete radar
1. `usas_search_expiring_contracts` for agency × NAICS × N months.
2. For each candidate: `usas_get_award_detail` to get period_of_performance + set-aside + competition extent.
3. Cross-reference with `sam_search_opportunities` (same NAICS) to find pre-RFP shaping (Sources Sought / Pre-solicitation notices).

### Workflow 4 — Teaming / supply-chain map
1. `usas_search_individual_awards` for prime awards at target agency.
2. `usas_search_subawards` filtered by prime to surface sub network.
3. For each sub: `usas_get_recipient_profile` to confirm size standards / alternate names.

### Workflow 5 — Capture brief / agency intelligence (NEW)
1. `usas_lookup_agency` → canonical name + toptier code.
2. `usas_get_agency_profile` — mission + scale.
3. `usas_get_agency_budget_function` — where the budget actually goes.
4. `usas_search_subagency_spending` — buying offices.
5. `usas_spending_over_time` (group=fiscal_year) — multi-year trend.
6. `usas_search_state_spending` — geographic spend distribution.

### Workflow 6 — Regulatory context for a pursuit (NEW)
When the user asks about FAR / DFARS / set-aside policy / cybersecurity rules:
1. `ecfr_search` (titleNumber=48 for FAR) — find the relevant section text.
2. `fed_register_search_documents` (agency + recent date range) — find proposed rules / amendments.
3. `fed_register_get_document` — pull the exact citation + body.
4. Quote at most 1 short snippet (< 15 words) from regulation text. Always include the eCFR section path or Federal Register citation.

### Workflow 7 — Grants pivot (NEW)
When the user pivots from contracts to grants (very common for SDVOSB / 8(a)):
1. `grants_search` with keyword / CFDA.
2. `grants_get_opportunity` — full grant detail.
3. (Optional) `usas_search_cfda_spending` — see who's already winning that grant program.

## Output discipline (anti-hallucination)

- **Cite tool calls inline** when surfacing facts: "VA awarded $410M to Booz Allen across 28 contracts in FY26 (`usas_search_awards`)."
- **Never invent** notice IDs, NAICS codes, recipient names, contract amounts, regulation citations. If a tool returns nothing, say so.
- **Use autocomplete guards FIRST**:
  - User mentions a NAICS theme without code → `usas_autocomplete_naics` to confirm.
  - User mentions a recipient name → `usas_autocomplete_recipient` to confirm exact USAspending-canonical legal name.
  - User mentions an agency abbreviation → `usas_lookup_agency` to get canonical name + toptier code.
- **Quote sparingly** from RFP body / regulation text — at most 1 snippet, < 15 words. Point to the source URL.
- Notice IDs starting with `demo-` are fictional fixtures from non-OSS demos; they don't exist on sam.gov.

## Common pitfalls

- ❌ "VA" passed directly as `agency` to USAspending tools → returns nothing. ✅ `usas_lookup_agency("VA")` first.
- ❌ Searching opportunities without a `ncode` or `query` filter — useless deluge. ✅ Always narrow.
- ❌ Quoting an old noticeId from training data — they expire. ✅ Always do a fresh `sam_search_opportunities`.
- ❌ Calling `sam_fetch_description` before `sam_get_opportunity` — you don't have the noticeId yet.
- ❌ Confusing `usas_search_cfda_spending` (grants) with `usas_search_psc_spending` (contracts) — different award types.
- ❌ Using a NAICS code from training without verification — they get retired. ✅ `usas_autocomplete_naics` to confirm currency.
- ❌ Agency name spelled wrong (e.g. "VA Department" vs canonical "Department of Veterans Affairs") → empty results. ✅ Always use `usas_lookup_agency`.

## Optional — higher rate limits + archives

The MCP server runs **keyless** by default. For higher SAM.gov rate limits + archives older than ~12 months, the operator can set `SAM_GOV_API_KEY` in the MCP server's `env` block. The agent doesn't need to know — auth path is transparent.
