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
import { throughGate } from "./datasource.js";
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
    let failedShards = 0;
    let missingFilings = 0; // Σ (declared − actual) for partial/failed shards.
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
                    missingFilings += declared - rows.length;
                    shardNotes.push(`shard ${name} returned ${rows.length} of ${declared} declared filings (recent→shard roll or upstream lag); not fabricated.`);
                }
            }
            catch (e) {
                const kind = e instanceof ToolErrorCarrier ? e.toolError.kind : "unknown";
                // not_found = a genuine 404 OR a refused bad/cross-CIK/host name (0 fetch).
                // Degrade to PARTIAL and continue; the declared filings are missing.
                if (kind === "not_found") {
                    failedShards++;
                    missingFilings += declared;
                    continue;
                }
                // schema_drift / rate_limited / invalid_input / upstream_unavailable →
                // fail LOUD (a shape break or a systemic UA/rate/outage fault is not a
                // per-shard degrade — never a fake-partial).
                throw e;
            }
        }
    }
    // Filings in the un-fetched (capped) older shards — reachable only by raising
    // maxShards, NOT by nextOffset (the two-axis "more", M2).
    const skippedFilings = fanoutRan && totalShards > maxShards
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
    // is the un-fetched-cap OR any failed shard (unfetchedOrFailed) — NOT the plain
    // hasShards boolean. A mutation that sets hasMore from moreInWindow alone → RED.
    const beyondWindow = fanoutRan
        ? fetchedShards < totalShards || failedShards > 0
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
        // allFetched = every shard the cap allowed was fetched WITHOUT a 404/skip.
        // "complete" (for the COMPLETE note + the forms-note wording) additionally
        // requires zero short-shard shortfalls (missingFilings 0).
        const allFetched = failedShards === 0 && fetchedShards === totalShards;
        const complete = allFetched && missingFilings === 0;
        if (complete) {
            notes.push(`COMPLETE filing history: fetched all ${totalShards} older shard(s) plus the recent window (${subm.recentCount}) = ${totalAvailable} filings.`);
        }
        else {
            if (fetchedShards < totalShards) {
                // PARTIAL-BY-CAP — split the two "more" axes explicitly (M2).
                const unfetched = totalShards - fetchedShards;
                notes.push(`PARTIAL history (maxShards cap ${maxShards}): fetched the ${fetchedShards} newest of ${totalShards} shard(s). Paginate via nextOffset for MORE OF THIS fetched window (${fetchedShards} newest shard(s) + the recent ${subm.recentCount}); pagination will NOT reach the ${unfetched} older un-fetched shard(s) (${skippedFilings} filings) — RAISE maxShards (max 100) to fetch those.`);
            }
            if (failedShards > 0) {
                // PARTIAL-BY-FAILURE (one or more shards 404'd / were skipped).
                notes.push(`PARTIAL history: ${failedShards} shard(s) could not be fetched (HTTP 404 / bad-or-cross-CIK name / transient); ${missingFilings} filing(s) are missing from this history. Not fabricated.`);
            }
            else if (allFetched && missingFilings > 0) {
                // All shards fetched, but some declared rows were absent (recent→shard
                // roll / upstream lag) — a benign shortfall, disclosed per-shard below.
                notes.push(`Fetched all ${totalShards} older shard(s) plus the recent window (${subm.recentCount}), but ${missingFilings} declared filing(s) were absent from the returned shard body(ies) (recent→shard roll or upstream lag); disclosed per-shard below and NOT fabricated.`);
            }
        }
        if (forms && forms.length) {
            notes.push(complete
                ? "The form filter now spans the COMPLETE fetched history (recent + all shards); totalAvailable stays the grand UNFILTERED total, so complete may read false — an under-claim, NOT missing older matches."
                : "Form filtering was applied across the fetched window (recent + fetched shards) — older matching filings may exist in the un-fetched/failed shards.");
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
//# sourceMappingURL=edgar.js.map