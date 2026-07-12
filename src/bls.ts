/**
 * BLS Public Data API v1/v2 — US labor-economics & price-index time series
 * (keyless v1 default; an OPTIONAL free BLS_API_KEY lifts to v2). ADR-0032.
 *
 * A NEW capability axis for the server — the PRICING / ESCALATION layer: CPI-U &
 * ECI drive federal contract escalation / economic-price-adjustment (EPA) clauses;
 * PPI benchmarks materials pricing; CES employment/wages give labor-rate context
 * (next to GSA CALC + SAM wage determinations). Consumer of the R2 `getJson`/
 * `throughGate` port; the SECOND POST-batch consumer (after NIH RePORTER).
 *
 * ON-DOMAIN HONESTY: these are PUBLIC AGGREGATE STATISTICS (no PII). The tool
 * LABELS units per series (an ECI "…A" 3.4 is a 12-month PERCENT CHANGE, not an
 * index level) and NEVER fabricates a value — the BLS "-" unavailable marker maps
 * to null (NEVER 0) with the footnote reason surfaced, so a data gap (e.g. the
 * 2025 lapse-in-appropriations) is DISCLOSED, never a silent null and never a 0.
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (method:"POST" + body + redirect:"error"), `driftError`, `throughGate`,
 * `num`·`str` (coerce.ts, null-never-0), `withMeta`·`buildMeta`, and MIRRORS the
 * fixed-host SSRF idiom from NIH/FDIC + the body-carried optional-key discipline
 * of datagovKey.ts (but the key rides in the POST BODY, never a header/URL/log).
 *
 * ★ SSRF GUARD (policy① — the smallest surface): host+path are compile-time
 *   CONSTANTS; NO caller value touches them. seriesids ride in the MODULE-BUILT
 *   POST body (JSON.stringify'd typed payload — no raw passthrough), so a caller
 *   value has NO host-alteration surface. Each raw seriesId is charclass-validated
 *   `^[A-Z0-9]{1,20}$` (rejects `../`, encoded traversal, `@host`, `;`, a trailing
 *   `\n`). Curated keys resolve through the FROZEN catalog map (never user text). A
 *   post-construction hostname/protocol assertion + `redirect:"error"` lock it.
 *
 * ★ THE HONESTY FRONTIER (P3): each observation's `value` is a STRING → `num()`.
 *   `num("-")` / any non-numeric → **null NEVER 0**; a genuine `"0"` → 0. The row
 *   carries `valueUnavailable` (true iff the raw value was present but unparseable)
 *   + its `footnotes[]`, and the footnote text is LIFTED into `_meta.notes` so the
 *   absence is disclosed. `value` is ALWAYS the parsed number, never the raw string.
 *
 * ★ STATUS GATE (P2): `status !== "REQUEST_SUCCEEDED"` THROWS (never a fake-empty):
 *   `REQUEST_NOT_PROCESSED` (the v1 daily-limit case) → `rate_limited` (retryable)
 *   with the tier disclosure; `REQUEST_FAILED`/other → `upstream_unavailable` (or
 *   `invalid_input` when `message[]` reads like a bad request). A non-JSON 200, or
 *   a SUCCESS body missing `Results.series` (non-array), → `driftError`.
 *
 * ★ OPTIONAL BLS_API_KEY (v2) — body-carried, NEVER leaked: read from env
 *   (trimmed; empty ⇒ keyless v1). When present → the `…/v2/…` path + a
 *   `registrationkey` field in the POST BODY, and NOWHERE else (never the URL, a
 *   header, the label, the `source`, `_meta`, or a log). When keyless,
 *   `registrationkey` is ABSENT from the body. Only the MODE is ever disclosed.
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError, throughGate } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` (bls.num === coerce.num — a num regression fails together across sources).
export { num };

// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
const BLS_HOST = "api.bls.gov";
const BLS_PATH_V1 = "/publicAPI/v1/timeseries/data/";
const BLS_PATH_V2 = "/publicAPI/v2/timeseries/data/";
// The self-throttle gate key + the min interval (one host = one shared budget —
// the FDIC pattern; the gate serializes bursts but CANNOT enforce the per-IP/day
// cap, so the honest surface for the daily limit is the disclosure + the throw).
const BLS_GATE_KEY = "bls";
const BLS_MIN_INTERVAL_MS = 250;

// ─── The FROZEN curated catalog (ADR §catalog) ────────────────────
// The SINGLE source of truth for: the `series` enum's value list, the resolver
// (key → seriesId), and the per-series `units` label. ALL seriesIDs live-verified
// (ADR §Context 2026-07-13). The ECI "…A" series carry "12-mo % change" units
// (a consumer misreads 3.4 as an index level otherwise).
export const BLS_SERIES_KEYS = [
  "cpi_u_all",
  "cpi_u_core",
  "ppi_final_demand",
  "eci_total_comp",
  "eci_wages",
  "unemployment_rate",
  "labor_force_participation",
  "employment_total_nonfarm",
  "avg_hourly_earnings",
] as const;

export type BlsSeriesKey = (typeof BLS_SERIES_KEYS)[number];

export type BlsCatalogEntry = {
  seriesId: string;
  meaning: string;
  units: string;
};

export const BLS_CATALOG: Record<BlsSeriesKey, BlsCatalogEntry> = {
  cpi_u_all: {
    seriesId: "CUUR0000SA0",
    meaning: "CPI-U, all items, US city avg (NSA)",
    units: "index 1982-84=100",
  },
  cpi_u_core: {
    seriesId: "CUUR0000SA0L1E",
    meaning: "CPI-U, all items less food & energy — core (NSA)",
    units: "index 1982-84=100",
  },
  ppi_final_demand: {
    seriesId: "WPUFD4",
    meaning: "PPI, final demand (NSA)",
    units: "index Nov-2009=100",
  },
  eci_total_comp: {
    seriesId: "CIU1010000000000A",
    meaning: "ECI, total compensation, all civilian",
    units: "12-mo % change",
  },
  eci_wages: {
    seriesId: "CIU2020000000000A",
    meaning: "ECI, wages & salaries, all civilian",
    units: "12-mo % change",
  },
  unemployment_rate: {
    seriesId: "LNS14000000",
    meaning: "Unemployment rate (SA)",
    units: "percent",
  },
  labor_force_participation: {
    seriesId: "LNS11300000",
    meaning: "Labor force participation rate (SA)",
    units: "percent",
  },
  employment_total_nonfarm: {
    seriesId: "CES0000000001",
    meaning: "Total nonfarm employment (SA)",
    units: "thousands of persons",
  },
  avg_hourly_earnings: {
    seriesId: "CES0500000003",
    meaning: "Avg hourly earnings, total private (SA)",
    units: "dollars/hour",
  },
};

// Reverse lookup seriesId → {key, entry}. A RAW seriesId that HAPPENS to equal a
// curated ID is then also labeled with its units (known-valid) — the honest,
// helpful behavior.
const BLS_ID_TO_KEY: ReadonlyMap<string, BlsSeriesKey> = new Map(
  BLS_SERIES_KEYS.map((k) => [BLS_CATALOG[k].seriesId, k]),
);

// ─── Raw-seriesId charclass (SSRF + "verify the ID" honesty) ──────
// `^[A-Z0-9]{1,20}$` — uppercase alnum, explicit length bound. In JS (no `m`
// flag) `$` matches only end-of-input, and `[A-Z0-9]` cannot include `\n`, so a
// trailing newline is rejected. Rejects `../`, encoded traversal, `@host`, `;`.
const SERIES_ID_RE = /^[A-Z0-9]{1,20}$/;

// ─── Year bounds ──────────────────────────────────────────────────
const YEAR_MIN = 1900;
const CURRENT_YEAR = new Date().getUTCFullYear();
export const YEAR_MAX = CURRENT_YEAR + 1;

// ─── Tier caps (pinned from the BLS FAQ; the disclosure reports the ACTIVE
// tier + the returned range, honest regardless of the constant) ───
type TierCaps = { seriesCap: number; spanCap: number; dailyLabel: string };
const V1_CAPS: TierCaps = { seriesCap: 25, spanCap: 10, dailyLabel: "~25 queries/day/IP" };
const V2_CAPS: TierCaps = { seriesCap: 50, spanCap: 20, dailyLabel: "~500 queries/day" };

// ─── Optional BLS_API_KEY seam (body-carried, NEVER leaked) ───────
// Mirror datagovKey.ts, but the value goes into the POST BODY as
// `registrationkey` and NOWHERE else. `resolvedBlsKey()` is the ONLY reader of
// the value; every other helper exposes only the MODE.
function resolvedBlsKey(): string {
  const raw = process.env.BLS_API_KEY;
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed;
}
/** true when no BLS_API_KEY is configured (keyless v1). Drives mode + caps + path. */
export function usingKeylessV1(): boolean {
  return resolvedBlsKey() === "";
}
function apiPath(): string {
  return usingKeylessV1() ? BLS_PATH_V1 : BLS_PATH_V2;
}
/** The MODE label — NEVER the value. */
function keyModeLabel(): string {
  return usingKeylessV1() ? "v1 keyless" : "v2 (BLS_API_KEY)";
}
function tierCaps(): TierCaps {
  return usingKeylessV1() ? V1_CAPS : V2_CAPS;
}
/** Host+path only label (surfaces in ToolError.upstreamEndpoint; no token). */
function blsLabel(): string {
  return `bls:${apiPath()}`;
}
function blsSource(): string {
  const version = usingKeylessV1() ? "v1" : "v2";
  const mode = usingKeylessV1() ? "keyless v1" : "BLS_API_KEY v2";
  return `api.bls.gov /publicAPI/${version}/timeseries/data/ (${mode})`;
}

// ─── Disclosure text ──────────────────────────────────────────────
/** The mandatory ALWAYS-ON tier disclosure (P1). Reports the ACTIVE tier + caps
 *  + the as-of/footnote caveat. */
function tierNote(): string {
  const c = tierCaps();
  const escapeHatch = usingKeylessV1()
    ? " Set a free BLS_API_KEY (https://data.bls.gov/registrationEngine/) for v2 (~500 queries/day, 50 series/query, ~20-year span) — the key is sent only in the POST request body, never logged."
    : "";
  return `Active BLS tier: ${keyModeLabel()} — approximately ${c.dailyLabel}, ${c.seriesCap} series/query, ~${c.spanCap}-year span/query.${escapeHatch} Values are as-published by BLS and may be preliminary or revised (see per-observation footnote codes, e.g. r=revised, p=preliminary, X=unavailable).`;
}
/** The mandatory per-series UNITS caveat. */
const UNITS_NOTE =
  'Each returned series carries its own units label — an ECI "…A" series is a 12-month PERCENT CHANGE (e.g. 3.4 means 3.4%), NOT an index level; CPI/PPI are index levels; CES nonfarm employment is thousands of persons; a raw seriesId has units:null (consult BLS). Do NOT compare values across series without reading each units label.';

/** The value-gap disclosure preamble (lifted alongside the verbatim footnote texts). */
const GAP_NOTE_PREFIX =
  'One or more observations are UNAVAILABLE (BLS "-" marker): value is null with valueUnavailable:true and the footnote reason on the observation — NEVER a fabricated 0. Disclosed reason(s): ';

function clampNote(requestedStart: number, sentStart: number, endYear: number, spanCap: number): string {
  return `The requested span ${requestedStart}–${endYear} (${endYear - requestedStart + 1} years) exceeds the active BLS tier's ~${spanCap}-year/query cap; startYear was clamped to ${sentStart} BEFORE the request (sent span ${sentStart}–${endYear}). Widen with a smaller window or a BLS_API_KEY (v2, ~${V2_CAPS.spanCap}-year span).`;
}

// ─── Curated observation / series shapes ──────────────────────────
export type BlsFootnote = { code: string | null; text: string | null };

export type BlsObservation = {
  year: string | null;
  period: string | null;
  periodName: string | null;
  /** The PARSED number — null (NEVER 0) for "-"/non-numeric; a genuine "0" → 0. */
  value: number | null;
  /** true iff the raw value was present but unparseable (a disclosed gap). */
  valueUnavailable: boolean;
  footnotes: BlsFootnote[];
  latest: boolean;
};

export type BlsSeriesResult = {
  seriesId: string;
  /** The curated enum key, or null for a raw seriesId. */
  key: string | null;
  /** The curated meaning, or null for a raw seriesId. */
  meaning: string | null;
  /** The units label (from the frozen catalog); null for a raw seriesId. */
  units: string | null;
  observations: BlsObservation[];
  observationCount: number;
  coveredRange: { from: number | null; to: number | null };
};

/** Map a footnotes[] array → non-empty {code,text} entries (drops the `[{}]` noise). */
function mapFootnotes(x: unknown): BlsFootnote[] {
  if (!Array.isArray(x)) return [];
  return x
    .map((f) => {
      const o = (f ?? {}) as Record<string, unknown>;
      return { code: str(o.code), text: str(o.text) };
    })
    .filter((f) => f.code !== null || f.text !== null);
}

/** Map ONE BLS data[] row → the curated observation (P3 — null-never-0 + footnotes). */
function mapObservation(raw: unknown): BlsObservation {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rawValue = r.value;
  const value = num(rawValue); // "-"/non-numeric → null; "0" → 0
  // valueUnavailable: the raw value was PRESENT but did not parse (a disclosed
  // gap), not merely absent. `!= null` catches both null and undefined.
  const valueUnavailable = value === null && rawValue != null;
  return {
    year: str(r.year),
    period: str(r.period),
    periodName: str(r.periodName),
    value,
    valueUnavailable,
    footnotes: mapFootnotes(r.footnotes),
    latest: r.latest === "true" || r.latest === true,
  };
}

// ─── Response envelope parse (status gate + shape guard) ──────────
type ParsedBls = {
  /** seriesID → the raw series object from Results.series. */
  byId: Map<string, Record<string, unknown>>;
  /** Top-level message[] strings (surfaced on soft conditions). */
  messages: string[];
};

/** Coerce a `message` field (BLS returns an array of strings) → string[]. */
function messageArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.map((m) => str(m)).filter((m): m is string => m !== null);
}

/** Heuristic: does a non-success message read like a bad request (→ invalid_input)? */
function looksLikeBadRequest(messages: string[]): boolean {
  return messages.some((m) =>
    /invalid|not a valid|must be|malformed|bad request|unable to parse|parameter|exceeds the maximum|too many/i.test(m),
  );
}

/**
 * Parse the HTTP-200 body: THROW on any non-SUCCESS status (P2, never a
 * fake-empty), else extract the per-series map + the top-level message[].
 * A body that is not an object, or a SUCCESS body whose `Results.series` is not
 * an array, → driftError.
 */
function parseBlsBody(body: unknown, label: string): ParsedBls {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw driftError(
      label,
      "BLS returned a 200 body that is not an object (an array or scalar) — refusing to report it as an empty result.",
    );
  }
  const b = body as { status?: unknown; message?: unknown; Results?: unknown };
  const status = str(b.status);
  const messages = messageArray(b.message);

  if (status !== "REQUEST_SUCCEEDED") {
    const detail = messages.length > 0 ? ` Upstream message(s): ${messages.join(" | ")}.` : "";
    if (status === "REQUEST_NOT_PROCESSED") {
      // The v1 daily-limit / threshold case — an honest retryable rate_limited
      // carrying the tier disclosure (never a fake-empty).
      throw new ToolErrorCarrier({
        kind: "rate_limited",
        message: `BLS did not process the request (status REQUEST_NOT_PROCESSED). The BLS free v1 tier allows ~25 queries/day/IP; this limit was likely hit. Set a free BLS_API_KEY (https://data.bls.gov/registrationEngine/) to use the v2 tier (~500/day) — the key is sent only in the request body, never logged.${detail}`,
        retryable: true,
        retryAfterSeconds: 60,
        upstreamEndpoint: label,
      });
    }
    // REQUEST_FAILED / any other non-SUCCEEDED status.
    const kind = looksLikeBadRequest(messages) ? "invalid_input" : "upstream_unavailable";
    throw new ToolErrorCarrier({
      kind,
      message: `BLS did not succeed (status ${JSON.stringify(status)}).${detail}`,
      retryable: kind === "upstream_unavailable",
      ...(kind === "upstream_unavailable" ? { retryAfterSeconds: 30 } : {}),
      upstreamEndpoint: label,
    });
  }

  // SUCCESS — the Results.series array must be present (else drift; never a fake empty).
  const results = (b.Results ?? {}) as { series?: unknown };
  if (!Array.isArray(results.series)) {
    throw driftError(
      label,
      "BLS returned REQUEST_SUCCEEDED but Results.series is missing/non-array — treating as schema drift (never a fake empty).",
    );
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const s of results.series as unknown[]) {
    const so = (s ?? {}) as Record<string, unknown>;
    const id = str(so.seriesID);
    if (id !== null) byId.set(id, so);
  }
  return { byId, messages };
}

// ─── The tool ─────────────────────────────────────────────────────
export type BlsTimeseriesArgs = {
  series?: BlsSeriesKey[];
  seriesId?: string[];
  startYear?: number;
  endYear?: number;
};

type ResolvedSeries = {
  seriesId: string;
  key: BlsSeriesKey | null;
  fromCurated: boolean; // came from the `series` enum (or is a known-valid catalog ID)
};

/**
 * Fetch one or more BLS time-series over a year range → normalized observations
 * (null-never-0 values + footnotes + per-series units label) + honest `_meta`.
 * At least one of `series`/`seriesId` is required; both may be combined. The
 * resolved+deduped series set is refused over the active tier's series cap
 * (never a silent drop). The span is CLAMPED to the tier cap BEFORE the fetch
 * and disclosed. seriesids ride in the module-built POST body (SSRF: no raw
 * host/path passthrough); the OPTIONAL BLS_API_KEY rides ONLY in the body.
 */
export async function timeseries(args: BlsTimeseriesArgs): Promise<MetaBundle> {
  const label = blsLabel();
  const caps = tierCaps();

  // ── Resolve + dedup the series set (curated keys → seriesId via the frozen
  //    catalog; raw seriesIds charclass-validated). Preserve request order. ──
  const resolved: ResolvedSeries[] = [];
  const seen = new Set<string>();
  const pushResolved = (seriesId: string, key: BlsSeriesKey | null) => {
    if (seen.has(seriesId)) return;
    seen.add(seriesId);
    // A raw ID that equals a known catalog ID is labeled curated (known-valid).
    const catalogKey = key ?? BLS_ID_TO_KEY.get(seriesId) ?? null;
    resolved.push({ seriesId, key: catalogKey, fromCurated: catalogKey !== null });
  };

  for (const k of args.series ?? []) {
    const entry = BLS_CATALOG[k];
    if (!entry) {
      // Belt-and-suspenders behind the server's Zod enum.
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        message: `Unknown curated series key ${JSON.stringify(k)} — expected one of: ${BLS_SERIES_KEYS.join(", ")}.`,
        retryable: false,
        upstreamEndpoint: label,
      });
    }
    pushResolved(entry.seriesId, k);
  }
  for (const raw of args.seriesId ?? []) {
    if (typeof raw !== "string" || !SERIES_ID_RE.test(raw)) {
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        message: `Invalid seriesId ${JSON.stringify(raw)} — expected 1..20 uppercase alphanumeric characters (^[A-Z0-9]{1,20}$). A BLS series ID like 'CUUR0000SA0'; punctuation/whitespace/lowercase are rejected (SSRF + "verify the ID" honesty).`,
        retryable: false,
        upstreamEndpoint: label,
      });
    }
    pushResolved(raw, null);
  }

  // ── At least one of series/seriesId is required (P4 — never a silent no-op). ──
  if (resolved.length === 0) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message:
        "At least one of `series` (a curated enum key) or `seriesId` (a raw BLS series ID) is required — nothing to query.",
      retryable: false,
      upstreamEndpoint: label,
    });
  }

  // ── Refuse over the tier's series cap — NEVER a silent drop of the overflow (P4). ──
  if (resolved.length > caps.seriesCap) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Requested ${resolved.length} distinct series, over the active BLS ${keyModeLabel()} tier cap of ${caps.seriesCap} series/query. Reduce the request (or set a BLS_API_KEY for the v2 tier, ${V2_CAPS.seriesCap} series/query) — the overflow is NOT silently dropped.`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }

  // ── Resolve the year window + defaults; enforce startYear ≤ endYear. ──
  const endYear = args.endYear ?? CURRENT_YEAR;
  const requestedStart = args.startYear ?? endYear - (caps.spanCap - 1);
  if (requestedStart < YEAR_MIN || endYear > YEAR_MAX) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Year out of range — startYear/endYear must be within ${YEAR_MIN}..${YEAR_MAX}. Got startYear ${requestedStart}, endYear ${endYear}.`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }
  if (requestedStart > endYear) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `startYear (${requestedStart}) must be ≤ endYear (${endYear}).`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }

  // ── Span clamp (P1) — clamp startYear BEFORE the fetch (avoid burning a query
  //    on a guaranteed REQUEST_NOT_PROCESSED) + disclose requested-vs-sent + cap. ──
  let sentStart = requestedStart;
  let clamped = false;
  if (endYear - requestedStart + 1 > caps.spanCap) {
    sentStart = endYear - caps.spanCap + 1;
    clamped = true;
  }

  // ── Build the module-built typed payload (SSRF: no raw host/path passthrough;
  //    seriesids + years + the OPTIONAL key ride in the JSON body). ──
  const seriesIds = resolved.map((r) => r.seriesId);
  const payload: Record<string, unknown> = {
    seriesid: seriesIds,
    startyear: String(sentStart),
    endyear: String(endYear),
  };
  // The OPTIONAL BLS_API_KEY — injected ONLY here, in the body, and NOWHERE else.
  // When keyless, `registrationkey` is ABSENT from the body entirely.
  const key = resolvedBlsKey();
  if (key !== "") payload.registrationkey = key;

  // ── SSRF belt-and-suspenders: the URL is a compile-time constant, but assert
  //    it cannot have drifted (a future typo / downgrade). ──
  const url = `https://${BLS_HOST}${apiPath()}`;
  const built = new URL(url);
  if (built.hostname !== BLS_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed BLS URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${BLS_HOST} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }

  // ── The POST-batch fetch through the shared self-throttle gate. A non-JSON 200
  //    body makes getJson's r.json() throw a SyntaxError → reclassify to driftError
  //    at THIS call site (the FDIC pattern); the 429/5xx/404/400 taxonomy propagates
  //    unchanged; redirect:"error" fails closed on any off-host 3xx. ──
  let body: unknown;
  try {
    body = await throughGate(BLS_GATE_KEY, BLS_MIN_INTERVAL_MS, () =>
      getJson<unknown>(built.toString(), {
        label,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
      }),
    );
  } catch (e) {
    if (e instanceof ToolErrorCarrier) throw e;
    if (e instanceof SyntaxError) {
      throw driftError(
        label,
        "BLS returned a non-JSON body at HTTP 200 (an HTML error page) — treating as schema drift (never read as an empty result).",
      );
    }
    throw e;
  }

  const parsed = parseBlsBody(body, label);

  // ── Assemble the per-series output; account for EVERY requested series (P4). ──
  const seriesOut: BlsSeriesResult[] = [];
  const fieldsUnavailable: string[] = [];
  const notes: string[] = [];
  const gapTexts = new Set<string>();
  const emptyNotes: string[] = [];
  const absentNotes: string[] = [];

  for (const rs of resolved) {
    const entry = rs.key ? BLS_CATALOG[rs.key] : null;
    const units = entry ? entry.units : null;
    const meaning = entry ? entry.meaning : null;
    const rawSeries = parsed.byId.get(rs.seriesId);

    if (rawSeries === undefined) {
      // Requested but ENTIRELY ABSENT from Results.series (BLS omitted it) — P4:
      // disclosed, never silently dropped.
      fieldsUnavailable.push(`${rs.seriesId} (not returned by upstream)`);
      absentNotes.push(
        `Series ${rs.seriesId}${rs.key ? ` (${rs.key})` : ""} was requested but NOT returned by BLS (absent from Results.series) — disclosed as unavailable, never silently dropped.`,
      );
      continue;
    }

    const rawData = Array.isArray(rawSeries.data) ? (rawSeries.data as unknown[]) : [];
    const observations = rawData.map(mapObservation);
    const years = observations
      .map((o) => (o.year !== null ? Number(o.year) : NaN))
      .filter((y) => Number.isFinite(y));
    const coveredRange =
      years.length > 0
        ? { from: Math.min(...years), to: Math.max(...years) }
        : { from: null, to: null };

    // Lift each disclosed data-gap footnote text into _meta.notes (P3 disclosure).
    for (const o of observations) {
      if (o.valueUnavailable) {
        for (const f of o.footnotes) if (f.text) gapTexts.add(f.text);
      }
    }

    // Empty-data ambiguity disclosure (P2 refinement).
    if (observations.length === 0) {
      if (rs.fromCurated) {
        emptyNotes.push(
          `No observations for ${rs.key ?? rs.seriesId} (${rs.seriesId}) over ${sentStart}–${endYear} — a genuine empty range for a valid series.`,
        );
      } else {
        emptyNotes.push(
          `No observations for ${rs.seriesId} over ${sentStart}–${endYear} — this is EITHER a genuine empty range OR a nonexistent/mistyped series ID (BLS returns success + empty data for both); verify the ID.`,
        );
      }
    }

    seriesOut.push({
      seriesId: rs.seriesId,
      key: rs.key,
      meaning,
      units,
      observations,
      observationCount: observations.length,
      coveredRange,
    });
  }

  // ── Notes (always: the tier disclosure + the units caveat). ──
  notes.push(tierNote());
  notes.push(UNITS_NOTE);
  if (clamped) notes.push(clampNote(requestedStart, sentStart, endYear, caps.spanCap));
  if (gapTexts.size > 0) notes.push(GAP_NOTE_PREFIX + [...gapTexts].map((t) => `"${t}"`).join("; ") + ".");
  notes.push(...emptyNotes);
  notes.push(...absentNotes);
  if (parsed.messages.length > 0) {
    notes.push(`BLS returned top-level message(s): ${parsed.messages.join(" | ")}.`);
  }

  // filtersApplied = the resolved series descriptors + the (possibly clamped) span (P4).
  const filtersApplied = [
    ...resolved.map((r) => (r.key ? `${r.key}=${r.seriesId}` : r.seriesId)),
    `years:${sentStart}-${endYear}`,
  ];

  const metaOut: Partial<ResponseMeta> = {
    source: blsSource(),
    keylessMode: usingKeylessV1(),
    returned: seriesOut.length,
    totalAvailable: resolved.length,
    filtersApplied,
    filtersDropped: [],
    fieldsUnavailable,
    notes,
  };

  return withMeta({ series: seriesOut }, metaOut);
}
