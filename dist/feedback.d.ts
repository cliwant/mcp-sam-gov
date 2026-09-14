/**
 * feedback.ts — the in-product feedback → GitHub-issue loop (KEYLESS, PULL-only).
 *
 * Why this exists
 * ----------------
 * This server's "user" is an AI agent, not a human at a keyboard. So the way we
 * collect "this looked wrong / this is broken / I wish it could do X" from real
 * usage is THROUGH the agent: a tool (or an error envelope) hands the agent a
 * PREFILLED GitHub "new issue" URL, and the agent offers it to the human, who
 * opens and submits it.
 *
 * Hard guarantees (consistent with the server's keyless / honest / no-telemetry
 * posture — and with the rule never to submit a form on the user's behalf):
 *   • PULL only. The server NEVER posts to GitHub. It builds a link; the human
 *     clicks and submits. No token, no account, no auto-submit, no network call.
 *   • No PII. A prefill carries only the tool name, server version, and (for the
 *     `feedback` tool) a caller-supplied one-line summary. It NEVER embeds the
 *     user's tool arguments or the upstream response, and every prefill body
 *     tells the human to redact anything sensitive before submitting.
 *   • Non-nagging. Error links are attached only to the two "something may be
 *     broken" kinds (schema_drift, upstream_unavailable) — never to expected
 *     outcomes (not_found, invalid_input, rate_limited).
 *   • Countable. Every prefilled body starts with one fixed HTML comment,
 *     `<!-- mcp-sam-gov:tool-report v=<server version> kind=<report kind> -->`
 *     (invisible once the issue renders). GitHub drops a prefilled `labels=`
 *     for filers without triage rights, so the repo's label-tool-reports
 *     workflow reads this marker instead and applies `from-tool`. The marker
 *     holds only the server version and the report kind — never a tool
 *     argument, query, key, path, or the caller's summary.
 */
export declare const REPO_URL = "https://github.com/cliwant/mcp-sam-gov";
export type FeedbackKind = "bug" | "feature" | "wrong_output";
/** The fixed token the label-tool-reports workflow looks for in an issue body. */
export declare const TOOL_REPORT_MARKER_TOKEN = "mcp-sam-gov:tool-report";
/**
 * The one-line, PII-free HTML comment put at the top of every prefilled body:
 * `<!-- mcp-sam-gov:tool-report v=<version> kind=<kind> -->`. A value that does
 * not match its pattern is written as `unknown`. It goes FIRST in the body so a
 * URL cut short at the end still keeps it, and it adds under 100 URL characters.
 */
export declare function toolReportMarker(kind: string, version: string): string;
/**
 * The prefilled report link attached to a schema_drift / upstream_unavailable
 * error envelope. Carries ONLY tool + kind + server version — no args, no PII.
 */
export declare function reportUrlForError(tool: string, kind: string, version: string): string;
/**
 * The ONLY two error kinds that get a prefilled report link — the "something may
 * be broken on our side" kinds. Expected/user errors (invalid_input, not_found,
 * rate_limited) are deliberately excluded so their envelopes stay byte-identical.
 */
export declare const REPORTABLE_ERROR_KINDS: ReadonlySet<string>;
/**
 * Attach a prefilled `report` URL to an error envelope IN PLACE, but only for a
 * reportable kind. A no-op (envelope unchanged) for every other kind. Centralizes
 * the policy so the dispatcher and the tests agree on exactly which kinds report.
 */
export declare function maybeAttachReport(error: {
    kind: string;
    report?: string;
}, tool: string, version: string): void;
export type FeedbackResult = {
    reportUrl: string;
    repo: string;
    willPost: false;
    instructions: string;
    privacy: string;
};
/**
 * The `feedback` tool handler. Turns a caller's (agent's) bug/feature/wrong-output
 * report into a PREFILLED GitHub new-issue URL for the HUMAN to open and submit.
 * Pure + keyless: no network, no posting. `summary` is caller-supplied free text
 * and is trusted to be non-sensitive (the description + privacy note say so).
 * `version` is the server version, used only in the tool-report marker.
 */
export declare function feedbackTool(input: {
    kind?: FeedbackKind;
    tool?: string;
    summary?: string;
}, version: string): FeedbackResult;
//# sourceMappingURL=feedback.d.ts.map