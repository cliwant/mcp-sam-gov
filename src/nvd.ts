/**
 * @cliwant/mcp-sam-gov/nvd — the IT / CYBER-COMPLIANCE lane (keyless).
 *
 * Why this exists (ADR-0035)
 * --------------------------
 * The server has DEEP regulatory-Comply (FAR/eCFR/SBA) and DEEP entity vetting
 * (EDGAR/FDIC/OFAC) but ZERO IT/cyber compliance — a whole GovCon segment
 * (FedRAMP-authorized cloud, CMMC-obligated defense IT, SBOM/supply-chain) is
 * unserved. This ONE keyless source opens that lane by JOINing two federal
 * upstreams:
 *   - NIST NVD CVE API 2.0 (services.nvd.nist.gov) — the authoritative federal
 *     CVE/CVSS database.
 *   - CISA KEV catalog (www.cisa.gov) — the Known-Exploited-Vulnerabilities list
 *     carrying BINDING remediation due-dates under BOD 22-01 / its 2026 successor
 *     BOD 26-04.
 * The B2G unlock is the JOIN: a GovCon IT vendor checking a product/component
 * gets both "how severe is this CVE (CVSS)" AND "does CISA mandate remediation
 * by a date" in one `cve_lookup` row.
 *
 * TWO tools on THIS one source:
 *   - cve_lookup      — NVD CVE detail/search JOINED with KEV status.
 *   - cisa_kev_lookup — the KEV catalog filtered standalone.
 *
 * ★ NEVER-FAKE honesty (mirrors OFAC's never-fake-CLEAR doctrine):
 *   - P1 pagination derives from `totalResults` (the EXACT count), NEVER page
 *     length.
 *   - P2 a genuine `totalResults:0` / `found:false` is honest; ANY 404 / 5xx /
 *     timeout / network / off-host-redirect / 403 / 429 THROWS (never fake-empty).
 *   - P3 base scores / counts are null-never-0 (`num`); an absent/Rejected score
 *     is null, a real 0.0 CVSS is 0.
 *   - A KEV download failure NEVER fabricates "not on the mandatory-remediation
 *     list": cve_lookup degrades to `kev.listed:null` (never false); cisa_kev_lookup
 *     THROWS; and a `kevOnly:true` filter during a KEV outage THROWS (M1).
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (redirect:"error"), `throughGate`, `driftError`, `num`/`str` (null-never-0),
 * `withMeta`/`buildMeta`, and MIRRORS the OFAC catalog-cache + the BLS
 * optional-key/tier-disclosure seam.
 *
 * ★ SSRF (policy①): both hosts are compile-time CONSTANTS; NO caller value
 *   touches host/path. NVD caller inputs are QUERY params only (validated then
 *   `URLSearchParams`-encoded); KEV takes no params (filters run client-side over
 *   the cached catalog). A post-construction hostname/protocol assert +
 *   `redirect:"error"` lock both (fail closed on any off-host 3xx; its body never
 *   read).
 *
 * ★ OPTIONAL NVD_API_KEY (never leaked): read once via `resolvedNvdKey()` (the
 *   ONLY reader; mirrors `resolvedBlsKey`). When set, injected ONLY into the
 *   documented `apiKey` HTTP header and NOWHERE else (never the URL, label,
 *   `_meta`, or a log), and it shortens the self-throttle interval. Only the MODE
 *   is ever disclosed.
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError, throughGate } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` (nvd.num === coerce.num — a num regression fails together across sources).
export { num };

// ─── NVD endpoint (SSRF core — compile-time CONSTANTS) ────────────
const NVD_HOST = "services.nvd.nist.gov";
const NVD_PATH = "/rest/json/cves/2.0";
const NVD_CVES_URL = `https://${NVD_HOST}${NVD_PATH}`;
// HOST+path-only label (surfaces in ToolError.upstreamEndpoint; the API key rides
// in the apiKey header, never here — leak-safe).
const NVD_LABEL = "nvd:/rest/json/cves/2.0";
// SEC-style UA — NVD serves the keyless API to a normal client.
const NVD_UA =
  "Mozilla/5.0 (compatible; @cliwant/mcp-sam-gov; +https://github.com/cliwant/mcp-sam-gov)";
const NVD_GATE_KEY = "nvd";
// Keyless ~5 req/30s ≈ 1 req/6s; with a free NVD_API_KEY ~50 req/30s ≈ 1 req/0.6s.
const NVD_MIN_INTERVAL_KEYLESS_MS = 6_000;
const NVD_MIN_INTERVAL_KEYED_MS = 700;
const NVD_TIMEOUT_MS = 30_000;

// ─── KEV endpoint (SSRF core — compile-time CONSTANTS) ────────────
const KEV_HOST = "www.cisa.gov";
const KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const KEV_LABEL = "cisa:kev";
const KEV_GATE_KEY = "cisa";
const KEV_GATE_MIN_INTERVAL_MS = 250;
// ★ S1 — the KEV read is DELIBERATELY UNBOUNDED. CISA sends NO Content-Length
// (chunked), so a content-length pre-check is inert; the read is bounded instead
// by the fixed host + `redirect:"error"` (fail-closed on any off-host 3xx) + the
// 30s AbortSignal timeout. `getJson`'s `r.json()` buffers the ~1.5 MB body.
const KEV_TIMEOUT_MS = 30_000;
// Plausibility floor (live 1637) — a truncated/near-empty catalog must NEVER read
// as "nothing is exploited" (the OFAC FLOORS doctrine applied to one catalog).
const KEV_FLOOR = 1_000;
// The lists update ~daily; a 6h TTL serves a warm cache instantly.
const KEV_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// ─── Caller-input limits + validators ─────────────────────────────
const MAX_RESULTS_PER_PAGE = 2_000; // NVD's cap
const DEFAULT_RESULTS_PER_PAGE = 50;
const MAX_DATE_SPAN_DAYS = 120; // NVD 404s a >120-day span (clamp+disclose)
const MAX_KEYWORD_LEN = 512;
const MAX_CPE_LEN = 256;

/** Exact-CVE id shape (client-side; a malformed cveId 404s upstream). */
export const CVE_ID_RE = /^CVE-\d{4}-\d+$/;
/** A CPE 2.3 formatted string: the `cpe:2.3:[aho]:` prefix + printable-ASCII
 *  body (no spaces/control chars). Rejects `http://evil`, `../`, a trailing \n. */
const CPE_RE = /^cpe:2\.3:[aho]:[\x21-\x7e]{1,240}$/;
const CVSS_SEVERITIES = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Optional NVD_API_KEY seam (header-carried, NEVER leaked) ─────
/** The ONLY reader of the key value (mirror `resolvedBlsKey`). Trimmed; empty ⇒
 *  keyless. Every other helper exposes only the MODE. */
export function resolvedNvdKey(): string {
  const raw = process.env.NVD_API_KEY;
  return typeof raw === "string" ? raw.trim() : "";
}
/** true when no NVD_API_KEY is configured (keyless). Drives mode + interval. */
export function usingNvdKey(): boolean {
  return resolvedNvdKey() !== "";
}
function nvdKeyModeLabel(): string {
  return usingNvdKey() ? "NVD_API_KEY" : "keyless";
}
function nvdMinIntervalMs(): number {
  return usingNvdKey() ? NVD_MIN_INTERVAL_KEYED_MS : NVD_MIN_INTERVAL_KEYLESS_MS;
}
function nvdSource(): string {
  return `services.nvd.nist.gov CVE API 2.0 (${nvdKeyModeLabel()})`;
}

// ─── Disclosure constants ─────────────────────────────────────────
/** M2 — the mandatory tier disclosure. Always names NVD_API_KEY; when keyless it
 *  also carries the free-registration escape. Rides on the reclassified rate throw
 *  AND on every response's _meta. */
function tierNote(): string {
  const escape = usingNvdKey()
    ? ""
    : " Set a free NVD_API_KEY (https://nvd.nist.gov/developers/request-an-api-key) to raise the limit to ~50 requests/30s — the key is sent ONLY in the apiKey HTTP header, never in a URL/label/_meta/log.";
  return `NVD active rate tier: ${nvdKeyModeLabel()}. NVD's keyless public rate is ~5 requests/30s; a free NVD_API_KEY raises it to ~50 requests/30s.${escape} NVD returns HTTP 403/429 on a rate breach — retryable; back off ~30s.`;
}

/**
 * ★ M3 — the load-bearing not-in-KEV ≠ safe caveat (VERBATIM shared constant,
 * mirror `OFAC_NOT_DETERMINATION_NOTE`). Rides on cve_lookup's `kev.listed:false`
 * AND on cisa_kev_lookup's `_meta.notes`. KEV is a CISA-curated subset of
 * CONFIRMED in-the-wild exploitation; absence is NOT a safety clearance.
 */
export const KEV_NOT_SAFE_NOTE =
  "NOT in the CISA KEV catalog does NOT mean not-exploited, not-vulnerable, or safe — KEV is a CURATED SUBSET of CVEs with CISA-confirmed in-the-wild exploitation. Absence means CISA has not catalogued it, NOT that the component is unexploited or not vulnerable. Assess severity from the CVSS/CVE detail and your own analysis.";

const REJECTED_NOTE =
  "One or more CVE identifiers are REJECTED/withdrawn by their CNA (vulnStatus 'Rejected') — NOT live vulnerabilities; no CVSS is published (rejected:true, primaryCvss:null). Do not surface a rejected CVE as an active risk.";
const AWAITING_NOTE =
  "One or more CVEs are still being scored by NVD (vulnStatus 'Awaiting Analysis'/'Undergoing Analysis'/'Received') — a null CVSS is an honest UNKNOWN (NVD has not finished analysis), NOT zero risk.";
const SECONDARY_CVSS_NOTE =
  "One or more primaryCvss values are type 'Secondary' — only a CNA/Secondary CVSS exists (no NVD Primary 'nvd@nist.gov' score has been published yet). It is a real score, but not the NVD-authoritative Primary.";

// ─── CVSS extraction (P3 — multi-version, never conflated) ────────
export type CvssMetric = {
  version: string | null;
  source: string | null;
  type: "Primary" | "Secondary" | string | null;
  baseScore: number | null;
  baseSeverity: string | null;
  vectorString: string | null;
  exploitabilityScore: number | null;
  impactScore: number | null;
};

export type PrimaryCvss = {
  version: string | null;
  baseScore: number | null;
  baseSeverity: string | null;
  type: "Primary" | "Secondary" | string | null;
};

/** Resolve the CVSS version from `cvssData.version`, else derive from the metric
 *  KEY (cvssMetricV31→"3.1", V30→"3.0", V2→"2.0", V40→"4.0"). */
function resolveCvssVersion(key: string, rawVersion: unknown): string | null {
  const v = str(rawVersion);
  if (v !== null) return v;
  const m = /^cvssMetricV(\d)(\d)?$/.exec(key);
  if (m) return `${m[1]}.${m[2] ?? "0"}`;
  return null;
}

/** Normalize a metric `type` to Primary/Secondary (else the raw string / null). */
function normCvssType(t: unknown): "Primary" | "Secondary" | string | null {
  const s = str(t);
  if (s === null) return null;
  const u = s.toLowerCase();
  if (u === "primary") return "Primary";
  if (u === "secondary") return "Secondary";
  return s;
}

/** Numeric rank for version comparison (4.0 > 3.1 > 3.0 > 2.0). */
function versionRank(v: string | null): number {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : -1;
}

/**
 * Extract EVERY `metrics` key matching `^cvssMetric` (V2/V30/V31/V40) into one
 * `cvssMetrics[]` element per entry. `ssvcV203` and any non-cvssMetric key are
 * IGNORED (never a "score"). `baseScore`/`baseSeverity` read from `cvssData`,
 * with the V2 metric-level `baseSeverity` as the load-bearing fallback. Base
 * score is null-never-0 (`num`).
 */
export function extractCvssMetrics(metrics: unknown): CvssMetric[] {
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) {
    return [];
  }
  const out: CvssMetric[] = [];
  for (const [key, val] of Object.entries(metrics as Record<string, unknown>)) {
    if (!/^cvssMetric/.test(key)) continue; // excludes ssvcV203 + any non-CVSS key
    if (!Array.isArray(val)) continue;
    for (const entry of val) {
      const e = (entry ?? {}) as Record<string, unknown>;
      const cvssData = (e.cvssData ?? {}) as Record<string, unknown>;
      out.push({
        version: resolveCvssVersion(key, cvssData.version),
        source: str(e.source),
        type: normCvssType(e.type),
        baseScore: num(cvssData.baseScore),
        // V2 puts baseSeverity at the METRIC level (not inside cvssData) — the
        // fallback is load-bearing (else V2 severity is lost).
        baseSeverity: str(cvssData.baseSeverity) ?? str(e.baseSeverity),
        vectorString: str(cvssData.vectorString),
        exploitabilityScore: num(e.exploitabilityScore),
        impactScore: num(e.impactScore),
      });
    }
  }
  return out;
}

/**
 * ★ M4 — `primaryCvss` is version-highest but type-PREFERENTIAL not
 * type-EXCLUSIVE: pick the highest CVSS version overall, preferring Primary and
 * FALLING BACK to the highest-version Secondary when no Primary exists. INCLUDES
 * the `type`. Null ONLY when `cvssMetrics[]` is genuinely empty (Rejected/Awaiting).
 */
export function pickPrimaryCvss(metrics: CvssMetric[]): PrimaryCvss | null {
  if (metrics.length === 0) return null;
  const primaries = metrics.filter((m) => m.type === "Primary");
  const secondaries = metrics.filter((m) => m.type === "Secondary");
  const pool =
    primaries.length > 0
      ? primaries
      : secondaries.length > 0
        ? secondaries
        : metrics;
  let best = pool[0]!;
  for (const m of pool) {
    if (versionRank(m.version) > versionRank(best.version)) best = m;
  }
  return {
    version: best.version,
    baseScore: best.baseScore,
    baseSeverity: best.baseSeverity,
    type: best.type,
  };
}

// ─── CVE row helpers ──────────────────────────────────────────────
function pickDescription(descriptions: unknown): string | null {
  if (!Array.isArray(descriptions)) return null;
  const en = descriptions.find(
    (d) => (d as Record<string, unknown> | null)?.lang === "en",
  );
  const chosen = (en ?? descriptions[0]) as Record<string, unknown> | undefined;
  return str(chosen?.value);
}

function extractCwes(weaknesses: unknown): string[] {
  if (!Array.isArray(weaknesses)) return [];
  const out = new Set<string>();
  for (const w of weaknesses) {
    const descs = (w as Record<string, unknown> | null)?.description;
    if (!Array.isArray(descs)) continue;
    for (const d of descs) {
      const v = str((d as Record<string, unknown> | null)?.value);
      if (v !== null && /^CWE-/i.test(v)) out.add(v);
    }
  }
  return [...out];
}

function extractReferences(
  references: unknown,
): Array<{ url: string; source: string | null }> {
  if (!Array.isArray(references)) return [];
  const out: Array<{ url: string; source: string | null }> = [];
  for (const r of references) {
    const url = str((r as Record<string, unknown> | null)?.url);
    if (url !== null) out.push({ url, source: str((r as Record<string, unknown>).source) });
  }
  return out;
}

const REJECTED_STATUSES = new Set(["rejected"]);
const AWAITING_STATUSES = new Set([
  "awaiting analysis",
  "undergoing analysis",
  "received",
]);

// ─── KEV catalog types + parse ────────────────────────────────────
export type KevEntry = {
  cveID: string | null;
  vendorProject: string | null;
  product: string | null;
  vulnerabilityName: string | null;
  dateAdded: string | null;
  shortDescription: string | null;
  requiredAction: string | null;
  dueDate: string | null;
  /** Surfaced VERBATIM (Known/Unknown) — never defaulted. */
  knownRansomwareCampaignUse: string | null;
  notes: string | null;
  cwes: string[];
};

export type LoadedKev = {
  entries: KevEntry[];
  byCve: Map<string, KevEntry>;
  catalogVersion: string | null;
  dateReleased: string | null;
  count: number;
  fetchedAt: number;
};

function strArrayLocal(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.map((v) => str(v)).filter((v): v is string => v !== null);
}

function mapKevEntry(raw: unknown): KevEntry {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    cveID: str(r.cveID),
    vendorProject: str(r.vendorProject),
    product: str(r.product),
    vulnerabilityName: str(r.vulnerabilityName),
    dateAdded: str(r.dateAdded),
    shortDescription: str(r.shortDescription),
    requiredAction: str(r.requiredAction),
    dueDate: str(r.dueDate),
    knownRansomwareCampaignUse: str(r.knownRansomwareCampaignUse),
    notes: str(r.notes),
    cwes: strArrayLocal(r.cwes),
  };
}

/**
 * Parse + validate the KEV catalog body → a loaded snapshot. Shape-guard FIRST
 * (a non-object / missing `vulnerabilities` → driftError, never a fake empty),
 * then the plausibility FLOOR + the `count === vulnerabilities.length` DRIFT
 * guard. A truncated/drifted catalog THROWS (never read as "nothing exploited").
 */
export function parseKevCatalog(body: unknown, label: string): LoadedKev {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw driftError(
      label,
      "CISA KEV catalog returned a body that is not an object — refusing to report it as an empty catalog.",
    );
  }
  const b = body as {
    vulnerabilities?: unknown;
    count?: unknown;
    catalogVersion?: unknown;
    dateReleased?: unknown;
  };
  if (!Array.isArray(b.vulnerabilities)) {
    throw driftError(
      label,
      "CISA KEV catalog is missing a `vulnerabilities` array (schema drift) — never a fake-empty catalog.",
    );
  }
  const vulns = b.vulnerabilities as unknown[];
  if (vulns.length < KEV_FLOOR) {
    throw driftError(
      label,
      `CISA KEV catalog parsed ${vulns.length} entries, below the plausibility floor of ${KEV_FLOOR} — the download is truncated or drifted. Refusing (a near-empty KEV catalog must never read as "nothing is exploited").`,
    );
  }
  // `count` must be a number AND equal the array length (a drift/truncation anchor).
  if (typeof b.count !== "number") {
    throw driftError(
      label,
      "CISA KEV catalog `count` is absent/non-numeric — nothing trustworthy to anchor the drift guard (schema drift).",
    );
  }
  if (b.count !== vulns.length) {
    throw driftError(
      label,
      `CISA KEV catalog count (${b.count}) !== vulnerabilities.length (${vulns.length}) — a truncated or drifted catalog. Refusing (a partial catalog must never read as complete).`,
    );
  }
  const entries = vulns.map(mapKevEntry);
  const byCve = new Map<string, KevEntry>();
  for (const e of entries) {
    if (e.cveID !== null) byCve.set(e.cveID.toUpperCase(), e);
  }
  return {
    entries,
    byCve,
    catalogVersion: str(b.catalogVersion),
    dateReleased: str(b.dateReleased),
    count: b.count,
    fetchedAt: Date.now(),
  };
}

// ─── KEV module cache (fetch once + freshness; single in-flight promise) ──
let kevCache: LoadedKev | null = null;
let kevInFlight: Promise<LoadedKev> | null = null;

/** TEST-ONLY: drop the KEV cache so a fault case can re-point the fetch mock. */
export function _resetNvdCacheForTests(): void {
  kevCache = null;
  kevInFlight = null;
}

/** Fetch + parse the KEV catalog (SSRF-locked, redirect-fail-closed). Every
 *  failure THROWS a classified error (never a fake-empty catalog). */
async function fetchKevCatalog(): Promise<LoadedKev> {
  // SSRF belt: the URL is a compile-time constant; assert it cannot have drifted.
  const built = new URL(KEV_URL);
  if (built.hostname !== KEV_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed KEV URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${KEV_HOST} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: KEV_LABEL,
    });
  }
  let body: unknown;
  try {
    body = await throughGate(KEV_GATE_KEY, KEV_GATE_MIN_INTERVAL_MS, () =>
      getJson<unknown>(KEV_URL, {
        label: KEV_LABEL,
        redirect: "error",
        timeoutMs: KEV_TIMEOUT_MS,
      }),
    );
  } catch (e) {
    if (e instanceof ToolErrorCarrier) throw e;
    if (e instanceof SyntaxError) {
      throw driftError(
        KEV_LABEL,
        "CISA KEV returned a non-JSON body at HTTP 200 (an HTML error page) — treating as schema drift (never read as an empty catalog).",
      );
    }
    throw new ToolErrorCarrier({
      kind: "upstream_unavailable",
      message: `Network error fetching the CISA KEV catalog: ${(e as Error).message}. The service is unavailable, NOT an empty catalog — retry (never read a fetch failure as "not exploited").`,
      retryable: true,
      retryAfterSeconds: 30,
      upstreamEndpoint: KEV_LABEL,
    });
  }
  return parseKevCatalog(body, KEV_LABEL);
}

/**
 * Ensure the KEV catalog is loaded + fresh. A warm cache within TTL is served
 * instantly; a past-TTL refresh that FAILS while a prior copy exists keeps the
 * stale copy (real data, disclosed by age). A COLD miss whose fetch fails THROWS
 * (never a fabricated catalog). Single in-flight promise (no thundering herd).
 */
async function ensureKev(): Promise<LoadedKev> {
  if (kevCache && Date.now() - kevCache.fetchedAt <= KEV_CACHE_TTL_MS) {
    return kevCache;
  }
  if (kevInFlight) return kevInFlight;
  const prior = kevCache;
  const load = (async () => {
    try {
      return await fetchKevCatalog();
    } catch (e) {
      if (prior) return prior; // stale copy served (honest, disclosed by age)
      throw e;
    }
  })();
  kevInFlight = load;
  try {
    const loaded = await load;
    kevCache = loaded;
    return loaded;
  } finally {
    kevInFlight = null;
  }
}

// ─── NVD transport (SSRF assert + M2 rate reclassify) ─────────────
/**
 * GET the NVD CVE API with the given query params. Fixed host; the OPTIONAL key
 * rides ONLY in the `apiKey` header. `redirect:"error"` fails closed.
 *
 * ★ M2 — a keyless rate breach is HTTP 403 (live-confirmed), OR 429. The reused
 * `errorFromResponse` classifies a bare 403 as `invalid_input` (permanent, no
 * back-off) — so at THIS call site we reclassify a caught 403/429 to
 * `rate_limited` carrying `tierNote()` (the ~5/30s keyless vs ~50/30s keyed
 * disclosure + the free-registration escape). 404→not_found and other 4xx→
 * invalid_input stay unchanged.
 */
async function nvdGet(params: URLSearchParams): Promise<unknown> {
  const url = `${NVD_CVES_URL}?${params.toString()}`;
  const built = new URL(url);
  if (built.hostname !== NVD_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed NVD URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${NVD_HOST} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: NVD_LABEL,
    });
  }
  const headers: Record<string, string> = { "User-Agent": NVD_UA };
  const key = resolvedNvdKey();
  // The OPTIONAL key — injected ONLY here, in the apiKey header, and NOWHERE else.
  if (key !== "") headers.apiKey = key;

  try {
    return await throughGate(NVD_GATE_KEY, nvdMinIntervalMs(), () =>
      getJson<unknown>(built.toString(), {
        label: NVD_LABEL,
        headers,
        redirect: "error",
        timeoutMs: NVD_TIMEOUT_MS,
      }),
    );
  } catch (e) {
    if (e instanceof ToolErrorCarrier) {
      const status = e.toolError.upstreamStatus;
      if (status === 403 || status === 429) {
        // ★ M2 — a keyless over-rate (403) or 429 → rate_limited + the tier
        // disclosure (never a permanent invalid_input, never a fake-empty).
        throw new ToolErrorCarrier({
          kind: "rate_limited",
          message: tierNote(),
          retryable: true,
          retryAfterSeconds: 30,
          upstreamStatus: status,
          upstreamEndpoint: NVD_LABEL,
        });
      }
      throw e;
    }
    if (e instanceof SyntaxError) {
      throw driftError(
        NVD_LABEL,
        "NVD returned a non-JSON body at HTTP 200 (an HTML error page) — treating as schema drift (never read as an empty result).",
      );
    }
    throw e;
  }
}

// ─── cve_lookup ───────────────────────────────────────────────────
export type CveLookupArgs = {
  cveId?: string;
  keyword?: string;
  cpeName?: string;
  cvssV3Severity?: string;
  pubStartDate?: string;
  pubEndDate?: string;
  lastModStartDate?: string;
  lastModEndDate?: string;
  kevOnly?: boolean;
  resultsPerPage?: number;
  startIndex?: number;
};

function nvdInvalid(message: string): never {
  throw new ToolErrorCarrier({
    kind: "invalid_input",
    message,
    retryable: false,
    upstreamEndpoint: NVD_LABEL,
  });
}

/** Validate an ISO date (YYYY-MM-DD) → a Date at UTC midnight; else invalid_input. */
function parseIsoDate(raw: string, field: string): Date {
  if (!DATE_ONLY_RE.test(raw)) {
    nvdInvalid(
      `Invalid ${field} ${JSON.stringify(raw)} — expected an ISO date YYYY-MM-DD.`,
    );
  }
  const t = Date.parse(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(t)) {
    nvdInvalid(`Invalid ${field} ${JSON.stringify(raw)} — not a real calendar date.`);
  }
  return new Date(t);
}

/**
 * Resolve one date pair (all-or-nothing — NVD 404s a lone bound) → NVD-format
 * bounds, clamping the START forward to a ≤120-day window and returning a
 * disclosure note when clamped.
 */
function resolveDatePair(
  startRaw: string | undefined,
  endRaw: string | undefined,
  startParam: string,
  endParam: string,
  humanLabel: string,
): { start: string; end: string; note: string | null } | null {
  const hasStart = startRaw !== undefined && startRaw !== "";
  const hasEnd = endRaw !== undefined && endRaw !== "";
  if (!hasStart && !hasEnd) return null;
  if (hasStart !== hasEnd) {
    nvdInvalid(
      `${humanLabel} date range must be paired — provide BOTH ${startParam} and ${endParam} (NVD 404s a lone bound).`,
    );
  }
  const startDate = parseIsoDate(startRaw!, startParam);
  const endDate = parseIsoDate(endRaw!, endParam);
  if (startDate.getTime() > endDate.getTime()) {
    nvdInvalid(`${startParam} (${startRaw}) must be ≤ ${endParam} (${endRaw}).`);
  }
  const spanDays =
    (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
  let sentStart = startDate;
  let note: string | null = null;
  if (spanDays > MAX_DATE_SPAN_DAYS) {
    sentStart = new Date(
      endDate.getTime() - MAX_DATE_SPAN_DAYS * 24 * 60 * 60 * 1000,
    );
    const sentStartIso = sentStart.toISOString().slice(0, 10);
    note = `The requested ${humanLabel} span ${startRaw}–${endRaw} (${Math.round(spanDays)} days) exceeds NVD's ${MAX_DATE_SPAN_DAYS}-day/query cap; ${startParam} was clamped forward to ${sentStartIso} BEFORE the request (sent ${sentStartIso}–${endRaw}). Narrow the window to page the earlier range.`;
  }
  // NVD expects an ISO-8601 date-time; use UTC midnight / end-of-day.
  return {
    start: `${sentStart.toISOString().slice(0, 10)}T00:00:00.000`,
    end: `${endDate.toISOString().slice(0, 10)}T23:59:59.999`,
    note,
  };
}

/**
 * NVD CVE exact-lookup (`cveId`) OR search (keyword/cpeName/cvssV3Severity/
 * date-range), each row ANNOTATED with its CISA KEV status. Honest `_meta`:
 * totalAvailable = totalResults (exact), within-window pagination, tierNote, KEV
 * freshness, the not-in-KEV caveat, span-clamp/rejected notes as applicable.
 *
 * ★ M1 — when `kevOnly` is truthy AND the KEV catalog failed to load, THROW the
 * classified KEV error (a KEV-membership filter is unanswerable without a loaded
 * catalog; a silently-empty result would be a fake "none on the mandatory list").
 */
export async function cveLookup(args: CveLookupArgs): Promise<MetaBundle> {
  const params = new URLSearchParams();
  const filtersApplied: string[] = [];
  const clampNotes: string[] = [];

  // ── Validate + build the query params (SSRF: all caller inputs are query
  //    params, validated then URLSearchParams-encoded; host/path unreachable). ──
  const cveId = args.cveId?.trim();
  if (cveId !== undefined && cveId !== "") {
    if (!CVE_ID_RE.test(cveId)) {
      nvdInvalid(
        `Invalid cveId ${JSON.stringify(cveId)} — expected the exact form CVE-YYYY-NNNN (^CVE-\\d{4}-\\d+$). A malformed cveId 404s upstream.`,
      );
    }
    params.set("cveId", cveId);
    filtersApplied.push(`cveId(${cveId})`);
  }

  const keyword = args.keyword?.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (keyword !== undefined && keyword !== "") {
    if (keyword.length > MAX_KEYWORD_LEN) {
      nvdInvalid(
        `keyword too long (${keyword.length} chars, max ${MAX_KEYWORD_LEN}).`,
      );
    }
    params.set("keywordSearch", keyword);
    filtersApplied.push(`keyword(${keyword})`);
  }

  const cpeName = args.cpeName?.trim();
  if (cpeName !== undefined && cpeName !== "") {
    if (cpeName.length > MAX_CPE_LEN || !CPE_RE.test(cpeName)) {
      nvdInvalid(
        `Invalid cpeName ${JSON.stringify(cpeName)} — expected a CPE 2.3 formatted string (cpe:2.3:[aho]:… — e.g. cpe:2.3:a:apache:log4j:2.14.1:*:*:*:*:*:*:*). Rejects non-CPE input (SSRF + verify-the-input honesty).`,
      );
    }
    params.set("cpeName", cpeName);
    filtersApplied.push(`cpeName(${cpeName})`);
  }

  const sev = args.cvssV3Severity?.trim().toUpperCase();
  if (sev !== undefined && sev !== "") {
    if (!CVSS_SEVERITIES.has(sev)) {
      nvdInvalid(
        `Invalid cvssV3Severity ${JSON.stringify(args.cvssV3Severity)} — expected one of: LOW, MEDIUM, HIGH, CRITICAL.`,
      );
    }
    params.set("cvssV3Severity", sev);
    filtersApplied.push(`cvssV3Severity(${sev})`);
  }

  const pubPair = resolveDatePair(
    args.pubStartDate,
    args.pubEndDate,
    "pubStartDate",
    "pubEndDate",
    "publication",
  );
  if (pubPair) {
    params.set("pubStartDate", pubPair.start);
    params.set("pubEndDate", pubPair.end);
    filtersApplied.push(`pubStartDate(${pubPair.start})`, `pubEndDate(${pubPair.end})`);
    if (pubPair.note) clampNotes.push(pubPair.note);
  }

  const modPair = resolveDatePair(
    args.lastModStartDate,
    args.lastModEndDate,
    "lastModStartDate",
    "lastModEndDate",
    "last-modified",
  );
  if (modPair) {
    params.set("lastModStartDate", modPair.start);
    params.set("lastModEndDate", modPair.end);
    filtersApplied.push(
      `lastModStartDate(${modPair.start})`,
      `lastModEndDate(${modPair.end})`,
    );
    if (modPair.note) clampNotes.push(modPair.note);
  }

  // ── At least one selector is required (never a silent full-DB pull). ──
  if (
    !params.has("cveId") &&
    !params.has("keywordSearch") &&
    !params.has("cpeName") &&
    !params.has("cvssV3Severity") &&
    !params.has("pubStartDate") &&
    !params.has("lastModStartDate")
  ) {
    nvdInvalid(
      "At least one of cveId / keyword / cpeName / cvssV3Severity / a date range is required — nothing to look up (never a silent full-database pull).",
    );
  }

  // ── Pagination (resultsPerPage ≤ 2000; startIndex ≥ 0). ──
  const rppRaw = args.resultsPerPage ?? DEFAULT_RESULTS_PER_PAGE;
  if (!Number.isFinite(rppRaw) || rppRaw < 1) {
    nvdInvalid(`resultsPerPage must be a positive integer (got ${rppRaw}).`);
  }
  if (rppRaw > MAX_RESULTS_PER_PAGE) {
    nvdInvalid(
      `resultsPerPage ${rppRaw} exceeds NVD's cap of ${MAX_RESULTS_PER_PAGE} — reduce it (never a silent clamp).`,
    );
  }
  const resultsPerPage = Math.floor(rppRaw);
  const startIndexRaw = args.startIndex ?? 0;
  if (!Number.isFinite(startIndexRaw) || startIndexRaw < 0) {
    nvdInvalid(`startIndex must be ≥ 0 (got ${startIndexRaw}).`);
  }
  const startIndex = Math.floor(startIndexRaw);
  params.set("resultsPerPage", String(resultsPerPage));
  params.set("startIndex", String(startIndex));

  const kevOnly = args.kevOnly === true;

  // ── Load the KEV catalog (capture the error rather than fail the whole call —
  //    a valid CVSS is still useful when KEV is down). ──
  let kevLoaded: LoadedKev | null = null;
  let kevError: unknown = null;
  try {
    kevLoaded = await ensureKev();
  } catch (e) {
    kevError = e;
  }

  // ★ M1 — kevOnly during a KEV outage is UNANSWERABLE → THROW (never an empty
  // filtered set that reads as "none of these CVEs are on the mandatory list").
  if (kevOnly && kevLoaded === null) {
    if (kevError instanceof ToolErrorCarrier) throw kevError;
    throw new ToolErrorCarrier({
      kind: "upstream_unavailable",
      message: `kevOnly filtering requires the CISA KEV catalog, which could not be loaded${kevError instanceof Error ? `: ${kevError.message}` : ""}. A KEV-membership filter is unanswerable without a loaded catalog — refusing to return an empty list (which would falsely read as "none of these CVEs are on CISA's mandatory-remediation list"). Retry, or drop kevOnly to get the CVSS detail with KEV status degraded to unknown.`,
      retryable: true,
      retryAfterSeconds: 30,
      upstreamEndpoint: KEV_LABEL,
    });
  }

  // ── The NVD fetch (P2: 403/429 → rate_limited THROW; 404/5xx/timeout → THROW;
  //    a genuine totalResults:0 is honest). ──
  const body = await nvdGet(params);

  // ── Shape guard FIRST → THROW (never fake-empty). ──
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw driftError(
      NVD_LABEL,
      "NVD returned a 200 body that is not an object — refusing to report it as an empty result.",
    );
  }
  const b = body as { totalResults?: unknown; vulnerabilities?: unknown };
  // ★ P1 — totalResults must be a NUMBER (a non-number → driftError BEFORE num()).
  if (typeof b.totalResults !== "number") {
    throw driftError(
      NVD_LABEL,
      "NVD totalResults is absent/non-numeric — nothing trustworthy to report as a total (schema drift).",
    );
  }
  if (!Array.isArray(b.vulnerabilities)) {
    throw driftError(
      NVD_LABEL,
      "NVD `vulnerabilities` is missing/non-array (schema drift) — never a fake-empty result.",
    );
  }
  const totalResults = num(b.totalResults); // exact count; never vulnerabilities.length

  // ── Map + KEV-annotate each row. ──
  const anyRejected: boolean[] = [];
  const anyAwaiting: boolean[] = [];
  let anyKevListedFalse = false;
  let anyKevUnavailable = false;
  let anySecondaryPrimary = false;

  const rows = (b.vulnerabilities as unknown[]).map((v) => {
    const cve = ((v as Record<string, unknown> | null)?.cve ?? {}) as Record<
      string,
      unknown
    >;
    const cvssMetrics = extractCvssMetrics(cve.metrics);
    const primaryCvss = pickPrimaryCvss(cvssMetrics);
    if (primaryCvss && primaryCvss.type === "Secondary") anySecondaryPrimary = true;

    const vulnStatus = str(cve.vulnStatus);
    const statusLc = (vulnStatus ?? "").toLowerCase();
    const rejected = REJECTED_STATUSES.has(statusLc);
    if (rejected) anyRejected.push(true);
    if (AWAITING_STATUSES.has(statusLc)) anyAwaiting.push(true);

    const id = str(cve.id);
    // ── KEV annotation (listed:null on outage — NEVER false). ──
    let kev:
      | {
          listed: true;
          dateAdded: string | null;
          dueDate: string | null;
          ransomware: string | null;
          requiredAction: string | null;
          catalogVersion: string | null;
        }
      | { listed: false; note: string }
      | { listed: null; status: "unavailable" };
    if (kevLoaded === null) {
      kev = { listed: null, status: "unavailable" };
      anyKevUnavailable = true;
    } else {
      const hit = id !== null ? kevLoaded.byCve.get(id.toUpperCase()) : undefined;
      if (hit) {
        kev = {
          listed: true,
          dateAdded: hit.dateAdded,
          dueDate: hit.dueDate,
          ransomware: hit.knownRansomwareCampaignUse, // verbatim (Known/Unknown)
          requiredAction: hit.requiredAction,
          catalogVersion: kevLoaded.catalogVersion,
        };
      } else {
        kev = { listed: false, note: KEV_NOT_SAFE_NOTE };
        anyKevListedFalse = true;
      }
    }

    return {
      cveId: id,
      vulnStatus,
      rejected,
      published: str(cve.published),
      lastModified: str(cve.lastModified),
      description: pickDescription(cve.descriptions),
      cvssMetrics,
      primaryCvss,
      cwes: extractCwes(cve.weaknesses),
      references: extractReferences(cve.references),
      kev,
    };
  });

  // ★ D1 — apply the kevOnly KEV-listed post-filter ONLY on a LOADED catalog (the
  //   M1 guard above already THREW on the outage case). `kev.listed===true` keeps
  //   only KEV-listed rows; `listed:false`/`null` are dropped.
  const kevListedFilter = kevOnly && kevLoaded !== null;
  const kevFiltered = kevListedFilter
    ? rows.filter((r) => r.kev.listed === true)
    : rows;

  // `nvdPageSize` = the NVD rows CONSUMED on this page (drives pagination);
  // `returned` = the DISPLAYED rows (post-KEV-filter). They differ under kevOnly.
  const nvdPageSize = rows.length;
  const returned = kevFiltered.length;

  // ★ CRITICAL pagination honesty (D1): nextOffset/hasMore MUST derive from the
  //   NVD page size (pre-KEV-filter), NEVER `kevFiltered.length`. kevOnly is a
  //   client-side post-filter over the CURRENT page and KEV-listed CVEs are
  //   scattered across NVD pages — deriving hasMore from the filtered length would
  //   dead-end a page with 0 KEV-listed rows and SILENTLY HIDE KEV-listed rows on
  //   later pages (a false-empty / silent-drop). Keep paging NVD while NVD has more.
  const candidateNext = startIndex + nvdPageSize;
  const nextOffset =
    totalResults !== null && candidateNext >= totalResults ? null : candidateNext;
  const hasMore = nextOffset !== null && nvdPageSize > 0;

  // ── Assemble notes. ──
  const notes: string[] = [tierNote()];
  if (kevLoaded !== null) {
    const ageHours =
      Math.round(((Date.now() - kevLoaded.fetchedAt) / 3_600_000) * 10) / 10;
    notes.push(
      `CISA KEV catalog version ${kevLoaded.catalogVersion ?? "unknown"} (released ${kevLoaded.dateReleased ?? "unknown"}), ${kevLoaded.count} entries, loaded ${ageHours}h ago (TTL 6h). Each CVE is annotated with its KEV status; kev.dueDate is the CISA-mandated remediation deadline and kev.ransomware is surfaced verbatim (Known/Unknown).`,
    );
  }
  if (anyKevUnavailable) {
    notes.push(
      "The CISA KEV catalog could not be loaded, so KEV status is UNKNOWN for each CVE (kev.listed:null, NEVER false) — a KEV outage can NEVER be read as 'this CVE is not on CISA's mandatory-remediation list'. The NVD/CVSS detail below is real; retry for KEV annotation.",
    );
  }
  if (anyKevListedFalse) notes.push(KEV_NOT_SAFE_NOTE);
  if (anySecondaryPrimary) notes.push(SECONDARY_CVSS_NOTE);
  if (anyRejected.length > 0) notes.push(REJECTED_NOTE);
  if (anyAwaiting.length > 0) notes.push(AWAITING_NOTE);
  notes.push(...clampNotes);

  const isExact = params.has("cveId");
  // The genuine-NVD-empty note keys on the NVD page size (nvdPageSize===0), NOT
  // the post-filter `returned` — a kevOnly-filtered-out CVE was PRESENT in NVD.
  if (isExact && nvdPageSize === 0) {
    notes.push(
      `${cveId} was not found in NVD (totalResults:0) — a GENUINE empty (found:false), not an error. Verify the identifier; a very-new CVE may not be published yet.`,
    );
  }
  if (kevListedFilter) {
    notes.push(
      `kevOnly is a CLIENT-SIDE filter applied to THIS NVD page: ${nvdPageSize} NVD row(s) were scanned and ${returned} are KEV-listed (kev.listed:true; the rest were dropped). totalAvailable is the NVD (pre-KEV-filter) total, NOT the count of KEV-listed matches — that count is UNKNOWABLE without paging the whole set. Keep paging while _meta.pagination.hasMore is true (nextOffset is NVD-based) to collect all KEV-listed rows — a page can have hasMore:true with returned:0 (0 KEV-listed on this page but more NVD pages remain).`,
    );
  }

  const data: Record<string, unknown> = { results: kevFiltered };
  if (isExact) data.found = returned > 0; // under kevOnly: found iff in NVD *and* in KEV
  if (kevListedFilter) data.scannedOnPage = nvdPageSize; // NVD rows scanned (pagination math)

  const metaOut: Partial<ResponseMeta> = {
    source: nvdSource(),
    keylessMode: !usingNvdKey(),
    returned,
    totalAvailable: totalResults,
    // "kevOnly" is listed ONLY when the filter actually RAN (loaded catalog) — an
    // outage would have thrown at the M1 guard, so this never claims an unrun filter.
    filtersApplied: kevListedFilter ? [...filtersApplied, "kevOnly"] : filtersApplied,
    filtersDropped: [],
    fieldsUnavailable: anyKevUnavailable ? ["kev"] : [],
    pagination: { offset: startIndex, limit: resultsPerPage, nextOffset, hasMore },
    notes,
  };

  return withMeta(data, metaOut);
}

// ─── cisa_kev_lookup ──────────────────────────────────────────────
export type CisaKevLookupArgs = {
  cveId?: string;
  vendorProject?: string;
  product?: string;
  ransomwareOnly?: boolean;
  addedSince?: string;
  dueBefore?: string;
  limit?: number;
  offset?: number;
};

function kevInvalid(message: string): never {
  throw new ToolErrorCarrier({
    kind: "invalid_input",
    message,
    retryable: false,
    upstreamEndpoint: KEV_LABEL,
  });
}

const KEV_MAX_LIMIT = 1_000;
const KEV_DEFAULT_LIMIT = 100;

function nvdDetailUrl(cveID: string): string {
  return `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(cveID)}`;
}

/**
 * Filter the cached CISA KEV catalog standalone (by cveId / vendorProject /
 * product / ransomwareOnly / addedSince / dueBefore, paginated). THROWS on a
 * catalog outage / floor-fail / drift (never a fake-empty catalog).
 *
 * ★ M3 — the not-in-KEV ≠ safe caveat (KEV_NOT_SAFE_NOTE) rides in _meta.notes on
 * EVERY response (especially a `cveId` miss / zero-match): absence is NOT a safety
 * clearance.
 */
export async function cisaKevLookup(
  args: CisaKevLookupArgs,
): Promise<MetaBundle> {
  // Validate inputs BEFORE the catalog load (a bad cveId is a caller error).
  const cveId = args.cveId?.trim();
  if (cveId !== undefined && cveId !== "" && !CVE_ID_RE.test(cveId)) {
    kevInvalid(
      `Invalid cveId ${JSON.stringify(cveId)} — expected the exact form CVE-YYYY-NNNN (^CVE-\\d{4}-\\d+$).`,
    );
  }
  const addedSince = args.addedSince?.trim();
  if (addedSince !== undefined && addedSince !== "" && !DATE_ONLY_RE.test(addedSince)) {
    kevInvalid(`Invalid addedSince ${JSON.stringify(addedSince)} — expected ISO YYYY-MM-DD.`);
  }
  const dueBefore = args.dueBefore?.trim();
  if (dueBefore !== undefined && dueBefore !== "" && !DATE_ONLY_RE.test(dueBefore)) {
    kevInvalid(`Invalid dueBefore ${JSON.stringify(dueBefore)} — expected ISO YYYY-MM-DD.`);
  }

  const limitRaw = args.limit ?? KEV_DEFAULT_LIMIT;
  if (!Number.isFinite(limitRaw) || limitRaw < 1 || limitRaw > KEV_MAX_LIMIT) {
    kevInvalid(`limit must be between 1 and ${KEV_MAX_LIMIT} (got ${limitRaw}).`);
  }
  const limit = Math.floor(limitRaw);
  const offsetRaw = args.offset ?? 0;
  if (!Number.isFinite(offsetRaw) || offsetRaw < 0) {
    kevInvalid(`offset must be ≥ 0 (got ${offsetRaw}).`);
  }
  const offset = Math.floor(offsetRaw);

  // ── Load the catalog — THROWS on outage / floor / drift (never fake-empty). ──
  const kev = await ensureKev();

  // ── Client-side filters over the cached catalog (zero wire surface). ──
  const vendorProject = args.vendorProject?.trim().toLowerCase();
  const product = args.product?.trim().toLowerCase();
  const ransomwareOnly = args.ransomwareOnly === true;
  const filtersApplied: string[] = [];
  if (cveId) filtersApplied.push(`cveId(${cveId})`);
  if (vendorProject) filtersApplied.push(`vendorProject(${args.vendorProject})`);
  if (product) filtersApplied.push(`product(${args.product})`);
  if (ransomwareOnly) filtersApplied.push("ransomwareOnly");
  if (addedSince) filtersApplied.push(`addedSince(${addedSince})`);
  if (dueBefore) filtersApplied.push(`dueBefore(${dueBefore})`);

  const cveUpper = cveId ? cveId.toUpperCase() : null;
  const matchesAll = kev.entries.filter((e) => {
    if (cveUpper && (e.cveID ?? "").toUpperCase() !== cveUpper) return false;
    if (vendorProject && !(e.vendorProject ?? "").toLowerCase().includes(vendorProject)) {
      return false;
    }
    if (product && !(e.product ?? "").toLowerCase().includes(product)) return false;
    if (ransomwareOnly && (e.knownRansomwareCampaignUse ?? "") !== "Known") return false;
    if (addedSince && (e.dateAdded === null || e.dateAdded < addedSince)) return false;
    if (dueBefore && (e.dueDate === null || e.dueDate >= dueBefore)) return false;
    return true;
  });

  const totalMatches = matchesAll.length;
  const page = matchesAll.slice(offset, offset + limit);
  const matches = page.map((e) => ({
    cveID: e.cveID,
    vendorProject: e.vendorProject,
    product: e.product,
    vulnerabilityName: e.vulnerabilityName,
    dateAdded: e.dateAdded,
    dueDate: e.dueDate,
    knownRansomwareCampaignUse: e.knownRansomwareCampaignUse, // verbatim
    shortDescription: e.shortDescription,
    requiredAction: e.requiredAction,
    cwes: e.cwes,
    nvdUrl: e.cveID !== null ? nvdDetailUrl(e.cveID) : null,
  }));

  const candidateNext = offset + matches.length;
  const nextOffset = candidateNext >= totalMatches ? null : candidateNext;
  const hasMore = nextOffset !== null && matches.length > 0;

  const ageHours =
    Math.round(((Date.now() - kev.fetchedAt) / 3_600_000) * 10) / 10;

  const data: Record<string, unknown> = {
    catalogVersion: kev.catalogVersion,
    dateReleased: kev.dateReleased,
    count: kev.count,
    matches,
  };
  // For a cveId query, `found` reflects catalog membership of THAT CVE.
  if (cveId) data.found = totalMatches > 0;

  // ★ M3 — the not-in-KEV ≠ safe caveat rides on EVERY response (the load-bearing
  // hazard is a `found:false`/zero-match reading as "safe/not-exploited").
  const notes: string[] = [
    KEV_NOT_SAFE_NOTE,
    `CISA KEV catalog version ${kev.catalogVersion ?? "unknown"} (released ${kev.dateReleased ?? "unknown"}), ${kev.count} entries, loaded ${ageHours}h ago (TTL 6h). dueDate is the CISA-mandated remediation deadline (BOD 22-01 / its successor BOD 26-04 — see requiredAction verbatim); knownRansomwareCampaignUse is surfaced verbatim (Known/Unknown).`,
  ];
  if (cveId && totalMatches === 0) {
    notes.push(
      `${cveId} is NOT in the CISA KEV catalog (found:false). Per the caveat above, this is NOT a determination that the CVE is unexploited or safe — KEV is a curated subset of confirmed in-the-wild exploitation.`,
    );
  }

  const metaOut: Partial<ResponseMeta> = {
    source: "www.cisa.gov Known Exploited Vulnerabilities catalog (keyless)",
    keylessMode: true,
    returned: matches.length,
    totalAvailable: totalMatches,
    filtersApplied,
    filtersDropped: [],
    fieldsUnavailable: [],
    pagination: { offset, limit, nextOffset, hasMore },
    notes,
  };

  return withMeta(data, metaOut);
}
