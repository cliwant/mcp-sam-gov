# Recipe 1 — Capture brief for an agency × NAICS

> One-call composite intelligence on an agency's market in a specific
> NAICS code. Replaces ~6 hand-orchestrated tool calls with one.

## Scenario

You're at a federal contractor. Capture lead asks Monday morning:
"Give me a quick read on VA's 541512 (Computer Systems Design) market
— who's winning, what's expiring, any rule changes I should know
about, what's actively out for bid right now."

This is the canonical capture-brief use case. Six distinct queries,
all needed, all routine. Doing this manually means logging into
USAspending, SAM.gov, and Federal Register separately, picking the
right filters in each, and stitching the answers together.

`workflow_capture_brief` does it in one call.

## Tool sequence

Single composite tool: **`workflow_capture_brief`**

Internally chains:
1. `usas_lookup_agency` — canonicalize "VA" → "Department of Veterans Affairs"
2. `usas_search_subagency_spending` — which office (VA OI&T vs VHA vs VBA) actually buys
3. `usas_search_awards` — top recipients in NAICS 541512 at VA
4. `usas_search_expiring_contracts` — contracts ending in next 12 months
5. `fed_register_search_documents` — VA-related rules / notices in last 90 days
6. `sam_search_opportunities` — active live opportunities right now

All 5 downstream calls run in **parallel** after step 1 resolves the
agency name. Total round-trip: ~3-5 seconds in good conditions.

## Sample prompt

```
Give me a capture brief on Department of Veterans Affairs in NAICS 541512
for fiscal year 2025. I want top vendors, sub-agency breakdown,
expiring contracts, recent regulatory activity, and active opportunities.
```

The agent will pick `workflow_capture_brief` because the description
matches "capture brief" + agency + NAICS pattern.

## Expected output shape

```json
{
  "ok": true,
  "data": {
    "inputs": { "agency": "VA", "naics": "541512", "fiscalYear": 2025 },
    "agency": {
      "ok": true,
      "data": {
        "canonical": "Department of Veterans Affairs",
        "toptierCode": "036",
        "abbreviation": "VA",
        "matches": 1
      }
    },
    "subagencyBreakdown": {
      "ok": true,
      "data": {
        "subAgencies": [
          { "name": "Office of Information and Technology", "amount": 2_840_000_000, "awards": 1840 },
          { "name": "Veterans Health Administration", "amount": 950_000_000, "awards": 620 },
          ...
        ]
      }
    },
    "topRecipients": {
      "ok": true,
      "data": {
        "results": [
          { "name": "Booz Allen Hamilton Inc", "amount": 510_000_000, "count": 47 },
          { "name": "Leidos, Inc.", "amount": 420_000_000, "count": 33 },
          ...
        ]
      }
    },
    "recompetePile": {
      "ok": true,
      "data": {
        "results": [
          { "Award ID": "VA118-25-D-1234", "Recipient Name": "...", "Award Amount": 22_000_000, "generated_internal_id": "CONT_AWD_VA118..." },
          ...
        ]
      }
    },
    "recentRegulatoryActivity": {
      "ok": true,
      "data": { "results": [ ... 10 most recent FedReg docs ... ] }
    },
    "activeOpportunities": {
      "ok": true,
      "data": { "opportunitiesData": [ ... up to 10 active SAM.gov notices ... ] }
    },
    "summary": "Agency: Department of Veterans Affairs (toptier 036). 8 sub-agencies with FY2025 spending. 25 top recipients in NAICS 541512. 14 contracts expiring in next 12 months. 6 Federal Register documents in last 90 days. 5 active SAM.gov opportunities."
  }
}
```

The `summary` field is the one-line answer if the user just wants a
quick read. The detailed sections are there for follow-up drilling.

## Variations

**Different fiscal year** — pass `fiscalYear: 2024` to look at last
year's market instead of current.

**Different NAICS** — switch to `541511` (Custom Programming) for a
different competitive map at the same agency.

**Different agency** — `agency: "DoD"` or `agency: "Department of Defense"`
(both work — the lookup canonicalizes).

**Drilling into one section** — once you see the response, drill into
specific results:

- For a recompete: pass each `generated_internal_id` from
  `recompetePile.data.results` into `usas_get_award_detail` to get
  period_of_performance, options, and set-aside.
- For a vendor: pass each `name` from `topRecipients.data.results`
  into `workflow_vendor_profile` to get their full federal footprint.

## Caveats

- **Federal Register agency-slug match is fuzzy** — if the canonical
  name doesn't fuzzy-match a FedReg slug, the regulatory activity
  section falls back to a global search. The agent gets back results
  but may include adjacent-agency notices.

- **Partial failure is normal** — federal endpoints are flaky.
  Sections wrap their result in `{ ok: true, data }` or
  `{ ok: false, error }`. If `recentRegulatoryActivity.ok === false`,
  the other 5 sections still return useful data.

- **The `summary` string only counts what succeeded.** If a section
  failed, it appears in the trailing parenthetical: "(2 section(s)
  failed: fedReg, samOpps.)" — alerting the agent to retry those.

- **Rate limits** — running this 20+ times back-to-back will hit
  USAspending throttling. Each call makes 5-6 USAS requests, so 20
  briefs = 100-120 requests. Space them out, or honor `retryAfter`
  on the error envelope.

## Source data

- USAspending v2 API (keyless): https://api.usaspending.gov/api/v2/
- SAM.gov public HAL endpoint (keyless): https://sam.gov/api/prod/sgs/v1/
- Federal Register API (keyless): https://www.federalregister.gov/api/v1/

All endpoints used by this composite are keyless. No API key required.
