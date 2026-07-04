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

import { buildMeta } from "./dist/meta.js";
import { parseRecordFields, enrichSearchOpportunities } from "./dist/gsa-csv.js";
import { analyzeIncumbent, getAwardDetail } from "./dist/usaspending.js";
import { checkExclusions, integrityLookup } from "./dist/integrity.js";
import { farClauseLookup, farComplianceMatrix } from "./dist/far.js";
import { _clearCache } from "./dist/cache.js";
import { sizeStandard } from "./dist/sba.js";
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
      const receipts = (await sizeStandard({ naics: "541512" })).data;
      ok("receipts NAICS ⇒ type receipts, threshold $34M (×1e6), unit receipts",
        receipts.standardType === "receipts" && receipts.threshold === 34_000_000 &&
        receipts.unit === "USD annual receipts" && receipts.revenueLimitUSD === 34_000_000,
        JSON.stringify(receipts));
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
      const missing = (await sizeStandard({ naics: "999999" })).data;
      ok("unknown NAICS ⇒ found:false, no fabricated standard",
        missing.found === false && missing.threshold === null && missing.standardType === "unknown",
        JSON.stringify(missing));
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

  // The EXACT mapping sam_search_opportunities / sam_search_shaping apply to a
  // SamSearchResult (mirrors server.ts): on r.degraded → an honest incomplete
  // partial; else the normal partial. Fed through the REAL buildMeta so the
  // assertions exercise the shipped invariant logic, not a copy of it.
  const metaForSearch = (r) =>
    r.degraded
      ? buildMeta({
          source:
            "sam.gov/sgs/v1 (keyless HAL) (DEGRADED — search backend unavailable)",
          keylessMode: true,
          complete: false,
          totalAvailable: null,
          returned: 0,
          notes: [
            r.degraded.reason +
              " This is a service outage, not a confirmed zero — retry.",
          ],
        })
      : buildMeta({
          source: "sam.gov/sgs/v1 (keyless HAL)",
          keylessMode: true,
          truncated: r.totalRecords > r.opportunitiesData.length,
          returned: r.opportunitiesData.length,
          totalAvailable: r.totalRecords,
        });

  // ── (a) TOTAL OUTAGE: the SGS search URL 503s on every attempt ⇒ the result
  // carries `.degraded` and is an empty 0 — but a DISTINGUISHABLE one.
  await withFetch(
    (u) => (isSgs(u) ? mockResponse({ status: 503 }) : failClosed()()),
    async () => {
      const r = await client().searchOpportunities({ query: "widgets" });
      ok("outage (SGS 503) ⇒ result.degraded set with a reason",
        r.degraded && typeof r.degraded.reason === "string" &&
        r.degraded.reason.length > 0,
        JSON.stringify(r.degraded));
      ok("outage ⇒ totalRecords 0 AND opportunitiesData empty (the empty shape…)",
        r.totalRecords === 0 && r.opportunitiesData.length === 0,
        JSON.stringify({ t: r.totalRecords, n: r.opportunitiesData.length }));
      // …but the tool `_meta` must NOT read as a confirmed zero.
      const m = metaForSearch(r);
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
      const r = await client().searchOpportunities({ query: "nomatchxyz" });
      ok("genuine zero ⇒ NO .degraded marker (healthy source, real 0)",
        r.degraded === undefined, JSON.stringify(r.degraded));
      ok("genuine zero ⇒ totalRecords === 0, opportunitiesData empty",
        r.totalRecords === 0 && r.opportunitiesData.length === 0,
        JSON.stringify({ t: r.totalRecords, n: r.opportunitiesData.length }));
      const m = metaForSearch(r);
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
      const r = await client().searchOpportunities({ query: "widgets", offset: 100 });
      ok("partial page ⇒ totalRecords stays 5 (NOT replaced by 0)",
        r.totalRecords === 5, JSON.stringify(r.totalRecords));
      ok("partial page ⇒ this page is empty (0 rows) but that is honest, not degraded",
        r.opportunitiesData.length === 0 && r.degraded === undefined,
        JSON.stringify({ n: r.opportunitiesData.length, d: r.degraded }));
      const m = metaForSearch(r);
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
      const r = await client().searchOpportunities({ query: "widgets" });
      ok("healthy non-empty ⇒ NO .degraded, totalRecords 2, 2 rows mapped",
        r.degraded === undefined && r.totalRecords === 2 &&
        r.opportunitiesData.length === 2 && r.opportunitiesData[0].noticeId === "N1",
        JSON.stringify({ d: r.degraded, t: r.totalRecords, n: r.opportunitiesData.length }));
      const m = metaForSearch(r);
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
        const r = await client().searchOpportunities({ query: "widgets" });
        ok(`hollow-200 (${label}) ⇒ result.degraded set (NOT a fake genuine-zero)`,
          !!r.degraded && r.totalRecords === 0 && r.opportunitiesData.length === 0,
          JSON.stringify({ degraded: r.degraded }));
        const m = metaForSearch(r);
        ok(`hollow-200 (${label}) ⇒ _meta complete:false + totalAvailable:null + outage note`,
          m.complete === false && m.totalAvailable === null &&
          m.notes.some((n) => /service outage, not a confirmed zero/i.test(n)),
          JSON.stringify({ c: m.complete, ta: m.totalAvailable }));
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

// ─── Main ─────────────────────────────────────────────────────────────────
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
  await testSearchOutageHonesty();
  await testGetOpportunityDetailHonesty();

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

main().catch((e) => {
  console.error("FATAL:", e);
  globalThis.fetch = REAL_FETCH;
  globalThis.setTimeout = REAL_SET_TIMEOUT;
  process.exit(1);
});
