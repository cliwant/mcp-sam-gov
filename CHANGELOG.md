# Changelog

All notable changes to `@cliwant/mcp-sam-gov` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-04-30 (foundation hardening + composite tools)

### Added — 5 new tools (36 → 41 total)

**SBA size standards (2)** — first-class small-business eligibility tooling.
- `sba_size_standard_lookup` — given a 6-digit NAICS, returns the official
  size standard (revenue cap or employee cap) from 13 CFR §121.201
  (effective 2023-03-17). Multi-entry NAICS (e.g. 541330 Engineering
  Services has $25.5M default but $47M for military/marine work) returns
  ALL applicable entries — firm qualifies under ANY one.
- `sba_check_size_qualification` — given (NAICS, avg revenue OR avg
  employees), returns `qualifies: true | false | indeterminate` plus
  per-entry breakdown. Honors any-of semantics for multi-entry NAICS.
- Coverage: ~50 most-used services / IT / R&D / consulting / construction
  NAICS in v0.4. Misses fall back to `ecfr_search` (hint surfaced in the
  error response).

**Workflow primitives — composite tools (3)** — single-call wrappers that
chain 4-7 underlying tools, handle partial failures, and synthesize a
one-line summary.
- `workflow_capture_brief` — federal capture intelligence in 1 call.
  Internally chains `usas_lookup_agency` → `usas_search_subagency_spending`
  → `usas_search_awards` → `usas_search_expiring_contracts` →
  `fed_register_search_documents` → `sam_search_opportunities`. Saves
  ~6 round-trips and avoids agent orchestration mistakes.
- `workflow_recompete_radar` — focused recompete intelligence. Chains
  `usas_lookup_agency` → `usas_search_expiring_contracts` →
  `usas_search_awards` (current incumbents) → `fed_register_search_documents`
  (rules affecting recompetes).
- `workflow_vendor_profile` — full vendor picture in 1 call. Chains
  `usas_autocomplete_recipient` (canonicalize) → `usas_search_recipients`
  (parent/child) → `usas_search_awards_by_recipient` (recent prime awards)
  → `usas_search_subawards` (sub appearances).
- Architecture: `Promise.all` for parallel sub-calls where no dependency
  exists; partial-failure isolation per section (each wrapped in
  `{ ok: true, data } | { ok: false, error }`); structured one-line
  summary synthesized at the end.

### Changed — agent-side reliability

**Tool descriptions tuned (21 of 36 existing tools)** — every description
now names the SIBLING TOOL to use instead when the user's intent maps
better there. Reduces "agent picked wrong tool first try" failures.
Examples:
- SAM.gov vs USAspending: "active solicitations" vs "historical contracts"
- `usas_search_awards` (aggregate) vs `usas_search_individual_awards` (line items)
- `fed_register_search_documents` vs `ecfr_search`: "new regulatory activity"
  vs "current codified text"
- `usas_autocomplete_naics` vs `usas_naics_hierarchy`: "free-text → code"
  vs "navigate parent/child"
- 5 spending category tools (psc / state / cfda / federal_account / agency)
  cross-referenced with explicit routing guidance.

**Error envelope upgrade — `hint` field + 4 new ErrorKinds.** Errors now
carry an actionable next-step suggestion pointing at the sibling tool to
call instead, or the input format to fix. Catches the most common
agent-side recovery loops:
- `sam_get_opportunity` bad noticeId → "Use `sam_search_opportunities` first."
- `usas_get_award_detail` bad ID → "Use `usas_search_individual_awards`
  first; IDs look like CONT_AWD_*."
- `fed_register_get_document` bad number → "Doc numbers are YYYY-NNNNN."
- `usas_get_agency_*` bad code → "Toptier codes from `usas_lookup_agency`."
- New ErrorKinds: `id_format_invalid`, `date_invalid`, `agency_not_resolved`,
  `naics_invalid`.

**ZodError handling** — input validation errors now caught explicitly →
`invalid_input` envelope with hint, instead of falling through to
`unknown`. Previously a malformed input crashed the dispatch with
"unknown error: ..."; now the agent sees actionable feedback.

### Tested

Edge case test suite: 10 → 29 cases.
- New: negative limit / over-max limit Zod rejections, empty noticeId,
  HTML / SQL-injection / whitespace-only input safety, hint-presence
  verification on FedReg / USAspending recipient errors, ecfr title=0,
  9 SBA size-standards cases (incl. multi-entry any-of qualification).
- 29/29 passing on production federal APIs.

### Backward compatibility

- All 36 v0.3 tools unchanged in name + input schema.
- Error envelope additive: existing readers of `{ ok, error: { kind, message,
  retryable } }` see new optional `hint` field; existing ErrorKinds
  unchanged, 4 new ones introduced.
- Tool list grows from 36 → 41 — agents that auto-discover tools see new
  ones, agents with hard-coded tool lists are unaffected.

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
[0.4.0]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.4.0
[0.3.0]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.3.0
[0.2.1]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.2.1
[0.2.0]: https://github.com/cliwant/mcp-sam-gov/releases/tag/v0.2.0
