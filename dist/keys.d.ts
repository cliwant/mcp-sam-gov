/**
 * @cliwant/mcp-sam-gov/keys — API-key discovery + `.env` auto-loading.
 *
 * Why this exists
 * ----------------
 * The server rides 31 federal sources. MOST are fully keyless. But the set of
 * *optional* keys (raise a rate limit, unlock one filter) plus the three *required*
 * keys (Census business-patterns, FRED, BEA Regional) has grown to the point where a user — or
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
 * (socrata.ts), CENSUS_API_KEY (census-economic.ts), FRED_API_KEY (fred.ts),
 * BEA_API_KEY (bea.ts). No invented keys, sources, or signup URLs.
 */
/** One registry entry describing a single API key the server can use. */
export type KeyRegistryEntry = {
    /** The exact `process.env.<NAME>` the code reads. */
    envVar: string;
    /** Human-readable source(s) this key affects. */
    sources: string[];
    /** true ⇒ the source has NO keyless tier (the tool throws without it). */
    required: boolean;
    /** Free signup URL (the user creates the account — this is their step). */
    signupUrl: string;
    /** What setting the key unlocks (higher limit / a filter / a whole tool). */
    unlocks: string;
    /** Extra honesty note (keyless fallback, precedence, scope). */
    note: string;
};
/**
 * The 8 keys the server reads — code-grounded, no inventions.
 *
 * REQUIRED (3): CENSUS_API_KEY, FRED_API_KEY, BEA_API_KEY — those sources have no
 * keyless tier, so the tool throws without them. OPTIONAL (5): everything else works
 * keyless; a key only raises a rate limit or unlocks a single filter.
 */
export declare const KEY_REGISTRY: readonly KeyRegistryEntry[];
/** Per-key status: the registry entry + a `currentlySet` boolean. NEVER the value. */
export type KeyStatus = KeyRegistryEntry & {
    currentlySet: boolean;
};
/** The `apiKeyStatus()` result shape. */
export type ApiKeyStatusResult = {
    keys: KeyStatus[];
    /** envVars of REQUIRED keys not currently set (empty ⇒ all required keys present). */
    requiredMissing: string[];
    /** envVars of OPTIONAL keys not currently set. */
    optionalMissing: string[];
    /** Every key here is free to obtain. */
    allKeysFree: boolean;
};
/**
 * Report which API keys the server can use and whether each is configured.
 *
 * SECURITY: the returned object carries ONLY a `currentlySet` boolean per key —
 * the key's VALUE is NEVER read into the output. (`isSet` inspects the value to
 * compute the boolean, but the value itself never leaves this function.)
 */
export declare function apiKeyStatus(): ApiKeyStatusResult;
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
export declare function loadDotEnv(cwd?: string): number;
//# sourceMappingURL=keys.d.ts.map