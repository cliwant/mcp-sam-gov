/**
 * BLS Public Data API v1/v2 — US labor-economics & price-index time series
 * (keyless v1 default; an OPTIONAL free BLS_API_KEY lifts to v2). ADR-0032.
 *
 * A NEW capability axis for the server — the PRICING / ESCALATION layer: CPI-U &
 * ECI drive federal contract escalation / economic-price-adjustment (EPA) clauses;
 * PPI benchmarks materials pricing; CES employment/wages give labor-rate context
 * (next to GSA CALC + SAM wage determinations). Consumer of the R2 `getJson`/
 * `throughGate` port; the SECOND POST-batch consumer (after NIH RePORTER).
 *
 * ON-DOMAIN HONESTY: these are PUBLIC AGGREGATE STATISTICS (no PII). The tool
 * LABELS units per series (an ECI "…A" 3.4 is a 12-month PERCENT CHANGE, not an
 * index level) and NEVER fabricates a value — the BLS "-" unavailable marker maps
 * to null (NEVER 0) with the footnote reason surfaced, so a data gap (e.g. the
 * 2025 lapse-in-appropriations) is DISCLOSED, never a silent null and never a 0.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (method:"POST" + body + redirect:"error"), `driftError`, `throughGate`,
 * `num`·`str` (coerce.ts, null-never-0), `withMeta`·`buildMeta`, and MIRRORS the
 * fixed-host SSRF idiom from NIH/FDIC + the body-carried optional-key discipline
 * of datagovKey.ts (but the key rides in the POST BODY, never a header/URL/log).
 *
 * ★ SSRF GUARD (policy① — the smallest surface): host+path are compile-time
 *   CONSTANTS; NO caller value touches them. seriesids ride in the MODULE-BUILT
 *   POST body (JSON.stringify'd typed payload — no raw passthrough), so a caller
 *   value has NO host-alteration surface. Each raw seriesId is charclass-validated
 *   `^[A-Z0-9]{1,20}$` (rejects `../`, encoded traversal, `@host`, `;`, a trailing
 *   `\n`). Curated keys resolve through the FROZEN catalog map (never user text). A
 *   post-construction hostname/protocol assertion + `redirect:"error"` lock it.
 *
 * ★ THE HONESTY FRONTIER (P3): each observation's `value` is a STRING → `num()`.
 *   `num("-")` / any non-numeric → **null NEVER 0**; a genuine `"0"` → 0. The row
 *   carries `valueUnavailable` (true iff the raw value was present but unparseable)
 *   + its `footnotes[]`, and the footnote text is LIFTED into `_meta.notes` so the
 *   absence is disclosed. `value` is ALWAYS the parsed number, never the raw string.
 *
 * ★ STATUS GATE (P2): `status !== "REQUEST_SUCCEEDED"` THROWS (never a fake-empty):
 *   `REQUEST_NOT_PROCESSED` (the v1 daily-limit case) → `rate_limited` (retryable)
 *   with the tier disclosure; `REQUEST_FAILED`/other → `upstream_unavailable` (or
 *   `invalid_input` when `message[]` reads like a bad request). A non-JSON 200, or
 *   a SUCCESS body missing `Results.series` (non-array), → `driftError`.
 *
 * ★ OPTIONAL BLS_API_KEY (v2) — body-carried, NEVER leaked: read from env
 *   (trimmed; empty ⇒ keyless v1). When present → the `…/v2/…` path + a
 *   `registrationkey` field in the POST BODY, and NOWHERE else (never the URL, a
 *   header, the label, the `source`, `_meta`, or a log). When keyless,
 *   `registrationkey` is ABSENT from the body. Only the MODE is ever disclosed.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const BLS_SERIES_KEYS: readonly ["cpi_u_all", "cpi_u_core", "ppi_final_demand", "eci_total_comp", "eci_wages", "unemployment_rate", "labor_force_participation", "employment_total_nonfarm", "avg_hourly_earnings"];
export type BlsSeriesKey = (typeof BLS_SERIES_KEYS)[number];
export type BlsCatalogEntry = {
    seriesId: string;
    meaning: string;
    units: string;
};
export declare const BLS_CATALOG: Record<BlsSeriesKey, BlsCatalogEntry>;
export declare const YEAR_MAX: number;
/** true when no BLS_API_KEY is configured (keyless v1). Drives mode + caps + path. */
export declare function usingKeylessV1(): boolean;
export type BlsFootnote = {
    code: string | null;
    text: string | null;
};
export type BlsObservation = {
    year: string | null;
    period: string | null;
    periodName: string | null;
    /** The PARSED number — null (NEVER 0) for "-"/non-numeric; a genuine "0" → 0. */
    value: number | null;
    /** true iff the raw value was present but unparseable (a disclosed gap). */
    valueUnavailable: boolean;
    footnotes: BlsFootnote[];
    latest: boolean;
};
export type BlsSeriesResult = {
    seriesId: string;
    /** The curated enum key, or null for a raw seriesId. */
    key: string | null;
    /** The curated meaning, or null for a raw seriesId. */
    meaning: string | null;
    /** The units label (from the frozen catalog); null for a raw seriesId. */
    units: string | null;
    observations: BlsObservation[];
    observationCount: number;
    coveredRange: {
        from: number | null;
        to: number | null;
    };
};
export type BlsTimeseriesArgs = {
    series?: BlsSeriesKey[];
    seriesId?: string[];
    startYear?: number;
    endYear?: number;
};
/**
 * Fetch one or more BLS time-series over a year range → normalized observations
 * (null-never-0 values + footnotes + per-series units label) + honest `_meta`.
 * At least one of `series`/`seriesId` is required; both may be combined. The
 * resolved+deduped series set is refused over the active tier's series cap
 * (never a silent drop). The span is CLAMPED to the tier cap BEFORE the fetch
 * and disclosed. seriesids ride in the module-built POST body (SSRF: no raw
 * host/path passthrough); the OPTIONAL BLS_API_KEY rides ONLY in the body.
 */
export declare function timeseries(args: BlsTimeseriesArgs): Promise<MetaBundle>;
//# sourceMappingURL=bls.d.ts.map