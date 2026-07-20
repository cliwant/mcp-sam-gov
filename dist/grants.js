/**
 * Grants.gov v1 API wrappers (keyless).
 *
 * Grants.gov hosts federal financial-assistance opportunities (grants,
 * cooperative agreements). Distinct from SAM.gov contracts but the
 * same pursuit ICP often cares about both.
 *
 * Endpoints (POST JSON, no key):
 *   - /v1/api/search2 — search opportunities
 *   - /v1/api/fetchOpportunity — single grant detail
 *
 * Documented at https://grants.gov/web/grants/s2s/grantor/schemas/grants-search-2-soap.html
 */
import { fetchWithRetry } from "./errors.js";
import { driftError } from "./datasource.js";
import { withMeta } from "./meta.js";
const GRANTS = "https://api.grants.gov/v1/api";
async function postJson(endpoint, body) {
    const r = await fetchWithRetry(`${GRANTS}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    }, `grants.gov:${endpoint}`);
    return (await r.json());
}
export async function searchGrants(args) {
    // The tool ALWAYS sends oppStatuses — default forecasted|posted when the caller
    // omits it — so it is ALWAYS an applied server-side filter (disclosed below).
    const effOppStatuses = args.oppStatuses ?? ["forecasted", "posted"];
    const statusDefaulted = args.oppStatuses == null;
    const body = {
        rows: args.rows ?? 10,
        keyword: args.keyword ?? "",
        cfda: args.cfda ?? "",
        agencies: args.agency ?? "",
        oppNum: args.oppNum ?? "",
        oppStatuses: effOppStatuses.join("|"),
    };
    const json = await postJson("search2", body);
    if (json.errorcode && json.errorcode !== 0) {
        throw new Error(`Grants.gov error: ${json.msg ?? "unknown"}`);
    }
    // F4 (P2 empty-vs-outage): a 200 that is NEITHER a recognized error envelope
    // (handled above) NOR a `{data:{hitCount:number,…}}` shape is drift — a
    // malformed / outage / interstitial body — and must NOT coalesce to
    // `totalRecords:0` (an AUTHORITATIVE "no grants"). A GENUINE empty carries a
    // numeric `data.hitCount:0` and stays an honest empty below. (Mirrors the
    // govinfo/nih driftError precedent — a drift is a throw, never a fake-empty.)
    const hitCount = json.data?.hitCount;
    if (typeof hitCount !== "number") {
        throw driftError("grants.gov", "Grants.gov search2 returned HTTP 200 but the body carries neither an error code nor a numeric data.hitCount — treating it as schema drift / an outage interstitial, NOT an empty result set.");
    }
    const totalRecords = hitCount;
    const data = {
        totalRecords,
        grants: (json.data?.oppHits ?? []).map((g) => ({
            id: g.id ?? "",
            opportunityNumber: g.number ?? "",
            title: g.title ?? "",
            agencyCode: g.agencyCode ?? "",
            // GRANT-2: prefer `agency` (the real agency name) over the empty `agencyName`.
            agencyName: g.agency ?? g.agencyName ?? "",
            openDate: g.openDate,
            closeDate: g.closeDate,
            status: g.oppStatus,
            docType: g.docType,
            // E-2: always an array — normalize absent/legacy-string to []/[str]
            // so consumers can rely on `cfdaList` being string[] unconditionally.
            cfdaList: Array.isArray(g.cfdaList)
                ? g.cfdaList
                : g.cfdaList
                    ? [g.cfdaList]
                    : [],
        })),
    };
    // Truthful `_meta` (spec §1.2 A4, §2.3). Grants.gov reports a real match
    // total (`hitCount`), so `totalAvailable` is trustworthy. A4: Grants.gov
    // silently IGNORES unknown agency codes / CFDA numbers (it returns the
    // unfiltered set rather than erroring), and it does not echo back which
    // filters it honored — so the AI cannot verify a filter took. We list the
    // filters we SENT in `filtersApplied` and warn that unknown values are
    // dropped silently, so the AI treats a suspiciously large result set with
    // caution instead of asserting it is filtered.
    const returned = data.grants.length;
    const sent = [];
    if (args.keyword)
        sent.push("keyword");
    if (args.cfda)
        sent.push("cfda");
    if (args.agency)
        sent.push("agency");
    if (args.oppNum)
        sent.push("oppNum");
    // oppStatuses is ALWAYS sent (default or caller-supplied), so ALWAYS disclose the
    // EFFECTIVE set — omitting it when defaulted made totalAvailable (a status-filtered
    // subset) read as unfiltered (live: keyword=cybersecurity → 235 forecasted|posted vs
    // 2008 all-statuses, a 1773-record closed/archived bucket hidden).
    sent.push(`oppStatuses(${effOppStatuses.join("|") || "all-statuses"})`);
    const notes = [];
    if (statusDefaulted) {
        notes.push("No oppStatuses supplied — DEFAULTED to forecasted|posted, so CLOSED and ARCHIVED opportunities are EXCLUDED from both the results AND totalAvailable (this total is the open/forecasted subset, not all statuses). To count or return every status, pass oppStatuses including 'closed'/'archived'.");
    }
    if (args.agency || args.cfda) {
        notes.push("Grants.gov applies the agency/CFDA filter server-side (live-verified 2026-07-20): a bogus or misspelled value returns 0 results, NOT an error and NOT the unfiltered set — so an unexpectedly EMPTY filtered search most often means the agency/CFDA value is invalid, not that no grants exist. `filtersApplied` reflects that the filter was sent. Verify the agency code / CFDA number if a filtered result is surprisingly empty.");
    }
    // VQ-1 (C82 dogfooding): Grants.gov OR-tokenizes multi-word keywords (matches ANY
    // word) and does NOT support phrase quoting (a quoted "..." keyword returns 0). Live:
    // "cybersecurity information technology" → 926 broad hits (State-Dept program
    // statements top) vs 280 focused for "cybersecurity". The note is RESULT-AWARE
    // (adversarial review F1/F2): "broad set ≠ no grants" only holds when there ARE
    // results; a 0-result multi-word query needs the opposite advice. Quotes are stripped
    // for the word count so a quote-wrapped phrase is still detected as multi-word.
    const rawKw = args.keyword ?? "";
    const looksQuoted = /^\s*["'][\s\S]*["']\s*$/.test(rawKw);
    const kwWords = rawKw
        .trim()
        .replace(/^["']+|["']+$/g, "")
        .trim()
        // disclosure-split-ok: grants.gov OR-splits ONLY whitespace (and '+'), NOT punctuation — live-verified 2026-07; the shared DISCLOSURE_SPLIT_RE punctuation class must NOT be applied here (it would over-disclose). See ADR-0022.
        .split(/\s+/)
        .filter(Boolean);
    if (kwWords.length > 1) {
        if (totalRecords > 0) {
            notes.push(`Grants.gov OR-matches multi-word keywords: it returns opportunities containing ANY of these ${kwWords.length} words, so this keyword may BROADEN results if any word is a common term ("information"/"technology"/"program" match many unrelated grants) — a broad, poorly-ranked set here does NOT mean "no relevant grants". For focused results pass ONE specific term (e.g. "cybersecurity"); Grants.gov does NOT support phrase quoting (a quoted "..." keyword returns 0). Narrow with cfda / agency / oppStatuses instead.`);
        }
        else {
            notes.push(`This ${kwWords.length}-word keyword returned 0 results. Grants.gov OR-matches keywords and does NOT support phrase quoting${looksQuoted ? ' — your keyword appears quote-wrapped, so REMOVE the quotes (a quoted "..." keyword always returns 0)' : ' (a quoted "..." keyword returns 0)'}. A 0 here means even the OR of these words has no match — try each word separately, or narrow with cfda/agency/oppStatuses, to isolate.`);
        }
    }
    return withMeta(data, {
        source: "grants.gov/api (search2)",
        keylessMode: true,
        returned,
        totalAvailable: totalRecords,
        truncated: returned < totalRecords,
        filtersApplied: sent,
        filtersDropped: [],
        fieldsUnavailable: [],
        notes,
    });
}
export async function getGrant(args) {
    const json = await postJson("fetchOpportunity", {
        opportunityId: args.opportunityId,
    });
    if (json.errorcode && json.errorcode !== 0) {
        throw new Error(`Grants.gov error: ${json.msg ?? "unknown"}`);
    }
    const d = json.data ?? {};
    // NOT-FOUND: Grants.gov's fetchOpportunity returns errorcode:0 ("Webservice
    // Succeeds") + a HOLLOW `data` object even for a NONEXISTENT opportunityId
    // (LIVE-VERIFIED 2026-07-06: id 999999999 → errorcode 0 but data carries NO
    // id / opportunityNumber / opportunityTitle / synopsis — only skeleton fields).
    // Mapping that shell would fabricate a grant (id:0, title:"") for an opportunity
    // that does NOT exist — an absence-as-present lie. `id` is the reliable signal:
    // a real grant ALWAYS carries a numeric `id`, the hollow shell never does.
    if (d.id === undefined || d.id === null) {
        return { found: false, opportunityId: args.opportunityId };
    }
    const s = d.synopsis ?? {};
    const rawContact = s.agencyContactName ?? s.agencyName ?? null;
    return {
        found: true,
        id: d.id, // guaranteed present past the not-found guard above
        opportunityNumber: d.opportunityNumber ?? "",
        title: d.opportunityTitle ?? "",
        // GRANT-2: `name` is the REAL agency (subtier preferred, else the department),
        // NOT synopsis.agencyName (which is the contact person). Fall back through both
        // the synopsis and top-level `data` locations. `department` is the top-tier
        // agency; `contactName` preserves the person the mislabeled old `name` held
        // (newlines collapsed so it renders on one line).
        agency: {
            code: s.agencyCode ?? d.owningAgencyCode,
            name: s.agencyDetails?.agencyName ??
                d.agencyDetails?.agencyName ??
                s.topAgencyDetails?.agencyName ??
                d.topAgencyDetails?.agencyName ??
                null,
            department: s.topAgencyDetails?.agencyName ?? d.topAgencyDetails?.agencyName ?? null,
            contactName: rawContact ? rawContact.replace(/\s*\n\s*/g, " — ") : null,
        },
        description: s.synopsisDesc ?? d.synopsisDesc ?? "",
        postingDate: s.postingDate,
        responseDate: s.responseDate,
        archiveDate: s.archiveDate,
        awardCeiling: s.awardCeiling,
        awardFloor: s.awardFloor,
        estimatedFunding: s.estimatedFunding,
        expectedNumberOfAwards: s.expectedNumberOfAwards,
        applicantTypes: (s.applicantTypes ?? [])
            .map((a) => a.description)
            .filter(Boolean),
        fundingInstruments: (s.fundingInstruments ?? [])
            .map((f) => f.description)
            .filter(Boolean),
        fundingCategories: (s.fundingActivityCategories ?? [])
            .map((f) => f.description)
            .filter(Boolean),
        cfdaPrograms: (d.cfdas ?? []).map((c) => ({
            number: c.cfdaNumber ?? "",
            title: c.programTitle ?? "",
        })),
    };
}
//# sourceMappingURL=grants.js.map