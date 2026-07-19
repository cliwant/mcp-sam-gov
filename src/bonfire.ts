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

import { ToolErrorCarrier } from "./errors.js";
import { getText, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

export { num };

// ─── Fixed suffix (SSRF core) + org grammar ───────────────────────
const BONFIRE_SUFFIX = ".bonfirehub.com";
export const BONFIRE_ORG_RE = /^[a-z0-9-]{1,64}$/;
const bonfireLabel = (org: string) => `bonfire:${org}/opportunities/rss`;
const BONFIRE_SOURCE = (org: string) =>
  `${org}.bonfirehub.com via Bonfire (Euna) open-opportunities RSS (keyless)`;

const BONFIRE_SEED_NOTE =
  "This directory is a CURATED, live-verified SEED (Bonfire has NO keyless org-list API; the authoritative list is auth-gated and out of bounds). Euna markets up to ~900 US orgs, so the seed is partial — probe `{slug}.bonfirehub.com/opportunities/rss` (200 <rss> = real org) to extend. Feed a result's `org` to bonfire_search_opportunities.";

// ─── The curated 187-org US seed directory (live-verified 2026-07-19) ──
// "slug|Entity|ST" — the slug is the RSS subdomain. Non-US (.ca / cayman / etc.)
// deliberately excluded.
const BONFIRE_SEED_RAW: readonly string[] = [
  "littlerock|City of Little Rock|AR",
  "buckeyeaz|City of Buckeye|AZ", "goodyearaz|City of Goodyear|AZ", "peoriaaz|City of Peoria|AZ", "scottsdaleaz|City of Scottsdale|AZ", "yumaaz|City of Yuma|AZ", "pinalcountyaz|Pinal County|AZ", "susd|Scottsdale USD|AZ", "tollesonuhsd|Tolleson Union HSD|AZ",
  "cityofirvine|City of Irvine|CA", "oaklandca|City of Oakland|CA", "alamedacounty|Alameda County|CA", "solanocounty|Solano County|CA", "ventura|County of Ventura|CA", "yolocounty|Yolo County|CA", "mtc|Metropolitan Transportation Commission|CA", "azusa|Azusa USD|CA", "stocktonusd|Stockton USD|CA", "weta|SF Bay Area Water Emergency Transportation Authority|CA", "acwd|Alameda County Water District|CA", "wrd|Water Replenishment District of Southern CA|CA", "actransit|AC Transit|CA", "marintransit|Marin Transit|CA", "mst|Monterey-Salinas Transit|CA", "omnitrans|Omnitrans|CA", "smctd|San Mateo County Transit District|CA", "sonomamarintrain|Sonoma-Marin Area Rail Transit|CA", "ggbhtd|Golden Gate Bridge Highway & Transportation District|CA",
  "bouldercounty|Boulder County|CO",
  "crcog|Capitol Region Council of Governments|CT", "easternct|Eastern Connecticut State University|CT",
  "dfm|DE OMB - Division of Facility Management|DE", "gss|DE OMB - Government Support Services|DE",
  "daviefl|Town of Davie|FL", "ocoee|City of Ocoee|FL", "broward|Broward County|FL", "hillsboroughcounty|Hillsborough County|FL", "marionfl|Marion County|FL", "monroecounty-fl|Monroe County|FL", "pascocountyfl|Pasco County|FL", "famu|Florida A&M University|FL", "fau|Florida Atlantic University|FL", "fgcu|Florida Gulf Coast University|FL", "floridapoly|Florida Polytechnic University|FL", "ucf|University of Central Florida|FL", "tampabaywater|Tampa Bay Water|FL", "gohart|Hillsborough Transit Authority|FL", "psta|Pinellas Suncoast Transit Authority|FL",
  "brookhavenga|City of Brookhaven|GA", "sandysprings|City of Sandy Springs|GA", "chathamcountyga|Chatham County|GA", "columbiacountyga|Columbia County|GA", "gwinnett|Gwinnett County Public Schools|GA",
  "cityofnampa|City of Nampa|ID", "adacounty|Ada County|ID", "bannockcounty|Bannock County|ID",
  "cookcountyil|Cook County|IL", "thecha|Chicago Housing Authority|IL", "cps|Chicago Public Schools|IL", "u-46|School District U-46|IL", "chicagoparkdistrict|Chicago Park District|IL", "mwrd|Metro Water Reclamation District of Greater Chicago|IL", "transitchicago|Chicago Transit Authority|IL", "metra|Metra|IL",
  "indygo|Indianapolis Public Transportation Corp|IN",
  "olatheks|City of Olathe|KS", "wichita|City of Wichita|KS",
  "covingtonky|City of Covington|KY", "louisvilleky|City of Louisville|KY", "owensboro|City of Owensboro|KY", "lexingtonky|Lexington-Fayette|KY", "kyhousing|Kentucky Housing Corporation|KY", "tarc|Transit Authority of River City|KY",
  "umass|University of Massachusetts|MA",
  "harfordcountymd|Harford County|MD", "habc|Housing Authority of Baltimore City|MD", "hcpss|Howard County Public School System|MD", "menv|Maryland Environmental Service|MD", "mdcourts|Maryland Judiciary|MD",
  "maine|State of Maine|ME",
  "detroit|City of Detroit|MI",
  "ramseycountymn|Ramsey County|MN", "sourcewell|Sourcewell|MN",
  "jeffersoncitymo|Jefferson City|MO", "stlouiscountymo|St. Louis County|MO", "stlcc|St. Louis Community College|MO",
  "apexnc|Town of Apex|NC", "charlottenc|City of Charlotte|NC", "wake|Wake County|NC", "ncat|NC A&T State University|NC", "ncsu|NC State University|NC",
  "rutgers|Rutgers University|NJ",
  "cabq|City of Albuquerque|NM", "mckinleycounty|McKinley County|NM",
  "clarkcountynv|Clark County|NV", "ccsd|Clark County School District|NV",
  "suffolkcountyny|Suffolk County|NY", "stonybrook|Stony Brook University|NY", "healthsolutions|Public Health Solutions|NY", "centro|Central NY Regional Transportation Authority|NY", "nfta|Niagara Frontier Transportation Authority|NY", "panynj|Port Authority of New York & New Jersey|NY",
  "akronohio|City of Akron|OH", "cincinnati-oh|City of Cincinnati|OH", "columbus|City of Columbus|OH", "equalisgroup|Equalis Group|OH",
  "pdx|Portland State University|OR",
  "pennbid|PennBid|PA", "alleghenycounty|Allegheny County|PA",
  "charlestoncounty|Charleston County|SC", "tridenttech|Trident Technical College|SC",
  "apsu|Austin Peay State University|TN",
  "dfwairport|DFW International Airport|TX", "amarillo|City of Amarillo|TX", "arlingtontx|City of Arlington|TX", "brownsvilletx|City of Brownsville|TX", "burlesontx|City of Burleson|TX", "cityoflewisville|City of Lewisville|TX", "dallascityhall|City of Dallas|TX", "fortworthtexas|City of Fort Worth|TX", "friscotexas|City of Frisco|TX", "leandertx|City of Leander|TX", "mckinneytexas|City of McKinney|TX", "midlandtexas|City of Midland|TX", "roundrocktexas|City of Round Rock|TX", "sanantonio|City of San Antonio|TX", "schertz|City of Schertz|TX", "southlake|City of Southlake|TX", "templetx|City of Temple|TX", "waco-texas|City of Waco|TX", "mansfield|Mansfield Council of Governments|TX", "brazoriacounty|Brazoria County|TX", "dentoncounty|Denton County|TX", "galvestoncountytx|Galveston County|TX", "harriscountytx|Harris County|TX", "johnsoncountytx|Johnson County|TX", "lubbock|Lubbock County|TX", "parkercountytx|Parker County|TX", "smithcounty|Smith County|TX", "wilco|Williamson County|TX", "hccs|Houston Community College|TX", "rice-edu|Rice University|TX", "tccd|Tarrant County College District|TX", "utdallas|UT Dallas|TX", "utexas|UT Austin|TX", "utrgv|UT Rio Grande Valley|TX", "uttyler|UT Tyler|TX", "uthscsa|UT Health San Antonio|TX", "saha|Opportunity Home San Antonio|TX", "universityhealth|University Health (hospital district)|TX", "allenisd|Allen ISD|TX", "austinisd|Austin ISD|TX", "comalisd|Comal ISD|TX", "dallasisd|Dallas ISD|TX", "fortbendisd|Fort Bend ISD|TX", "kleinisd|Klein ISD|TX", "laredoisd|Laredo ISD|TX", "magnoliaisd|Magnolia ISD|TX", "mesquiteisd|Mesquite ISD|TX", "tomballisd|Tomball ISD|TX", "twc-texas-gov|Texas Workforce Commission|TX", "txdot|Texas Department of Transportation|TX", "dart|Dallas Area Rapid Transit|TX", "ridemetro|Harris County METRO|TX",
  "ccog|The Cooperative Council of Governments|US", "omniapartners|OMNIA Partners|US", "utah|U3P / Utah Public Procurement Place|UT",
  "fairfaxcounty|Fairfax County|VA", "cnu|Christopher Newport University|VA", "gmu|George Mason University|VA", "nsu|Norfolk State University|VA", "fcps|Fairfax County Public Schools|VA",
  "cityofvancouver|City of Vancouver WA|WA", "federalwaywa|City of Federal Way|WA", "clarkcountywa|Clark County WA|WA", "kingcounty|King County|WA", "portolympia|Port of Olympia|WA", "lwsd|Lake Washington School District|WA", "tacoma|Tacoma Public Schools|WA",
  "cityofmilwaukee|City of Milwaukee|WI", "westalliswi|City of West Allis|WI", "racinecounty|Racine County|WI", "waukeshacounty|Waukesha County|WI", "cvtc|Chippewa Valley Technical College|WI", "mmsd|Milwaukee Metropolitan Sewerage District|WI",
  "marshall|Marshall University|WV",
];

export type BonfireOrg = { org: string; name: string; state: string };
export const BONFIRE_ORGS: readonly BonfireOrg[] = BONFIRE_SEED_RAW.map((r) => {
  const [org, name, state] = r.split("|");
  return { org: org ?? "", name: name ?? "", state: state ?? "" };
});

// ─── XML helpers (bespoke regex parser, mirrors fpds/gao) ─────────
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  if (!m) return null;
  return decodeEntities((m[1] ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim());
}

export type BonfireOpportunity = {
  referenceNumber: string | null;
  name: string | null;
  description: string | null;
  closeDate: string | null;
  link: string | null;
  pubDate: string | null;
};

/** Parse a Bonfire RSS item block → curated opportunity. Title is
 *  "Reference #: <ref>. Name: <name>"; description embeds "closes <date>". */
function mapItem(block: string): BonfireOpportunity {
  const title = tag(block, "title");
  const description = tag(block, "description");
  let referenceNumber: string | null = null;
  let name: string | null = str(title);
  if (title) {
    const m = /Reference #:\s*(.*?)\.\s*Name:\s*([\s\S]*)$/.exec(title);
    if (m) { referenceNumber = str(m[1]); name = str(m[2]); }
  }
  let closeDate: string | null = null;
  if (description) {
    const c = /\bcloses\s+([A-Za-z0-9:,\s]+?(?:AM|PM)[A-Za-z0-9 ]*)$/i.exec(description) || /\bcloses\s+(.+)$/i.exec(description);
    if (c && c[1]) closeDate = str(c[1].trim());
  }
  return { referenceNumber, name, description: str(description), closeDate, link: str(tag(block, "link")), pubDate: str(tag(block, "pubDate")) };
}

// ─── SSRF-guarded fetch ───────────────────────────────────────────
async function getBonfireRss(org: string): Promise<string> {
  const host = `${org}${BONFIRE_SUFFIX}`;
  const url = `https://${host}/opportunities/rss`;
  const built = new URL(url);
  if (built.hostname !== host || !built.hostname.endsWith(BONFIRE_SUFFIX) || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed Bonfire URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${JSON.stringify(host)} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
      upstreamEndpoint: bonfireLabel(org),
    });
  }
  return getText(url, { label: bonfireLabel(org), redirect: "error" });
}

// ─── Tool 1: bonfire_list_organizations (curated seed directory) ──
export type BonfireListArgs = { state?: string; query?: string; limit?: number; offset?: number };

export async function listOrganizations(args: BonfireListArgs): Promise<MetaBundle> {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const stateFilter = args.state ? args.state.trim().toUpperCase() : null;
  const queryFilter = args.query ? args.query.trim().toLowerCase() : null;
  const filtersApplied: string[] = [];
  if (stateFilter) filtersApplied.push("state");
  if (queryFilter) filtersApplied.push("query");

  const filtered = BONFIRE_ORGS.filter(
    (o) =>
      (!stateFilter || o.state.toUpperCase() === stateFilter) &&
      (!queryFilter || o.name.toLowerCase().includes(queryFilter)),
  );
  const totalAvailable = filtered.length;
  const page = filtered.slice(offset, offset + limit);
  const returned = page.length;
  const hasMore = offset + returned < totalAvailable;

  return withMeta(
    { organizations: page },
    {
      source: "Bonfire (Euna) curated seed directory (keyless)",
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset: hasMore ? offset + returned : null },
      notes: [BONFIRE_SEED_NOTE],
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool 2: bonfire_search_opportunities (per-org RSS) ───────────
export type BonfireSearchArgs = { org: string; limit?: number; offset?: number };

export async function searchOpportunities(args: BonfireSearchArgs): Promise<MetaBundle> {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const org = args.org ?? "";

  if (!BONFIRE_ORG_RE.test(org)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Invalid Bonfire org ${JSON.stringify(org)} — expected a lowercase-alnum/hyphen subdomain slug (from bonfire_list_organizations, e.g. 'harriscountytx', 'u-46').`,
      retryable: false,
      upstreamEndpoint: bonfireLabel(org),
    });
  }

  const body = await getBonfireRss(org); // getText THROWS on 429/5xx/404/timeout (P2)

  // P4: a 200 body must be RSS (no <rss/<channel ⇒ drift; e.g. an error/HTML page).
  if (!/<rss[\s>]/i.test(body) || !/<channel[\s>]/i.test(body)) {
    throw driftError(bonfireLabel(org), "Bonfire returned a non-RSS body at HTTP 200 — schema drift (expected an <rss><channel> feed).");
  }

  // Tolerate attributes on the opening <item …> tag (consistent with the <channel[\s>]
  // drift guard and the inner tag() matcher). RSS 2.0 <item> has no standard attributes,
  // but a namespaced/extended feed could add them — a bare-<item> regex would silently
  // DROP such items and undercount totalAvailable (a latent P1 risk caught in dogfooding).
  const items = body.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  const all = items.map(mapItem);
  // P1: the RSS is the COMPLETE open set ⇒ totalAvailable = item count (true total).
  const totalAvailable = all.length;
  const pageRows = all.slice(offset, offset + limit);
  const returned = pageRows.length;
  const hasMore = offset + returned < totalAvailable;

  return withMeta(
    { org, opportunities: pageRows },
    {
      source: BONFIRE_SOURCE(org),
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied: ["org"],
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset: hasMore ? offset + returned : null },
      notes: [
        "The RSS is the COMPLETE set of the org's currently-OPEN opportunities (no server pagination) — totalAvailable is the exact open-opportunity count, and this tool pages over it client-side. An empty feed (returned 0) means the org has no open opportunities right now. closeDate is parsed best-effort from the description text.",
      ],
    } satisfies Partial<ResponseMeta>,
  );
}
