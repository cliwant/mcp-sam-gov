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
 */

export const REPO_URL = "https://github.com/cliwant/mcp-sam-gov";
const NEW_ISSUE_URL = `${REPO_URL}/issues/new`;

export type FeedbackKind = "bug" | "feature" | "wrong_output";

const REDACT_NOTE =
  "⚠️ This is a PUBLIC issue. Do NOT paste API keys, credentials, personal data, or sensitive query values — redact anything private before you submit.";

/**
 * Build a GitHub "new issue" URL with a prefilled title/body/labels. Everything
 * is URL-encoded via URLSearchParams. A prefilled label that does not exist in
 * the repo is simply ignored by GitHub (the issue still opens) — never an error.
 */
function buildIssueUrl(params: { title: string; body: string; labels: string[] }): string {
  const q = new URLSearchParams();
  q.set("title", params.title);
  q.set("body", params.body);
  if (params.labels.length > 0) q.set("labels", params.labels.join(","));
  return `${NEW_ISSUE_URL}?${q.toString()}`;
}

/**
 * The prefilled report link attached to a schema_drift / upstream_unavailable
 * error envelope. Carries ONLY tool + kind + server version — no args, no PII.
 */
export function reportUrlForError(tool: string, kind: string, version: string): string {
  const title = `[${tool}] ${kind}`;
  const kindHint =
    kind === "schema_drift"
      ? "schema_drift means the government API very likely changed its response shape, so the wrapper needs updating — this is the single most useful thing to report."
      : "upstream_unavailable is often a transient government-side outage; please report only if it PERSISTS or the endpoint appears to have permanently moved.";
  const body = [
    "**Reporting a tool problem** (this link was suggested by the server).",
    "",
    `- **Tool:** \`${tool}\``,
    `- **Error kind:** \`${kind}\``,
    `- **Server version:** \`${version}\``,
    "",
    "**What I was trying to do:** _(describe — no sensitive values)_",
    "",
    "**Why it looks wrong / how often it happens:** _(describe)_",
    "",
    `_${kindHint}_`,
    "",
    REDACT_NOTE,
  ].join("\n");
  return buildIssueUrl({ title, body, labels: ["from-tool"] });
}

/**
 * The ONLY two error kinds that get a prefilled report link — the "something may
 * be broken on our side" kinds. Expected/user errors (invalid_input, not_found,
 * rate_limited) are deliberately excluded so their envelopes stay byte-identical.
 */
export const REPORTABLE_ERROR_KINDS: ReadonlySet<string> = new Set([
  "schema_drift",
  "upstream_unavailable",
]);

/**
 * Attach a prefilled `report` URL to an error envelope IN PLACE, but only for a
 * reportable kind. A no-op (envelope unchanged) for every other kind. Centralizes
 * the policy so the dispatcher and the tests agree on exactly which kinds report.
 */
export function maybeAttachReport(
  error: { kind: string; report?: string },
  tool: string,
  version: string,
): void {
  if (REPORTABLE_ERROR_KINDS.has(error.kind)) {
    error.report = reportUrlForError(tool, error.kind, version);
  }
}

const KIND_TITLE: Record<FeedbackKind, string> = {
  bug: "Bug",
  feature: "Feature request",
  wrong_output: "Tool returned a wrong-looking result",
};
const KIND_LABELS: Record<FeedbackKind, string[]> = {
  bug: ["bug"],
  feature: ["enhancement"],
  wrong_output: ["bug", "wrong-output"],
};

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
 */
export function feedbackTool(input: {
  kind?: FeedbackKind;
  tool?: string;
  summary?: string;
}): FeedbackResult {
  const kind: FeedbackKind = input.kind ?? "bug";
  const toolPart = input.tool ? `[${input.tool}] ` : "";
  const summary = (input.summary ?? "").trim();
  const title = `${toolPart}${KIND_TITLE[kind]}${summary ? `: ${summary}` : ""}`;
  const lead =
    kind === "feature"
      ? "**What I want to be able to do:**"
      : "**What I did, expected, and got:**";
  const body = [
    `**Type:** ${KIND_TITLE[kind]}`,
    input.tool ? `**Tool:** \`${input.tool}\`` : "",
    "",
    `${lead} ${summary || "_(describe)_"}`,
    "",
    kind === "feature"
      ? "**Why it matters / use case:** _(describe)_"
      : "**Steps to reproduce:** _(describe — no sensitive values)_",
    "",
    REDACT_NOTE,
  ]
    .filter((line, i) => !(line === "" && i === 2 && !input.tool))
    .join("\n");
  return {
    reportUrl: buildIssueUrl({ title, body, labels: KIND_LABELS[kind] }),
    repo: REPO_URL,
    willPost: false,
    instructions:
      "Open reportUrl in a browser and submit the issue yourself — the server does NOT post anything automatically. Edit the prefilled title/body first if you like.",
    privacy:
      "The link prefills only your summary + tool name — no API keys, query values, or personal data. Keep it that way; the issue is public.",
  };
}
