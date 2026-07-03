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
    // A1 / D4 (spec §1.2, §2.4): keyless search must NOT present unfiltered
    // results as filtered. `_meta.filtersDropped` must name the dropped
    // facets and `_meta.complete` must be false.
    label: "A1: keyless search flags dropped facet filters",
    name: "sam_search_opportunities",
    args: { ncode: "541512", setAside: ["SBA"], state: "VA", organizationName: "Department of Veterans Affairs", limit: 3 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      // In keyless mode all four requested facets are provably dropped.
      // (If a key is configured, keylessMode:false and dropped is empty —
      // accept that too so the gate is env-agnostic.)
      if (m.keylessMode === false) return m.complete === true && Array.isArray(m.filtersDropped);
      const dropped = m.filtersDropped ?? [];
      const wanted = ["ncode", "setAside", "state", "organizationName"];
      const allDropped = wanted.every((f) => dropped.includes(f));
      const fieldsGone = ["naics", "setAside", "placeOfPerformance"].every(
        (f) => (m.fieldsUnavailable ?? []).includes(f),
      );
      return (
        allDropped &&
        m.complete === false &&
        m.truncated === true &&
        fieldsGone &&
        Array.isArray(m.notes) &&
        m.notes.length >= 2
      );
    },
  },
  {
    // Only facets the caller actually requested get flagged (no noise).
    label: "A1: unrequested facets are NOT flagged as dropped",
    name: "sam_search_opportunities",
    args: { ncode: "541512", limit: 2 },
    accept: ({ env }) => {
      if (!env.ok || !env._meta) return false;
      const m = env._meta;
      if (m.keylessMode === false) return true;
      const dropped = m.filtersDropped ?? [];
      // ncode was requested → present; state/org/setAside were not → absent.
      return (
        dropped.includes("ncode") &&
        !dropped.includes("state") &&
        !dropped.includes("organizationName") &&
        !dropped.includes("setAside") &&
        m.complete === false
      );
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
    const ok = c.accept(result);
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
