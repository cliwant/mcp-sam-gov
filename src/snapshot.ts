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
 * ★INERT BY DEFAULT (the pass/fail bar): the snapshot base URL comes from the
 * env var `SAMGOV_SNAPSHOT_BASE_URL`, which is UNSET by default. When unset,
 * `snapshotPath()` returns `null` — the path is simply NOT added to a source's
 * chain, so every source stays single-path (live-only) and its output is
 * byte-identical to today. A snapshot fallback exists ONLY when an operator
 * explicitly configures a base URL.
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

import { getJson, driftError, type Provenance, type ResiliencePath } from "./datasource.js";

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
   * The snapshot mirror base URL (no trailing slash), or `undefined` when the
   * env var is unset/blank ⇒ snapshot DISABLED ⇒ every source stays live-only.
   */
  snapshotBaseUrl: string | undefined;
};

/**
 * Resolve `SAMGOV_SNAPSHOT_BASE_URL` at CALL TIME (never cached at module load,
 * so a test — or an operator flipping the env — takes effect immediately, and so
 * importing this module has zero config side effects). Returns `undefined` when
 * the var is unset or blank (the INERT default: snapshot disabled). A trailing
 * slash is stripped so `${base}/${key}.json` is well-formed.
 */
export function resolveSnapshotBaseUrl(): string | undefined {
  const raw = process.env.SAMGOV_SNAPSHOT_BASE_URL;
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The env-driven resilience config (default = snapshot disabled). */
export function resilienceConfig(): ResilienceConfig {
  return { snapshotBaseUrl: resolveSnapshotBaseUrl() };
}

/** A snapshot key is an internal identifier — restrict to a safe charset so it
 *  can never inject a path segment / traversal into the fetch URL. */
const SNAPSHOT_KEY_RE = /^[a-z0-9_]+$/;

/**
 * Parse + validate a fetched snapshot envelope. Throws `schema_drift` (a
 * NON-retryable, NON-hard error — it does NOT trip the breaker and does NOT
 * count as an outage) when the envelope is malformed or, per the public-only
 * policy gate, when `accessLevel` is present and not "public". `asOf` is required
 * (P5: a non-live body MUST disclose its freshness).
 */
function parseSnapshotEnvelope<T>(
  raw: unknown,
  label: string,
): { data: T; asOf: string } {
  if (typeof raw !== "object" || raw === null) {
    throw driftError(label, `Snapshot ${label} is not a JSON object.`);
  }
  const env = raw as Partial<SnapshotEnvelope<T>>;
  if (typeof env.asOf !== "string" || env.asOf.length === 0) {
    throw driftError(
      label,
      `Snapshot ${label} is missing a string 'asOf' (P5 freshness is mandatory for a non-live body).`,
    );
  }
  if (!("data" in env)) {
    throw driftError(label, `Snapshot ${label} is missing 'data'.`);
  }
  // ★Public-only gate (M3, defense-in-depth): the reader trusts the builder's
  // manifest but REFUSES a non-public envelope rather than serve restricted data.
  if (env.accessLevel !== undefined && env.accessLevel !== "public") {
    throw driftError(
      label,
      `Snapshot ${label} accessLevel is ${JSON.stringify(env.accessLevel)}, not "public" — refusing to serve (public-only policy).`,
    );
  }
  return { data: env.data as T, asOf: env.asOf };
}

/**
 * Build a `ResiliencePath` that reads the snapshot for `key` — or `null` when
 * the snapshot mirror is not configured (the INERT default).
 *
 * When configured, the path fetches `${base}/${key}.json` via the shipped
 * `getJson` with `redirect:"error"` (off-host redirect ⇒ TypeError ⇒ honest
 * failure — no SSRF, no route-around). On success it parses the envelope and
 * returns `envelope.data` as the body; its `provenance` object is MUTATED in
 * place to carry `{ dataPath:"snapshot", asOf }` before the body resolves —
 * `throughPathChain` reads `path.provenance` AFTER awaiting `run()`, so the
 * per-fetch `asOf` is captured (mirrors the `{body,provenance}` contract).
 *
 * ★A NULL return is how INERTness is achieved structurally: the Treasury pilot
 * builds `[livePath, snapshotPath(key)].filter(Boolean)`, so when this returns
 * null the chain is single-entry (live only) ⇒ `throughPathChain` fast-paths ⇒
 * byte-identical to today.
 */
export function snapshotPath<T = unknown>(
  key: string,
): ResiliencePath<T> | null {
  const base = resolveSnapshotBaseUrl();
  if (base === undefined) return null; // INERT: snapshot disabled ⇒ no path.
  if (!SNAPSHOT_KEY_RE.test(key)) {
    // A bad key is a programming error, not a runtime data condition — refuse to
    // construct a path rather than build a URL that could traverse.
    throw driftError(
      `snapshot:${key}`,
      `Invalid snapshot key ${JSON.stringify(key)} (must match ${SNAPSHOT_KEY_RE}).`,
    );
  }
  const baseUrl = new URL(base);
  const url = `${base}/${key}.json`;
  const host = baseUrl.host;
  const label = `snapshot:${host}`;
  // The provenance object is shared by reference with what run() mutates; the
  // chain reads it only after run() resolves, so asOf is populated by then.
  const provenance: Provenance = { dataPath: "snapshot" };
  return {
    host,
    provenance,
    run: async () => {
      // Host-assert: the fetch URL MUST stay on the configured base's host
      // (defense-in-depth alongside redirect:"error").
      if (new URL(url).host !== host) {
        throw driftError(label, `Snapshot URL host drifted from ${host}.`);
      }
      const raw = await getJson<unknown>(url, { label, redirect: "error" });
      const { data, asOf } = parseSnapshotEnvelope<T>(raw, label);
      provenance.asOf = asOf;
      return data;
    },
  };
}
