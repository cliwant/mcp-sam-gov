/**
 * Grants.gov v1 API wrappers (keyless).
 *
 * Grants.gov hosts federal financial-assistance opportunities (grants,
 * cooperative agreements). Distinct from SAM.gov contracts but the
 * same pursuit ICP often cares about both.
 *
 * Endpoints (POST JSON, no key):
 *   - /v1/api/search2 — search opportunities
 *   - /v1/api/fetchOpportunity — single grant detail
 *
 * Documented at https://grants.gov/web/grants/s2s/grantor/schemas/grants-search-2-soap.html
 */
import { fetchWithRetry } from "./errors.js";
const GRANTS = "https://api.grants.gov/v1/api";
async function postJson(endpoint, body) {
    const r = await fetchWithRetry(`${GRANTS}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    }, `grants.gov:${endpoint}`);
    return (await r.json());
}
export async function searchGrants(args) {
    const body = {
        rows: args.rows ?? 10,
        keyword: args.keyword ?? "",
        cfda: args.cfda ?? "",
        agencies: args.agency ?? "",
        oppNum: args.oppNum ?? "",
        oppStatuses: (args.oppStatuses ?? ["forecasted", "posted"]).join("|"),
    };
    const json = await postJson("search2", body);
    if (json.errorcode && json.errorcode !== 0) {
        throw new Error(`Grants.gov error: ${json.msg ?? "unknown"}`);
    }
    return {
        totalRecords: json.data?.hitCount ?? 0,
        grants: (json.data?.oppHits ?? []).map((g) => ({
            id: g.id ?? "",
            opportunityNumber: g.number ?? "",
            title: g.title ?? "",
            agencyCode: g.agencyCode ?? "",
            agencyName: g.agencyName ?? "",
            openDate: g.openDate,
            closeDate: g.closeDate,
            status: g.oppStatus,
            docType: g.docType,
            cfdaList: g.cfdaList,
        })),
    };
}
export async function getGrant(args) {
    const json = await postJson("fetchOpportunity", {
        opportunityId: args.opportunityId,
    });
    if (json.errorcode && json.errorcode !== 0) {
        throw new Error(`Grants.gov error: ${json.msg ?? "unknown"}`);
    }
    const d = json.data ?? {};
    const s = d.synopsis ?? {};
    return {
        id: d.id ?? 0,
        opportunityNumber: d.opportunityNumber ?? "",
        title: d.opportunityTitle ?? "",
        agency: { code: s.agencyCode ?? d.owningAgencyCode, name: s.agencyName },
        description: s.synopsisDesc ?? d.synopsisDesc ?? "",
        postingDate: s.postingDate,
        responseDate: s.responseDate,
        archiveDate: s.archiveDate,
        awardCeiling: s.awardCeiling,
        awardFloor: s.awardFloor,
        estimatedFunding: s.estimatedFunding,
        expectedNumberOfAwards: s.expectedNumberOfAwards,
        applicantTypes: (s.applicantTypes ?? [])
            .map((a) => a.description)
            .filter(Boolean),
        fundingInstruments: (s.fundingInstruments ?? [])
            .map((f) => f.description)
            .filter(Boolean),
        fundingCategories: (s.fundingActivityCategories ?? [])
            .map((f) => f.description)
            .filter(Boolean),
        cfdaPrograms: (d.cfdas ?? []).map((c) => ({
            number: c.cfdaNumber ?? "",
            title: c.programTitle ?? "",
        })),
    };
}
//# sourceMappingURL=grants.js.map