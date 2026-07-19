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
import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
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
// ─── ecfr_get_section — full in-force text of one CFR section ──────────────
// The eval-found gap: ecfr_search returns ranked SNIPPETS; there was no way to pull
// a clause's COMPLETE text. This fetches one section from the versioner `full`
// endpoint (a per-section XML, ~5KB), de-XMLed to plain text. A bespoke individual
// source (not the search API) — mode-2 discovery.
const ECFR_SECTION_RE = /^[0-9]{1,3}\.[0-9]{1,4}(-[0-9]{1,4})?$/;
const ECFR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
async function fetchXmlText(url) {
    const r = await fetchWithRetry(url, { headers: { Accept: "application/xml" }, signal: AbortSignal.timeout(20_000) }, `ecfr:${url.split("/api/")[1] ?? url}`);
    return await r.text();
}
function decodeXmlEntities(s) {
    return s
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, "&");
}
// De-XML a section body to readable plain text: block tags → newlines, strip the
// rest, decode entities, drop empty lines. No fabrication — the eCFR's own text.
function xmlToPlainText(xml) {
    return decodeXmlEntities(xml
        .replace(/<\/(P|HD1|HD2|HD3|HD4|HEAD|FP|GID|GPOTABLE|ROW)>/gi, "\n")
        .replace(/<[^>]+>/g, ""))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .join("\n");
}
export async function getSection(args) {
    // SSRF/injection: `section` (+ derived `part`) interpolate into the URL query, so
    // the charclass is the load-bearing guard. `titleNumber` is numeric (schema).
    // `\s` reject is load-bearing: JS `$` also matches BEFORE a trailing "\n", so the
    // charclass alone would admit "52.204-21\n". No valid section carries whitespace.
    if (!ECFR_SECTION_RE.test(args.section) || /\s/.test(args.section)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid section ${JSON.stringify(args.section)} — expected a CFR section like "52.204-21" or "12.301" (^[0-9]{1,3}\\.[0-9]{1,4}(-[0-9]{1,4})?$, no whitespace).`,
            upstreamEndpoint: "ecfr:versioner/full",
        });
    }
    let issueDate = args.date;
    if (issueDate !== undefined && !ECFR_DATE_RE.test(issueDate)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid date ${JSON.stringify(args.date)} — expected an eCFR issue date YYYY-MM-DD (omit to use the title's latest).`,
            upstreamEndpoint: "ecfr:versioner/full",
        });
    }
    if (!issueDate) {
        // Resolve the title's latest issue date (memoized titles list) — DISCLOSED below.
        const t = (await listTitles()).data.titles.find((x) => x.number === args.titleNumber);
        issueDate = t?.latestIssueDate;
        if (!issueDate) {
            throw new ToolErrorCarrier({
                kind: "invalid_input",
                retryable: false,
                message: `Title ${args.titleNumber} is not a known CFR title (or has no issue date). Verify it via ecfr_list_titles.`,
                upstreamEndpoint: "ecfr:versioner/full",
            });
        }
    }
    const part = args.section.split(".")[0];
    const url = `${ECFR}/versioner/v1/full/${issueDate}/title-${args.titleNumber}.xml?part=${encodeURIComponent(part)}&section=${encodeURIComponent(args.section)}`;
    const xml = await fetchXmlText(url);
    // Locate the SECTION DIV8 for EXACTLY this section (the endpoint may return the
    // enclosing part). Absent ⇒ honest not_found, NEVER a fabricated empty/wrong text.
    const escaped = args.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const div = xml.match(new RegExp(`<DIV8 N="${escaped}"[^>]*TYPE="SECTION"[^>]*>([\\s\\S]*?)</DIV8>`, "i"));
    if (!div) {
        throw new ToolErrorCarrier({
            kind: "not_found",
            retryable: false,
            message: `Section ${args.section} not found in CFR title ${args.titleNumber} as of the ${issueDate} issue. Verify the citation (e.g. via ecfr_search); the part number (${part}) must actually contain the section.`,
            upstreamEndpoint: "ecfr:versioner/full",
        });
    }
    const body = div[1];
    const headMatch = body.match(/<HEAD>([\s\S]*?)<\/HEAD>/i);
    const heading = headMatch ? xmlToPlainText(headMatch[1]).replace(/\n+/g, " ").trim() : null;
    let citation = null;
    let alternateReference = null;
    const meta = xml.match(/hierarchy_metadata="([^"]*)"/i);
    if (meta) {
        try {
            const hm = JSON.parse(decodeXmlEntities(meta[1]));
            citation = hm.citation ?? null;
            alternateReference = hm.alternate_reference ?? null;
        }
        catch {
            /* metadata is advisory — its absence never blocks the text */
        }
    }
    const fullText = xmlToPlainText(body);
    if (fullText.length === 0) {
        // A 200 with a section shell but no readable text ⇒ schema drift, not a fake empty.
        throw driftError("ecfr:versioner/full", `The section ${args.section} DIV8 carried no extractable text — eCFR XML shape drift, never a fabricated empty section.`);
    }
    const ecfrUrl = `https://www.ecfr.gov/current/title-${args.titleNumber}/section-${args.section}`;
    return withMeta({
        titleNumber: args.titleNumber,
        section: args.section,
        citation,
        alternateReference,
        heading,
        fullText,
        issueDate,
        ecfrUrl,
    }, {
        source: "ecfr.gov/api (versioner/v1/full)",
        keylessMode: true,
        returned: 1,
        totalAvailable: 1,
        truncated: false,
        filtersApplied: ["titleNumber", "section"],
        filtersDropped: [],
        fieldsUnavailable: [],
        notes: [
            `Full in-force text of ${citation ?? `${args.titleNumber} CFR ${args.section}`} as of the ${issueDate} eCFR issue (the title's LATEST unless a date was supplied — a moving target). De-XMLed to plain text; no content fabricated — open ecfrUrl for the authoritative rendering.`,
        ],
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
    // #5 (agent-eval 2026-07-18): an agent couldn't retrieve a clause's full text and
    // didn't know where to look. Each `excerpt` is a RANKED, ellipsized snippet — NOT
    // the full section — and a section recurs once per historical version.
    notes.push("Each result's `excerpt` is a ranked, ellipsized SNIPPET — NOT the full section text. For the complete in-force text of a section, open its `ecfrUrl`. A section can appear multiple times (one row per historical version, distinguished by `effectiveOn`); the row with the latest `effectiveOn` is the current version.");
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