// Structural guards for the core honesty invariants (QUALITY_BAR T4). TWO checks,
// ONE entry point (`npm run lint:invariants` / `node lint-invariants.mjs`):
//
//  (1) TRUTHFULNESS — a non-2xx HTTP response must THROW a classified error (or
//      disclose degradation), NEVER silently return an empty value. An empty return
//      on the `!res.ok` path reads to an AI consumer as "absent" when the service is
//      merely DOWN (the fetch-failure-as-absent masquerade the C25/C31 sweep killed).
//      Flags an `if (!X.ok)` guard whose body returns an empty literal ([]/{}/""/{k:[]})
//      before any `throw`.
//
//  (2) DISCLOSURE-TOKENIZER (ADR-0022) — a source must NOT build a multi-token
//      DISCLOSURE note from a WHITESPACE-ONLY split. The APIs (NSF's ES analyzer,
//      ClinicalTrials' Essie) tokenize on whitespace AND PUNCTUATION, so a compound
//      that only LOOKS like one token ("coral-reef" = coral OR reef; "Sanofi-Aventis"
//      = Sanofi AND Aventis) leaks through a `.split(/\s+/)` and the mandatory note
//      is silently SKIPPED — the SAME latent gap adversarial verification caught on
//      TWO sources (NSF C108, ClinicalTrials C109). The ONLY sanctioned tokenizer is
//      `tokenizeForDisclosure` (src/disclosure.ts). This rule flags a WHITESPACE-ONLY
//      split — a bare `.split(/\s+/)`/`.split(/ /)`/`.split(/[ \t]+/)`/`.split(" ")`
//      LITERAL *and* a same-file named-const ALIAS (`const X = /\s+/; … .split(X)`,
//      the very idiom NSF/CT used) — that sits in a DISCLOSURE WINDOW (a
//      `.length > 1`/`>= 2`/`!== 1` token-count gate near a disclosure keyword). The
//      punctuation class `DISCLOSURE_SPLIT_RE` (it carries non-whitespace delimiter
//      members) and any `tokenizeForDisclosure(...)` call are exempt; a
//      `// disclosure-split-ok:` marker (with a reason) allowlists a verified
//      whitespace-only source (the grants.gov case — its analyzer really is
//      whitespace-only).
//
// Both checks are HEURISTIC line-window lints (not full AST), intentionally narrow
// so they have ZERO false positives on the current tree. A reintroduction turns CI
// red.
//
// HONEST RESIDUAL — what check (2) does NOT catch (it is a guardrail, NOT a proof of
// universal absence; do not overstate it):
//   - a FULLY DYNAMIC split whose delimiter is computed at runtime — `new RegExp(...)`,
//     a pattern built by string concatenation, a split-regex passed in as a parameter,
//     or one IMPORTED from another module — the classifier only reasons about in-file
//     regex/string literals and same-file `const` aliases;
//   - a disclosure gate/keyword sitting FARTHER than DISCLOSURE_WINDOW lines away;
//   - a note built with NO `.length > 1`/`>= 2`/`!== 1` token-count gate.
//   These are accepted: the goal is to stop the specific whitespace-only recurrence
//   and to force new sources through the single sanctioned tokenizeForDisclosure —
//   the parity/behavioral fault tests (§54) cover the "silent local fork" hole the
//   lint cannot see.
import { readFileSync, readdirSync, statSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// ─── Check (1): truthfulness (silent-empty on the !ok path) ─────────
const EMPTY = /return\s*(\[\s*\]|\{\s*\}|""|''|\{[^{}]*:\s*\[\s*\]\s*\})\s*(;|\}|$)/;
const OK_GUARD = /if\s*\(\s*!\s*[\w.]+\.ok\s*\)/;
const OK_WINDOW = 8;

/** Truthfulness violations for ONE file's text (pure — no I/O). */
export function findTruthfulnessViolations(text, file) {
  const lines = text.split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (!OK_GUARD.test(lines[i])) continue;
    // Single-line: `if (!x.ok) return []`
    if (EMPTY.test(lines[i]) && !/throw/.test(lines[i])) {
      violations.push({ file, line: i + 1, text: lines[i].trim() });
      continue;
    }
    // Short-block: `if (!x.ok) {` … a return-empty before any throw or block close
    if (/\{\s*$/.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 1 + OK_WINDOW, lines.length); j++) {
        if (/\bthrow\b/.test(lines[j])) break; // discloses via throw → OK
        if (EMPTY.test(lines[j])) { violations.push({ file, line: j + 1, text: lines[j].trim() }); break; }
        if (/^\s*\}/.test(lines[j])) break; // block closed without empty-return → OK
      }
    }
  }
  return violations;
}

// ─── Check (2): disclosure-tokenizer (ADR-0022, M1) ─────────────────
const SPLIT_CALL = /\.split\(\s*([^)]*?)\s*\)/g;
// A same-file `const/let/var IDENT = /SOURCE/flags;` regex declaration. The SOURCE
// capture `(?:\\.|[^/\\])+` steps over escaped chars (so a `\/` inside the class
// does not close the literal early).
const CONST_REGEX = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\/((?:\\.|[^/\\])+)\/[a-z]*\s*;/;
const REGEX_LITERAL = /^\/((?:\\.|[^/\\])+)\/[a-z]*$/;
const STRING_LITERAL = /^(["'])([\s\S]*)\1$/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// A multi-token disclosure gate: > 1 / >= 2 / !== 1 / != 1 on a token count.
const TOKEN_GATE = /\.length\s*(?:>\s*1|>=\s*2|!==?\s*1)\b/;
// A disclosure keyword in the window (the second independent signal that drives
// false positives to zero — an unrelated whitespace split merely testing `.length`
// is not flagged unless it is textually in a disclosure context).
const DISCLOSURE_CTX = /note|Note|disclos|tokeniz|OR-match|OR-|AND-|_meta|co-occur|UNION|multi-word/;
const MARKER = /disclosure-split-ok:/;
const DISCLOSURE_WINDOW = 6;

/**
 * Does a regex-literal SOURCE (the text between the slashes, e.g. `\s+`, `[ \t]+`,
 * `[\s,;+&|@#=\/-]+`) split on WHITESPACE ONLY? A mixed class carrying real
 * punctuation members (the sanctioned DISCLOSURE_SPLIT_RE) returns false — it is
 * NOT a whitespace-only split — as does a negated class or any non-class pattern.
 */
export function isWhitespaceOnlySplitSource(src) {
  const s = src.trim();
  if (s === "") return false;
  // bare \s with an optional quantifier: \s \s+ \s* \s?
  if (/^\\s[+*?]?$/.test(s)) return true;
  // a single literal space with an optional quantifier
  if (/^ [+*?]?$/.test(s)) return true;
  // a character class whose members are ONLY whitespace tokens: [\s] [\s]+ [ \t]+ …
  const m = s.match(/^\[(\^?)([\s\S]*)\][+*?]?$/);
  if (m) {
    if (m[1] === "^") return false; // a negated class is not a whitespace-only splitter
    const inner = m[2];
    const stripped = inner
      .replace(/\\[stnrfv]/g, "") // \s \t \n \r \f \v escapes
      .replace(/[ \t]/g, ""); // literal space / tab inside the class
    return inner.length > 0 && stripped.length === 0;
  }
  return false;
}

/** Is a string-literal CONTENT whitespace-only (e.g. `" "`, `"\t"`)? "" → false. */
function isWhitespaceOnlyString(content) {
  const unescaped = content
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");
  return unescaped.length > 0 && /^\s+$/.test(unescaped);
}

/** Is a `.split(ARG)` argument a whitespace-only splitter (literal/string/alias)? */
function isWhitespaceOnlySplitArg(arg, wsOnlyConsts) {
  let m;
  if ((m = arg.match(REGEX_LITERAL))) return isWhitespaceOnlySplitSource(m[1]);
  if ((m = arg.match(STRING_LITERAL))) return isWhitespaceOnlyString(m[2]);
  if (IDENTIFIER.test(arg)) return wsOnlyConsts.has(arg); // named-const ALIAS (M1)
  return false; // a dynamic expression (new RegExp(...), a param, an import) — residual
}

/**
 * Disclosure-tokenizer violations + active opt-outs for ONE file's text (pure — no
 * I/O). A whitespace-only split (literal OR same-file whitespace-only const alias)
 * within a disclosure window (token-count gate + disclosure keyword) is a violation
 * unless a `// disclosure-split-ok:` marker sits in the window.
 */
export function findDisclosureSplitViolations(text, file) {
  const lines = text.split(/\r?\n/);
  // Pass 1 — collect the same-file WHITESPACE-ONLY const-regex aliases (a punctuation
  // class like DISCLOSURE_SPLIT_RE is NOT collected: it carries non-ws members).
  const wsOnlyConsts = new Set();
  for (const line of lines) {
    const m = CONST_REGEX.exec(line);
    if (m && isWhitespaceOnlySplitSource(m[2])) wsOnlyConsts.add(m[1]);
  }
  // Pass 2 — flag whitespace-only .split(...) calls inside a disclosure window.
  const violations = [];
  const optOuts = [];
  for (let i = 0; i < lines.length; i++) {
    SPLIT_CALL.lastIndex = 0;
    let sm;
    while ((sm = SPLIT_CALL.exec(lines[i])) !== null) {
      const arg = sm[1].trim();
      if (!isWhitespaceOnlySplitArg(arg, wsOnlyConsts)) continue;
      const lo = Math.max(0, i - DISCLOSURE_WINDOW);
      const hi = Math.min(lines.length - 1, i + DISCLOSURE_WINDOW);
      // A `// disclosure-split-ok:` marker in the window allowlists this site.
      let markerLine = -1;
      for (let j = lo; j <= hi; j++) {
        if (MARKER.test(lines[j])) { markerLine = j; break; }
      }
      if (markerLine !== -1) {
        const reason = (lines[markerLine].split("disclosure-split-ok:")[1] ?? "").trim();
        optOuts.push({ file, line: i + 1, reason });
        continue;
      }
      // Two independent signals in the window ⇒ a genuine disclosure split.
      let hasGate = false;
      let hasCtx = false;
      for (let j = lo; j <= hi; j++) {
        if (TOKEN_GATE.test(lines[j])) hasGate = true;
        if (DISCLOSURE_CTX.test(lines[j])) hasCtx = true;
      }
      if (hasGate && hasCtx) {
        violations.push({ file, line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return { violations, optOuts };
}

// ─── CLI runner (entry-point-gated — see the isMain() note below) ───
function tsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function runCli() {
  const files = tsFiles("src");
  let failed = false;

  // Check (1) — truthfulness.
  const tViol = [];
  for (const file of files) tViol.push(...findTruthfulnessViolations(readFileSync(file, "utf8"), file));
  if (tViol.length) {
    console.error(`✗ truthfulness lint: ${tViol.length} silent-empty-on-error violation(s) — a non-2xx must THROW/disclose, never return empty:`);
    for (const v of tViol) console.error(`    ${v.file}:${v.line}  ${v.text}`);
    failed = true;
  } else {
    console.log(`✓ truthfulness lint: 0 silent-empty-on-error (\`if(!x.ok) return <empty>\`) across ${files.length} src files`);
  }

  // Check (2) — disclosure-tokenizer.
  const dViol = [];
  const optOuts = [];
  for (const file of files) {
    const r = findDisclosureSplitViolations(readFileSync(file, "utf8"), file);
    dViol.push(...r.violations);
    optOuts.push(...r.optOuts);
  }
  // Print active opt-outs so an allowlisted whitespace-split stays visible in CI.
  if (optOuts.length) {
    console.log(`ℹ disclosure-tokenizer lint: ${optOuts.length} active \`// disclosure-split-ok:\` opt-out(s) (whitespace-split disclosure sites intentionally allowlisted):`);
    for (const o of optOuts) console.log(`    ${o.file}:${o.line}  — ${o.reason}`);
  }
  if (dViol.length) {
    console.error(`✗ disclosure-tokenizer lint: ${dViol.length} whitespace-only disclosure split(s) — use tokenizeForDisclosure (src/disclosure.ts, ADR-0022) so a punctuation-delimited compound (a-b, a,b, a/b) is not silently missed. If the source's analyzer is genuinely whitespace-only, route through tokenizeForDisclosure(value, /\\s+/) and add \`// disclosure-split-ok: <verified-reason>\`:`);
    for (const v of dViol) console.error(`    ${v.file}:${v.line}  ${v.text}`);
    failed = true;
  } else {
    console.log(`✓ disclosure-tokenizer lint: 0 whitespace-only multi-token disclosure splits across ${files.length} src files (the only sanctioned tokenizer is tokenizeForDisclosure; ${optOuts.length} allowlisted opt-out(s))`);
  }

  if (failed) process.exit(1);
}

// Entry-point-gated (mirrors dist/server.js): run the CLI only when this file is
// invoked DIRECTLY (`node lint-invariants.mjs`), NEVER on import — the fault suite
// (§54) imports the pure detectors above and must not trigger a filesystem scan /
// process.exit. Realpath both sides so a symlinked invocation still matches.
function isMain() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const canonical = (p) => {
    try {
      return pathToFileURL(realpathSync(p)).href;
    } catch {
      return pathToFileURL(p).href;
    }
  };
  try {
    return canonical(argv1) === canonical(fileURLToPath(import.meta.url));
  } catch {
    return import.meta.url === pathToFileURL(argv1).href;
  }
}

if (isMain()) runCli();
