# Handoff — v0.4 → v0.5 dev plan

This branch (`feat/v0.4-foundation`) contains 4 commits worth of
v0.4-scoped work. Six items from the original v0.4 plan are deferred
to a follow-up branch.

## What's in this branch (4 commits, ready for review)

| Commit | Item | Summary |
|---|---|---|
| `02df025` | #2 | Tool description tuning — 21 descriptions with sibling-tool routing hints |
| `f9aab3a` | #3 | Errors: `hint` field + 4 new ErrorKinds + Zod-aware dispatch + 10 new edge tests (29/29 pass) |
| `7fa06a0` | #8 | SBA size standards: `sba_size_standard_lookup` + `sba_check_size_qualification` (~50 NAICS embedded) |
| `f0a3b86` | #9 | Workflow primitives: `workflow_capture_brief` + `workflow_recompete_radar` + `workflow_vendor_profile` |

Plus this commit (incoming): v0.4.0 version bump + CHANGELOG + this doc.

**Tool count:** 36 → 41 (5 new).
**Test count:** 10 → 29 edge cases, all passing.
**Build:** `npm run build` clean.

## What's deferred to v0.5 (6 items)

| # | Item | Effort | Rationale for deferral |
|---|---|---|---|
| #10 | NAICS hierarchy + 2017→2022 crosswalk | ~1.5d | Requires Census concordance data sourcing. Lower priority than v0.4 work. Recommend embedding ~100 most-changed codes (services-heavy) like the SBA pattern. |
| #7 | Sub-award detail tool expansion | ~2d | FFATA endpoints need research. Current `usas_search_subawards` covers 80% of use cases; expansion (e.g. sub-recipient profile, sub-NAICS analysis) is incremental. |
| #6 | Federal Register classifier (5-class) | ~2d | Needs heuristic engine OR LLM calls (architectural choice). Current `fed_register_search_documents` returns raw notices; classifier adds "admin paperwork / rule change / system retirement / FAR amendment / set-aside policy" labels. |
| #5 | Hosted demo MCP server (Cloudflare Worker) | ~1d | Deployment-side work, separate from server logic. Needs DNS + CF account setup + smoke testing in production. Better as its own branch. |
| #4 + #11 | Cookbook recipes (10 total) | ~3d | Documentation effort. Lower priority than core code. Each recipe = README-style markdown with prose + working code snippet. Suggest organizing into `cookbook/` directory. |
| #1 | GitHub Discussions enable + 5 seed posts | ~2h | Account-side action (web UI + initial posts). Recommend doing AFTER v0.4.0 ships so the seed posts can reference the new tools. |

## Recommended v0.5 sequencing (when work resumes)

**Phase 1 — Polish (1 day)**
1. #1 GH Discussions seed — quick win, captures inbound
2. #4 first 3 cookbook recipes — pick the most-asked-about workflows

**Phase 2 — Tools (4-5 days)**
3. #10 NAICS crosswalk — extend SBA pattern, embed JSON
4. #6 Federal Register classifier — start with rule-based, can add LLM later
5. #7 Sub-award expansion — research FFATA endpoints, add 2-3 tools

**Phase 3 — Distribution (2-3 days)**
6. #5 Hosted demo — Cloudflare Worker deploy
7. #11 cookbook 5 more recipes — fill out workflows page
8. v0.5.0 release

## Push approval status

**4 commits sit on local `feat/v0.4-foundation`. Not pushed to origin.**

Per project rule: "public repo cliwant/mcp-sam-gov — no push without
explicit user approval."

When user approves push, run:
```
cd C:/Users/keums/git/govicon-mcp-sam-gov
git push -u origin feat/v0.4-foundation
gh pr create --base main --title "v0.4.0: foundation hardening + composite tools" --body-file HANDOFF-v0.4-to-v0.5.md
```

Then:
- Wait for daily-smoke CI green
- Merge PR
- `git checkout main && git pull && npm version 0.4.0 && npm publish`
- Tag release on GitHub
- Update MCP Registry (`mcp-publisher publish` after `mcp-publisher login github`)
- Update awesome-mcp PR #5573 if maintainer requests

## Architecture notes for v0.5

**Workflow primitive pattern works well.** The `safe()` wrapper +
`SectionResult<T>` union + `Promise.all` parallel-where-independent
shape should be the default for any future composite tool. Easy to
add: just chain more sub-calls.

**Embedded data pattern works well.** `src/data/sba-size-standards.json`
loaded via dual-path resolution (works in both src/ tsx dev and
dist/ npm install) is the right pattern for any future
"static-but-needs-citation" data (NAICS crosswalk, FAR clause map,
etc.). Each embedded file should have `$source`, `$effectiveDate`,
`$citationUrl`, `$coverage` metadata fields so the agent can cite.

**Hint resolution at the dispatcher boundary works well.**
`toToolError(e, toolName)` always uses the OUTER tool name for
hint computation, not the inner upstream endpoint label. This
keeps sibling-tool routing hints accurate even when errors bubble
through carriers.

## Files touched this session

```
src/
  data/sba-size-standards.json          (new)
  errors.ts                             (modified — hint field + new kinds)
  sba.ts                                (new — size-standards lookup + qualification)
  server.ts                             (modified — 5 new tool registrations + tuned descriptions)
  workflows.ts                          (new — 3 composite tools)
edge-case-test.mjs                      (modified — 19 new tests)
package.json                            (modified — 0.3.0 → 0.4.0)
CHANGELOG.md                            (modified — v0.4.0 entry)
HANDOFF-v0.4-to-v0.5.md                 (this file, new)
dist/                                   (rebuilt)
```

## Known issues / followups

1. **`server.json` and `manifest.json` versions not bumped** — these
   are the MCP Registry + Claude Desktop Extension manifests.
   Update before publish to keep registry in sync. Files:
   - `manifest.json` (Claude Desktop .mcpb)
   - `server.json` (MCP Registry)
2. **`README.md` mentions "36 tools" several places** — should update
   to "41 tools" as part of release prep.
3. **No smoke test for workflow primitives** — `smoke-test.mjs` covers
   primitive tools, edge tests cover SBA. Workflow primitives need
   their own smoke run before publish (manual or new CI step).
4. **Workflow primitive failure modes need real-world validation** —
   captureBrief makes 6 calls; if any one is consistently failing in
   the wild, the partial-failure summary will be noisy. Plan to monitor
   the daily-smoke CI for this once v0.4 ships.

— End of handoff —
