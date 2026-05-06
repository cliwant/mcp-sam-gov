# Recipe 6 — Federal AI procurement landscape scan

> Map where federal AI dollars are actually flowing across NAICS,
> agencies, and contract vehicles — for strategy, BD planning, or
> investor decks.

## Scenario

You're a federal-AI startup or a strategy lead. The press talks
about "the federal AI market" as if it's a single line item, but
it isn't — AI work is smeared across at least 4 NAICS codes that
don't say "AI" anywhere in their descriptions, plus across a dozen
agencies with vastly different buying patterns.

This recipe surfaces the actual map: which NAICS holds AI work,
which agencies buy the most, what regulatory activity is shaping
the field, and what's actively in solicitation right now.

## Tool sequence

Multi-step, agent-orchestrated:

1. `usas_search_psc_spending` × 2-3 NAICS codes (see below) for
   NAICS market structure
2. `usas_search_agency_spending` for buyer concentration
3. `usas_spending_over_time` for the multi-year curve (where the
   field is going)
4. `fed_register_search_documents` with query "artificial intelligence"
   for regulatory activity
5. `sam_search_opportunities` with query "AI" or "machine learning"
   for active opportunities
6. (Optional) `ecfr_search` for any AI-specific procurement clauses

## NAICS codes to query

Federal AI work shows up in these NAICS codes (per recipe 5
disambiguation pattern):

| NAICS | Title | Where AI lives |
|---|---|---|
| 541511 | Custom Computer Programming | LLM application code, agent development, ML pipeline build |
| 541512 | Computer Systems Design | "AI modernization" labeled work, integrators bundle AI into broader IT |
| 541330 | Engineering Services | AI-for-research at NIH, DoE, DARPA |
| 541690 | Other Scientific & Technical Consulting | ML model development outside DoD ML cores |
| 541713 / 541714 / 541715 | R&D | SBIR / STTR AI research grants |
| 518210 | Computing Infrastructure Providers | Hosted AI compute (GPU clusters at agencies) |

## Sample prompt

```
Map the federal AI market for FY2025. Show me:
1. Top buyers by agency
2. Top primes by NAICS
3. 5-year spending trend
4. What rules / regulations are coming out about federal AI
5. What's actively in SAM.gov for AI work right now

Cover NAICS 541511, 541512, 541330, and 541690.
```

The agent should execute the chain. Expect ~10-15 tool calls total.

## Expected output (synthesis)

The agent synthesizes a brief with these sections:

### Top buyers (FY2025, NAICS aggregated)

```
1. DoD (incl. all sub-services)         $X.XB
2. HHS (incl. NIH)                       $X.XB
3. VA                                    $X.XB
4. DHS (incl. CBP, ICE, USCIS)          $X.XB
5. NASA                                  $X.XB
```

### Top primes (FY2025, NAICS aggregated)

```
1. Booz Allen Hamilton                  $X.XB
2. Leidos                                $X.XB
3. SAIC                                  $X.XB
...
```

### 5-year curve (NAICS 541511 + 541512 combined)

```
FY2021    $XX.XB
FY2022    $XX.XB  (+X%)
FY2023    $XX.XB  (+X%)
FY2024    $XX.XB  (+X%)
FY2025    $XX.XB  (+X%)
```

### Regulatory pulse (last 90 days)

```
- Title 1: Title (publication_date, type)
- Title 2: ...
```

### Active in SAM.gov (today)

```
- Title 1: Notice (closes YYYY-MM-DD, $est)
- Title 2: ...
```

## Variations

**Single-NAICS deep-dive** — focus on one NAICS instead of aggregating.
Cleaner picture but loses cross-code work.

**Single-agency drill** — pivot to one agency's AI spending and run
`workflow_capture_brief` on each AI-relevant NAICS at that agency.

**Set-aside-only view** — filter all queries to `setAside: "8A"` (or
"SDVOSBC", "WOSB", etc.) for "AI work reserved for [type]
businesses" — useful if you're a small business strategist.

**Sub-award trail** — for each top prime, run `workflow_vendor_profile`
to see who they sub to. This reveals the AI-tier of the federal
sub-contractor universe — where indie firms appear.

## Caveats

- **NAICS is a leaky proxy** — not every contract under 541511 is AI.
  And some AI work hides under 541512 or 541618 (Other Management
  Consulting). The aggregate is directionally correct but not
  precise. For higher confidence, search award descriptions for
  "AI" / "machine learning" / "LLM" / "neural" — but text search
  isn't a USAspending feature. Workaround: pull recent awards and
  filter client-side.

- **"AI procurement" lags labeling** — many agencies don't flag a
  contract as "AI work" until late in performance, or never. The
  labels you see are the contracting officer's call at award time.

- **Trade press numbers vs USAspending numbers** — published "federal
  AI market" estimates often combine NAICS we don't query (e.g.
  semiconductor manufacturing for chips going into AI accelerators).
  Don't expect USAspending totals to match third-party reports.

- **Regulatory pulse is keyword-heavy** — "artificial intelligence"
  appears in many notices for non-procurement reasons (HHS
  diagnostic AI rules, DoD ethics frameworks). Skim before drawing
  conclusions about the procurement landscape specifically.

## Source data

- USAspending category breakdowns: `/api/v2/search/spending_by_category/`
- USAspending time-series: `/api/v2/search/spending_over_time/`
- Federal Register: `/api/v1/documents.json`
- SAM.gov public HAL: `/api/prod/sgs/v1/search/`
