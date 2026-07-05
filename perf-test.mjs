#!/usr/bin/env node
/**
 * Performance / memory regression detector for the OPT-IN 225 MB GSA-CSV backbone
 * (T10). The backbone's defining safety property is BOUNDED RAM: the daily 225 MB
 * CSV must be STREAMED (download piped to disk, parse via readline) so it is never
 * held in memory — only a COMPACT NoticeId→{~8 fields} index lives in RAM. A
 * regression that `readFile`s the whole CSV (instead of `createReadStream` +
 * readline) would reintroduce a multi-hundred-MB OOM risk on a memory-limited MCP
 * host. This test proves streaming empirically by indexing a large synthetic
 * fixture and asserting RSS growth stays BELOW the file size.
 *
 * It is NON-BLOCKING in CI (RSS is environment-noisy — GC timing, heap sizing,
 * OS differ across ubuntu/windows × Node 20/22), so it is a VISIBLE drift signal,
 * not a hard gate. The assertion bound (growth < file size) is deliberately
 * generous: streaming grows RSS by ~index-size (well under the file); a load-all
 * regression grows RSS by ≥ file-size and trips it.
 *
 * Run: node perf-test.mjs   ·   Exit 0 = pass, 1 = a bound was exceeded.
 */

import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "gsa-csv.js")).href;
const csv = await import(distUrl);

let FAIL = 0;
const ok = (name, cond, detail = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : `  — ${detail}`}`);
  if (!cond) FAIL++;
};

// ── Build a large synthetic CSV in the real 47-column shape. The size comes from
// a big Description field (col 46) — which the indexer does NOT keep (it parses
// only cols 0..MAX_COL≈24). So the FILE is large but the INDEX is small, exactly
// like the real GSA CSV (its bulk is Description text, not the ~8 indexed cols).
// Streaming reads each line and discards col 46; a load-all holds every
// description in RAM. Modest row count ⇒ small index ⇒ a wide margin below the
// file size, so the RSS check is discriminating without being flaky.
const NROWS = 8_000;
const DESC = "X".repeat(8_000); // ~8 KB non-indexed Description per row
const HEADER = Array.from({ length: 47 }, (_, i) => `col${i}`).join(",") + "\n";
const parts = [HEADER];
let buf = [];
const KNOWN_ID = "00000000abcdef0123456789abcdef01";
for (let i = 0; i < NROWS; i++) {
  const id = i === 0 ? KNOWN_ID : (i.toString(16).padStart(8, "0") + "abcdef0123456789abcdef01").slice(0, 32);
  const row = new Array(47).fill("");
  row[0] = id;
  row[14] = "SBA"; // SetAsideCode
  row[16] = "2026-08-01T00:00:00-04:00"; // ResponseDeadLine
  row[17] = "541512"; // NaicsCode
  row[24] = "Yes"; // Active
  row[46] = DESC; // large, NOT indexed → inflates file, not the index
  buf.push(row.join(","));
  if (buf.length >= 2000) { parts.push(buf.join("\n") + "\n"); buf = []; }
}
if (buf.length) parts.push(buf.join("\n") + "\n");
let body = parts.join("");
const fileMB = Buffer.byteLength(body) / 1048576;
const fixturePath = path.join(tmpdir(), `mcp-sam-gov-perf-${process.pid}.csv`);
writeFileSync(fixturePath, body);
// Release the in-test copy of the CSV so `before` measures the index build only.
body = null;
parts.length = 0;

console.log(`\n=== GSA-CSV backbone: bounded-RAM streaming (T10) ===`);
console.log(`  fixture: ${NROWS} rows, ${fileMB.toFixed(1)} MB (real 47-col shape)`);

try {
  process.env.SAM_GOV_CSV_FIXTURE = fixturePath;
  csv._resetIndexForTests?.();
  if (global.gc) global.gc();
  const before = process.memoryUsage().rss / 1048576;

  // Triggers the full pipeline: fixture stat → streaming index build → memoized lookup.
  const res = await csv.lookupNoticeFields({ noticeIds: [KNOWN_ID] });
  const after = process.memoryUsage().rss / 1048576;
  const growth = after - before;

  // 1. MEMORY: RSS growth must be BELOW the file size ⇒ the CSV was streamed, not
  //    buffered whole. (Streaming ⇒ growth ≈ compact index; load-all ⇒ growth ≥ file.)
  ok(`bounded RAM: RSS growth (${growth.toFixed(0)} MB) < CSV file size (${fileMB.toFixed(0)} MB) ⇒ streamed, not load-all`,
    growth < fileMB, `growth ${growth.toFixed(0)}MB ≥ file ${fileMB.toFixed(0)}MB — likely reading the whole CSV into memory`);

  // 2. SCALE CORRECTNESS: the streaming index built over 130k rows resolves the
  //    known notice with the right compact fields (proves the pipeline works at scale).
  const row = res?.data?.results?.[0];
  ok(`scale correctness: index of ${NROWS} rows resolves the known noticeId (found:true, naics 541512, setAside SBA)`,
    !!row && row.found === true && row.naicsCode === "541512" && (row.setAside === "SBA" || row.setAsideCode === "SBA"),
    JSON.stringify(row));

  console.log(`\n  (baseline RSS ${before.toFixed(0)} MB → ${after.toFixed(0)} MB; a load-all regression would grow by ≥ ${fileMB.toFixed(0)} MB)`);
} finally {
  try { rmSync(fixturePath, { force: true }); } catch { /* best effort */ }
  const cacheDir = path.join(path.dirname(fixturePath), ".mcp-sam-gov-csv-cache");
  try { rmSync(cacheDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(FAIL === 0 ? `\n=== perf OK ===\n` : `\n=== perf FAIL (${FAIL}) ===\n`);
process.exit(FAIL === 0 ? 0 : 1);
