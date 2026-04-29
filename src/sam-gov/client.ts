/**
 * @cliwant/mcp-sam-gov/sam-gov — keyless SAM.gov client.
 *
 * Two endpoint layers, one normalized contract:
 *   1. Authenticated `api.sam.gov/opportunities/v2/search` —
 *      higher rate limit + full historical archive. Used when the
 *      caller passes an API key.
 *   2. Keyless `sam.gov/api/prod/sgs/v1/search/` (HAL JSON) —
 *      the same data the SAM.gov website uses to render itself.
 *      No registration. Reasonable rate.
 *
 * The client picks layer 1 if an API key is available, falling back
 * to layer 2 transparently. Callers don't have to care.
 */

import type {
  EntitySearchResult,
  SamGovClientOptions,
  SamOpportunity,
  SamSearchFilters,
  SamSearchResult,
} from "./types.js";

const PROD_BASE = "https://api.sam.gov/opportunities/v2/search";
const ENTITY_BASE = "https://api.sam.gov/entity-information/v3/entities";
const PUBLIC_BASE = "https://sam.gov/api/prod";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; @cliwant/mcp-sam-gov; +https://github.com/cliwant/mcp-sam-gov)";

export class SamGovClient {
  private readonly apiKey?: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: { warn?: (msg: string, err?: unknown) => void };

  constructor(options: SamGovClientOptions = {}) {
    this.apiKey = options.apiKey?.trim();
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.logger = options.logger ?? {};
  }

  /**
   * Search SAM.gov opportunities.
   *
   * Three-tier fallback:
   *   1. Authenticated v2 search (if `apiKey` configured)
   *   2. Keyless HAL search
   *   3. Empty result (caller can decide how to surface "no data")
   */
  async searchOpportunities(
    filters: SamSearchFilters,
  ): Promise<SamSearchResult> {
    if (this.apiKey) {
      try {
        const url = this.buildAuthSearchUrl(filters);
        const r = await this.fetchImpl(url, {
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
        });
        if (r.ok) return (await r.json()) as SamSearchResult;
        this.warn(`auth search ${r.status}; trying public`);
      } catch (err) {
        this.warn("auth search failed, trying public", err);
      }
    }
    try {
      const r = await this.searchPublic(filters);
      if (r.opportunitiesData.length > 0) return r;
    } catch (err) {
      this.warn("public search failed", err);
    }
    return {
      totalRecords: 0,
      limit: filters.limit ?? 25,
      offset: filters.offset ?? 0,
      opportunitiesData: [],
    };
  }

  /**
   * Resolve a single opportunity by `noticeId` (32-char hex).
   *
   * Three-tier fallback:
   *   1. Authenticated v2 search filtered by noticeId (if key)
   *   2. Keyless detail endpoint + resources + org enrichment
   *   3. null
   */
  async getOpportunity(noticeId: string): Promise<SamOpportunity | null> {
    if (this.apiKey) {
      try {
        const url = new URL(PROD_BASE);
        const range = defaultPostedRange();
        const yearAgo = new Date();
        yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
        url.searchParams.set("api_key", this.apiKey);
        url.searchParams.set("postedFrom", formatSamDate(yearAgo));
        url.searchParams.set("postedTo", range.postedTo);
        url.searchParams.set("noticeid", noticeId);
        url.searchParams.set("limit", "1");
        const r = await this.fetchImpl(url.toString(), {
          headers: { Accept: "application/json", "User-Agent": this.userAgent },
        });
        if (r.ok) {
          const json = (await r.json()) as SamSearchResult;
          const hit = json.opportunitiesData?.[0];
          if (hit) {
            if (!hit.resourceLinks || hit.resourceLinks.length === 0) {
              hit.resourceLinks = await this.getPublicResourceLinks(noticeId);
            }
            return hit;
          }
        }
      } catch (err) {
        this.warn("auth getOpportunity failed, trying public", err);
      }
    }
    try {
      return await this.getOpportunityPublic(noticeId);
    } catch (err) {
      this.warn("public getOpportunity failed", err);
      return null;
    }
  }

  /**
   * Fetch the full description body for an opportunity.
   *
   * Handles three input shapes:
   *   1. Already-extracted text (no `http://`) — pass-through
   *   2. `api.sam.gov/.../v1/api/getDescription/...` — append `?api_key=`
   *   3. Public sam.gov URL — HAL headers, no key
   */
  async fetchOpportunityDescription(input: string): Promise<string> {
    if (!/^https?:\/\//i.test(input)) {
      return input.trim() || "Description not available.";
    }
    const isApi = /(^|\/\/)api\.sam\.gov\b/i.test(input);
    const isPublic =
      /(^|\/\/)sam\.gov\b/i.test(input) && !isApi;
    let finalUrl = input;
    let headers: HeadersInit = {
      Accept: "text/html, text/plain, */*",
      "User-Agent": this.userAgent,
    };
    if (isApi && this.apiKey) {
      finalUrl = `${input}${input.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(this.apiKey)}`;
    } else if (isPublic) {
      headers = {
        Accept: "text/html, text/plain, application/hal+json, */*",
        "User-Agent": this.userAgent,
      };
    }
    try {
      const r = await this.fetchImpl(finalUrl, { headers });
      if (!r.ok) return "Description not available.";
      const ct = r.headers.get("content-type") ?? "";
      if (ct.includes("application/json") || ct.includes("application/hal+json")) {
        const json = (await r.json()) as {
          body?: string;
          description?: string;
          data?: { body?: string };
        };
        return (
          (json.body ?? json.data?.body ?? json.description ?? "").trim() ||
          "Description not available."
        );
      }
      const text = await r.text();
      return text
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, " ")
        .trim();
    } catch (err) {
      this.warn("fetchOpportunityDescription failed", err);
      return "Description not available.";
    }
  }

  /**
   * Look up registered SAM.gov entities by legal business name.
   * Requires an API key (the entity registration API has no public
   * keyless mirror — it's the one place BYOK is genuinely needed).
   */
  async searchEntities(query: string): Promise<EntitySearchResult> {
    if (!this.apiKey) return { entities: [], totalRecords: 0 };
    try {
      const url = new URL(ENTITY_BASE);
      url.searchParams.set("api_key", this.apiKey);
      url.searchParams.set("legalBusinessName", query);
      url.searchParams.set("registrationStatus", "A");
      const r = await this.fetchImpl(url.toString(), {
        headers: { Accept: "application/json", "User-Agent": this.userAgent },
      });
      if (!r.ok) throw new Error(`Entity search ${r.status}`);
      type RawEntity = {
        entityRegistration?: {
          ueiSAM?: string;
          legalBusinessName?: string;
          cageCode?: string;
          registrationStatus?: string;
        };
        coreData?: {
          physicalAddress?: { city?: string; stateOrProvinceCode?: string };
        };
        assertions?: {
          goodsAndServices?: { naicsList?: { naicsCode?: string }[] };
        };
      };
      const json = (await r.json()) as {
        entityData?: RawEntity[];
        totalRecords?: number;
      };
      return {
        entities: (json.entityData ?? []).map((e) => ({
          ueiSAM: e.entityRegistration?.ueiSAM ?? "",
          legalBusinessName: e.entityRegistration?.legalBusinessName ?? "",
          cageCode: e.entityRegistration?.cageCode,
          physicalAddress: e.coreData?.physicalAddress,
          naics:
            e.assertions?.goodsAndServices?.naicsList?.map(
              (n) => n.naicsCode ?? "",
            ) ?? [],
          activeRegistration:
            e.entityRegistration?.registrationStatus === "Active",
        })),
        totalRecords: json.totalRecords ?? 0,
      };
    } catch (err) {
      this.warn("entity search failed", err);
      return { entities: [], totalRecords: 0 };
    }
  }

  /**
   * Build the keyless download URL for an attachment, given the
   * resourceId from getPublicResourceLinks(). Returns a 303 redirect
   * to a signed S3 URL when fetched. Useful for embedding viewers.
   */
  publicDownloadUrl(resourceId: string): string {
    return `${PUBLIC_BASE}/opps/v3/opportunities/resources/files/${encodeURIComponent(resourceId)}/download`;
  }

  // ─── Internal: keyless layer ──────────────────────────────────

  private buildAuthSearchUrl(filters: SamSearchFilters): string {
    const url = new URL(PROD_BASE);
    const range =
      filters.postedFrom && filters.postedTo
        ? { postedFrom: filters.postedFrom, postedTo: filters.postedTo }
        : defaultPostedRange();
    url.searchParams.set("api_key", this.apiKey!);
    url.searchParams.set("postedFrom", range.postedFrom);
    url.searchParams.set("postedTo", range.postedTo);
    url.searchParams.set("limit", String(filters.limit ?? 25));
    url.searchParams.set("offset", String(filters.offset ?? 0));
    if (filters.query) url.searchParams.set("title", filters.query);
    if (filters.ptype?.length) url.searchParams.set("ptype", filters.ptype.join(","));
    if (filters.ncode) url.searchParams.set("ncode", filters.ncode);
    if (filters.setAside?.length)
      url.searchParams.set("typeOfSetAside", filters.setAside.join(","));
    if (filters.organizationName)
      url.searchParams.set("organizationName", filters.organizationName);
    if (filters.state) url.searchParams.set("state", filters.state);
    if (filters.zip) url.searchParams.set("zip", filters.zip);
    if (filters.responseDeadlineFrom)
      url.searchParams.set("rdlfrom", filters.responseDeadlineFrom);
    if (filters.responseDeadlineTo)
      url.searchParams.set("rdlto", filters.responseDeadlineTo);
    return url.toString();
  }

  private async searchPublic(
    filters: SamSearchFilters,
  ): Promise<SamSearchResult> {
    const url = new URL(`${PUBLIC_BASE}/sgs/v1/search/`);
    url.searchParams.set("index", "opp");
    url.searchParams.set("page", "0");
    url.searchParams.set("mode", "search");
    url.searchParams.set("sort", "-modifiedDate");
    url.searchParams.set("size", String(filters.limit ?? 25));
    url.searchParams.set("is_active", "true");
    if (filters.query) url.searchParams.set("q", filters.query);
    if (filters.ncode) url.searchParams.append("naics_code", filters.ncode);
    if (filters.organizationName)
      url.searchParams.set("organization_name", filters.organizationName);
    if (filters.setAside?.length)
      for (const sa of filters.setAside) url.searchParams.append("set_aside", sa);
    if (filters.state)
      url.searchParams.set("place_of_performance_state", filters.state);

    const r = await this.fetchImpl(url.toString(), {
      headers: this.publicHeaders(),
    });
    if (!r.ok) throw new Error(`SAM.gov public search ${r.status}`);
    const json = (await r.json()) as {
      page?: { totalElements?: number };
      _embedded?: {
        results?: {
          _id?: string;
          title?: string;
          solicitationNumber?: string;
          organizationHierarchy?: { name?: string; level?: number }[];
          type?: { code?: string; value?: string };
          publishDate?: string;
          responseDate?: string;
          isActive?: boolean;
          descriptions?: { content?: string }[];
        }[];
      };
    };
    const totalRecords = json.page?.totalElements ?? 0;
    const results = json._embedded?.results ?? [];
    const data: SamOpportunity[] = results.map((r) => {
      const hierarchy = (r.organizationHierarchy ?? [])
        .filter((h) => h.name)
        .sort((a, b) => (a.level ?? 0) - (b.level ?? 0))
        .map((h) => h.name as string);
      return {
        noticeId: r._id ?? "",
        title: r.title ?? "",
        solicitationNumber: r.solicitationNumber,
        fullParentPathName: hierarchy.join("."),
        postedDate: r.publishDate,
        type: r.type?.value,
        baseType: r.type?.code,
        typeOfSetAsideDescription: null,
        typeOfSetAside: null,
        responseDeadLine: r.responseDate ?? null,
        naicsCode: null,
        active: r.isActive === false ? "No" : "Yes",
        placeOfPerformance: null,
        description: r.descriptions?.[0]?.content,
        uiLink: r._id ? `https://sam.gov/opp/${r._id}/view` : undefined,
        resourceLinks: [],
      };
    });
    return {
      totalRecords,
      limit: filters.limit ?? 25,
      offset: filters.offset ?? 0,
      opportunitiesData: data,
    };
  }

  private async getOpportunityPublic(
    noticeId: string,
  ): Promise<SamOpportunity | null> {
    const url = `${PUBLIC_BASE}/opps/v2/opportunities/${encodeURIComponent(noticeId)}`;
    const r = await this.fetchImpl(url, { headers: this.publicHeaders() });
    if (!r.ok) return null;
    type DetailResp = {
      data2?: {
        title?: string;
        type?: string;
        organizationId?: string;
        classificationCode?: string;
        postedDate?: string;
        archived?: boolean;
        archive?: { date?: string; type?: string };
        naics?: { code?: string[] }[];
        solicitationNumber?: string;
        solicitation?: { setAside?: string; deadlines?: { response?: string } };
        placeOfPerformance?: SamOpportunity["placeOfPerformance"];
        pointOfContact?: {
          type?: string;
          email?: string;
          phone?: string;
          title?: string;
          fullName?: string;
        }[];
      };
      description?: { body?: string }[];
    };
    const detail = (await r.json()) as DetailResp;
    const d = detail.data2 ?? {};
    if (!d.title) return null;
    const [resourceLinks, fullParentPathName] = await Promise.all([
      this.getPublicResourceLinks(noticeId),
      d.organizationId
        ? this.getPublicOrgName(d.organizationId)
        : Promise.resolve(""),
    ]);
    return {
      noticeId,
      title: d.title,
      solicitationNumber: d.solicitationNumber,
      fullParentPathName,
      postedDate: d.postedDate,
      type: d.type,
      baseType: d.type,
      archiveDate: d.archive?.date,
      archiveType: d.archive?.type,
      typeOfSetAsideDescription: d.solicitation?.setAside ?? null,
      typeOfSetAside: d.solicitation?.setAside ?? null,
      responseDeadLine: d.solicitation?.deadlines?.response ?? null,
      naicsCode: d.naics?.[0]?.code?.[0] ?? null,
      classificationCode: d.classificationCode,
      active: d.archived ? "No" : "Yes",
      placeOfPerformance: d.placeOfPerformance ?? null,
      description: detail.description?.[0]?.body,
      pointOfContact: d.pointOfContact ?? [],
      uiLink: `https://sam.gov/opp/${noticeId}/view`,
      resourceLinks,
    };
  }

  private async getPublicResourceLinks(noticeId: string): Promise<string[]> {
    try {
      const url = `${PUBLIC_BASE}/opps/v3/opportunities/${encodeURIComponent(noticeId)}/resources`;
      const r = await this.fetchImpl(url, { headers: this.publicHeaders() });
      if (!r.ok) return [];
      type Resp = {
        _embedded?: {
          opportunityAttachmentList?: {
            attachments?: { resourceId?: string; name?: string }[];
          }[];
        };
      };
      const json = (await r.json()) as Resp;
      const attachments =
        json._embedded?.opportunityAttachmentList?.[0]?.attachments ?? [];
      return attachments
        .filter((a) => a.resourceId)
        .map((a) => this.publicDownloadUrl(a.resourceId!));
    } catch (err) {
      this.warn("getPublicResourceLinks failed", err);
      return [];
    }
  }

  private async getPublicOrgName(orgId: string): Promise<string> {
    try {
      const url = `${PUBLIC_BASE}/federalorganizations/v1/organizations/${encodeURIComponent(orgId)}`;
      const r = await this.fetchImpl(url, { headers: this.publicHeaders() });
      if (!r.ok) return "";
      type Resp = {
        _embedded?: {
          org?: {
            fullParentPathName?: string;
            agencyName?: string;
            name?: string;
          };
        }[];
      };
      const json = (await r.json()) as Resp;
      const org = json._embedded?.[0]?.org;
      return org?.fullParentPathName ?? org?.agencyName ?? org?.name ?? "";
    } catch (err) {
      this.warn("getPublicOrgName failed", err);
      return "";
    }
  }

  private publicHeaders(): HeadersInit {
    return {
      Accept: "application/hal+json",
      "User-Agent": this.userAgent,
    };
  }

  private warn(msg: string, err?: unknown) {
    if (this.logger.warn) this.logger.warn(`[mcp-sam-gov/sam-gov] ${msg}`, err);
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function formatSamDate(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const year = date.getUTCFullYear();
  return `${month}/${day}/${year}`;
}

function defaultPostedRange(): { postedFrom: string; postedTo: string } {
  const today = new Date();
  const fromDate = new Date(today);
  fromDate.setUTCDate(today.getUTCDate() - 30);
  return {
    postedFrom: formatSamDate(fromDate),
    postedTo: formatSamDate(today),
  };
}
