/**
 * Core types for the @cliwant/mcp-sam-gov/sam-gov client. Mirrors the shapes
 * returned by SAM.gov's two endpoint layers (authenticated v2 and
 * the keyless public HAL endpoints) under one normalized contract.
 */
export type SamProcurementType = "u" | "p" | "a" | "r" | "s" | "o" | "g" | "k" | "i";
export type SamSetAside = "SBA" | "SBP" | "8A" | "8AN" | "HZC" | "HZS" | "SDVOSBC" | "SDVOSBS" | "WOSB" | "WOSBSS" | "EDWOSB" | "EDWOSBSS" | "LAS" | "IEE" | "ISBEE" | "BICiv" | "VSA" | "VSS";
export type SamLocation = {
    streetAddress?: string;
    streetAddress2?: string;
    city?: {
        code?: string;
        name?: string;
    };
    state?: {
        code?: string;
        name?: string;
    };
    zip?: string;
    country?: {
        code?: string;
        name?: string;
    };
};
export type SamPointOfContact = {
    type?: string;
    title?: string;
    fullName?: string;
    email?: string;
    phone?: string;
    fax?: string | null;
};
export type SamOpportunity = {
    noticeId: string;
    title: string;
    solicitationNumber?: string;
    fullParentPathName?: string;
    fullParentPathCode?: string;
    postedDate?: string;
    type?: string;
    baseType?: string;
    archiveType?: string;
    archiveDate?: string | null;
    typeOfSetAsideDescription?: string | null;
    typeOfSetAside?: string | null;
    responseDeadLine?: string | null;
    naicsCode?: string | null;
    classificationCode?: string | null;
    active?: "Yes" | "No";
    pointOfContact?: SamPointOfContact[] | null;
    description?: string;
    placeOfPerformance?: SamLocation | null;
    uiLink?: string;
    resourceLinks?: string[] | null;
};
export type SamSearchFilters = {
    query?: string;
    /** MM/DD/YYYY (auth endpoint convention). */
    postedFrom?: string;
    postedTo?: string;
    ptype?: SamProcurementType[];
    ncode?: string;
    setAside?: SamSetAside[];
    organizationName?: string;
    state?: string;
    zip?: string;
    responseDeadlineFrom?: string;
    responseDeadlineTo?: string;
    active?: boolean;
    limit?: number;
    offset?: number;
};
export type SamSearchResult = {
    totalRecords: number;
    limit: number;
    offset: number;
    opportunitiesData: SamOpportunity[];
};
export type EntitySearchResult = {
    entities: Array<{
        ueiSAM: string;
        legalBusinessName: string;
        cageCode?: string;
        physicalAddress?: {
            city?: string;
            stateOrProvinceCode?: string;
        };
        naics?: string[];
        setAsides?: string[];
        activeRegistration?: boolean;
    }>;
    totalRecords: number;
};
export type SamGovClientOptions = {
    /** SAM.gov public API key. Optional — keyless public endpoints
     *  cover ~95% of opportunity discovery without one. Set when you
     *  need the higher rate limit + the full historical archive. */
    apiKey?: string;
    /** Override the User-Agent the client sends to SAM.gov. */
    userAgent?: string;
    /** Override the underlying fetch (e.g. with `node-fetch` polyfill or
     *  a wrapper for caching/retries). Defaults to global `fetch`. */
    fetch?: typeof fetch;
    /** Optional logger (defaults to a noop). */
    logger?: {
        warn?: (msg: string, err?: unknown) => void;
    };
};
//# sourceMappingURL=types.d.ts.map