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
export declare function getJsonWithHeaders<T = unknown>(url: string, opts: GetJsonOptions): Promise<{
    body: T;
    contentRange: string | null;
}>;
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
/**
 * Provenance the resilience layer stamps on a served body (ADR-0045 B2). Mirrors
 * `getJsonWithHeaders`'s `{ body, contentRange }` provenance shape. `dataPath` is
 * a FRESHNESS enum (M2), not a topology label: an independent host serving live
 * data is still `"live"`. `asOf` (ISO-8601 UTC, m3) is present ONLY for a
 * non-live (`snapshot`) body.
 */
export type Provenance = {
    dataPath: "live" | "snapshot";
    asOf?: string;
};
/**
 * getJsonWithProvenance — the resilient-fetch primitive (ADR-0045 B2). Runs the
 * IDENTICAL init-assembly + `fetchWithRetry(url, init, opts.label)` envelope as
 * `getJson`, and returns `{ body, provenance }`. The port ALWAYS returns an
 * explicit provenance (honesty-B2 + regression-M1 reconciled): in Phase 1 there
 * is a SINGLE live path, so `provenance` is ALWAYS `{ dataPath:"live" }` (asOf
 * omitted). Because the port always stamps provenance, a mirror/snapshot body can
 * never be structurally mislabelled as live (a future adapter that forgets to
 * thread it still cannot claim live).
 *
 * ★INERT: NO adapter calls this yet — it is dormant infrastructure. It is a
 * SEPARATE primitive (getJson is untouched, byte-identical), exported for the
 * path-chain and for direct unit tests.
 */
export declare function getJsonWithProvenance<T = unknown>(url: string, opts: GetJsonOptions): Promise<{
    body: T;
    provenance: Provenance;
}>;
export declare class CircuitBreaker {
    /** Bounded: only hosts in the fixed set are ever tracked (m3-regression). */
    private readonly hosts;
    private readonly states;
    /** Injectable clock for deterministic offline unit tests (defaults Date.now). */
    private readonly now;
    constructor(hosts: Iterable<string>, now?: () => number);
    private state;
    /**
     * Should the live attempt to `host` be SKIPPED right now? True only while the
     * breaker is OPEN and its 30s window has not elapsed AND a half-open probe is
     * already in flight. When the window elapses, exactly ONE caller is admitted as
     * the half-open probe (this returns false and marks probeInFlight) and the rest
     * are skipped until that probe reports back. An untracked host is NEVER skipped.
     */
    shouldSkip(host: string): boolean;
    /** Record a live success — closes the breaker and resets the failure run. */
    onSuccess(host: string): void;
    /**
     * Record a live failure. A NON-hard error (429 / honor-Retry-After / 404 /
     * timeout / abort) is IGNORED — it neither counts toward the trip threshold nor
     * resets the run (it is orthogonal to host health). A HARD error increments the
     * consecutive count and trips the breaker at the threshold; if it arrives during
     * a half-open probe it immediately re-opens the window.
     */
    onFailure(host: string, err: unknown): void;
    /** Test-only introspection: is the breaker currently OPEN for `host`? */
    isOpen(host: string): boolean;
}
/**
 * Is a thrown error a HARD failure for circuit-breaker purposes (ADR-0045 B1)?
 * HARD = a 5xx or a network `TypeError` ONLY. Everything else is excluded:
 *   • isHonorRetryAfter (429 / 5xx+Retry-After) — B1-policy, honor the wait;
 *   • Timeout/Abort — classified upstream_unavailable with retryable:FALSE
 *     (errors.ts:169), so the `retryable===true` gate excludes it;
 *   • 404 (not_found), 4xx (invalid_input), schema_drift, unknown — not outages.
 * A 5xx-after-retries and a network TypeError both surface from `fetchWithRetry`
 * as a `ToolErrorCarrier` upstream_unavailable with retryable:TRUE — the one
 * signature this admits. A raw (unclassified) `TypeError` also counts, for
 * robustness when the breaker is driven directly.
 */
export declare function isHardFailure(err: unknown): boolean;
/**
 * One ordered access path for a source. `provenance` is what a SUCCESS on this
 * path yields (live for the primary API, snapshot for a self-hosted mirror);
 * `host` is the HOST-ONLY key the breaker tracks (must be in the breaker's fixed
 * set); `run` performs the fetch+parse (typically a `getJson*` call).
 */
export type ResiliencePath<T> = {
    provenance: Provenance;
    host: string;
    run: () => Promise<T>;
};
/**
 * Try an ordered array of access paths, returning the first success + its
 * provenance (ADR-0045 §"경로 체인").
 *
 * ★A SINGLE-entry chain is a PURE PASSTHROUGH — no breaker consult, no try/catch
 * overhead, byte-for-byte today's behavior (B1-regression). The breaker is
 * consulted ONLY for a ≥2-path chain, so the 27 single-path sources are never
 * affected.
 *
 * For a multi-path chain: an open breaker on a path's host SKIPS that path (no
 * live attempt); a HARD failure records against the breaker and falls through to
 * the next path; a SUCCESS records success and returns. An isHonorRetryAfter
 * error (429 / 5xx+Retry-After) is RE-THROWN IMMEDIATELY (B1-policy) — it never
 * counts against the breaker and never falls through to a mirror/snapshot; we
 * wait and fail honestly. If every path is exhausted, the last error is thrown
 * (honest failure — never a fabricated empty).
 */
export declare function throughPathChain<T>(paths: ReadonlyArray<ResiliencePath<T>>, breaker?: CircuitBreaker): Promise<{
    body: T;
    provenance: Provenance;
}>;
/**
 * A validator-bearing cache entry for `getJsonConditional`. `body` is the last
 * parsed payload; `etag`/`lastModified` are the validators to replay; `asOf`
 * (ISO-8601 UTC) is when the body was fetched.
 */
export type CacheEntry<T> = {
    body: T;
    etag?: string;
    lastModified?: string;
    asOf?: string;
};
/**
 * getJsonConditional — a SEPARATE conditional-GET primitive (ADR-0045
 * B2-regression). It is DELIBERATELY NOT folded into the shared getJson/getText:
 * adding If-None-Match/If-Modified-Since to getJson would make a 304 (a bodiless
 * response) hit `r.json()` → a SyntaxError that fdic:340 / fedreg:588 reclassify
 * as schema_drift — a hard regression. So this primitive:
 *   (a) sends validators ONLY when it holds a cache entry;
 *   (b) intercepts a 304 BEFORE the r.ok gate and returns the cached body;
 *   (c) NEVER calls `r.json()` on a 304.
 * It keeps getJson's retry taxonomy for the non-304 case (5xx/429/network retry;
 * timeout/abort fast-fail), via a local loop that mirrors fetchWithRetry but adds
 * the 304 short-circuit ABOVE the r.ok gate.
 *
 * ★INERT: no adapter uses it yet. A cache MISS (no entry) behaves like getJson
 * (no validators sent, 200 parsed) — so an adapter that later adopts it without a
 * warm cache is envelope-identical.
 */
export declare function getJsonConditional<T = unknown>(url: string, opts: GetJsonOptions, cache?: CacheEntry<T>): Promise<{
    body: T;
    notModified: boolean;
    provenance: Provenance;
}>;
//# sourceMappingURL=datasource.d.ts.map