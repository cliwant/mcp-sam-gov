# Recipe 10 — Daily federal data snapshot (automation)

> Run a scheduled daily query that captures "what changed" in the
> federal data layer relevant to your portfolio. Pipe to email,
> Slack, or a database.

## Scenario

You have an active capture portfolio across 3-5 agency × NAICS
slices. Reading them manually each morning takes 30+ minutes
across SAM.gov, USAspending, and Federal Register. You'd rather
get a daily 5-minute briefing.

This recipe is the cron-style automation pattern. The MCP server
runs as part of a Claude (or other LLM) agent, the agent runs once
a day on schedule, executes the queries, formats output, and
ships it to your inbox / Slack / a markdown file.

## Architecture

```
[cron / GitHub Actions]
        ↓ once daily
[Claude API / Codex CLI / Cursor with MCP]
        ↓
[mcp-sam-gov server]
        ↓ ~6-15 calls in parallel
[Federal data sources]
        ↓ structured response
[Agent synthesizes daily brief]
        ↓
[Email / Slack / markdown / DB]
```

## Tool sequence

Daily snapshot for one agency × NAICS slice:

1. **`sam_search_opportunities`** with `postedFrom: <yesterday>` →
   yesterday's new opportunities
2. **`fed_register_search_documents`** with `publicationDateFrom:
   <yesterday>` and your agency slug → yesterday's FedReg
   activity
3. **`usas_search_individual_awards`** with date filter → newly
   posted awards (USAspending typically lags 1-2 days)
4. **`workflow_recompete_radar`** for each portfolio slice (cached,
   updates weekly not daily)
5. Agent synthesizes a 5-section daily brief

## Sample prompt (run by agent on cron)

```
Run my daily federal data brief for portfolio:
  - VA × 541512 (Computer Systems Design)
  - DHS × 541512
  - VA × 541511 (Custom Programming)

For each slice, show:
1. New SAM.gov opportunities posted in last 24h
2. Federal Register documents from agency, last 24h
3. New awards on USAspending in last 24h (if any)

Plus a weekly section (only on Mondays):
4. This week's recompete movements (anything that just got
   modified or had options exercised)

Format as markdown with sections per slice. Keep under 1000 words.
```

## Sample agent automation (GitHub Actions example)

```yaml
# .github/workflows/daily-federal-brief.yml
name: Daily federal brief

on:
  schedule:
    - cron: '0 13 * * *'  # 9am ET daily
  workflow_dispatch: {}

jobs:
  brief:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install MCP server
        run: npm install -g @cliwant/mcp-sam-gov
      - name: Run daily brief
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          # See: https://docs.anthropic.com/en/api/agent-sdk
          # The agent calls mcp-sam-gov tools to gather data,
          # then formats the brief.
          node scripts/run-daily-brief.mjs > brief.md
      - name: Commit + post brief
        run: |
          git config user.name "daily-brief"
          git config user.email "noreply@example.com"
          git add brief.md
          git commit -m "$(date +%Y-%m-%d) brief"
          git push
```

The `run-daily-brief.mjs` script is your custom orchestrator. It
spawns the MCP server as a child process, instantiates an Anthropic
client, runs the agent loop with the prompt above, and outputs
markdown.

## Output format suggestion

```markdown
# Federal Brief — 2026-04-30

## VA × 541512 (Computer Systems Design)

### New SAM.gov opportunities (last 24h)
- VA-26-RFP-1234 — Cloud platform modernization for VHA
  (closes 2026-06-15, Total Small Business set-aside, $2.8M est)

### Federal Register (last 24h)
- VA OI&T proposed rule on data ingestion standards
  (publication 2026-04-30, comment period 60 days)

### New awards (last 24h)
- BOOZ ALLEN HAMILTON INC — VA118-26-D-0001 — $4.8M
  (Q3 FY26 task order)

---

## DHS × 541512
[same structure]

---

## VA × 541511 (Custom Programming)
[same structure]

---

## Weekly recompete movements (Monday only)
[option exercises, mod in / out, new term extensions]
```

## Variations

**Slack instead of email** — replace the markdown output with a
Slack webhook POST. Use Block Kit format for richer formatting.

**Database persistence** — write each daily snapshot to Postgres /
SQLite. Build a dashboard on top showing trend lines for "new
opps per day", "Federal Register velocity", etc.

**Agency-only brief** — focus on one agency × all your NAICS, vs
the multi-slice portfolio version. Simpler, faster.

**SBA set-aside-only** — filter all queries by your set-aside type
to see only contracts you can bid. Reduces noise dramatically for
small-business firms.

**Vendor-watchlist** — track competitor wins. Use
`workflow_vendor_profile` for each watched competitor with
yesterday's date filter; surface anything new.

## Engineering tips

- **Run during low-traffic hours** — federal APIs are less
  congested 0200-0600 UTC. Schedule briefs for 0900 ET (1300
  UTC) and you may hit a slower window. If rate limits bite,
  shift to 1400 ET (1800 UTC).

- **Cache the heavy queries** — `workflow_capture_brief` is
  expensive. Run it weekly (Sunday night) and cache; daily run
  only does the delta queries.

- **Honor rate limits across briefs** — if you have 5+ portfolio
  slices, run them sequentially with a small delay between, not
  all in parallel. USAspending throttles aggressive callers.

- **Email delivery** — use a transactional email service
  (Postmark, Resend, Amazon SES). Don't try to send from the GH
  Actions runner directly without a service.

## Caveats

- **USAspending lag** — newly awarded contracts take 1-2 business
  days to appear on USAspending. The "new awards last 24h" section
  is actually "awards that became visible in last 24h" — which
  may be 1-3 days after actual award.

- **SAM.gov posting lag** — typically real-time but occasionally
  6-12h. The daily snapshot will catch them eventually; if you
  need real-time, this isn't the right pattern (use webhook
  subscriptions on Federal Register / monitor SAM.gov via RSS
  feeds).

- **No webhook for federal sources** — federal data sources
  don't publish webhooks. Polling is the only option, which is
  why daily-cron is the standard pattern.

- **Federal Register agency slug match** — if your portfolio
  references an agency whose canonical name doesn't fuzzy-match
  a FedReg slug, the FedReg section will fall back to global
  search. Pre-resolve agency slugs once and cache.

## Source data

Same as previous recipes. The novelty here is the AUTOMATION
pattern — running them on cron + synthesizing for a daily reader.

## Examples in the wild

The following are open-source examples of similar automation
patterns the cookbook readers might want to study:

- **GitHub Actions + Anthropic SDK** — Claude Code's own scheduled-
  agent pattern (see `.github/workflows/daily-smoke.yml` in this
  repo for a similar cron-on-MCP-server pattern that runs a smoke
  test daily).

- **Substack-as-a-database** — some federal-AI watchers run a
  daily script that writes the brief as a Substack draft via API,
  letting them edit + publish on demand.

- **Airtable / Notion ingestion** — for portfolio-tracking, write
  each snapshot row to Airtable or Notion via their respective
  APIs. Build the dashboard in the destination tool.
