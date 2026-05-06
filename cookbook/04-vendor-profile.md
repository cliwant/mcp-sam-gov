# Recipe 4 — Vendor profile / competitive research

> Full picture of a federal vendor in 1 call: canonical name, parent /
> child hierarchy, recent prime awards, and where they appear as a
> sub on someone else's contracts.

## Scenario

A capture lead asks: "Tell me about Booz Allen — what are they
winning lately, what's their parent / sub structure, and where are
they teaming?"

Manually this means logging into USAspending, searching for "Booz
Allen", clicking through 6+ recipient records to find the parent
entity, then drilling into recent awards, then checking sub-award
appearances.

`workflow_vendor_profile` does it in 1 call.

## Tool sequence

Single composite tool: **`workflow_vendor_profile`**

Internally chains:
1. `usas_autocomplete_recipient` — confirm canonical name
   ("Booz Allen" → "BOOZ ALLEN HAMILTON INC")
2. `usas_search_recipients` — full hierarchy (parent / child / recipient
   level, multiple UEIs / DUNS)
3. `usas_search_awards_by_recipient` — recent prime awards with
   line-item detail
4. `usas_search_subawards` — sub-contracts where this firm appears as
   either prime (with subs) or sub (under another prime)

Steps 2-4 run in parallel after step 1 canonicalizes the name. ~2-4
seconds total.

## Sample prompt

```
Tell me about Booz Allen Hamilton — recent federal awards, parent
hierarchy, and where they're teaming as a sub.
```

Or more focused:

```
Show me Booz Allen's prime awards in fiscal year 2025 and any
sub-award appearances.
```

The agent should pick `workflow_vendor_profile`.

## Expected output shape

```json
{
  "ok": true,
  "data": {
    "inputs": { "recipientName": "Booz Allen", "fiscalYear": 2025 },
    "canonical": {
      "ok": true,
      "data": {
        "canonicalName": "BOOZ ALLEN HAMILTON INC",
        "matches": [
          { "name": "BOOZ ALLEN HAMILTON INC", "uei": "EH...", "duns": "..." },
          { "name": "BOOZ ALLEN HAMILTON HOLDING CORP", "uei": "...", "duns": "..." },
          ...
        ]
      }
    },
    "recipientHierarchy": {
      "ok": true,
      "data": {
        "totalRecords": 8,
        "recipients": [
          { "id": "abc-...-P", "name": "BOOZ ALLEN HAMILTON HOLDING CORP", "level": "P", "totalAmount": 6_400_000_000 },
          { "id": "def-...-C", "name": "BOOZ ALLEN HAMILTON INC", "level": "C", "totalAmount": 6_200_000_000 },
          ...
        ]
      }
    },
    "recentAwards": {
      "ok": true,
      "data": {
        "results": [
          { "Award ID": "...", "Award Amount": 47_500_000, "naicsCode": "541512", "Awarding Agency": "Department of Defense", ... },
          ...
        ]
      }
    },
    "subawardAppearances": {
      "ok": true,
      "data": {
        "results": [
          { "primeName": "...", "subAmount": 4_500_000, "subDescription": "...", ... },
          ...
        ]
      }
    },
    "summary": "Recipient: BOOZ ALLEN HAMILTON INC. 87 prime awards in FY2025. 23 prime contracts where this firm appears (own or as sub)."
  }
}
```

## Drilling deeper

For the parent entity (level: "P"), pass `recipientHierarchy.data.recipients[0].id`
into `usas_get_recipient_profile` to fetch:
- `alternate_names` (M&A history — "DBA X", "formerly known as Y")
- DUNS / UEI
- `business_types` (8(a) status, SDVOSB, WOSB, HUBZone, etc.)
- Full `location` (HQ address)
- 5-year `total_amount` history

For specific awards, pass `Award ID` or `generated_internal_id` (if
present in the response) into `usas_get_award_detail` for:
- Period of performance
- Set-aside type
- Competition extent
- Number of offers received

## Variations

**Different fiscal year** — pass `fiscalYear: 2024` for last year's
view (especially useful for finding what they ALMOST won that's now
expiring).

**Multiple firm comparison** — call this recipe per vendor and ask
the agent to diff the results ("what does Booz Allen do that Leidos
doesn't?").

**Sub-only view** — if you only care about teaming research (not
prime competition), the `subawardAppearances` section is the focus.
Look for primes who use this firm consistently — that's where
teaming relationships live.

## Sub-award trail interpretation

The `subawardAppearances.data.results` field surfaces FFATA
sub-award filings. A few things to know:

- **Coverage is uneven.** Top primes (Big 6, federal IT primes) tend
  to report most subs. Mid-tier primes have notable gaps. Some never
  report. Don't assume absence = no teaming.

- **Self-reported.** Primes file FFATA quarterly. Recent quarters
  have more gaps than older quarters; data lags ~3-4 months.

- **One firm, multiple roles.** Booz Allen appears both as a prime
  on one contract and as a sub on another. Read the `primeName` field
  to see which.

- **The sub-award MOST useful for capture intel** is "subs on
  contracts your competitor primes." If Leidos primes a $50M VA
  contract and Booz Allen subs on $5M of it, you now know Leidos
  uses Booz Allen for that scope. Replace Booz with yourself in the
  next recompete.

## Caveats

- **Recipient name canonicalization** — federal vendors often have
  multiple legal entities (parent corp, subsidiary LLC, joint
  ventures, special-purpose entities). The autocomplete returns the
  closest match but the agent should review `canonical.data.matches`
  and pick the correct one if multiple are returned.

- **Total-amount totals are inclusive** — the parent record's
  `totalAmount` includes all child entities. Don't sum across the
  hierarchy; use the parent record's total.

- **Recipient profiles are FY-cumulative** — `usas_get_recipient_profile`
  returns lifetime totals, not just the requested fiscal year. For
  FY-specific totals, use `usas_search_awards_by_recipient` with a
  `fiscalYear` filter.

- **Mergers and acquisitions** — when one firm buys another,
  USAspending tracks the new combined entity but may not retroactively
  re-attribute past awards. M&A history shows up in
  `alternate_names` on the recipient profile.

## Source data

- USAspending autocomplete (keyless): `/api/v2/autocomplete/recipient/`
- USAspending recipient list (keyless): `/api/v2/recipient/`
- USAspending recipient profile (keyless): `/api/v2/recipient/{id}/`
- USAspending awards (keyless): `/api/v2/search/spending_by_award`
- USAspending sub-awards (keyless): `/api/v2/search/spending_by_award` with `subawards: true`
