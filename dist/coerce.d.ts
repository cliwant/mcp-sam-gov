/**
 * coerce.ts — the honesty-critical value coercions shared across the keyless
 * DataSources (ADR-0005 v2 FIX-C: map-layer primitives, split out of the
 * fetch-envelope port so each module stays single-concern).
 *
 * `num`/`str` return **null (NEVER 0 / never a fabricated string)** for absent
 * values — a missing amount is an honest "unknown", never a data-absence-as-zero
 * masquerade (the project's forbidden failure class). This is the single most
 * duplicated honesty primitive across the sources; hoisting ONE audited copy
 * removes the 3-way drift risk (a `num` regression now fails Treasury AND Socrata
 * suites at once instead of silently in one).
 *
 * Byte-identical to Treasury's + Socrata's prior LOCAL copies:
 *   - `num` is identical in both (and, per ADR-0005 v2, output-equivalent to
 *     EDGAR's — "NULL" etc. reach null via Number(...)=NaN either way).
 *   - `str` adopts the Treasury/Socrata convention (null for ""/"null"). It is
 *     output-identical to BOTH over their real input domains. EDGAR's `str` does
 *     NOT null the literal "null" (ADR-0005 v2 FIX-A), so EDGAR keeps its own
 *     local `str` and is NOT migrated here (EDGAR is deferred anyway per FIX-B).
 */
/**
 * Coerce an inconsistently-typed value field to `number | null`.
 *
 * Returns **null (NEVER 0)** for absent values: `null`/`undefined`, the literal
 * string `"null"`, `""`/whitespace (CRITICAL — `Number("")` is 0, so this MUST
 * be caught explicitly), and the `"(-)"`/`"-"` placeholders. Numeric strings
 * parse; numbers pass through (a non-finite number → null).
 */
export declare function num(x: unknown): number | null;
/** null for absent (null/undefined/""/whitespace/"null"), else the trimmed string. */
export declare function str(x: unknown): string | null;
//# sourceMappingURL=coerce.d.ts.map