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

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { tokenizeForDisclosure } from "./disclosure.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` (clinicaltrials.num === coerce.num — a num regression fails together;
// NO local num/str in this module).
export { num };

// Re-export the shared disclosure tokenizer (single audited copy in
// ./disclosure.js — ADR-0022) so the fault suite's parity guard resolves the SAME
// function (clinicaltrials.tokenizeForDisclosure === nsf.tokenizeForDisclosure ===
// disclosure.tokenizeForDisclosure — a class regression fails both suites at once).
export { tokenizeForDisclosure } from "./disclosure.js";

// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
const CT_HOST = "clinicaltrials.gov";
// The FIXED base literal (host + api version). All paths interpolate off this.
const CT_BASE = "https://clinicaltrials.gov/api/v2";
const CT_STUDIES_PATH = "/studies";
// HOST+path label (keyless ⇒ no token can ever appear). Surfaces in
// ToolError.upstreamEndpoint.
const CT_LABEL = "clinicaltrials:/api/v2/studies";
// ADR-0024 — the facet-counts endpoint (per-field value distribution), a SIBLING
// path on the SAME fixed host, routed through the SAME audited getCT helper. Its
// own HOST+path label (keyless ⇒ no token) so ToolError.upstreamEndpoint and the
// _meta.source distinguish the facet endpoint from the row endpoint.
const CT_STATS_FIELDS_PATH = "/stats/field/values";
const CT_STATS_FIELDS_LABEL = "clinicaltrials:/api/v2/stats/field/values";

// ─── Frozen enums (Zod source of truth + [M1] in-handler re-guard) ─
// overallStatus — the 14 values from /stats/field/values (P24). Built FROM this
// array by the Zod enum in server.ts; re-validated in the handler (a bad value
// LOUD-fails at HTTP 400 upstream, so this guard's value is mostly a clean
// pre-fetch invalid_input + parity with funderType's re-guard).
export const CT_STATUSES = [
  "COMPLETED",
  "UNKNOWN",
  "RECRUITING",
  "TERMINATED",
  "NOT_YET_RECRUITING",
  "ACTIVE_NOT_RECRUITING",
  "WITHDRAWN",
  "ENROLLING_BY_INVITATION",
  "SUSPENDED",
  "WITHHELD",
  "NO_LONGER_AVAILABLE",
  "AVAILABLE",
  "APPROVED_FOR_MARKETING",
  "TEMPORARILY_NOT_AVAILABLE",
] as const;
export type CtStatus = (typeof CT_STATUSES)[number];
const CT_STATUSES_SET: ReadonlySet<string> = new Set(CT_STATUSES);

// funderType — the 4 live-nonzero-confirmed values (P16). The other 4 (indiv /
// network / ambig / unknown) return 0 even on the whole registry (behaviorally
// IDENTICAL to the P18 silent-invalid-zero), so they are EXCLUDED. This is the
// load-bearing honesty guard: an INVALID funderType silently fake-empties at
// HTTP 200, so a non-member is invalid_input PRE-fetch, NEVER sent.
export const CT_FUNDER_TYPES = ["nih", "fed", "industry", "other"] as const;
export type CtFunderType = (typeof CT_FUNDER_TYPES)[number];
const CT_FUNDER_TYPES_SET: ReadonlySet<string> = new Set(CT_FUNDER_TYPES);

// ─── Facet-counts field whitelist (ADR-0024 — the SECOND tool's Zod source of
//     truth + its [ssrf] in-handler re-guard) ──────────────────────────────
// The 11 LIVE-VERIFIED (2026-07-12, keyless) `type:"ENUM"` faceteable fields on
// `/stats/field/values`, each of which returns COMPLETE (topValues.length ==
// uniqueValuesCount — max observed 14 ≪ the endpoint's hard 250-value cap) and a
// UNIFORM `{uniqueValuesCount:number, topValues:[{value,studiesCount}]}` shape.
// The Zod enum in server.ts is DERIVED from this frozen array (single source of
// truth); the handler ALSO re-checks each requested field against CT_FACET_FIELDS_SET
// INLINE (the [ssrf] re-guard — a Zod-bypassing DIRECT handler call cannot smuggle a
// raw field name; mirrors CT_FUNDER_TYPES_SET / CT_STATUSES_SET). ENUM-ONLY by design:
// a whitelisted field whose response is NOT type:"ENUM" (e.g. the BOOLEAN
// HealthyVolunteers `{trueCount,falseCount}` shape, which has NO topValues) is
// schema_drift, never a silent mis-parse (§Honesty #7).
export const CT_FACET_FIELDS = [
  "OverallStatus", // 14 values — study-status distribution
  "StudyType", // 3  — interventional / observational / expanded-access
  "Phase", // 6  — ARRAY-valued ⇒ OVERLAP note (not a partition)
  "LeadSponsorClass", // 9  — ★ the FUNDING-SOURCE distribution (B2G: NIH/FED/OTHER_GOV/…)
  "Sex", // 3
  "DesignAllocation", // 3
  "DesignPrimaryPurpose", // 10
  "DesignInterventionModel", // 5
  "DesignMasking", // 5
  "DesignObservationalModel", // 9
  "DesignTimePerspective", // 4
] as const;
export type CtFacetField = (typeof CT_FACET_FIELDS)[number];
const CT_FACET_FIELDS_SET: ReadonlySet<string> = new Set(CT_FACET_FIELDS);

// The ARRAY-valued members whose per-value counts OVERLAP (a study can hold several,
// e.g. PHASE1|PHASE2) so Σ counts + missing OVERSHOOTS the registry total (Phase:
// live-verified sum 477032 + missing 140698 = 617730 > 593334). The v1 whitelist's
// ONLY array member is Phase; all 10 others are scalar (sum + missing == 593334, an
// exact partition). A static Set (no /stats/size call needed) drives the not-a-
// partition note + the per-facet `overlapping` flag.
export const CT_FACET_ARRAY_FIELDS: ReadonlySet<string> = new Set(["Phase"]);

// ─── Client-side value grammars (SSRF + injection guards) ─────────
// [M2] NCT id = exactly 8 digits (P1/P11/P12 — every observed id). Validated
// BEFORE the single-study path is built (no `/`, `?`, `..`, `%2F`, space can be
// injected — belt-and-suspenders behind the server's Zod, load-bearing for a
// direct handler call that bypasses Zod).
export const CT_NCT_RE = /^NCT\d{8}$/;
// The opaque pageToken alphabet is a base64/URL-safe SUPERSET (the real injection
// guard is URLSearchParams encoding; the regex bounds length + rejects obvious
// garbage). Mirrors GovInfo's page-mark regex MINUS the `"*"` sentinel (CT has no
// first-page sentinel — the first page is simply a call with no pageToken) AND
// MINUS a literal `%` — URLSearchParams would double-encode a `%` (`%2e`→`%252e`)
// and corrupt the cursor; CT's observed tokens are base64url (no `%`), so a stray
// `%` is rejected as invalid_input rather than silently corrupting pagination.
export const CT_TOKEN_RE = new RegExp("^[A-Za-z0-9+/=_~.,:-]{1,4096}$");

// ─── Disclosure constants (honesty obligations) ──────────────────
/** The mandatory trial≠federal-award caveat carried in EVERY response. */
const CT_TRIAL_CAVEAT =
  "A ClinicalTrials.gov record is the REGISTRATION of a clinical study, NOT a federal grant or contract award. leadSponsor.class / funderType (NIH/FED) indicate the study's funding-SOURCE class, and the sponsor / collaborator / organization NAMES overlap the entities in NIH RePORTER / NSF Awards / SAM / USAspending — but leadSponsor.name is a FREE-TEXT string, NOT a UEI, so any cross-reference to a federal award is a NOMINAL name match, not an authoritative entity join, and a registered trial does not imply a federal award to that sponsor.";

/** The opaque-cursor disclosure (offset/nextOffset are meaningless). */
const CT_CURSOR_NOTE =
  "ClinicalTrials.gov uses an opaque cursor: pagination.offset/nextOffset are not meaningful (null). Continue by passing _meta.nextCursor back as the `pageToken` argument; hasMore:false / nextCursor:null means this is the last page.";

/** funderType is a NON-EXCLUSIVE facet (values overlap; sum > registry total). */
const CT_FUNDER_OVERLAP_NOTE =
  "funderType is an OVERLAPPING facet — a study can have multiple funders, so the per-funderType counts MUST NOT be summed across values to reconstruct a registry total.";

/** query.spons is a fuzzy sponsor NAME search, not an exact-entity join. Emitted
 *  ONLY for a SINGLE-token sponsor: for a MULTI-token sponsor CT AND-splits and
 *  NARROWS (e.g. 'Sanofi-Aventis' → 'Sanofi' AND 'Aventis'), so the "matches more
 *  variants" broadening framing here would be the OPPOSITE of what happened — the
 *  AND-note (andTokenNote) takes precedence in that case (see searchStudies). */
const CT_SPONSOR_NOTE =
  "sponsor is a full-text sponsor-NAME search (query.spons), not an exact-entity equality — a single-token name also matches related name variants (e.g. 'Pfizer' matches 'Pfizer's Upjohn'), and the name is free text, NOT a UEI (nominal match only).";

/** A conservative data-currency note (not API-verifiable). */
const CT_DATA_CURRENCY_NOTE =
  "ClinicalTrials.gov updates registrations on a rolling basis; per-record refresh lag is not API-verifiable.";

// ─── Facet-counts disclosure constants (ADR-0024 honesty obligations) ──────
const CT_FACET_SOURCE =
  "clinicaltrials.gov /api/v2/stats/field/values (keyless)";

/**
 * [M1] totalAvailable/returned UNIT disclosure. For the facet tool ONLY,
 * `_meta.totalAvailable = Σ facet.uniqueValuesCount` and `_meta.returned =
 * Σ facet.values.length` — these drive buildMeta's `returned < totalAvailable ⇒
 * truncated` invariant, but they count DISTINCT FIELD VALUES, NOT studies (in
 * every OTHER tool, incl. clinicaltrials_search_studies, totalAvailable is a
 * study/record match count). Mandatory on every facet response so an AI never
 * reads the distinct-value total as a study total.
 */
const CT_FACET_UNIT_NOTE =
  "In this facet-counts response _meta.totalAvailable and _meta.returned count DISTINCT FIELD VALUES across the requested facet(s), NOT studies (e.g. OverallStatus+Phase ⇒ totalAvailable = 14+6 = 20 distinct values, which is NOT a study count). The per-value STUDY counts are facets[].values[].studiesCount; for a COUNT of studies use clinicaltrials_search_studies (its _meta.totalAvailable is the exact study total).";

/**
 * [M2] Whole-registry scope note — NO hard-coded registry size (the registry only
 * grows; freezing a total in a truthfulness string would go stale). These counts
 * are ALWAYS over the ENTIRE registry and are UNfilterable (query/filter/countTotal/
 * pageSize params all HTTP-400 here). Cross-links the sibling row tool for filtered
 * totals.
 */
const CT_FACET_SCOPE_NOTE =
  "These are whole-registry distribution counts — they cover the ENTIRE ClinicalTrials.gov registry and are NOT filtered by any query (the /stats/field/values endpoint rejects query.*/filter.*/countTotal/pageSize with HTTP 400). To count studies matching a specific query / sponsor / condition / status, use clinicaltrials_search_studies (its _meta.totalAvailable is the exact filtered total).";

/**
 * The FACET-SCOPED trial≠federal-award caveat (EVERY facet response). Carries the
 * same trial-registration ≠ federal-award substance as the row-level
 * CT_TRIAL_CAVEAT, but REWORDED for a distribution output — it describes the
 * LeadSponsorClass DISTRIBUTION, not a row-level leadSponsor.name free-text field.
 */
const CT_FACET_TRIAL_CAVEAT =
  "A ClinicalTrials.gov facet count is a DISTRIBUTION over clinical-study REGISTRATIONS, NOT over federal grants or contract awards. LeadSponsorClass (NIH / FED / OTHER_GOV vs INDUSTRY / OTHER / NETWORK / …) is the study's funding-SOURCE class, NOT a count of federal awards; these classes overlap — but do NOT equal — the entities in NIH RePORTER / NSF Awards / SAM / USAspending (a nominal funding-source-class distribution, not a UEI-keyed award join). A registered trial does not imply a federal award to its sponsor.";

/** Per-facet TOP-N truncation note — the 250-cap disclosure. Never fires for the
 *  v1 ENUM whitelist (all ≤14 unique ≪ 250) but is load-bearing: if the whitelist
 *  is ever extended to a high-cardinality (STRING) field, this discloses the cap. */
function ctFacetTruncationNote(field: string, unique: number, returned: number): string {
  return `Field '${field}' has ${unique} distinct values but ClinicalTrials.gov's /stats/field/values returned only the top ${returned} by study count (a hard 250-value cap, not pageable); the remaining ${unique - returned} value(s) are OMITTED — this is NOT the full distribution.`;
}

/** Per-facet not-a-partition note — an ARRAY-valued field (Phase) whose per-value
 *  counts OVERLAP and MUST NOT be summed to a registry total. */
function ctFacetOverlapNote(field: string): string {
  return `'${field}' is multi-valued per study (a study can carry several values, e.g. a trial registered as PHASE1|PHASE2), so its per-value studiesCount counts OVERLAP and MUST NOT be summed to a registry total (Σ counts + missingStudiesCount OVERSHOOTS the registry size). The other facets are scalar (each study has at most one value). Always read missingStudiesCount alongside the shown buckets.`;
}

/** Per-facet high-missing interpretation note — when more studies LACK a value for
 *  the field than are represented across all shown buckets, the distribution covers
 *  a MINORITY of the registry. `missing` is this response's exact (live) count — NOT
 *  a frozen constant (M2). */
function ctFacetHighMissingNote(field: string, missing: number): string {
  return `Field '${field}' has ${missing} studies with NO value for it — MORE than the studies represented across all shown buckets — so this distribution covers a MINORITY of the registry; do NOT read the shown value counts as registry-wide (the uncounted / missing studies dominate).`;
}

// CT's Essie analyzer AND-tokenizes free-text query.spons/query.cond/query.term on
// whitespace AND the confirmed PUNCTUATION set (space + `- , / ; + & | @ # =` split
// into the AND co-occurrence; `. : _ '` do NOT — live-verified 2026-07-12), so a
// single-token-LOOKING compound like "Sanofi-Aventis" is really 'Sanofi' AND
// 'Aventis' (→3 vs Sanofi→3416 — a ~1000× silent false-negative). That precise
// class is the SHARED tokenizeForDisclosure / DISCLOSURE_SPLIT_RE (src/disclosure.js,
// ADR-0022) — byte-identical to NSF's former CT_TOKEN_SPLIT_RE / NSF_KEYWORD_SPLIT_RE
// (there OR, here AND) — so a whitespace-only detector can never miss the AND-note.

/** The AND-tokenization disclosure for a multi-TOKEN term/sponsor/condition value. */
function andTokenNote(field: string, tokens: string[]): string {
  return `ClinicalTrials.gov tokenizes a multi-word ${field} on whitespace AND punctuation (hyphen, comma, slash, semicolon, etc.) and matches it as AND — ALL tokens must co-occur; this value was split into [${tokens.join(", ")}], so a 0/small count means no study matches EVERY token, NOT that the ${field} is absent (e.g. 'Sanofi-Aventis' = 'Sanofi' AND 'Aventis' → far fewer than 'Sanofi' alone). Try a single distinctive token.`;
}

const CT_SOURCE = "clinicaltrials.gov /api/v2/studies (keyless)";

// ─── Curated record shape (the ENTITY/sponsor/funding dimension) ───
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

/** A string array from a mixed value, else [] (drops non-string entries). */
function strArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.map((v) => str(v)).filter((v): v is string => v !== null);
}

/** Map a collaborators[]-style array of {name,class} entities (honest [] when absent). */
function mapEntities(x: unknown): CtEntity[] {
  if (!Array.isArray(x)) return [];
  return x.map((c) => {
    const it = (c ?? {}) as Record<string, unknown>;
    return { name: str(it.name), class: str(it.class) };
  });
}

/**
 * Map ONE study (a search `studies[]` row OR the get single-study body — both
 * carry `protocolSection`) → the curated entity shape. Every scalar is
 * null-never-fabricated (str, null-never-empty-string — a missing/blank sponsor
 * name is null, NEVER ""). collaborators/phases/conditions default to [] (an
 * honest "none listed"). `briefSummary` is included ONLY for get_study.
 */
function mapStudy(item: unknown, includeSummary: boolean): ClinicalStudy {
  const it = (item ?? {}) as Record<string, unknown>;
  const ps = (it.protocolSection ?? {}) as Record<string, unknown>;
  const idm = (ps.identificationModule ?? {}) as Record<string, unknown>;
  const org = (idm.organization ?? {}) as Record<string, unknown>;
  const orgStudyIdInfo = (idm.orgStudyIdInfo ?? {}) as Record<string, unknown>;
  const scm = (ps.sponsorCollaboratorsModule ?? {}) as Record<string, unknown>;
  const lead = (scm.leadSponsor ?? {}) as Record<string, unknown>;
  const statusM = (ps.statusModule ?? {}) as Record<string, unknown>;
  const startStruct = (statusM.startDateStruct ?? {}) as Record<string, unknown>;
  const designM = (ps.designModule ?? {}) as Record<string, unknown>;
  const condM = (ps.conditionsModule ?? {}) as Record<string, unknown>;
  const descM = (ps.descriptionModule ?? {}) as Record<string, unknown>;

  const leadClass = str(lead.class);
  const study: ClinicalStudy = {
    nctId: str(idm.nctId),
    briefTitle: str(idm.briefTitle),
    orgStudyId: str(orgStudyIdInfo.id),
    organization: { name: str(org.fullName), class: str(org.class) },
    leadSponsor: { name: str(lead.name), class: leadClass },
    collaborators: mapEntities(scm.collaborators),
    fundingClass: leadClass,
    overallStatus: str(statusM.overallStatus),
    startDate: str(startStruct.date),
    studyType: str(designM.studyType),
    phases: strArray(designM.phases),
    conditions: strArray(condM.conditions),
  };
  if (includeSummary) study.briefSummary = str(descM.briefSummary);
  return study;
}

// ─── SSRF-guarded fetch ([M2] — one audited fetch home for BOTH tools) ──
/**
 * GET one ClinicalTrials.gov v2 JSON resource. `path` is `/studies` (search) or
 * `/studies/{nctId}` (get — the caller validates `nctId` `^NCT\d{8}$` BEFORE
 * building the path); all query params ride in `params` (URLSearchParams,
 * encoded). Builds `${CT_BASE}${path}?${params}` on the FIXED host literal, then
 * asserts the CONSTRUCTED URL is `clinicaltrials.gov` over https (belt-and-
 * suspenders — a future constant typo/downgrade fails closed), sets
 * `redirect:"error"` (an off-host 3xx fails closed — its body is never read). NO
 * headers (keyless — no key/UA required, byte-clean init). Returns the parsed
 * JSON (unknown; the caller validates the response envelope + throws driftError).
 */
async function getCT(
  path: string,
  label: string,
  params: URLSearchParams,
): Promise<unknown> {
  const qs = params.toString();
  const url = `${CT_BASE}${path}${qs ? `?${qs}` : ""}`;
  const built = new URL(url);
  if (built.protocol !== "https:" || built.hostname !== CT_HOST) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed ClinicalTrials.gov URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(CT_HOST)} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }
  return getJson(url, { label, redirect: "error" });
}

// ─── Tool 1: clinicaltrials_search_studies ────────────────────────
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
export async function searchStudies(args: CtSearchArgs): Promise<MetaBundle> {
  const pageSize = args.pageSize ?? 20;

  // ── [M1] In-handler enum re-guard (funderType AND overallStatus) — throw
  //    invalid_input PRE-fetch (0 network call), mirroring govinfo's in-handler
  //    collection re-check. This is load-bearing for a DIRECT handler call that
  //    bypasses Zod: an unknown funderType would build aggFilters=funderType:<v>
  //    and get a fabricated HTTP-200 totalCount:0 (the silent fake-empty trap). ──
  if (
    args.funderType !== undefined &&
    !CT_FUNDER_TYPES_SET.has(args.funderType)
  ) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `funderType ${JSON.stringify(args.funderType)} is not supported by this tool (ships: ${CT_FUNDER_TYPES.join(", ")}). An unlisted funderType silently returns totalCount:0 at HTTP 200 on ClinicalTrials.gov (indistinguishable from a genuine empty) — refused before any fetch.`,
      retryable: false,
      upstreamEndpoint: CT_LABEL,
    });
  }
  if (
    args.overallStatus !== undefined &&
    !CT_STATUSES_SET.has(args.overallStatus)
  ) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `overallStatus ${JSON.stringify(args.overallStatus)} is not one of the ${CT_STATUSES.length} ClinicalTrials.gov statuses (${CT_STATUSES.join(", ")}) — refused before any fetch.`,
      retryable: false,
      upstreamEndpoint: CT_LABEL,
    });
  }
  // ── Belt-and-suspenders pageToken + pageSize grammars (behind the server's
  //    Zod). A bad token would loud-fail at HTTP 400, but reject it pre-fetch. ──
  if (args.pageToken !== undefined && !CT_TOKEN_RE.test(args.pageToken)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid pageToken (opaque cursor) — must be a ≤4096-char base64/URL-safe token. Pass back the _meta.nextCursor from the previous page.`,
      retryable: false,
      upstreamEndpoint: CT_LABEL,
    });
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid pageSize ${JSON.stringify(pageSize)} — must be an integer in [1, 1000] (ClinicalTrials.gov clamps a larger request to 1000).`,
      retryable: false,
      upstreamEndpoint: CT_LABEL,
    });
  }

  // ── Build the query from VALIDATED typed args, key-by-key (SSRF: no raw
  //    passthrough). countTotal=true is ALWAYS appended (§Honesty #1 — omitting
  //    it drops the total entirely). ──
  const params = new URLSearchParams();
  const filtersApplied: string[] = [];
  const andNotes: string[] = [];

  // A helper: push a filter + detect MULTI-TOKEN AND-tokenization on CT's REAL
  // delimiter set via the shared tokenizeForDisclosure (whitespace AND the confirmed
  // punctuation splitters — DISCLOSURE_SPLIT_RE), so a compound like "Sanofi-Aventis"
  // (= Sanofi AND Aventis) fires the mandatory AND-note instead of leaking as one
  // token through a hyphen/comma/slash. Returns true iff the value split into 2+
  // tokens (so the caller can suppress the contradictory sponsor-broadening note).
  // andField=null for fields with no AND-note obligation (location).
  const pushText = (
    value: string | undefined,
    upstreamKey: string,
    filterLabel: string,
    andField: string | null,
  ): boolean => {
    if (value === undefined) return false;
    params.set(upstreamKey, value);
    filtersApplied.push(filterLabel);
    if (andField === null) return false;
    const tokens = tokenizeForDisclosure(value);
    if (tokens.length > 1) {
      andNotes.push(andTokenNote(andField, tokens));
      return true;
    }
    return false;
  };

  pushText(args["query.term"], "query.term", "query.term", "term");
  const sponsorMultiToken = pushText(args.sponsor, "query.spons", "sponsor", "sponsor");
  pushText(args.condition, "query.cond", "condition", "condition");
  pushText(args.location, "query.locn", "location", null);

  if (args.overallStatus !== undefined) {
    params.set("filter.overallStatus", args.overallStatus);
    filtersApplied.push("overallStatus");
  }
  if (args.funderType !== undefined) {
    // The module builds the aggFilters string from the enum-validated value —
    // never from raw caller text (§SSRF #3).
    params.set("aggFilters", `funderType:${args.funderType}`);
    filtersApplied.push("funderType");
  }

  params.set("countTotal", "true"); // ALWAYS — §Honesty #1
  params.set("pageSize", String(pageSize));
  if (args.pageToken !== undefined) params.set("pageToken", args.pageToken);

  const body = await getCT(CT_STUDIES_PATH, CT_LABEL, params);
  const b = (body ?? {}) as {
    studies?: unknown;
    totalCount?: unknown;
    nextPageToken?: unknown;
  };

  // ── Container-guarded drift (never a TypeError masking drift as
  //    upstream_unavailable, never a fake empty). ──
  if (!Array.isArray(b.studies)) {
    throw driftError(
      CT_LABEL,
      "clinicaltrials shape drift — /studies response.studies must be an array.",
    );
  }
  // countTotal=true was sent, so totalCount MUST be a finite number — its absence
  // is drift, NEVER a silently-null total, NEVER studies.length (§Honesty #1).
  if (typeof b.totalCount !== "number" || !Number.isFinite(b.totalCount)) {
    throw driftError(
      CT_LABEL,
      "clinicaltrials shape drift — /studies totalCount missing/non-number on a countTotal=true request (typeof-checked BEFORE num() so a non-number can't silently parse; NEVER fall back to studies.length).",
    );
  }

  const studies = (b.studies as unknown[]).map((s) => mapStudy(s, false));
  const returned = studies.length;
  const totalAvailable = num(b.totalCount) as number; // EXACT (genuine 0 → 0)

  // ── Opaque-cursor honesty (§Honesty #2). Terminal = token ABSENT. The token is
  //    surfaced VERBATIM (never fabricated/derived). Phantom-empty guard: 0
  //    studies WITH a token ⇒ terminal (never advertise a continuation into an
  //    empty cursor loop). ──
  const rawNext = b.nextPageToken;
  const nextToken =
    typeof rawNext === "string" && rawNext.length > 0 ? rawNext : null;
  let hasMore: boolean;
  let nextCursor: string | null;
  if (returned === 0 && nextToken !== null) {
    hasMore = false;
    nextCursor = null;
  } else {
    hasMore = nextToken !== null;
    nextCursor = nextToken;
  }

  // ── Notes: the mandatory caveat + cursor + data-currency always; the
  //    conditional facet/tokenization disclosures; the unscoped recommendation. ──
  const notes: string[] = [CT_TRIAL_CAVEAT, CT_CURSOR_NOTE];
  notes.push(...andNotes);
  // Emit the sponsor-broadening note ONLY for a SINGLE-token sponsor. For a
  // MULTI-token sponsor CT AND-split and NARROWED (the andNotes AND-note fired),
  // so the "matches more variants" framing would AFFIRMATIVELY MISLEAD (the
  // opposite of what happened) — the AND-note is what the caller must see.
  if (args.sponsor !== undefined && !sponsorMultiToken)
    notes.push(CT_SPONSOR_NOTE);
  if (args.funderType !== undefined) notes.push(CT_FUNDER_OVERLAP_NOTE);
  if (filtersApplied.length === 0) {
    notes.push(
      "No filters were applied — this is an unscoped query over the WHOLE ClinicalTrials.gov registry (~593k studies). Add a filter (query.term, sponsor, condition, location, overallStatus, funderType) for a meaningful scoped result set.",
    );
  }
  notes.push(CT_DATA_CURRENCY_NOTE);

  return withMeta(
    { studies },
    {
      source: CT_SOURCE,
      keylessMode: true,
      returned,
      totalAvailable,
      // complete is DERIVED by buildMeta (never forced): a first-page call whose
      // returned === totalAvailable with no token ⇒ complete:true; a continuation
      // page (or any page with returned < total / a token) ⇒ complete:false.
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [
        "briefSummary (search rows omit it — use clinicaltrials_get_study)",
      ],
      // Cursor page: offset/nextOffset null (no numeric offset); continuation is
      // nextCursor (the opaque nextPageToken, passed back verbatim as pageToken).
      pagination: { offset: null, limit: pageSize, hasMore, nextOffset: null },
      nextCursor,
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool 2: clinicaltrials_get_study ─────────────────────────────
/**
 * Fetch ONE study by its NCT id; returns the fuller single record (entity fields
 * + briefSummary). [M2] `nctId` is regex-validated `^NCT\d{8}$` BEFORE the path is
 * built (a `../` / non-matching id ⇒ invalid_input, 0 fetch). A 404 (nonexistent
 * NCT id) ⇒ honest found:false (never a fabricated study).
 */
export async function getStudy(args: { nctId: string }): Promise<MetaBundle> {
  const nctId = args.nctId;
  // [M2] Validate BEFORE building the path (belt-and-suspenders behind the
  // server's Zod — load-bearing for a direct call; a traversal never reaches the
  // path). 0 fetch on a mismatch.
  if (!CT_NCT_RE.test(nctId)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid nctId ${JSON.stringify(nctId)} — expected an NCT id of the form NCT followed by exactly 8 digits (e.g. NCT02403869). Refused before any fetch (path-segment injection guard).`,
      retryable: false,
      upstreamEndpoint: CT_LABEL,
    });
  }

  const notes: string[] = [CT_TRIAL_CAVEAT, CT_DATA_CURRENCY_NOTE];

  let body: unknown;
  try {
    body = await getCT(
      `${CT_STUDIES_PATH}/${nctId}`,
      CT_LABEL,
      new URLSearchParams(),
    );
  } catch (e) {
    // A nonexistent NCT id ⇒ HTTP 404 ⇒ getJson throws not_found ⇒ honest
    // found:false (a definitive answer, never a fabricated study).
    if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
      return withMeta(
        { found: false, nctId, study: null as ClinicalStudy | null },
        {
          source: CT_SOURCE,
          keylessMode: true,
          returned: 0,
          totalAvailable: 0,
          complete: true,
          filtersApplied: ["nctId"],
          filtersDropped: [],
          fieldsUnavailable: [],
          notes: [
            `No ClinicalTrials.gov study found for nctId ${JSON.stringify(nctId)} (HTTP 404) — the id does not exist. Not fabricated.`,
            ...notes,
          ],
        } satisfies Partial<ResponseMeta>,
      );
    }
    throw e;
  }

  // A valid single-study 200 carries protocolSection at the TOP level (P11). Its
  // absence is drift (never a fabricated all-null record).
  const bo = (body ?? {}) as { protocolSection?: unknown };
  if (
    bo.protocolSection === null ||
    typeof bo.protocolSection !== "object" ||
    Array.isArray(bo.protocolSection)
  ) {
    throw driftError(
      CT_LABEL,
      "clinicaltrials shape drift — /studies/{nctId} response is missing a protocolSection object.",
    );
  }

  const study = mapStudy(body, true); // FULL record incl. briefSummary
  return withMeta(
    { found: true, nctId, study },
    {
      source: CT_SOURCE,
      keylessMode: true,
      returned: 1,
      totalAvailable: 1,
      complete: true,
      filtersApplied: ["nctId"],
      filtersDropped: [],
      fieldsUnavailable: [],
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool 3: clinicaltrials_facet_counts (ADR-0024) ───────────────
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

/**
 * Map ONE `/stats/field/values` facet element → the curated facet shape (a FRESH
 * mapper — does NOT reuse mapStudy/strArray/mapEntities, which are row-shaped).
 * ENUM-ONLY drift guard (§Honesty #7): the element MUST be `type:"ENUM"` with an
 * ARRAY `topValues` and a NUMBER `uniqueValuesCount` — a BOOLEAN
 * (`{trueCount,falseCount}`, no topValues) / STRING / re-typed shape for a
 * whitelisted field is schema_drift, NEVER read as an empty distribution. Each
 * `studiesCount` is typeof-checked to a finite NUMBER BEFORE `num()` (mirrors the
 * search tool's totalCount guard) so a non-number can NEVER silently parse or
 * coerce-to-0 — an EXACT count or drift, never a fabricated 0.
 */
function mapFacet(requested: string, item: unknown): CtFacet {
  const o = (item ?? {}) as Record<string, unknown>;
  if (o.type !== "ENUM") {
    throw driftError(
      CT_STATS_FIELDS_LABEL,
      `clinicaltrials facet shape drift — field '${requested}' returned type ${JSON.stringify(o.type)} (expected "ENUM"). A non-ENUM shape (e.g. a BOOLEAN {trueCount,falseCount} with NO topValues) must NEVER be read as an empty distribution.`,
    );
  }
  if (!Array.isArray(o.topValues)) {
    throw driftError(
      CT_STATS_FIELDS_LABEL,
      `clinicaltrials facet shape drift — field '${requested}' topValues is not an array (container-guarded — a TypeError must never mask drift as upstream_unavailable, never a fake empty).`,
    );
  }
  if (typeof o.uniqueValuesCount !== "number" || !Number.isFinite(o.uniqueValuesCount)) {
    throw driftError(
      CT_STATS_FIELDS_LABEL,
      `clinicaltrials facet shape drift — field '${requested}' uniqueValuesCount is missing/non-number (typeof-checked BEFORE num() so a string can't silently parse).`,
    );
  }
  const values: CtFacetValue[] = (o.topValues as unknown[]).map((v) => {
    const it = (v ?? {}) as Record<string, unknown>;
    if (typeof it.studiesCount !== "number" || !Number.isFinite(it.studiesCount)) {
      throw driftError(
        CT_STATS_FIELDS_LABEL,
        `clinicaltrials facet shape drift — a topValues[].studiesCount for field '${requested}' is missing/non-number (typeof-checked BEFORE num() so a non-number can NEVER be silently coerced to 0 — a per-value count is EXACT or it is drift).`,
      );
    }
    return { value: str(it.value), studiesCount: num(it.studiesCount) };
  });
  const uniqueValuesCount = num(o.uniqueValuesCount) as number;
  const returned = values.length;
  return {
    field: requested,
    fieldPath: str(o.field),
    valueType: str(o.type),
    uniqueValuesCount,
    missingStudiesCount: num(o.missingStudiesCount),
    returned,
    // The universal truncation invariant: returned < unique ⇒ truncated (rolled up
    // into buildMeta via the response-level returned/totalAvailable roll-up too).
    truncated: returned < uniqueValuesCount,
    overlapping: CT_FACET_ARRAY_FIELDS.has(requested),
    values,
  };
}

export type CtFacetArgs = { fields: string[] };

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
export async function facetCounts(args: CtFacetArgs): Promise<MetaBundle> {
  // ── [ssrf] In-handler field RE-GUARD (load-bearing for a Zod-BYPASSING direct
  //    call): re-check EACH requested field against the frozen CT_FACET_FIELDS_SET
  //    INLINE (mirror CT_FUNDER_TYPES_SET / CT_STATUSES_SET) BEFORE building params,
  //    and dedupe (preserving order). A non-member ⇒ invalid_input PRE-fetch, 0
  //    network call — NO raw field-name ever reaches the URL. ──
  const requested = args.fields ?? [];
  const seen = new Set<string>();
  const fields: string[] = [];
  for (const f of requested) {
    if (!CT_FACET_FIELDS_SET.has(f)) {
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        message: `field ${JSON.stringify(f)} is not a supported facet (ships: ${CT_FACET_FIELDS.join(", ")}). An unlisted field is NOT asserted upstream-invalid (it may be a real STRING/BOOLEAN field this tool deliberately does not whitelist) — refused before any fetch (SSRF + ENUM-shape-stability guard).`,
        retryable: false,
        upstreamEndpoint: CT_STATS_FIELDS_LABEL,
      });
    }
    if (!seen.has(f)) {
      seen.add(f);
      fields.push(f);
    }
  }
  if (fields.length === 0) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `at least one facet field is required (ships: ${CT_FACET_FIELDS.join(", ")}).`,
      retryable: false,
      upstreamEndpoint: CT_STATS_FIELDS_LABEL,
    });
  }

  // ── Build the query from the enum-validated array (SSRF: module-built, comma-
  //    joined; each element is a frozen enum member — no raw passthrough). The ONLY
  //    query key is `fields`; no filter/scope/page key is EVER sent (they 400). ──
  const params = new URLSearchParams();
  params.set("fields", fields.join(","));

  const body = await getCT(CT_STATS_FIELDS_PATH, CT_STATS_FIELDS_LABEL, params);
  // The 200 body is a TOP-LEVEL ARRAY (one object per requested field). Its absence
  // is drift, NEVER a fake-empty distribution. A 404 (a whitelisted field missing
  // upstream = whitelist drift) / 400 / 5xx is THROWN by getJson (never caught).
  if (!Array.isArray(body)) {
    throw driftError(
      CT_STATS_FIELDS_LABEL,
      "clinicaltrials facet shape drift — /stats/field/values response must be a top-level array (one object per requested field).",
    );
  }

  // Match each requested field to its response element by the echoed `piece`
  // (robust to element ordering); a whitelisted field absent from the response is
  // whitelist drift ⇒ driftError, never a silent empty.
  const byPiece = new Map<string, unknown>();
  for (const el of body as unknown[]) {
    const p = (el ?? {}) as Record<string, unknown>;
    if (typeof p.piece === "string" && !byPiece.has(p.piece)) byPiece.set(p.piece, el);
  }
  const facets: CtFacet[] = [];
  for (const f of fields) {
    const el = byPiece.get(f);
    if (el === undefined) {
      throw driftError(
        CT_STATS_FIELDS_LABEL,
        `clinicaltrials facet shape drift — requested field '${f}' is absent from the response (a whitelisted field must always be echoed; its absence signals the whitelist drifted from upstream — NEVER read as an empty distribution).`,
      );
    }
    facets.push(mapFacet(f, el));
  }

  // ── [M1] Response-level roll-up: returned = Σ values.length, totalAvailable =
  //    Σ uniqueValuesCount (DISTINCT VALUES, not studies — the unit note discloses
  //    it). buildMeta's `returned < totalAvailable ⇒ truncated:true / complete:false`
  //    auto-derives truncation the instant ANY facet is capped; for the v1 ENUM
  //    whitelist returned == totalAvailable ⇒ complete:true, truncated:false. ──
  const returned = facets.reduce((a, ff) => a + ff.values.length, 0);
  const totalAvailable = facets.reduce(
    (a, ff) => a + (ff.uniqueValuesCount ?? 0),
    0,
  );

  // ── Notes: the mandatory unit (M1) + scope (M2) always; per-facet truncation /
  //    overlap / high-missing conditionals; the facet-scoped trial≠award caveat +
  //    data-currency always. ──
  const notes: string[] = [CT_FACET_UNIT_NOTE, CT_FACET_SCOPE_NOTE];
  for (const ff of facets) {
    if (ff.truncated && ff.uniqueValuesCount !== null) {
      notes.push(ctFacetTruncationNote(ff.field, ff.uniqueValuesCount, ff.returned));
    }
  }
  for (const ff of facets) {
    if (ff.overlapping) notes.push(ctFacetOverlapNote(ff.field));
  }
  for (const ff of facets) {
    const missing = ff.missingStudiesCount;
    const shown = ff.values.reduce((a, v) => a + (v.studiesCount ?? 0), 0);
    // Denominator-free (no frozen registry total, M2): the shown buckets cover a
    // MINORITY when more studies lack a value than are represented across them.
    if (missing !== null && missing > shown) {
      notes.push(ctFacetHighMissingNote(ff.field, missing));
    }
  }
  notes.push(CT_FACET_TRIAL_CAVEAT, CT_DATA_CURRENCY_NOTE);

  return withMeta(
    { facets },
    {
      source: CT_FACET_SOURCE,
      keylessMode: true,
      returned,
      totalAvailable,
      // complete/truncated DERIVED by buildMeta from returned/totalAvailable (never
      // forced): v1 ENUM ⇒ complete:true; a future capped facet ⇒ complete:false.
      filtersApplied: [],
      filtersDropped: [],
      fieldsUnavailable: [],
      // NO pagination object — /stats/field/values is un-paged (pageSize 400s);
      // leave `pagination` undefined (NOT {hasMore:false}).
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
