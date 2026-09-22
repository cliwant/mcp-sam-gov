---
name: sam-gov
description: Query and analyze US federal contracting, spending, regulation, vetting, and market data. 153 tools across 54 data sources, keyless-first (148 tools need no key; only 5 tools across Census CBP, FRED, BEA, and DOL data need a free key). Covers SAM.gov opportunities, pre-solicitations, RFP/SOW attachment text; USAspending + FPDS awards, recompetes, disaster spending; GAO protests; vetting (OFAC, SAM exclusions, FAC audits, FDIC, EPA ECHO/TRI, CMS revocations); SEC EDGAR; Federal Register, Regulations.gov, eCFR, FAR/DFARS, Congress, GovInfo; pricing, labor, fiscal data (GSA CALC, wage determinations, BLS, Treasury, BEA, Census, FRED, per-diem); NIH/NSF/ClinicalTrials/CMS/NPPES health data; NVD/CISA KEV/NIST 800-53 cyber; tariffs; FEMA/NWS/Census geo; state/local bids and checkbooks (Socrata, CKAN, OpenGov, Bonfire, ArcGIS); lobbying, DOL enforcement, SBA size standards. Use for any US federal or state/local procurement, spending, regulation, vetting, market-sizing, or macro question.
when_to_use: federal contracting, SAM.gov search, GovCon opportunities, pre-solicitation shaping, RFP attachments / read the SOW text, USAspending awards, FPDS award actions, contracting officer lookup, NAICS / PSC analysis, agency spending, recompete radar, incumbent pressure, capture brief, bid no-bid, set-aside contracts (SDVOSB / 8(a) / WOSB / HUBZone), FAR/DFARS clause lookup, FAR compliance matrix, Section 889 / CMMC, vet a firm, OFAC sanctions, debarment / exclusions, single-audit findings, bank health (FDIC), EPA compliance, SEC EDGAR financials, teaming partners, GAO bid protests, wage determination / SCA / DBA / CALC labor rates, BLS CPI escalation / OEWS wages / QCEW market size, Treasury fiscal data, BEA regional GDP, Census business patterns / market sizing, FRED macro (GDP/CPI/rates), GSA per-diem travel cost, Federal Register / Regulations.gov rules, eCFR, Congress bills, GovInfo, grants.gov / federal grants, CFDA, NIH / NSF / clinical trials / CMS Open Payments / NPPES, Medicare providers / hospitals / care facilities / revoked providers, CVE / CISA KEV / NIST 800-53 cyber, HTS tariff, FEMA disasters / hazard mitigation, COVID / IIJA disaster spending by state, Socrata / CKAN open data, state contracts awarded / state checkbook vendor payments, Senate LDA lobbying, DOL wage-hour / OSHA enforcement, data.gov datasets, SBA size standard, which API keys are set
disable-model-invocation: false
user-invocable: true
---

# SAM.gov federal-data skill — 153 tools across 54 sources

This skill teaches Claude how to use the **`sam-gov` MCP server** (152 tools wrapped from `@cliwant/mcp-sam-gov`) to answer the full surface of US federal contracting / spending / regulation / vetting / market questions end-to-end — from discovering (and shaping) an opportunity, to **reading the actual RFP/SOW documents**, running a **FAR/DFARS compliance matrix**, **vetting a firm** (sanctions, exclusions, audits, bank health, EPA), **sizing a market** (establishments + wages + regional GDP), pricing the bid against statutory wage floors, and pulling **macro context** for escalation.

> **Setup:** the `sam-gov` MCP server must be reachable. `/plugin install cliwant/mcp-sam-gov` registers it automatically; otherwise see the [repo README](https://github.com/cliwant/mcp-sam-gov). Host prefixing: Claude Code exposes tools as `mcp__sam-gov__<tool>`; bare MCP hosts use just `<tool>`. Use whichever your host gives you.

## Tool inventory — 153 tools, keyless-first

**Keyless-first: 148 of the 153 tools work with no API key, and 50 of 54 sources need no key. Only 5 tools, across 4 sources, require a free key** (marked 🔑 below): Census CBP (`census_business_patterns`), FRED (`fred_search_series`, `fred_series_observations`), BEA (`bea_regional_data`), and DOL's *data* endpoint (`dol_get_dataset`; DOL's catalog is keyless). Those 5 tools **throw** an honest config error without a key. A handful of others take an *optional* free key for higher limits (see the Keys section). The server is **the only source of truth** — never invent notice IDs, officer names, award amounts, NAICS codes, or regulation citations.

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

### Spending, awards & competition — USAspending + FPDS + GAO (31)
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
- `usas_list_disaster_codes` — the complete list of Disaster Emergency Fund Codes (DEFC: COVID-19, IIJA/infrastructure, other emergency laws) with group/title/public law. Call FIRST to get the codes for `usas_disaster_spending`.
- `usas_disaster_spending` — disaster/emergency-fund obligations or outlays BY GEOGRAPHY (state / county / congressional district) for given `defCodes` — "which states captured COVID/IIJA relief money". Complete set, no paging; a real $0 stays 0 (IIJA can report $0 obligations with a nonzero awardCount), absent → null.
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

### Entity & partner vetting — OFAC · SAM · FAC · FDIC · EPA (15)
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
- `epa_tri_facilities` — EPA Toxics Release Inventory (TRI) reporting facilities by state / facility name / county (needs `state` or `facilityName`) — an environmental-footprint / place-of-performance screen. Nominal TRI reporters, NOT a compliance/enforcement finding (use ECHO for that); `closed` unknown → null.

### Financial disclosure — SEC EDGAR (8)
- `edgar_lookup_cik` — company ticker/name → 10-digit SEC CIK.
- `edgar_company_filings` — a company's SEC filings.
- `edgar_company_facts` — curated XBRL financial facts for a filer.
- `edgar_company_concept` — one filer × one XBRL concept × full reported time-series.
- `edgar_xbrl_frames` — cross-filer XBRL cross-section (one concept across all filers for a period).
- `edgar_full_text_search` — full-text search across EDGAR filings, 2001–present.
- `edgar_filing_index` — bulk cross-filer filing index for a quarter.
- `edgar_daily_filing_index` — per-day cross-filer filing index.

### Regulatory & legislative — Fed Register · Regulations.gov · eCFR · FAR · Congress · GovInfo (19)
- `fed_register_search_documents` — search Federal Register docs by query / agency / type / date.
- `fed_register_get_document` — full detail by document_number (citation, body URL, CFR refs).
- `fed_register_public_inspection` — the public-inspection desk (pre-publication).
- `fed_register_list_agencies` — Federal Register agency slugs reference.
- `regulations_search_dockets` — search Regulations.gov rulemaking dockets.
- `regulations_search_documents` — search Regulations.gov documents (rules, proposed rules, notices).
- `regulations_search_comments` — search public comments on rulemakings.
- `regulations_get_docket` — one Regulations.gov docket by id.
- `ecfr_search` — full-text search across all of CFR (titleNumber=48 for FAR); returns ranked SNIPPETS. For the FULL text of a hit: `far_clause_lookup` (FAR/DFARS clause) or `ecfr_get_section` (any other title); or open its ecfrUrl.
- `ecfr_get_section` — the **FULL in-force text of one CFR section** by citation (e.g. title 2 §200.1 grants, title 29 labor). For FAR/DFARS (title 48) prefer `far_clause_lookup`.
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

### Healthcare providers & facilities — CMS provider data (5)
All keyless (data.cms.gov); `totalAvailable` is the exact upstream count, never the page length (the three tools that use a separate count query return null + a note if that count fails). Public organization/provider-level data with no patient identifiers — a market or due-diligence signal, NOT a quality, fraud, or fitness determination.
- `cms_medicare_provider_services` — Medicare Part-B utilization for a provider (`npi`) or `state` (one is REQUIRED): HCPCS services, beneficiaries, and submitted / allowed / paid amounts. Healthcare market sizing and competitor intel; pairs with `nppes_lookup_provider` (who a provider is → what they bill). One annual vintage, disclosed in `_meta`.
- `cms_hospital_compare` — Medicare-certified hospitals by `state` and/or `facilityName` fragment (one is REQUIRED): type, ownership, emergency-services flag, CMS 1–5 star rating ('Not Available' → null, never 0).
- `cms_facility_directory` — nursing homes / home health agencies / hospices / dialysis facilities (`facilityType` REQUIRED; optional `state`, `facilityName`): name, address, ownership. A field the chosen dataset lacks → null, never an empty string.
- `cms_dmepos_suppliers` — Medicare durable medical equipment (DMEPOS) suppliers for an `npi` or `state` (one is REQUIRED): HCPCS codes, beneficiaries, claims, and submitted / allowed / paid amounts. The supply-side complement to `cms_medicare_provider_services`.
- `cms_revoked_providers` — CMS's public list of revoked Medicare providers & suppliers (optional `npi` / `state` / exact `lastName`): revocation reason, effective date, re-enrollment bar. Vetting before teaming or subcontracting, in the same class as OFAC / SAM exclusions — not a current-eligibility or guilt finding.

### Cyber compliance — NVD + CISA KEV + NIST 800-53 (3)
- `cve_lookup` — NIST NVD CVE records by cveId or keyword/CPE/severity/date, each row JOINED with CISA KEV status (severity + mandated remediation date in one row). not-in-KEV ≠ safe. Optional NVD_API_KEY raises the rate.
- `cisa_kev_lookup` — filter the CISA KEV catalog standalone (binding BOD 22-01 / BOD 26-04 due-dates). Works when NVD is rate-limited. not-in-KEV ≠ safe caveat on every response.
- `nist_800_53_controls` — NIST SP 800-53 Rev 5 security & privacy controls by `controlId` / `family` / `keyword` — the requirement text behind FedRAMP / CMMC / RMF mapping.

### Trade, tariffs & logistics — USITC · CBP (2)
- `hts_lookup` — US import-tariff classification + duty rates from the USITC Harmonized Tariff Schedule.
- `cbp_border_wait_times` — live CBP land-border commercial-vehicle (freight-truck) wait times at US–Canada and US–Mexico ports (standard + FAST lanes); passenger/pedestrian lanes are not included.

### Geo, disaster & state/local open data — Census · FEMA · NWS · Socrata · CKAN (10)
- `census_geocode_address` — one-line US address → matched address + Census geographies (tract, CD, place).
- `census_geographies_by_coordinates` — longitude/latitude point → Census geographies.
- `fema_disaster_declarations` — FEMA disaster / emergency declarations by state, type, incident, year.
- `fema_search_public_assistance` — FEMA Public Assistance funded projects (disaster RECOVERY spend).
- `fema_search_hazard_mitigation` — FEMA Hazard Mitigation Assistance projects (HMGP / FMA / PDM / BRIC resilience grants to state/local/tribal subrecipients) — the disaster-RESILIENCE axis. `state` accepts a 2-letter code ('AL') or the full name ('Alabama') — the dataset stores full names and the tool maps codes for you; totalAvailable is the exact filtered total; amounts absent → null.
- `nws_active_alerts` — currently-active National Weather Service watches / warnings / advisories (filter `state`, `event`) — live disaster readiness that pairs with the FEMA tools.
- `socrata_discover_datasets` — find Socrata dataset 4x4 ids by keyword.
- `socrata_query` — query rows from an allowlisted Socrata/SODA open-data portal.
- `ckan_discover_datasets` — find CKAN datastore resource ids by keyword.
- `ckan_query` — query rows from an allowlisted CKAN datastore resource (state/city spend/checkbook).

### SLED bid platforms & state checkbooks — OpenGov · Bonfire · ArcGIS · Tableau · Open Checkbook (8)
- `opengov_list_governments` — directory of 525+ US state/local governments on **OpenGov Procurement** (filter by `state`/`query`); feed a result's `code` to the next tool.
- `opengov_search_solicitations` — a government's **LIVE public solicitations** (title, `status` [open = accepting], deadline, portal link). Consumes only the anonymous endpoints the public portal itself calls (keyless).
- `bonfire_list_organizations` — curated live-verified 187-org US seed directory of governments on **Bonfire (Euna)** (filter `state`/`query`); feed a result's `org` to the next tool.
- `bonfire_search_opportunities` — an org's currently-open opportunities via keyless RSS (referenceNumber, name, `closeDate`, link). The RSS is the **complete** open set (totalAvailable = the exact open count).
- `arcgis_hub_discover_datasets` — discover ArcGIS Hub datasets by keyword (GIS / infrastructure / permits / zoning / procurement — the SLED layer Socrata & CKAN don't cover). **Global open platform → a DISCOVERY aid** (publisher surfaced for vetting), not a curated official-source allowlist.
- `arcgis_feature_query` — query rows from a curated allowlist of **29 US-gov ArcGIS REST feature layers**: DC OCP PASS live solicitations (~25k); local-gov checkbooks/contracts (Las Vegas, Baltimore, Naperville, Worcester, Topeka, Miami-Dade…); **county CIP pipelines** (`hennepin_transportation_cip` = Hennepin County MN transportation capital-improvement projects, ~257 rows; `charlotte_mecklenburg_cip` = Charlotte-Mecklenburg NC joint CIP, ~2,276 rows — **both are CAPITAL-PROJECT PIPELINES, NOT solicitation or award registers**); **state DOT bid/award registers (TX / AK / IA / OK)**; **North Dakota DOT federal flex-funding award layers** (`nddot_flex_setaside_road` / `nddot_flex_partner_road` / `nddot_flex_setaside_bridge` / `nddot_flex_partner_bridge`). These are NDDOT federal flex-funding AWARDS whose recipients are **local public agencies** — counties, townships, and cities, named in `LPA_NAME` / `LPA_TYPE` — **NOT vendors, vendor contracts, or winning bids**. Their `$` amounts (`Total_Project_Cost`, `Flex_Funds_Awarded`) are FORMATTED STRINGS; parse them client-side. They are a *proxy*, since ND's statewide checkbook and procurement portal aren't keyless-reachable. Honest match-count total; epoch-ms date disclosure.
- `tableau_view_csv` — a curated US-gov **Tableau Server Guest** view's COMPLETE CSV export (keyless), paged client-side (`view`, `limit`/`offset`). One view today: `mt_contracts_awarded` = **State of Montana (DOA) Contracts Awarded** (~4,554 awards: $ Awarded, Award Date, IFB/RFP Event Type, Event#, Vendor Name, Agency). Use for "who won Montana state contracts". totalAvailable = the full export row count; amounts are FORMATTED STRINGS (parse client-side); empty → null; freshness is the publisher's and can lag.
- `open_checkbook_search` — row-level **vendor-payment** search over a curated Socrata **Open Expenditures** checkbook portal (keyless; `portal`, EXACT-match `year`/`vendor`/`org`/`expenseCategory`, `sortBy`/`sortOrder`, `limit`/`offset`). Two portals: `sd` = **State of South Dakota Open Checkbook** (~740,980 payments, ~3 most-recent FYs); `ak` = **State of Alaska Open Checkbook** (41,751 payments, $1.18B — **FY2026 ONLY**; FY2019–FY2025 return count:0 meaning "not published", NOT zero spend — always pass `year='2026'`). A partial/misspelled filter value → honest count:0, not a fuzzy match; totalAvailable is the real filtered count; freshness is the publisher's and can lag (use `sortBy: payment_date`, `sortOrder: desc` to see the newest payment date).

**SLED local procurement — how the keyless surfaces fit together:** (1) `socrata_query` / `socrata_discover_datasets` reach **54 curated hosts** — state + major-city (NYC City Record, Chicago/SF/LA) + a deep **county/city sweep** (KC MO, Pittsburgh, Atlanta, Dallas, Baton Rouge, Fulton/Howard/Ramsey/Macoupin/Prince George's counties incl. sharefulton.fultoncountyga.gov, MA-Comptroller CTHRU, USAC E-Rate live bids…) — contracts / vendors / checkbook / **live solicitations**; (2) **`opengov_*`** (525+ govs' live solicitations) and **`bonfire_*`** (per-org open-opportunity RSS) for the bid-notice feeds Socrata doesn't carry; (3) **`arcgis_feature_query`** for gov ArcGIS-REST layers (DC live solicitations, state DOT bid/award registers, ND DOT flex-funding awards to local public agencies); (4) **`tableau_view_csv`** (Montana contracts awarded) and **`open_checkbook_search`** (SD ~3 recent FYs; AK FY2026 only) for state payment exports. For a "who's bidding / what's open in <locality>" question, try opengov/bonfire first, then the local Socrata host.

## State & local data map

Agent-readable lookup: jurisdiction → data type → exact tool call → verified row count → what it is NOT (the most common source of agent error).

**State-level open-data sources (verified 2026-09-21, all keyless):**

| Jurisdiction | Data | Tool · key args | Rows | NOT |
|---|---|---|---|---|
| **Virginia** | eVA PO line items 2023 | `ckan_query` host=data.virginia.gov, resourceId=`3c7f1bde-35b0-4fbf-b89c-978a19124d53` | 1,693,227 | the live eVA portal (login-gated); years 2016–2026 have separate resource IDs — `ckan_discover_datasets` host=data.virginia.gov q=`eVA procurement` lists them (2024=`25a59527`, 2025=`b8dc22a8`, 2026=`76f6831d`) |
| **Massachusetts** | Comptroller vendor payments (CTHRU) | `socrata_query` domain=cthru.data.socrata.com, datasetId=`pegc-naaa` | ~49M | an award or bid register; these are payment transactions |
| **New Jersey** | YourMoney agency purchasing by vendor | `socrata_query` domain=data.nj.gov, datasetId=`ubnu-tqu7` | 660,425 | a solicitation or bid register; agency expenditure rows |
| **New York** | State authority procurement contracts | `socrata_query` domain=data.ny.gov, datasetId=`ehig-g5x3` | 275,763 | all NYS agencies (authorities only) and NOT active solicitations |
| **New York** | MTA procurement contracts | `socrata_query` domain=data.ny.gov, datasetId=`twsw-2mqa` | 107,503 | a live MTA bid portal; MTA historical contract records |
| **Washington** | Agency contract register | `socrata_query` domain=data.wa.gov, datasetId=`s8d5-pj78` | 79,329 | a solicitation or bid feed; awarded contract records |
| **Washington** | Master-contract sales by vendor/customer | `socrata_query` domain=data.wa.gov, datasetId=`n8q6-4twj` | 245,831 | open bids; sales reported off statewide master contracts |
| **Montana** | DOA contracts awarded | `tableau_view_csv` view=`mt_contracts_awarded` | ~4,554 | a bid portal; awarded records only, freshness set by publisher |
| **South Dakota** | Open Checkbook vendor payments | `open_checkbook_search` portal=`sd` | ~741k | an award register; only ~3 most-recent FYs, exact-match filters |
| **Alaska** | Open Checkbook vendor payments (FY2026 ONLY) | `open_checkbook_search` portal=`ak`, year=`2026` | 41,751 | historical FY coverage — ONLY FY2026 published; FY2019–FY2025 return count:0 meaning "not published" NOT "zero spend". Always pass year=2026. |
| **Illinois** | CDB capital project future bids | `socrata_query` domain=data.illinois.gov, datasetId=`6rb8-ntpm` | 48 | a comprehensive solicitation feed, and NOT currently open bids — ~48 CDB capital solicitations "anticipated for a future date, but have not been posted yet" (publisher) |
| **Illinois** | IDHR certified eligible bidders | `socrata_query` domain=data.illinois.gov, datasetId=`w8h2-q8hu` | 7,848 | a bid or award register; vendor-eligibility directory only |
| **Texas** | TxDOT current lettings (★live bid-line items) | `socrata_query` domain=data.texas.gov, datasetId=`qh8x-rm8r` | 8,861 | rows are bid LINE ITEMS not projects (8,861 rows = 412 distinct project_ids — use `$select=count(distinct project_id)` for open-bid count); TxDOT highway lettings ONLY; rolling window (past lettings dropped). ★First live state solicitation feed in this map. |
| **Texas** | DIR Cooperative Contract Sales FY2010–FY2025 (archive) | `socrata_query` domain=data.texas.gov, datasetId=`w64c-ndf7` | 10,749,743 | bids or awards; purchase line items off DIR cooperative contracts (historical) |
| **Texas** | DIR Cooperative & Tele Contract Sales FY2026 | `socrata_query` domain=data.texas.gov, datasetId=`a743-wj72` | 2,077,855 | historical FY2026 purchase lines (same shape as w64c-ndf7); not bids |
| **Texas** | DIR Current Active Cooperative Contracts | `socrata_query` domain=data.texas.gov, datasetId=`vipt-h4ye` | 5,167 | a solicitation feed; active cooperative contract register (not TxDOT lettings) |
| **Texas** | TCEQ Current Contracts & Purchase Orders | `socrata_query` domain=data.texas.gov, datasetId=`svjm-sdfz` | 2,067 | statewide; one agency (TCEQ) only |
| **California** | DGS Purchase Order Data 2012–2015 | `ckan_query` host=data.ca.gov, resourceId=`bb82edc5-9c78-44e2-8947-68ece26197c5` | 344,504 | the live Cal eProcure portal (WAF-403); FY2012–2015 only — no post-2015 rows |
| **California** | DGS-Approved Non-Competitive Bids | `ckan_query` host=data.ca.gov, resourceId=`14932789-485b-481b-910a-dafb40d3471c` | 480 | open competitive solicitations; a sole-source / non-competitive AWARD register |
| **Oklahoma** | Vendor Payments FY2019 Q1 (OMES) | `ckan_query` host=data.ok.gov, resourceId=`cc443616-15eb-4a1f-8d87-93e5711ac43c` | 286,185 | bids or awards; vendor PAYMENTS — per-quarter resources, so one fiscal year is 4 calls (FY2011/2017/2018 also published) |
| **Maryland** | eMaryland Marketplace (eMMA) bids — FY2018 exemplar | `socrata_query` domain=opendata.maryland.gov, datasetId=`pgna-cxjh` | 107,303 | rows are bid LINE ITEMS not bids — FY2018 is 107,303 rows for only 3,067 bids (35× overcount); always use `$select=count(distinct bid_number)` for actual bid count. Coverage stops at FY2019 — eMMA migrated to Periscope mid-FY2019; no FY2020+ mirror exists and this cannot answer current Maryland bid questions. All six FY datasetIds: FY2018=`pgna-cxjh`, FY2017=`qkjf-rv4t` (64,331/4,943), FY2016=`7ang-84wj` (45,204/4,818), FY2015=`3hzs-sazv` (46,895/4,898), FY2014=`itax-4ccz` (45,551/4,884), FY2019=`ttg5-zfzj` (4,623/388). |
| **Oregon** | OregonBuys Purchases and Contracts FY2022–FY2025 | `socrata_query` domain=data.oregon.gov, datasetId=`qyug-f2km` | 109,119 | open solicitations — issued purchase orders and contracts (not bids). 92,224 distinct `po_nbr`. Historical ORPIN datasets (retired system): Contracts Issued=`6e9e-sfc4` (93,846 rows), Contracts Expired=`8izy-bwhd` (92,755), Statewide Price Agreement Spend=`gart-52me` (5,224). |
| **Vermont** | Purchase Orders with Vendor Information (current FY, live-ish) | `socrata_query` domain=data.vermont.gov, datasetId=`8ewu-igdm` | 111,271 | a bid or award register — issued purchase orders. 39,882 distinct `po_id` (~2.8 line items per PO). `po_date` 2025-07-02 → 2026-06-19 (current fiscal year, live-ish state spend, not an archive). |
| **City of Denver** | City of Denver Procurement Transactions (on CO state portal) | `socrata_query` domain=data.colorado.gov, datasetId=`66zf-qjdd` | 76,357 | Colorado STATE procurement — City of Denver spend hosted on the CO state portal; the domain does NOT indicate jurisdiction. Updated 2026-09-20. |
| **City of Denver** | City of Denver Checkbook (on CO state portal) | `socrata_query` domain=data.colorado.gov, datasetId=`wnau-xrqi` | 154,595 | Colorado STATE procurement — City of Denver checkbook data hosted on the CO state portal; the domain does NOT indicate jurisdiction. Updated 2026-09-20. |
| **Fulton County GA** | Vendor Payments 2014–present (sharefulton portal) | `socrata_query` domain=sharefulton.fultoncountyga.gov, datasetId=`kp4p-scak` | 226,797 | data.fultoncountyga.gov (a DIFFERENT host, also allowlisted). Fields: fiscal_year, fy_period, disb_date, dept, department_name, unit, unit_name, object, object_name, fund, fund_name, amount, vendor_code, vendor_legal_name. Updated 2026-09-14. |

**County & city — Socrata hosts (use `socrata_discover_datasets` to find dataset IDs):**

| Jurisdiction | Tool · domain | Data available | Notes |
|---|---|---|---|
| **NYC** | `socrata_query` domain=data.cityofnewyork.us | City Record solicitations + contracts | Live bids and awarded contracts; discover IDs first |
| **Chicago** | `socrata_query` domain=data.cityofchicago.org | Contracts, vendor payments | Checkbook and awarded contracts |
| **Austin TX** | `socrata_query` domain=data.austintexas.gov or datahub.austintexas.gov | Solicitations + spending | Multiple datasets; discover IDs first |
| **Dallas TX** | `socrata_query` domain=www.dallasopendata.com | Vendor/contract data | Contracts and spending |
| **LA City** | `socrata_query` domain=controllerdata.lacity.org or data.lacity.org | Controller spending | Payment records; not a solicitation feed |
| **King County WA** | `socrata_query` domain=data.kingcounty.gov | Contracts + spending | Discover dataset IDs |
| **Cook County IL** | `socrata_query` domain=datacatalog.cookcountyil.gov | Contracts + checkbook | Checkbook and contract data |
| **Montgomery County MD** | `socrata_query` domain=data.montgomerycountymd.gov | Vendor payments | Discover dataset IDs |
| **Hennepin County MN** | `arcgis_feature_query` view=`hennepin_transportation_cip` | Transportation CIP pipeline | ~257 rows; capital-project pipeline — **NOT** solicitations or awards |
| **Charlotte-Mecklenburg NC** | `arcgis_feature_query` view=`charlotte_mecklenburg_cip` | Joint city-county CIP pipeline | ~2,276 rows; capital-project pipeline — **NOT** solicitations or awards |

**State portals with no keyless procurement content (measured absence, 2026-09-21):**
- **Login-gated or WAF-blocked live-bid portals:** CA (Cal eProcure), TX ESBD/TxSmartBuy non-TxDOT (TxDOT lettings ARE available via `qh8x-rm8r` above), OH (OH|ID), NC (NC eProcurement), MI (SIGMA), and the Periscope-based portals for IL, MA, and NJ. These states have Socrata/CKAN mirrors for past spend (rows above); what they lack is a keyless live non-TxDOT bid feed.
- **Portal live, no procurement data:** PA (`data.pa.gov` is live and allowlisted; scoped catalog returns 0 bid/vendor/procurement datasets). Michigan (`data.michigan.gov`) was checked 2026-09-21 and carries only NIGP commodity code reference tables (`w3u3-uptp` 9,333 rows; `jv5q-yp8x` 235 rows) — not procurement transactions.
- **No state-level open-data portal:** FL (`data.fl.gov` NXDOMAIN — domain does not exist), GA (`data.georgia.gov` NXDOMAIN). These are measured absences, not connectivity blocks — there is no state portal to reach.

### Dataset & registry discovery — data.gov · get.gov (2)
- `datagov_search_datasets` — search the data.gov v4 catalog for federal open datasets across all publishing agencies.
- `search_gov_domains` — the authoritative CISA get.gov .gov domain registry (resolve which org owns a `.gov`; enumerate federal agencies; map SLED entities by state / domain type).

### Small business — SBA (1)
- `sba_size_standard` — SBA size standard for a 6-digit NAICS (set-aside eligibility gate). Returns standardType (receipts/employees/assets), normalized threshold, unit, footnote; value is `asOf` retrieval — re-verify for high-stakes eligibility.

### Labor compliance — US DOL (2)
- `dol_list_datasets` — browse the DOL enforcement/compliance dataset catalog (WHD wage-hour, OSHA, OFCCP, ILAB, MSHA…). **Keyless.** agency/query filtering is client-side. Feed a row's `apiUrl` + `agencyAbbr` into the next tool.
- 🔑 `dol_get_dataset` — fetch records from ONE DOL dataset (**requires free DOL_API_KEY** — data endpoint has no keyless tier, throws without it). Records surfaced VERBATIM (envelope key-gated/unverified); totalAvailable null unless the response carries a real count.

### Lobbying & influence — US Senate LDA (1)
- `lda_search_filings` — Senate lobbying filings: who is paid HOW MUCH to lobby WHICH agency on WHICH issue (keyless; optional LDA_API_KEY raises the rate). totalAvailable is the API's real ~1.95M-filing match count, not page rows; income/expenses null-never-0.

### Server utilities — key discovery · feedback (2)
- `api_key_status` — list every key the server can use, required vs optional, signup URL, what it unlocks, and whether each is currently set (a boolean — the value is NEVER shown). The live source of truth for key config.
- `feedback` — build a PREFILLED GitHub issue link (bug / feature / wrong_output) for the USER to open & submit (the server never posts). Use when the user reports a problem or wants a missing capability. `schema_drift` / `upstream_unavailable` errors also carry a `report` URL.

### Product safety & recalls — openFDA · NHTSA · CPSC (6)
- `openfda_enforcement` — drug/device/food recalls & FDA enforcement (recalling firm, Class I/II/III, reason, state).
- `openfda_device_clearances` — FDA 510(k) medical-device clearances (applicant, device, K-number).
- `openfda_drug_approvals` — Drugs@FDA approved applications (sponsor, products, submissions).
- `nhtsa_recalls` — NHTSA vehicle recalls by make/model/modelYear.
- `nhtsa_complaints` — NHTSA consumer safety complaints by make/model/modelYear.
- `cpsc_recalls` — CPSC consumer-product recalls.

### Litigation & courts — CourtListener (1)
- `courtlistener_search_opinions` — US federal court opinions (COFC bid-protest / contract-claim, CAFC). Free Law Project (non-`.gov`; provenance disclosed). Search a litigant with `party` (fielded `caseName:`) — a bare company name in `query` matches every opinion that merely mentions it (Lockheed Martin: 5,954 mentions vs 327 actual-party cases).
- `courtlistener_search_dockets` — US federal court DOCKETS (RECAP; case records, not opinions): `party` + `natureOfSuit` (a real fielded filter here, e.g. "False Claims") + court/dates/cursor → docketNumber, court, dateFiled, dateTerminated (null = still open), natureOfSuit, cause, url. This is where False Claims Act / qui tam matters live — settlements rarely produce a published opinion. A docket is the case record; the outcome or settlement amount is NOT in it.

### Nonprofit vendors — IRS 990 via ProPublica (2)
- `nonprofit_search` — tax-exempt orgs by name/state/NTEE (IRS Form 990). Provenance: ProPublica (non-`.gov`).
- `nonprofit_financials` — a nonprofit's 990 financials by EIN.

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
6. (Facility) `echo_search_facilities` → `echo_facility_report` — EPA compliance/enforcement; `epa_tri_facilities` for the toxics-release footprint. (Healthcare firm) `cms_revoked_providers` — Medicare revocation list.
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
4. (Healthcare market) `cms_medicare_provider_services` / `cms_dmepos_suppliers` (what providers and equipment suppliers bill Medicare, by NPI or state); `cms_hospital_compare` / `cms_facility_directory` (where facilities are, ownership, CMS star rating). Screen a healthcare partner with `cms_revoked_providers`.

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
- **Key-required tools throw without a key** — the 5 🔑 tools (Census, FRED×2, BEA, DOL data) return an honest config error, not a fake empty. Check `api_key_status`.
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

**Optional — only raise a rate limit or unlock one filter (the tools these keys affect all work without them):**

| Env var | Effect |
|---|---|
| `SAM_GOV_API_KEY` | authenticated SAM.gov v2 search + the organizationName filter + full archive (>~12mo) |
| `DATA_GOV_API_KEY` | higher limits across api.data.gov sources (Regulations.gov, Congress.gov, GovInfo, FAC, data.gov catalog, GSA per-diem) — lifts the shared `DEMO_KEY` cap |
| `LDA_API_KEY` | higher rate on `lda_search_filings` |
| `BLS_API_KEY` | BLS v2 tier (~500/day vs keyless ~25/day) for `bls_timeseries` (QCEW/CSV path is un-rate-limited regardless) |
| `NVD_API_KEY` | higher NVD rate for `cve_lookup` |
| `SOCRATA_APP_TOKEN` | higher Socrata throttling limits |

Creating the account at a signup URL is the one manual step; the server automates *discovery* (`api_key_status`) and *configuration* (`.env`). To confirm a key actually works, call that source's own tool.

## Reporting problems & requesting features

This server has a built-in, **PULL-only** feedback path — use it to help the user improve the tool:

- **On a `schema_drift` or `upstream_unavailable` error**, the `{ ok: false, error }` envelope carries a **`report`** URL (a prefilled GitHub issue link). If the failure looks real or persistent, offer it: *"This looks like the government API changed / is down — you can report it here: `<report URL>`."*
- **When the user reports a bug, says a result looks wrong, or wants a capability this server lacks**, call the **`feedback`** tool with `kind` (`bug` | `feature` | `wrong_output`), optional `tool`, and a short **non-sensitive** `summary`. It returns a `reportUrl` for the user to open and submit.

**Never post anything yourself** — the server only builds the link; the human opens and submits it. The repo is public, so never put secrets, personal data, or sensitive query values in `summary` (and tell the user to redact them).

## Toolset profiles (MCP_SAM_GOV_TOOLSETS)

If the server is configured with a toolset profile (e.g. `MCP_SAM_GOV_TOOLSETS=core,sled`), some tools may not be loaded. When a tool is unavailable because of a profile, you receive a `tool_not_loaded` error naming the toolset and the exact `MCP_SAM_GOV_TOOLSETS` value to set — it always suggests the **union** of the currently loaded sets and the needed set (e.g. `MCP_SAM_GOV_TOOLSETS=core,vetting`) so the user's existing profile is not dropped. Tell the user to update their server configuration with the suggested value, or use `MCP_SAM_GOV_TOOLSETS=all` to load everything. `feedback` and `api_key_status` are always available regardless of the active profile.
