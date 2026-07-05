#!/usr/bin/env node
/**
 * Edge case smoke test.
 *
 * Smoke test (smoke-test.mjs) verifies the happy path. This one
 * exercises the failure modes a real user will hit:
 *   - Invalid noticeId (32-char hex shape but not a real notice)
 *   - Empty results (NAICS that has no opportunities)
 *   - Non-existent recipient (autocomplete returns 0)
 *   - Bad agency abbreviation
 *   - Unicode / non-ASCII in keyword
 *   - Bad fiscal year (future)
 *   - Malformed inputs (negative limit, missing required field)
 *
 * Pass criteria: every tool returns a STRUCTURED envelope, never
 * crashes the server, never returns a stack trace to the user.
 */

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CSV = path.join(__dirname, "test-fixtures", "gsa-sample.csv");

const child = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

let buf = "";
const responses = new Map();

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id !== undefined) responses.set(m.id, m);
    } catch {}
  }
});

let id = 1;
async function rpc(method, params) {
  const myId = id++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  for (let i = 0; i < 250; i++) {
    if (responses.has(myId)) return responses.get(myId);
    await wait(80);
  }
  throw new Error(`timeout ${method}`);
}

async function call(name, args) {
  const r = await rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  let env;
  try { env = JSON.parse(text); } catch { env = { ok: false, error: { kind: "unknown", message: text } }; }
  return { env, mcpIsError: !!r.result?.isError };
}

const cases = [
  {
    label: "invalid noticeId (correct shape, not real)",
    name: "sam_get_opportunity",
    args: { noticeId: "0000000000000000000000000000abcd" },
    // Acceptable: ok:true with empty/found:false, OR ok:false not_found
    accept: ({ env }) =>
      (env.ok && (env.data?.found === false || env.data === null)) ||
      (!env.ok && (env.error.kind === "not_found" || env.error.retryable === false)),
  },
  {
    label: "non-hex noticeId (malformed)",
    name: "sam_get_opportunity",
    args: { noticeId: "not-a-real-id" },
    accept: ({ env }) =>
      (env.ok && env.data?.found === false) ||
      (!env.ok && !env.error.retryable),
  },
  {
    label: "empty NAICS search",
    name: "usas_autocomplete_naics",
    args: { searchText: "zzzzzzzzzzzzzzzzz", limit: 3 },
    accept: ({ env }) => env.ok && Array.isArray(env.data.naics),
  },
  {
    label: "agency lookup w/ unmatched abbreviation",
    name: "usas_lookup_agency",
    args: { searchText: "zzznotanagency" },
    accept: ({ env }) => env.ok && Array.isArray(env.data.matches),
  },
  {
    label: "unicode keyword (Korean)",
    name: "sam_search_opportunities",
    args: { query: "한글검색", limit: 2 },
    accept: ({ env }) => env.ok && Array.isArray(env.data.opportunities),
  },
  {
    label: "future fiscal year",
    name: "usas_search_awards",
    args: { agency: "Department of Veterans Affairs", naics: "541512", fiscalYear: 2099 },
    accept: ({ env }) => env.ok || (!env.ok && !env.error.retryable),
  },
  {
    label: "Federal Register doc number malformed",
    name: "fed_register_get_document",
    args: { documentNumber: "9999-99999-bad" },
    accept: ({ env }) => !env.ok && env.error.kind === "not_found",
  },
  {
    label: "eCFR title out of range (51)",
    name: "ecfr_search",
    args: { query: "test", titleNumber: 51, perPage: 1 },
    // eCFR may return empty results; either ok:true with empty results or ok:false invalid_input is fine
    accept: ({ env }) =>
      (env.ok && Array.isArray(env.data.results)) ||
      (!env.ok && !env.error.retryable),
  },
  {
    label: "Grants.gov bad opportunity id",
    name: "grants_get_opportunity",
    args: { opportunityId: "999999999" },
    accept: ({ env }) => env.ok || !env.error.retryable,
  },
  {
    label: "limit at maximum boundary",
    name: "sam_search_opportunities",
    args: { ncode: "541512", limit: 50 },
    accept: ({ env }) => env.ok && env.data.opportunities?.length <= 50,
  },
  {
    // A1 (spec §1.2, §2.4): the keyless HAL list endpoint HONORS
    // naics/set-aside/pop-state/keyword server-side (VERIFIED LIVE) — those
    // belong in `_meta.filtersApplied`, NOT filtersDropped. Only
    // organization-name has no keyless param → it is the SOLE dropped facet.
    // The per-result naics/set-aside/PoP VALUES are still omitted by the list
    // payload → fieldsUnavailable. (Keyed mode honors all → nothing dropped.)
    label: "A1: keyless search reports applied vs dropped facets truthfully",
    name: "sam_search_opportunities",
    args: { ncode: "541512", setAside: ["SBA"], state: "VA", organizationName: "Department of Veterans Affairs", limit: 3 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      if (m.keylessMode === false) return m.complete === true && Array.isArray(m.filtersDropped);
      const applied = m.filtersApplied ?? [];
      const dropped = m.filtersDropped ?? [];
      // The three honored facets must be reported as applied…
      const appliedOk = ["ncode", "setAside", "state"].every((f) => applied.includes(f));
      // …and organization-name is the ONLY dropped facet.
      const droppedOk =
        dropped.includes("organizationName") &&
        !dropped.includes("ncode") &&
        !dropped.includes("setAside") &&
        !dropped.includes("state");
      const fieldsGone = ["naics", "setAside", "placeOfPerformance"].every(
        (f) => (m.fieldsUnavailable ?? []).includes(f),
      );
      return (
        appliedOk &&
        droppedOk &&
        fieldsGone &&
        m.complete === false && // org dropped ⇒ not complete
        Array.isArray(m.notes) &&
        m.notes.length >= 2
      );
    },
  },
  {
    // A honored facet the caller requested lands in filtersApplied (never
    // filtersDropped), and unrequested facets stay absent from both.
    label: "A1: requested naics is applied, not dropped; nothing else flagged",
    name: "sam_search_opportunities",
    args: { ncode: "541512", limit: 2 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      if (m.keylessMode === false) return true;
      const applied = m.filtersApplied ?? [];
      const dropped = m.filtersDropped ?? [];
      // ncode honored → applied, not dropped. Nothing else requested → no drops.
      return (
        applied.includes("ncode") &&
        !dropped.includes("ncode") &&
        dropped.length === 0 &&
        m.truncated === true // ~600+ matches, returned 2 ⇒ truncated
      );
    },
  },
  {
    // A1 end-to-end: prove the keyless NAICS filter is REAL, not just
    // advertised — search by NAICS, fetch a result's detail, confirm its
    // primary NAICS matches. Guards against a silent regression to a wrong
    // param name (e.g. `naics_code`/`ncode`), which would return the
    // unfiltered firehose while _meta still claims the filter applied.
    label: "A1: keyless NAICS filter actually narrows results (end-to-end)",
    name: "sam_search_opportunities",
    args: { ncode: "236220", limit: 3 },
    accept: async ({ env }) => {
      if (!env.ok || !env._meta) return false;
      if (env._meta.keylessMode === false) return true; // keyed path differs
      const opps = env.data?.opportunities ?? [];
      if (opps.length === 0) return true; // no active 236220 today — acceptable
      const det = await call("sam_get_opportunity", { noticeId: opps[0].noticeId });
      if (!det.env.ok || det.env.data?.found === false) return true; // detail soft
      return det.env.data?.naics === "236220";
    },
  },
  {
    // GSA-CSV inline enrichment — DISABLED-path PARITY (default, no CSV env):
    // sam_search_opportunities must behave EXACTLY as before the enrichment
    // slice. naics/setAside stay null, _meta lists the full unavailable trio and
    // the plain keyless-HAL source (no "+ gsa-csv"), and the payload carries NO
    // enrichment keys (no data.freshness; no per-row type/placeOfPerformance).
    label: "sam_search (disabled CSV): null fields + no enrichment keys/notes (byte-parity)",
    name: "sam_search_opportunities",
    args: { ncode: "541512", limit: 3 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      if (m.keylessMode === false) return true; // keyed path is out of scope here
      const opps = env.data?.opportunities ?? [];
      // Every row still has null naics/setAside (list payload omits them) and
      // NO added enrichment keys (type/placeOfPerformance must be absent).
      const rowsClean = opps.every(
        (o) =>
          o.naics === null &&
          o.setAside === null &&
          !("type" in o) &&
          !("placeOfPerformance" in o),
      );
      // The full unavailable trio is intact (nothing was enriched away).
      const trioUnavailable = ["naics", "setAside", "placeOfPerformance"].every(
        (fld) => (m.fieldsUnavailable ?? []).includes(fld),
      );
      // Source is the plain keyless HAL (no "+ gsa-csv" composition) and there
      // is NO freshness block (enrichment never ran).
      const plainSource = /keyless HAL/.test(m.source) && !/gsa-csv/i.test(m.source);
      const noFreshness = !("freshness" in (env.data ?? {}));
      // No enrichment note leaked into _meta.notes.
      const noEnrichNote =
        Array.isArray(m.notes) &&
        !m.notes.some((n) => /gsa csv|gsa-csv|enrichment/i.test(n));
      return rowsClean && trioUnavailable && plainSource && noFreshness && noEnrichNote;
    },
  },
  {
    // Shaping radar (a): the DEFAULT window filters SERVER-SIDE to Sources
    // Sought / Presolicitation / Special Notice only. Every returned notice's
    // noticeTypeCode must be one of r/p/s (proves notice_type actually narrows,
    // not the 46k-notice firehose), and the true server-side totalRecords for
    // the type+naics filter is exposed. daysUntilResponse is number|null.
    label: "shaping (a): default noticeType filters to r/p/s only + honest counts",
    name: "sam_search_shaping",
    args: { ncode: "541512", limit: 10 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      if (!Array.isArray(d.notices) || !Array.isArray(d.noticeTypesRequested))
        return false;
      const defaulted = d.noticeTypesRequested.join(",") === "r,p,s";
      const onlyShaping = d.notices.every((n) =>
        ["r", "p", "s"].includes(n.noticeTypeCode),
      );
      const shaped = d.notices.every(
        (n) =>
          typeof n.noticeId === "string" &&
          (n.daysUntilResponse === null ||
            typeof n.daysUntilResponse === "number"),
      );
      // totalRecords is the true server count (a number ≥ returned); _meta mirrors.
      const total = env._meta.totalAvailable;
      const totalOk =
        typeof d.totalRecords === "number" &&
        d.totalRecords === total &&
        (total === null || total >= d.returned);
      // noticeType is always an applied server-side facet.
      const noticeTypeApplied = (env._meta.filtersApplied ?? []).includes("noticeType");
      return defaulted && onlyShaping && shaped && totalOk && noticeTypeApplied;
    },
  },
  {
    // Shaping radar (b): a response-deadline WINDOW is applied CLIENT-SIDE (the
    // keyless feed ignores rdlfrom/rdlto), so _meta.filtersDropped must contain
    // "responseDeadline" + a note that says the window was applied client-side
    // because the feed ignores rdlfrom/rdlto. Every returned notice must fall
    // inside the window (a deadline-less notice is excluded from a windowed query).
    label: "shaping (b): response-deadline window → filtersDropped + client-side note",
    name: "sam_search_shaping",
    args: {
      ncode: "541512",
      limit: 25,
      responseDeadlineFrom: "2026-07-01",
      responseDeadlineTo: "2026-12-31",
    },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const dropped = m.filtersDropped ?? [];
      const droppedOk = dropped.includes("responseDeadline");
      const noteOk =
        Array.isArray(m.notes) &&
        m.notes.some((n) => /client-side/i.test(n) && /rdlfrom/i.test(n));
      // A windowed query is never "complete" (client-side trim can hide rows).
      const notComplete = m.complete === false && m.truncated === true;
      // Every returned notice actually lies inside the window (inclusive).
      const inWindow = (env.data?.notices ?? []).every(
        (n) =>
          typeof n.responseDeadline === "string" &&
          n.responseDeadline >= "2026-07-01" &&
          n.responseDeadline <= "2026-12-31T23:59:59Z",
      );
      return droppedOk && noteOk && notComplete && inWindow;
    },
  },
  {
    // Shaping radar (c): the keyless list rows null naics/setAside/PoP, so
    // _meta.fieldsUnavailable MUST list all three and a note MUST steer the AI
    // to sam_get_opportunity for those per-notice values (never fabricated).
    label: "shaping (c): fieldsUnavailable lists naics/setAside/PoP + 'call sam_get_opportunity' note",
    name: "sam_search_shaping",
    args: { ncode: "541512", limit: 5 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const fieldsGone = ["naics", "setAside", "placeOfPerformance"].every((f) =>
        (m.fieldsUnavailable ?? []).includes(f),
      );
      const pointerNote =
        Array.isArray(m.notes) &&
        m.notes.some((n) => /sam_get_opportunity/i.test(n));
      // The list rows really do carry null naics/setAside (not a fabricated value).
      const rowsNull = (env.data?.notices ?? []).every(
        (n) => n.naics === null && n.setAside === null,
      );
      // Source names the keyless notice_type filter (provenance honesty).
      const sourceOk =
        typeof m.source === "string" && /notice_type/i.test(m.source);
      return fieldsGone && pointerNote && rowsNull && sourceOk && m.keylessMode === true;
    },
  },
  {
    // Shaping radar (d) — REGRESSION: sam_search_opportunities is UNCHANGED by
    // the notice_type addition. It must NOT send notice_type (its source stays
    // the plain keyless HAL with no notice_type mention) and its shape is intact
    // (opportunities[] array, not the shaping `notices[]`). Guards that the
    // additive client edit didn't leak into the discovery tool.
    label: "shaping (d): sam_search_opportunities unchanged (no notice_type leak)",
    name: "sam_search_opportunities",
    args: { ncode: "541512", limit: 3 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      if (m.keylessMode === false) return true; // keyed path out of scope
      // Its source is the plain keyless HAL — NEVER the notice_type-filtered feed.
      const plainSource =
        /keyless HAL/.test(m.source) && !/notice_type/i.test(m.source);
      // Shape intact: opportunities[] (discovery), no shaping keys.
      const shapeIntact =
        Array.isArray(env.data?.opportunities) &&
        !("notices" in (env.data ?? {})) &&
        !("noticeTypesRequested" in (env.data ?? {}));
      // noticeType is NOT a reported filter here (the tool never sets ptype).
      const noNoticeTypeFilter = !(m.filtersApplied ?? []).includes("noticeType");
      return plainSource && shapeIntact && noNoticeTypeFilter;
    },
  },
  {
    // D1 (spec §1.5, §3.2): usas_search_individual_awards must now return
    // naicsCode (parity with usas_search_awards_by_recipient). NAICS is a
    // valid spending_by_award field — the tool omitted it before this PR.
    label: "D1: individual_awards returns naicsCode",
    name: "usas_search_individual_awards",
    args: { agency: "Department of Veterans Affairs", naics: "541512", fiscalYear: 2024, limit: 3 },
    accept: ({ env }) => {
      if (!env.ok || !Array.isArray(env.data?.awards)) return false;
      if (env.data.awards.length === 0) return true; // empty is acceptable
      // Every returned award object must carry the naicsCode KEY (present,
      // even if a given row's value is null). Before D1 the key was absent.
      const allHaveKey = env.data.awards.every(
        (a) => Object.prototype.hasOwnProperty.call(a, "naicsCode"),
      );
      // And at least one 541512 row should actually carry the code we filtered.
      const anyPopulated = env.data.awards.some((a) => a.naicsCode === "541512");
      return allHaveKey && anyPopulated;
    },
  },
  {
    // B1 (spec §1.3, §3.4): usas_search_awards must NOT fabricate awards:0 /
    // totalAwards:0. Counts are unavailable from the category endpoint → they
    // are null (never 0), and _meta.fieldsUnavailable names them.
    label: "B1: search_awards emits no fake awards:0 counts",
    name: "usas_search_awards",
    args: { agency: "Department of Veterans Affairs", naics: "541512", fiscalYear: 2024 },
    accept: ({ env }) => {
      if (!env.ok || !env.data) return false;
      // totalAwards must not be the fabricated 0 — null (or absent) only.
      const totalOk = env.data.totalAwards === null || env.data.totalAwards === undefined;
      // No recipient may report a fabricated awards:0 — must be null/absent.
      const recips = env.data.topRecipients ?? [];
      const recipsOk = recips.every((r) => r.awards === null || r.awards === undefined);
      // And it must be flagged as unavailable, not silently dropped.
      const flagged =
        Array.isArray(env._meta?.fieldsUnavailable) &&
        env._meta.fieldsUnavailable.includes("awards");
      // Sanity: the dollar value is still present (unchanged semantics).
      const valuePresent = typeof env.data.totalValue === "number";
      return totalOk && recipsOk && flagged && valuePresent;
    },
  },
  {
    // C5 (spec §1.4, §3.3): usas_search_awards_by_recipient._meta.totalAvailable
    // must be a REAL upstream total (from spending_by_award_count), not the
    // page size. For a large prime it must exceed the returned page.
    label: "C5: awards_by_recipient _meta.totalAvailable is a real total",
    name: "usas_search_awards_by_recipient",
    args: { recipientName: "Booz Allen Hamilton", agency: "Department of Veterans Affairs", limit: 5 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const returned = env.data?.awards?.length ?? 0;
      // totalAvailable is either a real number ≥ returned, or explicitly null
      // (companion count query genuinely failed) — but NEVER the page length
      // when the prime has more. We assert: it's null OR a number, and if a
      // number it is >= returned. data.totalRecords must mirror it (not len).
      const t = m.totalAvailable;
      const typeOk = t === null || typeof t === "number";
      const notPageSize = t === null || t >= returned;
      const mirrored = env.data.totalRecords === t; // C5: real total, not len
      return typeOk && notPageSize && mirrored;
    },
  },
  {
    // A5 (spec §1.2, §2.3): Federal Register reports a real match total
    // (`count`), so _meta.totalAvailable must be a NUMBER (never null) — the
    // AI can tell a top-N slice from the complete set. When agencySlugs are
    // passed, _meta.notes must warn that an unknown slug is silently ignored.
    label: "A5: fed_register_search _meta.totalAvailable is a real number, OR null when the count saturates at the 10k FR cap (FEDREG-1)",
    name: "fed_register_search_documents",
    args: { agencySlugs: ["veterans-affairs-department"], perPage: 3 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const returned = env.data?.documents?.length ?? 0;
      const returnedOk = m.returned === returned;
      const slugNote =
        Array.isArray(m.notes) &&
        m.notes.some((n) => n.toLowerCase().includes("slug"));
      // FEDREG-1: the FR API HARD-CAPS `count` at 10,000. A broad slug (VA has far
      // more than 10k documents) SATURATES → totalAvailable must be null (unknown
      // exact, NOT the capped 10000), truncated true, and a note must disclose the
      // cap. A narrower future result (< 10k) → a real number total with truncated
      // agreeing with returned<total.
      if (env.data?.totalRecordsSaturated === true) {
        const totalNull = m.totalAvailable === null;
        const truncTrue = m.truncated === true;
        const capNote =
          Array.isArray(m.notes) &&
          m.notes.some((n) => /caps its match count/i.test(n));
        return totalNull && truncTrue && capNote && returnedOk && slugNote;
      }
      const totalIsNumber = typeof m.totalAvailable === "number";
      const truncOk = m.truncated === returned < m.totalAvailable;
      return totalIsNumber && returnedOk && slugNote && truncOk;
    },
  },
  {
    // A6 (spec §1.2, §2.3): eCFR must echo the applied title scope in
    // _meta.notes so the AI can verify it searched Title 48 (FAR) vs every
    // title. totalAvailable comes from meta.total_count (a number).
    label: "A6: ecfr_search _meta.notes echoes the title scope",
    name: "ecfr_search",
    args: { query: "federal acquisition regulation", titleNumber: 48, perPage: 3 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      // The scope note must name Title 48 (the filter we applied).
      const scopeNote =
        Array.isArray(m.notes) &&
        m.notes.some((n) => /title\s*48/i.test(n));
      // eCFR returns meta.total_count → totalAvailable is a number (or null
      // only if upstream omitted it, which it does not for this query).
      const totalOk = m.totalAvailable === null || typeof m.totalAvailable === "number";
      // titleNumber went in → filtersApplied should record it.
      const filterEchoed = (m.filtersApplied ?? []).includes("titleNumber");
      return scopeNote && totalOk && filterEchoed;
    },
  },
  {
    // A6 (all-titles branch): with NO titleNumber the note must say it
    // searched ALL titles — so the AI never assumes a FAR-only scope.
    label: "A6: ecfr_search notes 'all titles' when no titleNumber",
    name: "ecfr_search",
    args: { query: "small business set-aside", perPage: 2 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const allTitlesNote =
        Array.isArray(m.notes) &&
        m.notes.some((n) => /all\s+cfr\s+titles/i.test(n));
      // No title filter applied.
      const noTitleFilter = !(m.filtersApplied ?? []).includes("titleNumber");
      return allTitlesNote && noTitleFilter;
    },
  },
  // ━━━ SBA — Size Standards ━━━
  {
    // (a) RECEIPTS-based NAICS: 541512 (Computer Systems Design). The $millions
    // figure must be normalized to DOLLARS on `threshold` + `revenueLimitUSD`
    // (NEVER surfaced as the raw "34"), the unit disclosed, employee/asset
    // fields null, and _meta.notes MUST carry the "adjusted periodically" caveat.
    label: "sba_size_standard: receipts-based NAICS → dollars threshold + unit disclosed + caveat",
    name: "sba_size_standard",
    args: { naics: "541512" },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const m = env._meta;
      const shapeOk =
        d.found === true &&
        d.naics === "541512" &&
        d.standardType === "receipts" &&
        d.unit === "USD annual receipts";
      // Normalized to dollars: a large number (millions×1e6), mirrored on the
      // raw normalized field, and a whole-million multiple (proves ×1,000,000).
      const dollarsOk =
        typeof d.threshold === "number" &&
        d.threshold >= 1_000_000 &&
        d.threshold % 1_000_000 === 0 &&
        d.revenueLimitUSD === d.threshold;
      // The other standard types are null (a NAICS uses exactly ONE).
      const othersNull = d.employeeCountLimit === null && d.assetLimitUSD === null;
      // Retrieval timestamp present (value is "as published as of" asOf).
      const asOfOk = typeof d.asOf === "string" && d.asOf.length > 0;
      // The doc-07 "not a permanent constant" caveat is present.
      const caveat = (m.notes ?? []).some(
        (n) => /adjusted periodically/i.test(n) && /verify the current standard/i.test(n),
      );
      // Source names the keyless SBA dataset.
      const sourceOk = typeof m.source === "string" && /sba\.gov naics\.json/i.test(m.source);
      return shapeOk && dollarsOk && othersNull && asOfOk && caveat && sourceOk && m.keylessMode === true;
    },
  },
  {
    // (b) EMPLOYEE-based NAICS: 336411 (Aircraft Manufacturing). threshold is a
    // COUNT of employees (NOT dollars) with the "employees" unit, and the
    // receipts/asset fields are null. The caveat must still be present.
    label: "sba_size_standard: employee-based NAICS → employee count + unit (not dollars)",
    name: "sba_size_standard",
    args: { naics: "336411" },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const m = env._meta;
      const shapeOk =
        d.found === true &&
        d.naics === "336411" &&
        d.standardType === "employees" &&
        d.unit === "employees";
      // A plausible employee headcount (small integer, NOT a millions-scaled $).
      const countOk =
        typeof d.threshold === "number" &&
        d.threshold === d.employeeCountLimit &&
        d.threshold > 0 &&
        d.threshold < 100_000; // employee caps are hundreds/thousands, never $millions
      const othersNull = d.revenueLimitUSD === null && d.assetLimitUSD === null;
      const caveat = (m.notes ?? []).some((n) => /adjusted periodically/i.test(n));
      return shapeOk && countOk && othersNull && caveat;
    },
  },
  {
    // (c) A non-existent NAICS → found:false, every field null, and the
    // disclosure that NO standard was fabricated (never a made-up number). The
    // "adjusted periodically" caveat is STILL present, and _meta.complete:false.
    label: "sba_size_standard: non-existent NAICS → found:false + disclosure (no fabricated standard)",
    name: "sba_size_standard",
    args: { naics: "000000" },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const m = env._meta;
      const notFound =
        d.found === false &&
        d.threshold === null &&
        d.unit === null &&
        d.standardType === "unknown" &&
        d.revenueLimitUSD === null &&
        d.employeeCountLimit === null &&
        d.assetLimitUSD === null;
      // A disclosure that nothing was fabricated for the missing code.
      const disclosure = (m.notes ?? []).some(
        (n) => /not present in the sba size-standards dataset/i.test(n) && /fabricated/i.test(n),
      );
      const caveat = (m.notes ?? []).some((n) => /adjusted periodically/i.test(n));
      const completeness = m.complete === false;
      return notFound && disclosure && caveat && completeness;
    },
  },
  {
    // (d) A malformed NAICS (not 6 digits) → STRUCTURED invalid_input at the
    // server (Zod) boundary, never a silent found:false or a crash.
    label: "sba_size_standard: malformed NAICS → structured invalid_input",
    name: "sba_size_standard",
    args: { naics: "54" },
    accept: ({ env }) =>
      env.ok === false &&
      env.error?.kind === "invalid_input" &&
      env.error?.retryable === false,
  },
  {
    // E-2 (spec §1.6, §5): grants_search output cfdaList must be an ARRAY on
    // every row (the runtime shape), not the string the old type declared —
    // and [] when absent, never undefined.
    label: "E-2: grants_search output cfdaList is an array",
    name: "grants_search",
    args: { keyword: "cybersecurity", rows: 3 },
    accept: ({ env }) => {
      if (!env.ok || !Array.isArray(env.data?.grants)) return false;
      if (env.data.grants.length === 0) return true; // empty page is acceptable
      // EVERY row must expose cfdaList as an array (never string/undefined).
      const allArrays = env.data.grants.every((g) => Array.isArray(g.cfdaList));
      // _meta.totalAvailable must be the real hitCount (a number).
      const totalOk = typeof env._meta?.totalAvailable === "number";
      return allArrays && totalOk;
    },
  },
  {
    // C4 (spec §1.4, §2.3): a capped spending_by_category aggregate must flag
    // truncation. The psc endpoint reports NO grand total, so totalAvailable
    // MUST be null (never the page length, spec §3.3) while truncated is true
    // (a small limit against a broad agency filter always overflows).
    label: "C4: capped psc_spending aggregate flags truncated + null total",
    name: "usas_search_psc_spending",
    args: { agency: "Department of Veterans Affairs", fiscalYear: 2024, limit: 3 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const returned = env.data?.psc?.length ?? 0;
      // No-total endpoint: totalAvailable must be null (NOT the page size).
      const totalNull = m.totalAvailable === null;
      // With limit 3 against a broad filter the endpoint has more → truncated.
      const truncatedOk = m.truncated === true && m.complete === false;
      // Pagination must advertise more and a truthful nextOffset.
      const pg = m.pagination ?? {};
      const pagOk = pg.hasMore === true && pg.limit === 3 && pg.nextOffset === returned;
      // A truncation note must be present (AI-actionable caveat).
      const noted = Array.isArray(m.notes) && m.notes.length >= 1;
      return totalNull && truncatedOk && pagOk && noted && returned <= 3;
    },
  },
  {
    // usas_search_recipients: recipient/ DOES report a real grand total in
    // page_metadata.total → _meta.totalAvailable must be a real number (not
    // null, not the page size) and data.totalRecords must mirror it.
    label: "search_recipients _meta.totalAvailable is a real number",
    name: "usas_search_recipients",
    args: { keyword: "tech", limit: 5 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const returned = env.data?.recipients?.length ?? 0;
      // "tech" matches thousands of recipients → a real number well above 5.
      const total = m.totalAvailable;
      const realNumber = typeof total === "number" && total >= returned;
      // data.totalRecords mirrors the real _meta total.
      const mirrored = env.data.totalRecords === total;
      // A full page with a much larger total ⇒ truncated + hasMore.
      const truncatedOk = returned < total ? (m.truncated === true && m.pagination?.hasMore === true) : true;
      return realNumber && mirrored && truncatedOk;
    },
  },
  {
    // usas_glossary: references/glossary reports a real total in
    // page_metadata.count (151). A small limit ⇒ real totalAvailable + truncated.
    label: "glossary _meta.totalAvailable is the real 151-term total",
    name: "usas_glossary",
    args: { limit: 3 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const total = m.totalAvailable;
      // Real total (the full glossary is ~151 terms) — must exceed the page.
      const realNumber = typeof total === "number" && total > 3;
      const mirrored = env.data.totalRecords === total;
      const truncatedOk = m.truncated === true && m.complete === false;
      return realNumber && mirrored && truncatedOk;
    },
  },
  {
    // usas_list_toptier_agencies: the endpoint IGNORES `limit` and returns the
    // COMPLETE ~111-agency set. So a small limit must NOT be reported as
    // truncated (false positive) — complete:true, and totalAvailable == returned.
    label: "toptier_agencies is complete despite small limit (limit ignored upstream)",
    name: "usas_list_toptier_agencies",
    args: { limit: 5 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const returned = env.data?.agencies?.length ?? 0;
      // Endpoint returns all agencies (~111) regardless of limit:5.
      const fullSet = returned > 50;
      const completeOk = m.complete === true && m.truncated === false;
      const totalMatches = m.totalAvailable === returned;
      const pagOk = (m.pagination?.hasMore ?? true) === false;
      return fullSet && completeOk && totalMatches && pagOk;
    },
  },
  {
    // Recompete radar (a): every returned row's currentEndDate must be INSIDE
    // the requested window, and the rows must be sorted soonest-first
    // (daysUntilCurrentEnd non-decreasing). Uses the corrected "End Date"
    // alias + client-side window — proves the window+sort actually apply.
    label: "recompetes: rows are within the window and sorted soonest-first",
    name: "usas_search_recompetes",
    args: {
      agency: "Department of Veterans Affairs",
      naics: "541512",
      windowStartDays: -90,
      windowEndDays: 548,
      minAwardValue: 1000000,
      pageSize: 15,
    },
    accept: ({ env }) => {
      if (!env.ok || !Array.isArray(env.data?.recompetes)) return false;
      const rows = env.data.recompetes;
      if (rows.length === 0) return true; // no in-window data today is acceptable
      // Live-soft: bounds are checked with a small slack (±2 days) so a
      // same-day boundary rounding never flakes the test.
      const inWindow = rows.every(
        (r) => r.daysUntilCurrentEnd >= -92 && r.daysUntilCurrentEnd <= 550,
      );
      // Sorted ascending by daysUntilCurrentEnd (soonest recompete first).
      let sorted = true;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].daysUntilCurrentEnd < rows[i - 1].daysUntilCurrentEnd) {
          sorted = false;
          break;
        }
      }
      // Each row must carry the shaped keys the tool promises.
      const shaped = rows.every(
        (r) =>
          typeof r.awardId === "string" &&
          typeof r.incumbent === "string" &&
          typeof r.currentEndDate === "string" &&
          typeof r.amount === "number" &&
          r.amount >= 1000000,
      );
      return inWindow && sorted && shaped;
    },
  },
  {
    // Recompete radar (b): _meta must carry the honest completeness contract —
    // a numeric-or-null totalAvailable (the in-window count when the scan was
    // complete, null when the scan budget truncated), a boolean truncated, and
    // notes that INCLUDE the CPARS / public-signals-only honest-ceiling caveat
    // and the action_date lookback completeness boundary.
    label: "recompetes: _meta carries totalInWindow/truncated + CPARS caveat note",
    name: "usas_search_recompetes",
    args: {
      agency: "Department of Veterans Affairs",
      naics: "541512",
      minAwardValue: 1000000,
      pageSize: 10,
    },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      // totalAvailable: a real in-window count (number) OR null when truncated.
      const total = m.totalAvailable;
      const totalOk = total === null || typeof total === "number";
      // When we DID get a full scan (total is a number), truncated must agree
      // with returned<total; when null (scan truncated) truncated must be true.
      const returned = env.data?.recompetes?.length ?? 0;
      const truncOk =
        total === null
          ? m.truncated === true
          : m.truncated === (returned < total);
      const notes = Array.isArray(m.notes) ? m.notes : [];
      const cparsNote = notes.some((n) => /cpars|protest|public signals/i.test(n));
      const lookbackNote = notes.some((n) => /action/i.test(n) && /year/i.test(n));
      // The unavailable public fields must be declared.
      const fieldsGone = ["past_performance_cpars", "protest_history", "option_exercise_intent"].every(
        (f) => (m.fieldsUnavailable ?? []).includes(f),
      );
      // Source must name the keyless spending_by_award origin.
      const sourceOk = typeof m.source === "string" && /spending_by_award/i.test(m.source);
      return totalOk && truncOk && cparsNote && lookbackNote && fieldsGone && sourceOk;
    },
  },
  {
    // usas_analyze_incumbent (a)+(b)+(d): resolve a LIVE large award id, then
    // assert the PUBLIC-signals contract: signals present with pctConsumed a
    // number|null (never a fabricated 0), _meta.fieldsUnavailable carries the
    // CPARS trio, an honest no-score note is present, and pressureHints is an
    // array that NEVER contains a numeric "score" (this tool emits HINTS only).
    label: "analyze_incumbent: public signals + CPARS-unavailable + no score",
    name: "usas_search_individual_awards",
    args: { agency: "Department of Veterans Affairs", naics: "541512", fiscalYear: 2024, limit: 3 },
    accept: async ({ env }) => {
      if (!env.ok || !Array.isArray(env.data?.awards) || env.data.awards.length === 0)
        return false;
      const gid = env.data.awards.find((a) => a.generatedInternalId)?.generatedInternalId;
      if (!gid) return false;
      const res = await call("usas_analyze_incumbent", {
        generatedInternalId: gid,
        otherAwardsLimit: 5,
      });
      const e = res.env;
      if (!e.ok || !e._meta) return false;
      const d = e.data;
      // (a) signals present + pctConsumed number|null (never a fabricated 0/undefined).
      const sig = d?.signals;
      if (!sig || !sig.obligatedVsCeiling) return false;
      const pct = sig.obligatedVsCeiling.pctConsumed;
      const pctOk = pct === null || typeof pct === "number";
      // award identity + modCount shape present.
      const awardOk =
        typeof d.award?.incumbent === "string" &&
        (sig.modCount === null || typeof sig.modCount === "number") &&
        typeof sig.modCountAtLeast === "boolean";
      // (b) _meta.fieldsUnavailable includes the CPARS trio + a no-score note.
      const fu = e._meta.fieldsUnavailable ?? [];
      const trioOk = ["past_performance_cpars", "protest_history", "option_exercise_intent"].every(
        (f) => fu.includes(f),
      );
      const notes = Array.isArray(e._meta.notes) ? e._meta.notes : [];
      const noScoreNote = notes.some(
        (n) => /no composite vulnerability score/i.test(n) || (/public signals only/i.test(n) && /score/i.test(n)),
      );
      // (d) pressureHints is an array; never a numeric "score" and no entry is a bare number.
      const hints = d.pressureHints;
      const hintsOk =
        Array.isArray(hints) &&
        hints.every((h) => typeof h === "string") &&
        !("vulnerabilityScore" in d) &&
        !("score" in (sig ?? {}));
      return pctOk && awardOk && trioOk && noScoreNote && hintsOk;
    },
  },
  {
    // usas_analyze_incumbent (c): a bogus generatedInternalId must yield a
    // STRUCTURED not_found (ok:false), NOT ok:true with data:null.
    label: "analyze_incumbent: bogus id → structured not_found (never ok:true/null)",
    name: "usas_analyze_incumbent",
    args: { generatedInternalId: "CONT_AWD_NOT_A_REAL_AWARD_0000_0000" },
    accept: ({ env }) =>
      env.ok === false &&
      env.error?.kind === "not_found" &&
      env.error?.retryable === false,
  },
  {
    // Recompete radar (c): the DEPRECATED alias must still return the legacy
    // { contracts, searchedCount } shape AND flag its deprecation in _meta.notes
    // so callers are steered to usas_search_recompetes.
    label: "expiring_contracts (deprecated alias) still returns + flags deprecation",
    name: "usas_search_expiring_contracts",
    args: {
      agency: "Department of Veterans Affairs",
      naics: "541512",
      monthsUntilExpiry: 18,
      minAwardValue: 1000000,
      limit: 5,
    },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      // Legacy output shape preserved.
      const shapeOk =
        Array.isArray(env.data?.contracts) &&
        typeof env.data?.searchedCount === "number";
      if (!shapeOk) return false;
      // Each legacy contract row keeps its historical keys.
      const rows = env.data.contracts;
      const rowsOk =
        rows.length === 0 ||
        rows.every(
          (c) =>
            typeof c.awardId === "string" &&
            typeof c.recipient === "string" &&
            typeof c.endDate === "string" &&
            typeof c.daysUntilExpiry === "number",
        );
      // Deprecation must be surfaced in _meta.notes.
      const notes = Array.isArray(env._meta.notes) ? env._meta.notes : [];
      const deprecated = notes.some((n) => /deprecated/i.test(n) && /recompetes/i.test(n));
      return rowsOk && deprecated;
    },
  },

  // ━━━ Pricing / Wage ━━━
  {
    // (a) WD search locality filter honesty. A 2-letter `state` is applied
    // SERVER-SIDE (verified: index=sca&state=VA narrows to ~30 and every
    // returned WD's location contains VA), while `county` is CLIENT-SIDE over
    // the fetched page — _meta must disclose both, with the page-bound caveat.
    label: "wage_determinations: state server-side + county client-side disclosed in _meta",
    name: "sam_search_wage_determinations",
    args: { coverage: "sca", state: "VA", county: "Fairfax", limit: 20 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const applied = m.filtersApplied ?? [];
      const notes = m.notes ?? [];
      // state applied server-side; county applied client-side.
      const stateServer = applied.some((f) => /state/i.test(f) && /server/i.test(f));
      const countyClient = applied.some((f) => /county/i.test(f) && /client/i.test(f));
      // A client-side pagination caveat must be present.
      const caveat = notes.some((n) => /client-?side/i.test(n) && /page/i.test(n));
      // Every returned WD (if any) must actually be in VA (proves the filter).
      const rows = env.data?.determinations ?? [];
      const allVA = rows.every((d) => (d.states ?? []).includes("VA"));
      // County client-filter ⇒ totalAvailable null (can't prove completeness).
      const totalNull = m.totalAvailable === null;
      return stateServer && countyClient && caveat && allVA && totalNull;
    },
  },
  {
    // (b) sam_get_wage_rates: SCA WD returns parseConfidence, a WD-wide H&W, an
    // EO minimum, AND supports format:"raw". Resolve a LIVE SCA ref first.
    label: "get_wage_rates: SCA has parseConfidence + WD-wide H&W + EO min + raw format",
    name: "sam_search_wage_determinations",
    args: { coverage: "sca", state: "VA", limit: 3 },
    accept: async ({ env }) => {
      if (!env.ok) return false;
      const ref = env.data?.determinations?.[0]?.fullReferenceNumber;
      if (!ref) return false;

      // Parsed mode.
      const parsed = await call("sam_get_wage_rates", { reference: ref, coverage: "sca" });
      const p = parsed.env;
      if (!p.ok) return false;
      const confOk = p.data.parseConfidence === "high" || p.data.parseConfidence === "low";
      // SCA carries a WD-WIDE Health & Welfare (a number OR null if unparsed).
      const hwKey = Object.prototype.hasOwnProperty.call(p.data, "healthAndWelfarePerHour");
      const hwOk =
        p.data.healthAndWelfarePerHour === null ||
        typeof p.data.healthAndWelfarePerHour === "number";
      // An EO minimum-wage floor is surfaced (object {executiveOrder,minimumWage}
      // when parsed; null only if genuinely absent — but active SCA WDs cite one).
      const eo = p.data.executiveOrderMinimumWage;
      const eoOk =
        eo === null ||
        (eo && typeof eo.minimumWage === "number" && typeof eo.executiveOrder === "string");
      const eoSurfaced = eo && typeof eo.minimumWage === "number";
      const ratesArr = Array.isArray(p.data.rates);
      const srcOk = typeof p.data.sourceUrl === "string";

      // Raw mode: the full document text, no fabricated parsed structure.
      const raw = await call("sam_get_wage_rates", { reference: ref, coverage: "sca", format: "raw" });
      const rawOk =
        raw.env.ok &&
        typeof raw.env.data.document === "string" &&
        raw.env.data.document.length > 100 &&
        raw.env.data.rates === undefined;

      return confOk && hwKey && hwOk && eoOk && eoSurfaced && ratesArr && srcOk && rawOk;
    },
  },
  {
    // (c) gsa_benchmark_labor_rates returns a DISTRIBUTION (min/median/max/n) +
    // the ceiling/burdened caveats in _meta, and handles a SATURATED count
    // honestly (totalAvailable null when relation != "eq"). Use a broad category.
    label: "benchmark_labor_rates: distribution + ceiling/burdened caveats + saturation honesty",
    name: "gsa_benchmark_labor_rates",
    args: { laborCategory: "Analyst" },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const m = env._meta;
      // Distribution shape: currentRate has min/median/max/n (numbers or null).
      const cr = d.currentRate;
      const distOk =
        cr &&
        (cr.min === null || typeof cr.min === "number") &&
        (cr.median === null || typeof cr.median === "number") &&
        (cr.max === null || typeof cr.max === "number") &&
        typeof cr.n === "number";
      const escOk =
        d.escalatedRate &&
        (d.escalatedRate.nextYearMedian === null || typeof d.escalatedRate.nextYearMedian === "number");
      // Ceiling + fully-burdened caveats must be present in notes.
      const notes = m.notes ?? [];
      const ceilingNote = notes.some((n) => /ceiling|catalog/i.test(n));
      const burdenedNote = notes.some((n) => /burdened/i.test(n) && /wrap/i.test(n));
      // Saturation honesty: "Analyst" saturates at 10000/gte → totalAvailable
      // null + matchCountSaturated true + a saturation note. If (rarely) it were
      // exact, totalAvailable would be a number — accept either but require the
      // saturated case to null the total.
      let satOk;
      if (d.matchCountSaturated) {
        satOk =
          m.totalAvailable === null &&
          notes.some((n) => /saturat/i.test(n));
      } else {
        satOk = typeof m.totalAvailable === "number";
      }
      return distOk && escOk && ceilingNote && burdenedNote && satOk;
    },
  },
  {
    // (d) A bogus WD reference → STRUCTURED not_found (never ok:true with an
    // empty/fabricated table). Uses a well-formed-but-nonexistent SCA ref.
    label: "get_wage_rates: bogus WD reference → structured not_found",
    name: "sam_get_wage_rates",
    args: { reference: "2015-0000", revision: 99 },
    accept: ({ env }) =>
      env.ok === false &&
      env.error?.kind === "not_found" &&
      env.error?.retryable === false,
  },
  {
    // dba→dbra normalization + DBA per-craft fringe shape (distinct from SCA's
    // WD-wide H&W). A literal index=dba is an HTTP 400 upstream; the tool must
    // normalize it and return DBA rows whose fringe is per-craft.
    label: "wage_determinations: dba coverage normalizes + DBA rows carry per-craft fringe",
    name: "sam_search_wage_determinations",
    args: { coverage: "dba", state: "IA", limit: 3 },
    accept: async ({ env }) => {
      if (!env.ok) return false;
      const first = env.data?.determinations?.[0];
      if (!first || first.coverage !== "DBA") return false;
      const rates = await call("sam_get_wage_rates", {
        reference: first.fullReferenceNumber,
        revision: first.revisionNumber,
        coverage: "dba",
      });
      const r = rates.env;
      if (!r.ok || r.data.coverage !== "DBA" || !Array.isArray(r.data.rates)) return false;
      if (r.data.rates.length === 0) return true; // empty is acceptable
      // DBA fringe is PER-CRAFT: each row carries its OWN fringePerHour key, and
      // there is NO WD-wide healthAndWelfarePerHour on a DBA determination.
      const perCraftFringe = r.data.rates.every((row) =>
        Object.prototype.hasOwnProperty.call(row, "fringePerHour"),
      );
      const noWideHW = r.data.healthAndWelfarePerHour === undefined;
      return perCraftFringe && noWideHW;
    },
  },

  // ━━━ Integrity / Teaming ━━━
  {
    // (a1) NAME-GATE regression guard (the adversarial BLOCK): SAM's free-text
    // `q` tokenizes, so a query must NOT flag every record sharing a word. A
    // generic word ("construction") returns loose hits that are DROPPED —
    // `records`/`excluded` reflect ONLY normalized-name matches, and the
    // "not proof of responsibility" disclosure is ALWAYS present.
    label: "check_exclusions: name-gated (tokenized loose hits dropped, no false-positive)",
    name: "sam_check_exclusions",
    args: { query: "construction", size: 10 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const norm = (s) =>
        (s ?? "")
          .toUpperCase()
          .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, " ")
          .replace(/\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC|PC)\b/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const target = norm("construction");
      // No tokenized "…construction…" firm may leak: every returned record's
      // normalized name must EQUAL the query.
      const gated = Array.isArray(d.records) && d.records.every((r) => norm(r.name) === target);
      // excluded is consistent with the gated records (never a loose-hit true).
      const consistent = d.excluded === d.records.some((r) => r.isActive === true);
      const notes = env._meta.notes ?? [];
      const disclosure = notes.some((n) => /not\s+proof/i.test(n) && /responsibility/i.test(n));
      return gated && consistent && disclosure && env._meta.keylessMode === true;
    },
  },
  {
    // (a1b) The EXACT adversarial repro: a real firm name whose common tokens
    // ("PARTNERS"/"CONSULTING") hit MANY unrelated exclusions must NOT be
    // flagged excluded — the tokenized hits are dropped by the name-gate.
    // Guards the reviewer's blind spot (the old suite only used a 0-hit token).
    label: "check_exclusions: tokenized firm name is not a false-positive (VISIONARY CONSULTING PARTNERS)",
    name: "sam_check_exclusions",
    args: { query: "VISIONARY CONSULTING PARTNERS, LLC", size: 25 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const norm = (s) =>
        (s ?? "")
          .toUpperCase()
          .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, " ")
          .replace(/\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC|PC)\b/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      const target = norm("VISIONARY CONSULTING PARTNERS, LLC");
      // Every record present must actually name-match; no tokenized false-positive.
      const gated = Array.isArray(d.records) && d.records.every((r) => norm(r.name) === target);
      const consistent = d.excluded === d.records.some((r) => r.isActive === true);
      return gated && consistent && env._meta.keylessMode === true;
    },
  },
  {
    // (a2) An empty result is a NARROW true-negative — excluded:false, zero
    // records, and the "not proof of responsibility" disclosure STILL present
    // (an empty screen must never read as a clean bill of health).
    label: "check_exclusions: empty result → excluded:false + 'not proof' disclosure still present",
    name: "sam_check_exclusions",
    args: { query: "zzzznotarealexcludedentityxyzzz" },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const emptyOk = d.excluded === false && d.matchCount === 0 && d.records.length === 0;
      const notes = env._meta.notes ?? [];
      const disclosure = notes.some(
        (n) => /not\s+proof/i.test(n) && /responsibility/i.test(n),
      );
      // A true-negative is COMPLETE (nothing truncated/dropped) yet still hedged.
      return emptyOk && disclosure;
    },
  },
  {
    // (a3) No selector (no query/uei/cage) → structured invalid_input, never a
    // silent unbounded dump.
    label: "check_exclusions: no selector → structured invalid_input",
    name: "sam_check_exclusions",
    args: {},
    accept: ({ env }) =>
      env.ok === false &&
      env.error?.kind === "invalid_input" &&
      env.error?.retryable === false,
  },
  {
    // (b1) A BOGUS cert must yield a STRUCTURED invalid_input (ok:false) — NOT a
    // silent ok:true with an empty candidate list. This is THE guardrail: the
    // endpoint silently accepts a bad recipient_type_names and returns 0.
    label: "teaming_partners: bogus cert → structured invalid_input (never silent-empty ok:true)",
    name: "usas_search_teaming_partners",
    args: { cert: "totally_bogus_cert_value", naics: "541512" },
    accept: ({ env }) =>
      env.ok === false &&
      env.error?.kind === "invalid_input" &&
      env.error?.retryable === false &&
      // The rejection must name the offending `cert` field (the enum guard is
      // what stops the endpoint's silent-accept-and-return-0 behavior); the
      // message also surfaces the valid options.
      /cert/i.test(env.error?.message ?? "") &&
      /8a_program_participant/i.test(env.error?.message ?? ""),
  },
  {
    // (b2)+(c) A VALID cert returns ranked candidates, the AWARD-DERIVED proxy
    // caveat is in _meta, and the excludeDebarred screen is reflected in _meta
    // (how many screened/removed). Narrow slice + small caps to stay fast.
    label: "teaming_partners: valid cert → ranked candidates + proxy caveat + screen reflected in _meta",
    name: "usas_search_teaming_partners",
    args: {
      cert: "8a_program_participant",
      naics: "541512",
      agency: "Department of Veterans Affairs",
      lookbackYears: 3,
      limit: 5,
      screenCap: 3,
      scanPages: 2,
    },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const m = env._meta;
      // Ranked candidates present, each with the promised shape; ranking is by
      // agencyObligated desc (non-increasing).
      const cands = d.candidates ?? [];
      if (cands.length === 0) return false;
      const shaped = cands.every(
        (c) =>
          typeof c.recipientName === "string" &&
          c.cert === "8a_program_participant" &&
          typeof c.agencyObligated === "number" &&
          typeof c.agencyAwardCount === "number" &&
          Array.isArray(c.sampleAwards) &&
          Array.isArray(c.naicsMatched),
      );
      let ranked = true;
      for (let i = 1; i < cands.length; i++) {
        if (cands[i].agencyObligated > cands[i - 1].agencyObligated) {
          ranked = false;
          break;
        }
      }
      // The award-derived proxy caveat (proxy ≠ SBA registry of record) MUST be present.
      const notes = m.notes ?? [];
      const proxyNote = notes.some(
        (n) => /award/i.test(n) && /sba certification of record/i.test(n),
      );
      // The exclusion screen must be reflected in _meta (screened/removed counts).
      const screenNote = notes.some(
        (n) => /screen/i.test(n) && /exclusion/i.test(n),
      );
      // Proxy honesty: SBA cert of record + UEI are declared unavailable.
      const fu = m.fieldsUnavailable ?? [];
      const fieldsOk =
        fu.some((f) => /sbaCertificationOfRecord/i.test(f)) &&
        fu.some((f) => /uei/i.test(f));
      // Source names the award-derived keyless proxy.
      const sourceOk = typeof m.source === "string" && /award-derived/i.test(m.source);
      return shaped && ranked && proxyNote && screenNote && fieldsOk && sourceOk;
    },
  },
  {
    // (integrity a) NOT-EXCLUDED entity → integrityFlag "review_fapiis" (NEVER
    // "clear"), fapiisRecords null (key-gated, never faked),
    // _meta.fieldsUnavailable includes "fapiisRecords", and the "not a full
    // integrity clearance" note is present. Uses a clearly-not-excluded firm.
    label: "integrity_lookup: not-excluded → review_fapiis + fapiisRecords null + fieldsUnavailable + not-a-clearance note",
    name: "sam_integrity_lookup",
    args: { name: "Boeing" },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const m = env._meta;
      const flagOk = d.integrityFlag === "review_fapiis";
      const exclOk =
        d.exclusions &&
        d.exclusions.excluded === false &&
        d.exclusions.activeCount === 0 &&
        Array.isArray(d.exclusions.records) &&
        d.exclusions.records.length === 0;
      // fapiisRecords is ALWAYS null (never faked) and declared unavailable.
      const fapiisNull = d.fapiisRecords === null;
      const fieldGone = (m.fieldsUnavailable ?? []).includes("fapiisRecords");
      const urlOk = typeof d.fapiisUrl === "string" && /sam\.gov/i.test(d.fapiisUrl);
      // The "not a full integrity clearance" disclosure must be present.
      const notes = m.notes ?? [];
      const clearanceNote = notes.some(
        (n) => /not a full integrity clearance/i.test(n) && /no keyless machine API/i.test(n),
      );
      // Carry-through of the exclusion tool's own honesty (not-proof).
      const notProof = notes.some(
        (n) => /not\s+proof/i.test(n) && /responsibility/i.test(n),
      );
      const keyless = m.keylessMode === true;
      // Source names the keyless exclusions + FAPIIS deep-link composition.
      const sourceOk = typeof m.source === "string" && /fapiis/i.test(m.source);
      return flagOk && exclOk && fapiisNull && fieldGone && urlOk && clearanceNote && notProof && keyless && sourceOk;
    },
  },
  {
    // (integrity b) EXCLUDED entity → integrityFlag "excluded", exclusions.excluded
    // true, with at least one ACTIVE matching record. "Construction Associates"
    // is an active-excluded firm (DOL, verified live via the SGS index=ex list);
    // if SAM ever terminates it, this soft-passes on the still-correct shape.
    label: "integrity_lookup: excluded entity → integrityFlag 'excluded' + exclusions.excluded true",
    name: "sam_integrity_lookup",
    args: { name: "Construction Associates" },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      // Shape must always hold; the flag mirrors exclusions.excluded exactly.
      const consistent =
        (d.integrityFlag === "excluded") === (d.exclusions?.excluded === true);
      const neverClear = d.integrityFlag !== "clear";
      const fapiisNull = d.fapiisRecords === null;
      if (d.exclusions?.excluded === true) {
        // The live-verified hit path: flag excluded + an active record present.
        const hit =
          d.integrityFlag === "excluded" &&
          d.exclusions.activeCount >= 1 &&
          Array.isArray(d.exclusions.records) &&
          d.exclusions.records.some((r) => r.isActive === true);
        return hit && neverClear && fapiisNull;
      }
      // Soft path (record terminated since verification): still consistent + never clear.
      return consistent && neverClear && fapiisNull;
    },
  },
  {
    // (integrity c) No identifier (no uei/cage/name) → structured invalid_input,
    // never a silent unbounded/empty verdict.
    label: "integrity_lookup: no identifier → structured invalid_input",
    name: "sam_integrity_lookup",
    args: {},
    accept: ({ env }) =>
      env.ok === false &&
      env.error?.kind === "invalid_input" &&
      env.error?.retryable === false,
  },
  {
    // (integrity d) integrityFlag is NEVER "clear" keylessly — across both an
    // excluded and a not-excluded query the flag is one of the two honest values
    // and is only "excluded" when exclusions.excluded is true.
    label: "integrity_lookup: integrityFlag is never 'clear' (both excluded and not-excluded queries)",
    name: "sam_integrity_lookup",
    args: { name: "zzzznotarealentityxyzzz" },
    accept: async ({ env }) => {
      if (!env.ok) return false;
      const d = env.data;
      // The empty query yields review_fapiis (no exclusion) — never "clear".
      const emptyOk =
        d.integrityFlag === "review_fapiis" &&
        d.integrityFlag !== "clear" &&
        d.exclusions?.excluded === false;
      // And an excluded query yields "excluded" (still not "clear").
      const excl = await call("sam_integrity_lookup", { name: "Construction Associates" });
      const e = excl.env;
      if (!e.ok) return false;
      const exclFlagOk =
        e.data.integrityFlag !== "clear" &&
        (e.data.integrityFlag === "excluded") === (e.data.exclusions?.excluded === true);
      return emptyOk && exclFlagOk;
    },
  },
  // ━━━ GAO — Bid Protests ━━━
  {
    // (a) The honesty contract: _meta is ALWAYS complete:false + truncated:true
    // (the feed is a recent window, never the full history), totalAvailable is
    // null (the feed is not a count of all protests), and BOTH the top-level
    // accessNote AND a _meta note spell out the WAF-blocked / paid-API boundary.
    label: "gao_protest_lookup: _meta always complete:false/truncated:true + paid-API caveat",
    name: "gao_protest_lookup",
    args: { limit: 5 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const scopeOk =
        m.complete === false &&
        m.truncated === true &&
        m.totalAvailable === null &&
        m.keylessMode === true;
      // The top-level accessNote is present and names the paid API.
      const accessOk =
        typeof env.data?.accessNote === "string" &&
        /paid/i.test(env.data.accessNote) &&
        /waf|blocked|automated/i.test(env.data.accessNote);
      // A _meta note must ALSO carry the caveat (WAF-blocked + paid).
      const notes = Array.isArray(m.notes) ? m.notes : [];
      const noteOk = notes.some(
        (n) => /paid/i.test(n) && /(waf|blocked|automated|historical)/i.test(n),
      );
      // Source names the keyless GAO RSS origin.
      const sourceOk = typeof m.source === "string" && /gao\.gov/i.test(m.source);
      return scopeOk && accessOk && noteOk && sourceOk;
    },
  },
  {
    // (b) A client-side agency substring filter narrows the recent-protest set
    // and is disclosed in _meta.filtersApplied. Live-soft: if the narrowed set
    // is empty today that's still a valid (honest) narrowing — we only require
    // that the filter is recorded and the result is a subset (never larger).
    label: "gao_protest_lookup: agency substring filter narrows + is disclosed",
    name: "gao_protest_lookup",
    args: { limit: 25, enrich: false },
    accept: async ({ env }) => {
      if (!env.ok || !Array.isArray(env.data?.decisions)) return false;
      const baseCount = env.data.decisions.length;
      // Pick a term from a real returned title to guarantee a live substring.
      const sampleTitle = env.data.decisions[0]?.title ?? "";
      const term = (sampleTitle.split(/[\s,]+/)[0] || "LLC").slice(0, 6);
      const narrowed = await call("gao_protest_lookup", {
        agency: term,
        limit: 25,
        enrich: false,
      });
      const n = narrowed.env;
      if (!n.ok || !Array.isArray(n.data?.decisions)) return false;
      // The filter must be recorded as applied…
      const applied = n._meta?.filtersApplied ?? [];
      const disclosed = applied.some((f) => /agency/i.test(f));
      // …and the narrowed set must be a subset (never MORE than the base set).
      const isSubset = n.data.decisions.length <= baseCount;
      // Still honest about scope on the filtered call.
      const stillPartial = n._meta?.complete === false && n._meta?.truncated === true;
      return disclosed && isSubset && stillPartial;
    },
  },
  {
    // (c) A well-formed-but-nonexistent B-number → STRUCTURED not_found
    // (ok:false), never a crash and never ok:true with an empty/fabricated
    // decision that reads as "no protest here".
    label: "gao_protest_lookup: bogus bNumber → structured not_found (never crash/empty-as-success)",
    name: "gao_protest_lookup",
    args: { bNumber: "B-000000.99" },
    accept: ({ env }) =>
      env.ok === false &&
      env.error?.kind === "not_found" &&
      env.error?.retryable === false,
  },

  // ━━━ GSA daily-CSV keyless backbone — DISABLED-path + input guards ━━━
  // NOTE: this suite's server runs with NO CSV env → the backbone is DISABLED.
  // The ENABLED fixture path is exercised separately below (a second server
  // spawned with SAM_GOV_CSV_FIXTURE) so CI never pulls the live 226 MB CSV.
  {
    // DISABLED default: enabled:false + a structured "how to enable" note, every
    // row found:false + null fields, NO network download, NOT an error. The
    // _meta must flag every enrichment field as fieldsUnavailable and carry the
    // enable instructions (SAM_GOV_CSV_CACHE / SAM_GOV_ENABLE_CSV).
    label: "lookup_notice_fields: DISABLED by default → structured enable-note, no data, no download",
    name: "sam_lookup_notice_fields",
    args: { noticeIds: ["a4be592da0304872a252980925b9458f", "c7a871f27b5046be81549a9fdc9719c7"] },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const d = env.data;
      const enabledFalse = d.enabled === false && d.freshness === null;
      const allEmpty =
        Array.isArray(d.results) &&
        d.results.length === 2 &&
        d.results.every(
          (x) => x.found === false && x.naicsCode === null && x.setAside === null && x.type === null,
        );
      const notes = env._meta.notes ?? [];
      // The disclosure must both flag it DISABLED and name the enable env vars
      // (across the notes — not necessarily in a single sentence).
      const disabledNote = notes.some((n) => /disabled/i.test(n));
      const enableVarsNote = notes.some((n) => /SAM_GOV_CSV_CACHE|SAM_GOV_ENABLE_CSV/.test(n));
      const enableNote = disabledNote && enableVarsNote;
      // Enrichment fields flagged unavailable (not silently dropped).
      const fu = env._meta.fieldsUnavailable ?? [];
      const fieldsFlagged = ["naicsCode", "setAside", "popState"].every((f) => fu.includes(f));
      const sourceOk = typeof env._meta.source === "string" && /gsa\.gov.*csv/i.test(env._meta.source);
      return enabledFalse && allEmpty && enableNote && fieldsFlagged && sourceOk && env._meta.keylessMode === true;
    },
  },
  {
    // Empty noticeIds array → structured invalid_input (never an empty success).
    label: "lookup_notice_fields: empty noticeIds → structured invalid_input",
    name: "sam_lookup_notice_fields",
    args: { noticeIds: [] },
    accept: ({ env }) =>
      env.ok === false &&
      env.error?.kind === "invalid_input" &&
      env.error?.retryable === false,
  },
  {
    // Over-cap (>100) noticeIds → structured invalid_input (Zod .max(100) at the
    // server boundary surfaces as invalid_input with the field issue).
    label: "lookup_notice_fields: >100 noticeIds → structured invalid_input",
    name: "sam_lookup_notice_fields",
    args: { noticeIds: Array.from({ length: 101 }, (_, i) => "a".repeat(31) + (i % 10)) },
    accept: ({ env }) =>
      env.ok === false &&
      env.error?.kind === "invalid_input" &&
      env.error?.retryable === false,
  },
];

// ── RFC-4180 parser unit tests (in-process, no server, no network) ──
// Imports the compiled module directly and asserts the state machine handles
// quoted / embedded-comma / ""-escape / newline-in-quote cases correctly.
async function runParserUnitTests() {
  console.log("\n--- RFC-4180 parser unit tests (in-process) ---");
  let p = 0, f = 0;
  let parseRecordFields;
  try {
    ({ parseRecordFields } = await import("./dist/gsa-csv.js"));
  } catch (e) {
    console.log(`✗ could not import dist/gsa-csv.js: ${e.message}`);
    return { pass: 0, fail: 1 };
  }
  const check = (label, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    console.log(`${ok ? "✓" : "✗"} parser: ${label}`);
    if (!ok) console.log(`    got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    ok ? p++ : f++;
  };
  // plain unquoted fields
  check("plain fields", parseRecordFields("a,b,c", 24).fields, ["a", "b", "c"]);
  // embedded comma inside quotes stays one field
  check("embedded comma", parseRecordFields('a,"x, y, z",c', 24).fields, ["a", "x, y, z", "c"]);
  // ""-escape → a single literal quote
  check('""-escape', parseRecordFields('a,"say ""hi""",c', 24).fields, ["a", 'say "hi"', "c"]);
  // a line that ends inside an open quote reports inQuotes:true (record spans lines)
  {
    const r = parseRecordFields('a,"line one', 24);
    check("open-quote inQuotes flag", r.inQuotes, true);
  }
  // a balanced quoted field reports inQuotes:false
  check("balanced inQuotes flag", parseRecordFields('a,"whole",c', 24).inQuotes, false);
  // fields are capped at maxCol but quote-scanning continues past it: a newline
  // inside a LATER (col>maxCol) quoted field must still be detected as spanning.
  {
    const line = "id,t" + ",x".repeat(30) + ',"desc opens a quote then the line breaks';
    const r = parseRecordFields(line, 24);
    // stored fields capped (<= 26 = maxCol+1 up to and incl. col 24, plus the
    // early cells) and inQuotes must be true (the late quote is open).
    check("late-column newline still spans (inQuotes)", r.inQuotes, true);
    check("stored fields capped at maxCol+1", r.fields.length <= 25, true);
  }
  return { pass: p, fail: f };
}

// ── Inline search-enrichment merge tests (in-process, offline) ──────
// Live HAL noticeIds won't be in a small fixture, so we test the enrichment
// MERGE LOGIC in isolation: warm the fixture index (the ids we control), feed a
// SYNTHETIC HAL search page with those ids through enrichSearchOpportunities,
// and assert null naics/setAside/PoP/deadline/type get filled + the accounting
// (fieldsFilled / found / missing / freshness). Also exercises the NON-BLOCKING
// accessor: cold → null (degrade), disabled → null (no network), warm → ready.
async function runEnrichmentMergeTests() {
  console.log("\n--- Inline search-enrichment merge tests (in-process, offline) ---");
  let p = 0, f = 0;
  const t = (label, ok) => { console.log(`${ok ? "✓" : "✗"} enrich: ${label}`); ok ? p++ : f++; };

  let mod;
  try {
    mod = await import("./dist/gsa-csv.js");
  } catch (e) {
    console.log(`✗ could not import dist/gsa-csv.js: ${e.message}`);
    return { pass: 0, fail: 1 };
  }
  const {
    resolveCsvConfig,
    tryGetReadyIndex,
    enrichSearchOpportunities,
    lookupNoticeFields,
    _resetIndexForTests,
  } = mod;

  // (0) DISABLED → the accessor does no work and returns null (no network).
  {
    _resetIndexForTests();
    const disabledCfg = resolveCsvConfig({}); // empty env → disabled
    t("disabled config → tryGetReadyIndex returns null (no network)",
      disabledCfg.enabled === false && tryGetReadyIndex(disabledCfg) === null);
  }

  // Point a config at the small local fixture (no live 226 MB pull).
  const fixtureEnv = { SAM_GOV_CSV_FIXTURE: FIXTURE_CSV };
  const cfg = resolveCsvConfig(fixtureEnv);
  t("fixture config resolves enabled", cfg.enabled === true && cfg.fixturePath === FIXTURE_CSV);

  // (1) COLD → the FIRST accessor call returns null immediately (degrade path)
  // and kicks a background warm. Proves the search never blocks on a cold CSV.
  _resetIndexForTests();
  const coldFirst = tryGetReadyIndex(cfg);
  t("cold index → tryGetReadyIndex returns null immediately (non-blocking degrade)",
    coldFirst === null);

  // Warm the index deterministically (await ensureIndex via the batch tool,
  // which builds the fixture index) then confirm the accessor now returns it.
  await lookupNoticeFields({ noticeIds: ["aaaa0000aaaa0000aaaa0000aaaa0001"] }, fixtureEnv);
  const ready = tryGetReadyIndex(cfg);
  t("after warm → tryGetReadyIndex returns a ready index",
    !!ready && typeof ready.get === "function" && ready.rowCount === 5 &&
    typeof ready.indexBuiltAt === "string");

  // (2) MERGE: a synthetic keyless HAL page (all naics/setAside/deadline null,
  // no type/PoP keys) whose ids match the fixture — plus one ABSENT id.
  const halPage = [
    { noticeId: "aaaa0000aaaa0000aaaa0000aaaa0001", title: "HAL title A", agency: "VA", solicitationNumber: "S-A", responseDeadline: null, naics: null, setAside: null, uiLink: "u-a" },
    { noticeId: "bbbb1111bbbb1111bbbb1111bbbb0002", title: "HAL title B", agency: "GSA", solicitationNumber: "S-B", responseDeadline: null, naics: null, setAside: null, uiLink: "u-b" },
    { noticeId: "cccc2222cccc2222cccc2222cccc0003", title: "HAL title C", agency: "DoD", solicitationNumber: "S-C", responseDeadline: null, naics: null, setAside: null, uiLink: "u-c" },
    { noticeId: "ffff9999ffff9999ffff9999ffff0000", title: "HAL title MISSING", agency: "??", solicitationNumber: "S-M", responseDeadline: null, naics: null, setAside: null, uiLink: "u-m" },
  ];
  const outcome = enrichSearchOpportunities(halPage, ready);
  const out = Object.fromEntries(outcome.opportunities.map((o) => [o.noticeId, o]));

  const A = out["aaaa0000aaaa0000aaaa0000aaaa0001"];
  t("row A: naics/setAside(code)/deadline/type/PoP filled from CSV",
    A.naics === "541512" && A.setAside === "SBA" &&
    A.responseDeadline === "2026-08-15T17:00:00-04:00" && A.type === "Solicitation" &&
    A.placeOfPerformance && A.placeOfPerformance.state === "VA" &&
    A.placeOfPerformance.city === "Richmond" && A.placeOfPerformance.zip === "23219" &&
    A.placeOfPerformance.country === "USA");
  t("row A: HAL-supplied fields preserved (title/agency not overwritten)",
    A.title === "HAL title A" && A.agency === "VA" && A.uiLink === "u-a");

  const B = out["bbbb1111bbbb1111bbbb1111bbbb0002"];
  t("row B: embedded-comma-safe fill (naics 236220, setAside 8A, PoP TX)",
    B.naics === "236220" && B.setAside === "8A" &&
    B.type === "Combined Synopsis/Solicitation" &&
    B.placeOfPerformance && B.placeOfPerformance.state === "TX");

  const C = out["cccc2222cccc2222cccc2222cccc0003"];
  // Fixture row C has empty SetAsideCode + no Pop* cells → those stay null and
  // the placeOfPerformance/setAside keys are NOT added (absence ≠ empty).
  t("row C: empty CSV cells stay null (naics filled, setAside null, no PoP key)",
    C.naics === "339112" && C.type === "Special Notice" &&
    C.setAside === null &&
    !("placeOfPerformance" in C));

  const M = out["ffff9999ffff9999ffff9999ffff0000"];
  // Absent from the snapshot → left byte-identical (still all null, no new keys).
  t("row MISSING: absent id untouched (all null, no type/PoP keys added)",
    M.naics === null && M.setAside === null && M.responseDeadline === null &&
    !("type" in M) && !("placeOfPerformance" in M) && M.title === "HAL title MISSING");

  // (3) Accounting: 3 found / 1 missing; fieldsFilled includes the trio; the
  // freshness block is present with the snapshot metadata.
  t("accounting: foundCount=3, missingCount=1",
    outcome.foundCount === 3 && outcome.missingCount === 1);
  t("fieldsFilled includes naics + setAside + placeOfPerformance (drop from unavailable)",
    outcome.fieldsFilled.has("naics") && outcome.fieldsFilled.has("setAside") &&
    outcome.fieldsFilled.has("placeOfPerformance") && outcome.fieldsFilled.has("type") &&
    outcome.fieldsFilled.has("responseDeadline"));
  t("freshness present (csvLastModified + indexBuiltAt + rowCount)",
    outcome.freshness && typeof outcome.freshness.indexBuiltAt === "string" &&
    outcome.freshness.rowCount === 5);

  // (4) No-overwrite guarantee: a row that ALREADY has a value (keyed-like) is
  // never clobbered by the CSV.
  {
    const keyedRow = [{ noticeId: "aaaa0000aaaa0000aaaa0000aaaa0001", title: "x", naics: "999999", setAside: "PRESET", responseDeadline: "PRESET-DL", uiLink: "u" }];
    const r2 = enrichSearchOpportunities(keyedRow, ready);
    const k = r2.opportunities[0];
    t("no-overwrite: pre-set naics/setAside/deadline preserved (null-only fill)",
      k.naics === "999999" && k.setAside === "PRESET" && k.responseDeadline === "PRESET-DL" &&
      // type/PoP were null on input, so they DO get filled from the CSV.
      k.type === "Solicitation" && !!k.placeOfPerformance);
  }

  _resetIndexForTests();
  return { pass: p, fail: f };
}

// ── ENABLED fixture path (a SECOND server spawned with SAM_GOV_CSV_FIXTURE) ──
// Points the backbone at the small local test-fixtures/gsa-sample.csv so the
// test does NOT pull the live 226 MB CSV. Asserts a known noticeId returns its
// fields, an unknown one returns found:false + the "not in current CSV snapshot"
// disclosure, and _meta.source + freshness are present.
async function runEnabledFixtureTests() {
  console.log("\n--- ENABLED fixture path (offline, SAM_GOV_CSV_FIXTURE) ---");
  let p = 0, f = 0;

  const fx = spawn("node", ["dist/server.js"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SAM_GOV_CSV_FIXTURE: FIXTURE_CSV },
  });
  fx.stderr.on("data", (chunk) => process.stderr.write(`[fixture-server] ${chunk}`));
  const resp = new Map();
  let fbuf = "";
  fx.stdout.on("data", (chunk) => {
    fbuf += chunk.toString();
    let nl;
    while ((nl = fbuf.indexOf("\n")) >= 0) {
      const line = fbuf.slice(0, nl);
      fbuf = fbuf.slice(nl + 1);
      if (!line.trim()) continue;
      try { const m = JSON.parse(line); if (m.id !== undefined) resp.set(m.id, m); } catch {}
    }
  });
  let fid = 1;
  const frpc = async (method, params) => {
    const myId = fid++;
    fx.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    for (let i = 0; i < 250; i++) {
      if (resp.has(myId)) return resp.get(myId);
      await wait(80);
    }
    throw new Error(`fixture timeout ${method}`);
  };
  const fcall = async (name, args) => {
    const r = await frpc("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? "";
    let env; try { env = JSON.parse(text); } catch { env = { ok: false }; }
    return env;
  };
  const t = (label, ok) => { console.log(`${ok ? "✓" : "✗"} fixture: ${label}`); ok ? p++ : f++; };

  try {
    await frpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "edge-fixture", version: "0.0.1" },
    });

    // A known noticeId + a couple of edge rows + one absent id.
    const env = await fcall("sam_lookup_notice_fields", {
      noticeIds: [
        "aaaa0000aaaa0000aaaa0000aaaa0001", // clean row → SBA, VA, 541512
        "bbbb1111bbbb1111bbbb1111bbbb0002", // embedded-comma title
        "cccc2222cccc2222cccc2222cccc0003", // ""-escaped quote title, inactive
        "EEEE4444EEEE4444EEEE4444EEEE0005", // uppercase id, queried as-is
        "ffff9999ffff9999ffff9999ffff0000", // ABSENT from snapshot
      ],
    });

    t("envelope ok:true with enabled:true", env.ok === true && env.data?.enabled === true);
    const byId = Object.fromEntries((env.data?.results ?? []).map((r) => [r.noticeId.toLowerCase(), r]));

    const a = byId["aaaa0000aaaa0000aaaa0000aaaa0001"];
    t("known notice → found + correct fields (naics/setAsideCode/PoP/type/active/title)",
      !!a && a.found === true && a.naicsCode === "541512" && a.setAsideCode === "SBA" &&
      a.setAside === "Total Small Business Set-Aside (FAR 19.5)" && a.popState === "VA" &&
      a.popCity === "Richmond" && a.popZip === "23219" && a.type === "Solicitation" &&
      a.active === true && typeof a.title === "string" && a.title.length > 0);

    const b = byId["bbbb1111bbbb1111bbbb1111bbbb0002"];
    t("embedded-comma title parsed intact (RFC-4180)",
      !!b && b.found === true && b.naicsCode === "236220" && b.setAsideCode === "8A" &&
      b.title === "Design, Build, and Commission Task Order Contract (MATOC)");

    const c = byId["cccc2222cccc2222cccc2222cccc0003"];
    t('""-escaped quote title parsed + inactive + empty setAsideCode→null',
      !!c && c.found === true && c.title === 'Notice of Intent: "Sole Source" to Acme Corp' &&
      c.active === false && c.setAsideCode === null);

    const e = byId["eeee4444eeee4444eeee4444eeee0005"];
    t("case-insensitive noticeId match (uppercase in file)",
      !!e && e.found === true && e.naicsCode === "561730" && e.setAsideCode === "SDVOSBC");

    const miss = byId["ffff9999ffff9999ffff9999ffff0000"];
    t("absent notice → found:false + all null fields",
      !!miss && miss.found === false && miss.naicsCode === null && miss.setAside === null &&
      miss.popState === null && miss.type === null && miss.active === null);

    // The "not in current CSV snapshot" disclosure must be present when any id
    // is absent — never faked.
    const notes = env._meta?.notes ?? [];
    t('"not in current CSV snapshot" disclosure present for the absent id',
      notes.some((n) => /not in (the )?current csv snapshot/i.test(n)));

    // _meta.source names the GSA CSV keyless origin; freshness present in data.
    t("_meta.source names the keyless GSA CSV",
      typeof env._meta?.source === "string" && /gsa\.gov.*csv/i.test(env._meta.source) &&
      env._meta.keylessMode === true);
    t("freshness present (csvLastModified + indexBuiltAt + rowCount)",
      env.data?.freshness && typeof env.data.freshness.indexBuiltAt === "string" &&
      typeof env.data.freshness.rowCount === "number" && env.data.freshness.rowCount === 5);
    t("foundCount/missingCount accounting correct",
      env.data?.foundCount === 4 && env.data?.missingCount === 1);

    // ── End-to-end: sam_search_opportunities WIRING with the CSV enabled ──
    // The prior lookup warmed the process-memo index, so the search's
    // non-blocking accessor returns it synchronously and enrichment runs
    // inline. Live HAL noticeIds won't overlap the 5-row fixture, so we assert
    // the WIRING (never a crash; the CSV-composed source or the warming note;
    // freshness present when enrichment ran) rather than a specific filled row —
    // the merge FILL is proven deterministically by runEnrichmentMergeTests.
    const se = await fcall("sam_search_opportunities", { ncode: "541512", limit: 3 });
    const seOk = se.ok === true && se._meta && se._meta.keylessMode === true &&
      Array.isArray(se.data?.opportunities);
    // Either enrichment ran (source composed "+ gsa-csv", freshness present) OR
    // the index was (unexpectedly) not ready → the honest "warming" note. Both
    // are valid non-blocking outcomes; a hard failure/crash is not.
    const enriched = /gsa-csv/i.test(se._meta?.source ?? "");
    const warming = (se._meta?.notes ?? []).some((n) => /warming/i.test(n));
    t("sam_search (enabled CSV): non-blocking enrichment wired (no crash; enriched or warming)",
      seOk && (enriched || warming));
    // When enriched, freshness is surfaced in data and the source is composed.
    t("sam_search (enabled CSV): enriched → freshness in data + composed source",
      !enriched || (se.data?.freshness && typeof se.data.freshness.indexBuiltAt === "string" &&
        /keyless HAL.*gsa-csv/i.test(se._meta.source)));
    // Enabled path must NEVER regress to a bare disabled shape when warm:
    // fieldsUnavailable is still an array and the trio is only present for
    // fields NOT filled (here live ids are absent from the fixture → all 3 stay,
    // which is the honest "nothing enriched this page" outcome).
    t("sam_search (enabled CSV): _meta.fieldsUnavailable is a truthful array",
      Array.isArray(se._meta?.fieldsUnavailable));
  } catch (e) {
    console.log(`✗ fixture path threw: ${e.message}`);
    f++;
  } finally {
    fx.kill();
  }
  return { pass: p, fail: f };
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "edge-case-test", version: "0.0.1" },
  });
  console.log("=== edge case test ===\n");

  let pass = 0, fail = 0;
  for (const c of cases) {
    let result;
    try {
      result = await call(c.name, c.args);
    } catch (e) {
      console.log(`✗ ${c.label} — TIMEOUT/EXCEPTION: ${e.message}`);
      fail++;
      continue;
    }
    const ok = await c.accept(result);
    if (ok) {
      console.log(`✓ ${c.label.padEnd(50)}  ${result.env.ok ? "ok:true" : `ok:false ${result.env.error?.kind}`}`);
      pass++;
    } else {
      console.log(`✗ ${c.label} — unexpected envelope:`);
      console.log(`  ${JSON.stringify(result.env).slice(0, 300)}`);
      fail++;
    }
  }

  // Offline GSA-CSV backbone coverage: parser unit tests, the inline
  // search-enrichment merge tests, and the enabled fixture path (a separate
  // server pointed at the small local fixture — no 226 MB pull).
  const parser = await runParserUnitTests();
  pass += parser.pass; fail += parser.fail;
  const enrich = await runEnrichmentMergeTests();
  pass += enrich.pass; fail += enrich.fail;
  const fixture = await runEnabledFixtureTests();
  pass += fixture.pass; fail += fixture.fail;

  console.log(`\n=== ${pass}/${pass + fail} passed ===`);
  child.kill();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  child.kill();
  process.exit(1);
});
