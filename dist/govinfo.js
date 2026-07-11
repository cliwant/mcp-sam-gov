/**
 * govinfo.ts — GovInfo (`api.govinfo.gov`) — GPO-authoritative bulk publications
 * (BILLS, PLAW, USCODE, CREC, CFR/FR editions, BUDGET, GAOREPORTS, …) with
 * PDF/XML/MODS downloads + provenance. ADR-0010. This COMPLETES the api.data.gov
 * KEYED trio (ADR-0007 shipped Regulations.gov + Congress.gov; GovInfo was deferred
 * there for its opaque cursor).
 *
 * ★ HIGHEST-REUSE SLICE: the 2nd consumer of the shipped api.data.gov env-key
 * adapter (imported from the shared `./datagovKey.js` seam — §2). It writes ZERO new
 * key/fetch/coercion/error code: it REUSES `getJson`/`driftError`/`num`·`str` and
 * COPIES (does not import) the Socrata/CKAN/datagov SSRF + honesty PATTERN. The one
 * genuinely-novel piece is GovInfo's OPAQUE `offsetMark` cursor (§3 of the ADR).
 *
 * ★ KEY-SECURITY (§2 — inherited verbatim from ADR-0007 via datagovKey.ts):
 *  1. The key rides in `headers:{ "X-Api-Key": <key> }` ONLY — NEVER the URL/query
 *     (GovInfo also accepts `?api_key=`; we DELIBERATELY reject that form — it would
 *     embed the secret in the request URL AND in the echoed `nextPage`).
 *  2. `label` is HOST+PATH only ("govinfo:/collections" / "govinfo:/packages") —
 *     never the full URL, never a token.
 *  3. `_meta.source`/`notes` are host + key-MODE only — never the URL/key/header.
 *  4. The upstream `nextPage`/`previousPage` URLs are NEVER surfaced verbatim (they
 *     embed pageSize + api_key) — the cursor is re-derived by extracting ONLY the
 *     `offsetMark` value via `URL.searchParams`. `get_package` download links that
 *     embed `api_key` are stripped key-free before the payload is surfaced.
 *
 * ★ OPAQUE-CURSOR HONESTY (§3 — the novel pattern, "opaque-cursor pass-back"):
 *   - `totalAvailable = num(count)` — the EXACT real total (no lower-bound/estimate).
 *   - `hasMore` = `nextPage` present (⇔ a next cursor exists).
 *   - `_meta.nextCursor` = the next page's `offsetMark`, extracted from `nextPage`;
 *     `nextOffset:null` + `offset:null` ALWAYS (a numeric offset is meaningless for
 *     an opaque cursor). Continue by passing `nextCursor` back as `pageMark`.
 *   - M3 phantom-empty guard: `packages:[]` WITH `nextPage` present ⇒ `hasMore:false,
 *     nextCursor:null` (never follow into an empty cursor loop).
 *   - M4 complete: passed EXPLICITLY — `false` whenever `pageMark !== "*"` (a
 *     continuation, not the whole set); `true` only when `pageMark === "*" && !hasMore`
 *     (a single first-page call that IS the full result).
 *   - M6 nextPage parse-error: a malformed `nextPage` ⇒ schema_drift WITHOUT the raw
 *     value in the message (it may hold the real key); a valid `nextPage` lacking a
 *     usable `offsetMark` ⇒ graceful no-more.
 *   - NO 10k reachability wall (unlike EDGAR/Regulations): GovInfo's cursor traverses
 *     the ENTIRE result set, so there is no "unreachable remainder" caveat.
 *
 * ★ SSRF (§4 — copy the single-fixed-host shape): one fixed host `api.govinfo.gov`;
 * fixed service-path bases; the interpolated path segments (`collection`/`date`/
 * `packageId`) are grammar-constrained; `pageMark`/`pageSize` ride through
 * URLSearchParams; post-construction `hostname==="api.govinfo.gov" && https`
 * assertion; `redirect:"error"`. ★ ECHO-trap mitigation: `collection` is validated
 * against the memoized `/collections` catalog (a well-formed-but-unknown code could
 * return a silent `count:0`); M5 — if that catalog fetch FAILS, the error is
 * PROPAGATED (never bypass validation into a possibly-silent-empty data query).
 *
 * ★ HONESTY (§5): genuine-empty (`count:0`, valid inputs) ⇒ complete:true/total:0;
 * outage/5xx/timeout/401/403/404/429 ⇒ getJson THROWS (never `[]`); a 200 with a
 * missing/non-number `count`, or `packages`/`collections` NOT an array ⇒ driftError
 * (container-guarded — a TypeError must never mask drift as upstream_unavailable).
 * `num`/`str` are null-never-0.
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
// ADR-0010 §2 — the SHARED api.data.gov key seam (GovInfo is its 2nd consumer).
// govinfo.ts writes ZERO key code; it imports keyHeader/keyModeLabel/pushKeyNote.
import { keyHeader, keyModeLabel, pushKeyNote } from "./datagovKey.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js) so the
// fault suite's num-parity guard resolves the SAME `num` (govinfo.num === coerce.num).
export { num };
// ─── Fixed host + service paths (SSRF core — no free host/path param) ─
export const GOVINFO_HOST = "api.govinfo.gov";
const COLLECTIONS_PATH = "/collections";
// Grammar constraints for the interpolated PATH segments + the cursor query param.
// The SSRF guard is the grammar (no `/`, `?`, `..`, `@`, space can be injected);
// catalog-validation (below) is the SEPARATE silent-empty honesty guard.
export const GOVINFO_COLLECTION_RE = /^[A-Z]{2,10}$/;
export const GOVINFO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}Z)?$/;
export const GOVINFO_PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,}$/;
// m2/m3 — a base64 + URL-safe SUPERSET (the offsetMark alphabet is not fully
// live-verified; URLSearchParams encoding is the real injection guard). Uses the
// new RegExp(string) form (m7 — an inline /…/ literal would need the `/` escaped).
export const GOVINFO_PAGE_MARK_RE = new RegExp("^(\\*|[A-Za-z0-9+/=_~.,:%-]{1,4096})$");
const GOVINFO_SOURCE = (mode) => `${GOVINFO_HOST} via GovInfo API (${mode})`;
// The CFR/ECFR/FR overlap disclosure (§5) — turns a scope-overlap risk into an
// explicit honest routing signal for the AI consumer.
const OVERLAP_COLLECTIONS = new Set(["CFR", "ECFR", "FR"]);
const OVERLAP_NOTE = "GovInfo is the GPO-authoritative BULK-PUBLICATION view (published packages/granules with PDF/XML/MODS downloads + provenance) — complementary to, not a duplicate of, the ecfr_*/fed_register_* tools. For current-text point lookups/search use those; for authoritative published editions, bulk granules, historical point-in-time editions, and non-CFR/FR collections (BILLS, PLAW, CREC, USCODE, BUDGET, GAOREPORTS, …) use GovInfo.";
// m5/m9 — the /collections/{c} date facet filters by lastModified, NOT dateIssued.
const LAST_MODIFIED_NOTE = "startDate/endDate filter by lastModified (the record's last-update date), NOT dateIssued (original publication date). A package modified in the window but published earlier IS included; one published in the window but not since modified may be missed by a lastModified query.";
const CURSOR_NOTE = "GovInfo uses an opaque cursor: pagination.offset/nextOffset are not meaningful (null). Continue by passing _meta.nextCursor back as the `pageMark` argument; hasMore:false / nextCursor:null means this is the last page.";
// ─── SSRF-guarded fetch (§4 — fixed host + hostname assertion + redirect) ──
/**
 * GET one GovInfo JSON resource. `path` is a FIXED base (or a grammar-constrained
 * interpolation — the caller validates the segments BEFORE calling); all query
 * params go through `params` (URLSearchParams, encoded). Asserts the CONSTRUCTED
 * URL's hostname === GOVINFO_HOST over https (belt-and-suspenders, copied from
 * Socrata/CKAN/datagov), sets `redirect:"error"` (a 3xx off api.govinfo.gov is
 * anomalous and must NOT carry the X-Api-Key header to a foreign host), and attaches
 * the key ONLY in the X-Api-Key header. `label` is host+path only.
 */
async function getGovinfo(path, label, params) {
    const qs = params.toString();
    const url = `https://${GOVINFO_HOST}${path}${qs ? `?${qs}` : ""}`;
    const built = new URL(url);
    if (built.hostname !== GOVINFO_HOST || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed GovInfo URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(GOVINFO_HOST)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
        });
    }
    // Shared fetch envelope (ADR-0005): the key rides in headers ONLY (§2 rule 1);
    // redirect:"error" (§4); host-only label → ToolError.upstreamEndpoint (§2 rule 2).
    return getJson(url, { label, headers: keyHeader(), redirect: "error" });
}
// ─── Key-leak: strip any `api_key` from surfaced URLs (M1/M2) ──────
/**
 * Remove an `api_key` query param from a URL string. Under header auth the GovInfo
 * download links / package summary MAY still embed `?api_key=` (documented, not
 * fully live-verifiable today), and the secret must NEVER reach the surfaced
 * payload. A no-op when there is no `api_key`. Uses URL parsing when the string
 * parses; a defensive regex strip otherwise (a non-URL string that somehow carries
 * the token still has it removed — never surfaced verbatim).
 */
function scrubApiKey(s) {
    if (!/api_key=/i.test(s))
        return s;
    try {
        const u = new URL(s);
        u.searchParams.delete("api_key");
        return u.toString();
    }
    catch {
        return s
            .replace(/([?&])api_key=[^&#]*/gi, "$1")
            .replace(/([?&])(&|#|$)/g, "$2")
            .replace(/[?&]$/g, "");
    }
}
/** Recursively strip `api_key` from every string in a JSON value (M1/M2). */
function scrubDeep(v) {
    if (typeof v === "string")
        return scrubApiKey(v);
    if (Array.isArray(v))
        return v.map(scrubDeep);
    if (v && typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = scrubDeep(val);
        }
        return out;
    }
    return v;
}
/**
 * Fetch + shape-guard the `/collections` catalog. A missing/non-array
 * `body.collections` is drift (never `[]`). INSIDE the memoize callback so a bad
 * shape is never cached as a success (ADR-0005 v2 test-2 rule).
 */
async function fetchCollections() {
    const body = await getGovinfo(COLLECTIONS_PATH, "govinfo:/collections", new URLSearchParams());
    const b = (body ?? {});
    if (!Array.isArray(b.collections)) {
        throw driftError("govinfo:/collections", "govinfo shape drift — /collections response.collections must be an array.");
    }
    return b.collections.map((c) => {
        const it = (c ?? {});
        return {
            collectionCode: str(it.collectionCode),
            collectionName: str(it.collectionName),
            // m6 — packageCount (whole packages) vs granuleCount (sub-package documents,
            // e.g. individual bills within a CREC issue). num null-never-0.
            packageCount: num(it.packageCount),
            granuleCount: num(it.granuleCount),
        };
    });
}
/** The full collection catalog, memoized ~6h (42 slow-changing rows). */
async function collectionsCatalog() {
    return memoize("govinfo:collections", fetchCollections, 6 * 60 * 60 * 1000);
}
// ═══════════════════ Tool 1: govinfo_list_collections ═════════════
/**
 * The discovery entry-point: the GovInfo collection catalog (a single definitive
 * read — complete:true, totalAvailable = collections.length). Memoized ~6h; the
 * SAME memoized catalog validates `collection` in govinfo_search_packages.
 */
export async function listCollections(_args = {}) {
    const collections = await collectionsCatalog();
    const notes = [
        "packageCount = whole packages in the collection; granuleCount = sub-package granules (e.g. individual documents within an issue). A missing count is null, never 0.",
    ];
    pushKeyNote(notes);
    return withMeta({ collections }, {
        source: GOVINFO_SOURCE(keyModeLabel()),
        keylessMode: false,
        returned: collections.length,
        totalAvailable: collections.length,
        complete: true,
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
/** Map one `packages[]` row into a flat, honesty-coerced shape. */
function mapPackage(item) {
    const it = (item ?? {});
    return {
        packageId: str(it.packageId),
        title: str(it.title),
        dateIssued: str(it.dateIssued),
        lastModified: str(it.lastModified),
        docClass: str(it.docClass),
        congress: str(it.congress),
        // `packageLink` is the API's canonical resource URL; under header auth it is
        // key-FREE (the key is never in any URL). Scrubbed defensively regardless.
        packageLink: str(scrubApiKey(String(it.packageLink ?? "")) || null),
    };
}
/**
 * The workhorse + the sole carrier of the opaque-cursor pattern. Packages in a
 * collection modified since `startDate` (lastModified facet). `collection` is
 * grammar-checked THEN validated against the memoized `/collections` catalog (M5 —
 * a catalog-fetch failure PROPAGATES, never bypasses validation). Continuation is
 * via `_meta.nextCursor` passed back as `pageMark` (default "*" = first page).
 */
export async function searchPackages(args) {
    const label = "govinfo:/collections";
    const collection = args.collection;
    const pageMark = args.pageMark ?? "*";
    const pageSize = args.pageSize ?? 100;
    // ── Runtime grammar rechecks (belt-and-suspenders behind the server's Zod;
    //    load-bearing for a DIRECT call that bypasses Zod). Any failure ⇒ invalid_input
    //    BEFORE any fetch (0 network calls).
    if (!GOVINFO_COLLECTION_RE.test(collection)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid GovInfo collection ${JSON.stringify(collection)} — expected an uppercase alpha code like BILLS/CFR/FR/PLAW ([A-Z]{2,10}).`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    const startDate = normalizeDate(args.startDate, "startDate", label);
    const endDate = args.endDate !== undefined ? normalizeDate(args.endDate, "endDate", label) : undefined;
    if (!GOVINFO_PAGE_MARK_RE.test(pageMark)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid GovInfo pageMark (opaque cursor) — must be "*" or a ≤4096-char base64/URL-safe token. Pass back the _meta.nextCursor from the previous page.`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    // ── ECHO-trap mitigation (§4) — validate `collection` against the memoized
    //    catalog. M5: a catalog-fetch failure PROPAGATES (never skip validation into a
    //    possibly-silent-empty data query). A well-formed-but-UNKNOWN code ⇒ a clean
    //    invalid_input listing the valid codes, with NO data-query fetch.
    const catalog = await collectionsCatalog();
    const known = new Set(catalog.map((c) => c.collectionCode).filter((c) => c !== null));
    if (!known.has(collection)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Unknown GovInfo collection ${JSON.stringify(collection)}. Valid codes (from govinfo_list_collections): ${[...known].sort().join(", ")}.`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    const path = `${COLLECTIONS_PATH}/${collection}/${startDate}` +
        (endDate !== undefined ? `/${endDate}` : "");
    const params = new URLSearchParams();
    params.set("offsetMark", pageMark);
    params.set("pageSize", String(pageSize));
    const body = await getGovinfo(path, label, params);
    const b = (body ?? {});
    // ── Container-guarded drift (M2/M3): packages MUST be an array; count MUST be a
    //    number — never a TypeError (which would mask drift as upstream_unavailable),
    //    never a fake empty.
    if (!Array.isArray(b.packages)) {
        throw driftError(label, "govinfo shape drift — /collections/{c}/{date} response.packages must be an array.");
    }
    if (typeof b.count !== "number") {
        throw driftError(label, "govinfo shape drift — /collections/{c}/{date} count missing/non-number.");
    }
    const packages = b.packages.map(mapPackage);
    const returned = packages.length;
    const totalAvailable = num(b.count); // EXACT (never packages.length)
    // ── Opaque-cursor honesty (§3 + M3/M6). ──
    const nextPagePresent = str(b.nextPage) !== null;
    let hasMore;
    let nextCursor;
    if (returned === 0 && nextPagePresent) {
        // M3 phantom-empty livelock guard: an empty page WITH a nextPage must NOT
        // advertise a continuation — never follow into an empty cursor loop.
        hasMore = false;
        nextCursor = null;
    }
    else if (nextPagePresent) {
        let nextUrl;
        try {
            nextUrl = new URL(String(b.nextPage));
        }
        catch {
            // M6 — a MALFORMED nextPage. NEVER surface the raw value (it may hold the
            // real key); a clean schema_drift instead.
            throw driftError(label, "govinfo shape drift — nextPage is not a parseable URL.");
        }
        // m10 — run the extracted offsetMark through str() so a literal "null"/"" (or a
        // missing param) becomes null (⇒ no-more), never the string "null".
        const mark = str(nextUrl.searchParams.get("offsetMark"));
        if (mark === null) {
            // M6 — a valid nextPage lacking a usable offsetMark ⇒ graceful no-more.
            hasMore = false;
            nextCursor = null;
        }
        else {
            hasMore = true;
            nextCursor = mark;
        }
    }
    else {
        hasMore = false;
        nextCursor = null;
    }
    // M4 — cursor `complete` derives from hasMore + pageMark, NOT `returned<total`.
    // complete:true ONLY when this is a first-page call ("*") that IS the whole set.
    const complete = pageMark === "*" && !hasMore;
    const filtersApplied = ["collection", "startDate"];
    if (endDate !== undefined)
        filtersApplied.push("endDate");
    const notes = [CURSOR_NOTE, LAST_MODIFIED_NOTE];
    if (OVERLAP_COLLECTIONS.has(collection))
        notes.push(OVERLAP_NOTE);
    pushKeyNote(notes);
    return withMeta({ collection, packages }, {
        source: GOVINFO_SOURCE(keyModeLabel()),
        keylessMode: false,
        returned,
        totalAvailable,
        complete,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        // Cursor page: offset/nextOffset null (no numeric offset); continuation is
        // nextCursor (the extracted offsetMark, never the raw nextPage URL).
        pagination: { offset: null, limit: pageSize, hasMore, nextOffset: null },
        nextCursor,
        notes,
    });
}
/** Normalize a date-only value to the full ISO datetime GovInfo requires on this path. */
function normalizeDate(raw, field, label) {
    if (!GOVINFO_DATE_RE.test(raw)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid GovInfo ${field} ${JSON.stringify(raw)} — expected YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ.`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    return /T/.test(raw) ? raw : `${raw}T00:00:00Z`;
}
// ═══════════════════ Tool 3: govinfo_get_package ══════════════════
/**
 * The drill-down: one package's metadata + download links (txt/xml/pdf/mods/premis/
 * zip) + related links. A 404 (nonexistent packageId) ⇒ honest found:false (never a
 * fabricated summary). Any `api_key` embedded in a download/related link is stripped
 * key-free before the payload is surfaced (M1/M2).
 */
export async function getPackage(args) {
    const label = "govinfo:/packages";
    const packageId = args.packageId;
    if (!GOVINFO_PACKAGE_ID_RE.test(packageId)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid GovInfo packageId ${JSON.stringify(packageId)} — expected an id like BILLS-118hr1enr / CFR-2023-title1-vol1 ([A-Za-z0-9][A-Za-z0-9._-]{2,}).`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    const notes = [];
    pushKeyNote(notes);
    let body;
    try {
        body = await getGovinfo(`/packages/${packageId}/summary`, label, new URLSearchParams());
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
            // Honest empty for an unknown package — a definitive answer (complete).
            return withMeta({ found: false, packageId }, {
                source: GOVINFO_SOURCE(keyModeLabel()),
                keylessMode: false,
                returned: 0,
                totalAvailable: 0,
                complete: true,
                filtersApplied: [],
                filtersDropped: [],
                fieldsUnavailable: [],
                notes: [
                    `No GovInfo package found for packageId ${JSON.stringify(packageId)} (HTTP 404) — the id does not exist. Not fabricated.`,
                    ...notes,
                ],
            });
        }
        throw e;
    }
    if (!body || typeof body !== "object") {
        throw driftError(label, "govinfo shape drift — /packages/{id}/summary response is not an object.");
    }
    // M1/M2 — strip any api_key embedded in download/related links before surfacing.
    const pkg = scrubDeep(body);
    return withMeta({ found: true, packageId, package: pkg }, {
        source: GOVINFO_SOURCE(keyModeLabel()),
        keylessMode: false,
        returned: 1,
        totalAvailable: 1,
        complete: true,
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
//# sourceMappingURL=govinfo.js.map