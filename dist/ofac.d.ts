/**
 * @cliwant/mcp-sam-gov/ofac — OFAC denied-party sanctions screening (keyless).
 *
 * Why this exists (ADR-0034)
 * --------------------------
 * OFAC denied-party screening is legally REQUIRED on every federal
 * transaction/award (31 CFR ch. V; strict-liability civil penalties). The
 * server already wires SAM exclusions (`sam_check_exclusions`), but SAM
 * exclusions do NOT cover OFAC/BIS sanctions — a different list with a different
 * legal basis. This module closes that gap with ONE screening tool
 * (`ofac_screen_entity`) over OFAC's keyless bulk-download lists:
 *   - SDN.CSV        (primary Specially-Designated-Nationals names)
 *   - ALT.CSV        (SDN AKA / alternate names, joined to SDN by ent_num)
 *   - CONS_PRIM.CSV  (Consolidated non-SDN program primary names)
 *   - CONS_ALT.CSV   (Consolidated AKA names)
 *
 * ★ THE load-bearing SAFETY invariant — NEVER FAKE A "CLEAR"
 * ----------------------------------------------------------
 * A FALSE "no match / clear" could authorize an ILLEGAL transaction. Therefore:
 *   - `result` is `"potential_matches" | "no_name_match"` — NEVER "clear"
 *     (screening ≠ legal clearance; mirrors integrity.ts's never-"clear" gate).
 *   - A `no_name_match` is reachable ONLY when every REQUIRED list loaded,
 *     parsed, and passed its plausibility floor AND zero name matches at ANY
 *     quality were found. ANY fetch failure / SSRF reject / parse drift /
 *     floor-fail / empty-final-host THROWS a classified error — it is NEVER
 *     rendered as `no_name_match`.
 *
 * Doctrine reuse (do NOT edit those modules):
 *   - integrity.ts   — the normalized-name-match gate + never-"clear".
 *   - attachments.ts — the redirect-final-host SSRF revalidation + size guard.
 *   - gsa-csv.ts      — the exported RFC-4180 `parseRecordFields` (the private
 *                      record-assembler is REPLICATED here per M6; NO gsa-csv edit).
 *   - datasource.ts   — `throughGate` self-throttle + `driftError`.
 *   - coerce.ts        convention (`-0-`/""/"null" ⇒ null, never 0/"").
 *
 * SSRF (M4/M5): the legacy treasury.gov paths 2-hop-redirect
 * (treasury.gov → sanctionslistservice.ofac.treas.gov → GovCloud S3). We follow
 * the redirect (default cap) and fail-closed-allowlist ONLY the FINAL host — the
 * region-pinned GovCloud bucket. A commercial-partition squat of the same bucket
 * name (`…s3.amazonaws.com`) is REJECTED (no `us-gov` marker); an empty/hidden
 * final host is UNCONDITIONALLY rejected (OFAC always redirects — no
 * `!res.redirected` escape hatch). On any host reject we THROW `invalid_input`
 * and NEVER read the body.
 */
import { type MetaBundle } from "./meta.js";
/** The 4 keyless OFAC bulk-download lists (legacy treasury.gov paths). */
export declare const OFAC_URLS: {
    readonly sdn: "https://www.treasury.gov/ofac/downloads/sdn.csv";
    readonly alt: "https://www.treasury.gov/ofac/downloads/alt.csv";
    readonly cons_prim: "https://www.treasury.gov/ofac/downloads/consolidated/cons_prim.csv";
    readonly cons_alt: "https://www.treasury.gov/ofac/downloads/consolidated/cons_alt.csv";
};
export type OfacListKey = keyof typeof OFAC_URLS;
/**
 * ★ M4 — the ONE allowed final host: the region-pinned OFAC GovCloud bucket.
 * The bucket NAME (`wc2h-sls-prod-public-published`) is registrable in the
 * COMMERCIAL AWS partition, so a bucket-prefix + `.amazonaws.com` check ALONE
 * would admit a `…s3.amazonaws.com` squat serving an attacker CSV (that omits
 * the target ⇒ false CLEAR). We therefore ALSO require the `.s3.us-gov-`
 * GovCloud region marker.
 */
export declare const OFAC_S3_HOST = "wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com";
/** Fail-closed final-host allowlist (M4). Empty host ⇒ false (M5, in caller). */
export declare function isOfacS3Host(host: string): boolean;
/** Per-list plausibility floors (M1) — two orders of magnitude apart. */
export declare const FLOORS: Record<OfacListKey, number>;
/**
 * Rides in `_meta.notes` on EVERY response (potential_matches AND no_name_match).
 * Kept verbatim so the fault suite can assert it. A screen is NOT a determination.
 */
export declare const OFAC_NOT_DETERMINATION_NOTE = "This screens OFAC's published SDN + Consolidated lists as-of the snapshot date below; it is NOT OFAC's official Sanctions List Search, NOT a compliance/blocking determination, and NOT legal advice. A potential_match requires human adjudication against OFAC's Sanctions List Search + counsel; a no_name_match means no name match was found IN THIS SNAPSHOT \u2014 it is NOT a clearance and does NOT prove a party is not sanctioned (transliterations, variants, and typos can miss a real hit).";
/**
 * Normalize a name for matching: uppercase → strip punctuation → drop trailing
 * entity suffixes (LLC/INC/CORP/…) → collapse whitespace. Byte-for-byte the
 * integrity.ts doctrine, applied to the query AND every primary + AKA name.
 */
export declare function normName(s: string | null | undefined): string;
export type MatchQuality = "exact" | "strong" | "weak";
/**
 * Grade the match between a normalized query and a normalized index name.
 *   - exact:  the normalized strings are equal.
 *   - strong: one is a whole-token superset of the other, OR one normalized
 *             string contains the other (word-order / suffix noise).
 *   - weak:   ≥1 shared token of length ≥ 3 (the transliteration / common-name
 *             false-positive zone — a REVIEW candidate, never an assertion).
 *   - null:   no relationship.
 */
export declare function classifyMatch(queryNorm: string, entryNorm: string): MatchQuality | null;
export type OfacEntityType = "individual" | "entity" | "vessel" | "aircraft" | null;
/** A parsed a.k.a./f.k.a./n.k.a. alias mined from a primary row's Remarks. */
type RemarksAka = {
    name: string;
    akaType: "aka" | "fka" | "nka";
};
/** A parsed primary (SDN / CONS_PRIM) record. */
export type PrimaryRecord = {
    entNum: string;
    name: string;
    normName: string;
    /** Raw SDN_Type ("individual"/"vessel"/"aircraft"/entity/null). */
    type: OfacEntityType;
    /** true when `type` was INFERRED "entity" from a blank (`-0-`) type cell. */
    typeInferred: boolean;
    programs: string[];
    title: string | null;
    remarks: string | null;
    list: "SDN" | "Consolidated";
    remarksAkas: RemarksAka[];
};
/** A parsed alt (ALT / CONS_ALT) record. */
export type AltRecord = {
    entNum: string;
    altNum: string | null;
    akaType: "aka" | "fka" | "nka" | null;
    name: string;
    remarks: string | null;
    list: "SDN" | "Consolidated";
};
/**
 * Parse a primary (SDN / CONS_PRIM) list body into records. Every genuine
 * content row MUST have exactly 12 columns — a short/drifted row THROWS
 * `schema_drift` (a truncated download or a drifted file must NEVER read as a
 * near-empty "clear"). HEADERLESS (S1): every record is indexed (no header-skip).
 */
export declare function parsePrimaryList(body: string, list: "SDN" | "Consolidated", label: string): PrimaryRecord[];
/**
 * Parse an alt (ALT / CONS_ALT) list body into records. Every genuine content
 * row MUST have exactly 5 columns — a drifted row THROWS `schema_drift`.
 * HEADERLESS (S1).
 */
export declare function parseAltList(body: string, list: "SDN" | "Consolidated", label: string): AltRecord[];
export type MatchedVia = "primary" | "aka(alt)" | "aka(remarks)";
/** One screenable name entry (a primary name OR an alias) → its base party. */
export type NameEntry = {
    name: string;
    normName: string;
    matchedVia: MatchedVia;
    akaType: "aka" | "fka" | "nka" | null;
    base: PrimaryRecord;
};
/** Build the primary + AKA name entries for ONE scope (primaries + its alts). */
export declare function buildScopeEntries(primaries: PrimaryRecord[], alts: AltRecord[]): NameEntry[];
export type ScreenMatch = {
    name: string;
    matchedVia: MatchedVia;
    akaType: "aka" | "fka" | "nka" | null;
    matchQuality: MatchQuality;
    list: "SDN" | "Consolidated";
    programs: string[];
    type: OfacEntityType;
    entNum: string | null;
    title: string | null;
    remarks: string | null;
    typeInferred: boolean;
    ofacSearchUrl: string;
};
export type ScreenArgs = {
    name: string;
    type?: OfacEntityType;
    program?: string;
    minMatchQuality?: MatchQuality;
    limit?: number;
};
export type ScreenComputation = {
    result: "potential_matches" | "no_name_match";
    matchCount: number;
    returnedCount: number;
    suppressedCount: number;
    highestSuppressedQuality: MatchQuality | null;
    matches: ScreenMatch[];
    anyTypeInferred: boolean;
};
/**
 * ★ M2 — existence-first screening over a prebuilt name index.
 *
 * Matches are computed at the LOWEST (weak) quality FIRST, so `result` is
 * `potential_matches` whenever ≥1 name match exists at ANY quality — INDEPENDENT
 * of `minMatchQuality` and of the `type`/`program` post-filters. Those only trim
 * the RETURNED `matches[]`; when they suppress a match, `suppressedCount` and the
 * highest suppressed quality are disclosed. `result` is NEVER `no_name_match`
 * while a name match exists.
 */
export declare function computeScreen(entries: NameEntry[], args: ScreenArgs): ScreenComputation;
/** TEST-ONLY: drop the per-list caches so a fault case can re-point the mock. */
export declare function _resetOfacCacheForTests(): void;
export type ListArg = "sdn" | "consolidated" | "all";
export type OfacScreenArgs = {
    name: string;
    type?: string;
    program?: string;
    list?: string;
    minMatchQuality?: string;
    limit?: number;
};
/**
 * ★ `ofac_screen_entity` — keyless OFAC denied-party name screening.
 *
 * NEVER FAKE A CLEAR: every fetch failure / SSRF reject / parse drift /
 * floor-fail THROWS; a `no_name_match` is reached ONLY when all required lists
 * loaded + passed floors AND zero matches at any quality. `result` is never
 * "clear".
 */
export declare function screenEntity(args: OfacScreenArgs): Promise<MetaBundle<unknown>>;
export {};
//# sourceMappingURL=ofac.d.ts.map