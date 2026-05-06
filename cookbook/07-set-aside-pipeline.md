# Recipe 7 — Set-aside pipeline scan

> Find federal contracts reserved for specific small-business
> set-aside types, sized to your firm, expiring in your window.

## Scenario

You're a small business with one or more set-aside certifications:
8(a), SDVOSBC, WOSB, EDWOSB, HUBZone, VSA. The federal
contracting world has billions reserved for these categories, but
the search UI on SAM.gov isn't great at slicing by set-aside × NAICS
× expiring window simultaneously.

This recipe combines size eligibility verification with the
recompete radar to surface only the contracts you can actually bid.

## Tool sequence

Three-step chain:

1. **`sba_check_size_qualification`** — confirm your firm qualifies
   under the target NAICS (recipe 3 walks through this)
2. **`usas_search_expiring_contracts`** with `setAside` filter — find
   contracts ending in your window that are reserved for your type
3. **`sam_search_opportunities`** with `setAside` filter — see what's
   actively soliciting now

Optionally:
- **`workflow_recompete_radar`** for a focused view on one
  agency × NAICS × set-aside slice
- **`usas_search_awards_by_recipient`** on the current incumbents to
  understand their pricing before bidding the recompete

## Sample prompt

```
We're an 8(a)-certified firm with $18M in 3-year average revenue,
based in Maryland. We bid under NAICS 541512 (Computer Systems
Design) primarily.

1. Confirm our size qualifies us under 541512.
2. Show me 8(a) set-aside contracts at any federal agency,
   under NAICS 541512, expiring in the next 12 months,
   over $1M in value.
3. Show me 8(a) opportunities currently active on SAM.gov
   for NAICS 541512.
```

## Expected output

### Step 1 — qualification check (recipe 3)

```json
{
  "qualifies": true,
  "byEntry": [
    {
      "industry": "Computer Systems Design Services",
      "type": "revenue",
      "threshold": 34000000,
      "claimed": 18000000,
      "qualifies": true
    }
  ]
}
```

✅ Firm qualifies (under $34M cap, claimed $18M).

### Step 2 — expiring contracts (8(a), NAICS 541512, ≥$1M, 12mo)

```json
{
  "results": [
    {
      "Award ID": "VA118-22-D-0145",
      "Recipient Name": "[INCUMBENT 8(A) FIRM]",
      "Award Amount": 4_800_000,
      "generated_internal_id": "CONT_AWD_..."
    },
    ...
  ]
}
```

Each result is a real federal contract that:
- Expires in the next 12 months
- Was set aside for 8(a) (your category)
- Is over $1M
- Falls under NAICS 541512 (your code)

### Step 3 — active opportunities

```json
{
  "totalRecords": N,
  "opportunities": [
    {
      "noticeId": "...",
      "title": "...",
      "agency": "...",
      "responseDeadline": "2026-06-15T17:00:00",
      "naics": "541512",
      "setAside": "8A"
    }
  ]
}
```

## Drilling into a recompete target

For each contract in the expiring list, drill deeper:

1. **`usas_get_award_detail`** with the `generated_internal_id` →
   period_of_performance, options, set-aside type, competition extent

2. **`workflow_vendor_profile`** with the incumbent's name → what
   else they win, where they sub, parent/child structure

3. **`fed_register_search_documents`** with agency slug + query
   "set-aside" → recent rules affecting this competition

This is the canonical pre-recompete intel chain. The user can ask
the agent to do it for the top 3 expiring contracts.

## Set-aside type codes

When passing `setAside` parameter, use these exact codes:

| Code | Meaning |
|---|---|
| `SBA` | Small Business (default small-biz set-aside, broadest) |
| `8A` | 8(a) Business Development |
| `HZS` | HUBZone Small Business |
| `SDVOSBC` | Service-Disabled Veteran-Owned Small Business |
| `WOSB` | Woman-Owned Small Business |
| `EDWOSB` | Economically Disadvantaged Woman-Owned Small Business |
| `VSA` | Veteran-Owned Small Business (set-aside) |
| `VSS` | Veteran-Owned Small Business (sole source) |

## Variations

**Multi-set-aside firm** — firms with multiple certifications
(e.g. 8(a) + SDVOSBC + HUBZone) should run the scan once per
qualifying type. Different SOWs are reserved for different
combinations; each opens a different lane.

**Government-wide vs single-agency** — omit `agency` to scan
governmentwide. Useful for portfolio-wide pipeline view. Pass an
agency to focus capture on a specific buyer.

**Sub-NAICS scan** — if you're certified under a NAICS family
(e.g. all of 5415xx Computer Systems Design family), run the
scan once per 6-digit code in the family (use
`usas_naics_hierarchy` to enumerate).

**Set-aside graduation prep** — if your 8(a) certification
graduates in 6-12 months, run this scan WITHOUT the `setAside`
filter to see the broader full-and-open competition you'll need
to win against. Plan accordingly.

## Caveats

- **Set-aside type at award time** — USAspending's `setAside` field
  reflects what was set-aside on AWARD. Some contracts were
  originally posted as full-and-open but ended up being awarded to
  a small business via competitive process — those won't show
  with a setAside filter on the search.

- **Recompete strategy may change set-aside** — agencies sometimes
  move a recompete from full-and-open to set-aside (or vice versa)
  in the next acquisition cycle. The current contract's set-aside
  type is a signal but not a guarantee.

- **Affiliation rules** — the `sba_check_size_qualification` tool
  does NOT evaluate SBA affiliation. If your firm has joint
  ventures, parent companies, or strong contractual ties to other
  firms, the SBA may aggregate revenues/employees beyond what your
  internal numbers show. Get a SBA size advisory letter for any
  contract over $5M if there's any doubt.

- **Set-aside displacement** — a contract awarded under 8(a) cannot
  be recompeted as full-and-open without specific justification.
  Some agencies do this anyway, then face protest. If you see a
  full-and-open recompete of an 8(a) contract, consider whether
  to file a size protest after award.

## Source data

- USAspending awards (keyless) with set-aside filter
- SAM.gov public HAL with set-aside codes parameter
- 13 CFR §121.201 (size standards) — embedded
- 13 CFR §125-127 (set-aside program rules) — query via `ecfr_search`
