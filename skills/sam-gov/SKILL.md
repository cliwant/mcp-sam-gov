---
name: sam-gov
description: Query and analyze US federal contracting + spending + regulation data. 52 keyless tools across SAM.gov (active + pre-solicitation opportunities, RFPs, attachment TEXT extraction, contacting officers), USAspending.gov (awards, recipients, sub-agencies, time-series, NAICS/PSC analysis, recompete + incumbent pressure), Federal Register (rules, notices), eCFR + FAR/DFARS compliance (clause lookup, compliance matrix), SBA size standards, Grants.gov (federal grants), pricing & wage determinations (SCA/DBA + GSA CALC), and integrity/teaming/protests (exclusions, teaming partners, GAO protests). Use when the user asks about federal contracts, GovCon opportunities, SAM.gov notices, contracting officers, RFP / SOW analysis, reading the actual solicitation documents, FAR/DFARS clause compliance, agency spending, recompete signals, recipient win history, subawards, vetting a firm or teaming partner, bid pricing / wage floors, federal regulations, FAR clauses, federal grants, or any US Government procurement / spending question.
when_to_use: federal contracting, SAM.gov search, GovCon opportunities, pre-solicitation / sources sought shaping, RFP attachments, read the solicitation / SOW text, USAspending awards, contracting officer lookup, NAICS code search, SBA size standard, PSC code analysis, agency spending, recompete radar, incumbent pressure, capture brief, bid no-bid, set-aside contracts (SDVOSB / 8(a) / WOSB / HUBZone), federal procurement, FAR DFARS clause lookup, FAR compliance matrix, Section 889 / CMMC / limitations on subcontracting, vet a firm, debarment / exclusions, teaming partners, GAO bid protests, wage determination / SCA / DBA / CALC labor rates, Federal Register rules, eCFR compliance, grants.gov, federal grants, CFDA programs
disable-model-invocation: false
user-invocable: true
---

# SAM.gov + USAspending + Federal Register + eCFR/FAR + SBA + Grants + Pricing + Integrity skill

This skill teaches Claude how to use the **`sam-gov` MCP server** (52 keyless tools wrapped from `@cliwant/mcp-sam-gov`) to answer the full surface of US federal contracting / spending / regulation questions end-to-end — from discovering (and shaping) an opportunity, to **reading the actual RFP/SOW documents**, running a **FAR/DFARS compliance matrix**, **vetting a firm or teaming partner**, and **pricing the bid** against statutory wage floors.

> **Setup requirement:** the `sam-gov` MCP server must be reachable. If you installed via `/plugin install seungdo-keum/mcp-sam-gov`, the bundled `.mcp.json` registers the server automatically. Otherwise see the [repo README](https://github.com/cliwant/mcp-sam-gov) for manual MCP setup.

## Available tools — 52 total, all keyless

The MCP server exposes **the only sources of truth** for federal contracting + spending + regulation data — never invent notice IDs, contracting officer names, award amounts, NAICS codes, or regulation citations.

### SAM.gov — opportunities + attachment TEXT (8 tools)
| Tool | When to call |
|---|---|
| `sam_search_opportunities` | "Find solicitations…", "What's open at VA…", any discovery query. Filters: `query`, `ncode` (NAICS), `organizationName`, `state`, `setAside`, `limit`. |
| `sam_search_shaping` | **PRE-solicitation radar** — Sources Sought / Presolicitation / Special Notices BEFORE the RFP exists (defaults noticeType `['r','p','s']`; opt into `k/i/u`). Catch a requirement while it's still shapeable. Each row carries `noticeTypeCode`, `postedDate`, `responseDeadline` + `daysUntilResponse`; keyless list rows null `naics/setAside/place` — call `sam_get_opportunity` for those. |
| `sam_get_opportunity` | After search — full detail for ONE notice by 32-char hex `noticeId`. POCs, deadline, `attachments[]` (with download URLs), inline body. Call BEFORE bid/no-bid or compliance work. |
| `sam_fetch_description` | Full SOW / RFP body as plain text (when `sam_get_opportunity` gave a description URL instead of inline body). |
| `sam_attachment_url` | Build the public download URL for an attachment `resourceId` (303 → signed S3). |
| `sam_fetch_attachment_text` | **READ the actual attachment** — extract the TEXT of an RFP / SOW / Q&A / wage table PDF or HTML by its `attachments[].url` (resourceLinks). Returns `{ format, text, pages, filename, truncated }`. A DOCX/binary/scanned-image PDF it can't read keyless returns `text:null` + a disclosed reason (never fabricated). |
| `sam_lookup_organization` | Resolve a SAM.gov federal-organization id to its canonical `fullParentPathName`. |
| `sam_lookup_notice_fields` | **BATCH-fill** the keyless-nulled `naics/setAside/place/responseDeadline/type` for 1–100 `noticeId`s in ONE call from the GSA daily bulk CSV — instead of one `sam_get_opportunity` per notice. **OFF by default**: enable via `SAM_GOV_CSV_CACHE` or `SAM_GOV_ENABLE_CSV=1` (else returns `enabled:false` + how-to-enable note). Snapshot can lag live ~24h — confirm real-time-critical fields with `sam_get_opportunity`. |

### USAspending — awards + recipients (10 tools)
| Tool | When to call |
|---|---|
| `usas_search_awards` | Aggregate share-of-wallet at agency × NAICS. "Who wins the most at VA in 541512?" |
| `usas_search_individual_awards` | Line-item contracts. "Show me the actual contracts." Returns `generatedInternalId` for follow-up. |
| `usas_search_subagency_spending` | Buyer-office breakdown ("OI&T vs VHA"). |
| `usas_lookup_agency` | **ALWAYS call FIRST** when user uses an agency abbreviation ("VA", "DHS", "CMS"). |
| `usas_search_awards_by_recipient` | Recipient win history at agency × NAICS slice. "Show Booz Allen wins at VA last year." |
| `usas_search_subawards` | Supply-chain / teaming partners. "Who teams with Leidos at DISA?" |
| `usas_search_recompetes` | **Recompete radar (preferred)** — contracts whose current PoP ends inside a window around today (default −90d..+18mo), soonest-first. Filter by agency/naics/pscCodes/setAside/minAwardValue; counts (never drops) missing-end rows; flags truncated scans in `_meta`. Public signals only — no vulnerability score. |
| `usas_search_expiring_contracts` | **DEPRECATED alias** of `usas_search_recompetes` (legacy `{ contracts, searchedCount }` shape, N-months window). New callers should use `usas_search_recompetes`. |
| `usas_get_award_detail` | Per-award rich detail (`period_of_performance`, `base_and_all_options`, set-aside, competition extent, `number_of_offers`) by `generatedInternalId`. |
| `usas_analyze_incumbent` | **Incumbent + recompete-pressure** for ONE award (`generatedInternalId`): identity, IDV linkage, and PUBLIC pressure SIGNALS — `pctConsumed`, mod count, competition extent + offers, set-aside, days-to-PoP-end. Emits `pressureHints` (`single_offer` / `ceiling_nearly_exhausted` / `hard_stop_no_options`) as HINTS, NEVER a composite score (CPARS/protest/option-intent aren't public). Bounded ≤3 upstream calls. |

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

### eCFR + FAR/DFARS compliance (5 tools)
| Tool | When to call |
|---|---|
| `ecfr_search` | Full-text search across ALL of CFR. Pass `titleNumber=48` for FAR, `titleNumber=2` for federal financial assistance. For a specific FAR/DFARS clause, prefer `far_search`/`far_clause_lookup` (full-text mis-ranks GSAM over FAR). |
| `ecfr_list_titles` | List all 50 CFR titles with last-amended dates. |
| `far_search` | **"Which clauses touch topic X"** front-door — FAR/DFARS-scoped semantic search that EXCLUDES GSAM/agency supplements and collapses eCFR's historical version dupes to the CURRENT in-force one. `scope: far`(default)`|dfars|both`. Feeds `far_clause_lookup`. |
| `far_clause_lookup` | **Authoritative clause text + its PRESCRIPTION** ("As prescribed in…") for an EXACT clause number (e.g. `52.212-4`) via the eCFR versioner. Use this, NOT `ecfr_search`, for a known clause. Carries the `farOverhaulRisk` currency caveat; a genuinely-absent clause returns `not_found`. |
| `far_compliance_matrix` | **Shred an RFP's cited-clause list** (1–25 clauses, deduped) into a proposal-ready matrix: per-clause text + prescription + regulation + a `gate` flag for pass/fail award-eligibility GATES (Section 889 `52.204-24/25/26`, limitations on subcontracting `52.219-14`, DFARS cyber/CMMC `252.204-7012/7020/7021`). TRUTHFUL: a 404 clause → `unresolved`; an eCFR-down clause → SEPARATE `errored` bucket. Does NOT parse the PDF or give a compliance verdict. |

### SBA — size standards (1 tool)
| Tool | When to call |
|---|---|
| `sba_size_standard` | **"Is a firm SMALL for this NAICS?"** — the gate for set-aside eligibility and for vetting a teaming-partner candidate. By 6-digit NAICS (keyless sba.gov). Returns `standardType` (receipts/employees/assets), a normalized threshold (dollars or headcount), unit, and any footnote. No effective-date field → value is `asOf` retrieval; re-verify at sba.gov for high-stakes eligibility. Unknown NAICS → `found:false`. |

### Grants.gov — federal grants (2 tools)
| Tool | When to call |
|---|---|
| `grants_search` | Search federal grant opportunities by keyword / CFDA / agency. |
| `grants_get_opportunity` | Full grant detail (description, dates, award ceiling, applicant types, CFDA programs). |

### Pricing & wage determinations (3 tools)
| Tool | When to call |
|---|---|
| `sam_search_wage_determinations` | Find the **SCA or Davis-Bacon wage determination(s)** governing a locality (keyless SAM SGS). Filter by `coverage` (`sca`/`dba`), `state`, `county`, or WD number/title. Follow with `sam_get_wage_rates`. NOTE: `query` matches WD number/title, NOT occupation. |
| `sam_get_wage_rates` | Read the **prevailing-wage + fringe/H&W rate table** for a WD, PARSED from its plain-text doc, plus the Executive-Order minimum-wage floor. Distinguishes SCA (WD-wide H&W) vs DBA (per-craft fringe). Returns `parseConfidence`; supports `format:'parsed'|'raw'|'both'`. |
| `gsa_benchmark_labor_rates` | **GSA CALC market band** for a labor category (keyless) — a DISTRIBUTION (`currentRate` min/median/max + escalated medians), NOT a single price. CALC rates are CEILING/catalog and FULLY BURDENED (do not re-add wrap). Filter by businessSize/education/experience/sin to narrow. |

### Integrity, teaming & protests (4 tools)
| Tool | When to call |
|---|---|
| `sam_check_exclusions` | **Debarment/exclusion screen** — screen a firm/individual by `query` (name) and/or `uei`/`cage` against the SAM exclusions index (FAPIIS). Returns `excluded` (true iff ≥1 ACTIVE match), `matchCount`, per-record detail. CRITICAL: an EMPTY result means "no matching exclusion" — NOT proof of responsibility; a name match isn't identity-proof (verify UEI/CAGE). Needs ≥1 of query/uei/cage. |
| `sam_integrity_lookup` | **One-call integrity screen** — "any red flags on this entity?" Composes the exclusion verdict with a pointer to the FAPIIS record. Needs ≥1 of `uei`/`cage`/`name`. `integrityFlag` is `excluded` (≥1 active exclusion) else `review_fapiis` — it NEVER returns "clear" keylessly (FAPIIS has no keyless machine API). `fapiisRecords` is ALWAYS null; `fapiisUrl` deep-links the viewable page. |
| `usas_search_teaming_partners` | **Small-business teaming-partner discovery** by socioeconomic `cert` (enum) + optional naics/agency + lookback (keyless USAspending proxy). Ranks awardees by `agencyObligated` with award count + recency; optionally screens top candidates via `sam_check_exclusions` and drops active exclusions (`excludeDebarred`, default true). `cert` is AWARD-DERIVED, NOT the SBA cert of record — verify active certification in SAM/SBS. |
| `gao_protest_lookup` | **Recent GAO bid-protest decisions** from the public Legal-Products RSS feed (protester, agency, decision date, outcome sustained/denied/dismissed/withdrawn, solicitation #, PDF). Filter by agency/protester/solicitation/outcome, or pull one by `bNumber`. HONEST SCOPE: keyless covers only the RECENT feed window (~25 items) — always marked `complete:false`, NOT the full protest history. |

The exact tool names depend on the host — Claude Code prefixes MCP tools as `mcp__<server>__<tool>`, while bare MCP hosts use just `<tool>`. Use whichever your host gives you.

## 11 standard workflows

### Workflow 1 — Discover + qualify a single opportunity
1. `sam_search_opportunities` with NAICS / agency / state filter (or `sam_search_shaping` for pre-RFP Sources Sought / Presolicitation).
2. For most promising hit: `sam_get_opportunity` with its noticeId.
3. SOW depth: `sam_fetch_description` for full RFP text.
4. Attachments: surface URLs from step 2's `attachments` array — then read them (Workflow 8).
5. (Optional) Cross-check the issuing agency with `usas_get_agency_profile` for context.

### Workflow 2 — Competitive landscape ("who wins at agency X")
1. If agency is an abbreviation: `usas_lookup_agency` first to get canonical name.
2. `usas_search_awards` with canonical name + NAICS + fiscal year.
3. Line items: `usas_search_individual_awards`.
4. Office-level: `usas_search_subagency_spending`.
5. (Optional) Time-series: `usas_spending_over_time` to see trend.

### Workflow 3 — Recompete radar
1. `usas_search_recompetes` for agency × NAICS (window default −90d..+18mo; filter pscCodes/setAside/minAwardValue). Soonest-first.
2. For each candidate: `usas_get_award_detail` for period_of_performance + set-aside + competition extent, or `usas_analyze_incumbent` for the incumbent + PUBLIC `pressureHints` (single-offer / ceiling-exhausted / hard-stop-no-options).
3. Cross-reference with `sam_search_shaping` (same NAICS) to catch pre-RFP shaping (Sources Sought / Presolicitation) while the requirement is still shapeable.

### Workflow 4 — Teaming / supply-chain map
1. `usas_search_individual_awards` for prime awards at target agency.
2. `usas_search_subawards` filtered by prime to surface sub network.
3. For each sub: `usas_get_recipient_profile` to confirm alternate names / hierarchy, and `sba_size_standard(naics)` to confirm it's small for the set-aside NAICS.
4. To find NEW partners (not just existing subs): `usas_search_teaming_partners(cert, naics, agency)` — integrity-screened, ranked by agency award history (see Workflow 10).

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

### Workflow 8 — Read the solicitation documents (NEW)
Get past the metadata and read the ACTUAL RFP / SOW / Q&A / wage tables:
1. `sam_search_opportunities` (or `sam_search_shaping`) to find the notice.
2. `sam_get_opportunity(noticeId)` — returns the `attachments[]` array (each with a `url` / resourceLinks).
3. For each `attachments[].url`: `sam_fetch_attachment_text(url)` to extract the document TEXT (PDF + HTML; only sam.gov / api.sam.gov URLs are fetched).
4. Read the returned `text` to answer scope / eligibility / evaluation-criteria questions. A scanned/image-only PDF or a DOCX/binary it can't read keyless returns `text:null` + a disclosed reason — that's honest, not a failure (the doc may be image-only). Respect `truncated` (raise `maxChars` or page through).

### Workflow 9 — FAR/DFARS compliance check (NEW)
When the user needs the clauses on a topic, or to shred an RFP's cited-clause list:
1. `far_search(query, scope)` (`scope: far|dfars|both`) — find the FAR/DFARS clauses on a topic (excludes GSAM, current-version only).
2. `far_clause_lookup(clauseNumber)` — authoritative text + its **prescription** ("As prescribed in…") for each clause of interest. Use this, NOT `ecfr_search`, for an exact clause number.
3. `far_compliance_matrix(clauses[])` — turn the RFP's cited-clause list into a per-clause **text + prescription + eligibility-`gate`** matrix for a Section L/M response (flags Section 889 / limitations on subcontracting / CMMC gates; a 404 clause → `unresolved`, an eCFR-down clause → `errored` — no clause dropped).
4. Currency caveat: eCFR is the CODIFIED FAR; every response carries `farOverhaulRisk` — a Revolutionary-FAR-Overhaul agency class deviation may supersede a clause not shown here. Verify the controlling deviation for high-stakes gates.

### Workflow 10 — Vet a firm / teaming partner (NEW)
Before teaming with (or bidding against) a firm:
1. `sam_check_exclusions(name|uei)` — is it debarred/excluded? (empty ≠ "responsible"; verify UEI/CAGE on a name match.)
2. `sam_integrity_lookup(uei|cage|name)` — one-call integrity screen (`integrityFlag` = `excluded` or `review_fapiis`; never "clear" keylessly — check the `fapiisUrl` page).
3. `sba_size_standard(naics)` — is the firm SMALL for this NAICS (set-aside eligibility gate)?
4. `usas_search_teaming_partners(cert, naics, agency)` — discover ranked, integrity-screened small-business partners with the target cert + agency award history (`cert` is award-derived — verify active SBA certification in SAM/SBS before teaming).

### Workflow 11 — Price a bid (NEW)
Build a labor-cost basis of estimate:
1. `sam_search_wage_determinations(coverage, state, county)` — find the SCA/DBA wage determination(s) governing the place of performance.
2. `sam_get_wage_rates(wdNumber)` — the statutory prevailing-wage + fringe/H&W **floor** (parsed from the WD; check `parseConfidence`, read `raw` when low).
3. `gsa_benchmark_labor_rates(laborCategory)` — the GSA CALC awarded-ceiling market band (a min/median/max DISTRIBUTION, fully burdened — do not re-add wrap) to sanity-check proposed rates against the market.

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
- ❌ Treating `sam_fetch_attachment_text` `text:null` as a bug — it's honest: the doc may be a scanned/image-only PDF or a DOCX/binary not readable keyless (a reason is disclosed). ✅ Note the limitation; don't fabricate the contents.
- ❌ `ecfr_search` for an exact FAR clause number (e.g. `52.212-4`) — full-text mis-ranks GSAM `552.212-4` above the real clause. ✅ Use `far_clause_lookup` (exact) / `far_search` (topic → clauses).
- ❌ Reading `sam_check_exclusions` / `sam_integrity_lookup` empty as "the firm is responsible" — empty only means "no matching ACTIVE exclusion"; FAPIIS has no keyless API (never "clear"). ✅ Also check the `fapiisUrl` page; a name match isn't identity-proof — verify UEI/CAGE.
- ❌ Expecting `sam_lookup_notice_fields` to just work — it's OFF by default (returns `enabled:false` until `SAM_GOV_CSV_CACHE` / `SAM_GOV_ENABLE_CSV=1` is set). ✅ For a few notices, `sam_get_opportunity` per notice is fine.
- ❌ Treating `gsa_benchmark_labor_rates` as a single price or adding wrap on top — it's a fully-burdened CEILING distribution. And `gao_protest_lookup` is `complete:false` (recent ~25-item feed only), not the full protest history.

## Optional — higher rate limits + archives

The MCP server runs **keyless** by default. For higher SAM.gov rate limits + archives older than ~12 months, the operator can set `SAM_GOV_API_KEY` in the MCP server's `env` block. The agent doesn't need to know — auth path is transparent.
