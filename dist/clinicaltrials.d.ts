/**
 * clinicaltrials.ts — ClinicalTrials.gov API v2 (`clinicaltrials.gov/api/v2`) —
 * federally-registered clinical-research studies with LEAD-SPONSOR / COLLABORATOR
 * / ORGANIZATION / FUNDING-SOURCE entity enrichment. ADR-0021. Source #21 on the
 * R2 `getJson` GET port (a plain keyless GET — no key, no signup, no UA).
 *
 * WHAT IT ADDS: the trial-REGISTRATION axis of the research-funding entity layer
 * already served by NIH RePORTER (ADR-0014) + NSF Awards (ADR-0020). The
 * `leadSponsor` / `collaborators` / `organization` here are the pharma / biotech /
 * university / agency entities that ALSO receive federal grants/contracts — the
 * study-registration SIBLING of the grant sources, not a duplicate. On-mission =
 * the ENTITY/sponsor/funding dimension (NOT the clinical minutiae).
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error", a plain GET) / `driftError` / `num`·`str` (coerce.ts,
 * null-never-0 / null-never-empty-string) / `withMeta`·`buildMeta` /
 * `ResponseMeta.nextCursor`, and COPIES (does NOT import) the GovInfo opaque-cursor
 * honesty + the fixed-host SSRF idiom into the single audited `getCT` helper [M2].
 *
 * ★ SSRF ([M2] — one audited fetch home): BOTH tools route through `getCT(path,
 *   label, params)`. The host is a compile-time literal (`CT_BASE`); every filter
 *   rides in a MODULE-BUILT `URLSearchParams` (each value URLSearchParams-encoded)
 *   assembled key-by-key from validated typed args — NO raw-query passthrough. The
 *   single-study path segment `nctId` is regex-validated `^NCT\d{8}$` BEFORE the
 *   path is built (a `../` / `%2F` / non-matching id → invalid_input, 0 fetch —
 *   mirror edgar `buildFramesUrl` S1/S2). A post-construction hostname/protocol
 *   assertion + `redirect:"error"` lock it (fail closed on any off-host 3xx).
 *
 * ★ THE THREE HONESTY FACTS (LIVE-verified 2026-07-12, keyless plain GET, this IP):
 *   1. `totalCount` is EXACT + filter-respecting + UNCAPPED — but OMITTED unless
 *      `countTotal=true` is sent (default keys = [studies, nextPageToken]). So the
 *      module ALWAYS sends `countTotal=true`; `totalAvailable = num(totalCount)`
 *      (a genuine 0 → 0, NEVER null, NEVER studies.length); a missing/non-number
 *      totalCount on a countTotal=true call ⇒ schema_drift. (cancer=142304,
 *      unfiltered=593334 — an exact non-round number, no saturation cap.)
 *   2. Pagination is an OPAQUE cursor (`nextPageToken`). Terminal = token ABSENT
 *      (BOTH genuine-empty AND a single-complete-page omit it — live-verified
 *      progeria total=10/returned=10/no token). `nextCursor` is passed back
 *      VERBATIM as the `pageToken` argument (never fabricated/derived); a bad
 *      token loud-fails at HTTP 400 ⇒ getJson THROWS (never a silent-empty cursor).
 *      offset/nextOffset are null (meaningless for a cursor). CT's terminal is
 *      token-absent — there is NO GovInfo-style `"*"` sentinel.
 *   3. An INVALID `funderType` SILENTLY returns `totalCount:0` at HTTP 200 (NOT a
 *      400 — contrast a bad overallStatus / pageToken / aggFilters-KEY, which all
 *      400). So `funderType` is a FROZEN 4-value enum ([M1] re-validated IN THE
 *      HANDLER, not only in Zod) — a non-member ⇒ invalid_input PRE-fetch, 0
 *      network call, NEVER passed through to be read as a genuine empty.
 *
 * ★ [M1] IN-HANDLER ENUM RE-GUARD: `funderType` AND `overallStatus` are re-checked
 *   against the frozen CT enum arrays INLINE in the search handler (throw
 *   invalid_input pre-fetch, 0 fetch) — closing the funderType silent fake-empty
 *   even on a Zod-BYPASSING direct handler call (mirror govinfo's in-handler
 *   collection re-check).
 *
 * ★ TOKENIZATION is AND-conjunctive for query.term/query.spons/query.cond, and CT
 *   splits on whitespace AND a PUNCTUATION set (NOT whitespace alone) — live-verified
 *   2026-07-12: `query.spons=sanofi<delim>aventis` == the whitespace count (3) for
 *   space + `- , / ; + & | @ # =`; `. : _ '` do NOT split. So a single-token-LOOKING
 *   compound like "Sanofi-Aventis" is really 'Sanofi' AND 'Aventis' (→3 vs Sanofi
 *   →3416 — a ~1000× silent false-negative). A multi-TOKEN value (tokenized via the
 *   shared tokenizeForDisclosure / DISCLOSURE_SPLIT_RE, not just whitespace) fires a
 *   MANDATORY `_meta` AND-note (the mirror of NSF's OR-note, but AND); a multi-token
 *   sponsor SUPPRESSES the
 *   contradictory "matches more variants" broadening note (CT NARROWED, not broadened).
 *
 * ★ funderType facets OVERLAP (non-exclusive: nih+fed+industry+other sum >
 *   registry total) — a `_meta` note forbids summing them into a partition.
 *
 * ★ trial ≠ federal award (EVERY response): a registration is NOT an award;
 *   leadSponsor.name is FREE TEXT (not a UEI) → a NOMINAL name match only.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export { tokenizeForDisclosure } from "./disclosure.js";
export declare const CT_STATUSES: readonly ["COMPLETED", "UNKNOWN", "RECRUITING", "TERMINATED", "NOT_YET_RECRUITING", "ACTIVE_NOT_RECRUITING", "WITHDRAWN", "ENROLLING_BY_INVITATION", "SUSPENDED", "WITHHELD", "NO_LONGER_AVAILABLE", "AVAILABLE", "APPROVED_FOR_MARKETING", "TEMPORARILY_NOT_AVAILABLE"];
export type CtStatus = (typeof CT_STATUSES)[number];
export declare const CT_FUNDER_TYPES: readonly ["nih", "fed", "industry", "other"];
export type CtFunderType = (typeof CT_FUNDER_TYPES)[number];
export declare const CT_FACET_FIELDS: readonly ["OverallStatus", "StudyType", "Phase", "LeadSponsorClass", "Sex", "DesignAllocation", "DesignPrimaryPurpose", "DesignInterventionModel", "DesignMasking", "DesignObservationalModel", "DesignTimePerspective"];
export type CtFacetField = (typeof CT_FACET_FIELDS)[number];
export declare const CT_FACET_ARRAY_FIELDS: ReadonlySet<string>;
export declare const CT_NCT_RE: RegExp;
export declare const CT_TOKEN_RE: RegExp;
export type CtEntity = {
    name: string | null;
    class: string | null;
};
export type ClinicalStudy = {
    nctId: string | null;
    briefTitle: string | null;
    orgStudyId: string | null;
    /** identificationModule.organization — the REGISTERING org. */
    organization: CtEntity;
    /** sponsorCollaboratorsModule.leadSponsor — class = the FUNDING SOURCE. */
    leadSponsor: CtEntity;
    /** sponsorCollaboratorsModule.collaborators[] — [] when none listed (honest). */
    collaborators: CtEntity[];
    /** leadSponsor.class promoted (NIH/FED = federally-funded; the B2G axis). */
    fundingClass: string | null;
    overallStatus: string | null;
    startDate: string | null;
    studyType: string | null;
    phases: string[];
    conditions: string[];
    /** ONLY populated by clinicaltrials_get_study (search rows OMIT it — payload). */
    briefSummary?: string | null;
};
export type CtSearchArgs = {
    "query.term"?: string;
    sponsor?: string;
    condition?: string;
    location?: string;
    overallStatus?: CtStatus;
    funderType?: CtFunderType;
    pageSize?: number;
    pageToken?: string;
};
/**
 * Search federally-registered clinical studies with sponsor / condition /
 * location / status / funding-source filters. Each shipped filter is
 * LIVE-CONFIRMED to narrow; the query is MODULE-BUILT from validated typed args
 * through URLSearchParams (NO raw passthrough) with `countTotal=true` ALWAYS
 * appended (§Honesty #1). Returns curated ENTITY rows (briefSummary EXCLUDED —
 * payload) + honest `_meta`: the EXACT filtered total, the opaque-cursor
 * continuation, the AND-tokenization disclosure, the funderType-overlap note, and
 * the mandatory trial≠federal-award caveat. Disclose-not-refuse: an unscoped call
 * is NOT refused — it returns the first page + the exact total + a narrowing note.
 */
export declare function searchStudies(args: CtSearchArgs): Promise<MetaBundle>;
/**
 * Fetch ONE study by its NCT id; returns the fuller single record (entity fields
 * + briefSummary). [M2] `nctId` is regex-validated `^NCT\d{8}$` BEFORE the path is
 * built (a `../` / non-matching id ⇒ invalid_input, 0 fetch). A 404 (nonexistent
 * NCT id) ⇒ honest found:false (never a fabricated study).
 */
export declare function getStudy(args: {
    nctId: string;
}): Promise<MetaBundle>;
export type CtFacetValue = {
    /** The enum value (str — null-never-empty-string). */
    value: string | null;
    /** The EXACT per-value study count (num — null-never-0; a non-number ⇒ drift). */
    studiesCount: number | null;
};
export type CtFacet = {
    /** The requested/echoed field name (the `piece`). */
    field: string;
    /** The dotted upstream JSON path (the `field`), e.g. protocolSection.statusModule.overallStatus. */
    fieldPath: string | null;
    /** The echoed upstream `type` (asserted "ENUM"; else drift). */
    valueType: string | null;
    /** Distinct values that exist upstream (num — non-number ⇒ drift). */
    uniqueValuesCount: number | null;
    /** Studies with NO value for this field (num — null-never-0). */
    missingStudiesCount: number | null;
    /** values.length (== uniqueValuesCount for a COMPLETE ENUM facet). */
    returned: number;
    /** returned < uniqueValuesCount (the 250-cap surface; never true for v1 ENUMs). */
    truncated: boolean;
    /** true for an ARRAY-valued field (Phase) — counts OVERLAP, must not be summed. */
    overlapping: boolean;
    /** The EXACT per-value distribution. */
    values: CtFacetValue[];
};
export type CtFacetArgs = {
    fields: string[];
};
/**
 * Aggregate / statistical view: EXACT per-value study counts over the WHOLE
 * ClinicalTrials.gov registry for one or more whitelisted ENUM fields
 * (studies-by-OverallStatus / by-Phase / by-LeadSponsorClass = the funding-source
 * distribution / …). The aggregate SIBLING of clinicaltrials_search_studies (which
 * gives the exact FILTERED total for a query) — this gives the exact WHOLE-REGISTRY
 * distribution across a field's values. Reuses the shipped getCT verbatim (one new
 * path constant), coerce.num/str, buildMeta/withMeta — ZERO new fetch/coerce/error/
 * meta code.
 */
export declare function facetCounts(args: CtFacetArgs): Promise<MetaBundle>;
//# sourceMappingURL=clinicaltrials.d.ts.map