/**
 * USITC Harmonized Tariff Schedule (HTS) — the IMPORT-TARIFF / supply-chain PRICE
 * lane on a NEW keyless REST source (ADR-0039). Source #30; tool snapshot 102 →
 * 103. A Price-lane sibling of pricing.ts: it extends the THIN Price lane with a
 * NON-labor cost input — a good's HTS classification + its Column-1 General /
 * Special (preferential/FTA) / Column-2 duty-rate TEXT + the Section 301/232 /
 * Chapter-99 additional-duty provisions. Fully PUBLIC open data; KEYLESS (no key,
 * no header gate); no PII (product/tariff/classification data only).
 *
 * ONE tool — `hts_lookup`: a single `query` (a KEYWORD or an HTS NUMBER — both
 * ride `keyword=`) → the matching classification rows across the HTS hierarchy.
 *   Wire: GET https://hts.usitc.gov/reststop/search?keyword=<query>
 *   Body: a BARE JSON ARRAY (NO envelope, NO total, NO server pagination) of rows
 *   { htsno, statisticalSuffix, description, indent, units[], footnotes[],
 *     general, other, special, additionalDuties, quotaQuantity, effectivePeriod,
 *     status, … }.
 *
 * ★ THE DUTY-RATE HONESTY CRUX (P0 — load-bearing).
 * `general` (Column-1 General), `special` (Special/preferential), `other`
 * (Column-2) are AUTHORITATIVE VERBATIM TEXT — surfaced via `str` (trim only),
 * NEVER via `num`. `num("Free")`→null, `num("35%")`→NaN→null; a coerced 0/null
 * would render a FALSE "duty-free" (the money-lie class, inverted — here the
 * authoritative value IS text and coercion DESTROYS it). This module deliberately
 * does NOT import `num`, so no rate field can ever be numeric (the absence of
 * `num` is itself the guard; ofac.ts/pricing.ts omit it too). An empty `special`
 * ("") → str→null, disclosed as "no special-program rate" — NEVER read as Free.
 *
 * HONESTY (writes ZERO fetch/coerce/error/meta code — REUSES getJson/throughGate/
 * driftError + coerce.str + withMeta/buildMeta):
 *   P1 (completeness) — NO upstream total + NO server pagination (the `offset`
 *      param is IGNORED). `totalAvailable = served array.length` (the EXACT count
 *      the endpoint served — honest relative to what the source returns); paging is
 *      CLIENT-SIDE over the held array (never trust a server offset). The M2
 *      disclosure states there is no fixed cap and a single-char/common fragment
 *      can serve 10,000–16,000+ rows (several MB).
 *   ★M1 (hierarchy) — the duty rate is stated ONCE at a shallower level (usually the
 *      6/8-digit subheading) and inherits DOWNWARD to the blank statistical-suffix
 *      lines. A header/blank row's empty rate stays `null` (never fabricated); the
 *      hierarchy note tells the consumer to read UP to the nearest ANCESTOR line
 *      (SHALLOWER indent, same htsno prefix) with a non-empty rate — never to read
 *      the (blank) deepest line as no/unknown duty.
 *   ★M2 (no false ceiling) — the completeness note NEVER claims a "~900" cap; a
 *      MINIMUM query floor (≥3 non-whitespace chars) rejects a 1–2 char query as
 *      invalid_input BEFORE the fetch (closes the multi-MB "s"/"e" path); a
 *      belt-and-suspenders size bound (HTS_MAX_ROWS) discloses a very-large result.
 *   P2 (empty-vs-outage) — a no-match `[ ]` (HTTP 200) ⇒ honest empty; a
 *      400(→S2)/404/5xx/timeout/non-array/HTML(SyntaxError→schema_drift) ⇒ THROW
 *      (never a fake empty). The SyntaxError→schema_drift wrap mirrors fdic.ts.
 *   ★S1 (additionalDuties) — the per-line `additionalDuties` field is frequently
 *      null even when Section 301/232 duties apply; the additional duty rides the
 *      separate Chapter-99 (`isChapter99`) rows + the footnotes — disclosed.
 *   ★S2 (transient 400) — the query is PRE-VALIDATED (≥3 chars, control-stripped,
 *      ≤100), so an HTTP 400 is not a caller fault: it is remapped to
 *      upstream_unavailable (transient, retryable) for this source.
 *   ★S3 (fieldsUnavailable) — per-line empty rate fields are NOT hoisted into
 *      top-level `_meta.fieldsUnavailable` (rate nullity is per-line-normal per M1);
 *      that field is reserved for a field genuinely absent across the WHOLE response.
 *
 * SSRF — fixed host `hts.usitc.gov` (compile-time constant + Set.has recheck),
 * FIXED path `/reststop/search` (never caller free-text), the `query` value rides
 * `keyword=` via URLSearchParams (percent-encoded — a crafted `../exportList` /
 * `x&format=…` / off-host value cannot alter the host/path or inject a param); the
 * value is control-stripped + length-bounded (≥3, ≤100); a post-construction
 * hostname/protocol assert + `redirect:"error"` fail closed.
 *
 * Not-a-customs-ruling caveat (the Price-lane honesty boundary — the analog of
 * pricing.ts's "not the rate paid" + the FAC/OFAC *_NOT_DETERMINATION_NOTE): every
 * response carries HTS_NOT_A_RULING_NOTE.
 */
import { type MetaBundle } from "./meta.js";
export declare const USITC_HOSTS: readonly ["hts.usitc.gov"];
export type UsitcHost = (typeof USITC_HOSTS)[number];
export declare const HTS_MAX_ROWS = 5000;
/**
 * ★ The mandatory not-a-customs-ruling caveat carried on EVERY hts_lookup response
 * (mirrors pricing.ts's CALC caveats + FAC_NOT_DETERMINATION_NOTE /
 * OFAC_NOT_DETERMINATION_NOTE). Kept verbatim so the fault suite can assert it.
 */
export declare const HTS_NOT_A_RULING_NOTE = "Harmonized Tariff Schedule data (USITC HTS). These are the PUBLISHED schedule rates \u2014 Column-1 General, Special (preferential/FTA), and Column-2 \u2014 NOT a binding CBP classification ruling and NOT a landed-cost quote. The duty actually owed depends on the good's correct classification, its COUNTRY OF ORIGIN, the applicable trade program/FTA, and ADDITIONAL duties (Section 301/232, antidumping/countervailing, and any Chapter 99 [`99..`] provisions returned alongside the base line). Rate values are VERBATIM text (`Free`, a percentage, a specific `$/unit`, or a compound rate) \u2014 read them in context, never as a bare number. Confirm the classification and obtain a binding ruling via CBP (CROSS / eRulings) before pricing an import.";
/**
 * ★M1 — the hierarchy rate-inheritance disclosure. The rate inherits DOWNWARD; the
 * consumer must read UP to the nearest ANCESTOR line (NOT the blank deepest line).
 * Carried on EVERY response. RED if this ever says "read the deepest line".
 */
export declare const HTS_HIERARCHY_NOTE = "A lookup returns rows across hierarchy levels. The duty rate is stated at one level (usually the 6/8-digit subheading) and APPLIES TO ALL DEEPER statistical-suffix lines below it, which are typically blank. To find the rate for a specific statistical line, read UP to the nearest ANCESTOR line (SHALLOWER indent, same htsno prefix) that has a non-empty rate \u2014 never conclude a blank deepest line means no/unknown duty.";
/**
 * ★M2 — the completeness disclosure. NO server total, NO working pagination (the
 * `offset` param is ignored); `totalAvailable` is the EXACT served array length;
 * paging is client-side. NO "~900" ceiling — a single-char/common fragment can
 * serve 10,000–16,000+ rows / several MB. Carried on EVERY response.
 */
export declare const HTS_COMPLETENESS_NOTE = "The USITC HTS search endpoint returns the FULL match set for a query with NO server-side total and NO working pagination (the `offset` param is IGNORED); `totalAvailable` is the EXACT length of the array the endpoint served for this query, and paging is applied CLIENT-SIDE over that held array. There is NO fixed row cap \u2014 a single-character or common fragment can return 10,000\u201316,000+ rows (several MB) in one response \u2014 so narrow the query (a more specific keyword or a fuller HTS number) for a targeted classification.";
/**
 * ★S1 / P4 — the additional-duty disclosure. `additionalDuties` is frequently null
 * even when Section 301/232 duties apply; the real additional duty rides the
 * Chapter-99 rows + the footnotes. Carried on EVERY response.
 */
export declare const HTS_ADDITIONAL_DUTY_NOTE = "The per-line `additionalDuties` field is frequently null even when Section 301/232 additional duties apply \u2014 it is NOT a reliable signal for their absence. Additional duties are carried by the separate Chapter-99 rows (`isChapter99:true`, htsno beginning `99`) returned alongside the base line and by the per-line `footnotes`; check those, not `additionalDuties`. A Chapter-99 provision STACKS on top of the base-line rate \u2014 the base classification's landed duty is NOT complete without checking them.";
/** Conditional — surfaced when a returned line has an empty Special rate. */
export declare const HTS_EMPTY_SPECIAL_NOTE = "One or more lines have an empty Special (preferential/FTA/GSP) rate, surfaced as `specialPreferential: null` \u2014 this means NO special-program rate is published for that line (the Column-1 General rate applies unless a specific trade program qualifies). An empty/null Special is NEVER 'Free'.";
/** Conditional — surfaced when a returned line is a Chapter-99 provision. */
export declare const HTS_CHAPTER99_PRESENT_NOTE = "This result set includes Chapter-99 rows (`isChapter99:true`, htsno beginning `99`) \u2014 ADDITIONAL-duty provisions (Section 301/232, safeguards, temporary/other special duties) that STACK on top of the base-line rate; include them when computing landed duty.";
/** ★M2 belt — surfaced when the served array exceeds HTS_MAX_ROWS. */
export declare const HTS_LARGE_RESULT_NOTE: string;
/** Conditional — surfaced when a returned description had `<il>` markup stripped. */
export declare const HTS_MARKUP_NOTE = "Line descriptions had USITC inline markup (`<il>\u2026</il>`) stripped to plain text (the inner text is preserved); the semantic content is unchanged.";
export type HtsLine = {
    htsno: string | null;
    statisticalSuffix: string | null;
    indent: string | null;
    description: string | null;
    units: string[];
    /** Column-1 General duty rate — VERBATIM TEXT (str only; NEVER a number). */
    columnOneGeneral: string | null;
    /** Special (preferential/FTA/GSP) rate — VERBATIM TEXT; "" → null = none published. */
    specialPreferential: string | null;
    /** Column-2 (statutory/non-NTR) rate — VERBATIM TEXT (str only; NEVER a number). */
    columnTwo: string | null;
    additionalDuties: string | null;
    /** Per-line footnote markers, passed through verbatim (deeper decode deferred). */
    footnotes: unknown[];
    quotaQuantity: string | null;
    /** Effective-period block, passed through verbatim. */
    effectivePeriod: unknown;
    status: string | null;
    /** Derived: htsno begins "99" — a Chapter-99 additional-duty provision. */
    isChapter99: boolean;
};
export type HtsLookupArgs = {
    query: string;
    limit?: number;
    offset?: number;
};
/**
 * hts_lookup — keyless USITC HTS classification + duty-rate lookup. A single
 * `query` (a keyword OR an HTS number) → the matching classification rows across
 * the hierarchy, with the Column-1 General / Special / Column-2 duty-rate TEXT +
 * the Chapter-99 additional-duty provisions. The full array is fetched ONCE and
 * paginated CLIENT-SIDE (the server serves no total and ignores `offset`).
 */
export declare function htsLookup(args: HtsLookupArgs): Promise<MetaBundle>;
//# sourceMappingURL=usitc.d.ts.map