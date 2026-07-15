# API keys — batch acquisition checklist

> **Auto-generated from `KEY_REGISTRY` (src/keys.ts) — do not edit by hand.**
> Regenerate with `node scripts/gen-api-keys-md.mjs`. The fault suite (§keys-doc) fails
> if this file drifts from the registry. Live config state: call the `api_key_status` tool.

**Every key below is FREE.** This server is **keyless-first**: 10 keys total, but only **4 are REQUIRED** (their source has no keyless tier and the tool throws without the key); the other **6 are OPTIONAL** (they only raise a rate limit or unlock one filter — the tools work keyless without them). You can obtain them all in one sitting and paste them in together (see *How to set* below).

## Required keys (4) — the tool THROWS without these

| Env var | Source / tool(s) | Free signup | What it unlocks |
|---|---|---|---|
| `CENSUS_API_KEY` | US Census (census_business_patterns) | [https://api.census.gov/data/key_signup.html](https://api.census.gov/data/key_signup.html) | the census_business_patterns tool (there is no keyless tier — it throws without a key) |
| `FRED_API_KEY` | FRED (fred_search_series, fred_series_observations) | [https://fred.stlouisfed.org/docs/api/api_key.html](https://fred.stlouisfed.org/docs/api/api_key.html) | the 2 FRED tools (there is no keyless tier — they throw without a key) |
| `BEA_API_KEY` | BEA Regional Economic Accounts (bea_regional_data) | [https://apps.bea.gov/API/signup/](https://apps.bea.gov/API/signup/) | the bea_regional_data tool (there is no keyless tier — it throws without a key) |
| `DOL_API_KEY` | US DOL enforcement data (dol_get_dataset; dol_list_datasets is keyless) | [https://dataportal.dol.gov/registration](https://dataportal.dol.gov/registration) | the dol_get_dataset tool (dataset records need a free key; dol_list_datasets works keyless) |

Checklist:
- [ ] `CENSUS_API_KEY` — https://api.census.gov/data/key_signup.html
- [ ] `FRED_API_KEY` — https://fred.stlouisfed.org/docs/api/api_key.html
- [ ] `BEA_API_KEY` — https://apps.bea.gov/API/signup/
- [ ] `DOL_API_KEY` — https://dataportal.dol.gov/registration

## Optional keys (6) — only raise a rate limit / unlock a filter (tools work keyless without them)

| Env var | Source / tool(s) | Free signup | What it unlocks |
|---|---|---|---|
| `DATA_GOV_API_KEY` | api.data.gov keyed sources: Regulations.gov, Congress.gov, GovInfo, Federal Audit Clearinghouse (FAC), data.gov catalog, GSA per-diem | [https://api.data.gov/signup/](https://api.data.gov/signup/) | higher rate limits on the api.data.gov keyed sources (lifts the shared DEMO_KEY ~30/hr cap to ~1,000/hr) |
| `SAM_GOV_API_KEY` | SAM.gov opportunities | [https://open.gsa.gov/api/get-opportunities-public-api/](https://open.gsa.gov/api/get-opportunities-public-api/) | the authenticated v2 opportunity search + the organization-name filter |
| `BLS_API_KEY` | Bureau of Labor Statistics (BLS) | [https://data.bls.gov/registrationEngine/](https://data.bls.gov/registrationEngine/) | the BLS v2 tier (~500 queries/day, 50 series/query, ~20-year span) vs keyless v1 (~25 queries/day) |
| `NVD_API_KEY` | NIST NVD (cve_lookup) | [https://nvd.nist.gov/developers/request-an-api-key](https://nvd.nist.gov/developers/request-an-api-key) | a higher NVD rate limit |
| `SOCRATA_APP_TOKEN` | Socrata (state/city open-data portals) | [https://evergreen.data.socrata.com/signup](https://evergreen.data.socrata.com/signup) | higher Socrata throttling limits |
| `LDA_API_KEY` | US Senate LDA lobbying (lda_search_filings) | [https://lda.senate.gov/api/register/](https://lda.senate.gov/api/register/) | higher LDA API rate limits (anonymous access already works without it) |

Checklist:
- [ ] `DATA_GOV_API_KEY` — https://api.data.gov/signup/
- [ ] `SAM_GOV_API_KEY` — https://open.gsa.gov/api/get-opportunities-public-api/
- [ ] `BLS_API_KEY` — https://data.bls.gov/registrationEngine/
- [ ] `NVD_API_KEY` — https://nvd.nist.gov/developers/request-an-api-key
- [ ] `SOCRATA_APP_TOKEN` — https://evergreen.data.socrata.com/signup
- [ ] `LDA_API_KEY` — https://lda.senate.gov/api/register/

## How to set (once you have the keys)

Getting each key (creating the free account at its signup URL) is **your** step — the server automates *discovery* (`api_key_status`) and *configuration* (`.env` auto-load), never signup. Set them either way:

**A) Host environment variables** — set `ENV_VAR=value` in the server's environment.

**B) A `.env` file** in the server's working directory (auto-loaded at startup; a real env var always wins over `.env`):

```dotenv
CENSUS_API_KEY=
FRED_API_KEY=
BEA_API_KEY=
DOL_API_KEY=
DATA_GOV_API_KEY=
SAM_GOV_API_KEY=
BLS_API_KEY=
NVD_API_KEY=
SOCRATA_APP_TOKEN=
LDA_API_KEY=
```

Then call `api_key_status` to confirm each shows `currentlySet: true` (the value is never echoed back). To verify a key actually *works*, call that source's own tool.
