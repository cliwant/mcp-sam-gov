/**
 * get.gov — the authoritative US .gov domain registry (CISA). KEYLESS.
 *
 * The .gov program (run by CISA) publishes the COMPLETE registry as CSVs in its
 * official repo github.com/cisagov/dotgov-data — the canonical published location
 * (get.gov links there; there is no query API for the full set). It is NOT a .gov
 * API host, so provenance is disclosed on every response (the ProPublica /
 * CourtListener republisher pattern — except here CISA is the first-party registrar).
 *
 * B2G value: resolve WHICH organization owns a .gov domain, enumerate federal
 * agencies, and MAP SLED entities (state / county / city / school-district /
 * special-district / tribal) for market targeting — a distinct authoritative
 * gov-org registry no other tool here exposes.
 *
 * SSRF: fixed host `raw.githubusercontent.com` + fixed path prefix
 * `/cisagov/dotgov-data/main/` + a scope-selected FIXED filename (federal | full) —
 * no free host, path, or filename. `redirect:"error"` on the fetch.
 *
 * PII: the CSV carries a "Security contact email" column (an ORG security mailbox,
 * e.g. security@agency.gov). We DROP it — this tool resolves ORGANIZATIONS, not
 * contacts, and excluding it keeps the output free of contact info.
 *
 * Filtering is CLIENT-SIDE over the full published CSV (the registry has no query
 * API) — disclosed in `_meta.notes`. `totalAvailable` is the EXACT match count.
 */
import { type MetaBundle } from "./meta.js";
export declare const DOTGOV_HOST = "raw.githubusercontent.com";
declare const DOTGOV_FILES: {
    readonly all: "current-full.csv";
    readonly federal: "current-federal.csv";
};
export type GovDomainScope = keyof typeof DOTGOV_FILES;
export type GovDomainRow = {
    domain: string;
    domainType: string;
    organization: string;
    suborganization: string | null;
    city: string | null;
    state: string | null;
};
/**
 * Parse a full CSV document into rows of string fields. Handles double-quoted
 * fields, escaped `""` quotes, and commas/newlines INSIDE quotes. Self-contained
 * (no external dep) — the get.gov CSV is small (~1.4 MB) so a whole-string parse is
 * fine. Returns every record's raw field array (including the header row).
 */
export declare function parseCsv(text: string): string[][];
/**
 * Search the CISA get.gov .gov domain registry. Client-side filters over the
 * published CSV: organization/domain/city are case-insensitive SUBSTRING matches;
 * state (2-letter) and domainType are case-insensitive. scope 'all' (federal + SLED,
 * default) | 'federal'. Honest `_meta` (exact match total; provenance + client-side
 * disclosure).
 */
export declare function searchGovDomains(args: {
    scope?: GovDomainScope;
    organization?: string;
    domain?: string;
    domainType?: string;
    state?: string;
    city?: string;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
export {};
//# sourceMappingURL=gov-domains.d.ts.map