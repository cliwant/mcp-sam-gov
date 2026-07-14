/**
 * @cliwant/mcp-sam-gov/keys — API-key discovery + `.env` auto-loading.
 *
 * Why this exists
 * ----------------
 * The server rides 31 federal sources. MOST are fully keyless. But the set of
 * *optional* keys (raise a rate limit, unlock one filter) plus the two *required*
 * keys (Census business-patterns, FRED) has grown to the point where a user — or
 * the AI driving the server — cannot tell, without reading source code:
 *   - which env var each source reads,
 *   - whether a key is REQUIRED or merely OPTIONAL,
 *   - where to get one (free), and
 *   - whether it is currently configured.
 *
 * `apiKeyStatus()` answers all four, truthfully, WITHOUT ever revealing a key's
 * value (only a `currentlySet` boolean). `loadDotEnv()` lets a user configure
 * keys ONCE in a `.env` file instead of the host's env block.
 *
 * Grounding: every `envVar` below is the exact string the code reads via
 * `process.env.<NAME>` — DATA_GOV_API_KEY (datagovKey.ts), SAM_GOV_API_KEY
 * (server.ts), BLS_API_KEY (bls.ts), NVD_API_KEY (nvd.ts), SOCRATA_APP_TOKEN
 * (socrata.ts), CENSUS_API_KEY (census-economic.ts), FRED_API_KEY (fred.ts).
 * No invented keys, sources, or signup URLs.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
/**
 * The 7 keys the server reads — code-grounded, no inventions.
 *
 * REQUIRED (2): CENSUS_API_KEY, FRED_API_KEY — those sources have no keyless
 * tier, so the tool throws without them. OPTIONAL (5): everything else works
 * keyless; a key only raises a rate limit or unlocks a single filter.
 */
export const KEY_REGISTRY = [
    {
        envVar: "DATA_GOV_API_KEY",
        sources: [
            "api.data.gov gateway: Regulations.gov, FAC, NPPES, CMS, data.gov catalog, GSA per-diem",
        ],
        required: false,
        signupUrl: "https://api.data.gov/signup/",
        unlocks: "higher rate limits on all api.data.gov sources (lifts the shared DEMO_KEY ~30/hr cap to ~1,000/hr)",
        note: "Keyless by default via the public DEMO_KEY; a key only raises the shared hourly quota.",
    },
    {
        envVar: "SAM_GOV_API_KEY",
        sources: ["SAM.gov opportunities"],
        required: false,
        signupUrl: "https://open.gsa.gov/api/get-opportunities-public-api/",
        unlocks: "the authenticated v2 opportunity search + the organization-name filter",
        note: "Keyless HAL endpoint works without it; a key enables the keyed v2 path and org-name filtering. Register at sam.gov / api.sam.gov.",
    },
    {
        envVar: "BLS_API_KEY",
        sources: ["Bureau of Labor Statistics (BLS)"],
        required: false,
        signupUrl: "https://data.bls.gov/registrationEngine/",
        unlocks: "the BLS v2 tier (~500 queries/day, 50 series/query, ~20-year span) vs keyless v1 (~25 queries/day)",
        note: "Keyless v1 works out of the box; a key upgrades to the higher v2 limits.",
    },
    {
        envVar: "NVD_API_KEY",
        sources: ["NIST NVD (cve_lookup)"],
        required: false,
        signupUrl: "https://nvd.nist.gov/developers/request-an-api-key",
        unlocks: "a higher NVD rate limit",
        note: "Keyless by default; a key lifts the request rate limit.",
    },
    {
        envVar: "SOCRATA_APP_TOKEN",
        sources: ["Socrata (state/city open-data portals)"],
        required: false,
        signupUrl: "https://evergreen.data.socrata.com/signup",
        unlocks: "higher Socrata throttling limits",
        note: "Keyless by default; a token raises the per-host throttle. Any Socrata portal's developer settings issues one.",
    },
    {
        envVar: "CENSUS_API_KEY",
        sources: ["US Census (census_business_patterns)"],
        required: true,
        signupUrl: "https://api.census.gov/data/key_signup.html",
        unlocks: "the census_business_patterns tool (there is no keyless tier — it throws without a key)",
        note: "REQUIRED: the Census economic API has no keyless access.",
    },
    {
        envVar: "FRED_API_KEY",
        sources: ["FRED (fred_search_series, fred_series_observations)"],
        required: true,
        signupUrl: "https://fred.stlouisfed.org/docs/api/api_key.html",
        unlocks: "the 2 FRED tools (there is no keyless tier — they throw without a key)",
        note: "REQUIRED: the FRED API has no keyless access.",
    },
];
/** true iff the env var is set to a non-empty (after-trim) string. */
function isSet(envVar) {
    const v = process.env[envVar];
    return typeof v === "string" && v.trim().length > 0;
}
/**
 * Report which API keys the server can use and whether each is configured.
 *
 * SECURITY: the returned object carries ONLY a `currentlySet` boolean per key —
 * the key's VALUE is NEVER read into the output. (`isSet` inspects the value to
 * compute the boolean, but the value itself never leaves this function.)
 */
export function apiKeyStatus() {
    const keys = KEY_REGISTRY.map((k) => ({
        ...k,
        currentlySet: isSet(k.envVar),
    }));
    const requiredMissing = keys
        .filter((k) => k.required && !k.currentlySet)
        .map((k) => k.envVar);
    const optionalMissing = keys
        .filter((k) => !k.required && !k.currentlySet)
        .map((k) => k.envVar);
    return { keys, requiredMissing, optionalMissing, allKeysFree: true };
}
/**
 * MINIMAL, dependency-free `.env` loader.
 *
 * Reads `${cwd||process.cwd()}/.env` if present and sets `process.env[KEY]` for
 * each `KEY=VALUE` line — but ONLY if that key is not already set, so a real
 * environment variable always wins over `.env` (standard precedence). Supports
 * `export KEY=VALUE`, `#` comments, blank lines, and surrounding single/double
 * quotes on the value. NEVER throws: a missing file returns 0 (⇒ byte-identical
 * startup), and a malformed line is skipped rather than fatal.
 *
 * @returns the number of vars newly set into process.env.
 */
export function loadDotEnv(cwd) {
    const path = join(cwd ?? process.cwd(), ".env");
    let text;
    try {
        text = readFileSync(path, "utf8");
    }
    catch {
        // Missing / unreadable .env ⇒ zero change. This is the common case and
        // MUST be a no-op so startup is byte-identical when no .env exists.
        return 0;
    }
    let loaded = 0;
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#"))
            continue;
        // Optional `export ` prefix.
        const body = line.startsWith("export ")
            ? line.slice("export ".length).trim()
            : line;
        const eq = body.indexOf("=");
        if (eq <= 0)
            continue; // no `=`, or empty key ⇒ skip (malformed).
        const key = body.slice(0, eq).trim();
        if (!key)
            continue;
        let value = body.slice(eq + 1).trim();
        // Strip a single matching pair of surrounding quotes.
        if (value.length >= 2 &&
            ((value.startsWith('"') && value.endsWith('"')) ||
                (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        }
        // Precedence: if the key is already set in the real environment, it wins —
        // we set `process.env[key]` ONLY when it is not already present.
        if (process.env[key] !== undefined)
            continue;
        process.env[key] = value;
        loaded++;
    }
    return loaded;
}
//# sourceMappingURL=keys.js.map