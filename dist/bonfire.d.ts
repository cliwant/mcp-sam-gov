/**
 * bonfire.ts — Bonfire (Euna Solutions) per-organization open-solicitation RSS,
 * a keyless-first SLED bid source (loop — SLED bid campaign, 2026-07-19).
 *
 * WHAT IT ADDS: Bonfire hosts the open-bid portals of thousands of US state/local
 * governments; each org exposes a KEYLESS RSS 2.0 feed of its currently-open
 * opportunities at `https://{org}.bonfirehub.com/opportunities/rss` (live-verified
 * on Dallas/Harris County/Utah/Bernalillo/…). One of the two highest-reach keyless
 * SLED bid feeds (with OpenGov Procurement).
 *
 * ★ NO keyless directory API: Bonfire's authoritative org list
 * (`GET common-production-api-global.bonfirehub.com/v1.0/organizations/external`)
 * is AUTH-GATED (a free vendor-account token) — OUT OF BOUNDS (we never sign in).
 * So this ships a CURATED, live-verified SEED directory (187 US orgs; §BONFIRE_
 * ORGS) as `bonfire_list_organizations`, and documents the keyless RSS-probe
 * refresh method (no catch-all: `{slug}.bonfirehub.com/opportunities/rss` returns
 * 200 <rss> for a real org, a connection failure for a non-provisioned slug). The
 * seed is a PARTIAL directory (Euna markets up to ~900 US orgs) — disclosed.
 *
 * The module REUSES `getText` (shared XML/RSS fetch, redirect:"error") /
 * `driftError` / `str`·`num` / `withMeta`·`buildMeta`, mirroring fpds/gao. KEYLESS.
 *
 * ★ SSRF: org is charclass-validated (`^[a-z0-9-]{1,64}$` — no dots), the URL is
 *   built on the FIXED `.bonfirehub.com` suffix, and a post-construction assertion
 *   requires `hostname === {org}.bonfirehub.com` (over https) BEFORE the fetch;
 *   `redirect:"error"`.
 *
 * ★ HONESTY PILLARS:
 *   P1: the RSS is the COMPLETE current open-opportunity set for the org (no server
 *     pagination), so totalAvailable = the parsed item count (the true total, NOT a
 *     page length); client-side limit/offset page over it.
 *   P2: getText THROWS on 429 / 5xx / 404 / timeout — NEVER a fake empty. An empty
 *     channel (0 items) ⇒ honest empty (the org has no open opportunities now).
 *   P3: every field via `str` (null-never-empty); dates surfaced verbatim.
 *   P4: a 200 body that is not RSS (no `<rss`/`<channel`) ⇒ schema_drift (never
 *     parsed as an empty set).
 */
import { num } from "./coerce.js";
import { type MetaBundle } from "./meta.js";
export { num };
export declare const BONFIRE_ORG_RE: RegExp;
export type BonfireOrg = {
    org: string;
    name: string;
    state: string;
};
export declare const BONFIRE_ORGS: readonly BonfireOrg[];
export type BonfireOpportunity = {
    referenceNumber: string | null;
    name: string | null;
    description: string | null;
    closeDate: string | null;
    link: string | null;
    pubDate: string | null;
};
export type BonfireListArgs = {
    state?: string;
    query?: string;
    limit?: number;
    offset?: number;
};
export declare function listOrganizations(args: BonfireListArgs): Promise<MetaBundle>;
export type BonfireSearchArgs = {
    org: string;
    limit?: number;
    offset?: number;
};
export declare function searchOpportunities(args: BonfireSearchArgs): Promise<MetaBundle>;
//# sourceMappingURL=bonfire.d.ts.map