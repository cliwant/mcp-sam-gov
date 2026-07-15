/**
 * courtlistener.ts — US FEDERAL COURT OPINIONS via CourtListener (ADR-0055) — the
 * LITIGATION / case-law lane. Federal court decisions (opinions/clusters) — who
 * sued whom in which court, the nature of suit, the disposition — the judicial
 * signal no contract/spending/lobbying source carries (e.g. bid-protest and
 * contract-claim opinions from the US Court of Federal Claims `uscfc` and the
 * Federal Circuit `cafc`).
 *
 * ★ PROVENANCE — THIS IS NOT A .gov API (must be disclosed). The DATA is US federal
 *   court PUBLIC RECORDS, but the API is **CourtListener**, operated by the **Free
 *   Law Project** (a non-profit) which republishes those records KEYLESS. The .gov
 *   primary source (PACER) is PAYWALLED. So every response's `_meta.source` AND a
 *   note name CourtListener/Free Law Project and disclose the PACER-paywall — the
 *   tool never presents itself as a government API.
 *
 * ★ THIS IS A KEYLESS TOOL WITH AN *OPTIONAL* RATE-LIMIT TOKEN (the lda.ts /
 *   socrata app-token lineage, NOT the census/fred/bea key-REQUIRED lineage).
 *   Anonymous GETs return HTTP 200 — it works with NO token. A free
 *   COURTLISTENER_API_TOKEN only RAISES the shared rate limit; when set it rides
 *   ONLY as the `Authorization: Token <value>` request header (never the
 *   URL/label/_meta/notes/log — the K-test). When unset, NO auth header is sent
 *   (genuine keyless). This mirrors lda.ts's optional-Authorization discipline.
 *
 *   GET https://www.courtlistener.com/api/rest/v4/search/
 *       ?q=&court=&filed_after=&filed_before=&type=o&order_by=<order>[&cursor=]
 *   → { count, next, previous, results:[{ caseName, court, court_id, dateFiled,
 *        docketNumber, suitNature, status, judge, citation, absolute_url, … }] }
 *
 * ★ HONESTY (ADR-0055 P1–P5):
 *   [P1]  totalAvailable = `count` (the API's REAL total for the filter, e.g. the
 *         uscfc opinion corpus ~10595) — NEVER results.length. ★CURSOR pagination:
 *         `next` is a FULL URL carrying an opaque `cursor=` param (NOT page/offset).
 *         We EXTRACT the `cursor` value out of `next` and return it as `nextCursor`
 *         (offset/nextOffset null — a numeric offset is meaningless); hasMore = next
 *         is a non-null string. CourtListener v4 stops counting on deep cursor pages
 *         (`count:null`) — that is DISCLOSED (totalAvailable:null + a note), never
 *         fabricated as results.length.
 *   [P2]  a genuine no-match (results:[]) ⇒ honest empty (returned:0). A 400 (bad
 *         param) ⇒ invalid_input surfacing the API's message. A 429 (unauth
 *         throttle) ⇒ rate_limited THROW (Retry-After honored, never routed around).
 *         A 5xx/timeout ⇒ upstream_unavailable THROW. A 200 non-JSON ⇒ schema_drift.
 *   [P3]  dates are strings; `citation` may be an array/object ⇒ flattened to a safe
 *         string / string[] (never fabricated); judge / natureOfSuit / docketNumber
 *         are null when absent (never empty-string); every scalar null-never-empty.
 *   [P4]  `results` non-array, or `count` neither a number NOR null ⇒ driftError
 *         (never a fabricated empty/total).
 *   [K-test] OPTIONAL token: when COURTLISTENER_API_TOKEN is set it rides ONLY the
 *         `Authorization: Token …` header — NEVER the URL/label/_meta/notes/log.
 *         Unset ⇒ anonymous (no auth header at all).
 *   [SSRF] fixed host `www.courtlistener.com`; a post-construction hostname/protocol
 *         assert + `redirect:"error"`; `court` charclass `^[a-z0-9]+$`; the dates
 *         charclass `^\d{4}-\d{2}-\d{2}$`; every VALUE rides URLSearchParams. The
 *         `cursor` is opaque but charclass-guarded; and when we EXTRACT the cursor
 *         from a `next` URL we RE-ASSERT that URL's host is courtlistener.com — an
 *         off-host `next` is REFUSED (schema_drift), never followed.
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// ─── SSRF core: the single fixed host + base path ─────────────────
export const COURTLISTENER_HOST = "www.courtlistener.com";
const COURTLISTENER_SEARCH_PATH = "/api/rest/v4/search/";
// HOST+path label — surfaces in ToolError.upstreamEndpoint; the optional token rides
// ONLY in the Authorization header, so no token can ever appear here.
const COURTLISTENER_SEARCH_LABEL = "courtlistener:/api/rest/v4/search";

// ─── Validation (SSRF + "verify the input" honesty) ───────────────
// A CourtListener court id — lowercase alphanumerics only (e.g. uscfc, cafc, scotus).
const COURT_RE = /^[a-z0-9]+$/;
// An ISO calendar date (→ filed_after / filed_before).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// The opaque cursor grammar (SSRF + injection guard). CourtListener's v4 cursor is a
// URL-safe token; we return the DECODED value (extracted via URLSearchParams), so it
// carries NO `%`. Reject spaces / `&` / `#` / `?` / quotes / angle-brackets / `\`
// BEFORE it rides `cursor=` (defense-in-depth — the value can never steer the
// fixed-host authority, but a malformed cursor must never reach the query).
export const COURTLISTENER_CURSOR_RE = /^[A-Za-z0-9\-._~=+/:]{1,8192}$/;

const DEFAULT_ORDER = "dateFiled desc";

// ─── Honesty notes (ADR-0055 required set) ────────────────────────
const PROVENANCE_NOTE =
  "Data = US FEDERAL COURT PUBLIC RECORDS served by CourtListener (Free Law Project, a non-profit) — NOT a .gov API. CourtListener republishes these records keyless; the .gov primary source (PACER) is PAYWALLED. Treat opinions as of CourtListener's last ingest.";
const KEYLESS_NOTE =
  "Keyless by default (anonymous CourtListener access returns HTTP 200). An optional free COURTLISTENER_API_TOKEN only RAISES the rate limit; when set it is sent ONLY as the `Authorization: Token …` request header and is NEVER logged, echoed, or placed in this response.";
const COUNT_TOTAL_NOTE =
  "totalAvailable is CourtListener's real `count` — the total match count for the filter (NOT the rows on this page). Pagination is an OPAQUE cursor: pass _meta.nextCursor back as the `cursor` argument (offset/nextOffset are meaningless/null). nextCursor:null / hasMore:false means this is the last page.";
const DEEP_PAGE_NO_COUNT_NOTE =
  "CourtListener did not report a `count` on this cursor page (v4 stops counting on deep pages to save cost) — totalAvailable is unknown (null), NOT results.length. Use nextCursor to continue.";
const NATURE_OF_SUIT_QUERY_NOTE =
  "natureOfSuit was applied as a full-text query term (the v4 opinions search has no verified dedicated nature-of-suit filter), so it matches that text anywhere in the document rather than an exact suitNature-field equality.";

// ─── The optional-token seam (value NEVER leaked past the Authorization header) ──
/**
 * The optional Authorization header (keyless-first, lda.ts/socrata app-token
 * lineage). Present ONLY when COURTLISTENER_API_TOKEN is set (non-blank); the value
 * is NEVER logged / never placed in the URL, label, `_meta`, or a note. When unset,
 * `{}` (no header ⇒ genuine anonymous).
 */
export function courtlistenerAuthHeader(): Record<string, string> {
  const raw = process.env.COURTLISTENER_API_TOKEN;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? { Authorization: `Token ${trimmed}` } : {};
}

/** true iff a CourtListener token is configured (for the `_meta` note — never the value). */
export function courtlistenerTokenPresent(): boolean {
  const raw = process.env.COURTLISTENER_API_TOKEN;
  return typeof raw === "string" && raw.trim().length > 0;
}

// ─── Curated opinion shape ────────────────────────────────────────
export type CourtlistenerOpinion = {
  caseName: string | null;
  court: string | null; // the court's full name (court_citation_string / court)
  courtId: string | null; // court_id (e.g. "uscfc")
  dateFiled: string | null; // dateFiled (a date STRING — P3, never coerced)
  docketNumber: string | null;
  natureOfSuit: string | null; // suitNature — null when absent (never "")
  status: string | null;
  judge: string | null;
  citation: string | string[] | null; // flattened array/object/string (P3)
  absoluteUrl: string | null; // full https://www.courtlistener.com + absolute_url
};

/**
 * Flatten CourtListener's `citation` (which may be a string, an array of strings,
 * or an object) to a safe `string | string[] | null` — NEVER fabricated. An array
 * ⇒ the non-null strings (or null when none); a string ⇒ that string; an object ⇒
 * its non-null string VALUES (or null when none); absent ⇒ null. `[object Object]`
 * can never leak (we never `String()` an object).
 */
export function flattenCitation(x: unknown): string | string[] | null {
  if (x === null || x === undefined) return null;
  if (typeof x === "string") return str(x);
  if (Array.isArray(x)) {
    const parts = x.map((v) => str(v)).filter((v): v is string => v !== null);
    return parts.length === 0 ? null : parts;
  }
  if (typeof x === "object") {
    const parts = Object.values(x as Record<string, unknown>)
      .map((v) => str(v))
      .filter((v): v is string => v !== null);
    return parts.length === 0 ? null : parts;
  }
  return null;
}

/** Prefix a relative absolute_url with the fixed host; pass an already-absolute URL through. */
function resolveAbsoluteUrl(raw: unknown): string | null {
  const path = str(raw);
  if (path === null) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return `https://${COURTLISTENER_HOST}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Map ONE `results[]` opinion row → the curated shape. Every scalar via `str`. */
function mapOpinion(raw: unknown): CourtlistenerOpinion {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    caseName: str(o.caseName) ?? str(o.caseNameFull),
    // court_citation_string is the short display name; fall back to the full `court`.
    court: str(o.court_citation_string) ?? str(o.court),
    courtId: str(o.court_id),
    dateFiled: str(o.dateFiled),
    docketNumber: str(o.docketNumber),
    natureOfSuit: str(o.suitNature),
    status: str(o.status),
    judge: str(o.judge),
    citation: flattenCitation(o.citation),
    absoluteUrl: resolveAbsoluteUrl(o.absolute_url),
  };
}

/**
 * Extract the opaque `cursor` value from a CourtListener `next` URL. RE-ASSERTS the
 * `next` URL's host is courtlistener.com — an OFF-HOST `next` is REFUSED (drift),
 * never parsed/followed (SSRF: a poisoned `next` could otherwise steer the next
 * page off-host). Returns the decoded cursor string, or null when `next` is null /
 * carries no cursor. A non-string / unparseable `next` ⇒ null (treated as "no more").
 */
export function extractNextCursor(next: unknown, label: string): string | null {
  if (next === null || next === undefined) return null;
  if (typeof next !== "string" || next === "") return null;
  let u: URL;
  try {
    u = new URL(next);
  } catch {
    // A malformed `next` is drift — never fabricate a continuation from it.
    throw driftError(
      label,
      `CourtListener returned a malformed \`next\` URL (${JSON.stringify(next).slice(0, 120)}) — refusing to derive a cursor from it.`,
    );
  }
  if (u.hostname !== COURTLISTENER_HOST || u.protocol !== "https:") {
    // An OFF-HOST next must be refused, not followed (SSRF safety).
    throw driftError(
      label,
      `CourtListener \`next\` points off-host (${JSON.stringify(u.hostname)} ${u.protocol}) — refusing to follow it (SSRF safety).`,
    );
  }
  return u.searchParams.get("cursor");
}

// ─── Tool: courtlistener_search_opinions ──────────────────────────
export type CourtlistenerSearchOpinionsArgs = {
  query?: string; // → q
  court?: string; // a court id (e.g. uscfc|cafc|scotus); ^[a-z0-9]+$
  dateFiledAfter?: string; // → filed_after; ^\d{4}-\d{2}-\d{2}$
  dateFiledBefore?: string; // → filed_before; ^\d{4}-\d{2}-\d{2}$
  natureOfSuit?: string; // folded into q (no verified dedicated filter)
  cursor?: string; // opaque passthrough for the next page
  order?: string; // default "dateFiled desc"
};

/**
 * Search US federal court opinions via CourtListener (`/api/rest/v4/search/`,
 * type=o) → curated opinion rows + honest `_meta`. KEYLESS (an optional
 * COURTLISTENER_API_TOKEN only raises the rate limit, sent as the Authorization
 * header only). ★PROVENANCE: this is CourtListener/Free Law Project (a non-profit),
 * NOT a .gov API — PACER (the .gov source) is paywalled. totalAvailable is the
 * API's REAL `count`; CURSOR pagination (nextCursor extracted from `next`).
 */
export async function searchOpinions(
  args: CourtlistenerSearchOpinionsArgs,
): Promise<MetaBundle> {
  const label = COURTLISTENER_SEARCH_LABEL;

  // ── Validate + default (belt-and-suspenders behind the server Zod; a DIRECT
  //    handler call bypasses Zod). court / dates are charclass-guarded; the cursor
  //    grammar-guarded; the free-text values ride URLSearchParams (encoded). ──
  if (args.court !== undefined && !COURT_RE.test(args.court)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid court ${JSON.stringify(args.court)} — expected a CourtListener court id (lowercase alphanumerics, ^[a-z0-9]+$), e.g. "uscfc", "cafc", "scotus".`,
      upstreamEndpoint: label,
    });
  }
  if (
    args.dateFiledAfter !== undefined &&
    !DATE_RE.test(args.dateFiledAfter)
  ) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid dateFiledAfter ${JSON.stringify(args.dateFiledAfter)} — expected an ISO date (^\\d{4}-\\d{2}-\\d{2}$), e.g. "2020-01-01".`,
      upstreamEndpoint: label,
    });
  }
  if (
    args.dateFiledBefore !== undefined &&
    !DATE_RE.test(args.dateFiledBefore)
  ) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid dateFiledBefore ${JSON.stringify(args.dateFiledBefore)} — expected an ISO date (^\\d{4}-\\d{2}-\\d{2}$), e.g. "2024-12-31".`,
      upstreamEndpoint: label,
    });
  }
  if (
    args.cursor !== undefined &&
    !COURTLISTENER_CURSOR_RE.test(args.cursor)
  ) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid cursor (opaque continuation token) — must be a ≤8192-char URL-safe token (no spaces, '%', or steering characters). Pass back the _meta.nextCursor from the previous page.`,
      upstreamEndpoint: label,
    });
  }

  // ── Build the query from VALIDATED typed args, key-by-key (SSRF: no raw
  //    passthrough; every VALUE is URLSearchParams-encoded). type=o is FIXED. ──
  const params = new URLSearchParams();
  const filtersApplied: string[] = [];
  // natureOfSuit has no verified dedicated filter on the v4 opinions search, so it
  // is folded into the `q` full-text query (disclosed via NATURE_OF_SUIT_QUERY_NOTE).
  const qParts: string[] = [];
  if (args.query !== undefined && args.query !== "") {
    qParts.push(args.query);
    filtersApplied.push("query");
  }
  let natureOfSuitApplied = false;
  if (args.natureOfSuit !== undefined && args.natureOfSuit !== "") {
    qParts.push(args.natureOfSuit);
    filtersApplied.push("natureOfSuit");
    natureOfSuitApplied = true;
  }
  if (qParts.length > 0) params.set("q", qParts.join(" "));
  if (args.court !== undefined) {
    params.set("court", args.court);
    filtersApplied.push("court");
  }
  if (args.dateFiledAfter !== undefined) {
    params.set("filed_after", args.dateFiledAfter);
    filtersApplied.push("dateFiledAfter");
  }
  if (args.dateFiledBefore !== undefined) {
    params.set("filed_before", args.dateFiledBefore);
    filtersApplied.push("dateFiledBefore");
  }
  params.set("type", "o"); // FIXED — opinions only
  params.set("order_by", args.order && args.order !== "" ? args.order : DEFAULT_ORDER);
  if (args.cursor !== undefined) {
    params.set("cursor", args.cursor);
    filtersApplied.push("cursor");
  }

  const url = `https://${COURTLISTENER_HOST}${COURTLISTENER_SEARCH_PATH}?${params.toString()}`;
  // Belt-and-suspenders: the fixed host + strictly-built query leave nothing to
  // steer the authority; assert the built URL cannot have been moved off-host.
  const built = new URL(url);
  if (built.hostname !== COURTLISTENER_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Constructed CourtListener URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${COURTLISTENER_HOST} over https — refusing to fetch (SSRF safety).`,
      upstreamEndpoint: label,
    });
  }

  // ── Fetch through the shared envelope. The optional token rides the Authorization
  //    header ONLY (never the URL/label/_meta); redirect:"error" fails closed on any
  //    off-host 3xx. A 429 ⇒ rate_limited THROW (Retry-After honored by the shared
  //    taxonomy, never routed around); a 5xx/timeout ⇒ upstream_unavailable THROW; a
  //    400 ⇒ invalid_input (re-read below to surface the API message); a 200 non-JSON
  //    ⇒ getJson's r.json() throws a SyntaxError ⇒ schema_drift. ──
  const headers = courtlistenerAuthHeader();
  let body: unknown;
  try {
    body = await getJson<unknown>(url, {
      label,
      headers,
      redirect: "error",
    });
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw driftError(
        label,
        "CourtListener /api/rest/v4/search returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).",
      );
    }
    // [P2] A 400 (bad param) carries a DRF error body; fetchWithRetry discarded it.
    // Re-read once on the error path ONLY so the caller learns the REAL reason (never
    // a fake-empty). 5xx/429/404/timeout keep their taxonomy.
    if (e instanceof ToolErrorCarrier && e.toolError.upstreamStatus === 400) {
      const apiMsg = await readCourtlistenerErrorMessage(url, headers);
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        retryable: false,
        message: apiMsg
          ? `CourtListener rejected the request (HTTP 400): ${apiMsg}. Check the filter parameters (court, dateFiledAfter/Before, order, cursor).`
          : "CourtListener rejected the request (HTTP 400) — check the filter parameters (court, dateFiledAfter/Before, order, cursor).",
        upstreamStatus: 400,
        upstreamEndpoint: label,
      });
    }
    throw e; // 5xx → upstream_unavailable, 404 → not_found, 429 → rate_limited …
  }

  // ── [P4] `results` MUST be an array; `count` MUST be a number OR null (v4 returns
  //    count:null on deep cursor pages — a documented behavior, NOT drift). A
  //    non-array results, or a count that is neither a number nor null (e.g. a
  //    string/object), is drift — never a fabricated empty/total. ──
  const b = (body ?? {}) as { results?: unknown; count?: unknown; next?: unknown };
  if (!Array.isArray(b.results)) {
    throw driftError(
      label,
      "CourtListener /api/rest/v4/search shape drift — `results` must be an array.",
    );
  }
  const rawCount = b.count;
  const countIsNumber = typeof rawCount === "number" && Number.isFinite(rawCount);
  if (!countIsNumber && rawCount !== null && rawCount !== undefined) {
    throw driftError(
      label,
      "CourtListener /api/rest/v4/search shape drift — `count` must be the total match count (a number) or null (deep cursor page).",
    );
  }

  const opinions = (b.results as unknown[]).map(mapOpinion);
  const returned = opinions.length;

  // ── [P1] totalAvailable is the API's REAL count, NEVER results.length. count:null
  //    (deep cursor page) ⇒ totalAvailable:null + a disclosure note. ★CURSOR
  //    pagination: hasMore from `next` presence; nextCursor EXTRACTED from the `next`
  //    URL (host re-asserted). ──
  const totalAvailable = countIsNumber ? (rawCount as number) : null;
  const nextCursor = extractNextCursor(b.next, label);
  const hasMore = nextCursor !== null;

  const notes: string[] = [PROVENANCE_NOTE, COUNT_TOTAL_NOTE];
  if (!countIsNumber) notes.push(DEEP_PAGE_NO_COUNT_NOTE);
  if (natureOfSuitApplied) notes.push(NATURE_OF_SUIT_QUERY_NOTE);
  notes.push(KEYLESS_NOTE);
  notes.push(
    `CourtListener token: ${courtlistenerTokenPresent() ? "present (Authorization: Token … sent; value never logged)" : "absent (keyless; a free COURTLISTENER_API_TOKEN lifts the rate limit)"}.`,
  );

  return withMeta(
    { opinions },
    {
      source: `${COURTLISTENER_HOST} /api/rest/v4/search (CourtListener (Free Law Project) — US federal court records; PACER (.gov) is paywalled; keyless)`,
      keylessMode: true, // ★KEYLESS — the optional token only raises the rate limit
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      // Cursor page: offset/nextOffset null (no numeric offset); continuation is
      // nextCursor (the opaque token extracted from `next`, passed back as `cursor`).
      pagination: { offset: null, limit: returned, hasMore, nextOffset: null },
      nextCursor,
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

/**
 * Single bare GET to read a CourtListener 400's DRF error body (error path ONLY).
 * Returns a compact human-readable message, or null on any failure. Sends the SAME
 * headers (so a keyed re-read honors the token) + redirect:"error"; the token stays
 * header-only.
 */
async function readCourtlistenerErrorMessage(
  url: string,
  headers: Record<string, string>,
): Promise<string | null> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers,
      redirect: "error",
    });
    const body = (await r.json()) as unknown;
    return summarizeDrfError(body);
  } catch {
    return null;
  }
}

/**
 * Summarize a Django-REST-Framework 400 error body into a compact string. DRF emits
 * `{ detail: "…" }` OR `{ field: ["message", …], … }`. Returns null for a shape we
 * can't read (⇒ the caller falls back to the generic 400 message).
 */
function summarizeDrfError(body: unknown): string | null {
  if (typeof body === "string") return str(body);
  if (body === null || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  if (typeof obj.detail === "string") return str(obj.detail);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const msg = Array.isArray(v)
      ? v.map((x) => str(x)).filter((x): x is string => x !== null).join("; ")
      : str(v);
    if (msg) parts.push(`${k}: ${msg}`);
  }
  return parts.length > 0 ? parts.join(" | ") : null;
}
