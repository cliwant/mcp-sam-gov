/**
 * Structured error envelope for every tool response.
 *
 * Why this exists
 * ----------------
 * Federal APIs fail in 5 distinct ways: rate-limited (429), down
 * (5xx), schema-drift (200 with unexpected shape), notice-not-found
 * (404), and transient network. Each has a different retry strategy.
 * If we just throw, the LLM sees "Tool error: TypeError: x is
 * undefined" and gives up.
 *
 * Every tool should return either:
 *   { ok: true, data: ... }
 *   { ok: false, error: { kind, message, retryable, retryAfterSeconds? } }
 *
 * The MCP server layer surfaces this as JSON to the calling agent.
 * The agent can then decide: retry now, retry later, or surface
 * the error to the user with appropriate framing.
 */

import { ZodError } from "zod";

export type ErrorKind =
  /** HTTP 429. Retry after `retryAfterSeconds`. */
  | "rate_limited"
  /** HTTP 5xx or network error. Likely transient. */
  | "upstream_unavailable"
  /** HTTP 404 / empty results. Don't retry. */
  | "not_found"
  /** Caller passed bad input (e.g. malformed noticeId). Don't retry. */
  | "invalid_input"
  /** API returned 200 but we couldn't parse / shape doesn't match. */
  | "schema_drift"
  /** Anything else. Don't retry. */
  | "unknown";

export type ToolError = {
  kind: ErrorKind;
  message: string;
  /** Whether the agent should retry. Pairs with retryAfterSeconds. */
  retryable: boolean;
  /** If rate-limited, advisory wait time. Honors `Retry-After` header. */
  retryAfterSeconds?: number;
  /** Echo upstream HTTP status when available — helps debug. */
  upstreamStatus?: number;
  /** Endpoint that failed — for ops. */
  upstreamEndpoint?: string;
  /**
   * Set true when the upstream EXPLICITLY asked us to wait — i.e. a 429, or a
   * 5xx that CARRIED a `Retry-After` header (ADR-0045 M2). The resilience layer
   * (circuit breaker + path-chain) consults `isHonorRetryAfter(err)` and EXCLUDES
   * such errors from the breaker failure count AND from fallback (B1-policy): we
   * wait and fail honestly as `rate_limited`/`upstream_unavailable`, never route
   * around a rate limit onto a mirror/snapshot. Absent (undefined) on a plain 5xx
   * with no Retry-After header — that stays a HARD failure the breaker counts, so
   * absence must NOT be read as `false`-meaning-"honor". The 429 path never sets
   * this flag (it is detected by `kind==="rate_limited"`), keeping the 429 error
   * envelope byte-identical to before this ADR.
   */
  honorRetryAfter?: boolean;
};

export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

const RATE_LIMIT_DEFAULT_SECONDS = 30;

export class ToolErrorCarrier extends Error {
  readonly toolError: ToolError;
  constructor(toolError: ToolError) {
    super(toolError.message);
    this.toolError = toolError;
    this.name = "ToolErrorCarrier";
  }
}

/**
 * Convert a fetch Response into a structured tool error.
 *
 * Honors `Retry-After` (both seconds-int and HTTP-date forms).
 */
export function errorFromResponse(
  r: Response,
  endpoint: string,
): ToolError {
  const upstreamStatus = r.status;
  if (r.status === 429) {
    const retryAfter = parseRetryAfter(r.headers.get("Retry-After"));
    return {
      kind: "rate_limited",
      message: `Upstream rate-limited (HTTP 429) at ${endpoint}. Retry after ${retryAfter}s.`,
      retryable: true,
      retryAfterSeconds: retryAfter,
      upstreamStatus,
      upstreamEndpoint: endpoint,
    };
  }
  if (r.status === 404) {
    return {
      kind: "not_found",
      message: `Resource not found at ${endpoint} (HTTP 404).`,
      retryable: false,
      upstreamStatus,
      upstreamEndpoint: endpoint,
    };
  }
  if (r.status >= 500) {
    const err: ToolError = {
      kind: "upstream_unavailable",
      message: `Upstream server error (HTTP ${r.status}) at ${endpoint}. Try again later.`,
      retryable: true,
      retryAfterSeconds: 60,
      upstreamStatus,
      upstreamEndpoint: endpoint,
    };
    // ADR-0045 M2 — a 5xx MAY carry Retry-After (e.g. a 503 maintenance window).
    // Parse it ONLY when the header is PRESENT (so a plain 5xx is byte-identical
    // to before: retryAfterSeconds:60, no honorRetryAfter key), preserving the
    // `Math.min(...,60)` worst-case cap. The 429 branch above is UNTOUCHED (it
    // already parses Retry-After; re-implementing it is forbidden). Flagging
    // honorRetryAfter lets the resilience layer EXCLUDE this from the breaker /
    // fallback (B1-policy: honor the explicit wait, never route around it).
    const retryAfterHeader = r.headers.get("Retry-After");
    if (retryAfterHeader !== null) {
      err.retryAfterSeconds = Math.min(parseRetryAfter(retryAfterHeader), 60);
      err.honorRetryAfter = true;
    }
    return err;
  }
  if (r.status >= 400) {
    return {
      kind: "invalid_input",
      message: `Bad request (HTTP ${r.status}) at ${endpoint}.`,
      retryable: false,
      upstreamStatus,
      upstreamEndpoint: endpoint,
    };
  }
  return {
    kind: "unknown",
    message: `Unexpected status ${r.status} at ${endpoint}.`,
    retryable: false,
    upstreamStatus,
    upstreamEndpoint: endpoint,
  };
}

/**
 * Does this thrown error carry an EXPLICIT "wait, then fail honestly" signal
 * from the upstream — a 429 (`rate_limited`), or a 5xx that carried a
 * `Retry-After` header (ADR-0045 M2, flagged `honorRetryAfter`)?
 *
 * The resilience layer (circuit breaker + path-chain, datasource.ts) consults
 * this to EXCLUDE such errors from the breaker failure count AND from fallback
 * (ADR-0045 B1-policy): a rate limit / honor-Retry-After outcome must NEVER
 * count as a breaker "hard failure" nor trigger a mirror/snapshot fallback — we
 * wait and fail honestly. This is a POLICY boundary, not a bypass: we honor the
 * upstream's explicit throttle, we do not route around it.
 */
export function isHonorRetryAfter(err: unknown): boolean {
  if (!(err instanceof ToolErrorCarrier)) return false;
  const te = err.toolError;
  if (te.kind === "rate_limited") return true;
  return te.honorRetryAfter === true;
}

/**
 * Wrap a fetch + json call in retry-with-backoff for transient errors.
 *
 * Strategy: up to 3 attempts. On 429: respect Retry-After up to 60s.
 * On 5xx: 1s, 2s, 4s exponential. On parse error: no retry (schema
 * drift — needs human investigation).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  endpointLabel: string,
): Promise<Response> {
  const maxAttempts = 3;
  let lastErr: ToolError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const r = await fetch(url, init);
      if (r.ok) return r;
      const err = errorFromResponse(r, endpointLabel);
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
      // A timeout/abort. The caller's AbortSignal.timeout fired (or an
      // already-aborted signal is being reused across attempts). Retrying is
      // futile within this call's budget: the same signal stays aborted, so
      // attempts 2/3 reject immediately without ever reaching the endpoint,
      // and a re-driven tool call just re-hits the same wall. Fail fast,
      // honestly non-retryable. Keyed on the DOMException NAME only —
      // AbortSignal.timeout → "TimeoutError", AbortController.abort() →
      // "AbortError" — which is disjoint from a genuine network fault
      // (TypeError, name "TypeError"), so a real "fetch failed" falls through
      // to the generic retryable branch below UNCHANGED.
      if (
        e instanceof Error &&
        (e.name === "TimeoutError" || e.name === "AbortError")
      ) {
        // HONESTY (dogfooding 2026-07-16): if a PRIOR attempt already classified a
        // real upstream signal — a 429 rate_limit — do NOT mask it as a generic
        // "timed out". The abort here is a DOWNSTREAM artifact of waiting out that
        // rate limit (the retry-after wait outran getJson's AbortSignal, so the
        // next fetch hits the already-aborted signal). Surfacing "timed out" hides
        // the true cause (rate-limited) AND its remedy (wait / supply an API key)
        // and drops the retryable+retryAfterSeconds guidance. Prefer the real
        // rate_limited error. (A pure timeout with no prior 429 keeps "timed out".)
        if (lastErr && lastErr.kind === "rate_limited") {
          throw new ToolErrorCarrier(lastErr);
        }
        throw new ToolErrorCarrier({
          kind: "upstream_unavailable",
          message: `Request to ${endpointLabel} timed out.`,
          retryable: false,
          upstreamEndpoint: endpointLabel,
        });
      }
      // Network-level error
      lastErr = {
        kind: "upstream_unavailable",
        message: `Network error reaching ${endpointLabel}: ${(e as Error).message}`,
        retryable: true,
        retryAfterSeconds: 30,
        upstreamEndpoint: endpointLabel,
      };
      if (attempt === maxAttempts) {
        throw new ToolErrorCarrier(lastErr);
      }
      await new Promise((res) =>
        setTimeout(res, Math.pow(2, attempt - 1) * 1000),
      );
    }
  }
  throw new ToolErrorCarrier(
    lastErr ?? {
      kind: "unknown",
      message: `${endpointLabel} failed after ${maxAttempts} attempts.`,
      retryable: false,
      upstreamEndpoint: endpointLabel,
    },
  );
}

function parseRetryAfter(value: string | null): number {
  if (!value) return RATE_LIMIT_DEFAULT_SECONDS;
  const asInt = Number.parseInt(value, 10);
  if (Number.isFinite(asInt)) return asInt;
  // HTTP-date form
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }
  return RATE_LIMIT_DEFAULT_SECONDS;
}

/**
 * Convert any thrown error into a serializable ToolError envelope.
 * Used at the dispatcher boundary — server.ts catches everything
 * and wraps before returning to the MCP client.
 */
export function toToolError(e: unknown, endpointLabel?: string): ToolError {
  if (e instanceof ToolErrorCarrier) return e.toolError;
  // A Zod input-validation failure is a CALLER error (e.g. limit above the max,
  // a value outside an enum). Classify it as `invalid_input` with a readable
  // field-level message — NEVER a generic `unknown` carrying Zod's raw JSON
  // issue array (which an agent can't act on, and which mislabels a fixable
  // input problem as a mysterious/possibly-transient failure).
  if (e instanceof ZodError) {
    return {
      kind: "invalid_input",
      message: `Invalid input${endpointLabel ? ` for ${endpointLabel}` : ""}: ${e.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      retryable: false,
      upstreamEndpoint: endpointLabel,
    };
  }
  if (e instanceof Error) {
    const msg = e.message;
    // Common fetch timeout signature
    if (e.name === "TimeoutError" || /timeout|aborted/i.test(msg)) {
      return {
        kind: "upstream_unavailable",
        message: `${endpointLabel ?? "upstream"} timed out: ${msg}`,
        retryable: true,
        retryAfterSeconds: 30,
        upstreamEndpoint: endpointLabel,
      };
    }
    return {
      kind: "unknown",
      message: msg,
      retryable: false,
      upstreamEndpoint: endpointLabel,
    };
  }
  return {
    kind: "unknown",
    message: String(e),
    retryable: false,
    upstreamEndpoint: endpointLabel,
  };
}
