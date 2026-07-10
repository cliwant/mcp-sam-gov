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
export function buildMeta(partial: Partial<ResponseMeta> = {}): ResponseMeta {
  const source = partial.source ?? "unknown";
  const keylessMode = partial.keylessMode ?? true;
  const returned = partial.returned ?? 0;
  const totalAvailable =
    partial.totalAvailable === undefined ? null : partial.totalAvailable;
  const filtersApplied = partial.filtersApplied ?? [];
  const filtersDropped = partial.filtersDropped ?? [];
  const fieldsUnavailable = partial.fieldsUnavailable ?? [];
  const notes = partial.notes ? [...partial.notes] : [];
  const pagination = partial.pagination;
  const degraded = partial.degraded;

  // --- Derive truncated -------------------------------------------------
  // A known total that exceeds what we returned proves truncation.
  const totalProvesTruncation =
    totalAvailable !== null && returned < totalAvailable;
  const paginationHasMore = pagination ? pagination.hasMore : false;
  let truncated =
    partial.truncated ?? (totalProvesTruncation || paginationHasMore);
  if (totalProvesTruncation || paginationHasMore) truncated = true;

  // --- Derive complete (single source of truth = the §2.1 invariant) ----
  const degradedLoss = degraded ? degraded.failed > 0 : false;
  const derivedComplete =
    !truncated &&
    filtersDropped.length === 0 &&
    !paginationHasMore &&
    !degradedLoss &&
    !totalProvesTruncation;
  // Honor an explicit complete:false, but never let a caller claim
  // complete:true when the invariant says otherwise.
  const complete =
    partial.complete === false ? false : derivedComplete;

  // --- Invariant: filtersDropped non-empty ⇒ a note explaining it -------
  if (filtersDropped.length > 0 && notes.length === 0) {
    notes.push(
      `The following requested filters were NOT applied by the upstream and the results are unfiltered on them: ${filtersDropped.join(", ")}. Treat these results as unfiltered on those facets.`,
    );
  }

  const meta: ResponseMeta = {
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
  if (degraded) meta.degraded = degraded;
  if (pagination) meta.pagination = pagination;
  // Conditional passthrough (like enrichedCount/pagination): only surfaced when
  // the tool provides it, so existing tools' `_meta` output stays byte-identical.
  if (partial.totalIsLowerBound !== undefined)
    meta.totalIsLowerBound = partial.totalIsLowerBound;
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
export class MetaBundle<T = unknown> {
  readonly __isMetaBundle = true as const;
  constructor(
    readonly data: T,
    readonly meta: Partial<ResponseMeta>,
  ) {}
}

/** Attach a partial `_meta` to a handler's `data`. Server finalizes it. */
export function withMeta<T>(
  data: T,
  meta: Partial<ResponseMeta>,
): MetaBundle<T> {
  return new MetaBundle(data, meta);
}

/** Type guard: did the handler hand back a MetaBundle? */
export function isMetaBundle(v: unknown): v is MetaBundle {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __isMetaBundle?: unknown }).__isMetaBundle === true
  );
}
