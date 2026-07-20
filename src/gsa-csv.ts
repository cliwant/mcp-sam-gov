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

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
import { driftError } from "./datasource.js";
import { withMeta } from "./meta.js";

// ─── Source + config ─────────────────────────────────────────────

/** The GSA daily bulk CSV (keyless). Space in the path is URL-encoded. */
export const GSA_CSV_URL =
  "https://falextracts.s3.amazonaws.com/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv";

export const GSA_CSV_SOURCE = "gsa.gov daily bulk CSV (keyless)";

/** Max noticeIds accepted per batch (completes a `sam_search_opportunities` page). */
export const MAX_NOTICE_IDS = 100;

/** Refresh the cached index when it is older than this (or last-modified drifts). */
const INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

/** File names inside the cache dir. */
const RAW_CSV_FILE = "gsa-opportunities.csv";
const INDEX_FILE = "gsa-notice-index.json";

/**
 * 0-indexed CSV columns we keep. Description@46 is deliberately SKIPPED (it is
 * the largest field by far and the worst quoting offender — skipping it both
 * caps the index size AND means the streaming parser only has to parse cleanly
 * through column 24 (Active)).
 */
const COL = {
  NoticeId: 0,
  Title: 1,
  Type: 10,
  SetASideCode: 14,
  SetASide: 15,
  ResponseDeadLine: 16,
  NaicsCode: 17,
  PopCity: 20,
  PopState: 21,
  PopZip: 22,
  PopCountry: 23,
  Active: 24,
} as const;

/** Highest column index we need — we can stop parsing a record after this. */
const MAX_COL = COL.Active; // 24

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

export function resolveCsvConfig(env: NodeJS.ProcessEnv = process.env): CsvConfig {
  const fixture = env.SAM_GOV_CSV_FIXTURE?.trim() || null;
  const cacheEnv = env.SAM_GOV_CSV_CACHE?.trim() || null;
  const enableFlag = /^(1|true|yes|on)$/i.test(env.SAM_GOV_ENABLE_CSV?.trim() ?? "");

  if (fixture) {
    return {
      enabled: true,
      cacheDir: cacheEnv ?? path.join(path.dirname(fixture), ".mcp-sam-gov-csv-cache"),
      fixturePath: fixture,
    };
  }
  if (cacheEnv) {
    return { enabled: true, cacheDir: cacheEnv, fixturePath: null };
  }
  if (enableFlag) {
    return {
      enabled: true,
      cacheDir: path.join(os.tmpdir(), "mcp-sam-gov-csv"),
      fixturePath: null,
    };
  }
  return { enabled: false, cacheDir: "", fixturePath: null };
}

// ─── Streaming RFC-4180 parser ───────────────────────────────────

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
export function parseRecordFields(
  text: string,
  maxCol: number = MAX_COL,
): { fields: string[]; inQuotes: boolean } {
  const fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let col = 0;
  const keeping = () => col <= maxCol;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          if (keeping()) field += '"';
          i++; // consume the escaped quote
        } else {
          inQuotes = false;
        }
      } else if (keeping()) {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        if (keeping()) fields.push(field);
        field = "";
        col++;
      } else if (c === "\r") {
        // Strip stray CR (records are assembled by \n; CRLF → LF handled here).
      } else if (keeping()) {
        field += c;
      }
    }
  }
  if (keeping()) fields.push(field);
  return { fields, inQuotes };
}

/**
 * Assemble physical lines (from readline) into LOGICAL records, correctly
 * re-joining a record whose quoted field contained a newline. Calls `onRecord`
 * with the parsed fields (0..MAX_COL) of each complete logical record.
 */
function makeRecordAssembler(onRecord: (fields: string[]) => void) {
  let pending: string | null = null;
  return {
    push(line: string) {
      const candidate = pending === null ? line : pending + "\n" + line;
      const res = parseRecordFields(candidate, MAX_COL);
      if (res.inQuotes) {
        // Newline fell inside a quoted field → keep accumulating.
        pending = candidate;
        return;
      }
      pending = null;
      onRecord(res.fields);
    },
    flush() {
      if (pending !== null) {
        const res = parseRecordFields(pending, MAX_COL);
        onRecord(res.fields);
        pending = null;
      }
    },
  };
}

// ─── Compact index ───────────────────────────────────────────────

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

/** The persisted index file shape. */
type PersistedIndex = {
  builtAt: string; // ISO — when we built the compact index
  csvLastModified: string | null; // the CSV `last-modified` at download time
  csvBytes: number | null;
  rowCount: number;
  notices: Record<string, NoticeFields>;
};

/** In-memory loaded index (a Map for O(1) lookup) + its freshness metadata. */
type LoadedIndex = {
  map: Map<string, NoticeFields>;
  builtAt: string;
  csvLastModified: string | null;
  csvBytes: number | null;
  rowCount: number;
};

const EMPTY_FIELDS: NoticeFields = {
  title: "",
  type: "",
  setAsideCode: "",
  setAside: "",
  responseDeadline: "",
  naicsCode: "",
  popCity: "",
  popState: "",
  popZip: "",
  popCountry: "",
  active: "",
};

/** Build a compact NoticeFields from a parsed record's field array. */
function fieldsFromRecord(rec: string[]): NoticeFields {
  return {
    title: rec[COL.Title] ?? "",
    type: rec[COL.Type] ?? "",
    setAsideCode: rec[COL.SetASideCode] ?? "",
    setAside: rec[COL.SetASide] ?? "",
    responseDeadline: rec[COL.ResponseDeadLine] ?? "",
    naicsCode: rec[COL.NaicsCode] ?? "",
    popCity: rec[COL.PopCity] ?? "",
    popState: rec[COL.PopState] ?? "",
    popZip: rec[COL.PopZip] ?? "",
    popCountry: rec[COL.PopCountry] ?? "",
    active: rec[COL.Active] ?? "",
  };
}

/**
 * Stream a CSV file on disk line-by-line and build the compact index. NEVER
 * loads the whole file into memory — readline yields one physical line at a
 * time and the assembler holds at most one in-progress (quote-spanning) record.
 */
export async function buildIndexFromFile(
  csvPath: string,
): Promise<{ notices: Record<string, NoticeFields>; rowCount: number }> {
  const notices: Record<string, NoticeFields> = Object.create(null);
  let headerSeen = false;
  let rowCount = 0;

  const stream = createReadStream(csvPath, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const asm = makeRecordAssembler((rec) => {
    if (!headerSeen) {
      headerSeen = true; // first logical record is the 47-column header
      // [P4] The column contract is POSITIONAL (fixed COL indices). If GSA
      // reorders / inserts / renames a column, trusting the old positions would
      // serve WRONG-POSITION data as authoritative (or, if NoticeId shifts, skip
      // every row → a false "not in the current CSV snapshot"). Neither throws
      // today. Assert the expected header NAME at each COL index before indexing
      // any data row — a mismatch is schema drift, never a fake-empty (mirrors the
      // census-economic.ts header guard). Each COL key IS its expected header name.
      for (const [expectedName, idx] of Object.entries(COL)) {
        const got = (rec[idx] ?? "").trim();
        if (got !== expectedName) {
          throw driftError(
            "gsa:csv",
            `GSA Contract-Opportunities CSV header drift — column ${idx} is ${JSON.stringify(got)}, expected ${JSON.stringify(expectedName)}. The positional column contract changed; refusing to index (a silent column shift would serve wrong-position data as authoritative, or skip every row as a false "not in the current snapshot").`,
          );
        }
      }
      return;
    }
    rowCount++;
    const noticeId = (rec[COL.NoticeId] ?? "").trim();
    // Only index a well-formed 32-hex NoticeId (equals the HAL `_id`). A
    // malformed key would never match a real lookup — skip it.
    if (!/^[0-9a-f]{32}$/i.test(noticeId)) return;
    notices[noticeId.toLowerCase()] = fieldsFromRecord(rec);
  });

  try {
    for await (const line of rl) asm.push(line);
    asm.flush();
  } finally {
    // Release the OS file handle on ALL exit paths (including the header-drift
    // throw, which aborts mid-stream). Windows holds a lock on an open read
    // stream, so a caller deleting the file right after a throw hits
    // ENOTEMPTY/EBUSY unless the handle is closed here first.
    rl.close();
    stream.destroy();
  }

  return { notices, rowCount };
}

// ─── Download + refresh ──────────────────────────────────────────

/** HEAD the CSV to read `last-modified` + size without downloading the body. */
async function headCsv(): Promise<{ lastModified: string | null; bytes: number | null }> {
  try {
    const r = await fetchWithRetry(
      GSA_CSV_URL,
      { method: "HEAD", signal: AbortSignal.timeout(15_000) },
      "gsa:csv:head",
    );
    const len = r.headers.get("content-length");
    return {
      lastModified: r.headers.get("last-modified"),
      bytes: len ? Number(len) : null,
    };
  } catch {
    // A HEAD failure is non-fatal for staleness checks — treat as "unknown".
    return { lastModified: null, bytes: null };
  }
}

/**
 * Stream the 225 MB CSV to a file on disk (bounded RAM — the body is piped
 * straight to a write stream, never buffered). Downloads to a `.tmp` then
 * atomically renames so a crashed download never leaves a truncated cache file.
 */
async function downloadCsvToDisk(cacheDir: string): Promise<{ path: string; bytes: number }> {
  await mkdir(cacheDir, { recursive: true });
  const finalPath = path.join(cacheDir, RAW_CSV_FILE);
  const tmpPath = finalPath + ".tmp";
  const r = await fetchWithRetry(
    GSA_CSV_URL,
    { signal: AbortSignal.timeout(180_000) },
    "gsa:csv:download",
  );
  if (!r.body) {
    throw new ToolErrorCarrier({
      kind: "upstream_unavailable",
      message: "GSA CSV download returned no response body.",
      retryable: true,
      upstreamEndpoint: "gsa:csv:download",
    });
  }
  // `r.body` is a web ReadableStream — pipeline accepts it directly on Node 20+.
  await pipeline(
    r.body as unknown as NodeJS.ReadableStream,
    createWriteStream(tmpPath),
  );
  await rename(tmpPath, finalPath);
  const st = await stat(finalPath);
  return { path: finalPath, bytes: st.size };
}

/** Read a persisted index file, or null if absent/unreadable/corrupt. */
async function readPersistedIndex(cacheDir: string): Promise<PersistedIndex | null> {
  try {
    const raw = await readFile(path.join(cacheDir, INDEX_FILE), "utf8");
    const parsed = JSON.parse(raw) as PersistedIndex;
    if (!parsed || typeof parsed !== "object" || !parsed.notices) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Persist the compact index atomically (`.tmp` + rename). */
async function writePersistedIndex(cacheDir: string, idx: PersistedIndex): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const finalPath = path.join(cacheDir, INDEX_FILE);
  const tmpPath = finalPath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(idx), "utf8");
  await rename(tmpPath, finalPath);
}

// Process-lifetime memo of the loaded index + an in-flight refresh guard so
// concurrent tool calls don't each trigger a 225 MB download.
let loaded: LoadedIndex | null = null;
let refreshInFlight: Promise<{ index: LoadedIndex; warmed: boolean }> | null = null;

/** Is a persisted index stale (older than TTL, or CSV last-modified drifted)? */
function isStale(idx: PersistedIndex, head: { lastModified: string | null }): boolean {
  const ageMs = Date.now() - new Date(idx.builtAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > INDEX_TTL_MS) return true;
  if (
    head.lastModified &&
    idx.csvLastModified &&
    head.lastModified !== idx.csvLastModified
  ) {
    return true;
  }
  return false;
}

function toLoaded(idx: PersistedIndex): LoadedIndex {
  return {
    map: new Map(Object.entries(idx.notices)),
    builtAt: idx.builtAt,
    csvLastModified: idx.csvLastModified,
    csvBytes: idx.csvBytes,
    rowCount: idx.rowCount,
  };
}

/**
 * Ensure a fresh index is loaded, (re)building from a fixture or a fresh
 * download as needed. Returns the loaded index and whether THIS call warmed
 * the cache (i.e. paid the slow download/build) so the tool can disclose it.
 *
 * Concurrency: a single in-flight refresh is shared across callers.
 */
async function ensureIndex(cfg: CsvConfig): Promise<{ index: LoadedIndex; warmed: boolean }> {
  // ── Fixture mode: index the local file (no network, no staleness/HEAD). ──
  if (cfg.fixturePath) {
    if (loaded) return { index: loaded, warmed: false };
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const st = await stat(cfg.fixturePath as string).catch(() => {
        throw new ToolErrorCarrier({
          kind: "not_found",
          message: `SAM_GOV_CSV_FIXTURE points at a file that does not exist: ${cfg.fixturePath}`,
          retryable: false,
          upstreamEndpoint: "gsa:csv:fixture",
        });
      });
      const { notices, rowCount } = await buildIndexFromFile(cfg.fixturePath as string);
      const persisted: PersistedIndex = {
        builtAt: new Date().toISOString(),
        csvLastModified: st.mtime.toUTCString(),
        csvBytes: st.size,
        rowCount,
        notices,
      };
      loaded = toLoaded(persisted);
      return { index: loaded, warmed: true };
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  // ── Download mode: reuse a fresh persisted/loaded index; else refresh. ──
  // Fast path: an in-memory index that isn't past its TTL (skip the HEAD).
  if (loaded && Date.now() - new Date(loaded.builtAt).getTime() <= INDEX_TTL_MS) {
    return { index: loaded, warmed: false };
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const head = await headCsv();

    // Try the on-disk persisted index first.
    const persisted = await readPersistedIndex(cfg.cacheDir);
    if (persisted && !isStale(persisted, head)) {
      loaded = toLoaded(persisted);
      return { index: loaded, warmed: false };
    }

    // Stale or missing → download + rebuild (the slow, disclosed path).
    const { path: csvPath, bytes } = await downloadCsvToDisk(cfg.cacheDir);
    const { notices, rowCount } = await buildIndexFromFile(csvPath);
    const fresh: PersistedIndex = {
      builtAt: new Date().toISOString(),
      csvLastModified: head.lastModified,
      csvBytes: head.bytes ?? bytes,
      rowCount,
      notices,
    };
    await writePersistedIndex(cfg.cacheDir, fresh).catch(() => {
      // A failed persist is non-fatal — we still serve the in-memory index this
      // process; it just won't survive a restart. Don't throw.
    });
    loaded = toLoaded(fresh);
    return { index: loaded, warmed: true };
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/** TEST-ONLY: drop the process-lifetime memo so a test can re-point the env. */
export function _resetIndexForTests(): void {
  loaded = null;
  refreshInFlight = null;
}

// ─── Non-blocking accessor (for inline search enrichment) ────────
//
// `sam_search_opportunities` must stay fast: it must NEVER pay a synchronous
// 225 MB download to enrich a page. This accessor returns the ALREADY-loaded/
// fresh index if one is in memory, else returns null IMMEDIATELY — optionally
// kicking off a background refresh (fire-and-forget) so a LATER search can
// enrich once the cache warms. It never awaits I/O on the hot path.

/** A read-only view of a loaded index for enrichment consumers. */
export type ReadyIndex = {
  get(noticeId: string): NoticeFields | undefined;
  csvLastModified: string | null;
  indexBuiltAt: string;
  rowCount: number;
};

/** Wrap a LoadedIndex as the read-only ReadyIndex the enrichment path uses. */
function toReady(idx: LoadedIndex): ReadyIndex {
  return {
    get: (noticeId: string) => idx.map.get((noticeId ?? "").trim().toLowerCase()),
    csvLastModified: idx.csvLastModified,
    indexBuiltAt: idx.builtAt,
    rowCount: idx.rowCount,
  };
}

/**
 * NON-BLOCKING: return a ready CSV index if one is loaded + fresh, else null.
 *
 * Guarantees for the search hot-path:
 *   - Disabled config → null (no work, no network) — caller skips enrichment.
 *   - An in-memory index within its TTL → returned synchronously (no HEAD, no
 *     download).
 *   - No in-memory index (cold) → returns null IMMEDIATELY and, unless a
 *     refresh is already in flight, kicks off a background `ensureIndex` (its
 *     result is memoized into `loaded` for a subsequent call). The promise is
 *     deliberately NOT awaited here and its rejection is swallowed so a failed
 *     warm never surfaces on the search path.
 *   - An in-memory index PAST its TTL → still returned (stale-but-usable) while
 *     a background refresh is kicked off; the caller discloses the age via
 *     freshness so a slightly-stale snapshot is honest, never a stall.
 *
 * This never throws — any misconfiguration or I/O error degrades to null.
 */
export function tryGetReadyIndex(
  cfg: CsvConfig = resolveCsvConfig(),
): ReadyIndex | null {
  try {
    if (!cfg.enabled) return null;

    if (loaded) {
      const ageMs = Date.now() - new Date(loaded.builtAt).getTime();
      // Past TTL (download mode only — a fixture never expires): serve the
      // stale index now, refresh in the background for next time.
      if (!cfg.fixturePath && (!Number.isFinite(ageMs) || ageMs > INDEX_TTL_MS)) {
        kickBackgroundRefresh(cfg);
      }
      return toReady(loaded);
    }

    // Cold: nothing loaded yet — never block the search. Warm in the
    // background and return null so this call proceeds un-enriched.
    kickBackgroundRefresh(cfg);
    return null;
  } catch {
    return null;
  }
}

/** Fire-and-forget a single shared refresh; swallow errors (never block/throw). */
function kickBackgroundRefresh(cfg: CsvConfig): void {
  if (refreshInFlight) return;
  // ensureIndex sets/reuses `refreshInFlight` itself; we just make sure its
  // rejection is handled so an unhandledRejection never escapes the warm.
  void ensureIndex(cfg).catch(() => {
    /* a failed background warm is non-fatal — the next call retries */
  });
}

// ─── Inline enrichment merge (used by sam_search_opportunities) ──
//
// Pure, testable merge: given the keyless HAL search page (whose
// naics/setAside/PoP/deadline/type are null) and a ready CSV index, fill the
// null fields from the CSV snapshot and report EXACTLY what changed so the
// caller can rebuild `_meta` truthfully. Notices absent from the snapshot are
// left untouched and counted. Never fabricates: only null→value, only for a
// noticeId present in the index.

/** One opportunity row as emitted by the keyless sam_search handler. */
export type SearchOppRow = {
  noticeId: string;
  title?: string | null;
  agency?: string | null;
  solicitationNumber?: string | null;
  responseDeadline?: string | null;
  naics?: string | null;
  setAside?: string | null;
  uiLink?: string | null;
  // Enrichment MAY add these (absent on the un-enriched/disabled shape):
  type?: string | null;
  placeOfPerformance?: SamCsvPlaceOfPerformance | null;
  [k: string]: unknown;
};

/** Place-of-performance shape composed from the CSV Pop* columns. */
export type SamCsvPlaceOfPerformance = {
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
};

export type EnrichmentOutcome = {
  /** The page with null fields filled from the CSV where the notice was found. */
  opportunities: SearchOppRow[];
  /** Notices in the page that were present in the CSV snapshot. */
  foundCount: number;
  /** Notices in the page absent from the CSV snapshot (left un-enriched). */
  missingCount: number;
  /** Union of field names filled on ≥1 row (subset of naics/setAside/… ). */
  fieldsFilled: Set<string>;
  /** Snapshot freshness, mirrored into data + _meta by the caller. */
  freshness: {
    csvLastModified: string | null;
    indexBuiltAt: string;
    indexAgeHours: number | null;
    rowCount: number;
  };
};

/** Compose a CSV place-of-performance, or null when every Pop* cell is empty. */
function popFromFields(f: NoticeFields): SamCsvPlaceOfPerformance | null {
  const city = nn(f.popCity);
  const state = nn(f.popState);
  const zip = nn(f.popZip);
  const country = nn(f.popCountry);
  if (city === null && state === null && zip === null && country === null) {
    return null;
  }
  return { city, state, zip, country };
}

/**
 * Fill the keyless search page's null naics/setAside/placeOfPerformance (and
 * responseDeadline/type when currently null) from the ready CSV index.
 *
 * Rules (honesty):
 *   - Only a null field is filled — a value already present (e.g. keyed mode,
 *     or a HAL row that carried the value) is NEVER overwritten.
 *   - A field is filled only when the CSV cell is a real non-empty value (an
 *     empty CSV cell stays null — absence ≠ empty).
 *   - `type`/`placeOfPerformance` keys are ADDED only when a value is actually
 *     filled from the CSV, so a not-in-snapshot row keeps the exact original
 *     shape (no spurious null keys).
 *   - A noticeId absent from the snapshot is left byte-identical + counted.
 */
export function enrichSearchOpportunities(
  opportunities: SearchOppRow[],
  index: ReadyIndex,
): EnrichmentOutcome {
  const fieldsFilled = new Set<string>();
  let foundCount = 0;
  let missingCount = 0;

  const enriched = opportunities.map((row) => {
    const rec = index.get(row.noticeId);
    if (!rec) {
      missingCount++;
      return row; // absent from snapshot — untouched, disclosed via counts
    }
    foundCount++;
    const out: SearchOppRow = { ...row };

    // naics — fill only if currently null/absent.
    if (out.naics == null) {
      const v = nn(rec.naicsCode);
      if (v !== null) {
        out.naics = v;
        fieldsFilled.add("naics");
      }
    }
    // setAside — the keyless HAL nulls typeOfSetAside; the CSV's short code
    // (e.g. 'SBA') is the value that matches sam_get_opportunity's setAside.
    if (out.setAside == null) {
      const v = nn(rec.setAsideCode);
      if (v !== null) {
        out.setAside = v;
        fieldsFilled.add("setAside");
      }
    }
    // responseDeadline — fill only if currently null.
    if (out.responseDeadline == null) {
      const v = nn(rec.responseDeadline);
      if (v !== null) {
        out.responseDeadline = v;
        fieldsFilled.add("responseDeadline");
      }
    }
    // type — add the key only when the CSV has a real value.
    if (out.type == null) {
      const v = nn(rec.type);
      if (v !== null) {
        out.type = v;
        fieldsFilled.add("type");
      }
    }
    // placeOfPerformance — add the key only when ≥1 Pop* cell is populated.
    if (out.placeOfPerformance == null) {
      const pop = popFromFields(rec);
      if (pop !== null) {
        out.placeOfPerformance = pop;
        fieldsFilled.add("placeOfPerformance");
      }
    }
    return out;
  });

  const builtAtMs = new Date(index.indexBuiltAt).getTime();
  const indexAgeHours = Number.isFinite(builtAtMs)
    ? Math.round(((Date.now() - builtAtMs) / 3_600_000) * 10) / 10
    : null;

  return {
    opportunities: enriched,
    foundCount,
    missingCount,
    fieldsFilled,
    freshness: {
      csvLastModified: index.csvLastModified,
      indexBuiltAt: index.indexBuiltAt,
      indexAgeHours,
      rowCount: index.rowCount,
    },
  };
}

// ─── The tool: sam_lookup_notice_fields ──────────────────────────

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

/** Map an empty-string CSV cell to null (an absent value ≠ a real empty). */
function nn(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}

/** CSV Active is "Yes"/"No" — normalize to a boolean, null if neither. */
function activeBool(s: string): boolean | null {
  const t = s.trim().toLowerCase();
  if (t === "yes") return true;
  if (t === "no") return false;
  return null;
}

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
export async function lookupNoticeFields(
  args: { noticeIds: string[] },
  env: NodeJS.ProcessEnv = process.env,
) {
  const requested = Array.isArray(args.noticeIds) ? args.noticeIds : [];
  // Normalize + validate the batch. Cap at MAX_NOTICE_IDS.
  if (requested.length === 0) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: "sam_lookup_notice_fields requires a non-empty noticeIds array (1..100).",
      retryable: false,
      upstreamEndpoint: "gsa:csv:lookup",
    });
  }
  if (requested.length > MAX_NOTICE_IDS) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `sam_lookup_notice_fields accepts at most ${MAX_NOTICE_IDS} noticeIds per call (got ${requested.length}). Split the page into batches.`,
      retryable: false,
      upstreamEndpoint: "gsa:csv:lookup",
    });
  }

  const cfg = resolveCsvConfig(env);

  // ── DISABLED (default): a structured "how to enable" note, never fake data. ──
  if (!cfg.enabled) {
    const results: LookupResult[] = requested.map((id) => ({
      noticeId: id,
      found: false,
      naicsCode: null,
      setAside: null,
      setAsideCode: null,
      popState: null,
      popCity: null,
      popZip: null,
      popCountry: null,
      responseDeadline: null,
      type: null,
      active: null,
      title: null,
    }));
    return withMeta(
      { results, enabled: false, freshness: null },
      {
        source: GSA_CSV_SOURCE,
        keylessMode: true,
        complete: false,
        truncated: false,
        returned: results.length,
        totalAvailable: null,
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: [
          "naicsCode",
          "setAside",
          "setAsideCode",
          "popState",
          "popCity",
          "popZip",
          "popCountry",
          "responseDeadline",
          "type",
          "active",
          "title",
        ],
        notes: [
          "The GSA daily-CSV keyless backbone is DISABLED (default). No data was looked up and NO network download occurred — every result is found:false with null fields (this is NOT 'not found', it means the backbone is off).",
          "To enable it, set the env var SAM_GOV_CSV_CACHE to a writable cache-directory path (e.g. SAM_GOV_CSV_CACHE=/var/cache/mcp-sam-gov), OR set SAM_GOV_ENABLE_CSV=1 to use a default cache dir under the OS temp. On first use (and each daily refresh) the server streams the ~226 MB GSA CSV to disk once and builds a compact on-disk index (~24 MB) — subsequent lookups are instant.",
          "Until enabled, complete a sam_search_opportunities page by calling sam_get_opportunity per noticeId (one detail call each) to read naics/setAside/place-of-performance/deadline/type.",
        ],
      },
    );
  }

  // ── ENABLED: ensure the index, then batch-look-up. ──
  // A download/parse failure throws a classified ToolErrorCarrier (retryable) —
  // the server surfaces it as { ok:false, error } rather than a silent empty.
  let index: LoadedIndex;
  let warmed: boolean;
  try {
    const r = await ensureIndex(cfg);
    index = r.index;
    warmed = r.warmed;
  } catch (e) {
    if (e instanceof ToolErrorCarrier) throw e;
    throw new ToolErrorCarrier({
      kind: "upstream_unavailable",
      message: `GSA CSV backbone failed to build its index: ${(e as Error).message}. The 225 MB CSV download or parse did not complete; retry (the cache may warm on a subsequent call).`,
      retryable: true,
      upstreamEndpoint: "gsa:csv:index",
    });
  }

  let foundCount = 0;
  let missingCount = 0;
  const results: LookupResult[] = requested.map((rawId) => {
    const key = (rawId ?? "").trim().toLowerCase();
    const rec = /^[0-9a-f]{32}$/i.test(key) ? index.map.get(key) : undefined;
    const f = rec ?? EMPTY_FIELDS;
    const found = rec !== undefined;
    if (found) foundCount++;
    else missingCount++;
    return {
      noticeId: rawId,
      found,
      naicsCode: found ? nn(f.naicsCode) : null,
      setAside: found ? nn(f.setAside) : null,
      setAsideCode: found ? nn(f.setAsideCode) : null,
      popState: found ? nn(f.popState) : null,
      popCity: found ? nn(f.popCity) : null,
      popZip: found ? nn(f.popZip) : null,
      popCountry: found ? nn(f.popCountry) : null,
      responseDeadline: found ? nn(f.responseDeadline) : null,
      type: found ? nn(f.type) : null,
      active: found ? activeBool(f.active) : null,
      title: found ? nn(f.title) : null,
    };
  });

  const notes: string[] = [];
  notes.push(
    `Enrichment fields are read from the GSA daily bulk CSV snapshot (keyless), keyed by NoticeId. Snapshot last-modified: ${index.csvLastModified ?? "unknown"}; index built: ${index.builtAt} from ${index.rowCount.toLocaleString()} CSV rows.`,
  );
  if (warmed) {
    notes.push(
      "CSV index WARMING (first call this process / daily refresh): the ~226 MB CSV was just streamed to disk and indexed, so THIS call was slow (tens of seconds). Subsequent calls hit the cached on-disk index and return instantly until the daily refresh.",
    );
  }
  notes.push(
    "setAside is the CSV's human-readable label (e.g. 'Total Small Business Set-Aside (FAR 19.5)'); setAsideCode is the short code (e.g. 'SBA', '8A') that matches sam_get_opportunity's setAside. type is the CSV's procedure-type label (e.g. 'Solicitation', 'Combined Synopsis/Solicitation').",
  );
  if (missingCount > 0) {
    notes.push(
      `${missingCount} of ${requested.length} requested noticeId(s) were NOT in the current CSV snapshot (found:false + null fields) — a snapshot is a point-in-time daily file, so a very new notice (posted after the snapshot) or one dropped from the extract will be absent. This is an explicit "not in current CSV snapshot" disclosure, NOT fabricated data; fall back to sam_get_opportunity for those noticeIds.`,
    );
  }
  notes.push(
    "The CSV snapshot can lag the live HAL by up to ~24 h; for a field that must be real-time (e.g. a deadline just amended), confirm with sam_get_opportunity.",
  );

  // Machine-readable freshness object mirrored into `data` (the ResponseMeta
  // type has no typed `freshness` field, and meta.ts is out of scope to change,
  // so we surface freshness structurally here AND in _meta.notes for the AI).
  const builtAtMs = new Date(index.builtAt).getTime();
  const ageHours = Number.isFinite(builtAtMs)
    ? Math.round(((Date.now() - builtAtMs) / 3_600_000) * 10) / 10
    : null;
  const freshness = {
    csvLastModified: index.csvLastModified,
    indexBuiltAt: index.builtAt,
    indexAgeHours: ageHours,
    rowCount: index.rowCount,
    warming: warmed,
  };

  return withMeta(
    { results, enabled: true, freshness, foundCount, missingCount },
    {
      source: GSA_CSV_SOURCE,
      keylessMode: true,
      // A batch lookup against a known snapshot is "complete" for the ids asked
      // — there is no pagination and nothing was truncated/dropped. Absent ids
      // are disclosed per-row (found:false) + in notes, not via truncation.
      complete: true,
      truncated: false,
      returned: results.length,
      totalAvailable: results.length,
      filtersApplied: ["noticeIds(exact, CSV index)"],
      filtersDropped: [],
      fieldsUnavailable: [],
      notes,
    },
  );
}
