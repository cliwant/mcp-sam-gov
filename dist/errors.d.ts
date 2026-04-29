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
"rate_limited"
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
};
export type ToolResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: ToolError;
};
export declare class ToolErrorCarrier extends Error {
    readonly toolError: ToolError;
    constructor(toolError: ToolError);
}
/**
 * Convert a fetch Response into a structured tool error.
 *
 * Honors `Retry-After` (both seconds-int and HTTP-date forms).
 */
export declare function errorFromResponse(r: Response, endpoint: string): ToolError;
/**
 * Wrap a fetch + json call in retry-with-backoff for transient errors.
 *
 * Strategy: up to 3 attempts. On 429: respect Retry-After up to 60s.
 * On 5xx: 1s, 2s, 4s exponential. On parse error: no retry (schema
 * drift — needs human investigation).
 */
export declare function fetchWithRetry(url: string, init: RequestInit, endpointLabel: string): Promise<Response>;
/**
 * Convert any thrown error into a serializable ToolError envelope.
 * Used at the dispatcher boundary — server.ts catches everything
 * and wraps before returning to the MCP client.
 */
export declare function toToolError(e: unknown, endpointLabel?: string): ToolError;
//# sourceMappingURL=errors.d.ts.map