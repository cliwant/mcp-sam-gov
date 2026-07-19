/**
 * Integrity & teaming tier (keyless) — debarment screening + small-business
 * discovery for teaming, both grounded on LIVE-VERIFIED public endpoints
 * (2026-07-03).
 *
 * Two keyless tools:
 *   - sam_check_exclusions        → SAM debarment/exclusion screening
 *   - usas_search_teaming_partners → award-derived small-business discovery,
 *                                    integrity-screened
 *
 * The defining truthfulness constraints of this tier:
 *
 *   1. SAM exclusions — an EMPTY result is a TRUE NEGATIVE with a narrow
 *      meaning ("no matching exclusion under these terms"), NOT a clean bill of
 *      health. We say so, loudly, in every `_meta.notes` so an AI never reads
 *      "0 records" as "responsible".  The exclusions index is `ex` (NOT
 *      `ei`/`exclusion`), served keyless from sam.gov's frontend SGS with an
 *      `application/hal+json` Accept + a browser-y User-Agent.  Deep paging is
 *      capped at 10,000 records server-side.
 *
 *   2. USAspending socioeconomic proxy — a BOGUS `recipient_type_names` value
 *      returns `0` results with HTTP 200 (VERIFIED — a silent accept). So the
 *      `cert` parameter MUST be a Zod enum of values confirmed live (see the
 *      server's TeamingPartnersInput); the runtime here ALSO re-validates the
 *      cert against `VERIFIED_CERTS` and throws a structured `invalid_input`
 *      rather than ever issuing a confident-empty list. And the cert is
 *      AWARD-DERIVED (recorded on the firm's federal awards), NOT the SBA
 *      certification of record (which needs a keyed SAM Entity call) — every
 *      response says so.
 */

import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
import { withMeta } from "./meta.js";

// ─── Shared HTTP ─────────────────────────────────────────────────

// SAM's public frontend SGS endpoint gates on a browser-y User-Agent AND
// requires `Accept: application/hal+json`. Mirror the pricing tier's UA so
// behavior is consistent across the server.
const SAM_UA =
  "Mozilla/5.0 (compatible; @cliwant/mcp-sam-gov; +https://github.com/cliwant/mcp-sam-gov)";
const SAM_HAL_HEADERS = {
  Accept: "application/hal+json",
  "User-Agent": SAM_UA,
} as const;

const SGS_BASE = "https://sam.gov/api/prod/sgs/v1/search";
const USAS = "https://api.usaspending.gov/api/v2";

// Server-side deep-paging cap on the SGS search index (LIVE-VERIFIED:
// page.maxAllowedRecords = 10000).
const SGS_MAX_RECORDS = 10_000;

async function getSgsJson<T>(url: string, label: string): Promise<T> {
  const r = await fetchWithRetry(
    url,
    { headers: SAM_HAL_HEADERS, signal: AbortSignal.timeout(15_000) },
    label,
  );
  return (await r.json()) as T;
}

async function postUsas<T>(
  endpoint: string,
  body: Record<string, unknown>,
): Promise<T> {
  const r = await fetchWithRetry(
    `${USAS}/${endpoint}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
    `usaspending:${endpoint}`,
  );
  return (await r.json()) as T;
}

// ─── 1. sam_check_exclusions ─────────────────────────────────────

const EXCLUSIONS_SOURCE = "sam.gov/api/prod (frontend HAL, keyless)";

/**
 * The mandatory disclosure attached to EVERY exclusions response. An empty
 * result is a narrow true-negative — never a general clearance. Kept as a
 * constant so the smoke/edge tests can assert on it verbatim.
 */
const NOT_PROOF_NOTE =
  "An empty result means no matching exclusion was found (not currently excluded under these terms) — it is NOT proof of general responsibility.";

type ExclusionClassification =
  | "Firm"
  | "Individual"
  | "Special Entity Designation"
  | "any";

/** A single result row from the SGS `index=ex` exclusions index. */
type SgsExclusionResult = {
  title?: string;
  classification?: { code?: string; value?: string | null };
  ueiSam?: string | null;
  cageCode?: string | null;
  samNumber?: string | null;
  exclusionType?: string | null;
  type?: { code?: string; value?: string | null };
  exclusionProgram?: string | null;
  excludingAgency?: string | null;
  excludingAgencyDesc?: string | null;
  ctCode?: string | null;
  ctCodeDesc?: string | null;
  isActive?: boolean | null;
  activationDate?: string | null;
  terminationDate?: string | null;
  address?: Record<string, unknown> | null;
  _id?: string | null;
};

type SgsExclusionResp = {
  _embedded?: { results?: SgsExclusionResult[] };
  page?: {
    size?: number;
    totalElements?: number;
    totalPages?: number;
    number?: number;
    maxAllowedRecords?: number;
  };
};

/** Normalize a UEI/CAGE for a case-insensitive post-filter compare. */
function norm(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

/**
 * Normalize a legal entity NAME for a precise match: uppercase, strip
 * punctuation, drop trailing entity suffixes (LLC/INC/CORP/…), and collapse
 * whitespace. Used to decide whether an exclusion record genuinely names a
 * given firm — SAM's free-text `q` tokenizes, so a raw "≥1 result" is NOT a
 * match ("VISIONARY CONSULTING PARTNERS, LLC" would otherwise hit every
 * unrelated "…CONSULTING…" exclusion, a dangerous false positive).
 */
function normName(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"]/g, " ")
    .replace(/\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC|PC)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keyless SAM debarment / exclusion screening.
 *
 * Requires at least one of `query`/`uei`/`cage` (else structured
 * invalid_input). `query` drives the server-side `q=`; `uei`/`cage` are
 * POST-filtered on the returned rows (the frontend SGS has no dedicated
 * uei/cage query param). `activeOnly` and `classification` are also applied as
 * post-filters. The response distinguishes:
 *   - `excluded`: ≥1 ACTIVE record matched the (post-filtered) query,
 *   - `matchCount`: how many rows matched after post-filtering.
 * An empty/false result is disclosed as a NARROW true-negative, never a
 * general clearance (see NOT_PROOF_NOTE).
 */
export async function checkExclusions(args: {
  query?: string;
  uei?: string;
  cage?: string;
  activeOnly?: boolean;
  classification?: ExclusionClassification;
  page?: number;
  size?: number;
}) {
  const query = args.query?.trim() || undefined;
  const uei = args.uei?.trim() || undefined;
  const cage = args.cage?.trim() || undefined;
  const activeOnly = args.activeOnly ?? true;
  const classification = args.classification ?? "any";
  const page = Math.max(0, Math.floor(args.page ?? 0));
  const size = Math.min(100, Math.max(1, Math.floor(args.size ?? 25)));

  // At least one selector is required — an unbounded exclusions dump is never
  // a meaningful screen.
  if (!query && !uei && !cage) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message:
        "sam_check_exclusions requires at least one of query, uei, or cage. Pass the firm/individual name (query) and/or a UEI/CAGE to screen.",
      retryable: false,
      upstreamEndpoint: "sgs/v1/search?index=ex",
    });
  }

  // Build the SGS query. `q` is the only server-side text selector on this
  // index; uei/cage are post-filtered. When only a uei/cage is given (no
  // name), use it as the `q` so the server still narrows.
  const qValue = query ?? uei ?? cage ?? "";
  const params = new URLSearchParams({
    index: "ex",
    q: qValue,
    page: String(page),
    size: String(size),
    mode: "search",
  });

  const url = `${SGS_BASE}?${params.toString()}`;
  const json = await getSgsJson<SgsExclusionResp>(url, "sam:sgs:ex");
  const rawResults = json._embedded?.results ?? [];
  const totalElements = json.page?.totalElements ?? null;

  const filtersApplied: string[] = [];
  const filtersDropped: string[] = [];
  if (query) filtersApplied.push("query(q, server-side)");
  else if (uei) filtersApplied.push("uei(as q, server-side)");
  else if (cage) filtersApplied.push("cage(as q, server-side)");

  // Post-filter on uei/cage/classification/activeOnly over the fetched page.
  const ueiU = norm(uei);
  const cageU = norm(cage);
  let filtered = rawResults;
  // NAME-MATCH GATE (truthfulness-critical): SAM's free-text `q` tokenizes, so a
  // raw hit list is NOT a set of name matches — "VISIONARY CONSULTING PARTNERS"
  // otherwise hits every unrelated "…PARTNERS…"/"…CONSULTING…" exclusion. When a
  // name `query` is given, keep only records whose NORMALIZED name equals it
  // (mirroring the teaming screen), so `excluded`/`records`/`matchCount` never
  // flag someone else's exclusion. uei/cage-only selectors are gated below.
  let looseTextHits = 0;
  if (query) {
    const target = normName(query);
    if (target.length > 0) {
      const before = filtered.length;
      filtered = filtered.filter((r) => normName(r.title) === target);
      looseTextHits = before - filtered.length;
      filtersApplied.push("name(normalized exact match)");
    }
  }
  if (uei) {
    // Always narrow to the exact UEI when supplied (with or without a name
    // query) — a UEI used as free-text `q` is otherwise a loose text hit.
    filtered = filtered.filter((r) => norm(r.ueiSam) === ueiU);
    filtersApplied.push("uei(exact post-filter)");
  }
  if (cage) {
    filtered = filtered.filter((r) => norm(r.cageCode) === cageU);
    filtersApplied.push("cage(exact post-filter)");
  }
  if (classification !== "any") {
    filtered = filtered.filter(
      (r) => (r.classification?.code ?? "") === classification,
    );
    filtersApplied.push(`classification(${classification})`);
  }
  if (activeOnly) {
    filtered = filtered.filter((r) => r.isActive === true);
    filtersApplied.push("activeOnly");
  }

  const records = filtered.map((r) => {
    const ueiSam = r.ueiSam ?? null;
    return {
      name: r.title ?? "",
      classification: r.classification?.code ?? null,
      uei: ueiSam,
      cage: r.cageCode ?? null,
      samNumber: r.samNumber ?? null,
      excludingAgency: r.excludingAgency ?? null,
      excludingAgencyDesc: r.excludingAgencyDesc ?? null,
      exclusionType: r.exclusionType ?? r.type?.value ?? null,
      exclusionProgram: r.exclusionProgram ?? null,
      ctCode: r.ctCode ?? null,
      ctCodeDesc: r.ctCodeDesc ?? null,
      isActive: r.isActive ?? null,
      activationDate: r.activationDate ?? null,
      terminationDate: r.terminationDate ?? null,
      address: r.address ?? null,
      // FAPIIS (the official exclusions/responsibility record) lookup URL.
      samFapiisUrl: ueiSam
        ? `https://sam.gov/search/?index=ex&q=${encodeURIComponent(ueiSam)}`
        : `https://sam.gov/search/?index=ex&q=${encodeURIComponent(r.title ?? qValue)}`,
    };
  });

  const excluded = records.some((r) => r.isActive === true);
  const matchCount = records.length;

  // truncated when the server total exceeds what a single page returned, OR
  // when we hit the 10k deep-paging ceiling, OR when a post-filter means the
  // fetched page may not contain every match.
  const postFiltered =
    Boolean(query) ||
    Boolean(uei) ||
    Boolean(cage) ||
    classification !== "any";
  const serverTruncated =
    totalElements !== null && rawResults.length < totalElements;
  const hitCap = totalElements !== null && totalElements > SGS_MAX_RECORDS;
  // totalAvailable HONESTY: the raw free-text `totalElements` counts every record
  // that merely shares a WORD with the query — NOT the name-gated matches this
  // tool reports. Surfacing it read as "0 of 252 matches, incomplete" for a firm
  // with ZERO real matches (a vetting tool must not overstate match availability).
  // When the result is name-gated (the normal case — a selector is always
  // required), the true count of name-MATCHING exclusions is genuinely unknown
  // from one page of text hits, so report null (never the free-text total); the
  // per-page match count stays in data.matchCount.
  const totalAvailable = postFiltered ? null : totalElements;
  // truncated only when there is genuinely more to see: more server pages, the
  // deep-paging cap, or this page dropped loose text hits (so a name VARIANT
  // could match on a later page). The old `|| postFiltered` forced truncated:true
  // even over a genuinely empty result set (0 text hits) — asserting incompleteness
  // over an empty set, a contradiction. A fully-consumed name-gated result is a
  // complete, honest empty.
  const truncated = serverTruncated || hitCap || (postFiltered && looseTextHits > 0);

  const notes: string[] = [NOT_PROOF_NOTE];
  notes.push(
    "Exclusion screening is only as precise as the name/UEI/CAGE you pass. A name match is NOT identity-proof — confirm the UEI/CAGE, exclusion type, and dates against the FAPIIS record (samFapiisUrl) before acting on a hit.",
  );
  if (query && looseTextHits > 0) {
    notes.push(
      `SAM's free-text search returned ${looseTextHits} more record(s) sharing a word with "${query}" but NOT matching the normalized firm name — those are OTHER entities' exclusions and were dropped. \`excluded\` reflects ONLY records whose normalized name matches your query. Because this checked one page of text hits, a match under a name VARIANT could sit on a later page — if in doubt, raise \`size\` or verify the firm's UEI via samFapiisUrl.`,
    );
  }
  if (postFiltered) {
    notes.push(
      "A uei/cage/classification/activeOnly post-filter was applied over the fetched page only — the true name-matched total is unknown from one page, so `totalAvailable` is null (the raw free-text hit count is NOT the match count). `matchCount` is this page's name-gated matches; narrow with a more specific `query` or raise `size`.",
    );
  }
  if (hitCap) {
    notes.push(
      `SAM caps deep paging at ${SGS_MAX_RECORDS.toLocaleString()} records; this query is too broad to enumerate fully — narrow the query.`,
    );
  }
  if (uei && !query) {
    notes.push(
      "You passed a UEI as the sole selector; it was used as the free-text `q` (the frontend exclusions index has no dedicated UEI field), so a match is a text hit, not a keyed UEI lookup — verify the returned uei equals the one you searched.",
    );
  }

  return withMeta(
    {
      excluded,
      matchCount,
      records,
      page,
      size,
    },
    {
      source: EXCLUSIONS_SOURCE,
      keylessMode: true,
      returned: records.length,
      totalAvailable,
      truncated,
      pagination: {
        offset: page * size,
        limit: size,
        nextOffset: serverTruncated ? (page + 1) * size : null,
        hasMore: serverTruncated,
      },
      filtersApplied,
      filtersDropped,
      fieldsUnavailable: [],
      notes,
    },
  );
}

// ─── 1b. sam_integrity_lookup (keyless composition) ──────────────

const INTEGRITY_SOURCE =
  "sam.gov exclusions (keyless) + FAPIIS/Responsibility-Qualification deep-link (record-level key-gated)";

/** The canonical, currently-resolving FAPIIS landing page (fapiis.gov 301s here). */
const FAPIIS_CONTENT_URL = "https://sam.gov/content/fapiis";

/**
 * The mandatory disclosure attached to EVERY integrity-lookup response. Kept as
 * a constant so smoke/edge/fault tests can assert it verbatim. It states, in
 * order: (1) what keyless data this covers, (2) that FAPIIS
 * Responsibility/Qualification records have NO keyless machine API, and (3) that
 * `review_fapiis` is therefore NOT a clean bill of health.
 */
const INTEGRITY_FAPIIS_NOTE =
  "FAPIIS / Responsibility-Qualification records are publicly VIEWABLE at the linked SAM page but have no keyless machine API — record-level retrieval requires an optional SAM Entity key. This lookup covers the keyless government-wide EXCLUSION list only; it is not a full integrity clearance.";

/**
 * Keyless one-call integrity screen — "any integrity red flags on this entity?"
 *
 * Composes the KEYLESS exclusion verdict (via {@link checkExclusions}, REUSED —
 * exclusion fetching is not re-implemented here) with an HONEST pointer to the
 * FAPIIS / Responsibility-Qualification record, which has NO keyless machine
 * API. Requires at least one of `uei`/`cage`/`name` (uei preferred); `name`
 * maps to the exclusion tool's `query`.
 *
 * TRUTHFULNESS (doc 07 §2.2):
 *   - `integrityFlag` is `"excluded"` when ≥1 ACTIVE matching exclusion is found,
 *     else `"review_fapiis"`. It NEVER emits `"clear"` keylessly — terminations
 *     for default/cause, non-responsibility determinations, and self-reported
 *     criminal/civil/administrative proceedings live in FAPIIS, which is not
 *     machine-readable without a key, so the absence of an exclusion does NOT
 *     prove integrity.
 *   - `fapiisRecords` is ALWAYS `null` (never faked), with
 *     `_meta.fieldsUnavailable: ["fapiisRecords"]` + INTEGRITY_FAPIIS_NOTE.
 *   - An upstream `checkExclusions` failure PROPAGATES as the classified error
 *     (the ToolErrorCarrier bubbles) — it is never masked as a "clear"/empty.
 */
export async function integrityLookup(args: {
  uei?: string;
  cage?: string;
  name?: string;
}) {
  const uei = args.uei?.trim() || undefined;
  const cage = args.cage?.trim() || undefined;
  const name = args.name?.trim() || undefined;

  // At least one identifier is required — an identity-less integrity screen is
  // meaningless. Mirror checkExclusions' structured invalid_input.
  if (!uei && !cage && !name) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message:
        "sam_integrity_lookup requires at least one of uei, cage, or name (uei preferred). Pass the entity's UEI/CAGE and/or legal name to screen.",
      retryable: false,
      upstreamEndpoint: "sgs/v1/search?index=ex",
    });
  }

  // REUSE checkExclusions for the keyless exclusion verdict (map name→query).
  // A failure here throws a classified ToolErrorCarrier that bubbles to the
  // dispatcher — we never swallow it into a fake "clear".
  const exclusionsRes = await checkExclusions({
    query: name,
    uei,
    cage,
    activeOnly: true,
  });
  const ex = exclusionsRes.data;
  const excluded = ex.excluded === true;

  // integrityFlag: "excluded" iff an ACTIVE matching exclusion was found; else
  // "review_fapiis". NEVER "clear" — absence of an exclusion is not proof of
  // integrity (the FAPIIS responsibility record is key-gated below).
  const integrityFlag: "excluded" | "review_fapiis" = excluded
    ? "excluded"
    : "review_fapiis";

  // Human deep-links: the always-valid FAPIIS content page, plus an
  // entity-workspace Responsibility/Qualification deep-link when a UEI is known.
  // These are NOT fetched by the tool — they are pointers for a human/agent.
  const fapiisUrl = uei
    ? `https://sam.gov/workspace/profile/${encodeURIComponent(uei)}/responsibilityInformation`
    : FAPIIS_CONTENT_URL;

  const data = {
    entity: {
      name: name ?? null,
      uei: uei ?? null,
      cage: cage ?? null,
    },
    exclusions: {
      excluded,
      activeCount: ex.matchCount,
      records: ex.records,
    },
    // KEY-GATED — never faked. Record-level FAPIIS retrieval needs a SAM Entity
    // key; keyless we can only point at the viewable page.
    fapiisRecords: null,
    fapiisContentUrl: FAPIIS_CONTENT_URL,
    fapiisUrl,
    integrityFlag,
  };

  const notes: string[] = [];
  // Carry through the exclusion tool's own honesty first.
  notes.push(NOT_PROOF_NOTE);
  // Then the FAPIIS key-gating disclosure.
  notes.push(INTEGRITY_FAPIIS_NOTE);
  if (integrityFlag === "review_fapiis") {
    notes.push(
      "integrityFlag is 'review_fapiis' (NEVER 'clear' in keyless mode): no ACTIVE government-wide exclusion matched these identifiers, but that does NOT establish responsibility — review the FAPIIS / Responsibility-Qualification record at fapiisUrl (terminations for default/cause, non-responsibility determinations, and self-reported proceedings are not machine-readable keylessly).",
    );
  } else {
    notes.push(
      "integrityFlag is 'excluded' — at least one ACTIVE government-wide exclusion matched these identifiers (see exclusions.records). Confirm the UEI/CAGE, exclusion type, and dates against the FAPIIS record before acting; a name match is not identity-proof.",
    );
  }
  if (!uei) {
    notes.push(
      "No UEI was supplied, so fapiisUrl points at the general FAPIIS page rather than the entity's Responsibility/Qualification profile — pass the UEI for an entity-specific deep-link and a keyed exclusion match.",
    );
  }

  return withMeta(data, {
    source: INTEGRITY_SOURCE,
    keylessMode: true,
    // A single composite verdict record — not a paged list.
    returned: 1,
    totalAvailable: 1,
    // The exclusion verdict itself is complete for these terms; the FAPIIS
    // record dimension is declared unavailable (not truncated).
    truncated: false,
    filtersApplied: [],
    filtersDropped: [],
    // FAPIIS record-level content is unavailable keylessly — declared, not faked.
    fieldsUnavailable: ["fapiisRecords"],
    notes,
  });
}

// ─── 2. usas_search_teaming_partners ─────────────────────────────

const TEAMING_SOURCE =
  "usaspending (award-derived socioeconomic proxy, keyless)";

/**
 * The `recipient_type_names` vocabulary CONFIRMED live (2026-07-03) to narrow a
 * known-populated NAICS (541512, 2023+) to a plausible non-zero, non-baseline
 * count — the server SILENTLY accepts a bogus value and returns 0 with HTTP
 * 200, so this allow-list is the guardrail. The server's Zod enum mirrors this
 * set; this runtime re-check is defense-in-depth so a bad value can never yield
 * a confident-empty list.
 *
 * Verified counts (NAICS 541512, action_date ≥ 2023-01-01):
 *   small_business ....................................... 11539
 *   8a_program_participant ...............................  4902
 *   woman_owned_business .................................  3251
 *   veteran_owned_business ...............................  2805
 *   service_disabled_veteran_owned_business .............  2450
 *   women_owned_small_business ..........................  1931
 *   economically_disadvantaged_women_owned_small_business  1192
 *   historically_underutilized_business_firm (HUBZone) ..  1025
 */
export const VERIFIED_CERTS = [
  "small_business",
  "8a_program_participant",
  "woman_owned_business",
  "women_owned_small_business",
  "economically_disadvantaged_women_owned_small_business",
  "service_disabled_veteran_owned_business",
  "veteran_owned_business",
  "historically_underutilized_business_firm",
] as const;

export type VerifiedCert = (typeof VERIFIED_CERTS)[number];

const TEAMING_PROXY_NOTE =
  "cert reflects socioeconomic categories recorded on the firm's federal awards, NOT the current SBA certification of record (which requires a SAM Entity key) — verify active certification in SAM/SBS before teaming.";

/** True total for a spending_by_award query via the companion count endpoint. */
async function teamingAwardCount(
  filters: Record<string, unknown>,
): Promise<number | null> {
  try {
    type CountResp = { results?: Record<string, number> };
    const json = await postUsas<CountResp>("search/spending_by_award_count/", {
      filters,
      subawards: false,
    });
    const results = json.results;
    if (!results) return null;
    return Object.values(results).reduce(
      (s, v) => s + (typeof v === "number" ? v : 0),
      0,
    );
  } catch {
    return null;
  }
}

type TeamingAwardRow = {
  "Award ID"?: string | null;
  "Recipient Name"?: string | null;
  "Award Amount"?: number | null;
  "Awarding Agency"?: string | null;
  "Awarding Sub Agency"?: string | null;
  NAICS?: { code?: string; description?: string } | null;
  recipient_id?: string | null;
  "Start Date"?: string | null;
  "End Date"?: string | null;
  // The award's BASE obligation date = when it was first awarded/obligated (the real
  // "award date"). Always in the past; unlike "End Date" (PoP end, often FUTURE for
  // ongoing contracts) it is the correct source for a recency signal.
  "Base Obligation Date"?: string | null;
  generated_internal_id?: string | null;
};

type TeamingSearchResp = {
  results?: TeamingAwardRow[];
  page_metadata?: { hasNext?: boolean; page?: number };
};

/**
 * Small-business teaming-partner discovery by socioeconomic certification +
 * NAICS + agency award history (keyless USAspending `spending_by_award`
 * proxy), integrity-screened.
 *
 * MECHANISM: query `spending_by_award` filtered by `recipient_type_names:[cert]`
 * (+ optional naics/agency/subagency + an action_date lookback), page a bounded
 * number of award rows, then AGGREGATE client-side by `recipient_id`
 * (spending_by_award is NOT pre-grouped by recipient — one firm spans many
 * rows). Each candidate carries agencyAwardCount + agencyObligated +
 * mostRecentAwardDate + sampleAwards, ranked by agencyObligated desc, with
 * `minAwards` applied AFTER aggregation.
 *
 * INTEGRITY: when `excludeDebarred`, the top candidates (bounded by
 * `screenCap`) are screened via checkExclusions and flagged/dropped on an
 * ACTIVE exclusion. The screen is bounded and DISCLOSED (how many screened /
 * removed / whether the screen was capped).
 *
 * HONESTY: the cert is AWARD-DERIVED, not the SBA registry of record
 * (TEAMING_PROXY_NOTE, always in _meta). A bogus cert never reaches the network
 * — it is rejected as invalid_input (the endpoint would silently return 0).
 */
export async function searchTeamingPartners(args: {
  cert: string;
  naics?: string;
  agency?: string;
  subagency?: string;
  lookbackYears?: number;
  excludeDebarred?: boolean;
  minAwards?: number;
  limit?: number;
  page?: number;
  screenCap?: number;
  scanPages?: number;
}) {
  // --- Guardrail: the cert MUST be a verified value (defense-in-depth over
  // the server's Zod enum). A bogus value would be SILENTLY accepted by the
  // endpoint (HTTP 200, 0 results) — reject it loudly instead. ----------------
  const cert = args.cert;
  if (!(VERIFIED_CERTS as readonly string[]).includes(cert)) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Unknown socioeconomic cert '${cert}'. USAspending SILENTLY accepts an unrecognized recipient_type_names value and returns 0 results with HTTP 200, so an unverified value would yield a confident-but-empty list. Use one of: ${VERIFIED_CERTS.join(", ")}.`,
      retryable: false,
      upstreamEndpoint: "search/spending_by_award",
    });
  }

  const lookbackYears = Math.min(
    20,
    Math.max(1, Math.floor(args.lookbackYears ?? 3)),
  );
  const excludeDebarred = args.excludeDebarred ?? true;
  const minAwards = Math.max(1, Math.floor(args.minAwards ?? 1));
  const limit = Math.min(50, Math.max(1, Math.floor(args.limit ?? 25)));
  const page = Math.max(1, Math.floor(args.page ?? 1));
  const screenCap = Math.min(25, Math.max(1, Math.floor(args.screenCap ?? 10)));
  const scanPages = Math.min(10, Math.max(1, Math.floor(args.scanPages ?? 4)));

  // --- Build filters (only what we can send truthfully) ---------------------
  const nowMs = Date.now();
  const startDate = new Date(nowMs);
  startDate.setUTCFullYear(startDate.getUTCFullYear() - lookbackYears);
  const startIso = startDate.toISOString().slice(0, 10);
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);

  const filters: Record<string, unknown> = {
    award_type_codes: ["A", "B", "C", "D"],
    recipient_type_names: [cert],
    time_period: [{ start_date: startIso, end_date: todayIso }],
  };
  const filtersApplied: string[] = [
    `cert(${cert})`,
    `actionDateLookback(${lookbackYears}y)`,
  ];
  const filtersDropped: string[] = [];
  if (args.naics) {
    filters.naics_codes = [args.naics];
    filtersApplied.push("naics");
  }
  // agency + optional subagency. `agencies` accepts a toptier `name` and,
  // alongside it, a subtier entry when a subagency is given.
  if (args.agency) {
    const agencies: Record<string, unknown>[] = [
      { type: "awarding", tier: "toptier", name: args.agency },
    ];
    if (args.subagency) {
      agencies.push({ type: "awarding", tier: "subtier", name: args.subagency });
    }
    filters.agencies = agencies;
    filtersApplied.push("agency");
    if (args.subagency) filtersApplied.push("subagency");
  } else if (args.subagency) {
    // A subagency without a parent agency is ambiguous on this endpoint — do
    // not send it silently; disclose it was dropped.
    filtersDropped.push("subagency(requires agency)");
  }

  const fields = [
    "Award ID",
    "Recipient Name",
    "Award Amount",
    "Awarding Agency",
    "Awarding Sub Agency",
    "NAICS",
    "recipient_id",
    "Start Date",
    "End Date",
    "Base Obligation Date",
  ];

  // --- Scan a bounded number of award-value-sorted pages, then aggregate by
  // recipient. spending_by_award is NOT grouped by recipient, so a firm spans
  // multiple rows — we roll them up. --------------------------------------
  type Candidate = {
    recipientName: string;
    recipient_id: string | null;
    uei: string | null;
    cert: string;
    naicsMatched: Set<string>;
    agencyAwardCount: number;
    agencyObligated: number;
    mostRecentAwardDate: string | null;
    sampleAwards: {
      awardId: string;
      agency: string;
      amount: number;
      date: string | null;
    }[];
    excluded: boolean | null;
  };

  const byRecipient = new Map<string, Candidate>();
  let rowsScanned = 0;
  let scanTruncated = false;

  for (let p = 1; p <= scanPages; p++) {
    const resp = await postUsas<TeamingSearchResp>(
      "search/spending_by_award",
      {
        filters,
        fields,
        sort: "Award Amount",
        order: "desc",
        limit: 100,
        page: p,
        subawards: false,
      },
    );
    const rows = resp.results ?? [];
    for (const row of rows) {
      rowsScanned++;
      const name = row["Recipient Name"] ?? "";
      // Key by recipient_id when present, else fall back to the (uppercased)
      // name so nameless-id rows still aggregate deterministically.
      const key = row.recipient_id ?? `name:${norm(name)}`;
      const amount =
        typeof row["Award Amount"] === "number" ? row["Award Amount"] : 0;
      // LEAD-8 / TEAM-1 fix (Codex dogfood C76): `mostRecentAwardDate` and each
      // sample award's `date` are the AWARD date — sourced from Base Obligation
      // Date (when the award was first obligated, always past — live-verified 40/40
      // populated & 0 future for contract types A/B/C/D), NOT "End Date" (the PoP
      // END, which is FUTURE for ongoing contracts — live-verified 13/40 future,
      // producing "award dates" like 2027-05-16). "End Date" is DELIBERATELY NOT a
      // fallback: it is the only future-capable field, so falling back to it would
      // reintroduce the exact bug on a sparse row. Start Date (PoP start, ~always
      // past) is the sole fallback; when both are absent the award date is unknown
      // (null) rather than a fabricated/future value.
      const date = row["Base Obligation Date"] ?? row["Start Date"] ?? null;
      let c = byRecipient.get(key);
      if (!c) {
        c = {
          recipientName: name,
          recipient_id: row.recipient_id ?? null,
          uei: null, // spending_by_award does not return UEI on the award row.
          cert,
          naicsMatched: new Set<string>(),
          agencyAwardCount: 0,
          agencyObligated: 0,
          mostRecentAwardDate: null,
          sampleAwards: [],
          excluded: null,
        };
        byRecipient.set(key, c);
      }
      c.agencyAwardCount += 1;
      c.agencyObligated += amount;
      if (row.NAICS?.code) c.naicsMatched.add(row.NAICS.code);
      if (date && (c.mostRecentAwardDate === null || date > c.mostRecentAwardDate)) {
        c.mostRecentAwardDate = date;
      }
      if (c.sampleAwards.length < 3) {
        c.sampleAwards.push({
          awardId: row["Award ID"] ?? "",
          agency: row["Awarding Agency"] ?? "",
          amount,
          date,
        });
      }
    }
    if (!resp.page_metadata?.hasNext) break;
    if (p === scanPages && resp.page_metadata?.hasNext) scanTruncated = true;
  }

  // --- Rank by obligated desc, apply minAwards, page ------------------------
  const ranked = [...byRecipient.values()]
    .filter((c) => c.agencyAwardCount >= minAwards)
    .sort((a, b) => {
      if (b.agencyObligated !== a.agencyObligated)
        return b.agencyObligated - a.agencyObligated;
      if (b.agencyAwardCount !== a.agencyAwardCount)
        return b.agencyAwardCount - a.agencyAwardCount;
      return a.recipientName.localeCompare(b.recipientName);
    });

  const totalCandidates = ranked.length; // EXACT only when !scanTruncated
  const startIdx = (page - 1) * limit;
  const pageSlice = ranked.slice(startIdx, startIdx + limit);

  // --- Integrity screen (bounded, disclosed) --------------------------------
  let screenedCount = 0;
  let removedCount = 0;
  let screenFailed = false;
  let screenCapped = false;
  if (excludeDebarred && pageSlice.length > 0) {
    const toScreen = pageSlice.slice(0, screenCap);
    screenCapped = pageSlice.length > screenCap;
    for (const c of toScreen) {
      if (!c.recipientName) continue;
      try {
        const res = await checkExclusions({
          query: c.recipientName,
          activeOnly: true,
          size: 25,
        });
        screenedCount++;
        // PRECISION: `checkExclusions` returns every free-text hit (SAM's `q`
        // tokenizes), so `res.data.excluded` alone is a false-positive trap —
        // it is true if ANY active record shares a word with the firm name.
        // Only flag this candidate excluded when a returned ACTIVE record's
        // NAME actually matches the firm's (normalized). A non-matching hit is
        // someone else's exclusion and must NOT drop a clean partner.
        const target = normName(c.recipientName);
        const nameMatch =
          target.length > 0 &&
          res.data.records.some(
            (rec) => rec.isActive === true && normName(rec.name) === target,
          );
        c.excluded = nameMatch;
        if (nameMatch) removedCount++;
      } catch {
        // A screen failure must NOT be read as "clean" — leave excluded:null
        // and disclose that screening degraded.
        screenFailed = true;
        c.excluded = null;
      }
    }
  }

  // Materialize the candidate rows (after screening) — drop active exclusions
  // when excludeDebarred, keep everyone otherwise.
  const candidates = pageSlice
    .filter((c) => !(excludeDebarred && c.excluded === true))
    .map((c) => ({
      recipientName: c.recipientName,
      recipient_id: c.recipient_id,
      uei: c.uei,
      cert: c.cert,
      naicsMatched: [...c.naicsMatched],
      agencyAwardCount: c.agencyAwardCount,
      agencyObligated: c.agencyObligated,
      mostRecentAwardDate: c.mostRecentAwardDate,
      sampleAwards: c.sampleAwards,
      excluded: c.excluded,
    }));

  // --- True total (award count) via the companion endpoint. This is the
  // number of AWARDS, not distinct recipients — the endpoint reports no
  // distinct-recipient total, so recipient totalAvailable stays null. -------
  const awardTotal = await teamingAwardCount(filters);

  // --- Truthful _meta -------------------------------------------------------
  const notes: string[] = [TEAMING_PROXY_NOTE];
  notes.push(
    `Candidates are aggregated client-side by recipient over a bounded ${scanPages}-page scan (${rowsScanned} award row(s), sorted by award amount desc). agencyObligated/agencyAwardCount reflect the SCANNED rows for this cert×filters slice, not necessarily the firm's entire history.`,
  );
  if (scanTruncated) {
    notes.push(
      `The ${scanPages}-page scan budget was exhausted with more award rows available, so the candidate ranking is a LOWER BOUND (a firm ranked lower here could have more awards on unscanned pages). totalAvailable (distinct recipients) is unknown — narrow with naics/agency/subagency or raise scanPages for a complete ranking.`,
    );
  }
  if (awardTotal !== null) {
    notes.push(
      `The cert×filters slice covers ${awardTotal} award(s) total (via spending_by_award_count); the ${rowsScanned} scanned row(s) are the highest-value subset. This is an AWARD count, not a distinct-recipient count.`,
    );
  }
  if (excludeDebarred) {
    notes.push(
      `Integrity screen: ${screenedCount} of the top ${pageSlice.length} ranked candidate(s) were screened for ACTIVE SAM exclusions${screenCapped ? ` (capped at ${screenCap}; lower-ranked candidates on this page were NOT screened)` : ""}; ${removedCount} with an active exclusion ${removedCount === 1 ? "was" : "were"} dropped. Matching is by NORMALIZED NAME (a firm is flagged only when an active exclusion record's name matches — a shared-word text hit does NOT drop a firm), and because UEI is unavailable on award rows this is a NAME match, not a keyed UEI match — confirm any borderline case in SAM. An unscreened candidate's excluded flag is null (unknown), NOT a clearance.`,
    );
    if (screenFailed) {
      notes.push(
        "At least one exclusion screen FAILED (upstream error) — those candidates show excluded:null and were NOT dropped; re-run to complete screening. A failed screen is not a clean result.",
      );
    }
  } else {
    notes.push(
      "excludeDebarred is false — candidates were NOT screened for SAM exclusions (`excluded` is null for all). Screen with sam_check_exclusions before teaming.",
    );
  }
  if (filtersDropped.includes("subagency(requires agency)")) {
    notes.push(
      "A subagency was requested without a parent agency and was NOT applied — pass `agency` (the toptier name) alongside `subagency`.",
    );
  }

  const hasMore = scanTruncated ? true : startIdx + limit < totalCandidates;
  const truncated = hasMore || scanTruncated;

  return withMeta(
    {
      candidates,
      cert,
      page,
      limit,
    },
    {
      source: TEAMING_SOURCE,
      keylessMode: true,
      returned: candidates.length,
      // The distinct-recipient total is unknown when the scan truncated; even
      // when complete, the endpoint reports only an AWARD count (awardTotal),
      // not a distinct-recipient total, so recipient totalAvailable is null.
      totalAvailable: null,
      truncated,
      pagination: {
        offset: startIdx,
        limit,
        nextOffset: hasMore ? startIdx + limit : null,
        hasMore,
      },
      filtersApplied,
      filtersDropped,
      // UEI is not returned on the spending_by_award row (needs a recipient
      // profile lookup); the SBA cert of record needs a keyed SAM Entity call.
      fieldsUnavailable: [
        "uei(needs usas_get_recipient_profile)",
        "sbaCertificationOfRecord(needs keyed SAM Entity)",
      ],
      notes,
    },
  );
}
