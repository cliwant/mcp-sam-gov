# Recipe 5 — NAICS code disambiguation (anti-hallucination)

> Resolve a free-text market description into the correct 6-digit
> NAICS code BEFORE running any search that requires a code.

## Scenario

The user describes their target market in plain English: "we sell
custom AI software to federal agencies." That maps to a NAICS code,
but which one? 541511? 541512? 541618? 518210? 541715?

If the LLM guesses, it's a coin flip. Wrong NAICS = wrong
competitive map = wrong strategy. This is the most common
anti-pattern in federal-AI-for-procurement workflows.

The fix is two tools used together:
1. `usas_autocomplete_naics` for free-text → code (top fuzzy matches)
2. `usas_naics_hierarchy` for navigating up/down the code tree

## Tool sequence

**Pattern A: free-text → code**
1. `usas_autocomplete_naics` with the user's plain-English description
2. Agent presents top matches to user OR picks the most-likely match
   based on context

**Pattern B: drill into a code family**
1. `usas_autocomplete_naics` finds 541xxx as a likely root
2. `usas_naics_hierarchy` with `naicsFilter: "541"` to see all
   3-digit children
3. Repeat until 6-digit specificity

**Pattern C: validate a user-supplied code**
1. `usas_naics_hierarchy` with `naicsFilter: <user's code>` — if
   the code is real, it returns the description; if not, empty
   results signal the agent to ask the user to clarify

## Sample prompts

**Free-text → code:**
```
We sell custom AI software for federal agencies. What NAICS code
should we use when bidding?
```

The agent should call `usas_autocomplete_naics({searchText:
"custom AI software", limit: 10})`. Likely matches: 541511 (Custom
Computer Programming), 541512 (Computer Systems Design), 541618
(Other Management Consulting if positioned as services).

**Hierarchy navigation:**
```
What's all the 6-digit NAICS codes under 5415 (Computer Systems
Design and Related Services)?
```

Agent calls `usas_naics_hierarchy({naicsFilter: "5415"})`. Returns:
- 541511 Custom Computer Programming Services
- 541512 Computer Systems Design Services
- 541513 Computer Facilities Management Services
- 541519 Other Computer Related Services

**Validation:**
```
A SOW says NAICS 549999. Is that a real code?
```

Agent calls `usas_naics_hierarchy({naicsFilter: "549999"})`. If the
result is empty, the code is invalid (or retired in 2017→2022
revision). Agent should suggest re-checking the SOW or running
autocomplete with the SOW's description.

## Expected output shape

### `usas_autocomplete_naics` for "custom AI software":

```json
{
  "ok": true,
  "data": {
    "naics": [
      {
        "naics": "541511",
        "naics_description": "Custom Computer Programming Services",
        "score": 0.92
      },
      {
        "naics": "541512",
        "naics_description": "Computer Systems Design Services",
        "score": 0.88
      },
      {
        "naics": "541618",
        "naics_description": "Other Management Consulting Services",
        "score": 0.74
      },
      {
        "naics": "518210",
        "naics_description": "Computing Infrastructure Providers, Data Processing, Web Hosting, and Related Services",
        "score": 0.71
      }
    ]
  }
}
```

The agent should present the top 2-3 matches to the user, NOT pick
one silently. NAICS choice has real consequences (different
competitive map, different size standard, different set-aside
eligibility). User confirmation is required.

### `usas_naics_hierarchy` for "5415":

```json
{
  "ok": true,
  "data": {
    "results": [
      { "naics": "541511", "description": "Custom Computer Programming Services", "naicsLevel": 6, "activeAwardCount": 8400 },
      { "naics": "541512", "description": "Computer Systems Design Services", "naicsLevel": 6, "activeAwardCount": 12100 },
      { "naics": "541513", "description": "Computer Facilities Management Services", "naicsLevel": 6, "activeAwardCount": 460 },
      { "naics": "541519", "description": "Other Computer Related Services", "naicsLevel": 6, "activeAwardCount": 2700 }
    ]
  }
}
```

`activeAwardCount` is the number of currently-active federal contracts
under that code — useful for sizing the market.

## Anti-pattern: don't skip this step

A common LLM failure mode:

```
User: "Show me top federal IT services vendors at VA"
Agent: usas_search_awards({agency: "VA", naics: "541510"})  // ❌ retired code
```

NAICS 541510 was retired in the 2017 revision (split into 541511
and 541512). Calling search with it returns empty results. Agent
gives up or hallucinates "no IT vendors at VA" — completely wrong.

The fix:

```
User: "Show me top federal IT services vendors at VA"
Agent (corrected): usas_autocomplete_naics({searchText: "IT services"})
     → matches: 541512, 541511, 541513, ...
Agent: usas_lookup_agency({searchText: "VA"})
     → matches: "Department of Veterans Affairs", toptier 036
Agent: usas_search_awards({agency: "Department of Veterans Affairs", naics: "541512"})
     → real results
```

`usas_autocomplete_naics` and `usas_lookup_agency` are both
**ANTI-HALLUCINATION GUARDS**. Their job is to keep the LLM
anchored in real federal data. The descriptions in the v0.4 server
explicitly call this out.

## Variations

**Multi-NAICS portfolios** — for a firm bidding under 3-4 NAICS
codes simultaneously, run autocomplete once per business line and
keep a list. Pass each into search tools as needed.

**Industry vs sub-industry** — `usas_autocomplete_naics` returns
6-digit codes preferentially. To go up to industry-level (4-digit
or 3-digit), use `usas_naics_hierarchy` with `naicsFilter` set to
the prefix.

**Cross-walk to old codes** — when reading historical SOWs (pre-2022),
the NAICS may be from the 2017 revision. Most codes are stable, but
some changed. The 2017→2022 NAICS crosswalk is on the v0.5 roadmap;
for now, validate any pre-2022 code against the current hierarchy.

## Caveats

- **Autocomplete is a fuzzy match** — top score doesn't mean
  "definitive." Always present 2-3 matches to the user when the
  context is ambiguous. NAICS 541511 vs 541512 is a classic
  ambiguity — both apply to "custom software for the agency," and
  the actual choice depends on whether the work is heavy on
  programming (541511) or systems integration / consulting (541512).

- **NAICS revision history matters** — codes retired in 2017 (e.g.
  541510) won't appear in autocomplete or hierarchy. SOWs using old
  codes will fail searches silently.

- **NAICS != PSC** — Product Service Codes (PSC) are a separate
  classification used heavily in federal contracts. PSCs are
  4-character codes like "R425" (engineering support) or "D316"
  (IT-end user). For PSC analysis, use `usas_search_psc_spending`
  instead. NAICS is industry-of-the-vendor; PSC is what's-being-bought.

- **Multiple NAICS per contract** — a federal contract has ONE
  primary NAICS, but a vendor may sell across multiple. Don't
  assume one NAICS captures the firm's total federal revenue —
  always cross-check `usas_search_awards_by_recipient` across the
  vendor's full portfolio.

## Source data

- USAspending autocomplete (keyless): `/api/v2/autocomplete/naics/`
- USAspending NAICS hierarchy (keyless): `/api/v2/references/naics/`
- Census NAICS reference: https://www.census.gov/naics/
