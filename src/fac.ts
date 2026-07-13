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

import { ToolErrorCarrier } from "./errors.js";
import { getJsonWithHeaders, driftError, throughGate } from "./datasource.js";
import { num, str } from "./coerce.js";
import { keyHeader, keyModeLabel, pushKeyNote } from "./datagovKey.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js) so
// the fault suite's num-parity guard resolves fac.num === coerce.num, exactly
// like fdic.num / cms.num / datagov.num.
export { num };

// ─── Constants (SSRF core) ─────────────────────────────────────────
const FAC_HOST = "api.fac.gov";
// Single-entry host allowlist (structured for a later host-add; the belt-and-
// suspenders Set.has recheck runs in getFac).
export const FAC_HOSTS: readonly string[] = [FAC_HOST];
const FAC_HOST_SET: ReadonlySet<string> = new Set(FAC_HOSTS);
// One host = one rate budget. A modest self-throttle — courtesy to a shared
// api.data.gov-fronted host, doubly warranted by the ~10 req/hr DEMO_KEY ceiling.
const FAC_MIN_INTERVAL_MS = 200;
export const FAC_LABEL = "fac:" + FAC_HOST; // → ToolError.upstreamEndpoint (host-only)
const GATE_KEY = "fac";

// Fixed table path constants — the TOOL chooses these; NO caller value on the
// path (SSRF core / no table-injection surface).
const TABLE_GENERAL = "general";
const TABLE_FINDINGS = "findings";

// ★ The HARDCODED positive select-allowlists (the PII crux). These are the ONLY
// columns ever named on the wire — every personal-contact column
// (auditee_email/phone/certify_name/certify_title/contact_name/contact_title) is
// STRUCTURALLY excluded. NO caller can supply a `select`/column param.
export const GENERAL_SELECT =
  "report_id,auditee_uei,audit_year,auditee_name,auditee_ein,auditee_state,auditee_city,total_amount_expended,fac_accepted_date";
export const FINDINGS_SELECT =
  "report_id,auditee_uei,audit_year,award_reference,reference_number,is_material_weakness,is_modified_opinion,is_questioned_costs,is_repeat_finding,is_significant_deficiency,is_other_findings,is_other_matters,type_requirement,prior_finding_ref_numbers";

// Fixed default orders (deterministic offset windows; never caller-derived).
const GENERAL_ORDER = "fac_accepted_date.desc";
const FINDINGS_ORDER = "report_id.asc,reference_number.asc";

// The 7 audit-RISK flags (STRING "Y"/"N"/blank live) mapped to the tri-state.
const RISK_FLAG_COLUMNS = [
  "is_material_weakness",
  "is_modified_opinion",
  "is_questioned_costs",
  "is_repeat_finding",
  "is_significant_deficiency",
  "is_other_findings",
  "is_other_matters",
] as const;

// ─── Input grammars (belt-and-suspenders behind the server's Zod schemas — the
// fault suite calls these functions directly, bypassing Zod, so re-validation
// here is load-bearing for the SSRF/injection rejects). ────────────
const UEI_RE = /^[A-Z0-9]{12}$/;
const STATE_RE = /^[A-Z]{2}$/;
const REPORT_ID_RE = /^[0-9A-Za-z-]+$/;
const REPORT_ID_MAX = 64;

function invalidInput(message: string): ToolErrorCarrier {
  return new ToolErrorCarrier({ kind: "invalid_input", message, retryable: false });
}

// ─── Disclosure constants (honesty obligations — verbatim, fault-asserted) ──

/**
 * ★ §PII(d) — the mandatory not-a-determination caveat carried on EVERY response
 * (mirrors OFAC_NOT_DETERMINATION_NOTE / NPPES_NOT_DETERMINATION_NOTE). Kept
 * verbatim so the fault suite can assert it.
 */
export const FAC_NOT_DETERMINATION_NOTE =
  "Public Single Audit data (Federal Audit Clearinghouse; 2 CFR 200 Subpart F / Single Audit Act). Reports the independent auditor's findings, opinions, and questioned costs AS SUBMITTED — it is NOT a debarment, suspension, exclusion, or fitness determination, and an audit finding is the auditor's opinion, not proof of wrongdoing (many findings are routine and remediated). This tool DELIBERATELY EXCLUDES the auditee's personal-contact fields (email / phone / certifying-official name) — the vetting subject is the entity, not the individual. Cross-check SAM exclusions + OFAC and read the specific finding text before acting.";

/** ★ P3 — the risk-flag typing disclosure carried on EVERY fac_get_findings response. */
export const FAC_VALUE_TYPING_NOTE =
  "Risk flags (is_material_weakness, is_modified_opinion, is_questioned_costs, is_repeat_finding, is_significant_deficiency, is_other_findings, is_other_matters) are surfaced VERBATIM as the auditor reported them (\"Y\"/\"N\") plus a typed riskFlags tri-state; a blank/absent flag is UNKNOWN (null), NOT a \"no\" — never read a null flag as 'no finding'.";

/** ★ M2 — the empty-findings ≠ clean-audit disclosure (any totalAvailable:0 / empty findings). */
export const FAC_EMPTY_FINDINGS_NOTE =
  "An empty findings list means NO findings are ON RECORD for this UEI/report — it does NOT confirm a clean audit. The entity may not have filed a Single Audit (below the $750K threshold), the audit may predate FAC coverage, or the UEI may be wrong. Confirm the entity has an ACCEPTED audit via fac_search_audits before treating empty as clean.";

/** P1 — the Content-Range hedge disclosure (a `*`/absent/non-numeric denominator). */
const FAC_TOTAL_HEDGE_NOTE =
  "FAC did not return an exact Content-Range total (the denominator was '*', absent, or non-numeric); totalAvailable is UNKNOWN (null) and hasMore is inferred from page-fullness — page via offset until a short page confirms the end (never read this as 0 results).";

function facSource(): string {
  return `${FAC_HOST} via Federal Audit Clearinghouse API (${keyModeLabel()})`;
}

// ─── P1 — Content-Range EXACT-total parse (num-guarded, null-never-0) ──
/**
 * Parse the EXACT total from `Content-Range: <start>-<end>/<TOTAL>` — take the
 * substring after the LAST `/` and `num()` it. A run of digits → the EXACT total
 * (`0` denominator → 0, a genuine-empty total); a `*` (PostgREST "count not
 * computed") / non-number / absent header → null (NEVER 0 — the null-never-0 rule
 * on a header). Exported for the Content-Range-matrix fault fixture.
 */
export function parseTotal(contentRange: string | null): number | null {
  if (typeof contentRange !== "string") return null;
  const slash = contentRange.lastIndexOf("/");
  if (slash < 0) return null;
  // num("*")→null, num("")→null, num("37144")→37144, num("0")→0 (genuine zero).
  return num(contentRange.slice(slash + 1).trim());
}

// ─── P3 — risk-flag tri-state ("Y"→true / "N"→false / else → null=UNKNOWN) ──
/**
 * Map an FAC risk flag to an HONEST tri-state: "Y" → true, "N" → false, and a
 * null / blank / absent / any-other value → null (UNKNOWN — NEVER false). A null
 * `is_material_weakness` silently read as "no material weakness" is the false-CLEAR
 * class OFAC/sam_check_exclusions forbid. Exported for the flag-type fault fixture.
 */
export function flagTri(v: unknown): boolean | null {
  const s = typeof v === "string" ? v.trim().toUpperCase() : v;
  if (s === "Y") return true;
  if (s === "N") return false;
  return null;
}

// ─── SSRF-guarded fetch (fixed host + hostname assert + redirect) ──
/**
 * GET one FAC PostgREST table through the shared header-exposing port. `table` is
 * a FIXED per-tool constant (general/findings) — NO caller value on the path. The
 * key rides `X-Api-Key` ONLY (keyHeader), `Prefer: count=exact` requests the
 * EXACT total, `redirect:"error"` refuses an off-host 3xx (no key egress), and the
 * CONSTRUCTED URL's hostname must equal api.fac.gov over https (+ a Set.has
 * recheck). Returns `{ body, contentRange }`. A 200 non-JSON body (r.json()
 * SyntaxError, e.g. an HTML maintenance page) is reclassified to schema_drift
 * (S1); the structured 400/403/429/5xx/timeout taxonomy propagates unchanged.
 */
async function getFac(
  table: string,
  params: URLSearchParams,
): Promise<{ body: unknown; contentRange: string | null }> {
  const url = `https://${FAC_HOST}/${table}?${params.toString()}`;
  const built = new URL(url);
  if (
    built.hostname !== FAC_HOST ||
    built.protocol !== "https:" ||
    !FAC_HOST_SET.has(built.hostname)
  ) {
    throw invalidInput(
      `Constructed FAC URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${FAC_HOST} over https — refusing to fetch (SSRF safety).`,
    );
  }
  try {
    return await throughGate(GATE_KEY, FAC_MIN_INTERVAL_MS, () =>
      getJsonWithHeaders(url, {
        label: FAC_LABEL,
        headers: { ...keyHeader(), Prefer: "count=exact" },
        redirect: "error",
      }),
    );
  } catch (e) {
    // Preserve the structured taxonomy (400/403/429/5xx/timeout/off-host-redirect).
    if (e instanceof ToolErrorCarrier) throw e;
    // ★ S1 — a 200 non-JSON body makes getJsonWithHeaders' r.json() throw a
    // SyntaxError → reclassify to schema_drift (an honest THROW, never a fake
    // empty). The shared port stays byte-identical (reclassification is HERE).
    if (e instanceof SyntaxError) {
      throw driftError(
        FAC_LABEL,
        "FAC returned a non-JSON body at HTTP 2xx — treating as schema drift.",
      );
    }
    throw e;
  }
}

/** Assert the parsed body is a JSON array (P2 drift guard); else driftError. */
function asArray(body: unknown, table: string): unknown[] {
  if (!Array.isArray(body)) {
    throw driftError(
      FAC_LABEL,
      `FAC ${table} returned a non-array body — treating as schema drift (PostgREST returns a bare JSON array; never a fake empty).`,
    );
  }
  return body;
}

// ─── row mappers (pick ONLY the allowlist keys — a drifted extra column, incl.
// any personal-contact field, can NOT reach the output) ────────────
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

function mapAudit(rec: Record<string, unknown>): FacAudit {
  return {
    report_id: str(rec.report_id),
    auditee_uei: str(rec.auditee_uei),
    audit_year: str(rec.audit_year), // a STRING live ("2026")
    auditee_name: str(rec.auditee_name),
    auditee_ein: str(rec.auditee_ein), // a STRING live ("911767139")
    auditee_state: str(rec.auditee_state),
    auditee_city: str(rec.auditee_city),
    total_amount_expended: num(rec.total_amount_expended), // JSON number, null-never-0
    fac_accepted_date: str(rec.fac_accepted_date),
  };
}

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
  // ★ P3 — the typed tri-state convenience view ("Y"→true/"N"→false/UNKNOWN→null).
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

function mapFinding(rec: Record<string, unknown>): FacFinding {
  return {
    report_id: str(rec.report_id),
    auditee_uei: str(rec.auditee_uei),
    audit_year: str(rec.audit_year),
    award_reference: str(rec.award_reference),
    reference_number: str(rec.reference_number),
    // Flags surfaced VERBATIM ("Y"/"N"/null — str nulls ""/"null", so a blank
    // flag is null=UNKNOWN, never "N").
    is_material_weakness: str(rec.is_material_weakness),
    is_modified_opinion: str(rec.is_modified_opinion),
    is_questioned_costs: str(rec.is_questioned_costs),
    is_repeat_finding: str(rec.is_repeat_finding),
    is_significant_deficiency: str(rec.is_significant_deficiency),
    is_other_findings: str(rec.is_other_findings),
    is_other_matters: str(rec.is_other_matters),
    type_requirement: str(rec.type_requirement),
    prior_finding_ref_numbers: str(rec.prior_finding_ref_numbers),
    riskFlags: {
      materialWeakness: flagTri(rec.is_material_weakness),
      modifiedOpinion: flagTri(rec.is_modified_opinion),
      questionedCosts: flagTri(rec.is_questioned_costs),
      repeatFinding: flagTri(rec.is_repeat_finding),
      significantDeficiency: flagTri(rec.is_significant_deficiency),
      otherFindings: flagTri(rec.is_other_findings),
      otherMatters: flagTri(rec.is_other_matters),
    },
  };
}
void RISK_FLAG_COLUMNS; // documented flag inventory (mapper enumerates explicitly)

// ─── Tool 1: fac_search_audits (the `general` table) ───────────────
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
export async function searchAudits(args: {
  auditeeUei?: string;
  auditeeState?: string;
  auditYear?: number;
  totalExpendedMin?: number;
  totalExpendedMax?: number;
  limit?: number;
  offset?: number;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 25;
  const offset = args.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw invalidInput("fac_search_audits: limit must be an integer in 1..100.");
  if (!Number.isInteger(offset) || offset < 0)
    throw invalidInput("fac_search_audits: offset must be an integer ≥ 0.");

  const params = new URLSearchParams();
  params.set("select", GENERAL_SELECT); // ★ hardcoded allowlist — never caller-derived
  const filtersApplied: string[] = [];

  if (args.auditeeUei !== undefined) {
    if (!UEI_RE.test(args.auditeeUei))
      throw invalidInput("fac_search_audits: auditeeUei must match ^[A-Z0-9]{12}$ (12-char UEI).");
    params.append("auditee_uei", `eq.${args.auditeeUei}`);
    filtersApplied.push("auditeeUei");
  }
  if (args.auditeeState !== undefined) {
    if (!STATE_RE.test(args.auditeeState))
      throw invalidInput("fac_search_audits: auditeeState must match ^[A-Z]{2}$ (2-letter state).");
    params.append("auditee_state", `eq.${args.auditeeState}`);
    filtersApplied.push("auditeeState");
  }
  if (args.auditYear !== undefined) {
    if (!Number.isInteger(args.auditYear))
      throw invalidInput("fac_search_audits: auditYear must be an integer.");
    params.append("audit_year", `eq.${args.auditYear}`);
    filtersApplied.push("auditYear");
  }
  if (args.totalExpendedMin !== undefined) {
    if (!Number.isFinite(args.totalExpendedMin))
      throw invalidInput("fac_search_audits: totalExpendedMin must be a finite number.");
    params.append("total_amount_expended", `gte.${args.totalExpendedMin}`);
    filtersApplied.push("totalExpendedMin");
  }
  if (args.totalExpendedMax !== undefined) {
    if (!Number.isFinite(args.totalExpendedMax))
      throw invalidInput("fac_search_audits: totalExpendedMax must be a finite number.");
    params.append("total_amount_expended", `lte.${args.totalExpendedMax}`);
    filtersApplied.push("totalExpendedMax");
  }
  params.set("order", GENERAL_ORDER);
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const { body, contentRange } = await getFac(TABLE_GENERAL, params);
  const rows = asArray(body, TABLE_GENERAL).map((r) =>
    mapAudit((r ?? {}) as Record<string, unknown>),
  );
  const returned = rows.length;
  const totalAvailable = parseTotal(contentRange); // EXACT or null
  const exact = totalAvailable !== null;
  const hasMore = exact ? offset + returned < totalAvailable : returned >= limit;
  const nextOffset = hasMore ? offset + returned : null;

  const notes: string[] = [];
  pushKeyNote(notes);
  if (!exact) notes.push(FAC_TOTAL_HEDGE_NOTE);
  notes.push(FAC_NOT_DETERMINATION_NOTE);

  return withMeta(
    { audits: rows },
    {
      source: facSource(),
      keylessMode: false,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool 2: fac_get_findings (the `findings` table) ───────────────
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
export async function getFindings(args: {
  auditeeUei?: string;
  reportId?: string;
  auditYear?: number;
  limit?: number;
  offset?: number;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw invalidInput("fac_get_findings: limit must be an integer in 1..100.");
  if (!Number.isInteger(offset) || offset < 0)
    throw invalidInput("fac_get_findings: offset must be an integer ≥ 0.");
  if (args.auditeeUei === undefined && args.reportId === undefined)
    throw invalidInput(
      "fac_get_findings: at least one of auditeeUei or reportId is REQUIRED (an empty query would scan the whole 670K-row findings table — refused).",
    );

  const params = new URLSearchParams();
  params.set("select", FINDINGS_SELECT); // ★ hardcoded allowlist — never caller-derived
  const filtersApplied: string[] = [];

  if (args.auditeeUei !== undefined) {
    if (!UEI_RE.test(args.auditeeUei))
      throw invalidInput("fac_get_findings: auditeeUei must match ^[A-Z0-9]{12}$ (12-char UEI).");
    params.append("auditee_uei", `eq.${args.auditeeUei}`);
    filtersApplied.push("auditeeUei");
  }
  if (args.reportId !== undefined) {
    if (!REPORT_ID_RE.test(args.reportId) || args.reportId.length > REPORT_ID_MAX)
      throw invalidInput(
        `fac_get_findings: reportId must match ^[0-9A-Za-z-]+$ (≤ ${REPORT_ID_MAX} chars).`,
      );
    params.append("report_id", `eq.${args.reportId}`);
    filtersApplied.push("reportId");
  }
  if (args.auditYear !== undefined) {
    if (!Number.isInteger(args.auditYear))
      throw invalidInput("fac_get_findings: auditYear must be an integer.");
    params.append("audit_year", `eq.${args.auditYear}`);
    filtersApplied.push("auditYear");
  }
  params.set("order", FINDINGS_ORDER);
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  const { body, contentRange } = await getFac(TABLE_FINDINGS, params);
  const rows = asArray(body, TABLE_FINDINGS).map((r) =>
    mapFinding((r ?? {}) as Record<string, unknown>),
  );
  const returned = rows.length;
  const totalAvailable = parseTotal(contentRange);
  const exact = totalAvailable !== null;
  const hasMore = exact ? offset + returned < totalAvailable : returned >= limit;
  const nextOffset = hasMore ? offset + returned : null;

  const notes: string[] = [];
  pushKeyNote(notes);
  if (!exact) notes.push(FAC_TOTAL_HEDGE_NOTE);
  // ★ M2 — an empty findings result is an AMBIGUOUS false-CLEAR; disclose that
  // empty ≠ clean audit (fires on any empty page / totalAvailable:0).
  if (returned === 0 || totalAvailable === 0) notes.push(FAC_EMPTY_FINDINGS_NOTE);
  notes.push(FAC_VALUE_TYPING_NOTE, FAC_NOT_DETERMINATION_NOTE);

  return withMeta(
    { findings: rows },
    {
      source: facSource(),
      keylessMode: false,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
