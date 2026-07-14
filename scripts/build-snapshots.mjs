#!/usr/bin/env node
/**
 * build-snapshots.mjs — the MANUAL snapshot-mirror builder (ADR-0045 Phase 4).
 *
 * ★RUN THIS FROM A NON-EDGE-BLOCKED EGRESS (a clean IP — a laptop / CI runner /
 *  cloud box that is NOT behind the F5/WAF IP-reputation filter). It pulls a
 *  small, HIGH-VALUE, SLOW-CHANGING set of PUBLIC reference/aggregate data from
 *  the LIVE origins and writes static snapshot envelopes to `snapshots/`, plus a
 *  `snapshots/manifest.json`. A client later reads those (over a CDN base URL
 *  configured via SAMGOV_SNAPSHOT_BASE_URL) ONLY when the live source is
 *  unreachable from its own egress.
 *
 * ★NOT SCHEDULED, NOT IN CI. This is a plain `node scripts/build-snapshots.mjs`
 *  the operator (or a future CI job on a clean egress) runs on demand. If the
 *  origin is blocked from THIS egress it FAILS HONESTLY (logs the failure, writes
 *  no envelope for that key) — it does NOT hunt for another egress, use a proxy,
 *  or route around a block (ADR-0045 §"정책 경계" / m1-policy). A blocked key is
 *  simply not refreshed; the previously-published snapshot (if any) stays as-is.
 *
 * ★PUBLIC-ONLY GATE (M3/m2): only specs whose `accessLevel==="public"` AND whose
 *  license is redistributable are ingested. A non-public spec is SKIPPED and
 *  logged. The written envelope carries `{ asOf, source, license, accessLevel,
 *  data }`; the manifest records per-key `{ source, license, asOf, url }`.
 *
 * The pure helpers (`buildEnvelope`, `isPublicRedistributable`, `SNAPSHOT_SPECS`)
 * are EXPORTED and unit-tested offline by fault-injection-test.mjs; `main()` runs
 * ONLY when this file is invoked directly (entry-point gate), never on import.
 */

import { writeFileSync, mkdirSync } from "node:fs";
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
 * (reference lists + core aggregates). Each spec: a stable `key`, the LIVE `url`
 * to pull, an attribution `source`, a redistributable `license`, and
 * `accessLevel:"public"`. `pick` (optional) narrows the fetched JSON to the
 * payload we mirror (identity by default). Grow this set cautiously — every
 * added key is data we take responsibility for keeping honestly fresh.
 */
export const SNAPSHOT_SPECS = [
  {
    key: "usas_toptier_agencies",
    url: "https://api.usaspending.gov/api/v2/references/toptier_agencies/",
    source: "api.usaspending.gov /api/v2/references/toptier_agencies",
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

/** A manifest entry (per-key provenance the operator/CDN can audit). */
export function manifestEntry(spec, asOf) {
  return { key: spec.key, source: spec.source, license: spec.license, url: spec.url, asOf };
}

/**
 * Fetch one spec's LIVE JSON and return its snapshot envelope. Throws (honestly)
 * on a non-2xx or network fault — the caller logs it and moves on (the key is
 * simply not refreshed; NO route-around).
 */
async function fetchSnapshot(spec) {
  const res = await fetch(spec.url, {
    // Descriptive UA + honest failure; redirect:"error" refuses off-host hops.
    headers: { "User-Agent": "cliwant-mcp-sam-gov snapshot-builder (+public open-data mirror)" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${spec.url}`);
  }
  const data = await res.json();
  const asOf = new Date().toISOString();
  return { envelope: buildEnvelope(spec, data, asOf), asOf };
}

async function main() {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const manifest = { generatedAt: new Date().toISOString(), keys: [] };
  let built = 0;
  let skipped = 0;
  let failed = 0;

  for (const spec of SNAPSHOT_SPECS) {
    if (!isPublicRedistributable(spec)) {
      console.warn(
        `SKIP ${spec.key}: accessLevel=${JSON.stringify(spec.accessLevel)} license=${JSON.stringify(spec.license)} — not public+redistributable (M3 gate).`,
      );
      skipped++;
      continue;
    }
    try {
      const { envelope, asOf } = await fetchSnapshot(spec);
      const out = resolve(SNAPSHOTS_DIR, `${spec.key}.json`);
      writeFileSync(out, JSON.stringify(envelope, null, 2) + "\n");
      manifest.keys.push(manifestEntry(spec, asOf));
      console.log(`OK   ${spec.key} → ${out} (asOf ${asOf})`);
      built++;
    } catch (e) {
      // ★Honor a block: fail honestly, do NOT hunt egress. The key is not
      // refreshed; the previously-published snapshot (if any) is left untouched.
      console.error(
        `FAIL ${spec.key}: ${e instanceof Error ? e.message : String(e)} — snapshot NOT refreshed (honoring the failure; no route-around).`,
      );
      failed++;
    }
  }

  writeFileSync(
    resolve(SNAPSHOTS_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(`\nSnapshots: ${built} built, ${skipped} skipped, ${failed} failed. Manifest: ${manifest.keys.length} key(s).`);
  // A pull failure is NOT a builder error (honoring a block is expected) — exit 0
  // so a partial refresh from a partially-blocked egress still publishes what it
  // could. Nothing to publish AND at least one failure ⇒ exit 1 (nothing to do).
  process.exit(built === 0 && failed > 0 ? 1 : 0);
}

// Entry-point gate: run main() ONLY on a direct `node scripts/build-snapshots.mjs`
// invocation, never when imported (e.g. by the offline unit tests).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error("FATAL:", e);
    process.exit(1);
  });
}
