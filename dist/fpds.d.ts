/**
 * FPDS-NG (Federal Procurement Data System) — federal contract AWARD-ACTION
 * records from the keyless public ATOM feed. The FIRST XML/ATOM source in the
 * server (everything else is JSON via the getJson port; ADR-0012).
 *
 * WHY THIS EXISTS
 * ---------------
 * FPDS-NG is the AUTHORITATIVE system-of-record for federal contract ACTIONS
 * (each modification is its own transaction). USAspending.gov DERIVES its
 * contract data FROM FPDS via a nightly ETL — it lags FPDS by 1-2 days and
 * reshapes/enriches fields (sub-awards, Treasury-account linkage, a synthetic
 * unique award id). This tool closes the "action-level / mod-level latest-truth"
 * gap our usas_* tools (the transformed, lagged derivative) cannot.
 *
 * LIVE-VERIFIED 2026-07-12 (keyless, real HTTP probes, no key/cookie/session):
 *   GET https://www.fpds.gov/ezsearch/FEEDS/ATOM?FEEDNAME=PUBLIC&templateName=1.5.3&q=<Q>&start=<N>
 *   → HTTP 200 application/xml, an Atom 1.0 <feed>. Page size is FIXED at 10.
 *   The legacy ezSearch HTML variant (/ezsearch/search.do?...&feed=ATOM) 301s to
 *   sam.gov — the concrete justification for redirect:"error" + host-pinning.
 *
 * XML PARSE (bounded, fuzz-safe, dependency-free — the far.ts/gao.ts lineage):
 *   - entry slicer is an indexOf WALK ONLY (never a lazy regex — O(N) not O(N^2)
 *     on an unterminated <entry>), capped at MAX_ENTRIES.
 *   - leaf/attribute extractors are anchored, character-class ([^<]/[^"]) bounded
 *     regexes — no nested quantifiers, ReDoS-safe by construction.
 *   - attribute extraction is ELEMENT-SCOPED (M2): the attr is read from THAT
 *     element's own attr string, never a global description="…" scan (many FPDS
 *     elements share the `description`/`name` attribute names).
 *
 * HONESTY (the whole reason to ship this): the advertised total is a LOWER BOUND
 * (±10) for >10 results, keyless deep-paging is capped (~200K) far below the
 * advertised total, and a typo'd field name is a SILENT ZERO. All disclosed via
 * totalIsLowerBound + _meta.notes; hasMore is page-fullness (never offset<total).
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export type FpdsSearchArgs = {
    naics?: string;
    vendorName?: string;
    piid?: string;
    departmentId?: string;
    contractingAgencyName?: string;
    signedDateFrom?: string;
    signedDateTo?: string;
    lastModifiedFrom?: string;
    lastModifiedTo?: string;
    keyword?: string;
    offset?: number;
};
/** Build the fielded `q` string from structured filters (AND-combined by space). */
export declare function buildQuery(args: FpdsSearchArgs): {
    q: string;
    filters: string[];
    dropped: string[];
};
/**
 * Construct the SSRF-safe feed URL. Everything except `q`+`start` is fixed
 * (host, path, FEEDNAME, templateName); the caller-influenced values go through
 * URLSearchParams (which percent-encodes ` " : [ ] , & #`), so a value can add
 * a query param but CANNOT alter the host or path. Then a belt-and-suspenders
 * hostname/protocol assertion (verbatim ckan.ts pattern).
 */
export declare function buildSearchUrl(q: string, start: number): string;
export type FpdsAward = {
    recordType: "award" | "idv";
    title: string | null;
    piid: string | null;
    modNumber: string | null;
    parentIdvPiid: string | null;
    actionType: string | null;
    reasonForModification: string | null;
    signedDate: string | null;
    contractingDepartmentId: string | null;
    contractingDepartmentName: string | null;
    contractingOfficeAgencyId: string | null;
    contractingOfficeAgencyName: string | null;
    vendorName: string | null;
    vendorUei: string | null;
    ultimateParentUei: string | null;
    ultimateParentUeiName: string | null;
    cageCode: string | null;
    vendorCity: string | null;
    vendorState: string | null;
    businessSize: string | null;
    obligatedAmount: number | null;
    totalObligatedAmount: number | null;
    baseAndAllOptionsValue: number | null;
    naics: string | null;
    naicsDescription: string | null;
    psc: string | null;
    pscDescription: string | null;
    description: string | null;
    placeOfPerformanceState: string | null;
    placeOfPerformanceCity: string | null;
    extentCompeted: string | null;
    offersReceived: number | null;
    setAside: string | null;
    socioeconomic: {
        smallBusiness: boolean | null;
        womenOwned: boolean | null;
        veteranOwned: boolean | null;
    };
    fpdsHtmlUrl: string | null;
};
export declare function searchAwards(args: FpdsSearchArgs): Promise<MetaBundle>;
//# sourceMappingURL=fpds.d.ts.map