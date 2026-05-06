# Recipe 9 — FAR clause research workflow

> Find the right FAR clause(s) for a compliance question, with
> current text + recent regulatory amendments.

## Scenario

A proposal manager is drafting a response and needs to confirm:

- Which FAR clause covers IP rights for software developed under
  this contract?
- Has it been amended recently?
- What does the current codified text say?
- Are there agency supplements (DFARS, VAAR, etc.) that modify it?

This is a standard compliance workflow. The data lives in eCFR
(current codified text) and Federal Register (recent amendments).

## Tool sequence

1. **`ecfr_search`** with `titleNumber: 48` (FAR) → find relevant
   FAR sections by keyword
2. **`fed_register_search_documents`** with the FAR section number
   in query → recent rule changes affecting that section
3. (Optional) **`ecfr_search`** with `titleNumber: 48` and a
   specific Part number → drill into agency supplements (DFARS is
   FAR Part 200-299, VAAR is Part 800-899, etc.)

## Sample prompts

**Discover the right clause**:
```
What FAR section covers IP rights for software developed under
federal contracts? I want the clause text + any recent amendments.
```

**Drill into a known clause**:
```
Pull current text of FAR 52.227-14 (Rights in Data — General)
and check if there have been any amendments in the last 2 years.
```

**Cross-reference a SOW**:
```
Our SOW says "FAR 52.227-15 (Representation of Limited Rights
Data and Restricted Computer Software)". Confirm that's the
right clause for software with limited rights, and pull the
current text.
```

## Expected output shape

### `ecfr_search` for "rights in data" in title 48:

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "title": "Title 48",
        "hierarchy": "Title 48 → Chapter 1 → Subchapter H → Part 52 → 52.227-14",
        "section_label": "52.227-14",
        "section_title": "Rights in Data—General.",
        "excerpt": "...the Government shall have unlimited rights in...",
        "ecfrUrl": "https://www.ecfr.gov/current/title-48/chapter-1/subchapter-H/part-52/subpart-52.2/section-52.227-14"
      },
      ...
    ]
  }
}
```

### `fed_register_search_documents` with query "52.227-14":

```json
{
  "ok": true,
  "data": {
    "results": [
      {
        "title": "Federal Acquisition Regulation: Rights in Data...",
        "type": "Rule",
        "publication_date": "2024-08-15",
        "effective_on": "2024-09-15",
        "abstract": "...amends FAR 52.227-14 to clarify..."
      },
      ...
    ]
  }
}
```

## Variations

**Agency supplements** — federal agencies have FAR supplements
that modify or add clauses:

| Supplement | CFR Title 48 part | Example clauses |
|---|---|---|
| DFARS | 200-299 | 252.227-7013 (Rights in Tech Data — Noncommercial) |
| VAAR | 800-899 | 852.232-72 |
| HHSAR | 300-399 | 352.227-70 |
| AFFARS | 5300-5399 | Air Force-specific |

To find DFARS clauses on a topic, search:
```
ecfr_search({
  query: "rights in technical data",
  titleNumber: 48,
  // and check hierarchy contains "Chapter 2" (DFARS)
})
```

The result's `hierarchy` field tells you which chapter (FAR vs DFARS
vs VAAR vs etc.).

**Effective-date check** — once you have a clause, check whether
recent amendments have changed it:

```
fed_register_search_documents({
  query: "52.227-14",
  publicationDateFrom: "2023-01-01",
  type: "RULE"  // final rules only
})
```

The `effective_on` date in each result tells you when the change
landed in eCFR.

**Cross-reference graph** — clauses often cross-reference each other
(e.g. 52.227-14 references 52.227-15, 52.227-16, 52.227-17).
Currently no single tool returns the cross-reference graph; the
agent should pull each referenced clause individually.

## FAR Part / Subpart cheat sheet

For navigating Title 48 (FAR):

| Part | Topic | Common clauses |
|---|---|---|
| 19 | Small Business Programs | Set-aside rules |
| 25 | Foreign Acquisition | Buy American |
| 27 | Patents, Data, Copyrights | 52.227-14 family |
| 31 | Contract Cost Principles | 31.205 cost rules |
| 33 | Protests, Disputes, Appeals | 52.233-X |
| 42 | Contract Administration | 42.7 series |
| 52 | Solicitation Provisions and Contract Clauses | THE CLAUSE LIBRARY |

When in doubt, search Part 52 by keyword.

## Practitioner tips

- **Quote the clause number AND text in proposal responses** —
  agencies expect both. The `ecfrUrl` from `ecfr_search` results
  goes directly to the authoritative public source.

- **Check `effective_on` not `publication_date`** — a final rule
  published in March may not become effective until May or later.
  Both `fed_register_get_document` and `ecfr_search` surface the
  effective date.

- **Watch for FAC (Federal Acquisition Circular) numbering** —
  FAR amendments are bundled into FAC issues. The most recent
  FAC number tells you the FAR's current "version" — useful for
  dating compliance materials.

- **DFARS is Chapter 2 of Title 48** — when searching for DoD-
  specific clauses, filter `ecfr_search` results to entries where
  `hierarchy` contains "Chapter 2".

## Caveats

- **eCFR is current text only** — for HISTORICAL versions of a
  clause (e.g. "what did this clause say at the time my 5-year
  contract was awarded?"), eCFR's "Browse Previous" feature is
  the source. We don't currently wrap that in MCP — fall back to
  `https://www.ecfr.gov/historical/title-48/...`.

- **Keyword search has false positives** — "rights in data" matches
  several clauses; the agent should examine `hierarchy` + section
  title + excerpt before quoting. If the user wants ALL clauses
  matching, the agent should iterate through results and present
  each.

- **Federal Register doesn't always cite FAR section numbers
  cleanly** — sometimes a rule modifying FAR 52.227-14 is titled
  "Rights in Data — General" without the section number in the
  title. Search both ways (number + topic name) and de-duplicate.

- **eCFR API rate limit** — eCFR's public API has a soft per-IP
  cap (~1 req/sec). Heavy compliance research may hit it; the
  built-in retry handles transient 429s, but extreme bursts will
  fail.

## Source data

- eCFR API (keyless): https://www.ecfr.gov/api/v1/
- Federal Register API (keyless): https://www.federalregister.gov/api/v1/
- Acquisition.gov (FAR "official" portal): https://acquisition.gov/far
