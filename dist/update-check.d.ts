/**
 * update-check.ts — a startup "an update is available" notice (OPT-OUT, no telemetry).
 *
 * Why this exists
 * ----------------
 * npm is pull-based: a user who already installed the server is never told that a
 * newer version shipped. This closes that gap with the least intrusive mechanism
 * possible — a single anonymous version check on startup.
 *
 * What it does: one GET to the PUBLIC npm registry for THIS package's `latest`
 * version, compared to the running version. Only if a newer one exists does it print
 * one friendly line to STDERR.
 *
 * This is NOT telemetry. It sends NO user data anywhere — it fetches our own
 * package's public version metadata from registry.npmjs.org (the same registry the
 * package was installed from). It is, by construction:
 *   • opt-out via `MCP_SAM_GOV_NO_UPDATE_CHECK=1` (or the de-facto `NO_UPDATE_NOTIFIER=1`);
 *   • non-blocking (fire-and-forget with a short timeout — never delays startup);
 *   • fail-silent (any network / parse / abort error prints nothing and never throws);
 *   • STDERR-only (the JSON-RPC stdout stream is never touched);
 *   • quiet when up-to-date (prints only when a strictly-newer version exists).
 */
export declare const REGISTRY_LATEST_URL = "https://registry.npmjs.org/@cliwant/mcp-sam-gov/latest";
/**
 * Strictly-newer compare on the numeric MAJOR.MINOR.PATCH prefix only. A prerelease
 * or build suffix on either side is ignored (a `-rc` is never announced as "newer"
 * than the release it precedes). Non-numeric junk coerces to 0, so a malformed
 * registry value can never spuriously trigger a notice.
 */
export declare function isNewerVersion(latest: string, current: string): boolean;
/**
 * Perform the startup update check. `log` defaults to stderr and is injectable so the
 * offline fault suite can assert exactly when a notice is (and is not) emitted.
 * Resolves to the message that was logged, or null if nothing was logged — for tests;
 * the server calls it fire-and-forget and ignores the result.
 */
export declare function checkForUpdate(currentVersion: string, log?: (msg: string) => void): Promise<string | null>;
//# sourceMappingURL=update-check.d.ts.map