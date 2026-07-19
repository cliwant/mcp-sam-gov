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
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num } from "./coerce.js";
import { withMeta } from "./meta.js";
export { num };
export const ARCGIS_SERVICES = [
    { key: "dc_pass_solicitations", base: "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Government_Operations/MapServer/19", label: "DC OCP PASS — Solicitations", note: "DC Office of Contracting & Procurement live solicitations (SOLICITATIONNUMBER, SOLICITATIONTITLE, DUE_DATE, OPENDATE, CLOSEDATE, NIGPCODE, CONTRACTINGOFFICER, AWARD_TO…). ~25k." },
    { key: "dc_pass_contracts", base: "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Government_Operations/MapServer/37", label: "DC OCP PASS — Contracts", note: "DC awarded contracts. ~50k." },
    { key: "dc_pass_purchase_orders", base: "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Government_Operations/MapServer/16", label: "DC OCP PASS — Purchase Orders", note: "DC purchase orders. ~275k." },
    { key: "dc_pass_payments", base: "https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Government_Operations/MapServer/17", label: "DC OCP PASS — Payments", note: "DC vendor payments. ~1.55M." },
    // ── Additional US local-gov procurement layers (loop, 2026-07-19) — found via
    //    arcgis_hub_discover_datasets, each on a reachable Esri-hosted services*.
    //    arcgis.com endpoint (NOT WAF-gated) + live-verified returnCountOnly. ──
    { key: "asheville_purchase_orders", base: "https://services.arcgis.com/aJ16ENn1AaqdFlqx/ArcGIS/rest/services/Financials/FeatureServer/9", label: "Asheville NC — Purchase Order Line Items", note: "City of Asheville NC purchase-order line items. ~62.8k." },
    { key: "asheville_po_summary", base: "https://services.arcgis.com/aJ16ENn1AaqdFlqx/ArcGIS/rest/services/Financials/FeatureServer/8", label: "Asheville NC — Purchase Order Summary", note: "City of Asheville NC purchase-order summary. ~18.7k." },
    { key: "bellevue_vendor_payments", base: "https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/YTD_Vendor_Payments/FeatureServer/0", label: "Bellevue WA — YTD Vendor Payments", note: "City of Bellevue WA year-to-date vendor payments. ~15.8k." },
    { key: "bellevue_awarded_contracts", base: "https://services1.arcgis.com/EYzEZbDhXZjURPbP/arcgis/rest/services/Annual_Awarded_Contracts/FeatureServer/0", label: "Bellevue WA — Annual Awarded Contracts", note: "City of Bellevue WA annual awarded contracts. ~2.0k." },
    { key: "miamidade_purchase_orders_2017", base: "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_procurement_data_2017/FeatureServer/0", label: "Miami-Dade County FL — Purchase Orders (ADPICS) 2017", note: "Miami-Dade County FL purchase orders — a 2017 snapshot (historical, disclosed). ~94.8k." },
    { key: "miamidade_purchase_orders_2025", base: "https://services.arcgis.com/8Pc9XBTAsYuxx9Ny/arcgis/rest/services/miamidade_procurement_data_informs_2025/FeatureServer/0", label: "Miami-Dade County FL — Purchase Orders (INFORMS) 2025", note: "Miami-Dade County FL purchase orders — CURRENT (2025 INFORMS). ~25k." },
    { key: "suffolk_county_ny_contracts_2018", base: "https://services.arcgis.com/JsDD4qdG5r2a7hR5/arcgis/rest/services/County_Contracts_2018/FeatureServer/0", label: "Suffolk County NY — County Contracts 2018", note: "Suffolk County NY contracts — a 2018 snapshot (historical, disclosed). ~1.4k." },
    { key: "matsu_borough_ak_checkbook", base: "https://services.arcgis.com/fX5IGselyy1TirdY/arcgis/rest/services/Logos_Checkbook_Data/FeatureServer/0", label: "Matanuska-Susitna Borough AK — Checkbook", note: "Matanuska-Susitna Borough AK checkbook (vendor spend). ~1.2k." },
    { key: "lasvegas_checkbook", base: "https://services1.arcgis.com/F1v0ufATbBQScMtY/arcgis/rest/services/Processed_Checkbook_Table_View/FeatureServer/0", label: "City of Las Vegas NV — Open Checkbook", note: "City of Las Vegas NV checkbook (DEPARTMENT/VENDOR/TRANSACTION_AMOUNT/TRANSACTION_DATE). ~373k." },
    { key: "baltimore_checkbook", base: "https://services1.arcgis.com/UWYHeuuJISiGmgXx/arcgis/rest/services/OpenCheckbookFY2022_Through_Present/FeatureServer/0", label: "Baltimore City MD — Open Checkbook (FY2022–present)", note: "Baltimore City MD checkbook, FY2022 through present (Supplier_Name/Payment_Amount/Supplier_Contract_Number/Agency). ~367k." },
    { key: "naperville_vendor_payments", base: "https://services1.arcgis.com/rXJ6QApc2sOtl1Pd/arcgis/rest/services/Expenditures_2018_to_Current_Year/FeatureServer/0", label: "City of Naperville IL — Vendor Payments (2018–current)", note: "City of Naperville IL vendor payments, 2018 to current year (Vendor_Name/Payment_Amount/Purch_Order_No/Check_Date). ~127k." },
    { key: "worcester_ma_checkbook_fy25", base: "https://services1.arcgis.com/j8dqo2DJE7mVUBU1/arcgis/rest/services/Fiscal_Year_2025_Open_Checkbook/FeatureServer/0", label: "City of Worcester MA — Open Checkbook FY2025", note: "City of Worcester MA open checkbook, FY2025 (Payee/Pmt_Amount/Departments/Spend_Categories/Pmt_Date). ~38k." },
    { key: "lasvegas_purchasing_contracts", base: "https://services1.arcgis.com/F1v0ufATbBQScMtY/arcgis/rest/services/Purchasing_Contracts__view/FeatureServer/0", label: "City of Las Vegas NV — Purchasing Contracts", note: "City of Las Vegas NV purchasing contract register (Project_Number/Project_Name/Supplier_Name/Award_Date/Termination_Date). ~3.4k, all with a supplier. Complements lasvegas_checkbook (payments)." },
    { key: "txdot_construction_projects", base: "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_Projects_Info_All/FeatureServer/0", label: "Texas DOT — Projects (with awarded construction company)", note: "Texas Department of Transportation highway projects (CNSTR_CMPNY_NM awarded construction company/CNSTR_NTPD_DT notice-to-proceed/TYPE_OF_WORK/HWY_NBR). ~85k rows, ~14.1k with an awarded contractor (filter CNSTR_CMPNY_NM IS NOT NULL for awards)." },
    { key: "akdot_construction_awards", base: "https://services.arcgis.com/r4A0V7UzH9fcLVvv/arcgis/rest/services/AWARDS_DASHBOARD_AWARDS_TABLE_POINTS/FeatureServer/0", label: "Alaska DOT&PF — Construction Bid Awards", note: "Alaska Department of Transportation & Public Facilities construction bid awards (ContractID/Contractor/Bids_Received/Engineer_Est/Award_Amount/Advertised_Date/Bid_Opening_Date/Reg_Award_Date/DOT_Region). ~1.1k." },
];
const SERVICE_BY_KEY = new Map(ARCGIS_SERVICES.map((s) => [s.key, s]));
const DATE_NOTE = "ArcGIS date fields are epoch MILLISECONDS (e.g. DUE_DATE, OPENDATE, CLOSEDATE); a negative/sentinel value (≈ year 1900) is a placeholder, not a real date — surfaced verbatim, parse client-side.";
// ─── SSRF-guarded fetch (fixed allowlist base + hostname assertion) ──
async function getArcgisQuery(svc, params) {
    const url = `${svc.base}/query?${params.toString()}`;
    const allowedHost = new URL(svc.base).hostname;
    const built = new URL(url);
    if (built.hostname !== allowedHost || built.protocol !== "https:") {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Constructed ArcGIS URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the allowlisted service host ${JSON.stringify(allowedHost)} over https — refusing to fetch (SSRF safety).`,
            retryable: false,
            upstreamEndpoint: `arcgis:${svc.key}`,
        });
    }
    return getJson(url, { label: `arcgis:${svc.key}`, redirect: "error" });
}
// ArcGIS returns HTTP 200 + `{error:{code,message}}` for BOTH a bad query AND a
// transient server hiccup, and the messages OVERLAP (live-verified 2026-07-19):
//   - "Failed to execute query." ⇒ a bad column/field/where (the caller's query).
//   - "Unable to complete operation." ⇒ AMBIGUOUS — a bad SQL syntax OR a transient
//     server blip (observed intermittently on a valid query).
// So classify a clearly-input message as invalid_input (non-retryable), but treat
// the ambiguous/generic one as upstream_unavailable (RETRYABLE) — misclassifying a
// server blip as invalid_input would falsely blame the caller for an outage.
const ARCGIS_INPUT_ERROR_RE = /failed to execute query|invalid|parameter|field|syntax|parse|not supported|does not exist|cannot find|out of range/i;
/** An ArcGIS `{error:{code,message}}` body (HTTP 200) ⇒ throw the right kind. */
function throwIfArcgisError(svc, body) {
    const e = body?.error;
    if (e && typeof e === "object") {
        const code = num(e.code);
        const msg = String(e.message ?? "ArcGIS query error");
        const inputish = code === 400 && ARCGIS_INPUT_ERROR_RE.test(msg);
        throw new ToolErrorCarrier({
            kind: inputish ? "invalid_input" : "upstream_unavailable",
            message: `ArcGIS ${svc.key} error${code !== null ? ` (${code})` : ""}: ${msg}`.slice(0, 300),
            retryable: !inputish,
            upstreamEndpoint: `arcgis:${svc.key}`,
        });
    }
}
/**
 * Query rows from a curated ArcGIS REST feature layer. `service` is an allowlist
 * enum; `where` (SQL-ish filter, default 1=1), `outFields` (default *),
 * `orderByFields`, `limit`/`offset`. Returns curated record attributes + honest
 * `_meta` (totalAvailable = the layer's exact match count via a returnCountOnly
 * companion; epoch-ms date disclosure).
 */
export async function featureQuery(args) {
    const svc = SERVICE_BY_KEY.get(args.service);
    if (!svc) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            message: `Unknown ArcGIS service ${JSON.stringify(args.service)}. Allowed: ${ARCGIS_SERVICES.map((s) => s.key).join(", ")}.`,
            retryable: false,
        });
    }
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    const where = args.where && args.where.trim() ? args.where.trim() : "1=1";
    const outFields = args.outFields && args.outFields.trim() ? args.outFields.trim() : "*";
    const filtersApplied = ["service"];
    if (args.where && args.where.trim())
        filtersApplied.push("where");
    // ── Primary rows query. ──
    const rowParams = new URLSearchParams();
    rowParams.set("where", where);
    rowParams.set("outFields", outFields);
    rowParams.set("returnGeometry", "false");
    rowParams.set("resultOffset", String(offset));
    rowParams.set("resultRecordCount", String(limit));
    if (args.orderByFields && args.orderByFields.trim())
        rowParams.set("orderByFields", args.orderByFields.trim());
    rowParams.set("f", "json");
    let body;
    try {
        body = await getArcgisQuery(svc, rowParams);
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(`arcgis:${svc.key}`, "ArcGIS returned a non-JSON body at HTTP 200 — schema drift.");
        throw e;
    }
    throwIfArcgisError(svc, body); // P2: a 200 {error} body ⇒ throw (never a fake empty)
    const b = (body ?? {});
    // P4: features MUST be an array (a missing/non-array, with no error, is drift).
    if (!Array.isArray(b.features)) {
        throw driftError(`arcgis:${svc.key}`, "ArcGIS shape drift — response.features must be an array.");
    }
    const records = b.features.map((f) => f?.attributes ?? {});
    const returned = records.length;
    // ── P1: totalAvailable = the layer's exact match count (returnCountOnly
    //    companion). BEST-EFFORT: any count failure ⇒ null + note (rows kept). ──
    let totalAvailable = null;
    let countNote = null;
    try {
        const countParams = new URLSearchParams();
        countParams.set("where", where);
        countParams.set("returnCountOnly", "true");
        countParams.set("f", "json");
        const cbody = await getArcgisQuery(svc, countParams);
        throwIfArcgisError(svc, cbody);
        const c = num(cbody?.count);
        if (c !== null)
            totalAvailable = c;
        else
            countNote = "The returnCountOnly companion returned an unexpected shape — totalAvailable is unknown (null); the rows are still complete.";
    }
    catch {
        countNote = "The returnCountOnly companion failed (transient) — totalAvailable is unknown (null); the rows are still returned.";
    }
    const exceeded = b.exceededTransferLimit === true;
    const hasMore = totalAvailable !== null ? offset + returned < totalAvailable : (exceeded || returned >= limit);
    const nextOffset = hasMore ? offset + returned : null;
    const notes = [`Source: ${svc.label} (ArcGIS REST feature layer, keyless). ${svc.note}`, DATE_NOTE];
    if (countNote)
        notes.push(countNote);
    return withMeta({ service: svc.key, records }, {
        source: `${new URL(svc.base).hostname} via ArcGIS REST (keyless)`,
        keylessMode: true,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    });
}
//# sourceMappingURL=arcgis-feature.js.map