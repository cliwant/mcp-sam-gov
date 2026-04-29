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
const RATE_LIMIT_DEFAULT_SECONDS = 30;
export class ToolErrorCarrier extends Error {
    toolError;
    constructor(toolError) {
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
export function errorFromResponse(r, endpoint) {
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
export async function fetchWithRetry(url, init, endpointLabel) {
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const r = await fetch(url, init);
            if (r.ok)
                return r;
            const err = errorFromResponse(r, endpointLabel);
            if (!err.retryable || attempt === maxAttempts) {
                throw new ToolErrorCarrier(err);
            }
            lastErr = err;
            const wait = err.retryAfterSeconds
                ? Math.min(err.retryAfterSeconds, 60)
                : Math.pow(2, attempt - 1);
            await new Promise((res) => setTimeout(res, wait * 1000));
        }
        catch (e) {
            if (e instanceof ToolErrorCarrier)
                throw e;
            // Network-level error
            lastErr = {
                kind: "upstream_unavailable",
                message: `Network error reaching ${endpointLabel}: ${e.message}`,
                retryable: true,
                retryAfterSeconds: 30,
                upstreamEndpoint: endpointLabel,
            };
            if (attempt === maxAttempts) {
                throw new ToolErrorCarrier(lastErr);
            }
            await new Promise((res) => setTimeout(res, Math.pow(2, attempt - 1) * 1000));
        }
    }
    throw new ToolErrorCarrier(lastErr ?? {
        kind: "unknown",
        message: `${endpointLabel} failed after ${maxAttempts} attempts.`,
        retryable: false,
        upstreamEndpoint: endpointLabel,
    });
}
function parseRetryAfter(value) {
    if (!value)
        return RATE_LIMIT_DEFAULT_SECONDS;
    const asInt = Number.parseInt(value, 10);
    if (Number.isFinite(asInt))
        return asInt;
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
export function toToolError(e, endpointLabel) {
    if (e instanceof ToolErrorCarrier)
        return e.toolError;
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
//# sourceMappingURL=errors.js.map