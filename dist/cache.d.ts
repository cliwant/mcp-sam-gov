/**
 * Tiny in-memory TTL cache for hot, idempotent reads.
 *
 * Why this exists
 * ----------------
 * Some calls are extremely repeat-prone within a single agent
 * conversation: `usas_lookup_agency("VA")`, `ecfr_list_titles()`,
 * `fed_register_list_agencies()`, `usas_autocomplete_naics(...)`.
 * The agent will call them five times in a row across different
 * tool sequences. Each is a 250-700ms federal API hit.
 *
 * This cache is per-process (no Redis, no disk). Lives for the
 * lifetime of the MCP server stdio session — typically minutes
 * to hours. TTL is short enough that schema drift gets noticed
 * within an hour.
 *
 * What we cache
 * --------------
 *   - Reference lookups (agencies, NAICS hierarchy, glossary)
 *   - Autocomplete (idempotent for same query string)
 * What we DON'T cache
 * --------------------
 *   - Search results (volume changes; user expects freshness)
 *   - Per-opportunity / per-award detail (stale = wrong)
 *   - Anything with a date filter
 */
/**
 * Wrap an idempotent async producer in a TTL cache.
 *
 *   const result = await memoize("usas:agency:VA", () => lookupAgency("VA"));
 *
 * Returns the cached value if fresh; otherwise computes + stores.
 */
export declare function memoize<T>(key: string, producer: () => Promise<T>, ttlMs?: number): Promise<T>;
/** For tests / debug. */
export declare function _cacheStats(): {
    size: number;
    entries: string[];
};
//# sourceMappingURL=cache.d.ts.map