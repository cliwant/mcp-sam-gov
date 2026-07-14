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
/** Test-only: reset the resilience breaker between OFFLINE fixtures (mirrors
 *  treasury.ts's `_resetTreasuryBreakerForTests`). */
export declare function _resetSbaBreakerForTests(): void;
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
/**
 * Look up the SBA small-business size standard for one 6-digit NAICS.
 *
 * Returns `found:false` (never a fabricated standard) when the NAICS is not in
 * the fetched dataset, with the disclosure carried in `_meta.notes`.
 */
export declare function sizeStandard(args: {
    naics: string;
}): Promise<import("./meta.js").MetaBundle<SizeStandardResult>>;
//# sourceMappingURL=sba.d.ts.map