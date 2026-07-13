/**
 * CMS Open Payments — the healthcare industry→physician payment TRANSPARENCY lane
 * on a NEW **DKAN 2.x** datastore adapter (keyless). Source #28 (ADR-0037).
 *
 * A third data-portal family after Socrata SODA (src/socrata.ts) and CKAN Action
 * API (src/ckan.ts) — the DKAN DCAT-metastore + `/api/1/datastore/query` pair.
 * Scoped this cycle to the single confirmed host `openpaymentsdata.cms.gov`, whose
 * flagship datasets are the CMS Open Payments (Physician Payments Sunshine Act,
 * Social Security Act §1128G / 42 CFR Part 403 subpart I) tables: every reported
 * payment / other-transfer-of-value / ownership interest from drug & device
 * manufacturers (and GPOs) to physicians, non-physician practitioners, and
 * teaching hospitals. The B2G unlock: healthcare-COI / industry-financial-
 * relationship vetting + healthcare market intelligence — the money/COI question
 * NPPES (provider identity, src/nppes.ts) cannot answer.
 *
 * TWO tools (mirror the Socrata/CKAN discovery+query split):
 *   - cms_search_datasets — DKAN DCAT metastore discovery. `GET /api/1/metastore/
 *     schemas/dataset/items` returns the FULL catalog ARRAY in one shot (the server
 *     IGNORES limit/offset/page — M2). We fetch it ONCE and do ALL q-substring
 *     filtering + limit/offset slicing CLIENT-SIDE against the in-memory array, so
 *     totalAvailable is the EXACT post-q catalog size and pagination is honest
 *     against the KNOWN length (never a false-more, never a dead-end offset).
 *   - cms_query_dataset — DKAN datastore query by datasetId + distribution index,
 *     with server-side `conditions` filters, an EXACT `count`, offset/limit ≤ 500
 *     pagination, a `properties` projection, and `results:false` = the count/schema
 *     column-discovery mode. Rows pass through VERBATIM (values are text strings).
 *
 * HONESTY (writes ZERO fetch/coerce/error/meta code — REUSES getJson/throughGate/
 * driftError + coerce.num/str + withMeta/buildMeta):
 *   P1 `count` is the EXACT grand total (num-guarded) → totalAvailable=count, real
 *      offset pagination; a PRESENT non-number count in results-mode ⇒ driftError.
 *      limit ≤ 500 is the HARD API cap (Zod .max(500); a higher limit ⇒ invalid_input
 *      client-side, so the API's own 400 is never reached).
 *   P2 empty (`{count:0, results:[]}`) ⇒ honest complete:true; a 400 (bad column /
 *      bad limit) / 404 (bad datasetId/index) / HTML (SPA/WAF) / 5xx / timeout /
 *      non-JSON ⇒ THROW (never a fake empty).
 *   P3 money/amounts (total_amount_of_payment_usdollars, …) are text STRINGS →
 *      surfaced verbatim; coerce.num is null-never-0 (a missing/""/"-" amount → null,
 *      NEVER 0 — the pricing.ts money-lie precedent).
 *   P4 `conditions` are server-side + self-policing: a bad column → the API 400s →
 *      invalid_input; every requested condition either applies or the call errors,
 *      so filtersDropped is ALWAYS empty (no silent-drop path).
 *   P-drift (M1) — the results-array drift guard is CONDITIONED on the effective
 *      `results` mode: results:true (default) REQUIRES Array.isArray(body.results) +
 *      the schema anchor; results:false EXPECTS results ABSENT (rows:[], no throw)
 *      and uses schema presence + a number-typed count as the drift anchor. The
 *      schema block (keyed by the DISTRIBUTION id) is the anchor — fields are read
 *      from Object.values(schema)[0].fields.
 *
 * SSRF (the CKAN/Socrata fixed-host idiom, COPIED not imported). The load-bearing
 * risk: `datasetId` + `index` interpolate into the URL PATH
 * (`/api/1/datastore/query/{datasetId}/{index}`), so URLSearchParams does NOT
 * protect them. Validate datasetId against the strict 36-char LOWERCASE UUID
 * grammar (the CKAN UUID_RE verbatim — rejects %2F, "..", uppercase, a trailing
 * "\n") and index as a small non-negative int BEFORE interpolation; every OTHER
 * param (conditions[i][*], properties[], limit, offset, count, results) rides the
 * query string via URLSearchParams. Host is a compile-time constant; a
 * post-construction hostname/protocol assert + redirect:"error" fail closed.
 *
 * PII / scope boundary (NPPES precedent): Open Payments NAMES individual physicians
 * + payment amounts AND is a federal transparency-BY-LAW public dataset — IN-SCOPE
 * per the NPPES/NSF-PI precedent, bounded to targeted vetting (per-query limit ≤ 500
 * + an offset reach cap S3, no enrichment, NO covered_recipient_npi→NPPES auto-join,
 * a mandatory not-a-COI-finding / cross-check-SAM+OFAC+LEIE caveat on every response).
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const CMS_HOSTS: readonly ["openpaymentsdata.cms.gov"];
export type CmsHost = (typeof CMS_HOSTS)[number];
export declare const CMS_OPERATORS: readonly ["=", "<>", "<", ">", "<=", ">=", "like", "in"];
export type CmsOperator = (typeof CMS_OPERATORS)[number];
/**
 * ★ The mandatory not-a-determination caveat carried on EVERY cms_query_dataset /
 * cms_search_datasets response (mirrors NPPES_NOT_DETERMINATION_NOTE /
 * OFAC_NOT_DETERMINATION_NOTE). Kept verbatim so the fault suite can assert it.
 */
export declare const CMS_OPEN_PAYMENTS_NOT_DETERMINATION_NOTE = "Public transparency-by-law data (CMS Open Payments, Physician Payments Sunshine Act). Reports reported industry payments / transfers of value / ownership interests ONLY \u2014 it is NOT a conflict-of-interest finding, a fitness/exclusion determination, or evidence of wrongdoing (many payments are routine and lawful). Individual records name physicians, teaching hospitals, and dollar amounts verbatim from the public dataset; this tool performs NO enrichment and NO cross-source join (e.g. it does NOT auto-join covered_recipient_npi to NPPES). Cross-check SAM exclusions + OFAC for debarment/sanctions and the OIG-LEIE for healthcare exclusions.";
/** ★ S3 — the per-query reach-cap POLICY disclosure carried on EVERY response. */
export declare const CMS_OPEN_PAYMENTS_REACH_CAP_NOTE = "This vetting tool reaches at most the first ~2,500 rows per query (limit \u2264 500, offset \u2264 2,000) as a deliberate targeted-lookup boundary \u2014 Open Payments names individual physicians AND dollar amounts, so the reach is bounded like NPPES. The EXACT count sizes a result set but does not bound a harvest; this is a PER-QUERY cap only (cross-query iteration is inherent to any datastore API). Narrow your `conditions` (recipient_state / specialty / manufacturer) for a complete, targeted result set, or use the metastore distribution downloadURL for a bulk pull.";
export type CmsField = {
    name: string;
    type: string | null;
    mysqlType: string | null;
    description: string | null;
};
export type CmsCondition = {
    property: string;
    value: string | number;
    operator?: string;
};
export type CmsQueryArgs = {
    datasetId: string;
    index?: number;
    conditions?: CmsCondition[];
    properties?: string[];
    limit?: number;
    offset?: number;
    results?: boolean;
};
/**
 * Query a DKAN datastore distribution by datasetId + index. Server-side `conditions`
 * filters (self-policing — a bad column 400s → invalid_input, so filtersDropped is
 * always empty), an EXACT `count` (real offset pagination), a `properties`
 * projection, and `results:false` = the count/schema column-discovery mode (M1/S1:
 * rows omitted, pagination disabled — no livelock). count=true is ALWAYS on the wire
 * (S2 — never a caller toggle). Rows pass through VERBATIM (strings). A 400 (bad
 * column/limit) / 404 (bad datasetId/index) / HTML / 5xx / timeout ⇒ THROW.
 */
export declare function queryDataset(args: CmsQueryArgs): Promise<MetaBundle>;
export type CmsDistribution = {
    index: number;
    distId: string | null;
    title: string | null;
    mediaType: string | null;
    downloadURL: string | null;
};
export type CmsDataset = {
    datasetId: string | null;
    title: string | null;
    description: string | null;
    distributions: CmsDistribution[];
    keyword: string[];
    modified: string | null;
};
export type CmsSearchArgs = {
    q?: string;
    limit?: number;
    offset?: number;
};
/**
 * Discover DKAN datasets via the DCAT metastore. ★ M2 — the metastore IGNORES
 * limit/offset/page and always ships the ENTIRE catalog array in one response, so we
 * fetch it ONCE and apply ALL q-substring filtering + limit/offset slicing
 * CLIENT-SIDE against the in-memory array: totalAvailable = the EXACT post-q catalog
 * size (never null), hasMore = offset + returned < filteredLength, nextOffset
 * against the KNOWN length (never a server offset — no false-more, no dead-end).
 */
export declare function searchDatasets(args: CmsSearchArgs): Promise<MetaBundle>;
//# sourceMappingURL=cms.d.ts.map