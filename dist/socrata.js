/**
 * Socrata / SODA — keyless open data for state / local (SLED) + E-rate portals.
 *
 * First SLED source (ADR-0004); 3rd consumer of the fetch/map/meta shape after
 * treasury.ts / edgar.ts. Fully PUBLIC, KEYLESS. ONE connector reaches ~a dozen
 * US state portals + E-rate on the IDENTICAL SODA JSON API — swap hostname + a
 * 4x4 dataset id. Hosts are a CURATED allowlist (see SSRF below); the caller
 * never supplies a free host or a free path.
 *   Row query:  https://{domain}/resource/{4x4}.json?$select=…&$where=…&$limit=…
 *   Catalog:    https://api.us.socrata.com/api/catalog/v1?domains={domain}&q=…
 *
 * Three layers (mirror treasury.ts / edgar.ts):
 *   fetch — `getSocrataResource` / `getCatalog`: SSRF-guard, build the URL,
 *           set `redirect:"error"` + the optional app-token header, reuse
 *           errors.ts retry/timeout/taxonomy. Return the parsed JSON.
 *   map   — rows pass through mostly verbatim (already JSON; value fields are
 *           strings). `num(x)` → number|null (NEVER 0 for absent) for the count
 *           coercion. `mapCatalogRow` for discovery.
 *   meta  — `withMeta(...)`: hands totalAvailable/returned/pagination/notes to
 *           meta.ts's `buildMeta`, which DERIVES complete/truncated.
 *
 * ★ SSRF GUARD (policy① — the central design risk). The `domain` param is an
 * arbitrary-host vector, so it is a curated allowlist-enum + a fixed path (this
 * mirrors the treasury `dataset` enum + SamAttachmentUrl fixed-base). Validation
 * order: (1) domain ∈ SOCRATA_DOMAINS (a Zod enum at the server boundary, AND a
 * belt-and-suspenders Set check here) → else invalid_input BEFORE any fetch;
 * (2) datasetId matches /^[a-z0-9]{4}-[a-z0-9]{4}$/ AND is exactly 9 chars (M2 —
 * `.length(9)` on the RAW string rejects a trailing `\n` that the regex `$` would
 * otherwise admit; the Zod schema deliberately does NOT `.trim()`, since Zod
 * trims BEFORE `.length(9)` and would strip the `\n` to a valid id — defeating
 * the guard; see server.ts SocrataQueryInput);
 * (3) construct the URL, then ASSERT `new URL(built).hostname === domain` and
 * `protocol === "https:"`; (4) SoQL params go through URLSearchParams — encoded
 * values, no host-alteration surface (bad SoQL is upstream-validated: 400 →
 * invalid_input, surfaced, never silent). Adding a domain later = an allowlist
 * SOURCE edit + a live `$limit=1` verification + a test note — NEVER a free
 * runtime param.
 *
 * B1 (SSRF, redirect) — the pre-fetch `hostname === domain` assertion runs
 * BEFORE fetch, which defaults to `redirect:"follow"`; a 3xx from an allowlisted
 * host (migration / DNS-hijack / decommissioned-then-reused domain) would be
 * followed to an off-allowlist target the pre-check never sees. `attachments.ts`
 * closes this with a post-redirect `finalHost` check (~L484–515). SODA
 * `/resource/{4x4}.json` and the catalog are direct-JSON endpoints, so a 3xx is
 * anomalous → we set `redirect:"error"` in the init passed to fetchWithRetry for
 * EVERY socrata + catalog fetch (row, count companion, catalog). errors.ts's
 * fetchWithRetry calls `fetch(url, init)` directly (L139), forwarding `init`
 * verbatim, so `redirect:"error"` IS honored (confirmed) — a redirect makes
 * fetch throw, is never followed, and its body is never read back.
 *
 * B2 (honesty, hasMore) — SODA's row response has NO total, so `hasMore` must
 * NOT short-circuit to false on an unknown total (that would lie complete:true
 * on a full page and stop an agent mid-dataset). Formula:
 *   hasMore = totalAvailable !== null ? (offset + returned < totalAvailable)
 *                                     : (returned >= limit)
 * SODA returns fewer than $limit ONLY when the result set is exhausted, so
 * `returned >= limit` on an unknown total is the correct hedge (→ truncated).
 *
 * m3 (honesty, catalog drift) — `socrata_discover_datasets` is the catalog's
 * PRIMARY response; if `typeof resultSetSize !== "number"` → hard schema_drift
 * throw (nothing valid to return), then `totalAvailable = num(resultSetSize)`.
 *
 * m4 (honesty, count companion) — the count(*) companion is a best-effort
 * enrichment of an ALREADY-SUCCESSFUL row query: ANY count failure → degrade to
 * totalAvailable:null and STILL return the rows (never lose good data, never
 * fake complete). The note distinguishes a transient fetch throw from a 200 +
 * wrong shape (possible upstream API change). A hard schema_drift throw is
 * reserved for a PRIMARY query (rows / catalog), NEVER the secondary count.
 *
 * ALLOWLIST — LIVE-VERIFIED 2026-07-10 (each carries a real sample 4x4). All
 * `.gov` except `opendata.usac.org`:
 *   m6 — `opendata.usac.org` is a `.org` (USAC, a Congress-designated non-profit;
 *        E-rate). It is on the periodic re-verification checklist. NOTE: the
 *        federated discovery catalog (api.us.socrata.com) does NOT index USAC
 *        (returns resultSetSize 0), so `socrata_discover_datasets` will not
 *        surface it — but `socrata_query` works against it with a known 4x4
 *        (live: opendata.usac.org/resource/avi8-svp9.json → 200 bare array).
 *   M1 — MA is DROPPED from slice 1: `cthru.data.socrata.com` is a commercial
 *        vendor host (Tyler Technologies `.socrata.com`, not gov-controlled) and
 *        no `.gov` MA Socrata host verifies (`data.mass.gov` → the catalog
 *        answers "Domain not found"). Keep the allowlist all-`.gov` + the one
 *        `.org` USAC; revisit MA when a `data.mass.gov` (or documented
 *        trust-boundary caveat) verifies.
 *   CHURN-EXCLUDED — VA (→CKAN), IA (left Socrata → SODA 404s), MI (→SIGMA), and
 *        IL (`data.illinois.gov` — live 2026-07-10 the catalog returns 0
 *        datasets; its ids are "story" types whose resource endpoints 403/404,
 *        i.e. no queryable SODA table) are NOT in the allowlist.
 *
 * TOOL LEANNESS — slice 1 ships 2 core tools (socrata_query + socrata_discover_
 * datasets). The optional `socrata_state_datasets` (a static state→portal→4x4
 * map) is NOT shipped: a hand-curated list of specific 4x4 ids is precisely the
 * staleness/honesty liability the churn exclusion warns about (a moved dataset
 * silently 404s), and discovery is already served — always FRESH — by the live
 * catalog in socrata_discover_datasets, while the state→domain mapping is already
 * visible in the `domain` enum. So it does not earn its schema cost. (Documented
 * for the reviewer.)
 *
 * Keyless-first — keyless works everywhere above (all live-verified without a
 * token); a FREE `X-App-Token` only lifts the shared-IP 429 limits. Optional
 * `SOCRATA_APP_TOKEN` → the `X-App-Token` header only; never required, never
 * logged, never placed in `_meta` or an error (see m7 at the fetch call site).
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy now lives in
// ./coerce.js — ADR-0005 v2 FIX-C) so existing importers and the fault suite's
// num-parity guard keep resolving `num` from this module.
export { num };
// ─── Curated allowlist (SSRF core) ────────────────────────────────
// A frozen list of live-verified (2026-07-10) Socrata SODA hosts. The Zod
// `domain` enum in server.ts is built FROM this array (single source of truth),
// and getSocrataResource re-checks membership (belt-and-suspenders). Each entry
// carries a real sample 4x4 confirmed to return a 200 bare array.
export const SOCRATA_DOMAINS = [
    "data.ny.gov", // NY — e.g. kwxv-fwze
    "data.colorado.gov", // CO — e.g. 4ykn-tg5h
    "data.ct.gov", // CT — e.g. 28fr-iqnx
    "data.texas.gov", // TX — e.g. 54pj-3dxy
    "data.wa.gov", // WA — e.g. qxh8-f4bd
    "opendata.maryland.gov", // MD — e.g. 2ir4-626w
    "data.vermont.gov", // VT — e.g. jgqy-2smf
    "data.nj.gov", // NJ — e.g. 44xg-bswk
    "data.oregon.gov", // OR — e.g. tckn-sxa6
    "data.pa.gov", // PA — e.g. mcba-yywm
    "data.mo.gov", // MO — e.g. gfq7-aa86
    "data.delaware.gov", // DE — e.g. 5zy2-grhr
    "opendata.usac.org", // USAC E-rate (.org, m6) — e.g. avi8-svp9
];
const SOCRATA_DOMAIN_SET = new Set(SOCRATA_DOMAINS);
const CATALOG_HOST = "api.us.socrata.com";
const CATALOG_URL = `https://${CATALOG_HOST}/api/catalog/v1`;
// A valid Socrata 4x4 is EXACTLY 9 chars: 4 lowercase-alnum, a hyphen, 4 more.
// `.length === 9` (not just the regex) rejects a trailing `\n` (M2) that the
// regex `$` alone would admit ("abcd-1234\n" passes /…$/ in JS).
const DATASET_ID_RE = /^[a-z0-9]{4}-[a-z0-9]{4}$/;
// D2 — an AGGREGATE $select projection. Matches a SoQL aggregate function
// (count/sum/avg/min/max) applied via `fn(` — the `\b…\s*\(` shape avoids false
// hits on column names like `max_temperature` (no paren) or `xmax(` (no word
// boundary) — OR an explicit `group by`/`$group`. Case-insensitive. When the
// caller's own $select is aggregate, the count(*) companion is skipped (its
// raw-row total would be false for aggregate result rows). See `query`.
const AGGREGATE_SELECT_RE = /\b(?:count|sum|avg|min|max)\s*\(|\bgroup\s+by\b|\$group\b/i;
// ─── HONESTY-CRITICAL coercions (null, never 0, for absent) ───────
// `num`/`str` are the shared, audited null-never-0 coercions in ./coerce.js
// (imported above, `num` re-exported): null/undefined, the literal "null",
// ""/whitespace (Number("") is 0!), and "(-)"/"-" all become null (never 0).
/**
 * The optional app-token header (keyless-first). Present ONLY when
 * SOCRATA_APP_TOKEN is set; the value is never logged / never in `_meta`.
 */
function appTokenHeader() {
    const t = process.env.SOCRATA_APP_TOKEN;
    return t ? { "X-App-Token": t } : {};
}
/** true iff an app token is configured (for the `_meta` note — never the value). */
function appTokenPresent() {
    return !!process.env.SOCRATA_APP_TOKEN;
}
/**
 * GET one SODA resource. SSRF guard (belt-and-suspenders behind the server's
 * Zod enum+regex): domain ∈ allowlist, datasetId is a 9-char 4x4, and the
 * CONSTRUCTED URL's hostname === domain (protocol https). Sets `redirect:"error"`
 * (B1) + the optional app-token header, and reuses errors.ts retry/timeout/
 * taxonomy (429 → rate_limited retryable; 5xx → upstream_unavailable; 404 →
 * not_found; 400 → invalid_input). Returns the parsed JSON (unknown; callers
 * validate the shape).
 */
async function getSocrataResource(domain, datasetId, params) {
    if (!SOCRATA_DOMAIN_SET.has(domain)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Socrata domain ${JSON.stringify(domain)} is not on the curated allowlist. Allowed: ${SOCRATA_DOMAINS.join(", ")}.`,
            retryable: false,
        });
    }
    if (datasetId.length !== 9 || !DATASET_ID_RE.test(datasetId)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid Socrata datasetId ${JSON.stringify(datasetId)} — expected a 4x4 id matching [a-z0-9]{4}-[a-z0-9]{4} (exactly 9 chars).`,
            retryable: false,
        });
    }
    const url = `https://${domain}/resource/${datasetId}.json?${params.toString()}`;
    // Belt-and-suspenders: the FIXED path leaves only domain+datasetId to
    // interpolate; assert the built URL cannot have been steered off-host.
    const built = new URL(url);
    if (built.hostname !== domain || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed Socrata URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the allowlisted domain ${JSON.stringify(domain)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
        });
    }
    // Shared fetch envelope (ADR-0005): init === { headers, redirect, signal } —
    // byte-identical to the prior hand-rolled fetch.
    //   B1 — redirect:"error": a 3xx off an allowlisted host is anomalous for a
    //   direct-JSON SODA endpoint; error out rather than silently follow it
    //   off-allowlist (cf. attachments.ts finalHost precedent).
    //   m7 — the label is host-only; it surfaces verbatim in
    //   ToolError.upstreamEndpoint to the MCP caller and must NEVER include the
    //   app-token value.
    return getJson(url, {
        label: "socrata:" + domain,
        headers: appTokenHeader(),
        redirect: "error",
    });
}
/**
 * GET the discovery catalog (fixed host api.us.socrata.com; `domains` bound to
 * the allowlist enum by the caller). Same redirect/token/timeout policy.
 */
async function getCatalog(params) {
    const url = `${CATALOG_URL}?${params.toString()}`;
    const built = new URL(url);
    if (built.hostname !== CATALOG_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed Socrata catalog URL host ${JSON.stringify(built.hostname)} does not match ${CATALOG_HOST} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
        });
    }
    // Shared fetch envelope (ADR-0005) — same redirect:"error" (B1) + host-only
    // label (m7, never the token) as getSocrataResource.
    return getJson(url, {
        label: "socrata:catalog",
        headers: appTokenHeader(),
        redirect: "error",
    });
}
// ─── map + meta helpers ───────────────────────────────────────────
const STRING_COERCION_NOTE = "Row value fields arrive as strings verbatim from SODA (e.g. \"13650.00\", \"1\") — parse client-side. A missing value is absent, never 0.";
const SOURCE_SUFFIX = "via Socrata SODA (keyless)";
/**
 * The count(*) companion (m4). Reuses the caller's `$where`/`$q`, drops
 * `$select/$order/$limit/$offset`, sets `$select=count(*)`. BEST-EFFORT: ANY
 * failure → total:null with a reason (transient throw vs 200-wrong-shape) — the
 * caller keeps the rows and never fakes a total. A hard schema_drift throw is
 * NEVER raised here (reserved for the PRIMARY row/catalog query).
 */
async function fetchCount(domain, datasetId, where, q) {
    const params = new URLSearchParams();
    if (where)
        params.set("$where", where);
    if (q)
        params.set("$q", q);
    params.set("$select", "count(*)");
    let body;
    try {
        body = await getSocrataResource(domain, datasetId, params);
    }
    catch {
        return { total: null, reason: "transient" };
    }
    // Expected shape: a single-row array [{ count: "<number-as-string>" }].
    if (Array.isArray(body) &&
        body.length === 1 &&
        body[0] != null &&
        typeof body[0] === "object" &&
        "count" in body[0]) {
        const c = num(body[0].count);
        if (c !== null)
            return { total: c, reason: "ok" };
    }
    return { total: null, reason: "drift" };
}
// ─── Tool 1: socrata_query ────────────────────────────────────────
/**
 * Query rows from an allowlisted Socrata SODA dataset. The workhorse: reaches
 * every spend/checkbook/contract/vendor-payment/E-rate dataset on any
 * allowlisted portal. Rows pass through verbatim (value fields are strings).
 *
 * HONESTY: SODA's row response carries NO total, so (default) a count(*)
 * companion supplies `totalAvailable`; if it fails, the rows still return with
 * `totalAvailable:null` + a disclosing note (§m4), and `hasMore` is inferred
 * from the page fill (§B2 — never a false complete). Genuine-empty (`[]` + count
 * 0) → honest complete:true/totalAvailable:0; an outage/5xx/timeout/400/404 on
 * the ROW query THROWS (never a fake empty).
 */
export async function query(args) {
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    const withTotal = args.withTotal ?? true;
    // ── Primary row query (a shape violation here is a hard schema_drift). ──
    const rowParams = new URLSearchParams();
    if (args.select)
        rowParams.set("$select", args.select);
    if (args.where)
        rowParams.set("$where", args.where);
    if (args.order)
        rowParams.set("$order", args.order);
    if (args.q)
        rowParams.set("$q", args.q);
    rowParams.set("$limit", String(limit));
    rowParams.set("$offset", String(offset));
    const body = await getSocrataResource(args.domain, args.datasetId, rowParams);
    if (!Array.isArray(body)) {
        throw driftError("socrata:" + args.domain, `socrata:${args.domain}/${args.datasetId} returned an unexpected shape (SODA /resource/{4x4}.json must be a JSON array of rows).`);
    }
    const rows = body;
    const returned = rows.length;
    // ── count(*) companion (best-effort; §m4). ──
    // D2 — aggregate-projection guard. When the caller's OWN $select is an
    // AGGREGATE projection (count/sum/avg/min/max, or a group-by), the result
    // rows are AGGREGATES, not raw records — so a count(*) companion (which
    // counts the RAW underlying rows) would report a FALSE total. E.g. a 1-row
    // `$select=count(*)` result would get totalAvailable = raw-row-count,
    // hasMore:true, nextOffset:1 → an agent pages forever over a 1-row result
    // (a false-pagination livelock). When detected we SKIP the companion
    // entirely, set totalAvailable:null (an aggregate has no meaningful raw-row
    // total), and let hasMore fall out of PAGE-FULLNESS below (§B2), never a
    // bogus total. A non-aggregate query keeps the exact-count behavior.
    const isAggregateSelect = args.select !== undefined && AGGREGATE_SELECT_RE.test(args.select);
    let totalAvailable = null;
    let countNote;
    if (isAggregateSelect) {
        countNote =
            "The $select is an aggregate/group-by projection (count/sum/avg/min/max or group by), so its result rows are aggregates — an aggregate has no meaningful raw-row total. totalAvailable is null and pagination is page-fullness-based; the count(*) companion was NOT issued (it would count the RAW underlying rows and report a FALSE total).";
    }
    else if (withTotal) {
        const outcome = await fetchCount(args.domain, args.datasetId, args.where, args.q);
        if (outcome.reason === "ok") {
            totalAvailable = outcome.total;
            countNote =
                "totalAvailable was resolved via a count(*) companion query (SODA's row response carries no total).";
        }
        else if (outcome.reason === "transient") {
            countNote =
                "SODA's row response carries no total; the count(*) companion failed (transient); total unknown — results may be truncated at $limit (page via $offset).";
        }
        else {
            countNote =
                "SODA's row response carries no total; the count(*) companion returned an unexpected shape (possible upstream API change); total unknown — results may be truncated at $limit (page via $offset).";
        }
    }
    else {
        countNote =
            "withTotal:false — the count(*) companion was skipped; total unknown — results may be truncated at $limit (page via $offset).";
    }
    // ── B2 — hasMore MUST NOT short-circuit to false on an unknown total. ──
    const hasMore = totalAvailable !== null
        ? offset + returned < totalAvailable
        : returned >= limit;
    const nextOffset = hasMore ? offset + returned : null;
    const filtersApplied = [];
    if (args.select)
        filtersApplied.push("select");
    if (args.where)
        filtersApplied.push("where");
    if (args.order)
        filtersApplied.push("order");
    if (args.q)
        filtersApplied.push("q");
    const notes = [
        countNote,
        `App token: ${appTokenPresent() ? "present (X-App-Token sent; value never logged)" : "absent (keyless; a free SOCRATA_APP_TOKEN lifts shared-IP 429 limits)"}.`,
        STRING_COERCION_NOTE,
    ];
    if (totalAvailable === null && !hasMore) {
        notes.push("totalAvailable is unknown but completeness is INFERRED from a short page (returned < $limit): SODA returns fewer than $limit only when the result set is exhausted.");
    }
    return withMeta({ domain: args.domain, datasetId: args.datasetId, rows }, {
        source: `${args.domain} ${SOURCE_SUFFIX}`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    });
}
/** Map one catalog `results[]` entry → a stable discovery row. */
function mapCatalogRow(row) {
    const r = (row ?? {});
    const res = r.resource ?? {};
    return {
        id: str(res.id),
        name: str(res.name),
        description: str(res.description),
        domain: str(r.metadata?.domain),
        updatedAt: str(res.updatedAt),
        link: str(r.link) ?? str(r.permalink),
    };
}
/**
 * Discover dataset 4x4 ids via the Socrata catalog (memoized ~10 min). Omitting
 * `domain` searches the WHOLE allowlist (repeated `domains=`); passing one scopes
 * to it. Returns `[{ id, name, description, domain, updatedAt, link }]` +
 * `totalAvailable = resultSetSize`. Feeds `datasetId` to socrata_query.
 *
 * m3 — this is the catalog's PRIMARY response: a non-number `resultSetSize` is a
 * hard schema_drift throw (nothing valid to return), never a fabricated total.
 * (Note: the catalog does not index every allowlisted host — e.g. USAC — so a
 * host may return 0 here yet still be queryable via socrata_query with a known
 * 4x4.)
 */
export async function discoverDatasets(args) {
    const limit = args.limit ?? 20;
    const params = new URLSearchParams();
    params.set("q", args.q);
    params.set("only", "datasets");
    params.set("limit", String(limit));
    if (args.domain) {
        params.append("domains", args.domain);
    }
    else {
        for (const d of SOCRATA_DOMAINS)
            params.append("domains", d);
    }
    const key = `socrata:catalog:${args.domain ?? "*"}:${args.q}:${limit}`;
    const { totalAvailable, results } = await memoize(key, async () => {
        const body = await getCatalog(params);
        const b = (body ?? {});
        // m3 — hard drift on the PRIMARY response (contrast the best-effort count).
        // The check stays INSIDE the memoize callback so a bad shape is never
        // cached as a success (ADR-0005 v2 test 2).
        if (typeof b.resultSetSize !== "number") {
            throw driftError("socrata:catalog", "socrata:catalog returned an unexpected shape (resultSetSize must be a number).");
        }
        const total = num(b.resultSetSize);
        const rows = Array.isArray(b.results) ? b.results.map(mapCatalogRow) : [];
        return { totalAvailable: total, results: rows };
    }, 10 * 60 * 1000);
    const returned = results.length;
    const scope = args.domain ? `domain ${args.domain}` : `the ${SOCRATA_DOMAINS.length}-host allowlist`;
    const notes = [
        `Catalog search over ${scope} (only=datasets). Feed a result's id to socrata_query as datasetId.`,
        `App token: ${appTokenPresent() ? "present (X-App-Token sent; value never logged)" : "absent (keyless)"}.`,
    ];
    if (totalAvailable !== null && returned < totalAvailable) {
        notes.push(`Showing ${returned} of ${totalAvailable} matches; raise limit (≤100) or narrow q for the rest.`);
    }
    return withMeta({ query: args.q, domain: args.domain ?? null, results }, {
        source: `${CATALOG_HOST} catalog ${SOURCE_SUFFIX}`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied: args.domain ? ["q", "domain"] : ["q"],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
//# sourceMappingURL=socrata.js.map