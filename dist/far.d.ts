/**
 * FAR / DFARS clause lookup (keyless) — the authoritative clause text + its
 * prescription, from the eCFR **versioner full** endpoint.
 *
 * Why this exists (and why NOT `ecfr_search`)
 * -------------------------------------------
 * The shipped full-text `ecfr_search` mis-ranks EXACT clause numbers: a bare
 * `52.212-4` query returns GSAM **552**.212-4 above the real FAR 52.212-4
 * (doc-09 §1.2). A proposal writer needs the AUTHORITATIVE clause text AND the
 * rule that says WHEN it applies ("As prescribed in …") — the exact pair. The
 * clean path is the versioner full endpoint, which `src/ecfr.ts` does not call:
 *
 *   GET /api/versioner/v1/full/{date}/title-48.xml?section={clause}
 *
 * keyless, HTTP 200 (~40 KB XML) for a real clause, clean HTTP 404
 * `{"error":"No matching content found."}` for an absent one. Title 48 = FAR.
 * `{date}` defaults to Title 48 `up_to_date_as_of` (from listTitles, cached).
 *
 * TRUTHFULNESS invariants (a reviewer WILL try to break these):
 *   - A DOWN/failing eCFR service must NEVER read as "clause not found": only a
 *     genuine HTTP 404 maps to `not_found`; any other fetch error propagates
 *     with fetchWithRetry's classification (retryable 5xx/network/etc.).
 *   - A genuinely-absent clause is `not_found` (retryable:false), NEVER a fake
 *     empty clause. Clause text is never silently dropped or fabricated.
 *   - A prescription-section fetch failure is NON-FATAL: `prescription:null` +
 *     disclosed in `_meta.notes`; it never crashes the clause result.
 *   - `farOverhaulRisk` carries NO fabricated FAR-case numbers/dates — only the
 *     fixed structural caveat + the real authoritative-list / deviation URLs.
 *
 * Self-contained: imports only fetchWithRetry (+ ToolErrorCarrier) from
 * ./errors.js, memoize from ./cache.js, listTitles from ./ecfr.js, and withMeta
 * from ./meta.js — the versioner XML parse lives here (ecfr.ts's stripHtml is
 * private and stays private).
 */
/** The regulation family a clause number belongs to (from its prefix). */
type Regulation = "FAR" | "DFARS" | "GSAM" | "other";
/**
 * The RFO (Revolutionary FAR Overhaul) currency caveat — an ALWAYS-PRESENT
 * structural flag, NOT a per-clause claim. eCFR reflects the CODIFIED FAR only;
 * the RFO is replacing FAR parts via agency class deviations that may not appear
 * in eCFR, so a clause can be current in the CFR yet operationally superseded.
 *
 * This is the HONEST design (doc-09 §3 baked unverified FAR-case numbers/dates
 * as [가설] — those go stale/wrong). We ship the never-stale-wrong version: no
 * fabricated specifics, only the fixed caveat + the real authoritative-list and
 * deviation URLs (all VERIFIED HTTP 200, 2026-07-04). `appliesTo` scopes the
 * caveat to the clause's own regulation family.
 */
declare function buildFarOverhaulRisk(regulation: Regulation): {
    note: string;
    authoritativeList: string;
    deviationSources: string[];
    appliesTo: Regulation;
};
export declare function farClauseLookup(args: {
    clauseNumber: string;
    includePrescription?: boolean;
    asOfDate?: string;
}): Promise<import("./meta.js").MetaBundle<{
    clauseNumber: string;
    kind: "clause" | "provision";
    regulation: Regulation;
    heading: string | null;
    revision: string | null;
    text: string;
    prescribedIn: string | null;
    prescription: {
        section: string;
        heading: string | null;
        text: string;
    } | null;
    ecfrUrl: string;
    asOfDate: string;
    titleUpToDateAsOf: string | null;
    titleLatestAmendedOn: string | null;
    isCurrent: boolean;
    farOverhaulRisk: {
        note: string;
        authoritativeList: string;
        deviationSources: string[];
        appliesTo: Regulation;
    };
}>>;
/** One resolved matrix row: farClauseLookup's honest fields + a gate flag. */
type MatrixRow = {
    clauseNumber: string;
    kind: "clause" | "provision";
    regulation: Regulation;
    heading: string | null;
    revision: string | null;
    prescribedIn: string | null;
    prescription: {
        section: string;
        heading: string | null;
        text: string;
    } | null;
    text: string;
    ecfrUrl: string;
    farOverhaulRisk: ReturnType<typeof buildFarOverhaulRisk>;
    /** The eligibility-gate label (from GATE_MAP), or null when not a mapped gate. */
    gate: string | null;
};
/** A clause that did not resolve, with a disclosed reason. */
type UnresolvedClause = {
    clauseNumber: string;
    reason: string;
};
export declare function farComplianceMatrix(args: {
    clauses: string[];
    asOfDate?: string;
    includePrescription?: boolean;
    flagGates?: boolean;
}): Promise<import("./meta.js").MetaBundle<{
    asOfDate: string;
    rows: MatrixRow[];
    unresolved: UnresolvedClause[];
    errored: UnresolvedClause[];
    summary: {
        total: number;
        resolved: number;
        unresolved: number;
        errored: number;
        far: number;
        dfars: number;
        gsam: number;
        other: number;
        gates: number;
    };
}>>;
/** Which regulation family a far_search scope targets. */
type FarSearchScope = "far" | "dfars" | "both";
/** One far_search result row. */
type FarSearchRow = {
    regulation: Regulation;
    type: string;
    /** The FAR/DFARS part as a number (null if unparseable), for partsOnly. */
    part: number | null;
    section: string;
    headingPath: string;
    excerpt: string;
    score: number;
    ecfrUrl: string;
    effectiveOn: string;
    endsOn: string | null;
    /** endsOn==null ⇒ the CURRENT (in-force) version; false ⇒ a kept historical. */
    isCurrent: boolean;
};
export declare function farSearch(args: {
    query: string;
    scope?: FarSearchScope;
    dedupeVersions?: boolean;
    partsOnly?: number[];
    perPage?: number;
}): Promise<import("./meta.js").MetaBundle<{
    query: string;
    scope: FarSearchScope;
    rows: FarSearchRow[];
    returned: number;
    distinctSections: number;
    titleUpToDateAsOf: string | null;
    farOverhaulRisk: {
        note: string;
        authoritativeList: string;
        deviationSources: string[];
        appliesTo: Regulation;
    };
}>>;
export {};
//# sourceMappingURL=far.d.ts.map