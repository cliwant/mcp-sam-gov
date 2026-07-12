/**
 * NIH RePORTER v2 — federal research-GRANT project records (keyless).
 *
 * A NEW capability axis: **federal research-funding footprint by organization /
 * UEI / state** — awarded NIH project money keyed to a recipient org (with UEI +
 * DUNS), a recipient-ENRICHMENT layer orthogonal to the spend/contract/regulatory
 * sources. It joins the SAM/USAspending recipient graph via `primary_uei` (the
 * SAME UEI space) — but the award nature DIFFERS (grants fund research, not
 * goods/services), so every response carries the grant-vs-contract caveat (M2).
 *
 * ON-DOMAIN HONESTY: this is research-funding / grants-adjacent, the AWARDED-money
 * sibling of grants.gov opportunities and the biomedical-R&D slice of USAspending
 * assistance awards — NOT core procurement. Positioned as recipient-enrichment /
 * R&D market intel, never as a contract source.
 *
 * THE R2 PORT'S FIRST NON-GET CONSUMER (ADR-0014): NIH RePORTER is a
 * POST-with-JSON-body API. `getJson` (ADR-0005) gained a byte-neutral,
 * backward-compatible `method`/`body` passthrough for exactly this; this module
 * writes ZERO fetch/coercion/error code — it REUSES `getJson` / `driftError` /
 * `num`·`str` / `withMeta` and COPIES (does not import) the fixed-host SSRF +
 * honesty PATTERN from CKAN/ECHO/FPDS, adapted:
 *
 * ★ SSRF GUARD (policy① — the SMALLEST surface of any source): the request URL is
 * a compile-time CONSTANT (fixed host `api.reporter.nih.gov` + fixed path
 * `/v2/projects/search`); NO caller input touches it. All filters ride in the POST
 * body, which is MODULE-BUILT from a validated typed criteria object then
 * `JSON.stringify`'d — there is NO raw-body / raw-criteria passthrough, so a
 * caller value cannot break out of its criterion into another key. A
 * post-construction hostname/protocol assertion + `redirect:"error"` lock it
 * (fail closed on any off-host 3xx; its body is never read).
 *
 * ★ FILTER HONESTY (M1 — the load-bearing discipline): a criterion is shipped ONLY
 * after being LIVE-CONFIRMED to actually narrow the result set. The confirmed
 * v1 set is `orgStates` + `orgNames` + `fiscalYears` (each live-verified to
 * reduce the total below the unfiltered baseline). `agency_ic_codes` is EXCLUDED
 * — it is silently DROPPED upstream (a filter that no-ops is never presented as
 * applied). A shipped filter goes in `_meta.filtersApplied`; a silent-drop filter
 * is never listed there and never exposed in the schema.
 *
 * ★ 15,000-RECORD RETRIEVAL WINDOW (M3+M4 — the critical disclosure): NIH caps
 * keyless retrieval at `offset 0..14,999` (`limit ≤ 500`), so only the first
 * 15,000 records of any result set are reachable. This is a cap on RETRIEVAL, NOT
 * on the COUNT: `meta.total` stays EXACT (never truncated to 15,000, never marked
 * `totalIsLowerBound`). `offset >= 15,000` is refused pre-fetch (`invalid_input`);
 * after a page, `nextOffset` is null once `offset+returned` reaches the cap or the
 * exact total (never a dead-end `nextOffset=15000`). `truncated` is derived by
 * buildMeta from `returned < totalAvailable`; when the count exceeds the window a
 * `_meta.notes` line discloses the unreachable remainder and recommends narrowing.
 *
 * ★ HONESTY `_meta`: shape-guard FIRST (a 200 body that is not `{meta,results:[]}`
 * → driftError, NEVER a fake empty); a non-numeric/absent `meta.total` →
 * driftError BEFORE `num(meta.total)`; genuine-empty (`total:0`) → complete:true /
 * totalAvailable:0; outage/5xx/timeout → getJson throws; 400 (bad offset/limit/
 * type) → invalid_input (surfaced, never `[]`). `num` is null-never-0 on
 * `award_amount` (a real $0 award is 0; an absent amount is null). Every response
 * discloses the grant-vs-contract caveat + a data-currency note.
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` (nih.num === coerce.num === treasury.num — a num regression fails together).
export { num };
// ─── Fixed endpoint (SSRF core — a compile-time CONSTANT) ─────────
const NIH_HOST = "api.reporter.nih.gov";
const NIH_PATH = "/v2/projects/search";
const NIH_PROJECTS_URL = `https://${NIH_HOST}${NIH_PATH}`;
// HOST-only-ish label (path is fixed + carries no token — keyless). Surfaces in
// ToolError.upstreamEndpoint; no secret can appear here (the API is anonymous).
const NIH_LABEL = "nih:/v2/projects/search";
// ─── The 15,000-record RETRIEVAL window (live-verified: offset ≤ 14,999,
// limit ≤ 500). A cap on RETRIEVAL, not on the exact meta.total count. The
// limit ≤ 500 ceiling is enforced by the server's Zod schema; this module owns
// the offset-window guard + the never-a-dead-end nextOffset boundary. ──
const RETRIEVAL_CAP = 15_000;
// ─── Frozen US state/territory 2-letter USPS enum (UPPERCASE-only) ─
// Built FROM this array by the Zod enum in server.ts (single source of truth).
// It is BOTH an org_states value guard AND the silent-zero guard: live, an unknown
// but well-typed value (e.g. "ZZ") returns a genuine total:0 indistinguishable
// from a real empty, and a lowercase "ca" silently returns zeros — so a typo must
// be an invalid_input, never read as "no NIH funding" (a silent honesty failure).
export const NIH_ORG_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
    "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
    "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
    "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
    "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI",
    "WY", "AS", "GU", "MP", "PR", "VI",
];
// ─── Disclosure constants (honesty obligations) ──────────────────
/** M2 — the mandatory grant-vs-contract caveat carried in EVERY response. */
const NIH_GRANT_CAVEAT = "NIH RePORTER records are RESEARCH GRANTS awarded by NIH, NOT federal procurement contracts. The primary_uei joins to SAM/USAspending recipient records, but the award nature differs (grants fund research, not goods/services) — do not present these amounts as contract awards.";
/** m-currency — a conservative data-currency note (not API-verifiable). */
const DATA_CURRENCY_NOTE = "NIH RePORTER updates on a rolling basis; per-record refresh lag is not API-verifiable.";
/** The UEI join disclosure — how to bridge to the SAM/USAspending recipient graph. */
const UEI_JOIN_NOTE = "organization.primaryUei is the join key to SAM entities and USAspending recipients (same UEI space); a grant recipient is not necessarily a federal contractor.";
/** M3+M4 — the retrieval-window disclosure when the count exceeds the 15,000 cap. */
function retrievalCapNote(total) {
    return `NIH caps keyless retrieval at the first ${RETRIEVAL_CAP} of ${total} matching records; the count is EXACT but records beyond ${RETRIEVAL_CAP} cannot be retrieved via this API — narrow criteria (org, fiscal year, state) to bring the target set under ${RETRIEVAL_CAP}.`;
}
const SOURCE = "api.reporter.nih.gov v2 (keyless)";
/** "true"/true → true, "false"/false → false, absent/other → null (never a
 *  fabricated false). */
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
/** A 2-letter uppercase string array from a mixed value, else []. */
function strArray(x) {
    if (!Array.isArray(x))
        return [];
    return x.map((v) => str(v)).filter((v) => v !== null);
}
/** Map ONE NIH results[] row → the curated enrichment shape. Every scalar is
 *  null-never-fabricated (str/num); `award_amount` is num (a real $0 → 0, absent
 *  → null). Field names are NIH v2 documented keys; an absent field maps to null
 *  (honest "unknown"), never a crash. */
function mapProject(raw) {
    const r = (raw ?? {});
    const org = (r.organization ?? {});
    const ic = (r.agency_ic_admin ?? {});
    const pis = Array.isArray(r.principal_investigators)
        ? r.principal_investigators
        : [];
    return {
        projectNum: str(r.project_num),
        projectTitle: str(r.project_title),
        fiscalYear: num(r.fiscal_year),
        awardAmount: num(r.award_amount),
        awardType: str(r.award_type),
        activityCode: str(r.activity_code),
        isActive: boolOrNull(r.is_active),
        organization: {
            name: str(org.org_name),
            city: str(org.org_city),
            state: str(org.org_state),
            country: str(org.org_country),
            primaryUei: str(org.primary_uei),
            primaryDuns: str(org.primary_duns),
            ueis: strArray(org.org_ueis),
            duns: strArray(org.org_duns),
        },
        principalInvestigators: pis.map((p) => ({
            profileId: num(p.profile_id),
            firstName: str(p.first_name),
            lastName: str(p.last_name),
            fullName: str(p.full_name),
            isContactPi: boolOrNull(p.is_contact_pi),
            title: str(p.title),
        })),
        contactPiName: str(r.contact_pi_name),
        fundingIc: {
            code: str(ic.code),
            abbreviation: str(ic.abbreviation),
            name: str(ic.name),
        },
    };
}
/**
 * Search awarded NIH research projects (POST /v2/projects/search). Structured,
 * LIVE-CONFIRMED-narrowing criteria only (orgStates / orgNames / fiscalYears),
 * AND-combined in a MODULE-BUILT criteria object → JSON.stringify (no raw
 * passthrough). Returns curated recipient-enrichment rows + honest `_meta`:
 * exact totalAvailable, exact within-window pagination, the 15,000-retrieval-cap
 * disclosure when the count exceeds it, and the mandatory grant-vs-contract
 * caveat. Disclose-not-refuse: an unscoped query is NOT refused — it returns the
 * first page + the exact total + a note recommending a criterion when the total
 * exceeds the window.
 */
export async function searchProjects(args) {
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    // ── 15k window pre-fetch guard (M3): offset >= 15,000 is UNREACHABLE — refuse
    //    BEFORE any fetch (also enforced by the server's Zod .max(14_999); this is
    //    the belt-and-suspenders module guard so a direct caller can't slip past). ──
    if (offset >= RETRIEVAL_CAP) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `NIH RePORTER caps pagination at the first ${RETRIEVAL_CAP} records (offset 0..${RETRIEVAL_CAP - 1}); offset ${offset} is unreachable via this keyless API. Narrow criteria (org, fiscal year, state) to bring the target set under ${RETRIEVAL_CAP}.`,
            retryable: false,
            upstreamEndpoint: NIH_LABEL,
        });
    }
    // ── Build the criteria object from VALIDATED typed input (SSRF: no raw
    //    passthrough; every value is enum/typed by the server's Zod before here). A
    //    filter is added — and listed in filtersApplied — ONLY when it is one of the
    //    LIVE-CONFIRMED narrowing criteria (M1). agency_ic_codes is never built (it
    //    silently no-ops upstream and is not in the schema). ──
    const criteria = {};
    const filtersApplied = [];
    if (args.fiscalYears && args.fiscalYears.length > 0) {
        criteria.fiscal_years = args.fiscalYears;
        filtersApplied.push("fiscalYears");
    }
    if (args.orgStates && args.orgStates.length > 0) {
        criteria.org_states = args.orgStates;
        filtersApplied.push("orgStates");
    }
    if (args.orgNames && args.orgNames.length > 0) {
        criteria.org_names = args.orgNames;
        filtersApplied.push("orgNames");
    }
    const payload = { criteria, limit, offset };
    // ── SSRF belt-and-suspenders: the URL is a compile-time constant, but assert it
    //    cannot have drifted (a future typo) — exactly the CKAN/FPDS post-construction
    //    check, adapted (no URLSearchParams: there are no query params). ──
    const built = new URL(NIH_PROJECTS_URL);
    if (built.hostname !== NIH_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed NIH URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${NIH_HOST} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
            upstreamEndpoint: NIH_LABEL,
        });
    }
    // ── The R2 port's first POST call. Content-Type is MANDATORY for NIH (415
    //    without it, 405 on GET). redirect:"error" fails closed on any off-host 3xx
    //    (its body is never read). The body is the module-built, JSON.stringify'd
    //    typed payload — never string-concatenated. ──
    const body = await getJson(NIH_PROJECTS_URL, {
        label: NIH_LABEL,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
    });
    // ── Shape guard FIRST → THROW (never fake-empty). A 200 body must be an OBJECT
    //    with a `meta` object and an array `results`. An array body (a 200-with-array
    //    drift), a missing `meta`, or a non-array `results` → driftError; NEVER read
    //    `results` as []. ──
    if (typeof body !== "object" ||
        body === null ||
        Array.isArray(body)) {
        throw driftError(NIH_LABEL, "NIH /v2/projects/search returned a 200 body that is not an object {meta,results} (an array or scalar) — refusing to report it as an empty result.");
    }
    const b = body;
    if (typeof b.meta !== "object" || b.meta === null || !Array.isArray(b.results)) {
        throw driftError(NIH_LABEL, "NIH /v2/projects/search returned an unexpected shape (expected an object with a `meta` object and an array `results`).");
    }
    const meta = b.meta;
    // ── m-total-guard: a non-number `meta.total` (or absent) is drift — num() cannot
    //    tell a non-number from an absent one, so typeof-check BEFORE num() (CKAN m6).
    //    Nothing trustworthy to report as a total → THROW, never proceed with null. ──
    if (typeof meta.total !== "number") {
        throw driftError(NIH_LABEL, "NIH meta.total absent/non-numeric — nothing trustworthy to report as a total (treating as schema drift).");
    }
    // EXACT total (§1a) — NEVER results.length, NEVER a lower bound. num() defensively
    // (a finite number passes through; a non-finite would be caught, but the typeof
    // guard above already rejected non-numbers).
    const totalAvailable = num(meta.total);
    const projects = b.results.map(mapProject);
    const returned = projects.length;
    // ── Pagination (M3+M4): NEVER hand a dead-end nextOffset=15000. nextOffset is
    //    null once offset+returned reaches the cap OR the exact total; hasMore mirrors
    //    it. NO mid-page clamp (offset+limit>15000 does NOT 400 — only offset≥15000). ──
    const candidateNext = offset + returned;
    const nextOffset = candidateNext >= RETRIEVAL_CAP ||
        (totalAvailable !== null && candidateNext >= totalAvailable)
        ? null
        : candidateNext;
    const hasMore = nextOffset !== null;
    const notes = [NIH_GRANT_CAVEAT, UEI_JOIN_NOTE, DATA_CURRENCY_NOTE];
    // Disclose-not-refuse + the reachability-cap disclosure: fire whenever the exact
    // count exceeds the reachable window (records beyond 15,000 are UNREACHABLE — the
    // honest superset of "truncated by the cap" and "an unscoped broad query").
    if (totalAvailable !== null && totalAvailable > RETRIEVAL_CAP) {
        notes.push(retrievalCapNote(totalAvailable));
    }
    const metaOut = {
        source: SOURCE,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    };
    return withMeta({ projects }, metaOut);
}
//# sourceMappingURL=nih.js.map