# Changelog

All notable changes to `@cliwant/mcp-sam-gov` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.12.0] — 2026-07-20 (adversarial-dogfood honesty hardening, wave 2: 16 fixes + MCP tool annotations + auto-published registry/docs)

The second large **adversarial-dogfooding honesty pass**. Parallel Claude sub-agents audited the tool surface against LIVE upstreams across five batches; every confirmed defect was fixed under the SDLC (live-reproduced → non-vacuous fault fixture → PR → CI 6-gate → snapshot MATCH). Sixteen honesty fixes — dominated by **pagination honesty** (silent duplicate/skip walks, off-by-one duplicate pages, empty-tail livelocks, over-skip fabricated totals, a skip-ceiling poison cursor, and a hard crash on the advertised cursor continuation) — plus MCP tool annotations on all 150 tools. No new tools (150). Fault assertions 3393 → 3441.

### Added

- **MCP tool annotations on every tool** — `tools/list` now advertises `title` + `readOnlyHint: true` + `openWorldHint: true` for all 150 tools (every tool is strictly read-only and calls external government/public APIs). Improves tool-picker UX in every MCP client and satisfies the Anthropic Connectors Directory requirement. (#254)
- **GitHub Pages guide site + auto-published MCP Registry** — a self-contained landing/quickstart page (SEO: Open Graph, JSON-LD, sitemap) plus a GitHub-OIDC workflow that keeps the official MCP Registry listing in lockstep with each release. (#251, #253)

### Fixed

- **`opengov_search_solicitations` — 1-based pagination (was 0-based → duplicate page + dropped tail)** — the `/project/list` `page` param is 1-based (page 0 clamps to page 1), so the first two offsets both re-served page 1 as a silent duplicate and shifted every later page, dropping the tail while `count` still claimed completeness. (#247)
- **`usaspending` recompete cursor livelock** — when the bounded End-Date scan truncated, the tool emitted an ever-advancing `nextOffset` into empty pages; an agent paging by it looped forever. The cursor now advances only within the scanned window; the un-scanned tail is signaled by `hasMore:true` + `nextOffset:null`. (#248)
- **`clinicaltrials_search_studies` — cursor pagination crashed on page 2+** — the tool advertised a `nextCursor`, but following it threw `schema_drift`: ClinicalTrials.gov returns `totalCount` only on the first page and omits it on every `pageToken` continuation. Any result set larger than one page was unreachable past page 1; the total-count guard now applies to the first page only (a continuation ⇒ `totalAvailable:null` + note). (#259)
- **`fema_search_public_assistance` (+ siblings) — empty-tail livelock** — OpenFEMA's `metadata.count` can exceed the rows it will serve via `$skip`, so a near-end offset returned 0 rows while `hasMore:true` and `nextOffset === offset` (a non-advancing cursor). Added the `returned > 0` guard + a disclosure that the count can exceed the pageable window. (#258)
- **`openfda_*` (enforcement / device clearances / drug approvals) — over-skip total + skip-ceiling poison cursor** — an over-skip 404 (byte-identical to a genuine no-match) fabricated `totalAvailable:0` for a non-empty set; and a dataset larger than openFDA's 25,000 `skip` ceiling advertised a `nextOffset > 25000` that 400s when followed. A skip>0 404 now ⇒ `totalAvailable:null` + over-skip note, and the cursor never exceeds the ceiling (disclosed). (#264)
- **`nppes_lookup_provider` — over-skip reported the skip offset as the total** — skipping past the result set made `totalAvailable = skip` (e.g. "56 available" for a 6-match query); a skip>0 empty page now reports `totalAvailable:null`. (#250)
- **`nsf_search_awards` — undisclosed unstable order** — NSF exposes no stable server-side sort, so offset paging can duplicate/skip rows; a multi-page result now discloses that `totalAvailable` (not row-walking) is the reliable count. (#260)
- **`grants_search` — the default `oppStatuses` filter is now disclosed** — the tool always sent `oppStatuses=forecasted|posted` (excluding closed/archived) but only recorded it in `filtersApplied` when the caller supplied it, so `totalAvailable` (a filtered subset — 235 vs 2,008 across all statuses) read as unfiltered. Now always disclosed + a defaulted note. (#257)
- **`socrata` — DISTINCT / any function-call `$select` treated as cardinality-changing** — a `distinct`/aggregate `$select` no longer reports the base-table `count(*)` as the total; `totalAvailable:null` with page-fullness completeness instead. (#244)
- **`ckan_discover_datasets` — truncation driven by dataset count, not per-resource rows** — a unit mismatch made a partial result read as complete; `hasMore` now compares packages-returned against the dataset count. (#245)
- **`gsa` contract-opportunities CSV — column-header contract asserted before indexing** — a shifted upstream header column now throws `schema_drift` instead of silently mis-indexing fields. (#243)
- **`census` business-patterns — default CBP year advanced to the latest published vintage (2022 → 2023)**. (#246)
- **`bonfire_search_opportunities` — a drifted seed slug's redirect is `schema_drift`, not a retryable outage** — a moved portal (HTTP 307) was misclassified as retryable `upstream_unavailable`; it is now a non-retryable drift with a "re-discover the slug" message. (#256)
- **`usaspending` recompete amount — `null` for an absent award amount (P3)** — an absent amount no longer reads as a fabricated `$0`. (#249)
- **`fdic_*` — empty-page pagination guard (defense-in-depth)** — all 7 FDIC tools now terminate on an empty page (`returned > 0`). (#263)
- **`bls_timeseries` — `totalAvailable` is `null` for a batch-series request** — it was the requested-series count, which counted a nonexistent/stubbed seriesId; a batch request has no upstream total. (#265)

## [1.11.0] — 2026-07-20 (adversarial-dogfood honesty hardening: 14 fixes across lda/gao/nhtsa/gsa-perdiem/nist/cbp/grants/exclusions/ofac/ZodEffects/sam-offset/bonfire + Socrata county sweep 34→53)

This release is a large **adversarial-dogfooding honesty pass**: parallel Claude sub-agents audited the tool surface against LIVE upstreams, and every confirmed defect was fixed under the SDLC (live-reproduced → non-vacuous fault fixture → PR → CI 6-gate → snapshot MATCH). Fourteen honesty fixes plus the tail of the SLED Socrata county sweep (34 → 53 curated hosts). No new tools (150). Fault assertions 3247 → 3393.

### Fixed

- **`lda_search_filings` — the `agency` filter no longer returns the full corpus mislabeled as agency-scoped (dogfood)** — `agency` mapped to the LDA `government_entity` query param, but the keyless `/filings/` endpoint has NO server-side government-entity filter and silently ignores it (live-verified: `government_entity=131` left the count at 95,289 — identical to unfiltered — while `registrant_name=Google` narrowed to 4). The tool sent the ignored param and pushed `"agency"` to `filtersApplied`, so a "who lobbied agency X" query returned the entire ~1.95M-filing corpus with an overstated `totalAvailable` and a false `filtersApplied`. Now `agency` is never sent upstream and is disclosed in `_meta.filtersDropped` with a note pointing to the nested `lobbyingActivities[].governmentEntities` workaround; tool + field descriptions corrected. +3 fault assertions.
- **`gao` bid-protest lookup — outage-as-empty guard + undetermined-outcome disclosure (dogfood)** — (D1) the RSS feed path parsed whatever it fetched with no shape check; GAO's Cloudflare/WAF edge returns a 200 HTML interstitial and the `<item>` regex yields `[]` on any non-RSS body, so an outage was silently reported as "no recent bid protests." A 200 body with no `<rss>`/`<channel>`/`<item>` markup now throws a retryable `upstream_unavailable` (a genuinely empty feed still carries `<channel>`, so a 0-item feed stays honest-empty). (D2) with an `outcome` filter + enrichment, decisions whose per-decision page failed to enrich (`outcome=null` — common, GAO product pages are intermittently WAF-blocked) were silently dropped by the equality filter, so `returned:0` read as "no `<outcome>` protests exist"; the undetermined count is now disclosed in a note ("could not determine," NOT "none exist"). +3 fault assertions.
- **`nhtsa_recalls`/`nhtsa_complaints` — NHTSA's HTTP-400-for-empty idiom now returns an honest empty (dogfood)** — NHTSA returns **HTTP 400** (not 200) with body `{Count:0, Message:"Results returned successfully", results:[]}` for a VALID make/model/year that simply has ZERO records (live-verified: Tesla Model 3 2015 → HTTP 400, Count 0). The shared `getJson` threw `invalid_input` on the 400 and discarded the body, so the single most valuable clean answer — "this vehicle has zero recalls" — was impossible; the caller got a phantom "Bad request." A bespoke fetch (mirroring the openFDA 404-crux) now reads the body and reclassifies the empty idiom to an honest empty (`returned:0, totalAvailable:0, complete:true`); every other non-2xx keeps the standard taxonomy. The false "200 + Count 0" P2 docstrings are corrected. Fault §57 recalls + complaints empty tests now assert the real 400 idiom.
- **`gsa_perdiem_rates` — the default year now tracks the current federal fiscal year (dogfood)** — `DEFAULT_PERDIEM_YEAR` was hard-coded `"2025"` (commented "the current confirmed vintage"), but today is inside FY2026 (began Oct 1 2025); a no-year lookup silently served the expired prior FY's reimbursement ceilings. Replaced with a pure `federalFiscalYear(date)` (Oct-1 rollover, UTC-deterministic) + `defaultPerdiemYear()` computed at call time; a defaulted lookup now discloses in a note that the year is the current federal FY (Oct 1–Sep 30). +3 fault assertions (rollover boundaries + default-rides-current-FY + disclosure).
- **`nist_800_53_controls` — OSCAL version/freshness disclosed + withdrawn controls surfaced (dogfood)** — the tool served control text off the mutable `usnistgov/oscal-content` `main` branch but disclosed only "Rev 5," never the point release; the catalog `metadata` (version `5.2.0`, last-modified `2026-05-11`) is now read and surfaced in `source` + a note. Separately, 24 of 324 controls are *withdrawn* (e.g. AC-13) and carry no statement, so `mapControl` emitted `statement:""` — presenting a withdrawn control as active with a blank requirement and dropping its status + links; a control now surfaces `status` (`"withdrawn"`|null), `statement` is `null` (never `""`) when absent, and `incorporatedInto` lists the control(s) that superseded it (AC-13 → [AC-2, AU-6]). +4 fault assertions.
- **`cbp_border_wait_times` — client-side filter disclosure + empty-filter gate + freight-scope correction (dogfood)** — `border`/`portName` are applied client-side over the full fetched port set, but the response never said so (inconsistent with QCEW's disclosure); a note now discloses it. An empty-string filter value (Zod-shadowed on the tool path, reachable on a direct handler call) was reported in `filtersApplied` while narrowing nothing — now reported in `filtersDropped`. And the docs claimed "commercial-vehicle (and passenger)" while the tool surfaces ONLY the commercial-vehicle (freight) lanes — corrected to the freight-only scope. +2 fault assertions.
- **`grants_search` — corrected a stale, back-to-front agency/CFDA disclosure note (dogfood)** — the note claimed Grants.gov "silently ignores an unknown agency code or CFDA number (returns the UNFILTERED result set)… if the count looks too broad, verify." Live-verified, the opposite is true: the agency/CFDA filter **is** applied server-side, so a bogus value returns **0 results** (e.g. `agency:"ZZZ-FAKE-000"` → 0 vs 1,364 unfiltered), and `filtersApplied` reflects it. The note pointed the remedy the wrong way (warned about "too broad" when the real failure mode is an unexpectedly EMPTY filtered search). Rewritten to describe the actual behavior. No output value was ever wrong (a documentation-honesty fix caught by an adversarial dogfooding pass); +1 fault assertion pinning the corrected guidance.
- **`sam_check_exclusions` — `_meta.totalAvailable` no longer overstates match availability (dogfood)** — the field was set to SAM's raw free-text hit count (`page.totalElements`), which counts every record merely *sharing a word* with the query, not the name-gated matches the tool reports. For a firm with **zero** real matches it read as "0 of 252 matches, incomplete." It is now `null` whenever the result is name-gated (the normal case — the true count of name-matching exclusions is genuinely unknown from one page of text hits; the per-page count stays in `data.matchCount`), and a genuinely-empty free-text result (0 hits) now finalizes to `truncated:false` / `complete:true` instead of asserting incompleteness over an empty set. The safety invariant is unchanged (empty ≠ clear; positive matches still surface). +2 fault assertions.
- **`ofac_screen_entity` — substring "strong" match now requires a substantial fragment (dogfood)** — `classifyMatch`'s substring-containment tier graded a match "strong" for *any* containment with no minimum length, while the token "weak" tier already required ≥3 chars (inverted strictness). Tiny sub-word fragments (`"TS"`⊂`"WIDGETS"`, `"IBB"`⊂`"QUIBBLEFARB"`) scored "strong", flooding nearly every input with false strong matches (alert fatigue). The mid-word tier now requires the contained string to be ≥5 chars; whole-token containment (the legitimate "name is contained" case) is unchanged, and the safety net (`no_name_match` reachable, empty ≠ clear) is intact. +2 fault assertions.
- **`tools/list` — 7 tools published a degenerate `{"type":"string"}` inputSchema (ZodEffects serialization gap)** — the internal `zodToJsonSchema` serializer (used by the `tools/list` handler) had no `ZodEffects` branch, so every input schema wrapped in `.refine()` (a cross-field rule like "npi OR state required") fell through to the `{type:"string"}` default. Seven tools — `fac_get_findings`, `cms_medicare_provider_services`, `cms_hospital_compare`, `cms_dmepos_suppliers`, `fpds_search_awards`, `census_geographies_by_coordinates`, `epa_tri_facilities` — published a **property-less string schema** that a schema-driven MCP client cannot construct a valid call against (even though the runtime Zod still demanded the full object). Surfaced by an adversarial dogfooding pass. The serializer now unwraps `ZodEffects._def.schema`, so all seven publish their real `properties`/`required`/enums (snapshot updated for exactly those 7). +2 fault assertions: **every** one of the 150 published tool schemas must serialize to `type:"object"` with `properties` (a structural guard against any future degenerate schema), plus a spot-check that a `.refine()`-wrapped tool keeps its real properties. `zodToJsonSchema` is now exported for that guard.

- **`sam_search_opportunities` — keyless `offset` now actually pages (was a silent no-op)** — the keyless HAL search path hardcoded `page=0` and ignored the caller's row `offset`, yet echoed the requested offset back as if honored. Paging a result set (`offset` 0 → 5 → 10 …) returned the **same first page every time** while `_meta.filtersDropped` signalled nothing wrong — a silent-wrong-answer surfaced by an adversarial dogfooding pass. The HAL endpoint *does* page (live-verified: `page=0` and `page=1` return disjoint sets), so `offset` now maps onto the page grid (`page = floor(offset/size)`) and the result reports the **served, page-aligned** offset. A non-page-aligned offset snaps down to its page boundary and the snap is **disclosed in `_meta.notes`** (an aligned offset — the default `offset += limit` pattern — is served exactly). The authenticated path already honored arbitrary offsets. +4 fault assertions (URL page/size mapping, served-offset echo, snap + disclosure).

- **`bonfire_search_opportunities` — `<item>` attribute tolerance (dogfood hardening)** — the RSS item extractor matched only a bare `<item>` opening tag, inconsistent with the `<channel[\s>]` schema-drift guard and the inner tag matcher (both attribute-tolerant). A namespaced/extended Bonfire feed emitting `<item …attrs>` would have had those items **silently dropped**, undercounting `totalAvailable` (a latent P1 risk surfaced by an adversarial dogfooding pass; not reproducible on any live feed today, since RSS 2.0 `<item>` has no standard attributes). The extractor now tolerates attributes on the opening tag (`<item(?:\s[^>]*)?>`). +1 fault assertion (an `<item xmlns:ext ext:flag="1">` item is still parsed ⇒ totalAvailable:1, not 0).

### Changed

- **package.json + localized READMEs currency refresh** — the npm `description` still said "144 tools" and listed only federal sources; refreshed to **150 tools** with the SLED sources (OpenGov/Bonfire/ArcGIS/Socrata) and added discovery keywords (`sled`, `state-local`, `procurement`, `opengov`, `bonfire`, `arcgis`, `socrata`, `bid-opportunities`). The Japanese (`README.ja.md`) and Korean (`README.ko.md`) READMEs were likewise stale at 144/48 — refreshed to 150/52 (48-of-52 keyless), hash-safe. Docs/metadata-only.
- **README currency refresh (v1.10.0 surface)** — the public README still advertised "144 tools across 48 sources" throughout and did not mention the SLED bid campaign. Refreshed every count to the actual **150 / 52** (keyless-first: 48 of 52 need no key), added a **State/local procurement bids (SLED)** capability row + a dedicated tool-catalog section for the six new tools (`opengov_list_governments`/`opengov_search_solicitations`, `bonfire_list_organizations`/`bonfire_search_opportunities`, `arcgis_hub_discover_datasets`, `arcgis_feature_query`), noted `socrata_query`'s expansion to 53 curated hosts, and widened the headline to "federal **and state/local (SLED)**." Zero hallucinated tool names (every backticked tool reference verified against the live registry; the only non-registry backtick tokens are the `schema_drift`/`upstream_unavailable`/`rate_limited` error kinds). Docs-only.
- **SKILL.md currency refresh (v1.10.0 surface)** — the bundled agent skill was stale at "144 tools / 48 sources"; refreshed to the actual **150 / 52**, added a dedicated **SLED bid-platforms** section for the six new tools (`opengov_list_governments`/`opengov_search_solicitations`, `bonfire_list_organizations`/`bonfire_search_opportunities`, `arcgis_hub_discover_datasets`, `arcgis_feature_query`), and rewrote the SLED-local-procurement routing note to cover the **53-host Socrata allowlist** (state + major-city + county/city sweep) plus the OpenGov/Bonfire live-solicitation feeds and the ArcGIS-REST feature layers. Zero hallucinated tool names (every backticked tool reference verified against the live 150-tool registry; the 4 non-registry tokens are error-kinds / feedback categories / an `integrityFlag` field value, not tool claims). Docs-only — improves agent tool selection for the SLED bid surface.

### Added

- **Socrata — county/city procurement sweep, wave 4 (tail)** — two more US local-gov Socrata hosts (51 → 53), the clean wins from the diminishing tail of the sweep: **Mesa AZ** secondary hub (`citydata.mesaaz.gov`, attribution "Office of Management and Budget" — City Expenditures ~15.4M) and **City of West Hollywood CA** (`data.weho.org` — Active Contracts with contractor_name/status/type, live/current ~1,030). West Hollywood's `.org` official portal joins the documented non-`.gov` exception. The rest of this wave's catalog hits were Canada/Australia, demo/test, duplicate-county, or off-theme (and `data.miamigov.com` was egress-unreachable from CI — deferred, not added), signalling the federated-catalog procurement vein is largely mined.
- **Socrata — county/city procurement sweep, wave 3** — nine more US local/state-gov Socrata portals (34 → 51 hosts across waves 2–3), from expanded federated-catalog queries (rfp/rfq/disbursement/expenditure/commodity) + offset paging, each provenance-confirmed (via `/api/views` attribution or the government domain itself) and host-scoped `count(*)`-verified: **USAC E-Rate** (`datahub.usac.org` — E-Rate Open Competitive Bidding / FCC Form 470, schools' & libraries' **live open bids** ~2.2M), **Janesville WI** (`performance.ci.janesville.wi.us` — Open Expenditures ~1.0M), **Austin TX** secondary hub (`datahub.austintexas.gov` — PO quantity/price detail ~318k), **Macoupin County IL** (`data.macoupincountyil.gov` — Open Expenditures ~156k), **Oakland CA** (`data.oaklandca.gov` — budget expenditures ~66k), **Prince George's County MD** (`data.princegeorgescountymd.gov` — spending payee/agency/amount ~62k), **Commonwealth of Massachusetts / Comptroller CTHRU** (`cthru.data.socrata.com` — statewide spending ~48k), **College Station TX** (`data.cstx.gov` — Open Budget Expenditures ~42k), **US DOT** secondary hub (`datahub.transportation.gov` — Highway disbursements by state SF-2 ~15k). The three non-`.gov` official portals (USAC `.org`, Janesville `.us` municipal, MA-Comptroller CTHRU Socrata-hosted) join the documented `42a+` non-`.gov` allowlist exception. Hosts with only an individual-name attribution on a generic `*.data.socrata.com` subdomain (Washoe, Newcastle) were deferred; Canada/AU + demo/test hosts filtered out.
- **Socrata — county/city procurement sweep, wave 2** — eight more US local-government Socrata portals with large real checkbook / purchase-order / vendor-payment datasets, from the same federated-catalog mining + host-scoped `count(*)` + `/resource/<4x4>.json` 200 bare-array verification: **Pittsburgh PA** (`fiscalfocus.pittsburghpa.gov` — Checkbook ~1.01M), **City of Atlanta GA** (`atlanta.data.socrata.com` — Open Checkbook Ledger ~1.78M), **Framingham MA** (`data.framinghamma.gov` — Checkbook ~324k), **Providence RI** (`data.providenceri.gov` — City & School purchase orders ~228k), **Fulton County GA** (`data.fultoncountyga.gov` — vendor payments/disbursements ~217k), **Mesquite TX** (`opendata.cityofmesquite.com` — Check Register ~144k), **Howard County MD** (`opendata.howardcountymd.gov` — vendors paid $30k+ ~35k), **Colorado Springs CO** (`data.coloradosprings.gov` — Open Checkbook Vendors ~19k). Socrata allowlist 34 → 42 hosts. The two non-`.gov` official portals (Atlanta's Socrata-hosted instance + Mesquite `.com`) join the documented non-`.gov` allowlist exception. Off-theme 1–31-row "performance metric" hosts surfaced by the same sweep (Modesto, San Mateo County) were filtered out.

## [1.10.0] — 2026-07-20 (SLED bid campaign — 6 new keyless tools 144 → 150 + major SLED procurement expansion across Socrata/ArcGIS/OpenGov/Bonfire)

This release lands the bulk of the SLED (state/local/education) bid-coverage campaign from the exhaustive US state+local procurement-site research. Six new keyless tools (144 → 150) plus large keyless-source expansion, all live-verified before shipping. Highlights: **OpenGov Procurement** (525+ governments' live solicitations) and **Bonfire RSS** (per-org open-opportunity feeds) — the two highest-reach keyless SLED bid feeds; **`arcgis_feature_query`** growing to a 23-service curated allowlist of US local-gov + state-DOT (TX/AK/IA/OK) bid/award/checkbook layers; **`arcgis_hub_discover_datasets`** opening the ArcGIS Hub layer; and Socrata expanding to 34 curated hosts (major-city + federal + county/city procurement sweep). Honesty invariants (P1 total ≠ page length, empty-vs-outage, epoch-ms disclosure, `{error}`-body classification, curated-allowlist SSRF) hold across every new surface.

### Added

- **Socrata — county/city procurement sweep** — six more US local-government Socrata portals carrying procurement/bid/contract data, discovered by mining the Socrata federated catalog (`api.us.socrata.com`) for procurement datasets and then live-verifying each host ($select=count(*) + `/resource/<4x4>.json` 200 bare-array): **Kansas City MO** (`data.kcmo.org` — Vendor Payments ~144k, 22 procurement datasets), **Baton Rouge / East Baton Rouge Parish LA** (`data.brla.gov` — Upcoming Procurement Opportunities, 19 procurement datasets), **Dallas TX** (`www.dallasopendata.com` — Vendor Payments FY2019–present ~166k), **Los Angeles CA** (`data.lacity.org` — RAMP **live open bid opportunities**), **Ramsey County MN** (`data.ramseycountymn.gov` — Solicitations & Addenda with due dates/links), **Richmond VA** (`data.richmondgov.com` — City Contracts with contract_value/supplier/procurement_type). Reachable now via `socrata_query` / `socrata_discover_datasets`. The four non-`.gov` official municipal portals are added to the documented non-`.gov` allowlist exception (the SSRF core stays the frozen curated allowlist); the `.gov`-or-documented-exception fault assertion now covers them. Canada/Australia hosts, demo/test hosts, and off-theme aggregate hosts surfaced by the same sweep were filtered out.
- **`arcgis_feature_query`** (150th tool, keyless) — generic query over a curated allowlist of US-government **ArcGIS REST feature layers** (the query companion to `arcgis_hub_discover_datasets`, which discovers Hub datasets). A large amount of SLED procurement/GIS data lives on ArcGIS. First payload: the **DC Office of Contracting & Procurement "PASS"** layers — `dc_pass_solicitations` (DC's **live open solicitations**, ~25k, 46 fields incl. SOLICITATIONNUMBER/TITLE/DUE_DATE/NIGPCODE/CONTRACTINGOFFICER/AWARD_TO), `dc_pass_contracts` (~50k), `dc_pass_purchase_orders` (~275k), `dc_pass_payments` (~1.55M). Additional US local-gov procurement layers (found via `arcgis_hub_discover_datasets`, each on a reachable Esri-hosted `services*.arcgis.com` endpoint, live-verified — **23 curated services total**): Asheville NC (`asheville_purchase_orders` ~63k, `asheville_po_summary`), Bellevue WA (`bellevue_vendor_payments` ~16k, `bellevue_awarded_contracts`), Miami-Dade FL (`miamidade_purchase_orders_2025` current + `_2017` snapshot), Suffolk County NY (`suffolk_county_ny_contracts_2018`), Matanuska-Susitna Borough AK (`matsu_borough_ak_checkbook`), City of Las Vegas NV (`lasvegas_checkbook`), Baltimore City MD (`baltimore_checkbook`), City of Naperville IL (`naperville_vendor_payments`), City of Worcester MA (`worcester_ma_checkbook_fy25`), City of Las Vegas NV purchasing contracts (`lasvegas_purchasing_contracts`), Texas DOT projects with awarded construction company (`txdot_construction_projects`), Alaska DOT&PF construction bid awards + AASHTOWARE proposals (`akdot_construction_awards`, `akdot_aashtoware_proposals`), Iowa DOT public bid (`iowadot_public_bid_awards`), Oklahoma DOT CIRB contract status (`okdot_cirb_contract_status`), City of Topeka KS open checkbook FY2015–2023 (`topeka_checkbook_aggregate`). Inputs: `service` (allowlist **enum** — the SSRF core, never a free host), `where`/`outFields`/`orderByFields`/`limit`/`offset`. HONESTY: `totalAvailable` = the layer's exact match count (a `returnCountOnly` companion; a count failure ⇒ null + note, rows still returned; never the page length); ★ArcGIS date fields are epoch **milliseconds** and a negative sentinel (≈1900) is a placeholder — surfaced verbatim; ★an ArcGIS `{error}` body (HTTP 200) is classified — `"Failed to execute query."` ⇒ invalid_input, but the ambiguous `"Unable to complete operation."` ⇒ upstream_unavailable **retryable** (it is intermittently a transient blip on a valid query — never falsely blame the caller); non-array `features` ⇒ schema_drift; 429/5xx ⇒ throws. Fixed allowlist base + hostname assertion + `redirect:"error"` (where/outFields cannot alter the host). 14 new fault assertions. (SLED bid campaign — DC's keyless live-solicitation feed; the allowlist extends to other gov ArcGIS-REST layers.)
- **`bonfire_list_organizations` + `bonfire_search_opportunities`** (148th & 149th tools, keyless) — **Bonfire (Euna)** per-organization open-solicitation RSS. Thousands of US state/local governments on Bonfire expose a keyless RSS 2.0 feed of their currently-open opportunities at `{org}.bonfirehub.com/opportunities/rss`. `bonfire_list_organizations` serves a **curated, live-verified 186-org US seed directory** (filter `state`/`query`); feed a result's `org` to `bonfire_search_opportunities`, which returns that org's open opportunities (referenceNumber, name, description, `closeDate`, portal link, pubDate). ★HONESTY: the RSS is the **complete** open set (no server pagination) so `totalAvailable` = the exact open-opportunity count (never a page length); an empty feed ⇒ honest empty; Bonfire's authoritative org API is **auth-gated → out of bounds** (never used), so the directory is a partial seed (disclosed) extendable by the documented keyless RSS-probe method. Fixed-suffix SSRF (`.bonfirehub.com`) + org charclass guard + `redirect:"error"`; 429/5xx ⇒ throws; 200 non-RSS ⇒ schema_drift. 18 new fault assertions. (With OpenGov Procurement, one of the two highest-reach keyless SLED bid feeds.)
- **`opengov_list_governments` + `opengov_search_solicitations`** (146th & 147th tools, keyless) — **OpenGov Procurement** live SLED solicitations. OpenGov Procurement (formerly ProcureNow) hosts the open-bid portals of **525+ US state/local governments** (cities, counties, school & special districts, 42 states + DC). `opengov_list_governments` returns the whole directory in one keyless GET (filter by `state`/`query`); feed a result's `code` to `opengov_search_solicitations`, which lists that government's public solicitations (id, title, solicitation #, **status**, department, `proposalDeadline`, portal link). ★Genuinely keyless: consumes ONLY the anonymous endpoints the public portal itself calls (the official key-gated `api-key` API is **not** used) — live-verified anonymous. HONESTY: `status` verbatim (**open = accepting**; pending/evaluation/closed also returned — filter client-side); `totalAvailable` = the exact filtered portal count / the org's total public-project `count` (never the page length); fixed-host SSRF + slug charclass guard + `redirect:"error"`; 429/5xx ⇒ throws; non-array ⇒ schema_drift. 20 new fault assertions. (From the exhaustive US state+local bid-site research — one of the two highest-reach keyless SLED feeds, with Bonfire RSS.)
- **Socrata — SLED procurement bid-catalog hosts** — three `.gov` Socrata portals carrying **live bid-cycle** data (not just award/spend) added to the curated allowlist, from an exhaustive US state+local bid-site research pass: **Cook County IL** (`datacatalog.cookcountyil.gov` — Bid Tabulations `32au-zaqn` ~5,607 + awards/intent-to-award, 17 procurement datasets), **Illinois** (`data.illinois.gov` — Future Solicitations `6rb8-ntpm`, anticipated construction bids), **Cincinnati OH** (`data.cincinnati-oh.gov` — certified MBE/WBE vendors + contracts). Each live-verified (`/resource/<4x4>.json` → 200 bare array + honest `count(*)` total). Reachable now via `socrata_query` / `socrata_discover_datasets`. Honesty note: four other candidate hosts (`data.iowa.gov`, `data.scottsdaleaz.gov`, `data.gilbertaz.gov`, `opendata.hawaii.gov`) were **rejected** — live probing showed their endpoints 404 (Next.js/Express apps, not Socrata), so they were not added. 2 new fault assertions.
- **`arcgis_hub_discover_datasets`** (145th tool, keyless) — discover ArcGIS Hub datasets by keyword (`hub.arcgis.com/api/v3/datasets`). A large fraction of US state/local/regional/tribal (SLED) open data — GIS, infrastructure, permits, zoning, boundaries, procurement — is published on **ArcGIS Hub**, which Socrata and CKAN do not cover; this opens that layer for discovery. Inputs: `query` (≥2 chars), `openDataOnly` (default true → the designated-open-data subset), `limit`/`offset`. Returns curated rows (id, name, description, owner, orgName, source, region, type, keywords, downloadable, hasApi, landingPage, …) + honest `_meta`: `totalAvailable` = the exact Hub match count (`meta.total`, never page length). **★Provenance (a deliberately different trust posture):** ArcGIS Hub is a *global, open* publishing platform — results include non-US and non-governmental publishers — so this is a DISCOVERY aid, **not** a curated official-source allowlist (unlike `socrata_query`). Each row surfaces the publisher (owner/orgName/source/region) verbatim for vetting, and the global-platform caveat rides every response. Discovery only (metadata + links); a guarded row-query tool (ArcGIS feature services live on arbitrary hosts) is a planned separate addition. Fixed-host SSRF + `redirect:"error"`; 23 new fault assertions.
- **Socrata — federal open-data portal tier** — the first **federal** Socrata hosts added to the curated allowlist (prior tiers were state + local only), all `.gov`: **US DOT** (`data.transportation.gov` — e.g. the Company Census File, ~4.47M motor carriers; 1,873 datasets host-scoped), **US CDC** (`data.cdc.gov` — ~1,100 public-health datasets), **US BTS** (`data.bts.gov` — e.g. Border Crossing Entry Data, ~275k rows). Each host-scoped-catalog + `/resource/<4x4>.json` 200 bare-array + `count(*)` companion live-verified; `socrata_query` returns honest `totalAvailable` (the real full count, not page length). 2 new fault assertions (federal-tier membership + SSRF lookalike rejection). **Documented caveat:** the *federated* discovery catalog (`api.us.socrata.com`) under-indexes these hosts (e.g. DOT: 3 federated vs 1,873 host-scoped), so `socrata_discover_datasets` under-reports federal datasets (an honest partial from the upstream index) — `socrata_query` works normally with a known 4×4.
- **Socrata SLED — major-city portals** — the 4 largest municipal procurement markets added to the curated Socrata allowlist: **NYC OpenData** (`data.cityofnewyork.us` — City Record procurement notices, ~1.1M rows), **Chicago** (`data.cityofchicago.org` — contracts, ~186k), **DataSF** (`data.sfgov.org` — supplier contracts, ~48k), **LA City Controller** (`controllerdata.lacity.org` — checkbook, ~6.4M). Each host-scoped-catalog + `/resource/<4x4>.json` 200-verified. These are the first documented non-`.gov` municipal portals (the official city open-data sites); the SSRF core stays the frozen curated allowlist (not the TLD), and the fault suite now asserts the `.gov`-or-documented-exception policy.

### Changed

- **SKILL.md currency refresh** — the bundled agent skill was stale (advertised "120 tools / 37 sources"); refreshed to the actual **144 / 48**, added the missing capability lanes (product-safety openFDA/NHTSA/CPSC, litigation CourtListener, nonprofit IRS-990, NIST 800-53 controls, NWS/CBP/get.gov, SLED local Socrata, `feedback`), and fixed the eCFR full-text routing (`ecfr_search` snippets → `far_clause_lookup` / `ecfr_get_section`). Zero hallucinated tool names (all 138 verified against the live registry). Improves agent tool selection — the gap that surfaced in the agent-eval.

### Fixed

- **`socrata_discover_datasets` — federated under-index resolved for domain-scoped discovery** — a search with a specific `domain` now queries that portal's OWN catalog (`https://{domain}/api/catalog/v1?search_context=…`) instead of the federated `api.us.socrata.com` aggregator, which under-indexes many hosts. Live impact: **USAC `0 → 21`** (the federated index returned zero for USAC entirely), **DOT `q=safety` → 102**, **DOT `q=contract` `0 → 5`** — datasets the federated index hid are now discoverable. The all-host search (no `domain`, the only cross-host mode) still uses the federated aggregator and now **discloses the under-index in `_meta.notes`**; `_meta.source` names the actual catalog used (host vs federated). SSRF unchanged: the host-catalog fetch reuses the same allowlist + `hostname===domain` + `redirect:"error"` guard as row queries. No tool/schema change (still **144**); 4 new fault assertions (host-scoped vs federated routing).

## [1.9.0] — 2026-07-18 (SLED Socrata city/county expansion + eCFR full-section tool — keyless, 143 → 144 tools)

Additive minor release (autonomous improvement loop, cycles 1 + 3). Extends SLED coverage down to the local tier and adds full CFR section text for any title.

### Added

- **Socrata SLED expansion (city/county tier)** — 5 live-verified `.gov` municipal open-data hosts added to the curated Socrata allowlist: **Austin TX, King County WA, Montgomery County MD, Mesa AZ, Cambridge MA**. Each carries keyless B2G procurement/vendor/contract data (e.g. Austin purchase orders ~318k rows; King County procurement contracts ~4.8k), reachable via `socrata_query` / `socrata_discover_datasets`. Extends SLED coverage from state portals down to the fragmented local (city/county) tier — the layer most B2G buyers must track. Host-scoped catalog + `/resource/<4x4>.json` 200 bare-array verified per host; SSRF allowlist (single source of truth) + all-`.gov` principle preserved; 3 new fault assertions.
- **`ecfr_get_section`** (144th tool, keyless) — the FULL in-force text of any CFR section by citation, the companion to `ecfr_search` (which returns only ranked snippets). Fills an agent-eval gap (an agent couldn't retrieve a clause's complete text). For FAR/DFARS (title 48) it defers to `far_clause_lookup` (richer — adds prescription/revision); it is the full-text path for the **other 49 titles** (grants title 2, labor 29, IRS 26, …). `ecfr_search` now discloses both full-text routes. HONESTY: text is the eCFR's own (de-XMLed, no fabrication); a nonexistent section ⇒ `not_found`; a bad citation ⇒ `invalid_input` (SSRF charclass, incl. the JS `$` trailing-newline trap); the resolved issue date is disclosed. 6 new fault assertions.

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
