/**
 * opengov.ts — OpenGov Procurement (formerly ProcureNow) public solicitations,
 * a keyless-first SLED bid source (loop cycle — SLED bid campaign, 2026-07-19).
 *
 * WHAT IT ADDS: OpenGov Procurement hosts the live open-solicitation portals of
 * **525+ US state/local governments** (cities, counties, school & special
 * districts across 42 states + DC). The public portal SPA
 * (`procurement.opengov.com/portal/{code}`) is served by an UNAUTHENTICATED
 * backend REST API — the official key-gated `api-key` API is NOT used; this
 * consumes ONLY the anonymous endpoints the public portal itself calls, so it is
 * genuinely keyless (live-verified 2026-07-19: bare anonymous request, no api-key /
 * auth header / cookie). It is the OpenGov sibling of the Socrata/CKAN/ArcGIS
 * discovery tools and one of the two highest-reach keyless SLED bid feeds (with
 * Bonfire RSS).
 *
 * The module writes ZERO fetch/coercion/error/meta code — it REUSES `getJson`
 * (GET + POST/JSON via ADR-0014, redirect:"error") / `driftError` / `num`·`str`
 * (coerce.ts, null-never-0 / null-never-empty) / `withMeta`·`buildMeta`,
 * mirroring datagov-catalog.ts. KEYLESS: no key seam.
 *
 * ★ SSRF: the host is a compile-time literal (`OPENGOV_HOST`). All inputs ride in
 *   a MODULE-BUILT JSON body / URLSearchParams from validated typed args — NO
 *   raw-host/raw-path passthrough (this is a FIXED-host API). A post-construction
 *   hostname/protocol assertion + `redirect:"error"` lock every call.
 *
 * ★ TWO endpoints (both anonymous, live-verified):
 *   - `GET /api/v1/government` → a flat JSON array of ~560 org records (the whole
 *     directory in one call; `government.code` = the portal slug). We keep the
 *     ACTIVE, non-internal ones (~525 real public portals).
 *   - `POST /api/v1/project/list` body `{governmentCode, publicView:true, page,
 *     limit}` → `{projects:[…], count}`. `publicView:true` is REQUIRED (the public
 *     gate). `count` is the TRUE total of public projects for that org.
 *
 * ★ HONESTY PILLARS (captured live 2026-07-19):
 *   P1: totalAvailable = the real total — the filtered directory length (govt
 *     list) or the API's `count` (solicitations) — NEVER the page length.
 *   P2: getJson→fetchWithRetry THROWS on 429 / 5xx / timeout — NEVER a fake empty.
 *     A genuine no-match (projects:[], count:0) ⇒ honest empty.
 *   P3: every scalar via `str` (null-never-empty) / `num` (null-never-0). The
 *     `status` enum is surfaced VERBATIM (open = currently accepting; the response
 *     also carries pending/evaluation/closed — the CONSUMER filters; we do not
 *     hide non-open rows or fabricate an "open count").
 *   P4: `/government` non-array or `/project/list` `.projects` non-array ⇒
 *     driftError; a 200 non-JSON body ⇒ schema_drift via the catch-ladder
 *     (ToolErrorCarrier rethrow FIRST so a 429/5xx keeps its taxonomy).
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (num-parity guard).
export { num };

// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
export const OPENGOV_HOST = "api.procurement.opengov.com";
const OPENGOV_GOVERNMENT_PATH = "/api/v1/government";
const OPENGOV_PROJECT_LIST_PATH = "/api/v1/project/list";
const OPENGOV_GOV_LABEL = "opengov:/api/v1/government";
const OPENGOV_PROJ_LABEL = "opengov:/api/v1/project/list";
const OPENGOV_SOURCE = "procurement.opengov.com via OpenGov Procurement public API (keyless)";
const OPENGOV_PORTAL = "https://procurement.opengov.com/portal";

// The org slug grammar (SSRF + injection guard). Real slugs are lowercase
// alnum + hyphen (e.g. "santacruzca", "u-46", "twc-texas-gov"). Validated
// BEFORE it rides the JSON body — a "../"/space/uppercase ⇒ invalid_input, 0 fetch.
export const OPENGOV_CODE_RE = /^[a-z0-9-]{1,64}$/;

const OPENGOV_STATUS_NOTE =
  "`status` is surfaced verbatim: open = currently ACCEPTING responses; pending/evaluation/closed are also returned (publicView shows all public projects). Filter status==='open' for live bids. totalAvailable is the org's TOTAL public-project count (all statuses), not an open-only count.";

// ─── The curated shapes ───────────────────────────────────────────
export type OpengovGovernment = {
  code: string | null;
  name: string | null;
  city: string | null;
  state: string | null;
  website: string | null;
};

export type OpengovSolicitation = {
  id: number | null;
  title: string | null;
  solicitationNumber: string | null; // financialId
  status: string | null;
  type: string | null;
  department: string | null;
  releaseDate: string | null;
  proposalDeadline: string | null; // close/due date
  contactName: string | null;
  link: string | null;
};

/** null-preserving boolean (a real true/false survives; else null). */
function boolOrNull(x: unknown): boolean | null {
  return typeof x === "boolean" ? x : null;
}

// ─── SSRF-guarded fetch (fixed host + hostname assertion + redirect) ──
async function getOpengov(
  path: string,
  label: string,
  init: { method?: "POST"; body?: string } = {},
): Promise<unknown> {
  const url = `https://${OPENGOV_HOST}${path}`;
  const built = new URL(url);
  if (built.hostname !== OPENGOV_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed OpenGov URL host ${JSON.stringify(built.hostname)} (${built.protocol}) does not match the fixed host ${JSON.stringify(OPENGOV_HOST)} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: label,
    });
  }
  const headers: Record<string, string> =
    init.method === "POST" ? { "Content-Type": "application/json" } : {};
  return getJson(url, { label, headers, redirect: "error", ...init });
}

// ─── Tool 1: opengov_list_governments (the directory) ─────────────
export type OpengovListGovernmentsArgs = {
  state?: string;
  query?: string;
  limit?: number;
  offset?: number;
};

/**
 * List the OpenGov Procurement government portals (the whole directory arrives in
 * ONE keyless GET). Client-side filters: `state` (2-letter), `query` (name
 * substring). Only ACTIVE, non-internal portals are kept. Feeds `code` to
 * opengov_search_solicitations. totalAvailable = the filtered directory size (P1).
 */
export async function listGovernments(
  args: OpengovListGovernmentsArgs,
): Promise<MetaBundle> {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  let body: unknown;
  try {
    body = await getOpengov(OPENGOV_GOVERNMENT_PATH, OPENGOV_GOV_LABEL);
  } catch (e) {
    if (e instanceof ToolErrorCarrier) throw e;
    if (e instanceof SyntaxError)
      throw driftError(OPENGOV_GOV_LABEL, "OpenGov /government returned a non-JSON body at HTTP 200 — schema drift.");
    throw e;
  }
  // P4: the response MUST be an array (a missing/object body is drift).
  if (!Array.isArray(body)) {
    throw driftError(OPENGOV_GOV_LABEL, "OpenGov /government shape drift — response must be a JSON array of governments.");
  }

  const stateFilter = args.state ? args.state.trim().toUpperCase() : null;
  const queryFilter = args.query ? args.query.trim().toLowerCase() : null;
  const filtersApplied: string[] = [];
  if (stateFilter) filtersApplied.push("state");
  if (queryFilter) filtersApplied.push("query");

  const all: OpengovGovernment[] = [];
  for (const row of body as unknown[]) {
    const r = (row ?? {}) as Record<string, unknown>;
    // Keep only active, non-internal, non-vendor real public portals.
    if (boolOrNull(r.isActive) === false) continue;
    if (boolOrNull(r.isInternal) === true) continue;
    const gov = (r.government ?? {}) as Record<string, unknown>;
    const g: OpengovGovernment = {
      code: str(gov.code),
      name: str(r.name),
      city: str(r.city),
      state: str(r.state),
      website: str(r.website),
    };
    if (g.code === null) continue; // no portal slug ⇒ not queryable
    if (stateFilter && (g.state ?? "").toUpperCase() !== stateFilter) continue;
    if (queryFilter && !(g.name ?? "").toLowerCase().includes(queryFilter)) continue;
    all.push(g);
  }

  const totalAvailable = all.length;
  const page = all.slice(offset, offset + limit);
  const returned = page.length;
  const hasMore = offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  const notes: string[] = [
    "The full OpenGov Procurement directory is returned in one keyless call and filtered client-side; totalAvailable is the exact filtered portal count. Feed a result's `code` to opengov_search_solicitations.",
  ];
  if (filtersApplied.length === 0) {
    notes.push("No filters applied — this lists ALL active OpenGov portals. Add `state` and/or `query` to scope.");
  }

  return withMeta(
    { governments: page },
    {
      source: OPENGOV_SOURCE,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool 2: opengov_search_solicitations (per org) ───────────────
export type OpengovSearchSolicitationsArgs = {
  governmentCode: string;
  limit?: number;
  offset?: number;
};

/**
 * List an OpenGov government's public solicitations (POST /project/list with the
 * REQUIRED publicView gate). Returns all public projects with `status` surfaced
 * (filter status==='open' for live bids). totalAvailable = the API's `count` (the
 * org's total public-project count — P1, never the page length).
 */
export async function searchSolicitations(
  args: OpengovSearchSolicitationsArgs,
): Promise<MetaBundle> {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const code = args.governmentCode ?? "";

  // Belt-and-suspenders slug grammar (behind the server's Zod). A bad slug would
  // ride the JSON body and either error or mis-scope — reject pre-fetch (0 fetch).
  if (!OPENGOV_CODE_RE.test(code)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid OpenGov governmentCode ${JSON.stringify(code)} — expected a lowercase-alnum/hyphen portal slug (≤64 chars) from opengov_list_governments (e.g. 'santacruzca', 'u-46').`,
      retryable: false,
      upstreamEndpoint: OPENGOV_PROJ_LABEL,
    });
  }

  // The API paginates by 0-based `page` + `limit`. Map our offset → page.
  const page = Math.floor(offset / limit);
  const servedOffset = page * limit;
  const payload = JSON.stringify({ governmentCode: code, publicView: true, page, limit });

  let body: unknown;
  try {
    body = await getOpengov(OPENGOV_PROJECT_LIST_PATH, OPENGOV_PROJ_LABEL, { method: "POST", body: payload });
  } catch (e) {
    if (e instanceof ToolErrorCarrier) throw e;
    if (e instanceof SyntaxError)
      throw driftError(OPENGOV_PROJ_LABEL, "OpenGov /project/list returned a non-JSON body at HTTP 200 — schema drift.");
    throw e;
  }

  const b = (body ?? {}) as { projects?: unknown; count?: unknown };
  // P4: `projects` MUST be an array (a missing/object projects is drift).
  if (!Array.isArray(b.projects)) {
    throw driftError(OPENGOV_PROJ_LABEL, "OpenGov /project/list shape drift — response.projects must be an array.");
  }

  const solicitations: OpengovSolicitation[] = (b.projects as unknown[]).map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = num(r.id);
    const codeForLink = code;
    return {
      id,
      title: str(r.title),
      solicitationNumber: str(r.financialId),
      status: str(r.status),
      type: str(r.type),
      department: str(r.departmentName),
      releaseDate: str(r.releaseProjectDate ?? r.postedAt),
      proposalDeadline: str(r.proposalDeadline),
      contactName: [str(r.contactFirstName), str(r.contactLastName)].filter((v) => v !== null).join(" ") || null,
      link: id !== null ? `${OPENGOV_PORTAL}/${codeForLink}/projects/${id}` : null,
    };
  });
  const returned = solicitations.length;

  // P1: totalAvailable = the API `count` (total public projects), NEVER page length.
  const totalAvailable = num(b.count);
  const hasMore =
    totalAvailable !== null ? servedOffset + returned < totalAvailable : returned >= limit;
  const nextOffset = hasMore ? servedOffset + returned : null;

  const notes: string[] = [OPENGOV_STATUS_NOTE];
  if (servedOffset !== offset) {
    notes.push(`offset was snapped to the page boundary ${servedOffset} (OpenGov paginates by fixed pages of ${limit}).`);
  }
  if (totalAvailable === null) {
    notes.push("totalAvailable is unknown (the API omitted `count`); completeness inferred from page fullness.");
  }

  return withMeta(
    { governmentCode: code, solicitations },
    {
      source: OPENGOV_SOURCE,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied: ["governmentCode", "publicView"],
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset: servedOffset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
