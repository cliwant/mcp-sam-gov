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
import { fetchWithRetry } from "./errors.js";
import { driftError } from "./datasource.js";
import { memoize } from "./cache.js";
import { withMeta } from "./meta.js";
const ECFR = "https://www.ecfr.gov/api";
// eCFR's /search/v1/results `meta.total_count` is capped by Elasticsearch's
// `index.max_result_window` (live-verified 10,000). A total AT OR ABOVE this
// sentinel is a LOWER BOUND, not an exact count — see the totalIsLowerBound
// wiring in `search` (D1). A genuine count below this stays exact.
const ECFR_TOTAL_COUNT_CAP = 10000;
async function fetchJson(url) {
    const r = await fetchWithRetry(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
    }, `ecfr:${url.split("/api/")[1] ?? url}`);
    return (await r.json());
}
export async function listTitles() {
    // 50 CFR titles change very infrequently. Cache aggressively (5 min).
    return memoize("ecfr:titles", async () => {
        const json = await fetchJson(`${ECFR}/versioner/v1/titles.json`);
        const titles = (json.titles ?? []).map((t) => ({
            number: t.number ?? 0,
            name: t.name ?? "",
            latestAmendedOn: t.latest_amended_on,
            latestIssueDate: t.latest_issue_date,
            upToDateAsOf: t.up_to_date_as_of,
            reserved: !!t.reserved,
        }));
        // Carry the honesty envelope every other tool has (dogfooding 2026-07-15: this
        // list tool previously returned a bare {titles} with no _meta). The titles
        // endpoint returns the COMPLETE canonical CFR title set in one response — no
        // pagination, no filter — so the count IS the total and complete derives true.
        return withMeta({ titles }, {
            source: "ecfr.gov/api (versioner/v1/titles)",
            keylessMode: true,
            returned: titles.length,
            totalAvailable: titles.length,
            truncated: false,
            filtersApplied: [],
            filtersDropped: [],
            notes: [
                "Complete canonical list of all CFR titles — the endpoint returns every title in a single response (no pagination or filtering).",
            ],
        });
    });
}
export async function search(args) {
    const url = new URL(`${ECFR}/search/v1/results`);
    url.searchParams.set("query", args.query);
    url.searchParams.set("per_page", String(args.perPage ?? 5));
    if (args.titleNumber) {
        // eCFR search filter: hierarchy[title]=N (NOT just title=N — that's
        // an "unpermitted parameter" error from the eCFR API).
        url.searchParams.set("hierarchy[title]", String(args.titleNumber));
    }
    // Optional chapter filter (additive; existing ecfr_search callers pass none).
    // Within Title 48: chapter 1 = FAR, chapter 2 = DFARS, chapter 5 = GSAM, etc.
    // This is what lets far_search scope to FAR/DFARS and keep GSAM/agency
    // supplements out server-side. Same hierarchy[…] contract as the title filter.
    if (args.chapter !== undefined) {
        url.searchParams.set("hierarchy[chapter]", String(args.chapter));
    }
    const json = await fetchJson(url.toString());
    // F6 (P2 empty-vs-outage): a 200 whose `results` is PRESENT-but-non-array — or
    // a body carrying NEITHER a `results` array NOR a `meta` object — is drift / an
    // unexpected shape, NOT a genuine no-match. Throw (schema_drift) rather than
    // letting `(json.results ?? []).map` coalesce it into a fake AUTHORITATIVE empty.
    // A GENUINE empty (results:[] with meta.total_count:0) flows through honestly
    // below. (eCFR normally signals errors via HTTP status caught by fetchWithRetry;
    // this closes the previously-unhandled + untested 200-body drift path.)
    if (json.results !== undefined && !Array.isArray(json.results)) {
        throw driftError("ecfr.gov", "eCFR search returned HTTP 200 but `results` is not an array — treating it as schema drift, NOT an empty result set.");
    }
    if (json.results === undefined && json.meta === undefined) {
        throw driftError("ecfr.gov", "eCFR search returned HTTP 200 with neither a `results` array nor a `meta` object — an unexpected shape; treating it as schema drift, NOT an empty result set.");
    }
    const data = {
        results: (json.results ?? []).map((r) => ({
            type: r.type ?? "",
            title: r.hierarchy?.title ?? "",
            chapter: r.hierarchy?.chapter,
            part: r.hierarchy?.part,
            subpart: r.hierarchy?.subpart,
            section: r.hierarchy?.section,
            headingPath: Object.values(r.hierarchy_headings ?? {})
                .filter(Boolean)
                .join(" › "),
            excerpt: stripHtml(r.full_text_excerpt ?? ""),
            score: r.score ?? 0,
            // Stable ecfr.gov URL pattern from the hierarchy
            ecfrUrl: r.hierarchy
                ? buildEcfrUrl(r.hierarchy)
                : "",
            effectiveOn: r.starts_on ?? "",
            // Additive: the version's end date. null = the CURRENT (in-force) version;
            // a non-null date = a HISTORICAL version. eCFR search returns ~5 versions
            // per section; existing ecfr_search callers simply ignore this extra field,
            // while far_search uses it to collapse historical dups to the current one.
            endsOn: r.ends_on ?? null,
        })),
    };
    // Truthful `_meta` (spec §1.2 A6, §2.3). eCFR returns a hit count in
    // `meta.total_count`, BUT that count is capped by Elasticsearch's
    // `index.max_result_window` at 10,000 (a real ceiling — unlike a genuine
    // small count, a value at/above the cap is a LOWER BOUND, not an exact
    // total). Below the cap `totalAvailable` is exact (the AI can tell a top-N
    // slice from the full match set); at/above the cap we flag
    // `totalIsLowerBound:true` + a note so a broad query that truly matches
    // >10,000 sections is NOT reported as if exactly 10,000 (D1). A6: echo the
    // applied title scope so the AI can VERIFY it searched the intended corpus —
    // Title 48 (FAR) vs every CFR title — rather than silently trusting a filter
    // that could return cross-title results if the eCFR param contract ever changes.
    const returned = data.results.length;
    const totalAvailable = typeof json.meta?.total_count === "number" ? json.meta.total_count : null;
    // eCFR's search total_count saturates at the Elasticsearch max_result_window
    // (live-verified 10,000). Use `>= cap` (not `=== cap`) so a total AT OR ABOVE
    // the ceiling is treated as a lower bound — strictly safe if the window were
    // ever configured higher. Mirrors federal-register.ts's FR_COUNT_CAP and
    // edgar.ts's FTS_WINDOW.
    const totalIsLowerBound = totalAvailable !== null && totalAvailable >= ECFR_TOTAL_COUNT_CAP;
    const scopeNote = args.titleNumber !== undefined
        ? `searched CFR Title ${args.titleNumber}${args.titleNumber === 48 ? " (FAR — Federal Acquisition Regulation)" : ""} only`
        : "searched all CFR titles (no title filter applied)";
    const notes = [scopeNote];
    if (totalIsLowerBound) {
        notes.push(`eCFR caps total_count at ${ECFR_TOTAL_COUNT_CAP} (Elasticsearch index.max_result_window); totalAvailable is a LOWER BOUND — the true match count may be higher and is UNKNOWN. See totalIsLowerBound. Narrow by title/chapter/date for an exact count.`);
    }
    return withMeta(data, {
        source: "ecfr.gov/api (search/v1)",
        keylessMode: true,
        returned,
        totalAvailable,
        // Explicit boolean (not conditional): a below-cap count is DEFINITIVELY
        // exact (totalIsLowerBound:false), an at/above-cap count is a lower bound
        // (true). The AI can trust `false` as "this is the real total".
        totalIsLowerBound,
        truncated: totalAvailable !== null ? returned < totalAvailable : undefined,
        filtersApplied: args.titleNumber !== undefined ? ["titleNumber"] : [],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
function stripHtml(s) {
    return s
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
}
function buildEcfrUrl(h) {
    const base = `https://www.ecfr.gov/current/title-${h.title}`;
    if (h.section)
        return `${base}/section-${h.section}`;
    if (h.part)
        return `${base}/part-${h.part}`;
    if (h.chapter)
        return `${base}/chapter-${h.chapter}`;
    return base;
}
//# sourceMappingURL=ecfr.js.map