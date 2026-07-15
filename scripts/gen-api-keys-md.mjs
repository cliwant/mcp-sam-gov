/**
 * gen-api-keys-md.mjs — generate `API_KEYS.md` from the single source of truth
 * (`KEY_REGISTRY` in src/keys.ts → dist/keys.js).
 *
 * WHY generated, not hand-written: a hand-maintained key list DRIFTS every time a
 * key is added (the exact defect class fixed elsewhere this project). This renders
 * the doc deterministically from the registry; the fault suite (§keys-doc) asserts
 * the committed API_KEYS.md byte-equals this output, so adding a key to the registry
 * FORCES a regenerate — the doc can never silently go stale.
 *
 * Usage: `node scripts/gen-api-keys-md.mjs`  (writes ../API_KEYS.md)
 * The `renderApiKeysMd(registry)` export is imported by both this script and the
 * fault-injection guard so they share one renderer.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "..", "API_KEYS.md");

/** Render one registry row as a markdown table line. */
function row(k) {
  const sources = k.sources.join("; ").replace(/\|/g, "\\|");
  const unlocks = String(k.unlocks || "").replace(/\|/g, "\\|");
  return `| \`${k.envVar}\` | ${sources} | [${k.signupUrl}](${k.signupUrl}) | ${unlocks} |`;
}

/** Pure, deterministic render of the whole doc from a KEY_REGISTRY array. */
export function renderApiKeysMd(registry) {
  const required = registry.filter((k) => k.required);
  const optional = registry.filter((k) => !k.required);
  const table = (rows) =>
    ["| Env var | Source / tool(s) | Free signup | What it unlocks |", "|---|---|---|---|", ...rows.map(row)].join("\n");
  const checklist = (rows) => rows.map((k) => `- [ ] \`${k.envVar}\` — ${k.signupUrl}`).join("\n");

  return `# API keys — batch acquisition checklist

> **Auto-generated from \`KEY_REGISTRY\` (src/keys.ts) — do not edit by hand.**
> Regenerate with \`node scripts/gen-api-keys-md.mjs\`. The fault suite (§keys-doc) fails
> if this file drifts from the registry. Live config state: call the \`api_key_status\` tool.

**Every key below is FREE.** This server is **keyless-first**: ${optional.length + required.length} keys total, but only **${required.length} are REQUIRED** (their source has no keyless tier and the tool throws without the key); the other **${optional.length} are OPTIONAL** (they only raise a rate limit or unlock one filter — the tools work keyless without them). You can obtain them all in one sitting and paste them in together (see *How to set* below).

## Required keys (${required.length}) — the tool THROWS without these

${table(required)}

Checklist:
${checklist(required)}

## Optional keys (${optional.length}) — only raise a rate limit / unlock a filter (tools work keyless without them)

${table(optional)}

Checklist:
${checklist(optional)}

## How to set (once you have the keys)

Getting each key (creating the free account at its signup URL) is **your** step — the server automates *discovery* (\`api_key_status\`) and *configuration* (\`.env\` auto-load), never signup. Set them either way:

**A) Host environment variables** — set \`ENV_VAR=value\` in the server's environment.

**B) A \`.env\` file** in the server's working directory (auto-loaded at startup; a real env var always wins over \`.env\`):

\`\`\`dotenv
${[...required, ...optional].map((k) => `${k.envVar}=`).join("\n")}
\`\`\`

Then call \`api_key_status\` to confirm each shows \`currentlySet: true\` (the value is never echoed back). To verify a key actually *works*, call that source's own tool.
`;
}

// ─── main: write the file (skipped when imported by the guard) ───
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { KEY_REGISTRY } = await import(pathToFileURL(resolve(HERE, "..", "dist", "keys.js")).href);
  const md = renderApiKeysMd(KEY_REGISTRY);
  writeFileSync(OUT_PATH, md, "utf8");
  // Report a short summary (no secrets — registry carries none).
  const req = KEY_REGISTRY.filter((k) => k.required).length;
  console.log(`API_KEYS.md written: ${KEY_REGISTRY.length} keys (${req} required, ${KEY_REGISTRY.length - req} optional).`);
  // Touch readFileSync so an unused-import lint never trips (defensive; also lets a
  // future --check mode compare without a second import).
  void readFileSync;
}
