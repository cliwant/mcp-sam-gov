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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
let cached;
function load() {
    if (cached)
        return cached;
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, "data", "naics-revision-changes.json"),
        join(here, "..", "src", "data", "naics-revision-changes.json"),
    ];
    for (const p of candidates) {
        try {
            const text = readFileSync(p, "utf-8");
            cached = JSON.parse(text);
            return cached;
        }
        catch {
            // try next
        }
    }
    throw new Error("naics-revision-changes.json not found. Expected at src/data/ or one level up from dist/.");
}
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
export function checkNaicsRevision(naicsCode) {
    const file = load();
    const code = (naicsCode || "").trim();
    if (!/^\d{6}$/.test(code)) {
        return {
            naics: code,
            valid_in_2022: false,
            status: "unknown",
            note: `NAICS codes must be exactly 6 digits (got '${code}'). Use usas_autocomplete_naics with a free-text description if you don't have the code.`,
            citation: file.$citationUrl,
        };
    }
    // 1. Check the stable allowlist
    if (file.stable2022Codes.includes(code)) {
        return {
            naics: code,
            valid_in_2022: true,
            status: "stable",
            note: "Code is unchanged across the 2017→2022 NAICS revision. Confirmed stable in our federal-contracting curation set.",
            citation: file.$citationUrl,
        };
    }
    // 2. Check the changes table
    const change = file.changes[code];
    if (change) {
        const status = change.changeType === "stable" ? "stable" : change.changeType;
        if (change.changeType === "renumbered") {
            return {
                naics: code,
                valid_in_2022: false,
                status,
                canonical2022: change.newCode ?? undefined,
                note: change.note,
                citation: file.$citationUrl,
            };
        }
        if (change.changeType === "split") {
            return {
                naics: code,
                valid_in_2022: false,
                status,
                splitInto: change.splitInto,
                note: change.note,
                citation: file.$citationUrl,
            };
        }
        if (change.changeType === "retired") {
            return {
                naics: code,
                valid_in_2022: false,
                status,
                note: change.note,
                citation: file.$citationUrl,
            };
        }
        if (change.changeType === "renumbered_from" || change.changeType === "split_origin") {
            return {
                naics: code,
                valid_in_2022: true,
                status,
                origin: change.oldCode,
                note: change.note,
                citation: file.$citationUrl,
            };
        }
        if (change.changeType === "stable") {
            return {
                naics: code,
                valid_in_2022: true,
                status: "stable",
                note: change.note,
                citation: file.$citationUrl,
            };
        }
    }
    // 3. Code not in our curation set — unknown status
    return {
        naics: code,
        valid_in_2022: false,
        status: "unknown",
        note: `NAICS ${code} is not in our v0.5 curation set (~60 federal-contracting-relevant codes covered). The code may be (a) UNCHANGED across revisions but not on our explicit allowlist, OR (b) outside common federal contracting use. Verify against the official Census concordance: ${file.$officialDocs["2017_to_2022"]}`,
        citation: file.$citationUrl,
    };
}
/**
 * List all stable 2022 NAICS codes in our curation set.
 * Useful for "is my code in the curated allowlist?" diagnostics.
 */
export function listStableCodes() {
    return load().stable2022Codes.slice().sort();
}
/**
 * List all known revision changes (codes that changed across NAICS revisions).
 */
export function listKnownChanges() {
    const file = load();
    return Object.entries(file.changes).map(([code, change]) => ({
        code,
        changeType: change.changeType,
        note: change.note,
    }));
}
//# sourceMappingURL=naics-crosswalk.js.map