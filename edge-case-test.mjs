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
    label: "A5: fed_register_search _meta.totalAvailable is a number",
    name: "fed_register_search_documents",
    args: { agencySlugs: ["veterans-affairs-department"], perPage: 3 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      const returned = env.data?.documents?.length ?? 0;
      // Real total: a number, and (since a slug was given) a note mentioning it.
      const totalIsNumber = typeof m.totalAvailable === "number";
      const returnedOk = m.returned === returned;
      const slugNote =
        Array.isArray(m.notes) &&
        m.notes.some((n) => n.toLowerCase().includes("slug"));
      // truncated must agree with returned<totalAvailable.
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
];

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
  console.log(`\n=== ${pass}/${pass + fail} passed ===`);
  child.kill();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL:", e);
  child.kill();
  process.exit(1);
});
