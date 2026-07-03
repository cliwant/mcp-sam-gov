/**
 * Integrity & teaming tier (keyless) — debarment screening + small-business
 * discovery for teaming, both grounded on LIVE-VERIFIED public endpoints
 * (2026-07-03).
 *
 * Two keyless tools:
 *   - sam_check_exclusions        → SAM debarment/exclusion screening
 *   - usas_search_teaming_partners → award-derived small-business discovery,
 *                                    integrity-screened
 *
 * The defining truthfulness constraints of this tier:
 *
 *   1. SAM exclusions — an EMPTY result is a TRUE NEGATIVE with a narrow
 *      meaning ("no matching exclusion under these terms"), NOT a clean bill of
 *      health. We say so, loudly, in every `_meta.notes` so an AI never reads
 *      "0 records" as "responsible".  The exclusions index is `ex` (NOT
 *      `ei`/`exclusion`), served keyless from sam.gov's frontend SGS with an
 *      `application/hal+json` Accept + a browser-y User-Agent.  Deep paging is
 *      capped at 10,000 records server-side.
 *
 *   2. USAspending socioeconomic proxy — a BOGUS `recipient_type_names` value
 *      returns `0` results with HTTP 200 (VERIFIED — a silent accept). So the
 *      `cert` parameter MUST be a Zod enum of values confirmed live (see the
 *      server's TeamingPartnersInput); the runtime here ALSO re-validates the
 *      cert against `VERIFIED_CERTS` and throws a structured `invalid_input`
 *      rather than ever issuing a confident-empty list. And the cert is
 *      AWARD-DERIVED (recorded on the firm's federal awards), NOT the SBA
 *      certification of record (which needs a keyed SAM Entity call) — every
 *      response says so.
 */
type ExclusionClassification = "Firm" | "Individual" | "Special Entity Designation" | "any";
/**
 * Keyless SAM debarment / exclusion screening.
 *
 * Requires at least one of `query`/`uei`/`cage` (else structured
 * invalid_input). `query` drives the server-side `q=`; `uei`/`cage` are
 * POST-filtered on the returned rows (the frontend SGS has no dedicated
 * uei/cage query param). `activeOnly` and `classification` are also applied as
 * post-filters. The response distinguishes:
 *   - `excluded`: ≥1 ACTIVE record matched the (post-filtered) query,
 *   - `matchCount`: how many rows matched after post-filtering.
 * An empty/false result is disclosed as a NARROW true-negative, never a
 * general clearance (see NOT_PROOF_NOTE).
 */
export declare function checkExclusions(args: {
    query?: string;
    uei?: string;
    cage?: string;
    activeOnly?: boolean;
    classification?: ExclusionClassification;
    page?: number;
    size?: number;
}): Promise<import("./meta.js").MetaBundle<{
    excluded: boolean;
    matchCount: number;
    records: {
        name: string;
        classification: string | null;
        uei: string | null;
        cage: string | null;
        samNumber: string | null;
        excludingAgency: string | null;
        excludingAgencyDesc: string | null;
        exclusionType: string | null;
        exclusionProgram: string | null;
        ctCode: string | null;
        ctCodeDesc: string | null;
        isActive: boolean | null;
        activationDate: string | null;
        terminationDate: string | null;
        address: Record<string, unknown> | null;
        samFapiisUrl: string;
    }[];
    page: number;
    size: number;
}>>;
/**
 * Keyless one-call integrity screen — "any integrity red flags on this entity?"
 *
 * Composes the KEYLESS exclusion verdict (via {@link checkExclusions}, REUSED —
 * exclusion fetching is not re-implemented here) with an HONEST pointer to the
 * FAPIIS / Responsibility-Qualification record, which has NO keyless machine
 * API. Requires at least one of `uei`/`cage`/`name` (uei preferred); `name`
 * maps to the exclusion tool's `query`.
 *
 * TRUTHFULNESS (doc 07 §2.2):
 *   - `integrityFlag` is `"excluded"` when ≥1 ACTIVE matching exclusion is found,
 *     else `"review_fapiis"`. It NEVER emits `"clear"` keylessly — terminations
 *     for default/cause, non-responsibility determinations, and self-reported
 *     criminal/civil/administrative proceedings live in FAPIIS, which is not
 *     machine-readable without a key, so the absence of an exclusion does NOT
 *     prove integrity.
 *   - `fapiisRecords` is ALWAYS `null` (never faked), with
 *     `_meta.fieldsUnavailable: ["fapiisRecords"]` + INTEGRITY_FAPIIS_NOTE.
 *   - An upstream `checkExclusions` failure PROPAGATES as the classified error
 *     (the ToolErrorCarrier bubbles) — it is never masked as a "clear"/empty.
 */
export declare function integrityLookup(args: {
    uei?: string;
    cage?: string;
    name?: string;
}): Promise<import("./meta.js").MetaBundle<{
    entity: {
        name: string | null;
        uei: string | null;
        cage: string | null;
    };
    exclusions: {
        excluded: boolean;
        activeCount: number;
        records: {
            name: string;
            classification: string | null;
            uei: string | null;
            cage: string | null;
            samNumber: string | null;
            excludingAgency: string | null;
            excludingAgencyDesc: string | null;
            exclusionType: string | null;
            exclusionProgram: string | null;
            ctCode: string | null;
            ctCodeDesc: string | null;
            isActive: boolean | null;
            activationDate: string | null;
            terminationDate: string | null;
            address: Record<string, unknown> | null;
            samFapiisUrl: string;
        }[];
    };
    fapiisRecords: null;
    fapiisContentUrl: string;
    fapiisUrl: string;
    integrityFlag: "excluded" | "review_fapiis";
}>>;
/**
 * The `recipient_type_names` vocabulary CONFIRMED live (2026-07-03) to narrow a
 * known-populated NAICS (541512, 2023+) to a plausible non-zero, non-baseline
 * count — the server SILENTLY accepts a bogus value and returns 0 with HTTP
 * 200, so this allow-list is the guardrail. The server's Zod enum mirrors this
 * set; this runtime re-check is defense-in-depth so a bad value can never yield
 * a confident-empty list.
 *
 * Verified counts (NAICS 541512, action_date ≥ 2023-01-01):
 *   small_business ....................................... 11539
 *   8a_program_participant ...............................  4902
 *   woman_owned_business .................................  3251
 *   veteran_owned_business ...............................  2805
 *   service_disabled_veteran_owned_business .............  2450
 *   women_owned_small_business ..........................  1931
 *   economically_disadvantaged_women_owned_small_business  1192
 *   historically_underutilized_business_firm (HUBZone) ..  1025
 */
export declare const VERIFIED_CERTS: readonly ["small_business", "8a_program_participant", "woman_owned_business", "women_owned_small_business", "economically_disadvantaged_women_owned_small_business", "service_disabled_veteran_owned_business", "veteran_owned_business", "historically_underutilized_business_firm"];
export type VerifiedCert = (typeof VERIFIED_CERTS)[number];
/**
 * Small-business teaming-partner discovery by socioeconomic certification +
 * NAICS + agency award history (keyless USAspending `spending_by_award`
 * proxy), integrity-screened.
 *
 * MECHANISM: query `spending_by_award` filtered by `recipient_type_names:[cert]`
 * (+ optional naics/agency/subagency + an action_date lookback), page a bounded
 * number of award rows, then AGGREGATE client-side by `recipient_id`
 * (spending_by_award is NOT pre-grouped by recipient — one firm spans many
 * rows). Each candidate carries agencyAwardCount + agencyObligated +
 * mostRecentAwardDate + sampleAwards, ranked by agencyObligated desc, with
 * `minAwards` applied AFTER aggregation.
 *
 * INTEGRITY: when `excludeDebarred`, the top candidates (bounded by
 * `screenCap`) are screened via checkExclusions and flagged/dropped on an
 * ACTIVE exclusion. The screen is bounded and DISCLOSED (how many screened /
 * removed / whether the screen was capped).
 *
 * HONESTY: the cert is AWARD-DERIVED, not the SBA registry of record
 * (TEAMING_PROXY_NOTE, always in _meta). A bogus cert never reaches the network
 * — it is rejected as invalid_input (the endpoint would silently return 0).
 */
export declare function searchTeamingPartners(args: {
    cert: string;
    naics?: string;
    agency?: string;
    subagency?: string;
    lookbackYears?: number;
    excludeDebarred?: boolean;
    minAwards?: number;
    limit?: number;
    page?: number;
    screenCap?: number;
    scanPages?: number;
}): Promise<import("./meta.js").MetaBundle<{
    candidates: {
        recipientName: string;
        recipient_id: string | null;
        uei: string | null;
        cert: string;
        naicsMatched: string[];
        agencyAwardCount: number;
        agencyObligated: number;
        mostRecentAwardDate: string | null;
        sampleAwards: {
            awardId: string;
            agency: string;
            amount: number;
            date: string | null;
        }[];
        excluded: boolean | null;
    }[];
    cert: string;
    page: number;
    limit: number;
}>>;
export {};
//# sourceMappingURL=integrity.d.ts.map