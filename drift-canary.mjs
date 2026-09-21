#!/usr/bin/env node
/**
 * drift-canary.mjs — Live endpoint health + data-map row-count drift check.
 *
 * WHY THIS EXISTS:
 *   On 2026-09-21 data.sfgov.org was found to have permanently 301-redirected
 *   to data.sf.gov.  Because src/socrata.ts uses redirect:"error" (deliberate
 *   SSRF hardening), San Francisco was completely unreachable for real users and
 *   nobody knew until a verification sub-agent tripped over it.  The only live
 *   check was smoke-test.mjs (~2 hosts, PR-only).  This canary covers ALL ~285
 *   live endpoints weekly.
 *
 * ★ KNOWN PITFALLS (each burned us on 2026-09-21 — do not revert):
 *   1. count(1) on opendata.maryland.gov returns Cloudflare 403 (SQLi-like);
 *      always use $select=count(*).
 *   2. A missing User-Agent gets flat 403 on some hosts — send an honest
 *      identifying UA.  Do NOT spoof a browser (that circumvents WAF; such
 *      hosts are recorded as `blocked`).
 *   3. AbortSignal.timeout() is required on EVERY request — a stalled TLS
 *      handshake hung probes for 2.5 hours without it.
 *   4. redirect:"manual" everywhere — a 301 must be recorded as `redirect`
 *      with its Location header, NOT silently followed.  That is exactly what
 *      would have caught the SF case.
 *   5. Bounded concurrency (≈8) + per-host delay — this hits government servers.
 *
 * OUTPUT:
 *   JSON report  → $REPORT_JSON  (default: drift-canary-report.json)
 *   Markdown     → $REPORT_MD   (default: drift-canary-report.md)
 *   Exit 1 when real regressions: redirect | not-found | dns | collapse
 *   Exit 0 when only blocked / timeout / server-error / growth / unmeasurable
 *
 * Usage:
 *   node drift-canary.mjs
 *   REPORT_JSON=out.json REPORT_MD=out.md node drift-canary.mjs
 */

import { writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------
// ★ THRESHOLD CONFIGURATION — single source of truth for all classifications
// ---------------------------------------------------------------------------
export const THRESHOLDS = {
  /** concurrency cap for all fetch probes */
  CONCURRENCY: 8,
  /** ms between probe batches within a single host group */
  INTER_PROBE_DELAY_MS: 120,
  /** wall-clock timeout per HTTP request */
  REQUEST_TIMEOUT_MS: 15_000,
  /** row-count ratio below which we flag `collapse` */
  COLLAPSE_RATIO: 0.50,
  /** row-count ratio above which we flag `growth` */
  GROWTH_RATIO: 2.00,
};

// ★ Pitfall #2: honest, identifying User-Agent (NOT a browser spoof)
const UA = "mcp-sam-gov-drift-canary (+https://github.com/cliwant/mcp-sam-gov)";

// ---------------------------------------------------------------------------
// Classification logic — pure functions, tested offline in fault-injection
// ---------------------------------------------------------------------------

/**
 * Classify an HTTP status code into a canary class.
 * @param {number} status
 * @param {string|null} body  optional body text (used to detect WAF challenge pages)
 * @returns {'ok'|'redirect'|'not-found'|'blocked'|'server-error'}
 */
export function classifyStatus(status, body = null) {
  if (status >= 200 && status < 300) {
    // Some hosts return 200 with a WAF challenge page (Cloudflare, etc.)
    if (body && isWafChallengePage(body)) return "blocked";
    return "ok";
  }
  if (status >= 300 && status < 400) return "redirect";
  if (status === 404 || status === 410) return "not-found";
  if (status === 401 || status === 403 || status === 429) return "blocked";
  if (status >= 500) return "server-error";
  // Other 4xx → blocked
  return "blocked";
}

/**
 * Heuristic: does the body look like a WAF interstitial?
 */
export function isWafChallengePage(body) {
  const lc = body.toLowerCase();
  return (
    lc.includes("cloudflare") && lc.includes("checking your browser") ||
    lc.includes("attention required") && lc.includes("cloudflare") ||
    lc.includes("just a moment") && lc.includes("cloudflare") ||
    lc.includes("enable javascript") && lc.includes("challenge")
  );
}

/**
 * Classify a row-count drift result.
 * @param {number} recorded   rows stored in DATA_MAP_ENTRIES
 * @param {number} measured   rows actually returned by the live API
 * @returns {'ok'|'collapse'|'growth'}
 */
/**
 * A host we KEEP on the allowlist after it permanently moved, so a request reaches
 * the adapter's migration handler (which returns a non-retryable error naming the
 * replacement) instead of a generic "not allowlisted". Its 301 is therefore EXPECTED
 * and must not paint the weekly run red forever — a canary that is always red gets
 * ignored, which is worse than no canary. It is only "known-migrated" if it still
 * points where we recorded; a redirect anywhere else is a fresh regression.
 *
 * @param {string} host
 * @param {string|null} location  the Location header of the 3xx
 * @param {ReadonlyMap<string,string>} migrated  host -> recorded replacement host
 * @returns {boolean}
 */
export function isKnownMigration(host, location, migrated) {
  const target = migrated.get(host);
  if (!target || !location) return false;
  try {
    return new URL(location, `https://${host}/`).hostname === target;
  } catch {
    return false;
  }
}

export function classifyRowDrift(recorded, measured) {
  const ratio = measured / recorded;
  if (ratio < THRESHOLDS.COLLAPSE_RATIO) return "collapse";
  if (ratio > THRESHOLDS.GROWTH_RATIO) return "growth";
  return "ok";
}

// ---------------------------------------------------------------------------
// Import allowlists from BUILT dist/ (exactly what ships)
// ---------------------------------------------------------------------------
const { SOCRATA_DOMAINS, MIGRATED_SOCRATA_HOSTS } = await import("./dist/socrata.js");
const { CKAN_HOSTS } = await import("./dist/ckan.js");
const { OPEN_CHECKBOOK_PORTALS } = await import("./dist/open-checkbook.js");
const { ARCGIS_SERVICES } = await import("./dist/arcgis-feature.js");
const { BONFIRE_ORGS } = await import("./dist/bonfire.js");
const { DATA_MAP_ENTRIES } = await import("./dist/data-map.js");

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

/**
 * Probe a URL and return a result object.
 * ★ Pitfall #3: AbortSignal.timeout everywhere
 * ★ Pitfall #4: redirect:"manual"
 * ★ Pitfall #2: honest User-Agent
 */
async function probe(url, { headers = {} } = {}) {
  try {
    const res = await fetch(url, {
      redirect: "manual",          // ★ pitfall #4: never follow redirects
      signal: AbortSignal.timeout(THRESHOLDS.REQUEST_TIMEOUT_MS),  // ★ pitfall #3
      headers: {
        "User-Agent": UA,          // ★ pitfall #2
        ...headers,
      },
    });
    let body = "";
    try { body = await res.text(); } catch { /* ignore body read errors */ }
    const cls = classifyStatus(res.status, body);
    const location = res.headers.get("location") ?? null;
    return { ok: true, status: res.status, cls, location, body };
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      return { ok: false, cls: "timeout", error: "timeout" };
    }
    // Node.js fetch wraps the underlying cause: err.message = "fetch failed"
    // but err.cause.message = "getaddrinfo ENOTFOUND …".  Check both.
    const msg = String(err.message ?? err);
    const causeMsg = String(err?.cause?.message ?? "");
    const fullMsg = `${msg} ${causeMsg}`.trim();
    if (/ENOTFOUND|ENOENT|getaddrinfo|DNS\b/.test(fullMsg)) {
      return { ok: false, cls: "dns", error: causeMsg || msg };
    }
    return { ok: false, cls: "timeout", error: fullMsg };
  }
}

// ---------------------------------------------------------------------------
// Concurrency queue
// ---------------------------------------------------------------------------
async function runWithConcurrency(tasks, limit) {
  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
      await sleep(THRESHOLDS.INTER_PROBE_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// Per-rail probe builders
// ---------------------------------------------------------------------------

/** Socrata: /api/catalog/v1?q=test&limit=1 */
function buildSocrataTask(domain) {
  return async () => {
    const url = `https://${domain}/api/catalog/v1?q=test&limit=1`;
    const r = await probe(url);
    if (r.cls === "redirect" && isKnownMigration(domain, r.location, MIGRATED_SOCRATA_HOSTS)) {
      return { rail: "socrata", id: domain, url, ...r, cls: "known-migrated" };
    }
    return { rail: "socrata", id: domain, url, ...r };
  };
}

/** CKAN: /api/3/action/status_show */
function buildCkanTask(host) {
  return async () => {
    const url = `https://${host}/api/3/action/status_show`;
    const r = await probe(url);
    return { rail: "ckan", id: host, url, ...r };
  };
}

/**
 * Open Checkbook: probe checkbook_data.json with limit=1 and a valid year.
 * A 200 with JSON envelope proves liveness.
 */
function buildOpenCheckbookTask(portal) {
  return async () => {
    // AK uses FY2026 only; SD uses the default (most recent FYs)
    const year = portal.key === "ak" ? 2026 : new Date().getFullYear();
    const url = `https://${portal.host}/api/checkbook_data.json?limit=1&year=${year}`;
    const r = await probe(url);
    return { rail: "open-checkbook", id: portal.key, url, ...r };
  };
}

/** ArcGIS: {base}?f=json metadata */
function buildArcGisTask(svc) {
  return async () => {
    const url = `${svc.base}?f=json`;
    const r = await probe(url);
    return { rail: "arcgis", id: svc.key, url, ...r };
  };
}

/** Bonfire: /opportunities/rss — note domain is bonfirehub.com (NOT bonfirehq.com) */
function buildBonfireTask(org) {
  return async () => {
    const url = `https://${org.org}.bonfirehub.com/opportunities/rss`;
    const r = await probe(url);
    return { rail: "bonfire", id: org.org, url, ...r };
  };
}

// ---------------------------------------------------------------------------
// DATA_MAP row-count measurement
// ---------------------------------------------------------------------------

/**
 * Parse keyArgs string like "host=data.ca.gov, resourceId=abc123" into an object.
 */
function parseKeyArgs(keyArgs) {
  const result = {};
  for (const part of keyArgs.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    result[k] = v;
  }
  return result;
}

/**
 * Measure the live row count for a DATA_MAP_ENTRIES entry.
 * ★ Pitfall #1: always use $select=count(*) NOT count(1) (MD Cloudflare 403 on count(1))
 * Returns { measured: number|null, reason: string|null }
 */
async function measureDataMapEntry(entry) {
  const { tool, keyArgs } = entry;
  const args = parseKeyArgs(keyArgs);

  if (tool === "socrata_query") {
    const { domain, datasetId } = args;
    if (!domain || !datasetId) return { measured: null, reason: "missing domain/datasetId" };
    // ★ pitfall #1: use count(*) not count(1)
    const url = `https://${domain}/resource/${datasetId}.json?$select=count(*)&$limit=1`;
    const r = await probe(url);
    if (r.cls !== "ok") return { measured: null, reason: `probe=${r.cls} status=${r.status ?? "?"} error=${r.error ?? ""}` };
    try {
      const parsed = JSON.parse(r.body);
      // Socrata count(*) may return [{"count(*)":"12345"}] or [{"count":"12345"}]
      // depending on the Socrata version and API path.  Accept both.
      const countVal = parsed?.[0]?.["count(*)"] ?? parsed?.[0]?.["count"];
      if (countVal == null) return { measured: null, reason: `unexpected shape: ${r.body.slice(0, 80)}` };
      return { measured: Number(countVal), reason: null };
    } catch {
      return { measured: null, reason: `JSON parse failed: ${r.body.slice(0, 80)}` };
    }
  }

  if (tool === "ckan_query") {
    const { host, resourceId } = args;
    if (!host || !resourceId) return { measured: null, reason: "missing host/resourceId" };
    const url = `https://${host}/api/3/action/datastore_search?resource_id=${resourceId}&limit=0`;
    const r = await probe(url);
    if (r.cls !== "ok") return { measured: null, reason: `probe=${r.cls} status=${r.status ?? "?"} error=${r.error ?? ""}` };
    try {
      const parsed = JSON.parse(r.body);
      const total = parsed?.result?.total;
      if (total == null) return { measured: null, reason: `unexpected shape: ${r.body.slice(0, 80)}` };
      return { measured: Number(total), reason: null };
    } catch {
      return { measured: null, reason: `JSON parse failed: ${r.body.slice(0, 80)}` };
    }
  }

  if (tool === "open_checkbook_search") {
    const { portal, year } = args;
    if (!portal) return { measured: null, reason: "missing portal key" };
    const portalObj = OPEN_CHECKBOOK_PORTALS.find(p => p.key === portal);
    if (!portalObj) return { measured: null, reason: `unknown portal key: ${portal}` };
    if (!year) {
      // No year in keyArgs: the recorded row count spans multiple fiscal years.
      // A single-year probe would under-count and produce a false collapse.
      // Mark unmeasurable; the endpoint liveness is still probed by the
      // Open Checkbook rail above.
      return { measured: null, reason: "multi-year portal — single-request count not comparable to recorded total" };
    }
    const url = `https://${portalObj.host}/api/checkbook_data.json?limit=1&year=${year}`;
    const r = await probe(url);
    if (r.cls !== "ok") return { measured: null, reason: `probe=${r.cls} status=${r.status ?? "?"} error=${r.error ?? ""}` };
    try {
      const parsed = JSON.parse(r.body);
      const count = parsed?.count ?? parsed?.total_count;
      if (count == null) return { measured: null, reason: `no count in response: ${r.body.slice(0, 120)}` };
      return { measured: Number(count), reason: null };
    } catch {
      return { measured: null, reason: `JSON parse failed: ${r.body.slice(0, 80)}` };
    }
  }

  if (tool === "tableau_view_csv") {
    // Tableau doesn't offer a cheap count — mark unmeasurable
    return { measured: null, reason: "Tableau CSV does not expose a cheap row-count endpoint" };
  }

  return { measured: null, reason: `tool '${tool}' not yet supported in canary` };
}

// ---------------------------------------------------------------------------
// Main — only runs when this file is the entry point, not when imported
// ---------------------------------------------------------------------------
// Guard pattern (mirrors dist/server.js): top-level await is fine in ESM,
// but we skip the live-network code when the module is imported for testing.
const isEntryPoint =
  process.argv[1] &&
  new URL(import.meta.url).pathname.endsWith(
    process.argv[1].replace(/\\/g, "/").split("/").pop()
  );

if (isEntryPoint) {
const REPORT_JSON = process.env.REPORT_JSON ?? "drift-canary-report.json";
const REPORT_MD   = process.env.REPORT_MD   ?? "drift-canary-report.md";

console.log("=== drift-canary ===");
console.log(`Socrata: ${SOCRATA_DOMAINS.length}, CKAN: ${CKAN_HOSTS.length}, ` +
  `OpenCheckbook: ${OPEN_CHECKBOOK_PORTALS.length}, ArcGIS: ${ARCGIS_SERVICES.length}, ` +
  `Bonfire: ${BONFIRE_ORGS.length}, DataMap: ${DATA_MAP_ENTRIES.length}`);
console.log();

// Build all tasks
const endpointTasks = [
  ...SOCRATA_DOMAINS.map(buildSocrataTask),
  ...CKAN_HOSTS.map(buildCkanTask),
  ...OPEN_CHECKBOOK_PORTALS.map(buildOpenCheckbookTask),
  ...ARCGIS_SERVICES.map(buildArcGisTask),
  ...BONFIRE_ORGS.map(buildBonfireTask),
];

console.log(`Probing ${endpointTasks.length} endpoints (concurrency=${THRESHOLDS.CONCURRENCY})...`);
const startTime = Date.now();
const endpointResults = await runWithConcurrency(endpointTasks, THRESHOLDS.CONCURRENCY);
console.log(`Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s\n`);

// DATA_MAP row-count probes
console.log(`Measuring ${DATA_MAP_ENTRIES.length} DATA_MAP_ENTRIES row counts...`);
const dataMapResults = [];
for (const entry of DATA_MAP_ENTRIES) {
  const { measured, reason } = await measureDataMapEntry(entry);
  let cls;
  if (measured == null) {
    cls = "unmeasurable";
  } else {
    cls = classifyRowDrift(entry.rows, measured);
  }
  dataMapResults.push({
    rail: "data-map",
    id: `${entry.state}|${entry.dataLabel}`,
    tool: entry.tool,
    keyArgs: entry.keyArgs,
    recorded: entry.rows,
    measured: measured ?? null,
    cls,
    reason: reason ?? null,
    approximate: entry.approximate ?? false,
  });
  const sign = cls === "ok" ? "✓" : cls === "unmeasurable" ? "–" : "✗";
  const detail = measured != null
    ? `recorded=${entry.rows.toLocaleString()} measured=${measured.toLocaleString()} ratio=${(measured/entry.rows).toFixed(2)}`
    : reason ?? "";
  console.log(`  ${sign} [${cls}] ${entry.state} — ${entry.dataLabel}: ${detail}`);
  await sleep(THRESHOLDS.INTER_PROBE_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------
const ALL_CLASSES = ["ok", "known-migrated", "redirect", "not-found", "blocked", "server-error", "timeout", "dns"];
const REGRESSION_CLASSES = new Set(["redirect", "not-found", "dns"]);
const TRANSIENT_CLASSES  = new Set(["blocked", "timeout", "server-error"]);
const DM_REGRESSION_CLASSES = new Set(["collapse"]);

// Count endpoint classes
const endpointTally = Object.fromEntries(ALL_CLASSES.map(c => [c, 0]));
for (const r of endpointResults) endpointTally[r.cls] = (endpointTally[r.cls] ?? 0) + 1;

// Count data-map classes
const dmTally = { ok: 0, collapse: 0, growth: 0, unmeasurable: 0 };
for (const r of dataMapResults) dmTally[r.cls] = (dmTally[r.cls] ?? 0) + 1;

const nonOkEndpoints = endpointResults.filter(r => r.cls !== "ok");
const nonOkDm = dataMapResults.filter(r => r.cls !== "ok" && r.cls !== "unmeasurable");

// ---------------------------------------------------------------------------
// JSON Report
// ---------------------------------------------------------------------------
const report = {
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startTime,
  thresholds: THRESHOLDS,
  endpointTally,
  dataMapTally: dmTally,
  endpoints: endpointResults.map(r => ({
    rail: r.rail,
    id: r.id,
    url: r.url,
    cls: r.cls,
    status: r.status ?? null,
    location: r.location ?? null,
    error: r.error ?? null,
  })),
  dataMap: dataMapResults,
};

writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), "utf-8");
console.log(`\nJSON report → ${REPORT_JSON}`);

// ---------------------------------------------------------------------------
// Markdown Report
// ---------------------------------------------------------------------------
function mdTable(rows, headers) {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(r => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
}

const ts = new Date().toISOString();
let md = `# Drift Canary Report — ${ts}\n\n`;

md += `## Summary\n\n`;
md += `**Endpoints probed:** ${endpointResults.length}  \n`;
md += `**Data-map entries measured:** ${DATA_MAP_ENTRIES.length}  \n\n`;

md += `### Endpoint classes\n\n`;
md += mdTable(
  ALL_CLASSES.map(c => [c, String(endpointTally[c] ?? 0)]),
  ["Class", "Count"]
) + "\n\n";

md += `### Data-map row-drift classes\n\n`;
md += mdTable(
  Object.entries(dmTally).map(([k, v]) => [k, String(v)]),
  ["Class", "Count"]
) + "\n\n";

if (nonOkEndpoints.length === 0) {
  md += `## Endpoint Health\n\nAll endpoints are **OK**.\n\n`;
} else {
  md += `## Non-OK Endpoints\n\n`;
  md += mdTable(
    nonOkEndpoints.map(r => [
      r.rail,
      r.id,
      r.cls,
      String(r.status ?? "—"),
      r.location ? `→ ${r.location}` : r.error ?? "",
    ]),
    ["Rail", "ID", "Class", "Status", "Detail"]
  ) + "\n\n";
}

if (nonOkDm.length === 0 && dmTally.unmeasurable === 0) {
  md += `## Data-Map Row Counts\n\nAll measurable entries are within expected bounds.\n\n`;
} else {
  md += `## Data-Map Row Count Issues\n\n`;
  if (nonOkDm.length > 0) {
    md += mdTable(
      nonOkDm.map(r => [
        r.id,
        r.cls,
        String(r.recorded),
        r.measured != null ? String(r.measured) : "—",
        r.reason ?? "",
      ]),
      ["Entry", "Class", "Recorded", "Measured", "Note"]
    ) + "\n\n";
  }
  const unmeasurableRows = dataMapResults.filter(r => r.cls === "unmeasurable");
  if (unmeasurableRows.length > 0) {
    md += `### Unmeasurable entries\n\n`;
    md += unmeasurableRows.map(r => `- **${r.id}** (${r.tool}): ${r.reason}`).join("\n") + "\n\n";
  }
}

writeFileSync(REPORT_MD, md, "utf-8");
console.log(`Markdown report → ${REPORT_MD}`);

// ---------------------------------------------------------------------------
// Exit code
// ---------------------------------------------------------------------------
const hasEndpointRegression = nonOkEndpoints.some(r => REGRESSION_CLASSES.has(r.cls));
const hasDmRegression = nonOkDm.some(r => DM_REGRESSION_CLASSES.has(r.cls));
const hasTransients = nonOkEndpoints.some(r => TRANSIENT_CLASSES.has(r.cls));

if (nonOkEndpoints.length > 0 || nonOkDm.length > 0) {
  console.log("\n=== Non-OK results ===");
  for (const r of nonOkEndpoints) {
    const flag = REGRESSION_CLASSES.has(r.cls) ? "REGRESSION" : "WARN";
    const detail = r.location ? `→ ${r.location}` : r.error ?? `HTTP ${r.status}`;
    console.log(`  [${flag}] ${r.rail}/${r.id} ${r.cls} ${detail}`);
  }
  for (const r of nonOkDm) {
    console.log(`  [REGRESSION] data-map/${r.id} ${r.cls} recorded=${r.recorded} measured=${r.measured}`);
  }
}

console.log("\n=== Endpoint tally ===");
for (const [cls, cnt] of Object.entries(endpointTally)) {
  if (cnt > 0) console.log(`  ${cls}: ${cnt}`);
}
console.log("=== Data-map tally ===");
for (const [cls, cnt] of Object.entries(dmTally)) {
  if (cnt > 0) console.log(`  ${cls}: ${cnt}`);
}

if (hasEndpointRegression || hasDmRegression) {
  console.log("\n✗ REGRESSION detected — exit 1");
  process.exit(1);
} else if (hasTransients) {
  console.log("\n⚠ Transient issues (blocked/timeout/server-error) — exit 0 (warn only)");
} else {
  console.log("\n✓ All checks passed");
}
} // end isEntryPoint guard
