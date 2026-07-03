/**
 * USAspending v2 wrappers (keyless).
 *
 * Coverage map (every endpoint here is verified KEYLESS):
 *   Awards / Recipients
 *     - search/spending_by_category/recipient        → searchAwards
 *     - search/spending_by_award (subawards: false)  → searchIndividualAwards
 *     - search/spending_by_award (subawards: true)   → searchSubawards
 *     - search/spending_by_award (recipient filter)  → searchAwardsByRecipient
 *     - awards/{generated_internal_id}               → getAwardDetail
 *     - search/spending_by_award + awards/{id} pair  → searchExpiringContracts
 *   Aggregate analysis
 *     - search/spending_over_time                    → spendingOverTime
 *     - search/spending_by_category/psc              → searchPscSpending
 *     - search/spending_by_category/state_territory  → searchStateSpending
 *     - search/spending_by_category/cfda             → searchCfdaSpending
 *     - search/spending_by_category/federal_account  → searchFederalAccountSpending
 *     - search/spending_by_category/awarding_agency  → searchAgencySpending
 *     - search/spending_by_category/awarding_subagency → searchSubAgencySpending
 *   Agency profile
 *     - agency/{toptier_code}                        → getAgencyProfile
 *     - agency/{toptier_code}/awards                 → getAgencyAwardsSummary
 *     - agency/{toptier_code}/budget_function        → getAgencyBudgetFunction
 *   Recipient profile
 *     - recipient/ POST                              → searchRecipients
 *     - recipient/{id}                               → getRecipientProfile
 *   Reference / autocomplete (anti-hallucination)
 *     - autocomplete/funding_agency                  → lookupAgency
 *     - autocomplete/naics                           → autocompleteNaics
 *     - autocomplete/recipient                       → autocompleteRecipient
 *     - references/naics                             → naicsHierarchy
 *     - references/glossary                          → glossary
 *     - references/toptier_agencies                  → listToptierAgencies
 *
 * Total: 22 endpoints across the USAspending surface, all keyless.
 */
const USAS = "https://api.usaspending.gov/api/v2";
function buildFilters(args) {
    const filters = { award_type_codes: ["A", "B", "C", "D"] };
    if (args.agency) {
        filters.agencies = [
            { type: "awarding", tier: "toptier", name: args.agency },
        ];
    }
    if (args.naics)
        filters.naics_codes = [args.naics];
    if (args.fiscalYear) {
        filters.time_period = [
            {
                start_date: `${args.fiscalYear - 1}-10-01`,
                end_date: `${args.fiscalYear}-09-30`,
            },
        ];
    }
    if (args.setAside)
        filters.set_aside_type_codes = [args.setAside];
    if (args.pscCodes?.length)
        filters.psc_codes = args.pscCodes;
    return filters;
}
import { fetchWithRetry } from "./errors.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
const SPENDING_BY_AWARD_SOURCE = "usaspending.gov/api/v2 search/spending_by_award";
const SPENDING_BY_CATEGORY_RECIPIENT_SOURCE = "usaspending.gov/api/v2 search/spending_by_category/recipient";
/**
 * Build the `_meta` for a top-N `spending_by_category/*` aggregate. These
 * category endpoints report no grand total, so `totalAvailable` is always
 * `null` (honest "unknown" — never the returned count). Truncation is the
 * endpoint's own `hasNext` when present, else `returned >= limit`.
 */
function categoryAggregateMeta(opts) {
    const truncated = opts.hasNext ?? opts.returned >= opts.limit;
    const notes = [];
    if (truncated) {
        notes.push(`Capped at the top ${opts.limit} categories by amount; more categories may exist. This endpoint reports no grand total, so the true number of categories is unknown (totalAvailable is null, NOT the returned count) — page with a larger limit to see more.`);
    }
    if (opts.extraNotes)
        notes.push(...opts.extraNotes);
    return {
        source: opts.source,
        keylessMode: true,
        returned: opts.returned,
        // spec §3.3: the spending_by_category/* endpoints expose no total → null.
        totalAvailable: null,
        truncated,
        pagination: {
            offset: 0,
            limit: opts.limit,
            nextOffset: truncated ? opts.returned : null,
            hasMore: truncated,
        },
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: opts.fieldsUnavailable ?? [],
        notes,
    };
}
/**
 * Build the `_meta` for a reference / autocomplete tool. These are the
 * anti-hallucination lookups (NAICS/recipient autocomplete, NAICS hierarchy,
 * glossary, toptier agencies). Completeness rule (spec §2.3): a page that
 * came back SHORT of the requested `limit` is the whole result set
 * (`truncated:false`); a FULL page means more may exist (`truncated:true`).
 * When the endpoint reports a real total (glossary), pass it so truncation is
 * derived from `returned < total` instead. All are served from a 5-min TTL
 * cache (see cache.ts) — noted so the AI knows the data may be up to 5 min old.
 * [가설] we can't tell a cache HIT from a MISS here, so the note is
 * unconditional rather than hit-specific.
 */
function referenceMeta(opts) {
    const { source, returned, limit, totalAvailable } = opts;
    const limitHonored = opts.limitHonored ?? true;
    let truncated;
    let hasMore;
    if (totalAvailable !== null) {
        truncated = returned < totalAvailable;
        hasMore = truncated;
    }
    else if (!limitHonored) {
        // Endpoint ignores `limit` and returns the full set → complete.
        truncated = false;
        hasMore = false;
    }
    else {
        truncated = returned >= limit;
        hasMore = truncated;
    }
    const notes = [
        "Reference lookup served from a 5-minute TTL cache; values may be up to 5 minutes stale.",
    ];
    if (truncated) {
        notes.push(totalAvailable !== null
            ? `Showing ${returned} of ${totalAvailable} total; raise limit to see more.`
            : `A full page of ${returned} was returned; more matches may exist — raise limit to widen the result.`);
    }
    if (opts.extraNotes)
        notes.push(...opts.extraNotes);
    return {
        source,
        keylessMode: true,
        returned,
        totalAvailable,
        truncated,
        pagination: {
            offset: 0,
            limit,
            nextOffset: hasMore ? returned : null,
            hasMore,
        },
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    };
}
/**
 * True total for a `spending_by_award` query, via the companion
 * `spending_by_award_count` endpoint.
 *
 * WHY a companion query (not `page_metadata.total`): the `spending_by_award`
 * response uses cursor-style pagination — its `page_metadata` carries only
 * `page`/`hasNext`/`last_record_*`, NOT a `total` (empirically verified
 * 2026-07-03; the spec's assumption that it mirrors `recipient/`'s
 * `page_metadata.total` was wrong for this endpoint). The only honest source
 * of a real count is `spending_by_award_count`, which returns per-award-type
 * buckets; we sum them. Returns `null` on any failure — NEVER a page length
 * (spec §3.3: never substitute page size for an unknown total).
 */
async function awardCount(filters, mode) {
    try {
        const body = { filters };
        if (mode === "subawards")
            body.subawards = true;
        const json = await postUsas("search/spending_by_award_count/", body);
        const results = json.results;
        if (!results)
            return null;
        // Awards → contracts+idvs+direct_payments+grants+loans+other.
        // Subawards → subcontracts+subgrants. Sum every numeric bucket so we stay
        // correct if the endpoint adds categories.
        return Object.values(results).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
    }
    catch {
        return null;
    }
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
async function getUsas(endpoint) {
    const r = await fetchWithRetry(`${USAS}/${endpoint}`, { signal: AbortSignal.timeout(15_000) }, `usaspending:${endpoint}`);
    return (await r.json());
}
// ─── Aggregate share-of-wallet ───────────────────────────────────
export async function searchAwards(args) {
    const filters = buildFilters(args);
    const limit = 10;
    const json = await postUsas("search/spending_by_category/recipient", { filters, limit, page: 1 });
    const results = json.results ?? [];
    // B1 (spec §1.3, §3.4): the spending_by_category/recipient endpoint returns
    // `amount` but NOT a per-recipient award `count`. The old code defaulted the
    // missing count to 0, so every recipient reported `awards:0` and
    // `totalAwards:0` while `totalValue` was billions — a self-contradictory lie
    // ("0 contracts worth $3.45B"). Emit `null` (explicit "not available"), NOT
    // 0, and flag it in `_meta.fieldsUnavailable`. `amount`/`value` unchanged.
    const data = {
        totalAwards: null,
        totalValue: results.reduce((s, r) => s + (r.amount ?? 0), 0),
        topRecipients: results.map((r) => ({
            name: r.name ?? "—",
            value: r.amount ?? 0,
            awards: null,
        })),
    };
    return withMeta(data, {
        source: SPENDING_BY_CATEGORY_RECIPIENT_SOURCE,
        keylessMode: true,
        returned: results.length,
        // This is a landscape/top-N aggregate: the recipient tail is capped at
        // `limit` and the category endpoint reports no grand total → unknown.
        totalAvailable: null,
        truncated: results.length >= limit,
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: ["awards", "totalAwards"],
        notes: [
            "Per-recipient award COUNTS are not available from the spending_by_category/recipient endpoint (it returns obligated amount only) — `awards` and `totalAwards` are null, not 0. For a real contract count use usas_search_awards_by_recipient (its _meta.totalAvailable) or usas_get_recipient_profile.",
            "Only contract award types (A/B/C/D) are included; grants/IDVs are excluded from this share-of-wallet view.",
        ],
    });
}
// ─── Line-item awards ─────────────────────────────────────────────
export async function searchIndividualAwards(args) {
    const filters = buildFilters(args);
    const limit = args.limit ?? 10;
    // D1/D2 field-parity (spec §3.2): "NAICS" and the "Place of Performance …"
    // fields are valid `spending_by_award` field names (empirically verified
    // 2026-07-03 + confirmed against the API contract) and cost NO extra request
    // — USAspending returns whatever fields you ask for. Set-aside is NOT a
    // requestable field on this endpoint (filter-only) → documented as
    // detail-only in `_meta.fieldsUnavailable`.
    const [json, total] = await Promise.all([
        postUsas("search/spending_by_award", {
            filters,
            fields: [
                "Award ID",
                "Recipient Name",
                "Award Amount",
                "Awarding Agency",
                "Awarding Sub Agency",
                "NAICS",
                "Place of Performance State Code",
                "Place of Performance City Code",
                "Place of Performance Country Code",
                "Place of Performance Zip5",
                "Description",
            ],
            limit,
            page: 1,
            subawards: false,
        }),
        awardCount(filters, "awards"),
    ]);
    const results = json.results ?? [];
    const data = {
        awards: results.map((r) => ({
            awardId: r["Award ID"] ?? "",
            recipient: r["Recipient Name"] ?? "",
            amount: r["Award Amount"] ?? 0,
            awardingAgency: r["Awarding Agency"] ?? "",
            awardingSubAgency: r["Awarding Sub Agency"],
            // D1: NAICS now returned (parity with usas_search_awards_by_recipient).
            naicsCode: r.NAICS?.code,
            naicsDescription: r.NAICS?.description,
            placeOfPerformanceState: r["Place of Performance State Code"],
            placeOfPerformanceCity: r["Place of Performance City Code"],
            placeOfPerformanceCountry: r["Place of Performance Country Code"],
            placeOfPerformanceZip: r["Place of Performance Zip5"],
            description: r.Description,
            generatedInternalId: r.generated_internal_id ?? "",
        })),
    };
    return withMeta(data, {
        source: SPENDING_BY_AWARD_SOURCE,
        keylessMode: true,
        returned: results.length,
        totalAvailable: total,
        pagination: awardPagination(0, limit, results.length, total, json.page_metadata?.hasNext ?? false),
        filtersApplied: [],
        filtersDropped: [],
        // Set-aside is not a `spending_by_award` output field; PoP city is often a
        // numeric code (or null) rather than a name. Both live in detail.
        fieldsUnavailable: ["setAside", "setAsideDescription"],
        notes: [
            "Set-aside type is NOT available from the spending_by_award search endpoint (it can only be FILTERED, not returned) — call usas_get_award_detail (setAsideType/setAsideDescription) per award via generatedInternalId.",
        ],
    });
}
/** hasMore for cursor-paginated award search: prefer the real total. */
function awardPagination(offset, limit, returned, total, upstreamHasNext) {
    const hasMore = total !== null ? offset + returned < total : upstreamHasNext;
    return {
        offset,
        limit,
        nextOffset: hasMore ? offset + returned : null,
        hasMore,
    };
}
// ─── Recipient win history ────────────────────────────────────────
export async function searchAwardsByRecipient(args) {
    const filters = buildFilters(args);
    filters.recipient_search_text = [args.recipientName];
    const limit = args.limit ?? 15;
    const [json, total] = await Promise.all([
        postUsas("search/spending_by_award", {
            filters,
            fields: [
                "Award ID",
                "Recipient Name",
                "Award Amount",
                "Awarding Agency",
                "Awarding Sub Agency",
                "NAICS",
                "Place of Performance State Code",
                "Place of Performance City Code",
                "Place of Performance Country Code",
                "Place of Performance Zip5",
                "Description",
            ],
            limit,
            page: 1,
            subawards: false,
        }),
        awardCount(filters, "awards"),
    ]);
    const results = json.results ?? [];
    const data = {
        awards: results.map((r) => ({
            awardId: r["Award ID"] ?? "",
            recipient: r["Recipient Name"] ?? "",
            amount: r["Award Amount"] ?? 0,
            awardingAgency: r["Awarding Agency"] ?? "",
            awardingSubAgency: r["Awarding Sub Agency"],
            naicsCode: r.NAICS?.code,
            naicsDescription: r.NAICS?.description,
            placeOfPerformanceState: r["Place of Performance State Code"],
            placeOfPerformanceCity: r["Place of Performance City Code"],
            placeOfPerformanceCountry: r["Place of Performance Country Code"],
            placeOfPerformanceZip: r["Place of Performance Zip5"],
            description: r.Description,
            generatedInternalId: r.generated_internal_id ?? "",
        })),
        // C5 (spec §1.4, §3.3): the OLD value was `results.length` — the PAGE SIZE,
        // not the true count. A recipient with 400 awards but a 15-row page
        // reported `totalRecords:15` (an order-of-magnitude lie). Now the REAL
        // upstream total (via spending_by_award_count), or null if that companion
        // query failed — never the page length.
        totalRecords: total,
    };
    return withMeta(data, {
        source: SPENDING_BY_AWARD_SOURCE,
        keylessMode: true,
        returned: results.length,
        totalAvailable: total,
        pagination: awardPagination(0, limit, results.length, total, json.page_metadata?.hasNext ?? false),
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: ["setAside", "setAsideDescription"],
        notes: [
            "Set-aside type is NOT available from the spending_by_award search endpoint (filter-only) — call usas_get_award_detail per award for setAsideType/setAsideDescription.",
        ],
    });
}
// ─── Subaward enumeration ─────────────────────────────────────────
export async function searchSubawards(args) {
    const filters = buildFilters(args);
    if (args.primeRecipientName) {
        filters.recipient_search_text = [args.primeRecipientName];
    }
    const limit = args.limit ?? 15;
    // A3 (spec §1.2, §3.2): the OLD code requested "Sub-Award NAICS", which is
    // NOT a valid field name on this endpoint — `spending_by_award` echoes an
    // unknown field back as `null` (verified 2026-07-03), so the arg looked
    // honored but silently returned nothing. The valid field for subaward NAICS
    // is "NAICS" (returns {code,description} — the PRIME award's NAICS, which is
    // what USAspending exposes on subaward rows). Swap to it and map it.
    const [json, total] = await Promise.all([
        postUsas("search/spending_by_award", {
            filters,
            fields: [
                "Sub-Award ID",
                "Sub-Award Recipient",
                "Sub-Award Amount",
                "Sub-Award Date",
                "NAICS",
            ],
            limit,
            page: 1,
            subawards: true,
        }),
        awardCount(filters, "subawards"),
    ]);
    const results = json.results ?? [];
    const data = {
        subawards: results.map((r) => ({
            subAwardId: r["Sub-Award ID"] ?? "",
            subRecipient: r["Sub-Award Recipient"] ?? "(name redacted)",
            amount: r["Sub-Award Amount"] ?? 0,
            actionDate: r["Sub-Award Date"] ?? "",
            // A3: prime-award NAICS on the subaward row (the only NAICS the endpoint
            // exposes for subawards). null when the row genuinely lacks it.
            naicsCode: r.NAICS?.code,
            naicsDescription: r.NAICS?.description,
            primeAwardId: r.prime_award_generated_internal_id ?? "",
        })),
    };
    return withMeta(data, {
        source: SPENDING_BY_AWARD_SOURCE,
        keylessMode: true,
        returned: results.length,
        totalAvailable: total,
        pagination: awardPagination(0, limit, results.length, total, json.page_metadata?.hasNext ?? false),
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes: [
            "The `naicsCode`/`naicsDescription` on each subaward is the PRIME award's NAICS (USAspending does not expose a distinct sub-award NAICS on this endpoint). A subaward-specific NAICS is not available keyless.",
        ],
    });
}
// ─── Per-award detail ─────────────────────────────────────────────
export async function getAwardDetail(generatedInternalId) {
    try {
        const r = await fetch(`${USAS}/awards/${encodeURIComponent(generatedInternalId)}/`, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok)
            return null;
        const json = (await r.json());
        const ltc = json.latest_transaction_contract_data ?? {};
        return {
            awardId: json.piid ?? "",
            recipient: json.recipient?.recipient_name ?? "",
            totalObligation: json.total_obligation ?? 0,
            baseAndAllOptions: json.base_and_all_options ?? 0,
            periodOfPerformance: {
                startDate: json.period_of_performance?.start_date ?? null,
                endDate: json.period_of_performance?.end_date ?? null,
                potentialEndDate: json.period_of_performance?.potential_end_date ?? null,
            },
            description: json.description ?? "",
            setAsideType: ltc.type_set_aside,
            setAsideDescription: ltc.type_set_aside_description,
            competitionExtent: ltc.extent_competed,
            numberOfOffers: ltc.number_of_offers_received,
            awardingAgency: json.awarding_agency?.toptier_agency?.name,
            awardingSubAgency: json.awarding_agency?.subtier_agency?.name,
            naicsCode: ltc.naics,
            naicsDescription: ltc.naics_description,
        };
    }
    catch {
        return null;
    }
}
// ─── Recompete radar ──────────────────────────────────────────────
export async function searchExpiringContracts(args) {
    const filters = buildFilters(args);
    const search = await postUsas("search/spending_by_award", {
        filters,
        fields: ["Award ID", "Recipient Name", "Award Amount"],
        limit: 50,
        page: 1,
        subawards: false,
        sort: "Award Amount",
        order: "desc",
    });
    const candidates = (search.results ?? []).filter((r) => (r["Award Amount"] ?? 0) >= (args.minAwardValue ?? 100_000) &&
        r.generated_internal_id);
    // Enrich up to 8 in parallel — be polite to USAspending.
    const enrich = candidates.slice(0, 8);
    const details = await Promise.all(enrich.map((r) => getAwardDetail(r.generated_internal_id)));
    const now = Date.now();
    const cutoffDays = (args.monthsUntilExpiry ?? 12) * 30;
    const contracts = details
        .map((d, idx) => {
        if (!d || !d.periodOfPerformance.endDate)
            return null;
        const end = new Date(d.periodOfPerformance.endDate).getTime();
        if (Number.isNaN(end))
            return null;
        const days = Math.ceil((end - now) / (24 * 60 * 60 * 1000));
        if (days < -30 || days > cutoffDays)
            return null;
        const orig = enrich[idx] ?? {};
        return {
            awardId: d.awardId || orig["Award ID"] || "",
            recipient: d.recipient || orig["Recipient Name"] || "",
            amount: d.totalObligation || orig["Award Amount"] || 0,
            endDate: d.periodOfPerformance.endDate,
            potentialEndDate: d.periodOfPerformance.potentialEndDate,
            awardingAgency: d.awardingAgency ?? "",
            awardingSubAgency: d.awardingSubAgency,
            naicsCode: d.naicsCode,
            setAsideDescription: d.setAsideDescription,
            description: d.description,
            daysUntilExpiry: days,
        };
    })
        .filter((x) => x !== null)
        .slice(0, args.limit ?? 10)
        .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
    return { contracts, searchedCount: candidates.length };
}
// ─── Aggregate analysis: time series ──────────────────────────────
export async function spendingOverTime(args) {
    const filters = buildFilters(args);
    const json = await postUsas("search/spending_over_time/", {
        group: args.group ?? "fiscal_year",
        filters,
    });
    return {
        group: json.group,
        timeline: (json.results ?? []).map((r) => ({
            timePeriod: r.time_period ?? {},
            total: r.aggregated_amount ?? 0,
            contractObligations: r.Contract_Obligations ?? 0,
            grantObligations: r.Grant_Obligations ?? 0,
            idvObligations: r.Idv_Obligations ?? 0,
        })),
    };
}
// ─── Aggregate analysis: PSC spending ─────────────────────────────
export async function searchPscSpending(args) {
    const filters = buildFilters(args);
    const limit = args.limit ?? 10;
    const json = await postUsas("search/spending_by_category/psc", { filters, limit, page: 1 });
    const results = json.results ?? [];
    const data = {
        psc: results.map((r) => ({
            pscCode: r.code ?? "",
            pscName: r.name ?? "",
            amount: r.amount ?? 0,
        })),
    };
    return withMeta(data, categoryAggregateMeta({
        source: "usaspending.gov/api/v2 search/spending_by_category/psc",
        returned: results.length,
        limit,
        hasNext: json.page_metadata?.hasNext,
    }));
}
// ─── Aggregate analysis: state / territory ─────────────────────────
export async function searchStateSpending(args) {
    const filters = buildFilters(args);
    const limit = args.limit ?? 10;
    const json = await postUsas("search/spending_by_category/state_territory", { filters, limit, page: 1 });
    const results = json.results ?? [];
    const data = {
        states: results.map((r) => ({
            stateCode: r.code ?? "",
            stateName: r.name ?? "",
            amount: r.amount ?? 0,
        })),
    };
    return withMeta(data, categoryAggregateMeta({
        source: "usaspending.gov/api/v2 search/spending_by_category/state_territory",
        returned: results.length,
        limit,
        hasNext: json.page_metadata?.hasNext,
        extraNotes: [
            "There are ~59 U.S. states/territories total; a capped result is a top-N by amount, not all places that received funding.",
        ],
    }));
}
// ─── Aggregate analysis: CFDA (grants) ─────────────────────────────
export async function searchCfdaSpending(args) {
    // CFDA is grants — different award_type_codes
    const filters = {
        award_type_codes: ["02", "03", "04", "05"], // grants
    };
    if (args.agency) {
        filters.agencies = [
            { type: "awarding", tier: "toptier", name: args.agency },
        ];
    }
    if (args.fiscalYear) {
        filters.time_period = [
            {
                start_date: `${args.fiscalYear - 1}-10-01`,
                end_date: `${args.fiscalYear}-09-30`,
            },
        ];
    }
    const limit = args.limit ?? 10;
    const json = await postUsas("search/spending_by_category/cfda", { filters, limit, page: 1 });
    const results = json.results ?? [];
    const data = {
        programs: results.map((r) => ({
            cfdaCode: r.code ?? "",
            programName: r.name ?? "",
            amount: r.amount ?? 0,
        })),
    };
    return withMeta(data, categoryAggregateMeta({
        source: "usaspending.gov/api/v2 search/spending_by_category/cfda",
        returned: results.length,
        limit,
        hasNext: json.page_metadata?.hasNext,
        extraNotes: [
            "This is a grants view (award types 02/03/04/05); contracts are excluded.",
        ],
    }));
}
// ─── Aggregate analysis: federal account (TAS) ─────────────────────
export async function searchFederalAccountSpending(args) {
    const filters = buildFilters(args);
    const limit = args.limit ?? 10;
    const json = await postUsas("search/spending_by_category/federal_account", { filters, limit, page: 1 });
    const results = json.results ?? [];
    const data = {
        accounts: results.map((r) => ({
            tasCode: r.code ?? "",
            accountName: r.name ?? "",
            amount: r.amount ?? 0,
        })),
    };
    return withMeta(data, categoryAggregateMeta({
        source: "usaspending.gov/api/v2 search/spending_by_category/federal_account",
        returned: results.length,
        limit,
        hasNext: json.page_metadata?.hasNext,
    }));
}
// ─── Aggregate analysis: awarding agency ──────────────────────────
export async function searchAgencySpending(args) {
    const filters = buildFilters(args);
    const limit = args.limit ?? 10;
    const json = await postUsas("search/spending_by_category/awarding_agency", { filters, limit, page: 1 });
    const results = json.results ?? [];
    const data = {
        agencies: results.map((r) => ({
            name: r.name ?? "",
            code: r.code ?? "",
            slug: r.agency_slug ?? "",
            amount: r.amount ?? 0,
        })),
    };
    return withMeta(data, categoryAggregateMeta({
        source: "usaspending.gov/api/v2 search/spending_by_category/awarding_agency",
        returned: results.length,
        limit,
        hasNext: json.page_metadata?.hasNext,
    }));
}
// ─── Sub-agency breakdown ─────────────────────────────────────────
export async function searchSubAgencySpending(args) {
    const filters = buildFilters(args);
    const limit = 10;
    const json = await postUsas("search/spending_by_category/awarding_subagency", { filters, limit, page: 1 });
    const results = json.results ?? [];
    // NOTE: the awarding_subagency endpoint returns `amount` but NOT a per-
    // subagency award `count` (verified 2026-07-03), so `awards` here is always
    // the defaulted 0 — a fabricated count, same class as B1. `data` is kept
    // byte-identical this PR (value-semantics fix deferred); the lie is flagged
    // in `_meta.fieldsUnavailable` + a note so the AI won't report "0 awards".
    const data = {
        subAgencies: results.map((r) => ({
            name: r.name ?? "",
            amount: r.amount ?? 0,
            awards: r.count ?? 0,
        })),
    };
    return withMeta(data, categoryAggregateMeta({
        source: "usaspending.gov/api/v2 search/spending_by_category/awarding_subagency",
        returned: results.length,
        limit,
        hasNext: json.page_metadata?.hasNext,
        fieldsUnavailable: ["awards"],
        extraNotes: [
            "Per-subagency award COUNTS are not returned by this endpoint — the `awards` field is 0 for every row (a placeholder, not a real count). Use amount for ranking; do not report `awards` as a contract count.",
        ],
    }));
}
// ─── Agency profile ───────────────────────────────────────────────
export async function getAgencyProfile(toptierCode) {
    const json = await getUsas(`agency/${toptierCode}/`);
    return {
        fiscalYear: json.fiscal_year,
        toptierCode: json.toptier_code,
        name: json.name,
        abbreviation: json.abbreviation,
        mission: json.mission,
        website: json.website,
        subtierAgencyCount: json.subtier_agency_count,
        congressionalJustificationUrl: json.congressional_justification_url,
    };
}
export async function getAgencyAwardsSummary(args) {
    const fy = args.fiscalYear ?? new Date().getUTCFullYear();
    const json = await getUsas(`agency/${args.toptierCode}/awards/?fiscal_year=${fy}`);
    return {
        fiscalYear: json.fiscal_year,
        toptierCode: json.toptier_code,
        transactionCount: json.transaction_count ?? 0,
        obligations: json.obligations ?? 0,
        latestActionDate: json.latest_action_date,
    };
}
export async function getAgencyBudgetFunction(args) {
    const fy = args.fiscalYear ?? new Date().getUTCFullYear();
    const limit = args.limit ?? 10;
    const json = await getUsas(`agency/${args.toptierCode}/budget_function/?fiscal_year=${fy}&limit=${limit}`);
    const results = json.results ?? [];
    const total = json.page_metadata?.total ?? null;
    const data = {
        toptierCode: json.toptier_code,
        fiscalYear: json.fiscal_year,
        functions: results.map((r) => ({
            name: r.name ?? "",
            programs: (r.children ?? []).map((c) => ({
                name: c.name ?? "",
                obligated: c.obligated_amount ?? 0,
                outlays: c.gross_outlay_amount ?? 0,
            })),
        })),
    };
    const hasMore = total !== null ? results.length < total : (json.page_metadata?.hasNext ?? false);
    return withMeta(data, {
        source: "usaspending.gov/api/v2 agency/{code}/budget_function",
        keylessMode: true,
        returned: results.length,
        // Real total from the endpoint (budget-function count for the FY).
        totalAvailable: total,
        truncated: hasMore,
        pagination: {
            offset: 0,
            limit,
            nextOffset: hasMore ? results.length : null,
            hasMore,
        },
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes: hasMore
            ? [
                `Showing the top ${limit} budget functions; ${total ?? "more"} exist for FY${fy}. Raise limit to see the rest.`,
            ]
            : [],
    });
}
// ─── Recipient list + profile ─────────────────────────────────────
export async function searchRecipients(args) {
    const limit = args.limit ?? 10;
    const body = {
        keyword: args.keyword,
        limit,
        page: 1,
    };
    if (args.recipientLevel) {
        body.recipient_level = args.recipientLevel;
    }
    const json = await postUsas("recipient/", body);
    const results = json.results ?? [];
    // recipient/ DOES report a real grand total in page_metadata.total
    // (verified 2026-07-03: "booz" → total:512). Keep it in _meta.totalAvailable
    // and derive truncation from returned < total. null (not 0) when absent so
    // we never claim a total the endpoint didn't give.
    const total = json.page_metadata?.total ?? null;
    const data = {
        totalRecords: json.page_metadata?.total ?? 0,
        recipients: results.map((r) => ({
            id: r.id ?? "",
            duns: r.duns,
            uei: r.uei,
            name: r.name ?? "",
            level: r.recipient_level,
            totalAmount: r.amount ?? 0,
        })),
    };
    const hasMore = total !== null ? results.length < total : results.length >= limit;
    return withMeta(data, {
        source: "usaspending.gov/api/v2 recipient/",
        keylessMode: true,
        returned: results.length,
        totalAvailable: total,
        truncated: hasMore,
        pagination: {
            offset: 0,
            limit,
            nextOffset: hasMore ? results.length : null,
            hasMore,
        },
        filtersApplied: [],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes: hasMore
            ? [
                `Showing the top ${limit} recipients by amount; ${total ?? "more"} match the keyword. Raise limit or page to see more.`,
            ]
            : [],
    });
}
export async function getRecipientProfile(recipientId) {
    const json = await getUsas(`recipient/${encodeURIComponent(recipientId)}/`);
    return {
        name: json.name ?? "",
        alternateNames: json.alternate_names ?? [],
        duns: json.duns,
        uei: json.uei,
        recipientId: json.recipient_id,
        level: json.recipient_level,
        parentId: json.parent_id,
        parentName: json.parent_name,
        businessTypes: json.business_types ?? [],
        location: json.location ?? {},
        totalAmount: json.total_transaction_amount ?? 0,
        totalTransactions: json.total_transactions ?? 0,
    };
}
// ─── Reference / autocomplete ─────────────────────────────────────
export async function lookupAgency(searchText) {
    // Cache: agency lookups are extremely repeat-prone (`VA`, `DHS`, etc.)
    // and effectively static across a session.
    return memoize(`usas:agency:${searchText.toLowerCase()}`, async () => {
        try {
            const r = await fetch(`${USAS}/autocomplete/funding_agency/`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ search_text: searchText, limit: 5 }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!r.ok)
                return { matches: [] };
            const json = (await r.json());
            return {
                matches: (json.results ?? []).map((r) => ({
                    name: r.toptier_agency?.name ?? "",
                    abbreviation: r.toptier_agency?.abbreviation,
                    toptierCode: r.toptier_agency?.toptier_code,
                    isToptier: !!r.toptier_flag,
                })),
            };
        }
        catch {
            return { matches: [] };
        }
    });
}
export async function autocompleteNaics(args) {
    const limit = args.limit ?? 10;
    return memoize(`usas:naics:${args.searchText.toLowerCase()}:${limit}`, async () => {
        const json = await postUsas("autocomplete/naics/", {
            search_text: args.searchText,
            limit,
        });
        const results = json.results ?? [];
        const data = {
            naics: results.map((r) => ({
                code: r.naics ?? "",
                description: r.naics_description ?? "",
                retired: !!r.year_retired,
            })),
        };
        return withMeta(data, referenceMeta({
            source: "usaspending.gov/api/v2 autocomplete/naics",
            returned: results.length,
            limit,
            // autocomplete/naics returns only {results} — no total (verified
            // 2026-07-03). A full page means more matches likely exist.
            totalAvailable: null,
        }));
    });
}
export async function autocompleteRecipient(args) {
    const limit = args.limit ?? 10;
    return memoize(`usas:recipient:${args.searchText.toLowerCase()}:${limit}`, async () => {
        const json = await postUsas("autocomplete/recipient/", {
            search_text: args.searchText,
            limit,
        });
        const results = json.results ?? [];
        const data = {
            recipients: results.map((r) => ({
                name: r.recipient_name ?? "",
                uei: r.uei,
                duns: r.duns,
            })),
        };
        return withMeta(data, referenceMeta({
            source: "usaspending.gov/api/v2 autocomplete/recipient",
            returned: results.length,
            limit,
            totalAvailable: null,
        }));
    });
}
export async function naicsHierarchy(args) {
    return memoize(`usas:naics-hierarchy:${args.naicsFilter ?? ""}`, async () => {
        const path = args.naicsFilter
            ? `references/naics/?filter=${encodeURIComponent(args.naicsFilter)}`
            : "references/naics/";
        const json = await getUsas(path);
        const results = json.results ?? [];
        const data = {
            hierarchy: results.map((r) => ({
                code: r.naics ?? "",
                description: r.naics_description ?? "",
                count: r.count ?? 0,
                hasChildren: !!(r.children && r.children.length > 0),
            })),
        };
        // references/naics has NO limit param and NO total (verified 2026-07-03:
        // returns the full level — 24 sectors unfiltered, or the filter's matches).
        // So this response IS complete for the requested level; nodes with
        // hasChildren can be expanded by passing that code as naicsFilter.
        return withMeta(data, referenceMeta({
            source: "usaspending.gov/api/v2 references/naics",
            returned: results.length,
            limit: results.length, // no limit param → returned count is the whole set
            totalAvailable: results.length,
            limitHonored: false,
            extraNotes: [
                "This is the NAICS hierarchy level for the requested filter (complete); drill into a node by calling again with its code as naicsFilter.",
            ],
        }));
    });
}
export async function glossary(args) {
    const limit = args.limit ?? 25;
    return memoize(`usas:glossary:${args.search ?? ""}:${limit}`, async () => {
        const params = new URLSearchParams();
        params.set("limit", String(limit));
        if (args.search)
            params.set("search", args.search);
        const json = await getUsas(`references/glossary/?${params.toString()}`);
        const results = json.results ?? [];
        const total = json.page_metadata?.count ?? null;
        const data = {
            totalRecords: json.page_metadata?.count ?? 0,
            terms: results.map((r) => ({
                term: r.term ?? "",
                slug: r.slug ?? "",
                definition: r.plain ?? "",
            })),
        };
        return withMeta(data, referenceMeta({
            source: "usaspending.gov/api/v2 references/glossary",
            returned: results.length,
            limit,
            totalAvailable: total,
        }));
    });
}
export async function listToptierAgencies(args) {
    const limit = args.limit ?? 50;
    return memoize(`usas:toptier:${limit}`, async () => {
        const json = await getUsas(`references/toptier_agencies/?limit=${limit}`);
        const results = json.results ?? [];
        const data = {
            agencies: results.map((r) => ({
                name: r.agency_name ?? "",
                abbreviation: r.abbreviation,
                toptierCode: r.toptier_code,
                slug: r.agency_slug,
                activeFiscalYear: r.active_fy,
                obligatedAmount: r.obligated_amount ?? 0,
            })),
        };
        // IMPORTANT: this endpoint IGNORES the `limit` param (verified 2026-07-03:
        // limit=3 AND limit=1000 both return all 111 toptier agencies). So the
        // response is ALWAYS the complete set — truncated:false, and the returned
        // count IS the total. Deriving truncation from `returned >= limit` would be
        // a false positive, so limitHonored:false forces complete.
        return withMeta(data, referenceMeta({
            source: "usaspending.gov/api/v2 references/toptier_agencies",
            returned: results.length,
            limit,
            totalAvailable: results.length,
            limitHonored: false,
            extraNotes: [
                "The toptier_agencies endpoint returns the COMPLETE list of ~111 toptier agencies regardless of the `limit` value (limit is ignored upstream).",
            ],
        }));
    });
}
//# sourceMappingURL=usaspending.js.map