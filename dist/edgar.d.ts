/**
 * SEC EDGAR — company filings, XBRL financial facts, ticker→CIK, and full-text
 * search (keyless). First capital-markets source (ADR-0003); 2nd consumer of the
 * fetch/map/meta shape after treasury.ts.
 *
 * Fully PUBLIC, KEYLESS. Hosts: data.sec.gov, efts.sec.gov, www.sec.gov/files
 * (+ www.sec.gov/Archives for constructed links). No API key; instead SEC
 * requires a descriptive `User-Agent` on EVERY request and self-throttling to
 * ≤10 req/s (a breach → ~10-minute IP block).
 *
 * Three layers (mirror treasury.ts):
 *   fetch — `getEdgar(url, label)`: sets the mandatory UA (+ gzip) on the init,
 *           serializes every EDGAR fetch through a per-process min-interval gate
 *           (~110ms → ≤~9 req/s), and reuses errors.ts retry/timeout/taxonomy.
 *   map   — PURE columnar/curated mappers (zipRecent, companyfacts extraction,
 *           FTS hit map). `num(x)` → number|null (NEVER 0 for absent). `padCik`.
 *   meta  — `withMeta(...)`: hands totalAvailable/returned/pagination/notes to
 *           meta.ts's buildMeta, which DERIVES complete/truncated.
 *
 * HONESTY / REVIEW FIXES (ADR-0003 "Review outcome (v2)", live-verified 2026-07-10):
 *   F1 — the committed default UA is an ORG contact on the project domain
 *        (`cliwant-mcp-sam-gov/1.0 (contact: opendata@cliwant.com)`), NOT a
 *        github.com URL (SEC 403s any UA containing `github.com`) and NOT a
 *        personal email. Override via EDGAR_USER_AGENT.
 *   F2 — `edgar_full_text_search` has NO `size` param: efts ignores it (5/20/100/
 *        200 all return 100), so page size is a fixed 100. Pagination is by `from`.
 *   F3 — FTS window overflow: `from > 9900` (from+100 > 10000) is rejected as
 *        invalid_input BEFORE the fetch; and after r.json(), a missing `hits.hits`
 *        (SEC returns HTTP 200 + `{message:"Internal server error"}` past the
 *        window) is thrown as schema_drift, never crashed on.
 *   F4 — default curated concepts DO NOT include EarningsPerShareBasic (its unit
 *        is `USD/shares`, so the default `unit="USD"` would silently return
 *        nothing). A requested concept present only in another unit → a note,
 *        never a silent/fabricated 0.
 *   F5 — FTS `hits.total.relation === "gte"` → `totalIsLowerBound:true` passed to
 *        withMeta (machine-readable, not only a note). See meta.ts.
 *   F6 — getEdgar disambiguates a 403 by reading the body: "automated"/
 *        "Undeclared" ⇒ invalid_input (bad UA, don't retry); else ⇒ rate_limited,
 *        retryable, retryAfterSeconds 600 (the ~10-min block).
 *   F7 — FTS `_source` has NO primary-document filename; the output `filingIndexUrl`
 *        is the filing's ARCHIVE INDEX directory built from `adsh` (no fabricated
 *        doc URL). `edgar_company_filings` DOES use the real `primaryDocument`.
 *
 * CIK↔UEI JOIN CAVEAT (load-bearing, in every tool's `_meta.notes` +
 *   fieldsUnavailable): EDGAR keys on 10-digit SEC CIK, NOT SAM UEI/DUNS or a
 *   USAspending recipient id. No reliable programmatic CIK↔UEI join exists;
 *   bridging an EDGAR filer to a federal contracting entity is name/ticker-only
 *   (fuzzy) and MUST NOT be asserted as authoritative.
 */
import { type MetaBundle } from "./meta.js";
/**
 * A CIK (int or string, padded or not) → the canonical 10-digit zero-padded
 * form EDGAR's data.sec.gov paths require. Strips non-digits first (accepts
 * "CIK320193", "320193", 320193). e.g. 320193 → "0000320193".
 */
export declare function padCik(x: string | number): string;
/**
 * Coerce an XBRL value to number|null. Returns **null (never 0)** for absent —
 * a missing fact is an honest "unknown", never a fabricated zero. XBRL `val` is
 * already a JSON number, but guard strings/nullish/non-finite defensively.
 */
export declare function num(x: unknown): number | null;
export type TickerEntry = {
    cik: string;
    ticker: string;
    title: string;
};
/**
 * Map a company query (exact ticker, else title substring) to its 10-digit CIK
 * via the memoized company_tickers.json. Returns up to 50 matches; `found:false`
 * on none. The CIK is the join key the other three tools take.
 */
export declare function lookupCik(args: {
    query: string;
}): Promise<MetaBundle>;
export type Filing = {
    accession: string | null;
    form: string | null;
    filingDate: string | null;
    reportDate: string | null;
    primaryDocument: string | null;
    primaryDocDescription: string | null;
    primaryDocUrl: string | null;
    isXBRL: boolean;
};
/**
 * A company's SEC filings. By default (`fullHistory` off) returns the recent
 * window (from `filings.recent` — up to 1 year OR 1000 filings, whichever is
 * more), optionally narrowed to specific `forms`, with offset pagination. HONESTY:
 * the response is COMPLETE only when `filings.files[]` (older shards) is empty;
 * when shards exist, `totalAvailable` is the grand total (recent + Σ shard counts),
 * `hasMore:true`, and a note discloses that only the recent window was searched.
 * With `fullHistory:true`, the older `files[]` shards are fetched (newest-first up
 * to `maxShards`, default 10) and assembled (recent ++ shard001..N, descending
 * preserved, NO re-sort) into the COMPLETE history — a capped/failed fan-out is
 * disclosed as PARTIAL (never a capped set claimed complete). `totalAvailable`
 * stays the grand total regardless of the cap (buildMeta forces complete:false
 * when returned < total).
 */
export declare function companyFilings(args: {
    cikOrTicker: string;
    forms?: string[];
    limit?: number;
    offset?: number;
    fullHistory?: boolean;
    maxShards?: number;
}): Promise<MetaBundle>;
/**
 * The default curated us-gaap concepts (F4 — NO EarningsPerShareBasic; its unit
 * is USD/shares, so the default unit="USD" would silently return nothing). The
 * two revenue tags cover the same logical concept — filers report under one or
 * the other — so this is the 6 curated USD concepts. Extracting only these
 * avoids returning the full ~500-concept companyfacts payload.
 */
export declare const DEFAULT_FACT_CONCEPTS: string[];
/**
 * Curated XBRL financial facts for a filer. Extracts only the requested (or the
 * 6 default) concepts in the requested `unit` (default USD), from the memoized
 * companyfacts doc. HONESTY: a concept ABSENT for this filer is OMITTED and
 * listed in a note (NEVER surfaced as 0); a concept present only in a DIFFERENT
 * unit (e.g. EPS in USD/shares) is listed under `wrongUnit` with a note, never a
 * silent 0. `latest` reduces each concept to its single most-recent data point.
 */
export declare function companyFacts(args: {
    cikOrTicker: string;
    concepts?: string[];
    unit?: string;
    latest?: boolean;
}): Promise<MetaBundle>;
export type FtsResult = {
    accession: string | null;
    form: string | null;
    filingDate: string | null;
    entityNames: string[];
    ciks: string[];
    filingIndexUrl: string | null;
};
/**
 * Full-text search across EDGAR filings (2001-present). F2 — NO `size` param
 * (efts always returns 100/page); pagination is by `from`. F3 — `from > 9900`
 * is rejected as invalid_input BEFORE the fetch (from+100 would exceed the 10000
 * window, which efts answers with HTTP 200 + an error body; from=9900 itself is a
 * VALID final page), and a response missing `hits.hits` is thrown as schema_drift
 * (never crashed on). F5 — `hits.total.relation === "gte"` (true total unknown,
 * ≥10000) surfaces as `totalIsLowerBound:true`. ADR-0018 — optional `ciks` (pin
 * filings BY entities, exact 10-digit CIK) + `entityName` (fuzzy filer-name)
 * narrowing filters; a no-digit/CIK-0 `ciks` entry is rejected pre-fetch (M1).
 */
export declare function fullTextSearch(args: {
    q: string;
    forms?: string[];
    startdt?: string;
    enddt?: string;
    ciks?: string[];
    entityName?: string;
    from?: number;
}): Promise<MetaBundle>;
/**
 * The `taxonomy` path-segment enum — the SSRF guard for that segment (no free
 * value reaches the host). Only members LIVE-CONFIRMED to resolve a real frame
 * (per-segment live-verify discipline, ADR-0017 Open-Q5) are shipped. Maker
 * probes 2026-07-12: us-gaap (Assets/Revenues/NetIncomeLoss/EPS) + dei
 * (EntityCommonStockSharesOutstanding/EntityPublicFloat) → 200; the guessed
 * srt/invest/us-ins tags → 404, so they are DROPPED (conservative floor).
 */
export declare const FRAMES_TAXONOMIES: readonly ["us-gaap", "dei"];
/** One filer's row in a frame. `start` is present ONLY for duration concepts. */
export type FrameRow = {
    accn: string | null;
    cik: string | null;
    entityName: string | null;
    loc: string | null;
    end: string | null;
    val: number | null;
    start?: string | null;
};
/**
 * Summary distribution over the FULL cross-section (M2/M3). Computed over the
 * FINITE `val`s only (num() → null for absent/blank/"null"/non-finite, which are
 * excluded and counted in `nonFiniteExcluded`; a real 0 survives). Percentiles use
 * LINEAR INTERPOLATION on the ascending-sorted finite vals. `count===0` (no finite
 * vals) ⇒ EVERY stat field null (never 0/NaN/Infinity — the null-never-0 row rule
 * lifted onto the aggregate).
 */
export type FrameStats = {
    count: number;
    min: number | null;
    max: number | null;
    sum: number | null;
    mean: number | null;
    median: number | null;
    p25: number | null;
    p75: number | null;
    nonFiniteExcluded: number;
};
/**
 * Keyless cross-filer XBRL cross-section. In ONE call, return every filer's
 * reported value for a single us-gaap/dei concept in a single calendar period —
 * the complete cross-section — for peer benchmarking + distribution stats.
 *
 * HONESTY (ADR-0017 v2):
 *  - `totalAvailable` = SEC's own `pts` (NEVER a page length). Drift guards THROW
 *    schema_drift on a non-frames shape (data not array / pts non-numeric) or a
 *    `pts !== data.length` mismatch (a truncation frames has no way to page past,
 *    so refusing is the honest move — Open-Q2 resolved: THROW is the DEFAULT).
 *  - The upstream frame is fetched in FULL; `limit`/`offset` is a CLIENT-SIDE
 *    window disclosed as such (M1 — the completeness note never calls a subset
 *    page "complete"; buildMeta derives complete/truncated from returned/total/
 *    hasMore, mirroring edgar_company_filings — NO forced complete:true).
 *  - A 404 (tag/unit/period/taxonomy quadruple did not match) ⇒ honest found:false
 *    with the semantic note (absence ≠ 0). NEVER a fabricated val:0.
 *  - Row `val` is num()-coerced (null-never-0). `start` appears only on duration
 *    rows. `uom` echoes SEC's OWN unit (e.g. requested 'USD-per-shares' ⇒ 'USD/shares').
 *  - `includeStats` computes over the FULL data[] (all rows, before the slice).
 */
export declare function xbrlFrames(args: {
    tag: string;
    period: string;
    taxonomy?: string;
    unit?: string;
    limit?: number;
    offset?: number;
    includeStats?: boolean;
}): Promise<MetaBundle>;
//# sourceMappingURL=edgar.d.ts.map