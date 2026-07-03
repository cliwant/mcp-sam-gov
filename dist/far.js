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
import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
import { memoize } from "./cache.js";
import { listTitles } from "./ecfr.js";
import { withMeta } from "./meta.js";
const ECFR = "https://www.ecfr.gov/api";
/**
 * Fetch a versioner-full XML document as text. Mirrors ecfr.ts's fetchJson
 * shape (fetchWithRetry + a 15s AbortSignal) but asks for XML and returns the
 * raw body — the versioner endpoint serves `title-48.xml`. fetchWithRetry
 * throws a classified ToolErrorCarrier on any non-2xx (404 → not_found, 5xx →
 * upstream_unavailable, network → upstream_unavailable), which callers here
 * either map (404 on the CLAUSE) or let propagate.
 */
async function fetchText(url) {
    const r = await fetchWithRetry(url, {
        headers: { Accept: "application/xml" },
        signal: AbortSignal.timeout(15_000),
    }, `ecfr:${url.split("/api/")[1] ?? url}`);
    return await r.text();
}
/**
 * Strip XML tags → clean, paragraph-preserving plain text. The versioner body
 * is block XML (`<P>`, `<HD1>`, `<EXTRACT>`, `<I>`…); we drop the tags but keep
 * paragraph boundaries as spaces so the clause reads as continuous prose, then
 * decode the handful of numeric/entity refs the feed uses (—, &, ", ', <, >).
 */
function stripXml(s) {
    return s
        // Block-level closers become a space so paragraphs don't run together.
        .replace(/<\/(P|HD1|HEAD|EXTRACT|CITA|EDNOTE|PSPACE|HED|DIV8|LI)>/gi, " ")
        // Drop every remaining tag.
        .replace(/<[^>]+>/g, " ")
        // Decode the entities the eCFR XML actually emits.
        .replace(/&#8212;|&mdash;/gi, "—")
        .replace(/&#8211;|&ndash;/gi, "–")
        .replace(/&#8217;|&rsquo;/gi, "’")
        .replace(/&#8220;|&ldquo;/gi, "“")
        .replace(/&#8221;|&rdquo;/gi, "”")
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        // Collapse whitespace.
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * Normalize a raw clauseNumber to its bare `NN.NNN-N` / `NNN.NNN-NNNN` core:
 * strip a leading `FAR`/`DFARS` (case-insensitive) and surrounding
 * whitespace/stray punctuation. Returns "" if nothing usable remains.
 */
function normalizeClauseNumber(raw) {
    return (raw ?? "")
        .trim()
        // Leading regulation prefix (FAR 52.212-4 / DFARS 252.204-7012).
        .replace(/^\s*(?:d?far[s]?)\b[\s.:#-]*/i, "")
        // Strip anything that isn't part of a clause number (keep digits . -).
        .replace(/[^\d.\-]/g, "")
        .trim();
}
const CLAUSE_RE = /^\d{1,3}\.\d{3,4}-\d{1,4}$/;
/** Regulation family from the clause-number prefix (deterministic, no fetch). */
function regulationFor(clauseNumber) {
    if (/^252\./.test(clauseNumber))
        return "DFARS";
    if (/^2\d\d\./.test(clauseNumber))
        return "DFARS";
    if (/^552\./.test(clauseNumber))
        return "GSAM";
    if (/^52\./.test(clauseNumber))
        return "FAR";
    return "other";
}
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
function buildFarOverhaulRisk(regulation) {
    return {
        note: "eCFR reflects the CODIFIED FAR only. The Revolutionary FAR Overhaul (RFO) is actively replacing FAR parts via agency class deviations that may NOT appear in eCFR — so this clause text can be technically current in the CFR yet operationally superseded. Verify the controlling deviation before relying on it.",
        authoritativeList: "https://www.acquisition.gov/far-overhaul",
        deviationSources: [
            "https://www.acquisition.gov/far-overhaul",
            "https://www.acquisition.gov/dfars",
            "https://www.acq.osd.mil/dpap/dars/",
        ],
        appliesTo: regulation,
    };
}
/** Title 48 currency metadata, cached (titles.json changes infrequently). */
async function title48Currency() {
    return memoize("far:title48-currency", async () => {
        const { titles } = await listTitles();
        const t48 = titles.find((t) => t.number === 48);
        return {
            upToDateAsOf: t48?.upToDateAsOf ?? null,
            latestAmendedOn: t48?.latestAmendedOn ?? null,
        };
    });
}
/** Extract the first `<HEAD>…</HEAD>` inner text (tags stripped). */
function firstHead(xml) {
    const m = xml.match(/<HEAD>([\s\S]*?)<\/HEAD>/i);
    if (!m || m[1] === undefined)
        return null;
    const h = stripXml(m[1]);
    return h.length > 0 ? h : null;
}
/**
 * Does this body look like a REAL eCFR Title-48 section, vs an empty body, a
 * CDN/WAF HTML interstitial, or a truncated proxy response? (Defect-2 guard.)
 * Real versioner section XML carries an uppercase `<HEAD>…</HEAD>` plus
 * substantive text. The `<HEAD>` test is CASE-SENSITIVE on purpose: an HTML
 * challenge page uses lowercase `<head>`, and empty/truncated bodies carry
 * neither — so a hollow 200 fails this check and is refused rather than parsed
 * into a fake `complete:true` clause.
 */
function looksLikeSectionXml(xml) {
    return /<HEAD>/.test(xml) && stripXml(xml).length >= 20;
}
/**
 * Fetch + parse ONE Title-48 section as a prescription reference (its heading +
 * stripped text). NON-FATAL by contract: returns null on ANY failure so a
 * prescription problem never sinks the clause result. Memoized by URL.
 */
async function fetchPrescription(baseSection, asOfDate) {
    const url = `${ECFR}/versioner/v1/full/${asOfDate}/title-48.xml?section=${baseSection}`;
    try {
        const xml = await memoize(`far:section:${asOfDate}:${baseSection}`, async () => {
            const body = await fetchText(url);
            // A hollow/interstitial 200 is a fetch FAILURE, not an empty prescription
            // (Defect-2, non-fatal path). Throw so it is NOT cached and becomes null.
            if (!looksLikeSectionXml(body))
                throw new Error("non-section prescription body");
            return body;
        });
        const heading = firstHead(xml);
        const text = stripXml(xml);
        return { section: baseSection, heading, text };
    }
    catch {
        // Any failure (404/5xx/network/parse/hollow-body) → null; caller discloses it.
        return null;
    }
}
export async function farClauseLookup(args) {
    const clauseNumber = normalizeClauseNumber(args.clauseNumber ?? "");
    const includePrescription = args.includePrescription ?? true;
    // Defense-in-depth: the server Zod schema already rejects a non-matching
    // clauseNumber, but guard here too so far.ts is safe called directly.
    if (!CLAUSE_RE.test(clauseNumber)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Invalid FAR/DFARS clause number '${args.clauseNumber}'. Expected a clause like 52.212-4, 252.204-7012, or 52.204-25 (optionally prefixed 'FAR'/'DFARS').`,
            retryable: false,
            upstreamEndpoint: "ecfr:versioner/v1/full/title-48",
        });
    }
    const regulation = regulationFor(clauseNumber);
    // asOfDate defaults to Title 48's up_to_date_as_of (cached).
    const currency = await title48Currency();
    const asOfDate = args.asOfDate ?? currency.upToDateAsOf ?? "";
    // Guard (Defect 1): never query a blank/invalid date. If currency could NOT be
    // resolved (titles.json returns 200 but Title 48 — or its up_to_date_as_of —
    // is missing/renamed → upToDateAsOf:null, WITHOUT throwing) AND the caller gave
    // no asOfDate, asOfDate is "". The versioner 404s on a blank-date URL, and that
    // 404 would be mislabeled "clause not found" — a lie about a real, existing
    // clause. This is a currency-RESOLUTION failure, not an absent clause.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
        throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `Could not resolve Title 48's current codification date from the eCFR titles endpoint (up_to_date_as_of unavailable) and no asOfDate was supplied. Refusing to query a blank date — the versioner would return HTTP 404, which must NOT be reported as a missing clause. Retry shortly, or pass an explicit asOfDate (YYYY-MM-DD).`,
            retryable: true,
            upstreamEndpoint: "ecfr:versioner/v1/titles.json",
        });
    }
    const isCurrent = currency.upToDateAsOf !== null && asOfDate === currency.upToDateAsOf;
    // ── Fetch the CLAUSE XML (memoized by URL). ─────────────────────────────
    const clauseUrl = `${ECFR}/versioner/v1/full/${asOfDate}/title-48.xml?section=${clauseNumber}`;
    let xml;
    try {
        xml = await memoize(`far:section:${asOfDate}:${clauseNumber}`, async () => {
            const body = await fetchText(clauseUrl);
            // Guard (Defect 2): a 200 with an empty body, a CDN/WAF HTML interstitial,
            // or a truncated proxy response must NOT be parsed into a hollow
            // `complete:true` clause (heading/text empty, yet ok:true). Require real
            // Title-48 section XML. Throwing HERE (inside the memoize producer) keeps
            // the bad body OUT of the cache so a retry re-fetches cleanly.
            if (!looksLikeSectionXml(body)) {
                throw new ToolErrorCarrier({
                    kind: "upstream_unavailable",
                    message: `The eCFR versioner returned HTTP 200 for ${clauseNumber} (as of ${asOfDate}) but the body was not a parseable Title 48 section (empty, truncated, or a CDN/WAF interstitial). Refusing to emit a hollow clause. Retry shortly.`,
                    retryable: true,
                    upstreamStatus: 200,
                    upstreamEndpoint: "ecfr:versioner/v1/full/title-48",
                });
            }
            return body;
        });
    }
    catch (e) {
        // A genuine 404 → not_found NAMING the clause (never null/empty). Any OTHER
        // error (5xx/network/timeout) PROPAGATES with its classification so a DOWN
        // service is never misread as "clause not found".
        if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
            throw new ToolErrorCarrier({
                kind: "not_found",
                message: `FAR/DFARS clause ${clauseNumber} not found in Title 48 as of ${asOfDate}. (The eCFR versioner returned HTTP 404 "No matching content found" — the clause number may be wrong, reserved, or removed in this edition.)`,
                retryable: false,
                upstreamStatus: 404,
                upstreamEndpoint: "ecfr:versioner/v1/full/title-48",
            });
        }
        throw e;
    }
    // ── Parse the clause body. ──────────────────────────────────────────────
    const rawHead = firstHead(xml);
    // Strip a leading clause number if the HEAD duplicates it
    // ("52.212-4 Contract Terms…" → "Contract Terms…").
    const heading = rawHead != null
        ? rawHead.replace(new RegExp(`^${clauseNumber}\\s*[.:\\-—]?\\s*`), "").trim() ||
            rawHead
        : null;
    const revMatch = xml.match(/\(([A-Z]{3}\.?\s+\d{4})\)/);
    const revision = revMatch?.[1] ?? null;
    const preMatch = xml.match(/As prescribed in (\d{1,3}\.\d+(?:\([a-z0-9]+\))*)/i);
    const prescribedIn = preMatch?.[1] ?? null;
    // Detect clause vs provision from the prescribing verb. DFARS uses BOTH
    // "insert the following …" and "use the following …" (Defect 3: the narrow
    // /insert/-only regex silently mislabeled DFARS provisions as clauses). When
    // NEITHER verb is present, default to "clause" but DISCLOSE it as inferred
    // (see the note pushed below) rather than assert it.
    const kindMatch = xml.match(/(?:insert|use) the following (clause|provision)/i);
    const kindDetected = kindMatch?.[1]?.toLowerCase();
    const kind = kindDetected ?? "clause";
    const text = stripXml(xml);
    // ── Optional prescription section (non-fatal). ──────────────────────────
    const notes = [];
    let prescription = null;
    let prescriptionDegraded = false;
    if (includePrescription && prescribedIn) {
        // Trim any trailing subparagraph to the base section: 12.301(b)(3) → 12.301.
        const baseSection = prescribedIn.replace(/\(.*$/, "");
        prescription = await fetchPrescription(baseSection, asOfDate);
        if (prescription === null) {
            prescriptionDegraded = true;
            notes.push(`The prescribing section ${baseSection} (from "As prescribed in ${prescribedIn}") could NOT be fetched — prescription is null. This is a partial result: the clause text above is complete, but the "when does this clause apply?" rule was not retrieved (fetch it directly at ${ECFR}/versioner/v1/full/${asOfDate}/title-48.xml?section=${baseSection}, or via ecfr on ${`https://www.ecfr.gov/current/title-48/section-${baseSection}`}).`);
        }
    }
    else if (includePrescription && !prescribedIn) {
        notes.push("No 'As prescribed in …' pointer was found in this clause's text, so no prescription section was fetched (prescription:null). Some provisions/clauses carry the prescription in the parent subpart rather than an inline opener.");
    }
    // Disclose when `kind` was inferred rather than read from a verb (Defect 3):
    // an undetected verb defaults to "clause", which would silently mislabel a
    // provision — so the consumer is told the field is a default, not an assertion.
    if (kindDetected === undefined) {
        notes.push('The instrument kind (clause vs provision) could NOT be determined from the text — no "insert/use the following clause/provision" verb was found — so kind defaults to "clause". Verify against the section heading if the clause-vs-provision distinction matters.');
    }
    const ecfrUrl = `https://www.ecfr.gov/current/title-48/section-${clauseNumber}`;
    const farOverhaulRisk = buildFarOverhaulRisk(regulation);
    // Currency disclosures.
    if (!isCurrent) {
        notes.push(currency.upToDateAsOf
            ? `asOfDate ${asOfDate} is NOT Title 48's current codification date (${currency.upToDateAsOf}); this is a point-in-time read of the FAR as of ${asOfDate}, which may differ from the clause in force today.`
            : `Title 48's current codification date could not be confirmed from titles.json, so isCurrent is false; treat ${asOfDate} as the requested point-in-time edition.`);
    }
    // The RFO caveat is ALWAYS surfaced (structural, never per-clause-fabricated).
    notes.push(`RFO caveat: eCFR carries the CODIFIED ${regulation} only. The Revolutionary FAR Overhaul is replacing FAR parts via agency class deviations that may not appear here — verify the controlling deviation (farOverhaulRisk.authoritativeList) before relying on this clause.`);
    // Currency + provenance live in `data` (top-level), NOT in the meta partial:
    // the project's buildMeta (meta.ts) finalizes a FIXED-shape ResponseMeta and
    // drops unknown keys, so asOfDate/isCurrent/farOverhaulRisk passed via _meta
    // would be silently discarded. The design note anticipated this — carry them
    // where they actually survive. The honest completeness/degradation signals
    // (complete, fieldsUnavailable, notes) DO belong in _meta and are set there.
    const data = {
        clauseNumber,
        kind,
        regulation,
        heading,
        revision,
        text,
        prescribedIn,
        prescription,
        ecfrUrl,
        // Point-in-time provenance for THIS read (mirrors the design note's _meta
        // fields; placed in data so they are not dropped by buildMeta).
        asOfDate,
        titleUpToDateAsOf: currency.upToDateAsOf,
        titleLatestAmendedOn: currency.latestAmendedOn,
        isCurrent,
        // Always-present structural currency caveat (never fabricated specifics).
        farOverhaulRisk,
    };
    return withMeta(data, {
        source: "ecfr:versioner/full",
        keylessMode: true,
        // A single authoritative clause record.
        returned: 1,
        totalAvailable: 1,
        // A missing prescription is a genuine partial result → not complete.
        complete: prescriptionDegraded ? false : undefined,
        // fieldsUnavailable ONLY when we tried and failed to get the prescription.
        fieldsUnavailable: prescriptionDegraded ? ["prescription"] : [],
        filtersApplied: [],
        filtersDropped: [],
        notes,
    });
}
//# sourceMappingURL=far.js.map