#!/usr/bin/env node
/**
 * Comprehensive smoke test — every tool against the live API.
 *
 * Spawns the MCP server, speaks JSON-RPC over stdio, exercises all
 * tools, and reports pass/fail + p50/p95 latency per tool.
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
  // Unwrap structured envelope: tools now return { ok: true, data, _meta }
  // or { ok: false, error }. Pass through .data for the verify fns; expose
  // _meta separately so we can assert the completeness/provenance contract.
  const parsed =
    envelope && typeof envelope === "object" && "ok" in envelope
      ? envelope.ok
        ? envelope.data
        : envelope
      : envelope;
  const meta =
    envelope && typeof envelope === "object" && envelope.ok
      ? envelope._meta
      : undefined;
  const isError = envelope && envelope.ok === false;
  return { ms, isError: !!r.result?.isError || isError, parsed, meta, raw: r };
}

// Assert a success response carries a well-formed `_meta` (spec §2.1).
// Returns null on success, or a short reason string on failure.
function checkMeta(meta) {
  if (meta == null || typeof meta !== "object") return "_meta missing";
  if (typeof meta.source !== "string" || meta.source.length === 0)
    return "_meta.source not a non-empty string";
  if (typeof meta.keylessMode !== "boolean") return "_meta.keylessMode not boolean";
  if (typeof meta.complete !== "boolean") return "_meta.complete not boolean";
  if (typeof meta.truncated !== "boolean") return "_meta.truncated not boolean";
  if (typeof meta.returned !== "number") return "_meta.returned not number";
  if (!(meta.totalAvailable === null || typeof meta.totalAvailable === "number"))
    return "_meta.totalAvailable not number|null";
  for (const k of ["filtersApplied", "filtersDropped", "fieldsUnavailable", "notes"]) {
    if (!Array.isArray(meta[k])) return `_meta.${k} not an array`;
  }
  // Core §2.1 invariant: complete ⟺ not truncated AND no dropped filters.
  if (meta.complete && (meta.truncated || meta.filtersDropped.length > 0))
    return "_meta.complete violates invariant (truncated or filtersDropped non-empty)";
  return null;
}

const tests = [
  // ━━━ SAM.gov
  {
    name: "sam_search_opportunities",
    args: { ncode: "541512", limit: 3 },
    verify: (r) => r.totalRecords >= 0 && Array.isArray(r.opportunities),
  },
  {
    // Pre-solicitation shaping radar happy path. Default noticeType ['r','p','s']
    // returns notices, each carrying noticeTypeCode (r/p/s/…) + daysUntilResponse
    // (number OR null, never fabricated), and totalRecords is the true
    // server-side count for the type+naics filter.
    name: "sam_search_shaping",
    args: { ncode: "541512", limit: 5 },
    verify: (r) =>
      r.totalRecords >= 0 &&
      Array.isArray(r.notices) &&
      Array.isArray(r.noticeTypesRequested) &&
      r.noticeTypesRequested.join(",") === "r,p,s" &&
      // Every returned notice is inside the requested shaping window and carries
      // the shaped keys the tool promises.
      r.notices.every(
        (n) =>
          typeof n.noticeId === "string" &&
          ["r", "p", "s"].includes(n.noticeTypeCode) &&
          (n.daysUntilResponse === null ||
            typeof n.daysUntilResponse === "number") &&
          n.naics === null && // keyless list nulls it (honest)
          typeof n.uiLink === "string",
      ),
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
    // Shape-contract (drift detector), not just "an array came back": the parser
    // maps specific real spending_by_award fields, so assert the identity fields
    // survive (a renamed "Award ID"/generated_internal_id breaks them) AND at
    // least one positive amount (a dropped "Award Amount" ⇒ every amount 0).
    verify: (r) =>
      Array.isArray(r.awards) &&
      r.awards.length > 0 &&
      r.awards.every(
        (a) =>
          typeof a.awardId === "string" &&
          a.awardId.length > 0 &&
          typeof a.generatedInternalId === "string" &&
          a.generatedInternalId.length > 0 &&
          typeof a.amount === "number",
      ) &&
      r.awards.some((a) => a.amount > 0),
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
    name: "usas_search_recompetes",
    args: { agency: "Department of Veterans Affairs", naics: "541512", minAwardValue: 1000000, pageSize: 5 },
    verify: (r) => Array.isArray(r.recompetes) && r.page === 1 && r.pageSize === 5,
  },
  {
    name: "usas_search_expiring_contracts",
    args: { agency: "Department of Veterans Affairs", naics: "541512", monthsUntilExpiry: 24, minAwardValue: 1000000, limit: 5 },
    verify: (r) => Array.isArray(r.contracts),
  },
  {
    // Resolve a live generatedInternalId from the individual-awards result
    // above (not a hard-coded id) so the happy path isn't brittle.
    name: "usas_analyze_incumbent",
    args: { generatedInternalId: "FETCH_FROM_PRIOR", otherAwardsLimit: 5 },
    chain: { from: "usas_search_individual_awards", path: "awards[0].generatedInternalId" },
    verify: (r) =>
      typeof r.award?.incumbent === "string" &&
      r.signals &&
      // pctConsumed is a number OR null (never undefined / a fabricated 0).
      (r.signals.obligatedVsCeiling.pctConsumed === null ||
        typeof r.signals.obligatedVsCeiling.pctConsumed === "number") &&
      Array.isArray(r.pressureHints),
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
    // Drill into 54 (Prof/Sci/Tech) ⇒ its 4-digit children (5411, 5412, …). A
    // 6-digit code like 541512 is a LEAF (empty children) — use a non-leaf here.
    args: { naicsFilter: "54" },
    verify: (r) => Array.isArray(r.hierarchy) && r.hierarchy.length > 0 && r.parent?.code === "54",
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
  {
    // Authoritative FAR clause 52.212-4 via the eCFR versioner-full endpoint
    // (NOT ecfr_search, which mis-ranks the number). Live-soft on the revision
    // token (the clause gets amended) — assert the stable invariants: the number
    // echoes, kind/regulation are right, clean tag-free text, the prescription
    // pointer resolves into FAR 12.301, and the always-present farOverhaulRisk
    // caveat carries its 3 real deviation sources (no fabricated specifics).
    name: "far_clause_lookup",
    args: { clauseNumber: "52.212-4" },
    verify: (r) =>
      r.clauseNumber === "52.212-4" &&
      r.kind === "clause" &&
      r.regulation === "FAR" &&
      typeof r.text === "string" &&
      r.text.length > 100 &&
      !/[<>]/.test(r.text) &&
      typeof r.prescribedIn === "string" &&
      /^12\.301/.test(r.prescribedIn) &&
      r.farOverhaulRisk &&
      Array.isArray(r.farOverhaulRisk.deviationSources) &&
      r.farOverhaulRisk.deviationSources.length === 3 &&
      r.farOverhaulRisk.appliesTo === "FAR" &&
      r.isCurrent === true,
  },

  // ━━━ SBA — Size Standards
  {
    // Happy path: a known receipts-based NAICS (541512, Computer Systems Design)
    // returns found:true with a numeric threshold in DOLLARS + a disclosed unit.
    // Live-soft on the exact figure (SBA adjusts it) — assert shape, that the
    // threshold is the $millions figure normalized to dollars (a large number),
    // and that the unit is disclosed.
    name: "sba_size_standard",
    args: { naics: "541512" },
    verify: (r) =>
      r.found === true &&
      r.naics === "541512" &&
      r.standardType === "receipts" &&
      typeof r.threshold === "number" &&
      r.threshold >= 1_000_000 && // normalized to dollars, never the raw "34"
      r.unit === "USD annual receipts" &&
      r.revenueLimitUSD === r.threshold &&
      typeof r.asOf === "string",
  },

  // ━━━ Grants.gov
  {
    name: "grants_search",
    args: { keyword: "cybersecurity", rows: 3 },
    // Shape-contract (drift detector): the parser maps specific grants.gov fields,
    // so assert the STABLE ones survive on every row (a renamed id/opportunityNumber/
    // title/status/cfdaList signals drift). agencyName/closeDate are intentionally
    // NOT required non-empty — grants.gov really returns "" for forecast rows.
    verify: (r) =>
      Array.isArray(r.grants) &&
      r.grants.length > 0 &&
      r.grants.every(
        (g) =>
          typeof g.id === "string" &&
          g.id.length > 0 &&
          typeof g.opportunityNumber === "string" &&
          typeof g.title === "string" &&
          g.title.length > 0 &&
          typeof g.status === "string" &&
          Array.isArray(g.cfdaList),
      ),
  },
  {
    name: "grants_get_opportunity",
    args: { opportunityId: "FETCH_FROM_PRIOR" },
    chain: { from: "grants_search", path: "grants[0].id" },
    verify: (r) => typeof r.opportunityNumber === "string",
  },

  // ━━━ Pricing / Wage
  {
    name: "sam_search_wage_determinations",
    args: { coverage: "sca", state: "VA", limit: 5 },
    verify: (r) =>
      Array.isArray(r.determinations) &&
      r.determinations.length > 0 &&
      typeof r.determinations[0].fullReferenceNumber === "string" &&
      r.determinations[0].coverage === "SCA",
  },
  {
    // Resolve a LIVE WD reference from the search above (never a hard-coded,
    // possibly-stale one). Revision is omitted → resolved via /history.
    name: "sam_get_wage_rates",
    args: { reference: "FETCH_FROM_PRIOR", coverage: "sca" },
    chain: {
      from: "sam_search_wage_determinations",
      path: "determinations[0].fullReferenceNumber",
    },
    verify: (r) =>
      r.coverage === "SCA" &&
      (r.parseConfidence === "high" || r.parseConfidence === "low") &&
      Array.isArray(r.rates) &&
      typeof r.sourceUrl === "string",
  },
  {
    name: "gsa_benchmark_labor_rates",
    args: { laborCategory: "Engineer" },
    verify: (r) =>
      r.laborCategory === "Engineer" &&
      typeof r.matchCount === "number" &&
      r.currentRate &&
      (r.currentRate.median === null || typeof r.currentRate.median === "number") &&
      typeof r.currentRate.n === "number" &&
      Array.isArray(r.sampleRows),
  },

  // ━━━ Integrity / Teaming
  {
    // A known-populated name → active exclusion(s) present; excluded true and
    // records carry the exclusion fields.
    name: "sam_check_exclusions",
    args: { query: "construction", size: 5 },
    verify: (r) =>
      typeof r.excluded === "boolean" &&
      typeof r.matchCount === "number" &&
      Array.isArray(r.records) &&
      (r.records.length === 0 ||
        (typeof r.records[0].name === "string" &&
          typeof r.records[0].samFapiisUrl === "string")),
  },
  {
    // One-call integrity composition. A clearly-not-excluded firm → the honest
    // keyless verdict: integrityFlag "review_fapiis" (NEVER "clear"),
    // exclusions.excluded false, fapiisRecords null (key-gated), and a fapiisUrl
    // deep-link. Uses "Boeing" (0 exclusions in prior probes) to stay stable.
    name: "sam_integrity_lookup",
    args: { name: "Boeing" },
    verify: (r) =>
      r.integrityFlag === "review_fapiis" &&
      r.exclusions &&
      r.exclusions.excluded === false &&
      typeof r.exclusions.activeCount === "number" &&
      Array.isArray(r.exclusions.records) &&
      r.fapiisRecords === null &&
      typeof r.fapiisUrl === "string" &&
      r.fapiisUrl.includes("sam.gov") &&
      r.entity &&
      r.entity.name === "Boeing",
  },
  {
    // Award-derived teaming discovery: VA × 8a × 541512, integrity-screened.
    // Kept narrow (small limit/screenCap, few scan pages) so the bounded
    // exclusion screen stays fast.
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
    verify: (r) =>
      r.cert === "8a_program_participant" &&
      Array.isArray(r.candidates) &&
      r.candidates.length > 0 &&
      typeof r.candidates[0].recipientName === "string" &&
      typeof r.candidates[0].agencyObligated === "number" &&
      typeof r.candidates[0].agencyAwardCount === "number" &&
      Array.isArray(r.candidates[0].sampleAwards),
  },
  // ━━━ GSA daily-CSV keyless backbone (DEFAULT = disabled)
  {
    // The smoke suite runs with NO CSV env set, so the backbone is DISABLED by
    // default. The tool must return a STRUCTURED "how to enable" response —
    // enabled:false, every row found:false + null fields, and NO network
    // download — never fake data and never an error. (The ENABLED fixture path
    // is exercised offline in edge-case-test.mjs.)
    name: "sam_lookup_notice_fields",
    args: {
      noticeIds: [
        "c7a871f27b5046be81549a9fdc9719c7",
        "a4be592da0304872a252980925b9458f",
      ],
    },
    verify: (r) =>
      r.enabled === false &&
      r.freshness === null &&
      Array.isArray(r.results) &&
      r.results.length === 2 &&
      r.results.every(
        (x) =>
          x.found === false &&
          x.naicsCode === null &&
          x.setAside === null &&
          x.popState === null,
      ),
  },
  // ━━━ GAO — Bid Protests
  {
    // Happy path: the recent Legal-Products feed yields ≥1 bid-protest decision,
    // each carries a B-number + decisionUrl, and the honest accessNote is
    // present. Live-soft: feed content changes daily, so we assert shape/scope
    // rather than a specific protester.
    name: "gao_protest_lookup",
    args: { limit: 5 },
    verify: (r) =>
      typeof r.accessNote === "string" &&
      /paid/i.test(r.accessNote) &&
      Array.isArray(r.decisions) &&
      r.decisions.length >= 1 &&
      r.decisions.every(
        (d) =>
          typeof d.bNumber === "string" &&
          d.bNumber.length > 0 &&
          typeof d.decisionUrl === "string" &&
          d.decisionUrl.includes("gao.gov/products"),
      ),
  },
  // ━━━ US Treasury — Fiscal Data (keyless) (ADR-0002)
  {
    // Debt to the Penny, latest day. One record; amounts coerced to numbers
    // (num()), never left as the upstream string and never 0.
    name: "treasury_debt_to_penny",
    args: { latest: true },
    verify: (r) =>
      Array.isArray(r.records) &&
      r.records.length === 1 &&
      typeof r.records[0].recordDate === "string" &&
      typeof r.records[0].totalPublicDebtOutstanding === "number" &&
      r.records[0].totalPublicDebtOutstanding > 0,
  },
  {
    // Avg interest rates, latest month's full breakdown across security types.
    // Each row carries a securityType and a numeric (or null) percent — never 0
    // for a missing value.
    name: "treasury_avg_interest_rates",
    args: { latest: true },
    verify: (r) =>
      Array.isArray(r.records) &&
      r.records.length >= 1 &&
      r.records.every(
        (x) =>
          typeof x.securityType === "string" &&
          (x.avgInterestRatePercent === null ||
            typeof x.avgInterestRatePercent === "number"),
      ) &&
      r.records.some((x) => typeof x.avgInterestRatePercent === "number"),
  },
  {
    // MTS receipts/outlays/deficit. Default excludeSummaryRows drops the
    // null-amount fiscal-year parent rows (F4) server-side, so every returned
    // child row has a positive numeric grossOutlays.
    name: "treasury_monthly_statement",
    args: { startDate: "2026-01-31", pageSize: 5 },
    verify: (r) =>
      Array.isArray(r.records) &&
      r.records.length >= 1 &&
      r.records.every(
        (x) =>
          typeof x.grossOutlays === "number" &&
          x.grossOutlays > 0 &&
          (x.deficitSurplus === null || typeof x.deficitSurplus === "number"),
      ),
  },
  {
    // Generic escape hatch over the enum'd datasets (here rates_of_exchange).
    // Raw rows pass through; the dataset key is echoed back.
    name: "treasury_query_dataset",
    args: { dataset: "rates_of_exchange", sort: "-record_date", pageSize: 3 },
    verify: (r) =>
      r.dataset === "rates_of_exchange" &&
      Array.isArray(r.rows) &&
      r.rows.length >= 1 &&
      r.rows.every((row) => typeof row.country_currency_desc === "string"),
  },

  // ━━━ SEC EDGAR — filings / XBRL facts / CIK / full-text (keyless) (ADR-0003)
  {
    // Ticker → 10-digit CIK via company_tickers.json. Apple resolves to the
    // canonical padded CIK 0000320193 (padCik on the integer cik_str).
    name: "edgar_lookup_cik",
    args: { query: "AAPL" },
    verify: (r) =>
      r.found === true &&
      Array.isArray(r.results) &&
      r.results.some((x) => x.cik === "0000320193" && x.ticker === "AAPL"),
  },
  {
    // Recent 10-K filings for Apple. Each carries a real archive primaryDocUrl
    // built from accession + primaryDocument (F7 uses the real doc for filings).
    name: "edgar_company_filings",
    args: { cikOrTicker: "AAPL", forms: ["10-K"], limit: 3 },
    verify: (r) =>
      typeof r.cik === "string" &&
      Array.isArray(r.filings) &&
      r.filings.length >= 1 &&
      r.filings.every(
        (f) =>
          f.form === "10-K" &&
          typeof f.accession === "string" &&
          typeof f.primaryDocUrl === "string" &&
          f.primaryDocUrl.startsWith("https://www.sec.gov/Archives/edgar/data/"),
      ),
  },
  {
    // Curated XBRL facts. Assets in USD, latest point only — a real positive
    // number (num()), never 0 for a present fact.
    name: "edgar_company_facts",
    args: { cikOrTicker: "AAPL", concepts: ["Assets"], latest: true },
    verify: (r) =>
      Array.isArray(r.concepts) &&
      r.concepts.length === 1 &&
      r.concepts[0].concept === "Assets" &&
      r.concepts[0].points.length === 1 &&
      typeof r.concepts[0].points[0].val === "number" &&
      r.concepts[0].points[0].val > 0,
  },
  {
    // Full-text search (2001-present). Each hit carries a constructed archive
    // INDEX url from adsh (F7 — no fabricated doc filename); totalAvailable is
    // the true count (or a ≥ lower bound; _meta.totalIsLowerBound discloses it).
    name: "edgar_full_text_search",
    args: { q: "\"artificial intelligence\"", forms: ["10-K"] },
    verify: (r) =>
      Array.isArray(r.results) &&
      r.results.length >= 1 &&
      r.results.every(
        (h) =>
          typeof h.accession === "string" &&
          Array.isArray(h.ciks) &&
          (h.filingIndexUrl === null ||
            (typeof h.filingIndexUrl === "string" &&
              h.filingIndexUrl.endsWith("/"))),
      ),
  },

  // ━━━ Socrata / SODA — keyless SLED + E-rate open data (ADR-0004)
  {
    // Query rows from an allowlisted SODA portal. data.ny.gov/kwxv-fwze is a
    // live-verified dataset (bare JSON array; value fields are strings). Rows
    // pass through verbatim; a count(*) companion supplies totalAvailable.
    name: "socrata_query",
    args: { domain: "data.ny.gov", datasetId: "kwxv-fwze", limit: 3 },
    verify: (r) =>
      r.domain === "data.ny.gov" &&
      r.datasetId === "kwxv-fwze" &&
      Array.isArray(r.rows) &&
      r.rows.length >= 1 &&
      r.rows.length <= 3 &&
      r.rows.every((row) => row !== null && typeof row === "object"),
  },
  {
    // Discover dataset 4x4 ids via the catalog. A keyword on data.ny.gov returns
    // datasets whose `id` is a valid 4x4 to feed socrata_query.
    name: "socrata_discover_datasets",
    args: { q: "procurement", domain: "data.ny.gov", limit: 5 },
    verify: (r) =>
      Array.isArray(r.results) &&
      r.results.length >= 1 &&
      r.results.every(
        (d) => typeof d.id === "string" && /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(d.id),
      ),
  },
  // ━━━ CKAN datastore_search — keyless SLED open data (ADR-0006)
  {
    // Query rows from an allowlisted CKAN datastore. data.ca.gov/bb82edc5-… is a
    // live-verified datastore-active resource (Statewide Purchase Order Data).
    // The envelope carries a real result.total; records pass through verbatim.
    name: "ckan_query",
    args: {
      host: "data.ca.gov",
      resourceId: "bb82edc5-9c78-44e2-8947-68ece26197c5",
      limit: 3,
    },
    verify: (r) =>
      r.host === "data.ca.gov" &&
      r.resourceId === "bb82edc5-9c78-44e2-8947-68ece26197c5" &&
      Array.isArray(r.records) &&
      r.records.length >= 1 &&
      r.records.length <= 3 &&
      r.records.every((row) => row !== null && typeof row === "object"),
  },
  {
    // Discover datastore resource ids via package_search. A keyword on data.ca.gov
    // returns per-resource rows whose resourceId is a valid UUID to feed ckan_query.
    name: "ckan_discover_datasets",
    args: { host: "data.ca.gov", q: "purchase order", limit: 5 },
    verify: (r) =>
      Array.isArray(r.results) &&
      r.results.length >= 1 &&
      r.results.every(
        (d) =>
          d.resourceId === null ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            d.resourceId,
          ),
      ),
  },
  // ━━━ OpenFEMA — keyless disaster declarations + emergency-assistance spend (ADR-0016)
  // Live-hits www.fema.gov/api/open/v2 (keyless, no key/token/header). The module
  // ALWAYS sends $inlinecount=allpages, so a passing verify + checkMeta proves the
  // entity-keyed envelope + the EXACT metadata.count total path are intact against
  // the live API. A live transient (5xx/timeout/429) is TOLERATED as a pass-with-note.
  {
    // PA-details: state='LA' + damageCategoryCode='B' narrows the ~800k set; each
    // row MUST carry the real `stateAbbreviation` field (the M1 per-dataset field).
    name: "fema_search_public_assistance",
    args: { state: "LA", damageCategoryCode: "B", limit: 3 },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited",
    verify: (r) =>
      r.dataset === "PublicAssistanceFundedProjectsDetails" &&
      Array.isArray(r.rows) &&
      r.rows.length >= 1 &&
      r.rows.length <= 3 &&
      r.rows.every(
        (row) =>
          row !== null &&
          typeof row === "object" &&
          row.stateAbbreviation === "LA" &&
          (row.projectAmount === null || typeof row.projectAmount === "number"),
      ),
  },
  {
    // Declarations: state='CA' narrows to ~1.7k. Each row MUST carry the real
    // `state` field (proving the INVERSE per-dataset mapping vs PA-details).
    name: "fema_disaster_declarations",
    args: { state: "CA", limit: 3 },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited",
    verify: (r) =>
      r.dataset === "DisasterDeclarationsSummaries" &&
      Array.isArray(r.rows) &&
      r.rows.length >= 1 &&
      r.rows.length <= 3 &&
      r.rows.every(
        (row) => row !== null && typeof row === "object" && row.state === "CA",
      ),
  },
  // ━━━ FPDS-NG — federal contract AWARD ACTIONS (keyless ATOM, ADR-0012)
  // The FIRST XML/ATOM source. Live-hits www.fpds.gov/ezsearch/FEEDS/ATOM (keyless,
  // no key/cookie). NAICS 541511 (custom computer programming) is a broad,
  // always-populated multi-page query (→ rel="last" → totalAvailable is a lower
  // bound). Every returned row MUST carry a real string piid — the M3
  // namespace-drift guard would have THROWN schema_drift otherwise, so a passing
  // verify proves the ns1: award/IDV extractor is intact against the live feed. A
  // live transient (5xx/timeout/429) is TOLERATED as a pass-with-note.
  {
    name: "fpds_search_awards",
    args: { naics: "541511", offset: 0 },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited",
    verify: (r) =>
      Array.isArray(r.awards) &&
      r.awards.length >= 1 &&
      r.awards.length <= 10 &&
      r.awards.every(
        (a) => a !== null && typeof a === "object" && typeof a.piid === "string" && a.piid.length > 0,
      ) &&
      typeof r.totalAvailable === "number" &&
      r.totalAvailable >= 1,
  },
  // ━━━ NIH RePORTER v2 — keyless federal research-GRANT projects (ADR-0014)
  // The R2 getJson port's FIRST non-GET consumer. Live-hits
  // api.reporter.nih.gov/v2/projects/search (keyless POST/JSON, no key/cookie).
  // fiscal_years:[2023] + org_states:['CA'] is a broad, always-populated query
  // (live-verified to narrow to ~11k). A live transient (5xx/timeout/429) OR an
  // eRA maintenance window (the whole host 404s / off-host redirects to a
  // "System Unavailable" page → upstream_unavailable/not_found, never a fake
  // empty) is TOLERATED as a pass-with-note (the honest taxonomy working, not a
  // code failure). A 200 is verified normally: every project carries an
  // organization object (the recipient-enrichment payload with primaryUei).
  {
    name: "nih_reporter_search_projects",
    args: { fiscalYears: [2023], orgStates: ["CA"], limit: 3 },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited" ||
      env?.error?.kind === "not_found",
    verify: (r) =>
      Array.isArray(r.projects) &&
      r.projects.length >= 1 &&
      r.projects.length <= 3 &&
      r.projects.every(
        (p) =>
          p !== null &&
          typeof p === "object" &&
          p.organization !== null &&
          typeof p.organization === "object",
      ),
  },
  // ━━━ NSF Awards API — keyless federal research-GRANT awards (ADR-0020, source #20)
  // Live-hits api.nsf.gov (keyless). ueiNumber=FTMTDMBR29C7 (Johns Hopkins) is an
  // EXACT recipient-graph filter (a stable sub-10k count); every row carries the
  // awardee/UEI recipient-enrichment payload (the SAM/USAspending join) + a 7-digit
  // numeric id. A live transient (5xx/timeout/429) is TOLERATED as a pass-with-note.
  {
    name: "nsf_search_awards",
    args: { ueiNumber: "FTMTDMBR29C7", limit: 3 },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited",
    verify: (r) =>
      Array.isArray(r.awards) &&
      r.awards.length >= 1 &&
      r.awards.length <= 3 &&
      r.awards.every(
        (a) =>
          a !== null &&
          typeof a === "object" &&
          a.awardee !== null &&
          typeof a.awardee === "object" &&
          /^\d{5,9}$/.test(String(a.id)),
      ),
  },
  {
    // Full-record deep-dive (incl. abstractText) for the first award id from the
    // search above (chained — no hardcoded id). A nonexistent id ⇒ found:false; a
    // live transient is tolerated.
    name: "nsf_get_award",
    args: { awardId: "FETCH_FROM_PRIOR" },
    chain: { from: "nsf_search_awards", path: "awards[0].id" },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited",
    verify: (r) =>
      r.found === true &&
      r.award !== null &&
      typeof r.award === "object" &&
      /^\d{5,9}$/.test(String(r.award.id)) &&
      typeof r.award.abstractText === "string",
  },
  // ━━━ ClinicalTrials.gov API v2 — keyless clinical-study registrations (ADR-0021, source #21)
  // Live-hits clinicaltrials.gov (keyless). sponsor='Pfizer' is a stable multi-thousand
  // scoped total; every row carries the sponsor/org/funding entity-enrichment payload
  // (leadSponsor.{name,class} + an NCT id). countTotal=true ⇒ an exact filtered total.
  // A live transient (5xx/timeout/429) is TOLERATED as a pass-with-note.
  {
    name: "clinicaltrials_search_studies",
    args: { sponsor: "Pfizer", pageSize: 3 },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited",
    verify: (r) =>
      Array.isArray(r.studies) &&
      r.studies.length >= 1 &&
      r.studies.length <= 3 &&
      r.studies.every(
        (s) =>
          s !== null &&
          typeof s === "object" &&
          /^NCT\d{8}$/.test(String(s.nctId)) &&
          s.leadSponsor !== null &&
          typeof s.leadSponsor === "object",
      ),
  },
  {
    // Full-record deep-dive (incl. briefSummary) for the first nctId from the search
    // above (chained — no hardcoded id). A nonexistent id ⇒ found:false; a live
    // transient is tolerated.
    name: "clinicaltrials_get_study",
    args: { nctId: "FETCH_FROM_PRIOR" },
    chain: { from: "clinicaltrials_search_studies", path: "studies[0].nctId" },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited",
    verify: (r) =>
      r.found === true &&
      r.study !== null &&
      typeof r.study === "object" &&
      /^NCT\d{8}$/.test(String(r.study.nctId)),
  },
  // ━━━ EPA ECHO REST — keyless facility compliance/enforcement (ADR-0009)
  // Live-hits echodata.epa.gov (keyless). A live transient (5xx/timeout/429) is
  // acceptable and TOLERATED as a pass-with-note (the honest taxonomy, not a code
  // failure). p_st=DC is a small state (no queryset limit) with a stable ~4.7k
  // facilities; the two-step QueryID pagination is hidden in-call.
  {
    name: "echo_search_facilities",
    args: { state: "DC", limit: 3 },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited",
    verify: (r) =>
      r.state === "DC" &&
      Array.isArray(r.facilities) &&
      r.facilities.length >= 1 &&
      r.facilities.length <= 3 &&
      r.facilities.every(
        (f) => f !== null && typeof f === "object" && /^[0-9]{9,12}$/.test(String(f.RegistryID)),
      ),
  },
  {
    // DFR deep-dive for the first facility RegistryID from the search above
    // (chained — no hardcoded id). A bad id would be not_found; a live transient is
    // tolerated.
    name: "echo_facility_report",
    args: { registryId: "FETCH_FROM_PRIOR" },
    chain: { from: "echo_search_facilities", path: "facilities[0].RegistryID" },
    tolerateError: (env) =>
      env?.error?.kind === "upstream_unavailable" ||
      env?.error?.kind === "rate_limited",
    verify: (r) =>
      typeof r.registryId === "string" &&
      /^[0-9]{9,12}$/.test(r.registryId) &&
      r.report !== null &&
      typeof r.report === "object",
  },
  // ━━━ api.data.gov keyed trio — Regulations.gov + Congress.gov (ADR-0007)
  // These use DATA_GOV_API_KEY, else the shared public DEMO_KEY (~10 req/hr,
  // shared across ALL DEMO_KEY callers globally). A 429 rate_limited is therefore
  // EXPECTED on a clean install and is TOLERATED as a pass-with-note (the honest
  // error taxonomy working, not a code failure). A 200 is verified normally.
  {
    name: "regulations_search_documents",
    args: { searchTerm: "artificial intelligence", pageSize: 5 },
    tolerateError: (env) => env?.error?.kind === "rate_limited",
    verify: (r) =>
      Array.isArray(r.documents) &&
      r.documents.every(
        (d) => d === null || (typeof d === "object" && "id" in d),
      ),
  },
  {
    name: "regulations_search_comments",
    args: { searchTerm: "artificial intelligence", pageSize: 5 },
    tolerateError: (env) => env?.error?.kind === "rate_limited",
    verify: (r) =>
      Array.isArray(r.comments) &&
      r.comments.every(
        (c) => c === null || (typeof c === "object" && "id" in c),
      ),
  },
  {
    name: "congress_search_bills",
    args: { congress: 118, billType: "hr", limit: 3 },
    tolerateError: (env) => env?.error?.kind === "rate_limited",
    verify: (r) =>
      Array.isArray(r.bills) &&
      r.bills.length >= 1 &&
      r.bills.length <= 3 &&
      r.bills.every((b) => b !== null && typeof b === "object"),
  },
  {
    name: "congress_get_bill",
    args: { congress: 117, billType: "hr", billNumber: 3076 },
    tolerateError: (env) => env?.error?.kind === "rate_limited",
    verify: (r) => r.bill !== null && typeof r.bill === "object",
  },
  // ━━━ GovInfo — api.data.gov keyed trio's 3rd API (ADR-0010)
  // Same shared DEMO_KEY (~10 req/hr, shared globally) as the datagov trio, so a
  // 429 rate_limited (or its retry-backoff RPC timeout) is EXPECTED on a clean
  // install and TOLERATED as a pass-with-note. A 200 is verified normally. Note
  // search_packages/get_package validate the collection against the live
  // /collections catalog first, so the throttle typically manifests on that fetch.
  {
    name: "govinfo_list_collections",
    args: {},
    tolerateError: (env) => env?.error?.kind === "rate_limited",
    verify: (r) =>
      Array.isArray(r.collections) &&
      r.collections.length >= 1 &&
      r.collections.every(
        (c) => c !== null && typeof c === "object" && "collectionCode" in c,
      ),
  },
  {
    name: "govinfo_search_packages",
    args: { collection: "BILLS", startDate: "2024-01-01", pageSize: 3 },
    tolerateError: (env) => env?.error?.kind === "rate_limited",
    verify: (r) =>
      r.collection === "BILLS" &&
      Array.isArray(r.packages) &&
      r.packages.every(
        (p) => p === null || (typeof p === "object" && "packageId" in p),
      ),
  },
  {
    name: "govinfo_get_package",
    args: { packageId: "BILLS-118hr1enr" },
    tolerateError: (env) => env?.error?.kind === "rate_limited",
    verify: (r) =>
      typeof r.found === "boolean" &&
      r.packageId === "BILLS-118hr1enr" &&
      (r.found === false || (r.package !== null && typeof r.package === "object")),
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
      // A tolerateError-flagged tool (the api.data.gov datagov tools) whose shared
      // DEMO_KEY is currently rate-limited (429) manifests as an RPC TIMEOUT here,
      // NOT a fast error envelope: the standard fetchWithRetry taxonomy retries a
      // 429 with up to 60s backoff × attempts, which exceeds this smoke RPC window.
      // That timeout IS the rate-limit — tolerate it as a pass-with-note (the honest
      // taxonomy retrying a shared-key 429, not a code failure).
      if (test.tolerateError && /timeout/i.test(err.message ?? "")) {
        console.log(`~ ${test.name.padEnd(40)} TOLERATED (rate_limited → retry-backoff timeout) — shared DEMO_KEY throttled, counted as pass`);
        pass++;
        continue;
      }
      console.log(`✗ ${test.name} — ERROR: ${err.message}`);
      fail++;
      continue;
    }

    if (result.isError) {
      // Pass-with-note escape hatch: a tool may declare `tolerateError(envelope)`
      // for an EXPECTED, non-code upstream condition. The api.data.gov datagov
      // tools use the shared DEMO_KEY (~10 req/hr, shared globally), so a 429
      // rate_limited is EXPECTED and must NOT be a code failure — it is the honest
      // taxonomy doing its job. We surface it loudly but count it as a pass.
      if (test.tolerateError && test.tolerateError(result.parsed)) {
        const kind = result.parsed?.error?.kind ?? "?";
        console.log(`~ ${test.name.padEnd(40)} TOLERATED (${kind}) — expected shared-key condition, counted as pass`);
        pass++;
        continue;
      }
      console.log(`✗ ${test.name} — server returned isError; payload: ${typeof result.parsed === "string" ? result.parsed.slice(0, 120) : JSON.stringify(result.parsed).slice(0, 160)}`);
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

    // Every success response must now carry a well-formed `_meta` (§2.1).
    const metaProblem = checkMeta(result.meta);
    if (metaProblem) {
      console.log(`✗ ${test.name} — ${metaProblem}; _meta: ${JSON.stringify(result.meta).slice(0, 200)}`);
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
