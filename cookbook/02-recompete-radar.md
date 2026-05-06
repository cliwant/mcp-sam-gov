# Recipe 2 — Recompete radar

> Find federal contracts expiring in the next N months at a specific
> agency × NAICS, with the current incumbents and any recent rule
> changes that could affect the recompete.

## Scenario

You sell professional services to one or two specific federal
agencies. Your competitive moat is knowing what's coming up for
recompete BEFORE the RFP drops. Every captured recompete starts with
a year of relationship-building before the SOW lands on SAM.gov.

GovWin / Sweetspot / GovDash will sell you this view for $30K-$60K/yr.
The underlying data is public. This recipe gives you the same view
in 1 tool call.

## Tool sequence

Single composite tool: **`workflow_recompete_radar`**

Internally chains:
1. `usas_lookup_agency` — canonicalize agency name
2. `usas_search_expiring_contracts` — contracts ending in N months,
   sorted by award amount descending, top 20
3. `usas_search_awards` — current top recipients (FY context)
4. `fed_register_search_documents` — last 6 months of rules/notices
   that mention "recompete", "set-aside", or the NAICS code

Steps 2-4 run in parallel after step 1. ~2-4 seconds total.

## Sample prompt

```
Show me the recompete radar for Department of Veterans Affairs
in NAICS 541512 — anything expiring in the next 12 months over $5M.
Include current incumbents and any rules that affect federal IT
recompetes lately.
```

The agent should pick `workflow_recompete_radar` and pass:
- agency: "Department of Veterans Affairs" (or "VA")
- naics: "541512"
- monthsUntilExpiry: 12
- minAwardValueUsd: 5_000_000

## Expected output shape

```json
{
  "ok": true,
  "data": {
    "inputs": {
      "agency": "VA",
      "naics": "541512",
      "monthsUntilExpiry": 12,
      "minAwardValueUsd": 5000000
    },
    "agency": {
      "ok": true,
      "data": {
        "canonical": "Department of Veterans Affairs",
        "toptierCode": "036"
      }
    },
    "expiringContracts": {
      "ok": true,
      "data": {
        "results": [
          {
            "Award ID": "VA118-22-D-0145",
            "Recipient Name": "BOOZ ALLEN HAMILTON INC",
            "Award Amount": 47_500_000,
            "generated_internal_id": "CONT_AWD_..."
          },
          ...
        ]
      }
    },
    "currentTopRecipients": {
      "ok": true,
      "data": {
        "results": [
          { "name": "BOOZ ALLEN HAMILTON INC", "amount": 510_000_000, "count": 47 },
          { "name": "LEIDOS, INC.", "amount": 420_000_000, "count": 33 },
          ...
        ]
      }
    },
    "rulesAffectingRecompete": {
      "ok": true,
      "data": { "results": [ ... up to 5 most relevant FedReg docs ... ] }
    },
    "summary": "Agency: Department of Veterans Affairs. 14 contracts expiring in next 12 months in NAICS 541512. 25 current top recipients (FY2025). 3 potentially-relevant FedReg docs (last 6 months)."
  }
}
```

## Drilling deeper

For each contract in `expiringContracts.data.results`, call
`usas_get_award_detail` with the `generated_internal_id` to fetch:

- `period_of_performance.start_date`
- `period_of_performance.end_date`
- `period_of_performance.last_modified_date`
- `base_and_all_options_value`
- `type_of_set_aside` (e.g. "Service-Disabled Veteran-Owned Small Business")
- `extent_competed` (e.g. "Full and Open Competition")
- `number_of_offers`

Those fields tell you (a) when exactly the contract ends, (b) total
value with options, (c) what set-aside applies (so you know if you
qualify), and (d) how competitive the original award was.

## Variations

**Tighter time horizon** — `monthsUntilExpiry: 6` for "what's expiring
this year." Shorter horizons give you fewer but more urgent results.

**Wider time horizon** — `monthsUntilExpiry: 24` for "two-year
pipeline." Useful for strategic planning, less for active capture.

**Lower value floor** — drop `minAwardValueUsd` to capture small
contracts. Useful if you're a small firm targeting sub-$1M awards
that primes ignore.

**Cross-NAICS scan** — call this recipe once per NAICS in your
portfolio. The agent can chain calls automatically if you say "scan
across 541511, 541512, 541330".

**No agency** — omit `agency` to get a government-wide view of
expiring contracts in your NAICS. Useful for "who else might be
buying what we sell."

## Caveats

- **Period-of-performance dates are sometimes stale** — USAspending's
  `period_of_performance.end_date` reflects the original PoP, not
  including option exercises. A contract with `end_date: 2026-09-30`
  may already have an option exercised that pushes it to 2027-09-30.
  Always verify with `usas_get_award_detail` and look at
  `last_modified_date`.

- **"Recompete" detection isn't structural** — USAspending doesn't
  flag a contract as "recompete eligible" formally. We surface
  contracts ending in your window, sorted by value. The agency may
  award sole-source extension, modify scope, or fold it into a larger
  vehicle (CIO-SP4, OASIS+) — none of which appear in this view.

- **Rule-change relevance is keyword-based** — `rulesAffectingRecompete`
  searches FedReg for "recompete", "set-aside", and the NAICS code.
  False positives are common (rules using "set-aside" in unrelated
  contexts). Skim the titles before drawing conclusions.

- **Federal Register lag** — proposed rules show up the day they're
  published. Final rules can take 60-90 days to land in the Register
  after agency adoption. For real-time intelligence, pair this recipe
  with monitoring of agency procurement office press releases.

## Source data

- USAspending awards endpoint (keyless): `/search/spending_by_award`
- USAspending category endpoint (keyless): `/search/spending_by_category/recipient`
- Federal Register documents API (keyless): `/api/v1/documents.json`
