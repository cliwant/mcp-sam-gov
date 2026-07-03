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
import { withMeta } from "./meta.js";

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
        // E-2 (spec §1.6, §5): the Grants.gov search2 response returns
        // cfdaList as an ARRAY of CFDA numbers (e.g. ["19.441"]) — NOT a
        // pipe-delimited string as the type previously declared. Correct the
        // type to match the runtime shape.
        cfdaList?: string[];
      }[];
    };
  };
  const json = await postJson<Resp>("search2", body);
  if (json.errorcode && json.errorcode !== 0) {
    throw new Error(`Grants.gov error: ${json.msg ?? "unknown"}`);
  }
  const totalRecords = json.data?.hitCount ?? 0;
  const data = {
    totalRecords,
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
      // E-2: always an array — normalize absent/legacy-string to []/[str]
      // so consumers can rely on `cfdaList` being string[] unconditionally.
      cfdaList: Array.isArray(g.cfdaList)
        ? g.cfdaList
        : g.cfdaList
          ? [g.cfdaList as unknown as string]
          : [],
    })),
  };

  // Truthful `_meta` (spec §1.2 A4, §2.3). Grants.gov reports a real match
  // total (`hitCount`), so `totalAvailable` is trustworthy. A4: Grants.gov
  // silently IGNORES unknown agency codes / CFDA numbers (it returns the
  // unfiltered set rather than erroring), and it does not echo back which
  // filters it honored — so the AI cannot verify a filter took. We list the
  // filters we SENT in `filtersApplied` and warn that unknown values are
  // dropped silently, so the AI treats a suspiciously large result set with
  // caution instead of asserting it is filtered.
  const returned = data.grants.length;
  const sent: string[] = [];
  if (args.keyword) sent.push("keyword");
  if (args.cfda) sent.push("cfda");
  if (args.agency) sent.push("agency");
  if (args.oppNum) sent.push("oppNum");
  if (args.oppStatuses?.length) sent.push("oppStatuses");
  const notes: string[] = [];
  if (args.agency || args.cfda) {
    notes.push(
      "Grants.gov silently ignores an unknown agency code or CFDA number (it returns the UNFILTERED result set instead of an error) and does not confirm which filters were honored — if the result count looks too broad, verify the agency/CFDA value.",
    );
  }
  return withMeta(data, {
    source: "grants.gov/api (search2)",
    keylessMode: true,
    returned,
    totalAvailable: totalRecords,
    truncated: returned < totalRecords,
    filtersApplied: sent,
    filtersDropped: [],
    fieldsUnavailable: [],
    notes,
  });
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
