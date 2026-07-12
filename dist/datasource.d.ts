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
import { ToolErrorCarrier } from "./errors.js";
export type GetJsonOptions = {
    /** fetchWithRetry taxonomy + error surface. HOST-ONLY, never a token. */
    label: string;
    /** Set on init ONLY when defined — Treasury passes nothing → no `headers` key. */
    headers?: Record<string, string>;
    /** SSRF hardening passthrough; omitted from init when absent (Treasury/EDGAR). */
    redirect?: "error";
    /** Request timeout; default 15_000 (all sources today). */
    timeoutMs?: number;
    /**
     * HTTP method — the SINGLE literal `"POST"` (ADR-0014, the first non-GET
     * consumer: NIH RePORTER is a POST-with-JSON-body API). Set on init ONLY when
     * defined, so every existing GET caller (which omits it) keeps a byte-identical
     * init with NO `method` key. Typed as the literal (not `string`) so a stray
     * `method:"GET"` cannot silently alter a consumer. A retry of a read-only POST
     * search with a re-readable string body is safe.
     */
    method?: "POST";
    /**
     * Request body (a pre-serialized string, e.g. `JSON.stringify(payload)`).
     * A `RequestInit` field, exactly like `headers`/`redirect` — getJson forwards
     * it verbatim, adding no logic. Set on init ONLY when defined (the `!== undefined`
     * idiom), so a GET caller's init stays byte-identical.
     */
    body?: string;
};
/**
 * GET + parse one JSON resource through the shared envelope. Assembles `init`
 * (a fresh `AbortSignal.timeout` always; `headers`/`redirect` set ONLY when the
 * option is provided — byte-identical to each source's prior hand-rolled init),
 * calls `fetchWithRetry` (retry/backoff + the 429/5xx/404/400 taxonomy), then
 * returns the parsed body. The caller validates the shape and throws
 * `driftError` on drift.
 */
export declare function getJson<T = unknown>(url: string, opts: GetJsonOptions): Promise<T>;
/**
 * getText — the shared fetch → `r.text()` → error-classify skeleton for the
 * keyless XML/RSS/ATOM sources (far/gao/fpds; ADR-0013). Sibling of `getJson`;
 * returns the RAW body text (each source runs its own bespoke string/regex
 * parser). The three sources' only structural variation — headers, redirect,
 * timeout, retry strategy, and the redirect-classification message — are OPTIONS,
 * reconciled so each source's fetch semantics are BYTE-IDENTICAL to its former
 * hand-rolled fetcher.
 *
 * Two strategies, selected by `retry`:
 *   - retry !== false (DEFAULT — far/gao): `fetchWithRetry` (3-attempt retry +
 *     the 429/5xx/404/4xx/network taxonomy), then `r.text()`.
 *   - retry === false (fpds, m-redirect): a SINGLE direct `fetch`. A redirect
 *     `"error"` TypeError is classified INLINE as a NON-retryable `schema_drift`
 *     (via `driftError` + `redirectMessage`) — NOT the retryable
 *     `upstream_unavailable` that `fetchWithRetry`'s generic network-catch would
 *     emit, exactly what m-redirect forbids (the live search.do→sam.gov 301 must
 *     fail closed, single attempt). This is why fpds does its own `fetch` rather
 *     than routing through the shared, retry-all-transients `fetchWithRetry`.
 *
 * Unlike `getJson`, `label` is an OPAQUE passthrough — NOT host-only normalized
 * (far's label is path-bearing `ecfr:versioner/…`; forcing host-only would break
 * it). All three sources are keyless, so no token can appear in a label.
 */
export type GetTextOptions = {
    /** fetchWithRetry taxonomy key + `ToolError.upstreamEndpoint`. Opaque
     *  passthrough (NOT host-only normalized — far's is path-bearing). */
    label: string;
    /** Set on init ONLY when defined (far Accept-only / gao+fpds UA+Accept). */
    headers?: Record<string, string>;
    /** SSRF hardening passthrough; omitted from init when absent (far/gao). */
    redirect?: "error";
    /** Request timeout; default 15_000 (all three sources today). */
    timeoutMs?: number;
    /** DEFAULT true → the fetchWithRetry path (far/gao). false → the single-fetch
     *  path (fpds; the redirect TypeError must be caught on the sole attempt). */
    retry?: boolean;
    /** `driftError` message when a redirect TypeError is caught on the single-fetch
     *  path — preserves fpds's exact honesty disclosure. Only consulted on the
     *  retry:false + redirect fault. */
    redirectMessage?: string;
};
/**
 * GET one text resource through the shared envelope. Assembles `init`
 * (byte-identical to `getJson`'s rule: a fresh `AbortSignal.timeout` always;
 * `headers`/`redirect` set ONLY when the option is provided), then either
 * retries via `fetchWithRetry` (default) or does a single classified `fetch`
 * (retry:false), and returns the raw `r.text()` body.
 */
export declare function getText(url: string, opts: GetTextOptions): Promise<string>;
/**
 * Is a thrown error the redirect:"error" TypeError (undici: cause "unexpected
 * redirect")? The live FPDS search.do→sam.gov 301 is the concrete case
 * (ADR-0012 §1a). Moved here from fpds.ts (ADR-0013) as `getText`'s audited home
 * — it is only reachable when a caller sets `redirect:"error"` (undici throws
 * the unexpected-redirect TypeError only in `"error"` mode), so it is inert for
 * any retry:false caller that does NOT set redirect.
 */
export declare function isRedirectError(e: unknown): boolean;
/**
 * The shared `schema_drift` constructor (all sources threw the identical
 * carrier). Each source keeps its bespoke field-CHECK inline and calls this to
 * standardize only the THROW. `label` becomes `upstreamEndpoint` — host-only,
 * never a token.
 */
export declare function driftError(label: string, message: string): ToolErrorCarrier;
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
export declare function throughGate<T>(key: string, minIntervalMs: number, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=datasource.d.ts.map