/**
 * eCFR (Electronic Code of Federal Regulations) wrappers (keyless).
 *
 * eCFR is the up-to-date version of the CFR — Title 48 = FAR (Federal
 * Acquisition Regulation), Title 2 = Federal financial assistance, etc.
 * For a federal contractor, eCFR is the primary source for regulation
 * text the agent should quote when answering compliance questions.
 *
 * Endpoints:
 *   - /versioner/v1/titles.json — list 50 CFR titles + last-amended dates
 *   - /search/v1/results — full-text search across the entire CFR
 *
 * Both keyless. Documented at https://www.ecfr.gov/developers/.
 */
export declare function listTitles(): Promise<{
    titles: {
        number: number;
        name: string;
        latestAmendedOn: string | undefined;
        latestIssueDate: string | undefined;
        upToDateAsOf: string | undefined;
        reserved: boolean;
    }[];
}>;
export declare function search(args: {
    query: string;
    titleNumber?: number;
    perPage?: number;
}): Promise<{
    results: {
        type: string;
        title: string;
        chapter: string | undefined;
        part: string | undefined;
        subpart: string | undefined;
        section: string | undefined;
        headingPath: string;
        excerpt: string;
        score: number;
        ecfrUrl: string;
        effectiveOn: string;
    }[];
}>;
//# sourceMappingURL=ecfr.d.ts.map