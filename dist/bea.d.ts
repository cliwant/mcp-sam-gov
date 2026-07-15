/**
 * bea.ts — BEA (Bureau of Economic Analysis) Regional Economic Accounts — the
 * REGIONAL / SUB-NATIONAL economic lane (ADR-0051). County / state / MSA GDP by
 * industry (CAGDP2 / SAGDP2N) and personal income (CAINC1 / SAINC1) — the
 * place-of-performance market context that neither the national FRED macro series
 * nor the Census establishment counts carry.
 *
 * ★ THIS IS THE SERVER'S THIRD KEY-REQUIRED SOURCE (Census CBP #1, FRED #2). The
 *   BEA Data API has NO keyless tier: every request needs `UserID=`. So, honestly:
 *   with NO `BEA_API_KEY` this tool THROWS an `invalid_input` config error BEFORE
 *   any fetch (never a fake-empty, never a keyless-pretend). The other 116 tools
 *   stay keyless — this key is scoped to this one source. (Contrast the OPTIONAL
 *   keys of datagov/bls/nvd, which lift a tier but are not required.)
 *
 * This module MIRRORS the census-economic.ts / fred.ts key-required precedent: a
 * `beaApiKey()` env seam, a pre-fetch `invalid_input` THROW when unset, the
 * fixed-host SSRF assert + `redirect:"error"`, and a data-absence-sentinel→null
 * idiom (Census's negative floor / FRED's `"."` — here BEA's string suppression
 * codes `(NA) (D) (NM) (L) *`). It REUSES `getJson` (the shared fetch envelope) /
 * `driftError` / `num`·`str` (coerce.ts, null-never-0/empty) / `withMeta`·`buildMeta`.
 * The key rides ONLY in the `UserID=` query param, NOWHERE else (never the label,
 * `_meta.source`, notes, or a log — the K-test).
 *
 *   GET https://apps.bea.gov/api/data
 *       ?UserID=<BEA_API_KEY>        (REQUIRED)
 *       &method=GetData&datasetname=Regional&ResultFormat=json  (fixed)
 *       &TableName=<tableName>       (e.g. CAGDP2, SAGDP2N, CAINC1)
 *       &GeoFips=<geoFips>           (STATE | county FIPS | MSA)
 *       &LineCode=<lineCode>         (industry line, or ALL)
 *       &Year=<year>                 (YYYY | LAST5 | ALL)
 *       &Frequency=<frequency>       (A | Q)
 *   → { BEAAPI:{ Results:{ Statistic, UnitOfMeasure, Dimensions:[…],
 *        Data:[{ Code, GeoFips, GeoName, TimePeriod, CL_UNIT, UNIT_MULT,
 *                DataValue, NoteRef }], Notes:[{ NoteRef, NoteText }] } } }
 *
 * ★ HONESTY (ADR-0051 P1–P5):
 *   [KEY]  no key ⇒ invalid_input THROW pre-fetch (0 fetch); the message names
 *          BEA_API_KEY + the free-signup URL.
 *   [P1]   BEA GetData returns the COMPLETE set for the filter (no server
 *          pagination) ⇒ totalAvailable = the row count, complete:true. NEVER
 *          fabricated.
 *   [★P2]  ★the crux: a missing/invalid key (and any bad-parameter request) returns
 *          HTTP **200** carrying `BEAAPI.Results.Error` — NOT an HTTP error status.
 *          The catch-ladder checks `Results.Error` FIRST (BEFORE the Data-array
 *          drift check) and throws invalid_input SURFACING `APIErrorDescription`
 *          (+ code) — NEVER read as an empty result. `Data:[]` (a genuine empty
 *          array) ⇒ honest empty (returned:0, complete:true). A 5xx/timeout ⇒
 *          upstream_unavailable THROW. A 200 non-JSON ⇒ schema_drift.
 *   [★P3]  `DataValue` is a STRING WITH COMMAS ("1,234,567") — strip commas then
 *          `num()`. The suppression/not-available sentinels `(NA) (D) (NM) (L) *`
 *          (and any non-numeric after the comma-strip) map to **null** (withheld),
 *          NEVER 0 — a real "0" stays 0. `UNIT_MULT` (power-of-10 multiplier) is
 *          reported as `unitMult` and `CL_UNIT` as `unitOfMeasure`; the raw value is
 *          surfaced WITH the multiplier — it is NEVER multiplied in (that would lose
 *          precision and double-count against the disclosed multiplier).
 *   [P4]   `BEAAPI` / `Results` / `Data` absent or non-array ⇒ driftError — BUT
 *          ONLY after the Results.Error check (an Error response is P2, not drift).
 *   [SSRF] fixed host `apps.bea.gov`; `tableName` ^[A-Za-z0-9]{2,20}$; `geoFips`
 *          ^[A-Za-z0-9]{2,10}$; `lineCode` ^([0-9]{1,4}|ALL)$; `year`
 *          ^\d{4}$|LAST5|ALL; `frequency` {A,Q}. All VALUES ride URLSearchParams;
 *          the key rides `UserID=` ONLY.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const BEA_HOST = "apps.bea.gov";
/** Read BEA_API_KEY from env; trim; return the value or undefined (unset/blank). */
export declare function beaApiKey(): string | undefined;
export type BeaRegionalRow = {
    geoFips: string | null;
    geoName: string | null;
    timePeriod: string | null;
    lineCode: string | null;
    dataValue: number | null;
    unitOfMeasure: string | null;
    unitMult: number | null;
    noteRef: string | null;
};
export type BeaNote = {
    noteRef: string | null;
    noteText: string | null;
};
/**
 * num(), but for BEA's comma-formatted DataValue string. Strips a suppression code
 * ((NA)/(D)/(NM)/(L)/*) → null, otherwise removes thousands commas and defers to
 * num (so "1,234,567" ⇒ 1234567, a genuine "0" ⇒ 0, and any residual non-numeric
 * ⇒ null — NEVER a fabricated 0).
 */
export declare function beaDataValue(v: unknown): number | null;
export type BeaRegionalDataArgs = {
    tableName?: string;
    geoFips?: string;
    lineCode?: string;
    year?: string;
    frequency?: string;
};
/**
 * Fetch BEA Regional Economic Accounts rows for a table × geography × line filter
 * → normalized rows + summarized BEA Notes + honest `_meta`. REQUIRES BEA_API_KEY
 * (throws invalid_input pre-fetch when unset). ★A missing/invalid key (and any bad
 * parameter) surfaces as an HTTP-200 `BEAAPI.Results.Error` carrier which is
 * detected and thrown as invalid_input BEFORE the Data-array shape check.
 */
export declare function regionalData(args: BeaRegionalDataArgs): Promise<MetaBundle>;
//# sourceMappingURL=bea.d.ts.map