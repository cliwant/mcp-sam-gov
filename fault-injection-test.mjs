#!/usr/bin/env node
/**
 * Fault-injection + golden-fixture harness — the DETERMINISTIC, OFFLINE guard
 * for the server's TRUTHFULNESS / GRACEFUL-DEGRADATION guarantees.
 *
 * Why this exists (and why it is separate from smoke/edge)
 * -------------------------------------------------------
 * `smoke-test.mjs` and `edge-case-test.mjs` hit the LIVE federal APIs, so they
 * can only observe whatever those upstreams happen to return today. They prove
 * the happy path and real error envelopes, but they CANNOT force a 503 on
 * `awards/{id}`, a failed `transactions/` page, or a crafted SAM exclusions
 * record — the exact adversarial conditions under which prior reviews found the
 * server telling the AI a confident LIE (a swallowed error rendered as an empty
 * list, an outage mislabeled `not_found`, a tokenized text hit reported as an
 * exclusion match). Those guarantees were only ever checked ad-hoc in review.
 *
 * This harness locks them in. It is:
 *   - 100% OFFLINE + DETERMINISTIC — it imports the BUILT `dist/*.js` and
 *     monkeypatches `globalThis.fetch` to force failures / craft responses. It
 *     makes NO network calls. It passes with the network unplugged.
 *   - Pure / in-process — no server spawn; it calls the exported functions
 *     directly, so a failure points at the exact function + invariant.
 *   - Loud — every case prints ✓/✗ and the process exits non-zero on ANY
 *     failure (same contract as edge-case-test.mjs), so it can gate a merge.
 *
 * Guarded areas (see README / the task spec):
 *   1. buildMeta invariants (dist/meta.js, pure)
 *   2. GSA-CSV RFC-4180 parser + enrichment merge (dist/gsa-csv.js, pure)
 *   3. analyzeIncumbent degradation — D1/D2/D3 (dist/usaspending.js, fetch-mock)
 *   4. checkExclusions name-gate (dist/integrity.js, fetch-mock)
 *   4b. integrityLookup composition — flag/fapiisRecords (dist/integrity.js, fetch-mock)
 *   5. getAwardDetail error classification (dist/usaspending.js, fetch-mock)
 *
 * Fetch is read at CALL TIME by the modules (bare `fetch(...)` / the
 * `fetchWithRetry` wrapper), so patching `globalThis.fetch` at runtime works;
 * we always restore it (and any `setTimeout` stub) in a finally so cases never
 * leak state into one another.
 */

import zlib from "node:zlib";
// The REAL server tool-dispatcher. Importing dist/server.js is SAFE (does not
// spawn the stdio server) because main() is entry-point-gated: it runs only
// when argv[1] === dist/server.js (a direct `node dist/server.js` / the bin /
// smoke's spawn), never on an import like this one. §9/§12/§13 call this real
// runTool over a mocked fetch so a regression in the real wrapper turns RED.
import { runTool } from "./dist/server.js";
import { toToolError, ToolErrorCarrier } from "./dist/errors.js";
import { buildMeta, isMetaBundle } from "./dist/meta.js";
import { parseRecordFields, enrichSearchOpportunities } from "./dist/gsa-csv.js";
import { analyzeIncumbent, getAwardDetail, lookupAgency, searchAwardsByRecipient, searchIndividualAwards, searchAwards, searchSubAgencySpending, searchCfdaSpending, searchRecompetes, spendingOverTime, getRecipientProfile, getAgencyProfile, getAgencyBudgetFunction, getAgencyAwardsSummary, naicsHierarchy, searchSubawards } from "./dist/usaspending.js";
import { checkExclusions, integrityLookup, searchTeamingPartners } from "./dist/integrity.js";
import { farClauseLookup, farComplianceMatrix, farSearch } from "./dist/far.js";
import { search as ecfrSearch } from "./dist/ecfr.js";
import { searchGrants, getGrant } from "./dist/grants.js";
import { searchDocuments as fedRegSearch, getDocument as fedRegGet } from "./dist/federal-register.js";
import { searchWageDeterminations, getWageRates, benchmarkLaborRates } from "./dist/pricing.js";
import { gaoProtestLookup } from "./dist/gao.js";
import { _clearCache } from "./dist/cache.js";
import { sizeStandard } from "./dist/sba.js";
import { fetchAttachmentText } from "./dist/attachments.js";
import {
  SamGovClient,
  daysUntilResponse,
  applyResponseDeadlineWindow,
} from "./dist/sam-gov/index.js";

// ─── Tiny assertion kit (mirrors edge-case-test.mjs conventions) ──────────
let PASS = 0;
let FAIL = 0;
const FAILURES = [];

/** Assert a boolean; `detail` is printed only on failure. */
function ok(label, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    PASS++;
  } else {
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      ${detail}`);
    FAIL++;
    FAILURES.push(label);
  }
}

/** Deep-equality assert (JSON structural) with a got/want dump on failure. */
function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  ok(label, g === w, `got ${g}\n      want ${w}`);
}

/** Run an async fn expecting it to THROW; return the thrown value (or a marker). */
async function expectThrow(fn) {
  try {
    const v = await fn();
    return { threw: false, value: v };
  } catch (e) {
    return { threw: true, error: e };
  }
}

function section(title) {
  console.log(`\n--- ${title} ---`);
}

// ─── Fetch mocking ────────────────────────────────────────────────────────
const REAL_FETCH = globalThis.fetch;
const REAL_SET_TIMEOUT = globalThis.setTimeout;

/**
 * Build a `Response`-like object good enough for the modules under test.
 * They only touch: `.ok`, `.status`, `.headers.get()`, `.json()`, (and for the
 * CSV download path `.body`, which we never exercise here).
 */
function mockResponse({ status = 200, json = {}, headers = {} } = {}) {
  const hdrs = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => hdrs.get(String(k).toLowerCase()) ?? null },
    json: async () => json,
    text: async () => (typeof json === "string" ? json : JSON.stringify(json)),
  };
}

/**
 * A `Response`-like object for a BINARY body. The attachment path reads
 * `.arrayBuffer()` (not `.json()`/`.text()`), so we expose that alongside the
 * `.ok/.status/.headers.get()` surface. `bytes` is a Uint8Array; we hand back a
 * fresh ArrayBuffer sliced to exactly its view (so a subarray fixture is safe).
 */
function mockBinaryResponse({ status = 200, bytes = new Uint8Array(0), headers = {}, url = undefined, redirected = false } = {}) {
  const hdrs = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    // res.url = the FINAL url after redirects (for the redirect-host SSRF check).
    // undefined ⇒ the tool treats the (already allow-listed) input host as final.
    url,
    // res.redirected ⇒ whether a redirect was followed (for the hidden-target guard).
    redirected,
    headers: { get: (k) => hdrs.get(String(k).toLowerCase()) ?? null },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

/**
 * Install a fetch mock for the duration of `fn`, then ALWAYS restore the real
 * fetch (and neutralize the retry backoff so 5xx/network cases don't sleep for
 * real seconds — the behavior under test is unaffected by wait duration, only
 * by the sequence of responses). `handler(url, init)` returns either a
 * mockResponse(...) (to resolve) or throws (to simulate a network-level fault).
 */
async function withFetch(handler, fn) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = typeof url === "string" ? url : String(url?.url ?? url);
    calls.push({ url: u, init });
    return handler(u, init, calls);
  };
  // Make fetchWithRetry's exponential-backoff `setTimeout(res, wait*1000)`
  // fire immediately — deterministic + fast, same response sequence.
  globalThis.setTimeout = (cb, _ms, ...rest) => REAL_SET_TIMEOUT(cb, 0, ...rest);
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = REAL_FETCH;
    globalThis.setTimeout = REAL_SET_TIMEOUT;
  }
}

/** A fetch handler that fails EVERY request (should never be reached offline). */
function failClosed() {
  return () => {
    throw new Error("NETWORK CALL LEAKED — a test hit the real network path");
  };
}

// URL classifiers for the USAspending surface (analyzeIncumbent / getAwardDetail).
const isAwardsDetail = (u) => /\/api\/v2\/awards\/[^/]+\/?($|\?)/.test(u) && !/transactions/.test(u);
const isTransactions = (u) => /\/api\/v2\/transactions\/?$/.test(u);
const isSpendingByAward = (u) => /\/search\/spending_by_award\/?$/.test(u);
const isSpendingByAwardCount = (u) => /\/search\/spending_by_award_count\/?$/.test(u);
const isSgs = (u) => /sam\.gov\/api\/prod\/sgs\/v1\/search/.test(u);

// URL classifiers for the FAR surface (farClauseLookup → eCFR versioner).
const isEcfrTitles = (u) => /\/versioner\/v1\/titles\.json/.test(u);
const isEcfrFull = (u) => /\/versioner\/v1\/full\//.test(u);
// eCFR full-text search endpoint (far_search → ecfr.search → /search/v1/results).
const isEcfrSearchResults = (u) => /\/search\/v1\/results/.test(u);
/** The `hierarchy[chapter]=N` query param off a search URL (the scoped chapter). */
const ecfrSearchChapter = (u) => {
  const m = /[?&]hierarchy(?:%5B|\[)chapter(?:%5D|\])=([^&]+)/.exec(u);
  return m ? Number(decodeURIComponent(m[1])) : null;
};
/** The `section=` query param off a versioner-full URL (the clause/section id). */
const ecfrSection = (u) => {
  const m = /[?&]section=([^&]+)/.exec(u);
  return m ? decodeURIComponent(m[1]) : null;
};

// A minimal but REALISTIC titles.json (only Title 48's fields farClauseLookup
// reads: number + up_to_date_as_of + latest_amended_on).
const TITLES_JSON = {
  titles: [
    {
      number: 48,
      name: "Federal Acquisition Regulations System",
      latest_amended_on: "2026-05-07",
      latest_issue_date: "2026-06-02",
      up_to_date_as_of: "2026-07-01",
      reserved: false,
    },
  ],
};

// A trimmed FAR clause fixture: a <HEAD> that DUPLICATES the clause number, a
// `(NOV 2023)` revision token (plus a decoy `(NOV 2021)` LATER — the parser must
// take the FIRST), an `As prescribed in 12.301(b)(3)` opener, and "insert the
// following clause". Mirrors the live 52.212-4 structure.
const CLAUSE_XML_52_212_4 = `<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="52.212-4" TYPE="SECTION">
<HEAD>52.212-4 Contract Terms and Conditions&#8212;Commercial Products and Commercial Services.</HEAD>
<P>As prescribed in 12.301(b)(3), insert the following clause:</P>
<EXTRACT>
<HD1>Contract Terms and Conditions&#8212;Commercial Products and Commercial Services (NOV 2023)</HD1>
<P>(a) <I>Inspection/Acceptance.</I> The Contractor shall only tender for acceptance those items that conform to the requirements of this contract.</P>
<P>(c) <I>Changes.</I> Changes in the terms and conditions of this contract may be made only by written agreement of the parties (NOV 2021).</P>
</EXTRACT>
</DIV8>`;

// A trimmed DFARS clause fixture (252. prefix → regulation DFARS).
const CLAUSE_XML_252_204_7012 = `<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="252.204-7012" TYPE="SECTION">
<HEAD>252.204-7012 Safeguarding Covered Defense Information and Cyber Incident Reporting.</HEAD>
<P>As prescribed in 204.7304(c), insert the following clause:</P>
<EXTRACT>
<HD1>Safeguarding Covered Defense Information and Cyber Incident Reporting (JAN 2023)</HD1>
<P>(a) <I>Definitions.</I> As used in this clause&#8212;</P>
</EXTRACT>
</DIV8>`;

// A trimmed prescribing section fixture (12.301) — its <HEAD> + body text.
const SECTION_XML_12_301 = `<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="12.301" TYPE="SECTION">
<HEAD>12.301 Solicitation provisions and contract clauses for the acquisition of commercial products and commercial services.</HEAD>
<P>(b)(3) Insert the clause at 52.212-4, Contract Terms and Conditions&#8212;Commercial Products and Commercial Services.</P>
</DIV8>`;

// A well-formed awards/{id} detail body (only the fields analyzeIncumbent reads).
function awardDetailBody(overrides = {}) {
  return {
    piid: "PIID-001",
    recipient: { recipient_name: "ACME DEFENSE LLC" },
    total_obligation: 900000,
    base_and_all_options: 1000000, // pctConsumed = 0.9 → ceiling_nearly_exhausted
    base_exercised_options: 500000,
    subaward_count: 3,
    type: "C",
    type_description: "DELIVERY ORDER",
    period_of_performance: {
      start_date: "2022-01-01",
      end_date: "2030-01-01",
      potential_end_date: "2031-01-01",
    },
    description: "Support services",
    latest_transaction_contract_data: {
      type_set_aside: "SBA",
      type_set_aside_description: "Total Small Business",
      extent_competed: "D",
      extent_competed_description: "FULL AND OPEN COMPETITION",
      number_of_offers_received: "3",
      naics: "541512",
      naics_description: "Computer Systems Design",
      product_or_service_code: "D307",
      product_or_service_description: "IT",
    },
    awarding_agency: {
      toptier_agency: { name: "Department of Defense" },
      subtier_agency: { name: "Department of the Army" },
    },
    parent_award: null,
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// 1. buildMeta invariants (pure — no fetch)
// ══════════════════════════════════════════════════════════════════════════
function testBuildMeta() {
  section("1. buildMeta invariants (pure)");

  // 1a. Zero-input safe default: a tool that supplies nothing is truthfully
  // "single-record / known-complete".
  {
    const m = buildMeta();
    ok("empty partial → complete:true, truncated:false (safe default)",
      m.complete === true && m.truncated === false,
      JSON.stringify(m));
  }

  // 1b. totalAvailable > returned ⇒ truncated ⇒ NOT complete (proof of truncation).
  {
    const m = buildMeta({ returned: 10, totalAvailable: 100 });
    ok("totalAvailable(100) > returned(10) ⇒ truncated:true, complete:false",
      m.truncated === true && m.complete === false,
      JSON.stringify(m));
  }

  // 1c. returned === totalAvailable ⇒ NOT proof of truncation ⇒ complete.
  {
    const m = buildMeta({ returned: 7, totalAvailable: 7 });
    ok("returned === totalAvailable ⇒ truncated:false, complete:true",
      m.truncated === false && m.complete === true,
      JSON.stringify(m));
  }

  // 1d. filtersDropped non-empty ⇒ complete:false AND a disclosing note is
  // auto-added when the caller supplied none.
  {
    const m = buildMeta({ returned: 5, totalAvailable: 5, filtersDropped: ["setAside"] });
    ok("filtersDropped non-empty ⇒ complete:false",
      m.complete === false,
      JSON.stringify(m));
    ok("filtersDropped non-empty ⇒ a note is present (auto-added)",
      m.notes.length >= 1 && m.notes.some((n) => /setAside/.test(n)),
      JSON.stringify(m.notes));
  }

  // 1e. pagination.hasMore ⇒ truncated ⇒ complete:false.
  {
    const m = buildMeta({
      returned: 25,
      pagination: { offset: 0, limit: 25, nextOffset: 25, hasMore: true },
    });
    ok("pagination.hasMore:true ⇒ truncated:true, complete:false",
      m.truncated === true && m.complete === false,
      JSON.stringify(m));
  }

  // 1f. degraded.failed > 0 ⇒ complete:false (lossy enrichment breaks completeness).
  {
    const m = buildMeta({ returned: 3, totalAvailable: 3, degraded: { attempted: 3, failed: 1 } });
    ok("degraded.failed>0 ⇒ complete:false",
      m.complete === false,
      JSON.stringify(m));
  }
  {
    const m = buildMeta({ returned: 3, totalAvailable: 3, degraded: { attempted: 3, failed: 0 } });
    ok("degraded.failed===0 ⇒ complete:true (no false degradation)",
      m.complete === true,
      JSON.stringify(m));
  }

  // 1g. Explicit complete:false is HONORED even when the invariant would derive true.
  {
    const m = buildMeta({ returned: 1, totalAvailable: 1, complete: false });
    ok("explicit complete:false honored (never silently flipped to true)",
      m.complete === false,
      JSON.stringify(m));
  }

  // 1h. A caller CANNOT claim complete:true when the invariant says false —
  // complete is derived, an explicit `true` does not override a real truncation.
  {
    const m = buildMeta({ returned: 1, totalAvailable: 50, complete: true });
    ok("complete:true cannot override totalProvesTruncation (stays false)",
      m.complete === false && m.truncated === true,
      JSON.stringify(m));
  }

  // 1i. The full "complete IFF" conjunction: complete true ONLY when every clause holds.
  {
    const m = buildMeta({
      returned: 5,
      totalAvailable: 5,
      truncated: false,
      filtersDropped: [],
      pagination: { offset: 0, limit: 5, nextOffset: null, hasMore: false },
      degraded: { attempted: 5, failed: 0 },
    });
    ok("complete IFF: all clauses satisfied ⇒ complete:true",
      m.complete === true,
      JSON.stringify(m));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 2. GSA-CSV parser (RFC-4180) + enrichment merge (pure — no fetch)
// ══════════════════════════════════════════════════════════════════════════
function testGsaCsvParser() {
  section("2a. GSA-CSV RFC-4180 parser (pure)");

  // Embedded comma inside quotes stays ONE field.
  eq("embedded comma stays one field",
    parseRecordFields('a,"x, y, z",c', 24).fields, ["a", "x, y, z", "c"]);

  // "" escape → a single literal quote.
  eq('""-escape → single literal quote',
    parseRecordFields('a,"say ""hi""",c', 24).fields, ["a", 'say "hi"', "c"]);

  // Newline INSIDE a quoted field → parser reports inQuotes:true (record spans
  // physical lines; the assembler will keep accumulating).
  {
    const r = parseRecordFields('id,"line one\nline two', 24);
    ok("newline inside quoted field ⇒ inQuotes:true (record continues)",
      r.inQuotes === true, JSON.stringify(r));
  }

  // A newline in a LATE column (Description@46, past maxCol=24) MUST still be
  // detected as spanning — the parser caps STORAGE at maxCol but keeps SCANNING
  // quote parity, so the next record's NoticeId is never corrupted by a stray
  // Description tail. (This was a real bug: cap storage, never cap scanning.)
  {
    // Build a record with 46 leading columns then an OPEN quote at col 46.
    const line = "NID," + "x,".repeat(45) + '"desc opens a quote then the physical line breaks';
    const r = parseRecordFields(line, 24);
    ok("late-column (Description@46) open quote still spans ⇒ inQuotes:true",
      r.inQuotes === true, JSON.stringify(r.inQuotes));
    ok("storage capped at maxCol+1 while scanning continued past it",
      r.fields.length <= 25, `fields.length=${r.fields.length}`);
    eq("early columns still parsed correctly (NoticeId intact)",
      r.fields[0], "NID");
  }

  // CRLF vs LF: a stray CR is stripped so CRLF-terminated cells equal LF ones.
  eq("CRLF: stray CR stripped (CRLF cell === LF cell)",
    parseRecordFields("a,b\r,c", 24).fields, ["a", "b", "c"]);

  // Empty field + trailing comma → a trailing empty field is preserved.
  eq("empty field preserved (a,,c)",
    parseRecordFields("a,,c", 24).fields, ["a", "", "c"]);
  eq("trailing comma ⇒ trailing empty field",
    parseRecordFields("a,b,", 24).fields, ["a", "b", ""]);

  // A balanced quoted field reports inQuotes:false (record is complete).
  ok("balanced quoted field ⇒ inQuotes:false",
    parseRecordFields('a,"whole",c', 24).inQuotes === false);

  // ── The "next record NoticeId not corrupted" invariant, end-to-end via the
  // exported parser: parse a record that ends mid-Description-quote, then the
  // CONTINUATION line that closes the quote and (in the real assembler) the
  // NEXT physical line is a fresh record. We assert the parser's parity so the
  // assembler splits at the right boundary.
  {
    const openRec = 'AAAA0000AAAA0000AAAA0000AAAA0001,Title,' + "x,".repeat(43) + '"a quoted description with a';
    const first = parseRecordFields(openRec, 24);
    ok("record with open Description quote ⇒ inQuotes:true (won't swallow next id)",
      first.inQuotes === true);
    // The continuation that CLOSES the quote → parity returns to false, so the
    // following physical line becomes a new logical record (fresh NoticeId).
    const closed = parseRecordFields(openRec + '\ncontinues here"', 24);
    ok("closing the Description quote ⇒ inQuotes:false (boundary restored)",
      closed.inQuotes === false);
    eq("after the multi-line record, col0 is STILL the original NoticeId",
      closed.fields[0], "AAAA0000AAAA0000AAAA0000AAAA0001");
  }
}

function testGsaCsvEnrichment() {
  section("2b. GSA-CSV enrichment merge (pure)");

  // A hand-built ReadyIndex (the exact shape enrichSearchOpportunities consumes:
  // `get(noticeId)` → NoticeFields | undefined, plus freshness metadata). No CSV
  // file, no fetch — the merge logic is exercised in isolation.
  const FIELDS = (o = {}) => ({
    title: "", type: "", setAsideCode: "", setAside: "", responseDeadline: "",
    naicsCode: "", popCity: "", popState: "", popZip: "", popCountry: "", active: "",
    ...o,
  });
  const snapshot = new Map([
    ["aaaa0000aaaa0000aaaa0000aaaa0001", FIELDS({
      title: "CSV Title A", type: "Solicitation", setAsideCode: "SBA",
      responseDeadline: "2026-08-15T17:00:00-04:00", naicsCode: "541512",
      popCity: "Richmond", popState: "VA", popZip: "23219", popCountry: "USA",
    })],
    // Row with EMPTY set-aside + no Pop* cells (absence ≠ empty string).
    ["cccc2222cccc2222cccc2222cccc0003", FIELDS({
      type: "Special Notice", naicsCode: "339112", setAsideCode: "",
    })],
  ]);
  const index = {
    get: (id) => snapshot.get((id ?? "").trim().toLowerCase()),
    csvLastModified: "Wed, 02 Jul 2026 06:00:00 GMT",
    indexBuiltAt: new Date().toISOString(),
    rowCount: snapshot.size,
  };

  const halPage = [
    // All enrichable fields null → should be FILLED from the CSV.
    { noticeId: "aaaa0000aaaa0000aaaa0000aaaa0001", title: "HAL A", agency: "VA",
      responseDeadline: null, naics: null, setAside: null },
    // Empty CSV set-aside + no PoP → those stay null / keys NOT added.
    { noticeId: "cccc2222cccc2222cccc2222cccc0003", title: "HAL C", agency: "DoD",
      responseDeadline: null, naics: null, setAside: null },
    // Absent from snapshot → left byte-identical + counted as missing.
    { noticeId: "ffff9999ffff9999ffff9999ffff0000", title: "HAL MISSING",
      responseDeadline: null, naics: null, setAside: null },
    // Pre-set (keyed-like) values → NEVER overwritten (null-only fill).
    { noticeId: "aaaa0000aaaa0000aaaa0000aaaa0001", title: "HAL A2",
      responseDeadline: "PRESET-DL", naics: "999999", setAside: "PRESET" },
  ];

  const outcome = enrichSearchOpportunities(halPage, index);
  const rows = outcome.opportunities;

  // Row A (index 0): every null field filled from the CSV.
  const A = rows[0];
  ok("fill: null naics/setAside(code)/deadline/type filled from CSV",
    A.naics === "541512" && A.setAside === "SBA" &&
    A.responseDeadline === "2026-08-15T17:00:00-04:00" && A.type === "Solicitation",
    JSON.stringify(A));
  ok("fill: placeOfPerformance assembled from Pop* cells",
    A.placeOfPerformance && A.placeOfPerformance.state === "VA" &&
    A.placeOfPerformance.city === "Richmond" && A.placeOfPerformance.zip === "23219" &&
    A.placeOfPerformance.country === "USA",
    JSON.stringify(A.placeOfPerformance));
  ok("fill: HAL-supplied fields preserved (title/agency untouched)",
    A.title === "HAL A" && A.agency === "VA");

  // Row C (index 1): empty CSV set-aside stays null; no PoP key added.
  const C = rows[1];
  ok("empty CSV cell stays null (absence ≠ \"\"): setAside null despite present row",
    C.setAside === null, JSON.stringify(C));
  ok("no placeOfPerformance key added when every Pop* cell empty",
    !("placeOfPerformance" in C), JSON.stringify(Object.keys(C)));
  ok("row C: naics/type STILL filled from CSV (partial fill on same row)",
    C.naics === "339112" && C.type === "Special Notice");

  // Row MISSING (index 2): untouched + counted, no spurious keys.
  const M = rows[2];
  ok("miss: absent noticeId left byte-identical (all null, no new keys)",
    M.naics === null && M.setAside === null && M.responseDeadline === null &&
    !("type" in M) && !("placeOfPerformance" in M) && M.title === "HAL MISSING",
    JSON.stringify(M));

  // Row PRESET (index 3): a non-null value is NEVER overwritten.
  const P = rows[3];
  ok("no-overwrite: pre-set naics/setAside/deadline preserved (fill is null-only)",
    P.naics === "999999" && P.setAside === "PRESET" && P.responseDeadline === "PRESET-DL",
    JSON.stringify(P));
  // type/PoP were null on the PRESET row → they DO get filled (proves fill still
  // runs for the untouched fields, i.e. we don't skip the whole row).
  ok("no-overwrite: null fields on a partially-preset row still fill",
    P.type === "Solicitation" && !!P.placeOfPerformance);

  // Accounting: exactly the found/missing split, no wrong-notice injection.
  ok("accounting: foundCount=3 (A, C, A-again), missingCount=1 (MISSING)",
    outcome.foundCount === 3 && outcome.missingCount === 1,
    `found=${outcome.foundCount} missing=${outcome.missingCount}`);
  ok("fieldsFilled tracks what was actually filled (naics/setAside/type/PoP/deadline)",
    outcome.fieldsFilled.has("naics") && outcome.fieldsFilled.has("setAside") &&
    outcome.fieldsFilled.has("type") && outcome.fieldsFilled.has("placeOfPerformance") &&
    outcome.fieldsFilled.has("responseDeadline"),
    JSON.stringify([...outcome.fieldsFilled]));
  ok("freshness surfaced (csvLastModified + indexBuiltAt + rowCount)",
    outcome.freshness && outcome.freshness.rowCount === 2 &&
    typeof outcome.freshness.indexBuiltAt === "string");
  // No wrong-notice injection: each output row keeps its own noticeId.
  ok("no wrong-notice injection: output noticeIds equal input order",
    rows.map((r) => r.noticeId).join("|") === halPage.map((r) => r.noticeId).join("|"));
}

// ══════════════════════════════════════════════════════════════════════════
// 5. getAwardDetail error classification (fetch-mock)
//   (run before #3 because analyzeIncumbent builds on getAwardDetail)
// ══════════════════════════════════════════════════════════════════════════
async function testGetAwardDetail() {
  section("5. getAwardDetail error classification (fetch-mock)");

  // 404 ⇒ null (a genuine "not found"; callers turn this into not_found).
  await withFetch(
    (u) => (isAwardsDetail(u) ? mockResponse({ status: 404 }) : failClosed()()),
    async () => {
      const r = await getAwardDetail("GEN-404");
      ok("404 ⇒ null (genuine not-found, never a thrown outage)", r === null,
        `returned ${JSON.stringify(r)}`);
    },
  );

  // 429 ⇒ throws rate_limited, retryable:true (never a masked null).
  await withFetch(
    (u) => (isAwardsDetail(u) ? mockResponse({ status: 429 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => getAwardDetail("GEN-429"));
      ok("429 ⇒ throws (not a silent null)", threw);
      ok("429 ⇒ kind:rate_limited, retryable:true",
        threw && error?.toolError?.kind === "rate_limited" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // 503 ⇒ throws upstream_unavailable, retryable:true.
  await withFetch(
    (u) => (isAwardsDetail(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => getAwardDetail("GEN-503"));
      ok("5xx ⇒ kind:upstream_unavailable, retryable:true",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // Network fault (fetch rejects) ⇒ throws upstream_unavailable retryable,
  // NOT a masked {ok:true,data:null} / silent null.
  await withFetch(
    (u) => {
      if (isAwardsDetail(u)) throw new Error("ECONNRESET");
      return failClosed()();
    },
    async () => {
      const { threw, error } = await expectThrow(() => getAwardDetail("GEN-NET"));
      ok("network fault ⇒ throws upstream_unavailable retryable (never silent null)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // Sanity: a well-formed 200 body ⇒ a populated detail (no false failure).
  await withFetch(
    (u) => (isAwardsDetail(u) ? mockResponse({ status: 200, json: awardDetailBody() }) : failClosed()()),
    async () => {
      const r = await getAwardDetail("GEN-OK");
      ok("200 ⇒ populated detail (recipient + ceiling parsed, not null)",
        r && r.recipient === "ACME DEFENSE LLC" && r.baseAndAllOptions === 1000000,
        JSON.stringify(r && { recipient: r.recipient, ceiling: r.baseAndAllOptions }));
    },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 3. analyzeIncumbent degradation — the D1/D2/D3 defects (fetch-mock)
// ══════════════════════════════════════════════════════════════════════════
async function testAnalyzeIncumbent() {
  section("3. analyzeIncumbent graceful degradation (fetch-mock)");

  const GEN = "CONT_AWD_TEST_0001";

  // ── D3-precursor: awards/{id} → 503 ⇒ analyzeIncumbent THROWS
  // upstream_unavailable retryable — NOT not_found. An outage must never be
  // rendered as "this award does not exist".
  await withFetch(
    (u) => (isAwardsDetail(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => analyzeIncumbent({ generatedInternalId: GEN }));
      ok("awards/{id} 503 ⇒ throws upstream_unavailable (NOT not_found)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── A genuine 404 on awards/{id} ⇒ not_found (distinct from the outage above).
  await withFetch(
    (u) => (isAwardsDetail(u) ? mockResponse({ status: 404 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => analyzeIncumbent({ generatedInternalId: GEN }));
      ok("awards/{id} 404 ⇒ throws not_found, retryable:false (genuine miss)",
        threw && error?.toolError?.kind === "not_found" &&
        error?.toolError?.retryable === false,
        JSON.stringify(error?.toolError));
    },
  );

  // ── lookupAgency (usas_lookup_agency): the LAST silent-empty-on-outage in the
  // codebase, now routed through postUsas (fetchWithRetry). A DOWN funding_agency
  // autocomplete must THROW upstream_unavailable — NEVER return { matches: [] },
  // which an AI reads as "no such agency" when the endpoint is merely down. A
  // GENUINE no-match (200 + empty results) still returns an honest empty. Unique
  // search_text per case avoids the memoize cache.
  const isFundingAgency = (u) => /autocomplete\/funding_agency/.test(u);
  await withFetch(
    (u) => (isFundingAgency(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => lookupAgency("la-outage-503"));
      ok("lookupAgency 503 ⇒ throws upstream_unavailable (NOT a fake { matches: [] })",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );
  await withFetch(
    (u) => (isFundingAgency(u) ? mockResponse({ status: 200, json: { results: [] } }) : failClosed()()),
    async () => {
      const r = await lookupAgency("la-genuine-empty-xyz");
      ok("lookupAgency 200-empty ⇒ honest empty matches (a real no-match, never fabricated)",
        Array.isArray(r.matches) && r.matches.length === 0,
        JSON.stringify(r));
    },
  );
  await withFetch(
    (u) => (isFundingAgency(u)
      ? mockResponse({ status: 200, json: { results: [{ toptier_flag: true, toptier_agency: { name: "Department of Veterans Affairs", abbreviation: "VA", toptier_code: "036" } }] } })
      : failClosed()()),
    async () => {
      const r = await lookupAgency("la-maps-va");
      ok("lookupAgency 200 ⇒ maps matches (name/abbreviation/toptierCode/isToptier)",
        r.matches.length === 1 && r.matches[0].name === "Department of Veterans Affairs" &&
        r.matches[0].abbreviation === "VA" && r.matches[0].toptierCode === "036" && r.matches[0].isToptier === true,
        JSON.stringify(r.matches));
    },
  );

  // ── D2: transactions/ FAILS ⇒ modCount:null + _meta.complete:false + a
  // disclosing note. (detail ok, recipient search ok, ONLY transactions down.)
  await withFetch(
    (u) => {
      if (isAwardsDetail(u)) return mockResponse({ status: 200, json: awardDetailBody() });
      if (isTransactions(u)) return mockResponse({ status: 503 }); // fail the mod-count page
      if (isSpendingByAward(u)) {
        return mockResponse({ status: 200, json: { results: [], page_metadata: { hasNext: false } } });
      }
      if (isSpendingByAwardCount(u)) {
        return mockResponse({ status: 200, json: { results: { contracts: 0 } } });
      }
      return failClosed()();
    },
    async () => {
      const res = await analyzeIncumbent({ generatedInternalId: GEN });
      ok("transactions fail ⇒ signals.modCount === null (unknown, not zero)",
        res.data.signals.modCount === null,
        JSON.stringify(res.data.signals.modCount));
      ok("transactions fail ⇒ _meta.complete === false (degraded, not complete)",
        res.meta.complete === false, JSON.stringify(res.meta.complete));
      ok("transactions fail ⇒ a note DISCLOSES modCount is null because the call FAILED",
        res.meta.notes.some((n) => /modCount is null.*FAILED/i.test(n)),
        JSON.stringify(res.meta.notes));
    },
  );

  // ── D1: the recipient spending_by_award search FAILS ⇒
  // incumbentOtherAwards:[] + _meta.complete:false + a disclosing note. An empty
  // list here is "the search failed", NOT "the incumbent has no other awards".
  await withFetch(
    (u) => {
      if (isAwardsDetail(u)) return mockResponse({ status: 200, json: awardDetailBody() });
      if (isTransactions(u)) {
        return mockResponse({ status: 200, json: { results: [{}, {}], page_metadata: { hasNext: false } } });
      }
      // Fail BOTH the recipient search and its companion count.
      if (isSpendingByAward(u)) return mockResponse({ status: 503 });
      if (isSpendingByAwardCount(u)) return mockResponse({ status: 503 });
      return failClosed()();
    },
    async () => {
      const res = await analyzeIncumbent({ generatedInternalId: GEN });
      ok("recipient search fail ⇒ incumbentOtherAwards === [] (empty, disclosed)",
        Array.isArray(res.data.incumbentOtherAwards) && res.data.incumbentOtherAwards.length === 0,
        JSON.stringify(res.data.incumbentOtherAwards));
      ok("recipient search fail ⇒ _meta.complete === false",
        res.meta.complete === false, JSON.stringify(res.meta.complete));
      ok("recipient search fail ⇒ a note DISCLOSES the empty list is a FAILED search (not 'no awards')",
        res.meta.notes.some((n) => /incumbentOtherAwards.*FAILED/i.test(n) || /recipient search FAILED/i.test(n)),
        JSON.stringify(res.meta.notes));
      // modCount still populated from the successful transactions page (2 rows).
      ok("recipient fail (transactions OK) ⇒ modCount still reflects the good page (=2)",
        res.data.signals.modCount === 2, JSON.stringify(res.data.signals.modCount));
    },
  );

  // ── All-success ⇒ complete truthy, NO false "FAILED" notes, and the other
  // awards list actually reflects the returned rows (minus the analyzed award).
  await withFetch(
    (u) => {
      if (isAwardsDetail(u)) return mockResponse({ status: 200, json: awardDetailBody() });
      if (isTransactions(u)) {
        return mockResponse({ status: 200, json: { results: [{}, {}, {}], page_metadata: { hasNext: false } } });
      }
      if (isSpendingByAward(u)) {
        return mockResponse({
          status: 200,
          json: {
            results: [
              { "Award ID": "OTHER-1", "Recipient Name": "ACME DEFENSE LLC", "Award Amount": 100,
                "Awarding Agency": "Department of Defense", generated_internal_id: "OTHER-1", NAICS: { code: "541512" } },
              // The award under analysis itself — must be filtered OUT of "other".
              { "Award ID": "SELF", "Recipient Name": "ACME DEFENSE LLC", "Award Amount": 200,
                "Awarding Agency": "Department of Defense", generated_internal_id: GEN, NAICS: { code: "541512" } },
            ],
            page_metadata: { hasNext: false },
          },
        });
      }
      if (isSpendingByAwardCount(u)) {
        return mockResponse({ status: 200, json: { results: { contracts: 2 } } });
      }
      return failClosed()();
    },
    async () => {
      const res = await analyzeIncumbent({ generatedInternalId: GEN });
      ok("all-success ⇒ _meta.complete !== false (truthy/undefined, i.e. not forced-degraded)",
        res.meta.complete !== false, JSON.stringify(res.meta.complete));
      ok("all-success ⇒ NO false 'FAILED' disclosure note present",
        !res.meta.notes.some((n) => /FAILED/i.test(n)),
        JSON.stringify(res.meta.notes.filter((n) => /FAILED/i.test(n))));
      ok("all-success ⇒ modCount reflects the transactions page (=3)",
        res.data.signals.modCount === 3, JSON.stringify(res.data.signals.modCount));
      ok("all-success ⇒ the analyzed award is filtered OUT of incumbentOtherAwards",
        res.data.incumbentOtherAwards.length === 1 &&
        res.data.incumbentOtherAwards[0].generatedInternalId === "OTHER-1",
        JSON.stringify(res.data.incumbentOtherAwards.map((a) => a.generatedInternalId)));
      // Sanity: a public pressure hint is derived (pctConsumed 0.9 → ceiling_nearly_exhausted).
      ok("all-success ⇒ pressureHints derived from PUBLIC signals (ceiling_nearly_exhausted)",
        res.data.pressureHints.includes("ceiling_nearly_exhausted"),
        JSON.stringify(res.data.pressureHints));
    },
  );

  // ── Blank recipient_name on the award ⇒ the incumbent identity is UNKNOWN.
  // Two masquerades to guard: incumbent must be null (not "" = "none"), and with
  // includeOtherAwards the SKIPPED recipient search must not let the empty
  // incumbentOtherAwards read as "no other awards". Same class as D1. (Detail +
  // transactions succeed; only the recipient_name is absent.)
  await withFetch(
    (u) => {
      if (isAwardsDetail(u)) return mockResponse({ status: 200, json: awardDetailBody({ recipient: { recipient_name: "" } }) });
      if (isTransactions(u)) {
        return mockResponse({ status: 200, json: { results: [{}, {}], page_metadata: { hasNext: false } } });
      }
      // These MUST NOT be hit — a blank recipient means the search is skipped.
      if (isSpendingByAward(u) || isSpendingByAwardCount(u)) {
        throw new Error("recipient search must be SKIPPED when recipient_name is blank");
      }
      return failClosed()();
    },
    async () => {
      // getAwardDetail's RAW recipient must also be null (not "") — usas_get_award_detail
      // exposes it directly, and it must be consistent with analyzeIncumbent's incumbent.
      const dd = await getAwardDetail(GEN);
      ok("blank recipient ⇒ getAwardDetail.recipient === null (raw detail honest, not '')",
        dd.recipient === null, JSON.stringify(dd.recipient));

      const res = await analyzeIncumbent({ generatedInternalId: GEN });
      ok("blank recipient ⇒ award.incumbent === null (UNKNOWN, not '' = 'none')",
        res.data.award.incumbent === null, JSON.stringify(res.data.award.incumbent));
      ok("blank recipient ⇒ _meta.fieldsUnavailable includes 'recipient_name'",
        res.meta.fieldsUnavailable.includes("recipient_name"), JSON.stringify(res.meta.fieldsUnavailable));
      ok("blank recipient ⇒ a note DISCLOSES the incumbent identity is UNKNOWN",
        res.meta.notes.some((n) => /incumbent identity is UNKNOWN/i.test(n)), JSON.stringify(res.meta.notes));
      ok("blank recipient + includeOtherAwards ⇒ incumbentOtherAwards === [] (skipped, disclosed)",
        Array.isArray(res.data.incumbentOtherAwards) && res.data.incumbentOtherAwards.length === 0,
        JSON.stringify(res.data.incumbentOtherAwards));
      ok("blank recipient ⇒ a note DISCLOSES the empty list is a SKIPPED search (not 'no awards')",
        res.meta.notes.some((n) => /SKIPPED, not run and found empty/i.test(n)), JSON.stringify(res.meta.notes));
      ok("blank recipient (includeOtherAwards) ⇒ _meta.complete === false (masquerade averted)",
        res.meta.complete === false, JSON.stringify(res.meta.complete));
      // The award-level signals are still COMPLETE and honest (modCount from the good page).
      ok("blank recipient ⇒ award-level signals still populated (modCount=2 from the good page)",
        res.data.signals.modCount === 2, JSON.stringify(res.data.signals.modCount));
    },
  );

  // ── Null money fields (total_obligation / base_and_all_options absent) ⇒
  // UNKNOWN, not $0. A null ceiling is common+legitimate (IDVs/BPAs/grants);
  // rendering 0 would read as "a $0 ceiling" (data-absence-as-present). Both
  // getAwardDetail and analyzeIncumbent must surface null + disclose, and
  // pctConsumed must be null (never null/N coerced to 0 = "0% consumed").
  await withFetch(
    (u) => {
      if (isAwardsDetail(u)) return mockResponse({ status: 200, json: awardDetailBody({ total_obligation: null, base_and_all_options: null }) });
      if (isTransactions(u)) return mockResponse({ status: 200, json: { results: [{}], page_metadata: { hasNext: false } } });
      if (isSpendingByAward(u)) return mockResponse({ status: 200, json: { results: [], page_metadata: { hasNext: false } } });
      if (isSpendingByAwardCount(u)) return mockResponse({ status: 200, json: { results: { contracts: 0 } } });
      return failClosed()();
    },
    async () => {
      const d = await getAwardDetail(GEN);
      ok("null money ⇒ getAwardDetail.baseAndAllOptions === null (UNKNOWN, not 0)",
        d.baseAndAllOptions === null, JSON.stringify(d.baseAndAllOptions));
      ok("null money ⇒ getAwardDetail.totalObligation === null (UNKNOWN, not 0)",
        d.totalObligation === null, JSON.stringify(d.totalObligation));

      const res = await analyzeIncumbent({ generatedInternalId: GEN });
      ok("null money ⇒ signals.obligatedVsCeiling.baseAndAllOptions === null (not 0)",
        res.data.signals.obligatedVsCeiling.baseAndAllOptions === null,
        JSON.stringify(res.data.signals.obligatedVsCeiling.baseAndAllOptions));
      ok("null money ⇒ signals.obligatedVsCeiling.obligated === null (not 0)",
        res.data.signals.obligatedVsCeiling.obligated === null,
        JSON.stringify(res.data.signals.obligatedVsCeiling.obligated));
      ok("null money ⇒ pctConsumed === null (never null/N coerced to 0% consumed)",
        res.data.signals.obligatedVsCeiling.pctConsumed === null,
        JSON.stringify(res.data.signals.obligatedVsCeiling.pctConsumed));
      ok("null money ⇒ fieldsUnavailable discloses base_and_all_options + total_obligation",
        res.meta.fieldsUnavailable.includes("base_and_all_options") && res.meta.fieldsUnavailable.includes("total_obligation"),
        JSON.stringify(res.meta.fieldsUnavailable));
      ok("null money ⇒ NO fabricated 'ceiling_nearly_exhausted' hint (pctConsumed null)",
        !res.data.pressureHints.includes("ceiling_nearly_exhausted"),
        JSON.stringify(res.data.pressureHints));
      // A null ceiling is a property of the award (IDV), not a fetch failure →
      // NOT forced-degraded (disclosed via fieldsUnavailable, analysis still valid).
      ok("null money ⇒ _meta.complete !== false (disclosed, not a failure/degradation)",
        res.meta.complete !== false, JSON.stringify(res.meta.complete));
    },
  );

  // ── Search-result identity fields: a row missing Recipient Name / Awarding
  // Agency must map to null (UNKNOWN), never "" (which reads as "no recipient").
  // Same invariant as getAwardDetail. (Rare on the core spending_by_award columns,
  // but the mapper must not fabricate an empty-string identity.)
  await withFetch(
    (u) => {
      if (isSpendingByAward(u)) {
        return mockResponse({
          status: 200,
          json: {
            results: [
              { "Award ID": "X1", "Award Amount": 100, generated_internal_id: "X1" }, // no Recipient Name / Awarding Agency
              { "Award ID": "X2", "Recipient Name": "REAL CORP", "Awarding Agency": "Department of Energy", "Award Amount": 200, generated_internal_id: "X2" },
            ],
            page_metadata: { hasNext: false },
          },
        });
      }
      if (isSpendingByAwardCount(u)) return mockResponse({ status: 200, json: { results: { contracts: 2 } } });
      return failClosed()();
    },
    async () => {
      const r = await searchAwardsByRecipient({ recipientName: "ANY CO", limit: 5 });
      const rows = r.data.awards;
      const x1 = rows.find((a) => a.awardId === "X1");
      const x2 = rows.find((a) => a.awardId === "X2");
      ok("search row missing recipient ⇒ recipient === null (not '')",
        x1.recipient === null, JSON.stringify(x1.recipient));
      ok("search row missing awardingAgency ⇒ awardingAgency === null (not '')",
        x1.awardingAgency === null, JSON.stringify(x1.awardingAgency));
      ok("search row WITH identity ⇒ values preserved unchanged (no over-nulling)",
        x2.recipient === "REAL CORP" && x2.awardingAgency === "Department of Energy",
        JSON.stringify({ r: x2.recipient, a: x2.awardingAgency }));
    },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 4. checkExclusions name-gate (fetch-mock returning crafted SGS results)
// ══════════════════════════════════════════════════════════════════════════
async function testCheckExclusions() {
  section("4. checkExclusions name-gate (fetch-mock)");

  // Craft an SGS HAL page. checkExclusions reads json._embedded.results[] with
  // { title, isActive, ueiSam, cageCode, ... } and json.page.totalElements.
  const sgs = (results, totalElements = results.length) =>
    mockResponse({ status: 200, json: { _embedded: { results }, page: { totalElements } } });

  // ── TOKEN-MATCH TRAP: query "VISIONARY CONSULTING PARTNERS" against records
  // that merely SHARE the token "PARTNERS" ("Urban Partners LLC", "KZOO
  // Partners LLC"). SAM's free-text `q` would return them, but the normalized
  // NAME gate must DROP them ⇒ excluded:false, matchCount:0.
  await withFetch(
    (u) => (isSgs(u)
      ? sgs([
          { title: "Urban Partners LLC", isActive: true, ueiSam: "U1", cageCode: "C1" },
          { title: "KZOO Partners LLC", isActive: true, ueiSam: "U2", cageCode: "C2" },
        ])
      : failClosed()()),
    async () => {
      const res = await checkExclusions({ query: "VISIONARY CONSULTING PARTNERS" });
      ok("token-only hits DROPPED ⇒ excluded:false",
        res.data.excluded === false, JSON.stringify(res.data.excluded));
      ok("token-only hits DROPPED ⇒ matchCount:0 (no other firm's exclusion flagged)",
        res.data.matchCount === 0, JSON.stringify(res.data.matchCount));
      ok("token-only hits DROPPED ⇒ records is empty",
        Array.isArray(res.data.records) && res.data.records.length === 0);
      ok("'not proof of responsibility' disclosure ALWAYS present (empty result)",
        res.meta.notes.some((n) => /NOT proof of general responsibility/i.test(n)),
        JSON.stringify(res.meta.notes));
      // A note should disclose that shared-word text hits were dropped.
      ok("dropped-text-hits disclosed (SAM free-text tokens NOT a name match)",
        res.meta.notes.some((n) => /NOT matching the normalized firm name/i.test(n)),
        JSON.stringify(res.meta.notes));
    },
  );

  // ── EXACT NAME MATCH: a record whose NORMALIZED name equals the query (suffix
  // "LLC" stripped on both sides) ⇒ excluded:true, matchCount:1.
  await withFetch(
    (u) => (isSgs(u)
      ? sgs([
          { title: "VISIONARY CONSULTING PARTNERS, LLC", isActive: true, ueiSam: "UEIX", cageCode: "CG1",
            classification: { code: "F" }, exclusionType: "Ineligible" },
          { title: "Unrelated Vendor Inc", isActive: true, ueiSam: "U9", cageCode: "C9" },
        ])
      : failClosed()()),
    async () => {
      const res = await checkExclusions({ query: "Visionary Consulting Partners" });
      ok("normalized-name EQUALS query ⇒ excluded:true",
        res.data.excluded === true, JSON.stringify(res.data.excluded));
      ok("normalized-name EQUALS query ⇒ matchCount:1 (only the true match)",
        res.data.matchCount === 1, JSON.stringify(res.data.matchCount));
      ok("the matched record is the right firm (uei carried through)",
        res.data.records.length === 1 && res.data.records[0].uei === "UEIX",
        JSON.stringify(res.data.records.map((r) => r.uei)));
      ok("'not proof of responsibility' disclosure present even on a HIT",
        res.meta.notes.some((n) => /NOT proof of general responsibility/i.test(n)));
    },
  );

  // ── An INACTIVE exact-name record ⇒ still not `excluded` (excluded reflects
  // ACTIVE records only), and with activeOnly the record is filtered out.
  await withFetch(
    (u) => (isSgs(u)
      ? sgs([{ title: "VISIONARY CONSULTING PARTNERS LLC", isActive: false, ueiSam: "UEIX" }])
      : failClosed()()),
    async () => {
      const res = await checkExclusions({ query: "Visionary Consulting Partners", activeOnly: true });
      ok("inactive exact-name (activeOnly) ⇒ excluded:false, matchCount:0",
        res.data.excluded === false && res.data.matchCount === 0,
        JSON.stringify({ excluded: res.data.excluded, matchCount: res.data.matchCount }));
    },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 4b. integrityLookup composition — flag + fapiisRecords honesty (fetch-mock)
//   integrityLookup REUSES checkExclusions, so the SAME crafted SGS page drives
//   both. We assert the composed verdict: an active NAME-matching exclusion ⇒
//   "excluded"; ZERO matches ⇒ "review_fapiis" (NEVER "clear") + fapiisRecords
//   null + fieldsUnavailable:["fapiisRecords"]; and that an upstream failure
//   PROPAGATES (never a fake clearance).
// ══════════════════════════════════════════════════════════════════════════
async function testIntegrityLookup() {
  section("4b. integrityLookup composition (fetch-mock)");

  const sgs = (results, totalElements = results.length) =>
    mockResponse({ status: 200, json: { _embedded: { results }, page: { totalElements } } });

  // ── (i) An ACTIVE, normalized-name-matching exclusion ⇒ integrityFlag
  // "excluded", exclusions.excluded true, and the matched record carried through.
  await withFetch(
    (u) => (isSgs(u)
      ? sgs([
          { title: "ACME DEFENSE, LLC", isActive: true, ueiSam: "UEIA", cageCode: "CG1",
            classification: { code: "F" }, exclusionType: "Ineligible" },
          // A shared-token but NON-matching firm — must NOT flip the flag.
          { title: "Globex Defense Inc", isActive: true, ueiSam: "U9", cageCode: "C9" },
        ])
      : failClosed()()),
    async () => {
      const res = await integrityLookup({ name: "Acme Defense" });
      ok("active name-match ⇒ integrityFlag 'excluded'",
        res.data.integrityFlag === "excluded", JSON.stringify(res.data.integrityFlag));
      ok("active name-match ⇒ exclusions.excluded true + activeCount 1 (token hit dropped)",
        res.data.exclusions.excluded === true && res.data.exclusions.activeCount === 1,
        JSON.stringify({ excluded: res.data.exclusions.excluded, activeCount: res.data.exclusions.activeCount }));
      ok("the carried record is the right firm (uei UEIA)",
        res.data.exclusions.records.length === 1 && res.data.exclusions.records[0].uei === "UEIA",
        JSON.stringify(res.data.exclusions.records.map((r) => r.uei)));
      // Even on a HIT, fapiisRecords stays null (record-level is key-gated).
      ok("hit ⇒ fapiisRecords still null (never faked)",
        res.data.fapiisRecords === null, JSON.stringify(res.data.fapiisRecords));
      ok("integrityFlag is NEVER 'clear' (hit path)",
        res.data.integrityFlag !== "clear");
    },
  );

  // ── (ii) ZERO name matches ⇒ integrityFlag "review_fapiis" (NOT "clear"),
  // fapiisRecords null, and _meta.fieldsUnavailable includes "fapiisRecords".
  await withFetch(
    (u) => (isSgs(u)
      ? sgs([
          // Only shared-token noise — nothing normalizes to "ACME DEFENSE".
          { title: "Unrelated Vendor Inc", isActive: true, ueiSam: "U1" },
          { title: "Another Firm LLC", isActive: true, ueiSam: "U2" },
        ])
      : failClosed()()),
    async () => {
      const res = await integrityLookup({ name: "Acme Defense" });
      ok("zero matches ⇒ integrityFlag 'review_fapiis' (NOT 'clear')",
        res.data.integrityFlag === "review_fapiis", JSON.stringify(res.data.integrityFlag));
      ok("zero matches ⇒ integrityFlag is NEVER 'clear'",
        res.data.integrityFlag !== "clear");
      ok("zero matches ⇒ exclusions.excluded false + activeCount 0 + no records",
        res.data.exclusions.excluded === false && res.data.exclusions.activeCount === 0 &&
        res.data.exclusions.records.length === 0,
        JSON.stringify(res.data.exclusions));
      ok("zero matches ⇒ fapiisRecords null (key-gated, never faked)",
        res.data.fapiisRecords === null, JSON.stringify(res.data.fapiisRecords));
      ok("zero matches ⇒ _meta.fieldsUnavailable includes 'fapiisRecords'",
        (res.meta.fieldsUnavailable ?? []).includes("fapiisRecords"),
        JSON.stringify(res.meta.fieldsUnavailable));
      ok("zero matches ⇒ 'not a full integrity clearance' note present",
        res.meta.notes.some((n) => /not a full integrity clearance/i.test(n)),
        JSON.stringify(res.meta.notes));
      // Carry-through of checkExclusions' own honesty.
      ok("zero matches ⇒ 'not proof of responsibility' carried through",
        res.meta.notes.some((n) => /NOT proof of general responsibility/i.test(n)));
    },
  );

  // ── (iii) A uei-specific deep-link is emitted when a UEI is supplied (and the
  // exclusion still resolves via the mocked page).
  await withFetch(
    (u) => (isSgs(u)
      ? sgs([{ title: "ACME DEFENSE LLC", isActive: true, ueiSam: "UEIA" }])
      : failClosed()()),
    async () => {
      const res = await integrityLookup({ uei: "UEIA", name: "Acme Defense" });
      ok("uei supplied ⇒ fapiisUrl is the entity-workspace responsibility deep-link",
        /workspace\/profile\/UEIA\/responsibilityInformation$/.test(res.data.fapiisUrl),
        JSON.stringify(res.data.fapiisUrl));
      // uei post-filter is applied inside checkExclusions ⇒ the record matches.
      ok("uei supplied ⇒ integrityFlag 'excluded' (uei+name both matched)",
        res.data.integrityFlag === "excluded", JSON.stringify(res.data.integrityFlag));
    },
  );

  // ── (iv) An upstream SGS 503 ⇒ integrityLookup THROWS the classified error
  // (upstream_unavailable, retryable) — NEVER a fake "clear"/empty verdict.
  await withFetch(
    (u) => (isSgs(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => integrityLookup({ name: "Acme Defense" }));
      ok("upstream 503 ⇒ throws (never a fake 'clear'/empty verdict)", threw);
      ok("upstream 503 ⇒ kind upstream_unavailable, retryable:true (classified, propagated)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (v) No identifier ⇒ structured invalid_input (no network reached).
  {
    const { threw, error } = await expectThrow(() => integrityLookup({}));
    ok("no identifier ⇒ throws invalid_input, retryable:false",
      threw && error?.toolError?.kind === "invalid_input" &&
      error?.toolError?.retryable === false,
      JSON.stringify(error?.toolError));
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 8. far_clause_lookup — authoritative clause parse + graceful degradation
//    (dist/far.js, fetch-mock). Guards: the clause/prescription XML parse, the
//    always-present farOverhaulRisk caveat, the non-fatal prescription failure,
//    the 404 → not_found (never a fake empty clause), point-in-time currency,
//    and the DFARS regulation/appliesTo mapping.
//
//    NOTE on caching: farClauseLookup memoizes titles-currency (once) and each
//    section XML by URL, and the cache is process-global. Each case below uses a
//    DISTINCT clause number (and the override case a distinct asOfDate), so no
//    cached clause/section bleeds across cases. Title 48 currency is identical
//    across cases, so the shared cached value is correct for all of them.
// ══════════════════════════════════════════════════════════════════════════
async function testFarClauseLookup() {
  section("8. far_clause_lookup clause parse + degradation (fetch-mock)");

  const titles = () => mockResponse({ status: 200, json: TITLES_JSON });
  const xml = (body) => mockResponse({ status: 200, json: body });

  // ── (a) HAPPY PATH: heading (dup clause-number stripped), revision (FIRST
  // token), prescription (section fetched + parsed), kind, regulation FAR;
  // farOverhaulRisk present with the 3 deviationSources + appliesTo "FAR";
  // isCurrent true (asOfDate defaulted to upToDateAsOf).
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u)) {
        const s = ecfrSection(u);
        if (s === "52.212-4") return xml(CLAUSE_XML_52_212_4);
        if (s === "12.301") return xml(SECTION_XML_12_301);
      }
      return failClosed()();
    },
    async () => {
      const res = await farClauseLookup({ clauseNumber: "52.212-4" });
      const d = res.data;
      ok("happy: heading has the duplicated leading clause number stripped",
        d.heading === "Contract Terms and Conditions—Commercial Products and Commercial Services.",
        JSON.stringify(d.heading));
      ok("happy: revision is the FIRST token 'NOV 2023' (decoy 'NOV 2021' ignored)",
        d.revision === "NOV 2023", JSON.stringify(d.revision));
      ok("happy: prescribedIn parsed = '12.301(b)(3)'",
        d.prescribedIn === "12.301(b)(3)", JSON.stringify(d.prescribedIn));
      ok("happy: kind = 'clause'", d.kind === "clause", JSON.stringify(d.kind));
      ok("happy: regulation = 'FAR' (52. prefix)",
        d.regulation === "FAR", JSON.stringify(d.regulation));
      ok("happy: prescription fetched (base section 12.301, subparagraph trimmed)",
        d.prescription && d.prescription.section === "12.301" &&
        /Solicitation provisions/i.test(d.prescription.heading ?? ""),
        JSON.stringify(d.prescription && { section: d.prescription.section, heading: d.prescription.heading }));
      ok("happy: prescription text carries the section body (stripped)",
        d.prescription && /Insert the clause at 52\.212-4/i.test(d.prescription.text),
        JSON.stringify(d.prescription && d.prescription.text));
      ok("happy: clause text is stripped prose (no XML tags, entity decoded)",
        typeof d.text === "string" && !/[<>]/.test(d.text) &&
        /Contract Terms and Conditions—Commercial/i.test(d.text),
        JSON.stringify(d.text.slice(0, 80)));
      ok("happy: farOverhaulRisk present with all 3 deviationSources",
        d.farOverhaulRisk && Array.isArray(d.farOverhaulRisk.deviationSources) &&
        d.farOverhaulRisk.deviationSources.length === 3 &&
        d.farOverhaulRisk.deviationSources.includes("https://www.acquisition.gov/far-overhaul") &&
        d.farOverhaulRisk.deviationSources.includes("https://www.acquisition.gov/dfars") &&
        d.farOverhaulRisk.deviationSources.includes("https://www.acq.osd.mil/dpap/dars/"),
        JSON.stringify(d.farOverhaulRisk && d.farOverhaulRisk.deviationSources));
      ok("happy: farOverhaulRisk.appliesTo = 'FAR' (scoped to regulation)",
        d.farOverhaulRisk && d.farOverhaulRisk.appliesTo === "FAR",
        JSON.stringify(d.farOverhaulRisk && d.farOverhaulRisk.appliesTo));
      ok("happy: farOverhaulRisk carries NO fabricated case number/date (only the fixed note + URLs)",
        d.farOverhaulRisk && !/case\s*\d{4}|\d{4}-\d{2,3}|comments?\s+close/i.test(d.farOverhaulRisk.note),
        JSON.stringify(d.farOverhaulRisk && d.farOverhaulRisk.note));
      ok("happy: asOfDate defaulted to Title 48 upToDateAsOf (2026-07-01)",
        d.asOfDate === "2026-07-01" && d.titleUpToDateAsOf === "2026-07-01",
        JSON.stringify({ asOfDate: d.asOfDate, up: d.titleUpToDateAsOf }));
      ok("happy: isCurrent true (asOfDate === upToDateAsOf)",
        d.isCurrent === true, JSON.stringify(d.isCurrent));
      ok("happy: _meta not degraded (prescription present ⇒ complete not forced false)",
        res.meta.complete !== false &&
        !(res.meta.fieldsUnavailable ?? []).includes("prescription"),
        JSON.stringify({ complete: res.meta.complete, fu: res.meta.fieldsUnavailable }));
    },
  );

  // ── (b) PRESCRIPTION FETCH FAILS (500 on the section call) ⇒ prescription
  // null, clause STILL returned, _meta discloses it (fieldsUnavailable +
  // complete:false + a disclosing note). A different clause number (52.204-25)
  // → its own cache key; its prescription section (4.2105) 500s.
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u)) {
        const s = ecfrSection(u);
        if (s === "52.204-25") {
          return xml(`<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="52.204-25" TYPE="SECTION">
<HEAD>52.204-25 Prohibition on Contracting for Certain Telecommunications and Video Surveillance Services or Equipment.</HEAD>
<P>As prescribed in 4.2105(b), insert the following clause:</P>
<EXTRACT><HD1>Prohibition ... (NOV 2021)</HD1><P>(a) Definitions.</P></EXTRACT>
</DIV8>`);
        }
        if (s === "4.2105") return mockResponse({ status: 500 }); // section fails
      }
      return failClosed()();
    },
    async () => {
      const res = await farClauseLookup({ clauseNumber: "52.204-25" });
      const d = res.data;
      ok("presc-fail: clause STILL returned (heading parsed despite section failure)",
        /Prohibition on Contracting/i.test(d.heading ?? ""), JSON.stringify(d.heading));
      ok("presc-fail: prescribedIn still parsed = '4.2105(b)'",
        d.prescribedIn === "4.2105(b)", JSON.stringify(d.prescribedIn));
      ok("presc-fail: prescription === null (non-fatal, never crashed the clause)",
        d.prescription === null, JSON.stringify(d.prescription));
      ok("presc-fail: _meta.fieldsUnavailable includes 'prescription'",
        (res.meta.fieldsUnavailable ?? []).includes("prescription"),
        JSON.stringify(res.meta.fieldsUnavailable));
      ok("presc-fail: _meta.complete === false (partial result disclosed)",
        res.meta.complete === false, JSON.stringify(res.meta.complete));
      ok("presc-fail: a note DISCLOSES the prescribing section could not be fetched",
        res.meta.notes.some((n) => /prescribing section 4\.2105 .*could NOT be fetched/i.test(n)),
        JSON.stringify(res.meta.notes));
    },
  );

  // ── (c) CLAUSE 404 ⇒ throws not_found (retryable:false) NAMING the clause —
  // NEVER null/empty. Use a clause that does not exist (52.999-99); titles ok.
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u) && ecfrSection(u) === "52.999-99") {
        return mockResponse({ status: 404, json: { error: "No matching content found." } });
      }
      return failClosed()();
    },
    async () => {
      const { threw, error, value } = await expectThrow(() =>
        farClauseLookup({ clauseNumber: "52.999-99" }));
      ok("404: THROWS (never returns a null/empty clause)",
        threw && value === undefined, JSON.stringify({ threw, value }));
      ok("404: kind not_found, retryable:false",
        threw && error?.toolError?.kind === "not_found" &&
        error?.toolError?.retryable === false,
        JSON.stringify(error?.toolError));
      ok("404: message NAMES the clause (52.999-99)",
        threw && /52\.999-99/.test(error?.toolError?.message ?? ""),
        JSON.stringify(error?.toolError?.message));
    },
  );

  // ── (c2) TRUTHFULNESS: a DOWN service (500 on the CLAUSE) must NOT read as
  // "clause not found" — it PROPAGATES as upstream_unavailable (retryable),
  // NEVER a fake not_found/empty. (52.777-77 → its own cache key.)
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u) && ecfrSection(u) === "52.777-77") {
        return mockResponse({ status: 503 });
      }
      return failClosed()();
    },
    async () => {
      const { threw, error } = await expectThrow(() =>
        farClauseLookup({ clauseNumber: "52.777-77" }));
      ok("clause 503 ⇒ throws upstream_unavailable retryable (NOT a fake not_found)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (d) asOfDate OVERRIDE != upToDateAsOf ⇒ isCurrent:false AND the override
  // appears in the fetched clause URL. Use clause 52.203-99 + date 2025-01-01,
  // no prescription (includePrescription:false) to keep it to one clause call.
  await withFetch(
    (u, _i, calls) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u) && ecfrSection(u) === "52.203-99") {
        // Record that the override date is in the URL for the assertion below.
        calls._overrideDateInUrl = /\/full\/2025-01-01\/title-48\.xml/.test(u);
        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="52.203-99" TYPE="SECTION">
<HEAD>52.203-99 Prohibition on a Test Clause.</HEAD>
<P>As prescribed in 3.9999, insert the following clause:</P>
<EXTRACT><HD1>Prohibition ... (JAN 2025)</HD1><P>(a) Text.</P></EXTRACT>
</DIV8>`);
      }
      return failClosed()();
    },
    async (calls) => {
      const res = await farClauseLookup({
        clauseNumber: "52.203-99",
        asOfDate: "2025-01-01",
        includePrescription: false,
      });
      const d = res.data;
      ok("override: asOfDate echoed = '2025-01-01'",
        d.asOfDate === "2025-01-01", JSON.stringify(d.asOfDate));
      ok("override: isCurrent false (2025-01-01 != upToDateAsOf 2026-07-01)",
        d.isCurrent === false, JSON.stringify(d.isCurrent));
      ok("override: the override date appears in the fetched clause URL",
        calls._overrideDateInUrl === true, JSON.stringify(calls._overrideDateInUrl));
      ok("override: a note discloses the point-in-time (non-current) read",
        res.meta.notes.some((n) => /NOT Title 48's current codification date/i.test(n)),
        JSON.stringify(res.meta.notes));
      ok("override: includePrescription:false ⇒ prescription null, NOT degraded",
        d.prescription === null && res.meta.complete !== false &&
        !(res.meta.fieldsUnavailable ?? []).includes("prescription"),
        JSON.stringify({ presc: d.prescription, complete: res.meta.complete }));
    },
  );

  // ── (e) DFARS prefix 252.204-7012 ⇒ regulation "DFARS", farOverhaulRisk
  // .appliesTo "DFARS". Its prescription section (204.7304) is mocked ok.
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u)) {
        const s = ecfrSection(u);
        if (s === "252.204-7012") return xml(CLAUSE_XML_252_204_7012);
        if (s === "204.7304") {
          return xml(`<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="204.7304" TYPE="SECTION"><HEAD>204.7304 Solicitation provisions and contract clauses.</HEAD>
<P>(c) Use the clause at 252.204-7012.</P></DIV8>`);
        }
      }
      return failClosed()();
    },
    async () => {
      const res = await farClauseLookup({ clauseNumber: "252.204-7012" });
      const d = res.data;
      ok("dfars: regulation = 'DFARS' (252. prefix)",
        d.regulation === "DFARS", JSON.stringify(d.regulation));
      ok("dfars: farOverhaulRisk.appliesTo = 'DFARS'",
        d.farOverhaulRisk && d.farOverhaulRisk.appliesTo === "DFARS",
        JSON.stringify(d.farOverhaulRisk && d.farOverhaulRisk.appliesTo));
      ok("dfars: prescribedIn = '204.7304(c)', base section 204.7304 fetched",
        d.prescribedIn === "204.7304(c)" && d.prescription &&
        d.prescription.section === "204.7304",
        JSON.stringify({ prescribedIn: d.prescribedIn, section: d.prescription && d.prescription.section }));
    },
  );

  // ── (f) INPUT GUARD: a non-clause string ⇒ invalid_input (defense-in-depth;
  // the server Zod schema also rejects, but far.ts guards too), NO network.
  {
    const { threw, error } = await expectThrow(() =>
      farClauseLookup({ clauseNumber: "hello world" }));
    ok("bad input ⇒ throws invalid_input, retryable:false (no fetch)",
      threw && error?.toolError?.kind === "invalid_input" &&
      error?.toolError?.retryable === false,
      JSON.stringify(error?.toolError));
  }

  // ── (g) DEFECT-2 GUARD: a 200 with a HOLLOW body (empty / CDN-WAF HTML
  // interstitial / truncated XML) must NOT become a fake `complete:true` clause
  // with empty text — it must be REFUSED as upstream_unavailable. Three hollow
  // shapes, each on its own clause number (distinct cache key), prescription off.
  for (const [label, clause, body] of [
    ["empty body", "52.900-01", ""],
    ["WAF/Cloudflare HTML interstitial (lowercase <head>)", "52.900-02",
      "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>Please wait while we verify your browser…</body></html>"],
    ["truncated XML (cut before any HEAD)", "52.900-03",
      '<?xml version="1.0" encoding="UTF-8"?>\n<DIV8 N="52.900-03" TYPE="SECTION">'],
  ]) {
    await withFetch(
      (u) => {
        if (isEcfrTitles(u)) return titles();
        if (isEcfrFull(u) && ecfrSection(u) === clause)
          return mockResponse({ status: 200, json: body });
        return failClosed()();
      },
      async () => {
        const { threw, error } = await expectThrow(() =>
          farClauseLookup({ clauseNumber: clause, includePrescription: false }));
        ok(`hollow-200 (${label}) ⇒ throws upstream_unavailable, NOT a hollow complete:true clause`,
          threw && error?.toolError?.kind === "upstream_unavailable" &&
          error?.toolError?.retryable === true,
          JSON.stringify(error?.toolError));
      },
    );
  }

  // ── (h) DEFECT-3: kind detection covers BOTH "insert the following …" and
  // "use the following …" (DFARS provisions use "use the following provision").
  // And when NEITHER verb is present, kind defaults to "clause" but a note
  // DISCLOSES it as inferred rather than asserting it.
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u) && ecfrSection(u) === "252.204-7008")
        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="252.204-7008" TYPE="SECTION">
<HEAD>252.204-7008 Compliance with Safeguarding Covered Defense Information Controls.</HEAD>
<P>As prescribed in 204.7304(a), use the following provision:</P>
<EXTRACT><HD1>Compliance … (OCT 2016)</HD1><P>(a) Definitions.</P></EXTRACT>
</DIV8>`);
      return failClosed()();
    },
    async () => {
      const res = await farClauseLookup({ clauseNumber: "252.204-7008", includePrescription: false });
      ok('dfars provision: "use the following provision" ⇒ kind = "provision" (NOT mislabeled "clause")',
        res.data.kind === "provision", JSON.stringify(res.data.kind));
    },
  );
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u) && ecfrSection(u) === "52.800-99")
        return xml(`<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="52.800-99" TYPE="SECTION">
<HEAD>52.800-99 A Section With No Prescribing Verb.</HEAD>
<P>(a) This section states requirements directly and carries no prescribing verb.</P>
</DIV8>`);
      return failClosed()();
    },
    async () => {
      const res = await farClauseLookup({ clauseNumber: "52.800-99", includePrescription: false });
      ok('no-verb: kind defaults to "clause" AND a note DISCLOSES it was inferred (not asserted)',
        res.data.kind === "clause" &&
        res.meta.notes.some((n) => /kind .*could NOT be determined|defaults to "clause"/i.test(n)),
        JSON.stringify({ kind: res.data.kind, notes: res.meta.notes }));
    },
  );

  // ── (i) DEFECT-1 GUARD: a currency-resolution failure must NOT masquerade as
  // "clause not found". If titles.json returns 200 but Title 48 lacks
  // up_to_date_as_of (schema drift) AND no asOfDate is supplied, refuse with
  // schema_drift — NEVER query a blank-date URL, NEVER map its 404 to not_found.
  // _clearCache first (earlier cases cached the GOOD currency); runs LAST so its
  // null-currency cannot poison other cases.
  await withFetch(
    (u) => {
      if (isEcfrTitles(u))
        // Title 48 present but up_to_date_as_of MISSING (renamed/dropped).
        return mockResponse({ status: 200, json: {
          titles: [{ number: 48, name: "Federal Acquisition Regulations System", latest_amended_on: "2026-05-07" }],
        } });
      // If the guard FAILED, a blank-date clause fetch would land here and 404 —
      // the OLD bug mapped that to not_found. Return 404 to make the regression sharp.
      if (isEcfrFull(u)) return mockResponse({ status: 404, json: { error: "Not Found" } });
      return failClosed()();
    },
    async (calls) => {
      _clearCache();
      const { threw, error } = await expectThrow(() =>
        farClauseLookup({ clauseNumber: "52.212-4" }));
      ok("currency-null ⇒ throws schema_drift retryable (NOT a fake not_found on a real clause)",
        threw && error?.toolError?.kind === "schema_drift" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
      ok("currency-null ⇒ NO blank-date clause fetch attempted (guard fired before the versioner)",
        calls.every((c) => !isEcfrFull(c.url)),
        JSON.stringify(calls.map((c) => c.url)));
    },
  );
  _clearCache(); // wipe case (i)'s NULL currency before the normalize cases below.

  // ── (j) NORMALIZE HARDENING (truthfulness): normalizeClauseNumber must strip
  // ONLY a leading FAR/DFARS prefix + surrounding whitespace — NEVER embedded
  // characters. The old `.replace(/[^\d.\-]/g,"")` mangled a garbage input like
  // "52.212-4extra5" into "52.212-45" (a DIFFERENT real clause) that passed
  // CLAUSE_RE and fetched a SILENTLY-WRONG answer. The fix leaves the junk in
  // place so CLAUSE_RE rejects it ⇒ invalid_input, aligning far.ts standalone
  // with the server Zod boundary (which already rejects the same strings). These
  // reject cases reach NO network (the guard fires before any fetch).
  for (const bad of [
    "52.212-4extra5", // the load-bearing case: would have mangled → 52.212-45
    "52.212-4/5",
    "52.212-4 and 52.204-25",
    "foo52.212-4",
    "52.212-4.",       // trailing punct is NOT part of the clause (Zod rejects too)
  ]) {
    await withFetch(
      // Any fetch would be a bug: the input must be rejected before the versioner.
      () => { throw new Error(`NETWORK LEAKED — a mangled clause '${bad}' was fetched instead of rejected`); },
      async () => {
        const { threw, error } = await expectThrow(() =>
          farClauseLookup({ clauseNumber: bad }));
        ok(`normalize: '${bad}' ⇒ invalid_input (NOT a mangled fetch of a wrong clause)`,
          threw && error?.toolError?.kind === "invalid_input" &&
          error?.toolError?.retryable === false,
          JSON.stringify(error?.toolError));
      },
    );
  }

  // ── (j2) NORMALIZE — the LEGIT shapes still resolve: a bare clause, a 'FAR '
  // prefix, and surrounding whitespace all normalize to the SAME bare clause and
  // succeed (d.clauseNumber is the stripped core '52.212-4'). Proves the fix did
  // not over-tighten — only garbage is rejected, valid prefixes/whitespace pass.
  _clearCache();
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u) && ecfrSection(u) === "52.212-4") return xml(CLAUSE_XML_52_212_4);
      return failClosed()();
    },
    async () => {
      for (const [label, input] of [
        ["bare '52.212-4'", "52.212-4"],
        ["prefixed 'FAR 52.212-4'", "FAR 52.212-4"],
        ["whitespace ' 52.212-4 '", " 52.212-4 "],
      ]) {
        const res = await farClauseLookup({ clauseNumber: input, includePrescription: false });
        ok(`normalize: ${label} ⇒ resolves to bare clause '52.212-4' (prefix/space stripped, not mangled)`,
          res.data.clauseNumber === "52.212-4",
          JSON.stringify(res.data.clauseNumber));
      }
    },
  );

  // ── (j3) DFARS prefix stripping still works: 'DFARS 252.204-7012' normalizes to
  // the bare '252.204-7012' and resolves (regulation DFARS), proving the prefix
  // strip is intact for the DFARS family too.
  _clearCache();
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u)) {
        const s = ecfrSection(u);
        if (s === "252.204-7012") return xml(CLAUSE_XML_252_204_7012);
        if (s === "204.7304")
          return xml(`<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="204.7304" TYPE="SECTION"><HEAD>204.7304 Solicitation provisions and contract clauses.</HEAD>
<P>(c) Use the clause at 252.204-7012.</P></DIV8>`);
      }
      return failClosed()();
    },
    async () => {
      const res = await farClauseLookup({ clauseNumber: "DFARS 252.204-7012" });
      ok("normalize: 'DFARS 252.204-7012' ⇒ bare '252.204-7012', regulation DFARS",
        res.data.clauseNumber === "252.204-7012" && res.data.regulation === "DFARS",
        JSON.stringify({ c: res.data.clauseNumber, reg: res.data.regulation }));
    },
  );

  _clearCache(); // leave a clean cache for any later suite.
}

// ══════════════════════════════════════════════════════════════════════════
// 9. far_compliance_matrix — RFP cited-clause list → proposal-ready matrix
//    (dist/far.js, fetch-mock). It COMPOSES far_clause_lookup, so the load-
//    bearing guards here are the ones the composition adds: the not_found (404)
//    vs errored (5xx/other) SPLIT into DIFFERENT buckets, per-clause isolation
//    (one failure never sinks the matrix), the static gate map, dedupe (one
//    fetch per unique clause), and the summary/_meta consistency invariants.
//
//    Caching note: far_clause_lookup memoizes currency (once) + each section XML
//    by URL, process-global. Cases use DISTINCT clause numbers so no resolved
//    body bleeds into a case expecting a 404/503; _clearCache() before the
//    dedupe case makes its call-count assertion exact.
// ══════════════════════════════════════════════════════════════════════════
async function testFarComplianceMatrix() {
  section("9. far_compliance_matrix matrix + not-found/errored split (fetch-mock)");

  const titles = () => mockResponse({ status: 200, json: TITLES_JSON });
  const xml = (body) => mockResponse({ status: 200, json: body });

  // A resolved FAR clause fixture that is NOT a gate (52.212-4), a resolved DFARS
  // GATE fixture (252.204-7012), and a Section-889 GATE fixture (52.204-25).
  const CLAUSE_XML_52_204_25 = `<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="52.204-25" TYPE="SECTION">
<HEAD>52.204-25 Prohibition on Contracting for Certain Telecommunications and Video Surveillance Services or Equipment.</HEAD>
<P>As prescribed in 4.2105(b), insert the following clause:</P>
<EXTRACT><HD1>Prohibition ... (NOV 2021)</HD1><P>(a) Definitions.</P></EXTRACT>
</DIV8>`;

  // ── (a) MIXED BATCH (the core): 52.212-4 + 252.204-7012 resolve (200), 52.999-99
  // is a genuine 404 (→ unresolved), 52.777-77 is a 503 outage (→ errored). The
  // 404 and the 503 MUST land in DIFFERENT buckets. Prescription off to keep the
  // fetch surface to one call per clause.
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u)) {
        const s = ecfrSection(u);
        if (s === "52.212-4") return xml(CLAUSE_XML_52_212_4);
        if (s === "252.204-7012") return xml(CLAUSE_XML_252_204_7012);
        if (s === "52.999-99")
          return mockResponse({ status: 404, json: { error: "No matching content found." } });
        if (s === "52.777-77") return mockResponse({ status: 503 });
      }
      return failClosed()();
    },
    async () => {
      const res = await farComplianceMatrix({
        clauses: ["52.212-4", "252.204-7012", "52.999-99", "52.777-77"],
        includePrescription: false,
      });
      const d = res.data;
      ok("mixed: rows.length === 2 (only the two 200 clauses resolved)",
        d.rows.length === 2, JSON.stringify(d.rows.map((r) => r.clauseNumber)));
      ok("mixed: unresolved holds the 404 clause 52.999-99",
        d.unresolved.length === 1 && d.unresolved[0].clauseNumber === "52.999-99",
        JSON.stringify(d.unresolved));
      ok("mixed: unresolved does NOT hold the 503 clause 52.777-77",
        !d.unresolved.some((x) => x.clauseNumber === "52.777-77"),
        JSON.stringify(d.unresolved));
      ok("mixed: errored holds the 503 clause 52.777-77",
        d.errored.length === 1 && d.errored[0].clauseNumber === "52.777-77",
        JSON.stringify(d.errored));
      ok("mixed: errored does NOT hold the 404 clause 52.999-99 (SPLIT — a DOWN service is NOT 'not found')",
        !d.errored.some((x) => x.clauseNumber === "52.999-99"),
        JSON.stringify(d.errored));
      ok("mixed: _meta.complete === false (some clause didn't resolve)",
        res.meta.complete === false, JSON.stringify(res.meta.complete));
      // The tool returns a RAW partial (totalAvailable:null); the server finalizes
      // via buildMeta. Prove the AI-VISIBLE result: with totalAvailable null,
      // buildMeta cannot force truncated:true — so failed clauses never read as a
      // cap/pagination (they're disclosed in unresolved/errored instead).
      ok("mixed: raw partial sets totalAvailable:null (a matrix has no upstream match-count)",
        res.meta.totalAvailable === null, JSON.stringify(res.meta.totalAvailable));
      {
        const fm = buildMeta(res.meta);
        ok("mixed: FINAL _meta (buildMeta) truncated:false + complete:false (failed clauses are NOT truncation)",
          fm.truncated === false && fm.complete === false,
          JSON.stringify({ truncated: fm.truncated, complete: fm.complete }));
      }
      ok("mixed: _meta.degraded set (errored non-empty) with failed===1",
        res.meta.degraded && res.meta.degraded.failed === 1 &&
        res.meta.degraded.attempted === 4 && res.meta.degraded.succeeded === 2,
        JSON.stringify(res.meta.degraded));
      ok("mixed: a note DISCLOSES the not-found bucket",
        res.meta.notes.some((n) => /not found in Title 48/i.test(n)),
        JSON.stringify(res.meta.notes));
      ok("mixed: a note DISCLOSES the errored/service bucket (retryable, NOT a confirmation of absence)",
        res.meta.notes.some((n) => /could not be fetched due to a service issue/i.test(n) && /NOT a confirmation/i.test(n)),
        JSON.stringify(res.meta.notes));
      ok("mixed: summary.total === rows + unresolved + errored (no clause dropped)",
        d.summary.total === d.rows.length + d.unresolved.length + d.errored.length &&
        d.summary.total === 4,
        JSON.stringify(d.summary));
      ok("mixed: summary tallies resolved/unresolved/errored + far/dfars",
        d.summary.resolved === 2 && d.summary.unresolved === 1 &&
        d.summary.errored === 1 && d.summary.far === 1 && d.summary.dfars === 1,
        JSON.stringify(d.summary));
    },
  );
  _clearCache();

  // ── (b) GATE TAGGING: 52.204-25 resolved with default flagGates → its row.gate
  // is the Section-889 label; a non-mapped resolved clause (52.212-4) → gate null.
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u)) {
        const s = ecfrSection(u);
        if (s === "52.204-25") return xml(CLAUSE_XML_52_204_25);
        if (s === "52.212-4") return xml(CLAUSE_XML_52_212_4);
      }
      return failClosed()();
    },
    async () => {
      const res = await farComplianceMatrix({
        clauses: ["52.204-25", "52.212-4"],
        includePrescription: false,
      });
      const byNum = Object.fromEntries(res.data.rows.map((r) => [r.clauseNumber, r]));
      ok("gate: 52.204-25 row.gate === the Section-889 label",
        byNum["52.204-25"] &&
        byNum["52.204-25"].gate === "Section 889 — covered-telecom/video-surveillance prohibition (award-eligibility gate)",
        JSON.stringify(byNum["52.204-25"] && byNum["52.204-25"].gate));
      ok("gate: non-mapped 52.212-4 row.gate === null (NEVER a guessed gate)",
        byNum["52.212-4"] && byNum["52.212-4"].gate === null,
        JSON.stringify(byNum["52.212-4"] && byNum["52.212-4"].gate));
      ok("gate: summary.gates === 1 (one gate among the resolved rows)",
        res.data.summary.gates === 1, JSON.stringify(res.data.summary.gates));
    },
  );
  _clearCache();

  // ── (b2) flagGates:false ⇒ ALL rows gate null (even a mapped gate clause).
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u)) {
        const s = ecfrSection(u);
        if (s === "52.204-25") return xml(CLAUSE_XML_52_204_25);
        if (s === "52.212-4") return xml(CLAUSE_XML_52_212_4);
      }
      return failClosed()();
    },
    async () => {
      const res = await farComplianceMatrix({
        clauses: ["52.204-25", "52.212-4"],
        includePrescription: false,
        flagGates: false,
      });
      ok("flagGates:false ⇒ every row.gate === null (incl. the mapped 52.204-25)",
        res.data.rows.length === 2 && res.data.rows.every((r) => r.gate === null),
        JSON.stringify(res.data.rows.map((r) => ({ c: r.clauseNumber, gate: r.gate }))));
      ok("flagGates:false ⇒ summary.gates === 0",
        res.data.summary.gates === 0, JSON.stringify(res.data.summary.gates));
    },
  );
  _clearCache();

  // ── (c) DEDUPE: ["52.212-4","FAR 52.212-4"," 52.212-4 "] → ONE row and exactly
  // ONE clause fetch (the three spellings normalize to the same key). Clear cache
  // first so the `calls` array reflects only THIS case's fetches — making the
  // "one fetch" assertion exact.
  _clearCache();
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u) && ecfrSection(u) === "52.212-4") return xml(CLAUSE_XML_52_212_4);
      return failClosed()();
    },
    async (calls) => {
      const res = await farComplianceMatrix({
        clauses: ["52.212-4", "FAR 52.212-4", " 52.212-4 "],
        includePrescription: false,
      });
      ok("dedupe: rows.length === 1 (three spellings collapse to one clause)",
        res.data.rows.length === 1 && res.data.rows[0].clauseNumber === "52.212-4",
        JSON.stringify(res.data.rows.map((r) => r.clauseNumber)));
      ok("dedupe: summary.total === 1 (deduped input count)",
        res.data.summary.total === 1, JSON.stringify(res.data.summary.total));
      ok("dedupe: exactly ONE clause fetch happened (versioner-full section=52.212-4)",
        calls.filter((c) => isEcfrFull(c.url) && ecfrSection(c.url) === "52.212-4").length === 1,
        JSON.stringify(calls.filter((c) => isEcfrFull(c.url)).map((c) => c.url)));
    },
  );
  _clearCache();

  // ── (d) ALL-RESOLVED HAPPY: two clauses both 200 → unresolved/errored empty,
  // _meta.complete NOT forced false, NO false degraded, summary far/dfars right.
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrFull(u)) {
        const s = ecfrSection(u);
        if (s === "52.212-4") return xml(CLAUSE_XML_52_212_4);
        if (s === "252.204-7012") return xml(CLAUSE_XML_252_204_7012);
      }
      return failClosed()();
    },
    async () => {
      const res = await farComplianceMatrix({
        clauses: ["52.212-4", "252.204-7012"],
        includePrescription: false,
      });
      const d = res.data;
      ok("happy: rows.length === 2, unresolved & errored both empty",
        d.rows.length === 2 && d.unresolved.length === 0 && d.errored.length === 0,
        JSON.stringify({ rows: d.rows.length, unresolved: d.unresolved.length, errored: d.errored.length }));
      ok("happy: _meta.complete NOT forced false (all resolved ⇒ buildMeta derives true)",
        res.meta.complete !== false, JSON.stringify(res.meta.complete));
      ok("happy: _meta.degraded undefined (no outage ⇒ NOT degraded)",
        res.meta.degraded === undefined, JSON.stringify(res.meta.degraded));
      ok("happy: NO false 'service issue'/'not found' note",
        !res.meta.notes.some((n) => /could not be fetched due to a service issue|not found in Title 48/i.test(n)),
        JSON.stringify(res.meta.notes));
      ok("happy: the RFO currency caveat IS surfaced once (resolved rows are FAR/DFARS)",
        res.meta.notes.filter((n) => /RFO caveat/i.test(n)).length === 1,
        JSON.stringify(res.meta.notes));
      ok("happy: summary far===1, dfars===1, gsam===0, other===0, total===2",
        d.summary.far === 1 && d.summary.dfars === 1 && d.summary.gsam === 0 &&
        d.summary.other === 0 && d.summary.total === 2,
        JSON.stringify(d.summary));
    },
  );
  _clearCache(); // leave a clean cache for any later suite.
}

// ══════════════════════════════════════════════════════════════════════════
// 10. far_search — FAR/DFARS-scoped search over ecfr.search (dist/far.js,
//     fetch-mock). Guards the composition's load-bearing behaviors: the chapter
//     scope keeps GSAM/agency supplements OUT (no 552-over-52 leakage); historical
//     versions collapse to the CURRENT one with the raw→distinct count disclosed;
//     a section with only historical rows keeps its latest marked isCurrent:false;
//     partsOnly filters by part; a search-endpoint 503 THROWS (never a fake 0);
//     and the additive ecfr.search change is truly additive (chapterless call
//     still returns the same shape + the new endsOn field).
//
//     eCFR search RAW response shape (what ecfr.search parses):
//       { results: [ { type, hierarchy:{title,chapter,part,section},
//         hierarchy_headings, full_text_excerpt, score, starts_on, ends_on } ],
//         meta: { total_count } }
//     The chapter filter is SERVER-SIDE (a URL param), so a realistic mock
//     returns ONLY the rows for the queried chapter. One case additionally injects
//     a stray chapter-5 row into a chapter-1 response to prove far_search does not
//     itself re-admit a non-FAR section even if the upstream ever leaked one.
// ══════════════════════════════════════════════════════════════════════════
async function testFarSearch() {
  section("10. far_search FAR/DFARS scope + historical dedupe (fetch-mock)");

  const titles = () => mockResponse({ status: 200, json: TITLES_JSON });

  /** Build one raw eCFR search result row. */
  const row = (o = {}) => ({
    type: "SECTION",
    hierarchy: {
      title: "48",
      chapter: String(o.chapter ?? 1),
      part: String(o.part ?? 52),
      section: o.section ?? "52.219-14",
    },
    hierarchy_headings: {
      title: "Federal Acquisition Regulations System",
      section: o.heading ?? "Limitations on Subcontracting",
    },
    full_text_excerpt: o.excerpt ?? "…limitations on subcontracting…",
    score: o.score ?? 1,
    starts_on: o.starts_on ?? "2022-10-28",
    ends_on: o.ends_on ?? null,
  });
  /** A raw search response body (results + a total_count meta). */
  const searchBody = (results, total_count = results.length) =>
    mockResponse({ status: 200, json: { results, meta: { total_count } } });

  // ── (a) SCOPE:FAR — a chapter-1 response that also carries a STRAY chapter-5
  // (GSAM 552.x) row. far_search must return ONLY FAR rows: the chapter filter is
  // in the URL, and far_search itself must not re-admit the GSAM section. (We also
  // assert the URL carried hierarchy[chapter]=1.)
  await withFetch(
    (u, _i, calls) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrSearchResults(u)) {
        calls._chapterParam = ecfrSearchChapter(u);
        return searchBody([
          row({ chapter: 1, part: 52, section: "52.219-14", ends_on: null }),
          row({ chapter: 1, part: 19, section: "19.809-2", ends_on: null,
                heading: "Set-aside procedures", excerpt: "…set-aside…" }),
          // A GSAM leak the filter SHOULD have excluded — far_search must drop it.
          row({ chapter: 5, part: 552, section: "552.219-14", ends_on: null,
                heading: "GSAM subcontracting", excerpt: "…gsam…" }),
        ], 380);
      }
      return failClosed()();
    },
    async (calls) => {
      const res = await farSearch({ query: "limitations on subcontracting", scope: "far" });
      const d = res.data;
      ok("scope:far ⇒ far_search queried hierarchy[chapter]=1 (server-side FAR filter)",
        calls._chapterParam === 1, JSON.stringify(calls._chapterParam));
      ok("scope:far ⇒ EVERY returned row is regulation 'FAR' (no GSAM/agency leakage)",
        d.rows.length > 0 && d.rows.every((r) => r.regulation === "FAR"),
        JSON.stringify(d.rows.map((r) => ({ s: r.section, reg: r.regulation }))));
      ok("scope:far ⇒ the GSAM 552.219-14 row is NOT present (dropped by the scope guard)",
        !d.rows.some((r) => r.section === "552.219-14"),
        JSON.stringify(d.rows.map((r) => r.section)));
      ok("scope:far ⇒ a note DISCLOSES the off-scope drop (defense-in-depth, no leakage)",
        res.meta.notes.some((n) => /outside the requested scope.*dropped by a defense-in-depth chapter check.*ONLY FAR/i.test(n)),
        JSON.stringify(res.meta.notes));
      ok("scope:far ⇒ the two FAR sections ARE present",
        d.rows.some((r) => r.section === "52.219-14") &&
        d.rows.some((r) => r.section === "19.809-2"),
        JSON.stringify(d.rows.map((r) => r.section)));
      ok("scope:far ⇒ data.scope echoed 'far'", d.scope === "far", JSON.stringify(d.scope));
      ok("scope:far ⇒ farOverhaulRisk present, appliesTo 'FAR' (in data, survives buildMeta)",
        d.farOverhaulRisk && d.farOverhaulRisk.appliesTo === "FAR",
        JSON.stringify(d.farOverhaulRisk && d.farOverhaulRisk.appliesTo));
      ok("scope:far ⇒ titleUpToDateAsOf carried in data (2026-07-01)",
        d.titleUpToDateAsOf === "2026-07-01", JSON.stringify(d.titleUpToDateAsOf));
    },
  );

  // ── (b) DEDUPE: one section (52.219-14) appears 3× (ends_on date, date, null) →
  // ONE row, isCurrent:true; distinctSections===1; the collapse note is present.
  // dedupeVersions:false → all 3 rows, no collapse.
  const threeVersions = () => [
    row({ section: "52.219-14", ends_on: "2022-09-22", starts_on: "2021-09-10" }),
    row({ section: "52.219-14", ends_on: "2022-10-27", starts_on: "2022-09-23" }),
    row({ section: "52.219-14", ends_on: null, starts_on: "2022-10-28" }),
  ];
  await withFetch(
    (u) => (isEcfrTitles(u) ? titles() : isEcfrSearchResults(u) ? searchBody(threeVersions(), 3) : failClosed()()),
    async () => {
      const res = await farSearch({ query: "limitations on subcontracting", scope: "far" });
      const d = res.data;
      ok("dedupe(default) ⇒ 3 same-section versions collapse to ONE row",
        d.rows.length === 1 && d.rows[0].section === "52.219-14",
        JSON.stringify(d.rows.map((r) => ({ s: r.section, ends: r.endsOn }))));
      ok("dedupe(default) ⇒ the kept row is the CURRENT one (endsOn null, isCurrent true)",
        d.rows[0].endsOn === null && d.rows[0].isCurrent === true,
        JSON.stringify({ ends: d.rows[0].endsOn, cur: d.rows[0].isCurrent }));
      ok("dedupe(default) ⇒ distinctSections === 1",
        d.distinctSections === 1, JSON.stringify(d.distinctSections));
      ok("dedupe(default) ⇒ a note DISCLOSES the raw→distinct collapse (historical collapsed)",
        res.meta.notes.some((n) => /raw result\(s\).*distinct current section\(s\).*historical versions collapsed/i.test(n)),
        JSON.stringify(res.meta.notes));
      ok("dedupe(default) ⇒ filtersApplied includes 'dedupeVersions'",
        (res.meta.filtersApplied ?? []).includes("dedupeVersions"),
        JSON.stringify(res.meta.filtersApplied));
    },
  );
  await withFetch(
    (u) => (isEcfrTitles(u) ? titles() : isEcfrSearchResults(u) ? searchBody(threeVersions(), 3) : failClosed()()),
    async () => {
      const res = await farSearch({
        query: "limitations on subcontracting",
        scope: "far",
        dedupeVersions: false,
        perPage: 20,
      });
      const d = res.data;
      ok("dedupeVersions:false ⇒ all 3 raw rows returned (no collapse)",
        d.rows.length === 3 && d.rows.every((r) => r.section === "52.219-14"),
        JSON.stringify(d.rows.map((r) => r.endsOn)));
      ok("dedupeVersions:false ⇒ isCurrent honest per row (2 historical false, 1 current true)",
        d.rows.filter((r) => r.isCurrent).length === 1 &&
        d.rows.filter((r) => !r.isCurrent).length === 2,
        JSON.stringify(d.rows.map((r) => ({ ends: r.endsOn, cur: r.isCurrent }))));
      ok("dedupeVersions:false ⇒ NO 'historical versions collapsed' note (nothing collapsed)",
        !res.meta.notes.some((n) => /historical versions collapsed/i.test(n)),
        JSON.stringify(res.meta.notes));
      ok("dedupeVersions:false ⇒ filtersApplied does NOT include 'dedupeVersions'",
        !(res.meta.filtersApplied ?? []).includes("dedupeVersions"),
        JSON.stringify(res.meta.filtersApplied));
    },
  );

  // ── (c) A section with ONLY historical rows (all ends_on != null) → dedupe keeps
  // the LATEST (max starts_on), marked isCurrent:false, and DISCLOSES it.
  await withFetch(
    (u) => (isEcfrTitles(u) ? titles() : isEcfrSearchResults(u) ? searchBody([
      row({ section: "52.222-99", ends_on: "2020-01-01", starts_on: "2019-01-01",
            heading: "Old A", part: 52 }),
      row({ section: "52.222-99", ends_on: "2021-06-30", starts_on: "2020-01-02",
            heading: "Old B (latest historical)", part: 52 }),
    ], 2) : failClosed()()),
    async () => {
      const res = await farSearch({ query: "old clause", scope: "far" });
      const d = res.data;
      ok("hist-only ⇒ ONE row kept for the section (collapsed)",
        d.rows.length === 1 && d.rows[0].section === "52.222-99",
        JSON.stringify(d.rows.map((r) => ({ s: r.section, ends: r.endsOn }))));
      ok("hist-only ⇒ the kept row is the LATEST historical (starts_on 2020-01-02, ends 2021-06-30)",
        d.rows[0].effectiveOn === "2020-01-02" && d.rows[0].endsOn === "2021-06-30",
        JSON.stringify({ eff: d.rows[0].effectiveOn, ends: d.rows[0].endsOn }));
      ok("hist-only ⇒ isCurrent:false (no in-force version in the window)",
        d.rows[0].isCurrent === false, JSON.stringify(d.rows[0].isCurrent));
      ok("hist-only ⇒ a note DISCLOSES the kept-historical row (no current version)",
        res.meta.notes.some((n) => /NO current \(in-force\) version.*isCurrent:false.*52\.222-99/i.test(n)),
        JSON.stringify(res.meta.notes));
    },
  );

  // ── (d) partsOnly:[52] → only part-52 rows survive (a part-19 FAR row is dropped
  // by the client-side part filter, even though it is a legit FAR chapter-1 row).
  await withFetch(
    (u) => (isEcfrTitles(u) ? titles() : isEcfrSearchResults(u) ? searchBody([
      row({ chapter: 1, part: 52, section: "52.219-14", ends_on: null }),
      row({ chapter: 1, part: 19, section: "19.809-2", ends_on: null,
            heading: "Set-aside procedures" }),
      row({ chapter: 1, part: 52, section: "52.219-8", ends_on: null,
            heading: "Utilization of SB concerns" }),
    ], 3) : failClosed()()),
    async () => {
      const res = await farSearch({
        query: "subcontracting",
        scope: "far",
        partsOnly: [52],
      });
      const d = res.data;
      ok("partsOnly:[52] ⇒ EVERY returned row is part 52",
        d.rows.length > 0 && d.rows.every((r) => r.part === 52),
        JSON.stringify(d.rows.map((r) => ({ s: r.section, p: r.part }))));
      ok("partsOnly:[52] ⇒ the part-19 row (19.809-2) is dropped",
        !d.rows.some((r) => r.section === "19.809-2"),
        JSON.stringify(d.rows.map((r) => r.section)));
      ok("partsOnly:[52] ⇒ both part-52 rows present (52.219-14, 52.219-8)",
        d.rows.some((r) => r.section === "52.219-14") &&
        d.rows.some((r) => r.section === "52.219-8"),
        JSON.stringify(d.rows.map((r) => r.section)));
      ok("partsOnly:[52] ⇒ filtersApplied includes 'partsOnly'",
        (res.meta.filtersApplied ?? []).includes("partsOnly"),
        JSON.stringify(res.meta.filtersApplied));
    },
  );

  // ── (e) SEARCH FETCH 503 ⇒ far_search THROWS (upstream_unavailable, retryable) —
  // a DOWN search endpoint must NEVER read as "0 results"/degraded-silent.
  await withFetch(
    (u) => (isEcfrSearchResults(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error, value } = await expectThrow(() =>
        farSearch({ query: "limitations on subcontracting", scope: "far" }));
      ok("search 503 ⇒ THROWS (never a silent empty/0-results view)",
        threw && value === undefined, JSON.stringify({ threw, value }));
      ok("search 503 ⇒ kind upstream_unavailable, retryable:true (classified, propagated)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (f) scope:both → TWO searches (chapter 1 AND chapter 2), rows merged and
  // tagged FAR/DFARS by the chapter each came from.
  await withFetch(
    (u, _i, calls) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrSearchResults(u)) {
        const ch = ecfrSearchChapter(u);
        (calls._chapters ??= []).push(ch);
        if (ch === 1) return searchBody([
          row({ chapter: 1, part: 52, section: "52.204-25", ends_on: null,
                heading: "Prohibition (FAR)" }),
        ], 5);
        if (ch === 2) return searchBody([
          row({ chapter: 2, part: 252, section: "252.204-7012", ends_on: null,
                heading: "Safeguarding CDI (DFARS)" }),
        ], 3);
      }
      return failClosed()();
    },
    async (calls) => {
      const res = await farSearch({ query: "covered defense information", scope: "both", perPage: 10 });
      const d = res.data;
      ok("scope:both ⇒ queried BOTH chapter 1 and chapter 2",
        (calls._chapters ?? []).includes(1) && (calls._chapters ?? []).includes(2),
        JSON.stringify(calls._chapters));
      ok("scope:both ⇒ the FAR row is tagged regulation 'FAR'",
        d.rows.some((r) => r.section === "52.204-25" && r.regulation === "FAR"),
        JSON.stringify(d.rows.map((r) => ({ s: r.section, reg: r.regulation }))));
      ok("scope:both ⇒ the DFARS row is tagged regulation 'DFARS'",
        d.rows.some((r) => r.section === "252.204-7012" && r.regulation === "DFARS"),
        JSON.stringify(d.rows.map((r) => ({ s: r.section, reg: r.regulation }))));
    },
  );

  // ── (g) ADDITIVE-ecfr.search PROOF: a DIRECT ecfr.search({query,titleNumber:48})
  // with NO chapter still returns the same shape AND now carries the new endsOn
  // field (additive). The chapterless call must NOT put hierarchy[chapter] in the URL.
  await withFetch(
    (u, _i, calls) => {
      if (isEcfrSearchResults(u)) {
        calls._hadChapterParam = /hierarchy(?:%5B|\[)chapter/.test(u);
        return searchBody([
          row({ chapter: 1, part: 52, section: "52.212-4", ends_on: null, starts_on: "2023-11-01" }),
        ], 42);
      }
      return failClosed()();
    },
    async (calls) => {
      const res = await ecfrSearch({ query: "commercial items", titleNumber: 48 });
      const r0 = res.data.results[0];
      ok("ecfr.search(no chapter) ⇒ URL carries NO hierarchy[chapter] (unchanged behavior)",
        calls._hadChapterParam === false, JSON.stringify(calls._hadChapterParam));
      ok("ecfr.search(no chapter) ⇒ same mapped shape (section/effectiveOn/score present)",
        r0 && r0.section === "52.212-4" && r0.effectiveOn === "2023-11-01" &&
        typeof r0.score === "number",
        JSON.stringify(r0 && { section: r0.section, eff: r0.effectiveOn }));
      ok("ecfr.search(no chapter) ⇒ NEW additive field endsOn present (null = current)",
        r0 && "endsOn" in r0 && r0.endsOn === null,
        JSON.stringify(r0 && { endsOn: r0.endsOn }));
      ok("ecfr.search(no chapter) ⇒ _meta.totalAvailable is the real upstream count (42, unchanged)",
        res.meta.totalAvailable === 42, JSON.stringify(res.meta.totalAvailable));
    },
  );
  // ── (g) SECTION-LESS APPENDIX dedup (the review-caught BLOCK): eCFR returns
  // chapter/part-level APPENDIX hits with NO hierarchy.section. Keyed on `section`
  // alone they'd all collide on "" → distinct appendices SILENTLY dropped +
  // distinctSections corrupted. far_search must key a section-less row on its
  // (distinct) headingPath, so every DISTINCT appendix survives while the SAME
  // appendix's own historical+current versions still collapse.
  const appx = (heading, o = {}) => ({
    type: "APPENDIX",
    hierarchy: { title: "48", chapter: "2" }, // NO section, NO part (chapter-level)
    hierarchy_headings: { title: "DFARS", appendix: heading },
    full_text_excerpt: "…appendix text…",
    score: o.score ?? 1,
    starts_on: o.starts_on ?? "2020-01-01",
    ends_on: o.ends_on ?? null,
  });
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return titles();
      if (isEcfrSearchResults(u))
        return searchBody([
          appx("Appendix A to Chapter 2", { ends_on: "2019-12-31" }), // historical only
          appx("Appendix G to Chapter 2", { ends_on: "2018-01-01", starts_on: "2015-01-01" }), // G historical
          appx("Appendix G to Chapter 2", { ends_on: null, starts_on: "2020-01-01" }), // G current
          appx("Appendix H to Chapter 2", { ends_on: null }), // current
          appx("Appendix I to Chapter 2", { ends_on: null }), // current
        ]);
      return failClosed()();
    },
    async () => {
      const res = await farSearch({ query: "appendix", scope: "dfars", perPage: 20 });
      const d = res.data;
      const heads = d.rows.map((r) => r.headingPath);
      ok("appendix: 4 DISTINCT section-less appendices survive (no '' collision, none dropped)",
        d.rows.length === 4 &&
          ["Appendix A", "Appendix G", "Appendix H", "Appendix I"].every((a) =>
            heads.some((h) => h.includes(a))),
        JSON.stringify(heads));
      ok("appendix: distinctSections === 4 (counted on the fallback key, not the empty section)",
        d.distinctSections === 4, JSON.stringify(d.distinctSections));
      ok("appendix: Appendix G's two versions collapsed to its CURRENT one (isCurrent true, endsOn null)",
        (() => { const g = d.rows.find((r) => r.headingPath.includes("Appendix G")); return !!g && g.isCurrent === true && g.endsOn === null; })(),
        JSON.stringify(d.rows.find((r) => r.headingPath.includes("Appendix G"))));
      ok("appendix: Appendix A (historical-only) kept isCurrent:false AND disclosed in a note",
        (() => { const a = d.rows.find((r) => r.headingPath.includes("Appendix A")); return !!a && a.isCurrent === false; })() &&
          res.meta.notes.some((n) => /NO current \(in-force\) version/i.test(n)),
        JSON.stringify({ notes: res.meta.notes }));
    },
  );

  _clearCache(); // leave a clean cache for any later suite.
}

// ─── Meta-test: the harness FAILS LOUDLY when a guarded behavior breaks ────
// Proves the assertions are real (not vacuously green). We re-run the D2
// invariant against a DELIBERATELY-WRONG expectation and confirm it would fail;
// this is done via a scoped counter so it does not affect the suite tally.
async function selfCheck() {
  section("self-check: assertions are non-vacuous (a broken guarantee WOULD fail)");
  // Temporarily divert the global counters.
  const savedPass = PASS, savedFail = FAIL, savedFailures = FAILURES.slice();
  PASS = 0; FAIL = 0; FAILURES.length = 0;

  // Force transactions to SUCCEED but assert (wrongly) that modCount is null.
  await withFetch(
    (u) => {
      if (isAwardsDetail(u)) return mockResponse({ status: 200, json: awardDetailBody() });
      if (isTransactions(u)) {
        return mockResponse({ status: 200, json: { results: [{}, {}], page_metadata: { hasNext: false } } });
      }
      if (isSpendingByAward(u)) return mockResponse({ status: 200, json: { results: [], page_metadata: { hasNext: false } } });
      if (isSpendingByAwardCount(u)) return mockResponse({ status: 200, json: { results: { contracts: 0 } } });
      return failClosed()();
    },
    async () => {
      const res = await analyzeIncumbent({ generatedInternalId: "SELFCHK" });
      // This assertion is intentionally WRONG (modCount is 2, not null).
      ok("[intentional-wrong] modCount claimed null when it is actually 2", res.data.signals.modCount === null);
    },
  );

  const sawExpectedFailure = FAIL === 1;
  // Restore real counters.
  PASS = savedPass; FAIL = savedFail; FAILURES.length = 0;
  FAILURES.push(...savedFailures);

  ok("self-check: a deliberately-false assertion DID fail (harness is not vacuous)",
    sawExpectedFailure,
    `expected exactly 1 intentional failure, saw ${sawExpectedFailure ? 1 : "≠1"}`);
}

// ══════════════════════════════════════════════════════════════════════════
// 6. sba_size_standard classification + not-found (fetch-mock; one cached fetch)
// ══════════════════════════════════════════════════════════════════════════
async function testSbaSizeStandard() {
  section("6. sba_size_standard classification + not-found (fetch-mock)");
  // One crafted naics.json covering all three standard types + an absent id.
  // sizeStandard caches the array (5-min reference cache), so a SINGLE fetch
  // serves every lookup below — deterministic, no cross-case cache interference.
  const NAICS = [
    { id: "541512", description: "Computer Systems Design Services", sectorDescription: "P", subsectorDescription: "P", revenueLimit: 34, assetLimit: null, employeeCountLimit: null, footnote: null },
    { id: "336411", description: "Aircraft Manufacturing", sectorDescription: "M", subsectorDescription: "M", revenueLimit: null, assetLimit: null, employeeCountLimit: 1500, footnote: null },
    { id: "522110", description: "Commercial Banking", sectorDescription: "F", subsectorDescription: "F", revenueLimit: null, assetLimit: 850, employeeCountLimit: null, footnote: null },
  ];
  await withFetch(
    (u) => (u.includes("naics.json") ? mockResponse({ status: 200, json: NAICS }) : failClosed()()),
    async () => {
      const receiptsRes = await sizeStandard({ naics: "541512" });
      const receipts = receiptsRes.data;
      ok("receipts NAICS ⇒ type receipts, threshold $34M (×1e6), unit receipts",
        receipts.standardType === "receipts" && receipts.threshold === 34_000_000 &&
        receipts.unit === "USD annual receipts" && receipts.revenueLimitUSD === 34_000_000,
        JSON.stringify(receipts));
      // LEAD-12: a found single-NAICS lookup is a COMPLETE exact answer, never a
      // truncated slice of the ~978-row dataset. Assert the DERIVED _meta the agent
      // sees (buildMeta, exactly as server.ts finalizes it) — the mock has count=3,
      // so sourcing totalAvailable from the dataset size would force truncation.
      const rMeta = buildMeta(receiptsRes.meta);
      ok("6 LEAD-12 found:true single lookup ⇒ complete=true & truncated=false (NOT mislabeled as truncated)",
        rMeta.complete === true && rMeta.truncated === false,
        JSON.stringify({ complete: rMeta.complete, truncated: rMeta.truncated }));
      ok("6 LEAD-12 found:true ⇒ totalAvailable=1 (the one matching standard) & returned=1 — NOT the dataset row count",
        rMeta.totalAvailable === 1 && rMeta.returned === 1,
        JSON.stringify({ totalAvailable: rMeta.totalAvailable, returned: rMeta.returned }));
      const emp = (await sizeStandard({ naics: "336411" })).data;
      ok("employee NAICS ⇒ type employees, threshold 1500 (NOT ×1e6), unit employees",
        emp.standardType === "employees" && emp.threshold === 1500 && emp.unit === "employees",
        JSON.stringify(emp));
      // The assets-only fix: MUST be "assets", never "receipts+assets" (there is
      // no receipts prong on a financial asset standard).
      const assets = (await sizeStandard({ naics: "522110" })).data;
      ok("assets-only NAICS ⇒ type 'assets' (never 'receipts+assets'), unit USD assets, revenueLimitUSD null",
        assets.standardType === "assets" && assets.unit === "USD assets" &&
        assets.revenueLimitUSD === null && assets.assetLimitUSD === 850_000_000,
        JSON.stringify(assets));
      const missingRes = await sizeStandard({ naics: "999999" });
      const missing = missingRes.data;
      ok("unknown NAICS ⇒ found:false, no fabricated standard",
        missing.found === false && missing.threshold === null && missing.standardType === "unknown",
        JSON.stringify(missing));
      // LEAD-12: a definitive not-found is COMPLETE and NOT truncated — the machine
      // flags must not tell the agent to paginate for records that do not exist.
      const mMeta = buildMeta(missingRes.meta);
      ok("6 LEAD-12 found:false definitive not-found ⇒ complete=true & truncated=false (never 'paginate for more')",
        mMeta.complete === true && mMeta.truncated === false,
        JSON.stringify({ complete: mMeta.complete, truncated: mMeta.truncated }));
      ok("6 LEAD-12 found:false ⇒ totalAvailable=0 & returned=0 (zero match this NAICS, NOT the dataset row count)",
        mMeta.totalAvailable === 0 && mMeta.returned === 0,
        JSON.stringify({ totalAvailable: mMeta.totalAvailable, returned: mMeta.returned }));
    },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 7. Shaping radar pure helpers — daysUntilResponse + client-side deadline
//    window (dist/sam-gov/index.js, pure). These back sam_search_shaping's two
//    trickiest honesty guarantees: a null-safe whole-day countdown (a deadline-
//    less notice is COUNTED as null, never hidden/zeroed) and the client-side
//    response-deadline window (the keyless feed IGNORES rdlfrom/rdlto, so the
//    window is applied over the fetched page and disclosed).
// ══════════════════════════════════════════════════════════════════════════
function testShapingHelpers() {
  section("7. shaping radar: daysUntilResponse + client-side deadline window (pure)");

  // Fixed "now" so the whole-day math is deterministic regardless of run time.
  const NOW = new Date("2026-07-03T12:00:00Z");

  // 7a. Future deadline ⇒ positive whole-day count (UTC-midnight floored on
  // both ends, so intraday time-of-day never shifts the count).
  eq("future deadline (2026-07-09) ⇒ 6 whole days",
    daysUntilResponse("2026-07-09T21:00:00+00:00", NOW), 6);

  // 7b. Same calendar day ⇒ 0 (not negative, not null).
  eq("same-day deadline ⇒ 0 days",
    daysUntilResponse("2026-07-03T23:59:00Z", NOW), 0);

  // 7c. Past deadline ⇒ negative (surfaced, not clamped to 0).
  eq("past deadline (2026-07-01) ⇒ -2 days",
    daysUntilResponse("2026-07-01T00:00:00Z", NOW), -2);

  // 7d. Missing / null / unparseable deadline ⇒ null (COUNTED as null, never a
  // fabricated 0 — the radar surfaces deadline-less notices honestly).
  eq("null deadline ⇒ null (not 0)", daysUntilResponse(null, NOW), null);
  eq("undefined deadline ⇒ null", daysUntilResponse(undefined, NOW), null);
  eq("empty-string deadline ⇒ null", daysUntilResponse("", NOW), null);
  eq("garbage deadline ⇒ null (never NaN/0)",
    daysUntilResponse("not-a-date", NOW), null);

  // 7e. No window bounds ⇒ the page is returned UNCHANGED (identity — no window
  // was requested, so nothing is trimmed).
  {
    const page = [
      { noticeId: "A", responseDeadline: "2026-08-01T00:00:00Z" },
      { noticeId: "B", responseDeadline: null },
    ];
    const out = applyResponseDeadlineWindow(page, undefined, undefined);
    eq("no window bounds ⇒ page returned unchanged (identity)",
      out.map((n) => n.noticeId), ["A", "B"]);
  }

  // 7f. A [from,to] window keeps ONLY in-window notices (inclusive bounds) and
  // EXCLUDES a deadline-less notice (it cannot be proven inside the window).
  {
    const page = [
      { noticeId: "BEFORE", responseDeadline: "2026-06-15T00:00:00Z" }, // < from
      { noticeId: "IN1", responseDeadline: "2026-07-10T00:00:00Z" },    // in
      { noticeId: "IN2", responseDeadline: "2026-07-31T23:59:59Z" },    // in (edge)
      { noticeId: "AFTER", responseDeadline: "2026-08-05T00:00:00Z" },  // > to
      { noticeId: "NODATE", responseDeadline: null },                   // excluded
    ];
    const out = applyResponseDeadlineWindow(page, "2026-07-01", "2026-07-31T23:59:59Z");
    eq("window keeps only in-window notices; deadline-less excluded",
      out.map((n) => n.noticeId), ["IN1", "IN2"]);
  }

  // 7g. A one-sided FROM-only window keeps everything on/after `from` and still
  // drops the deadline-less notice.
  {
    const page = [
      { noticeId: "OLD", responseDeadline: "2026-06-01T00:00:00Z" },
      { noticeId: "NEW", responseDeadline: "2026-09-01T00:00:00Z" },
      { noticeId: "NODATE", responseDeadline: null },
    ];
    const out = applyResponseDeadlineWindow(page, "2026-07-01", undefined);
    eq("from-only window keeps on/after from, drops the deadline-less notice",
      out.map((n) => n.noticeId), ["NEW"]);
  }

  // 7h. A one-sided TO-only window keeps everything on/before `to`.
  {
    const page = [
      { noticeId: "EARLY", responseDeadline: "2026-07-05T00:00:00Z" },
      { noticeId: "LATE", responseDeadline: "2026-12-01T00:00:00Z" },
      { noticeId: "NODATE", responseDeadline: null },
    ];
    const out = applyResponseDeadlineWindow(page, undefined, "2026-07-31T23:59:59Z");
    eq("to-only window keeps on/before to, drops the deadline-less notice",
      out.map((n) => n.noticeId), ["EARLY"]);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 9. searchOpportunities OUTAGE-vs-GENUINE-ZERO honesty (C19) — the core
//    SAM discovery path (dist/sam-gov/index.js SamGovClient, fetch-mock).
//
//    The defect: the old three-tier fallback conflated a TOTAL OUTAGE
//    (searchPublic THREW — HAL down / 5xx-after-retry) with a GENUINE zero
//    (query matched nothing) — BOTH returned { totalRecords:0,
//    opportunitiesData:[] }, so the tool `_meta` derived `complete:true,
//    totalAvailable:0` and an AI read "0 matching notices, complete" when SAM
//    was DOWN. The fix marks a real outage with `.degraded` so the two exits
//    are distinguishable at the source; a genuine 0 (and a real totalRecords>0
//    empty page) is returned AS-IS with NO `.degraded`.
//
//    We drive the REAL SamGovClient (keyless — no apiKey → only the public
//    tier runs) over the mocked SGS HAL URL. The mock body mirrors what
//    searchPublic actually reads: `page.totalElements` + `_embedded.results[]`
//    (each { _id, title, type, publishDate, responseDate, isActive, … }).
//    server.ts's runTool is not exported (importing it spawns an MCP server on
//    stdio), so the tool `_meta` honesty is verified by running the wrapper's
//    EXACT degraded-vs-healthy mapping through the REAL buildMeta from
//    dist/meta.js — proving both that `.degraded` is the branch signal and that
//    the resulting `_meta` is honest (outage ⇒ complete:false/totalAvailable
//    null + note; genuine zero ⇒ complete:true/totalAvailable:0, no false note).
// ══════════════════════════════════════════════════════════════════════════
async function testSearchOutageHonesty() {
  section("9. searchOpportunities outage-vs-genuine-zero honesty (fetch-mock)");

  // A keyless client: no apiKey ⇒ the auth tier is skipped and ONLY the public
  // (SGS HAL) tier runs, so the mocked SGS URL drives the whole search.
  const client = () => new SamGovClient({ fetch: globalThis.fetch });

  // An SGS HAL page in searchPublic's read shape: page.totalElements +
  // _embedded.results[]. Each result carries the exact keys searchPublic maps.
  const sgsPage = (results, totalElements = results.length) =>
    mockResponse({
      status: 200,
      json: { page: { totalElements }, _embedded: { results } },
    });
  const oppRow = (id, title = "A Notice") => ({
    _id: id,
    title,
    solicitationNumber: "SOL-1",
    organizationHierarchy: [{ name: "DoD", level: 1 }],
    type: { code: "o", value: "Solicitation" },
    publishDate: "2026-07-01",
    responseDate: "2026-08-01T17:00:00-04:00",
    isActive: true,
  });

  // Drive the REAL server wrapper: call runTool("sam_search_opportunities", …)
  // over the SAME mocked SGS HAL, then finalize its returned MetaBundle through
  // the REAL buildMeta exactly as the CallTool handler does (`buildMeta(raw.meta)`).
  // This replaces the former inline `metaForSearch` copy — the outage-vs-zero
  // mapping under test is now the SHIPPED wrapper code, so a regression edited
  // into server.ts's degraded/genuine-zero branch turns these assertions RED.
  // A keyless client is built INSIDE withFetch (so its captured fetchImpl is the
  // patched mock) and passed straight into runTool.
  const metaForSearch = (bundle) => buildMeta(bundle.meta);
  const runSearch = (args, sam) => runTool("sam_search_opportunities", args, sam);

  // ── (a) TOTAL OUTAGE: the SGS search URL 503s on every attempt ⇒ the result
  // carries `.degraded` and is an empty 0 — but a DISTINGUISHABLE one.
  await withFetch(
    (u) => (isSgs(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const sam = new SamGovClient({});
      const r = await client().searchOpportunities({ query: "widgets" });
      ok("outage (SGS 503) ⇒ result.degraded set with a reason",
        r.degraded && typeof r.degraded.reason === "string" &&
        r.degraded.reason.length > 0,
        JSON.stringify(r.degraded));
      ok("outage ⇒ totalRecords 0 AND opportunitiesData empty (the empty shape…)",
        r.totalRecords === 0 && r.opportunitiesData.length === 0,
        JSON.stringify({ t: r.totalRecords, n: r.opportunitiesData.length }));
      // …but the REAL wrapper's tool `_meta` must NOT read as a confirmed zero.
      const bundle = await runSearch({ query: "widgets" }, sam);
      ok("outage ⇒ real wrapper returns null data count (totalRecords null, returned 0)",
        bundle.data.totalRecords === null && bundle.data.returned === 0 &&
        bundle.data.opportunities.length === 0,
        JSON.stringify(bundle.data));
      const m = metaForSearch(bundle);
      ok("outage ⇒ _meta.complete === false (NOT 'complete' over an outage)",
        m.complete === false, JSON.stringify(m.complete));
      ok("outage ⇒ _meta.totalAvailable === null (we do NOT know the count — never 0)",
        m.totalAvailable === null, JSON.stringify(m.totalAvailable));
      ok("outage ⇒ a note DISCLOSES it is a service outage, not a confirmed zero",
        m.notes.some((n) => /service outage, not a confirmed zero/i.test(n)),
        JSON.stringify(m.notes));
    },
  );

  // ── (b) NETWORK FAULT (fetch itself rejects) on the SGS URL ⇒ same degraded
  // outage marker (a thrown transport error is an outage, not a zero).
  await withFetch(
    (u) => {
      if (isSgs(u)) throw new Error("ECONNRESET");
      return failClosed()();
    },
    async () => {
      const r = await client().searchOpportunities({ query: "widgets" });
      ok("network fault ⇒ result.degraded set (transport throw is an outage)",
        !!r.degraded && r.opportunitiesData.length === 0 && r.totalRecords === 0,
        JSON.stringify(r.degraded));
    },
  );

  // ── (c) GENUINE ZERO: the source is HEALTHY (200) and honestly reports zero
  // matches (page.totalElements === 0, empty embedded list) ⇒ NO `.degraded`,
  // totalRecords 0, and the `_meta` STILL reads complete:true/totalAvailable:0
  // with NO false degradation note (no crying wolf).
  await withFetch(
    (u) => (isSgs(u) ? sgsPage([], 0) : failClosed()()),
    async () => {
      const sam = new SamGovClient({});
      const r = await client().searchOpportunities({ query: "nomatchxyz" });
      ok("genuine zero ⇒ NO .degraded marker (healthy source, real 0)",
        r.degraded === undefined, JSON.stringify(r.degraded));
      ok("genuine zero ⇒ totalRecords === 0, opportunitiesData empty",
        r.totalRecords === 0 && r.opportunitiesData.length === 0,
        JSON.stringify({ t: r.totalRecords, n: r.opportunitiesData.length }));
      const bundle = await runSearch({ query: "nomatchxyz" }, sam);
      ok("genuine zero ⇒ real wrapper data: totalRecords 0, returned 0 (a real count, not null)",
        bundle.data.totalRecords === 0 && bundle.data.returned === 0,
        JSON.stringify(bundle.data));
      const m = metaForSearch(bundle);
      ok("genuine zero ⇒ _meta.complete === true (a real, complete zero)",
        m.complete === true, JSON.stringify(m.complete));
      ok("genuine zero ⇒ _meta.totalAvailable === 0 (the true count, asserted)",
        m.totalAvailable === 0, JSON.stringify(m.totalAvailable));
      ok("genuine zero ⇒ NO false 'service outage' note (no crying wolf)",
        !m.notes.some((n) => /service outage/i.test(n)),
        JSON.stringify(m.notes));
    },
  );

  // ── (d) PARTIAL PAGE: a healthy 200 reports totalElements=5 but THIS page is
  // empty (paging past the end / a lagging embed) ⇒ the result KEEPS
  // totalRecords 5 (NOT replaced by a hardcoded 0), and NO `.degraded`. The old
  // `if (opportunitiesData.length > 0)` gate would have discarded this and
  // mislabeled it totalRecords:0.
  await withFetch(
    (u) => (isSgs(u) ? sgsPage([], 5) : failClosed()()),
    async () => {
      const sam = new SamGovClient({});
      const r = await client().searchOpportunities({ query: "widgets", offset: 100 });
      ok("partial page ⇒ totalRecords stays 5 (NOT replaced by 0)",
        r.totalRecords === 5, JSON.stringify(r.totalRecords));
      ok("partial page ⇒ this page is empty (0 rows) but that is honest, not degraded",
        r.opportunitiesData.length === 0 && r.degraded === undefined,
        JSON.stringify({ n: r.opportunitiesData.length, d: r.degraded }));
      const bundle = await runSearch({ query: "widgets", offset: 100 }, sam);
      const m = metaForSearch(bundle);
      ok("partial page ⇒ _meta.totalAvailable === 5 AND truncated (5 > 0 returned)",
        m.totalAvailable === 5 && m.truncated === true && m.complete === false,
        JSON.stringify({ ta: m.totalAvailable, tr: m.truncated, c: m.complete }));
    },
  );

  // ── (e) HEALTHY NON-EMPTY: a normal page with rows ⇒ returned AS-IS, NO
  // `.degraded`, totalRecords honored, rows mapped (sanity: the happy path is
  // byte-unchanged by the fix).
  await withFetch(
    (u) => (isSgs(u) ? sgsPage([oppRow("N1"), oppRow("N2")], 2) : failClosed()()),
    async () => {
      const sam = new SamGovClient({});
      const r = await client().searchOpportunities({ query: "widgets" });
      ok("healthy non-empty ⇒ NO .degraded, totalRecords 2, 2 rows mapped",
        r.degraded === undefined && r.totalRecords === 2 &&
        r.opportunitiesData.length === 2 && r.opportunitiesData[0].noticeId === "N1",
        JSON.stringify({ d: r.degraded, t: r.totalRecords, n: r.opportunitiesData.length }));
      const bundle = await runSearch({ query: "widgets" }, sam);
      ok("healthy non-empty ⇒ real wrapper maps 2 rows (noticeId carried through)",
        bundle.data.returned === 2 && bundle.data.opportunities.length === 2 &&
        bundle.data.opportunities[0].noticeId === "N1",
        JSON.stringify({ n: bundle.data.returned, first: bundle.data.opportunities[0]?.noticeId }));
      const m = metaForSearch(bundle);
      ok("healthy non-empty ⇒ _meta.complete true, totalAvailable 2 (no false degrade)",
        m.complete === true && m.totalAvailable === 2 &&
        !m.notes.some((n) => /service outage/i.test(n)),
        JSON.stringify({ c: m.complete, ta: m.totalAvailable }));
    },
  );

  // ── (f) HOLLOW 200 (the CloudFront→istio-envoy residual the review caught):
  // a 200 with VALID JSON but NO usable page.totalElements is NOT a genuine
  // zero — it's a cached/degraded error envelope. searchPublic now THROWS on a
  // non-finite totalElements, so each of these yields `.degraded` (outage), not
  // a fake "0 notices, complete". Contrast: a genuine {page:{totalElements:0}}
  // (case c) has a finite 0 and stays non-degraded — the discriminator.
  for (const [label, body] of [
    ['{"message":"Access Denied"} (no page block)', { message: "Access Denied", ref: "x" }],
    ["{} (empty object)", {}],
    ["page dropped by proxy", { _embedded: { results: [] } }],
    ["page present but totalElements dropped", { page: {}, _embedded: { results: [] } }],
  ]) {
    await withFetch(
      (u) => (isSgs(u) ? mockResponse({ status: 200, json: body }) : failClosed()()),
      async () => {
        const sam = new SamGovClient({});
        const r = await client().searchOpportunities({ query: "widgets" });
        ok(`hollow-200 (${label}) ⇒ result.degraded set (NOT a fake genuine-zero)`,
          !!r.degraded && r.totalRecords === 0 && r.opportunitiesData.length === 0,
          JSON.stringify({ degraded: r.degraded }));
        const bundle = await runSearch({ query: "widgets" }, sam);
        const m = metaForSearch(bundle);
        ok(`hollow-200 (${label}) ⇒ real wrapper: totalRecords null + complete:false + totalAvailable:null + outage note`,
          bundle.data.totalRecords === null && m.complete === false &&
          m.totalAvailable === null &&
          m.notes.some((n) => /service outage, not a confirmed zero/i.test(n)),
          JSON.stringify({ tr: bundle.data.totalRecords, c: m.complete, ta: m.totalAvailable }));
      },
    );
  }
}

// ══════════════════════════════════════════════════════════════════════════
// 10. getOpportunity / fetchOpportunityDescription OUTAGE-vs-ABSENT honesty
//     (C21) — the SAM DETAIL path (dist/sam-gov/index.js SamGovClient, fetch-
//     mock). Sibling of #9 (which covers SEARCH): #9 fixed DOWN-reads-as-zero
//     on the list endpoint; this fixes DOWN-reads-as-not-found on the detail
//     endpoint.
//
//     The defect: getOpportunityPublic collapsed EVERY non-ok status AND a
//     hollow 200 (no data2.title) to null, and getOpportunity re-swallowed any
//     outage throw to null; fetchOpportunityDescription swallowed a DOWN fetch
//     into "Description not available." The wrapper maps null → { found:false },
//     so an AI read "this notice does not exist" when SAM was DOWN.
//
//     LIVE-GROUNDED mapping (2026-07-04, re-verified this session): a real
//     32-hex id → 200 + data2.title; a malformed/absent id → 401 (stable, never
//     404/200-empty). So 401/404 → null (genuine absent → found:false); every
//     other non-2xx / network / hollow-200 → THROW upstream_unavailable
//     (retryable). We drive the REAL keyless SamGovClient over the mocked detail
//     URL; the enrichment sub-calls (resources / org) are given benign 200s so
//     their best-effort swallow (out of scope) does not muddy the assertions.
// ══════════════════════════════════════════════════════════════════════════
async function testGetOpportunityDetailHonesty() {
  section("10. getOpportunity / description outage-vs-absent honesty (fetch-mock)");

  // Keyless ⇒ auth tier skipped; ONLY the public detail tier runs.
  const client = () => new SamGovClient({ fetch: globalThis.fetch });

  // URL classifiers for the detail surface (from getOpportunityPublic).
  const isDetail = (u) => /\/opps\/v2\/opportunities\/[^/]+($|\?)/.test(u);
  const isResources = (u) => /\/opps\/v3\/opportunities\/[^/]+\/resources/.test(u);
  const isOrg = (u) => /\/federalorganizations\/v1\/organizations\//.test(u);

  // A detail body in getOpportunityPublic's EXACT read shape:
  // { data2: { title, … }, description: [{ body }] }.
  const detailBody = (over = {}) => ({
    data2: {
      title: "SAMPLE NOTICE TITLE",
      type: "Solicitation",
      organizationId: "ORG123",
      solicitationNumber: "SOL-9",
      postedDate: "2026-07-01",
      solicitation: { setAside: "SBA", deadlines: { response: "2026-08-01T17:00:00-04:00" } },
      naics: [{ code: ["541512"] }],
      ...over,
    },
    description: [{ body: "The full RFP body text." }],
  });
  // Benign enrichment responses so the out-of-scope sub-calls never throw.
  const resourcesOk = () =>
    mockResponse({ status: 200, json: { _embedded: { opportunityAttachmentList: [{ attachments: [] }] } } });
  const orgOk = () =>
    mockResponse({ status: 200, json: { _embedded: [{ org: { fullParentPathName: "DOD.ARMY" } }] } });

  // A detail handler: `detail(url)` decides the detail-endpoint response; the
  // enrichment URLs always resolve benignly.
  const detailHandler = (detail) => (u) => {
    if (isResources(u)) return resourcesOk();
    if (isOrg(u)) return orgOk();
    if (isDetail(u)) return detail(u);
    return failClosed()();
  };

  const REALID = "686796f3919a49f598fcc1493fe81f0a";

  // ── (a) 200 + data2.title ⇒ getOpportunity returns the notice (found).
  await withFetch(
    detailHandler(() => mockResponse({ status: 200, json: detailBody() })),
    async () => {
      const o = await client().getOpportunity(REALID);
      ok("200 + data2.title ⇒ returns an object (found)",
        o && o.noticeId === REALID && o.title === "SAMPLE NOTICE TITLE",
        JSON.stringify(o && { id: o.noticeId, title: o.title }));
      ok("200 ⇒ mapped fields carried (naics/setAside/deadline/description)",
        o && o.naicsCode === "541512" && o.typeOfSetAside === "SBA" &&
        o.responseDeadLine === "2026-08-01T17:00:00-04:00" &&
        o.description === "The full RFP body text.",
        JSON.stringify(o && { naics: o.naicsCode, sa: o.typeOfSetAside }));
    },
  );

  // ── (b) 401 ⇒ null (genuine not-found — the live-grounded "absent" signal for
  // most bogus/malformed ids: UNAUTHORIZED "Error occured while get...").
  await withFetch(
    detailHandler(() => mockResponse({ status: 401 })),
    async () => {
      const o = await client().getOpportunity("00000000000000000000000000000000");
      ok("401 ⇒ null (genuine absent, NOT a thrown outage)", o === null,
        `returned ${JSON.stringify(o)}`);
    },
  );

  // ── (c) 404 ⇒ null (also genuine not-found).
  await withFetch(
    detailHandler(() => mockResponse({ status: 404 })),
    async () => {
      const o = await client().getOpportunity(REALID);
      ok("404 ⇒ null (genuine absent, NOT a thrown outage)", o === null,
        `returned ${JSON.stringify(o)}`);
    },
  );

  // ── (c2) 400 ⇒ null (RE-GROUNDED live 2026-07-04: some bogus 32-hex ids get a
  // STABLE 400 BAD_REQUEST "Invalid request data" — the endpoint CLIENT-REJECTS
  // the id, semantically identical to 401/404 here. A 4xx is "not a retrievable
  // notice" = absent, NOT an outage. This is the exact id the live edge-case
  // suite exercises; mapping it to a retryable throw would cry wolf.)
  await withFetch(
    detailHandler(() => mockResponse({ status: 400 })),
    async () => {
      const o = await client().getOpportunity("0000000000000000000000000000abcd");
      ok("400 ⇒ null (client-rejected id = absent, NOT a thrown outage)", o === null,
        `returned ${JSON.stringify(o)}`);
    },
  );

  // ── (c3) 429 ⇒ THROWS rate_limited (the ONE 4xx that is NOT an absence — a
  // retryable throttle. Must NOT collapse to null/found:false, else a
  // rate-limited id reads as "does not exist").
  await withFetch(
    detailHandler(() => mockResponse({ status: 429 })),
    async () => {
      const { threw, error } = await expectThrow(() => client().getOpportunity(REALID));
      ok("429 ⇒ throws rate_limited retryable (NOT null / found:false)",
        threw && error?.toolError?.kind === "rate_limited" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (c4) 403 ⇒ THROWS upstream_unavailable (NOT null). The endpoint's live
  // absent vocabulary is strictly {400,401,404}; 403 was NEVER emitted, so a 403
  // is a CDN/WAF block = an OUTAGE, not an absence. Mapping it to null would let a
  // WAF-blocked notice read as found:false (a DOWN-reads-as-absent lie). Only the
  // three confirmed absent statuses null; every other non-2xx (incl. 403) throws.
  await withFetch(
    detailHandler(() => mockResponse({ status: 403 })),
    async () => {
      const { threw, error } = await expectThrow(() => client().getOpportunity(REALID));
      ok("403 ⇒ throws upstream_unavailable (NOT null — a WAF/CDN block is an outage, not an absence)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (d) 503 ⇒ THROWS upstream_unavailable (retryable), NOT null. A DOWN
  // service must never read as found:false.
  await withFetch(
    detailHandler(() => mockResponse({ status: 503 })),
    async () => {
      const { threw, error } = await expectThrow(() => client().getOpportunity(REALID));
      ok("503 ⇒ throws (never a silent null)", threw,
        `threw=${threw}`);
      ok("503 ⇒ kind:upstream_unavailable, retryable:true (classified outage)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (e) NETWORK FAULT (fetch rejects) ⇒ throws upstream_unavailable retryable,
  // never a masked null.
  await withFetch(
    (u) => {
      if (isResources(u)) return resourcesOk();
      if (isOrg(u)) return orgOk();
      if (isDetail(u)) throw new Error("ECONNRESET");
      return failClosed()();
    },
    async () => {
      const { threw, error } = await expectThrow(() => client().getOpportunity(REALID));
      ok("network fault ⇒ throws upstream_unavailable retryable (never silent null)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (f) HOLLOW 200 (no data2.title) ⇒ THROWS upstream_unavailable, NOT null.
  // A CDN/proxy hollow body is a degraded response, not a confirmed absence.
  for (const [label, body] of [
    ["{} (empty object)", {}],
    ['{"data2":{}} (data2 present, no title)', { data2: {} }],
    ['{"message":"Access Denied"} (proxy envelope)', { message: "Access Denied" }],
  ]) {
    await withFetch(
      detailHandler(() => mockResponse({ status: 200, json: body })),
      async () => {
        const { threw, error } = await expectThrow(() => client().getOpportunity(REALID));
        ok(`hollow-200 (${label}) ⇒ throws (NOT a fake found:false)`, threw,
          `threw=${threw}`);
        ok(`hollow-200 (${label}) ⇒ kind:upstream_unavailable, retryable:true`,
          threw && error?.toolError?.kind === "upstream_unavailable" &&
          error?.toolError?.retryable === true,
          JSON.stringify(error?.toolError));
      },
    );
  }

  // ── (g) WRAPPER CONTRACT: reproduce the server.ts wrapper's `if (!o) return
  // { found:false }` logic around getOpportunity. A 401 (absent) ⇒ found:false;
  // a 503 (outage) ⇒ the throw PROPAGATES (expectThrow) — it must NOT be
  // rendered as found:false. This proves the wrappers need no local catch: the
  // throw reaches the global tool-error mapper (upstream_unavailable), and only
  // a genuine absence yields found:false.
  const wrapperGetOpportunity = async (id) => {
    const o = await client().getOpportunity(id); // throws on outage
    if (!o) return { found: false, noticeId: id };
    return { found: true, noticeId: o.noticeId };
  };
  await withFetch(
    detailHandler(() => mockResponse({ status: 401 })),
    async () => {
      const res = await wrapperGetOpportunity("00000000000000000000000000000000");
      ok("wrapper: 401 (absent) ⇒ { found:false } (genuine not-found preserved)",
        res.found === false, JSON.stringify(res));
    },
  );
  await withFetch(
    detailHandler(() => mockResponse({ status: 503 })),
    async () => {
      const { threw, error, value } = await expectThrow(() => wrapperGetOpportunity(REALID));
      ok("wrapper: 503 (outage) ⇒ throws, NOT { found:false } (no fabricated absence)",
        threw && value === undefined, JSON.stringify(value));
      ok("wrapper: 503 propagates as upstream_unavailable (global mapper input)",
        threw && error?.toolError?.kind === "upstream_unavailable",
        JSON.stringify(error?.toolError));
    },
  );

  // ── (h) fetchOpportunityDescription: a URL whose fetch 503s ⇒ THROWS
  // upstream_unavailable (does NOT fabricate "Description not available.").
  await withFetch(
    (u) => (/sam\.gov/.test(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() =>
        client().fetchOpportunityDescription("https://sam.gov/api/prod/opps/v2/opportunities/X/description"));
      ok("description URL 503 ⇒ throws upstream_unavailable (no fabricated 'not available')",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (i) fetchOpportunityDescription: a URL that 200s with a text body ⇒
  // returns the cleaned text (happy path unchanged).
  await withFetch(
    (u) => (/sam\.gov/.test(u)
      ? mockResponse({ status: 200, json: "<p>Hello&nbsp;RFP world</p>", headers: { "content-type": "text/html" } })
      : failClosed()()),
    async () => {
      const text = await client().fetchOpportunityDescription("https://sam.gov/desc/X");
      ok("description URL 200 (text) ⇒ returns cleaned body text",
        typeof text === "string" && /Hello RFP world/.test(text),
        JSON.stringify(text));
    },
  );

  // ── (j) fetchOpportunityDescription: a URL that 200s with a JSON body ⇒
  // returns the body field (json passthrough unchanged).
  await withFetch(
    (u) => (/sam\.gov/.test(u)
      ? mockResponse({ status: 200, json: { body: "JSON body text" }, headers: { "content-type": "application/hal+json" } })
      : failClosed()()),
    async () => {
      const text = await client().fetchOpportunityDescription("https://sam.gov/desc/X");
      ok("description URL 200 (json) ⇒ returns the body field",
        text === "JSON body text", JSON.stringify(text));
    },
  );

  // ── (k) fetchOpportunityDescription: a PLAIN-TEXT input (no `http`) ⇒
  // passthrough, byte-unchanged, no fetch attempted (offline-safe).
  await withFetch(
    () => failClosed()(), // any fetch would throw the leak sentinel
    async () => {
      const text = await client().fetchOpportunityDescription("Already-extracted body text.");
      ok("plain-text input ⇒ passthrough unchanged (no fetch)",
        text === "Already-extracted body text.", JSON.stringify(text));
    },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 11. sam_fetch_attachment_text — read the ACTUAL solicitation document.
//
// The prior sections guard "a DOWN read must never read as absent/empty" for
// list/detail/description surfaces. This tool adds a DOCUMENT surface with the
// same contract PLUS real text extraction (unpdf, offline, on the bytes) and an
// SSRF allow-list. We drive the REAL fetchAttachmentText over mockBinaryResponse
// (it reads .arrayBuffer(), not .json()). The PDF fixture is a hand-rolled,
// uncompressed, single-page PDF whose content stream draws "HELLO PDF TEXT" — so
// a passing assertion proves unpdf actually parsed real bytes, not a stub.
// ══════════════════════════════════════════════════════════════════════════

// A valid, minimal PDF (588 bytes) drawing the literal "HELLO PDF TEXT" on one
// page. Verified offline that unpdf.extractText returns that string / 1 page.
const TINY_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NSA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcwMCBUZCAoSEVMTE8gUERGIFRFWFQpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzM2IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDA2CiUlRU9G";
// A valid single-page PDF with NO /Contents (no text layer) — the shape of a
// scanned/image-only attachment. Verified offline: unpdf returns totalPages:1,
// text:"" and does NOT throw. Proves the empty-text-layer guard (B1) fires.
const BLANK_PDF_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSA+PgplbmRvYmoKeHJlZgowIDQKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDQgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjE4NgolJUVPRg==";
const b64ToBytes = (b64) => Uint8Array.from(Buffer.from(b64, "base64"));
const strToBytes = (s) => new TextEncoder().encode(s);

// A real SAM keyless attachment download URL shape.
const SAM_ATT_URL =
  "https://sam.gov/api/prod/opps/v3/opportunities/resources/files/abc123def456/download";

/** Finalize a MetaBundle's partial meta exactly as the server layer does. */
const finalMeta = (bundle) => buildMeta(bundle.meta);

// ── DOCX fixtures, built at test time (deterministic, OFFLINE). ──────────────
// A DOCX is a ZIP whose `word/document.xml` holds the body text. The extractor
// only reads that entry, so a ZIP containing just it suffices. We build the ZIP
// container BY HAND (local header + data + central directory + EOCD) and
// deflate-raw the XML with the SAME zlib the extractor reverses — so a passing
// assertion proves the hand-rolled ZIP walk + zlib.inflateRawSync + XML-strip
// actually ran on real compressed bytes, NOT a stub. (`stored:true` emits an
// uncompressed method-0 entry to exercise that branch too.)
const _CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function _crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function _concatBytes(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
/**
 * Build a minimal, STRUCTURALLY VALID .docx (ZIP) byte array whose sole entry is
 * `word/document.xml` = `documentXml`. Deflate-raw compressed (method 8) unless
 * `stored` (method 0). `entryName` overrides the entry name (to build a valid
 * ZIP that LACKS word/document.xml for the negative case).
 */
function buildDocxFixture(documentXml, { stored = false, entryName = "word/document.xml" } = {}) {
  const enc = new TextEncoder();
  const name = enc.encode(entryName);
  const raw = enc.encode(documentXml);
  const comp = stored ? raw : zlib.deflateRawSync(raw);
  const crc = _crc32(raw);
  const method = stored ? 0 : 8;

  const lfh = new Uint8Array(30);
  const ldv = new DataView(lfh.buffer);
  ldv.setUint32(0, 0x04034b50, true);   // PK\x03\x04
  ldv.setUint16(4, 20, true);           // version needed
  ldv.setUint16(8, method, true);       // compression method
  ldv.setUint32(14, crc, true);         // crc-32
  ldv.setUint32(18, comp.length, true); // compressed size
  ldv.setUint32(22, raw.length, true);  // uncompressed size
  ldv.setUint16(26, name.length, true); // name length
  const localBlock = _concatBytes([lfh, name, comp]);

  const cdh = new Uint8Array(46);
  const cdv = new DataView(cdh.buffer);
  cdv.setUint32(0, 0x02014b50, true);   // PK\x01\x02
  cdv.setUint16(4, 20, true);           // version made by
  cdv.setUint16(6, 20, true);           // version needed
  cdv.setUint16(10, method, true);      // method
  cdv.setUint32(16, crc, true);         // crc-32
  cdv.setUint32(20, comp.length, true); // compressed size
  cdv.setUint32(24, raw.length, true);  // uncompressed size
  cdv.setUint16(28, name.length, true); // name length
  cdv.setUint32(42, 0, true);           // local header offset
  const cdBlock = _concatBytes([cdh, name]);

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);        // PK\x05\x06
  edv.setUint16(8, 1, true);                 // entries this disk
  edv.setUint16(10, 1, true);                // total entries
  edv.setUint32(12, cdBlock.length, true);   // CD size
  edv.setUint32(16, localBlock.length, true);// CD offset
  return _concatBytes([localBlock, cdBlock, eocd]);
}

async function testFetchAttachmentText() {
  section("11. sam_fetch_attachment_text: extract text + truthful null/outage/SSRF (fetch-mock)");

  // ── (a) PDF happy path — REAL extraction via unpdf on the fixture bytes.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: b64ToBytes(TINY_PDF_B64),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="test.pdf"',
        },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      const m = finalMeta(r);
      ok("PDF ⇒ format:pdf", r.data.format === "pdf", r.data.format);
      ok("PDF ⇒ text CONTAINS the fixture's real text (unpdf ran on the bytes)",
        typeof r.data.text === "string" && r.data.text.includes("HELLO PDF TEXT"),
        JSON.stringify(r.data.text));
      ok("PDF ⇒ pages >= 1 (honest page count)", r.data.pages >= 1, `pages=${r.data.pages}`);
      ok("PDF ⇒ extracted:true", r.data.extracted === true, JSON.stringify(r.data.extracted));
      ok("PDF ⇒ filename parsed from content-disposition", r.data.filename === "test.pdf", r.data.filename);
      ok("PDF ⇒ _meta.complete:true (document fully delivered)", m.complete === true, JSON.stringify(m));
      ok("PDF ⇒ _meta.returned:1", m.returned === 1, JSON.stringify(m.returned));
    },
  );

  // ── (b) HTML — tags stripped, <script> CONTENT dropped, entities decoded.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: strToBytes(
          "<html><body><script>var x=1;</script><p>Hello &amp; world</p></body></html>",
        ),
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      ok("HTML ⇒ format:html", r.data.format === "html", r.data.format);
      ok("HTML ⇒ text contains 'Hello & world' (entity decoded)",
        r.data.text.includes("Hello & world"), JSON.stringify(r.data.text));
      ok("HTML ⇒ <script> CONTENT stripped (no 'var x=1')",
        !r.data.text.includes("var x=1"), JSON.stringify(r.data.text));
      ok("HTML ⇒ extracted:true", r.data.extracted === true, JSON.stringify(r.data.extracted));
    },
  );

  // ── (c) text/plain — verbatim UTF-8 passthrough.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: strToBytes("plain body"),
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      ok("text ⇒ format:text", r.data.format === "text", r.data.format);
      ok("text ⇒ text === body verbatim", r.data.text === "plain body", JSON.stringify(r.data.text));
    },
  );

  // ── (d) Binary non-PDF (PNG magic 89 50 4E 47) ⇒ text:null, honest note,
  // NEVER "" masquerading as an empty document.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="logo.png"',
        },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      const m = finalMeta(r);
      ok("binary ⇒ format:binary", r.data.format === "binary", r.data.format);
      ok("binary ⇒ text:null (NOT '' — never a fake empty document)", r.data.text === null,
        JSON.stringify(r.data.text));
      ok("binary ⇒ extracted:false", r.data.extracted === false, JSON.stringify(r.data.extracted));
      ok("binary ⇒ disclosed 'not extractable' note",
        m.notes.some((n) => /not extractable/i.test(n)), JSON.stringify(m.notes));
      ok("binary ⇒ _meta.complete:false + text in fieldsUnavailable",
        m.complete === false && m.fieldsUnavailable.includes("text"), JSON.stringify(m));
    },
  );

  // ── (d-docx-1) DOCX HAPPY PATH — REAL extraction. A minimal but valid DOCX
  // (ZIP + word/document.xml, deflate-raw compressed) whose body carries a known
  // sentence ⇒ the tool inflates + strips it and returns the real text. A passing
  // assertion proves the hand-rolled ZIP walk + zlib.inflateRawSync + XML-strip
  // ACTUALLY RAN on real compressed bytes, not a stub. pages:null (DOCX has no
  // fixed page count without rendering — never fabricated).
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: buildDocxFixture(
          "<w:document><w:body><w:p><w:r><w:t>KNOWN SOW SENTENCE</w:t></w:r></w:p></w:body></w:document>",
        ),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="test.docx"',
        },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      const m = finalMeta(r);
      ok("DOCX ⇒ format:docx", r.data.format === "docx", r.data.format);
      ok("DOCX ⇒ text CONTAINS the fixture's real body (inflate+strip ran on the bytes)",
        typeof r.data.text === "string" && r.data.text.includes("KNOWN SOW SENTENCE"),
        JSON.stringify(r.data.text));
      ok("DOCX ⇒ extracted:true", r.data.extracted === true, JSON.stringify(r.data.extracted));
      ok("DOCX ⇒ pages:null (no fabricated page count)", r.data.pages === null, JSON.stringify(r.data.pages));
      ok("DOCX ⇒ filename parsed from content-disposition", r.data.filename === "test.docx", r.data.filename);
      ok("DOCX ⇒ _meta.complete:true (document fully delivered)", m.complete === true, JSON.stringify(m.complete));
      ok("DOCX ⇒ _meta.returned:1", m.returned === 1, JSON.stringify(m.returned));
    },
  );

  // ── (d-docx-2) ATTRIBUTE-JUNK — the open tag carries w14:paraId="…" attributes.
  // Stripping FULL tags (not partial) means the extracted text is exactly "Hello"
  // and NEVER leaks "paraId"/"w14"/the attribute value as body text.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: buildDocxFixture(
          '<w:p w14:paraId="ABC123" w14:textId="DEAD"><w:r><w:t>Hello</w:t></w:r></w:p>',
        ),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="attrs.docx"',
        },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      const t = r.data.text ?? "";
      ok("DOCX attr-junk ⇒ text is exactly 'Hello'", t === "Hello", JSON.stringify(t));
      ok("DOCX attr-junk ⇒ NO 'paraId' leaked into text", !t.includes("paraId"), JSON.stringify(t));
      ok("DOCX attr-junk ⇒ NO 'w14' leaked into text", !t.includes("w14"), JSON.stringify(t));
      ok("DOCX attr-junk ⇒ NO attribute value ('ABC123') leaked into text",
        !t.includes("ABC123"), JSON.stringify(t));
    },
  );

  // ── (d-docx-3) CORRUPT DOCX — PK\x03\x04 magic (so detectFormat says docx) then
  // garbage (no central directory / no word/document.xml). The defensive ZIP walk
  // THROWS internally; the tool CATCHES it ⇒ text:null + an extraction-failure
  // note, NO crash/throw out of the tool. A bad DOCX is not an outage, not "".
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: new Uint8Array([
          0x50, 0x4b, 0x03, 0x04,
          ...strToBytes("not a real zip at all, no central directory record here"),
        ]),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="broken.docx"',
        },
      }),
    async () => {
      const res = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("corrupt DOCX ⇒ does NOT throw (a bad DOCX is not an outage)", res.threw === false,
        res.threw ? String(res.error) : "");
      if (!res.threw) {
        const r = res.value;
        const m = finalMeta(r);
        ok("corrupt DOCX ⇒ format:docx (PK magic + .docx ext still detect it)",
          r.data.format === "docx", r.data.format);
        ok("corrupt DOCX ⇒ text:null (NOT a fabricated string)", r.data.text === null,
          JSON.stringify(r.data.text));
        ok("corrupt DOCX ⇒ pages:null", r.data.pages === null, JSON.stringify(r.data.pages));
        ok("corrupt DOCX ⇒ extraction-failure note disclosed",
          m.notes.some((n) => /DOCX text extraction failed/i.test(n)), JSON.stringify(m.notes));
        ok("corrupt DOCX ⇒ _meta.complete:false + text in fieldsUnavailable",
          m.complete === false && (m.fieldsUnavailable ?? []).includes("text"), JSON.stringify(m));
      }
    },
  );

  // ── (d-docx-4) EMPTY DOCX — a VALID zip whose word/document.xml has no <w:t>
  // (empty body). Extraction yields "" ⇒ the B1 empty-guard turns it into
  // text:null + a disclosed note, NEVER "" delivered as an empty document.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: buildDocxFixture("<w:document><w:body><w:p></w:p></w:body></w:document>"),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="empty.docx"',
        },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      const m = finalMeta(r);
      ok("empty DOCX ⇒ format:docx", r.data.format === "docx", r.data.format);
      ok("empty DOCX ⇒ text:null (B1 empty-guard; never '' as a fake empty document)",
        r.data.text === null && r.data.extracted === false,
        JSON.stringify({ text: r.data.text, extracted: r.data.extracted }));
      ok("empty DOCX ⇒ empty/whitespace disclosed + text in fieldsUnavailable",
        m.notes.some((n) => /empty\/whitespace|nothing to read/i.test(n)) &&
        (m.fieldsUnavailable ?? []).includes("text"),
        JSON.stringify({ notes: m.notes, fieldsUnavailable: m.fieldsUnavailable }));
    },
  );

  // ── (d-docx-5) VALID ZIP, NO word/document.xml — a real zip container whose
  // only entry is some other file ⇒ the walk finds no word/document.xml and
  // THROWS internally; the tool CATCHES it ⇒ text:null + disclosed note, no crash.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: buildDocxFixture("<x/>", { entryName: "other/file.xml" }),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="nodoc.docx"',
        },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      const m = finalMeta(r);
      ok("DOCX w/o word/document.xml ⇒ text:null (caught, not crashed)",
        r.data.text === null && r.data.extracted === false,
        JSON.stringify({ text: r.data.text, extracted: r.data.extracted }));
      ok("DOCX w/o word/document.xml ⇒ extraction-failure note names word/document.xml",
        m.notes.some((n) => /word\/document\.xml|not a valid Word document/i.test(n)),
        JSON.stringify(m.notes));
    },
  );

  // ── (d-docx-6) STORED (method 0) entry — an uncompressed word/document.xml
  // exercises the method-0 (no inflate) branch of the extractor.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: buildDocxFixture(
          "<w:p><w:r><w:t>STORED ENTRY TEXT</w:t></w:r></w:p>",
          { stored: true },
        ),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="stored.docx"',
        },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      ok("DOCX stored (method 0) ⇒ text extracted (no-inflate branch)",
        typeof r.data.text === "string" && r.data.text.includes("STORED ENTRY TEXT"),
        JSON.stringify(r.data.text));
    },
  );

  // ── (e) Corrupt PDF (%PDF header + garbage) ⇒ text:null + extractionError
  // note, NO crash/throw. A bad PDF is NOT an outage and NOT an empty doc.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: strToBytes("%PDF-1.4\nthis is not a real pdf body at all %%EOF"),
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="broken.pdf"',
        },
      }),
    async () => {
      const res = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("corrupt PDF ⇒ does NOT throw (a bad PDF is not an outage)", res.threw === false,
        res.threw ? String(res.error) : "");
      if (!res.threw) {
        const r = res.value;
        const m = finalMeta(r);
        ok("corrupt PDF ⇒ format:pdf (magic bytes still detect it)", r.data.format === "pdf", r.data.format);
        ok("corrupt PDF ⇒ text:null (NOT a fabricated string)", r.data.text === null,
          JSON.stringify(r.data.text));
        ok("corrupt PDF ⇒ pages:null", r.data.pages === null, JSON.stringify(r.data.pages));
        ok("corrupt PDF ⇒ extractionError note disclosed",
          m.notes.some((n) => /extractionError/i.test(n)), JSON.stringify(m.notes));
        ok("corrupt PDF ⇒ _meta.complete:false", m.complete === false, JSON.stringify(m.complete));
      }
    },
  );

  // ── (f) 503 ⇒ THROWS upstream_unavailable (retryable). A down service is
  // NOT an empty attachment — never text:"".
  await withFetch(
    () => mockBinaryResponse({ status: 503, bytes: new Uint8Array(0) }),
    async () => {
      const { threw, error } = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("503 ⇒ throws upstream_unavailable, retryable:true (NOT empty text)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (g) 404 ⇒ THROWS not_found (the attachment id is gone).
  await withFetch(
    () => mockBinaryResponse({ status: 404, bytes: new Uint8Array(0) }),
    async () => {
      const { threw, error } = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("404 ⇒ throws not_found, retryable:false",
        threw && error?.toolError?.kind === "not_found" &&
        error?.toolError?.retryable === false,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (h) Network fault (fetch rejects) ⇒ THROWS upstream_unavailable retryable
  // — never a silent empty text.
  await withFetch(
    () => { throw new Error("ECONNRESET"); },
    async () => {
      const { threw, error } = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("network fault ⇒ throws upstream_unavailable retryable (never silent empty)",
        threw && error?.toolError?.kind === "upstream_unavailable" &&
        error?.toolError?.retryable === true,
        JSON.stringify(error?.toolError));
    },
  );

  // ── (i) maxChars small (5) on a text body ⇒ truncated:true + disclosed,
  // text length <= 5.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: strToBytes("abcdefghij"),
        headers: { "content-type": "text/plain" },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL, maxChars: 5 });
      const m = finalMeta(r);
      ok("maxChars=5 ⇒ text length <= 5", r.data.text.length <= 5, `len=${r.data.text.length}`);
      ok("maxChars=5 ⇒ truncated:true", r.data.truncated === true, JSON.stringify(r.data.truncated));
      ok("maxChars=5 ⇒ truncation disclosed in a note",
        m.notes.some((n) => /truncat/i.test(n)), JSON.stringify(m.notes));
      ok("maxChars=5 ⇒ _meta.complete:false (couldn't fully deliver)",
        m.complete === false, JSON.stringify(m.complete));
    },
  );

  // ── (j) SSRF: a non-SAM host ⇒ invalid_input, NO fetch.
  await withFetch(
    () => { throw new Error("NETWORK LEAKED — SSRF guard failed to block a non-SAM host"); },
    async () => {
      const { threw, error } = await expectThrow(() =>
        fetchAttachmentText({ url: "https://evil.example/x/download" }));
      ok("non-SAM host ⇒ throws invalid_input (no fetch attempted)",
        threw && error?.toolError?.kind === "invalid_input",
        JSON.stringify(error?.toolError));
    },
  );

  // ── (k) SSRF: an http:// (non-TLS) SAM-looking URL ⇒ invalid_input, NO fetch.
  await withFetch(
    () => { throw new Error("NETWORK LEAKED — accepted a non-https URL"); },
    async () => {
      const { threw, error } = await expectThrow(() =>
        fetchAttachmentText({ url: "http://sam.gov/api/prod/opps/x/download" }));
      ok("http:// (non-TLS) ⇒ throws invalid_input (no fetch attempted)",
        threw && error?.toolError?.kind === "invalid_input",
        JSON.stringify(error?.toolError));
    },
  );

  // ── (l) Not even a URL ⇒ invalid_input, NO fetch.
  await withFetch(
    () => { throw new Error("NETWORK LEAKED — accepted a non-URL string"); },
    async () => {
      const { threw, error } = await expectThrow(() =>
        fetchAttachmentText({ url: "not a url at all" }));
      ok("non-URL string ⇒ throws invalid_input (no fetch attempted)",
        threw && error?.toolError?.kind === "invalid_input",
        JSON.stringify(error?.toolError));
    },
  );

  // ── (B1) IMAGE-ONLY / no-text-layer PDF (scanned doc) ⇒ text:null + disclosed,
  // NOT text:"" reported as a fully-delivered empty document. Keeps honest pages.
  await withFetch(
    () =>
      mockBinaryResponse({
        status: 200,
        bytes: b64ToBytes(BLANK_PDF_B64),
        headers: { "content-disposition": 'attachment; filename="scanned.pdf"' },
      }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      const m = finalMeta(r);
      ok("image-only PDF ⇒ text:null (NOT '' masquerading as an empty document)",
        r.data.text === null && r.data.extracted === false,
        JSON.stringify({ text: r.data.text, extracted: r.data.extracted }));
      ok("image-only PDF ⇒ pages kept honest (it HAS a page, just no text layer)",
        r.data.pages === 1, JSON.stringify(r.data.pages));
      ok("image-only PDF ⇒ _meta complete:false + fieldsUnavailable:['text'] + 'no text layer' note",
        m.complete === false && (m.fieldsUnavailable ?? []).includes("text") &&
        m.notes.some((n) => /no extractable text layer|scanned\/image-only/i.test(n)),
        JSON.stringify({ complete: m.complete, notes: m.notes }));
    },
  );

  // ── (empty body) a text/plain body of "" ⇒ text:null + disclosed (not "").
  await withFetch(
    () => mockBinaryResponse({ status: 200, bytes: new Uint8Array(0), headers: { "content-type": "text/plain" } }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      ok("empty body ⇒ text:null (never '' as a fake empty document)",
        r.data.text === null && r.data.extracted === false, JSON.stringify(r.data));
    },
  );

  // ── (non-UTF-8) a text/plain body that is actually UTF-16 (NUL soup when
  // decoded as UTF-8) ⇒ text:null + charset note, NOT garbage-as-text.
  await withFetch(
    () => mockBinaryResponse({
      status: 200,
      bytes: new Uint8Array([72, 0, 101, 0, 108, 0, 108, 0, 111, 0]), // "Hello" UTF-16LE
      headers: { "content-type": "text/plain" },
    }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      const m = finalMeta(r);
      ok("non-UTF-8 (UTF-16) text ⇒ text:null + charset note (no NUL/garbage as text)",
        r.data.text === null &&
        m.notes.some((n) => /could not be decoded as readable UTF-8|character set/i.test(n)),
        JSON.stringify({ text: r.data.text, notes: m.notes }));
    },
  );

  // ── (redirect SSRF) fetch followed a redirect to a NON-SAM/non-S3 host
  // (cloud-metadata) ⇒ refuse to read it back (invalid_input), even on a 200.
  await withFetch(
    () => mockBinaryResponse({
      status: 200,
      bytes: strToBytes("secret internal metadata"),
      url: "https://169.254.169.254/latest/meta-data/",
      headers: { "content-type": "text/plain" },
    }),
    async () => {
      const { threw, error } = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("redirect to non-SAM host (169.254.169.254) ⇒ throws invalid_input (SSRF: final host re-validated)",
        threw && error?.toolError?.kind === "invalid_input", JSON.stringify(error?.toolError));
    },
  );

  // ── (redirect to S3) the LEGITIMATE hop: SAM 303-redirects to its S3 store;
  // the final host is *.s3.amazonaws.com ⇒ ALLOWED (extraction must still work).
  await withFetch(
    () => mockBinaryResponse({
      status: 200,
      bytes: b64ToBytes(TINY_PDF_B64),
      url: "https://iae-fbo-attachments.s3.amazonaws.com/abc?X-Amz-Expires=9",
      headers: { "content-disposition": 'attachment; filename="test.pdf"' },
    }),
    async () => {
      const r = await fetchAttachmentText({ url: SAM_ATT_URL });
      ok("redirect to SAM's S3 store ⇒ ALLOWED, extracts the PDF text (the legit hop is not blocked)",
        r.data.format === "pdf" && typeof r.data.text === "string" && r.data.text.includes("HELLO PDF TEXT"),
        JSON.stringify({ format: r.data.format, textHead: (r.data.text ?? "").slice(0, 20) }));
    },
  );

  // ── (redirect S3 LOOK-ALIKE — hardened T5) a host that merely CONTAINS "s3"
  // (`evil-s3.attacker.amazonaws.com`) is NOT a real `s3` label ⇒ REJECTED. The
  // prior `includes("s3")` check would have wrongly admitted it.
  await withFetch(
    () => mockBinaryResponse({
      status: 200, bytes: b64ToBytes(TINY_PDF_B64), redirected: true,
      url: "https://evil-s3.attacker.amazonaws.com/x",
      headers: { "content-disposition": 'attachment; filename="x.pdf"' },
    }),
    async () => {
      const { threw, error } = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("redirect to look-alike 'evil-s3.attacker.amazonaws.com' ⇒ REJECTED (s3 must be a real label, not a substring)",
        threw && error?.toolError?.kind === "invalid_input", JSON.stringify(error?.toolError));
    },
  );

  // ── (redirect to a REAL-but-wrong S3 bucket — hardened T5, closes the review's
  // finding) `attacker-bucket.s3.amazonaws.com` is a genuine, registrable S3
  // endpoint but NOT SAM's pinned bucket ⇒ REJECTED. (The prior "trust ALL of S3"
  // logic would have read the attacker-controlled body back as "SAM text".)
  await withFetch(
    () => mockBinaryResponse({
      status: 200, bytes: b64ToBytes(TINY_PDF_B64), redirected: true,
      url: "https://attacker-bucket.s3.amazonaws.com/x",
      headers: { "content-disposition": 'attachment; filename="x.pdf"' },
    }),
    async () => {
      const { threw, error } = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("redirect to a REAL non-SAM S3 bucket (attacker-bucket.s3.amazonaws.com) ⇒ REJECTED (bucket pinned, not all-of-S3)",
        threw && error?.toolError?.kind === "invalid_input", JSON.stringify(error?.toolError));
    },
  );

  // ── (redirect, HIDDEN target — hardened T5) a redirect occurred but the runtime
  // left res.url empty ⇒ target unverifiable ⇒ REJECT (was blindly trusted before).
  await withFetch(
    () => mockBinaryResponse({
      status: 200, bytes: strToBytes("hidden redirect target body"),
      url: "", redirected: true, headers: { "content-type": "text/plain" },
    }),
    async () => {
      const { threw, error } = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("redirect with hidden final URL (redirected + empty res.url) ⇒ REJECTED (target unverifiable)",
        threw && error?.toolError?.kind === "invalid_input", JSON.stringify(error?.toolError));
    },
  );

  // ── (size cap) a content-length over the 50MB cap ⇒ refuse BEFORE buffering.
  await withFetch(
    () => mockBinaryResponse({
      status: 200,
      bytes: strToBytes("small body but header lies big"),
      headers: { "content-type": "application/pdf", "content-length": String(60 * 1024 * 1024) },
    }),
    async () => {
      const { threw, error } = await expectThrow(() => fetchAttachmentText({ url: SAM_ATT_URL }));
      ok("oversized content-length (60MB) ⇒ throws invalid_input (bounded before buffering)",
        threw && error?.toolError?.kind === "invalid_input" &&
        /MB|limit/i.test(error?.toolError?.message ?? ""),
        JSON.stringify(error?.toolError));
    },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 12. sam_get_opportunity ENRICHMENT honesty (C25) — the enrichment sub-fetch
//     DOWN-reads-as-absent swallow (dist/sam-gov/index.js SamGovClient, fetch-
//     mock). Closes the sweep started for search (§9) and detail (§10).
//
//     The defect: within an otherwise-successful getOpportunity, the two
//     enrichment sub-fetches (getPublicResourceLinks / getPublicOrgName)
//     collapsed EVERY non-200 / network fault into `[]` / `""` — so a DOWN
//     attachment-list read as "no attachments" and a DOWN org read as "no
//     organization". Since attachments are now READABLE, a hollow `[]` makes
//     an AI skip a solicitation whose RFP it could have read.
//
//     Live grounding: the resources/org endpoints are called ONLY after the
//     detail endpoint already 200'd (the notice EXISTS); they then return 200
//     for every real notice (a genuine NO-attachment notice = 200-empty). So
//     any non-200 there is an OUTAGE, never a genuine empty. The fix: the
//     sub-fetches THROW on non-200; getOpportunityPublic catches each
//     INDIVIDUALLY, records the degraded bucket on `enrichmentDegraded`, and
//     the wrapper emits an honest `_meta.degraded` + a disclosing note — while
//     a genuine 200-empty stays a plain, non-degraded result (no crying wolf).
//     We drive the REAL keyless SamGovClient over a mocked detail(200) +
//     varied enrichment responses.
// ══════════════════════════════════════════════════════════════════════════
async function testGetOpportunityEnrichmentHonesty() {
  section("12. sam_get_opportunity enrichment (attachments/org) outage-vs-empty honesty (fetch-mock)");

  // Keyless ⇒ auth tier skipped; ONLY the public detail+enrichment tiers run.
  const client = () => new SamGovClient({ fetch: globalThis.fetch });

  // Same classifiers as §10 (the detail + the two enrichment surfaces).
  const isDetail = (u) => /\/opps\/v2\/opportunities\/[^/]+($|\?)/.test(u);
  const isResources = (u) => /\/opps\/v3\/opportunities\/[^/]+\/resources/.test(u);
  const isOrg = (u) => /\/federalorganizations\/v1\/organizations\//.test(u);

  const REALID = "686796f3919a49f598fcc1493fe81f0a";

  // A valid detail body (200) with data2.title + data2.organizationId, so the
  // notice is FOUND and the org enrichment is ATTEMPTED. Mirrors §10.
  const detailBody = () => ({
    data2: {
      title: "SAMPLE NOTICE TITLE",
      type: "Solicitation",
      organizationId: "ORG123",
      solicitationNumber: "SOL-9",
      postedDate: "2026-07-01",
      solicitation: { setAside: "SBA", deadlines: { response: "2026-08-01T17:00:00-04:00" } },
      naics: [{ code: ["541512"] }],
    },
    description: [{ body: "The full RFP body text." }],
  });
  const detailOk = () => mockResponse({ status: 200, json: detailBody() });

  // A resources 200 body carrying ONE real attachment (resourceId present).
  const resourcesWith = () =>
    mockResponse({
      status: 200,
      json: { _embedded: { opportunityAttachmentList: [{ attachments: [{ resourceId: "res-1", name: "rfp.pdf" }] }] } },
    });
  // A resources 200 body with a GENUINELY empty list (the honest no-attachment).
  const resourcesEmpty = () =>
    mockResponse({ status: 200, json: { _embedded: { opportunityAttachmentList: [{ attachments: [] }] } } });
  const orgOk = () =>
    mockResponse({ status: 200, json: { _embedded: [{ org: { fullParentPathName: "DOD.ARMY" } }] } });

  // Build a handler whose detail is always 200 and whose enrichment responses
  // are supplied per-case: `res(u)` / `org(u)` return a mockResponse or throw.
  const handler = (res, org) => (u) => {
    if (isResources(u)) return res(u);
    if (isOrg(u)) return org(u);
    if (isDetail(u)) return detailOk();
    return failClosed()();
  };

  // Drive the REAL server wrapper: call runTool("sam_get_opportunity", …) over
  // the SAME mocked detail+enrichment fetch, then finalize its result exactly as
  // the CallTool handler does — a MetaBundle (via withMeta) → { data, meta:
  // buildMeta(raw.meta) }; a plain object (healthy notice) → { data, meta:null }
  // (the server would synthesize a default complete:true meta). This replaces the
  // former inline `wrap` copy, so a regression in server.ts's enrichmentDegraded
  // → _meta.degraded/note mapping turns these assertions RED. `sam` is a keyless
  // client built INSIDE withFetch so its captured fetchImpl is the patched mock.
  const wrap = async (noticeId, sam) => {
    const raw = await runTool("sam_get_opportunity", { noticeId }, sam);
    return isMetaBundle(raw)
      ? { data: raw.data, meta: buildMeta(raw.meta) }
      : { data: raw, meta: null };
  };

  // ── (a) resources 503 (org ok) ⇒ enrichmentDegraded:["attachments"]; the
  // wrapper meta is degraded (complete:false, failed>=1) + the attachments note;
  // resourceLinks is [] (DISCLOSED as unknown, not silently "none").
  await withFetch(
    handler(() => mockResponse({ status: 503 }), orgOk),
    async () => {
      const sam = new SamGovClient({});
      const o = await client().getOpportunity(REALID);
      ok("resources 503 ⇒ notice STILL returned (outage did not sink it)",
        o && o.noticeId === REALID && o.title === "SAMPLE NOTICE TITLE",
        JSON.stringify(o && { id: o.noticeId }));
      ok("resources 503 ⇒ enrichmentDegraded contains 'attachments'",
        Array.isArray(o?.enrichmentDegraded) && o.enrichmentDegraded.includes("attachments"),
        JSON.stringify(o?.enrichmentDegraded));
      ok("resources 503 ⇒ did NOT flag 'organization' (org was healthy)",
        !o.enrichmentDegraded.includes("organization") && o.fullParentPathName === "DOD.ARMY",
        JSON.stringify({ deg: o.enrichmentDegraded, org: o.fullParentPathName }));
      ok("resources 503 ⇒ resourceLinks is [] (empty, but disclosed as unknown)",
        Array.isArray(o.resourceLinks) && o.resourceLinks.length === 0,
        JSON.stringify(o.resourceLinks));
      const { data, meta } = await wrap(REALID, sam);
      ok("resources 503 ⇒ real wrapper STILL returns found:true (notice not sunk)",
        data && data.found === true && data.attachments.length === 0,
        JSON.stringify(data && { found: data.found, att: data.attachments.length }));
      ok("resources 503 ⇒ wrapper _meta.complete === false",
        meta && meta.complete === false, JSON.stringify(meta && { c: meta.complete }));
      ok("resources 503 ⇒ wrapper _meta.degraded.failed >= 1",
        meta && meta.degraded && meta.degraded.failed >= 1,
        JSON.stringify(meta && meta.degraded));
      ok("resources 503 ⇒ a note DISCLOSES 'MAY have attachments' (not a silent none)",
        meta && meta.notes.some((n) => /MAY have attachments/i.test(n) && /NOT a confirmation/i.test(n)),
        JSON.stringify(meta && meta.notes));
    },
  );

  // ── (b) resources 200-EMPTY (org ok) ⇒ NO enrichmentDegraded; healthy, the
  // wrapper synthesizes no degraded meta (a genuine no-attachment notice — no
  // crying wolf).
  await withFetch(
    handler(resourcesEmpty, orgOk),
    async () => {
      const sam = new SamGovClient({});
      const o = await client().getOpportunity(REALID);
      ok("resources 200-empty ⇒ NO enrichmentDegraded (genuine empty, not an outage)",
        o && o.enrichmentDegraded === undefined,
        JSON.stringify(o && { deg: o.enrichmentDegraded }));
      ok("resources 200-empty ⇒ resourceLinks is [] (honest empty)",
        Array.isArray(o.resourceLinks) && o.resourceLinks.length === 0,
        JSON.stringify(o.resourceLinks));
      const { data, meta } = await wrap(REALID, sam);
      ok("resources 200-empty ⇒ real wrapper returns a PLAIN result (found:true, no degraded meta)",
        meta === null && data && data.found === true, JSON.stringify({ meta, found: data?.found }));
    },
  );

  // ── (c) org 503 (resources ok, organizationId present) ⇒
  // enrichmentDegraded:["organization"] + its note; attachments unaffected.
  await withFetch(
    handler(resourcesWith, () => mockResponse({ status: 503 })),
    async () => {
      const sam = new SamGovClient({});
      const o = await client().getOpportunity(REALID);
      ok("org 503 ⇒ enrichmentDegraded contains 'organization'",
        Array.isArray(o?.enrichmentDegraded) && o.enrichmentDegraded.includes("organization"),
        JSON.stringify(o?.enrichmentDegraded));
      ok("org 503 ⇒ did NOT flag 'attachments' (resources was healthy, 1 link)",
        !o.enrichmentDegraded.includes("attachments") && (o.resourceLinks ?? []).length === 1,
        JSON.stringify({ deg: o.enrichmentDegraded, links: o.resourceLinks }));
      ok("org 503 ⇒ fullParentPathName is '' (empty, but disclosed as unknown)",
        o.fullParentPathName === "", JSON.stringify(o.fullParentPathName));
      const { meta } = await wrap(REALID, sam);
      ok("org 503 ⇒ wrapper _meta degraded + the organization note",
        meta && meta.complete === false && meta.degraded.failed >= 1 &&
        meta.notes.some((n) => /awarding-organization path could not be resolved/i.test(n) && /not absent/i.test(n)),
        JSON.stringify(meta && { c: meta.complete, notes: meta.notes }));
    },
  );

  // ── (d) BOTH healthy (resources-with + org ok) ⇒ no enrichmentDegraded, no
  // degraded meta (the plain happy result — attachments + agency populated).
  await withFetch(
    handler(resourcesWith, orgOk),
    async () => {
      const sam = new SamGovClient({});
      const o = await client().getOpportunity(REALID);
      ok("both healthy ⇒ NO enrichmentDegraded",
        o && o.enrichmentDegraded === undefined, JSON.stringify(o && o.enrichmentDegraded));
      ok("both healthy ⇒ resourceLinks has the 1 attachment, org resolved",
        (o.resourceLinks ?? []).length === 1 && o.fullParentPathName === "DOD.ARMY",
        JSON.stringify({ links: o.resourceLinks, org: o.fullParentPathName }));
      const { data, meta } = await wrap(REALID, sam);
      ok("both healthy ⇒ real wrapper emits NO degraded meta (plain result, 1 attachment)",
        meta === null && data && data.attachments.length === 1 && data.agency === "DOD.ARMY",
        JSON.stringify({ meta, att: data?.attachments.length, agency: data?.agency }));
    },
  );

  // ── (e) BOTH fail (resources 503 + org 503) ⇒
  // enrichmentDegraded:["attachments","organization"], degraded.failed === 2.
  await withFetch(
    handler(() => mockResponse({ status: 503 }), () => mockResponse({ status: 503 })),
    async () => {
      const sam = new SamGovClient({});
      const o = await client().getOpportunity(REALID);
      ok("both fail ⇒ enrichmentDegraded has BOTH buckets",
        Array.isArray(o?.enrichmentDegraded) &&
        o.enrichmentDegraded.includes("attachments") &&
        o.enrichmentDegraded.includes("organization") &&
        o.enrichmentDegraded.length === 2,
        JSON.stringify(o?.enrichmentDegraded));
      const { meta } = await wrap(REALID, sam);
      ok("both fail ⇒ wrapper _meta.degraded.failed === 2 (both disclosed)",
        meta && meta.degraded && meta.degraded.failed === 2 && meta.notes.length === 2,
        JSON.stringify(meta && meta.degraded));
    },
  );

  // ── (f) resources NETWORK fault (fetch rejects) ⇒ same as 503: degraded
  // "attachments", NOT a silent []. (Proves a raw network error is caught by
  // the per-enrichment .catch, not swallowed inside the sub-fetch.)
  await withFetch(
    (u) => {
      if (isResources(u)) throw new Error("ECONNRESET");
      if (isOrg(u)) return orgOk();
      if (isDetail(u)) return detailOk();
      return failClosed()();
    },
    async () => {
      const o = await client().getOpportunity(REALID);
      ok("resources network fault ⇒ enrichmentDegraded 'attachments' (never a silent [])",
        Array.isArray(o?.enrichmentDegraded) && o.enrichmentDegraded.includes("attachments") &&
        (o.resourceLinks ?? []).length === 0,
        JSON.stringify({ deg: o?.enrichmentDegraded, links: o?.resourceLinks }));
    },
  );

  // ── (g) detail body WITHOUT organizationId ⇒ org enrichment is SKIPPED (never
  // attempted), so an org outage cannot occur and NO "organization" bucket is
  // recorded even when resources also succeeds. (Guards: no phantom org degrade.)
  await withFetch(
    (u) => {
      if (isResources(u)) return resourcesEmpty();
      if (isOrg(u)) return failClosed()(); // MUST NOT be called
      if (isDetail(u)) return mockResponse({ status: 200, json: { data2: { title: "NO ORG NOTICE", type: "Solicitation" }, description: [{ body: "x" }] } });
      return failClosed()();
    },
    async () => {
      const o = await client().getOpportunity(REALID);
      ok("no organizationId ⇒ org enrichment skipped, NO enrichmentDegraded",
        o && o.title === "NO ORG NOTICE" && o.enrichmentDegraded === undefined && o.fullParentPathName === "",
        JSON.stringify(o && { deg: o.enrichmentDegraded, org: o.fullParentPathName }));
    },
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 13. sam_search_opportunities GSA-CSV enrichment disclosure gating — the
//     empty-page (returned===0) FALSE-warming fix (server.ts CSV-enrichment
//     block, ~L1421-1466).
//
//     The defect: with the CSV backbone ENABLED but its index cold, the
//     `ready = data.returned > 0 ? tryGetReadyIndex(...) : null` line yields
//     `ready===null` on a GENUINELY-EMPTY page (returned===0). Control then fell
//     into the `else` "index warming" branch, which set source "(index warming)"
//     and pushed a note telling the caller to "Retry shortly for an enriched
//     page". On a 0-row page there is NOTHING to enrich — a retry cannot add rows
//     — so that note is misleading. The fix gates the warming disclosure on
//     `data.returned > 0` (`else if (data.returned > 0)`), so an empty page is a
//     complete, honest result with NO warming note / suffix.
//
//     COVERAGE — the load-bearing empty-page fix is now driven through the REAL
//     runTool. Case (a) (ENABLED + GENUINELY-EMPTY page) calls the exported
//     runTool("sam_search_opportunities", …) over a mocked SGS HAL with the CSV
//     backbone enabled (SAM_GOV_ENABLE_CSV=1, restored after): on returned===0
//     the wrapper NEVER calls tryGetReadyIndex (the `returned>0 ? … : null`
//     ternary short-circuits — so NO background warm, NO network, NO disk, fully
//     deterministic offline) and the gated `else if (returned>0)` is skipped, so
//     a regression that re-emits the "index warming" suffix/note on an empty page
//     turns case (a) RED. Cases (b)/(c)/(d) exercise the WARM/cold-non-empty
//     enrichment branches, whose disclosure depends on the module-global `loaded`
//     CSV index — impractical to force into a specific warm/cold state
//     deterministically OFFLINE via the real runTool (the warm is a fire-and-
//     forget async that mutates process-global state). Those three stay on the
//     faithful inline `assembleEnrichment` reproduction below, which still drives
//     the REAL enrichSearchOpportunities (dist/gsa-csv.js) + buildMeta
//     (dist/meta.js). (§9 and §12 additionally cover the real runTool end-to-end
//     for the search-outage and get_opportunity-enrichment wrappers.)
// ══════════════════════════════════════════════════════════════════════════
async function testSearchEnrichmentGating() {
  section("13. sam_search_opportunities CSV enrichment disclosure gating (empty-page warming fix)");

  // A faithful reproduction of the server.ts CSV-enrichment assembly (the block
  // that was changed): given a `data` page ({returned, opportunities}), whether
  // the CSV is enabled, and a `readyIndex` (null = cold/warming), produce the
  // { source, notes, fieldsUnavailable, meta } the handler would emit. The ONLY
  // load-bearing line under test is the warming branch's `else if (returned>0)`
  // gate — every other line mirrors server.ts verbatim.
  const assembleEnrichment = ({ data, enabled, readyIndex, totalRecords }) => {
    let enrichedOpps = data.opportunities;
    let fieldsUnavailable = ["naics", "setAside", "placeOfPerformance"];
    const enrichmentNotes = [];
    let source = "sam.gov/sgs/v1 (keyless HAL)";
    let freshness = undefined;

    if (enabled) {
      const ready = data.returned > 0 ? readyIndex : null;
      if (ready) {
        const outcome = enrichSearchOpportunities(enrichedOpps, ready);
        enrichedOpps = outcome.opportunities;
        freshness = outcome.freshness;
        source = "sam.gov/sgs/v1 (keyless HAL) + gsa-csv (daily bulk CSV snapshot)";
        fieldsUnavailable = ["naics", "setAside", "placeOfPerformance"].filter(
          (f) => !outcome.fieldsFilled.has(f),
        );
        const filledList = [...outcome.fieldsFilled];
        if (filledList.length > 0) {
          enrichmentNotes.push(
            `naics/set-aside/place-of-performance for results present in today's GSA CSV snapshot were enriched from the GSA daily bulk CSV (source: gsa-csv) — filled fields this page: ${filledList.join(", ")}. set-aside here is the CSV short code (e.g. 'SBA') that matches sam_get_opportunity's setAside. Confirm real-time values (e.g. a just-amended deadline) with sam_get_opportunity.`,
          );
        } else {
          enrichmentNotes.push(
            "GSA-CSV enrichment ran but filled no fields on this page (the matched snapshot rows carried no non-empty naics/set-aside/place-of-performance) — values remain null; fetch sam_get_opportunity.",
          );
        }
        if (outcome.missingCount > 0) {
          enrichmentNotes.push(
            `${outcome.missingCount} of ${data.returned} results were not in the current CSV snapshot (too new or archived) — their naics/set-aside/PoP remain null; fetch sam_get_opportunity for those noticeIds.`,
          );
        }
        enrichmentNotes.push(
          `GSA CSV freshness — snapshot last-modified: ${outcome.freshness.csvLastModified ?? "unknown"}; index built: ${outcome.freshness.indexBuiltAt}; index age: ${outcome.freshness.indexAgeHours ?? "unknown"}h. The snapshot can lag the live HAL by up to ~24h.`,
        );
      } else if (data.returned > 0) {
        // THE GATED BRANCH (the fix): only disclose warming when rows exist that
        // COULD be enriched. returned===0 falls through with the plain source.
        source = "sam.gov/sgs/v1 (keyless HAL) + gsa-csv (index warming)";
        enrichmentNotes.push(
          "GSA-CSV enrichment pending — the CSV index is warming (a background download/build was kicked off); naics/set-aside/place-of-performance were NOT enriched this call. Retry shortly for an enriched page, or fetch sam_get_opportunity now.",
        );
      }
    }

    // The handler's filter-honesty note branch (returned>0/empty both add ONE of
    // these; neither mentions enrichment) then the enrichment notes.
    const notes = [];
    notes.push(
      "naics/setAside/placeOfPerformance are null because the keyless list endpoint omits those values — call sam_get_opportunity for a notice to obtain them.",
    );
    notes.push(...enrichmentNotes);

    const meta = buildMeta({
      source,
      keylessMode: true,
      truncated: totalRecords > data.returned,
      returned: data.returned,
      totalAvailable: totalRecords,
      filtersApplied: [],
      filtersDropped: [],
      fieldsUnavailable,
      notes,
    });
    return { source, notes, fieldsUnavailable, freshness, meta, opportunities: enrichedOpps };
  };

  // A warm ReadyIndex over ONE notice (the same hand-built shape §2b uses), so
  // the returned>0 warm path exercises the REAL enrichSearchOpportunities.
  const FIELDS = (o = {}) => ({
    title: "", type: "", setAsideCode: "", setAside: "", responseDeadline: "",
    naicsCode: "", popCity: "", popState: "", popZip: "", popCountry: "", active: "",
    ...o,
  });
  const warmSnapshot = new Map([
    ["aaaa0000aaaa0000aaaa0000aaaa0001", FIELDS({ naicsCode: "541512", setAsideCode: "SBA", type: "Solicitation" })],
  ]);
  const warmIndex = {
    get: (id) => warmSnapshot.get((id ?? "").trim().toLowerCase()),
    csvLastModified: "Wed, 02 Jul 2026 06:00:00 GMT",
    indexBuiltAt: new Date().toISOString(),
    rowCount: warmSnapshot.size,
  };

  // ── (a) THE FIX, via the REAL runTool: ENABLED + GENUINELY-EMPTY page
  // (returned===0) ⇒ NO "index warming" source suffix and NO "retry … for an
  // enriched page" note. We enable the CSV backbone (SAM_GOV_ENABLE_CSV=1) and
  // call runTool("sam_search_opportunities", …) over a mocked SGS HAL that
  // returns a healthy 200 with page.totalElements=0. On the empty page the
  // wrapper's `returned>0 ? tryGetReadyIndex(…) : null` ternary short-circuits →
  // tryGetReadyIndex is NEVER called (no background warm, no network, no disk),
  // and the gated `else if (returned>0)` is skipped → the plain, un-warmed
  // result. A regression that re-emits the warming suffix/note on an empty page
  // turns this RED. The env flag is restored in the finally.
  {
    const sgsEmpty = (u) =>
      isSgs(u)
        ? mockResponse({ status: 200, json: { page: { totalElements: 0 }, _embedded: { results: [] } } })
        : failClosed()();
    const prevEnable = process.env.SAM_GOV_ENABLE_CSV;
    process.env.SAM_GOV_ENABLE_CSV = "1";
    try {
      await withFetch(sgsEmpty, async () => {
        const sam = new SamGovClient({});
        const bundle = await runTool("sam_search_opportunities", { query: "nomatchxyz" }, sam);
        const m = buildMeta(bundle.meta);
        ok("empty-page (returned===0, REAL runTool, CSV enabled) ⇒ source has NO '(index warming)' suffix",
          !/index warming/i.test(bundle.meta.source) &&
          bundle.meta.source === "sam.gov/sgs/v1 (keyless HAL)",
          JSON.stringify(bundle.meta.source));
        ok("empty-page (REAL runTool) ⇒ NO 'index warming'/'Retry … enriched page' note (nothing to enrich)",
          !(bundle.meta.notes ?? []).some((n) => /index is warming|enriched page|enrichment pending/i.test(n)),
          JSON.stringify(bundle.meta.notes));
        ok("empty-page (REAL runTool) ⇒ _meta.source carries no warming suffix; complete:true (real, complete zero)",
          !/index warming/i.test(m.source) && m.complete === true && bundle.data.returned === 0,
          JSON.stringify({ source: m.source, complete: m.complete, returned: bundle.data.returned }));
      });
    } finally {
      if (prevEnable === undefined) delete process.env.SAM_GOV_ENABLE_CSV;
      else process.env.SAM_GOV_ENABLE_CSV = prevEnable;
    }
  }

  // ── (b) UNCHANGED behavior: ENABLED + COLD index + NON-EMPTY page (returned>0)
  // ⇒ the warming disclosure STILL fires (rows exist that could be enriched). This
  // guards that the fix suppresses ONLY the empty-page case, not the real one.
  {
    const r = assembleEnrichment({
      data: { returned: 1, opportunities: [{ noticeId: "zzz", title: "T", responseDeadline: null, naics: null, setAside: null }] },
      enabled: true,
      readyIndex: null, // cold
      totalRecords: 1,
    });
    ok("non-empty cold page (returned>0) ⇒ source DOES carry '(index warming)' (unchanged)",
      /index warming/i.test(r.source), JSON.stringify(r.source));
    ok("non-empty cold page ⇒ the warming/'retry for an enriched page' note IS present (unchanged)",
      r.notes.some((n) => /index is warming/i.test(n) && /enriched page/i.test(n)),
      JSON.stringify(r.notes));
  }

  // ── (c) SANITY: ENABLED + WARM index + NON-EMPTY page ⇒ the healthy enriched
  // path is untouched by the gating change (real enrichSearchOpportunities fills
  // naics/setAside; source is the enriched source, NOT warming).
  {
    const r = assembleEnrichment({
      data: {
        returned: 1,
        opportunities: [{ noticeId: "aaaa0000aaaa0000aaaa0000aaaa0001", title: "HAL A", responseDeadline: null, naics: null, setAside: null }],
      },
      enabled: true,
      readyIndex: warmIndex,
      totalRecords: 1,
    });
    ok("warm non-empty page ⇒ enriched source (NOT warming), fields filled from CSV",
      /daily bulk CSV snapshot/.test(r.source) && !/index warming/i.test(r.source) &&
      r.opportunities[0].naics === "541512" && r.opportunities[0].setAside === "SBA",
      JSON.stringify({ source: r.source, naics: r.opportunities[0].naics }));
    ok("warm non-empty page ⇒ an enrichment 'filled fields' note present (healthy path intact)",
      r.notes.some((n) => /enriched from the GSA daily bulk CSV/i.test(n)),
      JSON.stringify(r.notes));
  }

  // ── (d) DISABLED CSV (default) + empty page ⇒ plain un-enriched result, no
  // enrichment note at all (the disabled path is unaffected by the fix).
  {
    const r = assembleEnrichment({
      data: { returned: 0, opportunities: [] },
      enabled: false,
      readyIndex: null,
      totalRecords: 0,
    });
    ok("disabled + empty page ⇒ plain HAL source, no enrichment/warming note",
      r.source === "sam.gov/sgs/v1 (keyless HAL)" &&
      !r.notes.some((n) => /index is warming|enriched page|gsa csv/i.test(n)),
      JSON.stringify({ source: r.source, notes: r.notes }));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
// Grants.gov (grants_search / grants_get_opportunity) — honest-by-construction
// via fetchWithRetry, now PERMANENTLY guarded (was grep-verified only). Locks:
// an HTTP outage → throws upstream_unavailable (never a silent empty "no grants"
// that an AI reads as "this program has no opportunities"); an application-level
// errorcode → throws; a GENUINE zero (hitCount 0) → honest empty + totalAvailable:0.
async function testGrantsHonesty() {
  section("14. grants.gov search/fetch outage-vs-genuine-zero honesty (fetch-mock)");
  const isSearch = (u) => /api\.grants\.gov\/.*search2/.test(u);
  const isFetch = (u) => /api\.grants\.gov\/.*fetchOpportunity/.test(u);

  // 1. HTTP 503 ⇒ throws upstream_unavailable (NOT a fabricated empty result)
  await withFetch(
    (u) => (isSearch(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => searchGrants({ keyword: "flood" }));
      ok("grants search 503 ⇒ throws upstream_unavailable (NOT a fake empty 'no grants')",
        threw && error?.toolError?.kind === "upstream_unavailable", JSON.stringify(error?.toolError));
    },
  );

  // 2. 200 body carrying an application errorcode ⇒ throws (app failure, not empty)
  await withFetch(
    (u) => (isSearch(u) ? mockResponse({ status: 200, json: { errorcode: 1, msg: "bad request" } }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => searchGrants({ keyword: "x" }));
      ok("grants search 200+errorcode ⇒ throws (app error surfaced, not silent empty)",
        threw && /Grants\.gov error/i.test(error?.message ?? ""), JSON.stringify(error?.message));
    },
  );

  // 3. GENUINE zero (hitCount 0) ⇒ honest empty + totalAvailable:0, truncated:false
  await withFetch(
    (u) => (isSearch(u) ? mockResponse({ status: 200, json: { errorcode: 0, data: { hitCount: 0, oppHits: [] } } }) : failClosed()()),
    async () => {
      const res = await searchGrants({ keyword: "zzznotarealprogram" });
      ok("grants search genuine-zero ⇒ honest empty grants[] (a real no-match)",
        Array.isArray(res.data.grants) && res.data.grants.length === 0, JSON.stringify(res.data.grants));
      ok("grants search genuine-zero ⇒ _meta.totalAvailable 0 + truncated false (distinct from an outage)",
        res.meta.totalAvailable === 0 && res.meta.truncated === false, JSON.stringify(res.meta));
    },
  );

  // 4. 200 with results ⇒ maps + totalAvailable = hitCount, truncated when returned < total.
  // GRANT-2: search2 returns the real agency NAME in `agency` (agencyName is empty),
  // so agencyName must map from `agency`. The mock mirrors the live shape.
  await withFetch(
    (u) => (isSearch(u) ? mockResponse({ status: 200, json: { errorcode: 0, data: { hitCount: 42, oppHits: [
      { id: "GR1", number: "DHS-24-001", title: "Flood Mitigation", agencyCode: "DHS-FEMA", agency: "Federal Emergency Management Agency", oppStatus: "posted", cfdaList: ["97.039"] },
    ] } } }) : failClosed()()),
    async () => {
      const res = await searchGrants({ keyword: "flood", rows: 1 });
      ok("grants search results ⇒ maps grant (id/number/title/cfdaList)",
        res.data.grants.length === 1 && res.data.grants[0].id === "GR1" &&
        res.data.grants[0].opportunityNumber === "DHS-24-001" && res.data.grants[0].cfdaList[0] === "97.039",
        JSON.stringify(res.data.grants[0]));
      ok("grants search results ⇒ GRANT-2: agencyName from the `agency` field (real name), NOT the empty agencyName",
        res.data.grants[0].agencyName === "Federal Emergency Management Agency", JSON.stringify(res.data.grants[0].agencyName));
      ok("grants search results ⇒ totalAvailable=42 (real total) + truncated true (1<42)",
        res.meta.totalAvailable === 42 && res.meta.truncated === true, JSON.stringify(res.meta));
      // VQ-1 (C82 dogfooding): Grants.gov OR-tokenizes multi-word keywords (broadens,
      // not narrows). Disclose it so an agent doesn't read a broad set as "no grants".
      const multi = await searchGrants({ keyword: "cybersecurity information technology", rows: 1 });
      ok("VQ-1 multi-word keyword ⇒ _meta discloses Grants.gov OR-matches (BROADENS) + pass ONE specific term + phrase-quote returns 0",
        (multi.meta.notes || []).some((n) => /OR-matches multi-word/i.test(n) && /BROADEN/i.test(n) && /ONE specific/i.test(n)),
        JSON.stringify(multi.meta.notes));
      const single = await searchGrants({ keyword: "cybersecurity", rows: 1 });
      ok("VQ-1 single-word keyword ⇒ NO OR-match broadening note (fires only for multi-word)",
        !(single.meta.notes || []).some((n) => /OR-matches multi-word/i.test(n)),
        JSON.stringify(single.meta.notes));
    },
  );
  // VQ-1 F1/F2 (adversarial review, result-aware): a multi-word keyword that returns 0
  // must NOT say "broad set ≠ no grants" (there is no set); a quote-wrapped keyword (0
  // because Grants.gov has no phrase quoting) must say "remove the quotes", not "broadens".
  await withFetch(
    (u) => (isSearch(u) ? mockResponse({ status: 200, json: { errorcode: 0, data: { hitCount: 0, oppHits: [] } } }) : failClosed()()),
    async () => {
      const zero = await searchGrants({ keyword: "aardvark zzznonexistent", rows: 1 });
      ok("VQ-1 F2: multi-word keyword with 0 results ⇒ '0 results / try terms separately' guidance, NOT the 'broadens' note",
        (zero.meta.notes || []).some((n) => /returned 0 results/i.test(n) && /separately/i.test(n)) && !(zero.meta.notes || []).some((n) => /BROADEN/i.test(n)),
        JSON.stringify(zero.meta.notes));
      const quoted = await searchGrants({ keyword: '"cybersecurity information technology"', rows: 1 });
      ok("VQ-1 F1: quote-wrapped keyword returning 0 ⇒ 'REMOVE the quotes' hint, no self-contradicting 'broadens'",
        (quoted.meta.notes || []).some((n) => /REMOVE the quotes/i.test(n)) && !(quoted.meta.notes || []).some((n) => /BROADEN/i.test(n)),
        JSON.stringify(quoted.meta.notes));
    },
  );

  // 5. getGrant detail 503 ⇒ throws upstream_unavailable (never a hollow record)
  await withFetch(
    (u) => (isFetch(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => getGrant({ opportunityId: "123456" }));
      ok("grants getGrant 503 ⇒ throws upstream_unavailable (detail outage, not a fabricated record)",
        threw && error?.toolError?.kind === "upstream_unavailable", JSON.stringify(error?.toolError));
    },
  );

  // 6. GRANT-1: getGrant of a NONEXISTENT id — Grants.gov returns errorcode:0
  // ("Webservice Succeeds") + a HOLLOW data object (no id/title/synopsis; live-
  // verified). The tool must return found:false, NOT a fabricated grant with
  // id:0 / title:"". NON-VACUITY: the old code mapped the hollow data and
  // returned {id:0, title:"", ...} with no found flag → this assertion RED.
  await withFetch(
    (u) => (isFetch(u) ? mockResponse({ status: 200, json: { errorcode: 0, msg: "Webservice Succeeds", data: { revision: 0, flag2006: "N", cfdas: [], synopsisAttachmentFolders: [] } } }) : failClosed()()),
    async () => {
      const res = await getGrant({ opportunityId: "999999999" });
      ok("grants getGrant nonexistent ⇒ found:false (hollow 200 is NOT a fabricated grant)",
        res.found === false && res.opportunityId === "999999999" && res.id === undefined && res.title === undefined,
        JSON.stringify(res));
    },
  );

  // 7. getGrant of a REAL id — errorcode:0 + populated data ⇒ found:true + mapped
  // fields. GRANT-2: synopsis.agencyName is the CONTACT PERSON (live-verified); the
  // real agency is in agencyDetails (subtier) + topAgencyDetails (department). The
  // mock mirrors that live shape.
  await withFetch(
    (u) => (isFetch(u) ? mockResponse({ status: 200, json: { errorcode: 0, msg: "Webservice Succeeds", data: {
      id: 332894, opportunityNumber: "W911NF21S0009", opportunityTitle: "LPS Qubit Collaboratory",
      synopsis: {
        synopsisDesc: "…", responseDate: "2026-09-01", awardCeiling: 1000000,
        agencyName: "Andrew Day\nGrants/Agreements Officer", // the CONTACT PERSON (the mislabel)
        agencyContactName: "Andrew Day\nGrants/Agreements Officer",
        agencyDetails: { agencyName: "Dept of the Army -- Materiel Command" },
        topAgencyDetails: { agencyName: "Department of Defense" },
      },
      cfdas: [{ cfdaNumber: "12.431", programTitle: "Basic Research" }],
    } } }) : failClosed()()),
    async () => {
      const res = await getGrant({ opportunityId: "332894" });
      ok("grants getGrant real id ⇒ found:true + fields mapped (id/number/title/responseDate/cfda)",
        res.found === true && res.id === 332894 && res.title === "LPS Qubit Collaboratory" &&
        res.responseDate === "2026-09-01" && res.awardCeiling === 1000000 && res.cfdaPrograms[0].number === "12.431",
        JSON.stringify({ f: res.found, id: res.id, t: res.title }));
      ok("grants getGrant ⇒ GRANT-2: agency.name = REAL agency (subtier), NOT the contact person",
        res.agency.name === "Dept of the Army -- Materiel Command" && res.agency.name !== "Andrew Day\nGrants/Agreements Officer",
        JSON.stringify(res.agency));
      ok("grants getGrant ⇒ GRANT-2: agency.department = top-tier agency; contactName preserves the person the old `name` held (newline collapsed to ' — ')",
        res.agency.department === "Department of Defense" && res.agency.contactName === "Andrew Day — Grants/Agreements Officer",
        JSON.stringify(res.agency));
    },
  );

  // 8. GRANT-2 (review item 2): a sparse-synopsis record with agencyDetails ONLY at
  // the TOP level (data.agencyDetails, not synopsis.agencyDetails) — the name must
  // still resolve from the top-level fallback, NOT null. NON-VACUITY: dropping the
  // d.agencyDetails fallback makes agency.name null here → RED.
  await withFetch(
    (u) => (isFetch(u) ? mockResponse({ status: 200, json: { errorcode: 0, data: {
      id: 400001, opportunityNumber: "FORECAST-1", opportunityTitle: "Forecasted Program",
      agencyDetails: { agencyName: "Health Resources and Services Administration" },
      topAgencyDetails: { agencyName: "Department of Health and Human Services" },
      synopsis: { synopsisDesc: "forecast" }, // sparse: no agencyDetails under synopsis
    } } }) : failClosed()()),
    async () => {
      const res = await getGrant({ opportunityId: "400001" });
      ok("grants getGrant ⇒ GRANT-2 top-level fallback: agency.name from data.agencyDetails when synopsis lacks it (NOT null)",
        res.agency.name === "Health Resources and Services Administration" && res.agency.department === "Department of Health and Human Services",
        JSON.stringify(res.agency));
    },
  );
}

// Federal Register (fed_register_search / fed_register_get_document) — honest-by-
// construction via fetchWithRetry (all 3 fns share fetchJson), now PERMANENTLY
// guarded. Locks: outage → throws upstream_unavailable (never a silent empty "no
// rules"); a genuine 404 on a document → throws not_found (distinct from an
// outage); a genuine zero (count 0) → honest empty + totalAvailable:0.
async function testFederalRegisterHonesty() {
  section("15. federalregister.gov search/get outage-vs-genuine-zero honesty (fetch-mock)");
  const isSearch = (u) => /federalregister\.gov\/api\/v1\/documents\.json/.test(u);
  const isDoc = (u) => /federalregister\.gov\/api\/v1\/documents\/[^/]+\.json/.test(u);

  // 1. search 503 ⇒ throws upstream_unavailable (NOT a fabricated empty result)
  await withFetch(
    (u) => (isSearch(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => fedRegSearch({ query: "acquisition" }));
      ok("fedreg search 503 ⇒ throws upstream_unavailable (NOT a fake empty 'no documents')",
        threw && error?.toolError?.kind === "upstream_unavailable", JSON.stringify(error?.toolError));
    },
  );

  // 2. GENUINE zero (count 0) ⇒ honest empty + totalAvailable:0, truncated:false
  await withFetch(
    (u) => (isSearch(u) ? mockResponse({ status: 200, json: { count: 0, total_pages: 0, results: [] } }) : failClosed()()),
    async () => {
      const res = await fedRegSearch({ query: "zzznotarealrule" });
      ok("fedreg search genuine-zero ⇒ honest empty documents[] (a real no-match)",
        Array.isArray(res.data.documents) && res.data.documents.length === 0, JSON.stringify(res.data.documents));
      ok("fedreg search genuine-zero ⇒ _meta.totalAvailable 0 + truncated false (distinct from an outage)",
        res.meta.totalAvailable === 0 && res.meta.truncated === false, JSON.stringify(res.meta));
    },
  );

  // 3. results ⇒ maps + TYPE_MAP + totalAvailable = count, truncated when returned<count
  await withFetch(
    (u) => (isSearch(u) ? mockResponse({ status: 200, json: { count: 57, total_pages: 6, results: [
      { document_number: "2024-12345", title: "Small Business Set-Aside Rule", type: "Proposed Rule", publication_date: "2024-06-01", agencies: [{ name: "Department of Defense", slug: "defense-department" }] },
    ] } }) : failClosed()()),
    async () => {
      const res = await fedRegSearch({ query: "set-aside", perPage: 1 });
      const d0 = res.data.documents[0];
      ok("fedreg search results ⇒ maps doc (documentNumber/title/type via TYPE_MAP/agencies)",
        res.data.documents.length === 1 && d0.documentNumber === "2024-12345" &&
        d0.type === "PRORULE" && d0.typeDisplay === "Proposed Rule" && d0.agencies[0].slug === "defense-department",
        JSON.stringify(d0));
      ok("fedreg search results ⇒ totalAvailable=57 (real total) + truncated true (1<57)",
        res.meta.totalAvailable === 57 && res.meta.truncated === true, JSON.stringify(res.meta));
    },
  );

  // 3b. FEDREG-1: SATURATED count — the FR API HARD-CAPS `count` at 10,000, so any
  // broad query (incl. the no-term "all documents ever" query — the FR has millions)
  // returns exactly 10,000. That is a FLOOR (≥10,000), NOT an exact total:
  // totalAvailable must be null (unknown exact) + a totalRecordsSaturated flag + a
  // disclosing note — never 10000 presented as the real count. NON-VACUITY: the old
  // code reported totalAvailable:10000 (as if exact) → this turns RED.
  await withFetch(
    (u) => (isSearch(u) ? mockResponse({ status: 200, json: { count: 10000, total_pages: 50, results: [
      { document_number: "2026-1", title: "Doc", type: "Notice", publication_date: "2026-01-01", agencies: [] },
    ] } }) : failClosed()()),
    async () => {
      const res = await fedRegSearch({ query: "medicare", perPage: 1 });
      ok("fedreg saturated count(10000) ⇒ _meta.totalAvailable null (NOT 10000 — capped, unknown exact) + truncated true",
        res.meta.totalAvailable === null && res.meta.truncated === true, JSON.stringify(res.meta));
      ok("fedreg saturated ⇒ data.totalRecordsSaturated + totalPagesSaturated true + note discloses BOTH caps (count ≥10,000, pages ≥50)",
        res.data.totalRecordsSaturated === true && res.data.totalPagesSaturated === true &&
        res.meta.notes.some((n) => /caps its match count at 10,000/.test(n) && /total_pages at 50/.test(n) && /AT LEAST/.test(n)),
        JSON.stringify({ sat: res.data.totalRecordsSaturated, pgSat: res.data.totalPagesSaturated, notes: res.meta.notes }));
    },
  );

  // 4. getDocument 503 ⇒ throws upstream_unavailable (outage, not a hollow record)
  await withFetch(
    (u) => (isDoc(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => fedRegGet("2024-12345"));
      ok("fedreg getDocument 503 ⇒ throws upstream_unavailable (never a fabricated record)",
        threw && error?.toolError?.kind === "upstream_unavailable", JSON.stringify(error?.toolError));
    },
  );

  // 5. getDocument 404 ⇒ throws not_found (genuine missing doc, distinct from outage)
  await withFetch(
    (u) => (isDoc(u) ? mockResponse({ status: 404 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => fedRegGet("0000-00000"));
      ok("fedreg getDocument 404 ⇒ throws not_found (genuine miss, distinct from an outage)",
        threw && error?.toolError?.kind === "not_found", JSON.stringify(error?.toolError));
    },
  );
}

// Pricing — wage determinations (sam_search_wage_determinations / sam_get_wage_rates),
// keyless via SAM SGS (index=sca/dbra) + WDOL, now PERMANENTLY guarded. Both route
// through getJson→fetchWithRetry. Locks: search outage → throws upstream_unavailable
// (never a fake "no WDs"); genuine zero (page.totalElements 0) → honest empty +
// totalAvailable:0; getWageRates outage → throws; a hollow-200 (empty WD document)
// → throws schema_drift (an unreadable WD must NEVER read as an empty rate table);
// a 404 → throws not_found (distinct from an outage).
async function testPricingHonesty() {
  section("16. pricing wage-determination search/rates outage-vs-genuine-zero honesty (fetch-mock)");
  const isWdSearch = (u) => /sgs\/v1\/search.*index=(sca|dbra)/.test(u);
  const isWdDetail = (u) => /wdol\/v1\/wd\/[^/]+\/\d+/.test(u);

  // 1. WD search 503 ⇒ throws upstream_unavailable (never a fabricated empty result)
  await withFetch(
    (u) => (isWdSearch(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => searchWageDeterminations({ coverage: "sca" }));
      ok("pricing WD search 503 ⇒ throws upstream_unavailable (NOT a fake empty 'no WDs')",
        threw && error?.toolError?.kind === "upstream_unavailable", JSON.stringify(error?.toolError));
    },
  );

  // 2. GENUINE zero (page.totalElements 0) ⇒ honest empty + totalAvailable:0, truncated:false
  await withFetch(
    (u) => (isWdSearch(u) ? mockResponse({ status: 200, json: { _embedded: { results: [] }, page: { totalElements: 0 } } }) : failClosed()()),
    async () => {
      const res = await searchWageDeterminations({ coverage: "sca" });
      ok("pricing WD search genuine-zero ⇒ honest empty determinations[] (a real no-match)",
        Array.isArray(res.data.determinations) && res.data.determinations.length === 0, JSON.stringify(res.data.determinations));
      ok("pricing WD search genuine-zero ⇒ _meta.totalAvailable 0 + truncated false (distinct from outage)",
        res.meta.totalAvailable === 0 && res.meta.truncated === false, JSON.stringify(res.meta));
    },
  );

  // 3. results ⇒ maps + totalAvailable = totalElements, truncated when returned<total
  await withFetch(
    (u) => (isWdSearch(u) ? mockResponse({ status: 200, json: { _embedded: { results: [
      { fullReferenceNumber: "2015-4281", shortReferenceNumber: "VA281", type: { code: "SCA", value: "Service Contract Act" }, title: "VA SCA WD", isActive: true, isStandard: true },
    ] }, page: { totalElements: 30 } } }) : failClosed()()),
    async () => {
      const res = await searchWageDeterminations({ coverage: "sca", limit: 1 });
      const d0 = res.data.determinations[0];
      ok("pricing WD search results ⇒ maps determination (fullReferenceNumber/coverage/isActive)",
        res.data.determinations.length === 1 && d0.fullReferenceNumber === "2015-4281" &&
        d0.coverage === "SCA" && d0.isActive === true, JSON.stringify(d0));
      ok("pricing WD search results ⇒ totalAvailable=30 (real total) + truncated true (1<30)",
        res.meta.totalAvailable === 30 && res.meta.truncated === true, JSON.stringify(res.meta));
    },
  );

  // 4. getWageRates detail 503 (explicit revision skips history) ⇒ throws upstream_unavailable
  await withFetch(
    (u) => (isWdDetail(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => getWageRates({ reference: "2015-4281", revision: 5 }));
      ok("pricing getWageRates detail 503 ⇒ throws upstream_unavailable (outage, not fabricated rates)",
        threw && error?.toolError?.kind === "upstream_unavailable", JSON.stringify(error?.toolError));
    },
  );

  // 5. getWageRates hollow-200 (empty WD document) ⇒ throws schema_drift (never empty rates)
  await withFetch(
    (u) => (isWdDetail(u) ? mockResponse({ status: 200, json: { document: "" } }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => getWageRates({ reference: "2015-4281", revision: 5 }));
      ok("pricing getWageRates empty-document ⇒ throws schema_drift (hollow-200 never reads as empty rate table)",
        threw && error?.toolError?.kind === "schema_drift", JSON.stringify(error?.toolError));
    },
  );

  // 6. getWageRates detail 404 ⇒ throws not_found (genuine missing WD, distinct from outage)
  await withFetch(
    (u) => (isWdDetail(u) ? mockResponse({ status: 404 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => getWageRates({ reference: "0000-0000", revision: 1 }));
      ok("pricing getWageRates detail 404 ⇒ throws not_found (genuine miss, distinct from an outage)",
        threw && error?.toolError?.kind === "not_found", JSON.stringify(error?.toolError));
    },
  );
}

// GAO protests (gao_protest_lookup) — HTML/RSS-scraped (getText→fetchWithRetry→
// .text()), now PERMANENTLY guarded, completing the test-robustness axis (4/4).
// Locks: feed outage → throws upstream_unavailable (never a fake "no protests");
// a genuine-empty feed (reachable, 0 items) → honest empty decisions[]; and gao's
// structural honesty — it ALWAYS reports complete:false + totalAvailable:null
// (the keyless RSS is a recent ~25-item window, never the full protest history).
async function testGaoHonesty() {
  section("17. gao.gov protest feed outage-vs-genuine-empty honesty (fetch-mock)");
  const isFeed = (u) => /gao\.gov\/rss\/reportslegal\.xml/.test(u);
  const rss = (items) => `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
  const protestItem = `<item><title>Acme Corp</title><link>https://www.gao.gov/products/b-421234</link><description>Acme Corp protests the award of a contract for widgets.</description><pubDate>Mon, 01 Jul 2024 00:00:00 GMT</pubDate></item>`;

  // 1. Feed 503 ⇒ throws upstream_unavailable (never a fabricated empty protest list)
  await withFetch(
    (u) => (isFeed(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const { threw, error } = await expectThrow(() => gaoProtestLookup({}));
      ok("gao feed 503 ⇒ throws upstream_unavailable (NOT a fake empty 'no protests')",
        threw && error?.toolError?.kind === "upstream_unavailable", JSON.stringify(error?.toolError));
    },
  );

  // 2. GENUINE-empty feed (reachable, valid XML, 0 items) ⇒ honest empty decisions[]
  await withFetch(
    (u) => (isFeed(u) ? mockResponse({ status: 200, json: rss("") }) : failClosed()()),
    async () => {
      const res = await gaoProtestLookup({});
      ok("gao genuine-empty feed ⇒ honest empty decisions[] (feed reachable, no matches — not an outage)",
        Array.isArray(res.data.decisions) && res.data.decisions.length === 0, JSON.stringify(res.data.decisions));
    },
  );

  // 3. Feed with a protest item, enrich:false ⇒ maps feed-only decision + ALWAYS honest-partial
  await withFetch(
    (u) => (isFeed(u) ? mockResponse({ status: 200, json: rss(protestItem) }) : failClosed()()),
    async () => {
      const res = await gaoProtestLookup({ enrich: false });
      const d0 = res.data.decisions[0];
      ok("gao feed results (enrich:false) ⇒ maps feed-only decision (bNumber/title from RSS)",
        res.data.decisions.length === 1 && d0.bNumber === "B-421234" && d0.title === "Acme Corp",
        JSON.stringify(d0));
      ok("gao ⇒ ALWAYS complete:false + totalAvailable:null + truncated (recent-window feed ≠ full protest history)",
        res.meta.complete === false && res.meta.totalAvailable === null && res.meta.truncated === true,
        JSON.stringify(res.meta));
    },
  );
}

// Deterministic seeded PRNG (mulberry32) — reproducible fuzz in CI (Math.random
// would make failures non-reproducible). The hand-rolled parsers (DOCX ZIP,
// GSA-CSV, GAO RSS) all parse UNTRUSTED bytes; a crash/hang/OOB on hostile input
// is a real Sev2 defect. Invariant under fuzz: return a sane result OR throw a
// CLASSIFIED ToolErrorCarrier — never an uncaught RangeError/raw-throw/hang.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function testParserFuzz() {
  section("18. parser fuzz — hostile/malformed bytes never crash/hang/OOB (deterministic seeded)");
  const rnd = mulberry32(0x5a3c9e17);
  const rint = (n) => Math.floor(rnd() * n);
  const rbytes = (n) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = rint(256); return a; };
  const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
  const validDocx = buildDocxFixture("<w:body><w:p><w:t>hello fuzz world</w:t></w:p></w:body>");

  // ── (a) DOCX / ZIP parser via the REAL fetchAttachmentText path ──
  let fuzzBytes = new Uint8Array(0);
  const docxIters = 700;
  const docxBad = [];
  await withFetch(
    () => mockBinaryResponse({
      status: 200, bytes: fuzzBytes,
      headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="fuzz.docx"' },
    }),
    async () => {
      for (let i = 0; i < docxIters; i++) {
        const strat = i % 5;
        if (strat === 0) fuzzBytes = rbytes(rint(2048));                                    // pure garbage
        else if (strat === 1) fuzzBytes = _concatBytes([zipMagic, rbytes(rint(1024))]);     // PK magic + garbage
        else if (strat === 2) { const m = validDocx.slice(); const f = 1 + rint(30); for (let k = 0; k < f; k++) m[rint(m.length)] = rint(256); fuzzBytes = m; } // bit-flip valid
        else if (strat === 3) fuzzBytes = validDocx.slice(0, rint(validDocx.length + 1));   // truncate
        else { const m = validDocx.slice(); for (let k = 0; k < 8; k++) m[m.length - 1 - rint(Math.min(30, m.length))] = rint(256); fuzzBytes = m; } // corrupt EOCD/CD tail
        try {
          const r = await fetchAttachmentText({ url: SAM_ATT_URL });
          if (!r || !r.data || (r.data.text !== null && typeof r.data.text !== "string")) docxBad.push({ i, why: "bad-shape", strat });
        } catch (e) {
          if (!(e && e.toolError)) docxBad.push({ i, why: "unclassified:" + String(e && e.message).slice(0, 70), strat });
        }
      }
    },
  );
  ok(`DOCX/ZIP fuzz ${docxIters} malformed inputs ⇒ 0 crashes (sane result or classified error only)`,
    docxBad.length === 0, JSON.stringify(docxBad.slice(0, 4)));

  // ── (b) GSA-CSV parseRecordFields (exported; pure linear loop — confirm no throw) ──
  const csvIters = 700;
  const csvBad = [];
  for (let i = 0; i < csvIters; i++) {
    const cells = rint(8);
    const parts = [];
    for (let c = 0; c < cells; c++) {
      const kind = rint(6);
      if (kind === 0) parts.push('"'.repeat(1 + rint(6)));                 // unbalanced quotes
      else if (kind === 1) parts.push("a".repeat(rint(400)));              // long field
      else if (kind === 2) parts.push('"' + "x,y\n".repeat(rint(20)));     // delimiters inside a quote
      else if (kind === 3) parts.push(String.fromCharCode(rint(0x10000))); // random BMP unicode
      else if (kind === 4) parts.push(",".repeat(rint(30)));              // many delimiters
      else parts.push("\r\n\r".repeat(rint(10)));                          // stray CR/LF
    }
    const line = parts.join(rint(2) ? "," : "");
    try {
      const out = parseRecordFields(line, rint(60));
      if (!out || !Array.isArray(out.fields) || typeof out.inQuotes !== "boolean") csvBad.push({ i, why: "bad-shape" });
    } catch (e) {
      csvBad.push({ i, why: "throw:" + String(e && e.message).slice(0, 60) });
    }
  }
  ok(`CSV parseRecordFields fuzz ${csvIters} malformed inputs ⇒ 0 throws, always {fields[],inQuotes}`,
    csvBad.length === 0, JSON.stringify(csvBad.slice(0, 4)));

  // ── (c) GAO RSS parseFeed via gaoProtestLookup (regex parser — ReDoS/crash guard) ──
  const feedIters = 300;
  const feedBad = [];
  const isFeed = (u) => /gao\.gov\/rss\/reportslegal\.xml/.test(u);
  let feedXml = "";
  await withFetch(
    (u) => (isFeed(u) ? mockResponse({ status: 200, json: feedXml }) : failClosed()()),
    async () => {
      for (let i = 0; i < feedIters; i++) {
        const kind = i % 4;
        if (kind === 0) { let s = "<rss><channel>"; for (let k = 0; k < rint(15); k++) s += "<item>" + "<title>".repeat(rint(6)) + "b-" + rint(999999) + "</link>".repeat(rint(6)); feedXml = s; } // unbalanced tags
        else if (kind === 1) feedXml = "<item>".repeat(rint(200));                          // many opens, no close
        else if (kind === 2) feedXml = "<item>" + "<".repeat(rint(500)) + ">".repeat(rint(500)) + "</item>"; // bracket soup
        else { let s = ""; for (let k = 0; k < rint(1024); k++) s += String.fromCharCode(rint(128)); feedXml = s; } // ascii noise
        try {
          const r = await gaoProtestLookup({ enrich: false, limit: 5 });
          if (!r || !r.data || !Array.isArray(r.data.decisions)) feedBad.push({ i, why: "bad-shape", kind });
        } catch (e) {
          if (!(e && e.toolError)) feedBad.push({ i, why: "unclassified:" + String(e && e.message).slice(0, 60), kind });
        }
      }
    },
  );
  ok(`GAO parseFeed fuzz ${feedIters} malformed RSS ⇒ 0 crashes/hangs, decisions[] always`,
    feedBad.length === 0, JSON.stringify(feedBad.slice(0, 4)));

  // ── (d) far_clause_lookup versioner XML parser (regex tag-strip + <HEAD> extract)
  // over hostile/malformed XML via the REAL tool path (mock titles + versioner-full).
  // far_clause_lookup had 3 real parse bugs historically (C18); the regexes look
  // ReDoS-safe (lazy `[\s\S]*?`, `<[^>]*>`) — this locks that against regression.
  const xmlIters = 400;
  const xmlBad = [];
  let deepParses = 0;
  let xmlBody = "";
  await withFetch(
    (u) => {
      if (isEcfrTitles(u)) return mockResponse({ status: 200, json: TITLES_JSON });
      if (isEcfrFull(u)) return mockResponse({ status: 200, json: xmlBody });
      return failClosed()();
    },
    async () => {
      for (let i = 0; i < xmlIters; i++) {
        const kind = i % 6;
        if (kind === 0) { let s = ""; for (let k = 0; k < rint(600); k++) s += String.fromCharCode(rint(128)); xmlBody = s; } // ascii noise
        else if (kind === 1) xmlBody = "<HEAD>".repeat(1 + rint(80)) + "x";                                                  // many opens, unclosed
        else if (kind === 2) xmlBody = "<".repeat(rint(400)) + ">".repeat(rint(400));                                        // bracket soup (stripXml)
        else if (kind === 3) xmlBody = "<HEAD>" + "a".repeat(rint(2000)) + (rint(2) ? "</HEAD>" : "");                       // huge head, maybe unclosed
        else if (kind === 4) xmlBody = "<?xml?><HEAD>" + "<b>".repeat(rint(60)) + "52.212-4 text " + "</b>".repeat(rint(60)) + "</HEAD>"; // nested tags + valid-ish
        else xmlBody = "<HEAD>&" + "amp;".repeat(rint(120)) + "<![CDATA[" + "]".repeat(rint(120)) + "]]> real clause text here</HEAD>"; // entities/CDATA
        try {
          const r = await farClauseLookup({ clauseNumber: "52.212-4" });
          if (!r || !r.data || typeof r.data !== "object") xmlBad.push({ i, why: "bad-shape", kind });
          else if (r.data.text || r.data.heading) deepParses++; // reached the parse (non-vacuity)
        } catch (e) {
          if (!(e && e.toolError)) xmlBad.push({ i, why: "unclassified:" + String(e && e.message).slice(0, 60), kind });
        }
      }
    },
  );
  ok(`far_clause_lookup versioner XML fuzz ${xmlIters} malformed ⇒ 0 crashes/hangs (result or classified error)`,
    xmlBad.length === 0, JSON.stringify(xmlBad.slice(0, 4)));
  ok(`far XML fuzz non-vacuity ⇒ some inputs reach the deep parse (heading/text extracted, not all early-rejected)`,
    deepParses > 0, `deepParses=${deepParses}/${xmlIters}`);
}

// Metamorphic/property invariants — a lens for LOGIC bugs (wrong answers/
// inconsistencies), which crash-fuzz and happy-path dogfood cannot catch. A
// narrower filter must never INCREASE the result set; the same call twice must
// be identical. A fixed mixed rawset makes narrowing ACTUALLY reduce (the
// non-vacuity assert makes a trivially-passing test impossible).
async function testMetamorphic() {
  section("19. metamorphic/property invariants — far_search filter monotonicity + idempotency");
  const row = (o = {}) => ({
    type: "SECTION",
    hierarchy: { title: "48", chapter: String(o.chapter ?? 1), part: String(o.part ?? 52), section: o.section ?? "52.219-14" },
    hierarchy_headings: { title: "FAR", section: o.heading ?? "heading" },
    full_text_excerpt: o.excerpt ?? "…subcontracting…",
    score: 1, starts_on: "2022-10-28", ends_on: o.ends_on ?? null,
  });
  // 2 FAR (ch1) sections in DIFFERENT parts (52, 19) + 1 DFARS (ch2) section, so
  // scope:both→3, scope:far→2 (drops DFARS), scope:far+partsOnly[52]→1 (drops part-19).
  const RAWSET = [
    row({ chapter: 1, part: 52, section: "52.219-14" }),
    row({ chapter: 1, part: 19, section: "19.809-2", heading: "set-aside" }),
    row({ chapter: 2, part: 252, section: "252.219-7000", heading: "dfars sub" }),
  ];
  const handler = (u) => {
    if (isEcfrTitles(u)) return mockResponse({ status: 200, json: TITLES_JSON });
    if (isEcfrSearchResults(u)) return mockResponse({ status: 200, json: { results: RAWSET, meta: { total_count: RAWSET.length } } });
    return failClosed()();
  };
  let both, far, farP52, farAgain;
  await withFetch(handler, async () => {
    both = await farSearch({ query: "subcontracting", scope: "both" });
    far = await farSearch({ query: "subcontracting", scope: "far" });
    farP52 = await farSearch({ query: "subcontracting", scope: "far", partsOnly: [52] });
    farAgain = await farSearch({ query: "subcontracting", scope: "far" });
  });
  const nBoth = both.data.rows.length, nFar = far.data.rows.length, nP52 = farP52.data.rows.length;
  ok("metamorphic non-vacuity ⇒ narrowing ACTUALLY reduces (both=3 > far=2 > far+part52=1)",
    nBoth === 3 && nFar === 2 && nP52 === 1, JSON.stringify({ nBoth, nFar, nP52 }));
  ok("filter MONOTONICITY ⇒ count(scope:both) ≥ count(scope:far) ≥ count(far+partsOnly[52])",
    nBoth >= nFar && nFar >= nP52, JSON.stringify({ nBoth, nFar, nP52 }));
  ok("scope narrowing correctness ⇒ scope:far drops DFARS(ch2) 252.219-7000; scope:both keeps it",
    !far.data.rows.some((r) => r.section === "252.219-7000") && both.data.rows.some((r) => r.section === "252.219-7000"),
    JSON.stringify(far.data.rows.map((r) => r.section)));
  ok("partsOnly correctness ⇒ far+partsOnly[52] keeps ONLY part-52 (52.219-14), drops part-19",
    nP52 === 1 && farP52.data.rows[0].section === "52.219-14",
    JSON.stringify(farP52.data.rows.map((r) => r.section)));
  ok("IDEMPOTENCY ⇒ far_search(same args, same upstream) twice ⇒ byte-identical rows",
    JSON.stringify(far.data.rows) === JSON.stringify(farAgain.data.rows),
    `n1=${nFar} n2=${farAgain.data.rows.length}`);
}

// getWageRates parses rates best-effort from a WD's PLAIN-TEXT `document` (SAM
// exposes no structured rate JSON). Section 16 only proved the outage/empty/404
// error paths — NOT the actual parse. Here we REPLAY realistic fixed SCA/DBA WD
// document fixtures through the real getWageRates path (revision+coverage passed
// ⇒ deterministic, single detail fetch) and assert parse correctness + the
// TRUTHFULNESS invariants the parser owes an AI consumer:
//   • SCA H&W is the WD-WIDE primary rate, NOT the EO-13706 sick-leave variant.
//   • A poorly-parsed WD self-flags parseConfidence:'low' + steers to raw (never
//     presents partial rows as authoritative).
//   • DBA fringe is PER-CRAFT (distinct per row), not one shared figure.
//   • format:'raw'|'both'|'parsed' honor a strict document/rates contract.
// Every assertion targets a SPECIFIC known value ⇒ a broken regex/parser fails
// (non-vacuous), and the fixtures exercise the pricing parse branches untouched
// by section 16 (parseScaDocument / parseDbaDocument / EO-min / confidence / format).
async function testPricingParseReplay() {
  section("20. pricing WD-document PARSE replay — SCA/DBA rate parsing correctness + truthfulness (fixed-fixture, deterministic)");
  const isWdDetail = (u) => /wdol\/v1\/wd\/[^/]+\/\d+/.test(u);
  const wdDetail = (document) => ({
    document, active: true, standard: true, publishDate: "2024-01-01",
    location: { mapping: [{ state: "IA", counties: ["Polk"], statewideFlag: false }] },
  });
  const detailHandler = (doc) => (u) =>
    isWdDetail(u) ? mockResponse({ status: 200, json: wdDetail(doc) }) : failClosed()();

  // ── A. SCA happy-path: 6 coded rows + WD-wide H&W + EO-14026 floor ⇒ high confidence.
  // Row 27101 carries trailing dot-leaders in the title to exercise the ".replace(/\.+$/)" clean.
  const SCA_DOC = [
    "REGISTER OF WAGE DETERMINATIONS UNDER THE SERVICE CONTRACT ACT",
    "Wage Determination No.: 2015-4281   Revision No.: 5",
    "",
    "OCCUPATION CODE - TITLE                              RATE",
    "01011 - Accounting Clerk I                           16.44",
    "01012 - Accounting Clerk II                          18.46",
    "05360 - Machinist                                    25.71",
    "11150 - Janitor                                      14.10",
    "23370 - General Maintenance Worker                   20.83",
    "27101 - Guard I ....                                 15.62",
    "",
    "ALL OCCUPATIONS LISTED ABOVE RECEIVE THE FOLLOWING BENEFITS:",
    "",
    "HEALTH & WELFARE: $5.36 per hour or $214.40 per week or $929.07 per month",
    "HEALTH & WELFARE EO 13706: $4.57 per hour, or $182.80 per week, or $792.13 per month",
    "",
    "This contract is subject to Executive Order 14026. The contractor must pay",
    "all covered workers at least $17.20 per hour under this contract in 2024.",
  ].join("\n");
  await withFetch(detailHandler(SCA_DOC), async () => {
    const res = await getWageRates({ reference: "2015-4281", revision: 5, coverage: "sca" });
    const rates = res.data.rates;
    ok("SCA parse ⇒ coverage:'SCA' + parses all 6 coded occupation rows",
      res.data.coverage === "SCA" && Array.isArray(rates) && rates.length === 6, JSON.stringify({ cov: res.data.coverage, n: rates?.length }));
    const mach = (rates || []).find((r) => r.code === "05360");
    ok("SCA parse non-vacuity ⇒ code 05360 ⇒ title 'Machinist', baseRate 25.71 (last number on line)",
      !!mach && mach.title === "Machinist" && mach.baseRate === 25.71, JSON.stringify(mach));
    const guard = (rates || []).find((r) => r.code === "27101");
    ok("SCA parse ⇒ trailing dot-leaders stripped from title (27101 ⇒ 'Guard I', not 'Guard I ....')",
      !!guard && guard.title === "Guard I" && guard.baseRate === 15.62, JSON.stringify(guard));
    ok("SCA parse ⇒ every row well-formed (5-digit code, non-empty title, finite +baseRate, no trailing dot)",
      (rates || []).every((r) => /^\d{5}$/.test(r.code) && r.title.length > 0 && !/\.$/.test(r.title) && Number.isFinite(r.baseRate) && r.baseRate > 0), JSON.stringify(rates));
    ok("SCA TRUTHFULNESS ⇒ H&W is the WD-WIDE primary $5.36, NOT the EO-13706 sick-leave $4.57 variant",
      res.data.healthAndWelfarePerHour === 5.36, JSON.stringify(res.data.healthAndWelfarePerHour));
    const eo = res.data.executiveOrderMinimumWage;
    ok("SCA parse ⇒ EO minimum-wage floor read from text (EO 14026 @ $17.20), never hardcoded",
      !!eo && eo.executiveOrder === "EO 14026" && eo.minimumWage === 17.20, JSON.stringify(eo));
    ok("SCA parse ⇒ parseConfidence 'high' (≥5 rows AND H&W found)",
      res.data.parseConfidence === "high", JSON.stringify(res.data.parseConfidence));
    ok("SCA TRUTHFULNESS ⇒ a note states H&W is WD-WIDE (applies to ALL occupations, not per-occupation)",
      (res.meta.notes || []).some((n) => /WD-WIDE Health & Welfare/i.test(n) && /ALL listed occupations/i.test(n)), JSON.stringify(res.meta.notes));
  });

  // ── B. H&W disambiguation TRAP: the EO-13706 $4.57 line appears FIRST. A naive
  // "HEALTH.*WELFARE.*$(rate)" would grab $4.57; the real parser must still pick $5.36.
  const SCA_HW_TRAP = [
    "01011 - Accounting Clerk I                           16.44",
    "05360 - Machinist                                    25.71",
    "11150 - Janitor                                      14.10",
    "23370 - General Maintenance Worker                   20.83",
    "27101 - Guard I                                      15.62",
    "HEALTH & WELFARE EO 13706: $4.57 per hour, or $182.80 per week",
    "HEALTH & WELFARE: $5.36 per hour or $214.40 per week or $929.07 per month",
  ].join("\n");
  await withFetch(detailHandler(SCA_HW_TRAP), async () => {
    const res = await getWageRates({ reference: "2015-4281", revision: 5, coverage: "sca" });
    ok("SCA H&W trap ⇒ EO-13706 line FIRST but parser picks WD-wide $5.36 by CONTENT not order (non-vacuous)",
      res.data.healthAndWelfarePerHour === 5.36 && res.data.rates.length === 5, JSON.stringify({ hw: res.data.healthAndWelfarePerHour, n: res.data.rates.length }));
  });

  // ── C. Low-confidence HONESTY: 2 rows, no H&W, no EO ⇒ must self-flag, never
  // present partial rows as authoritative (mission: 오도 방지 / no misleading output).
  const SCA_SPARSE = [
    "01011 - Accounting Clerk I                           16.44",
    "05360 - Machinist                                    25.71",
  ].join("\n");
  await withFetch(detailHandler(SCA_SPARSE), async () => {
    const res = await getWageRates({ reference: "2015-4281", revision: 5, coverage: "sca" });
    ok("SCA low-confidence ⇒ parseConfidence 'low' (2 rows <5, no H&W) + H&W null + EO null",
      res.data.parseConfidence === "low" && res.data.healthAndWelfarePerHour === null && res.data.executiveOrderMinimumWage === null, JSON.stringify(res.data));
    ok("SCA low-confidence TRUTHFULNESS ⇒ absent fields declared in _meta.fieldsUnavailable (not silent defaults)",
      (res.meta.fieldsUnavailable || []).includes("healthAndWelfarePerHour") && (res.meta.fieldsUnavailable || []).includes("executiveOrderMinimumWage"), JSON.stringify(res.meta.fieldsUnavailable));
    ok("SCA low-confidence TRUTHFULNESS ⇒ a note warns LOW + steers to raw (don't trust the parsed rows)",
      (res.meta.notes || []).some((n) => /parseConfidence is LOW/i.test(n) && /raw/i.test(n)), JSON.stringify(res.meta.notes));
  });

  // ── D. DBA per-craft: ID header + 3 crafts, one with a WRAPPED multi-line label,
  // distinct fringe columns. Proves fringe is PER-CRAFT (not one WD-wide figure).
  const DBA_DOC = [
    "                                    Rates       Fringes",
    "",
    "PLUM0198-005  07/01/2023",
    "",
    "    PLUMBER..........................$ 42.15    24.30",
    "",
    "    ELECTRICIAN......................$ 38.90    18.75",
    "",
    "    BRICKLAYER/STONE MASON: ZONE 1 (The",
    "    Counties of Polk, Warren, and Dallas for",
    "    all Crafts)......................$ 37.44    19.17",
  ].join("\n");
  await withFetch(detailHandler(DBA_DOC), async () => {
    const res = await getWageRates({ reference: "IA20230012", revision: 3, coverage: "dba" });
    const rates = res.data.rates;
    ok("DBA parse ⇒ coverage:'DBA' + 3 craft rows + parseConfidence 'high'",
      res.data.coverage === "DBA" && Array.isArray(rates) && rates.length === 3 && res.data.parseConfidence === "high", JSON.stringify({ cov: res.data.coverage, n: rates?.length, conf: res.data.parseConfidence }));
    const plumber = (rates || []).find((r) => r.craft === "PLUMBER");
    ok("DBA parse non-vacuity ⇒ PLUMBER ⇒ baseRate 42.15, fringe 24.30, rateIdentifier 'PLUM0198-005'",
      !!plumber && plumber.baseRate === 42.15 && plumber.fringePerHour === 24.30 && plumber.rateIdentifier === "PLUM0198-005", JSON.stringify(plumber));
    const fringes = (rates || []).map((r) => r.fringePerHour);
    ok("DBA TRUTHFULNESS ⇒ fringe is PER-CRAFT (3 DISTINCT values 24.30/18.75/19.17, not one shared figure)",
      new Set(fringes).size === 3 && fringes.every((f) => Number.isFinite(f)), JSON.stringify(fringes));
    const brick = (rates || []).find((r) => r.craft === "BRICKLAYER/STONE MASON");
    ok("DBA parse ⇒ WRAPPED multi-line craft label joined into full title (dot-leaders collapsed, scope preserved)",
      !!brick && /Counties of Polk, Warren, and Dallas/.test(brick.title) && !/\.\./.test(brick.title) && /\)$/.test(brick.title) && brick.fringePerHour === 19.17, JSON.stringify(brick));
    ok("DBA TRUTHFULNESS ⇒ a note states fringe is PER-CRAFT (contrast SCA's single WD-wide H&W)",
      (res.meta.notes || []).some((n) => /PER-CRAFT/i.test(n) && /fringePerHour/i.test(n)), JSON.stringify(res.meta.notes));
  });

  // ── E. format METAMORPHIC contract: parsed⇒rates,no document · raw⇒document,no
  // rates,confidence low · both⇒document AND rates. (Same SCA_DOC, only format varies.)
  await withFetch(detailHandler(SCA_DOC), async () => {
    const parsed = await getWageRates({ reference: "2015-4281", revision: 5, coverage: "sca", format: "parsed" });
    ok("format:'parsed' ⇒ data.rates present, data.document ABSENT (no raw blob leaked)",
      Array.isArray(parsed.data.rates) && parsed.data.rates.length === 6 && parsed.data.document === undefined, JSON.stringify({ n: parsed.data.rates?.length, hasDoc: parsed.data.document !== undefined }));
    const raw = await getWageRates({ reference: "2015-4281", revision: 5, coverage: "sca", format: "raw" });
    ok("format:'raw' ⇒ full document returned, NO parsed rates, parseConfidence forced 'low' (no asserted structure)",
      raw.data.document === SCA_DOC && raw.data.rates === undefined && raw.data.parseConfidence === "low", JSON.stringify({ docMatch: raw.data.document === SCA_DOC, hasRates: raw.data.rates !== undefined, conf: raw.data.parseConfidence }));
    const both = await getWageRates({ reference: "2015-4281", revision: 5, coverage: "sca", format: "both" });
    ok("format:'both' ⇒ BOTH document AND parsed rates present (superset contract)",
      both.data.document === SCA_DOC && Array.isArray(both.data.rates) && both.data.rates.length === 6, JSON.stringify({ docMatch: both.data.document === SCA_DOC, n: both.data.rates?.length }));
  });
}

// usas_search_individual_awards paginates the `spending_by_award` endpoint, which
// is CURSOR-style and carries NO grand total in its own page_metadata. The tool's
// truthfulness therefore rests on a COMPANION `spending_by_award_count` query
// (awardCount, sums per-type buckets) for `totalAvailable`, and on awardPagination
// for hasMore/nextOffset. This whole path (awardCount + awardPagination +
// searchIndividualAwards) was UNTESTED. buildMeta's own invariants are covered in
// §1; here we pin the TOOL-LEVEL pagination-truthfulness an AI consumer relies on
// to answer "did I see every award?":
//   • returned === rows.length (meta never overstates what came back)
//   • totalAvailable = companion count, or null on companion failure — NEVER the
//     page length (§3.3: never substitute page size for an unknown total)
//   • totalAvailable is INVARIANT under `limit` (proves it's the true count, not
//     a page-derived number) — a metamorphic check
//   • truncated / pagination.hasMore / complete correctly encode "more exists"
//   • usas_search_awards (share-of-wallet): the B1 fix — award COUNTS are null
//     (not 0), so an AI never reads "0 contracts worth $3.4B" (a self-contradiction)
// All fixtures are fixed rawsets ⇒ deterministic; every assertion pins a specific
// value ⇒ non-vacuous.
async function testUsasPaginationTruthfulness() {
  section("21. usas pagination truthfulness — spending_by_award companion-count + awardPagination + share-of-wallet B1 (fixed-rawset, deterministic)");
  const isAwardCount = (u) => /spending_by_award_count/.test(u);
  const isAwardPage = (u) => /spending_by_award(?!_count)/.test(u);
  const isCatRecipient = (u) => /spending_by_category\/recipient/.test(u);
  const awardRows = (n) => Array.from({ length: n }, (_, i) => ({
    "Award ID": `CONT-${i}`, "Recipient Name": `Recipient ${i}`, "Award Amount": 1000 * (i + 1),
    "Awarding Agency": "DOD", NAICS: { code: "541512", description: "IT" }, generated_internal_id: `CONT_AWD_${i}`,
  }));
  const catRows = (n) => Array.from({ length: n }, (_, i) => ({ name: `Vendor ${i}`, amount: 1_000_000 * (i + 1) })); // amount only — NO count field
  // count:null ⇒ companion endpoint 503s (awardCount catches ⇒ null). count:{...} ⇒ 200 buckets.
  const usasHandler = ({ page = [], hasNext = false, count = null, cat = null }) => (u) => {
    if (isAwardCount(u)) return count === null ? mockResponse({ status: 503 }) : mockResponse({ status: 200, json: { results: count } });
    if (isAwardPage(u)) return mockResponse({ status: 200, json: { results: page, page_metadata: { hasNext } } });
    if (isCatRecipient(u)) return mockResponse({ status: 200, json: { results: cat ?? [] } });
    return failClosed()();
  };

  // NOTE: withMeta returns a MetaBundle carrying the RAW PARTIAL meta; the SERVER
  // finalizes it via buildMeta (server.ts) — that is where `truncated`/`complete`
  // are DERIVED (from totalAvailable/pagination.hasMore). So we finalize the same
  // way the server does and assert on the CONSUMER-VISIBLE meta, not the partial.
  const finalize = (res) => buildMeta(res.meta);

  // S1. total known, full page < total ⇒ truncated + hasMore + nextOffset advance.
  await withFetch(usasHandler({ page: awardRows(10), hasNext: true, count: { contracts: 240, idvs: 10 } }), async () => {
    const res = await searchIndividualAwards({ agency: "DOD", limit: 10 });
    const meta = finalize(res);
    ok("usas individual ⇒ meta.returned === data.awards.length (never overstates rows)",
      meta.returned === 10 && res.data.awards.length === 10, JSON.stringify({ r: meta.returned, n: res.data.awards.length }));
    ok("usas individual TRUTHFULNESS ⇒ totalAvailable = companion count SUM (250), NOT the page length (10)",
      meta.totalAvailable === 250, JSON.stringify(meta.totalAvailable));
    ok("usas individual ⇒ page(10)<total(250) ⇒ truncated + hasMore + nextOffset=10 + complete:false",
      meta.truncated === true && meta.pagination.hasMore === true && meta.pagination.nextOffset === 10 && meta.complete === false, JSON.stringify(meta.pagination));
  });

  // S2. total known, page reaches total ⇒ complete.
  await withFetch(usasHandler({ page: awardRows(3), hasNext: false, count: { contracts: 3 } }), async () => {
    const res = await searchIndividualAwards({ agency: "DOD", limit: 10 });
    const meta = finalize(res);
    ok("usas individual ⇒ returned(3)===total(3) ⇒ truncated:false, hasMore:false, nextOffset:null, complete:true",
      meta.returned === 3 && meta.totalAvailable === 3 && meta.truncated === false &&
      meta.pagination.hasMore === false && meta.pagination.nextOffset === null && meta.complete === true, JSON.stringify(meta));
  });

  // S3. companion count FAILS ⇒ totalAvailable null (NEVER the page length); hasMore
  // falls back to the upstream cursor's own hasNext.
  await withFetch(usasHandler({ page: awardRows(10), hasNext: true, count: null }), async () => {
    const res = await searchIndividualAwards({ agency: "DOD", limit: 10 });
    const meta = finalize(res);
    ok("usas individual TRUTHFULNESS ⇒ companion-count FAIL ⇒ totalAvailable null (NEVER fabricated as page length 10)",
      meta.totalAvailable === null && meta.returned === 10, JSON.stringify({ t: meta.totalAvailable, r: meta.returned }));
    ok("usas individual ⇒ count-fail ⇒ hasMore falls back to upstream page_metadata.hasNext(true) ⇒ truncated:true",
      meta.pagination.hasMore === true && meta.truncated === true, JSON.stringify(meta.pagination));
  });

  // S4. companion fail + short page + upstream hasNext:false ⇒ hasMore false, total still null.
  await withFetch(usasHandler({ page: awardRows(4), hasNext: false, count: null }), async () => {
    const res = await searchIndividualAwards({ agency: "DOD", limit: 10 });
    const meta = finalize(res);
    ok("usas individual ⇒ count-fail + short page + upstream hasNext:false ⇒ hasMore:false, nextOffset:null, total null, truncated:false",
      meta.pagination.hasMore === false && meta.pagination.nextOffset === null &&
      meta.totalAvailable === null && meta.truncated === false, JSON.stringify({ p: meta.pagination, t: meta.totalAvailable, tr: meta.truncated }));
  });

  // S5. METAMORPHIC: same query, limit 5 vs 10 over an 8-award universe. The true
  // total must be INVARIANT under limit (if it moved with limit it'd be page-derived).
  let small, big;
  await withFetch(usasHandler({ page: awardRows(5), hasNext: true, count: { contracts: 8 } }), async () => {
    small = finalize(await searchIndividualAwards({ agency: "DOD", limit: 5 }));
  });
  await withFetch(usasHandler({ page: awardRows(8), hasNext: false, count: { contracts: 8 } }), async () => {
    big = finalize(await searchIndividualAwards({ agency: "DOD", limit: 10 }));
  });
  ok("usas individual METAMORPHIC ⇒ totalAvailable INVARIANT under limit (8 at limit 5 AND 10) — it's the true count, not page-derived",
    small.totalAvailable === 8 && big.totalAvailable === 8, JSON.stringify({ small: small.totalAvailable, big: big.totalAvailable }));
  ok("usas individual METAMORPHIC ⇒ returned monotonic (5≤8) + truncated flips true→false as returned reaches total",
    small.returned === 5 && big.returned === 8 && small.truncated === true && big.truncated === false, JSON.stringify({ sr: small.returned, br: big.returned, st: small.truncated, bt: big.truncated }));
  ok("usas individual METAMORPHIC non-vacuity ⇒ returned ≤ totalAvailable in BOTH (5≤8, 8≤8)",
    small.returned <= small.totalAvailable && big.returned <= big.totalAvailable, JSON.stringify({ s: [small.returned, small.totalAvailable], b: [big.returned, big.totalAvailable] }));

  // S6. usas_search_awards (share-of-wallet aggregate): the B1 truthfulness fix —
  // per-recipient award COUNTS are unavailable from spending_by_category/recipient
  // (amount only), so they must be null (not 0). "0 contracts worth $3.4B" is a lie.
  await withFetch(usasHandler({ cat: catRows(10) }), async () => {
    const res = await searchAwards({ agency: "DOD" });
    const meta = finalize(res);
    ok("usas share-of-wallet B1 ⇒ totalAwards null (NOT 0) + every topRecipient.awards null — no '0 contracts worth $Xbn'",
      res.data.totalAwards === null && res.data.topRecipients.length === 10 && res.data.topRecipients.every((r) => r.awards === null), JSON.stringify({ ta: res.data.totalAwards, sample: res.data.topRecipients[0] }));
    ok("usas share-of-wallet ⇒ totalValue = sum(amount) > 0 (value present while count honestly null)",
      res.data.totalValue > 0 && res.data.totalValue === res.data.topRecipients.reduce((s, r) => s + r.value, 0), JSON.stringify(res.data.totalValue));
    ok("usas share-of-wallet TRUTHFULNESS ⇒ totalAvailable null (aggregate, no grand total — NEVER returned length) + fieldsUnavailable declares awards/totalAwards",
      meta.totalAvailable === null && meta.fieldsUnavailable.includes("awards") && meta.fieldsUnavailable.includes("totalAwards"), JSON.stringify(meta.fieldsUnavailable));
    ok("usas share-of-wallet ⇒ full page (returned 10 ≥ limit 10) ⇒ truncated:true (more recipients may exist)",
      meta.returned === 10 && meta.truncated === true, JSON.stringify({ r: meta.returned, tr: meta.truncated }));
    // VQ-6 (C79 dogfooding): _meta.filtersApplied must reflect the ACTUAL filters
    // sent upstream so an agent can confirm its filter took effect. Every
    // buildFilters-based tool previously reported filtersApplied:[] even when the
    // filter was applied. Derived from the real filters object (drift-proof).
    const filtered = finalize(await searchAwards({ agency: "DOD", naics: "541512", fiscalYear: 2024 }));
    ok("VQ-6 usas_search_awards ⇒ filtersApplied REFLECTS the real filters (awardType+agency+naics+fiscalYear, not [])",
      filtered.filtersApplied.includes("awardType(contracts A/B/C/D)") && filtered.filtersApplied.includes("agency") &&
      filtered.filtersApplied.includes("naics") && filtered.filtersApplied.includes("fiscalYear"),
      JSON.stringify(filtered.filtersApplied));
    const noFilter = finalize(await searchAwards({}));
    ok("VQ-6 no-filter call ⇒ filtersApplied is the awardType baseline ONLY (never claims naics/agency when none applied)",
      noFilter.filtersApplied.length === 1 && noFilter.filtersApplied[0] === "awardType(contracts A/B/C/D)",
      JSON.stringify(noFilter.filtersApplied));
  });
  // VQ-6 + adversarial-review SHIP-BLOCKER: usas_search_cfda_spending is GRANTS
  // (award_type_codes 02/03/04/05), so filtersApplied must label the REAL scope —
  // a value-blind label falsely claimed "contracts A/B/C/D" on a grants tool.
  await withFetch(
    (u) => (/spending_by_category\/cfda/.test(u)
      ? mockResponse({ status: 200, json: { results: [{ code: "93.778", name: "Medicaid", amount: 5e9 }], page_metadata: { hasNext: false } } })
      : failClosed()()),
    async () => {
      const cfda = finalize(await searchCfdaSpending({ agency: "HHS" }));
      ok("VQ-6 cfda (GRANTS) ⇒ filtersApplied labels the real award scope 'awardType(02/03/04/05)', NEVER 'contracts A/B/C/D'",
        cfda.filtersApplied.includes("awardType(02/03/04/05)") &&
        !cfda.filtersApplied.some((x) => /contracts/.test(x)) &&
        cfda.filtersApplied.includes("agency"),
        JSON.stringify(cfda.filtersApplied));
    },
  );
}

// Error-taxonomy contract (the CENTRAL classifier `toToolError`, which the server's
// CallTool handler now routes ALL errors through). An AI consumer keys on
// `error.kind` to decide retry-vs-fix: an input mistake (limit above the cap, a
// value outside an enum) MUST surface as `invalid_input` with a readable message —
// NOT `unknown` carrying Zod's raw JSON dump (which reads as a mysterious, maybe-
// transient failure and invites a useless retry). This lens was motivated by a C55
// Codex dogfood round: gpt-5.5's first individual-awards call failed on limit>50,
// and only a clean `invalid_input`/"limit must be ≤50" lets it self-correct.
// Guards the REAL dispatch path (runTool throws the ZodError; toToolError classifies).
async function testErrorTaxonomy() {
  section("22. error taxonomy — Zod input-validation ⇒ invalid_input (clean msg), not unknown+raw-dump");
  // (a) A real tool SCHEMA rejects an out-of-range limit ⇒ runTool throws a ZodError
  //     BEFORE any network call (validation is the boundary). Non-vacuous: if the
  //     .max(50) cap were removed this would not throw.
  let zerr;
  await withFetch(failClosed(), async () => {
    try {
      await runTool("usas_search_individual_awards", { agency: "Department of Defense", naics: "541512", limit: 100 }, new SamGovClient({}));
    } catch (e) { zerr = e; }
  });
  ok("invalid limit(100>50) ⇒ runTool throws a ZodError BEFORE any fetch (schema boundary enforced)",
    zerr !== undefined && zerr?.constructor?.name === "ZodError", `thrown=${zerr?.constructor?.name}`);
  // (b) toToolError (the server's centralized classifier) ⇒ invalid_input, retryable:false.
  const te = toToolError(zerr, "usas_search_individual_awards");
  ok("ZodError ⇒ kind:'invalid_input' (NOT 'unknown') + retryable:false — agent knows to FIX input, not retry",
    te.kind === "invalid_input" && te.retryable === false, JSON.stringify({ kind: te.kind, retryable: te.retryable }));
  // (c) CLEAN field-level message — NOT the raw Zod JSON issue array.
  ok("ZodError ⇒ readable message ('...for <tool>: limit: ...'), NOT a raw Zod dump starting with '['",
    /Invalid input for usas_search_individual_awards/.test(te.message) && /limit/.test(te.message) && !/^\s*\[/.test(te.message), JSON.stringify(te.message));
  // (d) A classified ToolErrorCarrier keeps its kind — never re-downgraded to unknown.
  ok("ToolErrorCarrier(not_found) ⇒ kind preserved (not_found), never downgraded",
    toToolError(new ToolErrorCarrier({ kind: "not_found", message: "x", retryable: false }), "t").kind === "not_found", "carrier passthrough");
  // (e) Non-vacuity the OTHER way: a GENERIC Error stays 'unknown' — invalid_input is
  //     NOT over-applied (proves (b) keys on ZodError specifically, not everything).
  ok("generic Error ⇒ kind:'unknown' (honest fallback; invalid_input is NOT over-applied to all errors)",
    toToolError(new Error("boom"), "t").kind === "unknown", JSON.stringify(toToolError(new Error("boom"), "t").kind));
}

// REAL-DATA REPLAY (lens: my mock ≠ reality). §20 validated the SCA parser against
// SYNTHETIC fixtures I hand-built from code comments — a fiction if the real SAM WD
// text format differs. Here we freeze a slice of an ACTUAL live SAM WD document
// (2015-4045 rev 36, captured 2026-07-05 — real bytes verbatim, incl. the real
// header/whitespace) and assert the parser handles the REAL shape. This surfaced a
// real defect the synthetic fixtures missed: real WDs carry a FOOTNOTE column, and
// footnoted occupations ("(see N)") polluted the parsed title + lost the material
// signal (footnote 2 = night/Sunday differential). The fix cleans the title and
// exposes `footnotes`. It ALSO validates the C53 H&W-disambiguation + EO parse on
// the real document's actual wording (which really does carry the EO-13706 variant).
async function testRealWdReplay() {
  section("23. real-data replay — C53 SCA parser vs a FROZEN slice of a real SAM WD (2015-4045, live-captured)");
  const isWdDetail = (u) => /wdol\/v1\/wd\/[^/]+\/\d+/.test(u);
  // Verbatim real bytes (SAM WDOL detail.document for 2015-4045 rev 36).
  const REAL_WD_2015_4045 = [
    "OCCUPATION CODE - TITLE                                    FOOTNOTE    RATE",
    "01000 - Administrative Support And Clerical Occupations",
    "01011 - Accounting Clerk I                                             23.25",
    "01012 - Accounting Clerk II                                            26.08",
    "01013 - Accounting Clerk III                                           29.18",
    "01020 - Administrative Assistant                                       38.37",
    "01035 - Court Reporter                                                 23.73",
    "30621 - Weather Observer, Senior                           (see 2)     29.20",
    "contract is subject to Executive Order 13658, the contractor must pay all covered ",
    "workers at least $13.65 per hour (or the applicable wage rate listed on this wage determination, if it is higher) for all hours spent performing on the contract from May 11, 2026, through December 31, 2026. ",
    "HEALTH & WELFARE: $5.55 per hour, up to 40 hours per week, or $222.00 per week or ",
    "HEALTH & WELFARE EO 13706: $5.09 per hour, up to 40 hours per week, or $203.60 per ",
  ].join("\n");
  const detail = {
    document: REAL_WD_2015_4045, active: true, standard: true, publishDate: "2026-06-25",
    location: { mapping: [{ state: "MA", counties: ["Barnstable"], statewideFlag: false }] },
  };
  await withFetch((u) => (isWdDetail(u) ? mockResponse({ status: 200, json: detail }) : failClosed()()), async () => {
    const res = await getWageRates({ reference: "2015-4045", revision: 36, coverage: "sca" });
    const d = res.data;
    ok("real WD ⇒ coverage SCA + 6 coded rows parsed (category header 01000 NOT counted) + parseConfidence high",
      d.coverage === "SCA" && d.rates.length === 6 && !d.rates.some((r) => r.code === "01000") && d.parseConfidence === "high", JSON.stringify({ n: d.rates.length, conf: d.parseConfidence }));
    const foot = d.rates.find((r) => r.code === "30621");
    ok("real WD FOOTNOTE FIX ⇒ 30621 title CLEAN 'Weather Observer, Senior' + footnotes:[2] + baseRate 29.20 (marker not buried in title)",
      !!foot && foot.title === "Weather Observer, Senior" && Array.isArray(foot.footnotes) && foot.footnotes.length === 1 && foot.footnotes[0] === 2 && foot.baseRate === 29.2, JSON.stringify(foot));
    const norm = d.rates.find((r) => r.code === "01011");
    ok("real WD ⇒ normal occupation clean ('Accounting Clerk I', footnotes null) — footnote field not over-applied",
      !!norm && norm.title === "Accounting Clerk I" && norm.baseRate === 23.25 && norm.footnotes === null, JSON.stringify(norm));
    ok("real WD ⇒ NO title polluted with '(see' or a double-space (column whitespace collapsed across all rows)",
      !d.rates.some((r) => /\(see|  /.test(r.title)), JSON.stringify(d.rates.map((r) => r.title)));
    ok("real WD H&W disambiguation ON REAL WORDING ⇒ WD-wide $5.55, NOT the real EO-13706 sick-leave $5.09 variant",
      d.healthAndWelfarePerHour === 5.55, JSON.stringify(d.healthAndWelfarePerHour));
    ok("real WD EO floor ON REAL CROSS-LINE WORDING ⇒ EO 13658 @ $13.65 (number+cite read from actual text, not hardcoded)",
      d.executiveOrderMinimumWage && d.executiveOrderMinimumWage.executiveOrder === "EO 13658" && d.executiveOrderMinimumWage.minimumWage === 13.65, JSON.stringify(d.executiveOrderMinimumWage));
    ok("real WD ⇒ a note flags footnoted occupations carry MATERIAL extra pay rules (steer to raw for definitions)",
      (res.meta.notes || []).some((n) => /footnotes/i.test(n) && /MATERIAL extra pay/i.test(n)), JSON.stringify(res.meta.notes));
  });
}

// REAL-DATA REPLAY (lens: my mock ≠ reality) — 2nd parser, extends C56. gao_protest_lookup
// scrapes the LIVE GAO Legal-Products RSS with a hand-rolled string/regex parser; §17's
// fault fixtures are hand-built. Here we freeze 2 VERBATIM real RSS <item>s (captured
// 2026-07-05) and assert the RSS-level parse handles the REAL shape — including two real
// edges the hand-built mocks didn't cover, both VERIFIED against the live site as correct
// (not defects): (a) GAO's own feed publishes a %2C-encoded multi-B link
// (…/b-424347%2Cb-424347.2) — bNumber must extract the BASE "B-424347" while decisionUrl
// passes the real URL through unchanged; (b) a pending-protest description yields
// outcome:null at the RSS level (an outcome is NOT fabricated before the decision page is
// read). Also validates RFC-822 pubDate → ISO date on real bytes.
async function testRealGaoReplay() {
  section("24. real-data replay — gao_protest_lookup RSS parser vs 2 FROZEN real GAO RSS items (live-captured)");
  const REAL_GAO_RSS = [
    '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>GAO Legal Products</title>',
    '<item><title>Strategic Alliance Business Group, LLC</title><link>https://www.gao.gov/products/b-423306.19</link><description>Strategic Alliance Business Group, LLC, a small business of Fairfax, Virginia, protests the elimination of its proposal from the competition under solicitation No. 80TECH24R0001.</description><pubDate>Thu, 02 Jul 2026 14:04:08 -0400</pubDate><guid isPermaLink="false">/products/b-423306.19</guid></item>',
    '<item><title>InterImage Inc.</title><link>https://www.gao.gov/products/b-424347%2Cb-424347.2</link><description>InterImage, Inc., of Arlington, Virginia, protests the issuance of a task order to Trillion Technology Solutions, Inc.</description><pubDate>Fri, 26 Jun 2026 10:22:23 -0400</pubDate><guid isPermaLink="false">/products/b-424347%2Cb-424347.2</guid></item>',
    "</channel></rss>",
  ].join("\n");
  const isRss = (u) => /reportslegal\.xml/.test(u);
  // enrich:false ⇒ RSS-only, NO product-page fetch ⇒ deterministic; failClosed proves it.
  await withFetch((u) => (isRss(u) ? mockResponse({ status: 200, json: REAL_GAO_RSS }) : failClosed()()), async () => {
    const r = await gaoProtestLookup({ enrich: false, limit: 5 });
    const rows = r.data.decisions;
    ok("real GAO RSS ⇒ parses 2 decisions (returned===2, no product-page fetch reached)",
      r.meta.returned === 2 && rows.length === 2, JSON.stringify({ returned: r.meta.returned, n: rows.length }));
    const sa = rows.find((d) => /Strategic Alliance/.test(d.protester || d.title || ""));
    ok("real GAO RSS ⇒ Strategic Alliance: bNumber B-423306.19 + decisionDate 2026-07-02 (RFC-822 pubDate → ISO)",
      !!sa && sa.bNumber === "B-423306.19" && sa.decisionDate === "2026-07-02", JSON.stringify(sa && { b: sa.bNumber, d: sa.decisionDate }));
    const ii = rows.find((d) => /InterImage/.test(d.protester || d.title || ""));
    ok("real GAO RSS EDGE ⇒ %2C multi-B link ⇒ bNumber extracts BASE 'B-424347' AND decisionUrl passes GAO's real %2C URL through unchanged",
      !!ii && ii.bNumber === "B-424347" && ii.decisionUrl === "https://www.gao.gov/products/b-424347%2Cb-424347.2", JSON.stringify(ii && { b: ii.bNumber, url: ii.decisionUrl }));
    ok("real GAO RSS TRUTHFULNESS ⇒ outcome:null at RSS level for BOTH (a pending-protest description does NOT fabricate an outcome before the decision page is read)",
      rows.every((d) => d.outcome === null), JSON.stringify(rows.map((d) => d.outcome)));
  });
}

// REAL-DATA REPLAY (lens: my mock ≠ reality) — 3rd parser, extends C56/C57.
// far_clause_lookup fetches the eCFR versioner-full XML and extracts heading/text via a
// hand-rolled <HEAD>/stripXml parser (C18 fixed 3 real defects here). §9/§18's fixtures
// are hand-built. Here we freeze a VERBATIM real Title-48 section XML (52.219-14, captured
// 2026-07-01) and assert the parser handles the REAL shape — which carries structural tags
// the synthetic fixtures lacked: <EXTRACT>, <HD1> (holding the "(OCT 2022)" revision),
// <HD3>(End of clause), <CITA>, and INLINE <I>…</I> tags inside <P>. Live-verified the
// parser is correct on this clause; this locks the real shape. (includePrescription:false
// ⇒ only the clause + titles fetches, deterministic.)
async function testRealEcfrReplay() {
  section("25. real-data replay — far_clause_lookup versioner-XML parser vs a VERBATIM real Title-48 section (52.219-14, live-captured)");
  const REAL_CLAUSE_52_219_14 = `<?xml version="1.0" encoding="UTF-8"?>
<DIV8 N="52.219-14" TYPE="SECTION" hierarchy_metadata="{&quot;path&quot;:&quot;/on/_SUBSTITUTE_DATE_/title-48/section-52.219-14&quot;,&quot;citation&quot;:&quot;48 CFR 52.219-14&quot;,&quot;alternate_reference&quot;:&quot;FAR 52.219-14&quot;}">
<HEAD>52.219-14 Limitations on Subcontracting.</HEAD>
<P>As prescribed in 19.507(e), insert the following clause:</P>
<EXTRACT>
<HD1>Limitations on Subcontracting (OCT 2022)
</HD1>
<P>(a) This clause does not apply to the unrestricted portion of a partial set-aside.</P>
<P>(b) <I>Definition. Similarly situated entity,</I> as used in this clause, means a first-tier subcontractor, including an independent contractor, that—</P>
<P>(1) Has the same small business program status as that which qualified the prime contractor for the award (<I>e.g.,</I> for a small business set-aside contract, any small business concern, without regard to its socioeconomic status); and</P>
<P>(e) <I>Limitations on subcontracting.</I> By submission of an offer and execution of a contract, the Contractor agrees that in performance of a contract assigned a North American Industry Classification System (NAICS) code for—</P>
<P>(1) Services (except construction), it will not pay more than 50 percent of the amount paid by the Government for contract performance to subcontractors that are not similarly situated entities.</P></EXTRACT>
<HD3>(End of clause)
</HD3>
<CITA TYPE="N">[86 FR 44245, Aug. 11, 2021, as amended at 87 FR 58226, Sept. 23, 2022]
</CITA>
</DIV8>`;
  const isEcfrFullSection = (u) => isEcfrFull(u) && ecfrSection(u) === "52.219-14";
  await withFetch((u) => {
    if (isEcfrTitles(u)) return mockResponse({ status: 200, json: TITLES_JSON });
    if (isEcfrFullSection(u)) return mockResponse({ status: 200, json: REAL_CLAUSE_52_219_14 });
    return failClosed()();
  }, async () => {
    const res = await farClauseLookup({ clauseNumber: "52.219-14", includePrescription: false });
    const d = res.data;
    ok("real eCFR XML ⇒ heading extracted from real <HEAD> with the leading clause-number stripped ('Limitations on Subcontracting.')",
      d.heading === "Limitations on Subcontracting.", JSON.stringify(d.heading));
    ok("real eCFR XML ⇒ revision 'OCT 2022' parsed from the real <HD1> token, prescribedIn '19.507(e)' from real <P>",
      d.revision === "OCT 2022" && d.prescribedIn === "19.507(e)", JSON.stringify({ rev: d.revision, presc: d.prescribedIn }));
    ok("real eCFR XML ⇒ stripXml removed ALL real structural tags (no <P>/<I>/<EXTRACT>/<HD1>/<HD3>/<CITA>/<DIV8> residue in text)",
      typeof d.text === "string" && !/<\/?(P|I|EXTRACT|HD1|HD3|CITA|DIV8|HEAD)\b/i.test(d.text), JSON.stringify((d.text || "").slice(0, 60)));
    ok("real eCFR XML ⇒ INLINE <I> handled cleanly: 'Definition. Similarly situated entity, as used in this clause' (no tag residue, no split word)",
      /Definition\. Similarly situated entity, as used in this clause/.test(d.text), JSON.stringify((d.text || "").match(/.{0,10}Similarly situated entity.{0,30}/)?.[0]));
    ok("real eCFR XML ⇒ substantive text preserved: real '50 percent', 'similarly situated entities', '(End of clause)'",
      /50 percent/.test(d.text) && /similarly situated entities/.test(d.text) && /\(End of clause\)/.test(d.text), `len=${(d.text || "").length}`);
    ok("real eCFR XML ⇒ isCurrent true (asOfDate 2026-07-01 === titles up_to_date_as_of) — HEAD-gate passed, NOT a hollow/schema_drift error",
      d.isCurrent === true && d.asOfDate === "2026-07-01", JSON.stringify({ cur: d.isCurrent, asOf: d.asOfDate }));
  });
}

// REAL-DATA REPLAY (lens: my mock ≠ reality) — validates C54 against reality. §21's
// usas pagination-truthfulness suite was built ENTIRELY on hand-built mocks. Here we
// freeze VERBATIM real USAspending responses (spending_by_award + companion
// spending_by_award_count for DoD × NAICS 541512, captured 2026-07-05) and assert the
// C54 invariants hold on the REAL shape. Confirmed against the live API: page_metadata
// carries hasNext + a cursor but NO total (exactly why totalAvailable MUST come from the
// companion count), and — a detail the 2-bucket mock missed — the real count returns SIX
// buckets (contracts/direct_payments/grants/idvs/loans/other) that awardCount must sum.
async function testRealUsasReplay() {
  section("26. real-data replay — usas_search_individual_awards vs VERBATIM real USAspending responses (DoD×541512, live-captured)");
  const isAwardCount = (u) => /spending_by_award_count/.test(u);
  const isAwardPage = (u) => /spending_by_award(?!_count)/.test(u);
  // Real spending_by_award page (2 verbatim results + real page_metadata; note the real
  // extra fields internal_id/agency_slug/awarding_agency_id the tool must IGNORE).
  const REAL_PAGE = {
    spending_level: "awards", limit: 2,
    results: [
      { internal_id: 350876734, "Award ID": "ZW05", "Recipient Name": "TYONEK MANUFACTURING, LLC", "Award Amount": 23712.4, "Awarding Agency": "Department of Defense", "Awarding Sub Agency": "Department of the Army", NAICS: { code: "541512", description: "COMPUTER SYSTEMS DESIGN SERVICES" }, "Place of Performance State Code": "WA", Description: "SERVICES TO SUPPORT TRAINING CLASS", awarding_agency_id: 1173, agency_slug: "department-of-defense", generated_internal_id: "CONT_AWD_ZW05_9700_W912HZ05D0013_9700" },
      { internal_id: 350876681, "Award ID": "ZW04", "Recipient Name": "TYONEK MANUFACTURING, LLC", "Award Amount": 26621.92, "Awarding Agency": "Department of Defense", "Awarding Sub Agency": "Department of the Army", NAICS: { code: "541512", description: "COMPUTER SYSTEMS DESIGN SERVICES" }, "Place of Performance State Code": "AL", Description: "COURSE INSTRUCTION AT FT. WAINWRIGHT", awarding_agency_id: 1173, agency_slug: "department-of-defense", generated_internal_id: "CONT_AWD_ZW04_9700_W912HZ05D0013_9700" },
    ],
    page_metadata: { page: 1, hasNext: true, last_record_unique_id: 350876681, last_record_sort_value: "ZW04" },
  };
  // Real spending_by_award_count: SIX buckets (the 2-bucket §21 mock understated this).
  const REAL_COUNT = { results: { contracts: 49990, direct_payments: 0, grants: 0, idvs: 0, loans: 0, other: 0 }, spending_level: "awards" };
  await withFetch((u) => {
    if (isAwardCount(u)) return mockResponse({ status: 200, json: REAL_COUNT });
    if (isAwardPage(u)) return mockResponse({ status: 200, json: REAL_PAGE });
    return failClosed()();
  }, async () => {
    const res = await searchIndividualAwards({ agency: "Department of Defense", naics: "541512", limit: 2 });
    const meta = buildMeta(res.meta);
    const a0 = res.data.awards[0];
    ok("real usas ⇒ returned===awards.length===2 (real page mapped)",
      meta.returned === 2 && res.data.awards.length === 2, JSON.stringify({ r: meta.returned, n: res.data.awards.length }));
    ok("real usas TRUTHFULNESS ⇒ totalAvailable = SUM of the real SIX count buckets (49990), NOT the page length (2) — awardCount handles the real shape",
      meta.totalAvailable === 49990, JSON.stringify(meta.totalAvailable));
    ok("real usas ⇒ real field mapping: Award ID→awardId 'ZW05', Recipient Name→recipient, Award Amount→amount 23712.4, real NAICS.{code,description}→naicsCode/naicsDescription",
      a0.awardId === "ZW05" && a0.recipient === "TYONEK MANUFACTURING, LLC" && a0.amount === 23712.4 && a0.naicsCode === "541512" && a0.naicsDescription === "COMPUTER SYSTEMS DESIGN SERVICES", JSON.stringify(a0));
    ok("real usas ⇒ maps real Awarding Sub Agency + generated_internal_id; ignores real extra fields (internal_id/agency_slug not surfaced)",
      a0.awardingSubAgency === "Department of the Army" && a0.generatedInternalId === "CONT_AWD_ZW05_9700_W912HZ05D0013_9700" && a0.internal_id === undefined && a0.agency_slug === undefined, JSON.stringify({ sub: a0.awardingSubAgency, gid: a0.generatedInternalId }));
    ok("real usas ⇒ page(2) < total(49990) ⇒ truncated + hasMore + nextOffset 2 + complete:false (real 'more exists' signal)",
      meta.truncated === true && meta.pagination.hasMore === true && meta.pagination.nextOffset === 2 && meta.complete === false, JSON.stringify(meta.pagination));
  });
}

// data-absence-as-present (the 2nd truthfulness class, T16). The awarding_subagency
// endpoint returns `amount` but NO per-subagency award count; emitting `awards: 0`
// would be a FABRICATED count (0 reads as "zero contracts", masking "unknown") —
// the exact B1 class searchAwards was already fixed for. This case was documented
// but the value-fix was DEFERRED (kept awards:0 + a _meta note). Now awards:null
// (honest), consistent with the B1 standard, so an AI that ignores _meta still
// sees null not a fake 0. Guards against re-introducing the fabricated-0 lie.
async function testSubAgencyAwardsNull() {
  section("27. data-absence-as-present (T16) — subagency awards is null (unavailable), NOT a fabricated 0-count");
  // Real awarding_subagency rows: `amount` present, `count` ABSENT (per the API).
  const isSubAgency = (u) => /spending_by_category\/awarding_subagency/.test(u);
  await withFetch(
    (u) => (isSubAgency(u) ? mockResponse({ status: 200, json: { results: [{ name: "Department of the Army", amount: 5e9 }, { name: "Department of the Navy", amount: 3e9 }], page_metadata: { hasNext: false } } }) : failClosed()()),
    async () => {
      const res = await searchSubAgencySpending({ agency: "Department of Defense", fiscalYear: 2025 });
      const subs = res.data.subAgencies;
      ok("subagency B1-class ⇒ EVERY row's `awards` is null (unavailable), NEVER a fabricated 0 (0 would read as 'zero contracts')",
        subs.length === 2 && subs.every((s) => s.awards === null), JSON.stringify(subs.map((s) => ({ n: s.name, a: s.awards }))));
      ok("subagency ⇒ amount preserved (present real field) while count is honestly null — not conflated",
        subs[0].amount === 5e9 && subs[1].amount === 3e9, JSON.stringify(subs.map((s) => s.amount)));
      ok("subagency ⇒ _meta.fieldsUnavailable declares 'awards' + a note says null/NOT a count (belt-and-suspenders with the null value)",
        (res.meta.fieldsUnavailable || []).includes("awards") && (res.meta.notes || []).some((n) => /awards.*null.*(NOT|not).*count/i.test(n)), JSON.stringify(res.meta.fieldsUnavailable));
      // VQ-6 (C79): category-aggregate path (via categoryAggregateMeta) must also
      // reflect the real filters — was filtersApplied:[] despite agency+fiscalYear.
      ok("VQ-6 subagency (categoryAggregateMeta path) ⇒ filtersApplied reflects awardType+agency+fiscalYear, not []",
        (res.meta.filtersApplied || []).includes("awardType(contracts A/B/C/D)") && (res.meta.filtersApplied || []).includes("agency") && (res.meta.filtersApplied || []).includes("fiscalYear"),
        JSON.stringify(res.meta.filtersApplied));
    },
  );
}

// far_clause_lookup future/uncodified asOfDate (found via C63 dogfood: a real agent
// inferred asOfDate=today when today > the latest eCFR codification, and the tool
// replied "clause not found (may be wrong, reserved, or removed)" about a VALID
// clause). The problem is the DATE, not the clause — so it must be a clear
// invalid_input pointing at the latest date, NOT a not_found that reads as
// "the clause was removed". Guard fires BEFORE any clause fetch (only titles).
async function testFarFutureAsOfDate() {
  section("28. far_clause_lookup future asOfDate ⇒ honest invalid_input (date past latest edition), NOT 'clause not found/removed'");
  const CLAUSE_XML = '<?xml version="1.0"?><DIV8 N="52.219-14" TYPE="SECTION"><HEAD>52.219-14 Limitations on Subcontracting.</HEAD><P>As prescribed in 19.507(e), insert the following clause:</P><P>(a) This clause does not apply to the unrestricted portion of a partial set-aside.</P></DIV8>';
  // TITLES_JSON.up_to_date_as_of is 2026-07-01. asOfDate 2026-07-05 is 4 days past it.
  const titlesHandler = (u, extra) => {
    if (isEcfrTitles(u)) return mockResponse({ status: 200, json: TITLES_JSON });
    return extra(u);
  };
  // 1. future date ⇒ invalid_input, message names the latest date + "NOT missing", NO clause fetch reached.
  await withFetch((u) => titlesHandler(u, () => failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => farClauseLookup({ clauseNumber: "52.219-14", asOfDate: "2026-07-05", includePrescription: false }));
    ok("far future asOfDate ⇒ throws invalid_input (NOT not_found — the DATE is wrong, the clause is fine), no clause fetch reached",
      threw && error?.toolError?.kind === "invalid_input", JSON.stringify(error?.toolError?.kind));
    ok("far future asOfDate ⇒ message names the latest codification (2026-07-01) + says the clause is NOT missing/removed (actionable, non-misleading)",
      /latest available codification is 2026-07-01/.test(error?.toolError?.message || "") && /NOT missing or removed/i.test(error?.toolError?.message || ""), JSON.stringify(error?.toolError?.message));
  });
  // 2. far-future date (2030) ⇒ same honest invalid_input (not a masked not_found).
  await withFetch((u) => titlesHandler(u, () => failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => farClauseLookup({ clauseNumber: "52.219-14", asOfDate: "2030-01-01", includePrescription: false }));
    ok("far far-future asOfDate (2030) ⇒ invalid_input, not not_found",
      threw && error?.toolError?.kind === "invalid_input", JSON.stringify(error?.toolError?.kind));
  });
  // 3. NON-VACUITY / no-regression: asOfDate ON the latest date is NOT rejected — the clause fetches + parses.
  await withFetch((u) => titlesHandler(u, (u2) => (isEcfrFull(u2) && ecfrSection(u2) === "52.219-14" ? mockResponse({ status: 200, json: CLAUSE_XML }) : failClosed()())), async () => {
    const res = await farClauseLookup({ clauseNumber: "52.219-14", asOfDate: "2026-07-01", includePrescription: false });
    ok("far asOfDate == latest (2026-07-01) ⇒ NOT rejected: clause fetches + parses (guard only rejects FUTURE dates, non-vacuous)",
      res.data.heading === "Limitations on Subcontracting." && res.data.isCurrent === true, JSON.stringify({ h: res.data.heading, cur: res.data.isCurrent }));
  });
}

// Upstream courtesy (T8): far_compliance_matrix can be asked for up to 25 clauses,
// but it must NOT fire them all at the eCFR versioner at once — a burst of 25
// concurrent fetches is rate-limit-risky and looks abusive. It fans out through a
// bounded worker pool (MATRIX_CONCURRENCY=5). This guards that courtesy invariant:
// the PEAK number of in-flight eCFR clause fetches during a 12-clause matrix stays
// ≤ 5 (bounded) while being > 1 (genuinely parallel, not accidentally sequential).
// A regression that replaced the pool with Promise.all(all clauses) would peak at 12.
async function testUpstreamConcurrencyBounded() {
  section("29. upstream courtesy (T8) — far_compliance_matrix bounds eCFR fan-out (≤ MATRIX_CONCURRENCY, never bursts)");
  _clearCache(); // ensure clause fetches hit the mock (not a memoized prior result)
  let inFlight = 0;
  let peak = 0;
  const CLAUSE_XML =
    '<?xml version="1.0"?><DIV8 TYPE="SECTION"><HEAD>Test Clause Heading.</HEAD><P>Substantive clause body text that comfortably exceeds twenty characters for the section gate.</P></DIV8>';
  const handler = (u) => {
    if (isEcfrTitles(u)) return mockResponse({ status: 200, json: TITLES_JSON });
    if (isEcfrFull(u)) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Hold the request open briefly (REAL timer — the harness neutralizes the
      // patched setTimeout) so concurrent workers actually overlap and `peak` is real.
      return new Promise((resolve) =>
        REAL_SET_TIMEOUT(() => {
          inFlight--;
          resolve(mockResponse({ status: 200, json: CLAUSE_XML }));
        }, 8),
      );
    }
    return failClosed()();
  };
  // 12 distinct valid-format clauses (> the pool of 5, ≤ the 25 cap), in an unused
  // 52.9xx range so a prior test's cache can't satisfy them.
  const clauses = Array.from({ length: 12 }, (_, i) => `52.9${String(10 + i).padStart(2, "0")}-9`);
  await withFetch(handler, async () => {
    await farComplianceMatrix({ clauses, includePrescription: false, flagGates: false });
  });
  ok("far_compliance_matrix(12 clauses) ⇒ 2 ≤ peak concurrent eCFR fetches ≤ MATRIX_CONCURRENCY(5): polite bounded fan-out, never a 12-wide burst",
    peak >= 2 && peak <= 5, `peak=${peak} concurrent (a Promise.all-all-clauses regression would peak at 12; sequential would be 1)`);
}

// §30: gsa_benchmark_labor_rates distribution correctness (PRICE-1).
// GSA CALC serves a GLOBALLY ascending-by-current_price list and reports an
// EXACT `total`; descending sort 406s and the price_range filter does not narrow
// (all LIVE-VERIFIED 2026-07-05). The ORIGINAL sampler paged only the first N
// rows (the CHEAPEST N) and reported THEIR min/median/max as the category's
// distribution — so for any category exceeding the ~300-row page budget the
// median/max were biased far LOW (LIVE: "Program Manager" 2114 matches → it
// reported median $115 / max $131 when the true median is $178 and max is $485,
// ~35% and ~73% low). The fix reads min/median/max at the true quantile RANKS of
// the sorted index (exact), and only falls back to a leading sample when the
// count is SATURATED — where it DISCLOSES the median/max as a downward-biased
// lower bound. NON-VACUITY: reverting to the leading-sample sampler makes the
// 30a median/max assertions RED (they'd read ~249.5 / 399, not 1099.5 / 2099).
async function testCalcBenchmarkDistribution() {
  section("30. real-data-shaped replay (PRICE-1) — gsa_benchmark_labor_rates reports EXACT median/max via quantile-rank paging of CALC's price-sorted index, NOT a cheapest-N (downward-biased) sample");

  const PS = 100; // the tool's PAGE_ROWS
  // A CALC-shaped mock: N rows, current_price(rank)=100+rank (globally ascending,
  // exactly how CALC serves them), page_size honored. education_level splits at
  // the median so a stratified (low+high) fetch is provable from the vocabulary.
  function calcMock(relation, N) {
    return (u) => {
      if (!/\/calc\/v3\/api\/ceilingrates\//.test(u)) return failClosed()();
      const q = new URL(u).searchParams;
      const page = Number(q.get("page") ?? 1);
      const size = Number(q.get("page_size") ?? PS);
      const start = (page - 1) * size;
      const hits = [];
      for (let i = 0; i < size; i++) {
        const rank = start + i;
        if (rank >= N) break;
        hits.push({ _source: {
          labor_category: "Widget Analyst",
          current_price: 100 + rank,
          next_year_price: 105 + rank,
          second_year_price: 110 + rank,
          education_level: rank < Math.floor(N / 2) ? "BA" : "PHD",
          min_years_experience: 5,
          business_size: "s",
        } });
      }
      return mockResponse({ status: 200, json: { hits: { total: { value: N, relation }, hits } } });
    };
  }

  // (a) KNOWN total (relation "eq", N=2000 ≫ the 300-row budget) ⇒ EXACT quantiles.
  //     true min=100, median=avg(price@999,price@1000)=avg(1099,1100)=1099.5, max=2099.
  await withFetch(calcMock("eq", 2000), async (calls) => {
    const res = await benchmarkLaborRates({ laborCategory: "Widget Analyst" });
    const d = res.data;
    ok("30a exact min = true global min (100)", d.currentRate.min === 100, JSON.stringify(d.currentRate));
    ok("30a exact median = TRUE median 1099.5 (a cheapest-300 sample reports ~249.5 — the bug)",
      d.currentRate.median === 1099.5, JSON.stringify(d.currentRate));
    ok("30a exact max = TRUE max 2099 (a cheapest-300 sample reports 399 — the bug)",
      d.currentRate.max === 2099, JSON.stringify(d.currentRate));
    ok("30a currentRateExact === true (distribution fully characterized by rank reads)",
      d.currentRateExact === true, JSON.stringify(d.currentRateExact));
    ok("30a _meta.truncated === true (only a SAMPLE of rows returned) — yet currentRateExact flags the stats as exact (the two signals are distinct)",
      res.meta.truncated === true, JSON.stringify(res.meta.truncated));
    ok("30a _meta.totalAvailable === 2000 (exact count known)",
      res.meta.totalAvailable === 2000, JSON.stringify(res.meta.totalAvailable));
    // Stratification: the soft-stat sample reaches the HIGH band (PHD), which a
    // cheapest-N sample (all BA) never would — proves it paged high, not just low.
    ok("30a stratified sample spans low AND high bands (educationLevelsInSample has BA + PHD)",
      d.educationLevelsInSample.includes("BA") && d.educationLevelsInSample.includes("PHD"),
      JSON.stringify(d.educationLevelsInSample));
    // Bounded: targeted paging touches only a few pages, never a 20-page full scan.
    const calcCalls = calls.filter((c) => /ceilingrates/.test(c.url)).length;
    ok("30a bounded targeted paging (≤ 5 CALC calls for N=2000, not a 20-page full scan)",
      calcCalls <= 5, `calcCalls=${calcCalls}`);
  });

  // (b) SATURATED (relation "gte", true total unknown) ⇒ min exact, median/max a
  //     DISCLOSED downward-biased lower bound; currentRateExact === false.
  await withFetch(calcMock("gte", 10000), async () => {
    const res = await benchmarkLaborRates({ laborCategory: "Widget Analyst" });
    const d = res.data;
    ok("30b saturated ⇒ currentRateExact === false (cannot locate ranks without an exact total)",
      d.currentRateExact === false, JSON.stringify(d.currentRateExact));
    ok("30b saturated ⇒ currentRate.min still exact (100 — the low tail is reachable)",
      d.currentRate.min === 100, JSON.stringify(d.currentRate));
    ok("30b saturated ⇒ _meta.truncated === true", res.meta.truncated === true, JSON.stringify(res.meta.truncated));
    ok("30b saturated ⇒ a note DISCLOSES the median/max as a downward-biased lower bound",
      res.meta.notes.some((n) => /DOWNWARD-BIASED LOWER BOUND/.test(n)), JSON.stringify(res.meta.notes));
  });

  // (c) SMALL known total (N=40 ≤ one page) ⇒ exact over the full set, 1 fetch.
  //     prices 100..139; median even = avg(119,120)=119.5; max=139.
  await withFetch(calcMock("eq", 40), async (calls) => {
    const res = await benchmarkLaborRates({ laborCategory: "Widget Analyst" });
    const d = res.data;
    ok("30c small exact: median 119.5, max 139, min 100 over the full 40 (currentRateExact)",
      d.currentRate.median === 119.5 && d.currentRate.max === 139 && d.currentRate.min === 100 && d.currentRateExact === true,
      JSON.stringify(d.currentRate));
    ok("30c all 40 rows returned ⇒ _meta.truncated === false (nothing withheld)",
      res.meta.truncated === false, JSON.stringify(res.meta.truncated));
    const calcCalls = calls.filter((c) => /ceilingrates/.test(c.url)).length;
    ok("30c small total ⇒ single-page fetch (all ranks on page 1)", calcCalls === 1, `calcCalls=${calcCalls}`);
  });

  // (d) ODD known total (N=41) ⇒ exact single-rank median (not the even-average
  //     branch). prices 100..140; median = price@rank20 = 120; max = 140.
  await withFetch(calcMock("eq", 41), async () => {
    const res = await benchmarkLaborRates({ laborCategory: "Widget Analyst" });
    const d = res.data;
    ok("30d odd exact median = price@middle-rank (120), max 140, min 100, currentRateExact",
      d.currentRate.median === 120 && d.currentRate.max === 140 && d.currentRate.min === 100 && d.currentRateExact === true,
      JSON.stringify(d.currentRate));
  });

  // (e) `total` DISAGREES with paginable rows (CALC reports 300 but only 150 are
  //     actually paginable — a real Elasticsearch total/deep-paging skew). The
  //     max-rank read lands on an empty page ⇒ rankClamped ⇒ currentRateExact
  //     DOWNGRADES to false rather than silently reporting a clamped (low) max as
  //     the truth. min stays exact. (Guards adversarial-review item 3a.)
  function calcMockCapped(claimedTotal, actualRows) {
    return (u) => {
      if (!/\/calc\/v3\/api\/ceilingrates\//.test(u)) return failClosed()();
      const q = new URL(u).searchParams;
      const page = Number(q.get("page") ?? 1);
      const size = Number(q.get("page_size") ?? PS);
      const start = (page - 1) * size;
      const hits = [];
      for (let i = 0; i < size; i++) {
        const rank = start + i;
        if (rank >= actualRows) break; // fewer rows than `claimedTotal` promises
        hits.push({ _source: { labor_category: "Widget Analyst", current_price: 100 + rank } });
      }
      return mockResponse({ status: 200, json: { hits: { total: { value: claimedTotal, relation: "eq" }, hits } } });
    };
  }
  await withFetch(calcMockCapped(300, 150), async () => {
    const res = await benchmarkLaborRates({ laborCategory: "Widget Analyst" });
    const d = res.data;
    ok("30e total(300) > paginable(150): rank unreachable ⇒ currentRateExact === false (honest downgrade, not a clamped low max as truth)",
      d.currentRateExact === false, JSON.stringify(d.currentRateExact));
    ok("30e degraded read ⇒ currentRate.min still exact (100)", d.currentRate.min === 100, JSON.stringify(d.currentRate));
    ok("30e degraded read ⇒ _meta.truncated === true (not the full picture)", res.meta.truncated === true, JSON.stringify(res.meta.truncated));
  });
}

// §31: usas_search_recompetes bounded-scan / early-stop / truncation truthfulness.
// The recompete window (current PoP END date ∈ [windowStartDays, windowEndDays]) is
// applied CLIENT-SIDE because USAspending exposes no server-side PoP-end filter
// (LIVE-VERIFIED 2026-07-06: date_type=period_of_performance_current_end_date → HTTP
// 500). The tool therefore pages spending_by_award sorted `End Date` DESC and
// EARLY-STOPS at the first row below the window — correct ONLY because the stream is
// End-Date-descending (LIVE-VERIFIED: strictly monotonic within AND across pages).
// Two guarantees are load-bearing and had NO offline guard (live edge/smoke can't
// force scanTruncated or verify the early-stop): (1) totalAvailable is EXACT only
// when the window end was reached, else null + LOWER BOUND; (2) the early-stop must
// not over-collect past-window rows. NON-VACUITY: removing the `pastWindow` break
// makes 31a over-collect (RED); dropping the DESC sort request fails 31a's body
// assertion; not setting scanTruncated makes 31b report totalAvailable 0 not null (RED).
async function testRecompeteWindowScan() {
  section("31. usas_search_recompetes — client-side PoP-end window: DESC-sort early-stop, exact-vs-LOWER-BOUND totalAvailable, missing-date counting (offline determinism for a live-only path)");

  const DAY = 86400000;
  const iso = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
  const row = (endDays, amount, id) => ({
    "Award ID": id,
    "Recipient Name": `INC-${id}`,
    "Award Amount": amount,
    "End Date": endDays === null ? null : iso(endDays),
    "Start Date": iso(-1000),
    "Awarding Agency": "Department of Defense",
    "Awarding Sub Agency": "Dept of the Army",
    NAICS: { code: "541512" }, PSC: { code: "R425" },
    "Contract Award Type": "DEFINITIVE CONTRACT",
    generated_internal_id: `GID-${id}`,
  });

  // (a) EXACT: a DESC-by-End-Date stream — far-future (skip) → in-window (collect)
  //     → past-window (BREAK). 5 in-window rows, 1 null-date (counted), then a
  //     past-window row that must stop the scan (page 2 must NEVER be fetched).
  const page1 = [
    row(900, 5e6, "F1"), row(700, 5e6, "F2"), row(600, 5e6, "F3"), // d>548 far future → skip
    row(500, 5e6, "W1"), row(300, 9e6, "W2"),                       // in window
    row(null, 5e6, "NULL1"),                                        // missing end date → counted
    row(100, 2e6, "W3"), row(10, 8e6, "W4"), row(-30, 1e6, "W5"),   // in window (−30 > −90)
    row(-200, 4e6, "P1"),                                           // d<−90 → pastWindow BREAK
  ];
  const poisonPage2 = [row(-30, 9e9, "SHOULD_NOT_APPEAR")];
  await withFetch((u, init) => {
    if (!/spending_by_award(?!_count)/.test(u)) return failClosed()();
    const body = JSON.parse(init.body);
    // Guard the load-bearing PRECONDITION: the tool MUST request End-Date DESC
    // (the early-stop is only valid for a descending stream).
    ok("31a request sorts by End Date DESC (early-stop precondition)",
      body.sort === "End Date" && body.order === "desc", JSON.stringify({ sort: body.sort, order: body.order }));
    return mockResponse({ status: 200, json: { results: body.page === 1 ? page1 : poisonPage2, page_metadata: { hasNext: true, page: body.page } } });
  }, async (calls) => {
    const res = await searchRecompetes({ agency: "Department of Defense", scanBudgetPages: 5 });
    const d = res.data, m = res.meta;
    const ds = d.recompetes.map((r) => r.daysUntilCurrentEnd);
    ok("31a collects EXACTLY the 5 in-window rows (past-window rows NOT over-collected — the break holds)",
      d.recompetes.length === 5, JSON.stringify(ds));
    ok("31a no far-future / past-window / null row leaked in (ids are W1..W5 only)",
      d.recompetes.every((r) => /^W\d$/.test(r.awardId)), JSON.stringify(d.recompetes.map((r) => r.awardId)));
    ok("31a sorted soonest-first (daysUntilCurrentEnd strictly ascending)",
      ds.every((v, i) => i === 0 || v > ds[i - 1]), JSON.stringify(ds));
    ok("31a totalAvailable EXACT (=5) — the window end was reached (early-stop fired), not truncated",
      m.totalAvailable === 5 && m.truncated === false, JSON.stringify({ ta: m.totalAvailable, tr: m.truncated }));
    ok("31a missing End Date COUNTED + disclosed (never silently dropped)",
      m.notes.some((n) => /had no usable current PoP end date/i.test(n)), JSON.stringify(m.notes));
    const awardCalls = calls.filter((c) => /spending_by_award(?!_count)/.test(c.url)).length;
    ok("31a EARLY-STOP: page 2 never fetched (pastWindow break) — exactly 1 award page scanned",
      awardCalls === 1, `awardCalls=${awardCalls}`);
  });

  // (b) TRUNCATED: the far-future tail fills the entire scan budget before the
  //     window is reached ⇒ totalAvailable NULL (unknown), results a LOWER BOUND
  //     — never a confident empty/exact-0. (The real DoD tail is exactly this:
  //     live, 200 consecutive rows all ended beyond the 18-month window.)
  const farFuturePage = Array.from({ length: 100 }, (_, i) => row(900 - i, 5e6, `FF${i}`)); // all d>548
  await withFetch((u) => {
    if (!/spending_by_award(?!_count)/.test(u)) return failClosed()();
    return mockResponse({ status: 200, json: { results: farFuturePage, page_metadata: { hasNext: true, page: 1 } } });
  }, async (calls) => {
    const res = await searchRecompetes({ agency: "Department of Defense", scanBudgetPages: 2 });
    const d = res.data, m = res.meta;
    ok("31b far-future tail exhausts budget ⇒ 0 in-window rows collected (a LOWER BOUND, not a real empty)",
      d.recompetes.length === 0, JSON.stringify(d.recompetes.length));
    ok("31b totalAvailable === null (unknown — NOT a confident 0)", m.totalAvailable === null, JSON.stringify(m.totalAvailable));
    ok("31b truncated === true", m.truncated === true, JSON.stringify(m.truncated));
    ok("31b note discloses the LOWER BOUND + exhausted scan budget",
      m.notes.some((n) => /LOWER BOUND/.test(n) && /scan budget/i.test(n)), JSON.stringify(m.notes));
    const awardCalls = calls.filter((c) => /spending_by_award(?!_count)/.test(c.url)).length;
    ok("31b scanned the full budget (2 pages) before giving up", awardCalls === 2, `awardCalls=${awardCalls}`);
  });
}

// §32: usas_spending_over_time contract-only truthfulness (SOT-1, DA-1 class).
// buildFilters hardcodes award_type_codes A/B/C/D (contracts), so the endpoint's
// Grant_Obligations / Idv_Obligations come back 0 for EVERY bucket — not because
// the agency has no grant/IDV spending (LIVE 2026-07-06: DoD grants ~$4.8B in
// FY2008), but because grants (02–05) and IDVs (IDV_*) are FILTERED OUT. The old
// code mapped `?? 0`, emitting grantObligations:0 / idvObligations:0 — a fabricated
// zero that reads as "this agency has no grant/IDV spending". It also returned NO
// tool-specific _meta (contract-only scope undisclosed). Fix: null (not 0) for the
// excluded fields + a contracts-only _meta disclosure. NON-VACUITY: reverting the
// nulls to `?? 0` makes 32's grant/idv assertions RED.
async function testSpendingOverTimeContractScope() {
  section("32. usas_spending_over_time — contract-only scope (SOT-1): grant/IDV obligations null (NOT fabricated 0), _meta discloses the A/B/C/D scope");

  // A VERBATIM-shaped spending_over_time response under the tool's A/B/C/D filter:
  // Grant/Idv obligations come back 0 (filtered out), aggregated_amount === Contract.
  const RESP = {
    group: "fiscal_year",
    results: [
      { time_period: { fiscal_year: "2024" }, aggregated_amount: 1000, Contract_Obligations: 1000, Grant_Obligations: 0, Idv_Obligations: 0, Direct_Obligations: 0, Loan_Obligations: 0, Other_Obligations: 0 },
      { time_period: { fiscal_year: "2025" }, aggregated_amount: 2500, Contract_Obligations: 2500, Grant_Obligations: 0, Idv_Obligations: 0 },
    ],
  };
  await withFetch((u) => {
    if (!/spending_over_time/.test(u)) return failClosed()();
    return mockResponse({ status: 200, json: RESP });
  }, async () => {
    const res = await spendingOverTime({ agency: "Department of Defense" });
    const t = res.data.timeline;
    ok("32 timeline maps every bucket (2)", t.length === 2, JSON.stringify(t.length));
    ok("32 total === contractObligations (contract-only view; aggregated_amount IS the contract obligation)",
      t.every((x) => x.total === x.contractObligations), JSON.stringify(t.map((x) => [x.total, x.contractObligations])));
    ok("32 total is the REAL contract number (1000, 2500 — unchanged)",
      t[0].total === 1000 && t[1].total === 2500, JSON.stringify(t.map((x) => x.total)));
    ok("32 grantObligations === null (NOT a fabricated 0 — grants are FILTERED OUT, not zero)",
      t.every((x) => x.grantObligations === null), JSON.stringify(t.map((x) => x.grantObligations)));
    ok("32 idvObligations === null (NOT a fabricated 0 — IDVs are FILTERED OUT, not zero)",
      t.every((x) => x.idvObligations === null), JSON.stringify(t.map((x) => x.idvObligations)));
    // _meta now exists and DISCLOSES the contract-only scope (was a bare object before).
    ok("32 _meta.source is spending_over_time", /spending_over_time/.test(res.meta.source ?? ""), JSON.stringify(res.meta.source));
    ok("32 _meta.fieldsUnavailable flags grant/IDV as EXCLUDED (not zero)",
      res.meta.fieldsUnavailable.some((f) => /grantObligations/.test(f)) && res.meta.fieldsUnavailable.some((f) => /idvObligations/.test(f)),
      JSON.stringify(res.meta.fieldsUnavailable));
    ok("32 _meta.notes discloses CONTRACT-only scope + null-not-0 rationale",
      res.meta.notes.some((n) => /CONTRACT obligations only/.test(n)) && res.meta.notes.some((n) => /null \(NOT 0\)/.test(n)),
      JSON.stringify(res.meta.notes));
    ok("32 _meta.truncated false + totalAvailable = full timeline (endpoint returns the whole series)",
      res.meta.truncated === false && res.meta.totalAvailable === 2, JSON.stringify({ tr: res.meta.truncated, ta: res.meta.totalAvailable }));
    ok("32 fiscal_year granularity ⇒ NO month/quarter completeness caveat (no-cap live-verified for FY)",
      !res.meta.notes.some((n) => /Completeness for group/.test(n)), JSON.stringify(res.meta.notes));
  });

  // group=month ⇒ completeness caveat present (no-cap verified ONLY for fiscal_year;
  // the endpoint has no pagination envelope so a long month series could be silently
  // capped) + the span label is UNAMBIGUOUS (FY2024-M10, not "2024 10"). (Review item 4/5.)
  const MRESP = {
    group: "month",
    results: [
      { time_period: { fiscal_year: "2024", month: "10" }, aggregated_amount: 5, Contract_Obligations: 5, Grant_Obligations: 0, Idv_Obligations: 0 },
      { time_period: { fiscal_year: "2024", month: "11" }, aggregated_amount: 7, Contract_Obligations: 7, Grant_Obligations: 0, Idv_Obligations: 0 },
    ],
  };
  await withFetch((u) => {
    if (!/spending_over_time/.test(u)) return failClosed()();
    return mockResponse({ status: 200, json: MRESP });
  }, async () => {
    const res = await spendingOverTime({ agency: "Department of Defense", group: "month" });
    ok("32 group=month ⇒ completeness caveat disclosed (silent-cap risk; no pagination envelope)",
      res.meta.notes.some((n) => /Completeness for group='month'/.test(n)), JSON.stringify(res.meta.notes));
    ok("32 span note uses UNAMBIGUOUS period labels (FY2024-M10, never '2024 10')",
      res.meta.notes.some((n) => /FY2024-M10/.test(n)), JSON.stringify(res.meta.notes));
  });

  // group=quarter ⇒ FY2024-Q1 span label (unambiguous vs month) + caveat present.
  const QRESP = {
    group: "quarter",
    results: [{ time_period: { fiscal_year: "2024", quarter: "1" }, aggregated_amount: 9, Contract_Obligations: 9, Grant_Obligations: 0, Idv_Obligations: 0 }],
  };
  await withFetch((u) => (/spending_over_time/.test(u) ? mockResponse({ status: 200, json: QRESP }) : failClosed()()), async () => {
    const res = await spendingOverTime({ group: "quarter" });
    ok("32 group=quarter ⇒ FY2024-Q1 span label (Q disambiguated from month) + caveat",
      res.meta.notes.some((n) => /FY2024-Q1/.test(n)) && res.meta.notes.some((n) => /Completeness for group='quarter'/.test(n)), JSON.stringify(res.meta.notes));
  });

  // empty results ⇒ empty timeline, generic (no-span) note, totalAvailable 0 — never a crash.
  await withFetch((u) => (/spending_over_time/.test(u) ? mockResponse({ status: 200, json: { group: "fiscal_year", results: [] } }) : failClosed()()), async () => {
    const res = await spendingOverTime({ agency: "Nowhere Agency" });
    ok("32 empty series ⇒ timeline [], totalAvailable 0, truncated false, generic 0-is-genuine note (no crash)",
      res.data.timeline.length === 0 && res.meta.totalAvailable === 0 && res.meta.truncated === false &&
      res.meta.notes.some((n) => /genuine zero for CONTRACT obligations/.test(n)), JSON.stringify({ n: res.data.timeline.length, ta: res.meta.totalAvailable }));
  });
}

// §33: sam_lookup_organization — a 5xx OUTAGE must NOT be reported as "org not
// found" (ORG-1, fetch-failure-as-absent). The handler did `if(!r.ok) return
// {found:false,...}` for EVERY non-2xx, so a 503/WAF-block during a SAM outage made
// every organization "not found" (SAM outages are real — see the WAF handling
// elsewhere). Fix: 404 → found:false (a real negative); any other non-2xx → a
// classified retryable error (upstream_unavailable / rate_limited), matching the
// server's taxonomy. The lint missed this because the returned shape wasn't an
// EMPTY literal ({found:false,status} has keys) — a reminder the invariant is
// semantic, not syntactic. NON-VACUITY: reverting to a blanket found:false makes
// the 503/429 cases return instead of throw → 33a/33b RED.
async function testLookupOrgOutageHonesty() {
  section("33. sam_lookup_organization — 5xx/429 OUTAGE ⇒ classified retryable error, NOT a fake 'org not found' (ORG-1)");
  const sam = new SamGovClient({});
  const isOrg = (u) => /\/federalorganizations\/v1\/organizations\//.test(u);

  // 503 outage ⇒ THROW upstream_unavailable (retryable) + upstreamStatus, never found:false.
  await withFetch((u) => (isOrg(u) ? mockResponse({ status: 503 }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => runTool("sam_lookup_organization", { organizationId: "100000000" }, sam));
    ok("33a 503 ⇒ THROWS upstream_unavailable+retryable+upstreamStatus (a down service is never 'org not found')",
      threw && error?.toolError?.kind === "upstream_unavailable" && error?.toolError?.retryable === true && error?.toolError?.upstreamStatus === 503,
      JSON.stringify({ threw, kind: error?.toolError?.kind, retryable: error?.toolError?.retryable, us: error?.toolError?.upstreamStatus }));
  });

  // 429 ⇒ THROW rate_limited (retryable).
  await withFetch((u) => (isOrg(u) ? mockResponse({ status: 429 }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => runTool("sam_lookup_organization", { organizationId: "100000000" }, sam));
    ok("33b 429 ⇒ THROWS rate_limited (retryable)",
      threw && error?.toolError?.kind === "rate_limited" && error?.toolError?.retryable === true, JSON.stringify(error?.toolError?.kind));
  });

  // 404 ⇒ the GENUINE not-found case STILL returns found:false (not thrown) — we
  // only reclassify OUTAGES, we don't break real absence.
  await withFetch((u) => (isOrg(u) ? mockResponse({ status: 404 }) : failClosed()()), async () => {
    const res = await runTool("sam_lookup_organization", { organizationId: "NOPE-000" }, sam);
    ok("33c 404 ⇒ found:false (real absence preserved, NOT thrown)",
      res.found === false && res.status === 404, JSON.stringify(res));
  });

  // 200 with an org ⇒ found:true + mapped fields (happy path intact).
  await withFetch((u) => (isOrg(u) ? mockResponse({ status: 200, json: { _embedded: [{ org: { agencyName: "DEPARTMENT OF X", fullParentPathName: "X.Y", name: "Y OFFICE", type: "OFFICE", level: 3 } }] } }) : failClosed()()), async () => {
    const res = await runTool("sam_lookup_organization", { organizationId: "100000000" }, sam);
    ok("33d 200 with org ⇒ found:true + fields mapped (happy path intact)",
      res.found === true && res.agencyName === "DEPARTMENT OF X" && res.level === 3, JSON.stringify({ f: res.found, a: res.agencyName }));
  });

  // 400 ⇒ invalid_input, NON-retryable (a malformed id — retrying can't help; via
  // the shared errorFromResponse matrix, not lumped into retryable upstream_unavailable).
  await withFetch((u) => (isOrg(u) ? mockResponse({ status: 400 }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => runTool("sam_lookup_organization", { organizationId: "bad id" }, sam));
    ok("33e 400 ⇒ invalid_input + retryable:false (NOT a retry-forever upstream_unavailable)",
      threw && error?.toolError?.kind === "invalid_input" && error?.toolError?.retryable === false, JSON.stringify({ kind: error?.toolError?.kind, retryable: error?.toolError?.retryable }));
  });

  // 200 + EMPTY body ⇒ found:false — this endpoint's real not-found signal
  // (live-verified). Must NOT crash r.json() into a mislabeled `unknown`.
  await withFetch((u) => (isOrg(u) ? mockResponse({ status: 200, json: "" }) : failClosed()()), async () => {
    const res = await runTool("sam_lookup_organization", { organizationId: "999999999999" }, sam);
    ok("33f 200 + empty body ⇒ found:false (genuine absence, not an `unknown` crash)",
      res.found === false && res.status === 200, JSON.stringify(res));
  });

  // 200 + non-JSON body (HTML error/interstitial) ⇒ schema_drift — degraded, NOT
  // a fabricated found:false on garbage.
  await withFetch((u) => (isOrg(u) ? mockResponse({ status: 200, json: "<html>Access Denied</html>" }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => runTool("sam_lookup_organization", { organizationId: "100000000" }, sam));
    ok("33g 200 + non-JSON body ⇒ schema_drift (unconfirmed, NOT fabricated found:false)",
      threw && error?.toolError?.kind === "schema_drift", JSON.stringify(error?.toolError?.kind));
  });
}

// §34: usas_get_recipient_profile — a NONEXISTENT recipient is not_found, not
// invalid_input (RECIP-1). USAspending signals a missing recipient with HTTP 400 +
// detail "Recipient ID not found: '...'" (LIVE-VERIFIED — NOT a 404). The old path
// (getUsas → fetchWithRetry → errorFromResponse) mapped that 400 to invalid_input
// ("Bad request"), telling a caller its recipient_id was MALFORMED when the
// recipient simply doesn't exist. Fix: inspect the 400 body — "not found" → not_found;
// a genuine bad-input 400 stays invalid_input; 5xx stays retryable; 200 maps.
// NON-VACUITY: reverting to getUsas makes 34a assert not_found on an invalid_input → RED.
async function testRecipientProfileNotFound() {
  section("34. usas_get_recipient_profile — nonexistent recipient ⇒ not_found (NOT invalid_input); USAspending's 400 'Recipient ID not found' classified honestly (RECIP-1)");
  const isRecipient = (u) => /\/api\/v2\/recipient\/[^/]+\/?$/.test(u);

  // 34a: 400 + "Recipient ID not found" ⇒ not_found (the real absence case).
  await withFetch((u) => (isRecipient(u) ? mockResponse({ status: 400, json: { detail: "Recipient ID not found: '00000000-0000-0000-0000-000000000000-C'" } }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => getRecipientProfile("00000000-0000-0000-0000-000000000000-C"));
    ok("34a 400 'Recipient ID not found' ⇒ not_found (NOT invalid_input 'bad request')",
      threw && error?.toolError?.kind === "not_found" && error?.toolError?.retryable === false && error?.toolError?.upstreamStatus === 400,
      JSON.stringify({ kind: error?.toolError?.kind, us: error?.toolError?.upstreamStatus }));
    ok("34a not_found message names the recipient_id + points at usas_search_recipients",
      /usas_search_recipients/.test(error?.toolError?.message ?? "") && /not.?found/i.test(error?.toolError?.message ?? ""),
      JSON.stringify(error?.toolError?.message));
  });

  // 34b: a GENUINELY malformed-input 400 (no "not found" detail) ⇒ invalid_input
  // (we only reclassify the not-found 400, not every 400).
  await withFetch((u) => (isRecipient(u) ? mockResponse({ status: 400, json: { detail: "Field 'recipient_id' has an invalid format." } }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => getRecipientProfile("garbage"));
    ok("34b malformed 400 (no 'not found') ⇒ stays invalid_input (we don't over-reclassify)",
      threw && error?.toolError?.kind === "invalid_input", JSON.stringify(error?.toolError?.kind));
  });

  // 34c: 503 ⇒ upstream_unavailable retryable (an outage is never not_found).
  await withFetch((u) => (isRecipient(u) ? mockResponse({ status: 503 }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => getRecipientProfile("VALID-ID"));
    ok("34c 503 ⇒ upstream_unavailable + retryable (outage, not not_found)",
      threw && error?.toolError?.kind === "upstream_unavailable" && error?.toolError?.retryable === true, JSON.stringify(error?.toolError?.kind));
  });

  // 34d: 200 with a real profile ⇒ maps fields (happy path intact).
  await withFetch((u) => (isRecipient(u) ? mockResponse({ status: 200, json: { name: "ACME CORP", recipient_id: "abc-C", recipient_level: "R", total_transaction_amount: 5000, total_transactions: 3 } }) : failClosed()()), async () => {
    const res = await getRecipientProfile("abc-C");
    ok("34d 200 ⇒ maps name/level/totalAmount/totalTransactions (happy path intact)",
      res.name === "ACME CORP" && res.level === "R" && res.totalAmount === 5000 && res.totalTransactions === 3, JSON.stringify(res));
  });

  // 34e: HOLLOW 200 (no recipient_id and no name) ⇒ schema_drift, NOT a fabricated
  // { name:"" } profile (defensive guard; cf. sam_lookup_organization / grants).
  await withFetch((u) => (isRecipient(u) ? mockResponse({ status: 200, json: { total_transaction_amount: 0 } }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => getRecipientProfile("degraded-C"));
    ok("34e hollow 200 (no id/name) ⇒ schema_drift (NOT a fabricated empty profile)",
      threw && error?.toolError?.kind === "schema_drift", JSON.stringify(error?.toolError?.kind));
  });
}

// §35: agency-detail workflow tools (usas_get_agency_profile /
// usas_get_agency_budget_function) — offline mapping + not_found. C73 live-verified
// both sound (agency lookup→profile round-trip consistent for DoD/VA/DHS; nonexistent
// toptier → 404 "does not exist"; budget_function current-FY populated with a real
// page_metadata.total), but neither had ANY offline guard. This locks in: the field
// mapping, the REAL total (page_metadata.total, never the returned-row count), and
// the not_found classification of a nonexistent toptier code.
async function testAgencyDetailTools() {
  section("35. usas_get_agency_profile / _budget_function — offline mapping + not_found (workflow-chain tools, were untested offline)");
  const isProfile = (u) => /\/agency\/[^/]+\/?(\?|$)/.test(u) && !/budget_function|\/awards/.test(u);
  const isBudget = (u) => /\/agency\/[^/]+\/budget_function\//.test(u);

  // 35a getAgencyProfile 200 ⇒ maps fields.
  await withFetch((u) => (isProfile(u) ? mockResponse({ status: 200, json: { toptier_code: "097", name: "Department of Defense", abbreviation: "DOD", subtier_agency_count: 40, mission: "Provide the military forces." } }) : failClosed()()), async () => {
    const res = await getAgencyProfile("097");
    ok("35a getAgencyProfile 200 ⇒ maps toptierCode/name/abbreviation/subtierAgencyCount",
      res.toptierCode === "097" && res.name === "Department of Defense" && res.abbreviation === "DOD" && res.subtierAgencyCount === 40, JSON.stringify(res));
  });

  // 35b getAgencyProfile nonexistent code (404) ⇒ not_found (never a fabricated empty profile).
  await withFetch((u) => (isProfile(u) ? mockResponse({ status: 404, json: { detail: "Agency with a toptier code of '999' does not exist" } }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => getAgencyProfile("999"));
    ok("35b getAgencyProfile nonexistent code ⇒ not_found (via getUsas classification, not a fake empty profile)",
      threw && error?.toolError?.kind === "not_found", JSON.stringify(error?.toolError?.kind));
  });

  // 35c getAgencyBudgetFunction 200 ⇒ maps functions/programs + the REAL total from
  // page_metadata.total (NOT the returned-row count — the endpoint reports a true total).
  await withFetch((u) => (isBudget(u) ? mockResponse({ status: 200, json: {
    toptier_code: "097", fiscal_year: 2026,
    results: [
      { name: "National Defense", children: [{ name: "Dept of the Army", obligated_amount: 1035482198021.19, gross_outlay_amount: 900000000000 }] },
      { name: "Income Security", children: [{ name: "Military retirement", obligated_amount: 50000000000, gross_outlay_amount: 48000000000 }] },
    ],
    page_metadata: { page: 1, total: 6, hasNext: true },
  } }) : failClosed()()), async () => {
    const res = await getAgencyBudgetFunction({ toptierCode: "097", fiscalYear: 2026, limit: 2 });
    const f = res.data.functions;
    ok("35c getAgencyBudgetFunction 200 ⇒ maps functions/programs (name/obligated/outlays)",
      f.length === 2 && f[0].name === "National Defense" && f[0].programs[0].obligated === 1035482198021.19 && f[0].programs[0].outlays === 900000000000, JSON.stringify(f[0]));
    ok("35c _meta.totalAvailable === page_metadata.total (6, the REAL FY count) — NOT the 2 returned rows; truncated true",
      res.meta.totalAvailable === 6 && res.meta.truncated === true, JSON.stringify({ ta: res.meta.totalAvailable, tr: res.meta.truncated }));
  });

  // 35d getAgencyBudgetFunction nonexistent code (404) ⇒ not_found.
  await withFetch((u) => (isBudget(u) ? mockResponse({ status: 404, json: { detail: "Agency with a toptier code of '999' does not exist" } }) : failClosed()()), async () => {
    const { threw, error } = await expectThrow(() => getAgencyBudgetFunction({ toptierCode: "999", fiscalYear: 2024 }));
    ok("35d getAgencyBudgetFunction nonexistent code ⇒ not_found (not a fabricated empty budget)",
      threw && error?.toolError?.kind === "not_found", JSON.stringify(error?.toolError?.kind));
  });

  // 35e VQ-2 (C80 dogfooding): getAgencyAwardsSummary `obligations` spans ALL award
  // types (contracts+grants+direct benefit payments+loans), so a benefit-heavy
  // agency's total is dominated by benefits, NOT procurement. The _meta MUST disclose
  // this scope + point to the contracts-only figure, else an agent misreads it as the
  // contract/procurement market (live: VA FY2024 $238B all-awards vs $67B contracts).
  const isAwards = (u) => /\/agency\/[^/]+\/awards\//.test(u);
  await withFetch((u) => (isAwards(u) ? mockResponse({ status: 200, json: { fiscal_year: 2024, toptier_code: "036", transaction_count: 547752, obligations: 238398048248.85, latest_action_date: "2024-09-30T00:00:00" } }) : failClosed()()), async () => {
    const res = await getAgencyAwardsSummary({ toptierCode: "036", fiscalYear: 2024 });
    ok("35e getAgencyAwardsSummary ⇒ obligations mapped + returned:1 (not a bare-object returned:0) + filtersApplied declares toptierCode+fiscalYear (URL-param filters, FILT-1 consistency)",
      res.data.obligations === 238398048248.85 && res.meta.returned === 1 &&
      (res.meta.filtersApplied || []).includes("toptierCode") && (res.meta.filtersApplied || []).includes("fiscalYear"),
      JSON.stringify({ o: res.data.obligations, r: res.meta.returned, fa: res.meta.filtersApplied }));
    ok("35e VQ-2 ⇒ _meta discloses obligations spans ALL award types (NOT procurement only) + points to contractObligations",
      (res.meta.notes || []).some((n) => /ALL award types/i.test(n) && /(NOT|not)\b/.test(n) && /procurement|contracts only/i.test(n) && /contractObligations/.test(n)),
      JSON.stringify(res.meta.notes));
  });
  // 35e-2: sparse response + default fiscalYear ⇒ absent count/obligations default
  // to 0 (never undefined/NaN), and the scope disclosure still fires.
  await withFetch((u) => (isAwards(u) ? mockResponse({ status: 200, json: { toptier_code: "036" } }) : failClosed()()), async () => {
    const res = await getAgencyAwardsSummary({ toptierCode: "036" });
    ok("35e-2 sparse response + no fiscalYear ⇒ transactionCount/obligations default to 0 (not undefined) + scope note still present",
      res.data.transactionCount === 0 && res.data.obligations === 0 && (res.meta.notes || []).some((n) => /ALL award types/i.test(n)),
      JSON.stringify({ tc: res.data.transactionCount, o: res.data.obligations, notes: (res.meta.notes || []).length }));
  });
}

// §36: usas_search_subawards — field mapping (A3 fix) + count-honesty. This tool
// was live-smoke only (no offline guard). Locks in TWO real invariants: (1) the A3
// fix — subaward NAICS is read from the "NAICS" field, NOT the invalid "Sub-Award
// NAICS" the old code sent (which spending_by_award silently echoes back as null,
// so the arg looked honored but returned nothing); (2) totalAvailable is the SUM of
// the spending_by_award_count buckets (the REAL, uncapped total — LIVE-VERIFIED
// C75: DoD subcontracts = 2,209,649, NOT capped at 10k), never the returned page
// length. NON-VACUITY: mapping naicsCode from a wrong field, or totalAvailable from
// results.length, turns the respective assertion RED.
async function testSearchSubawardsMapping() {
  section("36. usas_search_subawards — A3 NAICS field mapping + count-honesty (total = uncapped spending_by_award_count sum, not page length)");
  const isAwardPage = (u) => /spending_by_award(?!_count)/.test(u);
  const isAwardCount = (u) => /spending_by_award_count/.test(u);

  await withFetch((u, init) => {
    if (isAwardCount(u)) return mockResponse({ status: 200, json: { results: { subcontracts: 2209649, subgrants: 0 } } });
    if (isAwardPage(u)) {
      // A3 GUARD: the request MUST ask for "NAICS" (valid), never "Sub-Award NAICS"
      // (invalid → silent null), and must set subawards:true.
      const body = JSON.parse(init.body);
      ok("36 request uses subawards:true + the VALID 'NAICS' field (A3: never 'Sub-Award NAICS')",
        body.subawards === true && body.fields.includes("NAICS") && !body.fields.includes("Sub-Award NAICS"),
        JSON.stringify({ sub: body.subawards, fields: body.fields }));
      return mockResponse({ status: 200, json: { results: [
        { "Sub-Award ID": "SUB1", "Sub-Award Recipient": "ACME SUBCONTRACTOR LLC", "Sub-Award Amount": 50000, "Sub-Award Date": "2025-03-01", NAICS: { code: "541512", description: "COMPUTER SYSTEMS DESIGN SERVICES" }, prime_award_generated_internal_id: "CONT_AWD_PRIME1" },
      ], page_metadata: { hasNext: true } } });
    }
    return failClosed()();
  }, async () => {
    const res = await searchSubawards({ agency: "Department of Defense", limit: 1 });
    const s0 = res.data.subawards[0];
    ok("36 maps subaward row (subAwardId/subRecipient/amount/actionDate/primeAwardId)",
      s0.subAwardId === "SUB1" && s0.subRecipient === "ACME SUBCONTRACTOR LLC" && s0.amount === 50000 && s0.actionDate === "2025-03-01" && s0.primeAwardId === "CONT_AWD_PRIME1",
      JSON.stringify(s0));
    ok("36 A3: naicsCode/naicsDescription mapped from the NAICS{code,description} field (not silently null)",
      s0.naicsCode === "541512" && s0.naicsDescription === "COMPUTER SYSTEMS DESIGN SERVICES", JSON.stringify({ c: s0.naicsCode, d: s0.naicsDescription }));
    ok("36 count-honesty: totalAvailable = SUM of spending_by_award_count buckets (2,209,649) — the REAL uncapped total, NOT the 1 returned row",
      res.meta.totalAvailable === 2209649, JSON.stringify(res.meta.totalAvailable));
  });
}

// §37: usas_search_teaming_partners — mostRecentAwardDate is the AWARD date (Base
// Obligation Date), NOT the PoP End Date (TEAM-1, Codex dogfood C76 lead 8). The old
// code sourced `const date = row["End Date"] ?? ...`, so a firm's "most recent award
// date" was the latest PoP END — which is FUTURE for ongoing contracts (live-verified:
// produced dates like 2027-06-17). Fix sources Base Obligation Date (always past).
// NON-VACUITY: sourcing from End Date makes mostRecentAwardDate the future 2027 date → RED.
async function testTeamingMostRecentAwardDate() {
  section("37. usas_search_teaming_partners — mostRecentAwardDate = award (Base Obligation) date, NOT the future PoP End Date (TEAM-1)");
  const isAwardCount = (u) => /spending_by_award_count/.test(u);
  const isAwardPage = (u) => /spending_by_award(?!_count)/.test(u);

  // One recipient with TWO awards: the more recent AWARD (base obligation 2024-03-01)
  // runs to a FUTURE end (2027-06-17); the older award (base 2022-01-01) ended 2025.
  // mostRecentAwardDate must be 2024-03-01 (latest base obligation), NEVER 2027-06-17.
  const rows = [
    { "Award ID": "A1", "Recipient Name": "ACME ANALYTICS LLC", "Award Amount": 900000, recipient_id: "r1", NAICS: { code: "541512" }, "Awarding Agency": "Department of Veterans Affairs", "Start Date": "2024-03-01", "End Date": "2027-06-17", "Base Obligation Date": "2024-03-01" },
    { "Award ID": "A2", "Recipient Name": "ACME ANALYTICS LLC", "Award Amount": 500000, recipient_id: "r1", NAICS: { code: "541512" }, "Awarding Agency": "Department of Veterans Affairs", "Start Date": "2022-01-01", "End Date": "2025-01-01", "Base Obligation Date": "2022-01-01" },
  ];
  await withFetch((u) => {
    if (isAwardCount(u)) return mockResponse({ status: 200, json: { results: { contracts: 2 } } });
    if (isAwardPage(u)) return mockResponse({ status: 200, json: { results: rows, page_metadata: { hasNext: false, page: 1 } } });
    return failClosed()();
  }, async () => {
    // excludeDebarred:false → skip the SAM exclusion screen (keep the mock focused).
    const res = await searchTeamingPartners({ cert: "small_business", naics: "541512", excludeDebarred: false, limit: 5 });
    const c0 = res.data.candidates[0];
    ok("37 mostRecentAwardDate = 2024-03-01 (latest Base Obligation / award date) — NOT the future PoP end 2027-06-17",
      c0.mostRecentAwardDate === "2024-03-01", JSON.stringify({ mrad: c0.mostRecentAwardDate, name: c0.recipientName }));
    ok("37 mostRecentAwardDate is NOT in the future (award dates are always past)",
      c0.mostRecentAwardDate <= "2026-07-06", JSON.stringify(c0.mostRecentAwardDate));
    ok("37 sampleAwards[].date is also the award (base obligation) date, not the PoP end",
      c0.sampleAwards.every((s) => s.date !== "2027-06-17") && c0.sampleAwards.some((s) => s.date === "2024-03-01"),
      JSON.stringify(c0.sampleAwards.map((s) => s.date)));
  });

  // 37b: fallback — a row with NO Base Obligation Date falls back to Start Date
  // (a past recency proxy). "End Date" is DELIBERATELY NOT a fallback (adversarial-
  // review Finding 2/3): a row whose ONLY date is a FUTURE End Date must contribute
  // NO date, so that future value can never become mostRecentAwardDate.
  const fbRows = [
    { "Award ID": "B1", "Recipient Name": "BETA CORP", "Award Amount": 300000, recipient_id: "rb", NAICS: { code: "541512" }, "Awarding Agency": "VA", "Start Date": "2023-05-05", "End Date": "2028-01-01" }, // no Base ⇒ Start Date (NOT the future End)
    { "Award ID": "B2", "Recipient Name": "BETA CORP", "Award Amount": 200000, recipient_id: "rb", NAICS: { code: "541512" }, "Awarding Agency": "VA", "End Date": "2029-12-31" }, // ONLY a future End Date ⇒ contributes null, never sourced
  ];
  await withFetch((u) => {
    if (isAwardCount(u)) return mockResponse({ status: 200, json: { results: { contracts: 2 } } });
    if (isAwardPage(u)) return mockResponse({ status: 200, json: { results: fbRows, page_metadata: { hasNext: false, page: 1 } } });
    return failClosed()();
  }, async () => {
    const res = await searchTeamingPartners({ cert: "small_business", naics: "541512", excludeDebarred: false, limit: 5 });
    const c = res.data.candidates[0];
    // B1 → Start 2023-05-05 (no Base); B2 → null (only End, dropped). Max = 2023-05-05.
    ok("37b no Base ⇒ Start Date; future End Date NEVER sourced ⇒ mostRecentAwardDate = 2023-05-05 (not 2028/2029)",
      c.mostRecentAwardDate === "2023-05-05", JSON.stringify(c.mostRecentAwardDate));
    ok("37b a future End Date never appears as an award date (mostRecent + sampleAwards exclude 2028-01-01 / 2029-12-31)",
      c.mostRecentAwardDate !== "2028-01-01" && c.mostRecentAwardDate !== "2029-12-31" &&
        c.sampleAwards.every((s) => s.date !== "2028-01-01" && s.date !== "2029-12-31"),
      JSON.stringify({ mostRecent: c.mostRecentAwardDate, sample: c.sampleAwards.map((s) => s.date) }));
  });

  // 37c: excludeDebarred integrity screen — an active exclusion whose NORMALIZED
  // name EXACTLY matches a candidate drops it; a clean same-NAICS firm sharing no
  // name is KEPT (the shared-token false-positive trap must not remove it).
  const screenRows = [
    { "Award ID": "A1", "Recipient Name": "ALPHA CORP", "Award Amount": 500000, recipient_id: "ra", NAICS: { code: "541512" }, "Awarding Agency": "VA", "Base Obligation Date": "2024-01-01" },
    { "Award ID": "D1", "Recipient Name": "DEBARRED CO", "Award Amount": 400000, recipient_id: "rd", NAICS: { code: "541512" }, "Awarding Agency": "VA", "Base Obligation Date": "2024-06-01" },
  ];
  await withFetch((u) => {
    if (isAwardCount(u)) return mockResponse({ status: 200, json: { results: { contracts: 2 } } });
    if (isAwardPage(u)) return mockResponse({ status: 200, json: { results: screenRows, page_metadata: { hasNext: false, page: 1 } } });
    // Same HAL for every screen call; checkExclusions' own name-gate keeps it only
    // for the DEBARRED CO query, so ALPHA CORP screens clean without URL-sniffing.
    if (isSgs(u)) return mockResponse({ status: 200, json: { _embedded: { results: [{ title: "DEBARRED CO", isActive: true, ueiSam: "UD", cageCode: "CD" }] }, page: { totalElements: 1 } } });
    return failClosed()();
  }, async () => {
    const res = await searchTeamingPartners({ cert: "small_business", naics: "541512", excludeDebarred: true, limit: 10 });
    const names = res.data.candidates.map((c) => c.recipientName);
    ok("37c excludeDebarred: active EXACT-name-match exclusion ⇒ debarred firm DROPPED",
      !names.includes("DEBARRED CO"), JSON.stringify(names));
    ok("37c excludeDebarred: clean same-NAICS firm KEPT (shared-token false-positive avoided)",
      names.includes("ALPHA CORP"), JSON.stringify(names));
    ok("37c screen disclosed: note reports exactly one active-exclusion drop",
      res.meta.notes.some((n) => /1 with an active exclusion (was|were) dropped/i.test(n)),
      JSON.stringify(res.meta.notes));
  });

  // 37d: a row with NO date fields at all ⇒ mostRecentAwardDate stays null (no
  // fabricated date); sampleAwards[].date null too (honest absence, not a guess).
  const noDateRows = [
    { "Award ID": "N1", "Recipient Name": "GAMMA LLC", "Award Amount": 100000, recipient_id: "rg", NAICS: { code: "541512" }, "Awarding Agency": "VA" },
  ];
  await withFetch((u) => {
    if (isAwardCount(u)) return mockResponse({ status: 200, json: { results: { contracts: 1 } } });
    if (isAwardPage(u)) return mockResponse({ status: 200, json: { results: noDateRows, page_metadata: { hasNext: false, page: 1 } } });
    return failClosed()();
  }, async () => {
    const res = await searchTeamingPartners({ cert: "small_business", naics: "541512", excludeDebarred: false, limit: 5 });
    const c = res.data.candidates[0];
    ok("37d all date fields absent ⇒ mostRecentAwardDate is null (no fabricated date)",
      c.mostRecentAwardDate === null, JSON.stringify(c.mostRecentAwardDate));
    ok("37d sampleAwards[].date is null too (honest absence, not a guessed value)",
      c.sampleAwards.every((s) => s.date === null), JSON.stringify(c.sampleAwards.map((s) => s.date)));
  });

  // 37e: FAIL-CLOSED screen — when the exclusion screen ERRORS, the candidate is
  // NOT dropped, its excluded flag stays null (unknown ≠ clean), and the response
  // DISCLOSES that screening degraded. A failed screen must never read as a pass.
  const failRows = [
    { "Award ID": "E1", "Recipient Name": "DELTA CORP", "Award Amount": 250000, recipient_id: "re", NAICS: { code: "541512" }, "Awarding Agency": "VA", "Base Obligation Date": "2024-03-03" },
  ];
  await withFetch((u) => {
    if (isAwardCount(u)) return mockResponse({ status: 200, json: { results: { contracts: 1 } } });
    if (isAwardPage(u)) return mockResponse({ status: 200, json: { results: failRows, page_metadata: { hasNext: false, page: 1 } } });
    if (isSgs(u)) throw new Error("exclusions endpoint down"); // screen fails
    return failClosed()();
  }, async () => {
    const res = await searchTeamingPartners({ cert: "small_business", naics: "541512", excludeDebarred: true, limit: 5 });
    const c = res.data.candidates.find((x) => x.recipientName === "DELTA CORP");
    ok("37e screen failure ⇒ candidate NOT dropped (fail-closed, not fail-open)",
      c !== undefined, JSON.stringify(res.data.candidates.map((x) => x.recipientName)));
    ok("37e screen failure ⇒ excluded stays null (unknown, NOT a clearance)",
      c && c.excluded === null, JSON.stringify(c && c.excluded));
    ok("37e screen failure DISCLOSED (a failed screen is not a clean result)",
      res.meta.notes.some((n) => /screen FAILED/i.test(n) && /not a clean result/i.test(n)),
      JSON.stringify(res.meta.notes));
  });
}

async function main() {
  console.log("=== fault-injection + golden-fixture harness (OFFLINE, deterministic) ===");
  console.log("    imports dist/*.js; monkeypatches globalThis.fetch; makes NO network calls.");

  // Pure, no-fetch suites first.
  testBuildMeta();
  testGsaCsvParser();
  testGsaCsvEnrichment();
  testShapingHelpers();

  // Fetch-mocked suites.
  await testGetAwardDetail();
  await testAnalyzeIncumbent();
  await testCheckExclusions();
  await testIntegrityLookup();
  await testSbaSizeStandard();
  await testFarClauseLookup();
  await testFarComplianceMatrix();
  await testFarSearch();
  await testSearchOutageHonesty();
  await testSearchEnrichmentGating();
  await testGetOpportunityDetailHonesty();
  await testGetOpportunityEnrichmentHonesty();
  await testFetchAttachmentText();
  await testGrantsHonesty();
  await testFederalRegisterHonesty();
  await testPricingHonesty();
  await testGaoHonesty();
  await testParserFuzz();
  await testMetamorphic();
  await testPricingParseReplay();
  await testUsasPaginationTruthfulness();
  await testErrorTaxonomy();
  await testRealWdReplay();
  await testRealGaoReplay();
  await testRealEcfrReplay();
  await testRealUsasReplay();
  await testSubAgencyAwardsNull();
  await testFarFutureAsOfDate();
  await testUpstreamConcurrencyBounded();
  await testCalcBenchmarkDistribution();
  await testRecompeteWindowScan();
  await testSpendingOverTimeContractScope();
  await testLookupOrgOutageHonesty();
  await testRecipientProfileNotFound();
  await testAgencyDetailTools();
  await testSearchSubawardsMapping();
  await testTeamingMostRecentAwardDate();
  await testNaicsHierarchy();

  // Prove the harness bites.
  await selfCheck();

  console.log(`\n=== ${PASS}/${PASS + FAIL} passed ===`);
  if (FAIL > 0) {
    console.log("FAILURES:");
    for (const f of FAILURES) console.log(`  - ${f}`);
  }
  // Restore fetch defensively (all cases already restore in finally).
  globalThis.fetch = REAL_FETCH;
  globalThis.setTimeout = REAL_SET_TIMEOUT;
  process.exit(FAIL === 0 ? 0 : 1);
}

// §38: usas_naics_hierarchy drill-down (VQ-4). The tool must use the PATH form
// references/naics/{code}/ (node + its children), NOT ?filter= (a keyword search
// that fuzzy-matched sectors 32/45/48/54 and left hasChildren always false). The
// mock serves BOTH endpoint forms distinctly, so reverting to ?filter= yields the
// fuzzy 2-digit set and the drill-down assertions go RED (non-vacuity for the fix).
async function testNaicsHierarchy() {
  section("38. usas_naics_hierarchy — drill-down via path param (VQ-4): children, leaf, not-found");
  const node54 = {
    naics: "54", naics_description: "Professional, Scientific, and Technical Services", count: 52,
    children: [
      { naics: "5411", naics_description: "Legal Services", count: 4 },
      { naics: "5415", naics_description: "Computer Systems Design and Related Services", count: 30 },
    ],
  };
  const fuzzy = { results: [ { naics: "32", naics_description: "Manufacturing", count: 1 }, { naics: "45", naics_description: "Retail Trade", count: 1 }, { naics: "54", naics_description: "Prof/Sci/Tech", count: 1 } ] };
  await withFetch((u) => {
    if (/references\/naics\/54\//.test(u)) return mockResponse({ status: 200, json: { results: [node54] } }); // correct PATH form
    if (/references\/naics\/\?filter=54/.test(u)) return mockResponse({ status: 200, json: fuzzy });          // old ?filter= keyword search
    return failClosed()();
  }, async () => {
    const res = await naicsHierarchy({ naicsFilter: "54" });
    const codes = res.data.hierarchy.map((h) => h.code);
    ok("38 drill-down 54 ⇒ hierarchy is the CHILDREN (5411/5415), NOT the ?filter fuzzy 2-digit set (32/45/54); parent=54",
      codes.includes("5411") && codes.includes("5415") && !codes.includes("54") && !codes.includes("32") && res.data.parent?.code === "54",
      JSON.stringify({ codes, parent: res.data.parent?.code }));
    ok("38 hasChildren by code length ⇒ 4-digit children are drill-able (hasChildren:true), never a blanket false",
      res.data.hierarchy.length === 2 && res.data.hierarchy.every((h) => h.hasChildren === true),
      JSON.stringify(res.data.hierarchy.map((h) => [h.code, h.hasChildren])));
  });
  // Leaf: 6-digit node with no children ⇒ empty hierarchy + parent + honest leaf note.
  await withFetch((u) => (/references\/naics\/541512\//.test(u) ? mockResponse({ status: 200, json: { results: [{ naics: "541512", naics_description: "Computer Systems Design Services", count: 12 }] } }) : failClosed()()), async () => {
    const res = await naicsHierarchy({ naicsFilter: "541512" });
    ok("38 leaf (6-digit) ⇒ hierarchy empty + parent=541512 + found:true + honest 'leaf' note (never fabricated children)",
      res.data.hierarchy.length === 0 && res.data.parent?.code === "541512" && res.data.found === true && (res.meta.notes || []).some((n) => /leaf/i.test(n)),
      JSON.stringify({ h: res.data.hierarchy.length, p: res.data.parent?.code, found: res.data.found }));
  });
  // Not found: valid-format but nonexistent code ⇒ empty results ⇒ honest not-found note.
  await withFetch((u) => (/references\/naics\/999999\//.test(u) ? mockResponse({ status: 200, json: { results: [] } }) : failClosed()()), async () => {
    const res = await naicsHierarchy({ naicsFilter: "999999" });
    ok("38 nonexistent code ⇒ empty hierarchy + parent null + found:false (distinguishes not-found from leaf) + honest note",
      res.data.hierarchy.length === 0 && res.data.parent === null && res.data.found === false && (res.meta.notes || []).some((n) => /not found/i.test(n)),
      JSON.stringify({ parent: res.data.parent, found: res.data.found }));
  });
  // Unfiltered ⇒ top-level 2-digit sectors (references/naics/ exact), parent null,
  // each sector hasChildren:true (2-digit), a drill-in note.
  await withFetch((u) => (/references\/naics\/(\?|$)/.test(u) ? mockResponse({ status: 200, json: { results: [ { naics: "54", naics_description: "Prof/Sci/Tech", count: 52 }, { naics: "23", naics_description: "Construction", count: 10 } ] } }) : failClosed()()), async () => {
    const res = await naicsHierarchy({});
    ok("38 unfiltered ⇒ top-level sectors (2-digit, hasChildren:true) + parent null + drill note",
      res.data.hierarchy.length === 2 && res.data.parent === null && res.data.hierarchy.every((h) => h.code.length === 2 && h.hasChildren === true) && (res.meta.notes || []).some((n) => /drill/i.test(n)),
      JSON.stringify(res.data.hierarchy.map((h) => h.code)));
  });
}

main().catch((e) => {
  console.error("FATAL:", e);
  globalThis.fetch = REAL_FETCH;
  globalThis.setTimeout = REAL_SET_TIMEOUT;
  process.exit(1);
});
