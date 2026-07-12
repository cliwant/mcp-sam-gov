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
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` (nsf.num === coerce.num === nih.num — a num regression fails together).
export { num };
// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
const NSF_HOST = "api.nsf.gov";
const NSF_PATH = "/services/v1/awards.json";
const NSF_URL = `https://${NSF_HOST}${NSF_PATH}`;
// HOST-only-ish label (path is fixed + carries no token — keyless). Surfaces in
// ToolError.upstreamEndpoint; no secret can appear here (the API is anonymous).
const NSF_LABEL = "nsf:/services/v1/awards.json";
// ─── The 10,000-record retrieval window + count-saturation cap ─────
// LIVE-verified: metadata.totalCount saturates at 10,000 (ES track_total_hits)
// AND offset+rpp>10,000 → FATAL AwardAPI-004. The reachable slice and the count
// floor coincide at exactly 10,000.
const RETRIEVAL_WINDOW = 10_000;
// ─── Client-side value grammars (SSRF + silent-foot-gun guards) ────
// A UEI is 12 uppercase alnum; the API is case-insensitive, so we uppercase-
// normalize before sending for a stable exact match.
const UEI_RE = /^[A-Za-z0-9]{12}$/;
// STRICT mm/dd/yyyy: a wrong format (e.g. 2024-01-01) is silently MIS-PARSED by
// NSF (845 ≠ 369), NOT loud-failed — so it must be rejected client-side.
const MMDDYYYY_RE = /^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/;
// NSF award ids are all-digit. LIVE-verified 2026-07-12 across 1982 ids spanning
// 1950..2026: EVERY id is 7 digits (min 2423690, max 8207220, 0 non-numeric).
// `\d{5,9}` comfortably contains that with headroom on both ends (do not narrow
// to exactly 7 and risk rejecting an unsampled legitimate id); numeric-only is
// the actual injection-safety property.
const AWARD_ID_RE = /^\d{5,9}$/;
// M1 — NSF's Elasticsearch analyzer OR-tokenizes a keyword on whitespace AND a
// specific PUNCTUATION set, NOT whitespace alone. LIVE-verified 2026-07-12 (each
// `wordA<delim>wordB` returned an OR union broader than either single term):
// space + `- , / ; + & | @ # =` ALL SPLIT; `. : _ ' \ *` do NOT split (kept as one
// token); `~ ( )` loud-fail as ES query-syntax special chars (already surfaced by
// the loud-fail guard). So a single-token-LOOKING compound like "coral-reef" is
// really coral OR reef (a far broader set) — detect multi-token on THIS class (not
// just whitespace) so the mandatory OR-note is never skipped. The class is the
// PRECISE confirmed-splitter set (no non-alnum superset — that would over-disclose
// a union NSF did not make on `.`/`_`/`'`). `-` is placed last (literal); `/` is
// escaped for the regex-literal delimiter.
const NSF_KEYWORD_SPLIT_RE = /[\s,;+&|@#=\/-]+/;
// ─── Frozen US state/territory 2-letter USPS enum (UPPERCASE-only) ─
// Built FROM this array by the Zod enum in server.ts (single source of truth).
// It is BOTH the awardeeStateCode value guard AND the silent-zero guard: LIVE,
// an unknown-but-well-typed value ("ZZ") returns a genuine totalCount:0
// indistinguishable from "no NSF funding in that state", and a lowercase "ca"
// silently matches (case-insensitive) — so a NON-state typo must be an
// invalid_input, never read as "no NSF funding" (a silent honesty failure).
export const NSF_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
    "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
    "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
    "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
    "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI",
    "WY", "AS", "GU", "MP", "PR", "VI",
];
const NSF_STATES_SET = new Set(NSF_STATES);
// ─── Disclosure constants (honesty obligations) ──────────────────
/** M2 — the mandatory grant-vs-contract caveat carried in EVERY response. */
const NSF_GRANT_CAVEAT = "NSF Awards are RESEARCH GRANTS made by the National Science Foundation, NOT federal procurement contracts. awardee.ueiNumber / parentUeiNumber join to SAM entities and USAspending recipients (same UEI space), but the award nature differs (grants fund research, not goods/services) — do not present these amounts as contract awards.";
/** The UEI join disclosure — how to bridge to the SAM/USAspending recipient graph. */
const UEI_JOIN_NOTE = "awardee.ueiNumber is the EXACT join key to SAM entities and USAspending recipients (same UEI space); parentUeiNumber rolls up to the parent organization. A grant recipient is not necessarily a federal contractor.";
/** Amount labeling disclosure (the two amounts mean different things). */
const AMOUNTS_NOTE = "amounts.fundsObligatedAmt = funds obligated to date; amounts.estimatedTotalAmt = estimated total award value over its life (labeled distinctly). Both arrive as strings and are coerced null-never-0 (a real $0 stays 0; an absent amount is null, never a fabricated 0). amounts.fundsObligatedByYear is a verbatim display-only array.";
/** A conservative data-currency note (not API-verifiable). */
const DATA_CURRENCY_NOTE = "NSF updates awards on a rolling basis; per-record refresh lag is not API-verifiable.";
/** Live-verified date-filter semantics (Open-Q6 — do not assume). */
const DATE_SEMANTICS_NOTE = "dateStart / dateEnd filter on the award ACTION date (the initial award / obligation date — the `date` / initAmendmentDate field, live-verified 2026-07-12), NOT the project startDate or expDate. Format is STRICT mm/dd/yyyy; a yyyy-mm-dd (or any other format) is silently mis-parsed by NSF (not an error), so it is rejected client-side.";
/** #1 — the 10,000 saturation lower-bound disclosure. */
const LOWER_BOUND_NOTE = "NSF returns an exact match count only below 10,000; this query has AT LEAST 10,000 matching awards (the exact total is not exposed) and only the first 10,000 are retrievable — narrow filters (state, UEI, PI, date, keyword) to bring the set under 10,000 for an exact count and full reachability.";
/** #7 — the effective-rpp clamp disclosure (when the page hit the window edge). */
function clampNote(rpp) {
    return `The requested page would cross NSF's ${RETRIEVAL_WINDOW}-record retrieval window; the outgoing page size was reduced to ${rpp} to keep offset+rpp ≤ ${RETRIEVAL_WINDOW} (crossing it triggers a FATAL AwardAPI-004). Records beyond ${RETRIEVAL_WINDOW} are unreachable via this keyless API.`;
}
/** M1 — the multi-token keyword OR-tokenization disclosure. */
function orSemanticsNote(tokens) {
    return `NSF tokenizes a keyword on whitespace AND punctuation (hyphen, comma, slash, semicolon, etc.) and matches it as a UNION of its tokens — this result matches awards containing ANY of [${tokens.join(", ")}], NOT the exact phrase/compound; the total may be far broader than intended. For a narrower set, use a single distinctive keyword or add a scoping filter (state, UEI, PI, date).`;
}
const SOURCE = "api.nsf.gov /services/v1/awards.json (keyless)";
/** "true"/true → true, "false"/false → false, absent/other → null (never a
 *  fabricated false) — copied verbatim from nih.ts. */
function boolOrNull(x) {
    if (x === true)
        return true;
    if (x === false)
        return false;
    if (x === "true")
        return true;
    if (x === "false")
        return false;
    return null;
}
/** A string array from a mixed value, else [] (drops non-string entries). */
function strArray(x) {
    if (!Array.isArray(x))
        return [];
    return x.map((v) => str(v)).filter((v) => v !== null);
}
/**
 * Map ONE NSF award[] row → the curated enrichment shape. Every scalar is
 * null-never-fabricated (str/num); the two amounts are `num` (a real $0 → 0,
 * absent → null). `middleInitial` reads the VERBATIM misspelled `piMiddeInitial`.
 * An absent field maps to null (honest "unknown"), never a crash. abstractText
 * is included ONLY when `includeAbstract` (nsf_get_award) — search rows omit it.
 */
function mapAward(raw, includeAbstract) {
    const r = (raw ?? {});
    const award = {
        id: str(r.id),
        title: str(r.title),
        agency: str(r.agency),
        awardAgencyCode: str(r.awardAgencyCode),
        fundAgencyCode: str(r.fundAgencyCode),
        cfdaNumber: str(r.cfdaNumber),
        transType: str(r.transType),
        awardee: {
            name: str(r.awardeeName),
            legalName: str(r.awardee),
            city: str(r.awardeeCity),
            stateCode: str(r.awardeeStateCode),
            countryCode: str(r.awardeeCountryCode),
            zipCode: str(r.awardeeZipCode),
            districtCode: str(r.awardeeDistrictCode),
            ueiNumber: str(r.ueiNumber),
            parentUeiNumber: str(r.parentUeiNumber),
        },
        performanceSite: {
            location: str(r.perfLocation),
            city: str(r.perfCity),
            stateCode: str(r.perfStateCode),
            countryCode: str(r.perfCountryCode),
            zipCode: str(r.perfZipCode),
        },
        principalInvestigator: {
            fullName: str(r.pdPIName),
            firstName: str(r.piFirstName),
            lastName: str(r.piLastName),
            middleInitial: str(r.piMiddeInitial), // VERBATIM misspelled source key
            email: str(r.piEmail),
            id: str(r.piId),
        },
        coPrincipalInvestigators: strArray(r.coPDPI),
        programOfficer: { name: str(r.poName), email: str(r.poEmail) },
        amounts: {
            fundsObligatedAmt: num(r.fundsObligatedAmt),
            estimatedTotalAmt: num(r.estimatedTotalAmt),
            fundsObligatedByYear: strArray(r.fundsObligated),
        },
        dates: {
            startDate: str(r.startDate),
            expDate: str(r.expDate),
            lastActionDate: str(r.date),
            initAmendmentDate: str(r.initAmendmentDate),
            latestAmendmentDate: str(r.latestAmendmentDate),
        },
        program: {
            fundProgramName: str(r.fundProgramName),
            program: str(r.program),
            directorateAbbr: str(r.dirAbbr),
            divisionAbbr: str(r.divAbbr),
            orgLongName: str(r.orgLongName),
            orgLongName2: str(r.orgLongName2),
        },
        activeAward: boolOrNull(r.activeAwd),
        historicalAward: boolOrNull(r.histAwd),
    };
    if (includeAbstract)
        award.abstractText = str(r.abstractText);
    return award;
}
// ─── SSRF-guarded fetch (module-built URLSearchParams + hostname assert) ──
/**
 * GET `api.nsf.gov/services/v1/awards.json` with the module-built query. SSRF:
 * the host+path are constants; `params` are URLSearchParams-encoded values (no
 * host-alteration surface); then the CONSTRUCTED URL's hostname === NSF_HOST
 * (https) assertion. Sets `redirect:"error"` (off-host 3xx fails closed — its
 * body is never read). NO headers (keyless — no key/UA required, byte-clean init).
 * Returns the parsed JSON (unknown; the caller validates the response envelope).
 */
async function nsfGet(params) {
    const url = `${NSF_URL}?${params.toString()}`;
    // Belt-and-suspenders: the FIXED host+path leave nothing to steer the
    // authority; assert the built URL cannot have been moved off-host (a future
    // constant typo / downgrade).
    const built = new URL(url);
    if (built.hostname !== NSF_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed NSF URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${NSF_HOST} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
            upstreamEndpoint: NSF_LABEL,
        });
    }
    return getJson(built.toString(), { label: NSF_LABEL, redirect: "error" });
}
/**
 * Validate the HTTP-200 body envelope and extract the EXACT total + raw rows.
 * Guard ORDER (a body-level 200 can carry an error):
 *   (a) `serviceNotification` present AND `metadata` absent → a BODY-LEVEL LOUD-
 *       FAIL — THROW (never read award:[] as empty). AwardAPI-004 / FATAL (deep
 *       offset — we guard it pre-fetch) ⇒ upstream_unavailable (retryable); any
 *       other (AwardAPI-002 invalid param, or an unforeseen future type that
 *       drops metadata) ⇒ invalid_input surfacing the code+message.
 *   (b) `metadata` absent with NO notification, or a non-object `response`, or a
 *       non-array `award`, or a non-finite `metadata.totalCount` ⇒ driftError
 *       (schema_drift) — never a fabricated empty.
 *   (c) `totalCount === 10000` ⇒ totalIsLowerBound:true (ES saturation);
 *       `< 10000` ⇒ EXACT; `0` ⇒ a genuine empty (handled by the caller).
 */
function parseNsfBody(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw driftError(NSF_LABEL, "NSF awards.json returned a 200 body that is not an object {response:{…}} (an array or scalar) — refusing to report it as an empty result.");
    }
    const resp = body.response;
    if (resp === null || typeof resp !== "object" || Array.isArray(resp)) {
        throw driftError(NSF_LABEL, "NSF awards.json 200 body is missing the `response` object — treating as schema drift (never a fake empty).");
    }
    const r = resp;
    const notifications = Array.isArray(r.serviceNotification)
        ? r.serviceNotification
        : [];
    const metadataPresent = typeof r.metadata === "object" &&
        r.metadata !== null &&
        !Array.isArray(r.metadata);
    // (a) BODY-LEVEL LOUD-FAIL: a serviceNotification with metadata DROPPED. NEVER
    //     read award:[] as an empty result (fault (c)). Every observed loud-fail
    //     (ERROR AwardAPI-002 / FATAL AwardAPI-004) drops metadata (v2-confirmed),
    //     so this catches them all — plus any unforeseen future type that drops it.
    if (notifications.length > 0 && !metadataPresent) {
        const first = notifications[0] ?? {};
        const code = str(first.notificationCode) ?? "(no code)";
        const type = str(first.notificationType) ?? "(no type)";
        const message = str(first.notificationMessage) ?? "(no message)";
        if (code === "AwardAPI-004" || type === "FATAL") {
            // Deep-offset window overflow — we guard offset+rpp ≤ 10,000 PRE-fetch, so
            // this is an unexpected upstream fault here (retryable).
            throw new ToolErrorCarrier({
                kind: "upstream_unavailable",
                message: `NSF returned a FATAL service notification [${code}]: ${message} (an unexpected retrieval-window fault; the module guards offset+rpp ≤ ${RETRIEVAL_WINDOW} pre-fetch).`,
                retryable: true,
                retryAfterSeconds: 30,
                upstreamEndpoint: NSF_LABEL,
            });
        }
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `NSF rejected the request [${type} ${code}]: ${message}. (The module builds the query from a validated whitelist, so this indicates upstream parameter drift — never a silent empty.)`,
            retryable: false,
            upstreamEndpoint: NSF_LABEL,
        });
    }
    // (b) SHAPE guard: metadata must be present + carry a finite totalCount.
    if (!metadataPresent) {
        throw driftError(NSF_LABEL, "NSF awards.json is missing `response.metadata` with no serviceNotification — nothing trustworthy to report as a total (treating as schema drift).");
    }
    const md = r.metadata;
    if (typeof md.totalCount !== "number" || !Number.isFinite(md.totalCount)) {
        throw driftError(NSF_LABEL, "NSF metadata.totalCount absent/non-numeric — cannot report a trustworthy total (schema drift). typeof-checked BEFORE num() so a non-number can't silently parse.");
    }
    if (!Array.isArray(r.award)) {
        throw driftError(NSF_LABEL, "NSF awards.json returned a non-array `response.award` with valid metadata — treating as schema drift (never a fake empty).");
    }
    // EXACT total (num defensively — the typeof+finite guard already passed, so
    // this is guaranteed non-null; num keeps nsf.num === coerce.num single-source).
    const totalAvailable = num(md.totalCount);
    // === 10,000 ⇒ SATURATED (ES track_total_hits) ⇒ a disclosed LOWER BOUND.
    const totalIsLowerBound = totalAvailable === RETRIEVAL_WINDOW;
    return { totalAvailable, totalIsLowerBound, rawAwards: r.award };
}
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
export async function searchAwards(args) {
    const limit = args.limit ?? 25;
    const offset = args.offset ?? 0;
    // ── Window pre-fetch guard (#7): offset ≥ 10,000 is UNREACHABLE — refuse
    //    BEFORE any fetch (also enforced by the server's Zod .max(9999); this is
    //    the belt-and-suspenders module guard for a direct caller). ──
    if (offset >= RETRIEVAL_WINDOW) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `NSF caps keyless retrieval at the first ${RETRIEVAL_WINDOW} records (offset 0..${RETRIEVAL_WINDOW - 1}); offset ${offset} is unreachable — narrow criteria (state, UEI, PI, date, keyword) to bring the target set under ${RETRIEVAL_WINDOW}.`,
            retryable: false,
            upstreamEndpoint: NSF_LABEL,
        });
    }
    // ── Belt-and-suspenders value grammars (behind the server's Zod enum/regex).
    //    A direct caller must not slip a bad state (silent 0), a bad-format date
    //    (silent mis-parse), or a malformed UEI past these. ──
    if (args.awardeeStateCode !== undefined &&
        !NSF_STATES_SET.has(args.awardeeStateCode)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid awardeeStateCode ${JSON.stringify(args.awardeeStateCode)} — expected a USPS 2-letter state/territory code (a non-state value silently returns 0 awards on NSF, indistinguishable from "no funding").`,
            retryable: false,
            upstreamEndpoint: NSF_LABEL,
        });
    }
    for (const [k, v] of [
        ["ueiNumber", args.ueiNumber],
        ["parentUeiNumber", args.parentUeiNumber],
    ]) {
        if (v !== undefined && !UEI_RE.test(v)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                message: `Invalid ${k} ${JSON.stringify(v)} — expected 12 alphanumeric characters (a SAM/USAspending UEI).`,
                retryable: false,
                upstreamEndpoint: NSF_LABEL,
            });
        }
    }
    for (const [k, v] of [
        ["dateStart", args.dateStart],
        ["dateEnd", args.dateEnd],
    ]) {
        if (v !== undefined && !MMDDYYYY_RE.test(v)) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                message: `Invalid ${k} ${JSON.stringify(v)} — expected STRICT mm/dd/yyyy (a wrong format like yyyy-mm-dd is silently mis-parsed by NSF, not an error).`,
                retryable: false,
                upstreamEndpoint: NSF_LABEL,
            });
        }
    }
    // ── Effective rpp clamp (#7 — LOAD-BEARING): outgoing rpp = min(limit,
    //    RETRIEVAL_WINDOW − offset) so a last page can NEVER cross 10,000 and
    //    trigger FATAL AwardAPI-004 (Zod alone permits offset 9999 + limit 100 =
    //    10099 → FATAL). offset ≤ 9999 (guarded above) ⇒ rpp ≥ 1. ──
    const rpp = Math.min(limit, RETRIEVAL_WINDOW - offset);
    // ── Build the query from VALIDATED typed args, key-by-key (SSRF: no raw
    //    passthrough). A filter is added — and listed in filtersApplied — ONLY when
    //    supplied AND live-confirmed to narrow (M1). agency / printFields are never
    //    sent (agency = NSF-only-corpus zeros-out foot-gun; printFields = proven
    //    no-op). UEIs are uppercase-normalized for a stable exact match. ──
    const params = new URLSearchParams();
    const filtersApplied = [];
    let multiWordKeyword = null;
    if (args.keyword !== undefined) {
        params.set("keyword", args.keyword);
        filtersApplied.push("keyword");
        // M1: split on NSF's REAL tokenizer delimiters (whitespace AND the confirmed
        // punctuation splitters — NSF_KEYWORD_SPLIT_RE), so a compound like
        // "coral-reef" (= coral OR reef) fires the OR-note instead of leaking as one
        // token through a non-whitespace delimiter.
        const tokens = args.keyword
            .trim()
            .split(NSF_KEYWORD_SPLIT_RE)
            .filter((t) => t.length > 0);
        if (tokens.length > 1)
            multiWordKeyword = tokens; // M1 OR-disclosure trigger
    }
    if (args.awardeeStateCode !== undefined) {
        params.set("awardeeStateCode", args.awardeeStateCode.toUpperCase());
        filtersApplied.push("awardeeStateCode");
    }
    if (args.awardeeName !== undefined) {
        params.set("awardeeName", args.awardeeName);
        filtersApplied.push("awardeeName");
    }
    if (args.ueiNumber !== undefined) {
        params.set("ueiNumber", args.ueiNumber.toUpperCase());
        filtersApplied.push("ueiNumber");
    }
    if (args.parentUeiNumber !== undefined) {
        params.set("parentUeiNumber", args.parentUeiNumber.toUpperCase());
        filtersApplied.push("parentUeiNumber");
    }
    if (args.pdPIName !== undefined) {
        params.set("pdPIName", args.pdPIName);
        filtersApplied.push("pdPIName");
    }
    if (args.dateStart !== undefined) {
        params.set("dateStart", args.dateStart);
        filtersApplied.push("dateStart");
    }
    if (args.dateEnd !== undefined) {
        params.set("dateEnd", args.dateEnd);
        filtersApplied.push("dateEnd");
    }
    params.set("offset", String(offset));
    params.set("rpp", String(rpp));
    const parsed = parseNsfBody(await nsfGet(params));
    const { totalAvailable, totalIsLowerBound } = parsed;
    const awards = parsed.rawAwards.map((raw) => mapAward(raw, false));
    const returned = awards.length;
    // ── Pagination within the window (#7): NEVER hand a dead-end nextOffset that
    //    would FATAL. nextOffset is null once candidateNext reaches the window OR
    //    (when the total is EXACT — not a lower bound) the exact total. When
    //    totalIsLowerBound (≥10k) the window edge (10,000) IS the reachable end. ──
    const candidateNext = offset + returned;
    const nextOffset = candidateNext >= RETRIEVAL_WINDOW ||
        (!totalIsLowerBound && candidateNext >= totalAvailable)
        ? null
        : candidateNext;
    const hasMore = nextOffset !== null;
    const notes = [NSF_GRANT_CAVEAT, UEI_JOIN_NOTE, AMOUNTS_NOTE];
    if (multiWordKeyword)
        notes.push(orSemanticsNote(multiWordKeyword)); // M1
    if (totalIsLowerBound)
        notes.push(LOWER_BOUND_NOTE);
    if (rpp < limit)
        notes.push(clampNote(rpp));
    if (args.dateStart !== undefined || args.dateEnd !== undefined)
        notes.push(DATE_SEMANTICS_NOTE);
    if (filtersApplied.length === 0)
        notes.push("No filters were applied — this is an unscoped query over the whole NSF award corpus (the count saturates at 10,000). Add a filter (keyword, state, UEI, PI, date) for an exact count and a meaningful result set.");
    notes.push(DATA_CURRENCY_NOTE);
    const metaOut = {
        source: SOURCE,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: ["abstractText (search rows omit it — use nsf_get_award)"],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    };
    if (totalIsLowerBound)
        metaOut.totalIsLowerBound = true;
    return withMeta({ awards }, metaOut);
}
// ─── Tool 2: nsf_get_award ────────────────────────────────────────
/**
 * Fetch ONE NSF award by its numeric award id; returns the FULL single record
 * INCLUDING abstractText. Not-found is honest: `id=<nonexistent>` returns
 * totalCount:0 / award:[] (a genuine empty) ⇒ found:false, NEVER a fabricated
 * record. `id` is numeric-only (injection-safe).
 */
export async function getAward(args) {
    // Belt-and-suspenders (behind the server's Zod ^\d{5,9}$).
    if (!AWARD_ID_RE.test(args.awardId)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid awardId ${JSON.stringify(args.awardId)} — expected an all-digit NSF award id (5–9 digits).`,
            retryable: false,
            upstreamEndpoint: NSF_LABEL,
        });
    }
    const params = new URLSearchParams();
    params.set("id", args.awardId);
    const parsed = parseNsfBody(await nsfGet(params));
    const { totalAvailable } = parsed;
    const notes = [NSF_GRANT_CAVEAT, UEI_JOIN_NOTE, AMOUNTS_NOTE, DATA_CURRENCY_NOTE];
    // Genuine-empty (totalCount:0, award:[]) ⇒ found:false (never a fabricated record).
    if (parsed.rawAwards.length === 0 || totalAvailable === 0) {
        return withMeta({ found: false, award: null }, {
            source: SOURCE,
            keylessMode: true,
            returned: 0,
            totalAvailable: 0,
            filtersApplied: ["awardId"],
            filtersDropped: [],
            fieldsUnavailable: [],
            notes: [
                `No NSF award has id ${JSON.stringify(args.awardId)} (found:false — an honest not-found, never a fabricated record).`,
                ...notes,
            ],
        });
    }
    const award = mapAward(parsed.rawAwards[0], true); // FULL record incl. abstractText
    return withMeta({ found: true, award }, {
        source: SOURCE,
        keylessMode: true,
        returned: 1,
        totalAvailable: 1,
        filtersApplied: ["awardId"],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
//# sourceMappingURL=nsf.js.map