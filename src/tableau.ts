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

import { ToolErrorCarrier } from "./errors.js";
import { getText, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { parseCsv } from "./gov-domains.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

export { num };

// ─── Curated view allowlist (SSRF core) — LIVE-VERIFIED 2026-07-24 ──
// Each `base` is the Tableau Server view URL WITHOUT extension; the tool appends
// `.csv?:embed=y`. All keyless (anonymous, empty-cookie 200 verified).
export type TableauView = { key: string; base: string; label: string; note: string };
export const TABLEAU_VIEWS: readonly TableauView[] = [
  {
    key: "mt_contracts_awarded",
    base: "https://tableau-ext.mt.gov/t/DOA/views/ContractsAwarded/ContractsAwarded",
    label: "Montana DOA — Contracts Awarded",
    note: "State of Montana contract/solicitation awards (columns: '$ Awarded', 'Award Date', 'Event Title', 'Event Type' (Invitation For Bid / Request for Proposal), 'Event#' (solicitation number), 'Montana Vendor' (Y/N; '?'=unknown), 'Vendor Name', 'Agency'). ~4,554 awards, April 2020–present. ★'$ Awarded' is a FORMATTED STRING (e.g. \" $1,878,796.10 \") — parse client-side. Source: transparency.mt.gov (Tableau Server Guest CSV).",
  },
] as const;

const VIEW_BY_KEY: ReadonlyMap<string, TableauView> = new Map(TABLEAU_VIEWS.map((v) => [v.key, v]));

const VALUE_NOTE =
  "Values are TRIMMED strings (surrounding whitespace removed; an empty field ⇒ null, never 0 or \"\"). The content is preserved — amounts/dates are FORMATTED STRINGS (e.g. \"$5,879,590.00\"), parse client-side.";

/** Build the `.csv?:embed=y` export URL + assert it stays on the allowlisted host. */
function csvUrl(v: TableauView): string {
  const url = `${v.base}.csv?:embed=y`;
  const allowedHost = new URL(v.base).hostname;
  const built = new URL(url);
  if (built.hostname !== allowedHost || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed Tableau URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the allowlisted view host ${JSON.stringify(allowedHost)} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: `tableau:${v.key}`,
    });
  }
  return url;
}

// ─── Tool: tableau_view_csv ───────────────────────────────────────
export type TableauViewCsvArgs = { view: string; limit?: number; offset?: number };

/**
 * Fetch a curated Tableau Server Guest view's COMPLETE CSV export (keyless) and
 * page over it client-side. `view` is an allowlist enum; `limit`/`offset` page
 * the parsed rows. Returns { view, columns, rows:[{col:value…}] } + honest _meta
 * (totalAvailable = the complete row count, NOT a page length).
 */
export async function viewCsv(args: TableauViewCsvArgs): Promise<MetaBundle> {
  const v = VIEW_BY_KEY.get(args.view);
  if (!v) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Unknown Tableau view ${JSON.stringify(args.view)}. Allowed: ${TABLEAU_VIEWS.map((s) => s.key).join(", ")}.`,
      retryable: false,
    });
  }
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  // ── Fetch the full view CSV. getText THROWS on 429/5xx/404/timeout (P2). ──
  const url = csvUrl(v);
  const body = await getText(url, { label: `tableau:${v.key}`, redirect: "error", timeoutMs: 45_000 });

  // P4: a non-CSV body (HTML sign-in / error page) ⇒ schema_drift, never parsed as empty.
  const text = body.replace(/^﻿/, ""); // strip a leading UTF-8 BOM if present
  if (text.trim().length === 0 || /^\s*</.test(text)) {
    throw driftError(
      `tableau:${v.key}`,
      "Tableau returned an empty or non-CSV (HTML) body at HTTP 200 — the view may be gated, renamed, or a dashboard container (not a worksheet). Schema drift — refusing to report a fake empty.",
    );
  }

  const table = parseCsv(text);
  // P4: the first row MUST be a header (≥1 named column). No rows ⇒ drift.
  if (table.length === 0 || !Array.isArray(table[0]) || table[0].length === 0) {
    throw driftError(`tableau:${v.key}`, "Tableau CSV has no header row — schema drift.");
  }
  const header = table[0].map((h) => str(h) ?? "");
  const dataRows = table.slice(1);
  const totalAvailable = dataRows.length; // P1: complete view export = true total

  const pageRows = dataRows.slice(offset, offset + limit).map((r) => {
    const obj: Record<string, string | null> = {};
    for (let i = 0; i < header.length; i++) obj[header[i] || `col${i}`] = str(r[i]);
    return obj;
  });
  const returned = pageRows.length;
  const hasMore = offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  // P1 cap disclosure: a suspiciously round total may indicate a server export cap.
  const roundCap = totalAvailable >= 1000 && totalAvailable % 1000 === 0;
  const notes: string[] = [
    `Source: ${v.label} (Tableau Server Guest CSV export, keyless). ${v.note}`,
    "totalAvailable is the COMPLETE view export row count (Tableau returns all summary rows; there is no server-side pagination) — limit/offset page over the full set client-side.",
    "Pagination order follows the Tableau view's OWN sort. Each call re-fetches the complete CSV and slices it; if the view lacks a stable sort, offsets across SEPARATE calls could shift — for a consistent snapshot of a large view, fetch it with a single large limit.",
    VALUE_NOTE,
  ];
  if (roundCap)
    notes.push(
      `NOTE: the row count (${totalAvailable}) is an exact multiple of 1000 — Tableau Server MAY have capped this summary export, so totalAvailable could be a lower bound. Treat with caution.`,
    );

  return withMeta(
    { view: v.key, columns: header, rows: pageRows },
    {
      source: `${new URL(v.base).hostname} via Tableau Server Guest CSV (keyless)`,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied: ["view"],
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
