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
import { checkExclusions } from "./dist/integrity.js";
import { sizeStandard } from "./dist/sba.js";

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

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== fault-injection + golden-fixture harness (OFFLINE, deterministic) ===");
  console.log("    imports dist/*.js; monkeypatches globalThis.fetch; makes NO network calls.");

  // Pure, no-fetch suites first.
  testBuildMeta();
  testGsaCsvParser();
  testGsaCsvEnrichment();

  // Fetch-mocked suites.
  await testGetAwardDetail();
  await testAnalyzeIncumbent();
  await testCheckExclusions();
  await testSbaSizeStandard();

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
