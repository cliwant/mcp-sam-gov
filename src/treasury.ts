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

import {
  getJson,
  driftError,
  throughPathChain,
  CircuitBreaker,
  type ResiliencePath,
  type Provenance,
} from "./datasource.js";
import { snapshotPath } from "./snapshot.js";
import { num, str } from "./coerce.js";
import { memoize } from "./cache.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy now lives in
// ./coerce.js — ADR-0005 v2 FIX-C) so existing importers and the fault suite's
// num-parity guard keep resolving `num` from this module.
export { num };

const BASE =
  "https://api.fiscaldata.treasury.gov/services/api/fiscal_service";

// ─── Resilience wiring (ADR-0045 Phase 2 pilot — INERT by default) ─────────
// The Treasury live host, and a per-host circuit breaker keyed on the FIXED set
// {this host} (bounded — m3-regression). The breaker is CONSULTED only by
// `throughPathChain` for a ≥2-path chain; when no snapshot is configured the
// chain is single-path (live only) and the breaker is a pure no-op. See
// datasource.ts §"RESILIENCE PORT".
const TREASURY_HOST = "api.fiscaldata.treasury.gov";
let treasuryBreaker = new CircuitBreaker([TREASURY_HOST]);

/**
 * Test-only: reset the resilience circuit breaker between OFFLINE fixtures (the
 * breaker is module-level process state; a fresh instance isolates cases). Not a
 * runtime API — mirrors the `_reset*Cache` convention in the fault suite.
 */
export function _resetTreasuryBreakerForTests(): void {
  treasuryBreaker = new CircuitBreaker([TREASURY_HOST]);
}

// ─── Confirmed dataset paths (F5 allowlist enum) ──────────────────
// Live-verified 2026-07-10: path + total-count + key fields (ADR-0002 §Context).
export const TREASURY_DATASETS = {
  debt_to_penny: "/v2/accounting/od/debt_to_penny",
  avg_interest_rates: "/v2/accounting/od/avg_interest_rates",
  mts_table_1: "/v1/accounting/mts/mts_table_1",
  rates_of_exchange: "/v1/accounting/od/rates_of_exchange",
  debt_outstanding: "/v2/accounting/od/debt_outstanding",
  // interest_expense = ACTUAL interest PAID on the debt (debt-service cost by
  // security type), distinct from avg_interest_rates (rates only). LIVE-VERIFIED
  // 2026-07-16 (total-count 7245, truthful pagination). tror = the Treasury Report
  // on Receivables — federal receivables + delinquent-debt collections BY AGENCY
  // (debt-collection contracting / agency financial-management signal; total 3953).
  interest_expense: "/v2/accounting/od/interest_expense",
  tror: "/v2/debt/tror",
} as const;

export type TreasuryDatasetKey = keyof typeof TREASURY_DATASETS;

// ─── Envelope types (F1 counts are numbers; F2 values string|number|null) ──
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

type TreasuryQuery = {
  fields?: string;
  filter?: string;
  sort?: string;
  pageSize: number;
  pageNumber: number;
};

// ─── HONESTY-CRITICAL coercions (F1/F2/F3) ────────────────────────
// `num`/`str` are the shared, audited null-never-0 coercions in ./coerce.js
// (imported above, `num` re-exported). F3: `num` returns null (NEVER 0) for
// absent values — the literal string "null" (early history + MTS parent rows),
// ""/whitespace (Number("") is 0!), and "(-)"/"-" all become null.

// ─── fetch layer ──────────────────────────────────────────────────
/**
 * GET one Treasury Fiscal Data page. Reuses errors.ts (retry/backoff/timeout +
 * the 429/5xx/404/400 taxonomy: an invalid `fields`/`filter` column ⇒ upstream
 * 400 ⇒ `invalid_input`, surfaced as an error, never a silent drop). Throws a
 * `schema_drift` ToolErrorCarrier if the envelope's `total-count` is not a
 * number (so a future upstream retype can't silently corrupt `_meta`).
 */
async function getTreasury<Row = TreasuryRow>(
  path: string,
  query: TreasuryQuery,
  snapshotKey?: string,
): Promise<{ env: TreasuryEnvelope<Row>; provenance: Provenance }> {
  const params = new URLSearchParams();
  if (query.fields) params.set("fields", query.fields);
  if (query.filter) params.set("filter", query.filter);
  if (query.sort) params.set("sort", query.sort);
  params.set("page[size]", String(query.pageSize));
  params.set("page[number]", String(query.pageNumber));
  const url = `${BASE}${path}?${params.toString()}`;
  const label = "treasury:" + path;
  // ★ADR-0045 Phase 2 pilot — route the fetch through `throughPathChain` INSTEAD
  // of a bare getJson. The LIVE path is byte-identical to the prior hand-rolled
  // fetch (init === { signal }, no headers/redirect — the same getJson call).
  const livePath: ResiliencePath<TreasuryEnvelope<Row>> = {
    host: TREASURY_HOST,
    provenance: { dataPath: "live" },
    run: () => getJson<TreasuryEnvelope<Row>>(url, { label }),
  };
  // The snapshot fallback is added ONLY when (a) this call declares a canned
  // snapshot key AND (b) SAMGOV_SNAPSHOT_BASE_URL is configured (else
  // snapshotPath returns null). ★When either is absent the chain is SINGLE-ENTRY
  // (live only) ⇒ throughPathChain fast-paths (no breaker consult, no overhead)
  // ⇒ behavior byte-identical to before this ADR (the INERT guarantee).
  const snap = snapshotKey
    ? snapshotPath<TreasuryEnvelope<Row>>(snapshotKey)
    : null;
  const paths = snap ? [livePath, snap] : [livePath];
  const { body: env, provenance } = await throughPathChain<
    TreasuryEnvelope<Row>
  >(paths, treasuryBreaker);
  // Drift guard applies to BOTH paths (a malformed snapshot fails as loudly as a
  // malformed live body) — schema_drift is non-retryable, so it does not fall
  // through nor trip the breaker.
  if (
    !env ||
    typeof env.meta !== "object" ||
    env.meta === null ||
    typeof env.meta["total-count"] !== "number" ||
    !Array.isArray(env.data)
  ) {
    throw driftError(
      label,
      `treasury:${path} returned an unexpected envelope shape (meta['total-count'] must be a number and data an array).`,
    );
  }
  return { env, provenance };
}

// ─── meta layer ───────────────────────────────────────────────────
const STRING_COERCION_NOTE =
  "Treasury value/amount fields arrive as strings (or, for some datasets, numbers) and are coerced via num(): the literal string \"null\" and empty values become null (NOT 0) — a null amount means 'no value reported', never zero.";

/**
 * Build the partial `_meta`. Passes `totalAvailable` (= the numeric
 * `total-count`, NEVER data.length/count/page-size) + offset-pagination, and
 * lets meta.ts's `buildMeta` DERIVE `complete`/`truncated` from those signals
 * (do NOT recompute here).
 */
function treasuryMeta(opts: {
  env: TreasuryEnvelope;
  path: string;
  pageNumber: number;
  pageSize: number;
  notes: string[];
  filtersApplied?: string[];
  fieldsUnavailable?: string[];
  /**
   * The access path that served this response (ADR-0045 P5). When the live
   * upstream answered (`dataPath:"live"`, the default and — with no snapshot
   * configured — the ONLY path) the dataPath/asOf fields are OMITTED, so `_meta`
   * is byte-identical to before this ADR. They are threaded ONLY for a NON-live
   * (snapshot) body, which makes buildMeta emit a staleness note, gate `complete`
   * off, and qualify `totalAvailable` as an as-of figure.
   */
  provenance?: Provenance;
}): Partial<ResponseMeta> {
  const totalAvailable = opts.env.meta["total-count"];
  const returned = opts.env.data.length;
  const offset = (opts.pageNumber - 1) * opts.pageSize;
  const hasMore = offset + returned < totalAvailable;
  const meta: Partial<ResponseMeta> = {
    source: `api.fiscaldata.treasury.gov (keyless) ${opts.path}`,
    keylessMode: true,
    returned,
    totalAvailable,
    pagination: {
      offset,
      limit: opts.pageSize,
      hasMore,
      nextOffset: hasMore ? offset + returned : null,
    },
    filtersApplied: opts.filtersApplied ?? [],
    filtersDropped: [],
    fieldsUnavailable: opts.fieldsUnavailable ?? [],
    notes: opts.notes,
  };
  // P5 threading (ADR-0045 B2): surface dataPath/asOf ONLY when NON-live, so a
  // live response omits the keys and stays byte-identical. No `??` default.
  if (opts.provenance && opts.provenance.dataPath !== "live") {
    meta.dataPath = opts.provenance.dataPath;
    if (opts.provenance.asOf !== undefined) meta.asOf = opts.provenance.asOf;
  }
  return meta;
}

/** Build `record_date` gte/lte filter clauses from optional ISO dates. */
function dateFilters(startDate?: string, endDate?: string): string[] {
  const f: string[] = [];
  if (startDate) f.push(`record_date:gte:${startDate}`);
  if (endDate) f.push(`record_date:lte:${endDate}`);
  return f;
}

/** UTC "today minus N months" as YYYY-MM-DD, for trailing-window defaults. */
function isoMonthsAgo(months: number): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/**
 * The most recent `record_date` for a dataset (memoized 5-min — slow-changing
 * reference read). Used to pin the "latest" period for the per-date-breakdown
 * datasets (avg_interest_rates) where a single-row page would bleed across
 * months.
 */
async function latestRecordDate(path: string): Promise<string | null> {
  return memoize(`treasury:latestdate:${path}`, async () => {
    const { env } = await getTreasury(path, {
      fields: "record_date",
      sort: "-record_date",
      pageSize: 1,
      pageNumber: 1,
    });
    return str(env.data[0]?.record_date);
  });
}

// ─── Tool: queryDataset (escape hatch, F5 enum-only) ──────────────
/**
 * Generic escape hatch over the 5 confirmed datasets (covers debt_outstanding +
 * rates_of_exchange without a dedicated tool). Rows are passed through RAW
 * (value fields as strings exactly as upstream provides) — the `_meta` note
 * warns that the literal string "null" means "no value", never zero.
 */
export async function queryDataset(args: {
  dataset: TreasuryDatasetKey;
  fields?: string;
  filter?: string;
  sort?: string;
  pageSize?: number;
  pageNumber?: number;
}): Promise<MetaBundle> {
  const path = TREASURY_DATASETS[args.dataset];
  const pageSize = args.pageSize ?? 100;
  const pageNumber = args.pageNumber ?? 1;
  const { env, provenance } = await getTreasury(path, {
    fields: args.fields,
    filter: args.filter,
    sort: args.sort,
    pageSize,
    pageNumber,
  });
  const filtersApplied: string[] = [];
  if (args.filter) filtersApplied.push("filter");
  if (args.fields) filtersApplied.push("fields");
  return withMeta(
    { dataset: args.dataset, path, rows: env.data },
    treasuryMeta({
      env,
      path,
      pageNumber,
      pageSize,
      filtersApplied,
      provenance,
      notes: [
        "Raw pass-through: value/amount fields are the upstream strings (or numbers) verbatim — the literal string \"null\" or an empty value means 'no value reported', NOT zero. Parse client-side.",
      ],
    }),
  );
}

// ─── Tool: debtToPenny ────────────────────────────────────────────
const DEBT_TO_PENNY_FIELDS =
  "record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt";

/**
 * Daily total US public debt ("Debt to the Penny"). `latest` (default true) ⇒
 * the single most-recent day; else the `startDate/endDate` range, newest first.
 * Amounts are USD, coerced via num() (null, never 0, for absent).
 */
export async function debtToPenny(args: {
  latest?: boolean;
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  pageNumber?: number;
}): Promise<MetaBundle> {
  const path = TREASURY_DATASETS.debt_to_penny;
  const latest = args.latest ?? true;
  const pageNumber = args.pageNumber ?? 1;
  const pageSize = latest ? 1 : args.pageSize ?? 100;
  const filter = latest
    ? undefined
    : dateFilters(args.startDate, args.endDate).join(",") || undefined;
  // ★Snapshot fallback ONLY for the canned "latest" read (a single, well-defined
  // most-recent-day snapshot the builder can pre-fetch). Range/paginated reads
  // pass no key ⇒ live only. Even for latest, the snapshot is INERT unless
  // SAMGOV_SNAPSHOT_BASE_URL is configured (snapshotPath returns null).
  const snapshotKey = latest ? "treasury_debt_to_penny_latest" : undefined;
  const { env, provenance } = await getTreasury(
    path,
    {
      fields: DEBT_TO_PENNY_FIELDS,
      filter,
      sort: "-record_date",
      pageSize,
      pageNumber,
    },
    snapshotKey,
  );
  const data = {
    records: env.data.map((r) => ({
      recordDate: str(r.record_date),
      totalPublicDebtOutstanding: num(r.tot_pub_debt_out_amt),
      debtHeldByPublic: num(r.debt_held_public_amt),
      intragovernmentalHoldings: num(r.intragov_hold_amt),
    })),
  };
  const filtersApplied: string[] = [];
  if (!latest && (args.startDate || args.endDate)) filtersApplied.push("recordDate");
  return withMeta(
    data,
    treasuryMeta({
      env,
      path,
      pageNumber,
      pageSize,
      filtersApplied,
      provenance,
      notes: [
        latest
          ? "latest=true returns only the single most-recent day (page[size]=1)."
          : "Range mode: rows filtered by record_date, sorted newest-first.",
        STRING_COERCION_NOTE,
      ],
    }),
  );
}

// ─── Tool: monthlyStatement (MTS table 1) — F4 summary-row exclusion ──
const MTS_FIELDS =
  "record_date,classification_desc,parent_id,line_code_nbr,current_month_gross_rcpt_amt,current_month_gross_outly_amt,current_month_dfct_sur_amt";

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
export async function monthlyStatement(args: {
  startDate?: string;
  endDate?: string;
  excludeSummaryRows?: boolean;
  pageSize?: number;
  pageNumber?: number;
}): Promise<MetaBundle> {
  const path = TREASURY_DATASETS.mts_table_1;
  const excludeSummary = args.excludeSummaryRows ?? true;
  const pageNumber = args.pageNumber ?? 1;
  const pageSize = args.pageSize ?? 100;
  // Default to the trailing ~12 months when no explicit window is given.
  const startDate =
    args.startDate ?? (args.endDate ? undefined : isoMonthsAgo(12));
  const filters = dateFilters(startDate, args.endDate);
  if (excludeSummary) filters.push("current_month_gross_outly_amt:gt:0");
  const filter = filters.length ? filters.join(",") : undefined;
  const { env, provenance } = await getTreasury(path, {
    fields: MTS_FIELDS,
    filter,
    sort: "-record_date,line_code_nbr",
    pageSize,
    pageNumber,
  });
  const data = {
    records: env.data.map((r) => ({
      recordDate: str(r.record_date),
      classification: str(r.classification_desc),
      grossReceipts: num(r.current_month_gross_rcpt_amt),
      grossOutlays: num(r.current_month_gross_outly_amt),
      deficitSurplus: num(r.current_month_dfct_sur_amt),
    })),
  };
  const filtersApplied: string[] = [];
  if (startDate || args.endDate) filtersApplied.push("recordDate");
  if (excludeSummary) filtersApplied.push("excludeSummaryRows");
  const notes: string[] = [
    excludeSummary
      ? "Summary/parent rows excluded (default): the server-side filter current_month_gross_outly_amt:gt:0 drops the fiscal-year header rows (parent_id=\"null\", all amounts \"null\"). totalAvailable reflects child line-item rows only. Pass excludeSummaryRows=false to include them."
      : "excludeSummaryRows=false: fiscal-year parent/summary rows (parent_id=\"null\") ARE included; their amount fields are all null — do NOT read those null-amount rows as data.",
    STRING_COERCION_NOTE,
  ];
  return withMeta(
    data,
    treasuryMeta({
      env,
      path,
      pageNumber,
      pageSize,
      filtersApplied,
      notes,
      provenance,
    }),
  );
}

// ─── Tool: avgInterestRates ───────────────────────────────────────
const AVG_INTEREST_FIELDS =
  "record_date,security_type_desc,security_desc,avg_interest_rate_amt";

/**
 * Average interest rate the Treasury pays by security type/description.
 * `latest` (default true) returns the most-recent month's full breakdown across
 * security types (pinned to the latest record_date, memoized — a slow-changing
 * reference read); else the `startDate/endDate` range. Optional `securityType`
 * narrows by `security_type_desc` (e.g. "Marketable", "Non-marketable").
 * `avg_interest_rate_amt` is a PERCENT, coerced via num() (null, never 0).
 */
export async function avgInterestRates(args: {
  securityType?: string;
  latest?: boolean;
  startDate?: string;
  endDate?: string;
  pageSize?: number;
  pageNumber?: number;
}): Promise<MetaBundle> {
  const latest = args.latest ?? true;
  if (latest) {
    const key = `treasury:avg_interest_rates:latest:${args.securityType ?? "*"}`;
    return memoize(key, () => avgInterestRatesLatest(args.securityType));
  }
  return avgInterestRatesQuery({
    securityType: args.securityType,
    startDate: args.startDate,
    endDate: args.endDate,
    pageSize: args.pageSize ?? 100,
    pageNumber: args.pageNumber ?? 1,
    latest: false,
  });
}

async function avgInterestRatesLatest(
  securityType?: string,
): Promise<MetaBundle> {
  const path = TREASURY_DATASETS.avg_interest_rates;
  const maxDate = await latestRecordDate(path);
  return avgInterestRatesQuery({
    securityType,
    startDate: maxDate ?? undefined,
    endDate: maxDate ?? undefined,
    pageSize: 100,
    pageNumber: 1,
    latest: true,
    latestDate: maxDate,
  });
}

async function avgInterestRatesQuery(opts: {
  securityType?: string;
  startDate?: string;
  endDate?: string;
  pageSize: number;
  pageNumber: number;
  latest: boolean;
  latestDate?: string | null;
}): Promise<MetaBundle> {
  const path = TREASURY_DATASETS.avg_interest_rates;
  const filters = dateFilters(opts.startDate, opts.endDate);
  if (opts.securityType) {
    filters.push(`security_type_desc:eq:${opts.securityType}`);
  }
  const filter = filters.length ? filters.join(",") : undefined;
  const { env, provenance } = await getTreasury(path, {
    fields: AVG_INTEREST_FIELDS,
    filter,
    sort: "-record_date,security_type_desc",
    pageSize: opts.pageSize,
    pageNumber: opts.pageNumber,
  });
  const data = {
    records: env.data.map((r) => ({
      recordDate: str(r.record_date),
      securityType: str(r.security_type_desc),
      securityDescription: str(r.security_desc),
      avgInterestRatePercent: num(r.avg_interest_rate_amt),
    })),
  };
  const filtersApplied: string[] = [];
  if (opts.startDate || opts.endDate) filtersApplied.push("recordDate");
  if (opts.securityType) filtersApplied.push("securityType");
  const notes: string[] = [];
  if (opts.latest) {
    notes.push(
      opts.latestDate
        ? `latest=true: pinned to the most-recent record_date (${opts.latestDate}); served from a 5-minute TTL cache.`
        : "latest=true: could not resolve the most-recent record_date (upstream returned no rows).",
    );
  } else {
    notes.push("Range mode: rows filtered by record_date, sorted newest-first.");
  }
  notes.push(STRING_COERCION_NOTE);
  return withMeta(
    data,
    treasuryMeta({
      env,
      path,
      pageNumber: opts.pageNumber,
      pageSize: opts.pageSize,
      filtersApplied,
      notes,
      provenance,
    }),
  );
}
