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
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const OPENGOV_HOST = "api.procurement.opengov.com";
export declare const OPENGOV_CODE_RE: RegExp;
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
    solicitationNumber: string | null;
    status: string | null;
    type: string | null;
    department: string | null;
    releaseDate: string | null;
    proposalDeadline: string | null;
    contactName: string | null;
    link: string | null;
};
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
export declare function listGovernments(args: OpengovListGovernmentsArgs): Promise<MetaBundle>;
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
export declare function searchSolicitations(args: OpengovSearchSolicitationsArgs): Promise<MetaBundle>;
//# sourceMappingURL=opengov.d.ts.map