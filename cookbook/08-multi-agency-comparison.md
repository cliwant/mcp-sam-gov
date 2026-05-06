# Recipe 8 — Multi-agency competitive intelligence

> Compare 2-3 federal agencies side-by-side to find where to focus
> your capture investment.

## Scenario

A capture VP says "we have 3 strategic accounts: VA, DHS, and
HHS — where should we double down?" Each agency has a different
buying pattern, different prime concentration, different recompete
schedule, and different regulatory shape. Manually comparing means
running ~18 USAspending queries (6 per agency) and stitching
spreadsheets.

This recipe runs `workflow_capture_brief` once per agency in
parallel, then synthesizes the comparison.

## Tool sequence

Agent-orchestrated parallel chain:

1. **`workflow_capture_brief`** × N (one per agency)
2. Agent synthesizes a comparison table from the N briefs

Each `workflow_capture_brief` internally runs ~6 sub-tools, so
this recipe is effectively ~18 underlying API calls. With parallel
execution, ~5-8 seconds total.

## Sample prompt

```
Compare federal capture markets for VA, DHS, and HHS in NAICS
541512 (Computer Systems Design), fiscal year 2025.

For each agency:
- Top recipients
- Sub-agency breakdown
- Number of contracts expiring in next 12 months
- Active SAM.gov opportunities

Then give me a side-by-side comparison and a recommendation on
where a small-mid sized integrator should focus capture investment.
```

## Expected synthesis

The agent runs `workflow_capture_brief` 3× (in parallel) and
produces a comparison:

### Side-by-side comparison

| Dimension | VA | DHS | HHS |
|---|---|---|---|
| FY2025 NAICS 541512 spend | $X.XB | $X.XB | $X.XB |
| Top 3 recipients | Booz Allen, GDIT, SAIC | Leidos, BAH, GDIT | GDIT, BAH, Accenture Fed |
| Concentration (top 3 share) | XX% | XX% | XX% |
| Sub-agencies > $100M | OI&T, VHA, VBA | CBP, USCIS, ICE, FEMA | NIH, CMS, CDC |
| 12-month recompete pile | XX contracts | XX contracts | XX contracts |
| Active SAM.gov opps | XX | XX | XX |
| Recent FedReg activity | X notices | X notices | X notices |

### Recommendation pattern

The agent should recommend based on:

- **Concentration** — lower top-3 share = more accessible to new
  entrants
- **Recompete pile size** — more expiring contracts = more capture
  windows in next year
- **Sub-agency diversity** — more buying offices = more capture
  surfaces; fewer = focus required
- **Active opps** — high count = current momentum; low = quiet
  market

Example recommendation: *"DHS has lower top-3 concentration (~28%
vs VA's ~42%) and a larger recompete pile (43 contracts vs VA's
29). For a new-entrant integrator, DHS gives more inflection
opportunity. VA is structurally more locked-in."*

## Variations

**Single-NAICS scan vs multi-NAICS** — run the comparison once per
NAICS in your portfolio. Different NAICS may favor different
agencies for the same firm.

**Year-over-year drift** — run the comparison for FY2024 AND FY2025,
then ask the agent to surface the deltas. "DHS spending in 541512
fell 12% YoY while HHS rose 8% — DHS is contracting, HHS expanding."

**Set-aside filter** — pass a `setAside` filter to see how the
landscape differs for set-aside-only competition. Often a totally
different competitive map.

**Cross-vendor follow-up** — pick the top recipient at each agency
and run `workflow_vendor_profile` on each to understand the firms
you'd compete against in each market.

## When NOT to use this recipe

- **Single-agency focus** — if you only care about one agency, just
  run `workflow_capture_brief` directly. The comparison overhead
  is wasted.

- **Real-time live opps** — for "what's active right now,"
  `sam_search_opportunities` is faster and more current. The
  composite includes active opps but only top 10 per agency.

- **Long-horizon strategy (5+ years)** — `usas_spending_over_time`
  with multi-FY group is better for trend analysis than three
  single-FY composite calls.

## Performance notes

- Running 3 composites in parallel issues ~18 API calls. Stay
  under USAspending's per-minute rate limits (~120 reqs/min for
  unauthenticated callers).

- The composite already does parallel sub-calls internally — DON'T
  also try to parallelize the composites yourself in the same
  agent turn unless you've increased rate limits.

- Latency: 5-8s for 3 agencies in parallel. 12-20s for 5+ agencies
  in parallel (rate limit kicks in).

## Caveats

- **Apples-to-apples requires same NAICS** — a comparison is only
  meaningful if all agencies are queried at the same NAICS slice.
  Don't compare VA's 541512 to DHS's 541330; the markets are
  structurally different.

- **Sub-agency counts vary** — some "agencies" (DoD) have hundreds
  of sub-buying offices; others (Treasury) have a handful. The
  raw "sub-agencies > $100M" count isn't a fair cross-agency
  metric — DoD will always look more diverse.

- **Recompete pile size depends on contract length** — agencies
  with longer typical contract durations have smaller annual
  recompete piles even if their total spend is large. Don't
  conflate "small recompete pile" with "low opportunity" without
  also looking at total spend.

## Source data

Same as recipe 1 (`workflow_capture_brief`), called N times in
parallel. Plus agent's synthesis layer.
