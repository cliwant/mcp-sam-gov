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
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
const SBA_NAICS_URL = "https://www.sba.gov/sites/default/files/data/naics.json";
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
async function loadSizeStandards() {
    return memoize("sba:size-standards", async () => {
        const r = await fetchWithRetry(SBA_NAICS_URL, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(15_000),
        }, "sba:naics.json");
        const raw = (await r.json());
        if (!Array.isArray(raw)) {
            // 200 with an unexpected shape ⇒ schema drift, not "no data".
            throw new ToolErrorCarrier({
                kind: "schema_drift",
                message: "sba.gov naics.json did not return a JSON array (schema drift — the size-standards dataset shape changed).",
                retryable: false,
                upstreamEndpoint: "sba:naics.json",
            });
        }
        const byId = new Map();
        for (const entry of raw) {
            const id = entry?.id;
            // Index only clean 6-digit NAICS ids. The `<code>_a_Except` exception
            // rows share a base code with their parent and would otherwise clobber
            // the canonical entry; a caller looks up a plain 6-digit NAICS.
            if (typeof id === "string" && /^\d{6}$/.test(id) && !byId.has(id)) {
                byId.set(id, entry);
            }
        }
        return { byId, count: byId.size };
    });
}
/** The doc-07 "not a permanent constant" caveat, surfaced in every _meta. */
const NOT_A_CONSTANT_CAVEAT = "SBA size standards are adjusted periodically (e.g. SBA has proposed monetary increases) — " +
    "treat this as the value published in the fetched dataset as of retrieval, not a permanent " +
    "constant; the dataset does not carry an explicit effective-date field, so verify the current " +
    "standard at sba.gov for high-stakes eligibility.";
/**
 * Look up the SBA small-business size standard for one 6-digit NAICS.
 *
 * Returns `found:false` (never a fabricated standard) when the NAICS is not in
 * the fetched dataset, with the disclosure carried in `_meta.notes`.
 */
export async function sizeStandard(args) {
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
    const { byId, count } = await loadSizeStandards();
    const asOf = new Date().toISOString();
    const entry = byId.get(naics);
    if (!entry) {
        const data = {
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
            totalAvailable: count,
            complete: false,
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
        });
    }
    // Normalize the raw millions figures to dollars. Exactly one of the three
    // limits is set on any real row (verified live), so we classify by presence.
    const revenueLimitUSD = typeof entry.revenueLimit === "number"
        ? entry.revenueLimit * MILLIONS
        : null;
    const assetLimitUSD = typeof entry.assetLimit === "number" ? entry.assetLimit * MILLIONS : null;
    const employeeCountLimit = typeof entry.employeeCountLimit === "number"
        ? entry.employeeCountLimit
        : null;
    let standardType;
    let threshold;
    let unit;
    const fieldsUnavailable = [];
    if (revenueLimitUSD !== null) {
        // Receipts-based. (A financial NAICS could in principle also carry an
        // asset figure — none do today — in which case we flag it receipts+assets.)
        standardType = assetLimitUSD !== null ? "receipts+assets" : "receipts";
        threshold = revenueLimitUSD;
        unit = "USD annual receipts";
    }
    else if (employeeCountLimit !== null) {
        standardType = "employees";
        threshold = employeeCountLimit;
        unit = "employees";
    }
    else if (assetLimitUSD !== null) {
        // Asset-only standard (financial institutions — e.g. Commercial Banking).
        // Labeled "assets" (NOT "receipts+assets") — these rows carry NO receipts
        // component, so the label must not imply one.
        standardType = "assets";
        threshold = assetLimitUSD;
        unit = "USD assets";
    }
    else {
        // A row exists but publishes no numeric standard (rare/reserved).
        standardType = "unknown";
        threshold = null;
        unit = null;
        fieldsUnavailable.push("threshold", "unit", "standardType");
    }
    const data = {
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
    const thresholdNote = unit === "USD annual receipts"
        ? `Size standard: $${threshold.toLocaleString("en-US")} in average annual receipts (SBA publishes this as $${entry.revenueLimit} million).`
        : unit === "employees"
            ? `Size standard: ${threshold.toLocaleString("en-US")} employees.`
            : unit === "USD assets"
                ? `Size standard: $${threshold.toLocaleString("en-US")} in assets (SBA publishes this as $${entry.assetLimit} million); this is a financial-institution asset-based standard.`
                : `No numeric size standard is published for NAICS ${naics} in this dataset.`;
    const notes = [thresholdNote, NOT_A_CONSTANT_CAVEAT];
    if (entry.footnote && entry.footnote.length > 0) {
        notes.push("This NAICS carries an SBA footnote qualifying the standard (see data.footnote).");
    }
    return withMeta(data, {
        source: "sba.gov naics.json (keyless)",
        keylessMode: true,
        returned: 1,
        totalAvailable: count,
        complete: true,
        fieldsUnavailable,
        notes,
    });
}
//# sourceMappingURL=sba.js.map