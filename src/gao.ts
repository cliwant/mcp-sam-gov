/**
 * GAO bid-protest lookup (keyless) — recent Comptroller General bid-protest
 * decisions from the public GAO "Legal Products" RSS feed, optionally enriched
 * from each decision's public product page.
 *
 * HONEST SCOPE (the defining constraint of this tool)
 * ---------------------------------------------------
 * Keyless access covers ONLY the RECENT decisions carried by the public
 * Legal-Products RSS feed (a rolling ~25-item window). GAO's faceted historical
 * bid-protest search (by protester / agency / outcome / date across all years,
 * at https://www.gao.gov/legal/bid-protests/search) is WAF-protected against
 * automated clients and is available cleanly only via a PAID third-party API.
 * So this tool NEVER presents "recent" as "all": its `_meta` is ALWAYS
 * `complete:false` + `truncated:true`, `totalAvailable` is `null` (the feed is
 * not a count of all protests), and a top-level `accessNote` + a `_meta` note
 * spell out the boundary. This is an intentional PARTIAL close of a capability
 * that a competitor (Tango) sells as a paid feature.
 *
 * LIVE-VERIFIED 2026-07-03
 * ------------------------
 *   - `GET https://www.gao.gov/rss/reportslegal.xml` with a browser UA → HTTP
 *     200, application/rss+xml, ~14.6 KB, 26 <item>s. The feed carries GAO
 *     Legal Products — bid-protest DECISIONS *and* other legal products
 *     (Congressional Review Act regulatory reviews, legal opinions), so it MUST
 *     be filtered down to bid protests.
 *   - Each <item> has <title>, <link> (…/products/b-XXXXXX), <description>,
 *     <pubDate>, <guid>. A reconsideration reads "FCN Inc.--Reconsideration" →
 *     /products/b-424249.2; a costs decision "Accura Engineering--Costs".
 *   - Bid-protest items are reliably identified by their DESCRIPTION language
 *     ("protest(s)", "protester", "request(s) reconsideration of our decision")
 *     — regulatory reviews instead read "GAO reviewed the …'s new rule entitled".
 *     Protest B-numbers are the B-4xxxxx series; CRA reviews are B-33xxxx.
 *   - `GET https://www.gao.gov/products/b-XXXXXX` (browser UA) is cleanly
 *     parseable for protester (+ city/state), contracting agency, decision date,
 *     outcome ("We deny/sustain/dismiss the protest"), a solicitation number
 *     when present, and a decision-PDF link (/assets/.../NNNNNN.pdf).
 */

import { ToolErrorCarrier } from "./errors.js";
import { getText as getTextPort } from "./datasource.js";
import { withMeta } from "./meta.js";

// ─── Shared HTTP ─────────────────────────────────────────────────

// GAO's edge (Cloudflare/WAF) will 403 a bare client — always send a realistic
// browser User-Agent. Mirror the shape the rest of the server uses for GAO-ish
// public HTML/RSS scraping so behavior is consistent.
const GAO_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const RSS_URL = "https://www.gao.gov/rss/reportslegal.xml";
const PRODUCT_BASE = "https://www.gao.gov/products/";

const SOURCE = "gao.gov Legal Products RSS + decision pages (keyless)";

/**
 * The mandatory honesty disclaimer. Surfaced BOTH as a top-level `accessNote`
 * in `data` and inside `_meta.notes` so no consumer can miss the scope boundary.
 */
const ACCESS_NOTE =
  "Keyless GAO access covers only RECENT decisions from the public Legal-Products RSS feed (a rolling ~25-item window). GAO's faceted historical protest search (by protester/agency/outcome/date across all years) is WAF-blocked to automated clients and available only via a paid third-party API. Do NOT treat these results as the complete protest history.";

// Thin LOCAL wrapper (ADR-0013) that injects GAO's WAF-friendly UA + RSS Accept
// for the tool's two call sites, then delegates to the shared `getText` port
// (retry defaults true → fetchWithRetry, byte-identical to the former
// hand-rolled fetcher). `timeoutMs` is preserved as a param default (never
// overridden at either call site) and passed through explicitly.
async function getText(
  url: string,
  label: string,
  timeoutMs = 15_000,
): Promise<string> {
  return getTextPort(url, {
    label,
    headers: {
      "User-Agent": GAO_UA,
      Accept: "application/rss+xml, application/xml, text/html;q=0.9, */*;q=0.8",
    },
    timeoutMs,
  });
}

// ─── RSS parse (no dependency — string/regex) ─────────────────────

/** Decode the handful of XML/HTML entities that appear in GAO titles/desc. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    // &amp; last so we don't double-decode an already-decoded entity.
    .replace(/&amp;/g, "&")
    .trim();
}

/** Pull the inner text of the first <tag>…</tag> in a block (CDATA-aware). */
function tagText(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const m = re.exec(block);
  if (!m || m[1] === undefined) return null;
  let inner = m[1];
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner.trim());
  if (cdata && cdata[1] !== undefined) inner = cdata[1];
  return decodeEntities(inner);
}

/**
 * Extract the canonical B-number from a product URL or guid. The URL path is
 * lower-cased and may be percent-encoded with a comma joining companion numbers
 * (e.g. `/products/b-424347%2Cb-424347.2`). We take the FIRST b-number, upcase
 * it to the conventional `B-424347.2` form, and return the companions too.
 */
function bNumbersFromUrl(url: string): { primary: string | null; all: string[] } {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    /* keep raw on malformed escapes */
  }
  const matches = decoded.match(/b-[0-9][0-9a-z.\-]*/gi) ?? [];
  const norm = matches.map((b) => {
    // Upcase the leading "b-" and any trailing "-O.M." style suffix letters.
    return b.replace(/^b-/i, "B-").toUpperCase();
  });
  const unique = [...new Set(norm)];
  return { primary: unique[0] ?? null, all: unique };
}

type FeedItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;
  bNumber: string | null;
  companionBNumbers: string[];
};

/** Parse the RSS feed into raw items (every legal product, unfiltered). */
function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1] ?? "";
    const title = tagText(block, "title") ?? "";
    const link = tagText(block, "link") ?? "";
    const description = tagText(block, "description") ?? "";
    const pubDate = tagText(block, "pubDate");
    const guid = tagText(block, "guid");
    // Prefer the link for the B-number; fall back to the guid path.
    const fromLink = bNumbersFromUrl(link);
    const fromGuid = guid ? bNumbersFromUrl(guid) : { primary: null, all: [] };
    const primary = fromLink.primary ?? fromGuid.primary;
    const all = fromLink.all.length ? fromLink.all : fromGuid.all;
    items.push({
      title,
      link,
      description,
      pubDate,
      bNumber: primary,
      companionBNumbers: all,
    });
  }
  return items;
}

/**
 * Is this feed item a BID-PROTEST decision (vs a CRA regulatory review or a
 * legal opinion)? The most reliable keyless signal is the DESCRIPTION language:
 * a protest reads "…protests…" / "protester" / "request(s) reconsideration of
 * our decision", while a CRA review reads "GAO reviewed the …'s new rule
 * entitled". We also accept the "--Reconsideration" / "--Costs" title suffixes
 * GAO uses on protest follow-ons, and (as a weak positive) the B-4 number
 * series. Regulatory-review language is an explicit NEGATIVE so those never leak.
 */
function isBidProtest(item: FeedItem): boolean {
  if (!item.bNumber) return false;
  const d = item.description.toLowerCase();
  const t = item.title.toLowerCase();

  // Explicit negatives — CRA / rule reviews and pure legal opinions.
  if (/gao reviewed the .*new rule entitled/.test(d)) return false;
  if (/\bcongressional review act\b/.test(d) && !/\bprotest/.test(d)) return false;

  // Strong positives from the decision language.
  if (/\bprotest(s|er|ers|ed|ing)?\b/.test(d)) return true;
  if (/reconsideration of our decision/.test(d)) return true;
  if (/request(s)? (for )?reconsideration/.test(d)) return true;
  // GAO protest follow-on title conventions.
  if (/--reconsideration\b/.test(t)) return true;
  if (/--costs\b/.test(t)) return true;
  // Fallback: the B-4xxxxx series is the bid-protest docket range. Only trust it
  // when the description is not clearly a rule review (handled above).
  if (/^B-4\d/.test(item.bNumber)) return true;

  return false;
}

// ─── Per-decision page parse ──────────────────────────────────────

type DecisionFields = {
  protester: string | null;
  agency: string | null;
  decisionDate: string | null;
  solicitationNumber: string | null;
  outcome: Outcome | null;
  pdfUrl: string | null;
  summary: string | null;
};

type Outcome = "sustained" | "denied" | "dismissed" | "withdrawn";

/** Strip HTML tags + collapse whitespace from a fragment. */
function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Normalize a "Jun 22, 2026" / "June 22, 2026" date to ISO (YYYY-MM-DD),
 * parsing in UTC so we never shift a day (a local-timezone `new Date(...)` on a
 * bare date string is midnight LOCAL, which `toISOString()` then rolls back a
 * day in negative-offset zones — LIVE-VERIFIED that bug produced 06-21 for
 * "Jun 22, 2026"). Returns the input unchanged if it can't be parsed.
 */
function normalizeDate(human: string): string {
  const m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4})$/.exec(human.trim());
  if (m && m[1] && m[2] && m[3]) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon !== undefined) {
      const d = new Date(Date.UTC(Number(m[3]), mon, Number(m[2])));
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  return human;
}

/**
 * Extract the contracting agency from a GAO highlights blurb. GAO phrases it
 * two ways (LIVE-VERIFIED 2026-07-03):
 *   - "…issued by the <Agency>[, <sub-component>], for …"
 *   - "…protests the <Agency>'s issuance of …"
 * We capture the full agency phrase (through a trailing sub-component up to the
 * next clause boundary), then trim. Returns null when no agency is stated.
 */
function extractAgency(text: string): string | null {
  // Bound to the FIRST ~2 sentences of the highlights — the contracting agency
  // is named in the opening clause ("…issued by the <Agency>…"); a later "the
  // Department of Defense during both peace and war" narrative sentence would
  // otherwise be mis-captured (LIVE-VERIFIED that failure on USTRANSCOM).
  const blurb = text.split(/(?<=\.)\s+/).slice(0, 2).join(" ");
  // Anchor tokens that reliably head a federal agency name. "Department of the
  // Air Force" / "Department of Defense" both allow an optional leading "the".
  const AG =
    "(?:Department of (?:the )?[A-Z][A-Za-z.'’\\- ]+?|National [A-Z][A-Za-z.'’\\- ]+?|United States [A-Z][A-Za-z.'’\\- ]+? Command|U\\.S\\. [A-Z][A-Za-z.'’\\- ]+?|General Services Administration|Environmental Protection Agency|Small Business Administration|[A-Z][A-Za-z.'’\\- ]+? (?:Agency|Administration|Command|Corps|Bureau|Guard|Service))";
  // Clause boundary the agency name ends at: a comma, a period, a bare " for"/
  // " under"/" to"/" in support", or end-of-string. An optional parenthetical
  // acronym ("(USTRANSCOM)") is consumed but not captured.
  const STOP = "(?=,|\\.|\\s+for\\b|\\s+under\\b|\\s+to\\b|\\s+in support\\b|$)";
  // "issued/awarded/conducted/solicited by [the] <Agency>[, U.S. <sub>]".
  const by = new RegExp(
    `(?:issued|awarded|conducted|solicited|procured)\\s+by\\s+(?:the\\s+)?(${AG}(?:,\\s+U\\.S\\.[A-Za-z.'’&\\- ]+?)?)(?:\\s*\\([A-Z]{2,10}\\))?${STOP}`,
  ).exec(blurb);
  if (by && by[1]) return cleanAgency(by[1]);
  // "protests the <Agency>['s] issuance/award/decision".
  const poss = new RegExp(
    `protests?\\s+the\\s+(${AG})(?:'s|’s)?\\s+(?:issuance|award|decision|evaluation|cancellation|termination|rejection)`,
  ).exec(blurb);
  if (poss && poss[1]) return cleanAgency(poss[1]);
  // Bare "Department of [the] X[, U.S. sub-component]" fallback in the opening.
  const dept = new RegExp(
    `\\b(Department of (?:the )?[A-Z][A-Za-z.'’\\- ]+?(?:,\\s+U\\.S\\. [A-Z][A-Za-z.'’\\- ]+?)?)${STOP}`,
  ).exec(blurb);
  if (dept && dept[1]) return cleanAgency(dept[1]);
  return null;
}

function cleanAgency(s: string): string {
  return s.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "").trim();
}

/**
 * Classify the protest outcome from the decision text. GAO decisions state the
 * disposition in the Highlights ("We deny the protest", "We sustain…",
 * "We dismiss…") and echo it in the body. Order matters: "sustained in part"
 * still counts as sustained. Returns null if no clear disposition is found.
 */
function classifyOutcome(text: string): Outcome | null {
  const t = text.toLowerCase();
  // Sustain wins over deny when both appear ("sustain in part and deny in part"
  // is a win worth surfacing as sustained).
  if (/\bwe sustain\b/.test(t) || /protest is sustained/.test(t) || /\bsustained in part\b/.test(t))
    return "sustained";
  if (/\bwe deny\b/.test(t) || /protest is denied/.test(t) || /\bdenied in part\b/.test(t))
    return "denied";
  if (/\bwe dismiss\b/.test(t) || /protest is dismissed/.test(t) || /\bdismissed in part\b/.test(t))
    return "dismissed";
  if (/\bwithdrew\b/.test(t) || /protest is withdrawn/.test(t) || /\bwe withdraw\b/.test(t))
    return "withdrawn";
  return null;
}

/**
 * Best-effort parse of a GAO decision product page. Every field is nullable —
 * GAO's HTML is not a contract, so a missing field is surfaced as null (never
 * fabricated) and disclosed by the caller. `rawHtml` is the fetched page text.
 */
function parseDecisionPage(rawHtml: string, feed?: FeedItem): DecisionFields {
  // The GAO product page embeds a JSON-LD / og:description with the Highlights
  // text, and a visible Highlights section. We work over the whole HTML with
  // targeted regexes rather than a DOM parser (no dependency).

  const bodyOnly = rawHtml.slice(Math.max(0, rawHtml.indexOf("</head>")));
  const flat = stripHtml(rawHtml);

  // Highlights: GAO renders the FULL (un-truncated) highlights on the page —
  // the <meta> og:description carries only a TRUNCATED "…" blurb (agency cut
  // off). In the flattened body the real highlights sit right after a DOUBLED
  // "Highlights Highlights" marker (a heading + the body heading), and the body
  // begins with the protester name (LIVE-VERIFIED 2026-07-03). The single word
  // "Highlights" also appears in nav furniture, so we anchor on the doubled
  // marker and stop at the "What GAO Found"/"Recommendations"/"View Decision"
  // section that follows. Fall back to og:description, then the feed.
  let highlights: string | null = null;
  const flatHl =
    /Highlights\s+Highlights\s+([A-Z][\s\S]*?)(?=\s*(?:View Decision|Full Report|Highlights Page|What GAO Recommends|Recommendations for Executive Action|GAO Contacts|Additional Materials)\b|$)/.exec(
      flat,
    );
  if (flatHl && flatHl[1] && flatHl[1].trim().length > 40) {
    highlights = flatHl[1].replace(/\s+/g, " ").trim();
  }
  // A cleaner (truncated) blurb from the <meta> tags — used to VALIDATE the flat
  // highlights and as a fallback. It always starts with the protester.
  let metaBlurb: string | null = null;
  const og = /<meta\s+property="og:description"\s+content="([\s\S]*?)"/i.exec(rawHtml);
  if (og && og[1]) metaBlurb = decodeEntities(og[1]).trim();
  if (!metaBlurb) {
    const md = /<meta\s+name="description"\s+content="([\s\S]*?)"/i.exec(rawHtml);
    if (md && md[1]) metaBlurb = decodeEntities(md[1]).trim();
  }
  // If the flat highlights don't start with the same protester lead as the meta
  // blurb, the anchor grabbed the wrong section — discard it and use the blurb.
  if (highlights && metaBlurb) {
    const lead = metaBlurb.replace(/\.\.\.$|…$/, "").slice(0, 18).toLowerCase();
    if (lead.length > 6 && !highlights.slice(0, 40).toLowerCase().includes(lead.slice(0, 10))) {
      highlights = null;
    }
  }
  if (!highlights) highlights = metaBlurb;
  if (!highlights && feed) highlights = feed.description || null;

  // Outcome: GAO states the disposition in a
  // `<div class="status highlighted-status">We dismiss the protest.</div>`
  // block (LIVE-VERIFIED). Prefer that; else classify over the highlights/flat
  // text. The truncated og:description alone never carries the disposition.
  let outcome: Outcome | null = null;
  const statusBlock = /<div class="status[^"]*">\s*([\s\S]*?)\s*<\/div>/i.exec(rawHtml);
  if (statusBlock && statusBlock[1]) {
    outcome = classifyOutcome(stripHtml(statusBlock[1]));
  }
  if (!outcome) {
    outcome = classifyOutcome(`${highlights ?? ""} ${feed?.description ?? ""} ${flat}`);
  }

  // Decision date: no <time datetime> / JSON-LD on these pages — the visible
  // decision date renders as "Jun 22, 2026" in the body (LIVE-VERIFIED). Take
  // the first such date after </head>, normalized to ISO. Fall back to the feed
  // pubDate (handled by the caller when this is null).
  let decisionDate: string | null = null;
  const dm =
    /\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},\s+20\d{2})\b/.exec(
      bodyOnly.replace(/<[^>]+>/g, " "),
    );
  if (dm && dm[1]) decisionDate = normalizeDate(dm[1]);

  // Protester + agency parsed from the (un-truncated) highlights.
  let protester: string | null = null;
  let agency: string | null = null;
  const blurb = highlights ?? feed?.description ?? "";
  if (blurb) {
    // Protester = leading clause up to the first comma OR "protests"/"requests".
    const protMatch = /^(.*?)(?:,|\s+protests\b|\s+requests?\b)/i.exec(blurb);
    if (protMatch && protMatch[1] && protMatch[1].trim().length > 1) {
      protester = protMatch[1].trim();
    }
    agency = extractAgency(blurb);
  }
  // Fallback: parse the agency from the FULL flattened page text (the on-page
  // highlights are un-truncated there even when the <meta> blurb was cut off,
  // and the highlights container markup varies). LIVE-VERIFIED to recover
  // "Department of Homeland Security, U.S. Customs and Border Protection" etc.
  if (!agency) agency = extractAgency(flat);
  // A page-level agency facet as a last resort (GAO tags a "Federal agency").
  if (!agency) {
    const facet = /Federal agency<\/[^>]+>\s*<[^>]*>\s*([^<]{3,80}?)\s*</i.exec(rawHtml);
    if (facet && facet[1]) agency = stripHtml(facet[1]);
  }

  // Solicitation / RFP / RFQ / TOPR number — GAO decisions cite it as
  // "(request for proposals|solicitation|TOPR|task order proposal request)
  // [(RFP)] No. XXXXXXX". Parse over the un-truncated highlights first, then the
  // flat body. Best-effort — null when not stated in the highlights.
  let solicitationNumber: string | null = null;
  const solText = `${blurb} ${flat}`;
  const sol =
    /\b(?:solicitation|request for (?:proposals?|quotations?)|task order proposal request|RF[PQ]|TOPR)\s*(?:\((?:RF[PQ]|TOPR)\)\s*)?No\.?\s*([A-Za-z0-9][A-Za-z0-9-]{4,})/i.exec(
      solText,
    );
  if (sol && sol[1]) solicitationNumber = sol[1].replace(/[.,;]$/, "").trim();

  // Decision PDF: GAO links the full report as /assets/<dir>/NNNNNN.pdf.
  let pdfUrl: string | null = null;
  const pdf = /href="(\/assets\/[^"]*?\.pdf)"/i.exec(rawHtml) ?? /href="(https:\/\/www\.gao\.gov\/assets\/[^"]*?\.pdf)"/i.exec(rawHtml);
  if (pdf && pdf[1]) {
    pdfUrl = pdf[1].startsWith("http") ? pdf[1] : `https://www.gao.gov${pdf[1]}`;
  }

  const summary = highlights ? highlights.slice(0, 600) : null;

  return { protester, agency, decisionDate, solicitationNumber, outcome, pdfUrl, summary };
}

/**
 * Fetch + parse a single decision by B-number. A 404 → structured not_found; a
 * 429/5xx/network fault stays a retryable upstream error (never a silent empty
 * that reads as "no such protest"). The B-number is normalized to the
 * `/products/b-xxxxxx` path shape GAO serves.
 */
async function fetchDecision(bNumber: string, feed?: FeedItem): Promise<Decision> {
  const norm = bNumber.trim();
  const primaryPath = norm.toLowerCase().replace(/^b-?/, "b-");

  // Candidate URLs, in priority order. GAO reconsiderations are served at a
  // COMMA-JOINED path (e.g. /products/b-424347,b-424347.2) — the primary
  // B-number alone 404s (LIVE-VERIFIED 2026-07-03). So:
  //   1. the feed's exact <link> (already carries the comma-joined path), then
  //   2. the primary B-number path, then
  //   3. a companion-joined path built from the feed's B-numbers.
  const candidates: string[] = [];
  if (feed?.link) candidates.push(feed.link);
  candidates.push(`${PRODUCT_BASE}${encodeURIComponent(primaryPath)}`);
  if (feed && feed.companionBNumbers.length > 1) {
    const joined = feed.companionBNumbers.map((b) => b.toLowerCase()).join(",");
    candidates.push(`${PRODUCT_BASE}${joined}`);
  }
  // De-dup while preserving order.
  const urls = [...new Set(candidates)];

  let html: string | null = null;
  let usedUrl = urls[0] as string;
  let lastNotFound: ToolErrorCarrier | null = null;
  for (const u of urls) {
    try {
      html = await getText(u, `gao:product:${primaryPath}`);
      usedUrl = u;
      break;
    } catch (e) {
      if (e instanceof ToolErrorCarrier) {
        if (e.toolError.kind === "not_found") {
          // Try the next candidate — a 404 on the primary path is expected for
          // reconsiderations served at the comma-joined path.
          lastNotFound = e;
          continue;
        }
        // A 429/5xx/network fault is retryable — surface it, never swallow.
        throw e;
      }
      throw new ToolErrorCarrier({
        kind: "upstream_unavailable",
        message: `GAO decision fetch failed for '${bNumber}': ${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
        upstreamEndpoint: `products/${primaryPath}`,
      });
    }
  }
  if (html === null) {
    // Every candidate 404'd → a genuine "no such decision".
    throw new ToolErrorCarrier({
      kind: "not_found",
      message: `No GAO decision found for B-number '${bNumber}' (tried ${urls.length} path form(s)). Verify the B-number (e.g. via gao_protest_lookup without bNumber to list recent protests).`,
      retryable: false,
      upstreamEndpoint: lastNotFound?.toolError.upstreamEndpoint ?? `products/${primaryPath}`,
    });
  }

  const fields = parseDecisionPage(html, feed);
  return {
    bNumber: norm.toUpperCase(),
    protester: fields.protester ?? feedProtester(feed),
    agency: fields.agency,
    decisionDate: fields.decisionDate ?? feedDate(feed),
    solicitationNumber: fields.solicitationNumber,
    outcome: fields.outcome,
    title: feed?.title ?? fields.protester ?? norm.toUpperCase(),
    decisionUrl: usedUrl,
    pdfUrl: fields.pdfUrl,
    summary: fields.summary ?? feed?.description ?? null,
  };
}

type Decision = {
  bNumber: string;
  protester: string | null;
  agency: string | null;
  decisionDate: string | null;
  solicitationNumber: string | null;
  outcome: Outcome | null;
  title: string;
  decisionUrl: string;
  pdfUrl: string | null;
  summary: string | null;
};

/** A protester name derived from the feed title (company name) when present. */
function feedProtester(feed?: FeedItem): string | null {
  if (!feed) return null;
  // Feed titles ARE the protester (minus the "--Reconsideration"/"--Costs" tag).
  const t = feed.title.replace(/--(?:reconsideration|costs).*$/i, "").trim();
  return t || null;
}

/** ISO/human decision date from the feed pubDate (RFC-822) when present. */
function feedDate(feed?: FeedItem): string | null {
  if (!feed?.pubDate) return null;
  const d = new Date(feed.pubDate);
  if (Number.isNaN(d.getTime())) return feed.pubDate;
  return d.toISOString().slice(0, 10);
}

/** Bounded-concurrency map (be polite to GAO's edge — no unbounded fan-out). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Public tool ─────────────────────────────────────────────────

export async function gaoProtestLookup(args: {
  agency?: string;
  protester?: string;
  solicitationNumber?: string;
  outcome?: "sustained" | "denied" | "dismissed" | "withdrawn" | "any";
  bNumber?: string;
  limit?: number;
  enrich?: boolean;
}) {
  const outcomeFilter = args.outcome && args.outcome !== "any" ? args.outcome : null;
  const limit = Math.min(50, Math.max(1, Math.floor(args.limit ?? 20)));
  const enrich = args.enrich ?? true;

  // ── Direct-by-B-number path (bypass the feed) ──────────────────────
  if (args.bNumber) {
    const decision = await fetchDecision(args.bNumber);
    const notes = [ACCESS_NOTE];
    const fieldsUnavailable = missingFields([decision]);
    return withMeta(
      { accessNote: ACCESS_NOTE, decisions: [decision] },
      {
        source: SOURCE,
        keylessMode: true,
        // Even a direct lookup is a partial view of protest history.
        complete: false,
        truncated: true,
        returned: 1,
        totalAvailable: null,
        filtersApplied: ["bNumber(direct)"],
        filtersDropped: [],
        fieldsUnavailable,
        notes,
      },
    );
  }

  // ── Feed path ──────────────────────────────────────────────────────
  const xml = await getText(RSS_URL, "gao:rss");
  const rawItems = parseFeed(xml);
  const protests = rawItems.filter(isBidProtest);

  // Client-side filters over the feed items (case-insensitive substring).
  const filtersApplied: string[] = [];
  let filtered = protests;
  const agencyQ = args.agency?.trim().toLowerCase();
  const protesterQ = args.protester?.trim().toLowerCase();
  const solQ = args.solicitationNumber?.trim().toLowerCase();
  if (agencyQ) {
    filtersApplied.push("agency(client-side)");
    filtered = filtered.filter(
      (i) =>
        i.description.toLowerCase().includes(agencyQ) ||
        i.title.toLowerCase().includes(agencyQ),
    );
  }
  if (protesterQ) {
    filtersApplied.push("protester(client-side)");
    filtered = filtered.filter(
      (i) =>
        i.title.toLowerCase().includes(protesterQ) ||
        i.description.toLowerCase().includes(protesterQ),
    );
  }
  if (solQ) {
    filtersApplied.push("solicitationNumber(client-side)");
    filtered = filtered.filter((i) => i.description.toLowerCase().includes(solQ));
  }

  // Bound the number of items we enrich (be polite + fast). Outcome filtering
  // requires the decision page, so when an outcome filter is set we enrich the
  // candidate set then filter; otherwise we honor `limit` up front.
  const candidates = outcomeFilter ? filtered : filtered.slice(0, limit);

  let decisions: Decision[];
  let enrichFailures = 0;
  let enrichedCount = 0;
  if (enrich) {
    const enriched = await mapWithConcurrency(candidates, 4, async (item) => {
      try {
        const dec = await fetchDecision(item.bNumber as string, item);
        return { dec, ok: true as const };
      } catch {
        // Tolerate a failed enrich: fall back to feed-level fields, disclose it.
        return {
          dec: feedOnlyDecision(item),
          ok: false as const,
        };
      }
    });
    enrichedCount = enriched.filter((e) => e.ok).length;
    enrichFailures = enriched.filter((e) => !e.ok).length;
    decisions = enriched.map((e) => e.dec);
  } else {
    decisions = candidates.map(feedOnlyDecision);
  }

  // Apply the outcome filter now that we (may) have parsed outcomes, then cap.
  const filtersDropped: string[] = [];
  if (outcomeFilter) {
    if (enrich) {
      filtersApplied.push("outcome(from decision page)");
      decisions = decisions.filter((d) => d.outcome === outcomeFilter);
    } else {
      // Can't determine outcome without enrichment → don't silently pretend to.
      filtersDropped.push("outcome(requires enrichment; enrich=false)");
    }
    decisions = decisions.slice(0, limit);
  }

  const fieldsUnavailable = missingFields(decisions);

  const notes: string[] = [ACCESS_NOTE];
  if (enrich && enrichFailures > 0) {
    notes.push(
      `${enrichFailures} decision(s) returned feed-level fields only; per-decision page enrichment failed (agency/outcome/solicitation may be null for those).`,
    );
  }
  if (!enrich) {
    notes.push(
      "enrich=false: only RSS feed-level fields were returned (protester/title/date/summary). Agency, outcome, solicitation number, and the decision PDF require the per-decision page — call again with enrich=true or a specific bNumber.",
    );
  }
  if (outcomeFilter && !enrich) {
    notes.push(
      "The outcome filter was NOT applied because it requires reading each decision page (enrich=false). Results are unfiltered on outcome.",
    );
  }

  return withMeta(
    { accessNote: ACCESS_NOTE, decisions },
    {
      source: SOURCE,
      keylessMode: true,
      // ALWAYS incomplete — the feed is a recent window, never the full history.
      complete: false,
      truncated: true,
      returned: decisions.length,
      totalAvailable: null,
      filtersApplied,
      filtersDropped,
      fieldsUnavailable,
      enrichedCount: enrich ? enrichedCount : undefined,
      notes,
    },
  );
}

/** Build a feed-only decision (no page fetch) from a feed item. */
function feedOnlyDecision(item: FeedItem): Decision {
  return {
    bNumber: (item.bNumber ?? "").toUpperCase(),
    protester: feedProtester(item),
    agency: null,
    decisionDate: feedDate(item),
    solicitationNumber: null,
    outcome: null,
    title: item.title,
    decisionUrl: item.link || `${PRODUCT_BASE}${(item.bNumber ?? "").toLowerCase()}`,
    pdfUrl: null,
    summary: item.description || null,
  };
}

/**
 * Which decision fields came back null across the returned set — surfaced in
 * `_meta.fieldsUnavailable` so the AI knows these are "not parseable / not in
 * this source", not "no data exists". A field is listed only if it is null on
 * at least one returned decision.
 */
function missingFields(decisions: Decision[]): string[] {
  if (decisions.length === 0) return [];
  const keys: (keyof Decision)[] = [
    "agency",
    "outcome",
    "solicitationNumber",
    "pdfUrl",
    "decisionDate",
    "protester",
  ];
  const out: string[] = [];
  for (const k of keys) {
    if (decisions.some((d) => d[k] === null)) out.push(k);
  }
  // Historical-search limitation is structural, not per-field — always noted.
  out.push("historicalFacetedSearch(WAF-blocked; paid API only)");
  return out;
}
