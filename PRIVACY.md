# Privacy Policy — @cliwant/mcp-sam-gov

_Last updated: 2026-07-20_

`@cliwant/mcp-sam-gov` is an open-source MCP (Model Context Protocol) server that runs **locally** on your own machine (or your own infrastructure) and exposes read-only tools for querying **public US-government open data**. It is designed to collect nothing.

## Data collection

**We collect no personal data.** The software has no analytics, no telemetry, and no user accounts. Cliwant operates no server that receives your queries or results — the tool runs entirely within your MCP client's process on your device.

## How your data is used and stored

- Your prompts, tool inputs, and tool results are processed **in memory, locally**, and are **not stored** by this software and **not transmitted to Cliwant**.
- When you invoke a tool, the server makes a direct HTTPS request to the **relevant official US-government (or equivalent public) API** — e.g. SAM.gov, USAspending.gov, api.data.gov, EPA, FDIC, CourtListener — and returns the response to your MCP client. Those requests are governed by the respective provider's own privacy terms.
- **Optional API keys** (for sources such as Census, FRED, BEA, DOL, and a few others that offer higher limits with a free key) are read from your local environment variables and are sent **only** to that source's official API over HTTPS. They are never logged, never included in error reports, and never transmitted to Cliwant.
- The optional **feedback tool** produces a **pre-filled GitHub issue URL locally** for you to review and submit yourself; it does **not** post anything automatically and includes no personal data.
- **Update check:** on startup the package fetches its own public version metadata from `registry.npmjs.org` (the same public registry `npm install` uses) to tell you if a newer version exists. This is **not telemetry** — it sends no user data. Disable it with `MCP_SAM_GOV_NO_UPDATE_CHECK=1` (or `NO_UPDATE_NOTIFIER=1`).

## Third-party sharing

We do not share your data with anyone. This software sends requests **only** to the official public data APIs you explicitly query (and, on startup, the npm registry for the version check). It performs no cross-source joining, enrichment, or profiling of individuals.

## Data retention

Cliwant retains **no** user data because none is collected. Any local caching is on **your** machine and under your control.

## Personal / sensitive data

The tools surface only data that the underlying government sources already publish publicly. The server is designed to avoid personal-identifier exposure and carries provenance/PII caveats on relevant responses. It is **not** a consumer-reporting tool and must not be used for any FCRA-regulated purpose.

## Security

The server is keyless-first and read-only. It uses an SSRF-safe curated allowlist for outbound requests and fails loudly (never silently) on unexpected upstream behavior.

## Contact

- Issues / questions: <https://github.com/cliwant/mcp-sam-gov/issues>
- Privacy contact: **seungdo.keum@cliwant.com**

## Changes

Material changes to this policy will be reflected in this file with an updated date.
