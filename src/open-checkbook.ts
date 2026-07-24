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

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

export { num };

// ─── Curated portal allowlist (SSRF core) — LIVE-VERIFIED 2026-07-24 ──
export type OpenCheckbookPortal = { key: string; host: string; label: string; note: string };
export const OPEN_CHECKBOOK_PORTALS: readonly OpenCheckbookPortal[] = [
  {
    key: "sd",
    host: "southdakota.spending.socrata.com",
    label: "South Dakota — Open Checkbook",
    note: "State of South Dakota vendor-payment checkbook (row fields: expense_category, description, fund, payment_date, vendor, org1=department, amount, custom_checkbook_field7=invoice ref, payment_id). ~740,980 rows / ~$8.41B across the ~3 most-recent fiscal years (NOT full history). The underlying Socrata SODA dataset is login-gated; this public app-proxy is the keyless door.",
  },
] as const;

const PORTAL_BY_KEY: ReadonlyMap<string, OpenCheckbookPortal> = new Map(OPEN_CHECKBOOK_PORTALS.map((p) => [p.key, p]));

// Sort fields the product supports (validated — an SSRF/injection + silent-noop guard).
const SORT_FIELDS = new Set(["amount", "payment_date", "vendor", "org1", "expense_category"]);

// ─── SSRF-guarded fetch (fixed allowlist host + assertion) ──
async function getCheckbook(portal: OpenCheckbookPortal, params: URLSearchParams): Promise<unknown> {
  const url = `https://${portal.host}/api/checkbook_data.json?${params.toString()}`;
  const built = new URL(url);
  if (built.hostname !== portal.host || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed Open-Checkbook URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the allowlisted portal host ${JSON.stringify(portal.host)} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: `open-checkbook:${portal.key}`,
    });
  }
  return getJson(url, { label: `open-checkbook:${portal.key}`, redirect: "error" });
}

// ─── Tool: open_checkbook_search ──────────────────────────────────
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
export async function openCheckbookSearch(args: OpenCheckbookSearchArgs): Promise<MetaBundle> {
  const portal = PORTAL_BY_KEY.get(args.portal);
  if (!portal) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Unknown Open-Checkbook portal ${JSON.stringify(args.portal)}. Allowed: ${OPEN_CHECKBOOK_PORTALS.map((p) => p.key).join(", ")}.`,
      retryable: false,
    });
  }
  const limit = args.limit ?? 25;
  const offset = args.offset ?? 0;
  // The product paginates by 1-based `page` + `limit`. Map offset→page and snap
  // offset to the page boundary (disclosing the served offset when it differs).
  const page = Math.floor(offset / limit) + 1;
  const servedOffset = (page - 1) * limit;

  const filtersApplied: string[] = ["portal"];
  const params = new URLSearchParams();
  params.set("year", args.year && args.year.trim() ? args.year.trim() : "All Years");
  if (args.year && args.year.trim()) filtersApplied.push("year");
  if (args.vendor && args.vendor.trim()) { params.set("vendor", args.vendor.trim()); filtersApplied.push("vendor"); }
  if (args.org && args.org.trim()) { params.set("org1", args.org.trim()); filtersApplied.push("org"); }
  if (args.expenseCategory && args.expenseCategory.trim()) { params.set("expense_category", args.expenseCategory.trim()); filtersApplied.push("expenseCategory"); }
  if (args.sortBy && args.sortBy.trim()) {
    const sf = args.sortBy.trim();
    if (!SORT_FIELDS.has(sf)) {
      throw new ToolErrorCarrier({
        kind: "invalid_input",
        message: `Invalid sortBy ${JSON.stringify(sf)}. Allowed: ${[...SORT_FIELDS].join(", ")}.`,
        retryable: false,
      });
    }
    params.set("sort_field", sf);
    params.set("sort_order", args.sortOrder === "asc" ? "asc" : "desc");
    filtersApplied.push("sortBy");
  }
  params.set("page", String(page));
  params.set("limit", String(limit));

  const body = await getCheckbook(portal, params);
  const b = (body ?? {}) as { data?: unknown; count?: unknown; total_amount?: unknown };
  // P4: the shape MUST be { data:[…], count:<number> }.
  if (!Array.isArray(b.data)) throw driftError(`open-checkbook:${portal.key}`, "Open-Checkbook shape drift — response.data must be an array.");
  const totalAvailable = num(b.count);
  if (totalAvailable === null) throw driftError(`open-checkbook:${portal.key}`, "Open-Checkbook shape drift — response.count must be a number.");

  const rows = (b.data as unknown[]).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      vendor: str(o.vendor),
      amount: num(o.amount), // P3: a real $0 is 0; absent ⇒ null (never a fabricated 0)
      payment_date: str(o.payment_date),
      org1: str(o.org1),
      expense_category: str(o.expense_category),
      description: str(o.description),
      fund: str(o.fund),
      invoice: str(o.custom_checkbook_field7),
      payment_id: str(o.payment_id),
    };
  });
  const returned = rows.length;
  const hasMore = servedOffset + returned < totalAvailable;
  const nextOffset = hasMore ? servedOffset + returned : null;

  const notes: string[] = [
    `Source: ${portal.label} (Socrata Open Expenditures app-proxy /api/checkbook_data.json, keyless). ${portal.note}`,
    "totalAvailable = the API's exact match count (matches the product's totals.json), NOT the page length.",
    "Filters (year/vendor/org/expenseCategory) are EXACT-match — a partial/misspelled value returns an honest count:0, not an error. amount is number|null (a real $0 is 0, an absent value is null, never a fabricated 0).",
    "COVERAGE: only the ~3 most-recent fiscal years are exposed by this product — this is NOT the state's full payment history.",
  ];
  if (servedOffset !== offset)
    notes.push(`offset ${offset} was snapped to ${servedOffset} (the product paginates by fixed page×limit); pass an offset that is a multiple of limit to avoid snapping.`);

  return withMeta(
    { portal: portal.key, rows },
    {
      source: `${portal.host} via Socrata Open Expenditures (keyless app-proxy)`,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset: servedOffset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
