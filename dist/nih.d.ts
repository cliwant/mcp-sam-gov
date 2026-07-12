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
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const NIH_ORG_STATES: readonly ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "AS", "GU", "MP", "PR", "VI"];
export type NihOrgState = (typeof NIH_ORG_STATES)[number];
export type NihPrincipalInvestigator = {
    profileId: number | null;
    firstName: string | null;
    lastName: string | null;
    fullName: string | null;
    isContactPi: boolean | null;
    title: string | null;
};
export type NihProject = {
    projectNum: string | null;
    projectTitle: string | null;
    fiscalYear: number | null;
    awardAmount: number | null;
    awardType: string | null;
    activityCode: string | null;
    isActive: boolean | null;
    organization: {
        name: string | null;
        city: string | null;
        state: string | null;
        country: string | null;
        /** The SAM/USAspending recipient join key (but grant ≠ contract — M2). */
        primaryUei: string | null;
        primaryDuns: string | null;
        ueis: string[];
        duns: string[];
    };
    principalInvestigators: NihPrincipalInvestigator[];
    contactPiName: string | null;
    fundingIc: {
        code: string | null;
        abbreviation: string | null;
        name: string | null;
    };
};
export type NihSearchArgs = {
    orgStates?: NihOrgState[];
    orgNames?: string[];
    fiscalYears?: number[];
    limit?: number;
    offset?: number;
};
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
export declare function searchProjects(args: NihSearchArgs): Promise<MetaBundle>;
//# sourceMappingURL=nih.d.ts.map