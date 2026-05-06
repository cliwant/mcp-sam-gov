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
 * Compute a tool-specific actionable hint for an error.
 *
 * Maps (ErrorKind, tool name) -> next-step suggestion. Names sibling
 * tools the agent should call first, or input format corrections.
 * Returns undefined when no canonical hint applies.
 */
export declare function hintFor(kind: ErrorKind, toolOrEndpoint: string | undefined): string | undefined;
/**
 * Attach a hint to an existing ToolError if one is available.
 */
export declare function withHint(err: ToolError): ToolError;
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
export declare function toToolError(e: unknown, endpointLabel?: string): ToolError;
//# sourceMappingURL=errors.d.ts.map