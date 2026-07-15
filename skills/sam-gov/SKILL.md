---
name: sam-gov
description: Query and analyze the full surface of US federal contracting + spending + regulation + partner-vetting + market data. 120 tools across 37 federal data sources (keyless-first — only 4 sources need a free key). Covers SAM.gov opportunities (active + pre-solicitation, RFP/SOW attachment TEXT, contacting officers), USAspending + FPDS awards/recipients/competition/recompetes, GAO protests, entity vetting (OFAC sanctions, SAM exclusions, FAC single-audit, FDIC bank health, EPA ECHO), SEC EDGAR financials, Federal Register / Regulations.gov / eCFR + FAR/DFARS / Congress / GovInfo, pricing & labor & fiscal (GSA CALC, SCA/DBA wage determinations, BLS CPI/OEWS/QCEW, Treasury, BEA regional GDP, Census CBP market sizing, FRED macro, GSA per-diem), health & research funding (NIH/NSF/ClinicalTrials/CMS/NPPES), cyber compliance (NVD CVE + CISA KEV), trade tariffs (HTS), geo/disaster/state-local open data (Census geocode, FEMA, Socrata, CKAN), lobbying influence (Senate LDA), DOL labor-enforcement, data.gov + SBA size standards. Use for any US federal procurement / spending / regulation / vetting / market-sizing / macro question.
when_to_use: federal contracting, SAM.gov search, GovCon opportunities, pre-solicitation shaping, RFP attachments / read the SOW text, USAspending awards, FPDS award actions, contracting officer lookup, NAICS / PSC analysis, agency spending, recompete radar, incumbent pressure, capture brief, bid no-bid, set-aside contracts (SDVOSB / 8(a) / WOSB / HUBZone), FAR/DFARS clause lookup, FAR compliance matrix, Section 889 / CMMC, vet a firm, OFAC sanctions, debarment / exclusions, single-audit findings, bank health (FDIC), EPA compliance, SEC EDGAR financials, teaming partners, GAO bid protests, wage determination / SCA / DBA / CALC labor rates, BLS CPI escalation / OEWS wages / QCEW market size, Treasury fiscal data, BEA regional GDP, Census business patterns / market sizing, FRED macro (GDP/CPI/rates), GSA per-diem travel cost, Federal Register / Regulations.gov rules, eCFR, Congress bills, GovInfo, grants.gov / federal grants, CFDA, NIH / NSF / clinical trials / CMS Open Payments / NPPES, CVE / CISA KEV cyber, HTS tariff, FEMA disasters, Socrata / CKAN open data, Senate LDA lobbying, DOL wage-hour / OSHA enforcement, data.gov datasets, SBA size standard, which API keys are set
disable-model-invocation: false
user-invocable: true
---

# SAM.gov federal-data skill — 120 tools across 37 sources

This skill teaches Claude how to use the **`sam-gov` MCP server** (120 tools wrapped from `@cliwant/mcp-sam-gov`) to answer the full surface of US federal contracting / spending / regulation / vetting / market questions end-to-end — from discovering (and shaping) an opportunity, to **reading the actual RFP/SOW documents**, running a **FAR/DFARS compliance matrix**, **vetting a firm** (sanctions, exclusions, audits, bank health, EPA), **sizing a market** (establishments + wages + regional GDP), pricing the bid against statutory wage floors, and pulling **macro context** for escalation.

> **Setup:** the `sam-gov` MCP server must be reachable. `/plugin install cliwant/mcp-sam-gov` registers it automatically; otherwise see the [repo README](https://github.com/cliwant/mcp-sam-gov). Host prefixing: Claude Code exposes tools as `mcp__sam-gov__<tool>`; bare MCP hosts use just `<tool>`. Use whichever your host gives you.

## Tool inventory — 120 tools, keyless-first

**Keyless-first: 33 of 37 sources need no key. Only 4 sources require a free key** (marked 🔑 below): Census CBP (`census_business_patterns`), FRED (`fred_search_series`, `fred_series_observations`), BEA (`bea_regional_data`), and DOL's *data* endpoint (`dol_get_dataset`; DOL's catalog is keyless). Those 4 tools **throw** an honest config error without a key. A handful of others take an *optional* free key for higher limits (see the Keys section). The server is **the only source of truth** — never invent notice IDs, officer names, award amounts, NAICS codes, or regulation citations.

### Opportunities & solicitations — SAM.gov + Grants.gov (10)
- `sam_search_opportunities` — search active SAM.gov contracting opportunities (filters: query, ncode/NAICS, organizationName, state, setAside, limit).
- `sam_search_shaping` — **pre-solicitation radar**: Sources Sought / Presol / Special Notices before the RFP exists (keyless rows null naics/setAside/place — get those via `sam_get_opportunity`).
- `sam_get_opportunity` — full detail for ONE notice by 32-char hex noticeId (POCs, deadline, `attachments[]`, body). Call BEFORE bid/no-bid or compliance work.
- `sam_fetch_description` — full SOW/RFP body as plain text (when detail gave a description URL not inline body).
- `sam_fetch_attachment_text` — **READ the attachment** (RFP/SOW/Q&A/wage PDF+DOCX+HTML) by its `attachments[].url`. A scanned/image-only or unreadable doc returns `text:null` + disclosed reason (honest, not a bug).
- `sam_attachment_url` — build the public download URL for an attachment resourceId (303 → signed S3).
- `sam_lookup_organization` — federal-organization id → canonical `fullParentPathName`.
- `sam_lookup_notice_fields` — **batch-fill** nulled naics/setAside/PoP/deadline for 1–100 noticeIds from the opt-in GSA daily CSV. **OFF by default** (returns `enabled:false` until `SAM_GOV_ENABLE_CSV=1`); snapshot can lag ~24h.
- `grants_search` — Grants.gov federal grant opportunities (financial assistance, distinct from contracts).
- `grants_get_opportunity` — full grant detail (description, dates, award ceiling, applicant types, CFDA).

### Spending, awards & competition — USAspending + FPDS + GAO (29)
- `usas_search_awards` — aggregate share-of-wallet at agency × NAICS.
- `usas_search_individual_awards` — line-item contracts (returns `generatedInternalId`).
- `usas_get_award_detail` — per-award detail (period_of_performance, options, set-aside, competition, offers) by generatedInternalId.
- `usas_search_awards_by_recipient` — a recipient's wins in an agency × NAICS slice.
- `usas_search_subawards` — subcontracts on prime awards (supply chain / teaming).
- `usas_search_recompetes` — **recompete radar (preferred)**: PoP ending in a window (default −90d..+18mo), soonest-first, no silent drops. Public signals only.
- `usas_search_expiring_contracts` — **DEPRECATED** alias of `usas_search_recompetes` (legacy shape).
- `usas_analyze_incumbent` — per-award incumbent + PUBLIC `pressureHints` (single_offer / ceiling_nearly_exhausted / hard_stop_no_options) — HINTS, never a composite score.
- `usas_search_teaming_partners` — small-business teaming discovery by socioeconomic `cert` × NAICS × agency, exclusion-screened (`cert` is award-derived, not the SBA cert of record).
- `usas_spending_over_time` — contract-spending time series (fiscal_year / quarter / month).
- `usas_search_agency_spending` — top buying agencies for a NAICS / set-aside.
- `usas_search_subagency_spending` — parent agency → sub-agency / office breakdown.
- `usas_search_psc_spending` — spending by Product Service Code (contract market structure).
- `usas_search_cfda_spending` — spending by CFDA grant-program code (grants, not contracts).
- `usas_search_state_spending` — spending by state / territory.
- `usas_search_federal_account_spending` — spending mapped to Treasury Account Symbols (TAS).
- `usas_search_recipients` — recipient list with parent/child hierarchy (returns `id`).
- `usas_get_recipient_profile` — full recipient detail (UEI, alternate names, business types, totals).
- `usas_get_agency_profile` — agency mission/abbreviation/website/subtier count by toptierCode.
- `usas_get_agency_awards_summary` — award activity (transaction count + obligations) by FY.
- `usas_get_agency_budget_function` — budget breakdown by program area.
- `usas_list_toptier_agencies` — all toptier agencies + current-FY obligations.
- `usas_lookup_agency` — **ALWAYS call FIRST** on an agency abbreviation ('VA'/'DHS'/'CMS') → canonical name + toptier code.
- `usas_autocomplete_naics` — **anti-hallucination guard**: confirm a NAICS code before use.
- `usas_autocomplete_recipient` — **anti-hallucination guard**: confirm exact recipient legal name.
- `usas_naics_hierarchy` — navigate the NAICS tree (2→4→6) + active-contract count per code.
- `usas_glossary` — 151 federal-spending terms; confirm terminology.
- `fpds_search_awards` — FPDS-NG federal contract *award actions* (the authoritative action feed).
- `gao_protest_lookup` — recent GAO bid-protest decisions (public RSS; `complete:false` — recent ~25-item window only, NOT full history).

### Entity & partner vetting — OFAC · SAM · FAC · FDIC · EPA (14)
- `ofac_screen_entity` — OFAC denied-party / sanctions screening.
- `sam_check_exclusions` — SAM debarment/exclusion screen by name and/or UEI/CAGE. Empty ≠ "responsible" — only "no ACTIVE match"; a name match isn't identity-proof (verify UEI/CAGE).
- `sam_integrity_lookup` — one-call integrity screen; `integrityFlag` = `excluded` or `review_fapiis` — NEVER "clear" keylessly (FAPIIS has no keyless API); check `fapiisUrl`.
- `fac_search_audits` — Single Audit summaries from the Federal Audit Clearinghouse.
- `fac_get_findings` — drill into audit-RISK findings for an entity.
- `fdic_search_institutions` — search the FDIC-insured-institution directory.
- `fdic_institution_financials` — quarterly financial time-series for one institution (by cert #).
- `fdic_risk_ratios` — counterparty risk ratios for one institution.
- `fdic_institution_history` — structural-change event log (mergers, charter changes).
- `fdic_branch_deposits` — branch-deposit footprint.
- `fdic_bank_failures` — historical bank failures & assistance transactions.
- `fdic_industry_summary` — industry & state banking-sector annual aggregates.
- `echo_search_facilities` — search EPA-regulated facilities by state with compliance/enforcement screening.
- `echo_facility_report` — EPA ECHO Detailed Facility Report for one facility (by FRS RegistryID).

### Financial disclosure — SEC EDGAR (8)
- `edgar_lookup_cik` — company ticker/name → 10-digit SEC CIK.
- `edgar_company_filings` — a company's SEC filings.
- `edgar_company_facts` — curated XBRL financial facts for a filer.
- `edgar_company_concept` — one filer × one XBRL concept × full reported time-series.
- `edgar_xbrl_frames` — cross-filer XBRL cross-section (one concept across all filers for a period).
- `edgar_full_text_search` — full-text search across EDGAR filings, 2001–present.
- `edgar_filing_index` — bulk cross-filer filing index for a quarter.
- `edgar_daily_filing_index` — per-day cross-filer filing index.

### Regulatory & legislative — Fed Register · Regulations.gov · eCFR · FAR · Congress · GovInfo (18)
- `fed_register_search_documents` — search Federal Register docs by query / agency / type / date.
- `fed_register_get_document` — full detail by document_number (citation, body URL, CFR refs).
- `fed_register_public_inspection` — the public-inspection desk (pre-publication).
- `fed_register_list_agencies` — Federal Register agency slugs reference.
- `regulations_search_dockets` — search Regulations.gov rulemaking dockets.
- `regulations_search_documents` — search Regulations.gov documents (rules, proposed rules, notices).
- `regulations_search_comments` — search public comments on rulemakings.
- `regulations_get_docket` — one Regulations.gov docket by id.
- `ecfr_search` — full-text search across all of CFR (titleNumber=48 for FAR). For an EXACT clause number use `far_clause_lookup` (full-text mis-ranks GSAM).
- `ecfr_list_titles` — all 50 CFR titles + last-amended dates.
- `far_clause_lookup` — **authoritative FAR/DFARS clause text + its prescription** ("As prescribed in…") for an exact clause number. Carries `farOverhaulRisk` currency caveat.
- `far_search` — FAR/DFARS-scoped topic search (excludes GSAM, collapses to current in-force version). Feeds `far_clause_lookup`.
- `far_compliance_matrix` — cited-clause list (1–25) → proposal-ready Section L/M matrix with pass/fail `gate` flags (Section 889 / limitations on subcontracting / CMMC). A 404 → `unresolved`, an eCFR-down clause → separate `errored` bucket; never drops a clause.
- `congress_search_bills` — search Congress.gov bills / legislation.
- `congress_get_bill` — one bill by congress / type / number.
- `govinfo_search_packages` — search GovInfo (GPO-authoritative) packages in a collection.
- `govinfo_get_package` — one GovInfo package summary + download links (txt/xml/pdf/mods).
- `govinfo_list_collections` — the GovInfo collection catalog.

### Pricing, labor & fiscal — GSA CALC · WDs · BLS · Treasury · BEA · Census · FRED · per-diem (15)
- `gsa_benchmark_labor_rates` — GSA CALC awarded-ceiling market band (a min/median/max DISTRIBUTION, fully burdened — do not re-add wrap; not a single price).
- `sam_search_wage_determinations` — find SCA / Davis-Bacon wage determination(s) for a locality (filter coverage sca/dba, state, county; `query` matches WD number/title, NOT occupation).
- `sam_get_wage_rates` — prevailing-wage + fringe/H&W rate table parsed from a WD + EO minimum-wage floor (check `parseConfidence`).
- `bls_timeseries` — BLS time series (CPI-U / ECI escalation, PPI, employment) — the escalation layer.
- `bls_oews_wages` — benchmark occupational wages & employment (OEWS) by area × occupation.
- `bls_qcew` — county × NAICS **market size**: establishment count (competitor density), employment, avg weekly wage, and location quotient (>1.00 = higher concentration). Suppressed cells → null, never $0. Keyless, un-rate-limited (separate BLS domain).
- `treasury_debt_to_penny` — daily total US public debt outstanding.
- `treasury_avg_interest_rates` — average interest rate Treasury pays by security type.
- `treasury_monthly_statement` — Monthly Treasury Statement: receipts, outlays, deficit/surplus by month.
- `treasury_query_dataset` — escape-hatch query over 5 confirmed Treasury Fiscal Data datasets.
- 🔑 `bea_regional_data` — regional (county/state/MSA) GDP-by-industry + personal income (BEA Regional; **requires free BEA_API_KEY** — throws without it; a bad key returns HTTP 200 with an Error object → surfaced as invalid_input; suppression codes → null).
- 🔑 `census_business_patterns` — establishments / employment / annual payroll by NAICS × geography (Census CBP; **requires free CENSUS_API_KEY**; suppression sentinels → null, never 0; geoId/naicsCode are strings).
- 🔑 `fred_search_series` — search the FRED macro series catalog (GDP/CPI/rates/unemployment/PPI; **requires free FRED_API_KEY**). Feed `id` into observations.
- 🔑 `fred_series_observations` — time-series observations for a FRED series (**requires free FRED_API_KEY**; missing value '.' → null, never 0).
- `gsa_perdiem_rates` — federal travel per-diem: monthly lodging (varies seasonally) + M&IE meal caps by city+state OR zip (keyless via DEMO_KEY; ~10 req/hr shared — set DATA_GOV_API_KEY for more).

### Health & research funding — NIH · NSF · ClinicalTrials · CMS · NPPES (9)
- `nih_reporter_search_projects` — awarded NIH RePORTER research-grant projects.
- `nsf_search_awards` — awarded NSF research-grant awards.
- `nsf_get_award` — one NSF award by numeric award id.
- `clinicaltrials_search_studies` — federally-registered clinical studies with sponsor/funder enrichment.
- `clinicaltrials_get_study` — one study by NCT id (incl. brief summary).
- `clinicaltrials_facet_counts` — exact per-value study-count distribution over the whole registry.
- `cms_search_datasets` — discover CMS Open Payments (Sunshine Act) datasets.
- `cms_query_dataset` — query a CMS Open Payments distribution (industry → physician payments).
- `nppes_lookup_provider` — CMS/HHS NPPES NPI Registry provider lookup.

### Cyber compliance — NVD + CISA KEV (2)
- `cve_lookup` — NIST NVD CVE records by cveId or keyword/CPE/severity/date, each row JOINED with CISA KEV status (severity + mandated remediation date in one row). not-in-KEV ≠ safe. Optional NVD_API_KEY raises the rate.
- `cisa_kev_lookup` — filter the CISA KEV catalog standalone (binding BOD 22-01 / BOD 26-04 due-dates). Works when NVD is rate-limited. not-in-KEV ≠ safe caveat on every response.

### Trade & tariffs — USITC (1)
- `hts_lookup` — US import-tariff classification + duty rates from the USITC Harmonized Tariff Schedule.

### Geo, disaster & state/local open data — Census · FEMA · Socrata · CKAN (8)
- `census_geocode_address` — one-line US address → matched address + Census geographies (tract, CD, place).
- `census_geographies_by_coordinates` — longitude/latitude point → Census geographies.
- `fema_disaster_declarations` — FEMA disaster / emergency declarations by state, type, incident, year.
- `fema_search_public_assistance` — FEMA Public Assistance funded projects.
- `socrata_discover_datasets` — find Socrata dataset 4x4 ids by keyword.
- `socrata_query` — query rows from an allowlisted Socrata/SODA open-data portal.
- `ckan_discover_datasets` — find CKAN datastore resource ids by keyword.
- `ckan_query` — query rows from an allowlisted CKAN datastore resource (state/city spend/checkbook).

### Dataset discovery — data.gov (1)
- `datagov_search_datasets` — search the data.gov v4 catalog for federal open datasets across all publishing agencies.

### Small business — SBA (1)
- `sba_size_standard` — SBA size standard for a 6-digit NAICS (set-aside eligibility gate). Returns standardType (receipts/employees/assets), normalized threshold, unit, footnote; value is `asOf` retrieval — re-verify for high-stakes eligibility.

### Labor compliance — US DOL (2)
- `dol_list_datasets` — browse the DOL enforcement/compliance dataset catalog (WHD wage-hour, OSHA, OFCCP, ILAB, MSHA…). **Keyless.** agency/query filtering is client-side. Feed a row's `apiUrl` + `agencyAbbr` into the next tool.
- 🔑 `dol_get_dataset` — fetch records from ONE DOL dataset (**requires free DOL_API_KEY** — data endpoint has no keyless tier, throws without it). Records surfaced VERBATIM (envelope key-gated/unverified); totalAvailable null unless the response carries a real count.

### Lobbying & influence — US Senate LDA (1)
- `lda_search_filings` — Senate lobbying filings: who is paid HOW MUCH to lobby WHICH agency on WHICH issue (keyless; optional LDA_API_KEY raises the rate). totalAvailable is the API's real ~1.95M-filing match count, not page rows; income/expenses null-never-0.

### Server utilities — key discovery (1)
- `api_key_status` — list every key the server can use, required vs optional, signup URL, what it unlocks, and whether each is currently set (a boolean — the value is NEVER shown). The live source of truth for key config.

## Standard workflows

### Workflow 1 — Discover + qualify a single opportunity
1. `sam_search_opportunities` (NAICS/agency/state) — or `sam_search_shaping` for pre-RFP Sources Sought/Presol.
2. Best hit: `sam_get_opportunity(noticeId)` for POCs + `attachments[]`.
3. SOW depth: `sam_fetch_description` for full RFP text.
4. Read the attachments (Workflow 8).
5. (Optional) `usas_get_agency_profile` for issuing-agency context.

### Workflow 2 — Competitive landscape ("who wins at agency X")
1. If agency is an abbreviation: `usas_lookup_agency` first (canonical name + toptier code).
2. `usas_search_awards` with canonical name + NAICS + FY.
3. Line items: `usas_search_individual_awards`. Award actions: `fpds_search_awards`.
4. Office-level: `usas_search_subagency_spending`.
5. (Optional) `usas_spending_over_time` for the trend.

### Workflow 3 — Recompete radar
1. `usas_search_recompetes` for agency × NAICS (window −90d..+18mo; filter pscCodes/setAside/minAwardValue). Soonest-first.
2. Per candidate: `usas_get_award_detail` (PoP + set-aside + competition) or `usas_analyze_incumbent` (incumbent + public `pressureHints`).
3. Cross-reference `sam_search_shaping` (same NAICS) to catch pre-RFP shaping while still shapeable.

### Workflow 4 — Teaming / supply-chain map
1. `usas_search_individual_awards` for prime awards at the target agency.
2. `usas_search_subawards` filtered by prime → sub network.
3. Per sub: `usas_get_recipient_profile` (alternate names/hierarchy) + `sba_size_standard(naics)` (small for the set-aside?).
4. Find NEW partners: `usas_search_teaming_partners(cert, naics, agency)` — ranked, exclusion-screened (see Workflow 10).

### Workflow 5 — Capture brief / agency intelligence
1. `usas_lookup_agency` → canonical name + toptier code.
2. `usas_get_agency_profile` — mission + scale.
3. `usas_get_agency_budget_function` — where the budget goes.
4. `usas_search_subagency_spending` — buying offices.
5. `usas_spending_over_time` (group=fiscal_year) — multi-year trend.
6. `usas_search_state_spending` — geographic distribution.

### Workflow 6 — Regulatory context for a pursuit
1. `ecfr_search` (titleNumber=48 for FAR) — the relevant section text.
2. `regulations_search_dockets` / `regulations_search_documents` — open rulemakings; `regulations_search_comments` for public comment.
3. `fed_register_search_documents` (agency + recent range) → `fed_register_get_document` for the exact citation + body. `fed_register_public_inspection` for pre-publication.
4. (Statute) `congress_search_bills` → `congress_get_bill`; `govinfo_search_packages` for GPO-authoritative source. Quote ≤1 short snippet (<15 words); always cite the section path / citation.

### Workflow 7 — Grants pivot
1. `grants_search` (keyword / CFDA).
2. `grants_get_opportunity` — full grant detail.
3. (Optional) `usas_search_cfda_spending` — who already wins that program. Research grants: `nih_reporter_search_projects` / `nsf_search_awards`.

### Workflow 8 — Read the solicitation documents
1. `sam_search_opportunities` / `sam_search_shaping` to find the notice.
2. `sam_get_opportunity(noticeId)` → the `attachments[]` array.
3. Per `attachments[].url`: `sam_fetch_attachment_text(url)` (PDF+DOCX+HTML; only sam.gov URLs fetched).
4. Read the returned `text`. A `text:null` = honest (scanned/image-only or unreadable-keyless, reason disclosed) — don't fabricate; respect `truncated` (raise maxChars / page).

### Workflow 9 — FAR/DFARS compliance check
1. `far_search(query, scope: far|dfars|both)` — the clauses on a topic (excludes GSAM, current version).
2. `far_clause_lookup(clauseNumber)` — authoritative text + prescription. Use this, NOT `ecfr_search`, for an exact clause.
3. `far_compliance_matrix(clauses[])` — cited-clause list → per-clause text + prescription + eligibility-`gate` matrix (flags 889 / limitations on subcontracting / CMMC; 404 → `unresolved`, eCFR-down → `errored`, none dropped).
4. Currency caveat: every response carries `farOverhaulRisk` — verify the controlling class deviation for high-stakes gates.

### Workflow 10 — Vet a firm / teaming partner
1. `ofac_screen_entity(name)` — sanctions / denied-party screen.
2. `sam_check_exclusions(name|uei)` — debarred/excluded? (empty ≠ responsible; verify UEI/CAGE on a name match.)
3. `sam_integrity_lookup(uei|cage|name)` — one-call integrity (`integrityFlag` = excluded or review_fapiis; never "clear" keylessly — check `fapiisUrl`).
4. `fac_search_audits` → `fac_get_findings` — adverse Single Audit findings.
5. (Financial firm) `fdic_search_institutions` → `fdic_risk_ratios` / `fdic_institution_financials` — bank health.
6. (Facility) `echo_search_facilities` → `echo_facility_report` — EPA compliance/enforcement.
7. (Public co.) `edgar_lookup_cik` → `edgar_company_facts` / `edgar_company_filings` — revenue trend + 10-K.
8. `sba_size_standard(naics)` — small for the set-aside NAICS?

### Workflow 11 — Price a bid
1. `sam_search_wage_determinations(coverage, state, county)` — the SCA/DBA WD(s) governing the place of performance.
2. `sam_get_wage_rates(wdNumber)` — the statutory prevailing-wage + fringe/H&W floor (check `parseConfidence`, read `raw` when low).
3. `gsa_benchmark_labor_rates(laborCategory)` — GSA CALC awarded-ceiling market band (fully burdened; don't re-add wrap) to sanity-check proposed rates.
4. (Travel) `gsa_perdiem_rates(city+state | zip)` — lodging + M&IE caps for the cost basis.

### Workflow 12 — Market sizing (NEW)
Estimate the addressable market for a NAICS × geography:
1. `bls_qcew(mode, area|industry, year, quarter)` — establishment count (competitor density), employment, avg weekly wage, location quotient (keyless).
2. 🔑 `census_business_patterns(naics, geography, state)` — establishments / employment / annual payroll (needs CENSUS_API_KEY).
3. 🔑 `bea_regional_data(tableName, geoFips, lineCode)` — regional GDP-by-industry / personal income (needs BEA_API_KEY).
4. (Occupational depth) `bls_oews_wages(area, occupation)` — wage/employment for the labor category.
The establishments/employment/wages + GDP triad; only `census_business_patterns` and `bea_regional_data` need a key.

### Workflow 13 — Macro / bid-escalation context (NEW)
1. 🔑 `fred_search_series(query)` — find the right series id (e.g. 'CPI', 'GDP', '10-year treasury'; needs FRED_API_KEY).
2. 🔑 `fred_series_observations(seriesId, startDate, endDate)` — the CPI/GDP/rate time series (missing '.' → null).
3. Cross-check with `bls_timeseries` (CPI-U / ECI for an escalation clause) and `treasury_avg_interest_rates` for cost-of-money context.

### Workflow 14 — Influence / competitive lobbying (NEW)
1. `lda_search_filings(agency, issue)` — who lobbies the target agency, on what, for how much (keyless).
2. Narrow by `registrantName` / `clientName` to profile a competitor's B2G footprint (income/expenses null-never-0; totalAvailable is the real match count, not page rows).

### Workflow 15 — Labor-compliance vetting (NEW)
1. `dol_list_datasets(agency|query)` — find the WHD wage-hour / OSHA inspection dataset (keyless catalog); grab a row's `apiUrl` + `agencyAbbr`.
2. 🔑 `dol_get_dataset(agency, table, filterField, filterValue)` — pull the enforcement records for a partner (needs DOL_API_KEY; records surfaced verbatim).

### Workflow 16 — Cyber compliance (NEW)
For FedRAMP / CMMC / SBOM component review:
1. `cve_lookup(cveId | keyword)` — severity + CISA KEV status joined in one row.
2. `cisa_kev_lookup(cveId | vendorProject)` — standalone KEV membership + the binding remediation due-date (works even when NVD is rate-limited). not-in-KEV ≠ safe.

### Workflow 17 — Health / research pursuit (NEW)
1. `nih_reporter_search_projects` / `nsf_search_awards` — awarded research grants on a topic (funder/competitive intel).
2. `clinicaltrials_search_studies` → `clinicaltrials_get_study`; `clinicaltrials_facet_counts` for the distribution.
3. `cms_search_datasets` → `cms_query_dataset` — CMS Open Payments industry→physician payments; `nppes_lookup_provider` to confirm a provider NPI.

### Workflow 18 — Config / which keys are set (NEW)
1. `api_key_status` — the live source of truth: every key, required vs optional, signup URL, what it unlocks, and whether it's currently set (boolean; value never shown).
2. For the 4 required keys not set, point the user to the signup URL (see Keys section). To confirm a key WORKS, call that source's own tool.

## Output discipline (anti-hallucination)

- **Cite tool calls inline**: "VA awarded $410M to Booz Allen across 28 contracts in FY26 (`usas_search_awards`)."
- **Never invent** notice IDs, NAICS codes, recipient names, contract amounts, regulation citations. If a tool returns nothing, say so.
- **Use autocomplete guards FIRST**: NAICS theme → `usas_autocomplete_naics`; recipient name → `usas_autocomplete_recipient`; agency abbreviation → `usas_lookup_agency`.
- **Quote sparingly** from RFP body / regulation text — at most 1 snippet, < 15 words; point to the source URL.
- **`totalAvailable` is the real upstream total**, not the rows on this page — report it as the match count; page forward when `hasMore`.
- **Suppression / missing → null, never 0** — Census/BEA/QCEW/FRED/per-diem/LDA all map a withheld or missing value to null; a genuine 0 is preserved. Never read a null as "$0".
- **Key-required tools throw without a key** — the 4 🔑 tools (Census, FRED×2, BEA, DOL data) return an honest config error, not a fake empty. Check `api_key_status`.
- Notice IDs starting with `demo-` are fictional demo fixtures; they don't exist on sam.gov.

## Common pitfalls

- ❌ "VA" passed directly as `agency` to USAspending → nothing. ✅ `usas_lookup_agency("VA")` first.
- ❌ Searching opportunities with no `ncode`/`query` — useless deluge. ✅ Always narrow.
- ❌ Quoting an old noticeId from training — they expire. ✅ Always fresh `sam_search_opportunities`.
- ❌ `sam_fetch_description` before `sam_get_opportunity` — you don't have the noticeId yet.
- ❌ Confusing `usas_search_cfda_spending` (grants) with `usas_search_psc_spending` (contracts).
- ❌ A NAICS code from training unverified — they get retired. ✅ `usas_autocomplete_naics`.
- ❌ Treating `sam_fetch_attachment_text` `text:null` as a bug — it's honest (image-only / unreadable-keyless, reason disclosed).
- ❌ `ecfr_search` for an exact FAR clause (e.g. `52.212-4`) — mis-ranks GSAM `552.212-4`. ✅ `far_clause_lookup` (exact) / `far_search` (topic).
- ❌ Reading `ofac_screen_entity` / `sam_check_exclusions` / `sam_integrity_lookup` empty as "responsible" — empty = "no ACTIVE match"; FAPIIS has no keyless API (never "clear"). ✅ Also check `fapiisUrl`; verify UEI/CAGE.
- ❌ Expecting `sam_lookup_notice_fields` to just work — OFF by default (`enabled:false` until `SAM_GOV_ENABLE_CSV=1`). ✅ Few notices → `sam_get_opportunity` each.
- ❌ Treating `gsa_benchmark_labor_rates` as a single price or adding wrap — it's a fully-burdened CEILING distribution.
- ❌ `gao_protest_lookup` is `complete:false` (recent ~25-item feed only), not full history.
- ❌ Calling a 🔑 tool (Census/FRED/BEA/`dol_get_dataset`) with no key — it THROWS. ✅ `api_key_status` first; set the free key.
- ❌ Reading a Census/BEA/QCEW/FRED null as `0` — it's suppression/missing, never zero.
- ❌ Reporting a page's row count as the total — `totalAvailable` is the real upstream match count (e.g. LDA's ~1.95M corpus); page forward on `hasMore`.
- ❌ Summing `bls_qcew` rows across aggregation levels / ownerships — the file mixes them; a do-not-sum note rides every response.
- ❌ Treating a CVE/component *not* on CISA KEV as "safe" — KEV is a curated subset of confirmed in-the-wild exploitation; absence ≠ unexploited.
- ❌ Coercing `dol_get_dataset` records — the envelope is key-gated/unverified, so rows are surfaced VERBATIM; totalAvailable is null unless the response carries a real count.

## Keys & rate limits

**Most tools are keyless.** Ask the server live with **`api_key_status`** — it lists every key, whether required or optional, the free signup URL, what it unlocks, and whether each is currently set (a boolean; the value is never shown). Set keys via the host `env` block OR a `.env` file in the server's working directory (auto-loaded; real env wins). Every key below is free.

**Required — the source has NO keyless tier, so the tool throws without it:**

| Env var | Unlocks | Free signup |
|---|---|---|
| `CENSUS_API_KEY` | `census_business_patterns` | api.census.gov/data/key_signup.html |
| `FRED_API_KEY` | `fred_search_series`, `fred_series_observations` | fred.stlouisfed.org/docs/api/api_key.html |
| `BEA_API_KEY` | `bea_regional_data` | apps.bea.gov/API/signup/ |
| `DOL_API_KEY` | `dol_get_dataset` (the DOL *data* endpoint; `dol_list_datasets` catalog is keyless) | dataportal.dol.gov/registration |

**Optional — only raise a rate limit or unlock one filter (all tools work keyless without them):**

| Env var | Effect |
|---|---|
| `SAM_GOV_API_KEY` | authenticated SAM.gov v2 search + the organizationName filter + full archive (>~12mo) |
| `DATA_GOV_API_KEY` | higher limits across api.data.gov sources (Regulations.gov, FAC, NPPES, CMS, data.gov catalog, GSA per-diem) — lifts the shared `DEMO_KEY` cap |
| `LDA_API_KEY` | higher rate on `lda_search_filings` |
| `BLS_API_KEY` | BLS v2 tier (~500/day vs keyless ~25/day) for `bls_timeseries` (QCEW/CSV path is un-rate-limited regardless) |
| `NVD_API_KEY` | higher NVD rate for `cve_lookup` |
| `SOCRATA_APP_TOKEN` | higher Socrata throttling limits |

Creating the account at a signup URL is the one manual step; the server automates *discovery* (`api_key_status`) and *configuration* (`.env`). To confirm a key actually works, call that source's own tool.
