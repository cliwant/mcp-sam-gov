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

async function postJson<T>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  const r = await fetchWithRetry(
    `${GRANTS}/${endpoint}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
    `grants.gov:${endpoint}`,
  );
  return (await r.json()) as T;
}

export type GrantStatus = "forecasted" | "posted" | "closed" | "archived";

export async function searchGrants(args: {
  keyword?: string;
  cfda?: string; // CFDA program number, e.g. "10.500"
  agency?: string; // agency code, e.g. "DHS-FEMA"
  oppNum?: string; // opportunity number
  oppStatuses?: GrantStatus[];
  rows?: number;
}) {
  const body: Record<string, unknown> = {
    rows: args.rows ?? 10,
    keyword: args.keyword ?? "",
    cfda: args.cfda ?? "",
    agencies: args.agency ?? "",
    oppNum: args.oppNum ?? "",
    oppStatuses: (args.oppStatuses ?? ["forecasted", "posted"]).join("|"),
  };
  type Resp = {
    errorcode?: number;
    msg?: string;
    data?: {
      hitCount?: number;
      oppHits?: {
        id?: string;
        number?: string;
        title?: string;
        agencyCode?: string;
        agencyName?: string;
        openDate?: string;
        closeDate?: string;
        oppStatus?: string;
        docType?: string;
        cfdaList?: string;
      }[];
    };
  };
  const json = await postJson<Resp>("search2", body);
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

export async function getGrant(args: { opportunityId: string }) {
  type Resp = {
    errorcode?: number;
    msg?: string;
    data?: {
      id?: number;
      opportunityNumber?: string;
      opportunityTitle?: string;
      owningAgencyCode?: string;
      synopsisDesc?: string;
      synopsis?: {
        synopsisDesc?: string;
        applicantTypes?: { description?: string }[];
        fundingActivityCategories?: { description?: string }[];
        fundingInstruments?: { description?: string }[];
        responseDate?: string;
        postingDate?: string;
        archiveDate?: string;
        awardCeiling?: number;
        awardFloor?: number;
        estimatedFunding?: number;
        expectedNumberOfAwards?: number;
        agencyName?: string;
        agencyCode?: string;
      };
      opportunityHistoryDetails?: { actionType?: string; actionDate?: string }[];
      cfdas?: { cfdaNumber?: string; programTitle?: string }[];
    };
  };
  const json = await postJson<Resp>("fetchOpportunity", {
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
      .filter(Boolean) as string[],
    fundingInstruments: (s.fundingInstruments ?? [])
      .map((f) => f.description)
      .filter(Boolean) as string[],
    fundingCategories: (s.fundingActivityCategories ?? [])
      .map((f) => f.description)
      .filter(Boolean) as string[],
    cfdaPrograms: (d.cfdas ?? []).map((c) => ({
      number: c.cfdaNumber ?? "",
      title: c.programTitle ?? "",
    })),
  };
}
