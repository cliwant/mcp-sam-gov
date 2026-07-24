/**
 * open-checkbook.ts — Socrata "Open Expenditures / Open Checkbook" row-level
 * vendor-payment API, a keyless-first SLED source (loop cycle 76, 2026-07-24 —
 * South Dakota dark-state closure, the LAST dark state).
 *
 * WHAT IT ADDS: some US governments run Socrata's "Open Expenditures" product,
 * whose public dashboard fronts a KEYLESS app-proxy JSON API at
 *   `https://{host}/api/checkbook_data.json?year=…&{filters}&page=P&limit=L`
 * → `{ data:[…row-level payments…], count, total_amount }`. First (and, as of
 * this writing, only live-verified) portal: **South Dakota Open Checkbook**
 * (740,980 vendor-payment rows, ~$8.41B, the ~3 most-recent fiscal years).
 *
 * ★ KEYLESS- vs-GATED HONESTY (load-bearing): the app-proxy above is anonymous
 *   and public. The UNDERLYING Socrata SODA dataset (7uwr-juaf on
 *   southdakota.data.socrata.com) is **403 login-gated** — this module NEVER
 *   touches it and NEVER presents it as reachable. We only call the public
 *   /api/checkbook_data.json surface the dashboard itself uses anonymously.
 *
 * ★ CURATED allowlist (SSRF core): each portal is a FIXED, live-verified host;
 *   the `portal` enum in server.ts is built FROM the keys. Host asserted before
 *   fetch (redirect:"error").
 *
 * ★ HONESTY PILLARS:
 *   P1: totalAvailable = the API's own `count` (the REAL filtered total — it
 *     matches the product's totals.json exactly; e.g. 740,980 unfiltered,
 *     109,887 for org1=TRANSPORTATION), NEVER the page length.
 *   P2: getJson THROWS on 429/5xx/timeout — NEVER a fake empty. A bogus filter
 *     ⇒ honest count:0/empty; a deep offset past the end ⇒ returned:0 with the
 *     real count preserved (an honest tail, not an outage).
 *   P3: `amount` ⇒ number|null (a real $0 is 0, an absent value is null, never a
 *     fabricated 0); all other fields via str (null-never-empty). Dates verbatim.
 *   P4: a body that is not `{data:[…], count:<number>}` ⇒ schema_drift.
 *   ★ Coverage disclosure (P5): only the ~3 most-recent fiscal years are exposed
 *     by the product (NOT full history) — disclosed every response.
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export type OpenCheckbookPortal = {
    key: string;
    host: string;
    label: string;
    note: string;
};
export declare const OPEN_CHECKBOOK_PORTALS: readonly OpenCheckbookPortal[];
export type OpenCheckbookSearchArgs = {
    portal: string;
    year?: string;
    vendor?: string;
    org?: string;
    expenseCategory?: string;
    sortBy?: string;
    sortOrder?: string;
    limit?: number;
    offset?: number;
};
/**
 * Row-level vendor-payment search over a curated Socrata Open-Expenditures
 * checkbook portal (keyless). `portal` is an allowlist enum; `year`/`vendor`/
 * `org`/`expenseCategory` are EXACT-match filters; `sortBy`/`sortOrder` sort;
 * `limit`/`offset` page. Returns { portal, rows:[…] } + honest _meta
 * (totalAvailable = the API's real count, NOT a page length).
 */
export declare function openCheckbookSearch(args: OpenCheckbookSearchArgs): Promise<MetaBundle>;
//# sourceMappingURL=open-checkbook.d.ts.map