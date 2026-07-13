/**
 * fac.ts — CMS/GSA Federal Audit Clearinghouse (FAC) Single Audit vetting
 * (ADR-0038). A NEW keyless PostgREST adapter over `api.fac.gov` (fronted by
 * api.data.gov), housing TWO purpose-built audit-RISK vetting tools:
 *   - `fac_search_audits`  — the `general` table (entity Single Audit summaries)
 *   - `fac_get_findings`   — the `findings` table (the audit-RISK flags)
 * The B2G unlock: before teaming with / subcontracting to a partner, vet their
 * Single Audit RISK (material weaknesses, questioned costs, repeat findings,
 * modified opinions) — joinable to SAM/USAspending/EDGAR by UEI/EIN. DISTINCT
 * from `src/far.ts` (FAR clause compliance — no filename / gate-key collision).
 *
 * ★ KEYLESS-FIRST via the DEMO_KEY doctrine (the 3rd consumer of `datagovKey.ts`
 * after datagov.ts + govinfo.ts). A bare api.fac.gov request → HTTP 403
 * (API_KEY_MISSING); the SAME request + `X-Api-Key: DEMO_KEY` → 200/206 real
 * data. `keyHeader()` places the secret in the `X-Api-Key` header ONLY (never the
 * URL / label / _meta / a log); `resolvedKey()` falls back to the public literal
 * "DEMO_KEY" when DATA_GOV_API_KEY is unset. `keylessMode:false` (honest — it
 * genuinely sends a key, exactly like datagov.ts/govinfo.ts); `_meta.source`
 * discloses the key-MODE only.
 *
 * R2 consumer — reuses the shared port: `getJsonWithHeaders` (ADR-0038 M1 — the
 * header-exposing sibling of getJson; the EXACT total is a RESPONSE HEADER, not a
 * body field), `driftError` / `throughGate` (datasource.ts), `num`·`str`
 * (coerce.ts), `withMeta` (meta.ts). It writes ZERO bespoke fetch — a hand-rolled
 * fetch inside fac.ts would re-open `redirect:"error"` (a 3xx off api.fac.gov
 * carrying the X-Api-Key to a foreign host = key egress), the hostname/https
 * assert, and `keyHeader()` placement, all of which the shared port keeps
 * structurally present and ADR-0007-K-test-covered.
 *
 * ★ HONESTY (P1–P4; ADR §Q2 + the v2 review):
 *   (P1) The EXACT total is the `Content-Range` denominator (a RESPONSE HEADER
 *     under `Prefer: count=exact`; 206-on-subset). `parseTotal` takes the
 *     substring after the LAST `/`; a run of digits → num() EXACT; a `*`
 *     ("count not computed") / non-number / absent header → totalAvailable:null +
 *     a page-fullness `hasMore = returned >= limit` hedge + a disclosed note —
 *     NEVER 0 (the null-never-0 rule applied to a header).
 *   (P2) A genuine `[]` → honest empty (+ the M2 empty-findings note); a body
 *     that is not a JSON array → driftError. 400/403/5xx/timeout/off-host-redirect
 *     THROW via the port taxonomy (206 = success — `r.ok` covers 200-299). An
 *     HTML/non-JSON 200 (r.json() SyntaxError) → reclassified to schema_drift
 *     (S1) — never a fake empty.
 *   (P3) `total_amount_expended` is a JSON number → num() null-never-0. The `is_*`
 *     risk flags are STRINGS "Y"/"N" — surfaced verbatim (str → "Y"/"N"/null) AND
 *     mapped to a tri-state `riskFlags` object ("Y"→true / "N"→false / blank /
 *     absent / other → null=UNKNOWN). A null flag must NEVER read as false/"no
 *     material weakness" (the OFAC/sam_check_exclusions false-CLEAR class).
 *   (P4) Filters are server-side + self-policing: each caller filter maps to a
 *     KNOWN column + a FIXED operator, value-validated + URLSearchParams-encoded;
 *     a valid filter narrows the Content-Range total, a bad column → PostgREST 400
 *     → invalid_input. So `filtersDropped` is ALWAYS empty (no silent-drop path).
 *
 * ★ THE PII CRUX (load-bearing — §PII boundary, LIVE-confirmed SOUND): the
 * `select=` is a HARDCODED MODULE CONSTANT allowlist that SURFACES only entity +
 * audit-risk fields and EXCLUDES all 6 personal-contact columns (auditee_email,
 * auditee_phone, auditee_certify_name, auditee_certify_title, auditee_contact_name,
 * auditee_contact_title). PostgREST WILL project auditee_email the instant
 * `select=` names it (live-verified), so the tools accept NO caller-supplied
 * `select`/`order`/free-column param — the inputs are ONLY structured, validated
 * filters. Purpose-built tools bake the allowlist in by construction (the reason
 * v1 rejects a generic `fac_query{select}`). The mapper also picks ONLY the
 * allowlist keys, so even a drifted server that returns an extra column cannot
 * leak it into the output.
 *
 * ★ SSRF: fixed host `api.fac.gov` (single-entry FAC_HOSTS allowlist + a Set.has
 * recheck); the table name is a FIXED per-tool path CONSTANT (`general`/`findings`
 * — never caller free-text); filter values ride URLSearchParams as
 * `col=eq.VALUE`; `redirect:"error"`; a post-construction hostname/https assert.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const FAC_HOSTS: readonly string[];
export declare const FAC_LABEL: string;
export declare const GENERAL_SELECT = "report_id,auditee_uei,audit_year,auditee_name,auditee_ein,auditee_state,auditee_city,total_amount_expended,fac_accepted_date";
export declare const FINDINGS_SELECT = "report_id,auditee_uei,audit_year,award_reference,reference_number,is_material_weakness,is_modified_opinion,is_questioned_costs,is_repeat_finding,is_significant_deficiency,is_other_findings,is_other_matters,type_requirement,prior_finding_ref_numbers";
/**
 * ★ §PII(d) — the mandatory not-a-determination caveat carried on EVERY response
 * (mirrors OFAC_NOT_DETERMINATION_NOTE / NPPES_NOT_DETERMINATION_NOTE). Kept
 * verbatim so the fault suite can assert it.
 */
export declare const FAC_NOT_DETERMINATION_NOTE = "Public Single Audit data (Federal Audit Clearinghouse; 2 CFR 200 Subpart F / Single Audit Act). Reports the independent auditor's findings, opinions, and questioned costs AS SUBMITTED \u2014 it is NOT a debarment, suspension, exclusion, or fitness determination, and an audit finding is the auditor's opinion, not proof of wrongdoing (many findings are routine and remediated). This tool DELIBERATELY EXCLUDES the auditee's personal-contact fields (email / phone / certifying-official name) \u2014 the vetting subject is the entity, not the individual. Cross-check SAM exclusions + OFAC and read the specific finding text before acting.";
/** ★ P3 — the risk-flag typing disclosure carried on EVERY fac_get_findings response. */
export declare const FAC_VALUE_TYPING_NOTE = "Risk flags (is_material_weakness, is_modified_opinion, is_questioned_costs, is_repeat_finding, is_significant_deficiency, is_other_findings, is_other_matters) are surfaced VERBATIM as the auditor reported them (\"Y\"/\"N\") plus a typed riskFlags tri-state; a blank/absent flag is UNKNOWN (null), NOT a \"no\" \u2014 never read a null flag as 'no finding'.";
/** ★ M2 — the empty-findings ≠ clean-audit disclosure (any totalAvailable:0 / empty findings). */
export declare const FAC_EMPTY_FINDINGS_NOTE = "An empty findings list means NO findings are ON RECORD for this UEI/report \u2014 it does NOT confirm a clean audit. The entity may not have filed a Single Audit (below the $750K threshold), the audit may predate FAC coverage, or the UEI may be wrong. Confirm the entity has an ACCEPTED audit via fac_search_audits before treating empty as clean.";
/**
 * Parse the EXACT total from `Content-Range: <start>-<end>/<TOTAL>` — take the
 * substring after the LAST `/` and `num()` it. A run of digits → the EXACT total
 * (`0` denominator → 0, a genuine-empty total); a `*` (PostgREST "count not
 * computed") / non-number / absent header → null (NEVER 0 — the null-never-0 rule
 * on a header). Exported for the Content-Range-matrix fault fixture.
 */
export declare function parseTotal(contentRange: string | null): number | null;
/**
 * Map an FAC risk flag to an HONEST tri-state: "Y" → true, "N" → false, and a
 * null / blank / absent / any-other value → null (UNKNOWN — NEVER false). A null
 * `is_material_weakness` silently read as "no material weakness" is the false-CLEAR
 * class OFAC/sam_check_exclusions forbid. Exported for the flag-type fault fixture.
 */
export declare function flagTri(v: unknown): boolean | null;
export type FacAudit = {
    report_id: string | null;
    auditee_uei: string | null;
    audit_year: string | null;
    auditee_name: string | null;
    auditee_ein: string | null;
    auditee_state: string | null;
    auditee_city: string | null;
    total_amount_expended: number | null;
    fac_accepted_date: string | null;
};
export type FacFinding = {
    report_id: string | null;
    auditee_uei: string | null;
    audit_year: string | null;
    award_reference: string | null;
    reference_number: string | null;
    is_material_weakness: string | null;
    is_modified_opinion: string | null;
    is_questioned_costs: string | null;
    is_repeat_finding: string | null;
    is_significant_deficiency: string | null;
    is_other_findings: string | null;
    is_other_matters: string | null;
    type_requirement: string | null;
    prior_finding_ref_numbers: string | null;
    riskFlags: {
        materialWeakness: boolean | null;
        modifiedOpinion: boolean | null;
        questionedCosts: boolean | null;
        repeatFinding: boolean | null;
        significantDeficiency: boolean | null;
        otherFindings: boolean | null;
        otherMatters: boolean | null;
    };
};
/**
 * Search entity Single Audit summaries (`/general`). Structured filters (all
 * optional, AND-combined): `auditeeUei` (^[A-Z0-9]{12}$), `auditeeState`
 * (^[A-Z]{2}$), `auditYear` (int), `totalExpendedMin`/`totalExpendedMax` (finite
 * → gte/lte on total_amount_expended). Plus `limit` (1..100, def 25) / `offset`.
 * The `select=` is the HARDCODED GENERAL_SELECT allowlist (NO personal-contact
 * columns; NO caller column param). Order is the fixed GENERAL_ORDER.
 *
 * HONESTY: totalAvailable is the EXACT Content-Range denominator (P1; a `*`/
 * absent/non-numeric → null + a page-fullness hedge, never 0); a bad column ⇒
 * PostgREST 400 ⇒ invalid_input (filtersDropped always empty, P4); a genuine `[]`
 * ⇒ honest empty; 400/403/5xx/timeout/HTML(SyntaxError)/non-array THROW (P2, 206 =
 * success). The FAC_NOT_DETERMINATION_NOTE rides every response.
 */
export declare function searchAudits(args: {
    auditeeUei?: string;
    auditeeState?: string;
    auditYear?: number;
    totalExpendedMin?: number;
    totalExpendedMax?: number;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
/**
 * Drill into the audit-RISK findings (`/findings`) for a UEI and/or report. At
 * least ONE of `auditeeUei` (^[A-Z0-9]{12}$) / `reportId` (^[0-9A-Za-z-]+$) is
 * REQUIRED (empty → invalid_input, never a no-op full-table scan). Optional
 * `auditYear` (int), `limit` (1..100, def 50), `offset`. The `select=` is the
 * HARDCODED FINDINGS_SELECT allowlist (NO caller column param). Order is fixed.
 *
 * HONESTY: EXACT Content-Range total (P1); risk flags "Y"/"N" verbatim + the tri-
 * state riskFlags (P3, null-is-UNKNOWN); a bad column ⇒ 400 ⇒ invalid_input (P4);
 * 400/403/5xx/timeout/HTML/non-array THROW (P2); a genuine empty ⇒ honest empty +
 * the ★M2 empty≠clean note. FAC_NOT_DETERMINATION_NOTE + FAC_VALUE_TYPING_NOTE
 * ride every response.
 */
export declare function getFindings(args: {
    auditeeUei?: string;
    reportId?: string;
    auditYear?: number;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
//# sourceMappingURL=fac.d.ts.map