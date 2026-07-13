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
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
/** Exact-CVE id shape (client-side; a malformed cveId 404s upstream). */
export declare const CVE_ID_RE: RegExp;
/** The ONLY reader of the key value (mirror `resolvedBlsKey`). Trimmed; empty ⇒
 *  keyless. Every other helper exposes only the MODE. */
export declare function resolvedNvdKey(): string;
/** true when no NVD_API_KEY is configured (keyless). Drives mode + interval. */
export declare function usingNvdKey(): boolean;
/**
 * ★ M3 — the load-bearing not-in-KEV ≠ safe caveat (VERBATIM shared constant,
 * mirror `OFAC_NOT_DETERMINATION_NOTE`). Rides on cve_lookup's `kev.listed:false`
 * AND on cisa_kev_lookup's `_meta.notes`. KEV is a CISA-curated subset of
 * CONFIRMED in-the-wild exploitation; absence is NOT a safety clearance.
 */
export declare const KEV_NOT_SAFE_NOTE = "NOT in the CISA KEV catalog does NOT mean not-exploited, not-vulnerable, or safe \u2014 KEV is a CURATED SUBSET of CVEs with CISA-confirmed in-the-wild exploitation. Absence means CISA has not catalogued it, NOT that the component is unexploited or not vulnerable. Assess severity from the CVSS/CVE detail and your own analysis.";
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
/**
 * Extract EVERY `metrics` key matching `^cvssMetric` (V2/V30/V31/V40) into one
 * `cvssMetrics[]` element per entry. `ssvcV203` and any non-cvssMetric key are
 * IGNORED (never a "score"). `baseScore`/`baseSeverity` read from `cvssData`,
 * with the V2 metric-level `baseSeverity` as the load-bearing fallback. Base
 * score is null-never-0 (`num`).
 */
export declare function extractCvssMetrics(metrics: unknown): CvssMetric[];
/**
 * ★ M4 — `primaryCvss` is version-highest but type-PREFERENTIAL not
 * type-EXCLUSIVE: pick the highest CVSS version overall, preferring Primary and
 * FALLING BACK to the highest-version Secondary when no Primary exists. INCLUDES
 * the `type`. Null ONLY when `cvssMetrics[]` is genuinely empty (Rejected/Awaiting).
 */
export declare function pickPrimaryCvss(metrics: CvssMetric[]): PrimaryCvss | null;
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
/**
 * Parse + validate the KEV catalog body → a loaded snapshot. Shape-guard FIRST
 * (a non-object / missing `vulnerabilities` → driftError, never a fake empty),
 * then the plausibility FLOOR + the `count === vulnerabilities.length` DRIFT
 * guard. A truncated/drifted catalog THROWS (never read as "nothing exploited").
 */
export declare function parseKevCatalog(body: unknown, label: string): LoadedKev;
/** TEST-ONLY: drop the KEV cache so a fault case can re-point the fetch mock. */
export declare function _resetNvdCacheForTests(): void;
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
export declare function cveLookup(args: CveLookupArgs): Promise<MetaBundle>;
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
/**
 * Filter the cached CISA KEV catalog standalone (by cveId / vendorProject /
 * product / ransomwareOnly / addedSince / dueBefore, paginated). THROWS on a
 * catalog outage / floor-fail / drift (never a fake-empty catalog).
 *
 * ★ M3 — the not-in-KEV ≠ safe caveat (KEV_NOT_SAFE_NOTE) rides in _meta.notes on
 * EVERY response (especially a `cveId` miss / zero-match): absence is NOT a safety
 * clearance.
 */
export declare function cisaKevLookup(args: CisaKevLookupArgs): Promise<MetaBundle>;
//# sourceMappingURL=nvd.d.ts.map