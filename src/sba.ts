/**
 * SBA small-business size standards (keyless reference lookup).
 *
 * Why this exists
 * ----------------
 * "Is this firm actually SMALL for this NAICS?" is the gating question for
 * every set-aside eligibility call and for vetting a teaming candidate
 * (`usas_search_teaming_partners` surfaces award-derived candidates — this tool
 * answers whether one of them clears the SBA size standard for the work).
 * The answer is a per-NAICS threshold published by SBA: either an average
 * annual RECEIPTS cap (most services) or an EMPLOYEE-count cap (most
 * manufacturing/mining), with a small set of financial NAICS gated on ASSETS.
 *
 * Source — VERIFIED LIVE 2026-07-03
 * ---------------------------------
 *   GET https://www.sba.gov/sites/default/files/data/naics.json
 *     → HTTP 200, application/json, a keyless ARRAY of ~997 entries, one per
 *       6-digit NAICS (plus a handful of `<code>_a_Except` exception rows).
 *   Each entry:
 *     { id, description, sectorId, sectorDescription, subsectorId,
 *       subsectorDescription, revenueLimit, assetLimit, employeeCountLimit,
 *       parent, footnote }
 *   - revenueLimit  = receipts-based standard in $ MILLIONS  (34 ⇒ $34,000,000)
 *   - assetLimit    = asset-based standard   in $ MILLIONS  (850 ⇒ $850,000,000)
 *   - employeeCountLimit = employee-based standard as a NUMBER OF EMPLOYEES
 *   A NAICS uses exactly ONE of these; the other two are null. (Verified: zero
 *   rows carry revenue+assets or revenue+employees together.)
 *
 * IMPORTANT — not a permanent constant (doc-07 caveat)
 * ----------------------------------------------------
 * SBA adjusts size standards periodically (inflation adjustments to the
 * monetary caps, employee-based reviews). This dataset carries NO explicit
 * effective-date field, so we surface the value AS PUBLISHED in the fetched
 * file at retrieval time — with an `asOf` timestamp and an explicit _meta note
 * that high-stakes eligibility must be re-verified at sba.gov. We never present
 * the number as an immutable truth.
 *
 * Keyless. Fetched once and served from the shared 5-minute reference cache
 * (the file is ~200 KB — we cache the parsed lookup, not one fetch per call).
 */

import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
import {
  throughPathChain,
  CircuitBreaker,
  type ResiliencePath,
  type Provenance,
} from "./datasource.js";
import { snapshotPath, provenanceMeta } from "./snapshot.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";

const SBA_NAICS_URL =
  "https://www.sba.gov/sites/default/files/data/naics.json";

// ─── Resilience wiring (ADR-0045 pilot expansion — INERT by default) ───────
// The whole naics.json file (all ~997 size standards) is a single, queryless,
// slow-changing PUBLIC reference — the cleanest snapshot candidate: one
// pre-fetch serves EVERY per-NAICS lookup. The live host + a per-host circuit
// breaker keyed on the FIXED set {this host} (bounded — m3-regression),
// CONSULTED only by `throughPathChain` for a ≥2-path chain. When
// SAMGOV_SNAPSHOT_BASE_URL is unset the chain is single-path (live only), the
// breaker is a pure no-op, and the tool is BYTE-IDENTICAL to before this ADR.
const SBA_HOST = "www.sba.gov";
let sbaBreaker = new CircuitBreaker([SBA_HOST]);

/** Test-only: reset the resilience breaker between OFFLINE fixtures (mirrors
 *  treasury.ts's `_resetTreasuryBreakerForTests`). */
export function _resetSbaBreakerForTests(): void {
  sbaBreaker = new CircuitBreaker([SBA_HOST]);
}

/** One raw entry in sba.gov/naics.json (only the fields we consume). */
type SbaNaicsEntry = {
  id?: string;
  description?: string;
  sectorId?: string;
  sectorDescription?: string;
  subsectorId?: string;
  subsectorDescription?: string;
  /** Receipts-based standard, in $ MILLIONS (null when not receipts-based). */
  revenueLimit?: number | null;
  /** Asset-based standard, in $ MILLIONS (null unless a financial NAICS). */
  assetLimit?: number | null;
  /** Employee-based standard, a NUMBER OF EMPLOYEES (null when not emp-based). */
  employeeCountLimit?: number | null;
  parent?: number | string | null;
  footnote?: string[] | null;
};

const MILLIONS = 1_000_000;

/**
 * Fetch + parse the SBA naics.json into a Map keyed by 6-digit NAICS id.
 * Cached (5-min TTL) under a single key so the ~200 KB file is pulled at most
 * once per cache window regardless of how many NAICS the agent looks up.
 *
 * On upstream failure this THROWS a ToolErrorCarrier (retry-classified by
 * fetchWithRetry) — it never resolves to an empty map, so a lookup can never be
 * silently reported as "NAICS not found" during an outage.
 */
async function loadSizeStandards(): Promise<{
  byId: Map<string, SbaNaicsEntry>;
  count: number;
  provenance: Provenance;
}> {
  return memoize("sba:size-standards", async () => {
    // ★Route the fetch through the resilience path-chain. The LIVE path is
    // byte-identical to the prior bare fetch — same URL, same init
    // ({headers:{Accept}, signal}), same label — so with no snapshot configured
    // the chain is SINGLE-ENTRY, `throughPathChain` fast-paths (no breaker
    // consult), and behavior is BYTE-IDENTICAL to before this ADR. The snapshot
    // (key `sba_size_standards`, the whole array) is added only when
    // SAMGOV_SNAPSHOT_BASE_URL is configured (else snapshotPath returns null).
    const livePath: ResiliencePath<unknown> = {
      host: SBA_HOST,
      provenance: { dataPath: "live" },
      run: async () => {
        const r = await fetchWithRetry(
          SBA_NAICS_URL,
          {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(15_000),
          },
          "sba:naics.json",
        );
        return (await r.json()) as unknown;
      },
    };
    const snap = snapshotPath<unknown>("sba_size_standards");
    const paths = snap ? [livePath, snap] : [livePath];
    const { body: raw, provenance } = await throughPathChain<unknown>(
      paths,
      sbaBreaker,
    );
    if (!Array.isArray(raw)) {
      // 200 with an unexpected shape ⇒ schema drift, not "no data".
      throw new ToolErrorCarrier({
        kind: "schema_drift",
        message:
          "sba.gov naics.json did not return a JSON array (schema drift — the size-standards dataset shape changed).",
        retryable: false,
        upstreamEndpoint: "sba:naics.json",
      });
    }
    const byId = new Map<string, SbaNaicsEntry>();
    for (const entry of raw as SbaNaicsEntry[]) {
      const id = entry?.id;
      // Index only clean 6-digit NAICS ids. The `<code>_a_Except` exception
      // rows share a base code with their parent and would otherwise clobber
      // the canonical entry; a caller looks up a plain 6-digit NAICS.
      if (typeof id === "string" && /^\d{6}$/.test(id) && !byId.has(id)) {
        byId.set(id, entry);
      }
    }
    return { byId, count: byId.size, provenance };
  });
}

export type SizeStandardResult = {
  naics: string;
  found: boolean;
  description: string | null;
  sector: string | null;
  subsector: string | null;
  standardType: "receipts" | "employees" | "assets" | "receipts+assets" | "unknown";
  /** Receipts/assets → DOLLARS (revenueLimit*1e6); employees → the count. */
  threshold: number | null;
  unit: "USD annual receipts" | "employees" | "USD assets" | null;
  /** Raw normalized values (null where the dataset has none). */
  revenueLimitUSD: number | null;
  employeeCountLimit: number | null;
  assetLimitUSD: number | null;
  footnote: string[] | null;
  /** Retrieval timestamp — the value is "as published as of" this instant. */
  asOf: string;
  sourceUrl: string;
};

/** The doc-07 "not a permanent constant" caveat, surfaced in every _meta. */
const NOT_A_CONSTANT_CAVEAT =
  "SBA size standards are adjusted periodically (e.g. SBA has proposed monetary increases) — " +
  "treat this as the value published in the fetched dataset as of retrieval, not a permanent " +
  "constant; the dataset does not carry an explicit effective-date field, so verify the current " +
  "standard at sba.gov for high-stakes eligibility.";

/**
 * Look up the SBA small-business size standard for one 6-digit NAICS.
 *
 * Returns `found:false` (never a fabricated standard) when the NAICS is not in
 * the fetched dataset, with the disclosure carried in `_meta.notes`.
 */
export async function sizeStandard(args: { naics: string }) {
  const naics = (args.naics ?? "").trim();
  // Validate shape at the tool boundary — a malformed NAICS is invalid_input,
  // not a silent "not found". (The server also enforces this via Zod.)
  if (!/^\d{6}$/.test(naics)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `naics must be a 6-digit NAICS code (got "${args.naics}").`,
      retryable: false,
      upstreamEndpoint: "sba:naics.json",
    });
  }

  const { byId, count, provenance } = await loadSizeStandards();
  const asOf = new Date().toISOString();
  const entry = byId.get(naics);

  if (!entry) {
    const data: SizeStandardResult = {
      naics,
      found: false,
      description: null,
      sector: null,
      subsector: null,
      standardType: "unknown",
      threshold: null,
      unit: null,
      revenueLimitUSD: null,
      employeeCountLimit: null,
      assetLimitUSD: null,
      footnote: null,
      asOf,
      sourceUrl: SBA_NAICS_URL,
    };
    return withMeta(data, {
      source: "sba.gov naics.json (keyless)",
      keylessMode: true,
      returned: 0,
      // LEAD-12 fix (C78 adversarial review): a definitive not-found is a COMPLETE,
      // non-truncated answer — the tool scanned the whole cached dataset and confirmed
      // the NAICS is absent. totalAvailable is 0 (zero records match THIS query), NOT
      // the ~978-row dataset size; sourcing `count` here made returned(0) < 978 →
      // truncated:true → complete:false, which falsely told the agent to paginate for
      // the "other 977 results" that do not exist. complete now derives to true. The
      // dataset size stays in the note below (its correct home = prose disclosure).
      totalAvailable: 0,
      fieldsUnavailable: [
        "description",
        "sector",
        "subsector",
        "standardType",
        "threshold",
        "unit",
        "revenueLimitUSD",
        "employeeCountLimit",
        "assetLimitUSD",
      ],
      notes: [
        `NAICS ${naics} is not present in the SBA size-standards dataset (${count} 6-digit codes as of retrieval). No size standard was fabricated — confirm the code is a current 6-digit NAICS and check sba.gov.`,
        NOT_A_CONSTANT_CAVEAT,
      ],
      // P5 provenance — threaded ONLY when NON-live ⇒ live stays byte-identical.
      ...provenanceMeta(provenance),
    });
  }

  // Normalize the raw millions figures to dollars. Exactly one of the three
  // limits is set on any real row (verified live), so we classify by presence.
  const revenueLimitUSD =
    typeof entry.revenueLimit === "number"
      ? entry.revenueLimit * MILLIONS
      : null;
  const assetLimitUSD =
    typeof entry.assetLimit === "number" ? entry.assetLimit * MILLIONS : null;
  const employeeCountLimit =
    typeof entry.employeeCountLimit === "number"
      ? entry.employeeCountLimit
      : null;

  let standardType: SizeStandardResult["standardType"];
  let threshold: number | null;
  let unit: SizeStandardResult["unit"];
  const fieldsUnavailable: string[] = [];

  if (revenueLimitUSD !== null) {
    // Receipts-based. (A financial NAICS could in principle also carry an
    // asset figure — none do today — in which case we flag it receipts+assets.)
    standardType = assetLimitUSD !== null ? "receipts+assets" : "receipts";
    threshold = revenueLimitUSD;
    unit = "USD annual receipts";
  } else if (employeeCountLimit !== null) {
    standardType = "employees";
    threshold = employeeCountLimit;
    unit = "employees";
  } else if (assetLimitUSD !== null) {
    // Asset-only standard (financial institutions — e.g. Commercial Banking).
    // Labeled "assets" (NOT "receipts+assets") — these rows carry NO receipts
    // component, so the label must not imply one.
    standardType = "assets";
    threshold = assetLimitUSD;
    unit = "USD assets";
  } else {
    // A row exists but publishes no numeric standard (rare/reserved).
    standardType = "unknown";
    threshold = null;
    unit = null;
    fieldsUnavailable.push("threshold", "unit", "standardType");
  }

  const data: SizeStandardResult = {
    naics,
    found: true,
    description: entry.description ?? null,
    sector: entry.sectorDescription ?? null,
    subsector: entry.subsectorDescription ?? null,
    standardType,
    threshold,
    unit,
    revenueLimitUSD,
    employeeCountLimit,
    assetLimitUSD,
    footnote: entry.footnote ?? null,
    asOf,
    sourceUrl: SBA_NAICS_URL,
  };

  // A human-readable restatement of the threshold, so the AI never mistakes the
  // raw millions figure ("34") for dollars.
  const thresholdNote =
    unit === "USD annual receipts"
      ? `Size standard: $${(threshold as number).toLocaleString("en-US")} in average annual receipts (SBA publishes this as $${entry.revenueLimit} million).`
      : unit === "employees"
        ? `Size standard: ${(threshold as number).toLocaleString("en-US")} employees.`
        : unit === "USD assets"
          ? `Size standard: $${(threshold as number).toLocaleString("en-US")} in assets (SBA publishes this as $${entry.assetLimit} million); this is a financial-institution asset-based standard.`
          : `No numeric size standard is published for NAICS ${naics} in this dataset.`;

  const notes = [thresholdNote, NOT_A_CONSTANT_CAVEAT];
  if (entry.footnote && entry.footnote.length > 0) {
    notes.push(
      "This NAICS carries an SBA footnote qualifying the standard (see data.footnote).",
    );
  }

  return withMeta(data, {
    source: "sba.gov naics.json (keyless)",
    keylessMode: true,
    returned: 1,
    // LEAD-12 fix (Codex C76 dogfood, C78 live-repro): a single-NAICS lookup has
    // exactly ONE matching size standard — totalAvailable is 1, NOT the whole
    // dataset row count (`count`, ~978). Using `count` made totalAvailable(978) >
    // returned(1), which buildMeta reads as totalProvesTruncation → truncated:true
    // → complete:false, MISLABELING a complete exact answer as a truncated 1-of-978
    // result (the explicit complete:true above was silently overridden).
    totalAvailable: 1,
    complete: true,
    fieldsUnavailable,
    notes,
    // P5 provenance — threaded ONLY when NON-live ⇒ live stays byte-identical.
    // On a snapshot, buildMeta forces complete!==true (M1a) and qualifies the
    // totalAvailable via totalIsEstimated (M1b) — the found standard is disclosed
    // as an as-of figure, never a live-authoritative one.
    ...provenanceMeta(provenance),
  });
}
