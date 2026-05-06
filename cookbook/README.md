# Cookbook — `@cliwant/mcp-sam-gov`

Working recipes for the most common federal-contracting + AI-agent
workflows. Each recipe is self-contained: scenario → tool sequence →
sample prompt → expected output shape → variations.

All recipes assume you have the MCP server installed (`npm install
@cliwant/mcp-sam-gov` or `.mcpb` for Claude Desktop). No API key
required for any of these workflows.

## Recipes

| # | Recipe | What it does | Tools used |
|---|---|---|---|
| 1 | [Capture brief for an agency × NAICS](./01-capture-brief.md) | One-call composite intelligence on an agency's market — sub-agencies, top vendors, recompete pile, recent rules, active opps | `workflow_capture_brief` |
| 2 | [Recompete radar](./02-recompete-radar.md) | Find federal contracts expiring in next N months at a specific agency × NAICS | `workflow_recompete_radar` |
| 3 | [SBA size eligibility before bidding](./03-sba-size-eligibility.md) | Confirm a firm qualifies as "small business" under the right NAICS size standard | `sba_size_standard_lookup`, `sba_check_size_qualification` |
| 4 | [Vendor profile / competitive research](./04-vendor-profile.md) | Full picture of a federal vendor — recent awards, sub-award appearances, hierarchy | `workflow_vendor_profile` |
| 5 | [NAICS code disambiguation](./05-naics-disambiguation.md) | Resolve a free-text market description into the right NAICS code (anti-hallucination) | `usas_autocomplete_naics`, `usas_naics_hierarchy` |

## How to run a recipe

Open Claude Desktop / Claude Code / Cursor / any MCP-aware client with
the server connected, then paste the **Sample prompt** from the recipe.
The agent will pick the tools listed in **Tools used** automatically.

If the agent picks the wrong tool first, that's a description-tuning
issue — please open an issue at <https://github.com/cliwant/mcp-sam-gov/issues>
with the prompt + which tool was picked vs which should have been.

## Conventions used in recipes

- **Scenario** — the user need / business question being solved.
- **Tool sequence** — the canonical chain (some are composite; some
  are agent-orchestrated).
- **Sample prompt** — paste-ready text for the LLM.
- **Expected output shape** — what the response looks like (not
  literal data, since live federal data changes daily).
- **Variations** — common parameter changes that produce different
  cuts of the same query.
- **Caveats** — coverage limits, data freshness, known sharp edges.

## Contributing a recipe

1. Pick a workflow you've used 3+ times in real work.
2. Copy `cookbook/_template.md` (TODO — coming v0.5.1).
3. Fill in scenario / sequence / prompt / output / variations / caveats.
4. PR with title `cookbook: add recipe for <name>`.

We prioritize recipes that:
- Solve a real federal-contracting practitioner pain (not just MCP demos)
- Cite the data sources used (USAspending endpoints, FAR sections, etc.)
- Show error handling for partial failures (the `{ ok, error }` envelope)
