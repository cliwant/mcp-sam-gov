/**
 * EPA ECHO REST services — keyless facility environmental compliance / enforcement
 * screening (ADR-0009). A NEW capability axis for the product: facility &
 * competitor environmental compliance-risk screening / due diligence (EPA
 * enforcement, inspection, violation, and penalty history keyed to a facility),
 * orthogonal to the spend/contract/regulatory layers.
 *
 * The THIRD source on the R2 `DataSource` port (ADR-0005, after Socrata/CKAN):
 * `echo.ts` writes ZERO fetch/coercion/error code — it REUSES `getJson` /
 * `driftError` / `num`·`str` / `withMeta`, and COPIES (does NOT import) the
 * fixed-host SSRF + honesty PATTERN. Fully PUBLIC, KEYLESS (`keylessMode:true`,
 * byte-clean init — NO headers, like ckan.ts). ECHO is neither Socrata nor CKAN:
 * it is a bespoke Oracle-PL/SQL-fronted REST facade with a TWO-STEP QueryID
 * pagination model and a 200-with-error-body failure mode.
 *
 *   Step 1 (search):  https://echodata.epa.gov/echo/echo_rest_services.get_facilities?output=JSON&p_st=…
 *                     → { Results:{ Message, QueryRows:"N", …counts…, QueryID:"n" } }  (NO rows)
 *   Step 2 (rows):    https://echodata.epa.gov/echo/echo_rest_services.get_qid?output=JSON&qid=n&pageno=k
 *                     → { Results:{ Message:"Working", Facilities:[ …rows… ] } }
 *   Detail (DFR):     https://echodata.epa.gov/echo/dfr_rest_services.get_dfr?output=JSON&p_id={RegistryID}
 *                     → { Results:{ Message:"Success", RegistryID, Reports, Permits, … } }
 *
 * ★ SSRF GUARD (policy① — the central design risk; a TIGHTER copy of the
 *   Socrata/CKAN fixed-host shape). The attack surface is SMALLER than CKAN's:
 *   (1) SINGLE fixed host constant `ECHO_HOST` — the caller NEVER supplies a host.
 *   (2) THREE fixed service-path constants (a frozen Set) — the caller NEVER
 *       supplies a path fragment; a service outside the Set ⇒ invalid_input before
 *       any fetch (the path-injection guard).
 *   (3) Every interpolated id is grammar-validated BEFORE use — `state` ∈ a frozen
 *       US state/territory enum (also the silent-zero guard, below); `naics`
 *       ^[0-9]{2,6}$ / `sic` ^[0-9]{2,4}$; `registryId` ^[0-9]{9,12}$ (FRS IDs are
 *       12 digits; all-digit is the security property); the UPSTREAM-supplied
 *       `qid` is validated ^[0-9]+$ BECAUSE it is external (echodata.epa.gov mints
 *       it), before it is used in step 2; the internally-computed `pageno` is a
 *       plain integer. `facilityName` (p_fn) is a free-text filter VALUE — encoded
 *       through URLSearchParams, never touching the host/path.
 *   (4) Construct the URL, then ASSERT `new URL(built).hostname === ECHO_HOST` and
 *       `protocol === "https:"` ⇒ invalid_input on mismatch (belt-and-suspenders).
 *   B1 (redirect SSRF): every getJson sets `redirect:"error"` — a 3xx off
 *   echodata.epa.gov (migration / DNS-hijack / reused domain) throws; its body is
 *   never read. Adding a service/filter later = a CONSTANT edit + a live
 *   `output=JSON` verification — NEVER a free runtime host/path param.
 *
 * ★ 200-WITH-ERROR-BODY (the fake-empty trap — OBSERVED live, not defensive).
 *   A bogus `qid`, a bad DFR `p_id`, AND a queryset-limit overflow all return HTTP
 *   200 carrying `{Results:{Error:{ErrorMessage}}}`. `errorFromResponse` keys off
 *   HTTP status and would pass a 200 straight through. So on EVERY response we
 *   detect `Results.Error` FIRST and THROW (classified) BEFORE reading
 *   QueryRows/Facilities — the ECHO analogue of CKAN's success:false-on-200 guard.
 *   Classification (by ErrorMessage):
 *     - "Queryset Limit would be exceeded"  ⇒ invalid_input (narrow the query)
 *     - "…not found in ECHO"  (recycled qid) ⇒ not_found, RETRYABLE (the QueryID
 *        is an ephemeral globally-recycled slot — a transient, not a missing
 *        facility; retry echo_search_facilities)
 *     - "ID … is invalid"  (bad DFR id)      ⇒ not_found (no report for that id)
 *     - anything else                        ⇒ schema_drift (surfaced, never
 *        silently swallowed)
 *
 * ★ TWO-STEP HIDDEN IN-CALL (ADR-0009 §1a). The QueryID is an ephemeral,
 *   globally-recycled, monotonically-incrementing cache slot (live-verified:
 *   IDs jumped 835→909 across a handful of calls) — NOT deterministic, NOT safe to
 *   persist across tool calls. `echo_search_facilities` therefore performs BOTH
 *   steps inside ONE invocation (get_facilities → capture QueryRows + fresh
 *   QueryID → immediately get_qid at the requested page) and NEVER exposes the
 *   QueryID to the caller. Paginating to page N re-runs get_facilities fresh.
 *   Two HTTP round-trips per search; robust against id recycling (memoize is
 *   unsafe here). Pagination is the standard offset/limit contract, translated to
 *   `pageno = offset/limit + 1` and `responseset = limit`; because ECHO can only
 *   page on page boundaries, `offset` MUST be an exact multiple of `limit`
 *   (else invalid_input locally, before any fetch).
 *
 * ★ M2 — NAICS vs SIC filtering, LIVE-VERIFIED 2026-07-12 (the data-lie guard).
 *   `p_st=DC` bare ⇒ QueryRows 4714. `p_st=DC&p_naics=325` / `=32511` / `=54` /
 *   even a bogus `=999999` ALL returned the identical 4714 ⇒ ECHO DROPS NAICS
 *   entirely (a real filter would return 0 for a nonexistent code). BUT
 *   `p_st=DC&p_sic=2911` ⇒ 1 and `&p_sic=9999`/`=8011` ⇒ 0 ⇒ SIC DOES narrow.
 *   So the two behave DIFFERENTLY (a MIXED outcome — a deviation from the ADR's
 *   unified Case-A/B framing):
 *     - `sic`   = Case A (works)   ⇒ a REAL filter; listed in filtersApplied.
 *     - `naics` = Case B (dropped) ⇒ BEST-EFFORT: marked best-effort in the
 *       tool-schema description, added to `_meta.filtersDropped` whenever passed,
 *       AND a `_meta.notes` disclosure warns the returned facilities are NOT
 *       guaranteed to match the NAICS code. NEVER silently presented as filtered.
 *
 * ★ HONESTY (`_meta`; REUSE withMeta/buildMeta). `totalAvailable = num(QueryRows)`
 *   — the EXACT upstream total, NEVER the page size. `returned =
 *   Results.Facilities.length`. `hasMore = offset + returned < total` (exact — no
 *   page-fullness hedge). Genuine-empty (`QueryRows:"0"`, no Results.Error) ⇒
 *   complete:true / totalAvailable:0. Outage/5xx/timeout ⇒ getJson throws (never a
 *   fake empty). `num`/`str` are null-never-0. Row-level currency/count fields
 *   (e.g. TotalPenalties "$1,056,616") pass through VERBATIM.
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` from this module (echo.num === coerce.num === socrata.num === ckan.num).
export { num };

// ─── SSRF core: the single fixed host + three fixed service paths ──
const ECHO_HOST = "echodata.epa.gov";
const ECHO_BASE = `https://${ECHO_HOST}/echo/`;

// The ONLY three service paths we ever build (frozen constants — the caller never
// supplies a path fragment). A service outside this Set ⇒ invalid_input (the
// path-injection guard). get_facilities/get_qid live on echo_rest_services;
// get_dfr on dfr_rest_services.
const SVC_FACILITIES = "echo_rest_services.get_facilities";
const SVC_QID = "echo_rest_services.get_qid";
const SVC_DFR = "dfr_rest_services.get_dfr";
const ECHO_SERVICES: ReadonlySet<string> = new Set([
  SVC_FACILITIES,
  SVC_QID,
  SVC_DFR,
]);

// ─── Client-side value grammars (the silent-zero + SSRF guards) ───
// ECHO does NOT validate filter VALUES: an unknown value silently returns
// QueryRows:"0" (indistinguishable from a genuine-empty). So we validate
// client-side: `state` against the enum below (surfaced by the Zod enum in
// server.ts), naics/sic against a digit-length grammar, registryId all-digit.
const NAICS_RE = /^[0-9]{2,6}$/;
const SIC_RE = /^[0-9]{2,4}$/;
const REGISTRY_ID_RE = /^[0-9]{9,12}$/;
// The UPSTREAM-supplied QueryID — validated BECAUSE it is external (echodata mints
// it), before it is used to build the step-2 URL.
const QID_RE = /^[0-9]+$/;

// The frozen US state/territory enum (50 states + DC + the 5 territories). Built
// FROM this array by the Zod enum in server.ts (single source of truth); it is
// BOTH the SSRF value guard and the silent-zero guard (§1c-2).
export const ECHO_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
  "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
  "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI",
  "WY", "AS", "GU", "MP", "PR", "VI",
] as const;

export type EchoState = (typeof ECHO_STATES)[number];

// ─── Notes (honesty disclosures — ADR-0009 v2 required set) ───────
const DATA_CURRENCY_NOTE =
  "ECHO Version 'ALL DATA v2017-06-16' is the schema-version label, not a data cutoff; data is refreshed weekly and current through 2026 (live-verified).";
const FACILITY_NAME_NOTE =
  "facility-name filter (p_fn) is not validated by ECHO — a typo silently returns 0 results, not an error; verify spelling if the result is empty.";
const NAICS_BEST_EFFORT_NOTE =
  "ECHO did not narrow by NAICS at this (or any) scale — the p_naics filter is dropped upstream (live-verified 2026-07-12) — so the returned facilities are NOT guaranteed to match the NAICS code; naics is listed in _meta.filtersDropped. Use `sic` (which DOES narrow), facilityName, majorOnly, or federalOnly to scope by industry/type, and verify NAICS client-side.";
const NUMERIC_STRING_NOTE =
  "Count/amount fields arrive as strings; QueryRows is coerced for the exact total, but row-level currency fields (e.g. TotalPenalties '$1,056,616') keep their $/comma formatting — parse client-side. A missing value is null, never 0.";
const TWO_STEP_NOTE =
  "Results are the ECHO all-program facility compliance search (CAA/CWA/RCRA/SDWA); totalAvailable is the EXACT QueryRows total; rows are fetched via a hidden two-step QueryID pagination (the QueryID is ephemeral/globally-recycled and never exposed).";

const SOURCE = `${ECHO_HOST} via ECHO REST (keyless)`;

// ─── fetch layer (SSRF-guarded; reuses the R2 port) ───────────────
export type EchoRow = Record<string, unknown>;

/**
 * GET one ECHO REST service. SSRF guard: `service` ∈ the frozen 3-member Set
 * (the path-injection guard), params via URLSearchParams (encoded values, no
 * host-alteration surface), then the CONSTRUCTED URL's hostname === ECHO_HOST
 * (https) assertion. Sets `redirect:"error"` (B1); NO headers (keyless — ECHO is
 * anonymous, byte-clean init). Reuses errors.ts retry/timeout/taxonomy (429 →
 * rate_limited; 5xx → upstream_unavailable; 404 → not_found; 400 → invalid_input).
 * Returns the parsed JSON (unknown; the caller validates the Results envelope).
 */
export async function echoGet(
  service: string,
  params: URLSearchParams,
): Promise<unknown> {
  if (!ECHO_SERVICES.has(service)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `ECHO service ${JSON.stringify(service)} is not one of the three fixed service paths (get_facilities / get_qid / get_dfr) — refusing to fetch (SSRF path guard).`,
      retryable: false,
    });
  }
  const url = `${ECHO_BASE}${service}?${params.toString()}`;
  // Belt-and-suspenders: the FIXED host + FIXED service leave nothing to steer the
  // authority; assert the built URL cannot have been moved off-host.
  const built = new URL(url);
  if (built.hostname !== ECHO_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed ECHO URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${ECHO_HOST} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
    });
  }
  // Shared fetch envelope (ADR-0005): keyless ⇒ NO headers key (byte-clean init);
  // B1 redirect:"error"; the label surfaces as ToolError.upstreamEndpoint.
  return getJson(url, { label: "echo:" + service, redirect: "error" });
}

// ─── Results envelope + the 200-with-error-body guard ─────────────
type EchoResults = Record<string, unknown>;

/** Unwrap `{Results:{…}}`; a missing/non-object Results is schema drift. */
function unwrapResults(service: string, body: unknown): EchoResults {
  const r = (body as { Results?: unknown } | null | undefined)?.Results;
  if (r === null || typeof r !== "object" || Array.isArray(r)) {
    throw driftError(
      "echo:" + service,
      `echo:${service} returned an unexpected shape (missing Results object).`,
    );
  }
  return r as EchoResults;
}

/**
 * The 200-with-error-body guard (§1c-1). If `Results.Error` is present, classify
 * by ErrorMessage and THROW (never read QueryRows/Facilities). This MUST run on
 * every response BEFORE any record access — a bogus qid / bad DFR id / queryset
 * overflow all return HTTP 200 carrying the error, so the HTTP-status taxonomy
 * never sees it.
 */
function guardResultsError(service: string, results: EchoResults): void {
  const err = (results as { Error?: unknown }).Error;
  if (err === undefined || err === null) return;
  const label = "echo:" + service;
  const msg =
    str((err as { ErrorMessage?: unknown }).ErrorMessage) ??
    (typeof err === "string" ? str(err) : null) ??
    "(no ErrorMessage)";

  // M1 — a queryset-limit overflow is a known upstream ADVISORY, not a schema
  // regression. Map to invalid_input with actionable guidance. (naics is dropped
  // upstream — M2 — so it is NOT suggested as a narrowing filter.)
  if (msg.includes("Queryset Limit would be exceeded")) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `ECHO queryset limit exceeded — the query would return too many facilities. Narrow with sic, facilityName, majorOnly, or federalOnly (note: naics is ignored by ECHO). Upstream: ${msg}`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }
  // A recycled/unknown QueryID on the get_qid path (m6). The QueryID is an
  // ephemeral globally-recycled slot — a transient, NOT a missing facility.
  if (/not found in ECHO/i.test(msg)) {
    throw new ToolErrorCarrier({
      kind: "not_found",
      message: `ECHO QueryID was recycled by concurrent traffic before the page fetch (ephemeral shared slot); retry echo_search_facilities — this is a transient, not a missing facility. Upstream: ${msg}`,
      retryable: true,
      upstreamEndpoint: label,
    });
  }
  // A bad DFR RegistryID ⇒ no Detailed Facility Report for that id ⇒ not_found.
  if (/is invalid/i.test(msg)) {
    throw new ToolErrorCarrier({
      kind: "not_found",
      message: `ECHO has no Detailed Facility Report for that RegistryID (the id is not recognized). Upstream: ${msg}`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }
  // Anything else is an unrecognized ECHO error — surfaced as schema drift, never
  // silently swallowed into a fake empty.
  throw driftError(
    label,
    `echo:${service} returned an unrecognized Results.Error — treating as schema drift. Upstream: ${msg}`,
  );
}

// ─── Tool 1: echo_search_facilities ───────────────────────────────
/**
 * Search EPA-regulated facilities by state (+ optional sic / facilityName /
 * majorOnly / federalOnly / naics-best-effort) with compliance/enforcement
 * screening fields. The workhorse: state + industry + name + major/federal
 * across CAA/CWA/RCRA/SDWA. `state` is REQUIRED (an unscoped national query is
 * ~5.6M rows AND the state enum is the silent-zero guard).
 *
 * Hides the two-step QueryID pagination behind ONE call: internally get_facilities
 * (→ exact QueryRows + a fresh QueryID) then get_qid?pageno=offset/limit+1 (→ the
 * rows). The QueryID is captured and consumed in-call, NEVER exposed. Rows pass
 * through verbatim. HONESTY: totalAvailable = num(QueryRows) (exact, never the page
 * size); genuine-empty (QueryRows:"0") ⇒ complete:true/total:0; a Results.Error ⇒
 * classified throw (never a fake empty); an outage ⇒ getJson throws.
 */
export async function searchFacilities(args: {
  state: EchoState;
  naics?: string;
  sic?: string;
  facilityName?: string;
  majorOnly?: boolean;
  federalOnly?: boolean;
  limit?: number;
  offset?: number;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;

  // Page-boundary guard (§1b): ECHO can only page on pageno boundaries, so offset
  // MUST be an exact multiple of limit. Rejected LOCALLY, before any fetch.
  if (offset % limit !== 0) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `ECHO pages on fixed boundaries; offset (${offset}) must be an exact multiple of limit (${limit}).`,
      retryable: false,
    });
  }
  const pageno = offset / limit + 1;

  // Belt-and-suspenders value grammars (behind the server's Zod enum/regex).
  if (args.naics !== undefined && !NAICS_RE.test(args.naics)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid naics ${JSON.stringify(args.naics)} — expected 2–6 digits.`,
      retryable: false,
    });
  }
  if (args.sic !== undefined && !SIC_RE.test(args.sic)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid sic ${JSON.stringify(args.sic)} — expected 2–4 digits.`,
      retryable: false,
    });
  }

  // ── Step 1: get_facilities (→ exact total + a fresh QueryID; NO rows). ──
  const p1 = new URLSearchParams();
  p1.set("output", "JSON");
  p1.set("p_st", args.state);
  // naics is DROPPED upstream (M2) but still sent (harmless; disclosed as dropped
  // below). sic DOES narrow (M2) — a real filter.
  if (args.naics !== undefined) p1.set("p_naics", args.naics);
  if (args.sic !== undefined) p1.set("p_sic", args.sic);
  if (args.facilityName !== undefined) p1.set("p_fn", args.facilityName);
  if (args.majorOnly === true) p1.set("p_maj", "Y");
  if (args.federalOnly === true) p1.set("p_ff", "Y");
  p1.set("responseset", String(limit));

  const results1 = unwrapResults(SVC_FACILITIES, await echoGet(SVC_FACILITIES, p1));
  guardResultsError(SVC_FACILITIES, results1); // 200-with-error-body FIRST

  // totalAvailable = num(QueryRows) — the EXACT total, NEVER the page size. A
  // non-numeric / absent QueryRows with no Results.Error ⇒ hard drift.
  const total = num((results1 as { QueryRows?: unknown }).QueryRows);
  if (total === null) {
    throw driftError(
      "echo:" + SVC_FACILITIES,
      `echo:${SVC_FACILITIES} returned no numeric QueryRows and no Results.Error — treating as schema drift.`,
    );
  }

  // Program-count summary (all pass-through; TotalPenalties is a verbatim currency
  // string that num() cannot parse — kept as-is).
  const summary = {
    queryRows: total,
    totalPenalties: str((results1 as { TotalPenalties?: unknown }).TotalPenalties),
    programCounts: {
      caa: num((results1 as { CAARows?: unknown }).CAARows),
      cwa: num((results1 as { CWARows?: unknown }).CWARows),
      rcra: num((results1 as { RCRRows?: unknown }).RCRRows),
      tri: num((results1 as { TRIRows?: unknown }).TRIRows),
      inspections: num((results1 as { INSPRows?: unknown }).INSPRows),
    },
  };

  // Honesty accounting (M2): sic/facilityName/major/federal are HONORED; naics is
  // DROPPED upstream → filtersDropped + a disclosure note.
  const filtersApplied: string[] = ["state"];
  if (args.sic !== undefined) filtersApplied.push("sic");
  if (args.facilityName !== undefined) filtersApplied.push("facilityName");
  if (args.majorOnly === true) filtersApplied.push("majorOnly");
  if (args.federalOnly === true) filtersApplied.push("federalOnly");
  const filtersDropped: string[] = [];
  const notes: string[] = [
    TWO_STEP_NOTE,
    DATA_CURRENCY_NOTE,
    FACILITY_NAME_NOTE,
    NUMERIC_STRING_NOTE,
  ];
  if (args.naics !== undefined) {
    filtersDropped.push("naics");
    notes.push(NAICS_BEST_EFFORT_NOTE);
  }

  // Genuine-empty (QueryRows:"0", no Results.Error): honest complete:true/total:0
  // WITHOUT a step-2 fetch (there is nothing to page).
  if (total === 0) {
    return withMeta(
      { state: args.state, facilities: [] as EchoRow[], summary },
      {
        source: SOURCE,
        keylessMode: true,
        returned: 0,
        totalAvailable: 0,
        filtersApplied,
        filtersDropped,
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore: false, nextOffset: null },
        notes,
      } satisfies Partial<ResponseMeta>,
    );
  }

  // Capture + validate the UPSTREAM QueryID before using it in step 2.
  const qid = str((results1 as { QueryID?: unknown }).QueryID);
  if (qid === null || !QID_RE.test(qid)) {
    throw driftError(
      "echo:" + SVC_FACILITIES,
      `echo:${SVC_FACILITIES} returned a missing/non-numeric QueryID — cannot fetch the result page (schema drift).`,
    );
  }

  // ── Step 2: get_qid (→ the actual rows for the requested page). ──
  const p2 = new URLSearchParams();
  p2.set("output", "JSON");
  p2.set("qid", qid);
  p2.set("pageno", String(pageno));

  const results2 = unwrapResults(SVC_QID, await echoGet(SVC_QID, p2));
  guardResultsError(SVC_QID, results2); // recycled-qid ⇒ not_found retryable

  const facilities = (results2 as { Facilities?: unknown }).Facilities;
  if (!Array.isArray(facilities)) {
    throw driftError(
      "echo:" + SVC_QID,
      `echo:${SVC_QID} returned a non-array Facilities with no Results.Error — treating as schema drift (never a fake empty).`,
    );
  }

  const returned = facilities.length;
  // hasMore is EXACT (QueryRows is an exact total — no page-fullness hedge).
  const hasMore = offset + returned < total;
  const nextOffset = hasMore ? offset + returned : null;

  return withMeta(
    { state: args.state, facilities: facilities as EchoRow[], summary },
    {
      source: SOURCE,
      keylessMode: true,
      returned,
      totalAvailable: total,
      filtersApplied,
      filtersDropped,
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool 2: echo_facility_report ─────────────────────────────────
/**
 * Fetch the Detailed Facility Report (DFR) for ONE facility by its FRS RegistryID
 * (from echo_search_facilities rows): the per-facility compliance / enforcement /
 * inspection / permit deep-dive for competitor / acquisition-target due diligence.
 * Single record (no pagination). A bad/unknown RegistryID ⇒ the 200-with-error-
 * body guard classifies "ID … is invalid" ⇒ not_found (never a fabricated report).
 */
export async function facilityReport(args: {
  registryId: string;
}): Promise<MetaBundle> {
  // Belt-and-suspenders (behind the server's Zod ^[0-9]{9,12}$).
  if (!REGISTRY_ID_RE.test(args.registryId)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid registryId ${JSON.stringify(args.registryId)} — expected an all-digit FRS RegistryID (9–12 digits).`,
      retryable: false,
    });
  }

  const params = new URLSearchParams();
  params.set("output", "JSON");
  params.set("p_id", args.registryId);

  const results = unwrapResults(SVC_DFR, await echoGet(SVC_DFR, params));
  guardResultsError(SVC_DFR, results); // "ID … is invalid" ⇒ not_found

  return withMeta(
    {
      registryId: str((results as { RegistryID?: unknown }).RegistryID) ?? args.registryId,
      report: results,
    },
    {
      source: SOURCE,
      keylessMode: true,
      returned: 1,
      totalAvailable: 1,
      filtersApplied: ["registryId"],
      filtersDropped: [],
      fieldsUnavailable: [],
      notes: [
        "Single Detailed Facility Report (DFR) — the full compliance/enforcement/inspection/permit detail for one facility; no pagination.",
        DATA_CURRENCY_NOTE,
        NUMERIC_STRING_NOTE,
      ],
    } satisfies Partial<ResponseMeta>,
  );
}
