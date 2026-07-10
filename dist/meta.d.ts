/**
 * @cliwant/mcp-sam-gov/meta — the `_meta` completeness/provenance convention.
 *
 * Why this exists
 * ----------------
 * These tools' outputs are consumed by an AI, not a human who can eyeball
 * a table. For an AI consumer, silently-misleading data is strictly worse
 * than missing data: the AI cannot tell a filtered-but-blank field from a
 * genuinely-empty one, a hard cap from a complete list, or a swallowed
 * error from a real zero — and will state the wrong answer confidently.
 *
 * Every tool's success payload therefore gains a sibling `_meta` object.
 * `data` is UNCHANGED (backward compat): the envelope becomes
 * `{ ok, data, _meta }` where existing consumers reading `ok`/`data.*`
 * are 100% unaffected.
 *
 * See docs/research/02-truthful-outputs-spec.md §2 for the normative spec.
 */
/** Two-phase (enrich) tools: rows lost to failed per-record enrichment. */
export type MetaDegraded = {
    attempted: number;
    succeeded: number;
    failed: number;
};
/** Offset-based pagination descriptor for list/search/aggregate tools. */
export type MetaPagination = {
    offset: number;
    limit: number;
    nextOffset: number | null;
    hasMore: boolean;
};
/**
 * The normative `_meta` shape (spec §2.1). Rides alongside `data` in the
 * success envelope so the AI can branch on completeness/provenance
 * deterministically instead of guessing from null fields.
 */
export type ResponseMeta = {
    /** Human+machine label of the upstream + layer that served THIS response. */
    source: string;
    /** SAM tools: true when no SAM_GOV_API_KEY. Non-SAM tools: always true. */
    keylessMode: boolean;
    /** true iff this response contains the ENTIRE result set for the query. */
    complete: boolean;
    /** true iff a hard cap / top-N limited the rows. */
    truncated: boolean;
    /** Number of primary records in `data`. */
    returned: number;
    /** Upstream's total match count; null when the endpoint doesn't report it. */
    totalAvailable: number | null;
    /**
     * Present (and true) when `totalAvailable` is a KNOWN LOWER BOUND rather than
     * an exact count — i.e. the upstream reported the total as "≥ N" (e.g. SEC
     * EDGAR full-text search returns `hits.total.relation: "gte"` with the value
     * pinned at 10000). The true total is UNKNOWN and ≥ `totalAvailable`. Absent
     * on endpoints that report an exact total (do NOT read absence as `false`
     * meaning "exact" for tools that never set it — it is simply not applicable).
     */
    totalIsLowerBound?: boolean;
    /** Request filters the upstream verifiably honored. */
    filtersApplied: string[];
    /** Request filters sent but NOT honored (results are unfiltered on these). */
    filtersDropped: string[];
    /** Fields null/absent BY LIMITATION (keyless/endpoint), not "no data". */
    fieldsUnavailable: string[];
    /** Two-phase tools only: rows for which per-record detail was fetched. */
    enrichedCount?: number;
    /** Two-phase tools: enrichment accounting (see MetaDegraded). */
    degraded?: MetaDegraded;
    /** Present on list/search/aggregate tools. */
    pagination?: MetaPagination;
    /** Short, AI-actionable caveats (natural language). */
    notes: string[];
};
/**
 * Build a fully-populated, invariant-consistent ResponseMeta from a partial.
 *
 * Safe defaults (spec §2.1): a tool that supplies nothing gets a truthful,
 * "single-record / known-complete" meta (`complete:true, truncated:false`).
 *
 * The server (or the caller) hands over whatever it knows; this helper fills
 * the rest and then ENFORCES the §2.1 invariants so the flags the AI trusts
 * are internally consistent:
 *   - `complete === true`  ⟺  NOT truncated AND filtersDropped empty AND
 *     (no pagination OR hasMore===false) AND (no degraded OR failed===0).
 *   - If totalAvailable is known and returned < totalAvailable ⇒
 *     complete:false, truncated:true.
 *   - filtersDropped non-empty ⇒ at least one note is present.
 */
export declare function buildMeta(partial?: Partial<ResponseMeta>): ResponseMeta;
/**
 * Branded wrapper a tool handler returns to attach `_meta` to its payload.
 *
 * A handler may return either its raw domain object (server synthesizes a
 * minimal truthful default) OR `withMeta(data, partialMeta)`. The brand lets
 * the server distinguish "handler attached meta" from "domain object that
 * happens to have `data`/`_meta` keys" with zero ambiguity.
 */
export declare class MetaBundle<T = unknown> {
    readonly data: T;
    readonly meta: Partial<ResponseMeta>;
    readonly __isMetaBundle: true;
    constructor(data: T, meta: Partial<ResponseMeta>);
}
/** Attach a partial `_meta` to a handler's `data`. Server finalizes it. */
export declare function withMeta<T>(data: T, meta: Partial<ResponseMeta>): MetaBundle<T>;
/** Type guard: did the handler hand back a MetaBundle? */
export declare function isMetaBundle(v: unknown): v is MetaBundle;
//# sourceMappingURL=meta.d.ts.map