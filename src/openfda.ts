/**
 * openfda.ts — openFDA recall/enforcement records (api.fda.gov) — the
 * PRODUCT-SAFETY / RECALL lane (ADR-0054). Drug / device / food recall
 * enforcement reports: the recalling firm, the product, the reason, the FDA
 * classification (Class I/II/III), status, and geography.
 *
 * ★ THIS IS A KEYLESS TOOL WITH AN *OPTIONAL* RATE-LIMIT KEY. openFDA works
 *   keyless (~1000 requests/day); a free OPENFDA_API_KEY only RAISES the rate
 *   limit. So — unlike Census/FRED/BEA/DOL (key-REQUIRED, throw without it) —
 *   this tool NEVER throws for a missing key. When OPENFDA_API_KEY IS set it
 *   rides ONLY the `&api_key=` query param (openFDA has NO header option — query
 *   only). See the K-test discipline below.
 *
 *   GET https://api.fda.gov/{category}/enforcement.json
 *       ?search=<lucene>&limit=<1..100>&skip=<offset>[&api_key=<KEY>]
 *     category ∈ {drug, device, food}
 *   → { meta: { disclaimer, results: { skip, limit, total } }, results: [ {...} ] }
 *
 * This module COPIES (does NOT import) the census-economic.ts bespoke-fetch idiom
 * (a single classified `fetch` rather than the shared getJson) — the reason is
 * the ★P2 CRUX below: a no-match query returns HTTP 404, and getJson→
 * fetchWithRetry throws a `not_found` ToolErrorCarrier that DISCARDS the body, so
 * we could not distinguish a genuine no-match (→ honest empty) from a real 404.
 * A bespoke fetch returns the Response so we can READ the 404 body and reclassify
 * `{error:{code:"NOT_FOUND"}}` → an honest empty. Coercion/meta code is REUSED
 * (`str` coerce.ts null-never-empty-string, `driftError`, `errorFromResponse`,
 * `withMeta`/`buildMeta` with skip/limit offset pagination). NO local str/num.
 *
 * ★ HONESTY (ADR-0054 P1–P5):
 *   [P1]  totalAvailable = `meta.results.total` EXACT (the REAL total, e.g. drug
 *         17793), NEVER results.length. skip/limit offset pagination:
 *         hasMore = skip + returned < total; nextOffset = hasMore ? skip+returned : null.
 *   [★P2] a 404 whose body is `{error:{code:"NOT_FOUND"}}` (a no-match query OR an
 *         unknown field) ⇒ HONEST EMPTY (returned:0, totalAvailable:0) — NOT thrown,
 *         NOT not_found. Any OTHER 4xx (e.g. a 400 syntax error) ⇒ invalid_input
 *         surfacing openFDA's error message. 5xx/timeout ⇒ upstream_unavailable
 *         THROW. A 200 non-JSON body ⇒ schema_drift. (Reverting the
 *         404-NOT_FOUND-as-empty handling ⇒ RED.)
 *   [P3]  dates (`recall_initiation_date`, YYYYMMDD) and every scalar surfaced as a
 *         STRING via `str` (null-never-empty-string) — no numeric coercion; never
 *         fabricated.
 *   [P4]  `meta.results` or `results` absent / non-array ⇒ driftError (never a
 *         fabricated empty).
 *   [K-test] OPTIONAL key: when OPENFDA_API_KEY is set it rides `&api_key=` ONLY,
 *         so the key WILL appear in the raw fetch URL (an unavoidable openFDA
 *         constraint — no header option). Mitigation: the `label` is host+path
 *         ONLY (`openfda:/{category}/enforcement`, NO query), so no token can reach
 *         ToolError.upstreamEndpoint; `_meta.source` names the MODE only; the key is
 *         ABSENT from the serialized {data,_meta}, notes, and any log. Unset ⇒
 *         keyless (no api_key param at all).
 *   [SSRF] fixed host `api.fda.gov`; `category` is an ENUM (→ the path segment);
 *         all filter VALUES are Lucene-escaped + phrase-quoted and ride
 *         URLSearchParams `search=`; limit/skip are integers; state is charclass
 *         `^[A-Za-z]{2}$`. A post-construction hostname/protocol assertion +
 *         `redirect:"error"` lock it (no raw Lucene passthrough — structured only,
 *         injection-safe).
 */

import { ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { driftError, isRedirectError } from "./datasource.js";
import { str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// ─── SSRF core: the single fixed host ─────────────────────────────
export const OPENFDA_HOST = "api.fda.gov";
// The recall/enforcement categories (→ the FIRST path segment). An ENUM, so no
// free value ever touches the path.
export const OPENFDA_CATEGORIES = ["drug", "device", "food"] as const;
export type OpenfdaCategory = (typeof OPENFDA_CATEGORIES)[number];
const OPENFDA_CATEGORY_SET: ReadonlySet<string> = new Set(OPENFDA_CATEGORIES);

// The FDA recall classification enum (surfaced verbatim; a structured filter value).
export const OPENFDA_CLASSIFICATIONS = ["Class I", "Class II", "Class III"] as const;
const OPENFDA_CLASSIFICATION_SET: ReadonlySet<string> = new Set(
  OPENFDA_CLASSIFICATIONS,
);

// state filter charclass (a 2-letter US state/territory postal code).
const STATE_RE = /^[A-Za-z]{2}$/;

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** host+path-only label (→ ToolError.upstreamEndpoint); NEVER carries the key. */
function labelFor(category: string): string {
  return `openfda:/${category}/enforcement`;
}

// ─── Honesty notes (ADR-0054 required set) ────────────────────────
const NOT_DETERMINATION_NOTE =
  "openFDA recall/enforcement records are FDA-published recall reports; treat classification/status/dates as of the source's last publication. This is reference data, not a live regulatory determination.";
const KEYLESS_NOTE =
  "Keyless: no OPENFDA_API_KEY is set. openFDA allows ~1000 requests/day without a key; a free key raises the rate limit (get one at https://open.fda.gov/apis/authentication/).";
const KEYED_NOTE =
  "OPENFDA_API_KEY is set — it rides ONLY the &api_key= query parameter to api.fda.gov (openFDA has no header option), raising the rate limit. Its value is NEVER logged, echoed, or placed in this response.";
const NO_FILTER_NOTE =
  "No structured filters were applied — this is an unscoped scan of the WHOLE recall/enforcement category. Add firm / product / reason / classification / status / state to scope the result set.";
// dogfooding 2026-07-16: `category` defaults to 'drug'. A DEVICE- or FOOD-intent
// caller who omits it silently searches the DRUG dataset (a separate openFDA index
// with its own, much smaller total — e.g. "pacemaker" returns 1 drug recall vs 197
// device recalls). The default is convenient but load-bearing, so when it is TAKEN
// (not explicitly chosen) we say so and point to the alternatives. `category` is
// also echoed in filtersApplied so the drug/device/food choice is never invisible.
const CATEGORY_DEFAULT_NOTE =
  "category was NOT specified and DEFAULTED to 'drug' — this searched the DRUG recall dataset (/drug/enforcement) ONLY. For medical DEVICES pass category:'device'; for FOOD pass category:'food'. Each category is a SEPARATE openFDA dataset with its own total, so a device/food-intent query left on the default MISSES all of those recalls.";

// ─── The OPTIONAL key seam (value NEVER leaked past the &api_key= param) ──
/** Read OPENFDA_API_KEY from env; trim; return the value or undefined (unset/blank). */
export function openfdaApiKey(): string | undefined {
  const raw = process.env.OPENFDA_API_KEY;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : undefined;
}

// ─── Curated recall row shape ─────────────────────────────────────
export type OpenfdaRecall = {
  recallingFirm: string | null;
  productDescription: string | null;
  reasonForRecall: string | null;
  classification: string | null; // "Class I" / "Class II" / "Class III"
  status: string | null; // Ongoing / Terminated / Completed …
  state: string | null;
  city: string | null;
  recallInitiationDate: string | null; // YYYYMMDD — preserved as a STRING (P3)
  recallNumber: string | null;
  voluntaryMandated: string | null;
  distributionPattern: string | null;
};

/** Map ONE openFDA enforcement result row → the curated shape. Every scalar via `str`. */
function mapRecall(row: unknown): OpenfdaRecall {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    recallingFirm: str(r.recalling_firm),
    productDescription: str(r.product_description),
    reasonForRecall: str(r.reason_for_recall),
    classification: str(r.classification),
    status: str(r.status),
    state: str(r.state),
    city: str(r.city),
    recallInitiationDate: str(r.recall_initiation_date),
    recallNumber: str(r.recall_number),
    voluntaryMandated: str(r.voluntary_mandated),
    distributionPattern: str(r.distribution_pattern),
  };
}

// ─── Lucene search assembly (structured-only; injection-safe) ─────
/**
 * Quote a filter value as a Lucene phrase term. Wrapping in double quotes makes a
 * multi-word value (e.g. "Class I", "johnson & johnson") match as a phrase and
 * closes every operator-injection surface; within the quoted term only `"` and
 * `\` are special, so we backslash-escape BOTH (a `"` in the value can never break
 * out of the quotes). There is NO raw Lucene passthrough — the tool assembles the
 * whole `search=` string from validated typed args.
 */
export function luceneQuote(v: string): string {
  return '"' + v.replace(/(["\\])/g, "\\$1") + '"';
}

/** The structured filter set → openFDA `field:value` clauses. */
export type OpenfdaFilters = {
  firm?: string; // → recalling_firm
  product?: string; // → product_description
  reason?: string; // → reason_for_recall
  classification?: string; // → classification (Class I/II/III)
  status?: string; // → status
  state?: string; // → state (2-letter)
};

/**
 * Assemble the openFDA `search=` Lucene string from structured filters — each
 * value Lucene-escaped + phrase-quoted, joined by ` AND `. Returns "" when no
 * filter is present (openFDA then returns the whole category). The mapping of
 * clause → field is FIXED here; a caller can never inject a raw field:value.
 */
export function buildSearch(f: OpenfdaFilters): string {
  const clauses: string[] = [];
  if (f.firm !== undefined) clauses.push(`recalling_firm:${luceneQuote(f.firm)}`);
  if (f.product !== undefined)
    clauses.push(`product_description:${luceneQuote(f.product)}`);
  if (f.reason !== undefined)
    clauses.push(`reason_for_recall:${luceneQuote(f.reason)}`);
  if (f.classification !== undefined)
    clauses.push(`classification:${luceneQuote(f.classification)}`);
  if (f.status !== undefined) clauses.push(`status:${luceneQuote(f.status)}`);
  if (f.state !== undefined)
    clauses.push(`state:${luceneQuote(f.state.toUpperCase())}`);
  return clauses.join(" AND ");
}

// ─── Bespoke SSRF-guarded fetch (fixed host + assert + redirect:"error") ──
/**
 * A SINGLE classified `fetch` to api.fda.gov (NOT the shared getJson — we must
 * READ a 404 body to distinguish a NOT_FOUND no-match from a real outage; see the
 * ★P2 crux in the caller). Builds the URL on the FIXED host from `params`, asserts
 * the constructed URL cannot have been steered off-host (belt-and-suspenders), and
 * sets `redirect:"error"` (fail closed on any off-host 3xx — a redirect could
 * carry the api_key away). Returns the raw Response for the caller to classify. A
 * timeout/abort ⇒ non-retryable upstream_unavailable; a network TypeError ⇒
 * retryable upstream_unavailable; a redirect TypeError ⇒ schema_drift (never a
 * fake-empty). `label` is host+path only.
 */
export async function fetchOpenfda(url: string, label: string): Promise<Response> {
  const built = new URL(url);
  if (built.hostname !== OPENFDA_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Constructed openFDA URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${OPENFDA_HOST} over https — refusing to fetch (SSRF safety).`,
      upstreamEndpoint: label,
    });
  }
  try {
    return await fetch(built.toString(), {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (isRedirectError(e)) {
      throw driftError(
        label,
        `openFDA returned an off-host redirect (redirect:"error") while fetching ${label} — refusing to follow it (SSRF safety).`,
      );
    }
    if (
      e instanceof Error &&
      (e.name === "TimeoutError" || e.name === "AbortError")
    ) {
      throw new ToolErrorCarrier({
        kind: "upstream_unavailable",
        message: `Request to ${label} timed out.`,
        retryable: false,
        upstreamEndpoint: label,
      });
    }
    throw new ToolErrorCarrier({
      kind: "upstream_unavailable",
      message: `Network error reaching ${label}: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
      retryAfterSeconds: 30,
      upstreamEndpoint: label,
    });
  }
}

/** Best-effort read of an openFDA error body `{error:{code,message}}`. null on any failure. */
export async function readOpenfdaError(
  res: Response,
): Promise<{ code: string | null; message: string | null }> {
  try {
    const body = (await res.json()) as {
      error?: { code?: unknown; message?: unknown };
    };
    return {
      code: str(body?.error?.code),
      message: str(body?.error?.message),
    };
  } catch {
    return { code: null, message: null };
  }
}

// ─── Tool: openfda_enforcement ────────────────────────────────────
export type OpenfdaEnforcementArgs = OpenfdaFilters & {
  category?: string; // drug | device | food (default drug)
  limit?: number; // 1..100 (default 25)
  skip?: number; // offset ≥ 0 (default 0)
};

/**
 * Search openFDA recall/enforcement records for a category (drug/device/food) with
 * structured filters → curated recall rows + honest `_meta`. KEYLESS (an OPTIONAL
 * OPENFDA_API_KEY only raises the rate limit). totalAvailable = meta.results.total
 * (EXACT); skip/limit offset pagination. ★A no-match query (openFDA HTTP 404
 * NOT_FOUND) ⇒ an honest empty, never a throw.
 */
export async function enforcement(
  args: OpenfdaEnforcementArgs,
): Promise<MetaBundle> {
  // ── Validate + default the inputs (belt-and-suspenders behind the server Zod;
  //    a DIRECT handler call bypasses Zod). ──
  const category = args.category ?? "drug";
  const label = labelFor(category);
  if (!OPENFDA_CATEGORY_SET.has(category)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid category ${JSON.stringify(category)} — expected one of ${OPENFDA_CATEGORIES.join(", ")} (it rides in the request PATH; strictly validated).`,
      upstreamEndpoint: label,
    });
  }
  if (
    args.classification !== undefined &&
    !OPENFDA_CLASSIFICATION_SET.has(args.classification)
  ) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid classification ${JSON.stringify(args.classification)} — expected one of ${OPENFDA_CLASSIFICATIONS.join(", ")}.`,
      upstreamEndpoint: label,
    });
  }
  if (args.state !== undefined && !STATE_RE.test(args.state)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid state ${JSON.stringify(args.state)} — expected a 2-letter US state/territory postal code (^[A-Za-z]{2}$), e.g. "CA".`,
      upstreamEndpoint: label,
    });
  }
  const limit = clampLimit(args.limit);
  const skip = clampSkip(args.skip);

  // ── Assemble the query (structured-only; all VALUES via URLSearchParams — no
  //    host/path steer). The OPTIONAL key rides ONLY here in &api_key=. ──
  const filters: OpenfdaFilters = {
    firm: args.firm,
    product: args.product,
    reason: args.reason,
    classification: args.classification,
    status: args.status,
    state: args.state,
  };
  const search = buildSearch(filters);
  const filtersApplied: string[] = [];
  if (args.firm !== undefined) filtersApplied.push("firm");
  if (args.product !== undefined) filtersApplied.push("product");
  if (args.reason !== undefined) filtersApplied.push("reason");
  if (args.classification !== undefined) filtersApplied.push("classification");
  if (args.status !== undefined) filtersApplied.push("status");
  if (args.state !== undefined) filtersApplied.push("state");
  // NO_FILTER_NOTE gates on the STRUCTURED filters only — capture that BEFORE the
  // always-present category selector is appended below.
  const hasStructuredFilter = filtersApplied.length > 0;
  // The category (drug|device|food) is the ENDPOINT selector — always applied and
  // consequential — so echo it in filtersApplied to make the choice VISIBLE (a
  // device query left on the drug default must not look identical to a device query).
  const categoryDefaulted = args.category === undefined;
  filtersApplied.push(`category:${category}`);

  const params = new URLSearchParams();
  if (search !== "") params.set("search", search);
  params.set("limit", String(limit));
  params.set("skip", String(skip));
  const key = openfdaApiKey();
  if (key !== undefined) params.set("api_key", key); // OPTIONAL — &api_key= ONLY

  const url = `https://${OPENFDA_HOST}/${category}/enforcement.json?${params.toString()}`;

  // ── Fetch + classify. ★P2 CRUX: a 404 whose body is {error:{code:"NOT_FOUND"}}
  //    is a genuine no-match (or an unknown field) ⇒ an HONEST EMPTY, never a
  //    thrown not_found. Any OTHER 4xx (e.g. 400 syntax) ⇒ invalid_input surfacing
  //    openFDA's message; a 5xx/429 ⇒ the shared taxonomy THROWS. ──
  const res = await fetchOpenfda(url, label);

  if (res.status === 404) {
    const { code, message } = await readOpenfdaError(res);
    if (code === "NOT_FOUND") {
      // Honest empty — NOT thrown, NOT not_found (the openFDA no-match idiom).
      return emptyResult(category, limit, skip, filtersApplied, key !== undefined, categoryDefaulted);
    }
    // A non-NOT_FOUND 404 ⇒ the shared not_found taxonomy (never a fake-empty).
    throw new ToolErrorCarrier({
      ...errorFromResponse(res, label),
      message: message
        ? `openFDA returned HTTP 404 at ${label}: ${message}`
        : `Resource not found at ${label} (HTTP 404).`,
    });
  }

  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    // A 4xx OTHER than 404/429 (e.g. 400 syntax) ⇒ invalid_input surfacing the
    // openFDA error message (a caller-fixable request, never a fake-empty).
    const { message } = await readOpenfdaError(res);
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: message
        ? `openFDA rejected the request (HTTP ${res.status}) at ${label}: ${message}`
        : `Bad request (HTTP ${res.status}) at ${label}.`,
      upstreamStatus: res.status,
      upstreamEndpoint: label,
    });
  }

  if (!res.ok) {
    // 429 → rate_limited; 5xx → upstream_unavailable (a DOWN service is NEVER an
    // empty result). Delegated to the shared errors.ts taxonomy.
    throw new ToolErrorCarrier(errorFromResponse(res, label));
  }

  // ── 200 ⇒ parse JSON; a non-JSON body ⇒ r.json() SyntaxError ⇒ schema_drift
  //    (never read as an empty result). ──
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw driftError(
        label,
        `openFDA ${label} returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).`,
      );
    }
    throw e;
  }

  // ── [P4] meta.results (the total carrier) and results (the rows) MUST be present
  //    + well-shaped; anything else is drift, never a fabricated empty. ──
  const b = (body ?? {}) as { meta?: unknown; results?: unknown };
  const meta = (b.meta ?? {}) as { results?: unknown };
  const metaResults = meta.results as { total?: unknown } | undefined;
  if (
    metaResults === undefined ||
    metaResults === null ||
    typeof metaResults !== "object"
  ) {
    throw driftError(
      label,
      `openFDA ${label} shape drift — meta.results (the skip/limit/total carrier) is missing.`,
    );
  }
  if (!Array.isArray(b.results)) {
    throw driftError(
      label,
      `openFDA ${label} shape drift — results must be an array.`,
    );
  }

  const recalls = (b.results as unknown[]).map(mapRecall);
  const returned = recalls.length;

  // ── [P1] totalAvailable = meta.results.total EXACT (the REAL total), NEVER
  //    results.length. skip/limit offset pagination. ──
  const rawTotal = metaResults.total;
  const totalAvailable =
    typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : null;
  const hasMore =
    totalAvailable !== null && skip + returned < totalAvailable;
  const nextOffset = hasMore ? skip + returned : null;

  const notes: string[] = [NOT_DETERMINATION_NOTE, keyNote(key !== undefined)];
  if (!hasStructuredFilter) notes.push(NO_FILTER_NOTE);
  if (categoryDefaulted) notes.push(CATEGORY_DEFAULT_NOTE);

  return withMeta(
    { recalls },
    {
      // MODE only — never the key value (K-test).
      source: `${OPENFDA_HOST} /${category}/enforcement (openFDA recall enforcement; ${
        key !== undefined ? "OPENFDA_API_KEY rate-limit key applied" : "keyless"
      })`,
      keylessMode: true, // a keyless tool; the optional key only raises the rate limit
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset: skip, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Small helpers ────────────────────────────────────────────────
function keyNote(hasKey: boolean): string {
  return hasKey ? KEYED_NOTE : KEYLESS_NOTE;
}

/** An honest empty result (★P2: a 404 NOT_FOUND no-match) — returned:0, total:0. */
function emptyResult(
  category: string,
  limit: number,
  skip: number,
  filtersApplied: string[],
  hasKey: boolean,
  categoryDefaulted: boolean,
): MetaBundle {
  const notes = [
    "No recall/enforcement records matched this query (openFDA returned HTTP 404 NOT_FOUND — the source's honest no-match). This is an exact empty, not an error.",
    NOT_DETERMINATION_NOTE,
    keyNote(hasKey),
  ];
  // A defaulted category on an EMPTY result is the most misleading case — a device
  // analyst reads "0 recalls" as "clean" when they actually searched the wrong
  // dataset. Surface the default + the alternatives.
  if (categoryDefaulted) notes.push(CATEGORY_DEFAULT_NOTE);
  return withMeta(
    { recalls: [] as OpenfdaRecall[] },
    {
      source: `${OPENFDA_HOST} /${category}/enforcement (openFDA recall enforcement; ${
        hasKey ? "OPENFDA_API_KEY rate-limit key applied" : "keyless"
      })`,
      keylessMode: true,
      returned: 0,
      totalAvailable: 0,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset: skip, limit, hasMore: false, nextOffset: null },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

function clampLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_LIMIT;
  const n = Math.floor(v);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function clampSkip(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  const n = Math.floor(v);
  return n < 0 ? 0 : n;
}
