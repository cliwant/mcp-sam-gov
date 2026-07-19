# Changelog

All notable changes to `@cliwant/mcp-sam-gov` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.8.0] — 2026-07-18 (Agent-eval-driven disclosure fixes — keyless, no tool changes)

Additive minor release. Clarity improvements surfaced by a new agent-level eval (an LLM agent given only the tools, on realistic B2G tasks). No tool/schema changes (still **143**) — all `_meta`/disclosure.

### Changed

- **"obligations" disambiguation** — an agent conflated two same-named figures. `usas_list_toptier_agencies` (`obligatedAmount` = **account-level** total, all spending) and `usas_get_agency_awards_summary` (`obligations` = **award-level** only) now each disclose the distinction and cross-reference the other in `_meta` (e.g. VA ~$298B account-level vs ~$205B award-level).
- **`usas_get_agency_profile`** now returns a `spendingNote` pointing to where obligation figures live — the profile has no spending total, and an agent asking "how much did agency X obligate?" was dead-ending here.
- **`usas_list_toptier_agencies`** `_meta` now notes the list is alphabetical (sort client-side for top-N by spending) and that `limit` is ignored upstream (the returned count is the total).
- **`ecfr_search`** `_meta` now notes each `excerpt` is a ranked snippet (not full section text — open the row's `ecfrUrl`) and that a section recurs once per historical version.

2 new non-vacuous fault-injection assertions (3274 → 3276).

## [1.7.0] — 2026-07-18 (Stay-current: startup update notice + auto GitHub Releases — keyless, no telemetry)

Additive minor release. Two "keep installed users current" changes; no tool changes (still **143**).

### Added

- **Startup update notice** (opt-out, no telemetry): on startup the server makes a single anonymous GET to the public npm registry for its own `latest` version and — **only if a newer one exists** — prints one line to **stderr** (never stdout). This reaches already-installed users; npm is pull-based and otherwise never tells them. It sends **no user data** (a version check, not telemetry), is non-blocking, fail-silent, and quiet when you're current. Opt out with `MCP_SAM_GOV_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER=1`). 12 non-vacuous fault-injection assertions pin the behavior.

### Changed

- **Releases**: the tag-triggered release workflow now also creates the matching **GitHub Release** (notes drawn from this CHANGELOG), so the npm version and the GitHub Release stay in lockstep and repo watchers are notified of every version.

## [1.6.0] — 2026-07-18 (In-product feedback loop → GitHub issues — 142 → 143 tools, keyless)

Additive minor release. Adds a **PULL-only** feedback loop so the server improves from real usage — without ever posting anything itself.

### Added

- **`feedback` tool** (143rd tool, keyless): returns a PREFILLED GitHub new-issue link (`kind` = bug / feature / wrong_output) for the human to open and submit. The server never posts — no token, no account, no network call. Prefills carry only the caller's summary + tool name.
- **`report` field on error envelopes**: `schema_drift` and `upstream_unavailable` errors now carry a prefilled GitHub issue URL (tool + kind + server version only — no arguments, no PII). Expected errors (`invalid_input`, `not_found`, `rate_limited`) stay byte-identical (no `report`).
- **Server `instructions`**: tell the agent to offer the issue link when a result looks wrong, a tool stays broken, or the user wants a missing capability.
- **GitHub issue templates** (bug / feature / wrong-output), plus contributor governance landed since 1.5.0: a self-contained **DCO** sign-off CI check + CONTRIBUTING guidance, and the `LICENSE` copyright holder clarified to `Cliwant and the mcp-sam-gov contributors` (still MIT).

### Guarantees

PULL-only (the server never submits a form for you), no PII in any prefill, no telemetry, and non-nagging (report links appear only on the two "something may be broken" error kinds). 15 new non-vacuous fault-injection assertions pin all of the above.

## [1.5.0] — 2026-07-16 (Systematic domain sweep: disaster-resilience + emergency-fund + cyber-compliance + freight + gov-registry — 134 → 142 tools; plus dogfooding honesty hardening — all keyless)

Additive minor release. Every 1.4.0 tool is unchanged and byte-identical; this adds **8 keyless tools across 4 new sources**, sweeping five B2G domains in one pass — disaster-resilience, emergency-fund spending, cyber-compliance, freight/logistics, and the authoritative .gov registry. Every new source is keyless. Two ride non-`.gov` hosts but are **first-party federal publications with provenance disclosed in `_meta`** — NIST's OSCAL SP 800-53 content (`github.com/usnistgov/oscal-content`) and CISA's get.gov registry (`github.com/cisagov/dotgov-data`), both distributed by their own agencies via GitHub.

### Added — disaster-resilience & emergency-fund

- **FEMA Hazard Mitigation Assistance** (`fema_search_hazard_mitigation`): HMGP / FMA /
  PDM / BRIC mitigation grants to state/local/tribal subrecipients — the resilience
  (pre-disaster) counterpart to Public Assistance recovery, distinct from
  `fema_search_public_assistance`.
- **USAspending Disaster Emergency Fund Codes** (`usas_list_disaster_codes`,
  `usas_disaster_spending`): enumerate the DEFC tags (COVID-19, IIJA/infrastructure,
  and other emergency-appropriation tags), then break emergency-fund spending down
  **by geography** — which state / county / district captured the COVID / IIJA relief.
- **NWS active weather alerts** (`nws_active_alerts`): currently-active watches /
  warnings / advisories from `api.weather.gov` — disaster/climate readiness that pairs
  with the FEMA tools.

### Added — cyber-compliance

- **NIST SP 800-53 Rev 5** (`nist_800_53_controls`): security & privacy control lookup —
  FedRAMP / CMMC / RMF requirement text by controlId / family / keyword. *Source =
  NIST's first-party OSCAL content (`github.com/usnistgov/oscal-content`); provenance
  disclosed in `_meta`.*

### Added — pharma

- **openFDA Drugs@FDA** (`openfda_drug_approvals`): drug-approval applications —
  sponsor, approved products, submission/approval history — extending the openFDA
  recall/clearance pair into approvals.

### Added — freight/logistics

- **CBP border wait times** (`cbp_border_wait_times`): live land-border
  commercial-vehicle wait times at Canadian + Mexican ports (`bwt.cbp.gov`) — a
  freight/logistics signal alongside the USITC tariff tool.

### Added — gov-registry

- **CISA get.gov .gov registry** (`search_gov_domains`): the authoritative .gov domain
  registry — resolve which org owns a .gov domain, enumerate federal agencies, and map
  SLED entities. *Source = CISA's first-party dataset (`github.com/cisagov/dotgov-data`);
  provenance disclosed in `_meta`.*

### Changed

- `treasury_query_dataset` gained 2 datasets — `interest_expense` and `tror` — same
  tool, no tool-count change (the escape-hatch query surface widens to more confirmed
  Treasury Fiscal Data datasets).
- Documentation refreshed to **142 tools across 48 federal data sources**;
  `api_key_status` / `API_KEYS.md` are unchanged — every new source is keyless, so the
  key inventory stays at 4 required + 8 optional.

### Fixed

Dogfooding-driven honesty & drift hardening (~10 fixes), each preserving the
"honest failure over confident fabrication" contract — a genuine empty and an outage
stay distinguishable:

- **Subaward upstream field-rename drift**: an upstream field rename in the subaward
  feed is re-mapped, restoring populated subaward rows.
- **Unknown-input-key loud-fail**: an unrecognized input key now fails loudly
  (`invalid_input`) instead of being silently dropped.
- **List-tool `_meta` envelopes**: list-style tools now carry the standard `_meta`
  envelope for provenance/staleness parity with the rest of the surface.
- **`rate_limited` not `timeout`**: a throttled upstream is now typed `rate_limited`
  rather than misreported as a timeout.
- **openFDA default-category disclosure**: the default openFDA category is now disclosed
  in the response rather than applied silently.
- **usas agency code/name guards**: an unresolved agency code or name now fails honestly
  instead of returning a confidently-wrong empty result.
- **EDGAR fuzzy-match disclosure**: a fuzzy company-name match is now disclosed rather
  than presented as an exact hit.
- **data.gov v4 param-rename drift**: a renamed data.gov v4 query parameter is realigned
  so the catalog search keeps working.

## [1.4.0] — 2026-07-15 (Waves 6–7: cross-agency safety/vetting + healthcare depth — 120 → 134 tools, all keyless)

Additive minor release. Every 1.3.0 tool is unchanged and byte-identical; this adds **14 keyless tools** across new B2G vetting/market lanes. All the new sources are keyless (a couple of non-.gov republishers of federal public data are provenance-disclosed).

### Added — cross-agency product-safety vetting

- **openFDA** — `openfda_enforcement` (FDA drug/device/food recalls & enforcement) and
  `openfda_device_clearances` (FDA 510(k) medical-device clearances). Health/medical
  supplier responsibility + capability vetting. A no-match query (openFDA's 404) is an
  honest empty, never an error.
- **NHTSA** — `nhtsa_recalls` and `nhtsa_complaints` (vehicle safety by make/model/year).
  Vehicle/parts/fleet supplier vetting. (VINs are excluded — never surfaced.)
- **CPSC** — `cpsc_recalls` (consumer-product recalls). Product supplier vetting.

### Added — environmental, legal & nonprofit vetting

- **EPA Envirofacts** — `epa_tri_facilities` (Toxics Release Inventory facilities;
  real totals via a count sub-query). Environmental/ESG facility vetting, distinct
  from EPA ECHO.
- **CourtListener** — `courtlistener_search_opinions` (US federal court opinions:
  Court of Federal Claims contract claims/bid protests, Federal Circuit appeals).
  Legal-risk / contract-dispute intel. *Data = federal court records via CourtListener
  (Free Law Project); disclosed in `_meta`.*
- **IRS Form 990 nonprofits** — `nonprofit_search` + `nonprofit_financials`
  (nonprofit vendor / grant-recipient vetting: EIN, exempt status, NTEE, 990
  financials). *Via ProPublica Nonprofit Explorer; disclosed in `_meta`.*

### Added — healthcare depth (CMS)

- `cms_medicare_provider_services` (Medicare Part-B provider utilization & payments —
  demand-side market sizing), `cms_hospital_compare` (hospital quality ratings),
  `cms_facility_directory` (nursing home / home health / hospice / dialysis
  directories, 4 datasets in one tool), `cms_dmepos_suppliers` (DME supplier
  directory + Medicare spend), and `cms_revoked_providers` (Medicare
  revocation/exclusion list — a compliance lane alongside OFAC + SAM exclusions).
  All keyless, org/provider-level public data, real totals via CMS count endpoints.

### Changed

- Documentation refreshed to **134 tools**; `api_key_status` / `API_KEYS.md` track
  **12 keys** (4 required, 8 optional) — every new source above is keyless.

## [1.3.0] — 2026-07-15 (Wave 5: BEA + Senate lobbying + DOL enforcement — 116 → 120 tools)

Additive minor release. Every 1.2.0 tool is unchanged and byte-identical; this adds 4 tools across 3 new sources, extending market-sizing, influence, and labor-compliance coverage.

### Added — new sources (+4 tools, 34 → 37 sources)

- **BEA Regional Economic Accounts** (`bea_regional_data`): GDP / personal income by
  **industry × geography** (`apps.bea.gov`, dataset=Regional). Completes the
  market-sizing triad — BLS QCEW + Census CBP + **BEA regional GDP**. **Key-required**
  (free BEA_API_KEY): comma-formatted values are parsed, and BEA's suppression
  sentinels (`(D)/(NA)/(NM)/(L)/*`) map to `null` (never a fake `0`). An invalid key
  (a `200` carrying `Results.Error`) throws an honest `invalid_input`, never an empty.
- **US Senate LDA lobbying** (`lda_search_filings`): who lobbies which federal agency,
  on what issue, for how much (`lda.senate.gov`). The pre-RFP influence/competition
  signal. **Keyless** (an optional free LDA_API_KEY only raises the rate limit).
  `income`/`expenses` stay `null` when unreported (never `0`); `totalAvailable` is the
  API's real count, not the page length.
- **US DOL enforcement / compliance** — a hybrid pair: **`dol_list_datasets`**
  (keyless dataset catalog, 42 datasets incl. WHD Enforcement) and
  **`dol_get_dataset`** (WHD wage-hour / OFCCP records; **key-required**, free
  DOL_API_KEY sent only in the `X-API-KEY` header). Labor-compliance vetting of
  partners and competitors — the complement to the server's wage-determination tools.

### Changed

- `api_key_status` now tracks **10 keys**: 4 sources need a free key (Census, FRED,
  BEA, and DOL's data endpoint), the other 33 sources remain keyless. Registry
  descriptions and counts updated accordingly.
- Documentation refreshed to **120 tools across 37 federal data sources**
  (keyless-first — 4 sources require a free key).

## [1.2.0] — 2026-07-15 (GSA travel per-diem — 115 → 116 tools)

Additive minor release. Every 1.1.0 tool is unchanged and byte-identical; this adds one tool and completes the Wave 4 source expansion.

### Added

- **GSA Federal Travel Per-Diem** (`gsa_perdiem_rates`): monthly lodging + M&IE
  meals caps by **city + state** or **zip**, for a fiscal year (`api.gsa.gov`).
  Keyless via the shared api.data.gov key seam (DEMO_KEY; an optional
  `DATA_GOV_API_KEY` raises the shared limit). Monthly lodging rates are returned
  as-is (seasonal), meals as an integer USD cap; the wire string booleans
  (`standardRate`, `isOconus`) become real booleans. A 429 (DEMO_KEY hourly cap)
  throws an honest `rate_limited` — never an empty result, never routed around.

### Changed

- `api_key_status` now lists **GSA per-diem** among the `DATA_GOV_API_KEY` sources
  (the key raises its shared rate limit).
- Documentation: the tool catalog and counts are refreshed to **116 tools across
  34 federal data sources** (keyless-first — only Census CBP and FRED require a
  free key).

## [1.1.0] — 2026-07-15 (Wave 4 sources + always-on resilience + key self-service — 111 → 115 tools)

Additive minor release. Every tool from 1.0.0 is unchanged and byte-identical; this adds 4 tools, turns the snapshot backstop on by default, and lands two truthfulness fixes found in a pre-release review sweep.

### Added — new sources (+4 tools, 31 → 33 sources)

- **US Census — County Business Patterns** (`census_business_patterns`): market
  sizing by establishments / employment / annual payroll across NAICS × geography.
  The Census Data API has no keyless tier, so this is a **key-required** source —
  it throws an honest `invalid_input` (naming `CENSUS_API_KEY`) when no key is set.
  Census confidentiality sentinels (large negatives) map to `null`, never a
  negative or a fake `0`.
- **FRED — macroeconomic series** (`fred_search_series`, `fred_series_observations`):
  GDP / CPI / rates / unemployment and the rest of the St. Louis Fed catalog for
  bid-escalation and market-timing context. Also **key-required** (`FRED_API_KEY`);
  missing observations (`"."`) map to `null`.
- **API-key self-service** (`api_key_status`): a keyless tool that reports, for all
  7 keys the server can use, which env var each source reads, whether it is
  **required** or merely **optional** (raises a limit), the free signup URL, and
  whether it is **currently set** — as a boolean only; a key's value is never read
  into the output.

### Added — reliability

- **Snapshot backstop is now ON by default.** If a live source is unreachable, the
  server transparently serves the last-good hosted public-data snapshot with full
  provenance disclosure (`_meta.dataPath: "snapshot"` + `asOf`), never presented as
  live. Set `SAMGOV_SNAPSHOT_BASE_URL=off` to disable. A weekly (and on-demand)
  GitHub Action refreshes the snapshots from a clean egress. Rate limits are always
  honored — a 429/Retry-After is never routed around a mirror.
- **`.env` auto-loading**: keys can be set once in a project `.env` (real
  environment variables always win); no `.env` present ⇒ byte-identical startup.

### Fixed — truthfulness

- `api_key_status` listed the wrong sources for `DATA_GOV_API_KEY` (advertised
  NPPES/CMS, which are keyless on their own hosts, and a non-existent GSA per-diem
  tool; omitted Congress.gov and GovInfo). Corrected to the real keyed consumers.
- `census_business_patterns` misclassified an **invalid** `CENSUS_API_KEY` as a
  transient outage (`upstream_unavailable`) instead of a config error. The Census
  API 302-redirects a bad key to its "Missing Key" page; the tool now detects that
  via `redirect:"manual"` and throws an honest `invalid_input` naming the key.

## [1.0.0] — 2026-07-14 (first npm release since 0.3.0 — 111 tools, resilience & a truthfulness overhaul)

The largest release yet and the **first npm publish since 0.3.0** — it consolidates the in-repo 0.4.0–0.7.0 iterations and adds a major expansion: **52 → 111 tools across 31 keyless federal data sources**, a codebase-wide honesty dogfooding pass, and a resilience initiative for public-data availability.

### Added — new source families (+59 tools)

- **Entity & partner vetting:**
  - **OFAC** — `ofac_screen_entity` keyless denied-party / sanctions screening.
  - **SEC EDGAR (depth)** — 8 tools: CIK lookup, company filings, curated XBRL
    company facts, single-concept time-series, cross-filer XBRL frames, full-text
    search (2001–present), and the quarterly + daily cross-filer filing indexes.
  - **FDIC (depth)** — 7 tools: institution directory search, quarterly
    financials, risk ratios, structural-change history, branch deposits, historical
    bank failures, and industry/state banking aggregates.
  - **FAC** — Federal Audit Clearinghouse Single Audit search + findings drill-down.
  - **EPA ECHO** — regulated-facility compliance/enforcement search + Detailed
    Facility Report.
- **Health & research funding:** **NPPES** provider lookup; **CMS Open Payments**
  (Sunshine Act) dataset discovery + datastore query; **ClinicalTrials.gov**
  search / get / whole-registry facet counts; **NIH RePORTER** projects; **NSF**
  award search + detail.
- **Cyber compliance:** **NVD** `cve_lookup` + **CISA KEV** `cisa_kev_lookup`
  (binding BOD 22-01 remediation due-dates).
- **Trade & tariffs:** **USITC HTS** `hts_lookup` (import classification + duty rates).
- **Regulatory & legislative (depth):** **Federal Register public-inspection**
  desk; **Regulations.gov** dockets / documents / comments / get-docket;
  **Congress.gov** bill search + detail; **GovInfo** (GPO-authoritative) package
  search / get / collections; **eCFR** already present.
- **Pricing, labor & fiscal:** **BLS** timeseries (CPI/ECI/PPI), OEWS wages, and
  QCEW county×NAICS market size; **US Treasury** Fiscal Data — Debt to the Penny,
  average interest rates, Monthly Treasury Statement, and a query escape-hatch.
- **Spending & competition (depth):** **FPDS-NG** award-action search; plus new
  USAspending recompete / incumbent / teaming-partner analysis tools.
- **Geo, disaster & open data:** **US Census** geocoder (address + coordinates →
  geographies); **FEMA** disaster declarations + Public Assistance; **Socrata**
  and **CKAN** dataset discovery + query for state/city open data.
- **Dataset discovery:** **data.gov v4** catalog search (`datagov_search_datasets`,
  the CKAN-deprecation replacement for federal dataset discovery).

### Added — reliability & resilience initiative

- **Multi-path DataSource layer** (`src/datasource.ts`) — resilient-fetch
  primitives (`getJsonWithProvenance`, a path chain, a single-path circuit
  breaker, conditional-GET) that land **INERT**: with no snapshot configured every
  source stays single-path (live-only) and output is byte-identical to before.
- **P5 provenance / freshness** — a non-live response discloses its access path
  via `_meta.dataPath: "snapshot"` + `asOf`; `provenanceMeta` returns `{}` for a
  live body so the `_meta` stays byte-identical when nothing is degraded. A
  snapshot is **never** presented as live.
- **Snapshot mirror** (`src/snapshot.ts`) — an optional, env-gated
  (`SAMGOV_SNAPSHOT_BASE_URL`, unset by default) reader that serves a static,
  public-only cache of slow-changing reference data (agency list, NAICS tree,
  glossary, SBA size standards, Treasury debt) **only** when the live source is
  unreachable. Public-only gate: refuses any envelope not `accessLevel: "public"`;
  honors 429s, no proxies, no off-host redirects.
- **Self-diagnosing snapshot builder** (`scripts/build-snapshots.mjs`) — run from
  any clean egress; probes per-source reachability, prints a reachability table +
  `manifest.json`, refreshes only what it can reach and leaves last-good files for
  the rest, and exits non-zero only when the egress is fully blocked. Not scheduled,
  not in CI — on-demand.

### Changed — honesty (Wave-3 dogfooding)

- A **23-fix truthfulness pass** across the tool surface (from dogfooding all
  tools): tightened `totalAvailable` / `complete` / disclosure-suppression
  semantics so a rate-limited or down source, a confidentiality-withheld value, or
  an unsupported filter is disclosed honestly rather than read as a real zero or a
  silent drop.
- **Repo hardening:** branch protection enabled on the default branch.

### Note
Additive: existing tool outputs and the `_meta` shape are unchanged. Marked 1.0.0 to signal a stable, comprehensive, honesty-verified surface.

## [0.7.0] — 2026-07-04 (FAR compliance, document reading, keyless backbone & a truthfulness sweep)

The biggest tier yet. **44 → 52 tools.** Adds a FAR/DFARS compliance layer, the
ability to READ the actual solicitation documents (PDF + DOCX), a legitimate
keyless data backbone, and a codebase-wide truthfulness sweep that guarantees a
DOWN federal service is never reported as "no results" / "not found" / "no
attachments". Still keyless; still no API key required.

### Added
- **FAR/DFARS compliance layer** (composes the eCFR versioner, keyless):
  - **`far_clause_lookup`** — authoritative FAR/DFARS clause text **+ its
    prescription** ("As prescribed in …") for an exact clause number. Use this,
    not `ecfr_search`, which mis-ranks bare numbers (returns GSAM 552.212-4 above
    FAR 52.212-4). Every response carries a `farOverhaulRisk` currency caveat
    (eCFR reflects only the codified FAR; a Revolutionary-FAR-Overhaul class
    deviation may supersede it). An absent clause → `not_found`, never a fake.
  - **`far_search`** — FAR/DFARS-scoped search (Title-48 chapter filter) that
    keeps GSAM/agency supplements out of FAR results and collapses the
    5×-per-section historical versions to the current one (`isCurrent` per row).
  - **`far_compliance_matrix`** — an RFP's cited-clause list → a proposal-ready
    matrix (per-clause text + prescription + eligibility-gate flags for Section
    889 / CMMC / NIST 800-171 / limitations on subcontracting). Splits absent
    clauses (`unresolved`) from unfetchable ones (`errored`) — a DOWN eCFR never
    reads as "clause doesn't exist".
- **Document reading** — **`sam_fetch_attachment_text`**: extract the TEXT of a
  SAM notice attachment (the real RFP / SOW / Q&A), so an agent can analyze the
  requirements, not just the metadata. **PDF** via `unpdf` (a single
  self-contained dependency) and **DOCX** dependency-free (built-in `zlib` + a
  hand-rolled ZIP parse). A scanned/image-only PDF or a non-extractable format →
  `text:null` + a disclosed reason, never a fabricated empty document. SSRF
  allow-list + redirect-host re-validation + a size cap + a zip-bomb guard.
- **GSA daily-CSV keyless backbone** — **`sam_lookup_notice_fields`** batch-fills
  the naics/set-aside/place-of-performance/deadline the keyless HAL list nulls
  (opt-in, env-gated, streaming RFC-4180 parser, bounded RAM); plus optional
  inline enrichment of `sam_search_opportunities`. Off by default; honest
  `_meta` freshness / not-in-snapshot / degraded disclosure.
- **`sam_search_shaping`** — pre-solicitation radar (Sources Sought /
  Presolicitation / Special Notices) with a client-side response-deadline window.
- **`sam_integrity_lookup`** — composed exclusions + honest FAPIIS deep-link
  (`integrityFlag` is never "clear" keylessly — a type-level guarantee).
- **`sba_size_standard`** — SBA small-business size standard for a NAICS
  (receipts / employees / assets), normalized to dollars, with an as-of caveat.
- An offline **fault-injection test harness** (`npm run gate`) that permanently
  CI-guards the truthfulness/degradation invariants (now 338 assertions).

### Changed
- One new runtime dependency: **`unpdf`** (self-contained PDF text extraction —
  bundles pdfjs, no transitive deps). DOCX and everything else stays dependency-free.

### Fixed — truthfulness (a DOWN service is never reported as absent)
- **`sam_search_opportunities` / `sam_search_shaping`**: a total HAL outage (all
  access tiers failed) is no longer reported as "0 notices, complete" — it now
  surfaces `_meta.degraded` + `totalAvailable:null` + a note. A genuine zero is
  unchanged. Also a 200 lacking a valid `page.totalElements` (CDN/WAF interstitial)
  is treated as an outage, not a fake zero.
- **`sam_get_opportunity` / `sam_fetch_description`**: a DOWN detail endpoint
  (5xx / network / timeout / hollow 200) now throws `upstream_unavailable`
  instead of reading as "notice not found"; only a genuinely-absent id (4xx) →
  `found:false`. A failed attachment-list / org enrichment is disclosed via
  `_meta.degraded` ("MAY have attachments — retry"), never a silent "no attachments".
- Keyless SAM search `notice_type` filter and other `_meta` completeness signals
  refined across the board (see the fault-injection harness for the guarded invariants).

### Note
Version + changelog are in-repo. **Not published to npm** — awaiting maintainer sign-off.

## [0.6.0] — 2026-07-03 (integrity, teaming & protests)

Closes the capture lifecycle's integrity / teaming / protest gap — the last two
benchmark losses. **41 → 44 tools.** Against a 10-scenario competitor benchmark,
the keyless win-rate reaches **10 / 10 with zero remaining losses** (only
paid-tier depth — full protest history, SLED — still leads).

### Added
- **`sam_check_exclusions`** — keyless SAM debarment / exclusion screening
  (frontend SGS `index=ex`). Screen a firm or individual by name and/or UEI/CAGE.
  `excluded` / `records` / `matchCount` are **normalized-name gated** — SAM's
  free-text search tokenizes, so a shared word must never flag an unrelated firm
  (e.g. "Visionary Consulting Partners" no longer matches every "…Partners…"
  exclusion); UEI/CAGE selectors exact-match. An empty result is disclosed as a
  narrow true-negative ("not currently excluded under these terms"), **never
  proof of general responsibility**.
- **`usas_search_teaming_partners`** — keyless small-business teaming discovery
  by socioeconomic certification + NAICS + agency award history (USAspending
  `recipient_type_names` proxy), ranked by obligated $ and integrity-screened via
  `sam_check_exclusions`. The `cert` is **Zod-enum-validated**: USAspending
  silently accepts an unknown category as `0` results, so a typo is rejected as
  `invalid_input` rather than returning a confident-empty list. Labeled
  **award-derived, NOT the SBA certification of record** (verify in SAM/SBS).
- **`gao_protest_lookup`** — recent GAO bid-protest decisions from the public
  Legal-Products RSS feed + per-decision page parse (protester, contracting
  agency, decision date, outcome, solicitation #, decision PDF). **Honestly
  scoped:** `_meta` is always `complete:false` / `truncated:true` with an
  `accessNote` — keyless covers only the recent feed window; GAO's faceted
  historical protest search is WAF-blocked and a paid-API capability, so results
  are never presented as the full protest history.

### Changed
- **Zod input-validation failures now return `invalid_input`** (was `unknown`)
  across all tools — a non-retryable, actionable error naming the field and its
  valid options.
- Bumped `package.json` + `manifest.json` + `server.json` to `0.6.0`
  (manifest descriptions now read 44 tools).

### Backward compatibility
- Additive: existing tool outputs and the `_meta` shape are unchanged; no
  input-schema changes to existing tools.

## [0.5.0] — 2026-07-03 (recompete + pricing)

Builds the capture and pricing lifecycle on top of the v0.4 truthful substrate.
**36 → 41 tools.**

### Added
- **Recompete radar — `usas_search_recompetes`.** Federal contracts whose current
  period-of-performance end date falls inside a window, soonest-first, with true
  pagination and explicit completeness signals — **no silent drops**. Reads PoP
  end dates directly from the award-search endpoint (no per-award enrichment),
  narrows by an action-date lookback, windows client-side within a scan budget.
  `_meta.totalAvailable` is the exact in-window count when the window is fully
  scanned and `null` (an honest lower bound) when the scan budget truncates;
  awards with a null end date are counted, never dropped.
- **`usas_analyze_incumbent`.** Per-award incumbent + **public** recompete-pressure
  signals: obligated-vs-ceiling consumption, modification count (lower-bounded),
  competition extent + number of offers, set-aside, days to the current PoP end,
  option-extendable days, and vehicle/IDV linkage — plus the incumbent's other
  awards in the same agency. Emits `pressureHints` (labels), **never a composite
  "vulnerability score"** — CPARS/past-performance, protest history, and
  option-exercise intent are not public and are declared in
  `_meta.fieldsUnavailable`. Bounded & keyless (≤ 3 upstream calls, no N+1).
- **Keyless pricing (3 tools):**
  - **`sam_search_wage_determinations`** — Service Contract Act / Davis-Bacon
    wage determinations by coverage + locality (state filtered server-side,
    county client-side, both disclosed in `_meta`).
  - **`sam_get_wage_rates`** — prevailing wage + fringe / Health & Welfare table
    + the Executive-Order minimum-wage floor, **parsed from the WD's plain-text
    document** with a `parseConfidence` flag and a `format: parsed | raw | both`
    escape hatch. It never fabricates structure the source lacks; SCA (WD-wide
    H&W) and DBA (per-craft fringe) are kept distinct; the EO figure is read from
    the document text, not hardcoded.
  - **`gsa_benchmark_labor_rates`** — GSA CALC awarded ceiling-rate market band
    (min / median / max / n over a fetched sample), **never a single price**,
    with ceiling / fully-burdened / vendor-specific-escalation caveats and honest
    handling of the API's saturated (`≥ 10000`) match counts.

### Changed
- **`usas_search_expiring_contracts` is now a thin deprecated alias** of
  `usas_search_recompetes` (legacy `{ contracts, searchedCount }` keys
  preserved). As the deliberate cost of removing per-award enrichment, its
  `setAsideDescription` / `description` / `potentialEndDate` are now `null`.
- Bumped `package.json` + `manifest.json` + `server.json` to `0.5.0`.

### Fixed
- **`usas_get_award_detail` error classification.** A 404 → `not_found`; a
  429 / 5xx / network fault now surfaces as a retryable
  `rate_limited` / `upstream_unavailable` error instead of being masked as
  `{ ok: true, data: null }`.

### Breaking (minor, pre-1.0)
- **`usas_get_award_detail.numberOfOffers`** is now a parsed `number | null`
  (previously the raw string the API returns) — a correctness fix. Consumers
  that read it as a string should now read a number.

### Backward compatibility
- Additive otherwise: existing tool outputs keep their keys; the `_meta` shape is
  unchanged; no input-schema changes to existing tools.

## [0.4.0] — 2026-07-03 (truthful outputs)

The theme of this release is **never silently mislead an AI consumer.** Every
tool now reports how complete and trustworthy its result is, and a
long-standing keyless-filter bug that returned unfiltered results is fixed.

### Added
- **`_meta` on every tool response.** The success envelope is now
  `{ ok, data, _meta }`. `_meta` lets an AI branch on completeness and
  provenance deterministically instead of guessing from null fields:
  - `complete` / `truncated` — is this the entire result set, or a capped slice?
  - `returned` / `totalAvailable` — rows returned vs. the upstream's true match
    total. `null` when the endpoint reports no total — **never** faked from the
    page length.
  - `filtersApplied` / `filtersDropped` — which requested filters the upstream
    verifiably honored vs. silently ignored.
  - `fieldsUnavailable` — fields that are null by API limitation (keyless /
    endpoint shape), not because the underlying data is empty.
  - `pagination`, `degraded`, `source`, `keylessMode`, `notes` — provenance and
    short, AI-actionable caveats.

### Fixed
- **Keyless SAM search now actually filters by NAICS and place-of-performance.**
  The keyless path sent query-parameter names (`naics_code` /
  `place_of_performance_state`) that the sam.gov endpoint silently ignores — so
  a NAICS- or state-filtered search quietly returned unfiltered results.
  Corrected to `naics` / `pop_state` (place-of-performance now upper-cased);
  verified live end-to-end (search → fetch detail → NAICS matches). Set-aside
  and keyword filters were already correct. The tool's `_meta.filtersApplied`
  now reflects reality; organization-name (which has no keyless filter) is
  reported in `filtersDropped`.
- **USAspending award tools no longer present a missing total as `0` or the
  page length.** Endpoints that paginate without a grand total return
  `totalAvailable: null` and flag truncation from `hasNext`; those with a real
  companion count (`spending_by_award_count`, recipient/agency page metadata,
  glossary) report the true total.
- **`usas_search_individual_awards` returns `naicsCode`**, at parity with the
  other award tools (the field was requestable from the endpoint all along).
- **Grants.gov `cfdaList` is typed and normalized as `string[]`** (it is an
  array of CFDA numbers, not a delimited string).

### Changed
- Bumped `package.json` + `manifest.json` + `server.json` to `0.4.0`.

### Backward compatibility
- **Non-breaking.** `data` payload keys are unchanged; `_meta` is a new sibling
  object. Consumers reading `ok` / `data.*` are unaffected. Tool **input**
  schemas are unchanged — all 36 tools accept the same params.

## [0.3.0] — 2026-04-29 (hardening release)

### Added
- **Daily live smoke test** via GitHub Actions. Runs every 24h against
  the production federal APIs; auto-opens an issue tagged `smoke-failure`
  if any tool stops working. Schema-drift early warning system.
- **Structured error envelope** on every tool response:
  - Success: `{ ok: true, data: ... }`
  - Failure: `{ ok: false, error: { kind, message, retryable, retryAfterSeconds?, upstreamStatus?, upstreamEndpoint? } }`
  - `kind` is one of `rate_limited | upstream_unavailable | not_found | invalid_input | schema_drift | unknown`.
  - The agent can now reason about whether to retry without parsing prose.
- **Exponential-backoff retry** with `Retry-After` honoring across all
  five federal APIs (SAM.gov, USAspending, Federal Register, eCFR,
  Grants.gov). Up to 3 attempts on transient 429 / 5xx / network errors.
- README hero with text-based demo transcript and feature-vs-status-quo
  comparison table.
- `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` for community.

### Changed
- Bumped `manifest.json` + `package.json` + `server.json` to `0.3.0`.
- All upstream wrappers (`usaspending.ts`, `federal-register.ts`,
  `ecfr.ts`, `grants.ts`) now go through `fetchWithRetry` instead of raw
  `fetch`. Same contract, but graceful under flaky network / rate limit.

### Backward compatibility
- **Tool input schemas unchanged.** All 36 tools accept the same params.
- **Response wire format changed**: previously tools returned raw data
  in the MCP `content` text. Now they return `{ ok, data | error }`.
  Hosts that already parse JSON from the text part will see one extra
  level of nesting (`.data` for success). Most agents adapt automatically.

## [0.2.1] — 2026-04-29 (rebrand release)

### Changed
- Renamed `@govicon/mcp-sam-gov` → `@cliwant/mcp-sam-gov` (npm scope).
- Renamed bin: `govicon-mcp-sam-gov` → `mcp-sam-gov`.
- GitHub repo moved to `cliwant/mcp-sam-gov` (auto-redirects from old).

## [0.2.0] — 2026-04-29 (mass expansion)

### Added
- **36 tools** total (was 8). Expanded across 5 federal data sources:
  - SAM.gov: 5 tools — search, detail, attachments, body, organization lookup.
  - USAspending: 24 tools — awards, recipients, sub-agencies, time-series,
    NAICS / PSC / state / CFDA / federal-account breakdowns, agency
    profiles, recipient profiles, autocomplete + reference.
  - Federal Register: 3 tools — search, get document, list agencies.
  - eCFR: 2 tools — full-text search across CFR (incl. Title 48 = FAR), list titles.
  - Grants.gov: 2 tools — search opportunities, get grant detail.
- **Anti-hallucination autocomplete guards** for NAICS, recipient names,
  agency abbreviations.
- **Trilingual READMEs** (English / 한국어 / 日本語).
- `.mcpb` Claude Desktop Extension manifest for one-click install.
- Claude Code Plugin format (`.claude-plugin/plugin.json` + `skills/sam-gov/SKILL.md`).
- Subpath exports for library-only consumers:
  - `@cliwant/mcp-sam-gov/sam-gov`
  - `@cliwant/mcp-sam-gov/usaspending`
  - `@cliwant/mcp-sam-gov/federal-register`
  - `@cliwant/mcp-sam-gov/ecfr`
  - `@cliwant/mcp-sam-gov/grants`

### Verified
- Live smoke test: 35/35 tools pass (one chain dependency = self-skipping).
- Latency: p50 250ms, p95 755ms against production federal APIs.

## [0.1.0] — 2026-04-29 (initial)

### Added
- Initial MCP server with 8 tools wrapping SAM.gov public HAL endpoints
  + USAspending v2 share-of-wallet, line items, sub-agency, agency lookup.
- Stdio JSON-RPC transport.
- Claude Code plugin scaffold.

[Unreleased]: https://github.com/cliwant/mcp-sam-gov/compare/v0.7.0...HEAD
[0.6.0]: https://github.com/cliwant/mcp-sam-gov/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/cliwant/mcp-sam-gov/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/cliwant/mcp-sam-gov/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.3.0
[0.2.1]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.2.1
[0.2.0]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.2.0
