# Recipe 3 — SBA size eligibility before bidding

> Confirm a firm qualifies as "small business" under the right NAICS
> size standard, before submitting a set-aside bid.

## Scenario

A firm wants to bid on a small-business set-aside opportunity. The
set-aside applies under a specific NAICS code (named in the SOW).
Each NAICS has its own size standard — either a revenue cap (3-year
average annual revenue, in $M) or an employee count cap.

If the firm doesn't qualify, bidding wastes proposal $ AND risks
size protests if they win. If they DO qualify but use the wrong
NAICS, same problem.

This recipe answers: "Given my firm's size and the SOW's NAICS, do
I qualify? Under which alternative if there are multiple?"

## Tool sequence

Two tools, used together:

1. **`sba_size_standard_lookup`** — what's the size standard for this
   NAICS? (lookup-only)

2. **`sba_check_size_qualification`** — given my firm's revenue OR
   employee count, do I qualify? (decision)

For most queries, tool #2 is enough — it calls #1 internally and
applies the threshold.

## Sample prompts

**Lookup only** ("what's the size standard?"):
```
What's the SBA size standard for NAICS 541512?
```

**Qualification check** ("do I qualify?"):
```
We're bidding on a NAICS 541512 set-aside. Our average annual
revenue over the last 3 years is $28 million. Do we qualify
as a small business?
```

**Multi-entry NAICS handling** (when the NAICS has alternative
size standards):
```
We're a 1,200-employee engineering firm bidding on a NAICS 541330
set-aside. Some of our work is military aerospace, some is general
engineering. Do we qualify?
```

## Expected output shape

### `sba_size_standard_lookup` for NAICS 541512:

```json
{
  "ok": true,
  "data": {
    "found": true,
    "naics": "541512",
    "entries": [
      {
        "type": "revenue",
        "thresholdMillionsUsd": 34,
        "industry": "Computer Systems Design Services"
      }
    ],
    "citation": "https://www.ecfr.gov/current/title-13/chapter-I/part-121/subpart-A/section-121.201",
    "effectiveDate": "2023-03-17"
  }
}
```

### `sba_check_size_qualification` for $28M firm in NAICS 541512:

```json
{
  "ok": true,
  "data": {
    "qualifies": true,
    "byEntry": [
      {
        "industry": "Computer Systems Design Services",
        "type": "revenue",
        "threshold": 34000000,
        "claimed": 28000000,
        "qualifies": true
      }
    ],
    "citation": "https://www.ecfr.gov/current/title-13/chapter-I/part-121/subpart-A/section-121.201"
  }
}
```

### Multi-entry NAICS — 1,200-employee firm in NAICS 541330:

NAICS 541330 (Engineering Services) has 4 alternative size
standards: $25.5M default, $47M for military/aerospace work, $47M
for energy contracts, $47M for marine. The check evaluates each:

```json
{
  "ok": true,
  "data": {
    "qualifies": true,
    "byEntry": [
      {
        "industry": "Engineering Services (default)",
        "type": "revenue",
        "threshold": 25500000,
        "claimed": undefined,
        "qualifies": "indeterminate"
      },
      {
        "industry": "Engineering Services — Military and Aerospace Equipment",
        "type": "revenue",
        "threshold": 47000000,
        "claimed": undefined,
        "qualifies": "indeterminate"
      },
      ...
    ],
    "citation": "..."
  }
}
```

⚠️ Note: this firm passed `averageEmployees: 1200` but Engineering
Services uses revenue-based standards. The qualification check
returns `indeterminate` for all entries because no revenue figure
was provided. The agent should ask the user for revenue.

## Variations

**Revenue-based check** — pass `averageAnnualRevenueUsd` for any
NAICS that uses revenue.

**Employee-based check** — pass `averageEmployees` for NAICS that
use employee caps (most R&D codes 541713-541715, manufacturing
codes 334xxx/336xxx, telecom carriers 517xxx).

**Both metrics** — for NAICS with mixed entries (rare), pass both
to evaluate against any applicable standard.

**No NAICS yet** — call `usas_autocomplete_naics` first with a
free-text description to resolve the code (recipe 5).

## Multi-entry semantics

Some NAICS have multiple size standards depending on sub-industry:
- 541330 Engineering Services: 4 alternatives
- 541715 R&D in Physical/Engineering/Life Sciences: 3 alternatives
  (1,000 default, 1,500 for aircraft, 1,300 for missiles)
- 541519 Other Computer Related Services: 2 alternatives ($34M
  default, $34M with footnote 18 = IT VAR margin-protected)

A firm qualifies if it satisfies **ANY ONE** of the alternative
caps. The `qualifies: true` decision in the response is `true` if
at least one entry's `qualifies: true` — even if other entries
show `false`.

This is the **any-of** semantics from 13 CFR §121.201, and it's
why a 1,200-employee firm doing military engineering can qualify
under 541330's $47M cap even though general engineering 541330 is
capped at $25.5M.

## NAICS not in the embedded table

The v0.4 embedded table covers ~50 most-used services / IT / R&D
NAICS. For NAICS outside this set, the response will look like:

```json
{
  "ok": true,
  "data": {
    "found": false,
    "naics": "423840",
    "hint": "NAICS 423840 is not in the v0.4 embedded table (~50 most-used codes). Fall back to ecfr_search(query='size standard NAICS 423840', titleNumber=13) for full eCFR coverage.",
    "citation": "..."
  }
}
```

The agent should follow the hint and call `ecfr_search` with
`query: "size standard NAICS 423840"`, `titleNumber: 13`. The eCFR
result will contain the size standard text — but parsing it
reliably is a manual step.

## Caveats

- **Size standards change** — SBA periodically updates 13 CFR §121.201.
  The embedded table is dated 2023-03-17. Check `effectiveDate` in
  the response — if it's been a year+, verify against the official
  source.

- **3-year average revenue rule** — the "claimed" revenue must be
  the firm's 3-year average, not the most recent year alone. Same
  for employees (12-month average, including subsidiaries / affiliates
  per SBA affiliation rules).

- **Affiliation rules apply BEFORE size check** — under SBA
  affiliation, multiple firms under common control or with strong
  contractual ties may be aggregated. This tool does NOT evaluate
  affiliation. If a firm has joint ventures, parent companies, or
  exclusive teaming agreements, the actual size for SBA purposes
  may be larger than the firm alone. Consult SBA size advisory or
  legal counsel.

- **Footnote 18 (NAICS 541519 IT VAR)** — for IT value-added
  resellers under NAICS 541519, only the firm's MARGIN counts toward
  the $34M cap, not the gross pass-through hardware/software cost.
  This is why some IT VARs with $200M+ in gross federal sales still
  qualify as small. The embedded table flags this in the
  `industry` field but doesn't evaluate it for you — caller's
  responsibility to compute margin correctly.

## Source data

- 13 CFR §121.201 (effective 2023-03-17): https://www.ecfr.gov/current/title-13/chapter-I/part-121/subpart-A/section-121.201
- SBA official table: https://www.sba.gov/document/support-table-size-standards
- Embedded JSON: `src/data/sba-size-standards.json` in this repo (~50 NAICS, services-focused)
