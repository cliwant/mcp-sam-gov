/**
 * tableau.ts — Tableau Server "Guest" view CSV export, a keyless-first SLED
 * transparency source (loop cycle 75, 2026-07-24 — Montana dark-state closure).
 *
 * WHAT IT ADDS: many US state/local governments publish contracts / vendor-payment
 * / checkbook data on a Guest-enabled Tableau Server. A WORKSHEET view exports its
 * FULL summary data as CSV at
 *   `https://{host}/t/{site}/views/{workbook}/{view}.csv?:embed=y`
 * — anonymous, KEYLESS (no login, key, or session cookie required). This is the
 * export the public Tableau UI itself offers ("Download ▸ Data"). First payload:
 * Montana state **Contracts Awarded** (DOA), a live gov-con award register.
 *
 * ★ CURATED allowlist (SSRF core): each `base` is a FIXED, live-verified Tableau
 *   Server view URL (up to the view name; the tool appends `.csv?:embed=y`). The
 *   `view` enum in server.ts is built FROM the keys (single source of truth), and
 *   a post-construction hostname assertion (over https) guards the fetch
 *   (`redirect:"error"`). where/columns cannot alter the host.
 *
 * ★ HONESTY PILLARS:
 *   P1: the CSV is the COMPLETE view export — Tableau returns ALL summary rows in
 *     the view (there is NO server-side pagination on this endpoint), so
 *     totalAvailable = the parsed DATA-row count (the true total, NOT a page
 *     length); limit/offset page over it CLIENT-side. NOTE (disclosed every
 *     response): a Tableau Server MAY server-cap a very large summary export — the
 *     seeded views are live-verified COMPLETE (non-round counts), and a round-number
 *     count is flagged as a possible cap.
 *   P2: getText THROWS on 429 / 5xx / 404 / timeout — NEVER a fake empty. A view
 *     that is gated/renamed (a 200 sign-in HTML, or a dashboard-CONTAINER whose CSV
 *     export is empty) ⇒ schema_drift (a loud, honest failure — NEVER a silent 0).
 *     A worksheet that legitimately has a header but zero data rows ⇒ honest empty.
 *   P3: values are TRIMMED strings (surrounding whitespace removed; an empty field
 *     ⇒ null, never 0 or ""). The value CONTENT is preserved — amounts/dates are
 *     FORMATTED STRINGS (e.g. "$5,879,590.00"), parse client-side. Header trimmed.
 *   P4: a 200 body that is not CSV (HTML, or no header row) ⇒ schema_drift.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export type TableauView = {
    key: string;
    base: string;
    label: string;
    note: string;
};
export declare const TABLEAU_VIEWS: readonly TableauView[];
export type TableauViewCsvArgs = {
    view: string;
    limit?: number;
    offset?: number;
};
/**
 * Fetch a curated Tableau Server Guest view's COMPLETE CSV export (keyless) and
 * page over it client-side. `view` is an allowlist enum; `limit`/`offset` page
 * the parsed rows. Returns { view, columns, rows:[{col:value…}] } + honest _meta
 * (totalAvailable = the complete row count, NOT a page length).
 */
export declare function viewCsv(args: TableauViewCsvArgs): Promise<MetaBundle>;
//# sourceMappingURL=tableau.d.ts.map