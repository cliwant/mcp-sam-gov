# Changelog

All notable changes to `@cliwant/mcp-sam-gov` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/cliwant/mcp-sam-gov/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/cliwant/mcp-sam-gov/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.3.0
[0.2.1]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.2.1
[0.2.0]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.2.0
