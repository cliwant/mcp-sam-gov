/**
 * datasource.ts — the shared fetch envelope for the keyless DataSources
 * (ADR-0005). This is the ONE audited `assemble init → fetchWithRetry → r.json()`
 * skeleton the keyless adapters share; the per-source quirks (timeout / headers /
 * redirect) are OPTIONS, not three bespoke fetch fns. `RequestInit` already
 * carries `headers` and `redirect`, so getJson forwards them without adding logic
 * — folding the fetch fns into one is lossless.
 *
 * R2 SCOPE (ADR-0005 v2 FIX-B): getJson ships ONLY { label, headers?, redirect?,
 * timeoutMs? }. The min-interval GATE (throughGate / gateKey / minIntervalMs) is
 * DEFERRED to the EDGAR follow-on slice, where it has a real call site + a real
 * parity spy + the AbortSignal-timing disclosure — publishing it now would be
 * unused machinery exercised by zero pilot sources. `redirect:"error"` STAYS: a
 * zero-logic RequestInit passthrough, absent for Treasury, and Socrata + the
 * queued CKAN connector need the identical SSRF hardening.
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

export type GetJsonOptions = {
  /** fetchWithRetry taxonomy + error surface. HOST-ONLY, never a token. */
  label: string;
  /** Set on init ONLY when defined — Treasury passes nothing → no `headers` key. */
  headers?: Record<string, string>;
  /** SSRF hardening passthrough; omitted from init when absent (Treasury/EDGAR). */
  redirect?: "error";
  /** Request timeout; default 15_000 (all sources today). */
  timeoutMs?: number;
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
  const r = await fetchWithRetry(url, init, opts.label);
  return (await r.json()) as T;
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
