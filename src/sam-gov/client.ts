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

import { ToolErrorCarrier } from "../errors.js";
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
   * True when no SAM API key is configured, i.e. requests fall back to the
   * keyless HAL layer. The keyless list endpoint ignores the structured
   * facet filters (NAICS / set-aside / state / org) and nulls those fields,
   * so tools use this to populate an honest `_meta` (filtersDropped /
   * fieldsUnavailable). See docs/research/02-truthful-outputs-spec.md §1.2.
   */
  get isKeyless(): boolean {
    return !this.apiKey;
  }

  /**
   * Search SAM.gov opportunities.
   *
   * Three-tier fallback:
   *   1. Authenticated v2 search (if `apiKey` configured)
   *   2. Keyless HAL search — returned AS-IS (a genuine 0 or an empty page
   *      past the end is an honest result, not a fallback trigger)
   *   3. Only if EVERY tier throws (total outage): an empty result carrying
   *      `degraded` so the caller surfaces an outage, NOT a confirmed zero.
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
      // Return the public result AS-IS — even 0 rows. A genuine zero
      // (source healthy, query matched nothing) and a real `totalRecords>0`
      // but empty page (paging past the end) are both HONEST outcomes and
      // must not be replaced by a hardcoded 0. Only a THROW below (all tiers
      // failed) is an outage, which we mark `degraded` so callers can tell it
      // apart from a genuine zero instead of silently reporting "0, complete".
      return await this.searchPublic(filters);
    } catch (err) {
      this.warn("public search failed", err);
      return {
        totalRecords: 0,
        limit: filters.limit ?? 25,
        offset: filters.offset ?? 0,
        opportunitiesData: [],
        degraded: {
          reason:
            "SAM opportunity search is unavailable (all access tiers failed).",
        },
      };
    }
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
              // Same DOWN-reads-as-absent guard on the keyed path: a failed
              // resource-list fetch is an outage, not "no attachments" —
              // record the degradation instead of silently returning `[]`.
              hit.resourceLinks = await this.getPublicResourceLinks(
                noticeId,
              ).catch(() => {
                hit.enrichmentDegraded = [
                  ...(hit.enrichmentDegraded ?? []),
                  "attachments",
                ];
                return [];
              });
            }
            return hit;
          }
        }
      } catch (err) {
        this.warn("auth getOpportunity failed, trying public", err);
      }
    }
    // getOpportunityPublic returns null ONLY for a genuine not-found (401/404);
    // an outage (5xx/network/timeout/hollow-200) THROWS a classified
    // ToolErrorCarrier. That throw MUST propagate — collapsing it to null would
    // make the wrapper render a DOWN service as found:false (a fabricated
    // absence). A genuine null still passes through unchanged.
    try {
      return await this.getOpportunityPublic(noticeId);
    } catch (err) {
      this.warn("public getOpportunity failed", err);
      if (err instanceof ToolErrorCarrier) throw err;
      // A raw/unclassified error must not become a silent null either —
      // classify it as a retryable outage so the caller learns the truth.
      throw new ToolErrorCarrier({
        kind: "upstream_unavailable",
        message: `SAM detail lookup for ${noticeId} failed: ${(err as Error).message}. This is an outage, not a confirmed absence. Retry.`,
        retryable: true,
        retryAfterSeconds: 30,
        upstreamEndpoint: "sam:opps/v2/opportunities",
      });
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
      // A DOWN description fetch must ERROR, never fabricate a "not available"
      // placeholder that reads as "this description doesn't exist". THROW a
      // classified retryable outage; the wrapper propagates it to a tool error.
      if (!r.ok) {
        throw new ToolErrorCarrier({
          kind: "upstream_unavailable",
          message: `SAM description fetch returned HTTP ${r.status} for ${finalUrl} — the service is unavailable, NOT an absent description. Retry.`,
          retryable: true,
          retryAfterSeconds: 60,
          upstreamStatus: r.status,
          upstreamEndpoint: "sam:description",
        });
      }
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
      // A classified outage (from the !r.ok throw above) propagates as-is. A raw
      // network/parse fault must ALSO error (not fabricate "not available") —
      // classify it as a retryable outage so a DOWN fetch is never read as an
      // absent description.
      if (err instanceof ToolErrorCarrier) throw err;
      throw new ToolErrorCarrier({
        kind: "upstream_unavailable",
        message: `SAM description fetch for ${finalUrl} failed: ${(err as Error).message}. This is an outage, not an absent description. Retry.`,
        retryable: true,
        retryAfterSeconds: 30,
        upstreamEndpoint: "sam:description",
      });
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
    // Keyless HAL facet params — VERIFIED LIVE (2026-07). The list endpoint
    // honors these server-side: result counts drop correctly AND every returned
    // notice's detail matches the filter (e.g. naics=236220 → all hits carry
    // primary NAICS 236220). The param NAMES differ from the authenticated v2
    // API's, and a wrong name is SILENTLY IGNORED (returns the full firehose):
    //   NAICS         → `naics`     (NOT `naics_code`/`ncode` — both ignored)
    //   place-of-perf → `pop_state` (NOT `place_of_performance_state`; value
    //                                must be the UPPER-CASE 2-letter code)
    //   set-aside     → `set_aside` (repeatable; SAM codes: SBA/8A/HZS/HZC/
    //                                SDVOSBC/WOSB/EDWOSB/VSA/VSS — all verified)
    //   keyword       → `q`
    // Organization-name has NO keyless filter param (organization_name and
    // organizationName are both ignored) — sent best-effort; the tool's `_meta`
    // flags it as dropped so the AI never treats the set as org-filtered.
    if (filters.query) url.searchParams.set("q", filters.query);
    if (filters.ncode) url.searchParams.append("naics", filters.ncode);
    if (filters.organizationName)
      url.searchParams.set("organization_name", filters.organizationName);
    if (filters.setAside?.length)
      for (const sa of filters.setAside) url.searchParams.append("set_aside", sa);
    if (filters.state)
      url.searchParams.set("pop_state", filters.state.toUpperCase());
    // Notice-type facet — VERIFIED LIVE (2026-07): the keyless list endpoint
    // filters SERVER-SIDE on `notice_type` (comma-joined multi-value). Codes:
    // r=Sources Sought, p=Presolicitation, s=Special Notice, k=Combined
    // Synopsis/Solicitation, i=Intent to Bundle, u=Justification(J&A),
    // o=Solicitation, a=Award. (e.g. notice_type=r → 3,641; r,p,s → 10,603;
    // p&naics=541512 → 8 — counts drop correctly and every row matches.) The
    // keyless param is `notice_type` — NOT `ptype` (the AUTHENTICATED endpoint's
    // name, sent by buildAuthSearchUrl). ADDITIVE: existing callers that don't
    // set `ptype` (e.g. sam_search_opportunities) send nothing here, so their
    // behavior is UNCHANGED. Powers the pre-solicitation shaping radar
    // (sam_search_shaping).
    if (filters.ptype?.length)
      url.searchParams.set("notice_type", filters.ptype.join(","));

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
    // A 200 whose body lacks a well-formed HAL `page` block is NOT a genuine
    // zero — it's a hollow/degraded response (a CloudFront/Envoy cached error
    // envelope, a `{"message":"Access Denied"}` 200, or a dropped-`page` proxy
    // body; the endpoint sits behind CloudFront→istio-envoy). A GENUINE empty
    // result always carries `page.totalElements` (0); a healthy hit carries a
    // positive one. So treat a non-finite `totalElements` as an OUTAGE (throw)
    // — searchOpportunities' catch then marks it `degraded` instead of emitting
    // the "0 notices, complete" lie. Mirrors far.ts's hollow-200 guard.
    const totalElements = json.page?.totalElements;
    if (!Number.isFinite(totalElements)) {
      throw new Error(
        "SAM.gov public search returned HTTP 200 without a valid page.totalElements — hollow/degraded body, not a genuine zero.",
      );
    }
    const totalRecords = totalElements as number;
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
    // A network-level fault (DNS/socket/timeout) must surface as a classified
    // retryable outage, NOT collapse to null (which the wrapper renders as
    // "notice not found"). Mirrors far.ts/fetchWithRetry's network branch.
    let r: Response;
    try {
      r = await this.fetchImpl(url, { headers: this.publicHeaders() });
    } catch (err) {
      throw new ToolErrorCarrier({
        kind: "upstream_unavailable",
        message: `Network error reaching the SAM detail endpoint for ${noticeId}: ${(err as Error).message}. This is an outage, not a confirmed absence. Retry.`,
        retryable: true,
        retryAfterSeconds: 30,
        upstreamEndpoint: "sam:opps/v2/opportunities",
      });
    }
    // LIVE-GROUNDED mapping (re-verified 2026-07-04): a real 32-hex id → 200 +
    // data2.title, STABLE; the endpoint's ABSENT vocabulary (across ~20 bogus/
    // malformed/hostile ids, incl. SQLi/XSS/traversal) is STRICTLY:
    //   • 401 UNAUTHORIZED "Error occured while get..." (most bogus/malformed ids)
    //   • 400 BAD_REQUEST  "Record not found / Invalid request data"
    //   • 404 (documented not-found)
    // and its OUTAGE vocabulary is 5xx (a hostile payload live-returned a 502).
    // 403 was NEVER emitted; a 403 here would be a CDN/WAF block = an OUTAGE, not
    // an absence. So ONLY the three CONFIRMED absent statuses {400,401,404} → null
    // (→ wrapper found:false); 429 → rate_limited (a retryable throttle, not an
    // absence); and EVERY OTHER non-2xx — 403, other 4xx (410/422/451/…), all 5xx,
    // network, timeout, hollow-200 — THROWS upstream_unavailable. This honors the
    // invariant "a DOWN service must NEVER read as absent" and errs toward
    // retryable-outage for any ambiguous status (the safe direction: a spurious
    // "retry" is far less harmful than a fabricated "does not exist").
    if (r.status === 429) {
      throw new ToolErrorCarrier({
        kind: "rate_limited",
        message: `SAM detail endpoint rate-limited (HTTP 429) for ${noticeId}. Retry after a short back-off.`,
        retryable: true,
        retryAfterSeconds: 30,
        upstreamStatus: 429,
        upstreamEndpoint: "sam:opps/v2/opportunities",
      });
    }
    if (r.status === 400 || r.status === 401 || r.status === 404) return null;
    if (!r.ok) {
      throw new ToolErrorCarrier({
        kind: "upstream_unavailable",
        message: `SAM detail endpoint returned HTTP ${r.status} for ${noticeId} — the service is unavailable, NOT a confirmed absence. Retry.`,
        retryable: true,
        retryAfterSeconds: 60,
        upstreamStatus: r.status,
        upstreamEndpoint: "sam:opps/v2/opportunities",
      });
    }
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
    let detail: DetailResp;
    try {
      detail = (await r.json()) as DetailResp;
    } catch (err) {
      // A 200 whose body won't parse is a hollow/degraded response (CDN/proxy),
      // NOT a genuine absence — classify as a retryable outage.
      throw new ToolErrorCarrier({
        kind: "upstream_unavailable",
        message: `SAM detail endpoint returned HTTP 200 for ${noticeId} but the body could not be parsed as JSON (${(err as Error).message}) — hollow/degraded response, NOT a confirmed absence. Retry.`,
        retryable: true,
        retryAfterSeconds: 60,
        upstreamStatus: 200,
        upstreamEndpoint: "sam:opps/v2/opportunities",
      });
    }
    const d = detail.data2 ?? {};
    // A 200 WITHOUT a usable notice body (no data2.title) is a hollow/degraded
    // response — a CDN/proxy cached error envelope or dropped body — NOT a real
    // "this notice does not exist". Real notices are stably 200+title; absent
    // ids 401. So THROW (retryable), mirroring the searchPublic/far hollow-200
    // guards, instead of returning null (which the wrapper would render as
    // found:false — a fabricated absence over an outage).
    if (!d.title) {
      throw new ToolErrorCarrier({
        kind: "upstream_unavailable",
        message: `SAM detail returned HTTP 200 without a usable notice body (no data2.title) for ${noticeId} — hollow/degraded response, NOT a confirmed absence. Retry.`,
        retryable: true,
        retryAfterSeconds: 60,
        upstreamStatus: 200,
        upstreamEndpoint: "sam:opps/v2/opportunities",
      });
    }
    // Each enrichment sub-fetch is caught INDIVIDUALLY: an outage on one must
    // neither sink the notice (the primary fields still return) nor silently
    // zero the field (a swallowed `[]`/`""` would read as "no attachments"/"no
    // org"). We record WHICH bucket degraded so the wrapper can disclose an
    // honest `_meta.degraded` + a note ("MAY have attachments; retry — NOT a
    // confirmation it has none"), and never flag the OTHER (healthy) enrichment.
    const enrichmentDegraded: string[] = [];
    const [resourceLinks, fullParentPathName] = await Promise.all([
      this.getPublicResourceLinks(noticeId).catch((e) => {
        this.warn("resourceLinks enrichment failed", e);
        enrichmentDegraded.push("attachments");
        return [] as string[];
      }),
      d.organizationId
        ? this.getPublicOrgName(d.organizationId).catch((e) => {
            this.warn("orgName enrichment failed", e);
            enrichmentDegraded.push("organization");
            return "";
          })
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
      enrichmentDegraded: enrichmentDegraded.length
        ? enrichmentDegraded
        : undefined,
    };
  }

  /**
   * Fetch the public attachment-download URLs for a notice.
   *
   * TRUTHFULNESS (DOWN-reads-as-absent guard): this is called ONLY after the
   * detail endpoint already 200'd (the notice exists). The resources endpoint
   * then returns HTTP 200 for every real notice — a genuine NO-attachment
   * notice is 200 with an empty list. So any non-200 (or a network fault) here
   * is an OUTAGE, never a genuine "no attachments", and MUST NOT be swallowed
   * into `[]` — that would let a DOWN list-fetch read as "no documents" and an
   * AI skip a solicitation whose RFP it could have read. We THROW on non-200
   * and let a network error propagate; the caller (getOpportunityPublic / the
   * auth tier) catches it INDIVIDUALLY and records the degradation. A 200 →
   * the genuine links, which MAY be `[]` (an honest empty, disclosed as such).
   */
  private async getPublicResourceLinks(noticeId: string): Promise<string[]> {
    const url = `${PUBLIC_BASE}/opps/v3/opportunities/${encodeURIComponent(noticeId)}/resources`;
    const r = await this.fetchImpl(url, { headers: this.publicHeaders() });
    if (!r.ok) throw new Error(`resources HTTP ${r.status}`);
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
  }

  /**
   * Resolve an awarding-organization id to its canonical path/name.
   *
   * TRUTHFULNESS (same guard as getPublicResourceLinks): a genuine org with no
   * path → 200 + empty field; a non-200/network fault → an OUTAGE. Do NOT
   * swallow the outage into `""` (that reads as "no organization" when the
   * fetch was DOWN). THROW on non-200; let a network error propagate. The
   * caller catches it INDIVIDUALLY and records the degradation. A 200 → the
   * name, which MAY be `""` (an honest empty).
   */
  private async getPublicOrgName(orgId: string): Promise<string> {
    const url = `${PUBLIC_BASE}/federalorganizations/v1/organizations/${encodeURIComponent(orgId)}`;
    const r = await this.fetchImpl(url, { headers: this.publicHeaders() });
    if (!r.ok) throw new Error(`org HTTP ${r.status}`);
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

// ─── Shaping-radar pure helpers (exported for offline unit testing) ──────────

/**
 * Whole days from `now` to an ISO `responseDeadline`. Returns null when the
 * deadline is missing/unparseable (a null day count is COUNTED, never hidden —
 * the shaping radar surfaces deadline-less notices rather than dropping them).
 * Uses UTC-midnight flooring on both ends so the count is a stable whole number
 * regardless of intraday time-of-day. Negative when the deadline is in the past.
 */
export function daysUntilResponse(
  deadline: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!deadline) return null;
  const then = new Date(deadline);
  const t = then.getTime();
  if (Number.isNaN(t)) return null;
  const dayMs = 86_400_000;
  const nowUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const thenUtc = Date.UTC(
    then.getUTCFullYear(),
    then.getUTCMonth(),
    then.getUTCDate(),
  );
  return Math.round((thenUtc - nowUtc) / dayMs);
}

/**
 * Client-side response-deadline WINDOW filter for the shaping radar.
 *
 * The keyless SGS feed IGNORES rdlfrom/rdlto (VERIFIED LIVE 2026-07: a
 * notice_type=r query with rdlfrom/rdlto returns the same total and deadlines
 * outside the requested window), so a response-deadline window MUST be applied
 * over the already-fetched page and DISCLOSED (the server flags
 * `_meta.filtersDropped:["responseDeadline"]`). Bounds are inclusive ISO dates.
 *
 * A notice with NO deadline is EXCLUDED from a windowed query (it cannot be
 * proven inside the window) — the caller discloses this. When neither bound is
 * given, the page is returned unchanged (no window requested).
 */
export function applyResponseDeadlineWindow<
  T extends { responseDeadline?: string | null },
>(notices: T[], from?: string, to?: string): T[] {
  if (!from && !to) return notices;
  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;
  return notices.filter((n) => {
    if (!n.responseDeadline) return false; // no deadline ⇒ not provably in-window
    const ms = Date.parse(n.responseDeadline);
    if (Number.isNaN(ms)) return false;
    if (fromMs !== null && !Number.isNaN(fromMs) && ms < fromMs) return false;
    if (toMs !== null && !Number.isNaN(toMs) && ms > toMs) return false;
    return true;
  });
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
