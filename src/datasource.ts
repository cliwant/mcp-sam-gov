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

import {
  fetchWithRetry,
  errorFromResponse,
  ToolErrorCarrier,
  isHonorRetryAfter,
  type ToolError,
} from "./errors.js";

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
export async function getJson<T = unknown>(
  url: string,
  opts: GetJsonOptions,
): Promise<T> {
  const init: RequestInit = {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  };
  if (opts.headers !== undefined) init.headers = opts.headers;
  if (opts.redirect) init.redirect = opts.redirect;
  // POST/body passthrough (ADR-0014) — set ONLY when defined, matching the
  // `headers` idiom, so a GET caller's init stays byte-identical (no `method`/
  // `body` key). `method`/`body` are RequestInit fields forwarded without logic.
  if (opts.method !== undefined) init.method = opts.method;
  if (opts.body !== undefined) init.body = opts.body;
  const r = await fetchWithRetry(url, init, opts.label);
  return (await r.json()) as T;
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
export async function getJsonWithHeaders<T = unknown>(
  url: string,
  opts: GetJsonOptions,
): Promise<{ body: T; contentRange: string | null }> {
  const init: RequestInit = {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  };
  if (opts.headers !== undefined) init.headers = opts.headers;
  if (opts.redirect) init.redirect = opts.redirect;
  if (opts.method !== undefined) init.method = opts.method;
  if (opts.body !== undefined) init.body = opts.body;
  const r = await fetchWithRetry(url, init, opts.label);
  return {
    body: (await r.json()) as T,
    contentRange: r.headers.get("content-range"),
  };
}

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
export async function getText(
  url: string,
  opts: GetTextOptions,
): Promise<string> {
  const init: RequestInit = {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  };
  if (opts.headers !== undefined) init.headers = opts.headers;
  if (opts.redirect) init.redirect = opts.redirect;

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
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (e) {
    if (isRedirectError(e)) {
      // Fail closed — NEVER follow the off-host redirect, NEVER read its body,
      // and do NOT let it masquerade as a retryable outage.
      throw driftError(
        opts.label,
        opts.redirectMessage ??
          `Off-host redirect refused (redirect:"error") while fetching ${opts.label}.`,
      );
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
export function isRedirectError(e: unknown): boolean {
  if (!(e instanceof TypeError)) return false;
  const causeMsg =
    e.cause && typeof (e.cause as { message?: unknown }).message === "string"
      ? (e.cause as { message: string }).message
      : "";
  return /redirect/i.test(causeMsg) || /redirect/i.test(e.message);
}

/**
 * The shared `schema_drift` constructor (all sources threw the identical
 * carrier). Each source keeps its bespoke field-CHECK inline and calls this to
 * standardize only the THROW. `label` becomes `upstreamEndpoint` — host-only,
 * never a token.
 */
export function driftError(label: string, message: string): ToolErrorCarrier {
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
const gates = new Map<string, { chain: Promise<unknown>; lastAt: number }>();

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
export function throughGate<T>(
  key: string,
  minIntervalMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  let gate = gates.get(key);
  if (!gate) {
    gate = { chain: Promise.resolve(), lastAt: 0 };
    gates.set(key, gate);
  }
  const g = gate;
  const run = g.chain.then(async () => {
    const wait = g.lastAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    g.lastAt = Date.now();
    return fn();
  });
  // Keep the chain alive whether this link resolves or rejects.
  g.chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESILIENCE PORT (ADR-0045 Phase 1 — landed COMPLETELY INERT)
// ═══════════════════════════════════════════════════════════════════════════
//
// ★POLICY BOUNDARY (ADR-0045 §"정책 경계", invariant — see the safety rules):
// These primitives serve PUBLIC OPEN-DATA AVAILABILITY only. They are NOT an
// access-control bypass. Specifically, and unconditionally:
//   • NO auth / paywall / CAPTCHA / behind-a-login bypass.
//   • Rate limits are HONORED, never routed around: a 429 — and any 5xx bearing a
//     Retry-After header (isHonorRetryAfter, errors.ts M2) — waits and fails
//     honestly; it NEVER counts as a breaker failure nor triggers a fallback.
//   • NO IP-rotation / residential-proxy / egress-hunting (m1-policy). The default
//     deployment is client-side (each user's own clean egress); if OUR egress is
//     blocked we HONOR it and fail — we do not escalate.
//   • A mirror/snapshot is an HONEST cache of public data with provenance +
//     freshness disclosed (P5); a non-live body can NEVER be labelled live.
//
// ★INERT in Phase 1: NO adapter opts into a multi-path chain or the conditional
// primitive, and getJson/getText/getJsonWithHeaders are BYTE-IDENTICAL. A
// single-path chain is a pure passthrough (no breaker consult, no overhead) =
// today's behavior. The breaker only activates for a ≥2-path chain, so for all
// 27 single-path sources it is a NO-OP that never skips the live attempt.

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
export async function getJsonWithProvenance<T = unknown>(
  url: string,
  opts: GetJsonOptions,
): Promise<{ body: T; provenance: Provenance }> {
  const init: RequestInit = {
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  };
  if (opts.headers !== undefined) init.headers = opts.headers;
  if (opts.redirect) init.redirect = opts.redirect;
  if (opts.method !== undefined) init.method = opts.method;
  if (opts.body !== undefined) init.body = opts.body;
  const r = await fetchWithRetry(url, init, opts.label);
  return {
    body: (await r.json()) as T,
    // Single live path in Phase 1 — always live, no asOf.
    provenance: { dataPath: "live" },
  };
}

// ─── Per-host circuit breaker (ADR-0045 B1) ────────────────────────────────
/**
 * A per-host circuit breaker (bounded, keyed by a FIXED host set — the same
 * discipline as `gates` above, so the Map can NEVER grow unboundedly; m3-reg).
 *
 * Trip condition (INTENTIONALLY narrow, B1-regression): 5 CONSECUTIVE HARD
 * failures on a host — where HARD = a 5xx or a network `TypeError` ONLY. It is
 * EXPLICITLY not tripped by 429 (rate-limited), a 5xx bearing Retry-After
 * (isHonorRetryAfter — B1-policy), 404, or Timeout/Abort (errors.ts:162-172's
 * existing fast-fail). Once open, it stays open 30s, then admits a SINGLE
 * half-open probe; a probe success closes it, a probe failure re-opens it.
 *
 * ★INERT in Phase 1: the breaker is only ever CONSULTED by `throughPathChain`
 * for a ≥2-path chain. No source declares ≥2 paths this phase, so it never
 * activates in production — but it is unit-tested directly.
 */
const BREAKER_TRIP_THRESHOLD = 5;
const BREAKER_OPEN_MS = 30_000;

type BreakerState = {
  /** Consecutive HARD failures since the last success (resets on any success). */
  consecutiveHardFailures: number;
  /** Epoch ms until which the breaker is OPEN (0 = closed). */
  openUntil: number;
  /** True once a half-open probe has been admitted (dedupes to a SINGLE probe). */
  probeInFlight: boolean;
};

export class CircuitBreaker {
  /** Bounded: only hosts in the fixed set are ever tracked (m3-regression). */
  private readonly hosts: ReadonlySet<string>;
  private readonly states = new Map<string, BreakerState>();
  /** Injectable clock for deterministic offline unit tests (defaults Date.now). */
  private readonly now: () => number;

  constructor(hosts: Iterable<string>, now: () => number = () => Date.now()) {
    this.hosts = new Set(hosts);
    this.now = now;
  }

  private state(host: string): BreakerState | undefined {
    if (!this.hosts.has(host)) return undefined; // untracked host ⇒ pure no-op
    let s = this.states.get(host);
    if (!s) {
      s = { consecutiveHardFailures: 0, openUntil: 0, probeInFlight: false };
      this.states.set(host, s);
    }
    return s;
  }

  /**
   * Should the live attempt to `host` be SKIPPED right now? True only while the
   * breaker is OPEN and its 30s window has not elapsed AND a half-open probe is
   * already in flight. When the window elapses, exactly ONE caller is admitted as
   * the half-open probe (this returns false and marks probeInFlight) and the rest
   * are skipped until that probe reports back. An untracked host is NEVER skipped.
   */
  shouldSkip(host: string): boolean {
    const s = this.state(host);
    if (!s || s.openUntil === 0) return false; // closed (or untracked) ⇒ attempt
    if (this.now() < s.openUntil) {
      // Fully OPEN within the 30s window ⇒ skip every live attempt.
      return true;
    }
    // Window elapsed → HALF-OPEN. Admit exactly ONE probe (returns false so it
    // attempts live); skip all others until that probe reports back.
    if (!s.probeInFlight) {
      s.probeInFlight = true;
      return false;
    }
    return true;
  }

  /** Record a live success — closes the breaker and resets the failure run. */
  onSuccess(host: string): void {
    const s = this.state(host);
    if (!s) return;
    s.consecutiveHardFailures = 0;
    s.openUntil = 0;
    s.probeInFlight = false;
  }

  /**
   * Record a live failure. A NON-hard error (429 / honor-Retry-After / 404 /
   * timeout / abort) is IGNORED — it neither counts toward the trip threshold nor
   * resets the run (it is orthogonal to host health). A HARD error increments the
   * consecutive count and trips the breaker at the threshold; if it arrives during
   * a half-open probe it immediately re-opens the window.
   */
  onFailure(host: string, err: unknown): void {
    const s = this.state(host);
    if (!s) return;
    if (!isHardFailure(err)) return; // 429/honor-RA/404/timeout ⇒ not host health
    if (s.probeInFlight) {
      // Half-open probe failed → re-open for another full window.
      s.openUntil = this.now() + BREAKER_OPEN_MS;
      s.probeInFlight = false;
      return;
    }
    s.consecutiveHardFailures += 1;
    if (s.consecutiveHardFailures >= BREAKER_TRIP_THRESHOLD) {
      s.openUntil = this.now() + BREAKER_OPEN_MS;
    }
  }

  /** Test-only introspection: is the breaker currently OPEN for `host`? */
  isOpen(host: string): boolean {
    const s = this.states.get(host);
    return !!s && s.openUntil !== 0 && this.now() < s.openUntil;
  }
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
export function isHardFailure(err: unknown): boolean {
  if (isHonorRetryAfter(err)) return false;
  if (err instanceof ToolErrorCarrier) {
    const te = err.toolError;
    return te.kind === "upstream_unavailable" && te.retryable === true;
  }
  return err instanceof TypeError;
}

// ─── Path-chain abstraction (ADR-0045 §"경로 체인") ──────────────────────────
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
export async function throughPathChain<T>(
  paths: ReadonlyArray<ResiliencePath<T>>,
  breaker?: CircuitBreaker,
): Promise<{ body: T; provenance: Provenance }> {
  if (paths.length === 0) {
    throw new ToolErrorCarrier({
      kind: "unknown",
      message: "throughPathChain called with no paths.",
      retryable: false,
    });
  }
  // Single-path fast path: pure passthrough, no breaker, no overhead (=today).
  if (paths.length === 1) {
    const only = paths[0]!;
    return { body: await only.run(), provenance: only.provenance };
  }
  let lastErr: unknown;
  for (const path of paths) {
    if (breaker && breaker.shouldSkip(path.host)) {
      // Breaker open for this host → skip the live attempt, try the next path.
      lastErr =
        lastErr ??
        new ToolErrorCarrier({
          kind: "upstream_unavailable",
          message: `Circuit breaker open for ${path.host}; skipped.`,
          retryable: true,
          upstreamEndpoint: path.host,
        });
      continue;
    }
    try {
      const body = await path.run();
      if (breaker) breaker.onSuccess(path.host);
      return { body, provenance: path.provenance };
    } catch (e) {
      // Honor an explicit upstream wait — NEVER count it against the breaker and
      // NEVER fall through to a fallback path (B1-policy). Wait + fail honestly.
      if (isHonorRetryAfter(e)) throw e;
      if (breaker) breaker.onFailure(path.host, e);
      lastErr = e;
    }
  }
  throw lastErr;
}

// ─── Conditional GET (ADR-0045 B2-regression) ──────────────────────────────
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
export async function getJsonConditional<T = unknown>(
  url: string,
  opts: GetJsonOptions,
  cache?: CacheEntry<T>,
): Promise<{ body: T; notModified: boolean; provenance: Provenance }> {
  // (a) Send validators ONLY when a cache entry is held.
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (cache?.etag !== undefined) headers["If-None-Match"] = cache.etag;
  if (cache?.lastModified !== undefined)
    headers["If-Modified-Since"] = cache.lastModified;

  const buildInit = (): RequestInit => {
    const init: RequestInit = {
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    };
    if (Object.keys(headers).length > 0) init.headers = headers;
    if (opts.redirect) init.redirect = opts.redirect;
    if (opts.method !== undefined) init.method = opts.method;
    if (opts.body !== undefined) init.body = opts.body;
    return init;
  };

  const maxAttempts = 3;
  let lastErr: ToolError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(url, buildInit());
      // (b)/(c) Intercept 304 BEFORE the r.ok gate; NEVER read its (absent) body.
      if (r.status === 304) {
        if (!cache) {
          // A 304 with no held validators is a protocol violation — fail honestly
          // rather than fabricate an empty body.
          throw new ToolErrorCarrier({
            kind: "schema_drift",
            message: `Unexpected 304 from ${opts.label} without a cache entry.`,
            retryable: false,
            upstreamEndpoint: opts.label,
          });
        }
        return {
          body: cache.body,
          notModified: true,
          provenance: cache.asOf
            ? { dataPath: "snapshot", asOf: cache.asOf }
            : { dataPath: "live" },
        };
      }
      if (r.ok) {
        return {
          body: (await r.json()) as T,
          notModified: false,
          provenance: { dataPath: "live" },
        };
      }
      const err = errorFromResponse(r, opts.label);
      if (!err.retryable || attempt === maxAttempts) {
        throw new ToolErrorCarrier(err);
      }
      lastErr = err;
      const wait = err.retryAfterSeconds
        ? Math.min(err.retryAfterSeconds, 60)
        : Math.pow(2, attempt - 1);
      await new Promise((res) => setTimeout(res, wait * 1000));
    } catch (e) {
      if (e instanceof ToolErrorCarrier) throw e;
      // Timeout/abort ⇒ fast-fail non-retryable (mirrors fetchWithRetry:162-172).
      if (
        e instanceof Error &&
        (e.name === "TimeoutError" || e.name === "AbortError")
      ) {
        throw new ToolErrorCarrier({
          kind: "upstream_unavailable",
          message: `Request to ${opts.label} timed out.`,
          retryable: false,
          upstreamEndpoint: opts.label,
        });
      }
      lastErr = {
        kind: "upstream_unavailable",
        message: `Network error reaching ${opts.label}: ${(e as Error).message}`,
        retryable: true,
        retryAfterSeconds: 30,
        upstreamEndpoint: opts.label,
      };
      if (attempt === maxAttempts) throw new ToolErrorCarrier(lastErr);
      await new Promise((res) =>
        setTimeout(res, Math.pow(2, attempt - 1) * 1000),
      );
    }
  }
  throw new ToolErrorCarrier(
    lastErr ?? {
      kind: "unknown",
      message: `${opts.label} failed after ${maxAttempts} attempts.`,
      retryable: false,
      upstreamEndpoint: opts.label,
    },
  );
}
