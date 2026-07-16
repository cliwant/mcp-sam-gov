/**
 * US Treasury — Fiscal Data API wrappers (keyless).
 *
 * First non-SAM macro/fiscal source (ADR-0002). Fully PUBLIC, KEYLESS — the
 * Treasury Fiscal Data service (https://fiscaldata.treasury.gov) needs no API
 * key and documents no numeric rate limit. Base:
 *   https://api.fiscaldata.treasury.gov/services/api/fiscal_service/
 *
 * Three clean layers (seed the future common DataSource port, R2):
 *   fetch — `getTreasury(path, query)` builds the URL + envelope, reusing
 *           errors.ts retry/timeout/taxonomy.
 *   map   — per-dataset PURE mappers Row → domain object, coercing string
 *           amounts through the shared `num()`.
 *   meta  — `treasuryMeta(...)` hands `{ totalAvailable, returned, pagination }`
 *           to `withMeta`; meta.ts's `buildMeta` DERIVES complete/truncated.
 *
 * HONESTY TRAPS (live-verified 2026-07-10 — see ADR-0002 Review outcome v2):
 *   F1/F9 — `meta.count` / `meta['total-count']` / `meta['total-pages']` are
 *           JSON NUMBERS (not strings). `totalAvailable = meta['total-count']`
 *           directly; never `num()` them.
 *   F2    — VALUE fields are inconsistently typed across datasets (debt/rate
 *           amounts are strings; even `rates_of_exchange.exchange_rate`, whose
 *           dataType metadata says NUMBER, arrives as a string on the wire).
 *           Row value fields are typed `string | number | null` and ALWAYS go
 *           through `num()`.
 *   F3    — `num(x)` returns null (NEVER 0) for absent values. The literal
 *           string "null" is common (early history + MTS parent/summary rows);
 *           returning 0 would be a data-absence-as-zero masquerade.
 *   F4    — `mts_table_1` mixes child line-items (real amounts) with
 *           fiscal-year PARENT/SUMMARY rows whose amounts are all "null".
 *           `monthlyStatement` excludes them by default via the LIVE-VERIFIED
 *           server-side filter `current_month_gross_outly_amt:gt:0` (3039 →
 *           2769 rows; the 270 dropped rows are exactly the `parent_id="null"`
 *           header rows).
 *   F5    — `queryDataset` accepts only an ENUM of 5 confirmed paths (no free
 *           path) — removes the SSRF surface for this slice.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
/**
 * Test-only: reset the resilience circuit breaker between OFFLINE fixtures (the
 * breaker is module-level process state; a fresh instance isolates cases). Not a
 * runtime API — mirrors the `_reset*Cache` convention in the fault suite.
 */
export declare function _resetTreasuryBreakerForTests(): void;
export declare const TREASURY_DATASETS: {
    readonly debt_to_penny: "/v2/accounting/od/debt_to_penny";
    readonly avg_interest_rates: "/v2/accounting/od/avg_interest_rates";
    readonly mts_table_1: "/v1/accounting/mts/mts_table_1";
    readonly rates_of_exchange: "/v1/accounting/od/rates_of_exchange";
    readonly debt_outstanding: "/v2/accounting/od/debt_outstanding";
    readonly interest_expense: "/v2/accounting/od/interest_expense";
    readonly tror: "/v2/debt/tror";
};
export type TreasuryDatasetKey = keyof typeof TREASURY_DATASETS;
export type TreasuryValue = string | number | null;
export type TreasuryRow = Record<string, TreasuryValue>;
export type TreasuryEnvelopeMeta = {
    /** rows in THIS page — a JSON number (F1). */
    count: number;
    /** the truthful grand total for the query — a JSON number (F1). */
    "total-count": number;
    /** a JSON number (F1). */
    "total-pages": number;
    labels?: Record<string, string>;
    dataTypes?: Record<string, string>;
    dataFormats?: Record<string, string>;
};
export type TreasuryEnvelope<Row = TreasuryRow> = {
    data: Row[];
    meta: TreasuryEnvelopeMeta;
    links?: {
        self?: string;
        first?: string;
        prev?: string | null;
        next?: string | null;
        last?: string;
    };
};
/**
 * Generic escape hatch over the 5 confirmed datasets (covers debt_outstanding +
 * rates_of_exchange without a dedicated tool). Rows are passed through RAW
 * (value fields as strings exactly as upstream provides) — the `_meta` note
 * warns that the literal string "null" means "no value", never zero.
 */
export declare function queryDataset(args: {
    dataset: TreasuryDatasetKey;
    fields?: string;
    filter?: string;
    sort?: string;
    pageSize?: number;
    pageNumber?: number;
}): Promise<MetaBundle>;
/**
 * Daily total US public debt ("Debt to the Penny"). `latest` (default true) ⇒
 * the single most-recent day; else the `startDate/endDate` range, newest first.
 * Amounts are USD, coerced via num() (null, never 0, for absent).
 */
export declare function debtToPenny(args: {
    latest?: boolean;
    startDate?: string;
    endDate?: string;
    pageSize?: number;
    pageNumber?: number;
}): Promise<MetaBundle>;
/**
 * Monthly Treasury Statement (MTS) table 1 — federal receipts, outlays, and the
 * deficit/surplus by month. `startDate/endDate` (ISO) filter record_date;
 * default is the trailing ~12 months.
 *
 * F4 — SUMMARY-ROW EXCLUSION (live-verified 2026-07-10): mts_table_1 interleaves
 * child line-items (real amounts) with fiscal-year PARENT/SUMMARY header rows
 * whose `parent_id` is the string "null" and whose amount fields are all the
 * string "null". `excludeSummaryRows` (default true) appends the server-side
 * filter `current_month_gross_outly_amt:gt:0`, which drops EXACTLY those parent
 * rows (total-count 3039 → 2769; the 270 dropped rows == the parent_id="null"
 * set). Because the exclusion is server-side, `total-count` (and hence
 * `_meta.totalAvailable` / pagination) reflect the child rows only — no
 * client-side filtering that would desync `returned` from the envelope count.
 */
export declare function monthlyStatement(args: {
    startDate?: string;
    endDate?: string;
    excludeSummaryRows?: boolean;
    pageSize?: number;
    pageNumber?: number;
}): Promise<MetaBundle>;
/**
 * Average interest rate the Treasury pays by security type/description.
 * `latest` (default true) returns the most-recent month's full breakdown across
 * security types (pinned to the latest record_date, memoized — a slow-changing
 * reference read); else the `startDate/endDate` range. Optional `securityType`
 * narrows by `security_type_desc` (e.g. "Marketable", "Non-marketable").
 * `avg_interest_rate_amt` is a PERCENT, coerced via num() (null, never 0).
 */
export declare function avgInterestRates(args: {
    securityType?: string;
    latest?: boolean;
    startDate?: string;
    endDate?: string;
    pageSize?: number;
    pageNumber?: number;
}): Promise<MetaBundle>;
//# sourceMappingURL=treasury.d.ts.map