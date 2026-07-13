#!/usr/bin/env node
/**
 * Registry snapshot test — the byte-identical `tools/list` ground-truth.
 *
 * Spawns `node dist/server.js`, does the MCP stdio handshake (initialize →
 * tools/list), extracts the `tools` array, sorts it by `name`, and serializes
 * with 2-space indent. First run writes `tools-list-snapshot.json` and prints
 * `SNAPSHOT WRITTEN <count>`. Later runs deep-compare against the committed
 * snapshot and print `SNAPSHOT MATCH` or `SNAPSHOT MISMATCH` (+ which tool
 * differs), exiting non-zero on any drift.
 *
 * This is the ground-truth for the R1 tool-registry refactor (ADR-0001): the
 * structural refactor MUST keep ListTools output byte-identical. Do NOT
 * regenerate this snapshot to make a refactor "pass" (tautological-eval ban).
 *
 * Run: node registry-snapshot-test.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const SNAPSHOT_PATH = "tools-list-snapshot.json";
const TIMEOUT_MS = 20_000;

const child = spawn("node", ["dist/server.js"], {
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => {
  process.stderr.write(`[server] ${chunk}`);
});

let buf = "";
const responses = new Map();
// UTF-8-safe decode: a multi-byte char (e.g. the ★/× in a tool description) can
// SPLIT across two stdout chunks, and a naive per-chunk `chunk.toString()` mangles
// the split bytes into replacement chars — a non-deterministic false MISMATCH that
// surfaces only when the total output length shifts a boundary onto a multi-byte
// char. StringDecoder carries the partial trailing bytes across chunk boundaries.
const stdoutDecoder = new StringDecoder("utf8");

child.stdout.on("data", (chunk) => {
  buf += stdoutDecoder.write(chunk);
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) responses.set(msg.id, msg);
    } catch {
      // ignore non-JSON stdout noise
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
    await wait(50);
  }
  throw new Error(`Timeout id=${myId} method=${method}`);
}

function die(msg) {
  console.error(msg);
  child.kill();
  process.exit(1);
}

// Stable per-tool serialization for both storage and diffing.
function serializeTool(t) {
  return JSON.stringify(t, null, 2);
}

async function run() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "registry-snapshot-test", version: "0.0.1" },
  });

  const res = await rpc("tools/list", {});
  const tools = res.result?.tools;
  if (!Array.isArray(tools)) {
    die(
      `FATAL: tools/list did not return a tools array; got: ${JSON.stringify(
        res,
      ).slice(0, 400)}`,
    );
  }

  // Canonical form: sort by name, then 2-space JSON.
  const sorted = [...tools].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  const serialized = JSON.stringify(sorted, null, 2);
  const count = sorted.length;

  if (!existsSync(SNAPSHOT_PATH)) {
    writeFileSync(SNAPSHOT_PATH, serialized + "\n");
    console.log(`SNAPSHOT WRITTEN ${count}`);
    child.kill();
    process.exit(0);
  }

  const expected = readFileSync(SNAPSHOT_PATH, "utf8");
  if (expected.trimEnd() === serialized.trimEnd()) {
    console.log("SNAPSHOT MATCH");
    child.kill();
    process.exit(0);
  }

  // Mismatch — pinpoint which tool(s) differ.
  let prevTools;
  try {
    prevTools = JSON.parse(expected);
  } catch {
    die("SNAPSHOT MISMATCH (existing snapshot is not valid JSON)");
  }
  const byName = (arr) => new Map(arr.map((t) => [t.name, t]));
  const before = byName(prevTools);
  const after = byName(sorted);
  const diffs = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(name);
    const b = after.get(name);
    if (!a) {
      diffs.push(`+ ${name} (added)`);
    } else if (!b) {
      diffs.push(`- ${name} (removed)`);
    } else if (serializeTool(a) !== serializeTool(b)) {
      diffs.push(`~ ${name} (changed)`);
    }
  }
  console.error(`SNAPSHOT MISMATCH — ${diffs.length} tool(s) differ:`);
  for (const d of diffs.sort()) console.error(`  ${d}`);
  if (diffs.length === 0) {
    console.error(
      "  (per-tool JSON matches but full serialization differs — check count/order/whitespace)",
    );
  }
  child.kill();
  process.exit(1);
}

run().catch((err) => {
  console.error("FATAL:", err);
  child.kill();
  process.exit(1);
});
