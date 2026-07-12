/**
 * disclosure.ts — the single audited disclosure-note TOKENIZER shared across the
 * keyless DataSources (ADR-0022: an honesty-layer primitive, split into its own
 * tiny single-concern module — the sibling of coerce.ts's map-layer primitives).
 *
 * WHY IT EXISTS: two independent sources (NSF Awards C108 = the OR-note,
 * ClinicalTrials.gov C109 = the AND-note) each built a mandatory multi-token
 * disclosure note from the SAME character-for-character delimiter class, and
 * adversarial verification caught the SAME latent gap on BOTH — a whitespace-only
 * `.split(/\s+/)` misses the API's PUNCTUATION delimiters, so a compound that only
 * LOOKS like one token ("coral-reef" = coral OR reef; "Sanofi-Aventis" = Sanofi
 * AND Aventis) leaks through and the mandatory note is silently SKIPPED. Hoisting
 * ONE audited tokenizer removes the drift risk (a class regression now fails NSF
 * AND ClinicalTrials suites at once instead of silently in one) and gives the lint
 * guardrail (lint-invariants.mjs) + the parity fault test a single home to point
 * at: "the ONLY sanctioned way to tokenize a disclosure value lives here."
 *
 * THE CLASS (`DISCLOSURE_SPLIT_RE`) is the PRECISE ES/Essie confirmed-splitter set,
 * live-verified byte-identically on BOTH sources 2026-07-12:
 *   - SPLIT (→ multi-token, the note fires): whitespace + `- , / ; + & | @ # =`
 *   - DO NOT split (→ one token, no note):   `. : _ '`  (NSF also `\` `*`)
 * It is deliberately NOT a `[^A-Za-z0-9]+` superset — that would over-disclose a
 * split the APIs did NOT make on `.`/`_`/`'` (a fabricated union/conjunction). `-`
 * is placed LAST (a literal, not a range); `/` is escaped for the regex delimiter.
 *
 * NOTE-AGNOSTIC BY DESIGN: this returns ONLY the token array. The `.length > 1`
 * decision, the per-source note WORDING (NSF = OR-union, ClinicalTrials = AND
 * co-occurrence), and any downstream suppression (ClinicalTrials' sponsor
 * broadening-note) stay in each CALLER — they are genuinely source-specific and do
 * NOT belong to the tokenizer.
 *
 * THE OPTIONAL `splitRe` PARAM is the sanctioned, honest escape hatch: a FUTURE
 * source whose analyzer genuinely splits on a DIFFERENT class routes through THIS
 * helper with its own `splitRe` (explicit, greppable, reviewable) rather than
 * re-inlining a raw `.split(/\s+/)`. That is exactly what lets the lint ban the
 * bare whitespace split outright (there is one sanctioned tokenizer, not many).
 *
 * No new dep, no I/O, pure function — the exact shape of a coerce.ts primitive.
 */
/**
 * The shared ES/Essie confirmed-splitter class (byte-identical to NSF's former
 * `NSF_KEYWORD_SPLIT_RE` and ClinicalTrials' former `CT_TOKEN_SPLIT_RE`). Stateless
 * (no `/g`), so a single module-level RegExp is safe to share across callers.
 */
export const DISCLOSURE_SPLIT_RE = /[\s,;+&|@#=\/-]+/;
/**
 * Tokenize a disclosure value for a multi-token honesty note: trim, split on the
 * confirmed-splitter class (default `DISCLOSURE_SPLIT_RE`), and drop empty tokens.
 * Returns ONLY the token array — the caller owns the `.length > 1` gate + note
 * wording. `tokenizeForDisclosure("coral-reef")` → `["coral", "reef"]`;
 * `tokenizeForDisclosure("web_service")` → `["web_service"]` (the class does NOT
 * split `_`); `tokenizeForDisclosure("robotics")` → `["robotics"]`.
 */
export function tokenizeForDisclosure(value, splitRe = DISCLOSURE_SPLIT_RE) {
    return value.trim().split(splitRe).filter((t) => t.length > 0);
}
//# sourceMappingURL=disclosure.js.map