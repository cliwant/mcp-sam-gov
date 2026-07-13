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
import { fetchWithRetry, ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { throughGate, driftError } from "./datasource.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
// ─── Hosts + the mandatory User-Agent (F1) ────────────────────────
const SUBMISSIONS_BASE = "https://data.sec.gov/submissions";
const XBRL_FACTS_BASE = "https://data.sec.gov/api/xbrl/companyfacts";
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const FTS_URL = "https://efts.sec.gov/LATEST/search-index";
const ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data";
/**
 * The descriptive User-Agent SEC mandates on every request (Policy①). Default is
 * an ORG contact on the project domain — live-verified 200 (F1). It must NOT
 * contain `github.com` (SEC 403s that on all 3 hosts) and must NOT be a personal
 * email. Operators override with the `EDGAR_USER_AGENT` env var (SEC's suggested
 * form: "Sample Company AdminContact@example.com").
 */
const EDGAR_UA = process.env.EDGAR_USER_AGENT ??
    "cliwant-mcp-sam-gov/1.0 (contact: opendata@cliwant.com)";
const EDGAR_HEADERS = {
    "User-Agent": EDGAR_UA,
    "Accept-Encoding": "gzip",
};
const EDGAR_SOURCE = "data.sec.gov / efts.sec.gov (keyless)";
const EDGAR_FIELDS_UNAVAILABLE = ["uei", "duns", "sam_recipient_id"];
const CIK_UEI_CAVEAT = "EDGAR identifies filers by 10-digit SEC CIK, NOT SAM UEI/DUNS or a USAspending recipient id. There is no reliable programmatic CIK↔UEI join — bridging an EDGAR filer to a federal contracting entity is name/ticker-only (fuzzy) and must NOT be treated as authoritative.";
// ─── Min-interval gate (self-throttle ≤10 req/s) ──────────────────
// A tool call can fan out (lookup→submissions), and the process may run many
// tools; serialize EVERY EDGAR fetch through one promise chain with a ≥110ms
// spacing (~9 req/s < the 10 req/s ceiling → no ~10-min block). The chain +
// spacing math now live in the shared `throughGate("edgar", 110, fn)` primitive
// (datasource.ts, ADR-0011 R2 deferred slice) — same single-chain, same
// lastAt-stamped-before-fn, same bare-`setTimeout` global (so the fault tests'
// timer-neutralizing patch keeps it instant offline). Behavior is byte-identical
// to the former module singleton this replaced.
const EDGAR_MIN_INTERVAL_MS = 110;
// ─── fetch layer ──────────────────────────────────────────────────
/**
 * GET one EDGAR resource with the mandatory UA (+ gzip) and a 15s timeout,
 * serialized through the min-interval gate. Reuses errors.ts for the retry/
 * backoff on transient 429/5xx/network faults.
 *
 * F6 — a 403 from SEC is ambiguous (a missing/undeclared UA vs a rate-block).
 * Read the body to disambiguate BEFORE the generic errorFromResponse mislabels
 * it as a plain invalid_input:
 *   body ~ /automated|undeclared/i  ⇒  invalid_input, non-retryable (fix the UA)
 *   otherwise                       ⇒  rate_limited, retryable, retryAfter 600s
 * Common non-retryable statuses (404/400) throw immediately; 404 in particular
 * is caught by the caller and turned into an honest `found:false`.
 */
async function getEdgar(url, label) {
    const init = {
        headers: { ...EDGAR_HEADERS },
        signal: AbortSignal.timeout(15_000),
    };
    return throughGate("edgar", EDGAR_MIN_INTERVAL_MS, async () => {
        let r;
        try {
            r = await fetch(url, init);
        }
        catch {
            // Network-level fault (DNS/reset/timeout). Reuse the shared retry/backoff
            // with a fresh AbortSignal per attempt.
            return fetchWithRetry(url, { headers: { ...EDGAR_HEADERS }, signal: AbortSignal.timeout(15_000) }, label);
        }
        if (r.ok)
            return r;
        if (r.status === 403) {
            const body = await r.text().catch(() => "");
            if (/automated|undeclared/i.test(body)) {
                throw new ToolErrorCarrier({
                    kind: "invalid_input",
                    message: `SEC EDGAR rejected the request as automated/undeclared (HTTP 403) at ${label}. SEC requires a descriptive, non-github User-Agent — set EDGAR_USER_AGENT (e.g. "Sample Company AdminContact@example.com"). Upstream note: ${body.slice(0, 160)}`,
                    retryable: false,
                    upstreamStatus: 403,
                    upstreamEndpoint: label,
                });
            }
            throw new ToolErrorCarrier({
                kind: "rate_limited",
                message: `SEC EDGAR returned HTTP 403 at ${label} — likely the 10 req/s limit / a ~10-minute IP block. Slow down and retry after ~10 minutes.`,
                retryable: true,
                retryAfterSeconds: 600,
                upstreamStatus: 403,
                upstreamEndpoint: label,
            });
        }
        const err = errorFromResponse(r, label);
        if (err.retryable) {
            // 429 / 5xx — reuse the shared retry/backoff machinery.
            return fetchWithRetry(url, { headers: { ...EDGAR_HEADERS }, signal: AbortSignal.timeout(15_000) }, label);
        }
        // 404 / 400 (non-retryable) — throw now; callers translate 404 → found:false.
        throw new ToolErrorCarrier(err);
    });
}
// ─── shared coercions ─────────────────────────────────────────────
/**
 * A CIK (int or string, padded or not) → the canonical 10-digit zero-padded
 * form EDGAR's data.sec.gov paths require. Strips non-digits first (accepts
 * "CIK320193", "320193", 320193). e.g. 320193 → "0000320193".
 */
export function padCik(x) {
    const digits = String(x).replace(/\D/g, "");
    return digits.padStart(10, "0");
}
/** The un-padded CIK for Archives URLs (SEC drops leading zeros there). */
function unpadCik(cik10) {
    return cik10.replace(/^0+/, "") || "0";
}
/**
 * Coerce an XBRL value to number|null. Returns **null (never 0)** for absent —
 * a missing fact is an honest "unknown", never a fabricated zero. XBRL `val` is
 * already a JSON number, but guard strings/nullish/non-finite defensively.
 */
export function num(x) {
    if (x === null || x === undefined)
        return null;
    if (typeof x === "number")
        return Number.isFinite(x) ? x : null;
    if (typeof x === "string") {
        const s = x.trim();
        if (s === "" || s.toLowerCase() === "null")
            return null;
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
/** null for absent (null/undefined/""), else the trimmed string. */
function str(x) {
    if (x === null || x === undefined)
        return null;
    const s = String(x).trim();
    return s === "" ? null : s;
}
async function fetchTickerMap() {
    const r = await getEdgar(TICKERS_URL, "edgar:tickers");
    const d = (await r.json());
    if (!d || typeof d !== "object") {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: "edgar:tickers returned an unexpected shape (company_tickers.json should be a keyed dict of {cik_str,ticker,title}).",
            retryable: false,
            upstreamEndpoint: "edgar:tickers",
        });
    }
    const out = [];
    for (const v of Object.values(d)) {
        const e = v;
        if (e && e.cik_str != null && e.ticker != null) {
            out.push({
                cik: padCik(e.cik_str),
                ticker: String(e.ticker),
                title: e.title == null ? "" : String(e.title),
            });
        }
    }
    return out;
}
/** The full ticker→CIK table, memoized ~6h (slow-changing reference read). */
async function tickerMap() {
    return memoize("edgar:tickers", fetchTickerMap, 6 * 60 * 60 * 1000);
}
/**
 * Resolve a `cikOrTicker` argument to a 10-digit CIK. Pure digits (or "CIK…")
 * → padCik directly (no network). Otherwise look up the memoized ticker map:
 * exact ticker match first, then a case-insensitive title substring. null when
 * nothing matches (caller → honest found:false).
 */
async function resolveCik(cikOrTicker) {
    const raw = cikOrTicker.trim();
    if (/^(cik)?\s*\d+$/i.test(raw)) {
        return { cik: padCik(raw), ticker: null, title: null };
    }
    const map = await tickerMap();
    const upper = raw.toUpperCase();
    const exact = map.find((e) => e.ticker.toUpperCase() === upper);
    if (exact)
        return { cik: exact.cik, ticker: exact.ticker, title: exact.title };
    const byName = map.find((e) => e.title.toUpperCase().includes(upper));
    if (byName)
        return { cik: byName.cik, ticker: byName.ticker, title: byName.title };
    return null;
}
// ─── meta helper ──────────────────────────────────────────────────
/**
 * Build a partial `_meta` with the EDGAR source + the mandatory CIK↔UEI caveat
 * appended to every tool's notes and `fieldsUnavailable` set. Tool-specific
 * signals (returned/totalAvailable/pagination/totalIsLowerBound/complete) are
 * merged in via `extra`; buildMeta DERIVES complete/truncated from them.
 */
function edgarMeta(extra) {
    return {
        source: EDGAR_SOURCE,
        keylessMode: true,
        filtersApplied: extra.filtersApplied ?? [],
        filtersDropped: [],
        fieldsUnavailable: EDGAR_FIELDS_UNAVAILABLE,
        ...extra,
        notes: [...(extra.notes ?? []), CIK_UEI_CAVEAT],
    };
}
/** Honest empty for an unresolved/unknown filer: a definitive answer (complete). */
function notFoundBundle(identifier, note) {
    return withMeta({ found: false, identifier }, edgarMeta({
        returned: 0,
        totalAvailable: 0,
        complete: true,
        notes: [note],
    }));
}
// ─── Tool 1: edgar_lookup_cik ─────────────────────────────────────
/**
 * Map a company query (exact ticker, else title substring) to its 10-digit CIK
 * via the memoized company_tickers.json. Returns up to 50 matches; `found:false`
 * on none. The CIK is the join key the other three tools take.
 */
export async function lookupCik(args) {
    const q = args.query.trim();
    const map = await tickerMap();
    const upper = q.toUpperCase();
    const exact = map.filter((e) => e.ticker.toUpperCase() === upper);
    const matched = exact.length
        ? exact
        : map.filter((e) => e.title.toUpperCase().includes(upper));
    const LIMIT = 50;
    const results = matched
        .slice(0, LIMIT)
        .map((e) => ({ cik: e.cik, ticker: e.ticker, title: e.title }));
    const notes = [];
    if (matched.length === 0) {
        notes.push(`No company in SEC's ticker registry matched "${q}" (exact ticker or title substring). Not every SEC filer has a ticker; try edgar_full_text_search by name.`);
    }
    else {
        notes.push(exact.length
            ? `Matched by exact ticker "${q.toUpperCase()}".`
            : `Matched by title substring "${q}" (case-insensitive).`);
        if (matched.length > LIMIT) {
            notes.push(`${matched.length} companies matched; returning the first ${LIMIT}. Refine the query for a specific filer.`);
        }
    }
    return withMeta({ found: results.length > 0, query: q, results }, edgarMeta({
        returned: results.length,
        totalAvailable: matched.length,
        filtersApplied: ["query"],
        notes,
    }));
}
/**
 * The fixed grammar for a `filings.files[].name` older-submissions shard (ADR-0019).
 * Live-confirmed 2026-07-12: `CIK0000320193-submissions-001.json`,
 * `CIK0000019617-submissions-068.json`. This is the FIRST-pass SSRF grammar guard
 * (SEC-format check); `fetchShard` ALSO builds a stronger CIK-BOUND regex from the
 * resolved parent CIK (M3) so a name for ANY OTHER CIK is refused before any fetch.
 * The `\d{1,4}` shard-number quantifier is bounded (a giant number just 404s); the
 * `%`/`/`/`.`/`\`/`..` traversal characters are simply not in the allowed classes.
 */
const SHARD_NAME_RE = /^CIK\d{10}-submissions-\d{1,4}\.json$/;
/**
 * Unroll the COLUMNAR `filings.recent` (parallel arrays; index i = one filing)
 * into `Filing[]`, constructing the primary-document ARCHIVE URL from the real
 * accession + primaryDocument. Alignment is strictly by index i.
 */
function zipRecent(recent, cik10) {
    const accs = recent.accessionNumber ?? [];
    const cikUnpadded = unpadCik(cik10);
    const out = [];
    for (let i = 0; i < accs.length; i++) {
        const accession = str(accs[i]);
        const primaryDocument = str(recent.primaryDocument?.[i]);
        let primaryDocUrl = null;
        if (accession && primaryDocument) {
            const accNoDash = accession.replace(/-/g, "");
            primaryDocUrl = `${ARCHIVES_BASE}/${cikUnpadded}/${accNoDash}/${primaryDocument}`;
        }
        out.push({
            accession,
            form: str(recent.form?.[i]),
            filingDate: str(recent.filingDate?.[i]),
            reportDate: str(recent.reportDate?.[i]),
            primaryDocument,
            primaryDocDescription: str(recent.primaryDocDescription?.[i]),
            primaryDocUrl,
            isXBRL: recent.isXBRL?.[i] === 1 || recent.isXBRL?.[i] === true,
        });
    }
    return out;
}
async function fetchSubmissions(cik10) {
    const url = `${SUBMISSIONS_BASE}/CIK${cik10}.json`;
    const r = await getEdgar(url, "edgar:submissions");
    const d = (await r.json());
    const recent = d?.filings?.recent;
    if (!recent || !Array.isArray(recent.accessionNumber)) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `edgar:submissions returned an unexpected shape for CIK ${cik10} (filings.recent.accessionNumber array missing).`,
            retryable: false,
            upstreamEndpoint: "edgar:submissions",
        });
    }
    const files = Array.isArray(d.filings?.files) ? d.filings.files : [];
    return {
        name: str(d.name),
        recent,
        files,
        recentCount: recent.accessionNumber.length,
    };
}
/**
 * The 7 parallel-array columns `zipRecent` reads by index i. The INTRA-shard
 * shape guard (M1 — the REAL alignment guard, the `pts===data.length` analogue):
 * a shard 200 body whose `accessionNumber` is missing/non-array, or any of these
 * 7 arrays is not `=== accessionNumber.length`, would let `zipRecent` borrow a
 * value from a shorter/absent column at index i → a fabricated (form,date,accession)
 * tuple. So a non-columnar/ragged shard THROWS schema_drift (never emits rows).
 */
const SHARD_ZIP_COLUMNS = [
    "accessionNumber",
    "form",
    "filingDate",
    "reportDate",
    "primaryDocument",
    "primaryDocDescription",
    "isXBRL",
];
/**
 * Fetch ONE older-submissions shard and return its `Filing[]` (ADR-0019). The
 * shard `name` is SERVER-PROVIDED (from the parent `filings.files[].name`); the
 * caller never constructs it from user input. Belt-and-suspenders, mirroring
 * `buildFramesUrl` (S1/S2):
 *  - **[M3] CIK-BIND + grammar validate BEFORE any URL is built.** The name must
 *    match BOTH the fixed SEC grammar (`SHARD_NAME_RE`) AND a regex bound to THIS
 *    filer's resolved `cik10` — so a drifted/hostile/MITM'd parent whose name
 *    embeds a DIFFERENT CIK (`CIK9999999999-…`) or a traversal (`../`, `%2F`) is
 *    NEVER fetched (thrown as `not_found` → the caller skips + discloses PARTIAL).
 *  - Fixed host: build `${SUBMISSIONS_BASE}/${name}` and assert the parsed URL is
 *    `https://data.sec.gov` (host-escape/downgrade guard).
 *  - `getEdgar` → the shard body; **[M1]** assert the columnar shape (SHARD_ZIP_COLUMNS
 *    all equal-length) or THROW schema_drift; then `zipRecent`.
 * Throw taxonomy the caller relies on: `not_found` (bad/cross-CIK/host name OR a
 * genuine 404) → skip+PARTIAL; `schema_drift`/`rate_limited`/other → re-throw loud.
 */
async function fetchShard(name, cik10) {
    // [M3] CIK-bound grammar — ONLY a shard whose embedded CIK === this filer's CIK
    // is eligible. cik10 is 10 zero-padded DIGITS (padCik strips non-digits), so it
    // is safe to interpolate into a RegExp source (no metacharacters).
    const cikBoundRe = new RegExp(`^CIK${cik10}-submissions-\\d{1,4}\\.json$`);
    if (!SHARD_NAME_RE.test(name) || !cikBoundRe.test(name)) {
        throw new ToolErrorCarrier({
            kind: "not_found",
            message: `edgar:submissions shard name ${JSON.stringify(name)} did not match the CIK-bound grammar ^CIK${cik10}-submissions-\\d{1,4}\\.json$ (SEC format change, or a cross-entity/hostile name) — refused before any fetch, counted as a skipped shard.`,
            retryable: false,
            upstreamEndpoint: "edgar:submissions",
        });
    }
    const built = `${SUBMISSIONS_BASE}/${name}`;
    let parsed;
    try {
        parsed = new URL(built);
    }
    catch {
        throw new ToolErrorCarrier({
            kind: "not_found",
            message: `edgar:submissions shard URL could not be constructed from ${JSON.stringify(name)} — refused before any fetch.`,
            retryable: false,
            upstreamEndpoint: "edgar:submissions",
        });
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "data.sec.gov") {
        throw new ToolErrorCarrier({
            kind: "not_found",
            message: `edgar:submissions shard URL host/scheme is not https://data.sec.gov (${parsed.protocol}//${parsed.hostname}) — refused before any fetch (fixed-host assertion).`,
            retryable: false,
            upstreamEndpoint: "edgar:submissions",
        });
    }
    const r = await getEdgar(built, "edgar:submissions");
    const shard = (await r.json());
    // [M1] Intra-shard columnar-shape guard (the real alignment guard).
    const acc = shard?.accessionNumber;
    if (!Array.isArray(acc)) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `edgar:submissions shard ${name} returned HTTP 200 without a columnar accessionNumber[] array — the submissions shard envelope changed.`,
            retryable: false,
            upstreamEndpoint: "edgar:submissions",
        });
    }
    for (const col of SHARD_ZIP_COLUMNS) {
        const arr = shard[col];
        if (!Array.isArray(arr) || arr.length !== acc.length) {
            throw new ToolErrorCarrier({
                kind: "schema_drift",
                message: `edgar:submissions shard ${name} is not columnar: '${col}' is ${Array.isArray(arr) ? `length ${arr.length}` : "missing/non-array"} ≠ accessionNumber length ${acc.length}. Emitting index-aligned rows would fabricate (form,date,accession) tuples — refusing.`,
                retryable: false,
                upstreamEndpoint: "edgar:submissions",
            });
        }
    }
    return zipRecent(shard, cik10);
}
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
export async function companyFilings(args) {
    const resolved = await resolveCik(args.cikOrTicker);
    if (!resolved) {
        return notFoundBundle(args.cikOrTicker, `Could not resolve "${args.cikOrTicker}" to a CIK (not a numeric CIK and no exact-ticker/title match in company_tickers.json).`);
    }
    const cik = resolved.cik;
    let subm;
    try {
        subm = await fetchSubmissions(cik);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
            return notFoundBundle(cik, `No SEC submissions found for CIK ${cik} (HTTP 404) — the CIK does not exist or has no filings. Not fabricated.`);
        }
        throw e;
    }
    const fullHistory = args.fullHistory ?? false;
    const maxShards = args.maxShards ?? 10;
    const hasShards = subm.files.length > 0;
    const totalShards = subm.files.length;
    // Σ ALL files[].filingCount — the grand shard total, INCLUDING un-fetched shards.
    // Authoritative from the PARENT payload alone; never recomputed down (M1).
    const shardCount = subm.files.reduce((s, f) => s + (f.filingCount ?? 0), 0);
    // ── Shard fan-out (gated STRICTLY on fullHistory && there are shards) ──
    // Assemble `recent ++ shard001 ++ … ++ shardNNN` — descending date order is
    // preserved by construction (recent newest, then each shard newest-first), so
    // there is NO re-sort (a blind re-sort would risk breaking SEC's own tie order).
    let assembled = zipRecent(subm.recent, cik);
    let fetchedShards = 0;
    let failedShards = 0; // shards ATTEMPTED (within the cap) that 404'd / were refused.
    let failedFilings = 0; // Σ declared filingCount of those FAILED shards.
    let shortfallFilings = 0; // Σ (declared − actual) for SHORT (but fetched) shards.
    const shardNotes = [];
    const fanoutRan = fullHistory && hasShards;
    if (fanoutRan) {
        // newest-first up to maxShards (files[] is ordered shard-001 newest → shard-NNN oldest).
        const toFetch = subm.files.slice(0, maxShards);
        for (const shardEntry of toFetch) {
            const name = shardEntry.name ?? "";
            const declared = shardEntry.filingCount ?? 0;
            try {
                const rows = await fetchShard(name, cik);
                fetchedShards++;
                assembled = assembled.concat(rows);
                // [M1] filingCount !== length is INTER-document (parent vs a later shard
                // fetch) and can be legit (recent→shard roll / upstream lag). Do NOT throw;
                // use the ACTUAL fetched count and disclose the shortfall as partial.
                if (rows.length < declared) {
                    shortfallFilings += declared - rows.length;
                    shardNotes.push(`shard ${name} returned ${rows.length} of ${declared} declared filings (recent→shard roll or upstream lag); not fabricated.`);
                }
            }
            catch (e) {
                const kind = e instanceof ToolErrorCarrier ? e.toolError.kind : "unknown";
                // not_found = a genuine 404 OR a refused bad/cross-CIK/host name (0 fetch).
                // Degrade to PARTIAL and continue; the declared filings are missing. This is
                // a FAILURE of an ATTEMPTED shard — NOT the maxShards cap (see cappedShards).
                if (kind === "not_found") {
                    failedShards++;
                    failedFilings += declared;
                    continue;
                }
                // schema_drift / rate_limited / invalid_input / upstream_unavailable →
                // fail LOUD (a shape break or a systemic UA/rate/outage fault is not a
                // per-shard degrade — never a fake-partial).
                throw e;
            }
        }
    }
    // CAP remainder — the older shards the maxShards cap NEVER ATTEMPTED (totalShards >
    // maxShards). These are the ONLY shards reachable by RAISING maxShards; a shard that
    // was attempted-and-404'd is a FAILURE (failedShards), NOT a cap remainder, and
    // raising the cap will NOT recover it. Keeping the two causes separate is the fix.
    const cappedShards = fanoutRan && totalShards > maxShards ? totalShards - maxShards : 0;
    const cappedFilings = cappedShards > 0
        ? subm.files.slice(maxShards).reduce((s, f) => s + (f.filingCount ?? 0), 0)
        : 0;
    const forms = args.forms?.map((f) => f.trim().toUpperCase()).filter(Boolean);
    const filtered = forms && forms.length
        ? assembled.filter((f) => f.form != null && forms.includes(f.form.toUpperCase()))
        : assembled;
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;
    const page = filtered.slice(offset, offset + limit);
    const returned = page.length;
    const moreInWindow = offset + returned < filtered.length;
    // [M2/M4] Two "more" axes. When NOT fanning out, the beyond-window axis is
    // today's "shards exist but were not fetched" (hasShards). When fanning out, it
    // is the CAP remainder OR any FAILED shard (cappedShards>0 || failedShards>0 —
    // equivalent to fetchedShards<totalShards but attributed to its actual cause),
    // NOT the plain hasShards boolean. A mutation that sets hasMore from moreInWindow
    // alone → RED.
    const beyondWindow = fanoutRan
        ? cappedShards > 0 || failedShards > 0
        : hasShards;
    const hasMore = moreInWindow || beyondWindow;
    // nextOffset walks ONLY the assembled+fetched window; the older un-fetched shards
    // are UNREACHABLE via paging (mirror the FTS beyond-window pattern: hasMore true
    // while nextOffset is null).
    const nextOffset = moreInWindow ? offset + returned : null;
    // [M1] totalAvailable UNCHANGED — grand total when shards exist (incl un-fetched),
    // else the filtered recent length. Never recomputed down to fetched rows.
    const totalAvailable = hasShards ? subm.recentCount + shardCount : filtered.length;
    const filtersApplied = [];
    if (forms && forms.length)
        filtersApplied.push("forms");
    const notes = [];
    if (fanoutRan) {
        // The THREE independent PARTIAL causes, attributed + disclosed SEPARATELY (each
        // only when it actually applies): (1) the maxShards CAP skipped older shards
        // (cappedShards) → RAISE maxShards; (2) an ATTEMPTED shard FAILED/404'd
        // (failedShards) → retry may recover, raising maxShards will NOT; (3) a fetched
        // shard was SHORT (shortfallFilings) → benign roll/lag. "complete" needs all three
        // absent. Misattributing a failure to the cap (and advising "raise maxShards") is
        // the defect this split fixes.
        const complete = cappedShards === 0 && failedShards === 0 && shortfallFilings === 0;
        if (complete) {
            notes.push(`COMPLETE filing history: fetched all ${totalShards} older shard(s) plus the recent window (${subm.recentCount}) = ${totalAvailable} filings.`);
        }
        else {
            if (cappedShards > 0) {
                // PARTIAL-BY-CAP — ONLY the un-attempted older shards the cap skipped; the
                // "RAISE maxShards" advice appears ONLY here (it recovers cap remainder, not
                // a 404). The counts are the CAPPED counts, never a failed-shard count.
                notes.push(`PARTIAL history (maxShards cap ${maxShards}): the cap limited the fan-out to the newest ${maxShards} of ${totalShards} shard(s); ${cappedShards} older shard(s) (${cappedFilings} filings) were NOT attempted. Paginate via nextOffset for MORE OF THIS fetched window (the fetched shard(s) + the recent ${subm.recentCount}); pagination will NOT reach the un-attempted older shard(s) — RAISE maxShards (max 100) to fetch them.`);
            }
            if (failedShards > 0) {
                // PARTIAL-BY-FAILURE — shards that WERE attempted (within the cap) but 404'd /
                // errored. NOT a cap issue → do NOT advise raising maxShards (a re-fetch hits
                // the same 404); a retry may recover a transient failure.
                notes.push(`PARTIAL history: ${failedShards} attempted shard(s) could not be fetched (HTTP 404 / bad-or-cross-CIK name / transient); ${failedFilings} filing(s) are missing from this history. Not fabricated — a retry may recover a transient failure (raising maxShards will NOT recover a shard that 404'd).`);
            }
            if (shortfallFilings > 0) {
                // A fetched shard returned fewer rows than its parent-declared filingCount
                // (recent→shard roll / upstream lag) — a benign shortfall, per-shard below.
                notes.push(`${shortfallFilings} declared filing(s) were absent from otherwise-fetched shard body(ies) (recent→shard roll or upstream lag); disclosed per-shard below and NOT fabricated.`);
            }
        }
        if (forms && forms.length) {
            notes.push(complete
                ? "The form filter now spans the COMPLETE fetched history (recent + all shards); totalAvailable stays the grand UNFILTERED total, so complete may read false — an under-claim, NOT missing older matches."
                : "Form filtering was applied across the fetched window (recent + fetched shards) — older matching filings may exist in the un-attempted/failed shards.");
        }
        // [M4] Shared-throttle contention: the fan-out serializes N shard GETs through
        // the module-level edgar gate SHARED across all edgar tools.
        notes.push(`fullHistory serialized ${fetchedShards + failedShards} shard GET(s) through the shared EDGAR throttle gate (~${EDGAR_MIN_INTERVAL_MS}ms spacing, shared across ALL edgar tools) — a large fan-out adds latency to concurrent edgar tool calls.`);
        notes.push(...shardNotes);
    }
    else if (hasShards) {
        // fullHistory OFF (default) with shards → today's INCOMPLETE note VERBATIM
        // (backward-compat: byte-identical output when the flag is absent).
        notes.push(`INCOMPLETE HISTORY: only the ${subm.recentCount} most-recent filings (filings.recent) were fetched. ${subm.files.length} older shard(s) (~${shardCount} filings, filings.files[]) were NOT fetched, so this is NOT the full filing history.` +
            (forms && forms.length
                ? " Form filtering was applied to the recent window only — older matching filings may exist in the un-fetched shards."
                : ""));
    }
    else {
        notes.push(`Complete filing history: filings.files[] is empty, so filings.recent (${subm.recentCount}) is the full set.` +
            (moreInWindow ? " This page is a subset; paginate via nextOffset for the rest." : ""));
    }
    if (resolved.title)
        notes.push(`Resolved "${args.cikOrTicker}" → ${resolved.title} (CIK ${cik}).`);
    return withMeta({
        cik,
        entityName: subm.name,
        filings: page,
    }, edgarMeta({
        returned,
        totalAvailable,
        filtersApplied,
        pagination: {
            offset,
            limit,
            hasMore,
            nextOffset,
        },
        notes,
    }));
}
// ─── Tool 3: edgar_company_facts ──────────────────────────────────
/**
 * The default curated us-gaap concepts (F4 — NO EarningsPerShareBasic; its unit
 * is USD/shares, so the default unit="USD" would silently return nothing). The
 * two revenue tags cover the same logical concept — filers report under one or
 * the other — so this is the 6 curated USD concepts. Extracting only these
 * avoids returning the full ~500-concept companyfacts payload.
 */
export const DEFAULT_FACT_CONCEPTS = [
    "Revenues",
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Assets",
    "Liabilities",
    "StockholdersEquity",
    "NetIncomeLoss",
    "CashAndCashEquivalentsAtCarryingValue",
];
async function fetchFacts(cik10) {
    return memoize(`edgar:facts:${cik10}`, async () => {
        const url = `${XBRL_FACTS_BASE}/CIK${cik10}.json`;
        const r = await getEdgar(url, "edgar:companyfacts");
        const d = (await r.json());
        if (!d || typeof d.facts !== "object" || d.facts === null) {
            throw new ToolErrorCarrier({
                kind: "schema_drift",
                message: `edgar:companyfacts returned an unexpected shape for CIK ${cik10} (facts object missing).`,
                retryable: false,
                upstreamEndpoint: "edgar:companyfacts",
            });
        }
        return d;
    }, 60 * 60 * 1000);
}
/**
 * Curated XBRL financial facts for a filer. Extracts only the requested (or the
 * 6 default) concepts in the requested `unit` (default USD), from the memoized
 * companyfacts doc. HONESTY: a concept ABSENT for this filer is OMITTED and
 * listed in a note (NEVER surfaced as 0); a concept present only in a DIFFERENT
 * unit (e.g. EPS in USD/shares) is listed under `wrongUnit` with a note, never a
 * silent 0. `latest` reduces each concept to its single most-recent data point.
 */
export async function companyFacts(args) {
    const resolved = await resolveCik(args.cikOrTicker);
    if (!resolved) {
        return notFoundBundle(args.cikOrTicker, `Could not resolve "${args.cikOrTicker}" to a CIK (not a numeric CIK and no exact-ticker/title match in company_tickers.json).`);
    }
    const cik = resolved.cik;
    let doc;
    try {
        doc = await fetchFacts(cik);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
            return notFoundBundle(cik, `No XBRL company facts for CIK ${cik} (HTTP 404) — the CIK does not exist or has filed no XBRL financial data. Not fabricated.`);
        }
        throw e;
    }
    const unit = (args.unit ?? "USD").trim();
    const latest = args.latest ?? false;
    const requested = args.concepts && args.concepts.length ? args.concepts : DEFAULT_FACT_CONCEPTS;
    const usGaap = doc.facts?.["us-gaap"] ?? {};
    const dei = doc.facts?.["dei"] ?? {};
    const concepts = [];
    const absent = [];
    const wrongUnit = [];
    for (const concept of requested) {
        const node = usGaap[concept] ?? dei[concept];
        if (!node) {
            absent.push(concept);
            continue;
        }
        const units = node.units ?? {};
        const series = units[unit];
        if (!series || !Array.isArray(series)) {
            wrongUnit.push({ concept, availableUnits: Object.keys(units) });
            continue;
        }
        let points = series.map((p) => ({
            end: str(p.end),
            val: num(p.val),
            accn: str(p.accn),
            fy: typeof p.fy === "number" ? p.fy : null,
            fp: str(p.fp),
            form: str(p.form),
            filed: str(p.filed),
        }));
        if (latest && points.length > 0) {
            // Most-recent by period end (fallback: filed date), keep a single point.
            points = [
                points.reduce((best, p) => (p.end ?? "") > (best.end ?? "") ||
                    ((p.end ?? "") === (best.end ?? "") && (p.filed ?? "") > (best.filed ?? ""))
                    ? p
                    : best),
            ];
        }
        concepts.push({ concept, label: str(node.label), unit, points });
    }
    const notes = [];
    if (absent.length) {
        notes.push(`Concept(s) not reported by this filer (OMITTED, not zero): ${absent.join(", ")}.`);
    }
    if (wrongUnit.length) {
        for (const w of wrongUnit) {
            notes.push(`Concept "${w.concept}" exists but not in unit "${unit}" (available: ${w.availableUnits.join(", ") || "none"}). Re-request with the correct unit — NOT reported as 0.`);
        }
    }
    notes.push(latest
        ? "latest=true: each concept reduced to its single most-recent data point (by period end)."
        : "Full reported time series per concept (curated to the requested concepts only; companyfacts holds ~hundreds of concepts).");
    // A definitive curated extraction of the requested concepts (no upstream
    // pagination) — complete for the concepts that ARE present in this unit.
    return withMeta({ cik, entityName: str(doc.entityName), unit, concepts, absent, wrongUnit }, edgarMeta({
        returned: concepts.length,
        totalAvailable: concepts.length,
        complete: true,
        filtersApplied: latest ? ["concepts", "unit", "latest"] : ["concepts", "unit"],
        notes,
    }));
}
/**
 * Map one efts hit → a stable output row. F7: `_source` has NO primary-document
 * filename, so `filingIndexUrl` is the filing's ARCHIVE INDEX DIRECTORY built
 * from `adsh` (accession) + the first CIK — a real, resolvable URL, with NO
 * fabricated document filename appended.
 */
function mapFtsHit(hit) {
    const src = hit._source ?? {};
    const ciks = Array.isArray(src.ciks) ? src.ciks.map(String) : [];
    const adsh = str(src.adsh) ??
        (typeof hit._id === "string" ? str(hit._id.split(":")[0]) : null);
    let filingIndexUrl = null;
    if (adsh && ciks[0]) {
        filingIndexUrl = `${ARCHIVES_BASE}/${unpadCik(padCik(ciks[0]))}/${adsh.replace(/-/g, "")}/`;
    }
    return {
        accession: adsh,
        form: str(src.form),
        filingDate: str(src.file_date),
        entityNames: Array.isArray(src.display_names) ? src.display_names.map(String) : [],
        ciks,
        filingIndexUrl,
    };
}
const FTS_PAGE_SIZE = 100; // F2 — efts ignores `size`; it is fixed at 100/page.
const FTS_WINDOW = 10_000; // upstream hard cap: from + 100 must be ≤ 10000.
const FTS_MAX_FROM = FTS_WINDOW - FTS_PAGE_SIZE; // 9900 → from > 9900 is invalid (9900 is the valid final page).
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
export async function fullTextSearch(args) {
    const from = args.from ?? 0;
    // Off-by-one fix (ADR-0018): `from=9900` is a VALID final page (from+100=10000,
    // the exact ES window boundary — live-confirmed). Only `from > 9900` overflows.
    if (from > FTS_MAX_FROM) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `EDGAR full-text search 'from' (${from}) is out of range: the paging window is from+100 ≤ ${FTS_WINDOW}, so 'from' must be <= ${FTS_MAX_FROM}. Narrow the query with forms/startdt/enddt instead of paging past ${FTS_WINDOW} results.`,
            retryable: false,
            upstreamEndpoint: "edgar:fts",
        });
    }
    // ── Entity filters (ADR-0018) — normalize BEFORE any fetch. ──
    // M1 (fake-empty landmine): each `ciks` entry is reduced to digits; an entry
    // that yields NO digits (a ticker/garbage like "AAPL"/"../") OR an all-zeros
    // value ("0"/"0000000000") pads to the NON-EXISTENT CIK 0000000000, which efts
    // answers with a LIVE 0/eq fake-empty. Reject BOTH explicitly here (0 fetch) —
    // NEVER `.map(padCik).filter(Boolean)` (padCik("AAPL")="0000000000" is truthy).
    // Whitespace-only/empty entries are silently dropped (probe 10 — an empty CIK
    // is ignored upstream anyway).
    const ciks = [];
    for (const raw of args.ciks ?? []) {
        const s = raw == null ? "" : String(raw).trim();
        if (s === "")
            continue; // drop empty/whitespace entries
        const digits = s.replace(/\D/g, "");
        if (digits.replace(/0/g, "") === "") {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                message: `EDGAR full-text search 'ciks' entry ${JSON.stringify(raw)} is not a valid SEC CIK: 'ciks' takes NUMERIC CIKs only (each is zero-padded to 10 digits; CIK 0 / a ticker / a company name is rejected — it would silently return 0 matches). For a ticker or company name, use 'entityName' or resolve the CIK first with edgar_lookup_cik (by name/ticker).`,
                retryable: false,
                upstreamEndpoint: "edgar:fts",
            });
        }
        ciks.push(digits.padStart(10, "0"));
    }
    const entityName = args.entityName?.trim() ?? "";
    const params = new URLSearchParams();
    params.set("q", args.q);
    const forms = args.forms?.map((f) => f.trim()).filter(Boolean);
    if (forms && forms.length)
        params.set("forms", forms.join(","));
    if (args.startdt || args.enddt) {
        params.set("dateRange", "custom");
        if (args.startdt)
            params.set("startdt", args.startdt);
        if (args.enddt)
            params.set("enddt", args.enddt);
    }
    // Whitelisted entity filters — set (and echo in filtersApplied) ONLY when a
    // live-honored value was actually sent (silent-drop guard; probe 7).
    if (ciks.length)
        params.set("ciks", ciks.join(","));
    if (entityName)
        params.set("entityName", entityName);
    if (from > 0)
        params.set("from", String(from));
    const r = await getEdgar(`${FTS_URL}?${params.toString()}`, "edgar:fts");
    const d = (await r.json());
    // F3 — window overflow / any error body arrives as HTTP 200 with no hits.hits.
    if (!d || !d.hits || !Array.isArray(d.hits.hits)) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: "edgar:fts returned HTTP 200 without hits.hits — SEC answers a paging-window overflow (or a malformed query) with 200 + an error body. Narrow the query or reduce 'from'.",
            retryable: false,
            upstreamEndpoint: "edgar:fts",
        });
    }
    const total = d.hits.total ?? {};
    const totalAvailable = typeof total.value === "number" ? total.value : 0;
    const isLowerBound = total.relation === "gte";
    const results = d.hits.hits.map(mapFtsHit);
    const returned = results.length;
    const nextFrom = from + FTS_PAGE_SIZE;
    // More results exist AND the next page is still inside the 10000 window.
    const hasMore = from + returned < totalAvailable && nextFrom < FTS_WINDOW;
    // The next page is only reachable if it does not trip the `from > 9900` guard.
    // Off-by-one fix (ADR-0018): `<=` so pagination can reach the final `from=9900`
    // page (nextFrom=9900) instead of stopping one page short.
    const nextOffset = hasMore && nextFrom <= FTS_MAX_FROM ? nextFrom : null;
    const filtersApplied = ["q"];
    if (forms && forms.length)
        filtersApplied.push("forms");
    if (args.startdt || args.enddt)
        filtersApplied.push("dateRange");
    if (ciks.length)
        filtersApplied.push("ciks");
    if (entityName)
        filtersApplied.push("entityName");
    const notes = [
        "EDGAR full-text search covers 2001-present only (earlier filings are not indexed).",
        "Page size is fixed at 100 (the efts `size` param is ignored); paginate via `from`.",
    ];
    // Entity-filter semantics (ADR-0018) — emitted only when the filter was applied.
    if (ciks.length) {
        notes.push("Results are pinned to the supplied CIK(s) (exact 10-digit match). A 0-result set may mean the CIK is wrong OR the entity has no matching filings in the query/form/date window — it is NOT proof of absence; verify the CIK via edgar_lookup_cik (by name/ticker) or on SEC EDGAR directly.");
    }
    if (entityName) {
        notes.push("entityName is a FUZZY filer-name filter (it can match related entities, e.g. multiple 'Apple*' filers) — it is NOT a CIK-exact pin; combine with ciks for an exact-entity result.");
    }
    if (returned === 0 && (ciks.length || entityName)) {
        notes.push("0 results with ciks/entityName applied is NOT proof of absence — a wrong CIK, a too-fuzzy/mismatched entityName, or a genuine no-match are indistinguishable here; verify the identifier via edgar_lookup_cik (by name/ticker) or on SEC EDGAR directly.");
    }
    if (isLowerBound) {
        notes.push(`totalAvailable is a LOWER BOUND: SEC reported hits.total.relation="gte" with the value pinned at ${totalAvailable}; the true match count is UNKNOWN and ≥ ${totalAvailable}. See totalIsLowerBound. Narrow the query for an exact count.`);
    }
    if (hasMore && nextOffset === null) {
        notes.push(`More matches exist but are beyond EDGAR's ${FTS_WINDOW}-result full-text window and are UNREACHABLE via paging — narrow the query with forms/date filters to retrieve them.`);
    }
    const meta = {
        returned,
        totalAvailable,
        filtersApplied,
        pagination: { offset: from, limit: FTS_PAGE_SIZE, hasMore, nextOffset },
        notes,
    };
    if (isLowerBound)
        meta.totalIsLowerBound = true;
    return withMeta({ query: args.q, results }, edgarMeta(meta));
}
// ─── Tool 5: edgar_xbrl_frames ────────────────────────────────────
// ADR-0017 (v1 + v2 AUTHORITATIVE). A COMPLETE keyless cross-filer cross-section:
// every XBRL filer's reported value for ONE concept in ONE calendar period, in a
// single call — the peer-benchmarking / distribution primitive. Reuses getEdgar
// VERBATIM (no new host/gate/UA); the frames path puts caller-supplied segments
// (taxonomy/tag/unit/period) as RAW PATH SEGMENTS, so the load-bearing control is
// the pre-fetch enum/regex validation + fixed-host assertion (§SSRF, S1/S2).
/** The whitelisted frames host + base (same data.sec.gov the other edgar tools use). */
const FRAMES_BASE = "https://data.sec.gov/api/xbrl/frames";
/**
 * The `taxonomy` path-segment enum — the SSRF guard for that segment (no free
 * value reaches the host). Only members LIVE-CONFIRMED to resolve a real frame
 * (per-segment live-verify discipline, ADR-0017 Open-Q5) are shipped. Maker
 * probes 2026-07-12: us-gaap (Assets/Revenues/NetIncomeLoss/EPS) + dei
 * (EntityCommonStockSharesOutstanding/EntityPublicFloat) → 200; the guessed
 * srt/invest/us-ins tags → 404, so they are DROPPED (conservative floor).
 */
export const FRAMES_TAXONOMIES = ["us-gaap", "dei"];
// Segment grammars (belt-and-suspenders re-check in the builder — S1). These are
// the SAME regexes/enum the server Zod schema applies; re-running them here does
// NOT rely on Zod (a direct call could bypass it) nor on the hostname assertion
// alone (a same-host `../` traversal normalizes to host=data.sec.gov and PASSES a
// hostname check). They are allowlists: `%`, `/`, `.`, `\`, `..`, `%2F`, `%2E`,
// `%00` all fail (S2 — those characters are simply not in the allowed classes).
const FRAMES_TAG_RE = /^[A-Za-z0-9]+$/;
const FRAMES_UNIT_RE = /^[A-Za-z0-9-]+$/;
const FRAMES_PERIOD_RE = /^CY\d{4}(Q[1-4]I?)?$/;
/** Throw the pre-fetch injection-guard error (invalid_input, 0 fetch). */
function framesInvalid(message) {
    throw new ToolErrorCarrier({
        kind: "invalid_input",
        message,
        retryable: false,
        upstreamEndpoint: "edgar:frames",
    });
}
/**
 * Build the frames URL from validated path segments (S1/S2). BELT-AND-SUSPENDERS:
 * re-run the enum + the three regexes on each segment and hard-throw invalid_input
 * (0 fetch) on any mismatch — do NOT trust that Zod already ran, and do NOT rely on
 * the hostname assertion alone (it passes same-host traversal). THEN assert the
 * built URL is https on the fixed data.sec.gov host (guards host-escape/downgrade).
 */
function buildFramesUrl(taxonomy, tag, unit, period) {
    if (!FRAMES_TAXONOMIES.includes(taxonomy)) {
        framesInvalid(`edgar_xbrl_frames: taxonomy ${JSON.stringify(taxonomy)} is not one of {${FRAMES_TAXONOMIES.join(", ")}} — refused before any fetch (path-segment injection guard).`);
    }
    if (!FRAMES_TAG_RE.test(tag)) {
        framesInvalid(`edgar_xbrl_frames: tag ${JSON.stringify(tag)} must match ^[A-Za-z0-9]+$ (XBRL tags are alphanumeric; slash/dot/percent/backslash/'..' are rejected) — refused before any fetch (path-segment injection guard).`);
    }
    if (!FRAMES_UNIT_RE.test(unit)) {
        framesInvalid(`edgar_xbrl_frames: unit ${JSON.stringify(unit)} must match ^[A-Za-z0-9-]+$ (hyphen allowed, e.g. USD-per-shares; slash/dot/percent forbidden — never the 'USD/shares' companyfacts key form) — refused before any fetch (path-segment injection guard).`);
    }
    if (!FRAMES_PERIOD_RE.test(period)) {
        framesInvalid(`edgar_xbrl_frames: period ${JSON.stringify(period)} must match ^CY\\d{4}(Q[1-4]I?)?$ (e.g. CY2023, CY2023Q1, CY2023Q4I) — refused before any fetch (path-segment injection guard).`);
    }
    const built = `${FRAMES_BASE}/${taxonomy}/${tag}/${unit}/${period}.json`;
    let parsed;
    try {
        parsed = new URL(built);
    }
    catch {
        framesInvalid(`edgar_xbrl_frames: could not construct a valid URL from the segments — refused before any fetch.`);
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "data.sec.gov") {
        framesInvalid(`edgar_xbrl_frames: constructed URL host/scheme is not https://data.sec.gov (${parsed.protocol}//${parsed.hostname}) — refused before any fetch (fixed-host assertion).`);
    }
    return built;
}
/** Compute FrameStats over the full data[] (all rows, before any client slice). */
function framesStats(data) {
    const finite = [];
    let nonFiniteExcluded = 0;
    for (const d of data) {
        const v = num(d.val); // null for absent/""/"null"/non-finite; real 0 survives.
        if (v === null)
            nonFiniteExcluded++;
        else
            finite.push(v);
    }
    const count = finite.length;
    // M3 — no finite values ⇒ no distribution computable ⇒ every field null.
    if (count === 0) {
        return {
            count: 0,
            min: null,
            max: null,
            sum: null,
            mean: null,
            median: null,
            p25: null,
            p75: null,
            nonFiniteExcluded,
        };
    }
    finite.sort((a, b) => a - b);
    const sum = finite.reduce((s, v) => s + v, 0);
    // M2 — linear interpolation: pos=q*(n-1), interpolate between the bracketing
    // sorted values. median = q=0.5 (mean of the two middle values for even n).
    const quantile = (q) => {
        const pos = q * (count - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        const vLo = finite[lo];
        const vHi = finite[hi];
        return pos === lo ? vLo : vLo + (pos - lo) * (vHi - vLo);
    };
    return {
        count,
        min: finite[0],
        max: finite[count - 1],
        sum,
        mean: sum / count,
        median: quantile(0.5),
        p25: quantile(0.25),
        p75: quantile(0.75),
        nonFiniteExcluded,
    };
}
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
export async function xbrlFrames(args) {
    const taxonomy = args.taxonomy ?? "us-gaap";
    const unit = args.unit ?? "USD";
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    const includeStats = args.includeStats ?? false;
    // S1/S2 — build (and re-validate) the path BEFORE any fetch. Throws
    // invalid_input with 0 fetches on any bad segment or a non-fixed-host URL.
    const url = buildFramesUrl(taxonomy, args.tag, unit, args.period);
    let body;
    try {
        const r = await getEdgar(url, "edgar:frames");
        body = (await r.json());
    }
    catch (e) {
        // 404 ⇒ the quadruple did not match a frame ⇒ honest found:false (NEVER 0).
        if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
            return notFoundBundle(`${taxonomy}/${args.tag}/${unit}/${args.period}`, `No XBRL frame matched taxonomy=${taxonomy} tag=${args.tag} unit=${unit} period=${args.period} (HTTP 404). The concept was NOT reported under that exact tag/unit/calendar-frame — this is NOT a value of 0. Check: instant (balance-sheet) concepts need the trailing 'I' (e.g. CY2023Q4I); EPS uses unit 'USD-per-shares' (hyphen), never 'USD/shares'.`);
        }
        throw e;
    }
    // Drift guards (schema_drift THROW — never a fabricated empty). Order matters:
    // (1) data[] must be an array, (2) pts must be a finite number, (3) the
    // load-bearing invariant pts === data.length (a mismatch ⇒ truncation/shape
    // change; frames has NO page param to recover the rest, so we refuse).
    const data = body.data;
    if (!Array.isArray(data)) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `edgar:frames returned HTTP 200 without a data[] array (taxonomy=${taxonomy} tag=${args.tag} unit=${unit} period=${args.period}) — the frames envelope changed.`,
            retryable: false,
            upstreamEndpoint: "edgar:frames",
        });
    }
    if (typeof body.pts !== "number" || !Number.isFinite(body.pts)) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `edgar:frames returned a non-numeric 'pts' (${JSON.stringify(body.pts)}) — SEC's own data-point count is missing; the envelope changed.`,
            retryable: false,
            upstreamEndpoint: "edgar:frames",
        });
    }
    if (body.pts !== data.length) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `SEC frames pts (${body.pts}) ≠ data.length (${data.length}) — the cross-section may be truncated or the envelope changed. Frames has no pagination to recover the rest, so refusing rather than presenting a partial set as complete.`,
            retryable: false,
            upstreamEndpoint: "edgar:frames",
        });
    }
    // SEC's own count; validated === data.length. NEVER a page length (mutation a).
    const totalAvailable = body.pts;
    // Stats over the FULL data[] (ALL rows, BEFORE the client-side slice) — M2/M3.
    const stats = includeStats
        ? framesStats(data)
        : undefined;
    // Map every row: null-never-0 via num() on val; start only on duration rows.
    const allRows = data.map((d) => {
        const row = {
            accn: str(d.accn),
            cik: d.cik == null ? null : padCik(d.cik),
            entityName: str(d.entityName),
            loc: str(d.loc),
            end: str(d.end),
            val: num(d.val),
        };
        if ("start" in d)
            row.start = str(d.start);
        return row;
    });
    // Client-side window over the already-fully-fetched cross-section (M1).
    const page = allRows.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < totalAvailable;
    const uom = str(body.uom);
    const found = data.length > 0;
    const notes = [];
    // SEMANTIC (the CIK-caveat analogue) — absence ≠ 0.
    notes.push("A frame contains ONLY filers who reported this EXACT tag for this EXACT calendar period, with SEC selecting one best-fit fact per entity. Absence from the frame ≠ 0 and ≠ 'the company has none' — it means the filer did not report under that tag/calendar-frame.");
    // COMPLETENESS — M1 two-clause split (the word "complete" never describes a
    // subset page): the upstream-frame-fetched-in-full sense and the this-page-is-a-
    // subset sense are stated distinctly.
    notes.push(`The upstream frame was fetched in FULL server-side (pts=${totalAvailable} = the entire cross-section for this taxonomy/tag/unit/period, uncapped and unpaginated by SEC). THIS response page contains ${returned} of ${totalAvailable} rows; when hasMore is true, page via nextOffset to retrieve the remaining filers.`);
    // DISCOVERABILITY — period grammar + hyphen unit + 404-not-zero.
    notes.push("Period grammar: CY2023 (annual flow) · CY2023Q1 (quarterly flow, no I) · CY2023Q4I (instant, trailing I). EPS uses unit 'USD-per-shares' (hyphen), never 'USD/shares'. A tag/unit/period mismatch returns found:false (a 404), NOT an empty zero.");
    // val null-never-0.
    notes.push("Each row 'val' is coerced to number-or-null: a real reported 0 survives as 0, but an absent/blank/non-finite value is null — never a fabricated 0.");
    // uom echo (minor) — path-form vs response-form.
    if (uom && uom !== unit) {
        notes.push(`SEC's response uom is '${uom}', which differs from the requested unit path-segment '${unit}' (path-form vs response-form — e.g. 'USD-per-shares' is reported as 'USD/shares'). The 'uom' field echoes SEC's own value.`);
    }
    // Stats disclosure — M2 method / M3 no-finite.
    if (stats) {
        notes.push(stats.count === 0
            ? `stats: no finite values across the full cross-section (nonFiniteExcluded=${stats.nonFiniteExcluded}) — no distribution computable, so every stat field (min/max/sum/mean/median/p25/p75) is null, never 0/NaN/Infinity.`
            : `stats: min/max/sum/mean and linear-interpolated p25/median/p75 computed over the ${stats.count} FINITE vals (nulls/non-finite excluded; nonFiniteExcluded=${stats.nonFiniteExcluded}) across the FULL cross-section of ${totalAvailable} rows, sorted ascending — not a robust estimator for small frames.`);
    }
    const outData = {
        found,
        taxonomy,
        tag: str(body.tag) ?? args.tag,
        unit,
        uom,
        period: args.period,
        label: str(body.label),
        description: str(body.description),
        rows: page,
    };
    if (stats)
        outData.stats = stats;
    return withMeta(outData, edgarMeta({
        returned,
        totalAvailable,
        filtersApplied: ["taxonomy", "tag", "unit", "period"],
        pagination: {
            offset,
            limit,
            hasMore,
            nextOffset: hasMore ? offset + returned : null,
        },
        notes,
    }));
}
// ─── Tool 6: edgar_filing_index (ADR-0026) ────────────────────────
// A KEYLESS BULK cross-filer capability on the EXISTING edgar source: read the
// SEC EDGAR quarterly FULL-INDEX (www.sec.gov/Archives/edgar/full-index/<year>/
// QTR<n>/master.idx — a COMPLETE cross-filer index of EVERY filer's EVERY filing
// in a quarter, pipe-delimited, ~33MB / ~370K rows), FULL-SCAN it, apply
// CLIENT-SIDE filters, and return offset-paginated filings with an EXACT total.
// The per-filer edgar tools require you ALREADY hold a CIK; this is the
// bulk-enumeration primitive ("every 8-K in 2024 Q1", "every filing by CIK X in
// Q1", "every filer named '…'"). Reuses getEdgar VERBATIM (UA + Accept-Encoding:
// gzip + the ≤10 req/s throughGate — UNTOUCHED, so the other 5 edgar tools stay
// byte-identical), `.text()`, padCik, the module-local `str`, `driftError`,
// `buildMeta`/`withMeta`. Copies (does NOT import) the frames buildFramesUrl
// S1/S2 path-segment idiom.
//
// LIVE-VERIFIED 2026-07-12 (org UA `cliwant-mcp-sam-gov/1.0`):
//  - 2024/QTR1/master.idx → 200, 33,206,408 bytes, 370,304 data rows (all 5-field);
//    exact 8-K count 16,997, exact 10-K count 4,980.
//  - `Range: bytes=0-1000` → 200 FULL body (Range IGNORED, no 206) → a byte-cap
//    would truncate the CIK-sorted tail → under-count; FULL-SCAN → EXACT
//    totalAvailable is the ONLY honest model (byte-cap FORBIDDEN).
//  - 2026/QTR4 (current-YEAR future quarter) → 200, header+dashes, 0 data rows →
//    GENUINE-EMPTY (M1: NOT drift). 2026/QTR3 (current quarter) → 200, ~33K rows,
//    GROWING daily (short cache TTL + a point-in-time-snapshot note).
//  - 2024/QTR5 → 403 `AccessDenied` XML (does NOT match getEdgar F6's /automated|
//    undeclared/ → getEdgar mislabels it `rate_limited`) → TOOL-LOCAL reclassify.
//  - 2027/QTR1 (future YEAR) → 403, but the year bound blocks it PRE-FETCH
//    (invalid_input, 0 fetch — a future year has no published quarter index).
const FULLINDEX_HOST = "www.sec.gov";
const FULLINDEX_BASE = "https://www.sec.gov/Archives/edgar/full-index";
const FULLINDEX_FILE = "master.idx"; // the single backing file (pipe-delimited)
const FULLINDEX_LABEL = "edgar:full-index"; // host+path only; keyless ⇒ no token can appear
const FULLINDEX_HEADER = "CIK|Company Name|Form Type|Date Filed|Filename";
const EDGAR_FULLINDEX_START_YEAR = 1993; // EDGAR full-index begins 1993 Q1
const FILING_ARCHIVE_BASE = "https://www.sec.gov/Archives/"; // prefix for row.filename → a resolvable URL
// Safety ceiling ABOVE the live ~370K rows (2024Q1 = 370,304). If a body EXCEEDS
// it (drift/hostile/giant), the scan stops + `totalIsLowerBound` is set + a note —
// NEVER a silent truncation. The normal path never reaches it, so totals stay EXACT.
// Exported (with the `maxRows` param on parseFullIndex) so the fault suite can drive
// the ceiling with a COMPACT fixture (A2) instead of a 500K-row body.
export const MAX_INDEX_ROWS = 500_000;
/**
 * Fresh UTC year at CALL time (M2/S1) — NOT a module-load constant, so the upper
 * year bound survives a year rollover in a long-running process.
 */
function currentUtcYear() {
    return new Date().getUTCFullYear();
}
/**
 * True iff (year,quarter) is the CURRENT calendar quarter (UTC). The current
 * quarter GROWS daily (short cache TTL + a point-in-time-snapshot note); a closed
 * past quarter is immutable (long TTL). NOTE: this is a freshness/cache signal
 * ONLY — it is deliberately NOT a pre-fetch guard (M2: a same-year future quarter
 * returns a well-formed empty 200, so it must be reachable, not refused).
 */
function isCurrentQuarter(year, quarter) {
    const now = new Date();
    return (year === now.getUTCFullYear() &&
        quarter === Math.floor(now.getUTCMonth() / 3) + 1);
}
/** Throw the pre-fetch bounds/injection guard error (invalid_input, 0 fetch). */
function fullIndexInvalid(message) {
    throw new ToolErrorCarrier({
        kind: "invalid_input",
        message,
        retryable: false,
        upstreamEndpoint: FULLINDEX_LABEL,
    });
}
/**
 * Build the full-index URL from the ONLY two caller-influenced path segments
 * (year, quarter) — the frames `buildFramesUrl` S1/S2 idiom, with the segments as
 * BOUNDED INTEGERS (a range check, not a regex: `%`/`/`/`.`/`\`/`..`/`%2F` cannot
 * appear in an integer, so there is no path-segment-injection surface). This is
 * BELT-AND-SUSPENDERS behind Zod (a direct handler call could bypass Zod):
 *   - year   ∈ [1993, currentUtcYear()]   else invalid_input (0 fetch)  — the upper
 *     bound is CALL-TIME fresh (M2); a future YEAR has no published quarter index.
 *   - quarter ∈ {1,2,3,4}                  else invalid_input (0 fetch).
 * There is NO `≤currentCalendarQuarter` guard (M2): a same-year FUTURE quarter
 * returns a well-formed EMPTY 200 (2026/QTR4 live), so refusing it would be a false
 * "not available"; the two honest terminal paths (200+header+0rows → genuine-empty;
 * a bounds-valid 403 → the ambiguous reclassify) handle everything else.
 * THEN assert the built URL is https on the fixed www.sec.gov host.
 */
function buildFullIndexUrl(year, quarter) {
    const maxYear = currentUtcYear();
    if (!Number.isInteger(year) ||
        year < EDGAR_FULLINDEX_START_YEAR ||
        year > maxYear) {
        fullIndexInvalid(`edgar_filing_index: year ${JSON.stringify(year)} must be an integer in [${EDGAR_FULLINDEX_START_YEAR}, ${maxYear}] (EDGAR full-index begins 1993 Q1; a future year has no published quarter index) — refused before any fetch (path-segment bounds guard).`);
    }
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
        fullIndexInvalid(`edgar_filing_index: quarter ${JSON.stringify(quarter)} must be an integer in {1,2,3,4} — refused before any fetch (path-segment bounds guard).`);
    }
    const built = `${FULLINDEX_BASE}/${year}/QTR${quarter}/${FULLINDEX_FILE}`;
    let parsed;
    try {
        parsed = new URL(built);
    }
    catch {
        fullIndexInvalid(`edgar_filing_index: could not construct a valid URL from year=${year} quarter=${quarter} — refused before any fetch.`);
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== FULLINDEX_HOST) {
        fullIndexInvalid(`edgar_filing_index: constructed URL host/scheme is not https://${FULLINDEX_HOST} (${parsed.protocol}//${parsed.hostname}) — refused before any fetch (fixed-host assertion).`);
    }
    return built;
}
/**
 * Split `line` on its FIRST `n` occurrences of `|`; the remainder (which may
 * itself contain `|`) is the FINAL element (the BOUNDED pipe-split — minor fix). For
 * n=4 a well-formed row yields exactly 5 fields, and a row carrying an EXTRA `|`
 * still yields 5 fields (the extra pipe stays inside the rejoined tail) rather than
 * being dropped as "malformed" — so `totalAvailable` is never SILENTLY under-counted
 * by an over-split. A row with FEWER than 4 pipes returns <5 elements → malformed.
 */
function splitOnFirstPipes(line, n) {
    const out = [];
    let start = 0;
    for (let k = 0; k < n; k++) {
        const idx = line.indexOf("|", start);
        if (idx === -1)
            break;
        out.push(line.slice(start, idx));
        start = idx + 1;
    }
    out.push(line.slice(start));
    return out;
}
/**
 * Parse the raw master.idx body into `FilingIndexRow[]`.
 *
 * DRIFT keys on the ABSENCE of the `CIK|Company Name|Form Type|Date Filed|Filename`
 * header + the `----` dashes boundary ONLY (M1) — a non-index / error / format-changed
 * body served with HTTP 200 (e.g. an S3 error HTML page) → THROW `driftError`. A
 * body WITH the header+dashes but ZERO data rows is a GENUINE-EMPTY quarter (2026/QTR4
 * live) → returned to the caller (NOT thrown). A body WITH the header+dashes whose
 * EVERY data row fails the 5-field split → THROW `driftError` (all-malformed = format
 * drift). The fixed preamble (`Description:` …) BEFORE the header is skipped.
 */
export function parseFullIndex(body, maxRows = MAX_INDEX_ROWS) {
    const lines = body.split("\n");
    // Locate the header line immediately followed by the `----` dashes boundary.
    let dashesIdx = -1;
    for (let i = 0; i < lines.length - 1; i++) {
        if ((lines[i] ?? "").replace(/\r$/, "").trim() === FULLINDEX_HEADER) {
            const next = (lines[i + 1] ?? "").replace(/\r$/, "");
            if (/^-{5,}\s*$/.test(next.trim())) {
                dashesIdx = i + 1;
                break;
            }
        }
    }
    if (dashesIdx === -1) {
        throw driftError(FULLINDEX_LABEL, `edgar:full-index body is missing the '${FULLINDEX_HEADER}' header / '----' dashes boundary (a non-index / error / format-changed body served with HTTP 200) — refusing to report an empty result (schema drift, NOT a genuine-empty quarter).`);
    }
    const rows = [];
    let malformedRows = 0;
    let totalIsLowerBound = false;
    for (let i = dashesIdx + 1; i < lines.length; i++) {
        const line = (lines[i] ?? "").replace(/\r$/, "");
        if (line.trim() === "")
            continue; // blank line (e.g. the trailing newline) — skip
        // Safety ceiling (never a SILENT truncation): once the scanned data-row count
        // reaches MAX_INDEX_ROWS, stop + set totalIsLowerBound. The live ~370K is well
        // under 500K, so the normal path never trips it and totals stay EXACT.
        if (rows.length + malformedRows >= maxRows) {
            totalIsLowerBound = true;
            break;
        }
        const parts = splitOnFirstPipes(line, 4);
        if (parts.length < 5) {
            malformedRows++;
            continue;
        }
        const cik = str(parts[0]);
        const filename = str(parts[4]);
        rows.push({
            cik,
            cikPadded: cik === null ? null : padCik(cik),
            companyName: str(parts[1]),
            formType: str(parts[2]),
            dateFiled: str(parts[3]),
            filename,
            filingUrl: filename === null ? null : FILING_ARCHIVE_BASE + filename,
        });
    }
    // M1 — header+dashes PRESENT but EVERY data row failed the split ⇒ drift (a
    // format change). 0 data rows total (rows.length===0 && malformedRows===0) ⇒
    // GENUINE-EMPTY (returned by the caller, NOT thrown).
    if (rows.length === 0 && malformedRows > 0) {
        throw driftError(FULLINDEX_LABEL, `edgar:full-index has the header/dashes boundary but ALL ${malformedRows} data row(s) failed the 5-field pipe split (format drift) — refusing to report an empty result.`);
    }
    return { rows, malformedRows, totalIsLowerBound };
}
// A1 — a BOUNDED LRU for the full-index RAW TEXT. DELIBERATELY NOT the shared,
// UNBOUNDED `memoize` (cache.ts): as the review flagged, memoizing ~370K parsed
// row-objects per (year,quarter) with no eviction would OOM when a client sweeps
// many quarters. This caps at FULLINDEX_CACHE_MAX distinct quarters (a HARD size
// bound), caches the RAW TEXT (leaner than parsed rows) re-parsed per call (cheap),
// and TTL-splits: the CURRENT quarter grows daily → short TTL; a CLOSED quarter is
// immutable → long TTL. Map insertion order = LRU recency; the oldest quarter is
// evicted past the cap. A repeat call for the same quarter (different filters/
// offset) re-uses the cached text — NO second ~33MB download.
const FULLINDEX_CACHE_MAX = 3;
const FULLINDEX_TTL_CURRENT_MS = 5 * 60 * 1000; // current quarter: 5 min (grows daily)
const FULLINDEX_TTL_CLOSED_MS = 6 * 60 * 60 * 1000; // closed quarter: 6h (immutable)
const fullIndexCache = new Map();
/** Fetch the whole quarter's master.idx text (getEdgar VERBATIM + `.text()`),
 *  through the bounded LRU (A1). getEdgar sets the mandatory UA + gzip + the ≤10
 *  req/s gate + the 15s timeout; a slow body-read → abort → getEdgar's honest
 *  upstream_unavailable throw (never a fake-empty). */
async function fetchFullIndexText(built, year, quarter) {
    const key = `${year}:${quarter}`;
    const now = Date.now();
    const hit = fullIndexCache.get(key);
    if (hit && hit.expiresAt > now) {
        fullIndexCache.delete(key); // LRU touch → re-insert as the newest
        fullIndexCache.set(key, hit);
        return hit.text;
    }
    if (hit)
        fullIndexCache.delete(key); // expired
    const r = await getEdgar(built, FULLINDEX_LABEL);
    const text = await r.text();
    const ttl = isCurrentQuarter(year, quarter)
        ? FULLINDEX_TTL_CURRENT_MS
        : FULLINDEX_TTL_CLOSED_MS;
    fullIndexCache.set(key, { text, expiresAt: now + ttl });
    while (fullIndexCache.size > FULLINDEX_CACHE_MAX) {
        const oldest = fullIndexCache.keys().next().value;
        if (oldest === undefined)
            break;
        fullIndexCache.delete(oldest);
    }
    return text;
}
/** For tests: evict the full-index bounded LRU (mirrors cache.ts `_clearCache` for
 *  this dedicated cache, which the shared `_clearCache` does not touch). */
export function _resetFullIndexCache() {
    fullIndexCache.clear();
}
/**
 * Read the SEC EDGAR quarterly full-index for (year, quarter) and return the
 * filings matching the given CLIENT-SIDE filters (form / CIK / company substring /
 * date range), offset-paginated, with the EXACT total match count for the quarter.
 *
 * HONESTY (ADR-0026 v2):
 *  - FULL-SCAN → `totalAvailable` is the EXACT filtered match count across the WHOLE
 *    quarter (never a page length, never a byte-capped under-count — SEC ignores Range).
 *  - A bounds-valid but unpublished quarter 403s (getEdgar mislabels it rate_limited);
 *    TOOL-LOCAL reclassify to an AMBIGUOUS both-causes error (unpublished quarter OR
 *    the 10 req/s rate-block) — never a bare rate-limit, never a fake-empty.
 *  - Drift on header/dashes ABSENCE or an all-malformed body (THROW); header+0-rows ⇒
 *    genuine-empty (complete:true). A future year / bad quarter ⇒ invalid_input, 0 fetch.
 *  - CIK stays a STRING; every column via the module-local `str` (null-never-"").
 *  - `companyContains` is a LITERAL case-insensitive substring (C110 N/A — no token split).
 */
export async function filingIndex(args) {
    const { year, quarter } = args;
    // S1 — build + re-validate the path BEFORE any fetch (0 fetch on a bad year/quarter).
    const built = buildFullIndexUrl(year, quarter);
    // Fetch the WHOLE quarter (getEdgar VERBATIM + `.text()`, bounded-LRU cached). A
    // bounds-valid 403 (an unpublished quarter) is reclassified TOOL-LOCAL — getEdgar
    // is UNTOUCHED (the other 5 edgar tools stay byte-identical).
    let body;
    try {
        body = await fetchFullIndexText(built, year, quarter);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier &&
            e.toolError.kind === "rate_limited" &&
            e.toolError.upstreamStatus === 403) {
            // 403-not-404 reclassify (fact #2): a bad/unpublished full-index quarter
            // returns 403 `AccessDenied` (NOT 404); getEdgar's F6 can't match /automated|
            // undeclared/ so it labels it rate_limited. Re-surface an AMBIGUOUS both-causes
            // error — NEVER a bare "rate limited", NEVER a fake-empty. A REAL 429 (status
            // 429, not 403) is NOT caught here → stays an honest rate_limited.
            throw new ToolErrorCarrier({
                kind: "upstream_unavailable",
                message: `SEC returned HTTP 403 for the full-index path ${FULLINDEX_BASE}/${year}/QTR${quarter}/${FULLINDEX_FILE}. This is AMBIGUOUS: EITHER the ${year} QTR${quarter} index is not published yet (a too-early / non-existent quarter returns 403, not 404) OR SEC is rate-limiting this IP at the 10 req/s ceiling (~10-minute block). NOT fabricated as empty. Verify the quarter is a real past/current EDGAR quarter and retry after ~10 minutes.`,
                retryable: true,
                retryAfterSeconds: 600,
                upstreamStatus: 403,
                upstreamEndpoint: FULLINDEX_LABEL,
            });
        }
        throw e; // schema_drift / invalid_input(UA) / upstream_unavailable / real 429 — loud
    }
    // FULL-SCAN → parse ALL rows past the preamble. Drift (header-absent / all-malformed)
    // THROWS; header+0-rows ⇒ genuine-empty (below).
    const parsed = parseFullIndex(body);
    const all = parsed.rows;
    // CLIENT-SIDE filters — ZERO query string (none reach the URL). cik via padCik
    // both-sides; companyContains a LITERAL case-insensitive substring (no token split);
    // dates are ISO string compares (the column is already YYYY-MM-DD).
    const formNeedle = args.formType?.trim()
        ? args.formType.trim().toLowerCase()
        : null;
    const cikFilter = args.cik != null && String(args.cik).trim() !== ""
        ? padCik(args.cik)
        : null;
    const companyNeedle = args.companyContains?.trim()
        ? args.companyContains.trim().toLowerCase()
        : null;
    const dateFrom = args.dateFrom;
    const dateTo = args.dateTo;
    const matches = all.filter((row) => {
        if (formNeedle !== null) {
            if (row.formType === null || row.formType.toLowerCase() !== formNeedle)
                return false;
        }
        if (cikFilter !== null) {
            if (row.cikPadded !== cikFilter)
                return false;
        }
        if (companyNeedle !== null) {
            if (row.companyName === null ||
                !row.companyName.toLowerCase().includes(companyNeedle))
                return false;
        }
        if (dateFrom !== undefined) {
            if (row.dateFiled === null || row.dateFiled < dateFrom)
                return false;
        }
        if (dateTo !== undefined) {
            if (row.dateFiled === null || row.dateFiled > dateTo)
                return false;
        }
        return true;
    });
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    const totalAvailable = matches.length; // EXACT (full-scan) — never a page length
    const page = matches.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    const filtersApplied = [];
    if (formNeedle !== null)
        filtersApplied.push("formType");
    if (cikFilter !== null)
        filtersApplied.push("cik");
    if (companyNeedle !== null)
        filtersApplied.push("companyContains");
    if (dateFrom !== undefined)
        filtersApplied.push("dateFrom");
    if (dateTo !== undefined)
        filtersApplied.push("dateTo");
    const notes = [];
    // Index-vs-live-submissions caveat (always).
    notes.push(`The quarterly full-index (master.idx) is a POINT-IN-TIME snapshot of ${year} QTR${quarter}'s EDGAR dissemination feed — it covers ONLY that quarter. For the LATEST or complete-history filings of a KNOWN filer use edgar_company_filings (it fans out older shards); for a text query across 2001-present use edgar_full_text_search.`);
    // Full-scan / exact-total disclosure + the ~33MB size caveat.
    notes.push(`The whole ${year} QTR${quarter} index was downloaded and FULL-SCANNED (~33MB / hundreds of thousands of rows); totalAvailable (${totalAvailable}) is the EXACT count of filings matching the filters across the ENTIRE quarter (not a page length, not a byte-capped subset — SEC ignores HTTP Range). This page contains ${returned} of ${totalAvailable}; page via _meta.pagination.nextOffset for the rest.`);
    if (isCurrentQuarter(year, quarter)) {
        notes.push(`${year} QTR${quarter} is the CURRENT calendar quarter — it GROWS daily as new filings disseminate, so totalAvailable is EXACT AS-OF this (short-cached) snapshot, not exact-forever. A closed past quarter is immutable.`);
    }
    if (companyNeedle !== null) {
        notes.push(`companyContains is a case-insensitive LITERAL substring match on the Company Name column — a multi-word value matches as ONE contiguous string, NOT AND/OR-tokenized.`);
    }
    if (formNeedle !== null) {
        notes.push(`formType is a case-insensitive EXACT match on the Form Type column ("${args.formType?.trim()}" matches that form only — e.g. "8-K" does NOT match "8-K/A"). Pass each amendment variant separately.`);
    }
    if (parsed.malformedRows > 0) {
        notes.push(`${parsed.malformedRows} row(s) did not split into 5 pipe fields and were skipped (tolerated as stray malformed rows; a body with ZERO valid rows would instead be refused as schema drift).`);
    }
    if (parsed.totalIsLowerBound) {
        notes.push(`The scan hit the MAX_INDEX_ROWS safety ceiling (${MAX_INDEX_ROWS}); totals are a LOWER BOUND — the quarter index is larger than expected (possible format drift). See totalIsLowerBound.`);
    }
    if (totalAvailable === 0) {
        notes.push(filtersApplied.length
            ? `0 filings in ${year} QTR${quarter} matched the filters (${filtersApplied.join(", ")}). This is an EXACT ZERO over the full quarter index — NOT a truncation, NOT an outage.`
            : `0 filings in ${year} QTR${quarter} (the quarter index has no data rows). This is an EXACT ZERO over the full quarter index — NOT a truncation, NOT an outage.`);
    }
    const meta = {
        returned,
        totalAvailable,
        filtersApplied,
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    };
    if (parsed.totalIsLowerBound)
        meta.totalIsLowerBound = true;
    return withMeta({
        year,
        quarter,
        indexFile: FULLINDEX_FILE,
        returned,
        totalAvailable,
        filings: page,
    }, edgarMeta(meta));
}
// ─── Tool 7: edgar_daily_filing_index (ADR-0027) ──────────────────
// The per-DAY sibling of edgar_filing_index: read the SEC EDGAR DAILY-index
// (www.sec.gov/Archives/edgar/daily-index/<year>/QTR<n>/master.YYYYMMDD.idx — a
// COMPLETE cross-filer index of EVERY filer's EVERY filing on ONE calendar day,
// pipe-delimited, ~0.5–1.2MB / ~8K rows — ~30× smaller than the quarterly file),
// FULL-SCAN it, apply CLIENT-SIDE filters, and return offset-paginated filings
// with an EXACT total. It answers the monitoring/alerting question the quarterly
// tool cannot without a whole-quarter download ("every 8-K filed on 2024-01-03").
// Reuses getEdgar VERBATIM (UA + gzip + the ≤10 req/s throughGate — UNTOUCHED, so
// the other 6 edgar tools stay byte-identical), `.text()`, padCik, the module-local
// `str`, `driftError`, `buildMeta`/`withMeta`, `edgarMeta`, `splitOnFirstPipes`,
// `MAX_INDEX_ROWS`, `currentUtcYear`, `FILING_ARCHIVE_BASE`, `FULLINDEX_HOST`. A
// DEDICATED daily parser (do NOT reuse parseFullIndex — the daily header is
// `…|Date Filed|File Name` WITH A SPACE, not the full-index `Filename`).
//
// LIVE-VERIFIED 2026-07-12 (SEC UA `cliwant-mcp-sam-gov research (…)`):
//  - master.20240103.idx (Wed) → 200; header VERBATIM `CIK|Company Name|Form Type|
//    Date Filed|File Name` (File Name WITH a space), then `----`; Date Filed column
//    compact `20240103`; 8426 data rows; 8-K = 220, 8-K/A = 5 (distinct/exact).
//  - master.20240106.idx (Sat) → 403 AccessDenied XML; index.json 2024/QTR1 does
//    NOT list it and its newest master is 20240329 ⇒ TRUE genuine-absent (found:false,
//    complete:true) — a real gap INSIDE the covered range.
//  - ★M1 recency (live Sun 2026-07-12): 2026/QTR3 index.json lists master ONLY through
//    master.20260709 (Thu); Fri 20260710 (a normal trading day) is UNLISTED and its
//    .idx 403s ⇒ requestedYyyymmdd > maxListedMasterDate ⇒ NOT-YET-DISSEMINATED
//    (found:false, complete:FALSE), NEVER a confident genuine-absent complete:true.
//
// ★HONESTY: the 403-disambiguation is DESIGN (b) — fetch the .idx FIRST (the happy
// path pays ZERO oracle cost); consult the index.json existence oracle ONLY on a 403,
// RECENCY-AWARE per M1 (maxListedMasterDate: newer-than-listed ⇒ not-yet-disseminated
// complete:FALSE; listed-range gap ⇒ true genuine-absent complete:true; listed-but-403
// ⇒ honest rate_limited; oracle-inconclusive ⇒ ambiguous both-causes upstream_unavailable).
// The 403-reclassify is TOOL-LOCAL (getEdgar UNTOUCHED). M2: an EXACT date round-trip
// PRE-fetch rejects Feb-30 / day-40 / non-leap-Feb-29 / a future date (invalid_input, 0 GET).
const DAILYINDEX_BASE = "https://www.sec.gov/Archives/edgar/daily-index";
const DAILYINDEX_FILE = (yyyymmdd) => `master.${yyyymmdd}.idx`; // the single backing file (pipe-delimited)
const DAILYINDEX_LABEL = "edgar:daily-index"; // host+path only; keyless ⇒ no token can appear
const DAILYINDEX_ORACLE_LABEL = "edgar:daily-index:index.json";
// ★ File Name WITH A SPACE (the daily header) — the full-index uses `Filename` (no
// space); a parser keying drift on `Filename` would FALSE-DRIFT on every valid daily index.
const DAILYINDEX_HEADER = "CIK|Company Name|Form Type|Date Filed|File Name";
const EDGAR_DAILY_START_YEAR = 1994; // EDGAR daily-index begins 1994 Q1 (conservative lower bound)
// A daily-specific bounded LRU of the RAW TEXT keyed by yyyymmdd (mirrors the shipped
// fullIndexCache; NOT the shared unbounded `memoize`, which a many-day sweep would OOM).
// Days are tiny (~0.5–1.2MB) → a larger cap than full-index's 3 is cheap. TTL splits:
// TODAY may still be posting until ~22:00 ET → short TTL; a PAST day is immutable →
// long TTL. The index.json oracle is fetched ONLY on the rare 403 path and is NOT cached.
const DAILYINDEX_CACHE_MAX = 8;
const DAILYINDEX_TTL_TODAY_MS = 5 * 60 * 1000; // today may still be posting → short TTL
const DAILYINDEX_TTL_CLOSED_MS = 24 * 60 * 60 * 1000; // a past day is immutable → long TTL
const dailyIndexCache = new Map();
/** Throw the pre-fetch bounds/injection guard error (invalid_input, 0 fetch). */
function dailyIndexInvalid(message) {
    throw new ToolErrorCarrier({
        kind: "invalid_input",
        message,
        retryable: false,
        upstreamEndpoint: DAILYINDEX_LABEL,
    });
}
/** Today's date as compact `YYYYMMDD` in UTC (call-time fresh — survives a day rollover). */
function todayUtcYyyymmdd() {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1;
    const d = now.getUTCDate();
    return `${y}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}
/** True iff the compact `yyyymmdd` is TODAY (UTC) — the freshness/cache-TTL signal. */
function isTodayUtc(yyyymmdd) {
    return yyyymmdd === todayUtcYyyymmdd();
}
/**
 * Normalize the row's compact `Date Filed` (`YYYYMMDD`, fact #3) to ISO `YYYY-MM-DD`
 * for the `dateFiled` output (so it matches edgar_filing_index / edgar_company_filings
 * and is human-readable). A non-8-digit value is kept as-is (defensive; via `str`).
 */
function normDailyDate(raw) {
    const s = str(raw);
    if (s === null)
        return null;
    if (/^\d{8}$/.test(s))
        return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    return s;
}
/**
 * Build the daily-index URL from the caller-influenced segments (year, quarter,
 * yyyymmdd — all DERIVED from one validated ISO date). BELT-AND-SUSPENDERS behind Zod
 * (a direct handler call could bypass it): re-run the integer/range guards + the
 * 8-digit-tied-to-year regex, then assert the built URL is https on the fixed
 * www.sec.gov host. The 8-digit regex admits NO `%`/`/`/`.`/`\`/`..`/`%2F` (JS `\d`
 * is ASCII-only). This does NOT reject a well-formed-but-NONEXISTENT day (Feb-30) —
 * the pre-fetch date round-trip (M2, in the handler) is the SOLE defense for that.
 */
function buildDailyIndexUrl(year, quarter, yyyymmdd) {
    const maxYear = currentUtcYear();
    if (!Number.isInteger(year) || year < EDGAR_DAILY_START_YEAR || year > maxYear) {
        dailyIndexInvalid(`edgar_daily_filing_index: year ${JSON.stringify(year)} must be an integer in [${EDGAR_DAILY_START_YEAR}, ${maxYear}] (EDGAR daily-index begins 1994 Q1; a future year has no published daily index) — refused before any fetch (path-segment bounds guard).`);
    }
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
        dailyIndexInvalid(`edgar_daily_filing_index: quarter ${JSON.stringify(quarter)} must be an integer in {1,2,3,4} — refused before any fetch (path-segment bounds guard).`);
    }
    if (!/^\d{8}$/.test(yyyymmdd) || yyyymmdd.slice(0, 4) !== String(year)) {
        dailyIndexInvalid(`edgar_daily_filing_index: yyyymmdd ${JSON.stringify(yyyymmdd)} must be 8 digits whose year prefix === ${year} — refused before any fetch (path-segment injection guard; ties the compact day to the validated year, admits no slash/dot/percent/'..').`);
    }
    const built = `${DAILYINDEX_BASE}/${year}/QTR${quarter}/${DAILYINDEX_FILE(yyyymmdd)}`;
    let parsed;
    try {
        parsed = new URL(built);
    }
    catch {
        dailyIndexInvalid(`edgar_daily_filing_index: could not construct a valid URL from year=${year} quarter=${quarter} yyyymmdd=${yyyymmdd} — refused before any fetch.`);
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== FULLINDEX_HOST) {
        dailyIndexInvalid(`edgar_daily_filing_index: constructed URL host/scheme is not https://${FULLINDEX_HOST} (${parsed.protocol}//${parsed.hostname}) — refused before any fetch (fixed-host assertion).`);
    }
    return built;
}
/** Build the quarter's index.json existence-oracle URL (same year/quarter guard). */
function buildDailyOracleUrl(year, quarter) {
    const maxYear = currentUtcYear();
    if (!Number.isInteger(year) || year < EDGAR_DAILY_START_YEAR || year > maxYear) {
        dailyIndexInvalid(`edgar_daily_filing_index: oracle year ${JSON.stringify(year)} must be an integer in [${EDGAR_DAILY_START_YEAR}, ${maxYear}] — refused before any fetch (path-segment bounds guard).`);
    }
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
        dailyIndexInvalid(`edgar_daily_filing_index: oracle quarter ${JSON.stringify(quarter)} must be an integer in {1,2,3,4} — refused before any fetch (path-segment bounds guard).`);
    }
    const built = `${DAILYINDEX_BASE}/${year}/QTR${quarter}/index.json`;
    let parsed;
    try {
        parsed = new URL(built);
    }
    catch {
        dailyIndexInvalid(`edgar_daily_filing_index: could not construct a valid oracle URL from year=${year} quarter=${quarter} — refused before any fetch.`);
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== FULLINDEX_HOST) {
        dailyIndexInvalid(`edgar_daily_filing_index: constructed oracle URL host/scheme is not https://${FULLINDEX_HOST} (${parsed.protocol}//${parsed.hostname}) — refused before any fetch (fixed-host assertion).`);
    }
    return built;
}
/**
 * Parse the raw daily master.YYYYMMDD.idx body into `FilingIndexRow[]` (DEDICATED —
 * NOT parseFullIndex). DRIFT keys on the ABSENCE of the daily `CIK|Company Name|Form
 * Type|Date Filed|File Name` header (★ File Name WITH A SPACE) + the `----` dashes
 * boundary ONLY (M1/fact #2) — a non-index / error / format-changed body served with
 * HTTP 200 → THROW `driftError`. A body WITH the header+dashes but ZERO data rows is a
 * GENUINE-EMPTY day → returned (NOT thrown; near-unreachable for a real trading day but
 * honest). A body WITH the header+dashes whose EVERY data row fails the 5-field split →
 * THROW `driftError` (all-malformed = format drift). Date Filed is normalized to ISO.
 */
export function parseDailyIndex(body, maxRows = MAX_INDEX_ROWS) {
    const lines = body.split("\n");
    // Locate the DAILY header line immediately followed by the `----` dashes boundary.
    let dashesIdx = -1;
    for (let i = 0; i < lines.length - 1; i++) {
        if ((lines[i] ?? "").replace(/\r$/, "").trim() === DAILYINDEX_HEADER) {
            const next = (lines[i + 1] ?? "").replace(/\r$/, "");
            if (/^-{5,}\s*$/.test(next.trim())) {
                dashesIdx = i + 1;
                break;
            }
        }
    }
    if (dashesIdx === -1) {
        throw driftError(DAILYINDEX_LABEL, `edgar:daily-index body is missing the '${DAILYINDEX_HEADER}' header / '----' dashes boundary (a non-index / error / format-changed body served with HTTP 200 — note the daily header is 'File Name' WITH a space, NOT the full-index 'Filename') — refusing to report an empty result (schema drift, NOT a genuine-absent day).`);
    }
    const rows = [];
    let malformedRows = 0;
    let totalIsLowerBound = false;
    for (let i = dashesIdx + 1; i < lines.length; i++) {
        const line = (lines[i] ?? "").replace(/\r$/, "");
        if (line.trim() === "")
            continue; // blank line (e.g. the trailing newline) — skip
        if (rows.length + malformedRows >= maxRows) {
            totalIsLowerBound = true; // safety ceiling — never a SILENT truncation
            break;
        }
        const parts = splitOnFirstPipes(line, 4); // bounded → a `|`-in-company row stays 5 fields
        if (parts.length < 5) {
            malformedRows++;
            continue;
        }
        const cik = str(parts[0]);
        const filename = str(parts[4]);
        rows.push({
            cik,
            cikPadded: cik === null ? null : padCik(cik),
            companyName: str(parts[1]),
            formType: str(parts[2]),
            dateFiled: normDailyDate(parts[3]), // compact YYYYMMDD → ISO YYYY-MM-DD
            filename,
            filingUrl: filename === null ? null : FILING_ARCHIVE_BASE + filename,
        });
    }
    if (rows.length === 0 && malformedRows > 0) {
        throw driftError(DAILYINDEX_LABEL, `edgar:daily-index has the header/dashes boundary but ALL ${malformedRows} data row(s) failed the 5-field pipe split (format drift) — refusing to report an empty result.`);
    }
    return { rows, malformedRows, totalIsLowerBound };
}
/**
 * Fetch the whole day's master.YYYYMMDD.idx text (getEdgar VERBATIM + `.text()`),
 * through the bounded LRU. getEdgar sets the mandatory UA + gzip + the ≤10 req/s gate
 * + the 15s timeout; a 403 throws (rate_limited/403 — caught tool-locally by the
 * handler for the oracle disambiguation), so ONLY a 200 body is ever cached. A slow
 * body-read → abort → getEdgar's honest upstream_unavailable throw (never a fake-empty).
 */
async function fetchDailyIndexText(built, yyyymmdd) {
    const key = yyyymmdd;
    const now = Date.now();
    const hit = dailyIndexCache.get(key);
    if (hit && hit.expiresAt > now) {
        dailyIndexCache.delete(key); // LRU touch → re-insert as the newest
        dailyIndexCache.set(key, hit);
        return hit.text;
    }
    if (hit)
        dailyIndexCache.delete(key); // expired
    const r = await getEdgar(built, DAILYINDEX_LABEL);
    const text = await r.text();
    const ttl = isTodayUtc(yyyymmdd) ? DAILYINDEX_TTL_TODAY_MS : DAILYINDEX_TTL_CLOSED_MS;
    dailyIndexCache.set(key, { text, expiresAt: now + ttl });
    while (dailyIndexCache.size > DAILYINDEX_CACHE_MAX) {
        const oldest = dailyIndexCache.keys().next().value;
        if (oldest === undefined)
            break;
        dailyIndexCache.delete(oldest);
    }
    return text;
}
/** For tests: evict the daily-index bounded LRU (mirrors `_resetFullIndexCache`). */
export function _resetDailyIndexCache() {
    dailyIndexCache.clear();
}
/**
 * Consult the quarter's index.json existence oracle (getEdgar; ONLY on the 403 path).
 * Returns whether `master.<yyyymmdd>.idx` is listed AND `maxListed` = the newest
 * `YYYYMMDD` among items matching `/^master\.(\d{8})\.idx$/` (M1). Throws on a 403 /
 * unexpected shape — the caller converts that to the ambiguous both-causes
 * upstream_unavailable (the oracle itself is inconclusive).
 */
async function fetchDailyOracle(url, yyyymmdd) {
    const r = await getEdgar(url, DAILYINDEX_ORACLE_LABEL);
    const d = (await r.json());
    const items = d?.directory?.item;
    if (!Array.isArray(items)) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `edgar:daily-index index.json returned an unexpected shape (directory.item[] array missing) — the existence oracle is inconclusive.`,
            retryable: false,
            upstreamEndpoint: DAILYINDEX_ORACLE_LABEL,
        });
    }
    const wanted = DAILYINDEX_FILE(yyyymmdd);
    let listed = false;
    let maxListed = null;
    for (const it of items) {
        const name = typeof it?.name === "string" ? it.name : "";
        const mm = /^master\.(\d{8})\.idx$/.exec(name);
        if (!mm)
            continue;
        if (name === wanted)
            listed = true;
        const day = mm[1];
        if (maxListed === null || day > maxListed)
            maxListed = day;
    }
    return { listed, maxListed };
}
/** Honest found:false bundle for the daily-index absent/not-yet-disseminated states. */
function dailyAbsentBundle(found, date, year, quarter, yyyymmdd, complete, note) {
    return withMeta({
        found,
        date,
        year,
        quarter,
        indexFile: DAILYINDEX_FILE(yyyymmdd),
        returned: 0,
        totalAvailable: 0,
        filings: [],
    }, edgarMeta({
        returned: 0,
        totalAvailable: 0,
        complete,
        notes: [note, DAILY_SNAPSHOT_NOTE],
    }));
}
const DAILY_SNAPSHOT_NOTE = "The daily-index is a point-in-time snapshot of ONE dissemination DAY. For the LATEST or complete-history filings of a KNOWN filer use edgar_company_filings; for a whole quarter use edgar_filing_index; for a text query across 2001-present use edgar_full_text_search.";
/**
 * Read the SEC EDGAR daily-index for one calendar `date` and return the filings
 * matching the given CLIENT-SIDE filters (form / CIK / company substring),
 * offset-paginated, with the EXACT total match count for the day.
 *
 * HONESTY (ADR-0027 v1 + M1 + M2):
 *  - ★M2 — an EXACT date round-trip (Date.UTC component re-extraction) rejects
 *    Feb-30 / day-40 / non-leap-Feb-29 / a malformed / a FUTURE date PRE-fetch
 *    (invalid_input, 0 GET). NOT the `!isNaN(Date.UTC(...))` shortcut (it rolls overflow).
 *  - Fetch the .idx FIRST (happy path pays zero oracle cost). 200 + parseable ⇒
 *    found:true; FULL-SCAN → EXACT totalAvailable (byte-cap forbidden).
 *  - ★M1 — on a 403 (getEdgar mislabels the daily AccessDenied XML rate_limited/403;
 *    caught TOOL-LOCAL), consult index.json; maxListedMasterDate makes it recency-aware:
 *      requestedYyyymmdd > maxListed  ⇒ NOT-YET-DISSEMINATED (found:false, complete:FALSE)
 *      requestedYyyymmdd ≤ maxListed & unlisted ⇒ TRUE genuine-absent (found:false, complete:true)
 *      listed but .idx 403'd          ⇒ honest rate_limited (retryable ~600s)
 *      oracle itself 403/bad-shape     ⇒ ambiguous both-causes upstream_unavailable
 *  - A REAL 429 (status 429, not 403) is NOT caught → stays honest rate_limited.
 *  - CIK stays a STRING; every column via `str`; companyContains is a LITERAL
 *    case-insensitive substring (C110 N/A — no token split).
 */
export async function dailyFilingIndex(args) {
    // ★M2 — EXACT date round-trip PRE-fetch (before the URL builder), 0 GET on failure.
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.date);
    if (!dm) {
        dailyIndexInvalid(`edgar_daily_filing_index: date ${JSON.stringify(args.date)} must be an ISO calendar day YYYY-MM-DD — refused before any fetch.`);
    }
    const y = Number(dm[1]);
    const mo = Number(dm[2]);
    const d = Number(dm[3]);
    // Component re-extraction (NOT !isNaN(Date.UTC(...)) — JS silently rolls Feb-30 →
    // Mar-01, day-40, non-leap Feb-29, so the naive shortcut would FETCH a nonexistent day).
    const dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCFullYear() !== y ||
        dt.getUTCMonth() + 1 !== mo ||
        dt.getUTCDate() !== d) {
        dailyIndexInvalid(`edgar_daily_filing_index: date ${JSON.stringify(args.date)} is not a real calendar day (it does not round-trip through Date.UTC — e.g. 2024-02-30, 2024-01-40, or a non-leap 2023-02-29) — refused before any fetch.`);
    }
    const yyyymmdd = `${dm[1]}${dm[2]}${dm[3]}`;
    const todayYyyymmdd = todayUtcYyyymmdd();
    if (yyyymmdd > todayYyyymmdd) {
        // A future day has not happened — you cannot ask for its filings. TODAY is allowed
        // (reachable; the oracle handles the not-yet-posted case as not-yet-disseminated).
        dailyIndexInvalid(`edgar_daily_filing_index: date ${args.date} is in the FUTURE (> today ${todayYyyymmdd.slice(0, 4)}-${todayYyyymmdd.slice(4, 6)}-${todayYyyymmdd.slice(6, 8)} UTC) — no filings can exist for a day that has not happened. Refused before any fetch.`);
    }
    const quarter = Math.floor((mo - 1) / 3) + 1;
    // S1 — build + re-validate the path BEFORE any fetch (0 fetch on a bad year/quarter/day).
    const built = buildDailyIndexUrl(y, quarter, yyyymmdd);
    // Fetch the whole day (getEdgar VERBATIM + `.text()`, bounded-LRU cached). A 403 is
    // caught TOOL-LOCAL and disambiguated via the index.json oracle (M1) — getEdgar is
    // UNTOUCHED (the other 6 edgar tools stay byte-identical).
    let body;
    try {
        body = await fetchDailyIndexText(built, yyyymmdd);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier &&
            e.toolError.kind === "rate_limited" &&
            e.toolError.upstreamStatus === 403) {
            // ── ★M1 403-DISAMBIGUATION via the index.json existence oracle (recency-aware) ──
            const oracleUrl = buildDailyOracleUrl(y, quarter);
            let oracle;
            try {
                oracle = await fetchDailyOracle(oracleUrl, yyyymmdd);
            }
            catch {
                // The oracle ITSELF 403'd / returned an unexpected shape ⇒ INCONCLUSIVE.
                throw new ToolErrorCarrier({
                    kind: "upstream_unavailable",
                    message: `SEC returned HTTP 403 for the daily-index ${DAILYINDEX_BASE}/${y}/QTR${quarter}/${DAILYINDEX_FILE(yyyymmdd)}, and the index.json existence oracle could not be consulted (it too 403'd / returned an unexpected shape). This is AMBIGUOUS: EITHER ${args.date} has no published daily index OR SEC is rate-limiting this IP at the 10 req/s ceiling (~10-minute block). NOT fabricated as empty — retry after ~10 minutes.`,
                    retryable: true,
                    retryAfterSeconds: 600,
                    upstreamStatus: 403,
                    upstreamEndpoint: DAILYINDEX_LABEL,
                });
            }
            if (oracle.maxListed === null || yyyymmdd > oracle.maxListed) {
                // ★M1 branch (a) — NEWER than anything the oracle has published yet (covers today
                // AND unlisted recent trading day(s) across weekends/holidays) ⇒ NOT-YET-DISSEMINATED.
                // NEVER complete:true — a day full of 8-Ks must not read as a confident empty.
                return dailyAbsentBundle(false, args.date, y, quarter, yyyymmdd, false, // complete:FALSE
                `${args.date} is NEWER than the newest daily index EDGAR has published for this quarter (${oracle.maxListed ? `${oracle.maxListed.slice(0, 4)}-${oracle.maxListed.slice(4, 6)}-${oracle.maxListed.slice(6, 8)}` : "none listed yet"}). EDGAR's daily index and its index.json listing LAG real filing activity and may not be posted for the most recent trading day(s), especially across weekends/holidays — this day may simply not be disseminated yet; retry later (EDGAR posts each day's index around 22:00 US-Eastern). This is NOT a confirmed empty day (complete:false).`);
            }
            if (!oracle.listed) {
                // ★M1 branch (b) — requestedYyyymmdd ≤ maxListed AND still not listed ⇒ a TRUE
                // gap INSIDE the covered range (weekend / holiday / genuinely no-dissemination day).
                return dailyAbsentBundle(false, args.date, y, quarter, yyyymmdd, true, // complete:true — an HONEST genuine-absent, NOT an error/drift/fake-empty
                `master.${yyyymmdd}.idx is NOT published for ${args.date}: it is not listed in the quarter's index.json existence oracle, yet the oracle DOES list newer day(s) (newest ${oracle.maxListed.slice(0, 4)}-${oracle.maxListed.slice(4, 6)}-${oracle.maxListed.slice(6, 8)}) — so this is a genuine gap INSIDE the covered range (a weekend / holiday / no-dissemination day). This is an HONEST genuine-absent answer (found:false, complete:true), NOT an error, NOT a rate-block, NOT a fabricated empty.`);
            }
            // listed === true but the .idx 403'd ⇒ the index EXISTS, SEC rate-blocked this IP.
            throw new ToolErrorCarrier({
                kind: "rate_limited",
                message: `The daily index master.${yyyymmdd}.idx for ${args.date} EXISTS (it IS listed in the quarter's index.json oracle) but the .idx fetch returned HTTP 403 — SEC is rate-limiting this IP at the 10 req/s ceiling (or a transient edge block). Slow down and retry after ~10 minutes. NOT a fake-empty, NOT a genuine-absent day.`,
                retryable: true,
                retryAfterSeconds: 600,
                upstreamStatus: 403,
                upstreamEndpoint: DAILYINDEX_LABEL,
            });
        }
        throw e; // schema_drift / invalid_input(UA) / upstream_unavailable / real 429 — loud
    }
    // 200 path — FULL-SCAN → parse ALL rows past the preamble. Drift (header-absent /
    // all-malformed) THROWS; header+0-rows ⇒ genuine-empty (found:true, totalAvailable:0).
    const parsed = parseDailyIndex(body);
    const all = parsed.rows;
    // CLIENT-SIDE filters — ZERO query string (none reach the URL). cik via padCik
    // both-sides; formType case-insensitive EXACT on col3 ('8-K' ≠ '8-K/A');
    // companyContains a LITERAL case-insensitive substring (no token split, C110 N/A).
    const formNeedle = args.formType?.trim() ? args.formType.trim().toLowerCase() : null;
    const cikFilter = args.cik != null && String(args.cik).trim() !== "" ? padCik(args.cik) : null;
    const companyNeedle = args.companyContains?.trim()
        ? args.companyContains.trim().toLowerCase()
        : null;
    const matches = all.filter((row) => {
        if (formNeedle !== null) {
            if (row.formType === null || row.formType.toLowerCase() !== formNeedle)
                return false;
        }
        if (cikFilter !== null) {
            if (row.cikPadded !== cikFilter)
                return false;
        }
        if (companyNeedle !== null) {
            if (row.companyName === null ||
                !row.companyName.toLowerCase().includes(companyNeedle))
                return false;
        }
        return true;
    });
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    const totalAvailable = matches.length; // EXACT (full-scan) — never a page length
    const page = matches.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    const filtersApplied = [];
    if (formNeedle !== null)
        filtersApplied.push("formType");
    if (cikFilter !== null)
        filtersApplied.push("cik");
    if (companyNeedle !== null)
        filtersApplied.push("companyContains");
    const notes = [];
    notes.push(DAILY_SNAPSHOT_NOTE);
    notes.push(`The whole ${args.date} daily index was downloaded and FULL-SCANNED; totalAvailable (${totalAvailable}) is the EXACT count of filings matching the filters across the ENTIRE day (not a page length, not a byte-capped subset — SEC ignores HTTP Range). This page contains ${returned} of ${totalAvailable}; page via _meta.pagination.nextOffset for the rest.`);
    notes.push(`dateFiled is normalized to ISO YYYY-MM-DD from the index's compact YYYYMMDD column; every row in this file shares the requested day (${args.date}).`);
    if (isTodayUtc(yyyymmdd)) {
        notes.push(`${args.date} is TODAY (UTC) — EDGAR posts each day's index around 22:00 US-Eastern and it GROWS as filings disseminate, so totalAvailable is EXACT AS-OF this (short-cached) snapshot, not exact-forever. A closed past day is immutable.`);
    }
    if (companyNeedle !== null) {
        notes.push(`companyContains is a case-insensitive LITERAL substring match on the Company Name column — a multi-word value matches as ONE contiguous string, NOT AND/OR-tokenized.`);
    }
    if (formNeedle !== null) {
        notes.push(`formType is a case-insensitive EXACT match on the Form Type column ("${args.formType?.trim()}" matches that form only — e.g. "8-K" does NOT match "8-K/A"). Pass each amendment variant separately.`);
    }
    if (parsed.malformedRows > 0) {
        notes.push(`${parsed.malformedRows} row(s) did not split into 5 pipe fields and were skipped (tolerated as stray malformed rows; a body with ZERO valid rows would instead be refused as schema drift).`);
    }
    if (parsed.totalIsLowerBound) {
        notes.push(`The scan hit the MAX_INDEX_ROWS safety ceiling (${MAX_INDEX_ROWS}); totals are a LOWER BOUND — the daily index is larger than expected (possible format drift). See totalIsLowerBound.`);
    }
    if (totalAvailable === 0) {
        notes.push(filtersApplied.length
            ? `0 filings on ${args.date} matched the filters (${filtersApplied.join(", ")}). This is an EXACT ZERO over the full day index (found:true — the day IS published) — NOT a truncation, NOT an outage, NOT a genuine-absent day.`
            : `0 data rows in the ${args.date} daily index (found:true — the day IS published, but its index has no filing rows). This is an EXACT ZERO over the full day index — NOT a truncation, NOT an outage.`);
    }
    const meta = {
        returned,
        totalAvailable,
        filtersApplied,
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    };
    if (parsed.totalIsLowerBound)
        meta.totalIsLowerBound = true;
    return withMeta({
        found: true,
        date: args.date,
        year: y,
        quarter,
        indexFile: DAILYINDEX_FILE(yyyymmdd),
        returned,
        totalAvailable,
        filings: page,
    }, edgarMeta(meta));
}
// ─── Tool 8: edgar_company_concept (ADR-0041) ─────────────────────
// ONE filer × ONE XBRL concept × the COMPLETE reported time-series (with the
// amendment/restatement history + multi-unit disclosure) — the focused
// financial-TREND / entity-vetting primitive that sits BETWEEN company_facts
// (all curated concepts for one filer) and edgar_xbrl_frames (one concept across
// ALL filers for one period). Reuses the C105/C106-hardened edgar.ts adapter
// VERBATIM (getEdgar transport + self-throttle gate + UA + 403 disambiguation,
// padCik + resolveCik, num/str null-never-0, edgarMeta, notFoundBundle, withMeta,
// FRAMES_TAG_RE) — getEdgar UNTOUCHED, so the other 7 edgar tools stay byte-identical.
//
// LIVE-pinned (ADR-0041, 5 keyless GETs, SEC UA, data.sec.gov):
//   GET https://data.sec.gov/api/xbrl/companyconcept/CIK{cik10}/{taxonomy}/{Concept}.json
//   → { cik, taxonomy, tag, label, description, entityName, units:{ "USD":[…], "shares":[…] } }
//   Each unit key maps to its OWN row array; each row { start?, end, val, accn, fy, fp,
//   form, filed, (frame?) }. `unit` is a BODY key (filtered CLIENT-SIDE), NOT a path
//   segment. 404 (bad CIK/taxonomy/concept) → XML NoSuchKey → getEdgar throws not_found
//   BEFORE any JSON parse → notFoundBundle (never a fabricated val:0).
//
// ★M1 (period identity = the (start,end) PAIR, not `end` alone): every output row
//   carries `start` (null for INSTANT concepts, the ISO date for DURATION concepts).
//   The SAME `end` with a DIFFERENT `start` is a different-duration fact (a 3-month
//   quarter vs the 12-month year — LIVE: Apple NetIncomeLoss end=2009-09-26 carries
//   BOTH CY2009 (start 2008-09-28) + CY2009Q3 (start 2009-06-28), both frame-tagged
//   canonical), NOT a revision. A revision is ONLY multiple rows sharing the SAME
//   (start,end) with a differing accn/filed/val.
// ★M2 (canonicalOnly dedup key = (unit,start,end)): partition by unit FIRST, then keep
//   ONE row per distinct (start,end) — never collapsing a whole unit's row.
// ★S1 (unitsAvailable[].count = the RAW units[key].length, pre-filter).
// ★S2 (CONCEPT_TAXONOMIES = {us-gaap, dei, ifrs-full} — all three live-confirmed; srt DROPPED).
/** The companyconcept endpoint base (same data.sec.gov the other edgar tools use). */
const CONCEPT_BASE = "https://data.sec.gov/api/xbrl/companyconcept";
/**
 * The `taxonomy` path-segment enum — the SSRF guard for that segment (no free value
 * reaches the host). us-gaap + dei live-confirmed on Apple; ifrs-full live-confirmed on
 * Spotify (CIK0001639920 / ifrs-full / Assets → 200, unit EUR, frame CY2017Q4I). `srt`
 * is DROPPED (S2 — it was NOT probed to a resolving 200; a valid-but-unreported tuple is
 * an honest 404, so a slightly-broad enum can never fabricate — but ship only confirmed).
 */
export const CONCEPT_TAXONOMIES = ["us-gaap", "dei", "ifrs-full"];
/** A 10-digit CIK path segment (post-padCik; rejects an 11-digit overflow). */
const CIK10_RE = /^\d{10}$/;
/** Throw the pre-fetch injection-guard error (invalid_input, 0 fetch). */
function conceptInvalid(message) {
    throw new ToolErrorCarrier({
        kind: "invalid_input",
        message,
        retryable: false,
        upstreamEndpoint: "edgar:companyconcept",
    });
}
/**
 * Build the companyconcept URL from the THREE validated path segments (COPIES the
 * buildFramesUrl S1/S2 doctrine — with THREE segments, NOT four; `unit` is a BODY key,
 * never a path segment). BELT-AND-SUSPENDERS: re-run the cik regex + the taxonomy enum
 * + the concept regex and hard-throw invalid_input (0 fetch) on any mismatch — do NOT
 * trust that Zod already ran, and do NOT rely on the hostname assertion alone (it passes
 * a same-host `../` traversal). THEN assert the built URL is https on the fixed
 * data.sec.gov host (guards host-escape/downgrade).
 */
function buildConceptUrl(cik10, taxonomy, tag) {
    if (!CIK10_RE.test(cik10)) {
        conceptInvalid(`edgar_company_concept: CIK ${JSON.stringify(cik10)} must be exactly 10 digits after padding (an 11-digit overflow is rejected) — refused before any fetch (path-segment injection guard).`);
    }
    if (!CONCEPT_TAXONOMIES.includes(taxonomy)) {
        conceptInvalid(`edgar_company_concept: taxonomy ${JSON.stringify(taxonomy)} is not one of {${CONCEPT_TAXONOMIES.join(", ")}} — refused before any fetch (path-segment injection guard).`);
    }
    if (!FRAMES_TAG_RE.test(tag)) {
        conceptInvalid(`edgar_company_concept: concept ${JSON.stringify(tag)} must match ^[A-Za-z0-9]+$ (XBRL tags are alphanumeric CamelCase, e.g. NetIncomeLoss; slash/dot/percent/backslash/'..'/%2F/%2E/%00 are rejected) — refused before any fetch (path-segment injection guard).`);
    }
    const built = `${CONCEPT_BASE}/CIK${cik10}/${taxonomy}/${tag}.json`;
    let parsed;
    try {
        parsed = new URL(built);
    }
    catch {
        conceptInvalid(`edgar_company_concept: could not construct a valid URL from the segments — refused before any fetch.`);
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "data.sec.gov") {
        conceptInvalid(`edgar_company_concept: constructed URL host/scheme is not https://data.sec.gov (${parsed.protocol}//${parsed.hostname}) — refused before any fetch (fixed-host assertion).`);
    }
    return built;
}
/**
 * The all-rows default disclosure note (M1-corrected). Rides on EVERY found:true
 * response. The load-bearing correction vs v1: for flow/duration concepts the same
 * `end` with a different `start` is a DIFFERENT-DURATION fact, NOT a revision.
 */
const AMENDMENT_DISCLOSURE_NOTE = "Rows are SEC's COMPLETE reported history for this concept, each tagged with its unit. Period identity is the (start,end) PAIR: `start` is null for INSTANT (balance-sheet) concepts and the ISO period-start date for DURATION (flow) concepts. For flow/duration concepts the same `end` with a different `start` is a different-duration fact (a 3-month quarter vs the 12-month year), NOT a revision; a revision is only multiple rows sharing the same (start,end) with different accn/filed/val — read the filed dates. `canonical:true` (a `frame` tag present) marks SEC's consolidated value for that (start,end) period; `canonical:false` rows are earlier/superseded/intra-year reports. Values are surfaced verbatim (val is null-never-0); none is recomputed.";
/** The (unit,start,end) group key (M1/M2). A space joiner keeps the three fields distinct. */
function periodKey(r) {
    return `${r.unit} ${r.start ?? ""} ${r.end ?? ""}`;
}
/**
 * Deterministic canonicalOnly tiebreak within a (unit,start,end) group: prefer a
 * frame-tagged row, then max `filed`, then max `accn`. ALWAYS a verbatim selection of
 * an existing row (never a merge/recompute).
 */
function preferCanonical(a, b) {
    const af = a.frame != null;
    const bf = b.frame != null;
    if (af !== bf)
        return af ? a : b;
    const afiled = a.filed ?? "";
    const bfiled = b.filed ?? "";
    if (afiled !== bfiled)
        return afiled > bfiled ? a : b;
    const aaccn = a.accn ?? "";
    const baccn = b.accn ?? "";
    return aaccn >= baccn ? a : b;
}
/**
 * One filer × one XBRL concept × the COMPLETE reported time-series. Reuses resolveCik
 * (ticker→CIK path EXISTS) + buildConceptUrl (the frames path-segment SSRF doctrine,
 * THREE segments) + getEdgar VERBATIM. `unit`/`form`/`fy` are CLIENT-SIDE filters;
 * `canonicalOnly` (default false) dedups to one canonical row per (unit,start,end),
 * FULLY DISCLOSED. limit/offset window the already-fully-fetched set.
 *
 * HONESTY (ADR-0041 v2):
 *  - ★M1 — every row carries `start`; period identity is the (start,end) PAIR. A
 *    same-`end` different-`start` pair is a different-duration fact, NOT a revision.
 *  - ★M2 — canonicalOnly dedup key = (unit,start,end): partition by unit first, keep
 *    one canonical row per distinct (start,end) — never dropping a whole unit's row.
 *  - ★S1 — unitsAvailable[].count = the RAW units[key].length (pre-filter).
 *  - val null-never-0 via num(); every row unit-tagged (no USD↔shares conflation).
 *  - 404 (bad CIK/taxonomy/concept) → notFoundBundle (never a fabricated val:0);
 *    5xx/timeout/non-JSON/units-shape-drift → THROW; a bad `unit` filter → honest empty
 *    + the available-units note (unit is CLIENT-SIDE, never a path segment).
 */
export async function companyConcept(args) {
    const resolved = await resolveCik(args.cikOrTicker);
    if (!resolved) {
        return notFoundBundle(args.cikOrTicker, `Could not resolve "${args.cikOrTicker}" to a CIK (not a numeric CIK and no exact-ticker/title match in company_tickers.json).`);
    }
    const cik = resolved.cik;
    const taxonomy = args.taxonomy ?? "us-gaap";
    const concept = args.concept;
    // S1/S2 — build (and re-validate) the path BEFORE any fetch. Throws invalid_input
    // with 0 fetches on any bad segment or a non-fixed-host URL.
    const url = buildConceptUrl(cik, taxonomy, concept);
    let body;
    try {
        const r = await getEdgar(url, "edgar:companyconcept");
        // A 200 body that is NOT valid JSON (an HTML/XML outage slipping through with 200)
        // → SyntaxError → schema_drift THROW (ADR-0003 doctrine), never a fake empty.
        try {
            body = (await r.json());
        }
        catch {
            throw new ToolErrorCarrier({
                kind: "schema_drift",
                message: `edgar:companyconcept returned an HTTP 200 body that is not valid JSON for CIK ${cik} / ${taxonomy} / ${concept} — an outage/error page masquerading as a 200. Refusing rather than fabricating an empty result.`,
                retryable: false,
                upstreamEndpoint: "edgar:companyconcept",
            });
        }
    }
    catch (e) {
        // 404 (bad CIK / bad taxonomy / a concept the filer never reported) ⇒ getEdgar throws
        // not_found BEFORE any .json() (the XML NoSuchKey body is never parsed) ⇒ notFoundBundle.
        if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
            return notFoundBundle(`${cik}/${taxonomy}/${concept}`, `No XBRL companyconcept matched CIK ${cik} / ${taxonomy} / ${concept} (HTTP 404). The filer did NOT report this concept under this exact taxonomy — this is NOT a value of 0. Check the tag spelling/case (XBRL tags are CamelCase, e.g. NetIncomeLoss) and the taxonomy (us-gaap vs dei vs ifrs-full).`);
        }
        throw e;
    }
    // Drift guard: `units` MISSING / not an object / an array ⇒ schema_drift THROW (the
    // envelope changed) — never a fabricated empty.
    const units = body.units;
    if (units === null || typeof units !== "object" || Array.isArray(units)) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `edgar:companyconcept returned HTTP 200 without a units{} object for CIK ${cik} / ${taxonomy} / ${concept} — the companyconcept envelope changed.`,
            retryable: false,
            upstreamEndpoint: "edgar:companyconcept",
        });
    }
    const unitsObj = units;
    const unitKeys = Object.keys(unitsObj);
    // ★S1 — unitsAvailable[].count = the RAW per-unit array length, computed BEFORE any
    // unit/form/fy/canonicalOnly/limit/offset filtering (a filtered count is a masquerade).
    const unitsAvailable = unitKeys.map((k) => ({
        unit: k,
        count: Array.isArray(unitsObj[k]) ? unitsObj[k].length : 0,
    }));
    // Build ALL rows, TAGGED with unit (P3 — never conflate USD with shares). Iterate the
    // unit keys in a DETERMINISTIC order (ascending) for a stable window; each unit's rows
    // stay in SEC's returned order (no blind re-sort — the edgar_company_filings doctrine).
    const sortedUnitKeys = [...unitKeys].sort();
    const allRows = [];
    for (const uKey of sortedUnitKeys) {
        const arr = unitsObj[uKey];
        if (!Array.isArray(arr))
            continue; // defensive — a non-array unit contributes no rows
        for (const raw of arr) {
            const frame = str(raw.frame);
            allRows.push({
                unit: uKey,
                start: str(raw.start), // null for INSTANT concepts; ISO date for DURATION (M1)
                end: str(raw.end),
                val: num(raw.val), // null-never-0
                accn: str(raw.accn),
                fy: typeof raw.fy === "number" ? raw.fy : null,
                fp: str(raw.fp),
                form: str(raw.form),
                filed: str(raw.filed),
                frame,
                canonical: frame != null,
            });
        }
    }
    // Defensive empty (Q5): a 200 whose units{} has ZERO keys or ALL-empty arrays ⇒ an
    // honest empty (found:false, complete:true), NOT a crash and NOT a fabricated row.
    if (allRows.length === 0) {
        return withMeta({
            found: false,
            cik,
            entityName: str(body.entityName),
            taxonomy,
            concept,
            label: str(body.label),
            description: str(body.description),
            unitsAvailable,
            rows: [],
        }, edgarMeta({
            returned: 0,
            totalAvailable: 0,
            complete: true,
            filtersApplied: ["concept", "taxonomy"],
            notes: [
                `The companyconcept document for CIK ${cik} / ${taxonomy} / ${concept} has no reported data points (units{} is empty). This is an honest empty — NOT a value of 0 and NOT an outage.`,
            ],
        }));
    }
    // ── CLIENT-SIDE filters (unit/form/fy) — none reaches the URL. ──
    const unitFilter = args.unit?.trim() ? args.unit.trim() : null;
    const formFilter = args.form?.trim() ? args.form.trim().toLowerCase() : null;
    const fyFilter = typeof args.fy === "number" ? args.fy : null;
    const canonicalOnly = args.canonicalOnly ?? false;
    let filtered = allRows;
    if (unitFilter !== null)
        filtered = filtered.filter((r) => r.unit === unitFilter);
    if (formFilter !== null)
        filtered = filtered.filter((r) => r.form != null && r.form.toLowerCase() === formFilter);
    if (fyFilter !== null)
        filtered = filtered.filter((r) => r.fy === fyFilter);
    // Group the FILTERED rows by (unit,start,end) ONCE — used for BOTH revision detection
    // (over the pre-dedup set) and the canonicalOnly dedup (M1/M2).
    const groups = new Map();
    const groupOrder = [];
    for (const r of filtered) {
        const key = periodKey(r);
        let g = groups.get(key);
        if (!g) {
            g = [];
            groups.set(key, g);
            groupOrder.push(key);
        }
        g.push(r);
    }
    // ★M1 revision detection: a GENUINE restatement is ≥2 rows sharing the SAME
    // (unit,start,end) with ≥2 DISTINCT non-null vals. A same-`end` different-`start`
    // pair lands in DIFFERENT groups (singletons) ⇒ NOT flagged as a revision.
    const revisedPeriods = groupOrder
        .map((k) => groups.get(k))
        .filter((g) => {
        if (g.length < 2)
            return false;
        const vals = new Set(g.filter((r) => r.val !== null).map((r) => r.val));
        return vals.size >= 2;
    })
        .map((g) => {
        const first = g[0];
        return { unit: first.unit, start: first.start, end: first.end };
    });
    // ★M2 canonicalOnly — partition by unit FIRST (already reflected in the (unit,start,end)
    // key), keep ONE row per distinct (start,end): frame-tagged, else the latest-filed
    // fallback (marked canonical:false). Deterministic tiebreak via preferCanonical.
    if (canonicalOnly) {
        filtered = groupOrder.map((k) => groups.get(k).reduce(preferCanonical));
    }
    // ── Pagination — client-side window over the (unit,start,end)-keyed filtered set. ──
    const totalAvailable = filtered.length;
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    const page = filtered.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    const filtersApplied = ["concept", "taxonomy"];
    if (unitFilter !== null)
        filtersApplied.push("unit");
    if (formFilter !== null)
        filtersApplied.push("form");
    if (fyFilter !== null)
        filtersApplied.push("fy");
    if (canonicalOnly)
        filtersApplied.push("canonicalOnly");
    const notes = [AMENDMENT_DISCLOSURE_NOTE];
    // Unit-filter disclosure (Q2-c) — NEVER hide the other units.
    if (unitFilter !== null) {
        if (unitKeys.includes(unitFilter)) {
            const others = unitKeys.filter((k) => k !== unitFilter);
            notes.push(others.length
                ? `unit filter '${unitFilter}' applied; this concept is ALSO reported in unit(s) ${others.join(", ")} for this filer (not shown). Re-request without the unit filter, or with a different unit, to see them.`
                : `unit filter '${unitFilter}' applied; it is the only unit this filer reports for this concept.`);
        }
        else {
            notes.push(`unit filter '${unitFilter}' matched NONE of this filer's reported unit(s) for this concept (available: ${unitKeys.join(", ") || "none"}). Returning 0 rows for that filter — this is NOT a value of 0; re-request with one of the available units, or omit unit.`);
        }
    }
    // ★M1 revision note — a distinctive phrase so a caller (and the fault fixtures) can
    // tell a GENUINE restatement from ordinary duration-multiplicity.
    if (revisedPeriods.length) {
        const ex = revisedPeriods
            .slice(0, 3)
            .map((p) => `(unit ${p.unit}, ${p.start != null ? `start ${p.start}, ` : ""}end ${p.end})`)
            .join("; ");
        notes.push(`Restatement/revision detected: ${revisedPeriods.length} (unit,start,end) period(s) carry MULTIPLE rows with a DIFFERING val — the figure WAS revised for ${ex}${revisedPeriods.length > 3 ? " (and more)" : ""}. Read the filed dates; the frame-tagged (canonical) row carries SEC's consolidated value.`);
    }
    // canonicalOnly disclosure (Q3) — the dedup is FULLY disclosed, never silent.
    if (canonicalOnly) {
        notes.push("canonicalOnly=true: reduced to ONE row per distinct (unit,start,end) period — the frame-tagged canonical value, or (for a period SEC has not yet consolidated) the latest-filed row, marked canonical:false. SUPERSEDED/amendment rows sharing the same (start,end) were REMOVED; a value may have been revised — re-request with canonicalOnly=false to see the full amendment history. NOTE: the same `end` with a different `start` is a DIFFERENT period (kept separately), not a duplicate.");
    }
    // Raw-vs-filtered total disclosure (Q4) — fetch-once, exact filtered total.
    notes.push(`served ${allRows.length} row(s) across unit(s) ${unitKeys.join(", ")}; after filters (${filtersApplied.join(", ")}) → ${totalAvailable} pageable; totalAvailable reflects the FILTERED (unit,start,end)-keyed set. The full per-unit series was fetched in ONE request (SEC does not paginate companyconcept); limit/offset is a client-side window.`);
    if (resolved.title)
        notes.push(`Resolved "${args.cikOrTicker}" → ${resolved.title} (CIK ${cik}).`);
    return withMeta({
        found: true,
        cik,
        entityName: str(body.entityName),
        taxonomy,
        concept,
        label: str(body.label),
        description: str(body.description),
        unitsAvailable,
        rows: page,
    }, edgarMeta({
        returned,
        totalAvailable,
        filtersApplied,
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    }));
}
//# sourceMappingURL=edgar.js.map