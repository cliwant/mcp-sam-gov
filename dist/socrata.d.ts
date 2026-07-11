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
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const SOCRATA_DOMAINS: readonly ["data.ny.gov", "data.colorado.gov", "data.ct.gov", "data.texas.gov", "data.wa.gov", "opendata.maryland.gov", "data.vermont.gov", "data.nj.gov", "data.oregon.gov", "data.pa.gov", "data.mo.gov", "data.delaware.gov", "opendata.usac.org"];
export type SocrataDomain = (typeof SOCRATA_DOMAINS)[number];
export type SocrataRow = Record<string, unknown>;
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
export declare function query(args: {
    domain: SocrataDomain;
    datasetId: string;
    select?: string;
    where?: string;
    order?: string;
    q?: string;
    limit?: number;
    offset?: number;
    withTotal?: boolean;
}): Promise<MetaBundle>;
export type CatalogDataset = {
    id: string | null;
    name: string | null;
    description: string | null;
    domain: string | null;
    updatedAt: string | null;
    link: string | null;
};
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
export declare function discoverDatasets(args: {
    q: string;
    domain?: SocrataDomain;
    limit?: number;
}): Promise<MetaBundle>;
//# sourceMappingURL=socrata.d.ts.map