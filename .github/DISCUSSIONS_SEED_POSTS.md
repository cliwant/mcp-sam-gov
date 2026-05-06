# GitHub Discussions Seed Posts

This file contains 5 starter discussion posts to seed
github.com/cliwant/mcp-sam-gov/discussions when Discussions are
enabled on the repo.

## How to use

1. Enable Discussions on the repo:
   - Repo → Settings → General → Features → Check "Discussions"
2. Create the 5 standard categories (or accept GitHub's default):
   - Announcements
   - General
   - Ideas
   - Q&A
   - Show and tell
3. Post each of the 5 seed posts below into the matching category.

The seed posts are meant to (a) signal that Discussions is the right
place for community input, (b) prime the categories with real
content, and (c) surface 5 specific things we want feedback on.

---

## Seed post 1 — Announcements

**Title:** v0.4.0 shipped — 5 new tools (composite workflows + SBA size standards)

**Category:** Announcements

**Body:**

v0.4.0 is now on npm (`@cliwant/mcp-sam-gov@0.4.0`) and the MCP
Registry. Five new tools, taking the catalog from 36 → 41:

**SBA size standards (2)** — `sba_size_standard_lookup` and
`sba_check_size_qualification`. Embedded from 13 CFR §121.201, no
API key, multi-entry NAICS handled with any-of semantics.

**Composite workflow primitives (3)** — `workflow_capture_brief`,
`workflow_recompete_radar`, `workflow_vendor_profile`. Each chains
4-7 underlying tools with partial-failure isolation and a synthesized
one-line summary. Saves agents ~6 round-trips per query.

Plus 21 of the existing 36 tool descriptions were tuned with
sibling-tool routing hints to reduce "agent picked wrong tool first
try" failures. And errors now carry actionable `hint` fields.

Full changelog: https://github.com/cliwant/mcp-sam-gov/blob/main/CHANGELOG.md

Cookbook (5 working recipes for the most common workflows) is now
in the repo: [cookbook/](https://github.com/cliwant/mcp-sam-gov/tree/main/cookbook)

What we want to hear:
- Which tool worked best in your workflow?
- Which tool description still feels ambiguous to your agent?
- What workflow is missing that should become a composite?

---

## Seed post 2 — Ideas

**Title:** What federal-data workflows do you wish AI agents could do natively?

**Category:** Ideas

**Body:**

The composite workflow tools (`workflow_capture_brief`,
`workflow_recompete_radar`, `workflow_vendor_profile`) shipped in
v0.4 are based on the most common chains we've seen people running
manually. We want to ship more.

Reply with workflows you've found yourself running 3+ times that
SHOULD be one tool call:

- "Show me everything about agency X right now" (already covered by
  `workflow_capture_brief`)
- "Find vendors that primed a contract at agency X but subbed at
  agency Y" — lateral teaming intelligence?
- "Show me historical wins for the incumbent of contract Z" — pre-
  recompete intel?
- "Detect FAR clause changes that affect contracts in NAICS X over
  last N months" — compliance radar?
- Other?

For each idea, we'd love:
1. The plain-English question you ask
2. The data sources that need to combine to answer it
3. Why the existing tool chain is hard to orchestrate manually

We'll prioritize based on how many people +1 each idea + how much
hand-orchestration pain it eliminates.

---

## Seed post 3 — Q&A

**Title:** When should I use `workflow_capture_brief` vs the individual tools?

**Category:** Q&A

**Body:**

Short answer: **`workflow_capture_brief`** when you want a 6-section
overview in 1 call. Use the individual tools (e.g.
`usas_search_awards`, `sam_search_opportunities`) when you need to
drill into one specific dimension or apply non-standard filters.

Specifically, prefer `workflow_capture_brief` when:
- The user's question is broad ("give me a read on X")
- You don't yet know which dimension matters most
- You want partial-failure resilience (each section's success/failure
  is independent)

Prefer individual tools when:
- The user has already drilled into a specific question (e.g. "show me
  the top 5 expiring contracts over $10M")
- You need a non-default filter (the composite uses sensible defaults
  like `monthsUntilExpiry: 12`, `limit: 10`, FY current — not always
  what you want)
- You're optimizing latency (composite makes 5-6 parallel calls; one
  individual call is cheaper)

Want a more detailed walk-through? See the cookbook recipe:
[cookbook/01-capture-brief.md](https://github.com/cliwant/mcp-sam-gov/blob/main/cookbook/01-capture-brief.md)

---

## Seed post 4 — Show and tell

**Title:** What have you built with `@cliwant/mcp-sam-gov`?

**Category:** Show and tell

**Body:**

We'd love to see what's been built. Federal AI agents, capture-brief
generators, sub-award trail analysis, sliding-window dashboards,
GitHub Actions for federal data ingestion — anything.

Drop a link / screenshot / 2-line description of what you've put
together. Bonus points for:
- Live URLs (even if it's a localhost demo screenshot)
- The MCP-aware client you built it on (Claude Desktop / Code /
  Cursor / Continue / Codex / Gemini)
- The chain-of-tools that made it work
- What didn't work / what you ended up working around

Goal: build a community gallery of real applications. We'll feature
2-3 each month in the README.

---

## Seed post 5 — General

**Title:** Federal-AI procurement landscape: what's on your mind in 2026?

**Category:** General

**Body:**

Beyond the tooling, we're tracking the federal AI procurement space
broadly — vehicles like CIO-SP4 / OASIS+, FedRAMP / DoD IL
authorization timelines, the agentic-procurement frame, set-aside
strategy under continuous-evaluation contracts, etc.

What's on your mind? A few prompts:
- Which contract vehicle do you see most AI work flowing through in
  FY26?
- What FedRAMP / DoD IL changes are you tracking?
- Where's the agentic frame actually landing — RFI volume,
  pilot-to-production conversion, OASIS+ Pool 6 (8(a)) activity?
- What's the rule change you're most worried about?

This is a casual thread — drop a take, ask a question, share a link
to a recent piece you found useful.

---

## Posting checklist

When posting these to GitHub:
- [ ] Use the exact title text (matches the SEO of `cookbook/`
      cross-references)
- [ ] Pin Seed post 1 (Announcements) — first thing visitors see
- [ ] Tag posts with relevant labels if your repo has them set up
- [ ] After posting all 5, link the Discussions URL into:
      - README.md ("Have a question? Ask in [Discussions]")
      - CONTRIBUTING.md
      - The package.json `bugs` field
