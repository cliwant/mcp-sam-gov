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
  // ─── v0.4 — hint-bearing errors + new edge cases ──────────────
  {
    label: "negative limit rejected by Zod",
    name: "sam_search_opportunities",
    args: { ncode: "541512", limit: -5 },
    accept: ({ env }) =>
      !env.ok && env.error.kind === "invalid_input" && !env.error.retryable,
  },
  {
    label: "limit over maximum rejected by Zod",
    name: "sam_search_opportunities",
    args: { ncode: "541512", limit: 9999 },
    accept: ({ env }) =>
      !env.ok && env.error.kind === "invalid_input" && !env.error.retryable,
  },
  {
    label: "empty noticeId graceful",
    name: "sam_get_opportunity",
    args: { noticeId: "" },
    accept: ({ env }) =>
      (env.ok && env.data?.found === false) ||
      (!env.ok && !env.error.retryable),
  },
  {
    label: "HTML tag in query (no crash, no injection)",
    name: "sam_search_opportunities",
    args: { query: "<script>alert(1)</script>", limit: 2 },
    accept: ({ env }) => env.ok && Array.isArray(env.data.opportunities),
  },
  {
    label: "SQL-injection style input safely passes through",
    name: "usas_autocomplete_naics",
    args: { searchText: "'; DROP TABLE awards; --", limit: 3 },
    accept: ({ env }) => env.ok && Array.isArray(env.data.naics),
  },
  {
    label: "whitespace-only query handled",
    name: "sam_search_opportunities",
    args: { query: "   ", limit: 2 },
    accept: ({ env }) => env.ok && Array.isArray(env.data.opportunities),
  },
  {
    label: "FedReg bad doc ID returns hint",
    name: "fed_register_get_document",
    args: { documentNumber: "totally-not-a-real-doc-id" },
    accept: ({ env }) =>
      !env.ok &&
      env.error.kind === "not_found" &&
      typeof env.error.hint === "string" &&
      env.error.hint.includes("YYYY-NNNNN"),
  },
  {
    label: "USAspending award detail bad ID handled (hint or null)",
    name: "usas_get_award_detail",
    args: { generatedInternalId: "totally-not-a-real-award-id-XYZ" },
    accept: ({ env }) =>
      // Accept either: ok:true with null sentinel, OR ok:false with hint pointing to the search tool
      (env.ok && env.data === null) ||
      (!env.ok && typeof env.error.hint === "string"),
  },
  {
    label: "USAspending recipient profile bad ID returns hint",
    name: "usas_get_recipient_profile",
    args: { recipientId: "totally-not-a-real-recipient-id" },
    accept: ({ env }) =>
      !env.ok &&
      typeof env.error.hint === "string" &&
      env.error.hint.includes("usas_search_recipients"),
  },
  {
    label: "eCFR title=0 (out of range)",
    name: "ecfr_search",
    args: { query: "test", titleNumber: 0, perPage: 1 },
    // Either Zod rejects (invalid_input) OR upstream returns empty (ok:true)
    accept: ({ env }) =>
      (env.ok && Array.isArray(env.data.results)) ||
      (!env.ok && !env.error.retryable),
  },
  // ─── v0.4 — SBA size standards ──────────────────────────────────
  {
    label: "SBA lookup NAICS 541512 (revenue cap $34M)",
    name: "sba_size_standard_lookup",
    args: { naicsCode: "541512" },
    accept: ({ env }) =>
      env.ok &&
      env.data.found === true &&
      env.data.entries?.[0]?.thresholdMillionsUsd === 34 &&
      env.data.entries?.[0]?.type === "revenue",
  },
  {
    label: "SBA lookup NAICS 541330 (multi-entry: $25.5M / $47M)",
    name: "sba_size_standard_lookup",
    args: { naicsCode: "541330" },
    accept: ({ env }) =>
      env.ok &&
      env.data.found === true &&
      env.data.entries?.length >= 2 &&
      env.data.notes?.includes("ALTERNATIVES"),
  },
  {
    label: "SBA lookup NAICS 541715 (employee-based: 1000-1500)",
    name: "sba_size_standard_lookup",
    args: { naicsCode: "541715" },
    accept: ({ env }) =>
      env.ok &&
      env.data.found === true &&
      env.data.entries?.some((e) => e.type === "employee"),
  },
  {
    label: "SBA lookup NAICS not in table — returns hint to ecfr_search",
    name: "sba_size_standard_lookup",
    args: { naicsCode: "999999" },
    accept: ({ env }) =>
      env.ok &&
      env.data.found === false &&
      typeof env.data.hint === "string" &&
      env.data.hint.includes("ecfr_search"),
  },
  {
    label: "SBA lookup malformed NAICS",
    name: "sba_size_standard_lookup",
    args: { naicsCode: "abc" },
    accept: ({ env }) =>
      env.ok &&
      env.data.found === false &&
      env.data.hint?.includes("6 digits"),
  },
  {
    label: "SBA qualification check: $20M firm under 541512 ($34M cap) → qualifies",
    name: "sba_check_size_qualification",
    args: { naicsCode: "541512", averageAnnualRevenueUsd: 20_000_000 },
    accept: ({ env }) => env.ok && env.data.qualifies === true,
  },
  {
    label: "SBA qualification check: $50M firm under 541512 ($34M cap) → fails",
    name: "sba_check_size_qualification",
    args: { naicsCode: "541512", averageAnnualRevenueUsd: 50_000_000 },
    accept: ({ env }) => env.ok && env.data.qualifies === false,
  },
  {
    label: "SBA qualification check: 541330 firm at $40M qualifies under military entry",
    name: "sba_check_size_qualification",
    args: { naicsCode: "541330", averageAnnualRevenueUsd: 40_000_000 },
    // Default $25.5M FAILS, but military $47M PASSES → qualifies (any-of)
    accept: ({ env }) =>
      env.ok &&
      env.data.qualifies === true &&
      env.data.byEntry?.some((b) => b.qualifies === true) &&
      env.data.byEntry?.some((b) => b.qualifies === false),
  },
  {
    label: "SBA qualification check: no metric provided → indeterminate",
    name: "sba_check_size_qualification",
    args: { naicsCode: "541512" },
    accept: ({ env }) =>
      env.ok && env.data.qualifies === "indeterminate",
  },
  // ─── v0.5 — NAICS revision crosswalk ───────────────────────────
  {
    label: "NAICS 541512 stable in 2022",
    name: "naics_revision_check",
    args: { naicsCode: "541512" },
    accept: ({ env }) =>
      env.ok &&
      env.data.valid_in_2022 === true &&
      env.data.status === "stable",
  },
  {
    label: "NAICS 511210 renumbered to 513210 in 2022",
    name: "naics_revision_check",
    args: { naicsCode: "511210" },
    accept: ({ env }) =>
      env.ok &&
      env.data.valid_in_2022 === false &&
      env.data.status === "renumbered" &&
      env.data.canonical2022 === "513210",
  },
  {
    label: "NAICS 519130 split in 2022 → multiple successors",
    name: "naics_revision_check",
    args: { naicsCode: "519130" },
    accept: ({ env }) =>
      env.ok &&
      env.data.valid_in_2022 === false &&
      env.data.status === "split" &&
      Array.isArray(env.data.splitInto) &&
      env.data.splitInto.length >= 2,
  },
  {
    label: "NAICS 541510 retired in 2007",
    name: "naics_revision_check",
    args: { naicsCode: "541510" },
    accept: ({ env }) =>
      env.ok &&
      env.data.valid_in_2022 === false &&
      env.data.status === "retired",
  },
  {
    label: "NAICS not in curation set returns unknown + Census fallback hint",
    name: "naics_revision_check",
    args: { naicsCode: "999999" },
    accept: ({ env }) =>
      env.ok &&
      env.data.status === "unknown" &&
      env.data.note?.includes("Census"),
  },
  {
    label: "NAICS revision check rejects malformed input",
    name: "naics_revision_check",
    args: { naicsCode: "abc" },
    accept: ({ env }) =>
      env.ok &&
      env.data.status === "unknown" &&
      env.data.note?.includes("6 digits"),
  },
  // ─── v0.5 — Sub-award aggregation ──────────────────────────────
  {
    label: "Sub-award aggregate by prime recipient (Booz Allen FY2024)",
    name: "usas_aggregate_subawards",
    args: { primeRecipientName: "BOOZ ALLEN HAMILTON", fiscalYear: 2024 },
    // Coverage is uneven; accept ok:true with array (possibly empty) OR ok:false non-retryable
    accept: ({ env }) =>
      (env.ok && Array.isArray(env.data?.sub_recipients)) ||
      (!env.ok && !env.error.retryable),
  },
  {
    label: "Sub-award aggregate with no filter args → invalid_input",
    name: "usas_aggregate_subawards",
    args: {},
    accept: ({ env }) =>
      !env.ok && env.error.kind === "invalid_input" && !env.error.retryable,
  },
  {
    label: "Sub-recipient profile lookup (graceful when not found)",
    name: "usas_get_sub_recipient_profile",
    args: { recipientName: "ZZZ_NONEXISTENT_SUB_RECIPIENT_XYZ", fiscalYear: 2024 },
    accept: ({ env }) =>
      (env.ok &&
        (env.data?.sampleSize === 0 || Array.isArray(env.data?.primes))) ||
      (!env.ok && !env.error.retryable),
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
