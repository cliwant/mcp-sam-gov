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
export function buildMeta(partial = {}) {
    const source = partial.source ?? "unknown";
    const keylessMode = partial.keylessMode ?? true;
    const returned = partial.returned ?? 0;
    const totalAvailable = partial.totalAvailable === undefined ? null : partial.totalAvailable;
    const filtersApplied = partial.filtersApplied ?? [];
    const filtersDropped = partial.filtersDropped ?? [];
    const fieldsUnavailable = partial.fieldsUnavailable ?? [];
    const notes = partial.notes ? [...partial.notes] : [];
    const pagination = partial.pagination;
    const degraded = partial.degraded;
    // --- Derive truncated -------------------------------------------------
    // A known total that exceeds what we returned proves truncation.
    const totalProvesTruncation = totalAvailable !== null && returned < totalAvailable;
    const paginationHasMore = pagination ? pagination.hasMore : false;
    let truncated = partial.truncated ?? (totalProvesTruncation || paginationHasMore);
    if (totalProvesTruncation || paginationHasMore)
        truncated = true;
    // --- Derive complete (single source of truth = the §2.1 invariant) ----
    const degradedLoss = degraded ? degraded.failed > 0 : false;
    const derivedComplete = !truncated &&
        filtersDropped.length === 0 &&
        !paginationHasMore &&
        !degradedLoss &&
        !totalProvesTruncation;
    // Honor an explicit complete:false, but never let a caller claim
    // complete:true when the invariant says otherwise.
    const complete = partial.complete === false ? false : derivedComplete;
    // --- Invariant: filtersDropped non-empty ⇒ a note explaining it -------
    if (filtersDropped.length > 0 && notes.length === 0) {
        notes.push(`The following requested filters were NOT applied by the upstream and the results are unfiltered on them: ${filtersDropped.join(", ")}. Treat these results as unfiltered on those facets.`);
    }
    const meta = {
        source,
        keylessMode,
        complete,
        truncated,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped,
        fieldsUnavailable,
        notes,
    };
    if (partial.enrichedCount !== undefined)
        meta.enrichedCount = partial.enrichedCount;
    if (degraded)
        meta.degraded = degraded;
    if (pagination)
        meta.pagination = pagination;
    // Conditional passthrough (like enrichedCount/pagination): only surfaced when
    // the tool provides it, so existing tools' `_meta` output stays byte-identical.
    if (partial.totalIsLowerBound !== undefined)
        meta.totalIsLowerBound = partial.totalIsLowerBound;
    // Conditional passthrough (identical shape to totalIsLowerBound above): only
    // surfaced when the tool provides it (CKAN's estimated-total path), so every
    // existing tool's `_meta` output stays byte-identical. NO new derivation logic.
    if (partial.totalIsEstimated !== undefined)
        meta.totalIsEstimated = partial.totalIsEstimated;
    return meta;
}
/**
 * Branded wrapper a tool handler returns to attach `_meta` to its payload.
 *
 * A handler may return either its raw domain object (server synthesizes a
 * minimal truthful default) OR `withMeta(data, partialMeta)`. The brand lets
 * the server distinguish "handler attached meta" from "domain object that
 * happens to have `data`/`_meta` keys" with zero ambiguity.
 */
export class MetaBundle {
    data;
    meta;
    __isMetaBundle = true;
    constructor(data, meta) {
        this.data = data;
        this.meta = meta;
    }
}
/** Attach a partial `_meta` to a handler's `data`. Server finalizes it. */
export function withMeta(data, meta) {
    return new MetaBundle(data, meta);
}
/** Type guard: did the handler hand back a MetaBundle? */
export function isMetaBundle(v) {
    return (typeof v === "object" &&
        v !== null &&
        v.__isMetaBundle === true);
}
//# sourceMappingURL=meta.js.map