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

/** The value-gap disclosure when every gap is TEXTLESS (footnotes:[{}] / no text). */
const GAP_NOTE_TEXTLESS =
  'One or more observations are unavailable (BLS "-" marker) with no footnote reason supplied — surfaced as value:null / valueUnavailable:true.';

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
  // The AUTO-derived default is CLAMPED to the 1900 floor (Math.max) so an early
  // endYear (e.g. 1905 ⇒ 1896) never self-inflicts an out-of-range startYear and
  // false-rejects an in-range endYear. An EXPLICIT caller startYear is NOT clamped
  // — an explicit 1850 is still an honest invalid_input at the floor guard below.
  const requestedStart =
    args.startYear ?? Math.max(YEAR_MIN, endYear - (caps.spanCap - 1));
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
  // Tracks whether ANY returned observation is unavailable — so a textless "-" gap
  // (footnotes:[{}] / a code with no text) still contributes ONE aggregate note,
  // not just the per-observation valueUnavailable flag.
  let anyUnavailable = false;
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
        anyUnavailable = true;
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
  if (gapTexts.size > 0) {
    notes.push(GAP_NOTE_PREFIX + [...gapTexts].map((t) => `"${t}"`).join("; ") + ".");
  } else if (anyUnavailable) {
    // All gaps were textless (footnotes:[{}] / no text) — the per-observation flag
    // is honest, but the aggregate summary must reflect the gap too (never omitted).
    notes.push(GAP_NOTE_TEXTLESS);
  }
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

// ═══════════════════════════════════════════════════════════════════════════
// OEWS — Occupational Employment & Wage Statistics (the 2nd tool, ADR-0033)
// ═══════════════════════════════════════════════════════════════════════════
// A SECOND tool on this keyless BLS source: occupational LABOR-RATE benchmarking
// (mean/median annual & hourly wages + employment by SOC occupation × geography)
// — the LEVEL layer next to bls_timeseries's ESCALATION layer, GSA CALC, and SAM
// wage determinations. OEWS series IDs are 25 chars — they EXCEED the
// bls_timeseries raw-seriesId cap (^[A-Z0-9]{1,20}$), so OEWS is NOT reachable
// there; this tool BUILDS the 25-char ID INTERNALLY from validated structured
// inputs (the built ID is never caller-supplied raw text). The endpoint + shape
// are IDENTICAL to bls_timeseries (same POST api.bls.gov, same
// {status, Results.series[].data[]} envelope), so the fetch/parse/honesty layer
// is REUSED byte-identical (getJson-POST, throughGate, parseBlsBody status-throw,
// mapObservation "-"→null-never-0 + footnotes, the resolvedBlsKey/blsSource/tier
// key seam, the SSRF host assert, num/str, withMeta) — only the ID builder +
// curated maps + output shaping are new.
//
// OEWS-specific honesty ON TOP of the reused adapter:
//   (H1) OEWS is an ANNUAL point-in-time snapshot (reference May <year>, period
//        A01); the API serves ONLY the latest release (may lag ~1yr) — NOT
//        monthly/current-quarter; historical needs the downloadable tables.
//   (H2) a built-ID that returns empty data[] (or is absent from Results.series)
//        ⇒ value:null, valueUnavailable:FALSE (it is ABSENT, not a "-" gap) + the
//        not-published note + the surfaced upstream "Series does not exist…"
//        message + the ID in fieldsUnavailable — NEVER a fabricated 0. (Contrast:
//        a present-with-data row goes through mapObservation; a "-" in-band value
//        ⇒ the adapter's null + valueUnavailable:true + footnote.)
//   (H3) each row's measure.units from the datatype map (dollars/year |
//        dollars/hour | count (jobs)) — never mislabel.
//   (H4) the API returns real numerics (no "#"); very-high percentile/median
//        wages are estimates (published-tables boundary ≥$115/hr or ≥$239,200/yr).

// ─── Curated occupation catalog (SOC codes LIVE-verified, ADR §catalog) ──────
// The FROZEN single source of truth for the `occupation` enum, the resolver, and
// the output label (mirrors BLS_CATALOG). The long tail (~830 SOC detailed
// occupations) is reachable via the raw `soc` passthrough (^\d{6}$).
export const BLS_OEWS_OCCUPATION_KEYS = [
  "all_occupations",
  "software_developer",
  "computer_systems_analyst",
  "info_security_analyst",
  "management_analyst",
  "project_mgmt_specialist",
  "logistician",
  "accountant_auditor",
  "general_ops_manager",
  "civil_engineer",
  "electrical_engineer",
  "mechanical_engineer",
  "industrial_engineer",
  "lawyer",
  "technical_writer",
  "admin_assistant",
] as const;

export type BlsOewsOccupationKey = (typeof BLS_OEWS_OCCUPATION_KEYS)[number];

export type BlsOewsOccupationEntry = {
  /** The 6-digit hyphenless SOC code (the occupation component of the series ID). */
  soc: string;
  /** The official SOC occupation title (the output label). */
  label: string;
};

export const BLS_OEWS_OCCUPATIONS: Record<BlsOewsOccupationKey, BlsOewsOccupationEntry> = {
  all_occupations: { soc: "000000", label: "All Occupations" },
  software_developer: { soc: "151252", label: "Software Developers" },
  computer_systems_analyst: { soc: "151211", label: "Computer Systems Analysts" },
  info_security_analyst: { soc: "151212", label: "Information Security Analysts" },
  management_analyst: { soc: "131111", label: "Management Analysts" },
  project_mgmt_specialist: { soc: "131082", label: "Project Management Specialists" },
  logistician: { soc: "131081", label: "Logisticians" },
  accountant_auditor: { soc: "132011", label: "Accountants and Auditors" },
  general_ops_manager: { soc: "111021", label: "General and Operations Managers" },
  civil_engineer: { soc: "172051", label: "Civil Engineers" },
  electrical_engineer: { soc: "172071", label: "Electrical Engineers" },
  mechanical_engineer: { soc: "172141", label: "Mechanical Engineers" },
  industrial_engineer: { soc: "172112", label: "Industrial Engineers" },
  lawyer: { soc: "231011", label: "Lawyers" },
  technical_writer: { soc: "273042", label: "Technical Writers" },
  admin_assistant: {
    soc: "436014",
    label: "Secretaries and Administrative Assistants, Except Legal, Medical, and Executive",
  },
};

// Reverse SOC → curated key: a RAW soc that HAPPENS to equal a curated one is then
// also labeled (known-valid) — the honest, helpful behavior (mirrors BLS_ID_TO_KEY).
const BLS_SOC_TO_KEY: ReadonlyMap<string, BlsOewsOccupationKey> = new Map(
  BLS_OEWS_OCCUPATION_KEYS.map((k) => [BLS_OEWS_OCCUPATIONS[k].soc, k]),
);

// ─── State USPS → 2-digit FIPS map (ADR §area formation) ─────────────────────
// The curated `area` state enum. State areaCode = 2-digit FIPS + "00000" (CA
// 06 → "0600000"). The 5 unused FIPS (03/07/14/43/52) are simply absent.
export const BLS_STATE_FIPS: Record<string, string> = {
  AL: "01", AK: "02", AZ: "04", AR: "05", CA: "06", CO: "08", CT: "09",
  DE: "10", DC: "11", FL: "12", GA: "13", HI: "15", ID: "16", IL: "17",
  IN: "18", IA: "19", KS: "20", KY: "21", LA: "22", ME: "23", MD: "24",
  MA: "25", MI: "26", MN: "27", MS: "28", MO: "29", MT: "30", NE: "31",
  NV: "32", NH: "33", NJ: "34", NM: "35", NY: "36", NC: "37", ND: "38",
  OH: "39", OK: "40", OR: "41", PA: "42", RI: "44", SC: "45", SD: "46",
  TN: "47", TX: "48", UT: "49", VT: "50", VA: "51", WA: "53", WV: "54",
  WI: "55", WY: "56", PR: "72",
};

/** The curated `area` state enum values (the USPS 2-letter codes). */
export const BLS_STATE_KEYS = Object.keys(BLS_STATE_FIPS) as [string, ...string[]];

// ─── Datatype map (LIVE-verified; friendly enum → 2-digit code + units) ──────
// The FROZEN source of truth for the `datatype` enum, the series-ID datatype
// component, and the per-row measure.units label (H3). Default = annual_mean.
export const BLS_OEWS_DATATYPE_KEYS = [
  "annual_mean",
  "annual_median",
  "hourly_mean",
  "hourly_median",
  "employment",
] as const;

export type BlsOewsDatatypeKey = (typeof BLS_OEWS_DATATYPE_KEYS)[number];

export type BlsOewsDatatypeEntry = {
  /** The 2-digit datatype component of the series ID. */
  code: string;
  /** The units label carried on every row's measure (H3 — never mislabel). */
  units: string;
};

export const BLS_OEWS_DATATYPES: Record<BlsOewsDatatypeKey, BlsOewsDatatypeEntry> = {
  annual_mean: { code: "04", units: "dollars/year" },
  annual_median: { code: "13", units: "dollars/year" },
  hourly_mean: { code: "03", units: "dollars/hour" },
  hourly_median: { code: "08", units: "dollars/hour" },
  employment: { code: "01", units: "count (jobs)" },
};

// ─── The OEWS series-ID builder (the crux — ADR §crux, PINNED) ───────────────
// A 25-char ID: OE + U + areatype(N/S/M) + area(7) + industry(000000) +
// occupation(6) + datatype(2). Each component is validated BEFORE concat, then
// the assembled ID is re-asserted ^OEU[NSM][0-9]{21}$ — a wrong-width component
// can NEVER silently produce a DIFFERENT valid series. Pure fn (no fetch).
const OEWS_AREATYPES = new Set(["N", "S", "M"]);
const OEWS_AREA_RE = /^[0-9]{7}$/;
const OEWS_OCC_RE = /^[0-9]{6}$/;
const OEWS_CBSA_RE = /^[0-9]{5}$/;
const OEWS_INDUSTRY = "000000"; // cross-industry / all industries (the B2G default)
const OEWS_DATATYPE_CODES = new Set(["01", "03", "04", "08", "13"]);
const OEWS_ID_RE = /^OEU[NSM][0-9]{21}$/;

/** Throw a uniform invalid_input (host+path-only label — no token). */
function oewsInvalid(message: string): never {
  throw new ToolErrorCarrier({
    kind: "invalid_input",
    message,
    retryable: false,
    upstreamEndpoint: blsLabel(),
  });
}

export function buildOewsSeriesId(parts: {
  areatype: string;
  areaCode: string;
  occupation: string;
  datatype: string;
}): string {
  const { areatype, areaCode, occupation, datatype } = parts;
  if (!OEWS_AREATYPES.has(areatype)) {
    oewsInvalid(
      `Cannot build OEWS series ID: areatype ${JSON.stringify(areatype)} must be one of N (national), S (state), M (metro).`,
    );
  }
  if (!OEWS_AREA_RE.test(areaCode)) {
    oewsInvalid(
      `Cannot build OEWS series ID: areaCode ${JSON.stringify(areaCode)} must be exactly 7 digits (^[0-9]{7}$).`,
    );
  }
  if (!OEWS_OCC_RE.test(occupation)) {
    oewsInvalid(
      `Cannot build OEWS series ID: occupation ${JSON.stringify(occupation)} must be exactly 6 digits — a HYPHENLESS SOC (e.g. 151252, not 15-1252).`,
    );
  }
  if (!OEWS_DATATYPE_CODES.has(datatype)) {
    oewsInvalid(
      `Cannot build OEWS series ID: datatype code ${JSON.stringify(datatype)} must be one of 01/03/04/08/13.`,
    );
  }
  const id = "OE" + "U" + areatype + areaCode + OEWS_INDUSTRY + occupation + datatype;
  if (!OEWS_ID_RE.test(id)) {
    oewsInvalid(
      `Cannot build OEWS series ID: assembled ID ${JSON.stringify(id)} failed the ^OEU[NSM][0-9]{21}$ assertion (defense-in-depth — a wrong-width component must never silently produce a different valid series).`,
    );
  }
  return id;
}

// ─── OEWS input / resolution / output shapes ─────────────────────────────────
export type BlsOewsArgs = {
  occupation?: string[];
  soc?: string[];
  area?: string[];
  datatype?: string[];
};

type ResolvedOewsArea = {
  areatype: string;
  areaCode: string;
  type: "national" | "state" | "metro";
  code: string;
  label: string;
};
type ResolvedOewsOcc = { soc: string; key: string | null; label: string | null };
type ResolvedOewsDatatype = { key: string; code: string; units: string };

export type BlsOewsRow = {
  area: { type: string; code: string; label: string };
  occupation: { soc: string; key: string | null; label: string | null };
  measure: { key: string; code: string; units: string };
  /** The PARSED number — null (NEVER 0). Suppressed/absent (H2) ⇒ null too. */
  value: number | null;
  /** true iff a PRESENT value was unparseable ("-" gap); H2 absence ⇒ FALSE. */
  valueUnavailable: boolean;
  referenceYear: string | null;
  referencePeriod: string | null;
  footnotes: BlsFootnote[];
  seriesId: string;
};

/** Resolve one area token → areatype + zero-padded areaCode + output descriptor. */
function resolveOewsArea(token: string): ResolvedOewsArea {
  if (token === "national") {
    return { areatype: "N", areaCode: "0000000", type: "national", code: "0000000", label: "United States" };
  }
  const fips = BLS_STATE_FIPS[token];
  if (fips !== undefined) {
    const areaCode = fips + "00000"; // 2-digit FIPS + 5 zeros = 7 digits
    return { areatype: "S", areaCode, type: "state", code: areaCode, label: token };
  }
  if (OEWS_CBSA_RE.test(token)) {
    const areaCode = "00" + token; // "00" + 5-digit CBSA = 7 digits
    return { areatype: "M", areaCode, type: "metro", code: areaCode, label: `CBSA ${token}` };
  }
  return oewsInvalid(
    `Unknown area ${JSON.stringify(token)} — expected "national", a 2-letter USPS state code (e.g. CA, TX, DC), or a 5-digit CBSA metro code (e.g. 19100). Punctuation/mistyped codes are rejected (SSRF + verify-the-input honesty).`,
  );
}

// ─── OEWS honesty notes (H1/H3/H4 always-on; H2 per empty combo) ─────────────
/** (H1) The always-on annual / latest-year-only cadence disclosure. */
function oewsAnnualNote(refYear: string | null): string {
  const ref = refYear
    ? `reference May ${refYear}, period A01`
    : "reference May of the latest release year, period A01";
  return `OEWS is an ANNUAL point-in-time snapshot (${ref}); the BLS API serves ONLY the most recent release and may lag ~1 year. These are NOT monthly time-series values and NOT current-quarter figures — do not read a wage as "this month's". Historical OEWS is not in the API; it requires the downloadable OEWS tables (https://www.bls.gov/oes/tables.htm).`;
}
/** (H3) The always-on units-per-datatype caveat. */
const OEWS_UNITS_NOTE =
  "Each row's measure.units is set from its datatype: annual_mean/annual_median = dollars/year, hourly_mean/hourly_median = dollars/hour, employment = count (jobs). Never read an employment count as a wage, or an hourly rate as an annual salary — check measure.units on every row.";
/** (H4) The always-on top-coding informational note. */
const OEWS_TOPCODE_NOTE =
  "The BLS API returns the actual numeric estimate (no '#' top-code); very-high percentile/median wages are BLS estimates, and the published OEWS tables show values >= $115.00/hr or >= $239,200/yr as a boundary. If a '#' ever appeared it is non-numeric and maps to value:null + valueUnavailable + a footnote (never a fabricated number).";
/** (H2) The per-combo not-published disclosure (empty/absent built ID). */
function oewsNotPublishedNote(occLabel: string, areaLabel: string, measureLabel: string, seriesId: string): string {
  return `OEWS publishes no estimate for ${occLabel} in ${areaLabel} (${measureLabel}) — the occupation may not be surveyed/estimated in that area, OR the cell was suppressed for confidentiality/reliability. This is NOT a tool error; the built series ${seriesId} simply has no published value (value:null, not a fabricated 0).`;
}

/** Pick the latest observation (explicit `latest` flag, else max year). */
function pickLatestOewsObservation(observations: BlsObservation[]): BlsObservation | null {
  let best: BlsObservation | null = null;
  for (const o of observations) {
    if (best === null) {
      best = o;
      continue;
    }
    const oy = o.year !== null ? Number(o.year) : -Infinity;
    const by = best.year !== null ? Number(best.year) : -Infinity;
    if (o.latest && !best.latest) best = o;
    else if (o.latest === best.latest && oy > by) best = o;
  }
  return best;
}

/**
 * OEWS occupational wage benchmarking — build validated 25-char series IDs from
 * structured (area × occupation × datatype) inputs, batch them into ONE POST
 * (REUSING the bls_timeseries transport/parse/honesty layer), and return one
 * normalized wage/employment row per resolved combo + honest _meta. NO year
 * input (OEWS serves only the latest release; the tool requests a small recent
 * window internally and discloses the reference year from the returned A01 row).
 */
export async function oewsWages(args: BlsOewsArgs): Promise<MetaBundle> {
  const label = blsLabel();
  const caps = tierCaps();

  // ── Resolve occupations (curated keys + raw socs), preserving order. ──
  const occupations: ResolvedOewsOcc[] = [];
  for (const k of args.occupation ?? []) {
    const entry = (BLS_OEWS_OCCUPATIONS as Record<string, BlsOewsOccupationEntry>)[k];
    if (!entry) {
      oewsInvalid(
        `Unknown occupation key ${JSON.stringify(k)} — expected one of: ${BLS_OEWS_OCCUPATION_KEYS.join(", ")}, or pass a raw 6-digit SOC via 'soc'.`,
      );
    }
    occupations.push({ soc: entry.soc, key: k, label: entry.label });
  }
  for (const raw of args.soc ?? []) {
    if (typeof raw !== "string" || !OEWS_OCC_RE.test(raw)) {
      oewsInvalid(
        `Invalid soc ${JSON.stringify(raw)} — expected exactly 6 digits with NO hyphen (use 151252, not 15-1252). The curated 'occupation' enum is typo-proof; 'soc' is the long-tail passthrough.`,
      );
    }
    const key = BLS_SOC_TO_KEY.get(raw) ?? null;
    occupations.push({ soc: raw, key, label: key ? BLS_OEWS_OCCUPATIONS[key].label : null });
  }
  // ── At least one of occupation/soc is required (P4 — never a silent no-op). ──
  if (occupations.length === 0) {
    oewsInvalid(
      "At least one of `occupation` (a curated enum key) or `soc` (a raw 6-digit SOC) is required — nothing to query.",
    );
  }

  // ── Resolve areas (default national) + datatypes (default annual_mean). An
  //    empty array falls back to the default (never a silent 0-row no-op). ──
  const areaTokens = args.area && args.area.length > 0 ? args.area : ["national"];
  const areas = areaTokens.map((t) => resolveOewsArea(String(t)));

  const datatypeKeys = args.datatype && args.datatype.length > 0 ? args.datatype : ["annual_mean"];
  const datatypes: ResolvedOewsDatatype[] = datatypeKeys.map((k) => {
    const entry = (BLS_OEWS_DATATYPES as Record<string, BlsOewsDatatypeEntry>)[k];
    if (!entry) {
      oewsInvalid(
        `Unknown datatype ${JSON.stringify(k)} — expected one of: ${BLS_OEWS_DATATYPE_KEYS.join(", ")}.`,
      );
    }
    return { key: k, code: entry.code, units: entry.units };
  });

  // ── Refuse over the tier's series cap — NEVER a silent drop of the overflow
  //    (P4). The count is the cartesian product size, named explicitly. ──
  const product = areas.length * occupations.length * datatypes.length;
  if (product > caps.seriesCap) {
    oewsInvalid(
      `Requested ${areas.length} area(s) × ${occupations.length} occupation(s) × ${datatypes.length} datatype(s) = ${product} series, over the active BLS ${keyModeLabel()} tier cap of ${caps.seriesCap} series/query. Reduce the request (or set a free BLS_API_KEY for the v2 tier, ${V2_CAPS.seriesCap} series/query) — the overflow is NOT silently dropped.`,
    );
  }

  // ── Build one combo per (area, occ, datatype); dedup identical built IDs. ──
  type PlannedRow = { area: ResolvedOewsArea; occ: ResolvedOewsOcc; dt: ResolvedOewsDatatype; seriesId: string };
  const planned: PlannedRow[] = [];
  const seen = new Set<string>();
  for (const area of areas) {
    for (const occ of occupations) {
      for (const dt of datatypes) {
        const seriesId = buildOewsSeriesId({
          areatype: area.areatype,
          areaCode: area.areaCode,
          occupation: occ.soc,
          datatype: dt.code,
        });
        if (seen.has(seriesId)) continue;
        seen.add(seriesId);
        planned.push({ area, occ, dt, seriesId });
      }
    }
  }

  // ── The recent-window years (NO caller year input; OEWS serves only the
  //    latest release — a 3-year window covers the ~1-year lag). ──
  const endYear = CURRENT_YEAR;
  const startYear = CURRENT_YEAR - 2;

  // ── Module-built typed payload (SSRF: no raw host/path passthrough; the built
  //    seriesIDs + years + the OPTIONAL key ride in the JSON body). ──
  const payload: Record<string, unknown> = {
    seriesid: planned.map((p) => p.seriesId),
    startyear: String(startYear),
    endyear: String(endYear),
  };
  // The OPTIONAL BLS_API_KEY — injected ONLY here, in the body, and NOWHERE else.
  const key = resolvedBlsKey();
  if (key !== "") payload.registrationkey = key;

  // ── SSRF belt-and-suspenders: the URL is a compile-time constant; assert it
  //    cannot have drifted (a future typo / downgrade). ──
  const url = `https://${BLS_HOST}${apiPath()}`;
  const built = new URL(url);
  if (built.hostname !== BLS_HOST || built.protocol !== "https:") {
    oewsInvalid(
      `Constructed BLS URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${BLS_HOST} over https — refusing to fetch (SSRF safety).`,
    );
  }

  // ── The POST-batch fetch through the shared self-throttle gate (the SAME idiom
  //    as timeseries). A non-JSON 200 → driftError; the status/error taxonomy +
  //    redirect:"error" propagate unchanged. ──
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

  // ── Assemble one row per planned combo; account for EVERY combo (P4). ──
  const rows: BlsOewsRow[] = [];
  const fieldsUnavailable: string[] = [];
  const notPublishedNotes: string[] = [];
  let refYear: string | null = null;

  for (const p of planned) {
    const rawSeries = parsed.byId.get(p.seriesId);
    const rawData = rawSeries && Array.isArray(rawSeries.data) ? (rawSeries.data as unknown[]) : [];
    const observations = rawData.map(mapObservation);
    const latest = pickLatestOewsObservation(observations);

    const areaOut = { type: p.area.type, code: p.area.code, label: p.area.label };
    const occOut = { soc: p.occ.soc, key: p.occ.key, label: p.occ.label };
    const measureOut = { key: p.dt.key, code: p.dt.code, units: p.dt.units };

    if (latest === null) {
      // (H2) empty data[] OR absent from Results.series → NOT-PUBLISHED (absent,
      // not a "-" gap): value:null, valueUnavailable:FALSE, never a fabricated 0.
      fieldsUnavailable.push(`${p.seriesId} (OEWS publishes no estimate)`);
      notPublishedNotes.push(
        oewsNotPublishedNote(
          p.occ.label ?? p.occ.soc,
          p.area.label,
          `${p.dt.key} (${p.dt.units})`,
          p.seriesId,
        ),
      );
      rows.push({
        area: areaOut,
        occupation: occOut,
        measure: measureOut,
        value: null,
        valueUnavailable: false,
        referenceYear: null,
        referencePeriod: null,
        footnotes: [],
        seriesId: p.seriesId,
      });
      continue;
    }

    // Present-with-data → the reused mapObservation path (null-never-0 +
    // valueUnavailable + footnotes for an in-band "-"; a real number otherwise).
    if (latest.year !== null && (refYear === null || Number(latest.year) > Number(refYear))) {
      refYear = latest.year;
    }
    rows.push({
      area: areaOut,
      occupation: occOut,
      measure: measureOut,
      value: latest.value,
      valueUnavailable: latest.valueUnavailable,
      referenceYear: latest.year,
      referencePeriod: latest.period,
      footnotes: latest.footnotes,
      seriesId: p.seriesId,
    });
  }

  // ── Notes: H1 + H3 + H4 always; the tier disclosure (reused, P1); H2 per empty
  //    combo; any surfaced top-level BLS message. ──
  const notes: string[] = [];
  notes.push(oewsAnnualNote(refYear));
  notes.push(OEWS_UNITS_NOTE);
  notes.push(OEWS_TOPCODE_NOTE);
  notes.push(tierNote());
  notes.push(...notPublishedNotes);
  if (parsed.messages.length > 0) {
    notes.push(`BLS returned top-level message(s): ${parsed.messages.join(" | ")}.`);
  }

  const filtersApplied = [
    `areas:${areas.map((a) => a.code).join(",")}`,
    `occupations:${occupations.map((o) => o.soc).join(",")}`,
    `datatypes:${datatypes.map((d) => `${d.key}=${d.code}`).join(",")}`,
    `years:${startYear}-${endYear}`,
  ];

  const metaOut: Partial<ResponseMeta> = {
    source: blsSource(),
    keylessMode: usingKeylessV1(),
    returned: rows.length,
    totalAvailable: rows.length,
    filtersApplied,
    filtersDropped: [],
    fieldsUnavailable,
    notes,
  };

  return withMeta({ results: rows }, metaOut);
}
