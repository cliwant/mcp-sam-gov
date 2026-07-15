/**
 * gsa-perdiem.ts — GSA Federal Travel Per-Diem lookup (`api.gsa.gov`, base
 * `/travel/perdiem/v2`) — ADR-0050. The lodging + M&IE rate ceilings the federal
 * government reimburses for official travel, by city/state or ZIP for a given year.
 *
 * WHAT IT ADDS: a NEW travel-cost lane (the per-diem authority) on the SAME
 * `api.gsa.gov` host as datagov-catalog.ts, so it REUSES the audited `datagovKey.ts`
 * key seam VERBATIM (keyHeader / keyModeLabel / pushKeyNote) — keyless by default via
 * the shared DEMO_KEY, upgraded by DATA_GOV_API_KEY. The key rides ONLY in the
 * X-Api-Key header — NEVER the URL / label / _meta / a log (the K-test). This module
 * writes ZERO fetch/coercion/error/meta code: it REUSES `getJson` (redirect:"error",
 * the X-Api-Key header) / `driftError` / `num`·`str` (coerce.ts) / `withMeta`·
 * `buildMeta`, and MIRRORS the datagov-catalog schema_drift catch-ladder verbatim.
 *
 * ★ SSRF: the host is a compile-time literal (`GSA_PERDIEM_HOST`). The two lookup
 *   modes ride FIXED path templates; every caller value (city/state/zip/year) is
 *   charclass-validated THEN `encodeURIComponent`-escaped into a single path segment
 *   (no raw passthrough, no query steer). A post-construction hostname/protocol
 *   assertion + `redirect:"error"` lock it (fail closed on any off-host 3xx — a 3xx
 *   off api.gsa.gov could carry the X-Api-Key header away).
 *
 * ★ HONESTY (ADR-0050 P1–P5, live-verified 2026-07-15):
 *   [INPUT] EITHER (city + state) OR zip — supplying BOTH, or NEITHER, ⇒ invalid_input
 *           with 0 fetch (an ambiguous/empty lookup is a caller error, never a guess).
 *   [P1]    the API returns the COMPLETE rate set for the lookup (no pagination) ⇒
 *           totalAvailable = the flattened row count, complete:true. NEVER fabricated.
 *   [P2]    `errors` non-null ⇒ invalid_input surfacing the message (never a fake
 *           empty); a genuine no-match (rates:[] / rate:[]) ⇒ honest empty (returned:0,
 *           complete:true); a 429 (DEMO_KEY ~10/hr) ⇒ rate_limited THROW honoring
 *           Retry-After; a 5xx ⇒ upstream_unavailable THROW; a 200 non-JSON ⇒
 *           schema_drift. A DOWN service is NEVER a returned:0.
 *   [P3]    `value` (monthly max lodging $) / `meals` (M&IE cap $) via `num` (null-
 *           never-0 — a genuine 0 stays 0). `standardRate` / `isOconus` are STRING
 *           booleans "true"/"false" ⇒ coerced to a real boolean (an unrecognized value
 *           ⇒ null, never a fabricated false). The months array is preserved AS-IS
 *           (never padded/fabricated to 12).
 *   [P4]    `rates` / a group's `rate` / `months.month` absent or non-array ⇒
 *           driftError (never a fabricated empty).
 */
import { type MetaBundle } from "./meta.js";
export declare const GSA_PERDIEM_HOST = "api.gsa.gov";
export declare const DEFAULT_PERDIEM_YEAR = "2025";
export type PerdiemMonth = {
    month: number | null;
    monthName: string | null;
    lodgingUsd: number | null;
};
export type PerdiemRate = {
    city: string | null;
    county: string | null;
    state: string | null;
    zip: string | null;
    year: number | null;
    isOconus: boolean | null;
    standardRate: boolean | null;
    mealsUsd: number | null;
    monthlyLodgingUsd: PerdiemMonth[];
};
export type GsaPerdiemRatesArgs = {
    city?: string;
    state?: string;
    zip?: string;
    year?: string;
};
/**
 * Look up GSA Federal Travel per-diem rates by EITHER (city + state) OR zip, for a
 * given `year` (default 2025). Returns flattened rate rows (each outer state/year
 * group × inner city/rate) + honest `_meta`: totalAvailable = the row count (no
 * pagination — P1), lodging/meals as null-never-0 dollars (P3), standardRate/isOconus
 * as real booleans, the months array preserved as-is. The DEMO_KEY rate disclosure
 * rides in the notes.
 */
export declare function perdiemRates(args: GsaPerdiemRatesArgs): Promise<MetaBundle>;
//# sourceMappingURL=gsa-perdiem.d.ts.map