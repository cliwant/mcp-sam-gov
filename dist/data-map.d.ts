/**
 * State & local data map — single source of truth.
 *
 * These entries are exported for:
 *   (a) the MCP resource samgov://data-map/state-local (resources/read)
 *   (b) consistency tests (SKILL.md table must agree on domain/id/rows)
 *
 * Keep verified row counts and notes current here only; SKILL.md table and
 * the resource content are generated from this array.
 */
export type DataMapTool = "socrata_query" | "ckan_query" | "tableau_view_csv" | "open_checkbook_search";
export interface DataMapEntry {
    /** Two-letter state abbreviation for grouping */
    state: string;
    /** Human-readable jurisdiction name */
    jurisdiction: string;
    /** Short description of what the dataset contains */
    dataLabel: string;
    /** Tool to call */
    tool: DataMapTool;
    /** Key args to pass — human-readable form for doc */
    keyArgs: string;
    /** Verified approximate row count (null = not precisely known) */
    rows: number | null;
    /** Approximate flag — when true prefix rows with '~' */
    approximate: boolean;
    /** What this dataset is NOT (common agent error) */
    notNote: string;
    /** Extra notes (optional) */
    extra?: string;
}
/**
 * Verified 2026-09-21 — all keyless.
 */
export declare const DATA_MAP_ENTRIES: DataMapEntry[];
/**
 * Render the state-level entries as a Markdown table.
 * Matches the format in SKILL.md §State & local data map.
 */
export declare function renderStateTableMarkdown(): string;
/** Full resource content: header + state table */
export declare function renderDataMapMarkdown(): string;
//# sourceMappingURL=data-map.d.ts.map