/**
 * nhtsa.ts — NHTSA VEHICLE SAFETY (api.nhtsa.gov) — the vehicle / parts /
 * fleet supplier PRODUCT-SAFETY vetting lane (ADR-0057). Two keyless tools:
 *   • nhtsa_recalls    — /recalls/recallsByVehicle?make=&model=&modelYear=
 *   • nhtsa_complaints — /complaints/complaintsByVehicle?make=&model=&modelYear=
 * The cross-agency product-safety family alongside openFDA (medical) / CPSC
 * (consumer goods): a manufacturer/component/safety-signal history for B2G
 * supplier vetting.
 *
 * ★ KEYLESS — there is NO API key at all (no parameter, no header). This module
 *   touches NO key seam (no KEY_REGISTRY / keys.ts / API_KEYS.md). It REUSES the
 *   shared `getJson` (redirect:"error") / `driftError` fetch envelope, the `num`/
 *   `str` coercions (null-never-empty-string; a genuine 0 stays 0), and
 *   `withMeta`/`buildMeta` — and mirrors datagov-catalog.ts's fixed-host SSRF
 *   idiom + schema_drift catch-ladder verbatim.
 *
 * ★ PII — the complaints upstream response carries a `vin` field (an individual
 *   vehicle identifier). It is DELIBERATELY OMITTED from the curated output
 *   entirely — never surfaced, logged, or stored. The B2G value is the
 *   manufacturer / component / safety signal, NOT the VIN.
 *
 * ★ THE HONESTY PILLARS (P1-P4, live-verified 2026-07-15):
 *   P1: totalAvailable = `Count` (recalls) / `count` (complaints) — the REAL total.
 *       NHTSA returns the COMPLETE filtered set (no pagination), so in the normal
 *       case Count === results.length ⇒ complete:true. totalAvailable is NEVER
 *       fabricated: a PRESENT numeric Count is trusted verbatim; a MISSING Count
 *       falls back to results.length WITH an honest note (never invented).
 *   P2: results:[] (Count 0) ⇒ an HONEST EMPTY (returned:0, complete:true) — a bad
 *       make/model that returns 200+Count 0 is an honest no-match, NOT an error. A
 *       4xx ⇒ invalid_input; a 5xx/timeout ⇒ THROW (never a fake empty); a 200
 *       non-JSON body ⇒ schema_drift.
 *   P3: booleans (crash/fire/parkIt/parkOutSide/overTheAirUpdate) preserved AS
 *       booleans (a non-boolean ⇒ null, never a fabricated false); counts
 *       (numberOfInjuries/numberOfDeaths) via `num` (a genuine 0 stays 0, NEVER
 *       null-for-0); dates as strings via `str`; Count/count via `num`.
 *   P4: `results` non-array ⇒ driftError; a Count/count that is PRESENT but a
 *       non-number ⇒ driftError (a broken total contract, never a fabricated empty).
 *   SSRF: fixed host `api.nhtsa.gov` (compile-time literal) + post-construction
 *       hostname/protocol assertion + redirect:"error"; make/model ride
 *       URLSearchParams (module-built, no raw passthrough); modelYear is
 *       ^\d{4}$; make/model are charclass-validated (letters/digits/space/hyphen,
 *       so a `../` or `%` can never reach the fixed path).
 */
import { type MetaBundle } from "./meta.js";
export declare const NHTSA_HOST = "api.nhtsa.gov";
export declare const NHTSA_MODEL_YEAR_RE: RegExp;
export declare const NHTSA_MAKE_MODEL_RE: RegExp;
export type NhtsaVehicleArgs = {
    make: string;
    model: string;
    modelYear: string;
};
export type NhtsaRecall = {
    campaignNumber: string | null;
    manufacturer: string | null;
    component: string | null;
    summary: string | null;
    consequence: string | null;
    remedy: string | null;
    reportReceivedDate: string | null;
    parkIt: boolean | null;
    parkOutside: boolean | null;
    overTheAirUpdate: boolean | null;
};
export type NhtsaComplaint = {
    odiNumber: string | null;
    manufacturer: string | null;
    component: string | null;
    summary: string | null;
    crash: boolean | null;
    fire: boolean | null;
    numberOfInjuries: number | null;
    numberOfDeaths: number | null;
    dateOfIncident: string | null;
    dateComplaintFiled: string | null;
};
/**
 * Fetch NHTSA safety RECALLS for a make/model/modelYear → curated recall rows +
 * honest `_meta`. KEYLESS. totalAvailable = the upstream `Count` (the REAL total —
 * NHTSA returns the complete set, no pagination). A no-match (Count 0) ⇒ an honest
 * empty; a 4xx ⇒ invalid_input; a 5xx/timeout ⇒ THROW; a 200 non-JSON ⇒ drift.
 */
export declare function recalls(args: NhtsaVehicleArgs): Promise<MetaBundle>;
/**
 * Fetch NHTSA consumer COMPLAINTS for a make/model/modelYear → curated complaint
 * rows (★NO vin — PII omitted) + honest `_meta`. KEYLESS. totalAvailable = the
 * upstream `count` (the REAL total). A no-match ⇒ honest empty; a 4xx ⇒
 * invalid_input; a 5xx/timeout ⇒ THROW; a 200 non-JSON ⇒ drift.
 */
export declare function complaints(args: NhtsaVehicleArgs): Promise<MetaBundle>;
//# sourceMappingURL=nhtsa.d.ts.map