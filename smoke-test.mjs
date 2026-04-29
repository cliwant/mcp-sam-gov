#!/usr/bin/env node
/**
 * Comprehensive smoke test — every tool against the live API.
 *
 * Spawns the MCP server, speaks JSON-RPC over stdio, exercises all
 * 34 tools, and reports pass/fail + p50/p95 latency per tool.
 *
 * Run: node smoke-test.mjs
 *
 * Exit code 0 = all tools returned a non-error response.
 * Exit code 1 = at least one tool failed.
 *
 * Note: this hits live federal APIs. Don't run in a tight loop.
 */

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

const TIMEOUT_MS = 20_000;

const child = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[server] ${chunk}`);
});

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
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    } catch {
      // ignore
    }
  }
});

let id = 1;

async function rpc(method, params) {
  const myId = id++;
  const req = { jsonrpc: "2.0", id: myId, method, params: params ?? {} };
  child.stdin.write(JSON.stringify(req) + "\n");
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    if (responses.has(myId)) return responses.get(myId);
    await wait(80);
  }
  throw new Error(`Timeout id=${myId} method=${method}`);
}

async function callTool(name, args) {
  const start = Date.now();
  const r = await rpc("tools/call", { name, arguments: args });
  const ms = Date.now() - start;
  const text = r.result?.content?.[0]?.text ?? "";
  let envelope = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    envelope = { ok: false, raw: text };
  }
  // Unwrap structured envelope: tools now return { ok: true, data }
  // or { ok: false, error }. Pass through .data for the verify fns.
  const parsed =
    envelope && typeof envelope === "object" && "ok" in envelope
      ? envelope.ok
        ? envelope.data
        : envelope
      : envelope;
  const isError = envelope && envelope.ok === false;
  return { ms, isError: !!r.result?.isError || isError, parsed, raw: r };
}

const tests = [
  // ━━━ SAM.gov
  {
    name: "sam_search_opportunities",
    args: { ncode: "541512", limit: 3 },
    verify: (r) => r.totalRecords >= 0 && Array.isArray(r.opportunities),
  },
  {
    name: "sam_get_opportunity",
    args: { noticeId: "FETCH_FROM_PRIOR" },
    chain: { from: "sam_search_opportunities", path: "opportunities[0].noticeId" },
    verify: (r) => r.found === true && typeof r.title === "string",
  },
  {
    name: "sam_fetch_description",
    args: { noticeId: "FETCH_FROM_PRIOR" },
    chain: { from: "sam_search_opportunities", path: "opportunities[0].noticeId" },
    verify: (r) =>
      r.found === true && typeof r.description === "string",
  },
  {
    name: "sam_attachment_url",
    args: { resourceId: "ab96bdc15c854fec9f71762b621d4f80" },
    verify: (r) =>
      typeof r.downloadUrl === "string" && r.downloadUrl.includes("sam.gov"),
  },
  {
    name: "sam_lookup_organization",
    args: { organizationId: "100173468" },
    verify: (r) => r.found === true && typeof r.fullParentPathName === "string",
  },

  // ━━━ USAspending — Awards
  {
    name: "usas_search_awards",
    args: { agency: "Department of Veterans Affairs", naics: "541512", fiscalYear: 2025 },
    verify: (r) => Array.isArray(r.topRecipients),
  },
  {
    name: "usas_search_individual_awards",
    args: { agency: "Department of Veterans Affairs", naics: "541512", fiscalYear: 2025, limit: 3 },
    verify: (r) => Array.isArray(r.awards),
  },
  {
    name: "usas_search_subagency_spending",
    args: { agency: "Department of Veterans Affairs", fiscalYear: 2025 },
    verify: (r) => Array.isArray(r.subAgencies),
  },
  {
    name: "usas_lookup_agency",
    args: { searchText: "veterans" },
    verify: (r) =>
      Array.isArray(r.matches) && r.matches.length > 0 && r.matches[0].name,
  },
  {
    name: "usas_search_awards_by_recipient",
    args: { recipientName: "Booz Allen Hamilton", fiscalYear: 2025, limit: 3 },
    verify: (r) => Array.isArray(r.awards),
  },
  {
    name: "usas_search_subawards",
    args: { primeRecipientName: "Booz Allen Hamilton", limit: 3 },
    verify: (r) => Array.isArray(r.subawards),
  },
  {
    name: "usas_search_expiring_contracts",
    args: { agency: "Department of Veterans Affairs", naics: "541512", monthsUntilExpiry: 24, minAwardValue: 1000000, limit: 5 },
    verify: (r) => Array.isArray(r.contracts),
  },

  // ━━━ USAspending — Aggregate
  {
    name: "usas_spending_over_time",
    args: { group: "fiscal_year", agency: "Department of Veterans Affairs", naics: "541512" },
    verify: (r) => Array.isArray(r.timeline),
  },
  {
    name: "usas_search_psc_spending",
    args: { naics: "541512", limit: 5 },
    verify: (r) => Array.isArray(r.psc),
  },
  {
    name: "usas_search_state_spending",
    args: { naics: "541512", limit: 5 },
    verify: (r) => Array.isArray(r.states) && r.states.length > 0,
  },
  {
    name: "usas_search_cfda_spending",
    args: { fiscalYear: 2025, limit: 5 },
    verify: (r) => Array.isArray(r.programs),
  },
  {
    name: "usas_search_federal_account_spending",
    args: { agency: "Department of Veterans Affairs", limit: 5 },
    verify: (r) => Array.isArray(r.accounts),
  },
  {
    name: "usas_search_agency_spending",
    args: { naics: "541512", limit: 5 },
    verify: (r) => Array.isArray(r.agencies),
  },

  // ━━━ USAspending — Agency Profile
  {
    name: "usas_get_agency_profile",
    args: { toptierCode: "036" },
    verify: (r) => r.toptierCode === "036" && r.name?.includes("Veterans"),
  },
  {
    name: "usas_get_agency_awards_summary",
    args: { toptierCode: "036", fiscalYear: 2025 },
    verify: (r) => r.toptierCode === "036" && typeof r.obligations === "number",
  },
  {
    name: "usas_get_agency_budget_function",
    args: { toptierCode: "036", fiscalYear: 2025, limit: 3 },
    verify: (r) => Array.isArray(r.functions),
  },

  // ━━━ USAspending — Recipient Profile
  {
    name: "usas_search_recipients",
    args: { keyword: "Booz Allen", limit: 3 },
    verify: (r) =>
      Array.isArray(r.recipients) && r.recipients.length > 0 && r.recipients[0].id,
  },
  {
    name: "usas_get_recipient_profile",
    args: { recipientId: "FETCH_FROM_PRIOR" },
    chain: { from: "usas_search_recipients", path: "recipients[0].id" },
    verify: (r) => typeof r.name === "string" && r.name.length > 0,
  },

  // ━━━ USAspending — Reference / Autocomplete
  {
    name: "usas_autocomplete_naics",
    args: { searchText: "computer systems", limit: 5 },
    verify: (r) => Array.isArray(r.naics) && r.naics.length > 0,
  },
  {
    name: "usas_autocomplete_recipient",
    args: { searchText: "Lockheed Martin", limit: 3 },
    verify: (r) => Array.isArray(r.recipients) && r.recipients.length > 0,
  },
  {
    name: "usas_naics_hierarchy",
    args: { naicsFilter: "541512" },
    verify: (r) => Array.isArray(r.hierarchy) && r.hierarchy.length > 0,
  },
  {
    name: "usas_glossary",
    args: { search: "obligation", limit: 5 },
    verify: (r) => Array.isArray(r.terms),
  },
  {
    name: "usas_list_toptier_agencies",
    args: { limit: 10 },
    verify: (r) => Array.isArray(r.agencies) && r.agencies.length > 0,
  },

  // ━━━ Federal Register
  {
    name: "fed_register_search_documents",
    args: { agencySlugs: ["veterans-affairs-department"], perPage: 3 },
    verify: (r) => Array.isArray(r.documents),
  },
  {
    name: "fed_register_get_document",
    args: { documentNumber: "FETCH_FROM_PRIOR" },
    chain: { from: "fed_register_search_documents", path: "documents[0].documentNumber" },
    verify: (r) => typeof r.documentNumber === "string" && r.documentNumber.length > 0,
  },
  {
    name: "fed_register_list_agencies",
    args: { perPage: 5 },
    verify: (r) => Array.isArray(r.agencies) && r.agencies.length > 0,
  },

  // ━━━ eCFR
  {
    name: "ecfr_search",
    args: { query: "federal acquisition regulation", titleNumber: 48, perPage: 3 },
    verify: (r) => Array.isArray(r.results),
  },
  {
    name: "ecfr_list_titles",
    args: {},
    verify: (r) => Array.isArray(r.titles) && r.titles.length === 50,
  },

  // ━━━ Grants.gov
  {
    name: "grants_search",
    args: { keyword: "cybersecurity", rows: 3 },
    verify: (r) => Array.isArray(r.grants),
  },
  {
    name: "grants_get_opportunity",
    args: { opportunityId: "FETCH_FROM_PRIOR" },
    chain: { from: "grants_search", path: "grants[0].id" },
    verify: (r) => typeof r.opportunityNumber === "string",
  },
];

function pickPath(obj, path) {
  // Tiny path expression: supports a.b[0].c style
  return path.split(".").reduce((o, key) => {
    if (o == null) return undefined;
    const m = key.match(/^([^\[]*)\[(\d+)\]$/);
    if (m) {
      const k = m[1];
      const i = Number(m[2]);
      const arr = k ? o[k] : o;
      return arr?.[i];
    }
    return o[key];
  }, obj);
}

async function run() {
  // 1. initialize
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  console.log(`✓ initialize: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version}`);

  const tools = await rpc("tools/list", {});
  console.log(`✓ tools/list: ${tools.result?.tools?.length} tools registered\n`);

  const priorResults = new Map();
  const stats = [];
  let pass = 0;
  let fail = 0;

  for (const test of tests) {
    let args = test.args;
    // Resolve chain placeholder
    if (test.chain) {
      const prior = priorResults.get(test.chain.from);
      const value = prior ? pickPath(prior, test.chain.path) : undefined;
      if (!value) {
        console.log(`✗ ${test.name} — SKIP (chain dep ${test.chain.from} → ${test.chain.path} unresolvable)`);
        fail++;
        continue;
      }
      // Find the placeholder key in args and replace
      args = { ...args };
      for (const k of Object.keys(args)) {
        if (args[k] === "FETCH_FROM_PRIOR") args[k] = value;
      }
    }

    let result;
    try {
      result = await callTool(test.name, args);
    } catch (err) {
      console.log(`✗ ${test.name} — ERROR: ${err.message}`);
      fail++;
      continue;
    }

    if (result.isError) {
      console.log(`✗ ${test.name} — server returned isError; payload: ${typeof result.parsed === "string" ? result.parsed.slice(0, 120) : ""}`);
      fail++;
      continue;
    }

    let ok = false;
    try {
      ok = test.verify(result.parsed);
    } catch (err) {
      ok = false;
    }
    if (!ok) {
      console.log(`✗ ${test.name} — verify failed (${result.ms}ms); payload preview: ${JSON.stringify(result.parsed).slice(0, 200)}`);
      fail++;
      continue;
    }

    priorResults.set(test.name, result.parsed);
    stats.push({ name: test.name, ms: result.ms });
    console.log(`✓ ${test.name.padEnd(40)} ${String(result.ms).padStart(5)}ms`);
    pass++;
  }

  console.log(`\n=== ${pass}/${pass + fail} tools passed ===`);
  if (stats.length > 0) {
    const sorted = stats.map((s) => s.ms).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const max = sorted[sorted.length - 1];
    console.log(`Latency: p50=${p50}ms p95=${p95}ms max=${max}ms (n=${sorted.length})`);
  }

  child.kill();
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error("FATAL:", err);
  child.kill();
  process.exit(1);
});
