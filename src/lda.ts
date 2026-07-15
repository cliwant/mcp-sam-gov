/**
 * lda.ts — US Senate LDA (Lobbying Disclosure Act) filings — the LOBBYING / B2G
 * influence lane (ADR-0052). Who is paid HOW MUCH to lobby WHICH federal agency
 * on WHICH issue — the registrant→client→government-entity signal that no
 * contract/spending/grant source carries.
 *
 * ★ THIS IS A KEYLESS SOURCE WITH AN OPTIONAL KEY (the socrata.ts app-token
 *   lineage, NOT the census/fred/bea key-required lineage). The LDA REST API
 *   (lda.senate.gov/api/v1) serves anonymous GETs at HTTP 200 — it works with NO
 *   key. A free `LDA_API_KEY` only RAISES the shared rate limit; when set it rides
 *   ONLY as the `Authorization: Token <value>` request header (never the
 *   URL/label/_meta/notes/log — the K-test). When unset, NO auth header is sent
 *   (genuine keyless). This mirrors socrata's optional `X-App-Token` discipline.
 *
 * The module writes ZERO fetch/coercion/error/meta code of its own: it REUSES
 * `getJson` (the shared fetch envelope, redirect:"error") / `driftError` /
 * `num`·`str` (coerce.ts, null-never-0/empty) / `withMeta`·`buildMeta`.
 *
 *   GET https://lda.senate.gov/api/v1/filings/
 *       ?filing_year=&filing_type=&registrant_name=&client_name=&lobbyist_name=
 *        &filing_specific_lobbying_issues=&government_entity=&page=&page_size=
 *   → { count, next, previous, results:[{ filing_uuid, filing_type,
 *        filing_type_display, filing_year, filing_period, filing_period_display,
 *        filing_document_url, income, expenses, dt_posted, termination_date,
 *        registrant:{name,…}|string, client:{name,…}|string,
 *        lobbying_activities:[{ general_issue_code, general_issue_code_display,
 *          description, government_entities:[{ name }] }], … }] }
 *
 * ★ HONESTY (ADR-0052 P1–P5):
 *   [P1]   `count` is the API's REAL total (~1.95M) ⇒ totalAvailable = num(count),
 *          NEVER results.length. Page-based pagination (page/page_size, 1-based):
 *          returned = results.length, hasMore = page*pageSize < count, and the next
 *          page number is surfaced in a note. Reverting totalAvailable to
 *          results.length must go RED.
 *   [P2]   getJson → fetchWithRetry taxonomy: a 400 (bad filter/param) ⇒
 *          invalid_input SURFACING the API's error body (re-read once on the error
 *          path); a 5xx/timeout ⇒ upstream_unavailable THROW; a 429 ⇒ rate_limited
 *          THROW honoring Retry-After (NEVER routed around); a genuine no-match
 *          (results:[]) ⇒ honest empty (returned:0); a 200 non-JSON ⇒ schema_drift.
 *   [P3]   `income`/`expenses` are null-or-decimal-string ⇒ num() (null ⇒ null — NOT
 *          reported ≠ 0; a genuine "0" stays 0). A missing `lobbying_activities` /
 *          `government_entities` ⇒ empty arrays (never fabricated).
 *   [P4]   `results` non-array or `count` non-number ⇒ driftError (never a
 *          fabricated empty/total).
 *   [SSRF] fixed host `lda.senate.gov`; a post-construction hostname/protocol
 *          assert + `redirect:"error"`; every filter VALUE rides URLSearchParams;
 *          `filingYear` / `page` / `pageSize` are charclass/range-guarded pre-fetch.
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so a `num` regression fails together across sources.
export { num };

// ─── SSRF core: the single fixed host + base path ─────────────────
export const LDA_HOST = "lda.senate.gov";
const LDA_FILINGS_PATH = "/api/v1/filings/";
// HOST+path label — surfaces in ToolError.upstreamEndpoint; the optional key rides
// ONLY in the Authorization header, so no token can ever appear here.
const LDA_FILINGS_LABEL = "lda:/api/v1/filings";

// ─── Validation (SSRF + "verify the input" honesty) ───────────────
const YEAR_RE = /^\d{4}$/; // a single 4-digit filing year
const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 25; // the LDA API caps page_size at 25

// ─── Honesty notes (ADR-0052 required set) ────────────────────────
const KEYLESS_NOTE =
  "Keyless by default (anonymous LDA API access returns HTTP 200). An optional free LDA_API_KEY only RAISES the rate limit; when set it is sent ONLY as the `Authorization: Token …` request header and is NEVER logged, echoed, or placed in this response.";
const AMOUNT_NOTE =
  "incomeUsd / expensesUsd are parsed from the API's null-or-decimal-string income / expenses. A null (not reported) maps to null — NEVER 0; a genuine reported 0 is preserved as 0. A filing reports EITHER income (lobbying firms) OR expenses (in-house filers), so the other is typically null.";
const COUNT_TOTAL_NOTE =
  "totalAvailable is the LDA API's real total match count for the query (the whole corpus is ~1.95M filings) — NOT the number of rows on this page. Pagination is page-based (page / pageSize, 1-based); pass the next page number for more.";

// ─── The optional-key seam (value NEVER leaked past the Authorization header) ──
/**
 * The optional Authorization header (keyless-first, socrata app-token lineage).
 * Present ONLY when LDA_API_KEY is set (non-blank); the value is NEVER logged /
 * never placed in the URL, label, `_meta`, or a note. When unset, `{}` (no header).
 */
export function ldaAuthHeader(): Record<string, string> {
  const raw = process.env.LDA_API_KEY;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? { Authorization: `Token ${trimmed}` } : {};
}

/** true iff an LDA API key is configured (for the `_meta` note — never the value). */
export function ldaKeyPresent(): boolean {
  const raw = process.env.LDA_API_KEY;
  return typeof raw === "string" && raw.trim().length > 0;
}

// ─── Curated filing shape ─────────────────────────────────────────
export type LdaLobbyingActivity = {
  issueCode: string | null; // general_issue_code (the short code, e.g. "TAX")
  description: string | null; // description (the free-text issue narrative)
  governmentEntities: string[]; // government_entities[].name — the B2G targets
};

export type LdaFiling = {
  filingUuid: string | null;
  filingType: string | null; // filing_type (the short code, e.g. "Q1")
  filingYear: number | null; // filing_year
  filingPeriod: string | null; // filing_period_display ?? filing_period
  incomeUsd: number | null; // income (null-or-decimal-string) — null ≠ 0
  expensesUsd: number | null; // expenses (null-or-decimal-string) — null ≠ 0
  registrant: string | null; // registrant name (object-with-name OR string)
  client: string | null; // client name (object-with-name OR string)
  lobbyingActivities: LdaLobbyingActivity[];
  documentUrl: string | null; // filing_document_url
  postedDate: string | null; // dt_posted
  terminationDate: string | null; // termination_date
};

/**
 * The registrant/client value may be an OBJECT carrying `name` (with address
 * fields) OR a plain string. Defensively resolve either to the display name (or
 * null when absent) — never fabricate, never surface the whole address object.
 */
export function nameOf(x: unknown): string | null {
  if (x === null || x === undefined) return null;
  if (typeof x === "string") return str(x);
  if (typeof x === "object") return str((x as Record<string, unknown>).name);
  return null;
}

/** Map ONE lobbying_activities row → the curated shape (missing arrays ⇒ []). */
function mapActivity(raw: unknown): LdaLobbyingActivity {
  const a = (raw ?? {}) as Record<string, unknown>;
  const entities = Array.isArray(a.government_entities)
    ? (a.government_entities as unknown[])
        .map((e) => str((e as Record<string, unknown> | null)?.name))
        .filter((n): n is string => n !== null)
    : [];
  return {
    issueCode: str(a.general_issue_code),
    description: str(a.description),
    governmentEntities: entities,
  };
}

/** Map ONE `results[]` filing row → the curated LdaFiling shape. */
function mapFiling(raw: unknown): LdaFiling {
  const f = (raw ?? {}) as Record<string, unknown>;
  return {
    filingUuid: str(f.filing_uuid),
    filingType: str(f.filing_type),
    filingYear: num(f.filing_year),
    filingPeriod: str(f.filing_period_display) ?? str(f.filing_period),
    // [P3] null (not reported) ⇒ null, NEVER 0; a genuine "0" ⇒ 0.
    incomeUsd: num(f.income),
    expensesUsd: num(f.expenses),
    registrant: nameOf(f.registrant),
    client: nameOf(f.client),
    lobbyingActivities: Array.isArray(f.lobbying_activities)
      ? (f.lobbying_activities as unknown[]).map(mapActivity)
      : [],
    documentUrl: str(f.filing_document_url),
    postedDate: str(f.dt_posted),
    terminationDate: str(f.termination_date),
  };
}

// ─── Tool: lda_search_filings ─────────────────────────────────────
export type LdaSearchFilingsArgs = {
  registrantName?: string;
  clientName?: string;
  lobbyistName?: string;
  filingYear?: string; // ^\d{4}$
  filingType?: string; // a short code (e.g. "Q1", "RR")
  agency?: string; // → government_entity (the federal entity lobbied)
  issue?: string; // → filing_specific_lobbying_issues
  page?: number; // 1-based, default 1
  pageSize?: number; // 1..25, default 25
};

/**
 * Search US Senate LDA lobbying filings (`/api/v1/filings/`) → curated filing rows
 * + honest `_meta`. KEYLESS (an optional LDA_API_KEY only raises the rate limit,
 * sent as the Authorization header only). ★totalAvailable is the API's REAL `count`
 * (~1.95M corpus) — never results.length; page-based pagination. income/expenses
 * null-or-decimal-string → null-never-0.
 */
export async function searchFilings(
  args: LdaSearchFilingsArgs,
): Promise<MetaBundle> {
  // ── Validate + default (belt-and-suspenders behind the server Zod; a DIRECT
  //    handler call bypasses Zod). filingYear / page / pageSize are charclass/
  //    range-guarded; the free-text filters ride URLSearchParams (encoded). ──
  if (args.filingYear !== undefined && !YEAR_RE.test(args.filingYear)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid filingYear ${JSON.stringify(args.filingYear)} — expected a 4-digit year (^\\d{4}$), e.g. "2024".`,
      upstreamEndpoint: LDA_FILINGS_LABEL,
    });
  }
  const page = clampPage(args.page);
  const pageSize = clampPageSize(args.pageSize);

  // ── Build the query from VALIDATED typed args, key-by-key (SSRF: no raw
  //    passthrough; every VALUE is URLSearchParams-encoded). ──
  const params = new URLSearchParams();
  const filtersApplied: string[] = [];
  const setFilter = (key: string, val: string | undefined, label: string) => {
    if (val !== undefined && val !== "") {
      params.set(key, val);
      filtersApplied.push(label);
    }
  };
  setFilter("registrant_name", args.registrantName, "registrantName");
  setFilter("client_name", args.clientName, "clientName");
  setFilter("lobbyist_name", args.lobbyistName, "lobbyistName");
  setFilter("filing_year", args.filingYear, "filingYear");
  setFilter("filing_type", args.filingType, "filingType");
  setFilter("government_entity", args.agency, "agency");
  setFilter("filing_specific_lobbying_issues", args.issue, "issue");
  params.set("page", String(page));
  params.set("page_size", String(pageSize));

  const url = `https://${LDA_HOST}${LDA_FILINGS_PATH}?${params.toString()}`;
  // Belt-and-suspenders: the fixed host + strictly-built query leave nothing to
  // steer the authority; assert the built URL cannot have been moved off-host.
  const built = new URL(url);
  if (built.hostname !== LDA_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Constructed LDA URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${LDA_HOST} over https — refusing to fetch (SSRF safety).`,
      upstreamEndpoint: LDA_FILINGS_LABEL,
    });
  }

  // ── Fetch through the shared envelope. The optional key rides the Authorization
  //    header ONLY (never the URL/label/_meta); redirect:"error" fails closed on
  //    any off-host 3xx. A 429 ⇒ rate_limited THROW (Retry-After honored by the
  //    shared taxonomy, never routed around); a 5xx/timeout ⇒ upstream_unavailable
  //    THROW; a 400 ⇒ invalid_input (re-read below to surface the API message); a
  //    200 non-JSON ⇒ getJson's r.json() throws a SyntaxError ⇒ schema_drift. ──
  const headers = ldaAuthHeader();
  let body: unknown;
  try {
    body = await getJson<unknown>(url, {
      label: LDA_FILINGS_LABEL,
      headers,
      redirect: "error",
    });
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw driftError(
        LDA_FILINGS_LABEL,
        "LDA /api/v1/filings returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).",
      );
    }
    // [P2] A 400 (bad filter/param) carries a DRF error body; fetchWithRetry
    // discarded it. Re-read once on the error path ONLY so the caller learns the
    // REAL reason (never a fake-empty). 5xx/429/404/timeout keep their taxonomy.
    if (e instanceof ToolErrorCarrier && e.toolError.upstreamStatus === 400) {
      const apiMsg = await readLdaErrorMessage(url, headers);
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        retryable: false,
        message: apiMsg
          ? `LDA rejected the request (HTTP 400): ${apiMsg}. Check the filter parameters (filingYear, filingType, agency, issue, …).`
          : "LDA rejected the request (HTTP 400) — check the filter parameters (filingYear, filingType, agency, issue, …).",
        upstreamStatus: 400,
        upstreamEndpoint: LDA_FILINGS_LABEL,
      });
    }
    throw e; // 5xx → upstream_unavailable, 404 → not_found, 429 → rate_limited …
  }

  // ── [P4] `results` MUST be an array and `count` MUST be a number (a missing/
  //    wrong-typed either is drift, never a fabricated empty/total). ──
  const b = (body ?? {}) as { results?: unknown; count?: unknown };
  if (!Array.isArray(b.results)) {
    throw driftError(
      LDA_FILINGS_LABEL,
      "LDA /api/v1/filings shape drift — `results` must be an array.",
    );
  }
  if (typeof b.count !== "number" || !Number.isFinite(b.count)) {
    throw driftError(
      LDA_FILINGS_LABEL,
      "LDA /api/v1/filings shape drift — `count` (the total match count) must be a number.",
    );
  }

  const filings = (b.results as unknown[]).map(mapFiling);
  const returned = filings.length;

  // ── [P1] totalAvailable is the API's REAL count (~1.95M), NEVER results.length.
  //    Page-based: hasMore = page*pageSize < count; the next page is surfaced. ──
  const totalAvailable = b.count;
  const offset = (page - 1) * pageSize;
  const hasMore = page * pageSize < totalAvailable;
  const nextOffset = hasMore ? page * pageSize : null;

  const notes: string[] = [COUNT_TOTAL_NOTE, AMOUNT_NOTE, KEYLESS_NOTE];
  notes.push(
    `LDA API key: ${ldaKeyPresent() ? "present (Authorization: Token … sent; value never logged)" : "absent (keyless; a free LDA_API_KEY lifts the rate limit)"}.`,
  );
  if (hasMore) {
    notes.push(
      `This is page ${page} (pageSize ${pageSize}) of ~${Math.ceil(totalAvailable / pageSize)} — pass page=${page + 1} for the next page.`,
    );
  }

  return withMeta(
    { filings },
    {
      source: `${LDA_HOST} /api/v1/filings (US Senate LDA lobbying; keyless)`,
      keylessMode: true, // ★KEYLESS — the optional key only raises the rate limit
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

/**
 * Single bare GET to read an LDA 400's DRF error body (error path ONLY). Returns a
 * compact human-readable message, or null on any failure. Sends the SAME headers
 * (so a keyed re-read honors the key) + redirect:"error"; the key stays header-only.
 */
async function readLdaErrorMessage(
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
 * Summarize a Django-REST-Framework 400 error body into a compact string. DRF
 * emits `{ detail: "…" }` OR `{ field: ["message", …], … }`. Returns null for a
 * shape we can't read (⇒ the caller falls back to the generic 400 message).
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

// ─── Small clamps (defensive, behind the server Zod bounds) ────────
function clampPage(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_PAGE;
  const n = Math.floor(v);
  return n < 1 ? 1 : n;
}

function clampPageSize(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_PAGE_SIZE;
  const n = Math.floor(v);
  if (n < 1) return 1;
  if (n > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return n;
}
