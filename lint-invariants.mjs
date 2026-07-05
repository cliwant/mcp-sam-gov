// Structural guard for the core truthfulness invariant (QUALITY_BAR T4).
//
// Invariant: a non-2xx HTTP response must THROW a classified error (or disclose
// degradation), NEVER silently return an empty value — an empty return on the
// `!res.ok` path reads to an AI consumer as "absent" when the service is merely
// DOWN (the fetch-failure-as-absent masquerade the C25/C31 sweep eliminated).
//
// This is a HEURISTIC lint (not full AST): it flags an `if (!X.ok)` guard whose
// body returns an empty literal ([]/{}/""/{k:[]}) before any `throw`. It catches
// the common single-line and short-block reintroductions; it is intentionally
// narrow (targets only the `!*.ok` guard) so it has zero false positives on
// legitimate genuine-empty or disclosed-empty returns elsewhere. Passes the
// current tree (all `!r.ok` guards throw); a reintroduction turns CI red.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const EMPTY = /return\s*(\[\s*\]|\{\s*\}|""|''|\{[^{}]*:\s*\[\s*\]\s*\})\s*(;|\}|$)/;
const OK_GUARD = /if\s*\(\s*!\s*[\w.]+\.ok\s*\)/;
const WINDOW = 8;

function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const files = tsFiles("src");
const violations = [];
for (const file of files) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!OK_GUARD.test(lines[i])) continue;
    // Single-line: `if (!x.ok) return []`
    if (EMPTY.test(lines[i]) && !/throw/.test(lines[i])) {
      violations.push({ file, line: i + 1, text: lines[i].trim() });
      continue;
    }
    // Short-block: `if (!x.ok) {` … a return-empty before any throw or block close
    if (/\{\s*$/.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 1 + WINDOW, lines.length); j++) {
        if (/\bthrow\b/.test(lines[j])) break; // discloses via throw → OK
        if (EMPTY.test(lines[j])) { violations.push({ file, line: j + 1, text: lines[j].trim() }); break; }
        if (/^\s*\}/.test(lines[j])) break; // block closed without empty-return → OK
      }
    }
  }
}

if (violations.length) {
  console.error(`✗ truthfulness lint: ${violations.length} silent-empty-on-error violation(s) — a non-2xx must THROW/disclose, never return empty:`);
  for (const v of violations) console.error(`    ${v.file}:${v.line}  ${v.text}`);
  process.exit(1);
}
console.log(`✓ truthfulness lint: 0 silent-empty-on-error (\`if(!x.ok) return <empty>\`) across ${files.length} src files`);
