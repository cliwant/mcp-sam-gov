/**
 * arcgis-feature.ts — generic ArcGIS REST FeatureServer/MapServer layer query
 * over a CURATED service allowlist (loop — SLED bid campaign, 2026-07-19).
 *
 * WHAT IT ADDS: an enormous amount of US government data (esp. SLED procurement /
 * GIS / infrastructure) is published as ArcGIS REST feature layers. This is the
 * QUERY companion to `arcgis_hub_discover_datasets` (which DISCOVERS Hub datasets):
 * it queries the ROWS of a curated set of high-value ArcGIS layers. First payload:
 * the DC OCP "PASS" procurement layers (solicitations / contracts / purchase
 * orders / payments) — DC's live open-solicitation feed with 46 fields, keyless.
 *
 * The module REUSES `getJson` (redirect:"error") / `driftError` / `num`·`str` /
 * `withMeta`·`buildMeta`, mirroring socrata.ts (curated allowlist) + datagov-
 * catalog.ts. KEYLESS.
 *
 * ★ SSRF: the caller supplies a `service` ENUM key (never a free host/URL); each
 *   allowlist entry is a FIXED, live-verified ArcGIS layer base URL. The query
 *   URL is built on that fixed base, and a post-construction assertion requires
 *   the built hostname === the allowlist entry's host (over https) BEFORE the
 *   fetch; `redirect:"error"`. `where`/`outFields`/`orderByFields` ride in
 *   URLSearchParams (encoded) — they filter/project the read-only layer and
 *   CANNOT alter the host (a malformed `where` ⇒ upstream 400 ⇒ invalid_input,
 *   surfaced, never silent). Adding a service later = an allowlist SOURCE edit +
 *   a live count/`/query` verification — NEVER a free runtime param.
 *
 * ★ HONESTY PILLARS (captured live 2026-07-19):
 *   P1: totalAvailable = the layer's EXACT match count (a `returnCountOnly=true`
 *     companion query), NEVER the page length. Best-effort: a count failure ⇒
 *     totalAvailable:null + a note (the rows are still returned) — never a fake
 *     total. `exceededTransferLimit` also forces hasMore.
 *   P2: getJson THROWS on 429/5xx/timeout; an ArcGIS `{error:{code,message}}`
 *     body (HTTP 200) is classified (400 ⇒ invalid_input, else upstream) and
 *     THROWN — never a fake empty. A genuine no-match (features:[], count:0) ⇒
 *     honest empty.
 *   P3: attributes pass through VERBATIM (they are the layer's own record). NOTE
 *     (disclosed every response): ArcGIS date fields are epoch MILLISECONDS and a
 *     negative/sentinel value (e.g. -2209093200000 ≈ year 1900) is a placeholder,
 *     not a real date — surfaced verbatim, never coerced.
 *   P4: `body.features` absent/non-array (and no error) ⇒ driftError; a 200
 *     non-JSON body ⇒ schema_drift via the catch-ladder.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export type ArcgisService = {
    key: string;
    base: string;
    label: string;
    note: string;
};
export declare const ARCGIS_SERVICES: readonly ArcgisService[];
export type ArcgisFeatureQueryArgs = {
    service: string;
    where?: string;
    outFields?: string;
    orderByFields?: string;
    limit?: number;
    offset?: number;
};
/**
 * Query rows from a curated ArcGIS REST feature layer. `service` is an allowlist
 * enum; `where` (SQL-ish filter, default 1=1), `outFields` (default *),
 * `orderByFields`, `limit`/`offset`. Returns curated record attributes + honest
 * `_meta` (totalAvailable = the layer's exact match count via a returnCountOnly
 * companion; epoch-ms date disclosure).
 */
export declare function featureQuery(args: ArcgisFeatureQueryArgs): Promise<MetaBundle>;
//# sourceMappingURL=arcgis-feature.d.ts.map