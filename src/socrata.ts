/**
 * Socrata / SODA — keyless open data for state / local (SLED) + federal + E-rate portals.
 *
 * First SLED source (ADR-0004); 3rd consumer of the fetch/map/meta shape after
 * treasury.ts / edgar.ts. Fully PUBLIC, KEYLESS. ONE connector reaches ~a dozen
 * US state portals + E-rate on the IDENTICAL SODA JSON API — swap hostname + a
 * 4x4 dataset id. Hosts are a CURATED allowlist (see SSRF below); the caller
 * never supplies a free host or a free path.
 *   Row query:  https://{domain}/resource/{4x4}.json?$select=…&$where=…&$limit=…
 *   Catalog (host-scoped): https://{domain}/api/catalog/v1?search_context={domain}&q=…
 *   Catalog (all-host):    https://api.us.socrata.com/api/catalog/v1?domains=…&q=…
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
 * ALLOWLIST — each entry carries a real sample 4x4, live-verified on its tier's
 * date (base state slice 2026-07-10; local + major-city + federal 2026-07-18).
 * All `.gov` except the documented non-.gov exceptions: `opendata.usac.org` and
 * the four major-city portals (.us/.org — see the inline blocks below):
 *   m6 — `opendata.usac.org` is a `.org` (USAC, a Congress-designated non-profit;
 *        E-rate). It is on the periodic re-verification checklist. NOTE: the
 *        FEDERATED discovery catalog (api.us.socrata.com) does NOT index USAC
 *        (resultSetSize 0), so the ALL-HOST `socrata_discover_datasets` (domain
 *        omitted) won't surface it; as of loop cycle 8 a DOMAIN-scoped discover
 *        uses USAC's own catalog (search_context) and DOES surface it (live:
 *        opendata.usac.org/api/catalog/v1?search_context=… → resultSetSize 8).
 *        `socrata_query` works regardless with a known 4x4 (live:
 *        opendata.usac.org/resource/avi8-svp9.json → 200 bare array).
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
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

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
  // ── SLED city/county tier (loop cycle 1, 2026-07-18; host-scoped catalog +
  //    /resource/<4x4>.json 200 bare-array live-verified; all .gov; B2G
  //    procurement/vendor/contract data — the fragmented local layer above the
  //    state portals). ─────────────────────────────────────────────────────
  "data.austintexas.gov", // Austin TX (city) — e.g. 3ebq-e9iz (Purchase Orders)
  "data.kingcounty.gov", // King County WA — e.g. dqit-zt74 (Procurement Contracts)
  "data.montgomerycountymd.gov", // Montgomery County MD — e.g. vmu2-pnrc (Contracts)
  "data.mesaaz.gov", // Mesa AZ (city) — e.g. j7s9-qiuq (Vendor Payments)
  "data.cambridgema.gov", // Cambridge MA (city) — e.g. gp98-ja4f (Contracts bid list)
  // ── Federal open-data portal tier (loop cycle 7, 2026-07-18). The FIRST
  //    federal Socrata hosts (prior tiers were state + local only); all .gov,
  //    host-scoped catalog + /resource/<4x4>.json 200 bare-array + count(*)
  //    companion live-verified. High-value B2G federal datasets (carrier/company
  //    census, transportation infrastructure & stats, public health).
  //    NOTE (m3/under-index): the FEDERATED aggregator (api.us.socrata.com)
  //    under-indexes these hosts (DOT: 3 federated vs 1,873 host-scoped). As of
  //    loop cycle 8, `socrata_discover_datasets` WITH a domain uses each host's
  //    OWN catalog (search_context) → complete per-host discovery; only the
  //    all-host search (domain omitted) still relies on the federated aggregator
  //    (its `_meta` note discloses the gap). ──────────────────────────────────
  "data.transportation.gov", // US DOT — e.g. az4n-8mr2 (Company Census File, ~4.47M carriers)
  "data.cdc.gov", // US CDC — e.g. 9bhg-hcku (Provisional COVID-19 Deaths)
  "data.bts.gov", // US BTS (DOT) — e.g. keg4-3bc2 (Border Crossing Entry Data)
  // ── SLED procurement bid-catalog tier (loop cycle 11, 2026-07-19; from the
  //    exhaustive US state+local bid-site research). All .gov; host-scoped catalog
  //    + /resource/<4x4>.json 200 bare-array live-verified. Distinctive value:
  //    these carry LIVE bid-cycle data (bid tabulations / anticipated
  //    solicitations), not only award/spend. (★4 other candidate hosts —
  //    data.iowa.gov, data.scottsdaleaz.gov, data.gilbertaz.gov, opendata.hawaii.gov
  //    — were REJECTED: their /api/catalog/v1 AND /resource endpoints 404 (Next.js/
  //    Express apps, not Socrata — a research-agent "Socrata" claim that live
  //    verification disproved). Never add a host without a 200 bare-array probe.) ─
  "datacatalog.cookcountyil.gov", // Cook County IL — e.g. 32au-zaqn (Bid Tabulations ~5,607; +awards qh8j-6k63, intent-to-award bgq7-v7ms — 17 procurement datasets)
  "data.illinois.gov", // IL — e.g. 6rb8-ntpm (Future Solicitations = anticipated construction bids); re-included (cycle-1 excluded on federated-discover 0, but host-scoped catalog + /resource verified 2026-07-19)
  "data.cincinnati-oh.gov", // Cincinnati OH (city) — e.g. 2iq3-bugw (Certified Vendors MBE/WBE; +contracts 85xi-xdtw)
  // ── Major-city OFFICIAL portals (loop cycle 5, 2026-07-18). NON-.gov but the
  //    unambiguously-official municipal open-data portals for the largest local
  //    procurement markets (NYC OpenData / Chicago / DataSF / LA Controller) —
  //    host-scoped catalog + /resource 200 bare-array verified. Trust-boundary
  //    (like the USAC .org exception): the SSRF guard is the CURATED, FROZEN
  //    allowlist, not the TLD; these five are the documented non-.gov entries. ──
  "data.cityofnewyork.us", // NYC OpenData (.us, official) — e.g. dg92-zbpx (City Record: procurement notices)
  "data.cityofchicago.org", // Chicago (.org, official) — e.g. rsxa-ify5 (Contracts)
  "data.sfgov.org", // San Francisco / DataSF (.org, official) — e.g. cqi5-hm2d (Supplier Contracts)
  "controllerdata.lacity.org", // LA City Controller (.org, official) — e.g. pggv-e4fn (Checkbook L.A.)
  "opendata.usac.org", // USAC E-rate (.org, m6) — e.g. avi8-svp9
  // ── County/city procurement sweep (loop cycle 17, 2026-07-20). Discovered via
  //    the Socrata federated catalog (api.us.socrata.com) filtered to procurement/
  //    bid/contract datasets, then each host-scoped $select=count(*) + /resource
  //    200 bare-array live-verified. US local govs only (Canada/AU + demo/test +
  //    off-theme aggregate hosts filtered out). Mix of official .gov/.org/.com
  //    municipal portals (same documented non-.gov trust-boundary as above). ──
  "data.kcmo.org", // Kansas City MO (.org, official) — e.g. 4mdg-usvj (Vendor Payments ~144k; 22 procurement datasets)
  "data.brla.gov", // Baton Rouge / East Baton Rouge Parish LA (.gov) — e.g. e5pk-us93 (Upcoming Procurement Opportunities; 19 procurement datasets)
  "www.dallasopendata.com", // Dallas TX (.com, official) — e.g. x5ih-idh7 (Vendor Payments FY2019–present ~166k)
  "data.lacity.org", // Los Angeles CA (.org, official) — e.g. hf3r-utnq (RAMP Open Bid Opportunities — live bids)
  "data.ramseycountymn.gov", // Ramsey County MN (.gov) — e.g. iu7r-dzmj (Solicitations & Addenda, with due_date/download_url ~516)
  "data.richmondgov.com", // Richmond VA (.com, official) — e.g. xqn7-jvv2 (City Contracts: contract_value/supplier/procurement_type ~1,387)
  // ── County/city procurement sweep, wave 2 (loop cycle 19, 2026-07-20). Same
  //    federated-catalog mining + host-scoped count(*) + /resource 200 bare-array
  //    verification. All large real checkbook/PO/vendor-payment datasets. ──
  "opendata.howardcountymd.gov", // Howard County MD (.gov) — e.g. mesh-jggc (Vendors Receiving Payments $30k+ ~35k)
  "data.providenceri.gov", // Providence RI (.gov) — e.g. 425y-pm5m (City & School Dept Purchase Orders ~228k)
  "fiscalfocus.pittsburghpa.gov", // Pittsburgh PA (.gov) — e.g. t8t2-4b5n (Checkbook Data ~1.01M)
  "data.coloradosprings.gov", // Colorado Springs CO (.gov) — e.g. yn6y-xikx (Open Checkbook Vendors ~19k)
  "data.framinghamma.gov", // Framingham MA (.gov) — e.g. cqve-ehkr (Checkbook ~324k)
  "data.fultoncountyga.gov", // Fulton County GA (.gov) — e.g. mxhc-krcg (Vendor Payments/disbursements ~217k)
  "atlanta.data.socrata.com", // City of Atlanta GA (Socrata-hosted official portal) — e.g. jmke-icfi (Open Checkbook Ledger ~1.78M)
  "opendata.cityofmesquite.com", // Mesquite TX (.com, official) — e.g. 6tva-azs5 (Check Register ~144k)
] as const;

export type SocrataDomain = (typeof SOCRATA_DOMAINS)[number];

const SOCRATA_DOMAIN_SET: ReadonlySet<string> = new Set(SOCRATA_DOMAINS);

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
const AGGREGATE_SELECT_RE =
  /\b(?:count|sum|avg|min|max)\s*\(|\bgroup\s+by\b|\$group\b/i;

// ─── HONESTY-CRITICAL coercions (null, never 0, for absent) ───────
// `num`/`str` are the shared, audited null-never-0 coercions in ./coerce.js
// (imported above, `num` re-exported): null/undefined, the literal "null",
// ""/whitespace (Number("") is 0!), and "(-)"/"-" all become null (never 0).

/**
 * The optional app-token header (keyless-first). Present ONLY when
 * SOCRATA_APP_TOKEN is set; the value is never logged / never in `_meta`.
 */
function appTokenHeader(): Record<string, string> {
  const t = process.env.SOCRATA_APP_TOKEN;
  return t ? { "X-App-Token": t } : {};
}

/** true iff an app token is configured (for the `_meta` note — never the value). */
function appTokenPresent(): boolean {
  return !!process.env.SOCRATA_APP_TOKEN;
}

// ─── fetch layer ──────────────────────────────────────────────────
export type SocrataRow = Record<string, unknown>;

/**
 * GET one SODA resource. SSRF guard (belt-and-suspenders behind the server's
 * Zod enum+regex): domain ∈ allowlist, datasetId is a 9-char 4x4, and the
 * CONSTRUCTED URL's hostname === domain (protocol https). Sets `redirect:"error"`
 * (B1) + the optional app-token header, and reuses errors.ts retry/timeout/
 * taxonomy (429 → rate_limited retryable; 5xx → upstream_unavailable; 404 →
 * not_found; 400 → invalid_input). Returns the parsed JSON (unknown; callers
 * validate the shape).
 */
async function getSocrataResource(
  domain: string,
  datasetId: string,
  params: URLSearchParams,
): Promise<unknown> {
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
async function getCatalog(params: URLSearchParams): Promise<unknown> {
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

/**
 * GET a HOST-SCOPED discovery catalog (`https://{domain}/api/catalog/v1?
 * search_context={domain}&…`). Unlike the FEDERATED `getCatalog`
 * (api.us.socrata.com), each portal's OWN catalog COMPLETELY indexes its own
 * datasets — the federated aggregator under-indexes many hosts (loop cycle 8:
 * USAC → 0, DOT → 3 of 1,873). Used whenever a specific `domain` is requested;
 * the all-host search (domain omitted) still needs the federated aggregator.
 * SSRF: identical guard to getSocrataResource — domain ∈ allowlist + the
 * CONSTRUCTED URL's hostname === domain (https); redirect:"error" (B1); the
 * host-only label carries the domain (never the token, m7).
 */
async function getHostCatalog(
  domain: string,
  params: URLSearchParams,
): Promise<unknown> {
  if (!SOCRATA_DOMAIN_SET.has(domain)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Socrata domain ${JSON.stringify(domain)} is not on the curated allowlist. Allowed: ${SOCRATA_DOMAINS.join(", ")}.`,
      retryable: false,
    });
  }
  const url = `https://${domain}/api/catalog/v1?${params.toString()}`;
  const built = new URL(url);
  if (built.hostname !== domain || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed Socrata host-catalog URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the allowlisted domain ${JSON.stringify(domain)} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
    });
  }
  return getJson(url, {
    label: "socrata:catalog:" + domain,
    headers: appTokenHeader(),
    redirect: "error",
  });
}

// ─── map + meta helpers ───────────────────────────────────────────
const STRING_COERCION_NOTE =
  "Row value fields arrive as strings verbatim from SODA (e.g. \"13650.00\", \"1\") — parse client-side. A missing value is absent, never 0.";

const SOURCE_SUFFIX = "via Socrata SODA (keyless)";

/** The count(*) companion outcome (m4): a real total, or a null with a reason. */
type CountOutcome =
  | { total: number; reason: "ok" }
  | { total: null; reason: "transient" } // fetch threw (network/5xx/timeout)
  | { total: null; reason: "drift" }; // HTTP 200 but not `[{count:"<num>"}]`

/**
 * The count(*) companion (m4). Reuses the caller's `$where`/`$q`, drops
 * `$select/$order/$limit/$offset`, sets `$select=count(*)`. BEST-EFFORT: ANY
 * failure → total:null with a reason (transient throw vs 200-wrong-shape) — the
 * caller keeps the rows and never fakes a total. A hard schema_drift throw is
 * NEVER raised here (reserved for the PRIMARY row/catalog query).
 */
async function fetchCount(
  domain: string,
  datasetId: string,
  where?: string,
  q?: string,
): Promise<CountOutcome> {
  const params = new URLSearchParams();
  if (where) params.set("$where", where);
  if (q) params.set("$q", q);
  params.set("$select", "count(*)");
  let body: unknown;
  try {
    body = await getSocrataResource(domain, datasetId, params);
  } catch {
    return { total: null, reason: "transient" };
  }
  // Expected shape: a single-row array [{ count: "<number-as-string>" }].
  if (
    Array.isArray(body) &&
    body.length === 1 &&
    body[0] != null &&
    typeof body[0] === "object" &&
    "count" in (body[0] as Record<string, unknown>)
  ) {
    const c = num((body[0] as Record<string, unknown>).count);
    if (c !== null) return { total: c, reason: "ok" };
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
export async function query(args: {
  domain: SocrataDomain;
  datasetId: string;
  select?: string;
  where?: string;
  order?: string;
  q?: string;
  limit?: number;
  offset?: number;
  withTotal?: boolean;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  const withTotal = args.withTotal ?? true;

  // ── Primary row query (a shape violation here is a hard schema_drift). ──
  const rowParams = new URLSearchParams();
  if (args.select) rowParams.set("$select", args.select);
  if (args.where) rowParams.set("$where", args.where);
  if (args.order) rowParams.set("$order", args.order);
  if (args.q) rowParams.set("$q", args.q);
  rowParams.set("$limit", String(limit));
  rowParams.set("$offset", String(offset));
  const body = await getSocrataResource(args.domain, args.datasetId, rowParams);
  if (!Array.isArray(body)) {
    throw driftError(
      "socrata:" + args.domain,
      `socrata:${args.domain}/${args.datasetId} returned an unexpected shape (SODA /resource/{4x4}.json must be a JSON array of rows).`,
    );
  }
  const rows = body as SocrataRow[];
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
  const isAggregateSelect =
    args.select !== undefined && AGGREGATE_SELECT_RE.test(args.select);

  let totalAvailable: number | null = null;
  let countNote: string;
  if (isAggregateSelect) {
    countNote =
      "The $select is an aggregate/group-by projection (count/sum/avg/min/max or group by), so its result rows are aggregates — an aggregate has no meaningful raw-row total. totalAvailable is null and pagination is page-fullness-based; the count(*) companion was NOT issued (it would count the RAW underlying rows and report a FALSE total).";
  } else if (withTotal) {
    const outcome = await fetchCount(args.domain, args.datasetId, args.where, args.q);
    if (outcome.reason === "ok") {
      totalAvailable = outcome.total;
      countNote =
        "totalAvailable was resolved via a count(*) companion query (SODA's row response carries no total).";
    } else if (outcome.reason === "transient") {
      countNote =
        "SODA's row response carries no total; the count(*) companion failed (transient); total unknown — results may be truncated at $limit (page via $offset).";
    } else {
      countNote =
        "SODA's row response carries no total; the count(*) companion returned an unexpected shape (possible upstream API change); total unknown — results may be truncated at $limit (page via $offset).";
    }
  } else {
    countNote =
      "withTotal:false — the count(*) companion was skipped; total unknown — results may be truncated at $limit (page via $offset).";
  }

  // ── B2 — hasMore MUST NOT short-circuit to false on an unknown total. ──
  const hasMore =
    totalAvailable !== null
      ? offset + returned < totalAvailable
      : returned >= limit;
  const nextOffset = hasMore ? offset + returned : null;

  const filtersApplied: string[] = [];
  if (args.select) filtersApplied.push("select");
  if (args.where) filtersApplied.push("where");
  if (args.order) filtersApplied.push("order");
  if (args.q) filtersApplied.push("q");

  const notes: string[] = [
    countNote,
    `App token: ${appTokenPresent() ? "present (X-App-Token sent; value never logged)" : "absent (keyless; a free SOCRATA_APP_TOKEN lifts shared-IP 429 limits)"}.`,
    STRING_COERCION_NOTE,
  ];
  if (totalAvailable === null && !hasMore) {
    notes.push(
      "totalAvailable is unknown but completeness is INFERRED from a short page (returned < $limit): SODA returns fewer than $limit only when the result set is exhausted.",
    );
  }

  return withMeta(
    { domain: args.domain, datasetId: args.datasetId, rows },
    {
      source: `${args.domain} ${SOURCE_SUFFIX}`,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    },
  );
}

// ─── Tool 2: socrata_discover_datasets ────────────────────────────
export type CatalogDataset = {
  id: string | null;
  name: string | null;
  description: string | null;
  domain: string | null;
  updatedAt: string | null;
  link: string | null;
};

/** Map one catalog `results[]` entry → a stable discovery row. */
function mapCatalogRow(row: unknown): CatalogDataset {
  const r = (row ?? {}) as {
    resource?: Record<string, unknown>;
    metadata?: { domain?: unknown };
    permalink?: unknown;
    link?: unknown;
  };
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
 * Discover dataset 4x4 ids via the Socrata catalog (memoized ~10 min). Passing a
 * `domain` queries that portal's OWN catalog (search_context) — a COMPLETE
 * per-host index; omitting it searches the WHOLE allowlist via the federated
 * api.us.socrata.com aggregator (repeated `domains=`). Returns `[{ id, name,
 * description, domain, updatedAt, link }]` + `totalAvailable = resultSetSize`.
 * Feeds `datasetId` to socrata_query.
 *
 * m3 — this is the catalog's PRIMARY response: a non-number `resultSetSize` is a
 * hard schema_drift throw (nothing valid to return), never a fabricated total.
 *
 * UNDER-INDEX (loop cycle 8 fix): the FEDERATED aggregator under-indexes many
 * hosts (USAC → 0; DOT → 3 of 1,873), so the all-host search (domain omitted) can
 * miss datasets — its `_meta` note discloses this. A DOMAIN-scoped search now
 * uses that host's OWN catalog, which indexes it completely (USAC/DOT/etc. fully
 * discoverable). socrata_query works regardless with a known 4x4.
 */
export async function discoverDatasets(args: {
  q: string;
  domain?: SocrataDomain;
  limit?: number;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 20;
  const params = new URLSearchParams();
  params.set("q", args.q);
  params.set("only", "datasets");
  params.set("limit", String(limit));
  // A specific domain → that portal's OWN catalog (search_context), a COMPLETE
  // per-host index. Omitting domain → the federated aggregator (repeated
  // domains=), the only way to search across all hosts (loop cycle 8).
  if (args.domain) {
    params.set("search_context", args.domain);
  } else {
    for (const d of SOCRATA_DOMAINS) params.append("domains", d);
  }

  const key = `socrata:catalog:${args.domain ?? "*"}:${args.q}:${limit}`;
  const { totalAvailable, results } = await memoize(
    key,
    async () => {
      const body = args.domain
        ? await getHostCatalog(args.domain, params)
        : await getCatalog(params);
      const b = (body ?? {}) as { results?: unknown; resultSetSize?: unknown };
      // m3 — hard drift on the PRIMARY response (contrast the best-effort count).
      // The check stays INSIDE the memoize callback so a bad shape is never
      // cached as a success (ADR-0005 v2 test 2).
      if (typeof b.resultSetSize !== "number") {
        throw driftError(
          "socrata:catalog",
          "socrata:catalog returned an unexpected shape (resultSetSize must be a number).",
        );
      }
      const total = num(b.resultSetSize);
      const rows = Array.isArray(b.results) ? b.results.map(mapCatalogRow) : [];
      return { totalAvailable: total, results: rows };
    },
    10 * 60 * 1000,
  );

  const returned = results.length;
  const scope = args.domain ? `domain ${args.domain}` : `the ${SOCRATA_DOMAINS.length}-host allowlist`;
  const notes: string[] = [
    `Catalog search over ${scope} (only=datasets). Feed a result's id to socrata_query as datasetId.`,
    args.domain
      ? `Source: the ${args.domain} portal's OWN catalog (search_context) — a COMPLETE per-host index.`
      : `Source: the federated ${CATALOG_HOST} aggregator, which UNDER-INDEXES some hosts (e.g. USAC, DOT) — pass a specific domain to use that host's own complete catalog.`,
    `App token: ${appTokenPresent() ? "present (X-App-Token sent; value never logged)" : "absent (keyless)"}.`,
  ];
  if (totalAvailable !== null && returned < totalAvailable) {
    notes.push(
      `Showing ${returned} of ${totalAvailable} matches; raise limit (≤100) or narrow q for the rest.`,
    );
  }

  return withMeta(
    { query: args.q, domain: args.domain ?? null, results },
    {
      source: `${args.domain ?? CATALOG_HOST} catalog ${SOURCE_SUFFIX}`,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied: args.domain ? ["q", "domain"] : ["q"],
      filtersDropped: [],
      fieldsUnavailable: [],
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
