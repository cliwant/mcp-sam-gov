/**
 * cms-supplier.ts — two CMS supplier/vetting lanes on `data.cms.gov` (the SAME
 * data-API v1 dataset endpoint + the SAME two-request stats-count pattern as
 * cms-utilization.ts / ADR-0061; ADR-0064). KEYLESS.
 *
 * WHAT IT ADDS
 *   1. `cms_dmepos_suppliers` — CMS "Medicare Durable Medical Equipment,
 *      Devices & Supplies by Supplier": for a given supplier (NPI) or state, the
 *      DMEPOS supplier's identity + aggregate Medicare figures (HCPCS codes,
 *      beneficiaries, claims, services, submitted / Medicare-allowed / -paid
 *      amounts). A supplier-market / competitor-utilization lane on the SUPPLY
 *      side (who bills Medicare for equipment).
 *   2. `cms_revoked_providers` — CMS "Revoked Medicare Providers & Suppliers":
 *      the legally-published debarment / revocation list (7,059 rows), with the
 *      revoked provider's identity, provider type, revocation reason, effective
 *      date, and re-enrollment-bar expiration. A vetting / due-diligence lane in
 *      the SAME class as the OFAC / SAM-exclusions lists already shipped —
 *      surfacing the names IS the point (this is a public exclusion list).
 *
 * ★THE TWO-REQUEST PATTERN (the load-bearing P1 honesty — MIRRORS cms-utilization):
 *   the data-API's `/data` slice is a bare JSON array that reports NO total. So the
 *   EXACT total for a filter comes from a SEPARATE count sub-query — the identical
 *   `filter[...]` on the `/data-viewer/stats` endpoint returns
 *   `{ "data": { "found_rows": N, "total_rows": M } }`. Each tool runs the stats
 *   count FIRST (best-effort) then the data slice: totalAvailable = found_rows (P1,
 *   the per-filter EXACT total), NEVER the returned rows' length. If the stats
 *   sub-query fails or is absent, totalAvailable falls to null + a disclosing note
 *   (never a length-faked total) and the data slice still returns.
 *
 * ★THE FILTER-REQUIRED INPUT GUARD (dmepos only): the supplier table is large; an
 *   all-empty query (no npi, no state) is REFUSED with invalid_input (0 fetch) — a
 *   caller MUST pin npi OR state. The revocation list is only ~7K rows, so it is
 *   safe to page unfiltered (all its filters are optional).
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error") / `driftError` (datasource.ts), `str`/`num` (coerce.ts,
 * null-never-empty-string / null-never-0), and `withMeta`·`buildMeta` (meta.ts).
 * It MIRRORS cms-utilization.ts's fixed-host SSRF idiom (a single host const + a
 * post-construction hostname/protocol assertion + redirect:"error") and its
 * count-first two-request pattern + schema_drift catch-ladder.
 *
 * ★ SSRF: the host is a compile-time literal (`CMS_HOST`); the dataset UUIDs + the
 *   endpoint paths are MODULE literals. Every USER filter value rides as a
 *   URLSearchParams VALUE (`filter[Col]=Val`) — URLSearchParams encodes the bracket
 *   key AND the value, so a value can never break out into the path or inject a
 *   parameter. npi is `^\d{10}$`; state `^[A-Za-z]{2}$`; lastName is a bounded
 *   free-text charclass; size/offset are coerced to integers. A post-construction
 *   hostname/protocol assertion + `redirect:"error"` fail closed on any off-host 3xx.
 *
 * ★ HONESTY (ADR-0064 P1–P5, live-verified 2026-07-15 on data.cms.gov):
 *   [P1] totalAvailable = the stats sub-query's found_rows (EXACT), NOT the slice
 *        length. hasMore = offset+returned < total. Stats fails/absent ⇒
 *        totalAvailable:null + a disclosing note (never length-faked).
 *   [P2] empty array ⇒ honest empty (returned:0). dmepos all-empty input ⇒
 *        invalid_input (0 fetch). getJson maps a 4xx (⇒ invalid_input / not_found)
 *        / 5xx (⇒ upstream_unavailable) and THROWS; a 200 non-array/non-JSON body ⇒
 *        schema_drift (NEVER a fabricated empty).
 *   [P3] aggregates via num() (numeric strings → numbers; a real 0 stays 0; absent
 *        ⇒ null, never 0-faked); NPI / codes / reasons / dates as strings
 *        (null-never-empty-string); a coalesced name ⇒ null if none.
 *   [P4] a data body that is not an array ⇒ driftError; a stats body missing
 *        found_rows ⇒ totalAvailable:null (handled, not a crash).
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { str, num } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercions (single audited copy in ./coerce.js) so a
// regression fails together across sources. NO local num/str.
export { num, str };

// ─── SSRF core: the single fixed host + module-literal path pieces ──
const CMS_HOST = "data.cms.gov";
// HOST-only label — surfaces in ToolError.upstreamEndpoint; keyless, so no token
// can ever appear here.
const CMS_LABEL = "cms-supplier:data.cms.gov";

// ★THE DATASET UUIDs — SPECIFIC ANNUAL VINTAGES on data.cms.gov (live-verified,
// keyless). ★UPDATE YEARLY for the DMEPOS set (CMS publishes a new uuid per
// calendar year of supplier data); the revocation list is a rolling published
// register. Each vintage is surfaced to the caller in a _meta note so a consumer
// never mistakes it for "current" or an unspecified year.
const DMEPOS_DATASET_UUID = "a2d56d3f-3531-4315-9d87-e29986516b41"; // DMEPOS by Supplier (annual vintage)
const REVOKED_DATASET_UUID = "a6496a7d-4e19-479a-a9ad-d4c0a49e07c3"; // Revoked Medicare Providers & Suppliers (~7,059 rows)

// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
const NPI_RE = /^\d{10}$/; // a 10-digit National Provider Identifier
const STATE_RE = /^[A-Za-z]{2}$/; // 2-letter state/territory abbreviation
// lastName rides as a URLSearchParams VALUE (encoded), so this bound is a sanity
// guard, not an SSRF necessity: letters/digits/space and common name punctuation.
const LAST_NAME_RE = /^[A-Za-z0-9 .,'-]{1,100}$/;

const SIZE_MIN = 1;
const SIZE_MAX = 100;
const SIZE_DEFAULT = 25;

// ─── Honesty notes (ADR-0064 required set) ────────────────────────
const DMEPOS_VINTAGE_NOTE =
  `Source dataset: CMS "Medicare Durable Medical Equipment, Devices & Supplies — by Supplier" (data.cms.gov dataset ${DMEPOS_DATASET_UUID}) — a SPECIFIC ANNUAL VINTAGE (the most recent published year at build time), NOT a live/current or a multi-year figure. Amounts and counts are as-of that reference year. CMS publishes a new dataset id each year.`;
const DMEPOS_AGGREGATE_NOTE =
  "These are public SUPPLIER-level AGGREGATE Medicare DMEPOS figures (no patient identifiers). totalBeneficiaries is CMS-rounded and suppressed below 11 in the source. This is a utilization snapshot, NOT a fraud, quality, or fitness determination.";
const REVOKED_LIST_NOTE =
  `Source: CMS's PUBLIC "Revoked Medicare Providers & Suppliers" list (data.cms.gov dataset ${REVOKED_DATASET_UUID}) — a legally-published revocation/exclusion register (the same vetting class as the OFAC / SAM exclusion lists). A listing reflects a past Medicare enrollment revocation with its stated reason; it is a due-diligence signal, NOT a current-eligibility, guilt, or fitness determination. Verify against the primary source before acting.`;
const COUNT_FALLBACK_NOTE =
  "The count sub-query (…/data-viewer/stats) failed or did not report found_rows, so totalAvailable is null (unknown) — it was NOT faked from the returned row count. hasMore is a heuristic (a full page ⇒ likely more); re-page with offset to confirm.";

// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect:"error") ──
/**
 * GET one data.cms.gov JSON resource at a MODULE-BUILT URL (the dataset UUID + the
 * endpoint path are literals; all user filter VALUES are already carried in the
 * URLSearchParams `query`). Asserts the CONSTRUCTED URL's hostname === the fixed
 * host over https, and sets `redirect:"error"` (an off-host 3xx must NOT be
 * followed). Keyless — no headers.
 */
async function getCms(path: string, query: URLSearchParams): Promise<unknown> {
  const url = `https://${CMS_HOST}${path}?${query.toString()}`;
  const built = new URL(url);
  if (built.hostname !== CMS_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed CMS data-API URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(CMS_HOST)} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: CMS_LABEL,
    });
  }
  return getJson(built.toString(), { label: CMS_LABEL, redirect: "error" });
}

/**
 * The shared two-request slice: run the stats count sub-query FIRST (best-effort —
 * the EXACT total, P1), then the authoritative data slice. A count failure degrades
 * to totalAvailable:null + countFailed (never throws, never length-fakes). The data
 * slice preserves the 4xx/5xx/timeout ToolErrorCarrier taxonomy, reclassifies a 200
 * non-JSON SyntaxError to schema_drift, and asserts the body is an array (P4).
 */
async function fetchDatasetSlice(
  uuid: string,
  filters: URLSearchParams,
  size: number,
  offset: number,
): Promise<{ rows: unknown[]; totalAvailable: number | null; countFailed: boolean }> {
  const dataBase = `/data-api/v1/dataset/${uuid}/data`;
  const statsPath = `/data-api/v1/dataset/${uuid}/data-viewer/stats`;

  // ── (1) The COUNT sub-query FIRST. Body is `{ data: { found_rows, total_rows } }`.
  //    Any failure (network/5xx/drift/missing field) degrades to totalAvailable:null
  //    + a note; it NEVER throws and NEVER fakes the total from the slice length. ──
  let totalAvailable: number | null = null;
  let countFailed = false;
  try {
    const statsBody = await getCms(statsPath, filters);
    const dataObj =
      statsBody !== null &&
      typeof statsBody === "object" &&
      typeof (statsBody as Record<string, unknown>).data === "object" &&
      (statsBody as Record<string, unknown>).data !== null
        ? ((statsBody as Record<string, unknown>).data as Record<string, unknown>)
        : undefined;
    if (dataObj !== undefined) {
      const t = num(dataObj.found_rows);
      if (t !== null && t >= 0) {
        totalAvailable = t;
      } else {
        countFailed = true; // present body but no usable found_rows (P4)
      }
    } else {
      countFailed = true; // stats body not the expected { data: {…} } shape
    }
  } catch {
    countFailed = true; // any count error ⇒ degrade, never propagate (P1)
  }

  // ── (2) The DATA slice — the authoritative request (a bare JSON array). ──
  const dataQuery = new URLSearchParams(filters);
  dataQuery.set("size", String(size));
  dataQuery.set("offset", String(offset));

  // Catch-ladder (cms-utilization shape): preserve the 4xx/5xx/timeout
  // ToolErrorCarrier taxonomy FIRST; reclassify a 200 non-JSON SyntaxError to
  // schema_drift SECOND; bare-rethrow LAST.
  let body: unknown;
  try {
    body = await getCms(dataBase, dataQuery);
  } catch (e) {
    if (e instanceof ToolErrorCarrier) throw e;
    if (e instanceof SyntaxError)
      throw driftError(
        CMS_LABEL,
        "CMS data-API returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).",
      );
    throw e;
  }

  // [P4] the data body MUST be an array (a non-array 200 is drift, never a
  // fabricated empty).
  if (!Array.isArray(body)) {
    throw driftError(
      CMS_LABEL,
      "CMS data-API shape drift — the /data response must be a JSON array of rows.",
    );
  }

  return { rows: body as unknown[], totalAvailable, countFailed };
}

/** Coerce args.size / args.offset to bounded integers (belt-and-suspenders behind
 *  the server Zod; a DIRECT handler call bypasses Zod). */
function boundSize(raw: unknown): number {
  let size = SIZE_DEFAULT;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    size = Math.trunc(raw);
    if (size < SIZE_MIN) size = SIZE_MIN;
    if (size > SIZE_MAX) size = SIZE_MAX;
  }
  return size;
}
function boundOffset(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.trunc(raw);
  }
  return 0;
}

// ══════════════════════════════════════════════════════════════════
// (1) cms_dmepos_suppliers
// ══════════════════════════════════════════════════════════════════

/**
 * Join the CMS Last_Name_Org + First_Name into one display name. An ORGANIZATION
 * supplier (entity code "O") carries the org name in Last_Name_Org with an empty
 * First_Name ⇒ just the org name. An INDIVIDUAL carries both ⇒ "Last, First".
 * Either absent ⇒ the present one; both absent ⇒ null (never a fabricated "").
 */
export function joinSupplierName(lastOrg: unknown, first: unknown): string | null {
  const last = str(lastOrg);
  const firstName = str(first);
  if (last !== null && firstName !== null) return `${last}, ${firstName}`;
  return last ?? firstName ?? null;
}

export type DmeposSupplier = {
  npi: string | null;
  supplierName: string | null;
  credentials: string | null;
  entityType: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  totalHcpcsCodes: number | null;
  totalBeneficiaries: number | null;
  totalClaims: number | null;
  totalServices: number | null;
  submittedCharges: number | null;
  medicareAllowed: number | null;
  medicarePayment: number | null;
};

/** Map ONE DMEPOS data-API row → the curated supplier shape. */
function mapSupplier(row: unknown): DmeposSupplier {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    npi: str(r.Suplr_NPI),
    supplierName: joinSupplierName(
      r.Suplr_Prvdr_Last_Name_Org,
      r.Suplr_Prvdr_First_Name,
    ),
    credentials: str(r.Suplr_Prvdr_Crdntls),
    entityType: str(r.Suplr_Prvdr_Ent_Cd),
    city: str(r.Suplr_Prvdr_City),
    state: str(r.Suplr_Prvdr_State_Abrvtn),
    zip: str(r.Suplr_Prvdr_Zip5),
    totalHcpcsCodes: num(r.Tot_Suplr_HCPCS_Cds),
    totalBeneficiaries: num(r.Tot_Suplr_Benes),
    totalClaims: num(r.Tot_Suplr_Clms),
    totalServices: num(r.Tot_Suplr_Srvcs),
    submittedCharges: num(r.Suplr_Sbmtd_Chrgs),
    medicareAllowed: num(r.Suplr_Mdcr_Alowd_Amt),
    medicarePayment: num(r.Suplr_Mdcr_Pymt_Amt),
  };
}

export type CmsDmeposSuppliersArgs = {
  npi?: string;
  state?: string;
  size?: number;
  offset?: number;
};

/**
 * Fetch DMEPOS supplier rows for an NPI / state → normalized supplier rows +
 * honest `_meta`. REQUIRES npi OR state (an all-empty query is refused). Runs a
 * stats count sub-query FIRST for the EXACT total (P1), then the data slice; a count
 * failure degrades to totalAvailable:null + a note (never a length-faked total).
 */
export async function dmeposSuppliers(
  args: CmsDmeposSuppliersArgs,
): Promise<MetaBundle> {
  // ── [input guard] require npi OR state (never scan the whole supplier table). ──
  const hasNpi = args.npi !== undefined && args.npi !== "";
  const hasState = args.state !== undefined && args.state !== "";
  if (!hasNpi && !hasState) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message:
        "cms_dmepos_suppliers requires at least `npi` (10-digit) OR `state` (2-letter) — an all-empty query would scan the entire DMEPOS supplier table and is refused. Add npi or state and retry.",
      upstreamEndpoint: CMS_LABEL,
    });
  }

  // ── Validate + build the filter params (SSRF: charclass + URLSearchParams value). ──
  const filters = new URLSearchParams();
  const filtersApplied: string[] = [];

  if (hasNpi) {
    const npi = args.npi as string;
    if (!NPI_RE.test(npi)) {
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        retryable: false,
        message: `Invalid npi ${JSON.stringify(npi)} — expected a 10-digit National Provider Identifier (^\\d{10}$).`,
        upstreamEndpoint: CMS_LABEL,
      });
    }
    filters.set("filter[Suplr_NPI]", npi);
    filtersApplied.push(`npi:${npi}`);
  }

  if (hasState) {
    const state = args.state as string;
    if (!STATE_RE.test(state)) {
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        retryable: false,
        message: `Invalid state ${JSON.stringify(state)} — expected a 2-letter state/territory code (^[A-Za-z]{2}$), e.g. "VA".`,
        upstreamEndpoint: CMS_LABEL,
      });
    }
    filters.set("filter[Suplr_Prvdr_State_Abrvtn]", state.toUpperCase());
    filtersApplied.push(`state:${state.toUpperCase()}`);
  }

  const size = boundSize(args.size);
  const offset = boundOffset(args.offset);

  const { rows, totalAvailable, countFailed } = await fetchDatasetSlice(
    DMEPOS_DATASET_UUID,
    filters,
    size,
    offset,
  );

  const suppliers = rows.map(mapSupplier);
  const returned = suppliers.length;

  const hasMore =
    totalAvailable !== null
      ? offset + returned < totalAvailable
      : returned === size;
  const nextOffset = hasMore ? offset + returned : null;

  const notes: string[] = [DMEPOS_VINTAGE_NOTE, DMEPOS_AGGREGATE_NOTE];
  if (countFailed) notes.push(COUNT_FALLBACK_NOTE);

  const meta: Partial<ResponseMeta> = {
    source: `${CMS_HOST} CMS Medicare DMEPOS — by Supplier (keyless)`,
    keylessMode: true,
    returned,
    totalAvailable,
    filtersApplied,
    filtersDropped: [],
    fieldsUnavailable: [],
    pagination: { offset, limit: size, hasMore, nextOffset },
    notes,
  };

  return withMeta({ suppliers }, meta);
}

// ══════════════════════════════════════════════════════════════════
// (2) cms_revoked_providers
// ══════════════════════════════════════════════════════════════════

/**
 * Coalesce the revoked-provider display name: an ORGANIZATION carries ORG_NAME ⇒
 * use it. An INDIVIDUAL carries FIRST_NAME + LAST_NAME ⇒ "First Last" (either
 * present alone ⇒ that one). None present ⇒ null (never a fabricated "").
 */
export function coalesceRevokedName(
  org: unknown,
  first: unknown,
  last: unknown,
): string | null {
  const o = str(org);
  if (o !== null) return o;
  const f = str(first);
  const l = str(last);
  if (f !== null && l !== null) return `${f} ${l}`;
  return f ?? l ?? null;
}

export type RevokedProvider = {
  enrollmentId: string | null;
  npi: string | null;
  name: string | null;
  state: string | null;
  providerType: string | null;
  revocationReason: string | null;
  revocationEffectiveDate: string | null;
  reenrollmentBarExpiration: string | null;
};

/** Map ONE revocation data-API row → the curated revocation shape. */
function mapRevocation(row: unknown): RevokedProvider {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    enrollmentId: str(r.ENRLMT_ID),
    npi: str(r.NPI),
    name: coalesceRevokedName(r.ORG_NAME, r.FIRST_NAME, r.LAST_NAME),
    state: str(r.STATE_CD),
    providerType: str(r.PROVIDER_TYPE_DESC),
    revocationReason: str(r.REVOCATION_RSN),
    revocationEffectiveDate: str(r.REVOCATION_EFCTV_DT),
    reenrollmentBarExpiration: str(r.REENROLLMENT_BAR_EXPRTN_DT),
  };
}

export type CmsRevokedProvidersArgs = {
  npi?: string;
  state?: string;
  lastName?: string;
  size?: number;
  offset?: number;
};

/**
 * Fetch CMS revocation-list rows (all filters optional — the ~7K-row list is safe
 * to page unfiltered) → normalized revocation rows + honest `_meta`. Runs a stats
 * count sub-query FIRST for the EXACT total (P1), then the data slice; a count
 * failure degrades to totalAvailable:null + a note (never a length-faked total).
 */
export async function revokedProviders(
  args: CmsRevokedProvidersArgs,
): Promise<MetaBundle> {
  const filters = new URLSearchParams();
  const filtersApplied: string[] = [];

  if (args.npi !== undefined && args.npi !== "") {
    const npi = args.npi;
    if (!NPI_RE.test(npi)) {
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        retryable: false,
        message: `Invalid npi ${JSON.stringify(npi)} — expected a 10-digit National Provider Identifier (^\\d{10}$).`,
        upstreamEndpoint: CMS_LABEL,
      });
    }
    filters.set("filter[NPI]", npi);
    filtersApplied.push(`npi:${npi}`);
  }

  if (args.state !== undefined && args.state !== "") {
    const state = args.state;
    if (!STATE_RE.test(state)) {
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        retryable: false,
        message: `Invalid state ${JSON.stringify(state)} — expected a 2-letter state/territory code (^[A-Za-z]{2}$), e.g. "VA".`,
        upstreamEndpoint: CMS_LABEL,
      });
    }
    filters.set("filter[STATE_CD]", state.toUpperCase());
    filtersApplied.push(`state:${state.toUpperCase()}`);
  }

  if (args.lastName !== undefined && args.lastName !== "") {
    const lastName = args.lastName;
    if (!LAST_NAME_RE.test(lastName)) {
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        retryable: false,
        message: `Invalid lastName ${JSON.stringify(lastName)} — allowed: letters, digits, space, . , ' - (≤100 chars).`,
        upstreamEndpoint: CMS_LABEL,
      });
    }
    filters.set("filter[LAST_NAME]", lastName);
    filtersApplied.push(`lastName:${lastName}`);
  }

  const size = boundSize(args.size);
  const offset = boundOffset(args.offset);

  const { rows, totalAvailable, countFailed } = await fetchDatasetSlice(
    REVOKED_DATASET_UUID,
    filters,
    size,
    offset,
  );

  const revocations = rows.map(mapRevocation);
  const returned = revocations.length;

  const hasMore =
    totalAvailable !== null
      ? offset + returned < totalAvailable
      : returned === size;
  const nextOffset = hasMore ? offset + returned : null;

  const notes: string[] = [REVOKED_LIST_NOTE];
  if (countFailed) notes.push(COUNT_FALLBACK_NOTE);

  const meta: Partial<ResponseMeta> = {
    source: `${CMS_HOST} CMS Revoked Medicare Providers & Suppliers (public revocation list, keyless)`,
    keylessMode: true,
    returned,
    totalAvailable,
    filtersApplied,
    filtersDropped: [],
    fieldsUnavailable: [],
    pagination: { offset, limit: size, hasMore, nextOffset },
    notes,
  };

  return withMeta({ revocations }, meta);
}
