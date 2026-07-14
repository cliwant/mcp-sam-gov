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
 *   fetch (never a fake-empty, never a keyless-pretend). The other 112 tools stay
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
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const FRED_HOST = "api.stlouisfed.org";
/** Read FRED_API_KEY from env; trim; return the value or undefined (unset/blank). */
export declare function fredApiKey(): string | undefined;
/**
 * num(), but map FRED's missing-observation sentinel `"."` → null (missing). A
 * genuine "0" stays 0 (num("0") === 0); a real numeric string parses. This is the
 * BLS `"-"` lineage — a data-absence marker, never a fabricated 0.
 */
export declare function fredValue(v: unknown): number | null;
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
export declare function searchSeries(args: FredSearchSeriesArgs): Promise<MetaBundle>;
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
    value: number | null;
};
/**
 * Fetch a FRED series' time series (`/fred/series/observations`) → date/value rows
 * + honest `_meta`. REQUIRES FRED_API_KEY (throws invalid_input pre-fetch when
 * unset). ★A missing observation (`value === "."`) maps to null, never 0.
 * totalAvailable = FRED's exact `count`; offset pagination.
 */
export declare function seriesObservations(args: FredSeriesObservationsArgs): Promise<MetaBundle>;
//# sourceMappingURL=fred.d.ts.map