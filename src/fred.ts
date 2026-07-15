/**
 * fred.ts — FRED (Federal Reserve Economic Data, St. Louis Fed) — the MACRO
 * CONTEXT lane (ADR-0048, Wave-4 source #2). GDP · CPI · interest rates ·
 * unemployment · PPI … — the economy-wide backdrop for B2G bid escalation and
 * market-timing that no contract/spending source carries.
 *
 * ★ THIS IS THE SERVER'S SECOND KEY-REQUIRED SOURCE (Census CBP was the first).
 *   FRED has NO keyless tier: every request needs `&api_key=`, and a missing/bad
 *   key returns HTTP 400 `{error_code, error_message}`. So, honestly: with NO
 *   `FRED_API_KEY` these two tools THROW an `invalid_input` config error BEFORE any
 *   fetch (never a fake-empty, never a keyless-pretend). The other tools stay
 *   keyless — this key is scoped to this one source. (Contrast the OPTIONAL keys of
 *   datagov/bls/nvd, which lift a tier but are not required.)
 *
 * This module MIRRORS the census-economic.ts optional-key precedent: a `fredApiKey()`
 * env seam, a pre-fetch `invalid_input` THROW when unset, the fixed-host SSRF assert
 * + `redirect:"error"`, and the missing-sentinel→null idiom (Census's negative
 * suppression sentinel there; FRED's `value === "."` here — the BLS `"-"` lineage).
 * It writes ZERO coercion/meta code of its own: it REUSES `getJson` (the shared
 * fetch envelope) / `driftError` / `num`·`str` (coerce.ts, null-never-0/empty) /
 * `withMeta`·`buildMeta` (offset pagination via count-exact totals).
 *
 *   GET https://api.stlouisfed.org/fred/series/search
 *       ?search_text=<q>&limit=&offset=&api_key=<KEY>&file_type=json
 *   → { seriess:[{ id,title,frequency,frequency_short,units,seasonal_adjustment,
 *        observation_start,observation_end,last_updated,popularity,notes }],
 *       count, limit, offset }
 *
 *   GET https://api.stlouisfed.org/fred/series/observations
 *       ?series_id=<id>&observation_start=&observation_end=&limit=&offset=
 *        &sort_order=&api_key=<KEY>&file_type=json
 *   → { observations:[{ date, value }], count, … }   ★value === "." ⇒ missing (null)
 *
 * ★ HONESTY (ADR-0048 P1–P5):
 *   [KEY]  no key ⇒ invalid_input THROW pre-fetch (0 fetch); the message names
 *          FRED_API_KEY + the free-signup URL. A 400 carrying `{error_message}` (a
 *          bad series_id / expired key) ⇒ reclassified to invalid_input CARRYING the
 *          FRED error_message — honestly reported, never a fake empty.
 *   [P1]   both endpoints report `count` (the total) ⇒ totalAvailable = num(count)
 *          EXACT; offset pagination (hasMore = offset+returned < count, nextOffset).
 *          NEVER fabricated (RED if totalAvailable = returned).
 *   [P3]   ★the missing crux: an observation `value === "."` ⇒ **null** (FRED's
 *          missing sentinel — the BLS `"-"` lineage), NEVER 0. A genuine "0" ⇒ 0.
 *   [P2]   a 400 ⇒ invalid_input (carrying error_message); a genuine no-match
 *          (seriess:[] / observations:[]) ⇒ honest empty; a 5xx ⇒ upstream_unavailable
 *          THROW; a 200 non-JSON ⇒ schema_drift.
 *   [P4]   a body whose `seriess` / `observations` is absent or non-array ⇒ driftError
 *          (never a fabricated empty).
 *   [SSRF] fixed host `api.stlouisfed.org`; `series_id` charclass `^[A-Za-z0-9._-]+$`;
 *          dates `^\d{4}-\d{2}-\d{2}$`; sort_order enum {asc,desc}. All VALUES ride
 *          URLSearchParams; the key rides `&api_key=` ONLY — never a label/_meta/note
 *          (the K-test).
 */

import { ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { getJson, driftError, isRedirectError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so a `num` regression fails together across sources. NO local
// num/str; the `"."`→null map is a WRAPPER around num, not a fork.
export { num };

// ─── SSRF core: the single fixed host + base path ─────────────────
export const FRED_HOST = "api.stlouisfed.org";
const FRED_SEARCH_PATH = "/fred/series/search";
const FRED_OBS_PATH = "/fred/series/observations";
// HOST+path labels — surface in ToolError.upstreamEndpoint; the key rides ONLY in
// the &api_key= query param, so no token can ever appear here.
const FRED_SEARCH_LABEL = "fred:/fred/series/search";
const FRED_OBS_LABEL = "fred:/fred/series/observations";

// ─── Validation charclasses (SSRF + "verify the input" honesty) ───
const SERIES_ID_RE = /^[A-Za-z0-9._-]+$/; // FRED series ids: GDP, CPIAUCSL, DGS10 …
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD observation bounds
const SORT_ORDERS = new Set(["asc", "desc"]);

const DEFAULT_SEARCH_LIMIT = 25;
const MAX_SEARCH_LIMIT = 1000;
const DEFAULT_OBS_LIMIT = 100;
const MAX_OBS_LIMIT = 100000;

// ─── Honesty notes (ADR-0048 required set) ────────────────────────
const KEY_REQUIRED_NOTE =
  "This source REQUIRES a free FRED_API_KEY (FRED has no keyless tier). The key is sent ONLY as the &api_key= query parameter to api.stlouisfed.org and is NEVER logged, echoed, or placed in this response.";
const MISSING_VALUE_NOTE =
  "FRED encodes a MISSING observation as the literal '.' — such values are mapped to null (missing), NEVER 0. A genuine reported 0 is preserved as 0.";
const COUNT_TOTAL_NOTE =
  "totalAvailable is FRED's exact reported `count` for the query; page with limit/offset (hasMore/nextOffset are derived from it, never fabricated).";

// ─── The key seam (REQUIRED; value NEVER leaked past the &api_key= param) ──
/** Read FRED_API_KEY from env; trim; return the value or undefined (unset/blank). */
export function fredApiKey(): string | undefined {
  const raw = process.env.FRED_API_KEY;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed ? trimmed : undefined;
}

/**
 * num(), but map FRED's missing-observation sentinel `"."` → null (missing). A
 * genuine "0" stays 0 (num("0") === 0); a real numeric string parses. This is the
 * BLS `"-"` lineage — a data-absence marker, never a fabricated 0.
 */
export function fredValue(v: unknown): number | null {
  if (v === ".") return null;
  return num(v);
}

// ─── Shared SSRF-guarded fetch (REQUIRED key; &api_key= ONLY carrier) ──
/**
 * GET one FRED JSON resource. The REQUIRED key is checked BEFORE any fetch (an
 * unset FRED_API_KEY ⇒ invalid_input THROW, 0 network call). The query is built on
 * the FIXED host from `params` + `&api_key=` + `&file_type=json` via URLSearchParams
 * (no host/path steer); a post-construction hostname/protocol assertion +
 * `redirect:"error"` lock it (fail closed on any off-host 3xx — it could carry the
 * key away). `label` is host+path only.
 *
 * A 400 carrying `{error_message}` (a bad series_id / expired key) is reclassified
 * to invalid_input CARRYING the FRED message. `getJson`/`fetchWithRetry` discards a
 * non-ok body (it throws before reading it), so to surface FRED's honest reason we
 * re-read the 400 body via a single bare GET on the error path ONLY (the happy /
 * 5xx / 429 / timeout paths keep the shared envelope's retry taxonomy untouched).
 */
async function getFred(
  path: string,
  label: string,
  params: URLSearchParams,
  key: string,
): Promise<unknown> {
  params.set("api_key", key);
  params.set("file_type", "json");
  const url = `https://${FRED_HOST}${path}?${params.toString()}`;
  const built = new URL(url);
  if (built.hostname !== FRED_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Constructed FRED URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${FRED_HOST} over https — refusing to fetch (SSRF safety).`,
      upstreamEndpoint: label,
    });
  }

  try {
    // The key rides in &api_key= ONLY (never the label/_meta); redirect:"error"
    // (fail closed on any off-host 3xx). A 200 non-JSON body ⇒ getJson's r.json()
    // throws SyntaxError ⇒ the caller reclassifies to schema_drift.
    return await getJson<unknown>(url, { label, redirect: "error" });
  } catch (e) {
    if (e instanceof ToolErrorCarrier) {
      // A 400 (missing/bad key, or a bad series_id) carries FRED's honest
      // `{error_message}`, but fetchWithRetry discarded the body. Re-read it once so
      // the caller learns the REAL reason (never a fake-empty). A body that no longer
      // 400s / is unreadable falls back to the generic 400 carrier unchanged.
      if (e.toolError.upstreamStatus === 400) {
        const fredMsg = await readFredErrorMessage(url);
        throw new ToolErrorCarrier({
          kind: "invalid_input",
          retryable: false,
          message: fredMsg
            ? `FRED rejected the request (HTTP 400): ${fredMsg}. Check FRED_API_KEY and the series_id / parameters.`
            : "FRED rejected the request (HTTP 400) — check FRED_API_KEY and the series_id / parameters.",
          upstreamStatus: 400,
          upstreamEndpoint: label,
        });
      }
      throw e; // 5xx → upstream_unavailable, 404 → not_found, 429 → rate_limited …
    }
    throw e; // SyntaxError (200 non-JSON) → the caller maps it to driftError
  }
}

/** Single bare GET to read a FRED 400's `error_message` (error path ONLY). null on any failure. */
async function readFredErrorMessage(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const body = (await r.json()) as { error_message?: unknown };
    return typeof body?.error_message === "string" ? body.error_message : null;
  } catch {
    return null;
  }
}

// ─── Tool: fred_search_series ─────────────────────────────────────
export type FredSearchSeriesArgs = {
  query?: string;
  limit?: number;
  offset?: number;
};

export type FredSeries = {
  id: string | null;
  title: string | null;
  frequency: string | null;
  frequencyShort: string | null;
  units: string | null;
  seasonalAdjustment: string | null;
  observationStart: string | null;
  observationEnd: string | null;
  lastUpdated: string | null;
  popularity: number | null;
};

/**
 * Search FRED series (`/fred/series/search`) by `search_text` → curated series
 * rows + honest `_meta`. REQUIRES FRED_API_KEY (throws invalid_input pre-fetch when
 * unset). totalAvailable = FRED's exact `count`; offset pagination.
 */
export async function searchSeries(
  args: FredSearchSeriesArgs,
): Promise<MetaBundle> {
  // ── [KEY] REQUIRED key — throw an honest config error BEFORE any fetch. ──
  const key = fredApiKey();
  if (key === undefined) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message:
        "FRED requires a free API key. Get one at https://fred.stlouisfed.org/docs/api/api_key.html and set FRED_API_KEY.",
      upstreamEndpoint: FRED_SEARCH_LABEL,
    });
  }

  // ── Validate + default (belt-and-suspenders behind the server Zod; a DIRECT
  //    handler call bypasses Zod). ──
  const query = args.query ?? "";
  if (query.trim() === "") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message:
        "fred_search_series requires a non-empty `query` (the FRED search_text), e.g. 'unemployment rate' or 'CPI'.",
      upstreamEndpoint: FRED_SEARCH_LABEL,
    });
  }
  const limit = clampLimit(args.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  const offset = clampOffset(args.offset);

  const params = new URLSearchParams();
  params.set("search_text", query);
  params.set("limit", String(limit));
  params.set("offset", String(offset));

  let body: unknown;
  try {
    body = await getFred(FRED_SEARCH_PATH, FRED_SEARCH_LABEL, params, key);
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw driftError(
        FRED_SEARCH_LABEL,
        "FRED /series/search returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).",
      );
    }
    throw e;
  }

  // ── [P4] `seriess` MUST be an array (a missing/non-array is drift, never a
  //    fabricated empty). ──
  const b = (body ?? {}) as { seriess?: unknown; count?: unknown };
  if (!Array.isArray(b.seriess)) {
    throw driftError(
      FRED_SEARCH_LABEL,
      "FRED /series/search shape drift — `seriess` must be an array.",
    );
  }

  const series: FredSeries[] = (b.seriess as unknown[]).map((row) => {
    const s = (row ?? {}) as Record<string, unknown>;
    return {
      id: str(s.id),
      title: str(s.title),
      frequency: str(s.frequency),
      frequencyShort: str(s.frequency_short),
      units: str(s.units),
      seasonalAdjustment: str(s.seasonal_adjustment),
      observationStart: str(s.observation_start),
      observationEnd: str(s.observation_end),
      lastUpdated: str(s.last_updated),
      popularity: num(s.popularity),
    };
  });

  const returned = series.length;
  const totalAvailable = num(b.count); // [P1] EXACT — never returned
  const hasMore =
    totalAvailable !== null && offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  return withMeta(
    { series },
    {
      source: `${FRED_HOST} /fred/series/search (FRED; FRED_API_KEY)`,
      keylessMode: false, // ★KEYED — the second key-required source
      returned,
      totalAvailable,
      filtersApplied: [`query:${query}`],
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes: [KEY_REQUIRED_NOTE, COUNT_TOTAL_NOTE],
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool: fred_series_observations ───────────────────────────────
export type FredSeriesObservationsArgs = {
  seriesId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
  sortOrder?: string;
};

export type FredObservation = {
  date: string | null;
  value: number | null; // ★"." ⇒ null (missing), never 0
};

/**
 * Fetch a FRED series' time series (`/fred/series/observations`) → date/value rows
 * + honest `_meta`. REQUIRES FRED_API_KEY (throws invalid_input pre-fetch when
 * unset). ★A missing observation (`value === "."`) maps to null, never 0.
 * totalAvailable = FRED's exact `count`; offset pagination.
 */
export async function seriesObservations(
  args: FredSeriesObservationsArgs,
): Promise<MetaBundle> {
  // ── [KEY] REQUIRED key — throw an honest config error BEFORE any fetch. ──
  const key = fredApiKey();
  if (key === undefined) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message:
        "FRED requires a free API key. Get one at https://fred.stlouisfed.org/docs/api/api_key.html and set FRED_API_KEY.",
      upstreamEndpoint: FRED_OBS_LABEL,
    });
  }

  // ── Validate (belt-and-suspenders behind the server Zod; a DIRECT handler call
  //    bypasses Zod — `series_id` rides the query, dates/sort_order too). ──
  const seriesId = args.seriesId ?? "";
  if (!SERIES_ID_RE.test(seriesId)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid seriesId ${JSON.stringify(seriesId)} — expected a FRED series id (^[A-Za-z0-9._-]+$), e.g. "GDP", "CPIAUCSL", "UNRATE".`,
      upstreamEndpoint: FRED_OBS_LABEL,
    });
  }
  if (args.startDate !== undefined && !DATE_RE.test(args.startDate)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid startDate ${JSON.stringify(args.startDate)} — expected YYYY-MM-DD (^\\d{4}-\\d{2}-\\d{2}$).`,
      upstreamEndpoint: FRED_OBS_LABEL,
    });
  }
  if (args.endDate !== undefined && !DATE_RE.test(args.endDate)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid endDate ${JSON.stringify(args.endDate)} — expected YYYY-MM-DD (^\\d{4}-\\d{2}-\\d{2}$).`,
      upstreamEndpoint: FRED_OBS_LABEL,
    });
  }
  if (args.sortOrder !== undefined && !SORT_ORDERS.has(args.sortOrder)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: `Invalid sortOrder ${JSON.stringify(args.sortOrder)} — expected one of asc, desc.`,
      upstreamEndpoint: FRED_OBS_LABEL,
    });
  }
  const limit = clampLimit(args.limit, DEFAULT_OBS_LIMIT, MAX_OBS_LIMIT);
  const offset = clampOffset(args.offset);

  const params = new URLSearchParams();
  params.set("series_id", seriesId);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  const filtersApplied: string[] = [`series_id:${seriesId}`];
  if (args.startDate !== undefined) {
    params.set("observation_start", args.startDate);
    filtersApplied.push(`observation_start:${args.startDate}`);
  }
  if (args.endDate !== undefined) {
    params.set("observation_end", args.endDate);
    filtersApplied.push(`observation_end:${args.endDate}`);
  }
  if (args.sortOrder !== undefined) {
    params.set("sort_order", args.sortOrder);
    filtersApplied.push(`sort_order:${args.sortOrder}`);
  }

  let body: unknown;
  try {
    body = await getFred(FRED_OBS_PATH, FRED_OBS_LABEL, params, key);
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw driftError(
        FRED_OBS_LABEL,
        "FRED /series/observations returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).",
      );
    }
    throw e;
  }

  // ── [P4] `observations` MUST be an array. ──
  const b = (body ?? {}) as { observations?: unknown; count?: unknown };
  if (!Array.isArray(b.observations)) {
    throw driftError(
      FRED_OBS_LABEL,
      "FRED /series/observations shape drift — `observations` must be an array.",
    );
  }

  const observations: FredObservation[] = (b.observations as unknown[]).map(
    (row) => {
      const o = (row ?? {}) as Record<string, unknown>;
      return { date: str(o.date), value: fredValue(o.value) }; // ★"." ⇒ null
    },
  );

  const returned = observations.length;
  const totalAvailable = num(b.count); // [P1] EXACT — never returned
  const hasMore =
    totalAvailable !== null && offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  return withMeta(
    { observations },
    {
      source: `${FRED_HOST} /fred/series/observations (FRED; FRED_API_KEY)`,
      keylessMode: false, // ★KEYED
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes: [KEY_REQUIRED_NOTE, MISSING_VALUE_NOTE, COUNT_TOTAL_NOTE],
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Small shared clamps (defensive, behind the server Zod bounds) ──
function clampLimit(v: unknown, def: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return def;
  const n = Math.floor(v);
  if (n < 1) return 1;
  if (n > max) return max;
  return n;
}

function clampOffset(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  const n = Math.floor(v);
  return n < 0 ? 0 : n;
}
