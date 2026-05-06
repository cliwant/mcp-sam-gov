/**
 * NAICS revision crosswalk — keyless, embedded.
 *
 * Source: Census Bureau NAICS concordance files
 * (https://www.census.gov/naics/concordances/).
 *
 * Why embedded: Census doesn't publish a clean JSON/CSV API for the
 * concordance. The official files are Excel sheets. Embedding a
 * curated JSON keeps the lookup keyless, deterministic, fast.
 *
 * Coverage: v0.5 covers federal-contracting-relevant changes from
 * 2017→2022 (the most recent revision) plus the historic 2002→2007
 * retirement of 541510 (still cited in some old SOWs). Most
 * 5xxxxx services NAICS were unchanged in 2022.
 *
 * For codes not in this table:
 *   - If listed in `stable2022Codes` → confirmed stable, no change needed.
 *   - Otherwise → either stable-but-not-on-the-allowlist, OR not in our
 *     federal-contracting curation set. Caller should fall back to
 *     Census concordance file at the official URL.
 */
export type NaicsRevisionCheck = {
    naics: string;
    valid_in_2022: boolean;
    status: "stable" | "renumbered" | "split" | "retired" | "renumbered_from" | "split_origin" | "unknown";
    /** Canonical 2022 equivalent if the input was an OLD code that got renumbered. */
    canonical2022?: string;
    /** Pre-2022 origin if the input is a NEW code that came from a renumber/split. */
    origin?: string;
    /** When status === "split", the list of 2022 codes the OLD one was distributed across. */
    splitInto?: string[];
    /** Human-readable explanation of the change. */
    note: string;
    /** Source citation URL (Census concordance). */
    citation: string;
};
/**
 * Check whether a NAICS code is valid in NAICS 2022, and surface
 * any historical change.
 *
 * Returns:
 *   - `valid_in_2022: true` if the code is in our stable allowlist OR is
 *     a 2022-vintage code that exists in the changes table.
 *   - `valid_in_2022: false` if the code is in the changes table as
 *     retired or renumbered FROM (i.e. it's an old code that's been
 *     replaced) — in which case `canonical2022` names the 2022
 *     successor where applicable.
 *   - `status: "unknown"` if the code is not in our curation set.
 *     Caller should fall back to Census's full concordance.
 */
export declare function checkNaicsRevision(naicsCode: string): NaicsRevisionCheck;
/**
 * List all stable 2022 NAICS codes in our curation set.
 * Useful for "is my code in the curated allowlist?" diagnostics.
 */
export declare function listStableCodes(): string[];
/**
 * List all known revision changes (codes that changed across NAICS revisions).
 */
export declare function listKnownChanges(): Array<{
    code: string;
    changeType: string;
    note: string;
}>;
//# sourceMappingURL=naics-crosswalk.d.ts.map