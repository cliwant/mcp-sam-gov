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
export const REGISTRY_LATEST_URL = "https://registry.npmjs.org/@cliwant/mcp-sam-gov/latest";
const TIMEOUT_MS = 3000;
/**
 * Strictly-newer compare on the numeric MAJOR.MINOR.PATCH prefix only. A prerelease
 * or build suffix on either side is ignored (a `-rc` is never announced as "newer"
 * than the release it precedes). Non-numeric junk coerces to 0, so a malformed
 * registry value can never spuriously trigger a notice.
 */
export function isNewerVersion(latest, current) {
    const parse = (v) => String(v)
        .split("-")[0]
        .split(".")
        .slice(0, 3)
        .map((x) => {
        const n = Number.parseInt(x, 10);
        return Number.isFinite(n) ? n : 0;
    });
    const a = parse(latest);
    const b = parse(current);
    for (let i = 0; i < 3; i++) {
        const ai = a[i] ?? 0;
        const bi = b[i] ?? 0;
        if (ai > bi)
            return true;
        if (ai < bi)
            return false;
    }
    return false;
}
/**
 * Perform the startup update check. `log` defaults to stderr and is injectable so the
 * offline fault suite can assert exactly when a notice is (and is not) emitted.
 * Resolves to the message that was logged, or null if nothing was logged — for tests;
 * the server calls it fire-and-forget and ignores the result.
 */
export async function checkForUpdate(currentVersion, log = (m) => console.error(m)) {
    if (process.env.MCP_SAM_GOV_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER) {
        return null;
    }
    try {
        const res = await fetch(REGISTRY_LATEST_URL, {
            signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { Accept: "application/json" },
        });
        if (!res.ok)
            return null;
        const body = (await res.json());
        const latest = typeof body.version === "string" ? body.version : null;
        if (!latest || !isNewerVersion(latest, currentVersion))
            return null;
        const msg = `[mcp-sam-gov] a newer version is available: ${currentVersion} → ${latest}. ` +
            `Update with 'npm i -g @cliwant/mcp-sam-gov@latest' (or just restart if you run it via 'npx @cliwant/mcp-sam-gov@latest'). ` +
            `What changed: https://github.com/cliwant/mcp-sam-gov/releases  ` +
            `(silence this with MCP_SAM_GOV_NO_UPDATE_CHECK=1)`;
        log(msg);
        return msg;
    }
    catch {
        // Fail silent — an update check must never affect the server's operation.
        return null;
    }
}
//# sourceMappingURL=update-check.js.map