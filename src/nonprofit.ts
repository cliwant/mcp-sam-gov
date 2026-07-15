/**
 * nonprofit.ts — US TAX-EXEMPT NONPROFITS (IRS Form 990) — the nonprofit /
 * grantee / subcontractor vetting lane (ADR-0060). Who a tax-exempt organization
 * IS (EIN, NTEE code, subsection, ruling date, status) and what its Form 990
 * FINANCIALS look like (revenue, expenses, assets, liabilities by tax year) —
 * the 501(c) signal no contract/spending/grant/lobbying source carries.
 *
 * ★ PROVENANCE — THIS IS NOT A .gov API (must be disclosed). The DATA is IRS Form
 *   990 filings — FEDERAL tax-exempt PUBLIC RECORDS — but the API is **ProPublica
 *   Nonprofit Explorer**, operated by **ProPublica** (a non-profit newsroom) which
 *   republishes those records KEYLESS. The IRS itself offers NO clean query API
 *   (only bulk downloads / a web UI). So every response's `_meta.source` AND a note
 *   name "IRS Form 990 data via ProPublica Nonprofit Explorer" — the tool NEVER
 *   presents itself as a government API.
 *
 * ★ KEYLESS — no key of any kind. Anonymous GETs return HTTP 200. There is NO
 *   KEY_REGISTRY / keys.ts / API_KEYS.md entry for this source.
 *
 * The module writes ZERO fetch/coercion/error/meta code of its own: it REUSES
 * `getJson` (the shared fetch envelope, redirect:"error") / `driftError` /
 * `num`·`str` (coerce.ts, null-never-0/empty) / `withMeta`·`buildMeta`.
 *
 *   SEARCH  GET https://projects.propublica.org/nonprofits/api/v2/search.json
 *       ?q=&state[id]=&ntee[id]=&page=
 *     → { total_results, organizations:[{ ein, name, sub_name, city, state,
 *          ntee_code, subseccd, score }], num_pages, cur_page, per_page,
 *          page_offset }
 *   DETAIL  GET https://projects.propublica.org/nonprofits/api/v2/organizations/{ein}.json
 *     → { organization:{ ein, name, address, city, state, zipcode, ntee_code,
 *          subsection_code, ruling_date, exempt_organization_status_code,
 *          foundation_code }, filings_with_data:[{ tax_prd_yr, formtype, pdf_url,
 *          totrevenue, totfuncexpns, totassetsend, totliabend }] }
 *
 * ★ HONESTY (ADR-0060 P1–P5):
 *   [P1]   SEARCH totalAvailable = `total_results` (the API's REAL total for the
 *          query) — NEVER organizations.length. Page pagination (page is 0-based):
 *          hasMore = (cur_page+1) < num_pages; the next page number is surfaced in
 *          a note. DETAIL totalAvailable = filings.length (the COMPLETE filing set
 *          from the one detail doc — no pagination). Reverting the search total to
 *          organizations.length must go RED.
 *   [P2]   SEARCH a genuine no-match (organizations:[]) ⇒ honest empty (returned:0,
 *          complete:true). DETAIL an unknown EIN (HTTP 404) ⇒ not_found (NEVER a
 *          fabricated empty org). A 4xx ⇒ invalid_input; a 5xx/timeout ⇒
 *          upstream_unavailable THROW; a 200 non-JSON ⇒ schema_drift.
 *   [P3]   The four Form 990 figures (totrevenue/totfuncexpns/totassetsend/
 *          totliabend) ride `num()` — a genuine 0 STAYS 0, an absent figure ⇒ null
 *          (NEVER 0-faked). EIN + the codes are strings; ruling_date is a string.
 *   [P4]   SEARCH `organizations` non-array OR `total_results` non-number ⇒
 *          driftError. DETAIL `organization` non-object OR `filings_with_data`
 *          non-array ⇒ driftError (never a fabricated empty/total).
 *   [SSRF] fixed host `projects.propublica.org`; a post-construction hostname/
 *          protocol assert + `redirect:"error"`; the query VALUES ride
 *          URLSearchParams (incl. the `state[id]`/`ntee[id]` bracket keys);
 *          `ein` charclass `^\d{1,9}$` (path segment); `state` `^[A-Za-z]{2}$`;
 *          `ntee` an integer 1..10.
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so a `num` regression fails together across sources.
export { num };

// ─── SSRF core: the single fixed host + base path ─────────────────
export const NONPROFIT_HOST = "projects.propublica.org";
const NONPROFIT_BASE = "/nonprofits/api/v2";
// HOST+path labels — surface in ToolError.upstreamEndpoint. No token exists for
// this keyless source, so no secret can ever appear here.
const NONPROFIT_SEARCH_LABEL = "propublica-nonprofit:/nonprofits/api/v2/search";
const NONPROFIT_ORG_LABEL = "propublica-nonprofit:/nonprofits/api/v2/organizations";

// ─── Validation (SSRF + "verify the input" honesty) ───────────────
const STATE_RE = /^[A-Za-z]{2}$/; // a 2-letter US state/territory code
const EIN_RE = /^\d{1,9}$/; // a numeric EIN (1..9 digits), rides the PATH
// ★ProPublica's not-found SENTINEL (live-verified, NOT in the ADR): an EIN with no
// matching IRS record does NOT always 404 — an in-range unknown EIN (e.g. 999999999)
// returns HTTP 200 carrying a SYNTHETIC placeholder org `{ name:"Unknown Organization",
// …all-null }` with ZERO filings_with_data. Surfacing that verbatim would present a
// FABRICATED empty org as a real hit (a P2 honesty violation). We detect the exact
// sentinel name + empty structured filings and map it to not_found, EXACTLY like a 404.
const PROPUBLICA_NOT_FOUND_NAME = "Unknown Organization";
const NTEE_MIN = 1;
const NTEE_MAX = 10; // the NTEE major-category filter, 1..10
const DEFAULT_PAGE = 0; // the API's page is 0-BASED
const FALLBACK_PER_PAGE = 25; // the API's fixed page size (~25); a defensive fallback

// ─── Honesty notes (ADR-0060 required set) ────────────────────────
const PROVENANCE_NOTE =
  "Data = IRS Form 990 filings (federal tax-exempt public records), served by ProPublica Nonprofit Explorer (ProPublica, a non-profit newsroom, which republishes them keyless) — NOT a .gov API. The IRS itself has no clean query API (only bulk downloads / a web UI). Treat figures as of ProPublica's last IRS ingest.";
const SEARCH_TOTAL_NOTE =
  "totalAvailable is the API's real total_results — the total match count for the query (NOT the organizations on this page). Pagination is page-based and 0-INDEXED (pass page=cur_page+1 for the next page while hasMore).";
const FINANCIALS_TOTAL_NOTE =
  "totalAvailable is filings.length — the COMPLETE set of Form 990 filings-with-data carried by this organization's detail document (there is no pagination; this is the whole set, not a page).";
const FINANCIALS_MONEY_NOTE =
  "revenueUsd / expensesUsd / assetsUsd / liabilitiesUsd are parsed from the Form 990 totrevenue / totfuncexpns / totassetsend / totliabend. A genuine reported 0 is preserved as 0; an absent figure maps to null — NEVER 0.";

// ─── Curated search shape ─────────────────────────────────────────
export type NonprofitOrgSummary = {
  ein: string | null;
  name: string | null;
  city: string | null;
  state: string | null;
  nteeCode: string | null; // ntee_code (the NTEE classification, e.g. "E21")
  subsectionCode: string | null; // subseccd (the 501(c) subsection code)
};

/** Map ONE search `organizations[]` row → the curated summary shape. */
function mapOrgSummary(raw: unknown): NonprofitOrgSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    // EIN + codes are IDENTIFIERS ⇒ strings (never num-coerced).
    ein: str(o.ein),
    name: str(o.name),
    city: str(o.city),
    state: str(o.state),
    nteeCode: str(o.ntee_code),
    subsectionCode: str(o.subseccd),
  };
}

// ─── Curated financials shapes ────────────────────────────────────
export type NonprofitOrganization = {
  ein: string | null;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null; // zipcode
  nteeCode: string | null; // ntee_code
  subsectionCode: string | null; // subsection_code
  rulingDate: string | null; // ruling_date (a date STRING — never coerced)
  statusCode: string | null; // exempt_organization_status_code
};

export type NonprofitFiling = {
  taxYear: number | null; // tax_prd_yr (a filing year)
  formType: string | null; // formtype
  revenueUsd: number | null; // totrevenue — null-never-0
  expensesUsd: number | null; // totfuncexpns — null-never-0
  assetsUsd: number | null; // totassetsend — null-never-0
  liabilitiesUsd: number | null; // totliabend — null-never-0
  pdfUrl: string | null; // pdf_url (the scanned Form 990 PDF)
};

/** Map the detail `organization` object → the curated organization shape. */
function mapOrganization(raw: unknown): NonprofitOrganization {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    ein: str(o.ein),
    name: str(o.name),
    address: str(o.address),
    city: str(o.city),
    state: str(o.state),
    zip: str(o.zipcode),
    nteeCode: str(o.ntee_code),
    subsectionCode: str(o.subsection_code),
    rulingDate: str(o.ruling_date),
    statusCode: str(o.exempt_organization_status_code),
  };
}

/** Map ONE `filings_with_data[]` row → the curated filing shape (money via num). */
function mapFiling(raw: unknown): NonprofitFiling {
  const f = (raw ?? {}) as Record<string, unknown>;
  return {
    taxYear: num(f.tax_prd_yr),
    formType: str(f.formtype),
    // [P3] a genuine 0 STAYS 0; absent ⇒ null (NEVER 0-faked).
    revenueUsd: num(f.totrevenue),
    expensesUsd: num(f.totfuncexpns),
    assetsUsd: num(f.totassetsend),
    liabilitiesUsd: num(f.totliabend),
    pdfUrl: str(f.pdf_url),
  };
}

// ─── Tool: nonprofit_search ───────────────────────────────────────
export type NonprofitSearchArgs = {
  query?: string; // → q
  state?: string; // 2-letter → state[id]
  ntee?: number; // 1..10 → ntee[id]
  page?: number; // ≥0, default 0 (the API's page is 0-based)
};

/**
 * Search US tax-exempt nonprofits (IRS Form 990) via ProPublica Nonprofit Explorer
 * (`/nonprofits/api/v2/search.json`) → curated org summaries + honest `_meta`.
 * KEYLESS. ★PROVENANCE: this is ProPublica (a non-profit newsroom) republishing
 * IRS Form 990 public records — NOT a .gov API. ★totalAvailable is the API's REAL
 * `total_results` — never organizations.length; page-based (0-indexed) pagination.
 */
export async function search(args: NonprofitSearchArgs): Promise<MetaBundle> {
  const label = NONPROFIT_SEARCH_LABEL;

  // ── Validate + default (belt-and-suspenders behind the server Zod; a DIRECT
  //    handler call bypasses Zod). state/ntee/page are charclass/range-guarded;
  //    the free-text query rides URLSearchParams (encoded). ──
  if (args.state !== undefined && !STATE_RE.test(args.state)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid state ${JSON.stringify(args.state)} — expected a 2-letter US state/territory code (^[A-Za-z]{2}$), e.g. "VA".`,
      upstreamEndpoint: label,
    });
  }
  if (
    args.ntee !== undefined &&
    (!Number.isInteger(args.ntee) || args.ntee < NTEE_MIN || args.ntee > NTEE_MAX)
  ) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid ntee ${JSON.stringify(args.ntee)} — expected an integer NTEE major category 1..10.`,
      upstreamEndpoint: label,
    });
  }
  const page = clampPage(args.page);

  // ── Build the query from VALIDATED typed args, key-by-key (SSRF: no raw
  //    passthrough; every VALUE is URLSearchParams-encoded, incl. the bracket keys
  //    `state[id]`/`ntee[id]`). ──
  const params = new URLSearchParams();
  const filtersApplied: string[] = [];
  if (args.query !== undefined && args.query !== "") {
    params.set("q", args.query);
    filtersApplied.push("query");
  }
  if (args.state !== undefined) {
    params.set("state[id]", args.state.toUpperCase());
    filtersApplied.push("state");
  }
  if (args.ntee !== undefined) {
    params.set("ntee[id]", String(args.ntee));
    filtersApplied.push("ntee");
  }
  params.set("page", String(page));

  const url = `https://${NONPROFIT_HOST}${NONPROFIT_BASE}/search.json?${params.toString()}`;
  assertOnHost(url, label);

  // ── Fetch through the shared envelope. redirect:"error" fails closed on any
  //    off-host 3xx. A 4xx ⇒ invalid_input; a 5xx/timeout ⇒ upstream_unavailable
  //    THROW; a 429 ⇒ rate_limited THROW; a 200 non-JSON ⇒ getJson's r.json()
  //    throws a SyntaxError ⇒ schema_drift. ──
  let body: unknown;
  try {
    body = await getJson<unknown>(url, { label, redirect: "error" });
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw driftError(
        label,
        "ProPublica Nonprofit search returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).",
      );
    }
    throw e; // 5xx → upstream_unavailable, 4xx → invalid_input, 429 → rate_limited …
  }

  // ── [P4] `organizations` MUST be an array and `total_results` MUST be a number
  //    (a missing/wrong-typed either is drift, never a fabricated empty/total). ──
  const b = (body ?? {}) as {
    organizations?: unknown;
    total_results?: unknown;
    num_pages?: unknown;
    cur_page?: unknown;
    per_page?: unknown;
    page_offset?: unknown;
  };
  if (!Array.isArray(b.organizations)) {
    throw driftError(
      label,
      "ProPublica Nonprofit search shape drift — `organizations` must be an array.",
    );
  }
  if (typeof b.total_results !== "number" || !Number.isFinite(b.total_results)) {
    throw driftError(
      label,
      "ProPublica Nonprofit search shape drift — `total_results` (the total match count) must be a number.",
    );
  }

  const organizations = (b.organizations as unknown[]).map(mapOrgSummary);
  const returned = organizations.length;

  // ── [P1] totalAvailable is the API's REAL total_results, NEVER organizations.length.
  //    Page-based + 0-INDEXED: hasMore = (cur_page+1) < num_pages; surface the next
  //    page. cur_page/num_pages/per_page/page_offset via num() (defensive fallbacks). ──
  const totalAvailable = b.total_results;
  const curPage = num(b.cur_page) ?? page;
  const numPages = num(b.num_pages);
  const perPage = num(b.per_page) ?? (returned > 0 ? returned : FALLBACK_PER_PAGE);
  const hasMore = numPages !== null ? curPage + 1 < numPages : false;
  const offset = num(b.page_offset) ?? curPage * perPage;
  const nextOffset = hasMore ? (curPage + 1) * perPage : null;

  const notes: string[] = [PROVENANCE_NOTE, SEARCH_TOTAL_NOTE];
  if (hasMore && numPages !== null) {
    notes.push(
      `This is page ${curPage} (0-indexed) of ${numPages} — pass page=${curPage + 1} for the next page.`,
    );
  }

  return withMeta(
    { organizations },
    {
      source: `${NONPROFIT_HOST} /nonprofits/api/v2/search (IRS Form 990 data via ProPublica Nonprofit Explorer — not a .gov API; keyless)`,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit: perPage, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool: nonprofit_financials ───────────────────────────────────
export type NonprofitFinancialsArgs = {
  ein: string; // required; ^\d{1,9}$ (rides the PATH)
};

/**
 * Fetch ONE nonprofit's IRS Form 990 profile + financials via ProPublica Nonprofit
 * Explorer (`/nonprofits/api/v2/organizations/{ein}.json`) → curated organization +
 * filings + honest `_meta`. KEYLESS. ★PROVENANCE: ProPublica (a non-profit newsroom)
 * republishing IRS Form 990 public records — NOT a .gov API. An unknown EIN (HTTP
 * 404) ⇒ not_found (never a fabricated empty org). The four Form 990 figures ride
 * num() (null-never-0). totalAvailable = filings.length (the COMPLETE set).
 */
export async function financials(
  args: NonprofitFinancialsArgs,
): Promise<MetaBundle> {
  const label = NONPROFIT_ORG_LABEL;

  // ── Validate (belt-and-suspenders behind the server Zod). ein is charclass-
  //    guarded PRE-fetch — it rides the URL PATH, so it MUST be digits-only. ──
  if (typeof args.ein !== "string" || !EIN_RE.test(args.ein)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid ein ${JSON.stringify(args.ein)} — expected a numeric EIN of 1..9 digits (^\\d{1,9}$), e.g. "530196605".`,
      upstreamEndpoint: label,
    });
  }

  // ein is digits-only (EIN_RE) ⇒ safe as a path segment; no separators can steer
  // the authority. Build + re-assert the host (SSRF belt-and-suspenders).
  const url = `https://${NONPROFIT_HOST}${NONPROFIT_BASE}/organizations/${args.ein}.json`;
  assertOnHost(url, label);

  // ── Fetch through the shared envelope. A 404 (unknown EIN) ⇒ not_found (the
  //    shared taxonomy — never a fabricated empty org); a 4xx ⇒ invalid_input; a
  //    5xx/timeout ⇒ upstream_unavailable THROW; a 200 non-JSON ⇒ schema_drift. ──
  let body: unknown;
  try {
    body = await getJson<unknown>(url, { label, redirect: "error" });
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw driftError(
        label,
        "ProPublica Nonprofit organization detail returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).",
      );
    }
    throw e; // 404 → not_found, 5xx → upstream_unavailable, 4xx → invalid_input …
  }

  // ── [P4] `organization` MUST be an object and `filings_with_data` MUST be an
  //    array (a missing/wrong-typed either is drift, never a fabricated empty). ──
  const b = (body ?? {}) as {
    organization?: unknown;
    filings_with_data?: unknown;
  };
  if (
    b.organization === null ||
    typeof b.organization !== "object" ||
    Array.isArray(b.organization)
  ) {
    throw driftError(
      label,
      "ProPublica Nonprofit organization detail shape drift — `organization` must be an object.",
    );
  }
  if (!Array.isArray(b.filings_with_data)) {
    throw driftError(
      label,
      "ProPublica Nonprofit organization detail shape drift — `filings_with_data` must be an array.",
    );
  }

  const organization = mapOrganization(b.organization);
  const filings = (b.filings_with_data as unknown[]).map(mapFiling);
  const returned = filings.length;

  // ── [P2] ★not-found SENTINEL: ProPublica returns HTTP 200 + a synthetic
  //    `{ name:"Unknown Organization", …all-null }` placeholder (zero
  //    filings_with_data) for an in-range EIN with no IRS record. That is a
  //    FABRICATED empty org — surface it as not_found (identical to a 404), NEVER
  //    as a real hit. Gated on BOTH the exact sentinel name AND empty structured
  //    filings, so a real org (which would carry its true name / filings) is safe. ──
  if (organization.name === PROPUBLICA_NOT_FOUND_NAME && returned === 0) {
    throw new ToolErrorCarrier({
      kind: "not_found",
      retryable: false,
      message: `No IRS Form 990 record for EIN ${args.ein} — ProPublica returned its "${PROPUBLICA_NOT_FOUND_NAME}" placeholder (no matching tax-exempt organization). Verify the EIN.`,
      upstreamEndpoint: label,
    });
  }

  // ── [P1] totalAvailable = filings.length — the COMPLETE filing set from the one
  //    detail document (no pagination). ──
  const notes: string[] = [
    PROVENANCE_NOTE,
    FINANCIALS_TOTAL_NOTE,
    FINANCIALS_MONEY_NOTE,
  ];

  return withMeta(
    { organization, filings },
    {
      source: `${NONPROFIT_HOST} /nonprofits/api/v2/organizations (IRS Form 990 data via ProPublica Nonprofit Explorer — not a .gov API; keyless)`,
      keylessMode: true,
      returned,
      totalAvailable: returned,
      filtersApplied: [],
      filtersDropped: [],
      fieldsUnavailable: [],
      // The complete set is in one document — no pagination, hasMore:false.
      pagination: { offset: 0, limit: returned, hasMore: false, nextOffset: null },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── SSRF host assert (shared by both tools) ──────────────────────
/**
 * Belt-and-suspenders: the fixed host + strictly-built URL leave nothing to steer
 * the authority; assert the built URL cannot have been moved off-host / downgraded.
 */
function assertOnHost(url: string, label: string): void {
  const built = new URL(url);
  if (built.hostname !== NONPROFIT_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Constructed ProPublica Nonprofit URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${NONPROFIT_HOST} over https — refusing to fetch (SSRF safety).`,
      upstreamEndpoint: label,
    });
  }
}

// ─── Small clamp (defensive, behind the server Zod bounds) ─────────
function clampPage(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_PAGE;
  const n = Math.floor(v);
  return n < 0 ? 0 : n;
}
