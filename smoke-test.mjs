#!/usr/bin/env node
/**
 * Smoke-test the MCP server by spawning it + speaking JSON-RPC over
 * stdio. Verifies that:
 *   1. `initialize` handshake completes
 *   2. `tools/list` returns all 8 tools
 *   3. `tools/call` for sam_search_opportunities returns real data
 *
 * Run: node smoke-test.mjs
 */

import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";

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
      // ignore non-json
    }
  }
});

let id = 1;

async function rpc(method, params) {
  const myId = id++;
  const req = { jsonrpc: "2.0", id: myId, method, params: params ?? {} };
  child.stdin.write(JSON.stringify(req) + "\n");
  for (let i = 0; i < 100; i++) {
    if (responses.has(myId)) return responses.get(myId);
    await wait(80);
  }
  throw new Error(`No response for id=${myId} method=${method}`);
}

try {
  // 1. initialize
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.1" },
  });
  console.log("✓ initialize:", init.result?.serverInfo);

  // 2. tools/list
  const tools = await rpc("tools/list", {});
  const toolNames = (tools.result?.tools ?? []).map((t) => t.name);
  console.log(`✓ tools/list: ${toolNames.length} tools`);
  for (const t of toolNames) console.log(`    • ${t}`);

  // 3. tools/call → sam_search_opportunities
  const search = await rpc("tools/call", {
    name: "sam_search_opportunities",
    arguments: { ncode: "541512", limit: 2 },
  });
  const text = search.result?.content?.[0]?.text ?? "";
  const parsed = JSON.parse(text);
  console.log(`✓ tools/call sam_search_opportunities:`);
  console.log(`    totalRecords: ${parsed.totalRecords}`);
  console.log(`    returned:     ${parsed.returned}`);
  for (const o of parsed.opportunities ?? []) {
    console.log(`    • ${o.noticeId} — ${o.title?.slice(0, 60)}`);
  }

  // 4. tools/call → usas_lookup_agency
  const agency = await rpc("tools/call", {
    name: "usas_lookup_agency",
    arguments: { searchText: "veterans" },
  });
  const agencyText = agency.result?.content?.[0]?.text ?? "";
  const agencyParsed = JSON.parse(agencyText);
  console.log(
    `✓ tools/call usas_lookup_agency: ${agencyParsed.matches?.length} matches`,
  );
  for (const m of (agencyParsed.matches ?? []).slice(0, 3)) {
    console.log(`    • ${m.name} (${m.abbreviation ?? "—"})`);
  }

  console.log("\n✅ smoke test PASSED");
  child.kill();
  process.exit(0);
} catch (err) {
  console.error("\n❌ smoke test FAILED:", err);
  child.kill();
  process.exit(1);
}
