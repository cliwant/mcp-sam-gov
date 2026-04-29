# Contributing to @cliwant/mcp-sam-gov

Thanks for the interest. This is a small project that leans hard on
public federal APIs — keeping it working as those APIs evolve is the
single most valuable thing contributors can do.

## Two highest-value contributions

1. **Report a tool that broke.** If `npm run smoke` fails for you, or
   if a federal API started returning a different shape, open an issue
   labeled `smoke-failure`. Include:
   - Which tool (`sam_search_opportunities`, etc.).
   - The exact error text the agent received (the `{ ok: false, error: { ... } }` envelope is enough).
   - A minimal repro args object.
2. **Add a missing federal endpoint.** USAspending v2 alone has ~80
   endpoints; we wrap 22. If you have a workflow that needs another
   one (e.g. `/api/v2/recipient/duns/{duns}/`, `/api/v2/transactions/`),
   open an issue with the endpoint URL + a short use case, and a PR
   that follows the patterns in `src/usaspending.ts`.

## Setup

```bash
gh repo clone cliwant/mcp-sam-gov
cd mcp-sam-gov
npm install
npm run build
npm run smoke   # full live test against federal APIs (35/35 expected)
```

Requires Node.js ≥ 20.

## Development loop

```bash
# Run the server in dev mode (auto-rebuild on file save):
npm run dev

# Run a one-off smoke check:
npm run smoke

# Type-check without rebuilding:
npx tsc --noEmit
```

## How tools are structured

Every tool lives in one of five service modules:

| Module | What it wraps |
|---|---|
| `src/sam-gov/client.ts` | `SamGovClient` class — SAM.gov public HAL endpoints |
| `src/usaspending.ts` | USAspending v2 (22 functions) |
| `src/federal-register.ts` | Federal Register API v1 |
| `src/ecfr.ts` | eCFR (Code of Federal Regulations) |
| `src/grants.ts` | Grants.gov v1 |

The `src/server.ts` file is a thin dispatcher: it defines the Zod
schema for each tool's input, registers them with the MCP server, and
forwards calls to the service modules.

To **add a new tool**, you need to:

1. Add the wrapper function to the right service module (or a new module).
2. Add the Zod input schema in `src/server.ts`.
3. Add a `ToolDef` entry in the `TOOLS` array.
4. Add a `case` in `runTool`'s switch.
5. Update `manifest.json` (the `tools` array) so `.mcpb` users see it.
6. Update `skills/sam-gov/SKILL.md` so Claude knows when to call it.
7. Add a smoke test entry in `smoke-test.mjs`.

## Error handling

All upstream HTTP calls go through `fetchWithRetry` from `src/errors.ts`.
This handles:

- HTTP 429 → retry with `Retry-After` honoring (max 60s).
- HTTP 5xx → exponential backoff (1s, 2s, 4s).
- Network errors → 3 attempts.
- HTTP 4xx (non-429) → no retry, surfaces as `invalid_input` error.

If your tool needs a different policy, add a comment explaining why.

## Style

- TypeScript strict mode; no `any`.
- Prefer narrow types over generic objects (e.g. `type Resp = { results?: ... }` over `Record<string, unknown>`).
- Each file documents its purpose at the top.
- Comments explain **why**, code explains **what**.

## Pull requests

- Branch from `main`. PRs to `main` go through review + branch protection.
- Run `npm run smoke` and confirm 35/35 (or 36/36 if you added a tool) pass.
- Add a CHANGELOG entry under `[Unreleased]`.
- Keep PRs focused. One concern per PR.

## License

By contributing, you agree your code is licensed under the same MIT
license as the project.
