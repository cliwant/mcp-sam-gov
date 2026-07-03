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
import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
import { withMeta } from "./meta.js";
// ─── Shared HTTP ─────────────────────────────────────────────────
// SAM's public frontend SGS endpoint gates on a browser-y User-Agent AND
// requires `Accept: application/hal+json`. Mirror the pricing tier's UA so
// behavior is consistent across the server.
const SAM_UA = "Mozilla/5.0 (compatible; @cliwant/mcp-sam-gov; +https://github.com/cliwant/mcp-sam-gov)";
const SAM_HAL_HEADERS = {
    Accept: "application/hal+json",
    "User-Agent": SAM_UA,
};
const SGS_BASE = "https://sam.gov/api/prod/sgs/v1/search";
const USAS = "https://api.usaspending.gov/api/v2";
// Server-side deep-paging cap on the SGS search index (LIVE-VERIFIED:
// page.maxAllowedRecords = 10000).
const SGS_MAX_RECORDS = 10_000;
async function getSgsJson(url, label) {
    const r = await fetchWithRetry(url, { headers: SAM_HAL_HEADERS, signal: AbortSignal.timeout(15_000) }, label);
    return (await r.json());
}
async function postUsas(endpoint, body) {
    const r = await fetchWithRetry(`${USAS}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    }, `usaspending:${endpoint}`);
    return (await r.json());
}
// ─── 1. sam_check_exclusions ─────────────────────────────────────
const EXCLUSIONS_SOURCE = "sam.gov/api/prod (frontend HAL, keyless)";
/**
 * The mandatory disclosure attached to EVERY exclusions response. An empty
 * result is a narrow true-negative — never a general clearance. Kept as a
 * constant so the smoke/edge tests can assert on it verbatim.
 */
const NOT_PROOF_NOTE = "An empty result means no matching exclusion was found (not currently excluded under these terms) — it is NOT proof of general responsibility.";
/** Normalize a UEI/CAGE for a case-insensitive post-filter compare. */
function norm(s) {
    return (s ?? "").trim().toUpperCase();
}
/**
 * Normalize a legal entity NAME for a precise match: uppercase, strip
 * punctuation, drop trailing entity suffixes (LLC/INC/CORP/…), and collapse
 * whitespace. Used to decide whether an exclusion record genuinely names a
 * given firm — SAM's free-text `q` tokenizes, so a raw "≥1 result" is NOT a
 * match ("VISIONARY CONSULTING PARTNERS, LLC" would otherwise hit every
 * unrelated "…CONSULTING…" exclusion, a dangerous false positive).
 */
function normName(s) {
    return (s ?? "")
        .toUpperCase()
        .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, " ")
        .replace(/\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC|PC)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
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
export async function checkExclusions(args) {
    const query = args.query?.trim() || undefined;
    const uei = args.uei?.trim() || undefined;
    const cage = args.cage?.trim() || undefined;
    const activeOnly = args.activeOnly ?? true;
    const classification = args.classification ?? "any";
    const page = Math.max(0, Math.floor(args.page ?? 0));
    const size = Math.min(100, Math.max(1, Math.floor(args.size ?? 25)));
    // At least one selector is required — an unbounded exclusions dump is never
    // a meaningful screen.
    if (!query && !uei && !cage) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: "sam_check_exclusions requires at least one of query, uei, or cage. Pass the firm/individual name (query) and/or a UEI/CAGE to screen.",
            retryable: false,
            upstreamEndpoint: "sgs/v1/search?index=ex",
        });
    }
    // Build the SGS query. `q` is the only server-side text selector on this
    // index; uei/cage are post-filtered. When only a uei/cage is given (no
    // name), use it as the `q` so the server still narrows.
    const qValue = query ?? uei ?? cage ?? "";
    const params = new URLSearchParams({
        index: "ex",
        q: qValue,
        page: String(page),
        size: String(size),
        mode: "search",
    });
    const url = `${SGS_BASE}?${params.toString()}`;
    const json = await getSgsJson(url, "sam:sgs:ex");
    const rawResults = json._embedded?.results ?? [];
    const totalElements = json.page?.totalElements ?? null;
    const filtersApplied = [];
    const filtersDropped = [];
    if (query)
        filtersApplied.push("query(q, server-side)");
    else if (uei)
        filtersApplied.push("uei(as q, server-side)");
    else if (cage)
        filtersApplied.push("cage(as q, server-side)");
    // Post-filter on uei/cage/classification/activeOnly over the fetched page.
    const ueiU = norm(uei);
    const cageU = norm(cage);
    let filtered = rawResults;
    if (uei && query) {
        // uei alongside a name query → narrow the name results to that UEI.
        filtered = filtered.filter((r) => norm(r.ueiSam) === ueiU);
        filtersApplied.push("uei(post-filter)");
    }
    if (cage && (query || uei)) {
        filtered = filtered.filter((r) => norm(r.cageCode) === cageU);
        filtersApplied.push("cage(post-filter)");
    }
    if (classification !== "any") {
        filtered = filtered.filter((r) => (r.classification?.code ?? "") === classification);
        filtersApplied.push(`classification(${classification})`);
    }
    if (activeOnly) {
        filtered = filtered.filter((r) => r.isActive === true);
        filtersApplied.push("activeOnly");
    }
    const records = filtered.map((r) => {
        const ueiSam = r.ueiSam ?? null;
        return {
            name: r.title ?? "",
            classification: r.classification?.code ?? null,
            uei: ueiSam,
            cage: r.cageCode ?? null,
            samNumber: r.samNumber ?? null,
            excludingAgency: r.excludingAgency ?? null,
            excludingAgencyDesc: r.excludingAgencyDesc ?? null,
            exclusionType: r.exclusionType ?? r.type?.value ?? null,
            exclusionProgram: r.exclusionProgram ?? null,
            ctCode: r.ctCode ?? null,
            ctCodeDesc: r.ctCodeDesc ?? null,
            isActive: r.isActive ?? null,
            activationDate: r.activationDate ?? null,
            terminationDate: r.terminationDate ?? null,
            address: r.address ?? null,
            // FAPIIS (the official exclusions/responsibility record) lookup URL.
            samFapiisUrl: ueiSam
                ? `https://sam.gov/search/?index=ex&q=${encodeURIComponent(ueiSam)}`
                : `https://sam.gov/search/?index=ex&q=${encodeURIComponent(r.title ?? qValue)}`,
        };
    });
    const excluded = records.some((r) => r.isActive === true);
    const matchCount = records.length;
    // truncated when the server total exceeds what a single page returned, OR
    // when we hit the 10k deep-paging ceiling, OR when a post-filter means the
    // fetched page may not contain every match.
    const postFiltered = (Boolean(uei) && Boolean(query)) ||
        (Boolean(cage) && (Boolean(query) || Boolean(uei))) ||
        classification !== "any";
    const serverTruncated = totalElements !== null && rawResults.length < totalElements;
    const hitCap = totalElements !== null && totalElements > SGS_MAX_RECORDS;
    const truncated = serverTruncated || hitCap || postFiltered;
    const notes = [NOT_PROOF_NOTE];
    notes.push("Exclusion screening is only as precise as the name/UEI/CAGE you pass. A name match is NOT identity-proof — confirm the UEI/CAGE, exclusion type, and dates against the FAPIIS record (samFapiisUrl) before acting on a hit.");
    if (postFiltered) {
        notes.push("A uei/cage/classification/activeOnly post-filter was applied over the fetched page only — the true match count for the combined filter may exceed this page. Narrow with a more specific `query` or raise `size`.");
    }
    if (hitCap) {
        notes.push(`SAM caps deep paging at ${SGS_MAX_RECORDS.toLocaleString()} records; this query is too broad to enumerate fully — narrow the query.`);
    }
    if (uei && !query) {
        notes.push("You passed a UEI as the sole selector; it was used as the free-text `q` (the frontend exclusions index has no dedicated UEI field), so a match is a text hit, not a keyed UEI lookup — verify the returned uei equals the one you searched.");
    }
    return withMeta({
        excluded,
        matchCount,
        records,
        page,
        size,
    }, {
        source: EXCLUSIONS_SOURCE,
        keylessMode: true,
        returned: records.length,
        totalAvailable: totalElements,
        truncated,
        pagination: {
            offset: page * size,
            limit: size,
            nextOffset: serverTruncated ? (page + 1) * size : null,
            hasMore: serverTruncated,
        },
        filtersApplied,
        filtersDropped,
        fieldsUnavailable: [],
        notes,
    });
}
// ─── 2. usas_search_teaming_partners ─────────────────────────────
const TEAMING_SOURCE = "usaspending (award-derived socioeconomic proxy, keyless)";
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
export const VERIFIED_CERTS = [
    "small_business",
    "8a_program_participant",
    "woman_owned_business",
    "women_owned_small_business",
    "economically_disadvantaged_women_owned_small_business",
    "service_disabled_veteran_owned_business",
    "veteran_owned_business",
    "historically_underutilized_business_firm",
];
const TEAMING_PROXY_NOTE = "cert reflects socioeconomic categories recorded on the firm's federal awards, NOT the current SBA certification of record (which requires a SAM Entity key) — verify active certification in SAM/SBS before teaming.";
/** True total for a spending_by_award query via the companion count endpoint. */
async function teamingAwardCount(filters) {
    try {
        const json = await postUsas("search/spending_by_award_count/", {
            filters,
            subawards: false,
        });
        const results = json.results;
        if (!results)
            return null;
        return Object.values(results).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
    }
    catch {
        return null;
    }
}
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
export async function searchTeamingPartners(args) {
    // --- Guardrail: the cert MUST be a verified value (defense-in-depth over
    // the server's Zod enum). A bogus value would be SILENTLY accepted by the
    // endpoint (HTTP 200, 0 results) — reject it loudly instead. ----------------
    const cert = args.cert;
    if (!VERIFIED_CERTS.includes(cert)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Unknown socioeconomic cert '${cert}'. USAspending SILENTLY accepts an unrecognized recipient_type_names value and returns 0 results with HTTP 200, so an unverified value would yield a confident-but-empty list. Use one of: ${VERIFIED_CERTS.join(", ")}.`,
            retryable: false,
            upstreamEndpoint: "search/spending_by_award",
        });
    }
    const lookbackYears = Math.min(20, Math.max(1, Math.floor(args.lookbackYears ?? 3)));
    const excludeDebarred = args.excludeDebarred ?? true;
    const minAwards = Math.max(1, Math.floor(args.minAwards ?? 1));
    const limit = Math.min(50, Math.max(1, Math.floor(args.limit ?? 25)));
    const page = Math.max(1, Math.floor(args.page ?? 1));
    const screenCap = Math.min(25, Math.max(1, Math.floor(args.screenCap ?? 10)));
    const scanPages = Math.min(10, Math.max(1, Math.floor(args.scanPages ?? 4)));
    // --- Build filters (only what we can send truthfully) ---------------------
    const nowMs = Date.now();
    const startDate = new Date(nowMs);
    startDate.setUTCFullYear(startDate.getUTCFullYear() - lookbackYears);
    const startIso = startDate.toISOString().slice(0, 10);
    const todayIso = new Date(nowMs).toISOString().slice(0, 10);
    const filters = {
        award_type_codes: ["A", "B", "C", "D"],
        recipient_type_names: [cert],
        time_period: [{ start_date: startIso, end_date: todayIso }],
    };
    const filtersApplied = [
        `cert(${cert})`,
        `actionDateLookback(${lookbackYears}y)`,
    ];
    const filtersDropped = [];
    if (args.naics) {
        filters.naics_codes = [args.naics];
        filtersApplied.push("naics");
    }
    // agency + optional subagency. `agencies` accepts a toptier `name` and,
    // alongside it, a subtier entry when a subagency is given.
    if (args.agency) {
        const agencies = [
            { type: "awarding", tier: "toptier", name: args.agency },
        ];
        if (args.subagency) {
            agencies.push({ type: "awarding", tier: "subtier", name: args.subagency });
        }
        filters.agencies = agencies;
        filtersApplied.push("agency");
        if (args.subagency)
            filtersApplied.push("subagency");
    }
    else if (args.subagency) {
        // A subagency without a parent agency is ambiguous on this endpoint — do
        // not send it silently; disclose it was dropped.
        filtersDropped.push("subagency(requires agency)");
    }
    const fields = [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Awarding Agency",
        "Awarding Sub Agency",
        "NAICS",
        "recipient_id",
        "Start Date",
        "End Date",
    ];
    const byRecipient = new Map();
    let rowsScanned = 0;
    let scanTruncated = false;
    for (let p = 1; p <= scanPages; p++) {
        const resp = await postUsas("search/spending_by_award", {
            filters,
            fields,
            sort: "Award Amount",
            order: "desc",
            limit: 100,
            page: p,
            subawards: false,
        });
        const rows = resp.results ?? [];
        for (const row of rows) {
            rowsScanned++;
            const name = row["Recipient Name"] ?? "";
            // Key by recipient_id when present, else fall back to the (uppercased)
            // name so nameless-id rows still aggregate deterministically.
            const key = row.recipient_id ?? `name:${norm(name)}`;
            const amount = typeof row["Award Amount"] === "number" ? row["Award Amount"] : 0;
            const date = row["End Date"] ?? row["Start Date"] ?? null;
            let c = byRecipient.get(key);
            if (!c) {
                c = {
                    recipientName: name,
                    recipient_id: row.recipient_id ?? null,
                    uei: null, // spending_by_award does not return UEI on the award row.
                    cert,
                    naicsMatched: new Set(),
                    agencyAwardCount: 0,
                    agencyObligated: 0,
                    mostRecentAwardDate: null,
                    sampleAwards: [],
                    excluded: null,
                };
                byRecipient.set(key, c);
            }
            c.agencyAwardCount += 1;
            c.agencyObligated += amount;
            if (row.NAICS?.code)
                c.naicsMatched.add(row.NAICS.code);
            if (date && (c.mostRecentAwardDate === null || date > c.mostRecentAwardDate)) {
                c.mostRecentAwardDate = date;
            }
            if (c.sampleAwards.length < 3) {
                c.sampleAwards.push({
                    awardId: row["Award ID"] ?? "",
                    agency: row["Awarding Agency"] ?? "",
                    amount,
                    date,
                });
            }
        }
        if (!resp.page_metadata?.hasNext)
            break;
        if (p === scanPages && resp.page_metadata?.hasNext)
            scanTruncated = true;
    }
    // --- Rank by obligated desc, apply minAwards, page ------------------------
    const ranked = [...byRecipient.values()]
        .filter((c) => c.agencyAwardCount >= minAwards)
        .sort((a, b) => {
        if (b.agencyObligated !== a.agencyObligated)
            return b.agencyObligated - a.agencyObligated;
        if (b.agencyAwardCount !== a.agencyAwardCount)
            return b.agencyAwardCount - a.agencyAwardCount;
        return a.recipientName.localeCompare(b.recipientName);
    });
    const totalCandidates = ranked.length; // EXACT only when !scanTruncated
    const startIdx = (page - 1) * limit;
    const pageSlice = ranked.slice(startIdx, startIdx + limit);
    // --- Integrity screen (bounded, disclosed) --------------------------------
    let screenedCount = 0;
    let removedCount = 0;
    let screenFailed = false;
    let screenCapped = false;
    if (excludeDebarred && pageSlice.length > 0) {
        const toScreen = pageSlice.slice(0, screenCap);
        screenCapped = pageSlice.length > screenCap;
        for (const c of toScreen) {
            if (!c.recipientName)
                continue;
            try {
                const res = await checkExclusions({
                    query: c.recipientName,
                    activeOnly: true,
                    size: 25,
                });
                screenedCount++;
                // PRECISION: `checkExclusions` returns every free-text hit (SAM's `q`
                // tokenizes), so `res.data.excluded` alone is a false-positive trap —
                // it is true if ANY active record shares a word with the firm name.
                // Only flag this candidate excluded when a returned ACTIVE record's
                // NAME actually matches the firm's (normalized). A non-matching hit is
                // someone else's exclusion and must NOT drop a clean partner.
                const target = normName(c.recipientName);
                const nameMatch = target.length > 0 &&
                    res.data.records.some((rec) => rec.isActive === true && normName(rec.name) === target);
                c.excluded = nameMatch;
                if (nameMatch)
                    removedCount++;
            }
            catch {
                // A screen failure must NOT be read as "clean" — leave excluded:null
                // and disclose that screening degraded.
                screenFailed = true;
                c.excluded = null;
            }
        }
    }
    // Materialize the candidate rows (after screening) — drop active exclusions
    // when excludeDebarred, keep everyone otherwise.
    const candidates = pageSlice
        .filter((c) => !(excludeDebarred && c.excluded === true))
        .map((c) => ({
        recipientName: c.recipientName,
        recipient_id: c.recipient_id,
        uei: c.uei,
        cert: c.cert,
        naicsMatched: [...c.naicsMatched],
        agencyAwardCount: c.agencyAwardCount,
        agencyObligated: c.agencyObligated,
        mostRecentAwardDate: c.mostRecentAwardDate,
        sampleAwards: c.sampleAwards,
        excluded: c.excluded,
    }));
    // --- True total (award count) via the companion endpoint. This is the
    // number of AWARDS, not distinct recipients — the endpoint reports no
    // distinct-recipient total, so recipient totalAvailable stays null. -------
    const awardTotal = await teamingAwardCount(filters);
    // --- Truthful _meta -------------------------------------------------------
    const notes = [TEAMING_PROXY_NOTE];
    notes.push(`Candidates are aggregated client-side by recipient over a bounded ${scanPages}-page scan (${rowsScanned} award row(s), sorted by award amount desc). agencyObligated/agencyAwardCount reflect the SCANNED rows for this cert×filters slice, not necessarily the firm's entire history.`);
    if (scanTruncated) {
        notes.push(`The ${scanPages}-page scan budget was exhausted with more award rows available, so the candidate ranking is a LOWER BOUND (a firm ranked lower here could have more awards on unscanned pages). totalAvailable (distinct recipients) is unknown — narrow with naics/agency/subagency or raise scanPages for a complete ranking.`);
    }
    if (awardTotal !== null) {
        notes.push(`The cert×filters slice covers ${awardTotal} award(s) total (via spending_by_award_count); the ${rowsScanned} scanned row(s) are the highest-value subset. This is an AWARD count, not a distinct-recipient count.`);
    }
    if (excludeDebarred) {
        notes.push(`Integrity screen: ${screenedCount} of the top ${pageSlice.length} ranked candidate(s) were screened for ACTIVE SAM exclusions${screenCapped ? ` (capped at ${screenCap}; lower-ranked candidates on this page were NOT screened)` : ""}; ${removedCount} with an active exclusion ${removedCount === 1 ? "was" : "were"} dropped. Matching is by NORMALIZED NAME (a firm is flagged only when an active exclusion record's name matches — a shared-word text hit does NOT drop a firm), and because UEI is unavailable on award rows this is a NAME match, not a keyed UEI match — confirm any borderline case in SAM. An unscreened candidate's excluded flag is null (unknown), NOT a clearance.`);
        if (screenFailed) {
            notes.push("At least one exclusion screen FAILED (upstream error) — those candidates show excluded:null and were NOT dropped; re-run to complete screening. A failed screen is not a clean result.");
        }
    }
    else {
        notes.push("excludeDebarred is false — candidates were NOT screened for SAM exclusions (`excluded` is null for all). Screen with sam_check_exclusions before teaming.");
    }
    if (filtersDropped.includes("subagency(requires agency)")) {
        notes.push("A subagency was requested without a parent agency and was NOT applied — pass `agency` (the toptier name) alongside `subagency`.");
    }
    const hasMore = scanTruncated ? true : startIdx + limit < totalCandidates;
    const truncated = hasMore || scanTruncated;
    return withMeta({
        candidates,
        cert,
        page,
        limit,
    }, {
        source: TEAMING_SOURCE,
        keylessMode: true,
        returned: candidates.length,
        // The distinct-recipient total is unknown when the scan truncated; even
        // when complete, the endpoint reports only an AWARD count (awardTotal),
        // not a distinct-recipient total, so recipient totalAvailable is null.
        totalAvailable: null,
        truncated,
        pagination: {
            offset: startIdx,
            limit,
            nextOffset: hasMore ? startIdx + limit : null,
            hasMore,
        },
        filtersApplied,
        filtersDropped,
        // UEI is not returned on the spending_by_award row (needs a recipient
        // profile lookup); the SBA cert of record needs a keyed SAM Entity call.
        fieldsUnavailable: [
            "uei(needs usas_get_recipient_profile)",
            "sbaCertificationOfRecord(needs keyed SAM Entity)",
        ],
        notes,
    });
}
//# sourceMappingURL=integrity.js.map