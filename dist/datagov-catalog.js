/**
 * datagov-catalog.ts — data.gov v4 Catalog API (`api.gsa.gov/technology/datagov/v4`)
 * federal DATASET DISCOVERY (ADR-0046, resilience-initiative Phase 3).
 *
 * WHAT IT ADDS: data.gov RETIRED its CKAN `package_search` endpoint in 2025; the
 * v4 Catalog API is its replacement. This restores federal open-dataset DISCOVERY
 * across all publishing agencies (hundreds of thousands of datasets) as a NEW
 * keyless-first source. It is a SEPARATE host from datagov.ts's api.data.gov trio
 * (Regulations.gov / Congress.gov), but it shares the IDENTICAL api.data.gov key
 * (`api.gsa.gov` accepts the same DATA_GOV_API_KEY / DEMO_KEY via `X-Api-Key`), so
 * it REUSES the audited `datagovKey.ts` key seam verbatim (keyHeader / keyModeLabel
 * / pushKeyNote) — keylessMode:false (genuinely keyed, mirroring the regulations trio).
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error", the X-Api-Key header) / `driftError` / `str` (coerce.ts,
 * null-never-empty-string) / `withMeta`·`buildMeta` / `ResponseMeta.nextCursor`,
 * and MIRRORS datagov.ts's `searchDockets` schema_drift catch-ladder verbatim.
 *
 * ★ SSRF: the host is a compile-time literal (`DATAGOV_CATALOG_HOST`); every filter
 *   (`_q`/`organization`/`_size`/`_format`) rides in a MODULE-BUILT `URLSearchParams`
 *   assembled key-by-key from validated typed args — NO raw-query passthrough. The
 *   opaque `cursor` is charclass-validated (`^[A-Za-z0-9+/=_-]{1,4096}$`, rejecting
 *   `../` / spaces / `%`) BEFORE it rides the `after=` query param. A post-construction
 *   hostname/protocol assertion + `redirect:"error"` lock it (fail closed on any
 *   off-host 3xx — a 3xx off api.gsa.gov could carry the X-Api-Key header away).
 *
 * ★ THE HONESTY PILLARS (P1-P4, captured live 2026-07-14 — the v4 facts):
 *   P1 (NO total): the v4 search response is `{ after, results, sort }` — it reports
 *     NO match count. `totalAvailable = null` (NEVER results.length, NEVER a fabricated
 *     total). Pagination is an OPAQUE `after` cursor: `hasMore = after is a non-empty
 *     string`; `nextCursor = hasMore ? after : null` (passed back VERBATIM as the next
 *     `cursor` argument). offset/nextOffset are null (a numeric offset is meaningless).
 *   P2: getJson→fetchWithRetry THROWS on 429 (rate_limited — very likely at DEMO_KEY's
 *     ~10/hr), 5xx (upstream_unavailable), timeout — NEVER a fake empty. A genuine
 *     no-match (results:[], no after) ⇒ honest empty (datasets:[], returned:0,
 *     nextCursor:null, complete:true).
 *   P3: every scalar via `str` (null-never-empty-string — a missing accessLevel /
 *     license / landingPage is null, NEVER "").
 *   P4: `body.results` absent/non-array ⇒ driftError; a 200 non-JSON body ⇒ schema_drift
 *     via the catch-ladder (ToolErrorCarrier rethrow FIRST so a 429/5xx keeps its
 *     taxonomy → SyntaxError→driftError → bare rethrow).
 *   accessLevel is surfaced VERBATIM (public / restricted public / non-public), null
 *     when absent — the consumer judges the dataset's openness (this tool only
 *     DISCOVERS datasets; it does not ingest distributions).
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { str } from "./coerce.js";
import { withMeta } from "./meta.js";
// The SHARED api.data.gov key seam (ADR-0010 §2). api.gsa.gov accepts the SAME
// DATA_GOV_API_KEY / DEMO_KEY via the X-Api-Key header, so this is a THIRD consumer
// of the audited key discipline — a key-leak regression now fails this suite too.
import { keyHeader, keyModeLabel, pushKeyNote } from "./datagovKey.js";
// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
export const DATAGOV_CATALOG_HOST = "api.gsa.gov";
const DATAGOV_CATALOG_BASE = "/technology/datagov/v4";
const DATAGOV_CATALOG_SEARCH_PATH = `${DATAGOV_CATALOG_BASE}/search`;
// HOST+path label — surfaces in ToolError.upstreamEndpoint; the key rides ONLY in
// the X-Api-Key header, so no token can ever appear here.
const DATAGOV_CATALOG_LABEL = "datagov-catalog:/technology/datagov/v4/search";
const DATAGOV_CATALOG_SOURCE = (mode) => `${DATAGOV_CATALOG_HOST} via data.gov v4 Catalog API (${mode})`;
// The opaque `after` cursor grammar (SSRF + injection guard). data.gov's cursor is
// a base64/URL-safe token — `+/=_-`, no `%` (URLSearchParams would double-encode a
// literal `%` ('%2e'→'%252e') and corrupt the cursor; the real tokens carry none).
// Validated BEFORE the value rides `after=` — a `../` / space / `%` ⇒ invalid_input,
// 0 fetch (mirrors clinicaltrials CT_TOKEN_RE).
export const DATAGOV_CURSOR_RE = new RegExp("^[A-Za-z0-9+/=_-]{1,4096}$");
// The P1 no-total disclosure — the load-bearing honesty caveat carried EVERY response.
const DATAGOV_CATALOG_NO_TOTAL_NOTE = "data.gov catalog does not report a total match count — use nextCursor to page; totalAvailable is unknown (null). Pagination is an OPAQUE cursor (offset/nextOffset are meaningless/null); pass _meta.nextCursor back as the `cursor` argument. nextCursor:null / hasMore:false means this is the last page.";
/** A string[] from a mixed value (drops null/empty via str), else [] when absent/non-array. */
function strArray(x) {
    if (!Array.isArray(x))
        return [];
    return x.map((v) => str(v)).filter((v) => v !== null);
}
/**
 * Map ONE `results[]` row → the curated dataset shape. Every scalar via `str`
 * (null-never-empty-string — a missing accessLevel/license/landingPage is null,
 * NEVER ""). description falls back from the row-level to the DCAT-US field.
 * keywords/themes/distributions default to [] (an honest "none listed"); a
 * distribution is kept only when it carries a title OR a format.
 */
function mapDataset(row) {
    const r = (row ?? {});
    const dcat = (r.dcat ?? {});
    const distributions = Array.isArray(dcat.distribution)
        ? dcat.distribution
            .map((d) => {
            const it = (d ?? {});
            return { title: str(it.title), format: str(it.format ?? it.mediaType) };
        })
            .filter((x) => x.title !== null || x.format !== null)
        : [];
    return {
        id: str(r.slug),
        title: str(r.title),
        organization: str(r.organization),
        description: str(r.description ?? dcat.description),
        accessLevel: str(dcat.accessLevel),
        license: str(dcat.license),
        landingPage: str(dcat.landingPage),
        modified: str(dcat.modified),
        lastHarvested: str(r.last_harvested_date),
        keywords: strArray(r.keyword),
        themes: strArray(r.theme),
        distributions,
        identifier: str(dcat.identifier),
    };
}
// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect) ──
/**
 * GET one data.gov v4 Catalog JSON resource. `path` is a fixed base path; all
 * caller params ride in `params` (URLSearchParams, encoded). Builds
 * `https://${DATAGOV_CATALOG_HOST}${path}?${params}` on the FIXED host, asserts the
 * CONSTRUCTED URL's hostname === the host over https (belt-and-suspenders), sets
 * `redirect:"error"` (an off-host 3xx must NOT be followed — it could carry the
 * X-Api-Key header to a foreign host), and attaches the key ONLY in the X-Api-Key
 * header. `label` is host+path only (→ ToolError.upstreamEndpoint).
 */
async function getDatagovCatalog(path, label, params) {
    const qs = params.toString();
    const url = `https://${DATAGOV_CATALOG_HOST}${path}${qs ? `?${qs}` : ""}`;
    const built = new URL(url);
    if (built.hostname !== DATAGOV_CATALOG_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed data.gov catalog URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(DATAGOV_CATALOG_HOST)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    // The key rides in the X-Api-Key header ONLY (never the URL/label/_meta);
    // redirect:"error" (fail closed on any off-host 3xx).
    return getJson(url, { label, headers: keyHeader(), redirect: "error" });
}
/**
 * Search the data.gov v4 dataset catalog (the CKAN-retirement replacement).
 * Filters: `query` (→_q), `organization` (publisher slug), `limit` (→_size),
 * `cursor` (→after, the opaque continuation). The query is MODULE-BUILT from
 * validated typed args through URLSearchParams (NO raw passthrough); `_format=json`
 * is ALWAYS appended. Returns curated dataset rows + honest `_meta`: totalAvailable
 * is NULL (the v4 API reports no count — P1), the opaque-cursor continuation, the
 * accessLevel openness field surfaced verbatim, and the DEMO_KEY rate disclosure.
 */
export async function searchDatasets(args) {
    const label = DATAGOV_CATALOG_LABEL;
    const limit = args.limit ?? 20;
    // ── Belt-and-suspenders cursor grammar (behind the server's Zod). A bad cursor
    //    would ride `after=` and either 400 or silently mis-page; reject it pre-fetch
    //    (0 network call) so a `../` / space / `%` can never reach the query. ──
    if (args.cursor !== undefined && !DATAGOV_CURSOR_RE.test(args.cursor)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid cursor (opaque continuation token) — must be a ≤4096-char base64/URL-safe token (no spaces, '../', or '%'). Pass back the _meta.nextCursor from the previous page.`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    // ── Build the query from VALIDATED typed args, key-by-key (SSRF: no raw
    //    passthrough). _format=json is ALWAYS appended. ──
    const params = new URLSearchParams();
    const filtersApplied = [];
    if (args.query !== undefined) {
        // DRIFT FIX (dogfooding 2026-07-16): the data.gov v4 catalog renamed its
        // free-text param `_q` → `q` (and `_size` → `size`). The old `_q` was SILENTLY
        // IGNORED — every query returned the same default catalog page while
        // filtersApplied still claimed "query", a confidently-wrong result. LIVE-VERIFIED:
        // q=wildfire → wildfire datasets; _q=wildfire → the generic default list.
        params.set("q", args.query);
        filtersApplied.push("query");
    }
    if (args.organization !== undefined) {
        params.set("organization", args.organization);
        filtersApplied.push("organization");
    }
    params.set("size", String(limit));
    if (args.cursor !== undefined) {
        params.set("after", args.cursor);
        filtersApplied.push("cursor");
    }
    params.set("_format", "json");
    // ── The typed catch-ladder (datagov.ts searchDockets shape, VERBATIM). Preserve
    //    the 429/404/5xx/400/timeout ToolErrorCarrier taxonomy FIRST (LOAD-BEARING:
    //    the DEMO_KEY-~10/hr 429→rate_limited frontier would regress to schema_drift
    //    under a broader catch); reclassify a 200 non-JSON `.json()` SyntaxError to
    //    schema_drift SECOND; bare-rethrow LAST. The host-assert ToolErrorCarrier is
    //    also rethrown first. ──
    let body;
    try {
        body = await getDatagovCatalog(DATAGOV_CATALOG_SEARCH_PATH, label, params);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(label, "data.gov catalog returned a non-JSON body at HTTP 200 — schema drift.");
        throw e;
    }
    const b = (body ?? {});
    // ── P4: `results` MUST be an array (a missing/string/null results is drift,
    //    never a fabricated empty — a TypeError must never mask drift as
    //    upstream_unavailable). ──
    if (!Array.isArray(b.results)) {
        throw driftError(label, "data.gov catalog shape drift — /search response.results must be an array.");
    }
    const datasets = b.results.map(mapDataset);
    const returned = datasets.length;
    // ── P1: NO total is reported ⇒ totalAvailable = null (NEVER results.length,
    //    NEVER a fabricated total). Pagination is the opaque `after` cursor: hasMore
    //    from cursor-presence; nextCursor passed back VERBATIM (never derived). ──
    const rawAfter = b.after;
    const hasMore = typeof rawAfter === "string" && rawAfter.length > 0;
    const nextCursor = hasMore ? rawAfter : null;
    const notes = [DATAGOV_CATALOG_NO_TOTAL_NOTE];
    pushKeyNote(notes);
    if (filtersApplied.length === 0) {
        notes.push("No filters were applied — this is an unscoped scan of the WHOLE data.gov catalog. Add `query` and/or `organization` for a meaningful scoped result set.");
    }
    // Behavior-driven limit-honesty (dogfooding 2026-07-16): the v4 catalog currently
    // returns an upstream-FIXED page (~20) and ignores the `size` argument. Fire ONLY
    // when the API returned MORE than requested (returned > limit) — a DEFINITIVE
    // "limit ignored" signal that can't be confused with a genuine small result set
    // (returned < limit could just be few matches). Behavior-driven, so if the API
    // begins honoring `size` again (returned ≤ limit) the note self-suppresses.
    if (returned > limit) {
        notes.push(`The requested limit (${limit}) was NOT honored — the data.gov v4 catalog returned MORE (${returned} rows): it currently serves an upstream-fixed page and ignores the size argument. Page through the full result set with _meta.nextCursor, not by raising limit.`);
    }
    return withMeta({ datasets }, {
        source: DATAGOV_CATALOG_SOURCE(keyModeLabel()),
        keylessMode: false, // genuinely keyed (api.data.gov X-Api-Key)
        returned,
        // P1 — the v4 API reports NO match count. NULL, never results.length.
        totalAvailable: null,
        // complete is DERIVED by buildMeta: a page with no `after` (hasMore:false) and
        // no dropped filters ⇒ complete:true (an honest exact empty on a no-match); a
        // page WITH an `after` cursor ⇒ hasMore:true ⇒ complete:false.
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        // Cursor page: offset/nextOffset null (no numeric offset); continuation is
        // nextCursor (the opaque `after` token, passed back verbatim as `cursor`).
        pagination: { offset: null, limit, hasMore, nextOffset: null },
        nextCursor,
        notes,
    });
}
//# sourceMappingURL=datagov-catalog.js.map