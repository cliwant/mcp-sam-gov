/**
 * nist-controls.ts — NIST SP 800-53 Rev 5 security & privacy CONTROLS catalog
 * (OSCAL, keyless). The cyber-compliance controls backbone for FedRAMP / CMMC / RMF
 * work: look up a control (AC-2, SC-7, …) or a family (Access Control, System &
 * Communications Protection, …) and get its title, requirement STATEMENT, discussion
 * guidance, and control enhancements. No other tool here exposes the controls catalog
 * (we have NVD CVEs + CISA KEV, but not the requirement side).
 *
 * SOURCE: NIST's OFFICIAL OSCAL content, published at github.com/usnistgov/oscal-content
 * (the canonical machine-readable release; the .gov PDF is the human copy). NOT a
 * .gov API host, so provenance is disclosed on every response (the ProPublica /
 * CourtListener / get.gov republisher idiom — here NIST is the first-party author).
 *
 * PATTERN: the CISA-KEV static-file idiom (nvd.ts) — a fixed-host const URL fetched
 * via getJson (redirect:"error" + 30s timeout), memoized 6h, with a plausibility
 * FLOOR (a truncated catalog must NEVER read as "control not found"), then
 * client-side filter/lookup. An outage/4xx/timeout THROWS (never a fake empty).
 *
 * SSRF: fixed host `raw.githubusercontent.com` + a fixed, pinned path (no free
 * host/path). Filtering is CLIENT-SIDE over the parsed catalog.
 */
import { getJson, driftError } from "./datasource.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
export const OSCAL_HOST = "raw.githubusercontent.com";
const OSCAL_URL = "https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json";
const OSCAL_LABEL = "nist-oscal:sp800-53r5";
const OSCAL_TIMEOUT_MS = 30_000;
const OSCAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// Plausibility floor: 800-53 Rev5 has 20 control families and ~1000 controls. A
// truncated catalog with far fewer must THROW, never read as "control not found".
const FAMILY_FLOOR = 15;
const PROVENANCE_NOTE = "Source: NIST SP 800-53 Rev 5 OSCAL catalog, published at github.com/usnistgov/oscal-content (NIST's canonical machine-readable release; authoritative first-party data served from GitHub, not a .gov API host).";
const CLIENT_FILTER_NOTE = "The catalog has no query API — the full published OSCAL JSON is fetched (cached 6h) and filtered CLIENT-SIDE (controlId exact, family exact, keyword = case-insensitive substring over title+statement). totalAvailable is the EXACT match count.";
const REFERENCE_NOTE = "This is the REQUIREMENT catalog (control text), NOT an assessment or an authorization. A control's applicability depends on the system's FIPS-199 impact baseline (Low/Moderate/High) and overlay — which this catalog does not encode.";
/** OSCAL control id ("ac-2", "ac-2.1") → display id ("AC-2", "AC-2(1)"). */
function displayId(rawId) {
    const m = /^([a-z]+)-(\d+)(?:\.(\d+))?$/i.exec(rawId.trim());
    if (!m)
        return rawId.toUpperCase();
    const fam = (m[1] ?? "").toUpperCase();
    // Strip leading zeros so a zero-padded input ('AC-02') normalizes to the catalog's
    // canonical unpadded form ('AC-2') — else an exact controlId lookup would miss.
    const num = String(Number(m[2] ?? "0"));
    const enh = m[3] !== undefined ? String(Number(m[3])) : undefined;
    return enh !== undefined ? `${fam}-${num}(${enh})` : `${fam}-${num}`;
}
/** Recursively collect a statement part's prose as labelled, indented lines. */
function collectProse(part, depth, out) {
    const label = part.props?.find((p) => p.name === "label")?.value;
    const indent = "  ".repeat(depth);
    const prefix = label ? `${label} ` : "";
    if (part.prose && part.prose.trim().length > 0) {
        out.push(`${indent}${prefix}${part.prose.trim()}`);
    }
    else if (label) {
        out.push(`${indent}${prefix}`.trimEnd());
    }
    for (const sub of part.parts ?? [])
        collectProse(sub, depth + 1, out);
}
function partProse(control, name) {
    const part = (control.parts ?? []).find((p) => p.name === name);
    if (!part)
        return null;
    const out = [];
    collectProse(part, 0, out);
    const text = out.join("\n").trim();
    return text.length > 0 ? text : null;
}
function mapControl(control, family) {
    return {
        id: displayId(control.id ?? ""),
        family,
        title: (control.title ?? "").trim(),
        statement: partProse(control, "statement") ?? "",
        guidance: partProse(control, "guidance"),
        enhancements: (control.controls ?? []).map((e) => ({
            id: displayId(e.id ?? ""),
            title: (e.title ?? "").trim(),
        })),
    };
}
/**
 * Fetch + parse the OSCAL catalog into a flat list of TOP-LEVEL controls, memoized
 * 6h. Header/shape guarded: `catalog.groups` MUST be an array with ≥ FAMILY_FLOOR
 * families (else driftError — a truncated catalog is NEVER a fake empty). Enhancements
 * are carried on each control (not indexed as top-level entries).
 */
async function loadControls() {
    return memoize("nist:sp800-53r5", async () => {
        const built = new URL(OSCAL_URL);
        if (built.hostname !== OSCAL_HOST || built.protocol !== "https:") {
            throw driftError(OSCAL_LABEL, `Constructed OSCAL URL host ${JSON.stringify(built.hostname)} is not ${OSCAL_HOST} over https — refusing to fetch (SSRF safety).`);
        }
        const body = (await getJson(OSCAL_URL, {
            label: OSCAL_LABEL,
            redirect: "error",
            timeoutMs: OSCAL_TIMEOUT_MS,
        }));
        const groups = body.catalog?.groups;
        if (!Array.isArray(groups) || groups.length < FAMILY_FLOOR) {
            throw driftError(OSCAL_LABEL, `OSCAL catalog.groups missing or implausibly small (${Array.isArray(groups) ? groups.length : "not-an-array"} < ${FAMILY_FLOOR} families) — treating as schema drift / truncation, never a fake-empty catalog.`);
        }
        const controls = [];
        for (const g of groups) {
            const family = `${(g.id ?? "").toUpperCase()} — ${(g.title ?? "").trim()}`;
            for (const c of g.controls ?? [])
                controls.push(mapControl(c, family));
        }
        return controls;
    }, OSCAL_CACHE_TTL_MS);
}
// ─── Tool: nist_800_53_controls ───────────────────────────────────
/**
 * Look up NIST SP 800-53 Rev 5 controls by controlId (exact, e.g. "AC-2"), family
 * (exact family letter or name, e.g. "AC" / "Access Control"), and/or keyword
 * (case-insensitive substring over title + statement). Client-side filters over the
 * cached OSCAL catalog; honest `_meta` (exact match total; provenance disclosed).
 */
export async function searchControls(args) {
    const limit = args.limit ?? 25;
    const offset = args.offset ?? 0;
    const all = await loadControls();
    const filtersApplied = [];
    const idQ = args.controlId !== undefined ? displayId(args.controlId) : undefined;
    const famQ = args.family?.trim().toLowerCase();
    const kwQ = args.keyword?.trim().toLowerCase();
    if (args.controlId !== undefined)
        filtersApplied.push("controlId");
    if (args.family !== undefined)
        filtersApplied.push("family");
    if (args.keyword !== undefined)
        filtersApplied.push("keyword");
    const matched = all.filter((c) => {
        if (idQ && c.id.toUpperCase() !== idQ.toUpperCase())
            return false;
        if (famQ) {
            // family field is "AC — Access Control"; match either the letter code or a
            // substring of the title (both case-insensitive).
            const fam = c.family.toLowerCase();
            const code = (fam.split("—")[0] ?? "").trim();
            if (code !== famQ && !fam.includes(famQ))
                return false;
        }
        if (kwQ) {
            // Search the title + requirement statement AND each enhancement's title, so a
            // term that lives only in an enhancement (e.g. "multi-factor" → IA-2(1)) still
            // surfaces the parent control. filtersApplied still lists 'keyword'.
            const hay = `${c.title}\n${c.statement}\n${c.enhancements.map((e) => e.title).join("\n")}`.toLowerCase();
            if (!hay.includes(kwQ))
                return false;
        }
        return true;
    });
    const totalAvailable = matched.length;
    const page = matched.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    return withMeta({ controls: page }, {
        source: "NIST SP 800-53 Rev 5 (OSCAL catalog, keyless)",
        keylessMode: true,
        returned,
        totalAvailable,
        truncated: hasMore,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes: [PROVENANCE_NOTE, CLIENT_FILTER_NOTE, REFERENCE_NOTE],
    });
}
//# sourceMappingURL=nist-controls.js.map