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
import { ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { getJson, driftError, throughGate, isRedirectError } from "./datasource.js";
import { parseRecordFields } from "./gsa-csv.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
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
];
export const BLS_CATALOG = {
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
const BLS_ID_TO_KEY = new Map(BLS_SERIES_KEYS.map((k) => [BLS_CATALOG[k].seriesId, k]));
// ─── Raw-seriesId charclass (SSRF + "verify the ID" honesty) ──────
// `^[A-Z0-9]{1,20}$` — uppercase alnum, explicit length bound. In JS (no `m`
// flag) `$` matches only end-of-input, and `[A-Z0-9]` cannot include `\n`, so a
// trailing newline is rejected. Rejects `../`, encoded traversal, `@host`, `;`.
const SERIES_ID_RE = /^[A-Z0-9]{1,20}$/;
// ─── Year bounds ──────────────────────────────────────────────────
const YEAR_MIN = 1900;
const CURRENT_YEAR = new Date().getUTCFullYear();
export const YEAR_MAX = CURRENT_YEAR + 1;
const V1_CAPS = { seriesCap: 25, spanCap: 10, dailyLabel: "~25 queries/day/IP" };
const V2_CAPS = { seriesCap: 50, spanCap: 20, dailyLabel: "~500 queries/day" };
// ─── Optional BLS_API_KEY seam (body-carried, NEVER leaked) ───────
// Mirror datagovKey.ts, but the value goes into the POST BODY as
// `registrationkey` and NOWHERE else. `resolvedBlsKey()` is the ONLY reader of
// the value; every other helper exposes only the MODE.
function resolvedBlsKey() {
    const raw = process.env.BLS_API_KEY;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed;
}
/** true when no BLS_API_KEY is configured (keyless v1). Drives mode + caps + path. */
export function usingKeylessV1() {
    return resolvedBlsKey() === "";
}
function apiPath() {
    return usingKeylessV1() ? BLS_PATH_V1 : BLS_PATH_V2;
}
/** The MODE label — NEVER the value. */
function keyModeLabel() {
    return usingKeylessV1() ? "v1 keyless" : "v2 (BLS_API_KEY)";
}
function tierCaps() {
    return usingKeylessV1() ? V1_CAPS : V2_CAPS;
}
/** Host+path only label (surfaces in ToolError.upstreamEndpoint; no token). */
function blsLabel() {
    return `bls:${apiPath()}`;
}
function blsSource() {
    const version = usingKeylessV1() ? "v1" : "v2";
    const mode = usingKeylessV1() ? "keyless v1" : "BLS_API_KEY v2";
    return `api.bls.gov /publicAPI/${version}/timeseries/data/ (${mode})`;
}
// ─── Disclosure text ──────────────────────────────────────────────
/** The mandatory ALWAYS-ON tier disclosure (P1). Reports the ACTIVE tier + caps
 *  + the as-of/footnote caveat. */
function tierNote() {
    const c = tierCaps();
    const escapeHatch = usingKeylessV1()
        ? " Set a free BLS_API_KEY (https://data.bls.gov/registrationEngine/) for v2 (~500 queries/day, 50 series/query, ~20-year span) — the key is sent only in the POST request body, never logged."
        : "";
    return `Active BLS tier: ${keyModeLabel()} — approximately ${c.dailyLabel}, ${c.seriesCap} series/query, ~${c.spanCap}-year span/query.${escapeHatch} Values are as-published by BLS and may be preliminary or revised (see per-observation footnote codes, e.g. r=revised, p=preliminary, X=unavailable).`;
}
/** The mandatory per-series UNITS caveat. */
const UNITS_NOTE = 'Each returned series carries its own units label — an ECI "…A" series is a 12-month PERCENT CHANGE (e.g. 3.4 means 3.4%), NOT an index level; CPI/PPI are index levels; CES nonfarm employment is thousands of persons; a raw seriesId has units:null (consult BLS). Do NOT compare values across series without reading each units label.';
/** The value-gap disclosure preamble (lifted alongside the verbatim footnote texts). */
const GAP_NOTE_PREFIX = 'One or more observations are UNAVAILABLE (BLS "-" marker): value is null with valueUnavailable:true and the footnote reason on the observation — NEVER a fabricated 0. Disclosed reason(s): ';
/** The value-gap disclosure when every gap is TEXTLESS (footnotes:[{}] / no text). */
const GAP_NOTE_TEXTLESS = 'One or more observations are unavailable (BLS "-" marker) with no footnote reason supplied — surfaced as value:null / valueUnavailable:true.';
function clampNote(requestedStart, sentStart, endYear, spanCap) {
    return `The requested span ${requestedStart}–${endYear} (${endYear - requestedStart + 1} years) exceeds the active BLS tier's ~${spanCap}-year/query cap; startYear was clamped to ${sentStart} BEFORE the request (sent span ${sentStart}–${endYear}). Widen with a smaller window or a BLS_API_KEY (v2, ~${V2_CAPS.spanCap}-year span).`;
}
/** Map a footnotes[] array → non-empty {code,text} entries (drops the `[{}]` noise). */
function mapFootnotes(x) {
    if (!Array.isArray(x))
        return [];
    return x
        .map((f) => {
        const o = (f ?? {});
        return { code: str(o.code), text: str(o.text) };
    })
        .filter((f) => f.code !== null || f.text !== null);
}
/** Map ONE BLS data[] row → the curated observation (P3 — null-never-0 + footnotes). */
function mapObservation(raw) {
    const r = (raw ?? {});
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
/** Coerce a `message` field (BLS returns an array of strings) → string[]. */
function messageArray(x) {
    if (!Array.isArray(x))
        return [];
    return x.map((m) => str(m)).filter((m) => m !== null);
}
/** Heuristic: does a non-success message read like a bad request (→ invalid_input)? */
function looksLikeBadRequest(messages) {
    return messages.some((m) => /invalid|not a valid|must be|malformed|bad request|unable to parse|parameter|exceeds the maximum|too many/i.test(m));
}
/**
 * Parse the HTTP-200 body: THROW on any non-SUCCESS status (P2, never a
 * fake-empty), else extract the per-series map + the top-level message[].
 * A body that is not an object, or a SUCCESS body whose `Results.series` is not
 * an array, → driftError.
 */
function parseBlsBody(body, label) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw driftError(label, "BLS returned a 200 body that is not an object (an array or scalar) — refusing to report it as an empty result.");
    }
    const b = body;
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
    const results = (b.Results ?? {});
    if (!Array.isArray(results.series)) {
        throw driftError(label, "BLS returned REQUEST_SUCCEEDED but Results.series is missing/non-array — treating as schema drift (never a fake empty).");
    }
    const byId = new Map();
    for (const s of results.series) {
        const so = (s ?? {});
        const id = str(so.seriesID);
        if (id !== null)
            byId.set(id, so);
    }
    return { byId, messages };
}
/**
 * Fetch one or more BLS time-series over a year range → normalized observations
 * (null-never-0 values + footnotes + per-series units label) + honest `_meta`.
 * At least one of `series`/`seriesId` is required; both may be combined. The
 * resolved+deduped series set is refused over the active tier's series cap
 * (never a silent drop). The span is CLAMPED to the tier cap BEFORE the fetch
 * and disclosed. seriesids ride in the module-built POST body (SSRF: no raw
 * host/path passthrough); the OPTIONAL BLS_API_KEY rides ONLY in the body.
 */
export async function timeseries(args) {
    const label = blsLabel();
    const caps = tierCaps();
    // ── Resolve + dedup the series set (curated keys → seriesId via the frozen
    //    catalog; raw seriesIds charclass-validated). Preserve request order. ──
    const resolved = [];
    const seen = new Set();
    const pushResolved = (seriesId, key) => {
        if (seen.has(seriesId))
            return;
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
            message: "At least one of `series` (a curated enum key) or `seriesId` (a raw BLS series ID) is required — nothing to query.",
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
    const requestedStart = args.startYear ?? Math.max(YEAR_MIN, endYear - (caps.spanCap - 1));
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
    const payload = {
        seriesid: seriesIds,
        startyear: String(sentStart),
        endyear: String(endYear),
    };
    // The OPTIONAL BLS_API_KEY — injected ONLY here, in the body, and NOWHERE else.
    // When keyless, `registrationkey` is ABSENT from the body entirely.
    const key = resolvedBlsKey();
    if (key !== "")
        payload.registrationkey = key;
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
    let body;
    try {
        body = await throughGate(BLS_GATE_KEY, BLS_MIN_INTERVAL_MS, () => getJson(built.toString(), {
            label,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            redirect: "error",
        }));
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError) {
            throw driftError(label, "BLS returned a non-JSON body at HTTP 200 (an HTML error page) — treating as schema drift (never read as an empty result).");
        }
        throw e;
    }
    const parsed = parseBlsBody(body, label);
    // ── Assemble the per-series output; account for EVERY requested series (P4). ──
    const seriesOut = [];
    const fieldsUnavailable = [];
    const notes = [];
    const gapTexts = new Set();
    // Tracks whether ANY returned observation is unavailable — so a textless "-" gap
    // (footnotes:[{}] / a code with no text) still contributes ONE aggregate note,
    // not just the per-observation valueUnavailable flag.
    let anyUnavailable = false;
    const emptyNotes = [];
    const absentNotes = [];
    for (const rs of resolved) {
        const entry = rs.key ? BLS_CATALOG[rs.key] : null;
        const units = entry ? entry.units : null;
        const meaning = entry ? entry.meaning : null;
        const rawSeries = parsed.byId.get(rs.seriesId);
        if (rawSeries === undefined) {
            // Requested but ENTIRELY ABSENT from Results.series (BLS omitted it) — P4:
            // disclosed, never silently dropped.
            fieldsUnavailable.push(`${rs.seriesId} (not returned by upstream)`);
            absentNotes.push(`Series ${rs.seriesId}${rs.key ? ` (${rs.key})` : ""} was requested but NOT returned by BLS (absent from Results.series) — disclosed as unavailable, never silently dropped.`);
            continue;
        }
        const rawData = Array.isArray(rawSeries.data) ? rawSeries.data : [];
        const observations = rawData.map(mapObservation);
        const years = observations
            .map((o) => (o.year !== null ? Number(o.year) : NaN))
            .filter((y) => Number.isFinite(y));
        const coveredRange = years.length > 0
            ? { from: Math.min(...years), to: Math.max(...years) }
            : { from: null, to: null };
        // Lift each disclosed data-gap footnote text into _meta.notes (P3 disclosure).
        for (const o of observations) {
            if (o.valueUnavailable) {
                anyUnavailable = true;
                for (const f of o.footnotes)
                    if (f.text)
                        gapTexts.add(f.text);
            }
        }
        // Empty-data ambiguity disclosure (P2 refinement).
        if (observations.length === 0) {
            if (rs.fromCurated) {
                emptyNotes.push(`No observations for ${rs.key ?? rs.seriesId} (${rs.seriesId}) over ${sentStart}–${endYear} — a genuine empty range for a valid series.`);
            }
            else {
                emptyNotes.push(`No observations for ${rs.seriesId} over ${sentStart}–${endYear} — this is EITHER a genuine empty range OR a nonexistent/mistyped series ID (BLS returns success + empty data for both); verify the ID.`);
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
    if (clamped)
        notes.push(clampNote(requestedStart, sentStart, endYear, caps.spanCap));
    if (gapTexts.size > 0) {
        notes.push(GAP_NOTE_PREFIX + [...gapTexts].map((t) => `"${t}"`).join("; ") + ".");
    }
    else if (anyUnavailable) {
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
    const metaOut = {
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
];
export const BLS_OEWS_OCCUPATIONS = {
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
const BLS_SOC_TO_KEY = new Map(BLS_OEWS_OCCUPATION_KEYS.map((k) => [BLS_OEWS_OCCUPATIONS[k].soc, k]));
// ─── State USPS → 2-digit FIPS map (ADR §area formation) ─────────────────────
// The curated `area` state enum. State areaCode = 2-digit FIPS + "00000" (CA
// 06 → "0600000"). The 5 unused FIPS (03/07/14/43/52) are simply absent.
export const BLS_STATE_FIPS = {
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
export const BLS_STATE_KEYS = Object.keys(BLS_STATE_FIPS);
// ─── Datatype map (LIVE-verified; friendly enum → 2-digit code + units) ──────
// The FROZEN source of truth for the `datatype` enum, the series-ID datatype
// component, and the per-row measure.units label (H3). Default = annual_mean.
export const BLS_OEWS_DATATYPE_KEYS = [
    "annual_mean",
    "annual_median",
    "hourly_mean",
    "hourly_median",
    "employment",
];
export const BLS_OEWS_DATATYPES = {
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
function oewsInvalid(message) {
    throw new ToolErrorCarrier({
        kind: "invalid_input",
        message,
        retryable: false,
        upstreamEndpoint: blsLabel(),
    });
}
export function buildOewsSeriesId(parts) {
    const { areatype, areaCode, occupation, datatype } = parts;
    if (!OEWS_AREATYPES.has(areatype)) {
        oewsInvalid(`Cannot build OEWS series ID: areatype ${JSON.stringify(areatype)} must be one of N (national), S (state), M (metro).`);
    }
    if (!OEWS_AREA_RE.test(areaCode)) {
        oewsInvalid(`Cannot build OEWS series ID: areaCode ${JSON.stringify(areaCode)} must be exactly 7 digits (^[0-9]{7}$).`);
    }
    if (!OEWS_OCC_RE.test(occupation)) {
        oewsInvalid(`Cannot build OEWS series ID: occupation ${JSON.stringify(occupation)} must be exactly 6 digits — a HYPHENLESS SOC (e.g. 151252, not 15-1252).`);
    }
    if (!OEWS_DATATYPE_CODES.has(datatype)) {
        oewsInvalid(`Cannot build OEWS series ID: datatype code ${JSON.stringify(datatype)} must be one of 01/03/04/08/13.`);
    }
    const id = "OE" + "U" + areatype + areaCode + OEWS_INDUSTRY + occupation + datatype;
    if (!OEWS_ID_RE.test(id)) {
        oewsInvalid(`Cannot build OEWS series ID: assembled ID ${JSON.stringify(id)} failed the ^OEU[NSM][0-9]{21}$ assertion (defense-in-depth — a wrong-width component must never silently produce a different valid series).`);
    }
    return id;
}
/** Resolve one area token → areatype + zero-padded areaCode + output descriptor. */
function resolveOewsArea(token) {
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
    return oewsInvalid(`Unknown area ${JSON.stringify(token)} — expected "national", a 2-letter USPS state code (e.g. CA, TX, DC), or a 5-digit CBSA metro code (e.g. 19100). Punctuation/mistyped codes are rejected (SSRF + verify-the-input honesty).`);
}
// ─── OEWS honesty notes (H1/H3/H4 always-on; H2 per empty combo) ─────────────
/** (H1) The always-on annual / latest-year-only cadence disclosure. */
function oewsAnnualNote(refYear) {
    const ref = refYear
        ? `reference May ${refYear}, period A01`
        : "reference May of the latest release year, period A01";
    return `OEWS is an ANNUAL point-in-time snapshot (${ref}); the BLS API serves ONLY the most recent release and may lag ~1 year. These are NOT monthly time-series values and NOT current-quarter figures — do not read a wage as "this month's". Historical OEWS is not in the API; it requires the downloadable OEWS tables (https://www.bls.gov/oes/tables.htm).`;
}
/** (H3) The always-on units-per-datatype caveat. */
const OEWS_UNITS_NOTE = "Each row's measure.units is set from its datatype: annual_mean/annual_median = dollars/year, hourly_mean/hourly_median = dollars/hour, employment = count (jobs). Never read an employment count as a wage, or an hourly rate as an annual salary — check measure.units on every row.";
/** (H4) The always-on top-coding informational note. */
const OEWS_TOPCODE_NOTE = "The BLS API returns the actual numeric estimate (no '#' top-code); very-high percentile/median wages are BLS estimates, and the published OEWS tables show values >= $115.00/hr or >= $239,200/yr as a boundary. If a '#' ever appeared it is non-numeric and maps to value:null + valueUnavailable + a footnote (never a fabricated number).";
/** (H2) The per-combo not-published disclosure (empty/absent built ID). */
function oewsNotPublishedNote(occLabel, areaLabel, measureLabel, seriesId) {
    return `OEWS publishes no estimate for ${occLabel} in ${areaLabel} (${measureLabel}) — the occupation may not be surveyed/estimated in that area, OR the cell was suppressed for confidentiality/reliability. This is NOT a tool error; the built series ${seriesId} simply has no published value (value:null, not a fabricated 0).`;
}
/** Pick the latest observation (explicit `latest` flag, else max year). */
function pickLatestOewsObservation(observations) {
    let best = null;
    for (const o of observations) {
        if (best === null) {
            best = o;
            continue;
        }
        const oy = o.year !== null ? Number(o.year) : -Infinity;
        const by = best.year !== null ? Number(best.year) : -Infinity;
        if (o.latest && !best.latest)
            best = o;
        else if (o.latest === best.latest && oy > by)
            best = o;
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
export async function oewsWages(args) {
    const label = blsLabel();
    const caps = tierCaps();
    // ── Resolve occupations (curated keys + raw socs), preserving order. ──
    const occupations = [];
    for (const k of args.occupation ?? []) {
        const entry = BLS_OEWS_OCCUPATIONS[k];
        if (!entry) {
            oewsInvalid(`Unknown occupation key ${JSON.stringify(k)} — expected one of: ${BLS_OEWS_OCCUPATION_KEYS.join(", ")}, or pass a raw 6-digit SOC via 'soc'.`);
        }
        occupations.push({ soc: entry.soc, key: k, label: entry.label });
    }
    for (const raw of args.soc ?? []) {
        if (typeof raw !== "string" || !OEWS_OCC_RE.test(raw)) {
            oewsInvalid(`Invalid soc ${JSON.stringify(raw)} — expected exactly 6 digits with NO hyphen (use 151252, not 15-1252). The curated 'occupation' enum is typo-proof; 'soc' is the long-tail passthrough.`);
        }
        const key = BLS_SOC_TO_KEY.get(raw) ?? null;
        occupations.push({ soc: raw, key, label: key ? BLS_OEWS_OCCUPATIONS[key].label : null });
    }
    // ── At least one of occupation/soc is required (P4 — never a silent no-op). ──
    if (occupations.length === 0) {
        oewsInvalid("At least one of `occupation` (a curated enum key) or `soc` (a raw 6-digit SOC) is required — nothing to query.");
    }
    // ── Resolve areas (default national) + datatypes (default annual_mean). An
    //    empty array falls back to the default (never a silent 0-row no-op). ──
    const areaTokens = args.area && args.area.length > 0 ? args.area : ["national"];
    const areas = areaTokens.map((t) => resolveOewsArea(String(t)));
    const datatypeKeys = args.datatype && args.datatype.length > 0 ? args.datatype : ["annual_mean"];
    const datatypes = datatypeKeys.map((k) => {
        const entry = BLS_OEWS_DATATYPES[k];
        if (!entry) {
            oewsInvalid(`Unknown datatype ${JSON.stringify(k)} — expected one of: ${BLS_OEWS_DATATYPE_KEYS.join(", ")}.`);
        }
        return { key: k, code: entry.code, units: entry.units };
    });
    // ── Refuse over the tier's series cap — NEVER a silent drop of the overflow
    //    (P4). The count is the cartesian product size, named explicitly. ──
    const product = areas.length * occupations.length * datatypes.length;
    if (product > caps.seriesCap) {
        oewsInvalid(`Requested ${areas.length} area(s) × ${occupations.length} occupation(s) × ${datatypes.length} datatype(s) = ${product} series, over the active BLS ${keyModeLabel()} tier cap of ${caps.seriesCap} series/query. Reduce the request (or set a free BLS_API_KEY for the v2 tier, ${V2_CAPS.seriesCap} series/query) — the overflow is NOT silently dropped.`);
    }
    const planned = [];
    const seen = new Set();
    for (const area of areas) {
        for (const occ of occupations) {
            for (const dt of datatypes) {
                const seriesId = buildOewsSeriesId({
                    areatype: area.areatype,
                    areaCode: area.areaCode,
                    occupation: occ.soc,
                    datatype: dt.code,
                });
                if (seen.has(seriesId))
                    continue;
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
    const payload = {
        seriesid: planned.map((p) => p.seriesId),
        startyear: String(startYear),
        endyear: String(endYear),
    };
    // The OPTIONAL BLS_API_KEY — injected ONLY here, in the body, and NOWHERE else.
    const key = resolvedBlsKey();
    if (key !== "")
        payload.registrationkey = key;
    // ── SSRF belt-and-suspenders: the URL is a compile-time constant; assert it
    //    cannot have drifted (a future typo / downgrade). ──
    const url = `https://${BLS_HOST}${apiPath()}`;
    const built = new URL(url);
    if (built.hostname !== BLS_HOST || built.protocol !== "https:") {
        oewsInvalid(`Constructed BLS URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${BLS_HOST} over https — refusing to fetch (SSRF safety).`);
    }
    // ── The POST-batch fetch through the shared self-throttle gate (the SAME idiom
    //    as timeseries). A non-JSON 200 → driftError; the status/error taxonomy +
    //    redirect:"error" propagate unchanged. ──
    let body;
    try {
        body = await throughGate(BLS_GATE_KEY, BLS_MIN_INTERVAL_MS, () => getJson(built.toString(), {
            label,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            redirect: "error",
        }));
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError) {
            throw driftError(label, "BLS returned a non-JSON body at HTTP 200 (an HTML error page) — treating as schema drift (never read as an empty result).");
        }
        throw e;
    }
    const parsed = parseBlsBody(body, label);
    // ── Assemble one row per planned combo; account for EVERY combo (P4). ──
    const rows = [];
    const fieldsUnavailable = [];
    const notPublishedNotes = [];
    let refYear = null;
    for (const p of planned) {
        const rawSeries = parsed.byId.get(p.seriesId);
        const rawData = rawSeries && Array.isArray(rawSeries.data) ? rawSeries.data : [];
        const observations = rawData.map(mapObservation);
        const latest = pickLatestOewsObservation(observations);
        const areaOut = { type: p.area.type, code: p.area.code, label: p.area.label };
        const occOut = { soc: p.occ.soc, key: p.occ.key, label: p.occ.label };
        const measureOut = { key: p.dt.key, code: p.dt.code, units: p.dt.units };
        if (latest === null) {
            // (H2) empty data[] OR absent from Results.series → NOT-PUBLISHED (absent,
            // not a "-" gap): value:null, valueUnavailable:FALSE, never a fabricated 0.
            fieldsUnavailable.push(`${p.seriesId} (OEWS publishes no estimate)`);
            notPublishedNotes.push(oewsNotPublishedNote(p.occ.label ?? p.occ.soc, p.area.label, `${p.dt.key} (${p.dt.units})`, p.seriesId));
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
    const notes = [];
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
    const metaOut = {
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
// ═══════════════════════════════════════════════════════════════════════════
// QCEW — Quarterly Census of Employment & Wages (the 3rd tool, ADR-0042)
// ═══════════════════════════════════════════════════════════════════════════
// A THIRD tool on the BLS provider — but a SECOND, DIFFERENT, keyless,
// un-rate-limited BLS DOMAIN: the QCEW Open Data Access CSV files on
// data.bls.gov/cew (NOT the rate-limited api.bls.gov/publicAPI timeseries API the
// two tools above share). It answers the market-size / competition-density
// question no existing tool can: for a county (area_fips) or a NAICS industry ×
// quarter — establishment COUNT (market size / competitor density), county×NAICS
// employment, average weekly wage (labor cost), and the LOCATION QUOTIENT
// (concentration vs the national average = competition density).
//
// This path DELIBERATELY does NOT touch the api.bls.gov key seam
// (resolvedBlsKey/apiPath/blsSource/BLS_GATE_KEY="bls"): QCEW is keyless, a NEW
// host, and uses a NEW self-throttle gate key ("bls_qcew") so it never serializes
// behind — or shares the ~25/day budget of — the timeseries tools. NO BLS_API_KEY
// is read here.
//
// ★ THE DISCLOSURE-SUPPRESSION HONESTY CRUX (P3). Each row carries THREE
// disclosure codes governing THREE blocks: `disclosure_code` (base),
// `lq_disclosure_code` (lq), `oty_disclosure_code` (oty). QCEW encodes a
// SUPPRESSED (confidential) employment/wage value as a literal `0`; because
// num("0") === 0, a naive map would surface a withheld field as a real "$0 wage /
// 0 employment" — the exact data-absence-as-zero masquerade the project forbids
// (the FDIC-CBLR-sentinel lesson applied to a CSV). The fix is a BLOCK-scoped,
// CODE-scoped, FIELD-specific mapper (NEVER a blanket 0→null): under 'N' the
// confidential emplvl/wage/avg-wkly fields → null while the establishment COUNT
// (qtrly_estabs / lq_qtrly_estabs) — AND the over-the-year establishment CHANGE
// (oty_qtrly_estabs_chg / _pct_chg) — stay DISCLOSED (real, live-confirmed real in
// 167/526 'N' rows); under '-' (or any other non-blank) the WHOLE block incl. the
// estabs field(s) → null; under blank a genuine reported/negative `0` SURVIVES
// (the disclosed federal taxable=0/contrib=0 and the oty_*_chg=0 "no change").
// ─── Fixed endpoint + transport constants (SSRF core — compile-time CONSTANTS) ──
const QCEW_HOST = "data.bls.gov";
/** A NEW self-throttle gate key — DELIBERATELY NOT "bls" (a different, un-rate-
 *  limited host; QCEW must not share the api.bls.gov ~25/day budget or serialize
 *  behind the timeseries tools). */
const QCEW_GATE_KEY = "bls_qcew";
const QCEW_MIN_INTERVAL_MS = 250;
/** Host-only error/endpoint label (never a token — QCEW is keyless anyway). */
const QCEW_LABEL = "data.bls.gov/cew";
/** Browser-ish UA — data.bls.gov/cew serves the keyless CSV to a normal client. */
const QCEW_UA = "Mozilla/5.0 (compatible; @cliwant/mcp-sam-gov; +https://github.com/cliwant/mcp-sam-gov)";
const QCEW_FETCH_TIMEOUT_MS = 30_000;
/**
 * Hard streamed read cap. The largest single slice observed is 3.84 MB
 * (industry/10.csv, all industries × all ~3,800 areas); a detailed-NAICS slice is
 * ~664 KB, an area slice ~100 KB–a few MB. 16 MB clears the max with ~4× headroom
 * AND catches a drifted giant. Applied to BOTH the declared content-length
 * (pre-check) AND the streamed read (abort past this bound) — never content-length
 * alone (ADR-0042 §S3, the OFAC readCappedBody replication).
 */
const MAX_QCEW_BYTES = 16 * 1024 * 1024;
/** QCEW Open Data coverage floor (a pre-coverage year is an honest per-tuple 404). */
const QCEW_YEAR_MIN = 1990;
/** The 42 PINNED column names, in exact order (ADR-0042 fact 2, live-verified). */
export const QCEW_COLUMNS = [
    "area_fips",
    "own_code",
    "industry_code",
    "agglvl_code",
    "size_code",
    "year",
    "qtr",
    "disclosure_code",
    "qtrly_estabs",
    "month1_emplvl",
    "month2_emplvl",
    "month3_emplvl",
    "total_qtrly_wages",
    "taxable_qtrly_wages",
    "qtrly_contributions",
    "avg_wkly_wage",
    "lq_disclosure_code",
    "lq_qtrly_estabs",
    "lq_month1_emplvl",
    "lq_month2_emplvl",
    "lq_month3_emplvl",
    "lq_total_qtrly_wages",
    "lq_taxable_qtrly_wages",
    "lq_qtrly_contributions",
    "lq_avg_wkly_wage",
    "oty_disclosure_code",
    "oty_qtrly_estabs_chg",
    "oty_qtrly_estabs_pct_chg",
    "oty_month1_emplvl_chg",
    "oty_month1_emplvl_pct_chg",
    "oty_month2_emplvl_chg",
    "oty_month2_emplvl_pct_chg",
    "oty_month3_emplvl_chg",
    "oty_month3_emplvl_pct_chg",
    "oty_total_qtrly_wages_chg",
    "oty_total_qtrly_wages_pct_chg",
    "oty_taxable_qtrly_wages_chg",
    "oty_taxable_qtrly_wages_pct_chg",
    "oty_qtrly_contributions_chg",
    "oty_qtrly_contributions_pct_chg",
    "oty_avg_wkly_wage_chg",
    "oty_avg_wkly_wage_pct_chg",
];
/** The expected column count. Passed as `maxCol` to parseRecordFields so a
 *  too-MANY-columns row materializes 43 fields and trips the drift check (the
 *  OFAC `maxCol=cols` SYMMETRY — `cols-1` would silently cap a column ADDITION). */
const QCEW_COLS = QCEW_COLUMNS.length; // 42
// ─── SSRF path-segment charclasses (validate PRE-interpolation) ──────────────
const QCEW_MODES = new Set(["area", "industry"]);
/** area_fips: county 01005, statewide 01000, national US000, MSA C1018, CSA
 *  CS122 — letter prefixes exist, so alphanumeric. Rejects `/` `.` `..` `%2F`
 *  `%2E` `%00` `@host` whitespace newline. */
const QCEW_AREA_RE = /^[0-9A-Za-z]{1,6}$/;
/** industry NAICS: STRICTLY digit-only. A hyphenated NAICS supersector
 *  (Manufacturing 31-33, Retail 44-45) 404s live (`industry/31-33.csv` → HTTP
 *  404) — a hyphen never resolves AND widens the SSRF charclass with a
 *  non-alphanumeric, so it is REJECTED (invalid_input pointing at the digit
 *  aggregate code), never silently stripped. */
const QCEW_INDUSTRY_RE = /^[0-9]{1,6}$/;
const QCEW_YEAR_RE = /^\d{4}$/;
/** quarter: ship 1-4 (all live-confirmed). The annual `a` is UNVERIFIED this
 *  cycle — NOT enabled (a live `…/a/…` 200 HEAD + a <16 MB size check must land
 *  first); the charclass would permit it safely via `^([1-4]|a)$` when enabled. */
const QCEW_QUARTER_RE = /^[1-4]$/;
/** Uniform invalid_input (host-only label, no token — QCEW is keyless). */
function qcewInvalid(message) {
    throw new ToolErrorCarrier({
        kind: "invalid_input",
        message,
        retryable: false,
        upstreamEndpoint: QCEW_LABEL,
    });
}
/**
 * ★ Build + validate the QCEW slice URL. Each caller-influenced path segment is
 * charclass-validated BEFORE interpolation; the host is a compile-time constant;
 * a post-construction `new URL` host/protocol assert locks it (the per-segment
 * charclass is the real guard — the hostname check alone does not stop a same-host
 * `../`). The client-side filters (ownership/aggregationLevel/sizeCode/narrow)
 * NEVER touch the URL — no SSRF surface. Pure fn (no fetch).
 */
export function buildQcewUrl(mode, year, quarter, code) {
    if (!QCEW_MODES.has(mode)) {
        qcewInvalid(`Cannot build QCEW URL: mode ${JSON.stringify(mode)} must be one of area, industry.`);
    }
    const y = String(year);
    if (!QCEW_YEAR_RE.test(y)) {
        qcewInvalid(`Cannot build QCEW URL: year ${JSON.stringify(y)} must be exactly 4 digits (^\\d{4}$).`);
    }
    const yr = Number(y);
    if (yr < QCEW_YEAR_MIN || yr > CURRENT_YEAR) {
        qcewInvalid(`Cannot build QCEW URL: year ${yr} is out of range ${QCEW_YEAR_MIN}..${CURRENT_YEAR} (a pre-coverage or future year is an absent slice; QCEW Open Data begins ~${QCEW_YEAR_MIN}).`);
    }
    const q = String(quarter);
    if (!QCEW_QUARTER_RE.test(q)) {
        qcewInvalid(`Cannot build QCEW URL: quarter ${JSON.stringify(q)} must be one of 1, 2, 3, 4 (the annual 'a' is not enabled this build).`);
    }
    if (mode === "area") {
        if (!QCEW_AREA_RE.test(code)) {
            qcewInvalid(`Cannot build QCEW URL: area ${JSON.stringify(code)} must be 1..6 alphanumeric chars (^[0-9A-Za-z]{1,6}$) — an area_fips like 01005 (county), 01000 (statewide), US000 (national), C1018 (MSA). Slashes/dots/encoded traversal are rejected (SSRF).`);
        }
    }
    else {
        if (!QCEW_INDUSTRY_RE.test(code)) {
            // Digit-only: a hyphenated NAICS supersector (e.g. 31-33, 44-45) 404s live
            // (industry/31-33.csv → HTTP 404) — pass the digit aggregate code instead.
            qcewInvalid(`Cannot build QCEW URL: industry ${JSON.stringify(code)} must be 1..6 DIGITS (^[0-9]{1,6}$) — a NAICS code like 5415 or the aggregate 10. A hyphenated NAICS supersector (31-33, 44-45) 404s on QCEW; use its digit aggregate code, not the hyphenated form.`);
        }
    }
    const url = `https://${QCEW_HOST}/cew/data/api/${y}/${q}/${mode}/${code}.csv`;
    const built = new URL(url);
    if (built.hostname !== QCEW_HOST || built.protocol !== "https:") {
        qcewInvalid(`Constructed QCEW URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${QCEW_HOST} over https — refusing to fetch (SSRF safety).`);
    }
    return built.toString();
}
// ─── Bounded streamed read (OFAC readCappedBody replication — ADR-0042 §S3) ──
/** Concatenate streamed chunks into one Uint8Array. */
function concatQcewChunks(chunks, total) {
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
    }
    return out;
}
/**
 * Read the response body with a HARD byte cap — abort past `maxBytes` rather than
 * trusting content-length alone. Streams via `res.body` when available (real
 * data.bls.gov), else falls back to `arrayBuffer()` + a post-read cap (the offline
 * fetch-mock, which exposes no stream). An over-cap read is a distinct honest
 * THROW, never a truncated body handed to the parser. Byte-for-byte the OFAC
 * idiom (replicated here — NO ofac.ts edit).
 */
async function readCappedQcewBody(res, maxBytes, label) {
    const tooBig = () => new ToolErrorCarrier({
        kind: "invalid_input",
        message: `QCEW ${label} body exceeded the ${Math.round(maxBytes / 1048576)} MB read cap — refusing to buffer it (a drifted giant, not the ≤~3.84 MB slices). Narrow by area/agglvl or verify the pinned endpoint.`,
        retryable: false,
        upstreamEndpoint: label,
    });
    const body = res.body;
    if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            if (value) {
                total += value.byteLength;
                if (total > maxBytes) {
                    try {
                        await reader.cancel();
                    }
                    catch {
                        /* ignore */
                    }
                    throw tooBig();
                }
                chunks.push(value);
            }
        }
        return concatQcewChunks(chunks, total);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes)
        throw tooBig();
    return buf;
}
// ─── RFC-4180 record assembler (replicated from ofac.ts/gsa-csv.ts — no edit) ──
/** Strip a trailing SUB (0x1A) + terminal newlines BEFORE record assembly. */
function stripTrailingSubQcew(body) {
    return body.replace(/[\r\n\x1a]+$/g, "");
}
/** Is a parsed record an empty (whitespace-only) non-content row? */
function isEmptyQcewRecord(fields) {
    return fields.every((f) => f.trim() === "");
}
/**
 * Assemble physical lines into LOGICAL CSV records via `parseRecordFields`
 * (gsa-csv), correctly re-joining a record whose quoted field contains a newline
 * (defense-in-depth — QCEW rows carry no embedded newlines observed). `maxCol =
 * QCEW_COLS` so a too-many-columns row materializes 43 fields and trips the drift
 * check (the OFAC symmetry). Empty rows (the trailing newline) are skipped.
 */
function assembleQcewRecords(body) {
    const text = stripTrailingSubQcew(body);
    const lines = text.split("\n");
    const records = [];
    let pending = null;
    for (const line of lines) {
        const candidate = pending === null ? line : pending + "\n" + line;
        const res = parseRecordFields(candidate, QCEW_COLS);
        if (res.inQuotes) {
            pending = candidate;
            continue;
        }
        pending = null;
        if (isEmptyQcewRecord(res.fields))
            continue;
        records.push(res.fields);
    }
    if (pending !== null) {
        const res = parseRecordFields(pending, QCEW_COLS);
        if (!isEmptyQcewRecord(res.fields))
            records.push(res.fields);
    }
    return records;
}
/**
 * ★ M2 — the header drift assertion runs POST-parse (on the quote-STRIPPED
 * record). The live QCEW header is FULLY double-quoted (`"area_fips","own_code",…`);
 * `parseRecordFields` strips the RFC-4180 quotes, so the parsed first record is the
 * 42 UNQUOTED names — compared here against the pinned array, NEVER the raw
 * pre-parse line / split(","). A missing / renamed / added / removed / reordered
 * header → schema_drift (a shifted schema must NEVER be read positionally — that
 * would map avg_wkly_wage values under total_qtrly_wages).
 */
function assertQcewHeader(headerFields, label) {
    const drift = headerFields.length !== QCEW_COLS ||
        QCEW_COLUMNS.some((name, i) => headerFields[i] !== name);
    if (drift) {
        throw driftError(label, `QCEW header drifted — expected the pinned ${QCEW_COLS} columns in order but got ${headerFields.length} column(s): [${headerFields.slice(0, 45).join(", ")}]. Refusing to read a renamed/added/removed/reordered schema positionally (a shifted header would map wage values under the wrong field).`);
    }
}
/**
 * BASE block (rec cols 7–15), governed by `disclosure_code` (rec[7]).
 *  - blank (disclosed) → EVERY field via num (a genuine reported 0 SURVIVES).
 *  - 'N' → qtrly_estabs REAL (via num); the 6 emplvl/wage/avg-wkly fields → null.
 *  - '-' or any OTHER non-blank → the WHOLE base block incl qtrly_estabs → null.
 */
function mapBaseBlock(rec) {
    const disc = str(rec[7]);
    const disclosed = disc === null;
    // The establishment COUNT is non-confidential: disclosed under blank OR 'N',
    // but withheld under '-'/other (the whole block goes null).
    const estabsDisclosed = disclosed || disc === "N";
    return {
        disclosed,
        disclosureCode: disc,
        qtrly_estabs: estabsDisclosed ? num(rec[8]) : null,
        month1_emplvl: disclosed ? num(rec[9]) : null,
        month2_emplvl: disclosed ? num(rec[10]) : null,
        month3_emplvl: disclosed ? num(rec[11]) : null,
        total_qtrly_wages: disclosed ? num(rec[12]) : null,
        taxable_qtrly_wages: disclosed ? num(rec[13]) : null,
        qtrly_contributions: disclosed ? num(rec[14]) : null,
        avg_wkly_wage: disclosed ? num(rec[15]) : null,
    };
}
/**
 * LQ block (rec cols 16–24, ratios), governed by `lq_disclosure_code` (rec[16]).
 * IDENTICAL field-specific rule as the base block: under 'N' lq_qtrly_estabs is
 * DISCLOSED (a real ratio) and the rest → null; under '-'/other → whole block
 * null; under blank → all via num.
 */
function mapLqBlock(rec) {
    const disc = str(rec[16]);
    const disclosed = disc === null;
    const estabsDisclosed = disclosed || disc === "N";
    return {
        disclosed,
        disclosureCode: disc,
        lq_qtrly_estabs: estabsDisclosed ? num(rec[17]) : null,
        lq_month1_emplvl: disclosed ? num(rec[18]) : null,
        lq_month2_emplvl: disclosed ? num(rec[19]) : null,
        lq_month3_emplvl: disclosed ? num(rec[20]) : null,
        lq_total_qtrly_wages: disclosed ? num(rec[21]) : null,
        lq_taxable_qtrly_wages: disclosed ? num(rec[22]) : null,
        lq_qtrly_contributions: disclosed ? num(rec[23]) : null,
        lq_avg_wkly_wage: disclosed ? num(rec[24]) : null,
    };
}
/**
 * ★ M1 — OTY block (rec cols 25–41, over-the-year changes/pct-changes), governed
 * by `oty_disclosure_code` (rec[25]). The OTY block has the SAME establishment
 * exception as base/lq: under 'N', BOTH oty_qtrly_estabs_chg AND
 * oty_qtrly_estabs_pct_chg are DISCLOSED via num (a real value / a negative / a
 * genuine-0 "no change" SURVIVES — live-confirmed real in 167/526 'N' rows), while
 * the 14 employment/wage oty fields → null. Under '-' or any OTHER non-blank → the
 * WHOLE oty block INCLUDING the estabs-change pair → null (conservative; OTY '-'
 * was not observed — the exception is NOT extended to '-'). Under blank → all via
 * num so a genuine 0/negative survives.
 */
function mapOtyBlock(rec) {
    const disc = str(rec[25]);
    const disclosed = disc === null;
    const estabsChgDisclosed = disclosed || disc === "N";
    return {
        disclosed,
        disclosureCode: disc,
        oty_qtrly_estabs_chg: estabsChgDisclosed ? num(rec[26]) : null,
        oty_qtrly_estabs_pct_chg: estabsChgDisclosed ? num(rec[27]) : null,
        oty_month1_emplvl_chg: disclosed ? num(rec[28]) : null,
        oty_month1_emplvl_pct_chg: disclosed ? num(rec[29]) : null,
        oty_month2_emplvl_chg: disclosed ? num(rec[30]) : null,
        oty_month2_emplvl_pct_chg: disclosed ? num(rec[31]) : null,
        oty_month3_emplvl_chg: disclosed ? num(rec[32]) : null,
        oty_month3_emplvl_pct_chg: disclosed ? num(rec[33]) : null,
        oty_total_qtrly_wages_chg: disclosed ? num(rec[34]) : null,
        oty_total_qtrly_wages_pct_chg: disclosed ? num(rec[35]) : null,
        oty_taxable_qtrly_wages_chg: disclosed ? num(rec[36]) : null,
        oty_taxable_qtrly_wages_pct_chg: disclosed ? num(rec[37]) : null,
        oty_qtrly_contributions_chg: disclosed ? num(rec[38]) : null,
        oty_qtrly_contributions_pct_chg: disclosed ? num(rec[39]) : null,
        oty_avg_wkly_wage_chg: disclosed ? num(rec[40]) : null,
        oty_avg_wkly_wage_pct_chg: disclosed ? num(rec[41]) : null,
    };
}
/** Map ONE parsed 42-field record → a disclosure-aware output row. */
export function mapQcewRow(rec) {
    return {
        area_fips: str(rec[0]),
        own_code: str(rec[1]),
        industry_code: str(rec[2]),
        agglvl_code: str(rec[3]),
        size_code: str(rec[4]),
        base: mapBaseBlock(rec),
        locationQuotient: mapLqBlock(rec),
        overTheYear: mapOtyBlock(rec),
    };
}
// ─── QCEW honesty note constants ─────────────────────────────────────────────
const QCEW_SUPPRESSION_NOTE = "BLS QCEW WITHHOLDS employment/wage values for confidentiality when too few establishments would be identifiable. A suppressed field is null with disclosed:false and its disclosureCode ('N' = not disclosable / confidential; '-' = not available) — it is WITHHELD, NOT zero. qtrly_estabs / lq_qtrly_estabs and oty_qtrly_estabs_chg / oty_qtrly_estabs_pct_chg remain DISCLOSED under 'N' (establishment counts and their change are non-confidential) but are withheld under '-'. Do NOT read a null as 0, and do NOT sum/average across rows treating suppressed cells as zero.";
const QCEW_MIXED_AGGLVL_NOTE = "This slice MIXES aggregation levels (agglvl_code, e.g. 70=total-all-industries down to 78=6-digit-NAICS-by-ownership) and ownerships (own_code, incl. 0=Total, 1=Federal, 2=State, 3=Local, 5=Private). Do NOT sum qtrly_estabs/employment/wages across different agglvl_code, or across own_code=0 plus its parts — that double-counts. Filter to ONE agglvl_code (and one ownership) for a coherent total.";
const QCEW_LQ_RATIO_NOTE = "Location-quotient (lq_*) fields are a RATIO vs the national average (1.00 = same concentration as the nation; >1.00 = MORE concentrated here = higher specialization / competition density; <1.00 = less), each governed by its own lq_disclosure_code.";
/** Uniform base for a client-side filter descriptor. */
function qcewTrimEq(cell, want) {
    return (cell ?? "").trim() === want.trim();
}
/**
 * ★ `bls_qcew` — keyless QCEW county×NAICS market-size / wages / location-quotient,
 * disclosure-aware. Fetches ONE slice CSV (fetch-once — QCEW does not paginate),
 * parses ALL rows through the symmetric column-drift guard + the POST-parse header
 * assertion, applies the CLIENT-SIDE filters (ownership/aggregationLevel/sizeCode +
 * the narrow industry/area), windows with limit/offset, and maps each page row
 * through the block/code/field-scoped disclosure mapper (suppressed → null NEVER 0;
 * a genuine 0 survives). A per-tuple HTTP 404 → an honest empty (found:false), a
 * 5xx/timeout → THROW, a 200 non-CSV / drifted header → schema_drift THROW. No
 * BLS_API_KEY is read on this keyless path.
 */
export async function qcew(args) {
    const label = QCEW_LABEL;
    const mode = String(args.mode ?? "");
    if (!QCEW_MODES.has(mode)) {
        qcewInvalid(`mode ${JSON.stringify(args.mode)} must be one of area, industry.`);
    }
    // The path code + the OPTIONAL client-side narrow (the OTHER field). In area
    // mode: `area` is the required path segment, `industry` is an optional narrow
    // filter; in industry mode the roles swap.
    let pathCode;
    let narrowField = null;
    let narrowValue = null;
    if (mode === "area") {
        pathCode = String(args.area ?? "");
        if (!QCEW_AREA_RE.test(pathCode)) {
            qcewInvalid(`area ${JSON.stringify(args.area)} is required for mode=area and must be 1..6 alphanumeric chars (^[0-9A-Za-z]{1,6}$) — an area_fips like 01005.`);
        }
        if (args.industry !== undefined && args.industry !== null && String(args.industry) !== "") {
            const narrow = String(args.industry);
            if (!QCEW_INDUSTRY_RE.test(narrow)) {
                qcewInvalid(`industry (client-side narrow) ${JSON.stringify(args.industry)} must be 1..6 DIGITS (^[0-9]{1,6}$) — a NAICS code like 5415. A hyphenated NAICS is rejected.`);
            }
            narrowField = "industry_code";
            narrowValue = narrow;
        }
    }
    else {
        pathCode = String(args.industry ?? "");
        if (!QCEW_INDUSTRY_RE.test(pathCode)) {
            qcewInvalid(`industry ${JSON.stringify(args.industry)} is required for mode=industry and must be 1..6 DIGITS (^[0-9]{1,6}$) — a NAICS code like 5415 or the aggregate 10. A hyphenated NAICS supersector (31-33) 404s; use its digit aggregate code.`);
        }
        if (args.area !== undefined && args.area !== null && String(args.area) !== "") {
            const narrow = String(args.area);
            if (!QCEW_AREA_RE.test(narrow)) {
                qcewInvalid(`area (client-side narrow) ${JSON.stringify(args.area)} must be 1..6 alphanumeric chars (^[0-9A-Za-z]{1,6}$) — an area_fips like 01005.`);
            }
            narrowField = "area_fips";
            narrowValue = narrow;
        }
    }
    const year = args.year;
    if (typeof year !== "number" || !Number.isFinite(year)) {
        qcewInvalid("year is required and must be a 4-digit integer (e.g. 2023).");
    }
    const quarter = String(args.quarter ?? "");
    // buildQcewUrl re-validates every path segment (year range / quarter / code /
    // mode) + the fixed-host assert (belt-and-suspenders behind the checks above).
    const url = buildQcewUrl(mode, year, quarter, pathCode);
    const ownership = str(args.ownership);
    const aggregationLevel = str(args.aggregationLevel);
    const sizeCode = str(args.sizeCode);
    const limit = Math.min(1000, Math.max(1, Math.floor(args.limit ?? 50)));
    const offset = Math.max(0, Math.floor(args.offset ?? 0));
    // filtersApplied — mode/year/quarter always; + client-side filters when set.
    const filtersApplied = [
        `mode:${mode}`,
        `${mode}:${pathCode}`,
        `year:${year}`,
        `quarter:${quarter}`,
    ];
    if (ownership !== null)
        filtersApplied.push(`ownership:${ownership}`);
    if (aggregationLevel !== null)
        filtersApplied.push(`aggregationLevel:${aggregationLevel}`);
    if (sizeCode !== null)
        filtersApplied.push(`sizeCode:${sizeCode}`);
    if (narrowField && narrowValue !== null)
        filtersApplied.push(`narrow ${narrowField}:${narrowValue}`);
    // ── Fetch the slice through the NEW self-throttle gate (keyless; NO
    //    BLS_API_KEY). A per-tuple 404 (not_found) → honest empty; every other
    //    failure THROWS (never a fake empty). ──
    let body;
    try {
        body = await throughGate(QCEW_GATE_KEY, QCEW_MIN_INTERVAL_MS, () => fetchQcewCsv(url, label));
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
            // The slice file does not exist (nonexistent area/naics, an unpublished /
            // pre-coverage quarter) — an ABSENT slice, NOT zero establishments. The HTML
            // 404 body was NEVER parsed (classified on status before any read).
            return withMeta({ found: false, mode, code: pathCode, [mode]: pathCode, year, quarter, rows: [] }, {
                source: qcewSource(),
                keylessMode: true,
                complete: true,
                returned: 0,
                totalAvailable: 0,
                filtersApplied,
                filtersDropped: [],
                fieldsUnavailable: [],
                notes: [
                    `No QCEW slice exists for ${mode} ${pathCode}, ${year} Q${quarter} (HTTP 404). The ${mode === "area" ? "area_fips" : "NAICS"} code may not exist, or the quarter may be unpublished / before coverage — this is an ABSENT slice, NOT zero establishments. Verify the code and that the quarter is published.`,
                ],
            });
        }
        throw e;
    }
    // ── Parse: assemble records → assert the header (POST-parse, quote-stripped) →
    //    symmetric per-row field-count guard. ──
    const records = assembleQcewRecords(body);
    if (records.length === 0) {
        throw driftError(label, "QCEW returned a 200 text/csv body with no parseable records (no header) — treating as schema drift (never a fake empty).");
    }
    assertQcewHeader(records[0] ?? [], label);
    const contentRecords = records.slice(1);
    let rowNo = 0;
    for (const rec of contentRecords) {
        rowNo++;
        if (rec.length !== QCEW_COLS) {
            throw driftError(label, `QCEW content row ${rowNo} has ${rec.length} column(s), expected exactly ${QCEW_COLS} — the download was truncated (too few) or the file schema drifted (a column added/removed, too many). Refusing to read a truncated OR column-shifted slice.`);
        }
    }
    // ── Client-side filters (fetch-once → filter → EXACT filtered total). ──
    const rawCount = contentRecords.length;
    const filtered = contentRecords.filter((rec) => {
        if (ownership !== null && !qcewTrimEq(rec[1], ownership))
            return false;
        if (aggregationLevel !== null && !qcewTrimEq(rec[3], aggregationLevel))
            return false;
        if (sizeCode !== null && !qcewTrimEq(rec[4], sizeCode))
            return false;
        if (narrowField === "industry_code" && narrowValue !== null && !qcewTrimEq(rec[2], narrowValue))
            return false;
        if (narrowField === "area_fips" && narrowValue !== null && !qcewTrimEq(rec[0], narrowValue))
            return false;
        return true;
    });
    const totalAvailable = filtered.length;
    // ── Client-side window (preserve upstream order) → the page rows. ──
    const pageRecords = filtered.slice(offset, offset + limit);
    const rows = pageRecords.map(mapQcewRow);
    const returned = rows.length;
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    // ── Honesty surface: suppressed field names + the conditional notes. ──
    const suppressedFields = new Set();
    let anySuppressed = false;
    const distinctAgglvl = new Set();
    const distinctOwn = new Set();
    for (const r of rows) {
        if (r.agglvl_code !== null)
            distinctAgglvl.add(r.agglvl_code);
        if (r.own_code !== null)
            distinctOwn.add(r.own_code);
        for (const [block, keys] of [
            [r.base, ["qtrly_estabs", "month1_emplvl", "month2_emplvl", "month3_emplvl", "total_qtrly_wages", "taxable_qtrly_wages", "qtrly_contributions", "avg_wkly_wage"]],
            [r.locationQuotient, ["lq_qtrly_estabs", "lq_month1_emplvl", "lq_month2_emplvl", "lq_month3_emplvl", "lq_total_qtrly_wages", "lq_taxable_qtrly_wages", "lq_qtrly_contributions", "lq_avg_wkly_wage"]],
            [r.overTheYear, ["oty_qtrly_estabs_chg", "oty_qtrly_estabs_pct_chg", "oty_month1_emplvl_chg", "oty_month1_emplvl_pct_chg", "oty_month2_emplvl_chg", "oty_month2_emplvl_pct_chg", "oty_month3_emplvl_chg", "oty_month3_emplvl_pct_chg", "oty_total_qtrly_wages_chg", "oty_total_qtrly_wages_pct_chg", "oty_taxable_qtrly_wages_chg", "oty_taxable_qtrly_wages_pct_chg", "oty_qtrly_contributions_chg", "oty_qtrly_contributions_pct_chg", "oty_avg_wkly_wage_chg", "oty_avg_wkly_wage_pct_chg"]],
        ]) {
            if (block.disclosed === false) {
                anySuppressed = true;
                for (const k of keys)
                    if (block[k] === null)
                        suppressedFields.add(k);
            }
        }
    }
    const notes = [];
    if (anySuppressed)
        notes.push(QCEW_SUPPRESSION_NOTE);
    if (distinctAgglvl.size >= 2 || distinctOwn.size >= 2)
        notes.push(QCEW_MIXED_AGGLVL_NOTE);
    notes.push(QCEW_LQ_RATIO_NOTE);
    notes.push(`Parsed ${rawCount} content row(s) for this ${mode} slice; after filters → ${totalAvailable} pageable; totalAvailable reflects the FILTERED set (not the page length). The full slice was fetched in ONE request (QCEW does not paginate); limit/offset is a client-side window.`);
    const metaOut = {
        source: qcewSource(),
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [...suppressedFields],
        pagination: { offset, limit, nextOffset, hasMore },
        notes,
    };
    return withMeta({ found: true, mode, code: pathCode, [mode]: pathCode, year, quarter, rows }, metaOut);
}
/** The QCEW source label (mirrors blsSource(); keyless CSV domain). */
function qcewSource() {
    return "data.bls.gov/cew QCEW Open Data Access (keyless CSV)";
}
/**
 * Fetch ONE QCEW slice CSV. Order: fetch(redirect:"error") → check status
 * (404 → not_found kind, caught by the caller for an honest empty; 5xx/429 →
 * throw; off-host redirect → schema_drift) → assert text/csv → content-length
 * pre-check → readCappedBody → decode. Every failure THROWS a classified error
 * (never a fake empty); the HTML 404 body is NEVER read (classified on status).
 */
async function fetchQcewCsv(url, label) {
    let res;
    try {
        res = await fetch(url, {
            headers: { "User-Agent": QCEW_UA, Accept: "text/csv, */*" },
            redirect: "error",
            signal: AbortSignal.timeout(QCEW_FETCH_TIMEOUT_MS),
        });
    }
    catch (e) {
        if (isRedirectError(e)) {
            // Fail closed — never follow an off-host redirect, never read its body.
            throw driftError(label, `QCEW ${label} refused an off-host redirect (redirect:"error") — the fixed host ${QCEW_HOST} must serve the CSV directly (SSRF safety).`);
        }
        // timeout / abort / network — retryable OUTAGE (THROW — never a fake empty).
        throw new ToolErrorCarrier({
            kind: "upstream_unavailable",
            message: `Network error fetching QCEW ${label}: ${e.message}. The service is unavailable, NOT an empty slice — retry.`,
            retryable: true,
            retryAfterSeconds: 30,
            upstreamEndpoint: label,
        });
    }
    if (!res.ok) {
        // 404 → not_found (the caller renders an honest empty); 429 → rate_limited;
        // 5xx → upstream_unavailable; 4xx → invalid_input. A DOWN endpoint NEVER
        // reads empty; the HTML 404 body is never read (classified on status here).
        throw new ToolErrorCarrier(errorFromResponse(res, label));
    }
    // ★ M2 — the ONLY pre-parse content check is the text/csv Content-Type metadata
    // guard; the header-name assertion runs POST-parse (assertQcewHeader). A 200
    // whose Content-Type is not text/csv (an HTML interstitial slipping through at
    // 200) → schema_drift (never read as data).
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/csv/i.test(ct)) {
        throw driftError(label, `QCEW ${label} returned HTTP 200 with Content-Type ${JSON.stringify(ct)} (not text/csv) — refusing to read a non-CSV 200 body as data (schema drift).`);
    }
    // Size guard (content-length) BEFORE buffering — belt to the streamed cap.
    const declaredLen = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declaredLen) && declaredLen > MAX_QCEW_BYTES) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `QCEW ${label} declares ${Math.round(declaredLen / 1048576)} MB, over this tool's ${Math.round(MAX_QCEW_BYTES / 1048576)} MB per-slice cap — refusing (a drifted giant, not the ≤~3.84 MB slices). Narrow by area/agglvl.`,
            retryable: false,
            upstreamEndpoint: label,
        });
    }
    const bytes = await readCappedQcewBody(res, MAX_QCEW_BYTES, label);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
//# sourceMappingURL=bls.js.map