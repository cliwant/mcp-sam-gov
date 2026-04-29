/**
 * @govicon/sam-gov — keyless SAM.gov client.
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
import type { EntitySearchResult, SamGovClientOptions, SamOpportunity, SamSearchFilters, SamSearchResult } from "./types.js";
export declare class SamGovClient {
    private readonly apiKey?;
    private readonly userAgent;
    private readonly fetchImpl;
    private readonly logger;
    constructor(options?: SamGovClientOptions);
    /**
     * Search SAM.gov opportunities.
     *
     * Three-tier fallback:
     *   1. Authenticated v2 search (if `apiKey` configured)
     *   2. Keyless HAL search
     *   3. Empty result (caller can decide how to surface "no data")
     */
    searchOpportunities(filters: SamSearchFilters): Promise<SamSearchResult>;
    /**
     * Resolve a single opportunity by `noticeId` (32-char hex).
     *
     * Three-tier fallback:
     *   1. Authenticated v2 search filtered by noticeId (if key)
     *   2. Keyless detail endpoint + resources + org enrichment
     *   3. null
     */
    getOpportunity(noticeId: string): Promise<SamOpportunity | null>;
    /**
     * Fetch the full description body for an opportunity.
     *
     * Handles three input shapes:
     *   1. Already-extracted text (no `http://`) — pass-through
     *   2. `api.sam.gov/.../v1/api/getDescription/...` — append `?api_key=`
     *   3. Public sam.gov URL — HAL headers, no key
     */
    fetchOpportunityDescription(input: string): Promise<string>;
    /**
     * Look up registered SAM.gov entities by legal business name.
     * Requires an API key (the entity registration API has no public
     * keyless mirror — it's the one place BYOK is genuinely needed).
     */
    searchEntities(query: string): Promise<EntitySearchResult>;
    /**
     * Build the keyless download URL for an attachment, given the
     * resourceId from getPublicResourceLinks(). Returns a 303 redirect
     * to a signed S3 URL when fetched. Useful for embedding viewers.
     */
    publicDownloadUrl(resourceId: string): string;
    private buildAuthSearchUrl;
    private searchPublic;
    private getOpportunityPublic;
    private getPublicResourceLinks;
    private getPublicOrgName;
    private publicHeaders;
    private warn;
}
//# sourceMappingURL=client.d.ts.map