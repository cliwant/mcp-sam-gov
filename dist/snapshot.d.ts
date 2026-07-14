/**
 * snapshot.ts — the snapshot-mirror READER + config (ADR-0045 Phase 2+4).
 *
 * A snapshot is an HONEST cache of PUBLIC open data: the builder
 * (`scripts/build-snapshots.mjs`) pulls high-value, slow-changing reference /
 * aggregate data from a CLEAN egress and writes a static JSON envelope
 * (`{ asOf, source, license, accessLevel, data }`) to a CDN/object store. A
 * client reads that snapshot ONLY when the live source is unreachable from its
 * egress (an edge/WAF IP-reputation block). This module is that reader; it slots
 * into the Phase-1 `throughPathChain` as a LOWER-priority `ResiliencePath`.
 *
 * ★DEFAULT-ON (resilience active out of the box): the snapshot base URL comes
 * from the env var `SAMGOV_SNAPSHOT_BASE_URL`. When it is UNSET, the reader now
 * resolves to `DEFAULT_SNAPSHOT_BASE_URL` — the public, weekly-refreshed GitHub
 * mirror — so every user gets offline fallback with zero configuration. An
 * operator can point at their own mirror (any custom URL) or DISABLE the
 * fallback entirely (pure live-only) with a disable sentinel
 * (`SAMGOV_SNAPSHOT_BASE_URL=off`); when disabled, `snapshotPath()` returns
 * `null` — the path is simply NOT added to a source's chain, so every source
 * stays single-path (live-only) and its output is byte-identical to today.
 *
 * ★POLICY BOUNDARY (ADR-0045 §"정책 경계", invariant — mirrors datasource.ts):
 *   • PUBLIC-ONLY (M3/m2): the builder writes ONLY public + redistributable data
 *     (accessLevel==="public"); the reader trusts that manifest and, defensively,
 *     REFUSES to serve any envelope whose accessLevel is present and NOT "public".
 *   • NO auth / paywall / CAPTCHA bypass, NO proxy, NO egress-hunting. If the
 *     snapshot URL is ITSELF blocked, it fails HONESTLY (no route-around) — the
 *     path throws and the chain falls to the next path or fails honestly.
 *   • PROVENANCE + FRESHNESS disclosed (P5): a served snapshot stamps
 *     `{ dataPath:"snapshot", asOf }`, which `buildMeta` turns into a staleness
 *     note + gates `complete` off. A snapshot body can NEVER be labelled live.
 */
import { type Provenance, type ResiliencePath } from "./datasource.js";
import type { ResponseMeta } from "./meta.js";
/**
 * The static snapshot envelope the builder writes and the reader parses. `data`
 * is the source-shaped payload (e.g. a Treasury `{data,meta}` envelope, a USAS
 * agency list). The metadata fields carry P5 provenance + the public-only gate.
 */
export type SnapshotEnvelope<T = unknown> = {
    /** ISO-8601 UTC instant the origin data was retrieved (P5 freshness, m3). */
    asOf: string;
    /** Human+machine label of the ORIGIN this snapshot mirrors (attribution). */
    source: string;
    /** The origin's redistribution license (public-domain / CC0 / etc.). */
    license: string;
    /** Structural public-only gate (M3): the builder only writes "public". */
    accessLevel: string;
    /** The mirrored payload, in the SOURCE's native shape. */
    data: T;
};
/** Env-driven resilience config. Read at CALL TIME so it is togglable per call. */
export type ResilienceConfig = {
    /**
     * The snapshot mirror base URL (no trailing slash) — the hosted default when
     * the env var is unset, a custom mirror when set to a URL, or `undefined` when
     * DISABLED via a sentinel (`off`) ⇒ every source stays live-only.
     */
    snapshotBaseUrl: string | undefined;
};
/**
 * The public, weekly-refreshed snapshot mirror (see .github/workflows/snapshots.yml);
 * read-only public reference data. This is the DEFAULT base URL when
 * `SAMGOV_SNAPSHOT_BASE_URL` is unset. Disable the fallback with
 * `SAMGOV_SNAPSHOT_BASE_URL=off`.
 */
export declare const DEFAULT_SNAPSHOT_BASE_URL = "https://raw.githubusercontent.com/cliwant/mcp-sam-gov/snapshots";
/**
 * Resolve `SAMGOV_SNAPSHOT_BASE_URL` at CALL TIME (never cached at module load,
 * so a test — or an operator flipping the env — takes effect immediately, and so
 * importing this module has zero config side effects). The resolution is
 * DEFAULT-ON:
 *   • env UNSET ⇒ `DEFAULT_SNAPSHOT_BASE_URL` (resilience ON by default).
 *   • env is a DISABLE sentinel — case-insensitive one of `off` / `none` /
 *     `false` / `0` / `disabled`, OR blank after trim ⇒ `undefined` (snapshot
 *     disabled = live-only, byte-identical to pre-ADR output).
 *   • any other value ⇒ that custom mirror URL, trailing slash stripped so
 *     `${base}/${key}.json` is well-formed.
 */
export declare function resolveSnapshotBaseUrl(): string | undefined;
/** The env-driven resilience config (default = hosted snapshot mirror ON). */
export declare function resilienceConfig(): ResilienceConfig;
/**
 * P5 provenance → `_meta` partial (ADR-0045 B2/M1). The SHARED threading helper
 * every opted-in adapter uses so a served body discloses its access path
 * IDENTICALLY: it returns the EMPTY object `{}` for a `live` (or absent)
 * provenance — so spreading it into a meta partial adds NO keys and the `_meta`
 * stays BYTE-IDENTICAL to pre-ADR output (the INERT bar) — and returns
 * `{ dataPath, asOf? }` ONLY for a NON-live (`snapshot`) body. This is exactly
 * the guarded, `??`-free discipline treasury.ts inlines in `treasuryMeta`,
 * factored out so the usaspending/sba reference opt-ins can't drift from it.
 * buildMeta then surfaces the fields via its `if (partial.dataPath !== undefined)`
 * passthrough (and forces `complete!==true` + `totalIsEstimated` on non-live).
 */
export declare function provenanceMeta(provenance: Provenance | undefined): Partial<ResponseMeta>;
/**
 * Build a `ResiliencePath` that reads the snapshot for `key` — or `null` when
 * the snapshot mirror is DISABLED (`SAMGOV_SNAPSHOT_BASE_URL=off`).
 *
 * When configured, the path fetches `${base}/${key}.json` via the shipped
 * `getJson` with `redirect:"error"` (off-host redirect ⇒ TypeError ⇒ honest
 * failure — no SSRF, no route-around). On success it parses the envelope and
 * returns `envelope.data` as the body; its `provenance` object is MUTATED in
 * place to carry `{ dataPath:"snapshot", asOf }` before the body resolves —
 * `throughPathChain` reads `path.provenance` AFTER awaiting `run()`, so the
 * per-fetch `asOf` is captured (mirrors the `{body,provenance}` contract).
 *
 * ★A NULL return is how the DISABLED (live-only) path stays byte-identical
 * structurally: the Treasury pilot builds
 * `[livePath, snapshotPath(key)].filter(Boolean)`, so when this returns null the
 * chain is single-entry (live only) ⇒ `throughPathChain` fast-paths ⇒
 * byte-identical to today.
 */
export declare function snapshotPath<T = unknown>(key: string): ResiliencePath<T> | null;
//# sourceMappingURL=snapshot.d.ts.map