/**
 * Minimal USAspending v2 wrappers for the MCP server.
 *
 * Why we don't depend on a separate `@govicon/usaspending` package:
 * the surface here is small (4 endpoints, ~120 LOC) and tightly
 * coupled to the MCP tool shape. If usage grows we'll extract.
 *
 * USAspending endpoints used:
 *   - /search/spending_by_category/recipient
 *   - /search/spending_by_category/awarding_subagency
 *   - /search/spending_by_award (with subawards: false | true)
 *   - /autocomplete/funding_agency
 *
 * All endpoints are KEYLESS — USAspending is a public federal
 * spending transparency API, no registration needed.
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
    return filters;
}
async function callUsas(endpoint, body) {
    const r = await fetch(`${USAS}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
        throw new Error(`USAspending ${endpoint} returned ${r.status}`);
    }
    return (await r.json());
}
export async function searchAwards(args) {
    const filters = buildFilters(args);
    const json = await callUsas("search/spending_by_category/recipient", { filters, limit: 10, page: 1 });
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
export async function searchIndividualAwards(args) {
    const filters = buildFilters(args);
    const json = await callUsas("search/spending_by_award", {
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
        })),
    };
}
export async function searchSubAgencySpending(args) {
    const filters = buildFilters(args);
    const json = await callUsas("search/spending_by_category/awarding_subagency", { filters, limit: 10, page: 1 });
    return {
        subAgencies: (json.results ?? []).map((r) => ({
            name: r.name ?? "",
            amount: r.amount ?? 0,
            awards: r.count ?? 0,
        })),
    };
}
export async function lookupAgency(searchText) {
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
//# sourceMappingURL=usaspending.js.map