/**
 * arcgis-hub.ts — ArcGIS Hub dataset DISCOVERY (`hub.arcgis.com/api/v3/datasets`),
 * a NEW keyless-first SLED-discovery platform (loop cycle 9).
 *
 * WHAT IT ADDS: a large fraction of US state/local/regional/tribal (SLED) open
 * data — especially GIS / infrastructure / permits / boundaries / procurement —
 * is published on ArcGIS Hub, NOT on Socrata or CKAN. This tool DISCOVERS those
 * datasets (keyword search over the whole Hub) so a B2G researcher can find what
 * fragmented local data exists. It is the ArcGIS sibling of
 * `socrata_discover_datasets` / `datagov_search_datasets`.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error") / `driftError` / `num`·`str` (coerce.ts, null-never-0 /
 * null-never-empty-string) / `withMeta`·`buildMeta`, mirroring datagov-catalog.ts.
 * KEYLESS: no key seam (no token is ever read/sent).
 *
 * ★ SSRF: the host is a compile-time literal (`ARCGIS_HUB_HOST`). Every input
 *   (`q` / `filter[openData]` / `page[size]` / `page[start]`) rides in a
 *   MODULE-BUILT `URLSearchParams` assembled key-by-key from validated typed args
 *   — NO raw-query / raw-host passthrough (this is a FIXED-host catalog search, so
 *   there is no per-jurisdiction host vector like socrata_query has). A
 *   post-construction hostname/protocol assertion + `redirect:"error"` lock it.
 *
 * ★ PROVENANCE (the crux — different trust posture from our other sources): ArcGIS
 *   Hub is a GLOBAL, OPEN publishing platform. Anyone — a US city, a foreign
 *   government, an NGO, a company — can publish, so results are NOT all US and NOT
 *   all governmental. This tool is therefore explicitly a DISCOVERY aid, NOT a
 *   curated official-source allowlist (unlike `socrata_query`, whose hosts are a
 *   vetted allowlist). Each result surfaces `owner`/`orgName`/`source`/`region`
 *   VERBATIM so the consumer can VET the publisher, and every response carries the
 *   global-platform disclosure. `openDataOnly` (default true) biases toward items
 *   the publisher designated as open data. DISCOVERY ONLY — to read rows, follow
 *   the dataset on its own ArcGIS endpoint (a guarded row-query tool is a planned
 *   addition; ArcGIS feature services live on arbitrary hosts, which needs its own
 *   SSRF design).
 *
 * ★ HONESTY PILLARS (captured live 2026-07-19):
 *   P1 (real total): the v3 response carries `meta.total` (== `meta.stats.totalCount`)
 *     — the EXACT match count across the Hub. `totalAvailable = num(meta.total)`
 *     (NEVER data.length); a page is `truncated` when `offset + returned < total`.
 *     Pagination is a 1-based record offset (`page[start] = offset + 1`).
 *   P2: getJson→fetchWithRetry THROWS on 429 (rate_limited) / 5xx
 *     (upstream_unavailable) / timeout — NEVER a fake empty. A genuine no-match
 *     (`data:[]`, total 0) ⇒ honest empty (datasets:[], returned:0, total:0,
 *     complete:true).
 *   P3: every scalar via `str` (null-never-empty) / booleans preserved / `num`
 *     for counts (null-never-0). A missing owner/source/region is null, never "".
 *   P4: `body.data` absent/non-array ⇒ driftError; a 200 non-JSON body ⇒
 *     schema_drift via the catch-ladder (ToolErrorCarrier rethrow FIRST so a
 *     429/5xx keeps its taxonomy → SyntaxError→driftError → bare rethrow).
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js) so
// the fault suite's num-parity guard resolves `num` from this module too.
export { num };

// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
export const ARCGIS_HUB_HOST = "hub.arcgis.com";
const ARCGIS_HUB_PATH = "/api/v3/datasets";
// HOST+path label — surfaces in ToolError.upstreamEndpoint. Keyless: no token can
// ever appear here (none is read).
const ARCGIS_HUB_LABEL = "arcgis-hub:/api/v3/datasets";
const ARCGIS_HUB_SOURCE =
  "hub.arcgis.com via ArcGIS Hub (keyless; GLOBAL open platform — vet each publisher)";

// The load-bearing provenance caveat carried on EVERY response.
const ARCGIS_HUB_PROVENANCE_NOTE =
  "ArcGIS Hub is a GLOBAL, OPEN publishing platform — results include non-US and non-governmental publishers. This is a DISCOVERY aid, NOT a curated official-source allowlist (unlike socrata_query): VET each result's owner/orgName/source/region before relying on it. DISCOVERY ONLY (metadata + links) — to read rows, follow the dataset on its own ArcGIS endpoint.";

// ─── The curated dataset shape ────────────────────────────────────
export type HubDataset = {
  id: string | null;
  name: string | null;
  description: string | null;
  owner: string | null;
  orgName: string | null;
  source: string | null;
  region: string | null;
  type: string | null;
  sector: string | null;
  keywords: string[];
  downloadable: boolean | null;
  hasApi: boolean | null;
  created: string | null;
  modified: string | null;
  landingPage: string | null;
  itemId: string | null;
};

/** A string[] from a mixed value (drops null/empty via str), else [] when absent/non-array. */
function strArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.map((v) => str(v)).filter((v): v is string => v !== null);
}

/** null-preserving boolean coercion — a real true/false survives; anything else → null (never a fabricated false). */
function boolOrNull(x: unknown): boolean | null {
  return typeof x === "boolean" ? x : null;
}

/**
 * Map ONE `data[]` row → the curated dataset shape. The Hub's JSON:API row is
 * `{ id, type, attributes:{…} }`. Every scalar via `str` (null-never-empty);
 * booleans null-preserving; keywords via strArray. The publisher-identifying
 * fields (owner/orgName/source/region) are surfaced VERBATIM for vetting.
 */
function mapDataset(row: unknown): HubDataset {
  const r = (row ?? {}) as { id?: unknown; attributes?: Record<string, unknown> };
  const a = r.attributes ?? {};
  return {
    id: str(r.id),
    name: str(a.name),
    description: str(a.searchDescription ?? a.description ?? a.snippet),
    owner: str(a.owner),
    orgName: str(a.orgName ?? a.organization),
    source: str(a.source),
    region: str(a.region),
    type: str(a.type),
    sector: str(a.sector),
    keywords: strArray(a.tags),
    downloadable: boolOrNull(a.downloadable),
    hasApi: boolOrNull(a.hasApi),
    created: str(a.created),
    modified: str(a.modified),
    landingPage: str(a.landingPage ?? a.url),
    itemId: str(a.itemId),
  };
}

// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect) ──
/**
 * GET one ArcGIS Hub v3 JSON resource. All caller params ride in `params`
 * (URLSearchParams, encoded). Builds `https://${ARCGIS_HUB_HOST}${ARCGIS_HUB_PATH}?…`
 * on the FIXED host, asserts the CONSTRUCTED URL's hostname === the host over
 * https (belt-and-suspenders), sets `redirect:"error"` (an off-host 3xx must NOT
 * be followed). KEYLESS — no headers/token.
 */
async function getHub(params: URLSearchParams): Promise<unknown> {
  const qs = params.toString();
  const url = `https://${ARCGIS_HUB_HOST}${ARCGIS_HUB_PATH}${qs ? `?${qs}` : ""}`;
  const built = new URL(url);
  if (built.hostname !== ARCGIS_HUB_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed ArcGIS Hub URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(ARCGIS_HUB_HOST)} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: ARCGIS_HUB_LABEL,
    });
  }
  return getJson(url, { label: ARCGIS_HUB_LABEL, redirect: "error" });
}

// ─── Tool: arcgis_hub_discover_datasets ───────────────────────────
export type ArcgisHubDiscoverArgs = {
  query: string;
  openDataOnly?: boolean;
  limit?: number;
  offset?: number;
};

/**
 * Search ArcGIS Hub datasets by keyword. Filters: `query` (→q, REQUIRED, ≥2
 * non-whitespace chars), `openDataOnly` (default true → filter[openData]=true,
 * biases toward publisher-designated open data), `limit` (→page[size]), `offset`
 * (→page[start]=offset+1, 1-based). The query is MODULE-BUILT from validated typed
 * args (NO raw passthrough). Returns curated dataset rows + honest `_meta`:
 * totalAvailable = the EXACT Hub match count (meta.total, P1), the global-platform
 * provenance disclosure, and per-row publisher fields for vetting.
 */
export async function discoverDatasets(
  args: ArcgisHubDiscoverArgs,
): Promise<MetaBundle> {
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;
  const openDataOnly = args.openDataOnly ?? true;

  // Belt-and-suspenders (behind the server's Zod): a <2-char / whitespace-only q
  // would scan the whole global Hub — reject pre-fetch (0 network call).
  const q = args.query ?? "";
  if (q.trim().length < 2) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `ArcGIS Hub 'query' must be at least 2 non-whitespace characters (a broad scan of the entire global Hub is refused).`,
      retryable: false,
      upstreamEndpoint: ARCGIS_HUB_LABEL,
    });
  }

  // Build the query from VALIDATED typed args, key-by-key (SSRF: no raw passthrough).
  const params = new URLSearchParams();
  const filtersApplied: string[] = ["query"];
  params.set("q", q);
  params.set("page[size]", String(limit));
  params.set("page[start]", String(offset + 1)); // Hub page[start] is 1-based.
  if (openDataOnly) {
    params.set("filter[openData]", "true");
    filtersApplied.push("openDataOnly");
  }

  // The typed catch-ladder (datagov-catalog shape, VERBATIM): preserve the
  // 429/404/5xx/400/timeout ToolErrorCarrier taxonomy FIRST; reclassify a 200
  // non-JSON SyntaxError to schema_drift SECOND; bare-rethrow LAST.
  let body: unknown;
  try {
    body = await getHub(params);
  } catch (e) {
    if (e instanceof ToolErrorCarrier) throw e;
    if (e instanceof SyntaxError)
      throw driftError(
        ARCGIS_HUB_LABEL,
        "ArcGIS Hub returned a non-JSON body at HTTP 200 — schema drift.",
      );
    throw e;
  }

  const b = (body ?? {}) as { data?: unknown; meta?: Record<string, unknown> };

  // P4: `data` MUST be an array (a missing/string/null data is drift, never a
  // fabricated empty — a TypeError must never mask drift as upstream_unavailable).
  if (!Array.isArray(b.data)) {
    throw driftError(
      ARCGIS_HUB_LABEL,
      "ArcGIS Hub shape drift — /api/v3/datasets response.data must be an array.",
    );
  }

  const datasets = (b.data as unknown[]).map(mapDataset);
  const returned = datasets.length;

  // P1: totalAvailable = the EXACT Hub match count (meta.total), NEVER data.length.
  // meta.total (== meta.stats.totalCount) is the primary total; if absent → null
  // (best-effort, never a fabricated count). num() is null-never-0.
  const meta = (b.meta ?? {}) as { total?: unknown; stats?: { totalCount?: unknown } };
  const totalAvailable = num(meta.total ?? meta.stats?.totalCount);
  const hasMore =
    totalAvailable !== null ? offset + returned < totalAvailable : returned >= limit;
  const nextOffset = hasMore ? offset + returned : null;

  const notes: string[] = [ARCGIS_HUB_PROVENANCE_NOTE];
  notes.push(
    openDataOnly
      ? "openDataOnly=true: results are filtered to items the publisher designated as open data (filter[openData]=true). Set openDataOnly=false to broaden to all shared items."
      : "openDataOnly=false: ALL shared Hub items are searched (not only designated open data) — vetting the publisher matters even more.",
  );
  if (totalAvailable === null) {
    notes.push(
      "totalAvailable is unknown (the Hub omitted meta.total on this response); completeness is inferred from page fullness (returned < limit ⇒ last page).",
    );
  }

  return withMeta(
    { query: q, openDataOnly, datasets },
    {
      source: ARCGIS_HUB_SOURCE,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
