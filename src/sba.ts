/**
 * SBA size standards lookup — keyless, embedded.
 *
 * Source: 13 CFR §121.201 (effective 2023-03-17). The official PDF
 * table is at https://www.sba.gov/document/support-table-size-standards.
 *
 * Why embedded: SBA does not publish a stable JSON/CSV API for the
 * size-standards table. The eCFR text contains the data but parsing
 * it reliably is brittle. Embedding a curated JSON keeps the lookup
 * keyless, deterministic, fast, and offline-capable.
 *
 * Coverage: v0.4 covers ~50 of the most-used NAICS codes for federal
 * services / IT / R&D / consulting / construction. Coverage will
 * expand each release. For NAICS not in this file, callers should
 * fall back to ecfr_search(query="size standard NAICS XXXXXX",
 * titleNumber=13).
 *
 * Multi-tier handling: some NAICS (e.g. 541330 Engineering Services)
 * have multiple size standards depending on the specific work scope
 * — military aerospace, marine, etc. all have higher caps. The lookup
 * returns ALL applicable entries; the firm qualifies under ANY one
 * being satisfied.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type SizeStandardEntry = {
  /** "revenue" = average annual revenue cap (3-year avg). "employee" = average employee count cap. */
  type: "revenue" | "employee";
  /** Revenue cap in millions of USD (when type === "revenue"). */
  thresholdMillionsUsd?: number;
  /** Employee count cap (when type === "employee"). */
  thresholdEmployees?: number;
  /** Sub-industry description. May say "default" when this is the catch-all entry. */
  industry: string;
};

export type SizeStandardLookup = {
  found: true;
  naics: string;
  entries: SizeStandardEntry[];
  citation: string;
  effectiveDate: string;
  notes?: string;
} | {
  found: false;
  naics: string;
  hint: string;
  citation: string;
};

type StandardsFile = {
  $source: string;
  $effectiveDate: string;
  $citationUrl: string;
  $officialTableUrl: string;
  $coverage: string;
  $notes: string;
  standards: Record<string, SizeStandardEntry[]>;
};

let cached: StandardsFile | undefined;

/**
 * Inject data directly (used by the Cloudflare Worker build, which has no filesystem).
 * Call once at startup before any lookup; subsequent calls are no-ops if cache is set.
 */
export function _injectData(data: StandardsFile): void {
  cached = data;
}

function load(): StandardsFile {
  if (cached) return cached;
  // src/sba.ts -> src/data/sba-size-standards.json
  // dist/sba.js -> ../src/data/sba-size-standards.json (since data/ stays in src/)
  // To keep both work, look in two candidate paths and use the first that exists.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "data", "sba-size-standards.json"),       // src/sba.ts case
    join(here, "..", "src", "data", "sba-size-standards.json"), // dist/sba.js case
  ];
  for (const p of candidates) {
    try {
      const text = readFileSync(p, "utf-8");
      cached = JSON.parse(text) as StandardsFile;
      return cached;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    "sba-size-standards.json not found. Expected at src/data/ or one level up from dist/.",
  );
}

/**
 * Look up the SBA size standard for a given 6-digit NAICS code.
 *
 * Returns:
 *   { found: true, entries: [...], citation, effectiveDate }
 *   { found: false, hint } — caller should fall back to ecfr_search.
 */
export function lookupSizeStandard(naicsCode: string): SizeStandardLookup {
  const file = load();
  const code = (naicsCode || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return {
      found: false,
      naics: code,
      hint:
        "NAICS codes must be 6 digits (e.g. '541512'). Use usas_autocomplete_naics with a free-text description if you don't have the code.",
      citation: file.$citationUrl,
    };
  }
  const entries = file.standards[code];
  if (!entries) {
    return {
      found: false,
      naics: code,
      hint: `NAICS ${code} is not in the v0.4 embedded table (~50 most-used codes). Fall back to ecfr_search(query='size standard NAICS ${code}', titleNumber=13) for full eCFR coverage.`,
      citation: file.$citationUrl,
    };
  }
  return {
    found: true,
    naics: code,
    entries,
    citation: file.$citationUrl,
    effectiveDate: file.$effectiveDate,
    notes:
      entries.length > 1
        ? "Multiple entries returned — these are ALTERNATIVES. A firm qualifies under ANY one being satisfied."
        : undefined,
  };
}

/**
 * Format a size-standard entry as a human-readable one-liner.
 * E.g. "$34M revenue (3-year avg)" or "1,000 employees".
 */
export function formatSizeStandard(e: SizeStandardEntry): string {
  if (e.type === "revenue") {
    return `$${e.thresholdMillionsUsd}M revenue (3-year avg)`;
  }
  return `${(e.thresholdEmployees ?? 0).toLocaleString()} employees`;
}

/**
 * High-level qualification check: given (naics, claimedRevenue?,
 * claimedEmployees?), return whether the firm qualifies as small.
 *
 * Returns:
 *   { qualifies: true | false, byEntry: [...] }
 *   or { qualifies: "indeterminate", reason } when neither metric is provided.
 */
export type QualificationCheck = {
  qualifies: true | false | "indeterminate";
  reason?: string;
  /** Per-entry result: which alternative size standard the firm qualifies under (or doesn't). */
  byEntry: Array<{
    industry: string;
    type: "revenue" | "employee";
    threshold: number;
    claimed?: number;
    qualifies: boolean | "indeterminate";
  }>;
  citation: string;
};

export function checkQualification(args: {
  naicsCode: string;
  averageAnnualRevenueUsd?: number;
  averageEmployees?: number;
}): QualificationCheck | { qualifies: "unknown"; reason: string; citation: string } {
  const lookup = lookupSizeStandard(args.naicsCode);
  if (!lookup.found) {
    return {
      qualifies: "unknown",
      reason: lookup.hint,
      citation: lookup.citation,
    };
  }
  const byEntry = lookup.entries.map((entry) => {
    if (entry.type === "revenue") {
      const claimed = args.averageAnnualRevenueUsd;
      const threshold = (entry.thresholdMillionsUsd ?? 0) * 1_000_000;
      return {
        industry: entry.industry,
        type: entry.type,
        threshold,
        claimed,
        qualifies:
          claimed === undefined
            ? ("indeterminate" as const)
            : claimed <= threshold,
      };
    }
    const claimed = args.averageEmployees;
    const threshold = entry.thresholdEmployees ?? 0;
    return {
      industry: entry.industry,
      type: entry.type,
      threshold,
      claimed,
      qualifies:
        claimed === undefined
          ? ("indeterminate" as const)
          : claimed <= threshold,
    };
  });
  // Firm qualifies if it qualifies under ANY one alternative entry.
  const anyQualifies = byEntry.some((b) => b.qualifies === true);
  const allIndet = byEntry.every((b) => b.qualifies === "indeterminate");
  const qualifies: QualificationCheck["qualifies"] = anyQualifies
    ? true
    : allIndet
      ? "indeterminate"
      : false;
  return {
    qualifies,
    reason: allIndet
      ? "Provide either averageAnnualRevenueUsd or averageEmployees to evaluate."
      : undefined,
    byEntry,
    citation: lookup.citation,
  };
}
