/**
 * datagov.ts — the api.data.gov KEYED trio (slice 1: Regulations.gov +
 * Congress.gov). ADR-0007.
 *
 * This is the project's FIRST KEYED (non-keyless) source — every prior source
 * (Treasury, EDGAR, Socrata, CKAN) is anonymous. It exercises policy② ("keyless-
 * first, but when a free public key is required, research + automate its
 * issuance"), so the load-bearing concern is a SAFE env-key adapter whose secret
 * can NEVER leak into a ToolError, a URL, a log, or `_meta`. Built on the R2
 * `DataSource` port (ADR-0005) exactly like CKAN — it writes ZERO fetch/coercion/
 * error/meta code (reuses `getJson`/`driftError`/`num`·`str`/`withMeta`) and
 * COPIES (does not import) the Socrata/CKAN SSRF + honesty PATTERN.
 *
 * ★ THE KEY-SECURITY DISCIPLINE (ADR-0007 §2 — the load-bearing rules):
 *  1. The key travels in `headers:{ "X-Api-Key": <key> }` ONLY — NEVER in the
 *     URL/query (no `?api_key=`). Live-verified: the `X-Api-Key` header works for
 *     BOTH api.regulations.gov and api.congress.gov, so the key is structurally
 *     absent from the request URL (→ never in a CDN/proxy/access log, never in
 *     `getJson`'s `label`, never in `ToolError.upstreamEndpoint`).
 *  2. `label` is HOST+PATH only (e.g. "regulations:/v4/documents",
 *     "congress:/v3/bill") — never the full URL, never a token. This is what
 *     reaches `ToolError.upstreamEndpoint`.
 *  3. `_meta.source`/`notes` are host + key-MODE only ("…(DEMO_KEY)" /
 *     "…(DATA_GOV_API_KEY)") — never the URL, never the key value, never the
 *     `X-Api-Key` header.
 *  4. Headers are never logged/echoed; upstream `next`/`pagination.next` URLs are
 *     NEVER surfaced verbatim — pagination is re-derived NUMERICALLY.
 *  5. Never commit the key — read from env only; the DEMO_KEY fallback is a
 *     literal public constant (safe in source), the real key never is.
 *
 * ★ KEYLESS-FIRST UX (policy② / §3): DATA_GOV_API_KEY from env, else the public
 * literal "DEMO_KEY" + a `_meta.notes` disclosure of the ~10 req/hr shared ceiling
 * and the free-key signup path. `keylessMode:false` (this is the FIRST source to
 * report it — it is genuinely keyed).
 *
 * ★ SSRF (§4): two fixed hosts (constants, no free host param); all caller params
 * via URLSearchParams; path segments that interpolate caller input (Congress
 * `/v3/bill/{congress}/{billType}/{billNumber}`) are Zod-constrained to int/enum;
 * post-construction `hostname===host && https` assertion; `redirect:"error"`.
 *
 * ★ HONESTY (§5): totals are EXACT integers read from the PRIMARY container
 * (`meta.totalElements` / `pagination.count`) with container guards (a null/absent
 * container or a non-number total → `driftError`, NOT a TypeError/upstream_unavail);
 * the primary array (`data`/`bills`) must be an array or → `driftError`; a
 * genuine-empty (0 results) → complete:true/total:0; an outage/5xx/timeout throws
 * (never a fake empty). Regulations.gov's 40-page/10,000-record HARD CAP is
 * handled with the EDGAR window-cap pattern (B1): `hasMore:true` (more genuinely
 * exists) BUT `nextOffset:null` (no reachable continuation) + a disclosing note.
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";
// ADR-0010 §2 — the api.data.gov KEY seam is now a single audited home shared with
// govinfo.ts (the 2nd consumer). This is a pure behavior-identical extraction of
// datagov's former module-private key helpers (they read process.env at call time,
// so the move changes nothing — datagov's key handling / _meta / snapshot / K-test
// all stay green). govinfo.ts imports from the SAME module; neither imports the other.
import { keyHeader, keyModeLabel, pushKeyNote } from "./datagovKey.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` from this module (datagov.num === coerce.num === ckan.num === …).
export { num };

// ─── Fixed hosts (SSRF core — no free host param) ─────────────────
export const REGULATIONS_HOST = "api.regulations.gov";
export const CONGRESS_HOST = "api.congress.gov";

// ─── Regulations.gov hard pagination cap (§1c / B1, EDGAR-pattern) ─
// page[number] is hard-capped at 40; the max reachable window is 40 × 250 =
// 10,000 records. `meta.totalElements` is the REAL total (~1.97M) — far larger.
// We never trust meta.totalPages/hasNextPage/lastPage (they are cap-relative
// liars). Mirrors edgar.ts's FTS_WINDOW / FTS_MAX_FROM window cap.
const REG_MAX_PAGE = 40;
const REG_MAX_PAGE_SIZE = 250;
const REG_MAX_RECORDS = REG_MAX_PAGE * REG_MAX_PAGE_SIZE; // 10_000

// Live-verified accepted Regulations.gov sort fields (non-exhaustive — the API
// accepts more; these are the ones confirmed with DEMO_KEY, ADR-0007 §1b/m8).
export const REGULATIONS_SORTS = [
  "-postedDate",
  "postedDate",
  "-lastModifiedDate",
  "lastModifiedDate",
  "-commentEndDate",
] as const;
export type RegulationsSort = (typeof REGULATIONS_SORTS)[number];

// Regulations.gov documentType facet (§4 rule 5 — Zod enum, bad values fail
// locally before fetch).
export const REGULATIONS_DOCUMENT_TYPES = [
  "Rule",
  "Proposed Rule",
  "Notice",
  "Supporting & Related Material",
  "Other",
] as const;
export type RegulationsDocumentType = (typeof REGULATIONS_DOCUMENT_TYPES)[number];

// Regulations.gov docket-type facet (ADR-0044 §4 rule 5 — Zod enum; a bad value
// fails LOCALLY as invalid_input before any fetch). Dockets are the rulemaking/
// nonrulemaking CONTAINER that groups documents + comments under one action.
export const REGULATIONS_DOCKET_TYPES = ["Rulemaking", "Nonrulemaking"] as const;
export type RegulationsDocketType = (typeof REGULATIONS_DOCKET_TYPES)[number];

// Docket sort fields (ADR-0044 S5). `-lastModifiedDate` and `title` are
// DEMO_KEY-verified; `lastModifiedDate` (asc) and `-title` are assumed by JSON:API
// asc/desc symmetry — LIVE-VERIFY when a non-throttled key is available. An
// unattested value the API rejects yields an honest invalid_input THROW, so
// keeping them is safe (mirrors the REGULATIONS_SORTS non-exhaustive note above).
export const REGULATIONS_DOCKET_SORTS = [
  "-lastModifiedDate",
  "lastModifiedDate",
  "title",
  "-title",
] as const;
export type RegulationsDocketSort = (typeof REGULATIONS_DOCKET_SORTS)[number];

// Congress.gov bill-type path enum (§4 — constrains the /v3/bill/{congress}/{type}
// path segment; a bad value fails locally before any fetch).
export const CONGRESS_BILL_TYPES = [
  "hr",
  "s",
  "hjres",
  "sjres",
  "hconres",
  "sconres",
  "hres",
  "sres",
] as const;
export type CongressBillType = (typeof CONGRESS_BILL_TYPES)[number];

// ─── Key handling (the load-bearing secret discipline) ────────────
// `keyHeader`/`keyModeLabel`/`pushKeyNote` (+ `usingDemoKey`, the DEMO_KEY literal,
// and the disclosure notes) now live in the SHARED `./datagovKey.js` seam (ADR-0010
// §2) — imported above, byte-identical behavior. GovInfo is their 2nd consumer, so
// the single-audited-home promotion mirrors the `coerce.ts` precedent for `num`.

// ─── SSRF-guarded fetch (§4 — fixed host + hostname assertion + redirect) ──
/**
 * GET one api.data.gov JSON resource. `host` is a fixed module constant; `path`
 * is a fixed base path (or a Zod-constrained interpolation); all caller params go
 * through `params` (URLSearchParams, encoded). Asserts the CONSTRUCTED URL's
 * hostname === host over https (belt-and-suspenders, copied from Socrata/CKAN),
 * sets `redirect:"error"` (a 3xx off an api.data.gov host is anomalous and must
 * NOT be followed — it could carry the X-Api-Key header to a foreign host), and
 * attaches the key ONLY in the X-Api-Key header. `label` is host+path only.
 */
async function getDatagov(
  host: string,
  path: string,
  label: string,
  params: URLSearchParams,
): Promise<unknown> {
  const qs = params.toString();
  const url = `https://${host}${path}${qs ? `?${qs}` : ""}`;
  const built = new URL(url);
  if (built.hostname !== host || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed api.data.gov URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(host)} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
    });
  }
  // Shared fetch envelope (ADR-0005): the key rides in headers ONLY (§2 rule 1);
  // redirect:"error" (§4); host-only label → ToolError.upstreamEndpoint (§2 rule 2).
  return getJson(url, { label, headers: keyHeader(), redirect: "error" });
}

// ═══════════════════ Regulations.gov (JSON:API) ═══════════════════

const REG_DOC_SOURCE = (mode: string) =>
  `${REGULATIONS_HOST} via Regulations.gov API (${mode})`;

type RegulationsSearchArgs = {
  searchTerm?: string;
  query?: string; // alias for searchTerm
  agencyId?: string;
  docketId?: string;
  documentType?: RegulationsDocumentType; // documents only
  withinCommentPeriod?: boolean; // documents only
  postedDateGe?: string;
  postedDateLe?: string;
  sort?: RegulationsSort;
  pageNumber?: number;
  pageSize?: number;
};

/** Map one JSON:API `data[]` document into a flat, honesty-coerced row. */
function mapRegDocument(item: unknown): Record<string, unknown> {
  const it = (item ?? {}) as { id?: unknown; attributes?: Record<string, unknown> };
  const a = (it.attributes ?? {}) as Record<string, unknown>;
  return {
    id: str(it.id),
    documentType: str(a.documentType),
    title: str(a.title),
    agencyId: str(a.agencyId),
    docketId: str(a.docketId),
    postedDate: str(a.postedDate),
    commentStartDate: str(a.commentStartDate),
    commentEndDate: str(a.commentEndDate),
    openForComment:
      typeof a.openForComment === "boolean" ? a.openForComment : null,
    withinCommentPeriod:
      typeof a.withinCommentPeriod === "boolean" ? a.withinCommentPeriod : null,
    frDocNum: str(a.frDocNum),
    objectId: str(a.objectId),
  };
}

/** Map one JSON:API `data[]` comment into a flat, honesty-coerced row. */
function mapRegComment(item: unknown): Record<string, unknown> {
  const it = (item ?? {}) as { id?: unknown; attributes?: Record<string, unknown> };
  const a = (it.attributes ?? {}) as Record<string, unknown>;
  return {
    id: str(it.id),
    documentType: str(a.documentType),
    title: str(a.title),
    agencyId: str(a.agencyId),
    docketId: str(a.docketId),
    postedDate: str(a.postedDate),
    objectId: str(a.objectId),
  };
}

/**
 * The shared Regulations.gov JSON:API search core for `/v4/documents` and
 * `/v4/comments` (identical envelope + identical page[number]≤40 hard cap).
 *
 * ⚠ CAP-VERIFICATION NOTE (m5): the `/v4/documents` 40-page cap (HTTP 400
 * "Maximum value is 40") is LIVE-VERIFIED (ADR-0007 §1c). The `/v4/comments` cap
 * was NOT live-verifiable at build time (the shared DEMO_KEY was rate-limited /
 * HTTP 429 on both hosts), so the SAME cap guard is applied here on the well-
 * founded assumption that the two endpoints share the identical JSON:API paging
 * contract (same host, same envelope, same page[number]/page[size] model).
 * LIVE-VERIFY `GET /v4/comments?page[number]=41` when a non-throttled key is
 * available and adjust REG_MAX_PAGE if it ever differs.
 */
async function regulationsSearch(
  endpoint: "/v4/documents" | "/v4/comments",
  kind: "documents" | "comments",
  args: RegulationsSearchArgs,
): Promise<MetaBundle> {
  const label = `regulations:${endpoint}`;
  const pageNumber = args.pageNumber ?? 1;
  const pageSize = args.pageSize ?? 25;
  const sort = args.sort ?? "-postedDate";

  // B1 PRE-FETCH window guard (mirror edgar.ts `from >= FTS_MAX_FROM`): reject a
  // beyond-cap page BEFORE any fetch, so a naive agent that computes page 41 gets
  // a clean LOCAL invalid_input, never the upstream HTTP 400. (Zod also caps
  // pageNumber≤40 / pageSize≤250 at the tool boundary — this is defense-in-depth
  // for a direct call.)
  if (pageNumber > REG_MAX_PAGE || pageNumber * pageSize > REG_MAX_RECORDS) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Regulations.gov page[number] (${pageNumber}) × page[size] (${pageSize}) exceeds the API's hard ${REG_MAX_RECORDS}-record / ${REG_MAX_PAGE}-page pagination ceiling. Narrow filters (agencyId/docketId/postedDate) or seek by lastModifiedDate instead of paging past ${REG_MAX_RECORDS} results.`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }

  const searchTerm = args.searchTerm ?? args.query;
  const params = new URLSearchParams();
  const filtersApplied: string[] = [];
  if (searchTerm) {
    params.set("filter[searchTerm]", searchTerm);
    filtersApplied.push("searchTerm");
  }
  if (args.agencyId) {
    params.set("filter[agencyId]", args.agencyId);
    filtersApplied.push("agencyId");
  }
  if (args.docketId) {
    params.set("filter[docketId]", args.docketId);
    filtersApplied.push("docketId");
  }
  if (kind === "documents" && args.documentType) {
    params.set("filter[documentType]", args.documentType);
    filtersApplied.push("documentType");
  }
  if (kind === "documents" && args.withinCommentPeriod !== undefined) {
    params.set("filter[withinCommentPeriod]", String(args.withinCommentPeriod));
    filtersApplied.push("withinCommentPeriod");
  }
  if (args.postedDateGe) {
    params.set("filter[postedDate][ge]", args.postedDateGe);
    filtersApplied.push("postedDateGe");
  }
  if (args.postedDateLe) {
    params.set("filter[postedDate][le]", args.postedDateLe);
    filtersApplied.push("postedDateLe");
  }
  params.set("sort", sort);
  params.set("page[number]", String(pageNumber));
  params.set("page[size]", String(pageSize));

  const body = await getDatagov(REGULATIONS_HOST, endpoint, label, params);
  const b = (body ?? {}) as {
    data?: unknown;
    meta?: { totalElements?: unknown } | null;
  };

  // M2 — `data` MUST be an array (a missing/string/null data is drift, never []).
  if (!Array.isArray(b.data)) {
    throw driftError(
      label,
      `regulations shape drift — ${endpoint} response.data must be an array.`,
    );
  }
  // M3 — CONTAINER-guarded total: a null/absent `meta` or a non-number
  // `meta.totalElements` → driftError (NOT a TypeError that would mask drift as
  // upstream_unavailable).
  if (!b.meta || typeof b.meta.totalElements !== "number") {
    throw driftError(
      label,
      `regulations shape drift — ${endpoint} meta.totalElements missing/non-number.`,
    );
  }

  const rows = (b.data as unknown[]).map(
    kind === "documents" ? mapRegDocument : mapRegComment,
  );
  const returned = rows.length;
  // EXACT real total — NEVER meta.totalPages*pageSize (§1c: totalPages is capped
  // at 40 = a lie). totalElements is typeof-guarded to be a number above.
  const totalAvailable = num(b.meta.totalElements);
  const offset = (pageNumber - 1) * pageSize;

  // B1 EDGAR-pattern cap: `hasMore` reflects whether MORE genuinely exists (from
  // the real total). `nextOffset` is the next page's record offset ONLY when the
  // next page is still inside the 40-page/10,000-record window; at the ceiling it
  // is null (no actionable continuation) + a disclosing note. Never use
  // meta.hasNextPage/lastPage/totalPages (cap-relative liars).
  const moreExist =
    totalAvailable !== null && pageNumber * pageSize < totalAvailable;
  const nextPageNumber = pageNumber + 1;
  const nextPageReachable =
    nextPageNumber <= REG_MAX_PAGE &&
    nextPageNumber * pageSize <= REG_MAX_RECORDS;
  const hasMore = moreExist;
  const nextOffset = moreExist && nextPageReachable ? pageNumber * pageSize : null;

  const notes: string[] = [];
  pushKeyNote(notes);
  if (moreExist && !nextPageReachable) {
    notes.push(
      `Reached the API's ${REG_MAX_RECORDS}-record / ${REG_MAX_PAGE}-page pagination ceiling (totalElements=${totalAvailable} total). ~${totalAvailable - REG_MAX_RECORDS} more records exist but are UNREACHABLE via page[number] — narrow filters (agencyId/docketId/postedDate) or seek by lastModifiedDate to reach the rest.`,
    );
  }

  const key = kind === "documents" ? "documents" : "comments";
  return withMeta(
    { [key]: rows },
    {
      source: REG_DOC_SOURCE(keyModeLabel()),
      keylessMode: false,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit: pageSize, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

/** Tool: regulations_search_documents. */
export async function searchDocuments(
  args: RegulationsSearchArgs,
): Promise<MetaBundle> {
  return regulationsSearch("/v4/documents", "documents", args);
}

/** Tool: regulations_search_comments. */
export async function searchComments(
  args: RegulationsSearchArgs,
): Promise<MetaBundle> {
  return regulationsSearch("/v4/comments", "comments", args);
}

// ─── Regulations.gov dockets (ADR-0044 — within-source DEPTH) ──────
// Siblings of regulationsSearch that reuse getDatagov + REG_MAX_* + the
// totalElements-exact block + pushKeyNote. The docket is the rulemaking CONTAINER
// grouping documents + comments, and (in DETAIL) it carries `rin` — the cross-
// source join key to the Federal Register / Unified Agenda (NULL in list rows,
// PRESENT in detail). regulationsSearch/mapRegDocument/mapRegComment are UNTOUCHED.

type RegulationsSearchDocketsArgs = {
  searchTerm?: string;
  query?: string; // alias for searchTerm
  agencyId?: string;
  docketType?: RegulationsDocketType;
  lastModifiedDateGe?: string;
  lastModifiedDateLe?: string;
  sort?: RegulationsDocketSort;
  limit?: number; // caller's requested count (min-5 client-slice control)
  pageNumber?: number;
};

type RegulationsGetDocketArgs = {
  docketId: string;
};

/**
 * Map one JSON:API `/v4/dockets` LIST row into a flat, honesty-coerced record
 * (all scalars via `str`, null-never-empty). `highlightedContent` (a search-
 * snippet artifact) is surfaced ONLY when a searchTerm was sent. There is NO
 * `rin` field: the list envelope never carries it (captured fact 4) — surfacing a
 * null `rin` here would read as "no RIN"; `rin` lives ONLY in mapDocketDetail.
 */
function mapDocketListRow(
  item: unknown,
  withSearchTerm: boolean,
): Record<string, unknown> {
  const it = (item ?? {}) as {
    id?: unknown;
    attributes?: Record<string, unknown>;
  };
  const a = (it.attributes ?? {}) as Record<string, unknown>;
  const row: Record<string, unknown> = {
    docketId: str(a.docketId),
    title: str(a.title),
    agencyId: str(a.agencyId),
    docketType: str(a.docketType),
    lastModifiedDate: str(a.lastModifiedDate),
    objectId: str(a.objectId),
    id: str(it.id),
  };
  if (withSearchTerm) row.highlightedContent = str(a.highlightedContent);
  return row;
}

/**
 * Map the `/v4/dockets/{docketId}` DETAIL object into the compliance-relevant
 * subset (captured fact 5). `rin` is null-when-absent (never "") — the cross-
 * source join key to the Federal Register / Unified Agenda. `keywords` → string[]
 * (via `str`+filter; [] only when genuinely absent). DROPS internal/rarely-
 * populated fields (displayProperties/generic/field1/field2/subType/subType2/
 * category/petitionNbr/organization/legacyId) to keep the row focused.
 */
function mapDocketDetail(data: unknown): Record<string, unknown> {
  const it = (data ?? {}) as {
    id?: unknown;
    attributes?: Record<string, unknown>;
  };
  const a = (it.attributes ?? {}) as Record<string, unknown>;
  const keywords = Array.isArray(a.keywords)
    ? (a.keywords as unknown[])
        .map((k) => str(k))
        .filter((k): k is string => k !== null)
    : [];
  return {
    docketId: str(a.docketId),
    title: str(a.title),
    agencyId: str(a.agencyId),
    docketType: str(a.docketType),
    // rin — the cross-source join key; null-when-absent, NEVER "".
    rin: str(a.rin),
    dkAbstract: str(a.dkAbstract),
    keywords,
    program: str(a.program),
    shortTitle: str(a.shortTitle),
    effectiveDate: str(a.effectiveDate),
    modifyDate: str(a.modifyDate),
    objectId: str(a.objectId),
    id: str(it.id),
  };
}

/**
 * Tool: regulations_search_dockets (`GET /v4/dockets`). Lists rulemaking/
 * nonrulemaking docket CONTAINERS with the same 40-page/10,000-record ceiling and
 * `totalElements`-exact total doctrine as regulationsSearch.
 *
 * ★ min-5 floor (ADR-0044): the API 400s on page[size]<5. The friendly `limit`
 * exposes 1..250; the wire page[size] is `max(5, limit)` and a `limit<5` returns
 * the first `limit` of the fetched rows client-side (disclosed) — `totalAvailable`
 * stays the EXACT server total.
 */
export async function searchDockets(
  args: RegulationsSearchDocketsArgs,
): Promise<MetaBundle> {
  const label = "regulations:/v4/dockets";
  const limit = args.limit ?? 20;
  const pageNumber = args.pageNumber ?? 1;
  const sort = args.sort ?? "-lastModifiedDate";
  const fetchSize = Math.max(5, limit); // the wire page[size] — NEVER < 5
  const clientSlice = limit < 5;

  // S6 — pre-fetch window guard (mirror regulationsSearch): reject a beyond-ceiling
  // page BEFORE any fetch, so a DIRECT call bypassing the Zod caps gets a clean
  // LOCAL invalid_input rather than burning a scarce DEMO_KEY call on an upstream
  // 400. (Zod also caps pageNumber≤40 / limit≤250 at the tool boundary.)
  if (pageNumber > REG_MAX_PAGE || pageNumber * fetchSize > REG_MAX_RECORDS) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Regulations.gov page[number] (${pageNumber}) × page[size] (${fetchSize}) exceeds the API's hard ${REG_MAX_RECORDS}-record / ${REG_MAX_PAGE}-page pagination ceiling. Narrow filters (agencyId/docketType/lastModifiedDate) or seek by lastModifiedDate instead of paging past ${REG_MAX_RECORDS} results.`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }

  const searchTerm = args.searchTerm ?? args.query;
  const params = new URLSearchParams();
  const filtersApplied: string[] = [];
  if (searchTerm) {
    params.set("filter[searchTerm]", searchTerm);
    filtersApplied.push("searchTerm");
  }
  if (args.agencyId) {
    params.set("filter[agencyId]", args.agencyId);
    filtersApplied.push("agencyId");
  }
  if (args.docketType) {
    params.set("filter[docketType]", args.docketType);
    filtersApplied.push("docketType");
  }
  if (args.lastModifiedDateGe) {
    params.set("filter[lastModifiedDate][ge]", args.lastModifiedDateGe);
    filtersApplied.push("lastModifiedDateGe");
  }
  if (args.lastModifiedDateLe) {
    params.set("filter[lastModifiedDate][le]", args.lastModifiedDateLe);
    filtersApplied.push("lastModifiedDateLe");
  }
  params.set("sort", sort);
  params.set("page[number]", String(pageNumber));
  params.set("page[size]", String(fetchSize));

  // M1 — the typed catch ladder (fema.ts:262-275 shape). Preserve the 429/404/5xx/
  // 400/timeout ToolErrorCarrier taxonomy FIRST (LOAD-BEARING: a broader catch
  // would regress the DEMO_KEY-10/hr 429→rate_limited frontier to schema_drift);
  // reclassify a 200 non-JSON `.json()` SyntaxError to schema_drift SECOND; bare-
  // rethrow LAST.
  let body: unknown;
  try {
    body = await getDatagov(REGULATIONS_HOST, "/v4/dockets", label, params);
  } catch (e) {
    if (e instanceof ToolErrorCarrier) throw e;
    if (e instanceof SyntaxError)
      throw driftError(
        label,
        "Regulations.gov returned a non-JSON body at HTTP 200 — schema drift.",
      );
    throw e;
  }

  const b = (body ?? {}) as {
    data?: unknown;
    meta?: { totalElements?: unknown } | null;
  };

  // data[] guard + meta.totalElements container guard (datagov.ts:288-302 idiom).
  if (!Array.isArray(b.data)) {
    throw driftError(
      label,
      "regulations shape drift — /v4/dockets response.data must be an array.",
    );
  }
  if (!b.meta || typeof b.meta.totalElements !== "number") {
    throw driftError(
      label,
      "regulations shape drift — /v4/dockets meta.totalElements missing/non-number.",
    );
  }

  const rawRows = (b.data as unknown[]).map((row) =>
    mapDocketListRow(row, Boolean(searchTerm)),
  );
  const rows = clientSlice ? rawRows.slice(0, limit) : rawRows;
  const returned = rows.length;
  // EXACT real total — NEVER meta.totalPages (a capped-40 sentinel). Typeof-guarded
  // above. UNAFFECTED by the client-slice.
  const totalAvailable = num(b.meta.totalElements);
  const offset = (pageNumber - 1) * fetchSize;

  const moreExist =
    totalAvailable !== null && offset + returned < totalAvailable;
  const nextPageNumber = pageNumber + 1;
  const nextPageReachable =
    nextPageNumber <= REG_MAX_PAGE &&
    nextPageNumber * fetchSize <= REG_MAX_RECORDS;
  const hasMore = moreExist;
  // nextOffset is null in the client-slice case (paging by pageNumber would skip
  // the unshown rows — an honest "increase limit to page reliably") and at the
  // ceiling (no reachable continuation) — both surface hasMore:true/nextOffset:null.
  const nextOffset =
    moreExist && nextPageReachable && !clientSlice ? pageNumber * fetchSize : null;

  const notes: string[] = [];
  pushKeyNote(notes);
  if (moreExist && !nextPageReachable) {
    notes.push(
      `Reached the API's ${REG_MAX_RECORDS}-record / ${REG_MAX_PAGE}-page pagination ceiling (totalElements=${totalAvailable} total). ~${totalAvailable - REG_MAX_RECORDS} more records exist but are UNREACHABLE via page[number] — narrow filters (agencyId/docketType/lastModifiedDate) or seek by lastModifiedDate to reach the rest.`,
    );
  }
  if (clientSlice) {
    notes.push(
      `limit<5 requested; page[size] was floored to 5 upstream (the API rejects page[size]<5) and the first ${limit} of the ${rawRows.length} fetched rows are returned — totalAvailable is still the EXACT server total. For reliable pagination use limit>=5.`,
    );
  }

  return withMeta(
    { dockets: rows },
    {
      source: REG_DOC_SOURCE(keyModeLabel()),
      keylessMode: false, // M2 — genuinely keyed
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      // S3 — pagination.limit is the CALLER's requested count (the honest effective
      // window; the wire floor of 5 is disclosed only in the min-5 note). offset
      // uses fetchSize.
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

/**
 * Tool: regulations_get_docket (`GET /v4/dockets/{docketId}`). Single-docket
 * detail — the ONLY view carrying `rin`. `docketId` is charclass-validated at the
 * Zod layer (S1); it is the only caller value reaching a path segment.
 */
export async function getDocket(
  args: RegulationsGetDocketArgs,
): Promise<MetaBundle> {
  const label = "regulations:/v4/dockets/{id}";
  const path = `/v4/dockets/${args.docketId}`;
  const params = new URLSearchParams();

  // M1 — the IDENTICAL typed catch ladder as searchDockets (fema.ts:262-275). A
  // nonexistent id is EXPECTED to 404 → not_found; the missing-`data` driftError
  // guard below is the mandatory fallback if a bad id instead yields a 200 error-
  // envelope (S2).
  let body: unknown;
  try {
    body = await getDatagov(REGULATIONS_HOST, path, label, params);
  } catch (e) {
    if (e instanceof ToolErrorCarrier) throw e;
    if (e instanceof SyntaxError)
      throw driftError(
        label,
        "Regulations.gov returned a non-JSON body at HTTP 200 — schema drift.",
      );
    throw e;
  }

  const b = (body ?? {}) as { data?: unknown };

  // S2 — MANDATORY fabrication guard: a missing/non-object `data` → schema_drift,
  // NEVER a fabricated {docketId, ...nulls} (mirror getBill's bill guard).
  if (!b.data || typeof b.data !== "object") {
    throw driftError(
      label,
      "regulations shape drift — /v4/dockets/{docketId} response.data missing/not-an-object.",
    );
  }

  const notes: string[] = [];
  pushKeyNote(notes);
  notes.push(
    "rin (Regulatory Identifier Number) is the join key to the Federal Register (fed_register_search_documents) and the Unified Agenda; null when this docket has no assigned RIN (e.g. many Nonrulemaking dockets).",
  );

  return withMeta(
    { docket: mapDocketDetail(b.data) },
    {
      source: REG_DOC_SOURCE(keyModeLabel()),
      keylessMode: false, // M2 — genuinely keyed
      returned: 1,
      totalAvailable: null, // S4 — single-record detail convention (rely on complete:true)
      filtersApplied: [],
      filtersDropped: [],
      fieldsUnavailable: [],
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ═══════════════════ Congress.gov ═════════════════════════════════

const CONGRESS_SOURCE = (mode: string) =>
  `${CONGRESS_HOST} via Congress.gov API (${mode})`;

/** Map one Congress.gov `bills[]` item into a flat, honesty-coerced row. */
function mapBill(item: unknown): Record<string, unknown> {
  const it = (item ?? {}) as Record<string, unknown>;
  const latest = (it.latestAction ?? null) as Record<string, unknown> | null;
  return {
    congress: num(it.congress),
    type: str(it.type),
    number: str(it.number),
    title: str(it.title),
    originChamber: str(it.originChamber),
    latestAction: latest
      ? { actionDate: str(latest.actionDate), text: str(latest.text) }
      : null,
    updateDate: str(it.updateDate),
    // `url` is the API's canonical resource locator; under header auth it is
    // key-FREE (the key is never in any URL). Passed through as data.
    url: str(it.url),
  };
}

type CongressSearchBillsArgs = {
  query?: string;
  congress?: number;
  billType?: CongressBillType;
  fromDateTime?: string;
  toDateTime?: string;
  offset?: number;
  limit?: number;
};

/**
 * Tool: congress_search_bills. Lists bills via `/v3/bill`, `/v3/bill/{congress}`,
 * or `/v3/bill/{congress}/{billType}` (congress/billType are Zod-constrained PATH
 * segments — §4). Numeric offset/limit pagination; `totalAvailable =
 * pagination.count` (EXACT). `nextOffset` is re-derived NUMERICALLY (never the
 * upstream `pagination.next` URL — §2 rule 4).
 *
 * HONESTY on `query`: the Congress.gov `/v3/bill` endpoint has NO keyword-search
 * parameter, so a supplied `query` is NOT sent and is disclosed in
 * `filtersDropped` (a filter we cannot honor is surfaced, never silently ignored).
 */
export async function searchBills(
  args: CongressSearchBillsArgs,
): Promise<MetaBundle> {
  const label = "congress:/v3/bill";
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;

  if (args.billType && args.congress === undefined) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message:
        "congress_search_bills: `billType` requires `congress` (the path is /v3/bill/{congress}/{billType}). Provide `congress`, or omit `billType`.",
      retryable: false,
      upstreamEndpoint: label,
    });
  }

  let path = "/v3/bill";
  if (args.congress !== undefined) {
    path += `/${args.congress}`;
    if (args.billType) path += `/${args.billType}`;
  }

  const params = new URLSearchParams();
  params.set("format", "json");
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  const filtersApplied: string[] = [];
  const filtersDropped: string[] = [];
  if (args.congress !== undefined) filtersApplied.push("congress");
  if (args.billType) filtersApplied.push("billType");
  if (args.fromDateTime) {
    params.set("fromDateTime", args.fromDateTime);
    filtersApplied.push("fromDateTime");
  }
  if (args.toDateTime) {
    params.set("toDateTime", args.toDateTime);
    filtersApplied.push("toDateTime");
  }
  if (args.query) filtersDropped.push("query");

  const body = await getDatagov(CONGRESS_HOST, path, label, params);
  const b = (body ?? {}) as {
    bills?: unknown;
    pagination?: { count?: unknown } | null;
  };

  // M2 — `bills` MUST be an array (missing/string/null → drift, never []).
  if (!Array.isArray(b.bills)) {
    throw driftError(
      label,
      "congress shape drift — /v3/bill response.bills must be an array.",
    );
  }
  // M3 — CONTAINER-guarded total: null/absent `pagination` or non-number
  // `pagination.count` → driftError (not a TypeError masked as upstream_unavailable).
  if (!b.pagination || typeof b.pagination.count !== "number") {
    throw driftError(
      label,
      "congress shape drift — /v3/bill pagination.count missing/non-number.",
    );
  }

  const bills = (b.bills as unknown[]).map(mapBill);
  const returned = bills.length;
  const totalAvailable = num(b.pagination.count); // EXACT
  const hasMore =
    totalAvailable !== null ? offset + returned < totalAvailable : false;
  const nextOffset = hasMore ? offset + returned : null;

  const notes: string[] = [];
  pushKeyNote(notes);
  if (filtersDropped.includes("query")) {
    notes.push(
      "The `query` filter was NOT applied: Congress.gov /v3/bill has no keyword-search parameter. Results are UNFILTERED on keyword — narrow with `congress`, `billType`, `fromDateTime`/`toDateTime` instead.",
    );
  }

  return withMeta(
    { bills },
    {
      source: CONGRESS_SOURCE(keyModeLabel()),
      keylessMode: false,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped,
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

type CongressGetBillArgs = {
  congress: number;
  billType: CongressBillType;
  billNumber: number;
};

/**
 * Tool: congress_get_bill. Fetches one bill via
 * `/v3/bill/{congress}/{billType}/{billNumber}` (all three path segments are
 * Zod-constrained to int/enum — §4, no injection). Single-record honest `_meta`
 * (complete:true). A 404 (nonexistent bill) → not_found (never fabricated).
 */
export async function getBill(args: CongressGetBillArgs): Promise<MetaBundle> {
  const label = "congress:/v3/bill";
  const path = `/v3/bill/${args.congress}/${args.billType}/${args.billNumber}`;
  const params = new URLSearchParams();
  params.set("format", "json");

  const body = await getDatagov(CONGRESS_HOST, path, label, params);
  const b = (body ?? {}) as { bill?: unknown };

  if (!b.bill || typeof b.bill !== "object") {
    throw driftError(
      label,
      "congress shape drift — /v3/bill/{congress}/{type}/{number} response.bill missing/not-an-object.",
    );
  }

  const notes: string[] = [];
  pushKeyNote(notes);

  return withMeta(
    { bill: b.bill },
    {
      source: CONGRESS_SOURCE(keyModeLabel()),
      keylessMode: false,
      returned: 1,
      totalAvailable: null,
      filtersApplied: [],
      filtersDropped: [],
      fieldsUnavailable: [],
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
