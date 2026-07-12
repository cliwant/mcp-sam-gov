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
 *   →3416 — a ~1000× silent false-negative). A multi-TOKEN value (split on
 *   CT_TOKEN_SPLIT_RE, not just whitespace) fires a MANDATORY `_meta` AND-note (the
 *   mirror of NSF's OR-note, but AND); a multi-token sponsor SUPPRESSES the
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
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` (clinicaltrials.num === coerce.num — a num regression fails together;
// NO local num/str in this module).
export { num };
// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
const CT_HOST = "clinicaltrials.gov";
// The FIXED base literal (host + api version). All paths interpolate off this.
const CT_BASE = "https://clinicaltrials.gov/api/v2";
const CT_STUDIES_PATH = "/studies";
// HOST+path label (keyless ⇒ no token can ever appear). Surfaces in
// ToolError.upstreamEndpoint.
const CT_LABEL = "clinicaltrials:/api/v2/studies";
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
];
const CT_STATUSES_SET = new Set(CT_STATUSES);
// funderType — the 4 live-nonzero-confirmed values (P16). The other 4 (indiv /
// network / ambig / unknown) return 0 even on the whole registry (behaviorally
// IDENTICAL to the P18 silent-invalid-zero), so they are EXCLUDED. This is the
// load-bearing honesty guard: an INVALID funderType silently fake-empties at
// HTTP 200, so a non-member is invalid_input PRE-fetch, NEVER sent.
export const CT_FUNDER_TYPES = ["nih", "fed", "industry", "other"];
const CT_FUNDER_TYPES_SET = new Set(CT_FUNDER_TYPES);
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
const CT_TRIAL_CAVEAT = "A ClinicalTrials.gov record is the REGISTRATION of a clinical study, NOT a federal grant or contract award. leadSponsor.class / funderType (NIH/FED) indicate the study's funding-SOURCE class, and the sponsor / collaborator / organization NAMES overlap the entities in NIH RePORTER / NSF Awards / SAM / USAspending — but leadSponsor.name is a FREE-TEXT string, NOT a UEI, so any cross-reference to a federal award is a NOMINAL name match, not an authoritative entity join, and a registered trial does not imply a federal award to that sponsor.";
/** The opaque-cursor disclosure (offset/nextOffset are meaningless). */
const CT_CURSOR_NOTE = "ClinicalTrials.gov uses an opaque cursor: pagination.offset/nextOffset are not meaningful (null). Continue by passing _meta.nextCursor back as the `pageToken` argument; hasMore:false / nextCursor:null means this is the last page.";
/** funderType is a NON-EXCLUSIVE facet (values overlap; sum > registry total). */
const CT_FUNDER_OVERLAP_NOTE = "funderType is an OVERLAPPING facet — a study can have multiple funders, so the per-funderType counts MUST NOT be summed across values to reconstruct a registry total.";
/** query.spons is a fuzzy sponsor NAME search, not an exact-entity join. Emitted
 *  ONLY for a SINGLE-token sponsor: for a MULTI-token sponsor CT AND-splits and
 *  NARROWS (e.g. 'Sanofi-Aventis' → 'Sanofi' AND 'Aventis'), so the "matches more
 *  variants" broadening framing here would be the OPPOSITE of what happened — the
 *  AND-note (andTokenNote) takes precedence in that case (see searchStudies). */
const CT_SPONSOR_NOTE = "sponsor is a full-text sponsor-NAME search (query.spons), not an exact-entity equality — a single-token name also matches related name variants (e.g. 'Pfizer' matches 'Pfizer's Upjohn'), and the name is free text, NOT a UEI (nominal match only).";
/** A conservative data-currency note (not API-verifiable). */
const CT_DATA_CURRENCY_NOTE = "ClinicalTrials.gov updates registrations on a rolling basis; per-record refresh lag is not API-verifiable.";
// CT's Essie analyzer AND-tokenizes free-text query.spons/query.cond/query.term on
// whitespace AND a specific PUNCTUATION set, NOT whitespace alone. LIVE-verified
// 2026-07-12 (`query.spons=sanofi<delim>aventis` == the whitespace count 3, ≠ the
// single-token "sanofi.aventis"→0): space + `- , / ; + & | @ # =` ALL SPLIT into
// the AND co-occurrence; `. : _ '` do NOT split (kept as one literal token). So a
// single-token-LOOKING compound like "Sanofi-Aventis" is really 'Sanofi' AND
// 'Aventis' (→3 vs Sanofi→3416 — a ~1000× silent false-negative), and a
// whitespace-only detector would MISS it and skip the mandatory AND-note. The
// class is the PRECISE confirmed-splitter set (NOT a non-alnum superset — that
// would over-disclose a split CT did not make on `.`/`_`/`'`). This is the CT
// analogue of NSF's NSF_KEYWORD_SPLIT_RE (there OR, here AND); `-` is placed last
// (literal); `/` is escaped for the regex-literal delimiter.
const CT_TOKEN_SPLIT_RE = /[\s,;+&|@#=\/-]+/;
/** The AND-tokenization disclosure for a multi-TOKEN term/sponsor/condition value. */
function andTokenNote(field, tokens) {
    return `ClinicalTrials.gov tokenizes a multi-word ${field} on whitespace AND punctuation (hyphen, comma, slash, semicolon, etc.) and matches it as AND — ALL tokens must co-occur; this value was split into [${tokens.join(", ")}], so a 0/small count means no study matches EVERY token, NOT that the ${field} is absent (e.g. 'Sanofi-Aventis' = 'Sanofi' AND 'Aventis' → far fewer than 'Sanofi' alone). Try a single distinctive token.`;
}
const CT_SOURCE = "clinicaltrials.gov /api/v2/studies (keyless)";
/** A string array from a mixed value, else [] (drops non-string entries). */
function strArray(x) {
    if (!Array.isArray(x))
        return [];
    return x.map((v) => str(v)).filter((v) => v !== null);
}
/** Map a collaborators[]-style array of {name,class} entities (honest [] when absent). */
function mapEntities(x) {
    if (!Array.isArray(x))
        return [];
    return x.map((c) => {
        const it = (c ?? {});
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
function mapStudy(item, includeSummary) {
    const it = (item ?? {});
    const ps = (it.protocolSection ?? {});
    const idm = (ps.identificationModule ?? {});
    const org = (idm.organization ?? {});
    const orgStudyIdInfo = (idm.orgStudyIdInfo ?? {});
    const scm = (ps.sponsorCollaboratorsModule ?? {});
    const lead = (scm.leadSponsor ?? {});
    const statusM = (ps.statusModule ?? {});
    const startStruct = (statusM.startDateStruct ?? {});
    const designM = (ps.designModule ?? {});
    const condM = (ps.conditionsModule ?? {});
    const descM = (ps.descriptionModule ?? {});
    const leadClass = str(lead.class);
    const study = {
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
    if (includeSummary)
        study.briefSummary = str(descM.briefSummary);
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
async function getCT(path, label, params) {
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
export async function searchStudies(args) {
    const pageSize = args.pageSize ?? 20;
    // ── [M1] In-handler enum re-guard (funderType AND overallStatus) — throw
    //    invalid_input PRE-fetch (0 network call), mirroring govinfo's in-handler
    //    collection re-check. This is load-bearing for a DIRECT handler call that
    //    bypasses Zod: an unknown funderType would build aggFilters=funderType:<v>
    //    and get a fabricated HTTP-200 totalCount:0 (the silent fake-empty trap). ──
    if (args.funderType !== undefined &&
        !CT_FUNDER_TYPES_SET.has(args.funderType)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `funderType ${JSON.stringify(args.funderType)} is not supported by this tool (ships: ${CT_FUNDER_TYPES.join(", ")}). An unlisted funderType silently returns totalCount:0 at HTTP 200 on ClinicalTrials.gov (indistinguishable from a genuine empty) — refused before any fetch.`,
            retryable: false,
            upstreamEndpoint: CT_LABEL,
        });
    }
    if (args.overallStatus !== undefined &&
        !CT_STATUSES_SET.has(args.overallStatus)) {
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
    const filtersApplied = [];
    const andNotes = [];
    // A helper: push a filter + detect MULTI-TOKEN AND-tokenization on CT's REAL
    // delimiter set (whitespace AND the confirmed punctuation splitters —
    // CT_TOKEN_SPLIT_RE), so a compound like "Sanofi-Aventis" (= Sanofi AND Aventis)
    // fires the mandatory AND-note instead of leaking as one token through a
    // hyphen/comma/slash. Returns true iff the value split into 2+ tokens (so the
    // caller can suppress the contradictory sponsor-broadening note). andField=null
    // for fields with no AND-note obligation (location).
    const pushText = (value, upstreamKey, filterLabel, andField) => {
        if (value === undefined)
            return false;
        params.set(upstreamKey, value);
        filtersApplied.push(filterLabel);
        if (andField === null)
            return false;
        const tokens = value.trim().split(CT_TOKEN_SPLIT_RE).filter((t) => t.length > 0);
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
    if (args.pageToken !== undefined)
        params.set("pageToken", args.pageToken);
    const body = await getCT(CT_STUDIES_PATH, CT_LABEL, params);
    const b = (body ?? {});
    // ── Container-guarded drift (never a TypeError masking drift as
    //    upstream_unavailable, never a fake empty). ──
    if (!Array.isArray(b.studies)) {
        throw driftError(CT_LABEL, "clinicaltrials shape drift — /studies response.studies must be an array.");
    }
    // countTotal=true was sent, so totalCount MUST be a finite number — its absence
    // is drift, NEVER a silently-null total, NEVER studies.length (§Honesty #1).
    if (typeof b.totalCount !== "number" || !Number.isFinite(b.totalCount)) {
        throw driftError(CT_LABEL, "clinicaltrials shape drift — /studies totalCount missing/non-number on a countTotal=true request (typeof-checked BEFORE num() so a non-number can't silently parse; NEVER fall back to studies.length).");
    }
    const studies = b.studies.map((s) => mapStudy(s, false));
    const returned = studies.length;
    const totalAvailable = num(b.totalCount); // EXACT (genuine 0 → 0)
    // ── Opaque-cursor honesty (§Honesty #2). Terminal = token ABSENT. The token is
    //    surfaced VERBATIM (never fabricated/derived). Phantom-empty guard: 0
    //    studies WITH a token ⇒ terminal (never advertise a continuation into an
    //    empty cursor loop). ──
    const rawNext = b.nextPageToken;
    const nextToken = typeof rawNext === "string" && rawNext.length > 0 ? rawNext : null;
    let hasMore;
    let nextCursor;
    if (returned === 0 && nextToken !== null) {
        hasMore = false;
        nextCursor = null;
    }
    else {
        hasMore = nextToken !== null;
        nextCursor = nextToken;
    }
    // ── Notes: the mandatory caveat + cursor + data-currency always; the
    //    conditional facet/tokenization disclosures; the unscoped recommendation. ──
    const notes = [CT_TRIAL_CAVEAT, CT_CURSOR_NOTE];
    notes.push(...andNotes);
    // Emit the sponsor-broadening note ONLY for a SINGLE-token sponsor. For a
    // MULTI-token sponsor CT AND-split and NARROWED (the andNotes AND-note fired),
    // so the "matches more variants" framing would AFFIRMATIVELY MISLEAD (the
    // opposite of what happened) — the AND-note is what the caller must see.
    if (args.sponsor !== undefined && !sponsorMultiToken)
        notes.push(CT_SPONSOR_NOTE);
    if (args.funderType !== undefined)
        notes.push(CT_FUNDER_OVERLAP_NOTE);
    if (filtersApplied.length === 0) {
        notes.push("No filters were applied — this is an unscoped query over the WHOLE ClinicalTrials.gov registry (~593k studies). Add a filter (query.term, sponsor, condition, location, overallStatus, funderType) for a meaningful scoped result set.");
    }
    notes.push(CT_DATA_CURRENCY_NOTE);
    return withMeta({ studies }, {
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
    });
}
// ─── Tool 2: clinicaltrials_get_study ─────────────────────────────
/**
 * Fetch ONE study by its NCT id; returns the fuller single record (entity fields
 * + briefSummary). [M2] `nctId` is regex-validated `^NCT\d{8}$` BEFORE the path is
 * built (a `../` / non-matching id ⇒ invalid_input, 0 fetch). A 404 (nonexistent
 * NCT id) ⇒ honest found:false (never a fabricated study).
 */
export async function getStudy(args) {
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
    const notes = [CT_TRIAL_CAVEAT, CT_DATA_CURRENCY_NOTE];
    let body;
    try {
        body = await getCT(`${CT_STUDIES_PATH}/${nctId}`, CT_LABEL, new URLSearchParams());
    }
    catch (e) {
        // A nonexistent NCT id ⇒ HTTP 404 ⇒ getJson throws not_found ⇒ honest
        // found:false (a definitive answer, never a fabricated study).
        if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
            return withMeta({ found: false, nctId, study: null }, {
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
            });
        }
        throw e;
    }
    // A valid single-study 200 carries protocolSection at the TOP level (P11). Its
    // absence is drift (never a fabricated all-null record).
    const bo = (body ?? {});
    if (bo.protocolSection === null ||
        typeof bo.protocolSection !== "object" ||
        Array.isArray(bo.protocolSection)) {
        throw driftError(CT_LABEL, "clinicaltrials shape drift — /studies/{nctId} response is missing a protocolSection object.");
    }
    const study = mapStudy(body, true); // FULL record incl. briefSummary
    return withMeta({ found: true, nctId, study }, {
        source: CT_SOURCE,
        keylessMode: true,
        returned: 1,
        totalAvailable: 1,
        complete: true,
        filtersApplied: ["nctId"],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
//# sourceMappingURL=clinicaltrials.js.map