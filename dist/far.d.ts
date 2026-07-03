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
export {};
//# sourceMappingURL=far.d.ts.map