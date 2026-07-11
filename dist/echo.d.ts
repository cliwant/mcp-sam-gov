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
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const ECHO_STATES: readonly ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "AS", "GU", "MP", "PR", "VI"];
export type EchoState = (typeof ECHO_STATES)[number];
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
export declare function echoGet(service: string, params: URLSearchParams): Promise<unknown>;
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
export declare function searchFacilities(args: {
    state: EchoState;
    naics?: string;
    sic?: string;
    facilityName?: string;
    majorOnly?: boolean;
    federalOnly?: boolean;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
/**
 * Fetch the Detailed Facility Report (DFR) for ONE facility by its FRS RegistryID
 * (from echo_search_facilities rows): the per-facility compliance / enforcement /
 * inspection / permit deep-dive for competitor / acquisition-target due diligence.
 * Single record (no pagination). A bad/unknown RegistryID ⇒ the 200-with-error-
 * body guard classifies "ID … is invalid" ⇒ not_found (never a fabricated report).
 */
export declare function facilityReport(args: {
    registryId: string;
}): Promise<MetaBundle>;
//# sourceMappingURL=echo.d.ts.map