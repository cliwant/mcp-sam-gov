/**
 * NSF Awards API — federal research-GRANT award records (keyless).
 *
 * Source #20 on the R2 `getJson` port (ADR-0020). A recipient/PI/**UEI**-keyed
 * research-funding footprint from `https://api.nsf.gov/services/v1/awards.json`,
 * the grant-SIBLING of NIH RePORTER (ADR-0014) on a DIFFERENT agency. It
 * strengthens the WEAK entity/recipient layer (C83) with a UEI-keyed recipient
 * graph: `ueiNumber` / `parentUeiNumber` join to the SAM/USAspending recipient
 * space (same UEI space) — but the award nature DIFFERS (grants fund research,
 * not goods/services), so every response carries the grant-vs-contract caveat.
 *
 * ON-DOMAIN HONESTY: this is research-funding / grants-adjacent recipient
 * enrichment — NOT core procurement. Positioned as a recipient-graph / R&D
 * market-intel source, never as a contract source.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error", no method/body — a plain GET) / `driftError` / `num`·`str`
 * (coerce.ts, null-never-0) / `withMeta`·`buildMeta`, and COPIES (does NOT
 * import) the fixed-host SSRF idiom from ECHO + the `boolOrNull` helper from NIH.
 *
 * ★ SSRF GUARD (policy① — the ECHO/CKAN fixed-host pattern): the request host +
 *   path are compile-time CONSTANTS; NO caller value touches them. Every filter
 *   rides in a MODULE-BUILT `URLSearchParams` (each value URLSearchParams-encoded)
 *   assembled key-by-key from the validated typed args — there is NO raw-query
 *   passthrough, so a caller value cannot break out of its param into the host /
 *   path / another param (LIVE-verified 2026-07-12: `keyword=robotics%26agency=
 *   NASA` keeps the `&` inside the value — no param split). A post-construction
 *   hostname/protocol assertion + `redirect:"error"` lock it (fail closed on any
 *   off-host 3xx; its body is never read). `id` is numeric-only.
 *
 * ★ THE THREE HONESTY FACTS (LIVE-verified 2026-07-12, keyless plain GET):
 *   1. `metadata.totalCount` is EXACT below 10,000 and SATURATES at 10,000 (an
 *      Elasticsearch `track_total_hits` cap). So `< 10000` ⇒ EXACT; `=== 10000`
 *      ⇒ a disclosed LOWER BOUND (`totalIsLowerBound:true` — the true total is
 *      unknown and ≥ 10,000, and only the first 10,000 are retrievable); `0` ⇒ a
 *      genuine empty. (robotics=9038, ueiNumber=FTMTDMBR29C7=3396 all-JHU,
 *      cryptography=2598, dates 2024=369 — all EXACT; unfiltered / university /
 *      science / quantum / awardeeName=JHU all =10000.)
 *   2. The retrieval window is `offset + rpp ≤ 10,000` (P13 confirmed:
 *      offset=9980&rpp=20 OK, offset=9981&rpp=20 → FATAL AwardAPI-004). The
 *      reachable slice and the count floor coincide at exactly 10,000.
 *   3. Errors are BODY-level loud-fails at HTTP 200 (P4/P12): a bad param ⇒
 *      `serviceNotification` ERROR/FATAL with `metadata` DROPPED. `getJson` will
 *      NOT throw on these (200 parses) — so the handler inspects
 *      `serviceNotification` and THROWS, NEVER reads the empty `award:[]` as a
 *      genuine result. Genuine-empty is the DISTINCT `totalCount:0`-with-no-
 *      notification shape.
 *
 * ★ [M1] MULTI-TOKEN KEYWORD OR-TOKENIZATION (normative disclosure): NSF's ES
 *   analyzer OR-splits a `keyword` into tokens and matches ANY of them (a UNION),
 *   not the phrase — and it splits on whitespace AND PUNCTUATION, not whitespace
 *   alone (LIVE-verified: cryptography=2598 + volcano=1655 → "cryptography volcano"
 *   =4253; and the hyphen/comma/slash/semicolon/plus/&/|/@/#/= forms all return the
 *   SAME OR union — while `.`/`:`/`_`/`'`/`\`/`*` do NOT split, and `~`/`(`/`)`
 *   loud-fail). The honest-looking (often saturated) totalCount + rows carry NO
 *   signal the tokens were unioned, so when `keyword` contains ANY confirmed
 *   splitter (NSF_KEYWORD_SPLIT_RE — whitespace + the confirmed punctuation set,
 *   NOT just whitespace) the module emits a MANDATORY `_meta.notes` line disclosing
 *   the OR-semantics. This closes the compound-token leak (e.g. "coral-reef" =
 *   coral OR reef, a far broader set than a caller intends).
 *
 * ★ AMOUNTS are STRINGS → `coerce.num` (null-never-0): a real $0 → 0; absent/""/
 *   "null" → null (NEVER 0). `fundsObligatedAmt` (obligated to date) and
 *   `estimatedTotalAmt` (estimated total life value) are labeled distinctly.
 *
 * ★ `piMiddeInitial` is copied VERBATIM — the source key is genuinely misspelled
 *   (missing the second `l`). Reading `piMiddleInitial` would silently drop real
 *   PI data.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const NSF_STATES: readonly ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "AS", "GU", "MP", "PR", "VI"];
export type NsfState = (typeof NSF_STATES)[number];
export type NsfAward = {
    id: string | null;
    title: string | null;
    agency: string | null;
    awardAgencyCode: string | null;
    fundAgencyCode: string | null;
    cfdaNumber: string | null;
    transType: string | null;
    awardee: {
        /** The SAM/USAspending recipient join key (but grant ≠ contract — M2). */
        name: string | null;
        legalName: string | null;
        city: string | null;
        stateCode: string | null;
        countryCode: string | null;
        zipCode: string | null;
        districtCode: string | null;
        ueiNumber: string | null;
        parentUeiNumber: string | null;
    };
    performanceSite: {
        location: string | null;
        city: string | null;
        stateCode: string | null;
        countryCode: string | null;
        zipCode: string | null;
    };
    principalInvestigator: {
        fullName: string | null;
        firstName: string | null;
        lastName: string | null;
        /** raw.piMiddeInitial — the source key is genuinely MISSPELLED (verbatim). */
        middleInitial: string | null;
        email: string | null;
        id: string | null;
    };
    coPrincipalInvestigators: string[];
    programOfficer: {
        name: string | null;
        email: string | null;
    };
    amounts: {
        fundsObligatedAmt: number | null;
        estimatedTotalAmt: number | null;
        fundsObligatedByYear: string[];
    };
    dates: {
        startDate: string | null;
        expDate: string | null;
        lastActionDate: string | null;
        initAmendmentDate: string | null;
        latestAmendmentDate: string | null;
    };
    program: {
        fundProgramName: string | null;
        program: string | null;
        directorateAbbr: string | null;
        divisionAbbr: string | null;
        orgLongName: string | null;
        orgLongName2: string | null;
    };
    activeAward: boolean | null;
    historicalAward: boolean | null;
    /** ONLY populated by nsf_get_award (search rows OMIT it — payload). */
    abstractText?: string | null;
};
export type NsfSearchArgs = {
    keyword?: string;
    awardeeStateCode?: NsfState;
    awardeeName?: string;
    ueiNumber?: string;
    parentUeiNumber?: string;
    pdPIName?: string;
    dateStart?: string;
    dateEnd?: string;
    limit?: number;
    offset?: number;
};
/**
 * Search awarded NSF research grants with recipient / PI / UEI filters. Each
 * shipped filter is LIVE-CONFIRMED to narrow (M1 discipline); the query is
 * MODULE-BUILT from validated typed args through URLSearchParams (NO raw
 * passthrough). Returns curated rows (abstract EXCLUDED — payload) + honest
 * `_meta`: exact totalAvailable below 10k / a disclosed lower bound at 10k, the
 * offset+rpp ≤ 10,000 window clamp, the multi-word OR disclosure, and the
 * mandatory grant-vs-contract caveat. Disclose-not-refuse: an unscoped call is
 * NOT refused — it returns the first page + the (lower-bound) total + a
 * narrowing recommendation.
 */
export declare function searchAwards(args: NsfSearchArgs): Promise<MetaBundle>;
/**
 * Fetch ONE NSF award by its numeric award id; returns the FULL single record
 * INCLUDING abstractText. Not-found is honest: `id=<nonexistent>` returns
 * totalCount:0 / award:[] (a genuine empty) ⇒ found:false, NEVER a fabricated
 * record. `id` is numeric-only (injection-safe).
 */
export declare function getAward(args: {
    awardId: string;
}): Promise<MetaBundle>;
//# sourceMappingURL=nsf.d.ts.map