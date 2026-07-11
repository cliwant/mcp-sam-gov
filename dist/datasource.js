/**
 * datasource.ts — the shared fetch envelope for the keyless DataSources
 * (ADR-0005). This is the ONE audited `assemble init → fetchWithRetry → r.json()`
 * skeleton the keyless adapters share; the per-source quirks (timeout / headers /
 * redirect) are OPTIONS, not three bespoke fetch fns. `RequestInit` already
 * carries `headers` and `redirect`, so getJson forwards them without adding logic
 * — folding the fetch fns into one is lossless.
 *
 * R2 SCOPE (ADR-0005 v2 FIX-B): getJson ships ONLY { label, headers?, redirect?,
 * timeoutMs? }. `redirect:"error"` STAYS: a zero-logic RequestInit passthrough,
 * absent for Treasury, and Socrata + the queued CKAN connector need the identical
 * SSRF hardening.
 *
 * THE MIN-INTERVAL GATE (ADR-0011 orchestrator, v6 cycle 15 — the R2 deferred
 * slice, now landed): `throughGate(key, minIntervalMs, fn)` is a STANDALONE
 * exported primitive (below), the shared home for EDGAR's former module-singleton
 * self-throttle. It is deliberately NOT wired into getJson and `gateKey`/
 * `minIntervalMs` are deliberately NOT added to GetJsonOptions — there is no
 * getJson consumer that throttles, so that would be dead option-surface (FIX-B
 * "no dead surface"). If a future source makes a throttled getJson call, wiring
 * the gate into getJson can be revisited then.
 *
 * `label` is the fetchWithRetry taxonomy key AND surfaces verbatim in
 * ToolError.upstreamEndpoint to the MCP caller — it MUST be HOST-ONLY and never
 * contain a token (Socrata/EDGAR m7).
 *
 * The shape-drift CHECK stays at each call site (bespoke per-source fields); only
 * the THROW is standardized via `driftError`. This is deliberately NOT a `guard`
 * hook baked into getJson: a hook would collide with Socrata's count(*) companion
 * (which must degrade to total:null and NEVER throw schema_drift) and its
 * discoverDatasets memoize boundary — leaving the check at the call site keeps
 * that split honest (ADR-0005 §1c / Q4).
 */
import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
/**
 * GET + parse one JSON resource through the shared envelope. Assembles `init`
 * (a fresh `AbortSignal.timeout` always; `headers`/`redirect` set ONLY when the
 * option is provided — byte-identical to each source's prior hand-rolled init),
 * calls `fetchWithRetry` (retry/backoff + the 429/5xx/404/400 taxonomy), then
 * returns the parsed body. The caller validates the shape and throws
 * `driftError` on drift.
 */
export async function getJson(url, opts) {
    const init = {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    };
    if (opts.headers !== undefined)
        init.headers = opts.headers;
    if (opts.redirect)
        init.redirect = opts.redirect;
    const r = await fetchWithRetry(url, init, opts.label);
    return (await r.json());
}
/**
 * The shared `schema_drift` constructor (all sources threw the identical
 * carrier). Each source keeps its bespoke field-CHECK inline and calls this to
 * standardize only the THROW. `label` becomes `upstreamEndpoint` — host-only,
 * never a token.
 */
export function driftError(label, message) {
    return new ToolErrorCarrier({
        kind: "schema_drift",
        message,
        retryable: false,
        upstreamEndpoint: label,
    });
}
// ─── Per-key min-interval gate (shared self-throttle primitive) ────
/**
 * One serialized promise chain + last-run timestamp PER KEY. Module-level so a
 * key's chain persists across every call in the process (the whole point of a
 * self-throttle: a tool call can fan out and many tools may run). Different keys
 * are independent chains — they never block each other.
 */
const gates = new Map();
/**
 * Serialize every call sharing `key` through a single promise chain, spacing the
 * START of consecutive runs by ≥ `minIntervalMs`. This is the generalization of
 * EDGAR's former module singleton (edgar.ts `edgarGateChain`/`edgarLastFetchAt`/
 * `throughEdgarGate`); `throughGate("edgar", 110, fn)` reproduces its behavior
 * EXACTLY. Semantics that MUST stay byte-identical to the old EDGAR gate:
 *   - the Map entry is fetched-or-created and MUTATED IN PLACE (never replaced),
 *     so a key keeps one chain across the process;
 *   - before invoking `fn()`, wait `max(0, minIntervalMs - (now - lastAt))` using
 *     the **bare global `setTimeout`** (NOT `node:timers/promises`) — the fault
 *     suite's timer-neutralizing patch makes this offline-instant; an import-based
 *     timer would break that (and offline determinism);
 *   - `lastAt` is stamped with `Date.now()` **BEFORE** `fn()` is called, so the
 *     spacing is measured from the START of the previous run (edgar L97-98);
 *   - the chain SWALLOWS each step's error so the queue keeps flowing, while the
 *     real result/error still propagates on the promise returned to THAT caller.
 */
export function throughGate(key, minIntervalMs, fn) {
    let gate = gates.get(key);
    if (!gate) {
        gate = { chain: Promise.resolve(), lastAt: 0 };
        gates.set(key, gate);
    }
    const g = gate;
    const run = g.chain.then(async () => {
        const wait = g.lastAt + minIntervalMs - Date.now();
        if (wait > 0)
            await new Promise((res) => setTimeout(res, wait));
        g.lastAt = Date.now();
        return fn();
    });
    // Keep the chain alive whether this link resolves or rejects.
    g.chain = run.then(() => undefined, () => undefined);
    return run;
}
//# sourceMappingURL=datasource.js.map