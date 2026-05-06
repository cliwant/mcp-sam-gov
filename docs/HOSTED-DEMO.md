# Hosted demo — Cloudflare Worker

A small HTTP-JSON facade that exposes a **keyless subset** of mcp-sam-gov's
tools so evaluators can curl the surface without installing the npm package
or running the stdio MCP server locally.

> **Scope** — this is a *demo*, not a production MCP transport. It speaks
> plain HTTP+JSON, not the Model Context Protocol's Streamable-HTTP
> transport. For the full 46-tool MCP surface, install
> `@cliwant/mcp-sam-gov` and point your MCP client at `mcp-sam-gov` over
> stdio.

## What's exposed (10 tools)

Pure-keyless, Worker-safe subset:

- `usas_lookup_agency`
- `usas_autocomplete_naics`
- `usas_autocomplete_recipient`
- `fed_register_search_documents`
- `fed_register_list_agencies`
- `fed_register_classify`
- `sba_size_standard_lookup`
- `sba_check_size_qualification`
- `naics_revision_check`

## What's NOT exposed (yet)

- `sam_*` — uses the `SamGovClient` adapter with internal retry/cache;
  needs a Worker-flavored fetch-only adapter (TODO).
- `usas_search_*` heavy queries — long timeouts; safe to add later.
- `workflow_*` composite tools — fan out 4-6 upstream calls; likely OK
  on Worker but want explicit budgeting before exposing.

## Endpoints

```
GET  /              — service banner + tool index
GET  /tools         — list of tools with descriptions
POST /tools/:name   — invoke a tool with JSON body
```

## Deploy

```bash
cd worker
npm install         # installs wrangler + @cloudflare/workers-types
npx wrangler login  # one-time browser auth to your Cloudflare account
npm run deploy      # publishes mcp-sam-gov-demo.<your-account>.workers.dev
```

No secrets required — the demo wraps only keyless upstreams (USAspending,
Federal Register, SBA local data, Census NAICS local data).

## Local dev

```bash
cd worker
npm run dev   # wrangler dev — opens localhost:8787
```

## Example calls

```bash
# Banner
curl https://mcp-sam-gov-demo.<account>.workers.dev/

# List tools
curl https://mcp-sam-gov-demo.<account>.workers.dev/tools

# Look up an agency
curl -X POST https://mcp-sam-gov-demo.<account>.workers.dev/tools/usas_lookup_agency \
  -H 'content-type: application/json' \
  -d '{"searchText":"Veterans Affairs"}'

# Classify a Federal Register notice (inline)
curl -X POST https://mcp-sam-gov-demo.<account>.workers.dev/tools/fed_register_classify \
  -H 'content-type: application/json' \
  -d '{"title":"Small Business Size Standards; 8(a) Updates","type":"PRORULE","cfrReferences":[{"title":"13","part":"121"}]}'

# SBA size check
curl -X POST https://mcp-sam-gov-demo.<account>.workers.dev/tools/sba_check_size_qualification \
  -H 'content-type: application/json' \
  -d '{"naicsCode":"541512","averageAnnualRevenueUsd":20000000}'
```

## Architecture notes

- `worker/data.ts` re-imports `src/data/*.json` with `import attributes`
  so the bundler inlines them — no filesystem reads at runtime.
- `worker/index.ts` calls `sba._injectData(...)` and
  `naicsXwalk._injectData(...)` once at module load to populate the
  loaders without `node:fs`.
- Other tool modules (`usaspending.ts`, `federal-register.ts`,
  `fedreg-classifier.ts`) are pure `fetch`-based and run unchanged on
  Workers thanks to `compatibility_flags = ["nodejs_compat"]`.

## Path forward

To upgrade to a true Streamable-HTTP MCP transport:

1. Replace the `/tools/:name` POST routes with the SDK's
   `StreamableHTTPServerTransport` mounted on `/mcp`.
2. Refactor `runTool` from `src/server.ts` into a stand-alone `dispatch`
   module so both the stdio server and the Worker import the same
   tool registry.
3. Add Worker-flavored adapters for `SamGovClient` (so `sam_*` tools
   work too).
