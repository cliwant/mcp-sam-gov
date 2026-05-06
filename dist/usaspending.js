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
    const json = await postUsas("search/spending_by_category/recipient", { filters, limit: 10, page: 1 });
    const results = json.results ?? [];
    return {
        totalAwards: results.reduce((s, r) => s + (r.count ?? 0), 0),
        totalValue: results.reduce((s, r) => s + (r.amount ?? 0), 0),
        topRecipients: results.map((r) => ({
            name: r.name ?? "—",
            value: r.amount ?? 0,
            awards: r.count ?? 0,
        })),
    };
}
// ─── Line-item awards ─────────────────────────────────────────────
export async function searchIndividualAwards(args) {
    const filters = buildFilters(args);
    const json = await postUsas("search/spending_by_award", {
        filters,
        fields: [
            "Award ID",
            "Recipient Name",
            "Award Amount",
            "Awarding Agency",
            "Awarding Sub Agency",
            "Place of Performance State Code",
            "Description",
        ],
        limit: args.limit ?? 10,
        page: 1,
        subawards: false,
    });
    return {
        awards: (json.results ?? []).map((r) => ({
            awardId: r["Award ID"] ?? "",
            recipient: r["Recipient Name"] ?? "",
            amount: r["Award Amount"] ?? 0,
            awardingAgency: r["Awarding Agency"] ?? "",
            awardingSubAgency: r["Awarding Sub Agency"],
            placeOfPerformanceState: r["Place of Performance State Code"],
            description: r.Description,
            generatedInternalId: r.generated_internal_id ?? "",
        })),
    };
}
// ─── Recipient win history ────────────────────────────────────────
export async function searchAwardsByRecipient(args) {
    const filters = buildFilters(args);
    filters.recipient_search_text = [args.recipientName];
    const json = await postUsas("search/spending_by_award", {
        filters,
        fields: [
            "Award ID",
            "Recipient Name",
            "Award Amount",
            "Awarding Agency",
            "Awarding Sub Agency",
            "NAICS",
            "Description",
        ],
        limit: args.limit ?? 15,
        page: 1,
        subawards: false,
    });
    const results = json.results ?? [];
    return {
        awards: results.map((r) => ({
            awardId: r["Award ID"] ?? "",
            recipient: r["Recipient Name"] ?? "",
            amount: r["Award Amount"] ?? 0,
            awardingAgency: r["Awarding Agency"] ?? "",
            awardingSubAgency: r["Awarding Sub Agency"],
            naicsCode: r.NAICS?.code,
            naicsDescription: r.NAICS?.description,
            description: r.Description,
            generatedInternalId: r.generated_internal_id ?? "",
        })),
        totalRecords: results.length,
    };
}
// ─── Subaward enumeration ─────────────────────────────────────────
export async function searchSubawards(args) {
    const filters = buildFilters(args);
    if (args.primeRecipientName) {
        filters.recipient_search_text = [args.primeRecipientName];
    }
    const json = await postUsas("search/spending_by_award", {
        filters,
        fields: [
            "Sub-Award ID",
            "Sub-Award Recipient",
            "Sub-Award Amount",
            "Sub-Award Date",
            "Sub-Award NAICS",
        ],
        limit: args.limit ?? 15,
        page: 1,
        subawards: true,
    });
    return {
        subawards: (json.results ?? []).map((r) => ({
            subAwardId: r["Sub-Award ID"] ?? "",
            subRecipient: r["Sub-Award Recipient"] ?? "(name redacted)",
            amount: r["Sub-Award Amount"] ?? 0,
            actionDate: r["Sub-Award Date"] ?? "",
            primeAwardId: r.prime_award_generated_internal_id ?? "",
        })),
    };
}
/**
 * Aggregate sub-awards by sub-recipient. Returns top N sub-recipients
 * across the filter slice, with each sub-recipient's total sub-award
 * amount + count + distinct prime count.
 *
 * Use cases:
 *   - "Top subs to Booz Allen FY2025" → pass primeRecipientName
 *   - "Top subs in NAICS 541512 FY2025" → pass naics
 *   - "Top subs in NAICS 541512 at VA FY2025" → pass naics + agency
 *
 * Implementation: fetches up to 100 line-item subawards (USAspending
 * doesn't have a server-side aggregation endpoint for sub-awards),
 * then aggregates client-side by `Sub-Award Recipient` name.
 *
 * Coverage caveat (FFATA): sub-award reporting is self-reported by
 * primes quarterly. Top primes typically report ~80% of subs;
 * mid-tier primes have notable gaps. Aggregates surface relative
 * patterns, not exhaustive totals.
 */
export async function aggregateSubawards(args) {
    const filters = buildFilters(args);
    if (args.primeRecipientName) {
        filters.recipient_search_text = [args.primeRecipientName];
    }
    const json = await postUsas("search/spending_by_award", {
        filters,
        fields: [
            "Sub-Award Recipient",
            "Sub-Award Amount",
            "Sub-Award Date",
        ],
        limit: 100,
        page: 1,
        subawards: true,
    });
    // Aggregate client-side
    const agg = new Map();
    for (const r of json.results ?? []) {
        const name = r["Sub-Award Recipient"] ?? "(name redacted)";
        const amount = r["Sub-Award Amount"] ?? 0;
        const primeId = r.prime_award_generated_internal_id ?? "";
        const existing = agg.get(name);
        if (existing) {
            existing.totalAmount += amount;
            existing.subAwardCount += 1;
            if (primeId)
                existing.primeAwardIds.add(primeId);
        }
        else {
            agg.set(name, {
                name,
                totalAmount: amount,
                subAwardCount: 1,
                primeAwardIds: new Set(primeId ? [primeId] : []),
            });
        }
    }
    const sorted = Array.from(agg.values())
        .map((x) => ({
        subRecipient: x.name,
        totalAmount: x.totalAmount,
        subAwardCount: x.subAwardCount,
        distinctPrimeAwards: x.primeAwardIds.size,
    }))
        .sort((a, b) => b.totalAmount - a.totalAmount)
        .slice(0, args.limit ?? 20);
    return {
        aggregateBy: "sub_recipient",
        coverageWindow: "first 100 sub-awards matching filter; aggregates relative ranking, not exhaustive totals",
        sampleSize: (json.results ?? []).length,
        sub_recipients: sorted,
    };
}
/**
 * Sub-recipient profile: given a firm name, return their federal
 * sub-contracting footprint — distinct primes that used them,
 * total sub-revenue, NAICS distribution, FY context.
 *
 * Use case: "What's IBM's federal sub-tier presence in FY2025?"
 *
 * Implementation: searches sub-awards where Sub-Award Recipient
 * matches, aggregates client-side by prime.
 */
export async function getSubRecipientProfile(args) {
    const filters = buildFilters({
        agency: args.agency,
        fiscalYear: args.fiscalYear,
    });
    // We can't filter by sub-recipient name server-side; pull a wider
    // sample then filter client-side.
    filters.recipient_search_text = [args.subRecipientName];
    const json = await postUsas("search/spending_by_award", {
        filters,
        fields: [
            "Sub-Award Recipient",
            "Sub-Award Amount",
            "Sub-Award Date",
            "Recipient Name",
            "Awarding Agency",
        ],
        limit: 100,
        page: 1,
        subawards: true,
    });
    const target = args.subRecipientName.toLowerCase();
    const matched = (json.results ?? []).filter((r) => (r["Sub-Award Recipient"] ?? "").toLowerCase().includes(target));
    const primesAgg = new Map();
    let totalSubAmount = 0;
    for (const r of matched) {
        const primeName = r["Recipient Name"] ?? "(unknown prime)";
        const amount = r["Sub-Award Amount"] ?? 0;
        const primeId = r.prime_award_generated_internal_id ?? "";
        totalSubAmount += amount;
        const existing = primesAgg.get(primeName);
        if (existing) {
            existing.totalSubAmount += amount;
            existing.subAwardCount += 1;
            if (primeId)
                existing.primeAwardIds.add(primeId);
        }
        else {
            primesAgg.set(primeName, {
                primeName,
                totalSubAmount: amount,
                subAwardCount: 1,
                primeAwardIds: new Set(primeId ? [primeId] : []),
            });
        }
    }
    const primesSorted = Array.from(primesAgg.values())
        .map((x) => ({
        primeName: x.primeName,
        totalSubAmount: x.totalSubAmount,
        subAwardCount: x.subAwardCount,
        distinctPrimeAwards: x.primeAwardIds.size,
    }))
        .sort((a, b) => b.totalSubAmount - a.totalSubAmount)
        .slice(0, args.limit ?? 15);
    return {
        subRecipient: args.subRecipientName,
        fiscalYear: args.fiscalYear,
        sampleSize: matched.length,
        coverageCaveat: "Based on first 100 sub-awards matching the recipient search text. FFATA reporting is self-reported quarterly by primes; coverage is uneven (top primes ~80%, mid-tier ~40%).",
        totalSubAmount,
        distinctPrimes: primesAgg.size,
        primes: primesSorted,
    };
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
    const json = await postUsas("search/spending_by_category/psc", { filters, limit: args.limit ?? 10, page: 1 });
    return {
        psc: (json.results ?? []).map((r) => ({
            pscCode: r.code ?? "",
            pscName: r.name ?? "",
            amount: r.amount ?? 0,
        })),
    };
}
// ─── Aggregate analysis: state / territory ─────────────────────────
export async function searchStateSpending(args) {
    const filters = buildFilters(args);
    const json = await postUsas("search/spending_by_category/state_territory", { filters, limit: args.limit ?? 10, page: 1 });
    return {
        states: (json.results ?? []).map((r) => ({
            stateCode: r.code ?? "",
            stateName: r.name ?? "",
            amount: r.amount ?? 0,
        })),
    };
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
    const json = await postUsas("search/spending_by_category/cfda", { filters, limit: args.limit ?? 10, page: 1 });
    return {
        programs: (json.results ?? []).map((r) => ({
            cfdaCode: r.code ?? "",
            programName: r.name ?? "",
            amount: r.amount ?? 0,
        })),
    };
}
// ─── Aggregate analysis: federal account (TAS) ─────────────────────
export async function searchFederalAccountSpending(args) {
    const filters = buildFilters(args);
    const json = await postUsas("search/spending_by_category/federal_account", { filters, limit: args.limit ?? 10, page: 1 });
    return {
        accounts: (json.results ?? []).map((r) => ({
            tasCode: r.code ?? "",
            accountName: r.name ?? "",
            amount: r.amount ?? 0,
        })),
    };
}
// ─── Aggregate analysis: awarding agency ──────────────────────────
export async function searchAgencySpending(args) {
    const filters = buildFilters(args);
    const json = await postUsas("search/spending_by_category/awarding_agency", { filters, limit: args.limit ?? 10, page: 1 });
    return {
        agencies: (json.results ?? []).map((r) => ({
            name: r.name ?? "",
            code: r.code ?? "",
            slug: r.agency_slug ?? "",
            amount: r.amount ?? 0,
        })),
    };
}
// ─── Sub-agency breakdown ─────────────────────────────────────────
export async function searchSubAgencySpending(args) {
    const filters = buildFilters(args);
    const json = await postUsas("search/spending_by_category/awarding_subagency", { filters, limit: 10, page: 1 });
    return {
        subAgencies: (json.results ?? []).map((r) => ({
            name: r.name ?? "",
            amount: r.amount ?? 0,
            awards: r.count ?? 0,
        })),
    };
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
    const json = await getUsas(`agency/${args.toptierCode}/budget_function/?fiscal_year=${fy}&limit=${args.limit ?? 10}`);
    return {
        toptierCode: json.toptier_code,
        fiscalYear: json.fiscal_year,
        functions: (json.results ?? []).map((r) => ({
            name: r.name ?? "",
            programs: (r.children ?? []).map((c) => ({
                name: c.name ?? "",
                obligated: c.obligated_amount ?? 0,
                outlays: c.gross_outlay_amount ?? 0,
            })),
        })),
    };
}
// ─── Recipient list + profile ─────────────────────────────────────
export async function searchRecipients(args) {
    const body = {
        keyword: args.keyword,
        limit: args.limit ?? 10,
        page: 1,
    };
    if (args.recipientLevel) {
        body.recipient_level = args.recipientLevel;
    }
    const json = await postUsas("recipient/", body);
    return {
        totalRecords: json.page_metadata?.total ?? 0,
        recipients: (json.results ?? []).map((r) => ({
            id: r.id ?? "",
            duns: r.duns,
            uei: r.uei,
            name: r.name ?? "",
            level: r.recipient_level,
            totalAmount: r.amount ?? 0,
        })),
    };
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
    return memoize(`usas:naics:${args.searchText.toLowerCase()}:${args.limit ?? 10}`, async () => {
        const json = await postUsas("autocomplete/naics/", {
            search_text: args.searchText,
            limit: args.limit ?? 10,
        });
        return {
            naics: (json.results ?? []).map((r) => ({
                code: r.naics ?? "",
                description: r.naics_description ?? "",
                retired: !!r.year_retired,
            })),
        };
    });
}
export async function autocompleteRecipient(args) {
    return memoize(`usas:recipient:${args.searchText.toLowerCase()}:${args.limit ?? 10}`, async () => {
        const json = await postUsas("autocomplete/recipient/", {
            search_text: args.searchText,
            limit: args.limit ?? 10,
        });
        return {
            recipients: (json.results ?? []).map((r) => ({
                name: r.recipient_name ?? "",
                uei: r.uei,
                duns: r.duns,
            })),
        };
    });
}
export async function naicsHierarchy(args) {
    return memoize(`usas:naics-hierarchy:${args.naicsFilter ?? ""}`, async () => {
        const path = args.naicsFilter
            ? `references/naics/?filter=${encodeURIComponent(args.naicsFilter)}`
            : "references/naics/";
        const json = await getUsas(path);
        return {
            hierarchy: (json.results ?? []).map((r) => ({
                code: r.naics ?? "",
                description: r.naics_description ?? "",
                count: r.count ?? 0,
                hasChildren: !!(r.children && r.children.length > 0),
            })),
        };
    });
}
export async function glossary(args) {
    return memoize(`usas:glossary:${args.search ?? ""}:${args.limit ?? 25}`, async () => {
        const params = new URLSearchParams();
        params.set("limit", String(args.limit ?? 25));
        if (args.search)
            params.set("search", args.search);
        const json = await getUsas(`references/glossary/?${params.toString()}`);
        return {
            totalRecords: json.page_metadata?.count ?? 0,
            terms: (json.results ?? []).map((r) => ({
                term: r.term ?? "",
                slug: r.slug ?? "",
                definition: r.plain ?? "",
            })),
        };
    });
}
export async function listToptierAgencies(args) {
    return memoize(`usas:toptier:${args.limit ?? 50}`, async () => {
        const json = await getUsas(`references/toptier_agencies/?limit=${args.limit ?? 50}`);
        return {
            agencies: (json.results ?? []).map((r) => ({
                name: r.agency_name ?? "",
                abbreviation: r.abbreviation,
                toptierCode: r.toptier_code,
                slug: r.agency_slug,
                activeFiscalYear: r.active_fy,
                obligatedAmount: r.obligated_amount ?? 0,
            })),
        };
    });
}
//# sourceMappingURL=usaspending.js.map