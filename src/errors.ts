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
  /** Notice/award/document ID has wrong shape (length/format). Don't retry. */
  | "id_format_invalid"
  /** Date string (e.g. fiscal year, publication date) is unparseable or out of supported range. Don't retry. */
  | "date_invalid"
  /** Caller passed an agency abbreviation/partial name that didn't resolve. Hint: call lookup tool first. */
  | "agency_not_resolved"
  /** Caller passed a NAICS code that's retired or never existed. Hint: call autocomplete first. */
  | "naics_invalid"
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
  /** Endpoint / tool name that failed — for ops + hint resolution. */
  upstreamEndpoint?: string;
  /**
   * Actionable next-step suggestion the calling agent can use to recover.
   * Names a SIBLING TOOL or input fix where applicable.
   * Example: "Notice IDs are 32-char hex. Use sam_search_opportunities to get a real noticeId first."
   */
  hint?: string;
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
    return {
      kind: "upstream_unavailable",
      message: `Upstream server error (HTTP ${r.status}) at ${endpoint}. Try again later.`,
      retryable: true,
      retryAfterSeconds: 60,
      upstreamStatus,
      upstreamEndpoint: endpoint,
    };
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
 * Compute a tool-specific actionable hint for an error.
 *
 * Maps (ErrorKind, tool name) -> next-step suggestion. Names sibling
 * tools the agent should call first, or input format corrections.
 * Returns undefined when no canonical hint applies.
 */
export function hintFor(
  kind: ErrorKind,
  toolOrEndpoint: string | undefined,
): string | undefined {
  if (!toolOrEndpoint) return undefined;
  const t = toolOrEndpoint;

  // Tool-specific hints — common kinds for ID-bearing tools.
  // 400 / 404 / id-shape errors all benefit from the same "use the
  // search tool first" hint.
  const isIdShapeError =
    kind === "not_found" ||
    kind === "id_format_invalid" ||
    kind === "invalid_input";
  if (isIdShapeError) {
    if (t.startsWith("sam_get_opportunity") || t.startsWith("sam_fetch_description")) {
      return "Notice IDs are 32-char hex. Use sam_search_opportunities first to get a real noticeId.";
    }
    if (t === "usas_get_award_detail") {
      return "Award IDs are generatedInternalId from usas_search_individual_awards (e.g. CONT_AWD_*). Run that search first.";
    }
    if (t === "usas_get_recipient_profile") {
      return "Recipient IDs come from usas_search_recipients (e.g. 'ed02855e-...-P'). Search by name first.";
    }
    if (t === "fed_register_get_document") {
      return "Federal Register doc numbers look like 'YYYY-NNNNN' (e.g. '2026-08333'). Use fed_register_search_documents to find a real one.";
    }
    if (t === "grants_get_opportunity") {
      return "Grants.gov opportunity IDs are numeric strings from grants_search.";
    }
    if (t === "sam_lookup_organization") {
      return "Organization IDs come from sam_get_opportunity (organizationHierarchy field) — fetch a notice first.";
    }
    if (t.startsWith("usas_get_agency_")) {
      return "Toptier codes are 3-4 digits from usas_lookup_agency (e.g. '036' for VA). Call lookup first.";
    }
  }

  if (kind === "agency_not_resolved") {
    return "Agency name didn't match a USAspending canonical entry. Call usas_lookup_agency('VA' / 'DHS' / etc.) FIRST to get the canonical toptier name.";
  }
  if (kind === "naics_invalid") {
    return "NAICS code didn't resolve. Call usas_autocomplete_naics with a free-text description first (e.g. 'cloud computing' → 541512).";
  }
  if (kind === "invalid_input") {
    if (t.startsWith("usas_") && t.includes("agency")) {
      return "If you used an abbreviation, call usas_lookup_agency first to get the canonical name.";
    }
  }

  // Generic hints for transport-layer kinds
  if (kind === "rate_limited") {
    return "USAspending / SAM.gov enforce per-minute caps. Wait `retryAfterSeconds` and retry. Aggressive callers should reduce concurrency.";
  }
  if (kind === "upstream_unavailable") {
    return "Federal endpoints are sometimes flaky. Most retries complete in <800ms. If repeated, check status.usaspending.gov or sam.gov status.";
  }
  if (kind === "schema_drift") {
    return "Upstream API shape changed. Daily smoke CI catches this within 24h — please open an issue at github.com/cliwant/mcp-sam-gov/issues.";
  }
  return undefined;
}

/**
 * Attach a hint to an existing ToolError if one is available.
 */
export function withHint(err: ToolError): ToolError {
  if (err.hint) return err;
  const hint = hintFor(err.kind, err.upstreamEndpoint);
  return hint ? { ...err, hint } : err;
}

/**
 * Convert any thrown error into a serializable ToolError envelope.
 * Used at the dispatcher boundary — server.ts catches everything
 * and wraps before returning to the MCP client.
 *
 * The `endpointLabel` here is the MCP TOOL NAME (e.g.
 * "fed_register_get_document") which `hintFor()` uses to resolve
 * tool-specific hints. The carrier's stored upstreamEndpoint is
 * the API-level identifier (e.g. "federal-register:documents/...")
 * — we keep that for ops/debug but always recompute hints from the
 * outer tool name.
 */
export function toToolError(e: unknown, endpointLabel?: string): ToolError {
  if (e instanceof ToolErrorCarrier) {
    const inner = e.toolError;
    // Recompute hint using the outer tool name (not the inner upstream endpoint)
    // so sibling-tool routing hints fire correctly.
    if (!inner.hint) {
      const hint = hintFor(inner.kind, endpointLabel);
      if (hint) return { ...inner, hint };
    }
    return inner;
  }
  if (e instanceof Error) {
    const msg = e.message;
    // Zod validation errors → invalid_input with shape hint
    if (e.name === "ZodError" || /zod/i.test(msg) || /Required|Expected/.test(msg)) {
      return withHintFromTool({
        kind: "invalid_input",
        message: `Input validation failed for ${endpointLabel ?? "tool"}: ${msg}`,
        retryable: false,
        upstreamEndpoint: endpointLabel,
      }, endpointLabel);
    }
    // Common fetch timeout signature
    if (e.name === "TimeoutError" || /timeout|aborted/i.test(msg)) {
      return withHintFromTool({
        kind: "upstream_unavailable",
        message: `${endpointLabel ?? "upstream"} timed out: ${msg}`,
        retryable: true,
        retryAfterSeconds: 30,
        upstreamEndpoint: endpointLabel,
      }, endpointLabel);
    }
    return withHintFromTool({
      kind: "unknown",
      message: msg,
      retryable: false,
      upstreamEndpoint: endpointLabel,
    }, endpointLabel);
  }
  return withHintFromTool({
    kind: "unknown",
    message: String(e),
    retryable: false,
    upstreamEndpoint: endpointLabel,
  }, endpointLabel);
}

/**
 * Apply hint using an explicit tool-name override (separate from
 * upstreamEndpoint, which may be an API-level identifier).
 */
function withHintFromTool(err: ToolError, toolName: string | undefined): ToolError {
  if (err.hint) return err;
  const hint = hintFor(err.kind, toolName);
  return hint ? { ...err, hint } : err;
}
