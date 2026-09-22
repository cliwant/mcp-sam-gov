# Changelog

All notable changes to `@cliwant/mcp-sam-gov` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.16.0] - 2026-09-22

### Added

- **Drift canary (`drift-canary.mjs`)**: weekly live-endpoint health check covering all ~285 allowlisted hosts (Socrata 55, CKAN 4, Open Checkbook 2, ArcGIS 29, Bonfire 195) plus row-count drift verification for all 26 `DATA_MAP_ENTRIES`. Classifies each probe as `ok | redirect | not-found | blocked | server-error | timeout | dns` and row-count drift as `ok | collapse (< 50%) | growth (> 200%) | unmeasurable`. Exits non-zero on regressions (`redirect`, `not-found`, `dns`, `collapse`); transient issues (`blocked`, `timeout`, `server-error`) warn without failing. Baseline run (2026-09-21) confirmed `data.sfgov.org` 301-redirect and 9 drifted Bonfire org slugs.
- **`.github/workflows/drift-canary.yml`**: weekly schedule (Monday 03:00 UTC) + `workflow_dispatch`. Report-only — no issues, no comments, no push. Uploads JSON/Markdown artifact; writes Markdown to job summary.
- **Fault-injection tests for canary classification logic** (`fault-injection-test.mjs` §drift-canary): offline deterministic assertions for `classifyStatus()`, `isWafChallengePage()`, `classifyRowDrift()`, and `THRESHOLDS` config. 3763/3763 pass (baseline was 3738, +25 assertions).

- **Alaska Open Checkbook (`portal=ak`) — `open_checkbook_search`**: `checkbook.alaska.gov` (official `.gov` CNAME to `alaska-state.spending.socrata.com`) added to `OPEN_CHECKBOOK_PORTALS`. Verified 2026-09-21: 41,751 rows / $1,179,091,896.12 for FY2026. ★ **FY coverage caveat**: ONLY FY2026 is published; FY2019–FY2025 and no-year all return count:0/empty — this means "not published by this portal", NOT "Alaska spent nothing". Caveat is encoded in the portal `note` (surfaced in every tool response), the server.ts parameter description, the data-map entry `notNote`, and SKILL.md. The tool's existing honesty envelope already exposes `count:0` with the portal note text; a caller reading the note sees the "not published" interpretation. PR also proposes the smallest honest fix for the genuine-empty ambiguity: the portal note text now explicitly states the interpretation, preventing agent misreads.
- **Socrata allowlist: `sharefulton.fultoncountyga.gov`** — Fulton County GA second official portal. Dataset `kp4p-scak` "Vendor Payments", 226,797 rows (exact), updated 2026-09-14, attribution "Fulton County Government (GA)", spanning 2014-01-01 to present. Note: `data.fultoncountyga.gov` is a DIFFERENT host that was already allowlisted; both are now present.
- **Data map: Alaska and Fulton County GA (sharefulton) entries** — `src/data-map.ts` + SKILL.md table updated with both.
- **Measured absence: New Orleans LA** — `data.nola.gov` exists but has NO procurement dataset. Full 9-term scan 2026-09-21 found only a 626-row DBE directory last updated 2019-11-11; large datasets are permits/traffic citations. Recorded in the rendered resource text.

- **CKAN: California `data.ca.gov` — 2 new data-map entries** (host already allowlisted). DGS Purchase Order Data 2012–2015 (`bb82edc5`, 344,504 rows exact) + DGS-Approved Non-Competitive Bids (`14932789`, 480 rows exact). NOT: FY2012–2015 only; live Cal eProcure portal remains WAF-403; non-competitive bids are sole-source award register, not open solicitations.
- **CKAN: Oklahoma `data.ok.gov` — lifts documented SOURCE_BACKLOG deferral**. Deferral bar (2nd procurement-relevant >1k-row resource) met: Vendor Payments FY2019 Q1 (`cc443616`, 286,185 rows exact). FY2011/FY2017/FY2018/FY2019 each have 4 quarterly resources; one fiscal year = 4 calls. NOT: vendor PAYMENTS, not bids or awards. Host comment updated in `src/ckan.ts`; host added to CKAN_HOSTS; data-map entry added to `src/data-map.ts`.
- **Hawaii `opendata.hawaii.gov` — measured and NOT added**. Best procurement resource found: "Projects Awarded 2003–2020" (`a5d67ba9`, 848 rows, `total_was_estimated:false`); OIMT Spending FY13-FY14 (`4a786681`, 119 rows). Neither clears the >1k-row admission bar; host is not added to CKAN_HOSTS.

### Changed

- **`gao_protest_lookup` and `fpds_search_awards` now send the project's honest User-Agent** (`Mozilla/5.0 (compatible; @cliwant/mcp-sam-gov; +https://github.com/cliwant/mcp-sam-gov)`) instead of a fake Chrome browser string. Live-verified 2026-09-22: GAO's RSS feed returns 200 to the honest UA; FPDS returns 200 to the honest UA. The previously-used Chrome UA did not help — GAO per-decision pages 403 regardless of UA. Pretending to be a browser gains nothing and is contrary to the project's honesty policy.

- **The four solicitation directory/search tools (`opengov_*`, `bonfire_*`) now point to the state-level bid feeds that live on open-data portals** — TX TxDOT lettings (advertised, taking bids) and IL CDB capital bids (anticipated, not yet posted). Asked for "Illinois state solicitations", agents searched OpenGov then Bonfire, found no state-level Illinois portal in either, and never reached the Illinois dataset.

### Fixed

- **`socrata_query` now guides agents to use aggregates instead of summing pages.** When the result is a truncated page of raw rows (`hasMore:true`) and no aggregate `select` was used, the response appends a note: "This is a PAGE of raw rows — do NOT sum this page. For a grand total: re-query with `select='sum(<amount column>)'`; for top-N: `select='vendor_name, sum(amount) as total'` with `order='total DESC'`." The tool description and `select` parameter description now give concrete examples for totals and group-by rankings. This fixes two eval failures (MA CTHRU Deloitte payments — agent gave raw rows and told user to sum; TX DIR IT spending — agent guessed a 3x-spread estimate instead of issuing an aggregate). CKAN `datastore_search_sql` is NOT wired; `ckan_query` is unchanged.

- **`gsa_perdiem_rates` now labels each rate with an explicit `fiscalYear` field and states the Oct–Sep convention in every response.** Previously the rate only carried `year` (the raw GSA API year number, which is the FY number) with no label distinguishing it from a calendar year. Each rate now includes `fiscalYear` alongside `year` (same numeric value; surfaced separately so callers never confuse it with a calendar year). A permanent `_meta.notes` entry explains: "October 2026 belongs to FY2027; pass year='2027' for October 2026 rates." The `year` parameter description now gives the Oct 2026 = FY2027 example explicitly. Live verification was blocked by DEMO_KEY rate-limit (exhausted during testing); unit tests confirm the fix.
- **`gao_protest_lookup` now gives a precise next step when a protester/agency/solicitationNumber filter is given and the term is not in the current ~25-decision window.** Previously, the tool returned a bare "not in window" message that agents scored poorly against plain web search. The tool now adds a note with GAO's own search pre-filtered to bid-protest decisions with the search term URL-encoded: `https://www.gao.gov/search?f%5B0%5D=ctype_search%3ABid%20Protest%20Decision&keyword=<term>`. The `accessNote` was also corrected: historical search is unavailable as keyless *programmatic* access, but a human can search it at that URL (it is not "only via a paid third-party API").

- **`sam_search_wage_determinations` now returns the correct Davis-Bacon WD for a county+constructionType lookup.** Previously, county filtering was applied only over the first fetched page (max 50 records), so Illinois's IL20260009 (the Cook County Building WD) was silently skipped because it lives on page 1 of IL's 70 active DBA WDs. The tool now scans ALL pages for the state (cap: 10 pages / 500 WDs) when a `county` or `constructionType` filter is given. A new `constructionType` parameter (Building | Residential | Heavy | Highway) enables precise DBA lookup: pass `state` + `county` + `constructionType` to get the right WD on the first call. Single-county WDs are ranked before multi-county WDs (a single-county WD is almost always the most specific match). `totalAvailable` and the scan note now report real numbers after the full scan instead of `null` with a "may miss" warning. (`IL20260009`, Cook County Building, correctly returned first with base $57.75 / fringe $42.89 electrician rate confirmed live.)

- **`socrata_discover_datasets` no longer presents a likely-false zero as proof of absence.** The catalog behaves as if every `q` term must match, and datasets rarely repeat their jurisdiction's name — so on `data.illinois.gov`, `q="Illinois state solicitations"` and `q="Illinois procurement"` returned 0 while `q="solicitations"` returned the dataset. An eval agent took that zero at face value and told the user no Illinois procurement datasets exist. An empty result now carries a note saying it is likely a false zero and how to retry (place in `domain`, one topical term, synonyms), and the `q` parameter says to put the jurisdiction in `domain`, never in `q`.
- **Illinois CDB `6rb8-ntpm` is no longer described as just "upcoming".** The publisher describes these as solicitations "anticipated for a future date, but have not been posted yet"; the data-map caveat now says they are NOT currently open bids. Two eval answers had called them "currently out to bid".
- **Bonfire seed: 8 dead feeds removed, `saha` → `homesa` slug rename** (195 → 187). Drift canary 2026-09-21 found 9 slugs no longer serving RSS. `saha` (Opportunity Home San Antonio / formerly SAHA) 301-redirects to `homesa.bonfirehub.com/opportunities/rss` — valid feed confirmed, renamed in seed. Eight slugs (`thecha` Chicago Housing Authority IL, `sourcewell` Sourcewell MN, `rutgers` Rutgers University NJ, `apsu` Austin Peay State University TN, `sanantonio` City of San Antonio TX, `allenisd` Allen ISD TX, `kingcounty` King County WA, `cvtc` Chippewa Valley Technical College WI) return 307 → site root; no working replacement feed found for any of them. The redirect-error path was already `retryable: false` (`schema_drift`); this change removes the stale entries so `bonfire_list_organizations` no longer advertises orgs whose feeds are gone.

## [1.15.0] - 2026-09-21

### Added

- **State & local data map: 4 new jurisdictions verified 2026-09-21** — Maryland (`opendata.maryland.gov`), Oregon (`data.oregon.gov`), Vermont (`data.vermont.gov`), and City of Denver (on Colorado state portal `data.colorado.gov`). All hosts were already in the Socrata allowlist; this is a discoverability/documentation addition. Key honesty caveats: MD eMMA rows are bid LINE ITEMS (FY2018 is 107,303 rows for 3,067 bids — 35× overcount; use `$select=count(distinct bid_number)`); eMMA coverage stops at FY2019 (Periscope migration). OR OregonBuys (`qyug-f2km`) and historical ORPIN datasets (`6e9e-sfc4`, `8izy-bwhd`, `gart-52me`) are purchase orders and contracts, not open solicitations. VT (`8ewu-igdm`) is issued purchase orders for the current fiscal year (live-ish). Denver (`66zf-qjdd` Procurement Transactions, `wnau-xrqi` Checkbook) is City of Denver spend hosted on the CO state portal — NOT Colorado state procurement; placed in the state table with jurisdiction="City of Denver" to prevent domain-as-jurisdiction misreads. Michigan (`data.michigan.gov`) added to measured-absence section: carries only NIGP commodity code reference tables, not procurement transactions. 14 new non-vacuous fault assertions (76-f anchors + 76-f2) cover dataset ids, MD 35× caveat, VT distinct po_id count, Denver "NOT Colorado STATE" caveat, and Michigan measured-absence text.

- **ArcGIS allowlist: 2 new county CIP pipeline services** (`hennepin_transportation_cip`, `charlotte_mecklenburg_cip`; 27 → 29 services). These are capital-project pipeline registries — **NOT solicitation or award registers** — and are disclosed as such in every note field. `hennepin_transportation_cip`: Hennepin County MN transportation CIP, ~257 rows (CP_Num, Roadway, Bid_Open, Fund_Source, CIP_Status), all fits in one page (maxRecordCount 2000), keyless. `charlotte_mecklenburg_cip`: Charlotte-Mecklenburg NC joint CIP, ~2,276 rows (Project_ID, Project_Name, Project_Phase, Department), page by resultRecordCount=1000 at offsets 0/1000/2000; Project_Manager/Email/Phone government-staff fields noted as excluded from agent output. Both live-verified 2026-09-21: returnCountOnly=true gives true totals; pagination walks to a natural end. No PII in either data layer (rows are road/infrastructure projects, not about individuals; staff contact fields in the Charlotte layer are noted as excluded).
- **Bonfire seed: 9 new orgs** (186 → 195). All re-verified 2026-09-21 (200 + valid `<rss><channel>`). Additions: `maricopa` = Maricopa County Community Colleges AZ (MCCCD; NOT Maricopa County government); `emwd` = Eastern Municipal Water District CA; `laccd` = Los Angeles Community College District CA; `d214` = Township High School District 214 IL; `kcmo` = Kansas City, MO MO; `dps` = Dayton Public Schools OH (NOT Denver Public Schools); `pcc` = Portland Community College OR (NOT Pima Community College AZ); `montcopa` = Montgomery County PA (DEPTH gap, rank 59, pop 856k); `chesterfield` = Chesterfield County VA. `calwater` (California Water Service) excluded — a private investor-owned utility (Cal Water Group / NYSE: CWT), out of scope for a government-buyer directory. Slug identity traps documented in source and seed note: pcc/dps/maricopa are not the entities their slugs might suggest.
- **MCP resource `samgov://data-map/state-local`** — the server now exposes an MCP `resources` capability with one resource: a jurisdiction → tool → dataset-id → row-count → NOT-caveat map for every verified state/local open-data source. Readable via `resources/list` (name + one-line description) and `resources/read` (full Markdown). The map is generated from a new `src/data-map.ts` single source of truth so the resource, SKILL.md, and README cannot drift apart. Non-Claude-Code clients (Claude Desktop, Cursor, API) can now read the map on demand — the gap that caused an agent to answer an Illinois coverage question from OpenGov instead of the known IL Socrata dataset. `socrata_query` and `ckan_query` tool descriptions gain a compact pointer to the biggest state mirrors (NY ehig-g5x3, NJ ubnu-tqu7, WA s8d5-pj78, MA cthru.data.socrata.com pegc-naaa, VA data.virginia.gov) and reference the resource URI so any client sees the hint immediately. Server `instructions` field now includes: "State/local dataset IDs (Socrata, CKAN, etc.) are listed in the MCP resource samgov://data-map/state-local." 29 new non-vacuous fault assertions (section 76) cover resources/list, resources/read, source-of-truth consistency vs SKILL.md, and description cap compliance; mutation of dist turns 4 of them RED.
- **Texas added to state & local data map** — `data.texas.gov` is already in the Socrata allowlist and carries substantial state procurement data. Five verified datasets: `qh8x-rm8r` (★TxDOT current lettings — the first live state solicitation feed in this map; 8,861 rows = 412 distinct projects in a rolling window, TxDOT only); `w64c-ndf7` (DIR Cooperative Contract Sales FY2010–FY2025 archive, 10.7M rows); `a743-wj72` (DIR Cooperative Sales FY2026, 2.1M rows); `vipt-h4ye` (DIR Current Active Cooperative Contracts, 5,167 rows); `svjm-sdfz` (TCEQ agency contracts, 2,067 rows). Agent row-count trap documented: 8,861 rows ≠ 8,861 open bids — use `$select=count(distinct project_id)` for the correct 412-project count.

### Changed

- **`socrata_query` / `socrata_discover_datasets`: the `domain` parameter now names the jurisdiction of every allowlisted host whose hostname does not reveal it** (`cthru.data.socrata.com` = Massachusetts statewide, `data.brla.gov` = Baton Rouge, `data.kcmo.org` = Kansas City, and so on), and warns that `data.colorado.gov`'s procurement datasets are City of Denver rather than Colorado state. Measured, not cosmetic: with the bare 54-value enum an agent answered "no statewide Massachusetts portal" while the ~49M-row MA dataset sat in that enum. Adding the legend flipped that eval task from FAIL to PASS and raised right-tool selection from 2/6 to 4/6.

- **State & local data map:** now generated from `src/data-map.ts` (single source of truth) and exposed as MCP resource `samgov://data-map/state-local` (see Added). SKILL.md `## State & local data map` table extended with 5 Texas datasets. "Not reachable" section split into three honest categories: login-gated/WAF-blocked portals; portal-live-but-no-procurement-data (PA); no-portal (FL data.fl.gov NXDOMAIN, GA data.georgia.gov NXDOMAIN — these are measured absences, not connectivity blocks). TX ESBD/TxSmartBuy updated to note that TxDOT lettings ARE available via `qh8x-rm8r`.

### Fixed

- **Socrata: San Francisco host migration** (`data.sfgov.org` — `data.sf.gov`). `data.sfgov.org` now 301-redirects every path to `data.sf.gov`; because `redirect:"error"` is set for SSRF hardening, the old host was completely unreachable. Fix: added `data.sf.gov` to the allowlist as the canonical SF domain, plus a migration-map pre-flight check. Requests to the old host now return `invalid_input` (non-retryable, `retryable: false`) naming the replacement domain, rather than `upstream_unavailable` (`retryable: true`) which was factually wrong (a permanent redirect cannot be resolved by retrying). The `$select=count(*)` companion is documented as load-bearing — Cloudflare-fronted Socrata hosts 403 `count(1)` as SQLi-like while `count(*)` passes (verified on `opendata.maryland.gov`).

## [1.14.0] — 2026-09-18 (opt-in toolset profiles; leaner tool descriptions; BLS OEWS series IDs)

Three improvements shipped together: an opt-in toolset-profile filter (MCP_SAM_GOV_TOOLSETS / .mcpb “Toolsets” setting) lets a govcon profile such as core,sled,vetting load 89 tools and roughly halve the tools/list context in clients that load every tool, while the default (unset) remains all 152 tools — byte-identical to 1.13.x. Description trimming reduced the all-tools compact-JSON character count from ~80,754 to ~74,460 tokens, and a CI lint now enforces the per-tool/param length limits so regressions are caught automatically. A bls_timeseries validation fix accepts 25-char OEWS series IDs (e.g. OEUN000000000000015125201) that were silently rejected before.

### Added
- **Toolset profiles (MCP_SAM_GOV_TOOLSETS).** A new src/toolsets.ts maps every registered tool to one of ten named toolsets (core, sled, vetting, disclosure, regulatory, pricing, health, safety, geo, cyber). Set MCP_SAM_GOV_TOOLSETS to a comma-separated list to load only a subset. Unset or all loads all 152 tools (byte-identical default). `feedback` and `api_key_status` are always loaded in every profile. Unknown names produce a stderr warning and are reported in the server instructions (visible in Claude Desktop where stderr is hidden); if no valid name survives, falls back to all tools and the instructions say so. When a tool in an unloaded toolset is called, CallTool returns a structured tool_not_loaded error (ok:false, kind "tool_not_loaded") naming the toolset and the exact env var to set; the suggested value is the union of the currently loaded sets and the needed set (e.g. MCP_SAM_GOV_TOOLSETS=core,vetting) so the existing profile is not silently dropped. The server instructions field, when a profile is active, lists loaded sets and other available sets with a 2-4 word hint each; the default (all tools) stays byte-identical. The envelope builder (toolNotLoadedEnvelope) and list filter (filterToolsFor) are exported pure functions from src/toolsets.ts so tests can import them from dist without spawning a server. Mapping moves: ofac_screen_entity moved to core (govcon users screen SAM exclusions + OFAC together); gsa_benchmark_labor_rates moved to core (proposal pricing); hts_lookup moved to pricing (tariff/duty data). Resulting set counts: core=60, sled=13, vetting=16, pricing=15, geo=8 (total unchanged: 152). lint-invariants.mjs check (3) now accepts single-quoted tool names and also parses src/toolsets.ts directly so a mapping removed in src is caught before a rebuild; MCP_SAM_GOV_TOOLSETS added to server.json environmentVariables. fault-injection-test.mjs gains non-vacuous toolset assertions: E2E test (75-j) spawns node dist/server.js with TOOLSETS=core and verifies tools/list count, list filtering, and tool_not_loaded on a tools/call of a non-core tool; mutations to filterToolsFor or toolNotLoadedEnvelope in dist/server.js turn these assertions red.

### Changed
- **Trim tool descriptions to cut tools/list token cost.** Rewrote 39 tool descriptions and 2 parameter descriptions to enforce <=1600-char tool description and <=650-char param description limits. Grand total compact-JSON chars reduced from 323,017 (~80,754 tokens) to 297,839 (~74,460 tokens). A reworked lint-invariants.mjs check (4) now reads actual exported strings from tools-list-snapshot.json (the MCP tools/list ground-truth) instead of regex over source, correctly catching multi-line .describe() calls that the previous regex missed; it enforces the limits in CI so regressions turn CI red.

### Fixed
- **bls_timeseries: widen seriesId regex from 20 to 25 chars.** OEWS series IDs are 25 chars (e.g. `OEUN000000000000015125201`) and were silently rejected by the prior `^[A-Z0-9]{1,20}$` validation guard. The regex is now `^[A-Z0-9]{1,25}$`; the character-class guard (uppercase alnum only, no separators/spaces/percent/newlines) is unchanged. Fault assertions added: 25-char OEWS id accepted, 26-char id rejected, injection-shaped ids rejected.

## [1.13.2] — 2026-09-17 (README contact redaction reaches npm; countable tool reports; release asset guard; VS Code/Kiro install badges)

### Added
- **Reports filed from the server's prefilled issue links can now be counted.** The `report` link on `schema_drift` and `upstream_unavailable` errors asks for the `from-tool` label, and the `feedback` tool's link asks for its kind's labels (`bug` → `bug`, `feature` → `enhancement`, `wrong_output` → `bug,wrong-output`), but GitHub ignores prefilled labels when the person filing has no triage rights, so almost no external report got any of them. Every prefilled issue body (the `feedback` tool, and the `report` link on `schema_drift` and `upstream_unavailable` errors) now starts with one HTML comment, `<!-- mcp-sam-gov:tool-report v=<server version> kind=<kind> -->`, which is hidden once the issue renders. It holds only the server version and the report kind (`schema_drift`, `upstream_unavailable`, `bug`, `feature` or `wrong_output`), never a tool argument, query, key, path or the caller's summary, and a value outside those patterns is written as `unknown`. It adds 65 to 82 characters to the URL. The server still makes no network call and posts nothing. A new workflow, `.github/workflows/label-tool-reports.yml`, runs when an issue is opened; if the body contains the marker it adds the existing `from-tool` label, plus `kind:<kind>` only when that label already exists. It does this for both kinds of link, so `feedback` issues now get `from-tool` too; before this change they never did, even from filers with triage rights, so `from-tool` counts from before and after this change are not comparable. The `feedback` tool's own `bug` / `enhancement` / `wrong-output` labels are still dropped for external filers and are not re-applied. The marker is not authenticated: anyone can type it into a hand-written issue, and a filer can delete it before submitting, so `from-tool` counts issues that claim to come from the tool and is an approximation, not an exact count. It has only `issues: write`, reads the body inside `actions/github-script` from the event payload (no shell step, no `${{ }}` expression), and never creates labels, comments or closes issues. The `feedback` tool's `privacy` note and PRIVACY.md now say the link also carries the server version and report kind. +45 fault assertions (3477 → 3522): the marker on all five report paths, no argument values in it even when the failing call had arguments, the URL length, and the workflow script run against a fake API client.

### Changed
- **README now includes one-click install badges for VS Code and Kiro.** Two new badges appear in the badge row at the top of `README.md`: "Install in VS Code" (links to `insiders.vscode.dev/redirect/mcp/install`) and "Add to Kiro" (links to `kiro.dev/launch/mcp/add`), both pre-configured with `npx -y @cliwant/mcp-sam-gov`. A short VS Code section is added to "Host configurations" showing the `.vscode/mcp.json` format (which uses `"servers"`, not `"mcpServers"`); a Kiro section points to the badge. `README.ko.md` and `README.ja.md` add a one-liner at the end of install path 3 mentioning VS Code and the badges. Docs only.
- **The release workflow now fails if the Claude Desktop bundle is missing.** v1.6.0 through v1.12.0 were published with no `mcp-sam-gov.mcpb` asset and nothing failed, so for about two months README install path 1 ("download `mcp-sam-gov.mcpb` from the latest release") led to a release page with no bundle file to download. After the upload, the `bundle` job in `release.yml` now checks that the release lists an uploaded asset named exactly `mcp-sam-gov.mcpb` larger than 1 MB and that its public download URL resolves, retrying briefly, and fails the job otherwise. CI only; no tool, schema or runtime change.
- **The READMEs now show how to run the server without a global install.** Every host config in `README.md` (Claude Desktop, Claude Code, Codex CLI, Cursor, Continue, Gemini CLI) has a second, labelled variant, `"command": "npx", "args": ["-y", "@cliwant/mcp-sam-gov"]`, and Claude Code gets `claude mcp add sam-gov -- npx -y @cliwant/mcp-sam-gov`. `README.ko.md` and `README.ja.md` add the same variant to install path 3. Before this, every documented config used the bare `mcp-sam-gov` command, which only exists after `npm install -g`, and no page showed an `npx` form, so third-party catalogs guessed `npx -y mcp-sam-gov`. That command fails with a 404 because no unscoped `mcp-sam-gov` package exists on npm. The READMEs now say once that the package is scoped (`@cliwant/mcp-sam-gov`) and that `npx -y mcp-sam-gov` is wrong. For Windows hosts that start `npx` without a shell (`spawn npx ENOENT`), they give the `"command": "cmd", "args": ["/c", "npx", "-y", "@cliwant/mcp-sam-gov"]` form, in the Claude Desktop section and in the troubleshooting table. Checked live against the published 1.13.1 package with an empty npm cache: `npx -y @cliwant/mcp-sam-gov` (through a shell) and `cmd /c npx -y @cliwant/mcp-sam-gov` both answered MCP `initialize` with `serverInfo` `mcp-sam-gov` 1.13.1 and listed 152 tools, and spawning `npx` with no shell on Windows failed with `ENOENT`. Docs only.
- **`glama.json` added at the repo root** so the Glama listing (`glama.ai/mcp/servers/cliwant/mcp-sam-gov`) can be claimed by a maintainer; Glama requires the file for organization-owned repositories. It names the GitHub maintainer account and nothing else. The file is excluded from the Claude Desktop bundle (`.mcpbignore`) and is not in the npm tarball (`package.json` `files` is a whitelist). No code, tool, schema or version changes.

### Fixed
- **Test fixtures no longer carry real-looking personal data.** The NSF award fixture in `fault-injection-test.mjs` copied what appeared to be a real researcher's name, email address, and a co-investigator's name and email from a live API probe. They are replaced with obviously fictional values (`Alex A Rivera`, `alex.rivera@example.edu`, `Morgan D Chen mchen001@example.edu`); all 3522 assertions continue to pass and no assertion count was reduced.
- **The README demo no longer shows a real person's contact details.** The "See it in action" transcript in `README.md` showed the name, email address and phone number of a real VA contracting officer as the example point of contact. It now shows an obviously fictional placeholder, `Contracting Officer <co.name@example.gov> +1-XXX-XXX-XXXX`, with the column layout unchanged. A search of the three READMEs, `docs/`, `skills/` and the other tracked Markdown files found no other real government staff names, emails or phone numbers used as examples. Git history is not rewritten, and npm tarballs and third-party mirrors of earlier versions still contain the old text; the next release ships the cleaned README. Docs only.

## [1.13.1] — 2026-09-14 (new Claude Desktop / MCP Directory icon)

### Changed
- **New bundle icon.** `icon.png` (512×512, referenced by the manifest's `icon` field) is replaced with a new design: three overlapping frosted-glass cards, standing for the federal, state and local layers of public data, with a single blue point marking the exact record. The artwork was generated with an image model and then only resized and masked to a rounded square. It contains no text, government seal, flag or agency mark. No tool, schema or behaviour changes.

## [1.13.0] — 2026-09-14 (every state + DC now has a keyless state/local source — North Dakota via a DOT funding-award proxy; 2 new SLED tools; Anthropic Directory listing requirements, one-click bundle restored)

Closes the last three states that had no keyless state/local government-contracting source — North Dakota, Montana and South Dakota — so all 50 states and DC now have at least one (North Dakota only through a proxy: NDDOT federal flex-funding awards to local public agencies, not vendor contracts, because ND's statewide checkbook and procurement portal are not keyless-reachable). That is breadth, not depth: inside most states, coverage of the state portal and mid-sized counties and cities is still thin. Two new reusable tools (150 → 152). The release also meets the Anthropic MCP Directory listing requirements, fixes an EPA ECHO drift bug found by a pre-release live run, discloses upstream freshness for the new sources, and puts the one-click Claude Desktop bundle back on GitHub releases. Fault assertions 3441 → 3477.

### Added
- **`open_checkbook_search` — new tool (151→152), South Dakota dark-state closure (the LAST dark state → 100% state presence).** Row-level vendor-payment search over a curated **Socrata Open Expenditures** checkbook portal (keyless — the product's public dashboard fronts a `{host}/api/checkbook_data.json` app-proxy). First portal: `sd` = State of South Dakota Open Checkbook (~740,980 vendor-payment rows, ~$8.41B, the ~3 most-recent fiscal years). EXACT-match `year`/`vendor`/`org`/`expenseCategory` filters + `sortBy`/`sortOrder` + `limit`/`offset`. Honesty: totalAvailable = the API's own `count` (the REAL filtered total — 740,980 unfiltered / 109,887 for org=TRANSPORTATION — NEVER a page length); `amount` = number|null (a real $0 is 0, absent is null); an exact-match miss ⇒ honest count:0; a deep offset past the end ⇒ returned:0 with the real count preserved; 5xx/timeout THROWS; a non-`{data,count}` body ⇒ schema_drift. ★The underlying Socrata SODA dataset (login-gated) is NEVER touched and NEVER presented as reachable — only the public app-proxy; the ~3-year coverage window is disclosed. +15 non-vacuous fault assertions (§45OC).
- **`tableau_view_csv` — new tool (150→151), Montana dark-state closure.** Fetches a curated US-government **Tableau Server Guest** view's COMPLETE CSV export (keyless — `{host}/t/{site}/views/{workbook}/{view}.csv?:embed=y`, no login/key/cookie) and pages over it client-side. First payload: `mt_contracts_awarded` = State of Montana (DOA) **Contracts Awarded** (~4,554 award records: $ Awarded, Award Date, Event Type IFB/RFP, Event# solicitation, Vendor Name, Agency). Montana's authoritative 989k-row "Checkbook" is a Tableau dashboard-container (empty CSV export) and its Socrata portal is decommissioned — this Contracts-Awarded worksheet is MT's best keyless gov-con source. Honesty: totalAvailable = the complete export row count (Tableau has no server pagination, so NEVER a page length); a round-number total is flagged as a possible export cap; values TRIMMED (empty ⇒ null); a 5xx/404/timeout THROWS, a gated/renamed view (HTML sign-in / empty dashboard-container CSV) ⇒ schema_drift (never a fake empty). Reusable Tableau-Guest-CSV primitive (curated allowlist grows as more gov views are live-verified). +13 non-vacuous fault assertions (§45TB).
- **North Dakota dark-state closure** — `arcgis_feature_query` allowlist +4 NDDOT federal flex-funding **award** layers (`nddot_flex_setaside_road`/`_partner_road`/`_setaside_bridge`/`_partner_bridge`, ~68 awards: recipient local public agency, federal $ awarded, work type; live-verified keyless, no PII). Closes the coverage-ledger's ND gap. ND's authoritative statewide checkbook (omb.nd.gov) and procurement (ndbuys.nd.gov, Ivalua) are keyless-**unreachable** (the state network refuses external connections) / **CAPTCHA+SSO-gated** — recorded as structurally-blocked; this DOT award layer is ND's best-available keyless proxy (disclosed in each service note). ArcGIS services enum 23→27.

### Changed
- **Anthropic MCP Directory listing requirements.** The MCPB bundle now ships a 512×512 `icon.png` referenced by the manifest's `icon` field, and the project is stated plainly to be independent: the manifest's short description says it is "not affiliated with or endorsed by SAM.gov or the U.S. GSA", and the manifest's long description and all three READMEs (EN/KO/JA) add that it is not sponsored by SAM.gov, the U.S. General Services Administration or any government agency either.
- **Upstream freshness is disclosed for `tableau_view_csv` and `open_checkbook_search`.** Each response now carries a FRESHNESS note: the publisher controls refreshes, they can lag by weeks, and here is how to check recency (the view's date columns; `sortBy=payment_date`, `sortOrder=desc`). A pre-release live run found South Dakota's newest payment still dated 2026-07-03 in September, despite the portal's stated per-payment-cycle refresh, and the Montana view unrefreshed since July. +2 fault assertions (§45TB-P5, §45OC-P5).
- **GitHub releases carry `mcp-sam-gov.mcpb` again.** README install path 1 points Claude Desktop users at that file, but no release since v0.3.0 had it. `release.yml` now packs the bundle from a staging copy that holds production-only dependencies and the same `dist/` that goes to npm (a new root-anchored `.mcpbignore` keeps source, tests and docs out), using the `@anthropic-ai/mcpb` installed from the lockfile rather than an unlocked `npx` download, and attaches it to the GitHub Release. The release workflow is also safer: checkouts no longer persist the write token in `.git/config`; `manifest.json` is validated in the publish job before `npm publish`; and `npm publish` is skipped when that version is already on npm, so re-running a failed release completes the GitHub Release and the bundle instead of failing on the duplicate publish. The release tag check now covers `package.json`, `manifest.json`, `server.json`, `.claude-plugin/plugin.json` and `SERVER_VERSION` instead of `package.json` alone.

### Fixed
- **`echo_facility_report` rejected RegistryIDs that `echo_search_facilities` itself returns (upstream drift).** EPA ECHO search rows now include non-FRS ids — state/program ids such as `DCR000509282` and short ids such as `9434` — alongside 12-digit FRS ids, and ECHO's Detailed Facility Report serves all of them (live-verified). The report tool's all-digit 9–12 grammar threw `invalid_input` for those rows, breaking the documented search → report chain (4 of 1,000 DC rows). The grammar is now alphanumeric 1–20 (the character class, not the digit count, is the security property: no separator, space, `%` or newline can reach the query), and an id ECHO does not recognize still returns `not_found`. +5 fault assertions (§46m/m2; reverting the grammar turns the new controls red).
- **Documentation and tool-description accuracy.** `arcgis_feature_query`'s service description now lists all 27 services, including the four North Dakota layers. The Bonfire seed directory is described as 186 organizations (it said 187). No shipped text claims every tool is keyless any more — the GitHub Pages site, the npm package description, the MCP Registry entry, the bundle manifest (whose settings had labelled the Census, FRED, BEA and DOL keys "optional") and the three READMEs now say 147 of the 152 tools need no key and 5 need a free key (`census_business_patterns`, `fred_search_series`, `fred_series_observations`, `bea_regional_data`, `dol_get_dataset`). The list of sources that `DATA_GOV_API_KEY` affects now matches the code (it wrongly named NPPES and CMS). SKILL.md's `fema_search_hazard_mitigation` note now says `state` accepts a 2-letter code or a full name. The tool catalogs in the three READMEs and in SKILL.md now list all 152 tools, including `feedback`, and their group counts add up. The Claude Code plugin manifest (`.claude-plugin/plugin.json`) no longer says 36 tools and now carries the release version.
- **Live smoke fixtures**: `usas_search_subawards` passed a key the tool never accepted (`primeRecipientName` → `subRecipientName`), and the `echo_search_facilities` check assumed all-digit RegistryIDs.

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
