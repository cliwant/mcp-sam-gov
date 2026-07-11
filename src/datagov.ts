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

// ─── Key resolver (the load-bearing secret discipline) ────────────
// The key is read from env; if unset/empty it falls back to the public literal
// "DEMO_KEY". `keyHeader()` is the ONLY place the value is used — it is placed in
// the `X-Api-Key` request header and NOWHERE else (never the URL, never the label,
// never `_meta`, never a log). Mirrors Socrata's `appTokenHeader()`/`appTokenPresent()`
// split (there the token is optional; here it is required-with-public-fallback).
const DEMO_KEY = "DEMO_KEY";

function resolvedKey(): string {
  const raw = process.env.DATA_GOV_API_KEY;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : DEMO_KEY;
}

/** The X-Api-Key header — the ONLY carrier of the secret. Never logged/echoed. */
function keyHeader(): Record<string, string> {
  return { "X-Api-Key": resolvedKey() };
}

/** true when no real DATA_GOV_API_KEY is configured (drives the disclosure note). */
function usingDemoKey(): boolean {
  const raw = process.env.DATA_GOV_API_KEY;
  return !(typeof raw === "string" && raw.trim());
}

/** Key-MODE label for `_meta.source` — the MODE, never the value. */
function keyModeLabel(): string {
  return usingDemoKey() ? "DEMO_KEY" : "DATA_GOV_API_KEY";
}

// The DEMO_KEY disclosure (m4-note: NO hardcoded verification date — "approximately
// 10 requests/hour", not a pinned date).
const DEMO_KEY_NOTE =
  "Using the shared api.data.gov DEMO_KEY — approximately 10 requests/hour, shared across all DEMO_KEY callers (limits reached quickly). Set DATA_GOV_API_KEY for production; free key at https://api.data.gov/signup/.";
const CONFIGURED_KEY_NOTE =
  "Using a configured DATA_GOV_API_KEY (value never logged).";

/** Push the key-mode disclosure note (DEMO_KEY ceiling OR configured-key). */
function pushKeyNote(notes: string[]): void {
  notes.push(usingDemoKey() ? DEMO_KEY_NOTE : CONFIGURED_KEY_NOTE);
}

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
