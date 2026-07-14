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
  /**
   * The row offset of this page. `number` for offset-paginated tools (unchanged —
   * every existing tool sets an integer). ADR-0010: widened to `number | null` for
   * OPAQUE-CURSOR tools (GovInfo), where no meaningful numeric offset exists — those
   * tools set `offset:null` (the honest "not a numeric offset"; continuation is via
   * `_meta.nextCursor`, not a numeric `nextOffset`). Additive: no existing tool changes.
   */
  offset: number | null;
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
  /**
   * Present (and true) when `totalAvailable` (or, for CKAN, the value disclosed
   * in `notes`) is an upstream STATISTICAL ESTIMATE rather than an exact count —
   * i.e. the source reported the total as an approximation that may be ABOVE OR
   * BELOW the true count (CKAN `datastore_search` returns `total_was_estimated:
   * true` for a PostgreSQL `reltuples`-style estimate, live-verified to overshoot
   * — so it is NOT a lower bound, unlike `totalIsLowerBound`). CKAN sets this on
   * the estimated path alongside `totalAvailable:null` (the estimate never drives
   * pagination — ADR-0006 B1) + a disclosing note carrying the estimate value.
   * Absent on endpoints that report an exact total (do NOT read absence as
   * `false` meaning "exact" for tools that never set it — it is not applicable).
   */
  totalIsEstimated?: boolean;
  /**
   * Present when this response comes from an OPAQUE-CURSOR-paginated source
   * (ADR-0010 — GovInfo's `offsetMark`): the opaque continuation token to pass back
   * to fetch the NEXT page (GovInfo: as the `pageMark` argument), or `null` on the
   * last page (no further cursor). It is a source-minted token, NOT derived from any
   * secret and NEVER the raw upstream `nextPage` URL (which embeds pageSize + the
   * api_key). Cursor tools set `nextOffset:null`/`offset:null` (a numeric offset is
   * meaningless for a cursor) and use THIS as the sole continuation surface. Absent
   * on offset-paginated tools (do NOT read absence as "no more" for those). Added as
   * a conditional passthrough exactly like totalIsLowerBound/totalIsEstimated —
   * only surfaced when the tool provides it, so existing tools' `_meta` stays
   * byte-identical and the tools/list snapshot is unaffected (it is a runtime `_meta`
   * field, not part of any tool's input schema).
   */
  nextCursor?: string | null;
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
  /**
   * P5 PROVENANCE (ADR-0045 B2/M1). The access path that served THIS response:
   * `"live"` (the current, and in Phase 1 the ONLY, path) or `"snapshot"` (a
   * self-hosted cache served when the live upstream was unreachable). Set by the
   * resilience port's provenance-returning primitive, then threaded by the
   * adapter ONLY when NON-live — so a live response OMITS this field entirely and
   * stays byte-identical to pre-P5 output. Surfaced via the guarded
   * `if (partial.dataPath !== undefined)` passthrough below (NO `??` default).
   * Absent ⇒ live; do NOT read absence as any other value. Freshness enum, not a
   * topology label (M2): an independent host serving live data is still `"live"`.
   */
  dataPath?: "live" | "snapshot";
  /**
   * P5 FRESHNESS (ADR-0045 m3). ISO-8601 UTC timestamp of when a NON-live
   * (`snapshot`) body was retrieved from the origin — the as-of instant for
   * deterministic cross-tool freshness comparison. Present ONLY alongside a
   * non-live `dataPath`; absent on a live response (byte-identical). When a
   * snapshot carries a `totalAvailable`, it is qualified as an as-of figure via
   * the existing `totalIsEstimated` flag (m1 forbids a dedicated `totalAsOf`
   * field — the only NEW P5 fields are `dataPath` and `asOf`).
   */
  asOf?: string;
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

  // --- P5 provenance (ADR-0045 B2/M1) -----------------------------------
  // A NON-live response (a snapshot served because the live upstream was
  // unreachable) is honesty-qualified below. For a live/absent dataPath this
  // whole strand is INERT — `nonLiveProvenance` is false, so `complete`, the
  // notes[], and totalIsEstimated are all derived EXACTLY as before P5 (Phase 1:
  // no adapter threads a dataPath ⇒ byte-identical output on every one of the
  // 110 tools).
  const nonLiveProvenance =
    partial.dataPath !== undefined && partial.dataPath !== "live";

  // --- Derive complete (single source of truth = the §2.1 invariant) ----
  const degradedLoss = degraded ? degraded.failed > 0 : false;
  const derivedComplete =
    !truncated &&
    filtersDropped.length === 0 &&
    !paginationHasMore &&
    !degradedLoss &&
    !totalProvesTruncation &&
    // M1a: `complete` is defined against the LIVE result set (:53), so a snapshot
    // can NEVER claim complete:true — gate the derivation behind a live/absent
    // dataPath. (Inert for live: `!false` === true, no change.)
    !nonLiveProvenance;
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

  // --- P5 (ADR-0045 M1c/m1): staleness note on a non-live response ------
  // Push into the EXISTING notes[] (m1 killed the separate `stalenessNote`
  // field). Inert for live/absent dataPath. Names the as-of instant when known.
  if (nonLiveProvenance) {
    const asOfPhrase = partial.asOf ? ` (as of ${partial.asOf})` : "";
    notes.push(
      `Live upstream was unreachable — this response is served from a ${partial.dataPath} snapshot${asOfPhrase}. Freshness is NOT guaranteed; treat completeness and totals as of the snapshot time, not live.`,
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
  // Conditional passthrough (identical shape to totalIsLowerBound above): only
  // surfaced when the tool provides it (CKAN's estimated-total path), so every
  // existing tool's `_meta` output stays byte-identical. NO new derivation logic.
  if (partial.totalIsEstimated !== undefined)
    meta.totalIsEstimated = partial.totalIsEstimated;
  // Conditional passthrough (IDENTICAL shape to totalIsLowerBound/totalIsEstimated
  // above): only surfaced when the tool provides it (GovInfo's opaque-cursor path),
  // so every existing tool's `_meta` output stays byte-identical. NO new derivation
  // logic — the value (the offsetMark token, or null on the last page) is set by the
  // cursor tool and passed through verbatim.
  if (partial.nextCursor !== undefined) meta.nextCursor = partial.nextCursor;
  // P5 provenance passthrough (ADR-0045 B2) — IDENTICAL guarded idiom to
  // totalIsLowerBound/nextCursor above: surfaced ONLY when the adapter provides
  // it, so every existing (live, dataPath-absent) tool `_meta` stays
  // byte-identical. NO `??` default. In Phase 1 no adapter threads these ⇒ inert.
  if (partial.dataPath !== undefined) meta.dataPath = partial.dataPath;
  if (partial.asOf !== undefined) meta.asOf = partial.asOf;
  // M1b: a snapshot's totalAvailable is an as-of figure, NOT a live exact total —
  // qualify it via the EXISTING totalIsEstimated flag (m1 forbids a new
  // totalAsOf field) so an AI never reads it as a live count. Only when a total
  // is actually present. Inert for live (nonLiveProvenance false).
  if (nonLiveProvenance && totalAvailable !== null) meta.totalIsEstimated = true;
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
