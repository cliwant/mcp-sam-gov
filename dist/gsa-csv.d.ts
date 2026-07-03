/**
 * GSA daily-CSV keyless backbone (opt-in) — page-completing enrichment for the
 * fields the keyless SAM HAL list endpoint nulls.
 *
 * Why this exists
 * ----------------
 * `sam_search_opportunities` (keyless HAL) returns a page of notices but nulls
 * each row's naics / setAside / place-of-performance / responseDeadline / type
 * (the list payload omits those VALUES even though the server-side filter
 * honored them). Today the only fill path is `sam_get_opportunity` PER notice —
 * N detail calls to complete an N-row page.
 *
 * The GSA "Contract Opportunities" daily bulk CSV carries all of those fields
 * keyed by NoticeId (the 32-hex id that equals the HAL `_id`). So ONE cached
 * index lookup completes a whole page, and it's a durability hedge if the
 * undocumented HAL list drifts.
 *
 * Source — LIVE-VERIFIED 2026-07-03
 * ---------------------------------
 *   https://falextracts.s3.amazonaws.com/Contract Opportunities/datagov/ContractOpportunitiesFullCSV.csv
 *   HEAD 200, 225,722,960 bytes (225.7 MB), `last-modified` daily,
 *   `accept-ranges: bytes`, 47 columns. Key + HAL-nulled fields (0-indexed):
 *   NoticeId@0 (32-hex == HAL _id), Title@1, Type@10, SetASideCode@14,
 *   SetASide@15, ResponseDeadLine@16, NaicsCode@17, PopCity@20, PopState@21,
 *   PopZip@22, PopCountry@23, Active@24, Description@46.
 *
 * Gold-standard verification (2026-07-03): for a live notice
 * (a4be592da0304872a252980925b9458f) the CSV index's naics/PoP EQUAL what
 * `sam_get_opportunity` (detail) returns — naics 238990, PoP WA / Hoodsport /
 * 98548 all match; setAsideCode 'SBA' equals detail's mapped setAside 'SBA'.
 *
 * The non-negotiable design constraints
 * -------------------------------------
 *   1. OFF BY DEFAULT. No forced 225 MB download. Enabled only via env
 *      (`SAM_GOV_CSV_CACHE` = a cache dir, or `SAM_GOV_ENABLE_CSV=1` to use a
 *      default dir under the OS temp). Every EXISTING keyless HAL tool is
 *      UNCHANGED.
 *   2. BOUNDED RAM. Never hold the 225 MB in memory. Stream the download to a
 *      cache FILE on disk. Build a COMPACT index of only the ~11 needed columns
 *      (NOT Description@46), keyed by NoticeId (~24 MB for this snapshot's
 *      ~78k rows, verified). Persist the compact index to the cache dir and
 *      load THAT into a Map; refresh when > 24 h old or the CSV `last-modified`
 *      changed.
 *   3. STREAMING RFC-4180 parser, NO new npm dependency. Fields are quoted and
 *      some (Title, addresses) embed commas; a state machine handles the
 *      in-quote toggle, `""`→`"` escape, and newlines inside quotes. Since we
 *      skip Description@46 (the worst offender) we only parse through column 24.
 *   4. TRUTHFUL `_meta` (the product): honest source, freshness (CSV
 *      last-modified + index build time), degraded on download/parse failure
 *      (never a silent empty), and per-noticeId a notice ABSENT from the
 *      current snapshot → `found:false` + nulls + an explicit "not in current
 *      CSV snapshot" disclosure, NEVER faked. DISABLED → a structured note
 *      explaining how to enable it (not an error, not fake data). A cold-cache
 *      first call that triggers the download is slow → disclosed as "warming".
 */
/** The GSA daily bulk CSV (keyless). Space in the path is URL-encoded. */
export declare const GSA_CSV_URL = "https://falextracts.s3.amazonaws.com/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv";
export declare const GSA_CSV_SOURCE = "gsa.gov daily bulk CSV (keyless)";
/** Max noticeIds accepted per batch (completes a `sam_search_opportunities` page). */
export declare const MAX_NOTICE_IDS = 100;
/**
 * Resolve the opt-in config from the environment.
 *
 * Enablement (in priority order):
 *   - `SAM_GOV_CSV_FIXTURE` = path to a LOCAL CSV file → enabled, no network
 *     (used by tests and for pinning a pre-downloaded file). The cache dir
 *     defaults next to the fixture unless `SAM_GOV_CSV_CACHE` is also set.
 *   - `SAM_GOV_CSV_CACHE` = a cache DIRECTORY path → enabled; downloads live.
 *   - `SAM_GOV_ENABLE_CSV` truthy (`1`/`true`/`yes`) → enabled with a default
 *     cache dir under the OS temp (`<tmp>/mcp-sam-gov-csv`).
 *   - otherwise DISABLED (default) — the backbone never touches the network.
 */
export type CsvConfig = {
    enabled: boolean;
    cacheDir: string;
    /** A local CSV to index instead of downloading (tests / pinned file). */
    fixturePath: string | null;
};
export declare function resolveCsvConfig(env?: NodeJS.ProcessEnv): CsvConfig;
/**
 * Parse one LOGICAL CSV record's text into fields 0..maxCol (inclusive).
 *
 * A proper state machine (NOT `split(",")`): tracks an in-quote toggle, turns
 * `""` into a single `"`, and treats commas/CR/quotes literally while inside a
 * quoted field. It also reports whether parsing ended INSIDE an open quote —
 * the record-assembler uses that to know a physical newline fell inside a
 * quoted field and the logical record continues on the next line.
 *
 * CRITICAL — we must scan the WHOLE text to get quote parity right, even though
 * we only KEEP fields up to `maxCol`. Once we're past `maxCol` we stop STORING
 * fields (so the giant Description@46 is never materialized — bounded memory),
 * but we KEEP walking the characters to maintain the in-quote toggle. Early-
 * returning at `maxCol` would misjudge a newline that falls inside a LATER
 * quoted field (e.g. an embedded newline in Description@46): the record would
 * be wrongly treated as complete and the field's tail would corrupt the next
 * record. (This was a real bug — the fix is: cap storage, never cap scanning.)
 */
export declare function parseRecordFields(text: string, maxCol?: number): {
    fields: string[];
    inQuotes: boolean;
};
/** The compact per-notice record we keep in the index (NOT Description). */
export type NoticeFields = {
    title: string;
    type: string;
    setAsideCode: string;
    setAside: string;
    responseDeadline: string;
    naicsCode: string;
    popCity: string;
    popState: string;
    popZip: string;
    popCountry: string;
    active: string;
};
/** TEST-ONLY: drop the process-lifetime memo so a test can re-point the env. */
export declare function _resetIndexForTests(): void;
export type LookupResult = {
    noticeId: string;
    found: boolean;
    naicsCode: string | null;
    setAside: string | null;
    setAsideCode: string | null;
    popState: string | null;
    popCity: string | null;
    popZip: string | null;
    popCountry: string | null;
    responseDeadline: string | null;
    type: string | null;
    active: boolean | null;
    title: string | null;
};
/**
 * BATCH keyless enrichment: for each 32-hex noticeId return the HAL-nulled
 * fields (naics / setAside / place-of-performance / responseDeadline / type /
 * active / title) from the cached GSA CSV index — completing a whole
 * `sam_search_opportunities` page in ONE call.
 *
 * Honesty contract (the product):
 *   - DISABLED (default) → `data.enabled:false`, every row `found:false`+nulls,
 *     and `_meta.notes` explains how to enable the backbone. NOT an error, NOT
 *     fake data.
 *   - a noticeId ABSENT from the current snapshot → `found:false` + nulls + a
 *     disclosure that it is "not in the current CSV snapshot", NEVER faked.
 *   - download/parse failure → `degraded` (a structured error is thrown and
 *     surfaced by the server as a retryable envelope) — never a silent empty.
 *   - `_meta.freshness` carries the CSV `last-modified` + the index build time
 *     so the AI knows how stale the snapshot is; a cold-cache first call that
 *     triggered the download is disclosed as "warming".
 */
export declare function lookupNoticeFields(args: {
    noticeIds: string[];
}, env?: NodeJS.ProcessEnv): Promise<import("./meta.js").MetaBundle<{
    results: LookupResult[];
    enabled: boolean;
    freshness: null;
}> | import("./meta.js").MetaBundle<{
    results: LookupResult[];
    enabled: boolean;
    freshness: {
        csvLastModified: string | null;
        indexBuiltAt: string;
        indexAgeHours: number | null;
        rowCount: number;
        warming: boolean;
    };
    foundCount: number;
    missingCount: number;
}>>;
//# sourceMappingURL=gsa-csv.d.ts.map