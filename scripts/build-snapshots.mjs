#!/usr/bin/env node
/**
 * build-snapshots.mjs — the MANUAL, EGRESS-SELF-DIAGNOSING snapshot-mirror
 * builder (ADR-0045 Phase 4 + the diagnosis hardening).
 *
 * ★RUN THIS FROM A NON-EDGE-BLOCKED EGRESS (a clean IP — a laptop / CI runner /
 *  cloud box that is NOT behind the F5/WAF IP-reputation filter). It pulls a
 *  small, HIGH-VALUE, SLOW-CHANGING set of PUBLIC reference/aggregate data from
 *  the LIVE origins and writes static snapshot envelopes to `snapshots/`, plus a
 *  `snapshots/manifest.json`. A client later reads those (over a CDN base URL
 *  configured via SAMGOV_SNAPSHOT_BASE_URL) ONLY when the live source is
 *  unreachable from its own egress.
 *
 * ★SELF-DIAGNOSIS (the key hardening). EMPIRICAL FACT (verified out-of-band):
 *  USAspending + Treasury ARE reachable from a clean egress (200/JSON); the F5
 *  500s are specific to FLAGGED DATACENTER IPs. So a deployment must be able to
 *  CONFIRM ITS OWN reachability. Each run records, PER SOURCE, whether THIS
 *  egress reached it (`reachable`, `httpStatus`|`errorKind`, `asOf`), prints a
 *  per-source table + an "N/M sources reachable from this egress" summary, and:
 *    • PARTIAL SUCCESS: refreshes the snapshots this egress CAN reach; for an
 *      unreachable source it does NOT overwrite/blank the existing snapshot —
 *      the last-good, stale-but-honest file is LEFT IN PLACE and the source is
 *      marked `reachable:false, lastAttempt:<ts>` (prior asOf/bytes carried
 *      forward from the previous manifest).
 *    • EXIT CODE: non-zero ONLY when ZERO sources were reachable (a
 *      totally-blocked egress = a real problem the operator must fix); otherwise
 *      exit 0 with the honest partial report.
 *
 * ★NOT SCHEDULED, NOT IN CI. Plain `node scripts/build-snapshots.mjs`, on demand.
 *
 * ★HONEST-FAIL, NO EVASION (ADR-0045 §"정책 경계" / m1-policy). If a source is
 *  F5/blocked from THIS egress, the builder REPORTS it and moves on — it does
 *  NOT retry via proxies / IP-rotation / alternate egress. The diagnosis tells
 *  you if YOUR egress works: if coverage is poor, RE-RUN from a cleaner
 *  (non-datacenter) egress. That is the only sanctioned remedy.
 *
 * ★PUBLIC-ONLY GATE (M3/m2): only specs whose `accessLevel==="public"` AND whose
 *  license is redistributable are ingested. A non-public spec is SKIPPED (never
 *  attempted, never counted in the egress total) and logged.
 *
 * The pure helpers (`buildEnvelope`, `isPublicRedistributable`, `manifestEntry`,
 * `summarize`, `exitCodeFor`, `buildManifest`, `SNAPSHOT_SPECS`) are EXPORTED and
 * unit-tested OFFLINE by fault-injection-test.mjs (via an injected `fetchImpl` —
 * no real network, no fs). `main()` runs ONLY when this file is invoked directly
 * (entry-point gate), never on import.
 */

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = resolve(HERE, "..", "snapshots");

/**
 * The redistributable licenses we accept. US federal government works are
 * public-domain (17 U.S.C. §105); we also accept explicit CC0. Anything else is
 * treated as NON-redistributable and skipped (conservative default).
 */
const REDISTRIBUTABLE_LICENSES = new Set([
  "public-domain",
  "us-government-work",
  "cc0",
]);

/**
 * The snapshot build set — deliberately SMALL and clearly PUBLIC + slow-changing
 * (canonical reference lists + core aggregates). Each spec: a stable `key`, the
 * LIVE `url` to pull, an attribution `source`, a redistributable `license`, and
 * `accessLevel:"public"`. Grow this set cautiously — every added key is data we
 * take responsibility for keeping honestly fresh, and it must be a
 * CANONICAL/QUERYLESS read (a snapshot can't cover free-form queries), matching
 * EXACTLY the URL the opted-in tool issues for its canonical case.
 */
export const SNAPSHOT_SPECS = [
  {
    key: "usas_toptier_agencies",
    // The toptier list ignores `limit` (returns the complete ~111-agency set for
    // any limit) — the tool opts this key in for ANY limit.
    url: "https://api.usaspending.gov/api/v2/references/toptier_agencies/",
    source: "api.usaspending.gov /api/v2/references/toptier_agencies",
    license: "us-government-work",
    accessLevel: "public",
  },
  {
    key: "usas_naics_hierarchy",
    // The canonical UNFILTERED top-level NAICS tree (2-digit sectors). A
    // drill-down (naicsFilter set) is live-only, so the snapshot mirrors ONLY the
    // top-level query the tool issues with no filter.
    url: "https://api.usaspending.gov/api/v2/references/naics/",
    source: "api.usaspending.gov /api/v2/references/naics (top-level)",
    license: "us-government-work",
    accessLevel: "public",
  },
  {
    key: "usas_glossary",
    // The canonical glossary read: NO search term + the tool's default limit
    // (25). The tool opts this key in ONLY for that exact query, so the served
    // snapshot can never desync `returned` from what was asked.
    url: "https://api.usaspending.gov/api/v2/references/glossary/?limit=25",
    source: "api.usaspending.gov /api/v2/references/glossary (default)",
    license: "us-government-work",
    accessLevel: "public",
  },
  {
    key: "sba_size_standards",
    // The WHOLE naics.json (all ~997 size standards) — a single queryless file
    // that serves EVERY per-NAICS lookup. The cleanest snapshot candidate.
    url: "https://www.sba.gov/sites/default/files/data/naics.json",
    source: "sba.gov naics.json (SBA small-business size standards)",
    license: "us-government-work",
    accessLevel: "public",
  },
  {
    key: "treasury_debt_to_penny_latest",
    // The single most-recent "Debt to the Penny" day (page[size]=1, newest-first)
    // — the exact live query the treasury_debt_to_penny(latest:true) tool issues.
    url:
      "https://api.fiscaldata.treasury.gov/services/api/fiscal_service" +
      "/v2/accounting/od/debt_to_penny" +
      "?fields=record_date,tot_pub_debt_out_amt,debt_held_public_amt,intragov_hold_amt" +
      "&sort=-record_date&page[size]=1&page[number]=1",
    source: "api.fiscaldata.treasury.gov /v2/accounting/od/debt_to_penny (latest)",
    license: "us-government-work",
    accessLevel: "public",
  },
];

/**
 * The public-only + redistributable-license gate (M3). Returns true ONLY when
 * the spec is `accessLevel:"public"` AND its license is redistributable — the
 * builder INGESTS a spec only when this holds; everything else is skipped.
 */
export function isPublicRedistributable(spec) {
  return (
    spec != null &&
    spec.accessLevel === "public" &&
    typeof spec.license === "string" &&
    REDISTRIBUTABLE_LICENSES.has(spec.license.toLowerCase())
  );
}

/**
 * Build a snapshot envelope from a spec + the fetched `data` + the retrieval
 * `asOf` (ISO-8601 UTC). The shape the reader (`src/snapshot.ts`) parses:
 * `{ asOf, source, license, accessLevel, data }`. Pure — no I/O.
 */
export function buildEnvelope(spec, data, asOf) {
  return {
    asOf,
    source: spec.source,
    license: spec.license,
    accessLevel: spec.accessLevel,
    data,
  };
}

/**
 * One per-key manifest reachability record (m2-policy provenance the operator /
 * CDN can audit). PURE. `result` carries this run's diagnosis:
 *   { asOf?, reachable, httpStatus?, errorKind?, bytes?, lastAttempt? }
 * Shape written per key: `{ key, source, license, accessLevel, url, asOf,
 * reachable, httpStatus|errorKind, bytes[, lastAttempt] }`. `asOf`/`bytes`
 * default to null (a never-yet-fetched or blocked-with-no-prior key). For a
 * BLOCKED source the caller passes the PRIOR run's asOf/bytes (carried forward,
 * stale-but-honest) plus `reachable:false, lastAttempt`.
 */
export function manifestEntry(spec, result) {
  const entry = {
    key: spec.key,
    source: spec.source,
    license: spec.license,
    accessLevel: spec.accessLevel,
    url: spec.url,
    asOf: result.asOf ?? null,
    reachable: result.reachable === true,
    bytes: result.bytes ?? null,
  };
  // httpStatus (a live status code) XOR errorKind (a network/timeout class) —
  // whichever the probe produced. A reachable source has an httpStatus; a
  // network-level fault has an errorKind and no status.
  if (result.httpStatus !== undefined) entry.httpStatus = result.httpStatus;
  if (result.errorKind !== undefined) entry.errorKind = result.errorKind;
  if (result.lastAttempt !== undefined) entry.lastAttempt = result.lastAttempt;
  return entry;
}

/** A skipped-by-public-gate manifest record. NOT counted in the egress total. */
function skippedEntry(spec) {
  return {
    key: spec.key,
    source: spec.source,
    license: spec.license,
    accessLevel: spec.accessLevel,
    url: spec.url,
    skipped: true,
    reason: "not public+redistributable (M3 gate)",
  };
}

/**
 * Summarize the per-key entries into the egress diagnosis. PURE. A skipped
 * (public-gate) entry is NEITHER attempted NOR counted in `egressTotal` — the
 * total is the number of sources this egress actually TRIED to reach.
 */
export function summarize(entries) {
  const attempted = entries.filter((e) => e.skipped !== true);
  return {
    egressTotal: attempted.length,
    egressReachable: attempted.filter((e) => e.reachable === true).length,
  };
}

/**
 * The exit code for a diagnosis. PURE. Non-zero ONLY when ZERO sources were
 * reachable out of ≥1 attempted (a fully-blocked egress = a real problem the
 * operator must fix). A partial refresh, or an all-skipped run (egressTotal 0),
 * exits 0 — we publish what we could and report honestly.
 */
export function exitCodeFor({ egressReachable, egressTotal }) {
  return egressTotal > 0 && egressReachable === 0 ? 1 : 0;
}

/** Classify a thrown fetch fault into a stable, loggable error kind. */
function errorKindOf(e) {
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) return "timeout";
  if (e instanceof TypeError) return "network";
  return e && e.name ? String(e.name) : "error";
}

/**
 * Probe ONE spec via `fetchImpl` (injectable for offline tests). Returns this
 * run's diagnosis WITHOUT throwing: `{ reachable, httpStatus?, errorKind?,
 * data?, asOf? }`. A non-2xx is `reachable:false` + `httpStatus`; a network
 * fault is `reachable:false` + `errorKind`; a 2xx JSON is `reachable:true` +
 * `data` + `httpStatus` + `asOf`. `redirect:"error"` refuses off-host hops.
 */
async function probeSpec(spec, fetchImpl, now) {
  try {
    const res = await fetchImpl(spec.url, {
      headers: {
        "User-Agent":
          "cliwant-mcp-sam-gov snapshot-builder (+public open-data mirror)",
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { reachable: false, httpStatus: res.status };
    const data = await res.json();
    return { reachable: true, httpStatus: res.status, data, asOf: now() };
  } catch (e) {
    // ★Honor a block: record it, do NOT hunt egress / proxy (m1-policy).
    return { reachable: false, errorKind: errorKindOf(e) };
  }
}

/**
 * Build the full manifest + the set of snapshot writes for a run. PURE of fs
 * (does NOT write) and of the real network (fetch is injected) — so it is fully
 * unit-testable offline. `main()` performs the returned writes and the fs reads.
 *
 * @param specs               the spec set to attempt.
 * @param fetchImpl           (url, init) => Response-like. Real `fetch` in main.
 * @param priorEntriesByKey   the PREVIOUS manifest's entries, keyed — used to
 *                            carry forward a blocked source's last-good asOf/bytes.
 * @param now                 () => ISO-8601 UTC string (injectable clock).
 * @returns { manifest, writes, entries }. `writes` = [{ key, filename, contents }]
 *          ONLY for reachable+public specs; a blocked/skipped spec produces NO
 *          write (its last-good snapshot is left untouched).
 */
export async function buildManifest({
  specs,
  fetchImpl,
  priorEntriesByKey = {},
  now = () => new Date().toISOString(),
}) {
  const entries = [];
  const writes = [];
  for (const spec of specs) {
    if (!isPublicRedistributable(spec)) {
      entries.push(skippedEntry(spec));
      continue;
    }
    const probe = await probeSpec(spec, fetchImpl, now);
    if (probe.reachable) {
      const contents =
        JSON.stringify(buildEnvelope(spec, probe.data, probe.asOf), null, 2) +
        "\n";
      const bytes = Buffer.byteLength(contents, "utf8");
      writes.push({ key: spec.key, filename: `${spec.key}.json`, contents });
      entries.push(
        manifestEntry(spec, {
          asOf: probe.asOf,
          reachable: true,
          httpStatus: probe.httpStatus,
          bytes,
        }),
      );
    } else {
      // ★BLOCKED: do NOT overwrite the existing snapshot. Carry the prior run's
      // asOf/bytes forward (stale-but-honest) and stamp lastAttempt.
      const prior = priorEntriesByKey[spec.key];
      entries.push(
        manifestEntry(spec, {
          asOf: prior && prior.asOf !== undefined ? prior.asOf : null,
          reachable: false,
          httpStatus: probe.httpStatus,
          errorKind: probe.errorKind,
          bytes: prior && prior.bytes !== undefined ? prior.bytes : null,
          lastAttempt: now(),
        }),
      );
    }
  }
  const { egressReachable, egressTotal } = summarize(entries);
  const manifest = {
    builtAt: now(),
    egressReachable,
    egressTotal,
    keys: entries,
  };
  return { manifest, writes, entries };
}

/** Read the previous manifest's entries (keyed) so a blocked source can carry
 *  forward its last-good asOf/bytes. Returns {} if none / unreadable. */
function readPriorEntries() {
  try {
    const raw = readFileSync(resolve(SNAPSHOTS_DIR, "manifest.json"), "utf8");
    const prev = JSON.parse(raw);
    const byKey = {};
    for (const e of (prev && prev.keys) || []) {
      if (e && e.key) byKey[e.key] = e;
    }
    return byKey;
  } catch {
    return {};
  }
}

/** Print the per-source reachability table + the N/M summary + guidance. */
function printReport(manifest) {
  console.log("\nEgress reachability (this run):");
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  ${pad("KEY", 32)} ${pad("REACHABLE", 10)} STATUS`);
  for (const e of manifest.keys) {
    if (e.skipped) {
      console.log(`  ${pad(e.key, 32)} ${pad("SKIPPED", 10)} ${e.reason}`);
      continue;
    }
    const status =
      e.httpStatus !== undefined
        ? `HTTP ${e.httpStatus}`
        : e.errorKind !== undefined
          ? e.errorKind
          : "blocked";
    const tail = e.reachable
      ? ""
      : "  (snapshot NOT refreshed — last-good left in place)";
    console.log(
      `  ${pad(e.key, 32)} ${pad(e.reachable ? "yes" : "NO", 10)} ${status}${tail}`,
    );
  }
  console.log(
    `\n${manifest.egressReachable}/${manifest.egressTotal} sources reachable from this egress.`,
  );
  if (manifest.egressTotal > 0 && manifest.egressReachable === 0) {
    console.log(
      "★ZERO sources reachable — this egress is fully blocked (likely a flagged " +
        "datacenter IP). RE-RUN from a NON-datacenter/clean egress (laptop / home / " +
        "clean CI). No proxy / IP-rotation / egress-hunting (policy boundary). Exiting non-zero.",
    );
  } else if (manifest.egressReachable < manifest.egressTotal) {
    console.log(
      "Partial coverage: blocked sources were left at their last-good snapshot " +
        "(honest stale). Re-run from a cleaner egress to refresh them — no route-around.",
    );
  }
}

async function main() {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const priorEntriesByKey = readPriorEntries();
  const { manifest, writes } = await buildManifest({
    specs: SNAPSHOT_SPECS,
    fetchImpl: (url, init) => fetch(url, init),
    priorEntriesByKey,
  });
  // Perform the writes for REACHABLE+public specs ONLY. Blocked/skipped specs
  // produce no write, so their last-good snapshot file is left untouched.
  for (const w of writes) {
    const out = resolve(SNAPSHOTS_DIR, w.filename);
    writeFileSync(out, w.contents);
    console.log(`OK   ${w.key} → ${out}`);
  }
  writeFileSync(
    resolve(SNAPSHOTS_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  printReport(manifest);
  // Non-zero ONLY when the egress is TOTALLY blocked (zero reachable of ≥1
  // attempted). A partial refresh publishes what it could and exits 0.
  process.exit(exitCodeFor(manifest));
}

// Entry-point gate: run main() ONLY on a direct `node scripts/build-snapshots.mjs`
// invocation, never when imported (e.g. by the offline unit tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
