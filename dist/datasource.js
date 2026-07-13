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
import { fetchWithRetry, errorFromResponse, ToolErrorCarrier, } from "./errors.js";
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
    // POST/body passthrough (ADR-0014) — set ONLY when defined, matching the
    // `headers` idiom, so a GET caller's init stays byte-identical (no `method`/
    // `body` key). `method`/`body` are RequestInit fields forwarded without logic.
    if (opts.method !== undefined)
        init.method = opts.method;
    if (opts.body !== undefined)
        init.body = opts.body;
    const r = await fetchWithRetry(url, init, opts.label);
    return (await r.json());
}
/**
 * getJsonWithHeaders — the header-exposing sibling of `getJson` (ADR-0038 M1).
 *
 * WHY a SEPARATE primitive (and NOT a mutation of getJson): a PostgREST source
 * (FAC / any Range-paginating REST API) carries its EXACT total in the
 * `Content-Range` RESPONSE HEADER, but `getJson` returns ONLY `await r.json()`
 * (the parsed body) and DISCARDS the `Response`/headers — so the header is
 * unreachable through it. Mutating getJson's return shape would break every one
 * of its ~9 callers (NOT byte-identical); this additive variant leaves getJson
 * untouched. It runs the IDENTICAL init assembly + `fetchWithRetry(url, init,
 * opts.label)` envelope as getJson (same headers / `redirect` / timeout / method
 * / body / retry-taxonomy), and returns the parsed body PLUS ONLY the
 * `content-range` header string — it NEVER surfaces the raw `Headers` object, so
 * no incidental response header (Set-Cookie, a rate-limit token, etc.) can reach
 * a consumer's `_meta`/output. A 200 non-JSON body makes `r.json()` throw a
 * `SyntaxError`, exactly as with getJson — the caller reclassifies it (the
 * fdic.ts / ADR-0038 S1 pattern), keeping the shared envelope free of source
 * quirks.
 */
export async function getJsonWithHeaders(url, opts) {
    const init = {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    };
    if (opts.headers !== undefined)
        init.headers = opts.headers;
    if (opts.redirect)
        init.redirect = opts.redirect;
    if (opts.method !== undefined)
        init.method = opts.method;
    if (opts.body !== undefined)
        init.body = opts.body;
    const r = await fetchWithRetry(url, init, opts.label);
    return {
        body: (await r.json()),
        contentRange: r.headers.get("content-range"),
    };
}
/**
 * GET one text resource through the shared envelope. Assembles `init`
 * (byte-identical to `getJson`'s rule: a fresh `AbortSignal.timeout` always;
 * `headers`/`redirect` set ONLY when the option is provided), then either
 * retries via `fetchWithRetry` (default) or does a single classified `fetch`
 * (retry:false), and returns the raw `r.text()` body.
 */
export async function getText(url, opts) {
    const init = {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    };
    if (opts.headers !== undefined)
        init.headers = opts.headers;
    if (opts.redirect)
        init.redirect = opts.redirect;
    // Default path (far/gao): retry transient errors up to 3× via the shared
    // primitive, then return the body text.
    if (opts.retry !== false) {
        const r = await fetchWithRetry(url, init, opts.label);
        return await r.text();
    }
    // Single-attempt path (fpds m-redirect): the fetch is done HERE so a
    // redirect:"error" TypeError is classified as a NON-retryable schema_drift
    // (never routed through fetchWithRetry, which would retry it 3× as a retryable
    // upstream_unavailable). A 5xx/429/404/timeout is classified + THROWS (never a
    // fake empty). Byte-for-byte the shipped fpds single-fetch body.
    let r;
    try {
        r = await fetch(url, init);
    }
    catch (e) {
        if (isRedirectError(e)) {
            // Fail closed — NEVER follow the off-host redirect, NEVER read its body,
            // and do NOT let it masquerade as a retryable outage.
            throw driftError(opts.label, opts.redirectMessage ??
                `Off-host redirect refused (redirect:"error") while fetching ${opts.label}.`);
        }
        // timeout / abort / network — retryable upstream, but THROWS (never fake-empty).
        throw new ToolErrorCarrier({
            kind: "upstream_unavailable",
            message: `Network error reaching ${opts.label}: ${e instanceof Error ? e.message : String(e)}`,
            retryable: true,
            retryAfterSeconds: 30,
            upstreamEndpoint: opts.label,
        });
    }
    if (!r.ok) {
        // 404/429/5xx/4xx → the errors.ts taxonomy. A DOWN service NEVER reads empty.
        throw new ToolErrorCarrier(errorFromResponse(r, opts.label));
    }
    return await r.text();
}
/**
 * Is a thrown error the redirect:"error" TypeError (undici: cause "unexpected
 * redirect")? The live FPDS search.do→sam.gov 301 is the concrete case
 * (ADR-0012 §1a). Moved here from fpds.ts (ADR-0013) as `getText`'s audited home
 * — it is only reachable when a caller sets `redirect:"error"` (undici throws
 * the unexpected-redirect TypeError only in `"error"` mode), so it is inert for
 * any retry:false caller that does NOT set redirect.
 */
export function isRedirectError(e) {
    if (!(e instanceof TypeError))
        return false;
    const causeMsg = e.cause && typeof e.cause.message === "string"
        ? e.cause.message
        : "";
    return /redirect/i.test(causeMsg) || /redirect/i.test(e.message);
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