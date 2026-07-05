/**
 * USAspending v2 wrappers (keyless).
 *
 * Coverage map (every endpoint here is verified KEYLESS):
 *   Awards / Recipients
 *     - search/spending_by_category/recipient        → searchAwards
 *     - search/spending_by_award (subawards: false)  → searchIndividualAwards
 *     - search/spending_by_award (subawards: true)   → searchSubawards
 *     - search/spending_by_award (recipient filter)  → searchAwardsByRecipient
 *     - awards/{generated_internal_id}               → getAwardDetail
 *     - search/spending_by_award + awards/{id} pair  → searchExpiringContracts
 *   Aggregate analysis
 *     - search/spending_over_time                    → spendingOverTime
 *     - search/spending_by_category/psc              → searchPscSpending
 *     - search/spending_by_category/state_territory  → searchStateSpending
 *     - search/spending_by_category/cfda             → searchCfdaSpending
 *     - search/spending_by_category/federal_account  → searchFederalAccountSpending
 *     - search/spending_by_category/awarding_agency  → searchAgencySpending
 *     - search/spending_by_category/awarding_subagency → searchSubAgencySpending
 *   Agency profile
 *     - agency/{toptier_code}                        → getAgencyProfile
 *     - agency/{toptier_code}/awards                 → getAgencyAwardsSummary
 *     - agency/{toptier_code}/budget_function        → getAgencyBudgetFunction
 *   Recipient profile
 *     - recipient/ POST                              → searchRecipients
 *     - recipient/{id}                               → getRecipientProfile
 *   Reference / autocomplete (anti-hallucination)
 *     - autocomplete/funding_agency                  → lookupAgency
 *     - autocomplete/naics                           → autocompleteNaics
 *     - autocomplete/recipient                       → autocompleteRecipient
 *     - references/naics                             → naicsHierarchy
 *     - references/glossary                          → glossary
 *     - references/toptier_agencies                  → listToptierAgencies
 *
 * Total: 22 endpoints across the USAspending surface, all keyless.
 */

const USAS = "https://api.usaspending.gov/api/v2";

export type UsasFilters = Record<string, unknown>;

function buildFilters(args: {
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  setAside?: string;
  pscCodes?: string[];
}): UsasFilters {
  const filters: UsasFilters = { award_type_codes: ["A", "B", "C", "D"] };
  if (args.agency) {
    filters.agencies = [
      { type: "awarding", tier: "toptier", name: args.agency },
    ];
  }
  if (args.naics) filters.naics_codes = [args.naics];
  if (args.fiscalYear) {
    filters.time_period = [
      {
        start_date: `${args.fiscalYear - 1}-10-01`,
        end_date: `${args.fiscalYear}-09-30`,
      },
    ];
  }
  if (args.setAside) filters.set_aside_type_codes = [args.setAside];
  if (args.pscCodes?.length) filters.psc_codes = args.pscCodes;
  return filters;
}

import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
import { memoize } from "./cache.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

const SPENDING_BY_AWARD_SOURCE =
  "usaspending.gov/api/v2 search/spending_by_award";
const SPENDING_BY_CATEGORY_RECIPIENT_SOURCE =
  "usaspending.gov/api/v2 search/spending_by_category/recipient";

/**
 * `page_metadata` shape for the `spending_by_category/*` endpoints. These are
 * cursor/page-paginated: the block carries `hasNext` but NO grand total
 * (empirically verified 2026-07-03 for psc/state_territory/cfda/federal_account/
 * awarding_agency/awarding_subagency — every one returns only
 * `{page, next, previous, hasNext, hasPrevious}`). So a truthful aggregate
 * `_meta` uses `hasNext` as the truncation signal and sets
 * `totalAvailable: null` — never the page length (spec §3.3).
 */
type CategoryPageMeta = {
  page?: number;
  next?: number | null;
  hasNext?: boolean;
};

/**
 * Build the `_meta` for a top-N `spending_by_category/*` aggregate. These
 * category endpoints report no grand total, so `totalAvailable` is always
 * `null` (honest "unknown" — never the returned count). Truncation is the
 * endpoint's own `hasNext` when present, else `returned >= limit`.
 */
function categoryAggregateMeta(opts: {
  source: string;
  returned: number;
  limit: number;
  hasNext?: boolean;
  fieldsUnavailable?: string[];
  extraNotes?: string[];
}): Partial<ResponseMeta> {
  const truncated = opts.hasNext ?? opts.returned >= opts.limit;
  const notes: string[] = [];
  if (truncated) {
    notes.push(
      `Capped at the top ${opts.limit} categories by amount; more categories may exist. This endpoint reports no grand total, so the true number of categories is unknown (totalAvailable is null, NOT the returned count) — page with a larger limit to see more.`,
    );
  }
  if (opts.extraNotes) notes.push(...opts.extraNotes);
  return {
    source: opts.source,
    keylessMode: true,
    returned: opts.returned,
    // spec §3.3: the spending_by_category/* endpoints expose no total → null.
    totalAvailable: null,
    truncated,
    pagination: {
      offset: 0,
      limit: opts.limit,
      nextOffset: truncated ? opts.returned : null,
      hasMore: truncated,
    },
    filtersApplied: [],
    filtersDropped: [],
    fieldsUnavailable: opts.fieldsUnavailable ?? [],
    notes,
  };
}

/**
 * Build the `_meta` for a reference / autocomplete tool. These are the
 * anti-hallucination lookups (NAICS/recipient autocomplete, NAICS hierarchy,
 * glossary, toptier agencies). Completeness rule (spec §2.3): a page that
 * came back SHORT of the requested `limit` is the whole result set
 * (`truncated:false`); a FULL page means more may exist (`truncated:true`).
 * When the endpoint reports a real total (glossary), pass it so truncation is
 * derived from `returned < total` instead. All are served from a 5-min TTL
 * cache (see cache.ts) — noted so the AI knows the data may be up to 5 min old.
 * [가설] we can't tell a cache HIT from a MISS here, so the note is
 * unconditional rather than hit-specific.
 */
function referenceMeta(opts: {
  source: string;
  returned: number;
  limit: number;
  totalAvailable: number | null;
  limitHonored?: boolean; // false ⇒ endpoint ignores `limit` (e.g. toptier)
  extraNotes?: string[];
}): Partial<ResponseMeta> {
  const { source, returned, limit, totalAvailable } = opts;
  const limitHonored = opts.limitHonored ?? true;
  let truncated: boolean;
  let hasMore: boolean;
  if (totalAvailable !== null) {
    truncated = returned < totalAvailable;
    hasMore = truncated;
  } else if (!limitHonored) {
    // Endpoint ignores `limit` and returns the full set → complete.
    truncated = false;
    hasMore = false;
  } else {
    truncated = returned >= limit;
    hasMore = truncated;
  }
  const notes: string[] = [
    "Reference lookup served from a 5-minute TTL cache; values may be up to 5 minutes stale.",
  ];
  if (truncated) {
    notes.push(
      totalAvailable !== null
        ? `Showing ${returned} of ${totalAvailable} total; raise limit to see more.`
        : `A full page of ${returned} was returned; more matches may exist — raise limit to widen the result.`,
    );
  }
  if (opts.extraNotes) notes.push(...opts.extraNotes);
  return {
    source,
    keylessMode: true,
    returned,
    totalAvailable,
    truncated,
    pagination: {
      offset: 0,
      limit,
      nextOffset: hasMore ? returned : null,
      hasMore,
    },
    filtersApplied: [],
    filtersDropped: [],
    fieldsUnavailable: [],
    notes,
  };
}

/**
 * True total for a `spending_by_award` query, via the companion
 * `spending_by_award_count` endpoint.
 *
 * WHY a companion query (not `page_metadata.total`): the `spending_by_award`
 * response uses cursor-style pagination — its `page_metadata` carries only
 * `page`/`hasNext`/`last_record_*`, NOT a `total` (empirically verified
 * 2026-07-03; the spec's assumption that it mirrors `recipient/`'s
 * `page_metadata.total` was wrong for this endpoint). The only honest source
 * of a real count is `spending_by_award_count`, which returns per-award-type
 * buckets; we sum them. Returns `null` on any failure — NEVER a page length
 * (spec §3.3: never substitute page size for an unknown total).
 */
async function awardCount(
  filters: UsasFilters,
  mode: "awards" | "subawards",
): Promise<number | null> {
  try {
    type CountResp = { results?: Record<string, number> };
    const body: Record<string, unknown> = { filters };
    if (mode === "subawards") body.subawards = true;
    const json = await postUsas<CountResp>(
      "search/spending_by_award_count/",
      body,
    );
    const results = json.results;
    if (!results) return null;
    // Awards → contracts+idvs+direct_payments+grants+loans+other.
    // Subawards → subcontracts+subgrants. Sum every numeric bucket so we stay
    // correct if the endpoint adds categories.
    return Object.values(results).reduce(
      (s, v) => s + (typeof v === "number" ? v : 0),
      0,
    );
  } catch {
    return null;
  }
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

async function getUsas<T>(endpoint: string): Promise<T> {
  const r = await fetchWithRetry(
    `${USAS}/${endpoint}`,
    { signal: AbortSignal.timeout(15_000) },
    `usaspending:${endpoint}`,
  );
  return (await r.json()) as T;
}

// ─── Aggregate share-of-wallet ───────────────────────────────────

export async function searchAwards(args: {
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  setAside?: string;
}) {
  const filters = buildFilters(args);
  type Resp = {
    results?: { name?: string; amount?: number; count?: number }[];
    page_metadata?: { total?: number; count?: number };
  };
  const limit = 10;
  const json = await postUsas<Resp>(
    "search/spending_by_category/recipient",
    { filters, limit, page: 1 },
  );
  const results = json.results ?? [];
  // B1 (spec §1.3, §3.4): the spending_by_category/recipient endpoint returns
  // `amount` but NOT a per-recipient award `count`. The old code defaulted the
  // missing count to 0, so every recipient reported `awards:0` and
  // `totalAwards:0` while `totalValue` was billions — a self-contradictory lie
  // ("0 contracts worth $3.45B"). Emit `null` (explicit "not available"), NOT
  // 0, and flag it in `_meta.fieldsUnavailable`. `amount`/`value` unchanged.
  const data = {
    totalAwards: null as number | null,
    totalValue: results.reduce((s, r) => s + (r.amount ?? 0), 0),
    topRecipients: results.map((r) => ({
      name: r.name ?? "—",
      value: r.amount ?? 0,
      awards: null as number | null,
    })),
  };
  return withMeta(data, {
    source: SPENDING_BY_CATEGORY_RECIPIENT_SOURCE,
    keylessMode: true,
    returned: results.length,
    // This is a landscape/top-N aggregate: the recipient tail is capped at
    // `limit` and the category endpoint reports no grand total → unknown.
    totalAvailable: null,
    truncated: results.length >= limit,
    filtersApplied: [],
    filtersDropped: [],
    fieldsUnavailable: ["awards", "totalAwards"],
    notes: [
      "Per-recipient award COUNTS are not available from the spending_by_category/recipient endpoint (it returns obligated amount only) — `awards` and `totalAwards` are null, not 0. For a real contract count use usas_search_awards_by_recipient (its _meta.totalAvailable) or usas_get_recipient_profile.",
      "Only contract award types (A/B/C/D) are included; grants/IDVs are excluded from this share-of-wallet view.",
    ],
  });
}

// ─── Line-item awards ─────────────────────────────────────────────

export async function searchIndividualAwards(args: {
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  setAside?: string;
  limit?: number;
}) {
  const filters = buildFilters(args);
  type Resp = {
    results?: {
      "Award ID"?: string;
      "Recipient Name"?: string;
      "Award Amount"?: number;
      "Awarding Agency"?: string;
      "Awarding Sub Agency"?: string;
      NAICS?: { code?: string; description?: string };
      "Place of Performance State Code"?: string;
      "Place of Performance City Code"?: string;
      "Place of Performance Country Code"?: string;
      "Place of Performance Zip5"?: string;
      Description?: string;
      generated_internal_id?: string;
    }[];
    page_metadata?: { hasNext?: boolean };
  };
  const limit = args.limit ?? 10;
  // D1/D2 field-parity (spec §3.2): "NAICS" and the "Place of Performance …"
  // fields are valid `spending_by_award` field names (empirically verified
  // 2026-07-03 + confirmed against the API contract) and cost NO extra request
  // — USAspending returns whatever fields you ask for. Set-aside is NOT a
  // requestable field on this endpoint (filter-only) → documented as
  // detail-only in `_meta.fieldsUnavailable`.
  const [json, total] = await Promise.all([
    postUsas<Resp>("search/spending_by_award", {
      filters,
      fields: [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Awarding Agency",
        "Awarding Sub Agency",
        "NAICS",
        "Place of Performance State Code",
        "Place of Performance City Code",
        "Place of Performance Country Code",
        "Place of Performance Zip5",
        "Description",
      ],
      limit,
      page: 1,
      subawards: false,
    }),
    awardCount(filters, "awards"),
  ]);
  const results = json.results ?? [];
  const data = {
    awards: results.map((r) => ({
      awardId: r["Award ID"] ?? "",
      recipient: r["Recipient Name"] || null,
      amount: r["Award Amount"] ?? 0,
      awardingAgency: r["Awarding Agency"] || null,
      awardingSubAgency: r["Awarding Sub Agency"],
      // D1: NAICS now returned (parity with usas_search_awards_by_recipient).
      naicsCode: r.NAICS?.code,
      naicsDescription: r.NAICS?.description,
      placeOfPerformanceState: r["Place of Performance State Code"],
      placeOfPerformanceCity: r["Place of Performance City Code"],
      placeOfPerformanceCountry: r["Place of Performance Country Code"],
      placeOfPerformanceZip: r["Place of Performance Zip5"],
      description: r.Description,
      generatedInternalId: r.generated_internal_id ?? "",
    })),
  };
  return withMeta(data, {
    source: SPENDING_BY_AWARD_SOURCE,
    keylessMode: true,
    returned: results.length,
    totalAvailable: total,
    pagination: awardPagination(
      0,
      limit,
      results.length,
      total,
      json.page_metadata?.hasNext ?? false,
    ),
    filtersApplied: [],
    filtersDropped: [],
    // Set-aside is not a `spending_by_award` output field; PoP city is often a
    // numeric code (or null) rather than a name. Both live in detail.
    fieldsUnavailable: ["setAside", "setAsideDescription"],
    notes: [
      "Set-aside type is NOT available from the spending_by_award search endpoint (it can only be FILTERED, not returned) — call usas_get_award_detail (setAsideType/setAsideDescription) per award via generatedInternalId.",
    ],
  });
}

/** hasMore for cursor-paginated award search: prefer the real total. */
function awardPagination(
  offset: number,
  limit: number,
  returned: number,
  total: number | null,
  upstreamHasNext: boolean,
): NonNullable<MetaBundle["meta"]["pagination"]> {
  const hasMore =
    total !== null ? offset + returned < total : upstreamHasNext;
  return {
    offset,
    limit,
    nextOffset: hasMore ? offset + returned : null,
    hasMore,
  };
}

// ─── Recipient win history ────────────────────────────────────────

export async function searchAwardsByRecipient(args: {
  recipientName: string;
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  limit?: number;
}) {
  const filters = buildFilters(args);
  filters.recipient_search_text = [args.recipientName];
  type Resp = {
    results?: {
      "Award ID"?: string;
      "Recipient Name"?: string;
      "Award Amount"?: number;
      "Awarding Agency"?: string;
      "Awarding Sub Agency"?: string;
      NAICS?: { code?: string; description?: string };
      "Place of Performance State Code"?: string;
      "Place of Performance City Code"?: string;
      "Place of Performance Country Code"?: string;
      "Place of Performance Zip5"?: string;
      Description?: string;
      generated_internal_id?: string;
    }[];
    page_metadata?: { hasNext?: boolean };
  };
  const limit = args.limit ?? 15;
  const [json, total] = await Promise.all([
    postUsas<Resp>("search/spending_by_award", {
      filters,
      fields: [
        "Award ID",
        "Recipient Name",
        "Award Amount",
        "Awarding Agency",
        "Awarding Sub Agency",
        "NAICS",
        "Place of Performance State Code",
        "Place of Performance City Code",
        "Place of Performance Country Code",
        "Place of Performance Zip5",
        "Description",
      ],
      limit,
      page: 1,
      subawards: false,
    }),
    awardCount(filters, "awards"),
  ]);
  const results = json.results ?? [];
  const data = {
    awards: results.map((r) => ({
      awardId: r["Award ID"] ?? "",
      recipient: r["Recipient Name"] || null,
      amount: r["Award Amount"] ?? 0,
      awardingAgency: r["Awarding Agency"] || null,
      awardingSubAgency: r["Awarding Sub Agency"],
      naicsCode: r.NAICS?.code,
      naicsDescription: r.NAICS?.description,
      placeOfPerformanceState: r["Place of Performance State Code"],
      placeOfPerformanceCity: r["Place of Performance City Code"],
      placeOfPerformanceCountry: r["Place of Performance Country Code"],
      placeOfPerformanceZip: r["Place of Performance Zip5"],
      description: r.Description,
      generatedInternalId: r.generated_internal_id ?? "",
    })),
    // C5 (spec §1.4, §3.3): the OLD value was `results.length` — the PAGE SIZE,
    // not the true count. A recipient with 400 awards but a 15-row page
    // reported `totalRecords:15` (an order-of-magnitude lie). Now the REAL
    // upstream total (via spending_by_award_count), or null if that companion
    // query failed — never the page length.
    totalRecords: total,
  };
  return withMeta(data, {
    source: SPENDING_BY_AWARD_SOURCE,
    keylessMode: true,
    returned: results.length,
    totalAvailable: total,
    pagination: awardPagination(
      0,
      limit,
      results.length,
      total,
      json.page_metadata?.hasNext ?? false,
    ),
    filtersApplied: [],
    filtersDropped: [],
    fieldsUnavailable: ["setAside", "setAsideDescription"],
    notes: [
      "Set-aside type is NOT available from the spending_by_award search endpoint (filter-only) — call usas_get_award_detail per award for setAsideType/setAsideDescription.",
    ],
  });
}

// ─── Subaward enumeration ─────────────────────────────────────────

export async function searchSubawards(args: {
  primeRecipientName?: string;
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  limit?: number;
}) {
  const filters = buildFilters(args);
  if (args.primeRecipientName) {
    filters.recipient_search_text = [args.primeRecipientName];
  }
  type Resp = {
    results?: {
      "Sub-Award ID"?: string;
      "Sub-Award Recipient"?: string;
      "Sub-Award Amount"?: number;
      "Sub-Award Date"?: string;
      NAICS?: { code?: string; description?: string };
      prime_award_generated_internal_id?: string;
    }[];
    page_metadata?: { hasNext?: boolean };
  };
  const limit = args.limit ?? 15;
  // A3 (spec §1.2, §3.2): the OLD code requested "Sub-Award NAICS", which is
  // NOT a valid field name on this endpoint — `spending_by_award` echoes an
  // unknown field back as `null` (verified 2026-07-03), so the arg looked
  // honored but silently returned nothing. The valid field for subaward NAICS
  // is "NAICS" (returns {code,description} — the PRIME award's NAICS, which is
  // what USAspending exposes on subaward rows). Swap to it and map it.
  const [json, total] = await Promise.all([
    postUsas<Resp>("search/spending_by_award", {
      filters,
      fields: [
        "Sub-Award ID",
        "Sub-Award Recipient",
        "Sub-Award Amount",
        "Sub-Award Date",
        "NAICS",
      ],
      limit,
      page: 1,
      subawards: true,
    }),
    awardCount(filters, "subawards"),
  ]);
  const results = json.results ?? [];
  const data = {
    subawards: results.map((r) => ({
      subAwardId: r["Sub-Award ID"] ?? "",
      subRecipient: r["Sub-Award Recipient"] ?? "(name redacted)",
      amount: r["Sub-Award Amount"] ?? 0,
      actionDate: r["Sub-Award Date"] ?? "",
      // A3: prime-award NAICS on the subaward row (the only NAICS the endpoint
      // exposes for subawards). null when the row genuinely lacks it.
      naicsCode: r.NAICS?.code,
      naicsDescription: r.NAICS?.description,
      primeAwardId: r.prime_award_generated_internal_id ?? "",
    })),
  };
  return withMeta(data, {
    source: SPENDING_BY_AWARD_SOURCE,
    keylessMode: true,
    returned: results.length,
    totalAvailable: total,
    pagination: awardPagination(
      0,
      limit,
      results.length,
      total,
      json.page_metadata?.hasNext ?? false,
    ),
    filtersApplied: [],
    filtersDropped: [],
    fieldsUnavailable: [],
    notes: [
      "The `naicsCode`/`naicsDescription` on each subaward is the PRIME award's NAICS (USAspending does not expose a distinct sub-award NAICS on this endpoint). A subaward-specific NAICS is not available keyless.",
    ],
  });
}

// ─── Per-award detail ─────────────────────────────────────────────

/**
 * Parse USAspending's `number_of_offers_received` to a real number|null.
 *
 * LIVE-VERIFIED 2026-07-03: this field is a STRING on competed awards (e.g.
 * "1", "2", "3") but is genuinely `null` on some delivery orders — so the
 * previous typing/mapping (`number_of_offers_received?: string`, passed
 * through raw) exposed a string where a numeric compare was expected. Coerce
 * to a number; return null for null/empty/non-numeric so a missing value is
 * an honest "unknown", never 0 or "".
 */
function parseOffers(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : null;
}

/** A parent-award / IDV linkage as returned on awards/{id} (all optional). */
export type AwardParentIdv = {
  piid: string | null;
  generatedUniqueAwardId: string | null;
  idvTypeDescription: string | null;
  multipleOrSingleAwardDescription: string | null;
};

export async function getAwardDetail(generatedInternalId: string) {
  try {
    const r = await fetch(
      `${USAS}/awards/${encodeURIComponent(generatedInternalId)}/`,
      { signal: AbortSignal.timeout(10_000) },
    );
    // 404 = the id genuinely doesn't resolve → null (a real "not found").
    // 429/5xx = a RETRYABLE upstream fault, NOT a missing award → throw a
    // classified error so callers never mislabel an outage as not_found.
    if (r.status === 404) return null;
    if (!r.ok) {
      throw new ToolErrorCarrier({
        kind: r.status === 429 ? "rate_limited" : "upstream_unavailable",
        message: `usaspending awards/{id} returned ${r.status}`,
        retryable: true,
        upstreamStatus: r.status,
        upstreamEndpoint: `awards/${generatedInternalId}`,
      });
    }
    type Resp = {
      piid?: string;
      description?: string;
      total_obligation?: number;
      base_and_all_options?: number;
      base_exercised_options?: number;
      subaward_count?: number;
      type?: string;
      type_description?: string;
      category?: string;
      period_of_performance?: {
        start_date?: string;
        end_date?: string;
        potential_end_date?: string;
      };
      latest_transaction_contract_data?: {
        type_set_aside?: string;
        type_set_aside_description?: string;
        extent_competed?: string;
        extent_competed_description?: string;
        number_of_offers_received?: string | number | null;
        naics?: string;
        naics_description?: string;
        product_or_service_code?: string;
        product_or_service_description?: string;
      };
      psc_hierarchy?: { base_code?: { code?: string; description?: string } };
      parent_award?: {
        piid?: string;
        generated_unique_award_id?: string;
        idv_type_description?: string;
        multiple_or_single_aw_desc?: string;
      } | null;
      awarding_agency?: {
        toptier_agency?: { name?: string };
        subtier_agency?: { name?: string };
      };
      recipient?: { recipient_name?: string };
    };
    const json = (await r.json()) as Resp;
    const ltc = json.latest_transaction_contract_data ?? {};
    // PSC: prefer the ltc code, fall back to the psc_hierarchy base code (the
    // ltc-level product_or_service_code is often absent while the hierarchy
    // carries it — LIVE-VERIFIED 2026-07-03).
    const pscCode =
      ltc.product_or_service_code ?? json.psc_hierarchy?.base_code?.code ?? null;
    const pscDescription =
      ltc.product_or_service_description ??
      json.psc_hierarchy?.base_code?.description ??
      null;
    const parent = json.parent_award ?? null;
    const parentIdv: AwardParentIdv | null = parent
      ? {
          piid: parent.piid ?? null,
          generatedUniqueAwardId: parent.generated_unique_award_id ?? null,
          idvTypeDescription: parent.idv_type_description ?? null,
          multipleOrSingleAwardDescription:
            parent.multiple_or_single_aw_desc ?? null,
        }
      : null;
    return {
      awardId: json.piid ?? "",
      // Identity field is null (UNKNOWN) when absent OR blank — never "" (which
      // reads as "no recipient"). `|| null` catches both a missing recipient_name
      // and a present-but-empty one. Consistent with analyzeIncumbent's incumbent
      // field (#43) and the money fields below.
      recipient: json.recipient?.recipient_name || null,
      // Money fields are null (UNKNOWN) when USAspending omits them — never 0.
      // A null base_and_all_options is common and legitimate (IDVs/BPAs carry
      // the ceiling at the vehicle level, grants/loans have no ceiling concept);
      // rendering it as 0 would read as "a $0 ceiling", a data-absence-as-present
      // masquerade. Consistent with baseExercisedOptions, which already nulls.
      totalObligation: json.total_obligation ?? null,
      baseAndAllOptions: json.base_and_all_options ?? null,
      baseExercisedOptions: json.base_exercised_options ?? null,
      subawardCount: json.subaward_count ?? null,
      // Award type + human description (e.g. "C" / "DELIVERY ORDER").
      contractAwardType: json.type_description ?? json.type ?? null,
      periodOfPerformance: {
        startDate: json.period_of_performance?.start_date ?? null,
        endDate: json.period_of_performance?.end_date ?? null,
        potentialEndDate: json.period_of_performance?.potential_end_date ?? null,
      },
      description: json.description ?? "",
      setAsideType: ltc.type_set_aside,
      setAsideDescription: ltc.type_set_aside_description,
      competitionExtent: ltc.extent_competed,
      competitionExtentDescription: ltc.extent_competed_description ?? null,
      // E-type-hygiene fix: number_of_offers_received is now a parsed
      // number|null, not the raw string it arrives as.
      numberOfOffers: parseOffers(ltc.number_of_offers_received),
      awardingAgency: json.awarding_agency?.toptier_agency?.name,
      awardingSubAgency: json.awarding_agency?.subtier_agency?.name,
      naicsCode: ltc.naics,
      naicsDescription: ltc.naics_description,
      pscCode,
      pscDescription,
      parentIdv,
    };
  } catch (e) {
    // A classified upstream error (429/5xx) must propagate so the caller can
    // retry and never mislabel it as not_found. A network/timeout/parse fault
    // is likewise retryable — surface it, don't collapse it to a false null.
    if (e instanceof ToolErrorCarrier) throw e;
    throw new ToolErrorCarrier({
      kind: "upstream_unavailable",
      message: `usaspending awards/{id} fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      retryable: true,
      upstreamEndpoint: `awards/${generatedInternalId}`,
    });
  }
}

// ─── Per-award transaction (modification) count ───────────────────

/**
 * Bounded modification-count for a single award via the keyless
 * `POST transactions/` endpoint (`{award_id, limit:100, page:1}`).
 *
 * WHY bounded, not paged: this endpoint's `page_metadata` carries only
 * `hasNext` — there is NO grand total (LIVE-VERIFIED 2026-07-03). So we read
 * ONE 100-row page and return its length. If `hasNext` is true the true count
 * exceeds 100, so we return `{ count: <len>, atLeast: true }` — a LOWER BOUND,
 * never an unbounded fan-out. `modification_number` on the latest transaction
 * is an unreliable proxy (it was `undefined` on the test award) and is not
 * used. Returns `null` count on failure so the caller degrades honestly.
 */
async function transactionsCount(
  generatedInternalId: string,
): Promise<{ count: number | null; atLeast: boolean }> {
  try {
    type Resp = {
      results?: unknown[];
      page_metadata?: { hasNext?: boolean };
    };
    const json = await postUsas<Resp>("transactions/", {
      award_id: generatedInternalId,
      limit: 100,
      page: 1,
    });
    const rows = json.results ?? [];
    return { count: rows.length, atLeast: json.page_metadata?.hasNext === true };
  } catch {
    return { count: null, atLeast: false };
  }
}

// ─── Per-award incumbent + public recompete-pressure analysis ─────

const ANALYZE_INCUMBENT_SOURCE =
  "usaspending.gov awards/{id} + transactions + spending_by_award (keyless)";

/**
 * The public fields that are decision-relevant for a recompete but are NOT
 * in any keyless (or any public) source — declared in `_meta.fieldsUnavailable`
 * so the AI hedges instead of inventing a vulnerability score.
 */
const ANALYZE_FIELDS_UNAVAILABLE = [
  "past_performance_cpars",
  "protest_history",
  "option_exercise_intent",
];

/**
 * Per-award incumbent + PUBLIC recompete-pressure analysis (design doc 04
 * §5.2). Given ONE award (`generatedInternalId`) it assembles, from keyless
 * data only:
 *   - the incumbent identity + the award's agency/NAICS/PSC/vehicle,
 *   - PUBLIC recompete-pressure SIGNALS (obligated-vs-ceiling consumption, mod
 *     count, competition extent + number of offers, set-aside, days to the
 *     current PoP end, and option-extendable days), and
 *   - (optionally) the incumbent's other awards in the same agency.
 *
 * DESIGN — bounded & keyless, NO N+1 fan-out:
 *   1 `awards/{id}` detail  +  1 `transactions/` page (mod count, capped at
 *   100 → lower bound)  +  (optional) 1 `searchAwardsByRecipient` call. That is
 *   at most 3 upstream calls regardless of award size.
 *
 * HONEST CEILING (mandatory): it emits INDIVIDUAL public signals + `pressureHints`
 * (e.g. "single_offer", "ceiling_nearly_exhausted", "hard_stop_no_options") that
 * are HINTS, never a score. It NEVER emits a composite "vulnerability score" —
 * the most decision-relevant input (past performance / CPARS), protest history,
 * and the incumbent's option-exercise intent are not public, and are declared
 * in `_meta.fieldsUnavailable`. A not-found award raises a structured not_found
 * error (never `{ok:true, data:null}`).
 */
export async function analyzeIncumbent(args: {
  generatedInternalId: string;
  includeOtherAwards?: boolean;
  otherAwardsLimit?: number;
}) {
  const includeOtherAwards = args.includeOtherAwards ?? true;
  const otherAwardsLimit = Math.min(
    50,
    Math.max(1, Math.floor(args.otherAwardsLimit ?? 15)),
  );

  // --- 1. Award detail (throws not_found if the id doesn't resolve) ------
  const detail = await getAwardDetail(args.generatedInternalId);
  if (!detail) {
    throw new ToolErrorCarrier({
      kind: "not_found",
      message: `No award found for generatedInternalId '${args.generatedInternalId}' on usaspending.gov awards/{id}. Resolve a valid id via usas_search_individual_awards or usas_search_awards_by_recipient (each result carries a generatedInternalId).`,
      retryable: false,
      upstreamEndpoint: `awards/${args.generatedInternalId}`,
    });
  }

  const nowMs = Date.now();
  let enrichmentCalls = 1; // the detail fetch

  // --- 2. Bounded mod count (1 transactions page) -----------------------
  const mods = await transactionsCount(args.generatedInternalId);
  enrichmentCalls++;

  // --- 3. Signals (all PUBLIC, individual — never combined into a score) -
  const obligated = detail.totalObligation;
  const ceiling = detail.baseAndAllOptions;
  // pctConsumed only when BOTH obligated is a number AND the ceiling is a usable
  // positive number; a null/absent obligated or a 0/absent/negative ceiling → null
  // (never a divide-by-zero, a null-coerced-to-0 ratio, or a nonsensical negative).
  const pctConsumed =
    typeof obligated === "number" && typeof ceiling === "number" && ceiling > 0
      ? obligated / ceiling
      : null;

  const currentEndDate = detail.periodOfPerformance.endDate;
  const potentialEndDate = detail.periodOfPerformance.potentialEndDate;
  const daysUntilCurrentEnd = daysUntil(currentEndDate, nowMs);
  const daysUntilPotentialEnd = daysUntil(potentialEndDate, nowMs);
  // extendableDays = runway the unexercised options would add. Null when
  // either end date is unusable.
  const extendableDays =
    daysUntilPotentialEnd !== null && daysUntilCurrentEnd !== null
      ? daysUntilPotentialEnd - daysUntilCurrentEnd
      : null;

  const numberOfOffers = detail.numberOfOffers; // already number|null

  const signals = {
    obligatedVsCeiling: {
      obligated,
      baseAndAllOptions: ceiling,
      baseExercisedOptions: detail.baseExercisedOptions,
      pctConsumed,
    },
    modCount: mods.count,
    modCountAtLeast: mods.atLeast,
    setAside: detail.setAsideType ?? null,
    setAsideDescription: detail.setAsideDescription ?? null,
    extentCompeted: detail.competitionExtent ?? null,
    extentCompetedDescription: detail.competitionExtentDescription ?? null,
    numberOfOffers,
    currentEndDate,
    potentialEndDate,
    extendableDays,
    daysUntilCurrentEnd,
    vehicle: {
      contractAwardType: detail.contractAwardType,
      parentIdvPiid: detail.parentIdv?.piid ?? null,
      idvType: detail.parentIdv?.idvTypeDescription ?? null,
      singleOrMultiple:
        detail.parentIdv?.multipleOrSingleAwardDescription ?? null,
    },
  };

  // --- pressureHints: individual PUBLIC flags — HINTS, never a score -----
  const pressureHints: string[] = [];
  if (numberOfOffers === 1) pressureHints.push("single_offer");
  if (pctConsumed !== null && pctConsumed >= 0.9)
    pressureHints.push("ceiling_nearly_exhausted");
  if (extendableDays !== null && extendableDays <= 0)
    pressureHints.push("hard_stop_no_options");

  // --- 4. Incumbent's other awards in the same agency (1 bounded call) ---
  let incumbentOtherAwards:
    | Awaited<ReturnType<typeof searchAwardsByRecipient>>["data"]["awards"]
    | undefined;
  let otherAwardsFailed = false;
  if (includeOtherAwards && detail.recipient) {
    enrichmentCalls++; // count the attempt (whether or not it succeeds)
    try {
      const other = await searchAwardsByRecipient({
        recipientName: detail.recipient,
        agency: detail.awardingAgency,
        naics: detail.naicsCode,
        limit: otherAwardsLimit,
      });
      // Drop the award we're analyzing from its own "other awards" list.
      incumbentOtherAwards = other.data.awards.filter(
        (a) => a.generatedInternalId !== args.generatedInternalId,
      );
    } catch {
      // Non-fatal, but MUST be disclosed: an empty list here means "the search
      // failed", NOT "the incumbent has no other awards". (D1)
      incumbentOtherAwards = [];
      otherAwardsFailed = true;
    }
  }

  // The award record carries no recipient_name → the incumbent identity is
  // UNKNOWN. Two masquerades to avoid: (1) `incumbent: ""` reads as "none"
  // rather than "unknown"; (2) with includeOtherAwards, the recipient search is
  // SKIPPED (the `detail.recipient` guard above is falsy) so `incumbentOtherAwards`
  // stays undefined → `?? []` emits an empty list that reads as "no other awards"
  // when the search never ran. Same class as the D1 otherAwardsFailed disclosure.
  const incumbentUnknown = !detail.recipient;

  const data = {
    award: {
      awardId: detail.awardId,
      incumbent: detail.recipient || null,
      awardingAgency: detail.awardingAgency ?? null,
      awardingSubAgency: detail.awardingSubAgency ?? null,
      naicsCode: detail.naicsCode ?? null,
      pscCode: detail.pscCode ?? null,
      contractAwardType: detail.contractAwardType,
      startDate: detail.periodOfPerformance.startDate,
      currentEndDate,
      potentialEndDate,
    },
    signals,
    pressureHints,
    ...(includeOtherAwards ? { incumbentOtherAwards: incumbentOtherAwards ?? [] } : {}),
  };

  // --- Truthful _meta ---------------------------------------------------
  // The offers value being null means single_offer could not be evaluated —
  // declare number_of_offers_received unavailable so the AI knows.
  const fieldsUnavailable = [...ANALYZE_FIELDS_UNAVAILABLE];
  if (numberOfOffers === null) {
    fieldsUnavailable.push("number_of_offers_received");
  }
  if (incumbentUnknown) {
    fieldsUnavailable.push("recipient_name");
  }
  // Null money fields are UNKNOWN, not $0 — disclose so an AI never cites a
  // fabricated zero (the values themselves are now null in obligatedVsCeiling).
  if (obligated === null) fieldsUnavailable.push("total_obligation");
  if (ceiling === null) fieldsUnavailable.push("base_and_all_options");

  // List ONLY the calls actually attempted — never assert a recipient search
  // that failed or was skipped (D1). enrichmentCalls stays in lockstep with
  // this list: detail + transactions are always attempted; the recipient call
  // is attempted iff includeOtherAwards && a recipient name exists.
  const callList = ["awards/{id} detail", "1 transactions page"];
  if (includeOtherAwards && detail.recipient) callList.push("1 recipient search");
  const transactionsFailed = mods.count === null;

  const notes: string[] = [
    "HONEST CEILING: PUBLIC signals only; no composite vulnerability score. Past-performance/CPARS ratings, protest history, and the incumbent's option-exercise intent are NOT public — judge the recompete with off-platform intelligence.",
    `Bounded keyless design: ${enrichmentCalls} upstream call(s) (${callList.join(" + ")}); no per-record fan-out.`,
  ];
  if (mods.atLeast) {
    notes.push(
      `modCount is a LOWER BOUND: this award has more than 100 transactions (the transactions endpoint reports no total, so only one 100-row page is read). modCountAtLeast is true.`,
    );
  }
  if (transactionsFailed) {
    notes.push(
      "modCount is null because the transactions call FAILED (not because the award has no modifications) — the modification count is unknown, not zero.",
    );
  }
  if (otherAwardsFailed) {
    notes.push(
      "incumbentOtherAwards could not be retrieved (the recipient search FAILED) and is shown as an EMPTY list — this is NOT a confirmation that the incumbent has no other awards.",
    );
  }
  if (incumbentUnknown) {
    notes.push(
      "The award record carries no recipient_name — the incumbent identity is UNKNOWN (returned as null), NOT 'none'. Incumbent-specific analysis (identity, other awards) cannot be performed on this record.",
    );
    if (includeOtherAwards) {
      notes.push(
        "incumbentOtherAwards is an EMPTY list because there is no recipient name to search by — the recipient search was SKIPPED, not run and found empty. This is NOT a confirmation that the incumbent has no other awards.",
      );
    }
  }
  if (pctConsumed === null) {
    notes.push(
      "obligatedVsCeiling.pctConsumed is null because the obligated amount or the award's ceiling (base_and_all_options) is absent (null), zero, or a negative data-entry value — consumption cannot be computed.",
    );
  }
  if (numberOfOffers === null) {
    notes.push(
      "number_of_offers_received is null on this award, so the 'single_offer' hint could not be evaluated (absence of the hint does NOT imply competition).",
    );
  }

  // A failed secondary enrichment means this is NOT the complete picture →
  // force complete:false so an AI never reads partial data as complete (D1/D2).
  // A blank recipient with includeOtherAwards is the same class: the emitted
  // empty incumbentOtherAwards would otherwise read as complete.
  const degraded =
    transactionsFailed ||
    otherAwardsFailed ||
    (includeOtherAwards && incumbentUnknown);

  return withMeta(data, {
    source: ANALYZE_INCUMBENT_SOURCE,
    keylessMode: true,
    complete: degraded ? false : undefined,
    returned: 1,
    totalAvailable: 1,
    truncated: false,
    filtersApplied: [],
    filtersDropped: [],
    fieldsUnavailable,
    enrichedCount: enrichmentCalls,
    notes,
  });
}

// ─── Recompete radar ──────────────────────────────────────────────

/**
 * Set-aside → USAspending `set_aside_type_codes` filter code. The
 * `spending_by_award` endpoint DOES honor `set_aside_type_codes` server-side
 * (LIVE-VERIFIED 2026-07-03: VA×541512 base 696 → SDVOSBC 182, SBA 19, WOSB 1
 * — genuine reductions; the wrong keys `type_set_aside`/`set_aside` are
 * silently IGNORED, returning the unfiltered 696). Set-aside is a FILTER only,
 * never a requestable output field (verified: it comes back absent). So we
 * filter by it but cannot read a per-row set-aside VALUE from search — that
 * lives in usas_get_award_detail.
 */
const SET_ASIDE_CODES = new Set([
  "SBA",
  "8A",
  "HZS",
  "SDVOSBC",
  "WOSB",
  "EDWOSB",
  "VSA",
  "VSS",
]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A `spending_by_award` row as returned when we request the recompete field
 * set. Every value is optional/nullable — USAspending echoes unknown fields
 * back as `null`, and PoP end dates are legitimately null on some rows.
 */
type RecompeteRow = {
  "Award ID"?: string | null;
  "Recipient Name"?: string | null;
  "Award Amount"?: number | null;
  "Awarding Agency"?: string | null;
  "Awarding Sub Agency"?: string | null;
  "Start Date"?: string | null;
  "End Date"?: string | null;
  NAICS?: { code?: string; description?: string } | null;
  PSC?: { code?: string; description?: string } | null;
  "Contract Award Type"?: string | null;
  "Last Modified Date"?: string | null;
  "Period of Performance Potential End Date"?: string | null;
  generated_internal_id?: string | null;
};

/**
 * Parse a PoP end date to "whole days from today" (UTC midnight). Returns
 * `null` for null/empty/unparseable/absurd values so the caller can COUNT the
 * row (never silently drop it) and treat it as out-of-window. Guards against
 * the far-future data-entry errors USAspending carries (e.g. year 2108).
 */
function daysUntil(dateStr: string | null | undefined, nowMs: number): number | null {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  // Sanity clamp: PoP end dates outside [1990, 2200] are data errors.
  if (year < 1990 || year > 2200) return null;
  return Math.ceil((t - nowMs) / MS_PER_DAY);
}

/** UTC "today minus N years" as YYYY-MM-DD, for the action_date lower bound. */
function isoYearsAgo(nowMs: number, years: number): string {
  const d = new Date(nowMs);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

const RECOMPETE_SOURCE =
  "usaspending.gov spending_by_award (keyless)";

const RECOMPETE_FIELDS_UNAVAILABLE = [
  "past_performance_cpars",
  "protest_history",
  "option_exercise_intent",
];

/**
 * Recompete radar — federal contracts whose current period of performance
 * ends inside a window around today, so you can see what's coming up for
 * recompete. Replaces the broken `searchExpiringContracts` internals.
 *
 * MECHANISM (LIVE-VERIFIED 2026-07-03 across VA×541512 and DoD×541330):
 * `spending_by_award` returns the current PoP end date directly under the
 * field ALIAS `"End Date"` (the canonical string
 * "Period of Performance Current End Date" is NOT a recognized field — it
 * comes back always null, and is not in the sort mappings → HTTP 400 if you
 * sort by it). Gold-standard confirmed: search `"End Date"` ===
 * `awards/{generated_internal_id}`.period_of_performance.end_date.
 *
 * We CANNOT filter by PoP end date server-side (`time_period.date_type` only
 * supports action_date/date_signed/last_modified_date/new_awards_only). So:
 *   1. server-side SORT by `"End Date"` DESC (the alias — the only PoP-end
 *      value in the sort mappings),
 *   2. an action_date `time_period` lower bound (LOAD-BEARING: prunes inactive
 *      records and much of the far-future data-entry garbage so DESC reaches
 *      the window sooner),
 *   3. a CLIENT-SIDE window filter with pagination + a safe early-stop (DESC ⇒
 *      once a row is earlier than the window start, every later row is earlier
 *      too), bounded by `scanBudgetPages`.
 *
 * TRUTHFULNESS: rows with a null `"End Date"` are COUNTED (`missingEndDate`),
 * never silently dropped. If the scan budget is exhausted before the early-stop
 * fires, `scanTruncated` is set and `totalAvailable` becomes null (the returned
 * set is a lower bound, not the complete window). This tool emits PUBLIC
 * signals only — it never fabricates a composite "vulnerability" score;
 * past-performance/CPARS, protest history, and option-exercise intent are not
 * public and are declared in `_meta.fieldsUnavailable`.
 */
export async function searchRecompetes(args: {
  agency?: string;
  naics?: string;
  pscCodes?: string[];
  setAside?: string;
  windowStartDays?: number;
  windowEndDays?: number;
  minAwardValue?: number;
  includePotentialEnd?: boolean;
  actionDateLookbackYears?: number;
  page?: number;
  pageSize?: number;
  scanBudgetPages?: number;
}) {
  const nowMs = Date.now();
  const windowStartDays = args.windowStartDays ?? -90;
  const windowEndDays = args.windowEndDays ?? 548; // ~18 months
  const minAwardValue = args.minAwardValue ?? 0;
  const includePotentialEnd = args.includePotentialEnd ?? false;
  const actionDateLookbackYears = args.actionDateLookbackYears ?? 3;
  const page = Math.max(1, Math.floor(args.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(args.pageSize ?? 25)));
  const scanBudgetPages = Math.min(20, Math.max(1, Math.floor(args.scanBudgetPages ?? 8)));

  // --- Build filters (only what we can send truthfully) -----------------
  const filters: UsasFilters = { award_type_codes: ["A", "B", "C", "D"] };
  const filtersApplied: string[] = ["awardType(contracts A/B/C/D)"];
  const filtersDropped: string[] = [];
  if (args.agency) {
    filters.agencies = [{ type: "awarding", tier: "toptier", name: args.agency }];
    filtersApplied.push("agency");
  }
  if (args.naics) {
    filters.naics_codes = [args.naics];
    filtersApplied.push("naics");
  }
  if (args.pscCodes?.length) {
    filters.psc_codes = args.pscCodes;
    filtersApplied.push("pscCodes");
  }
  // Set-aside: `set_aside_type_codes` is honored server-side (verified). Only
  // send a code we know the endpoint recognizes; otherwise record it dropped.
  if (args.setAside) {
    if (SET_ASIDE_CODES.has(args.setAside)) {
      filters.set_aside_type_codes = [args.setAside];
      filtersApplied.push("setAside");
    } else {
      filtersDropped.push("setAside");
    }
  }
  // action_date lower bound — the default date_type is action_date, so no
  // explicit date_type is needed (and passing one is optional).
  const lookbackStart = isoYearsAgo(nowMs, actionDateLookbackYears);
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);
  filters.time_period = [{ start_date: lookbackStart, end_date: todayIso }];
  filtersApplied.push(`actionDateLookback(${actionDateLookbackYears}y)`);

  const fields = [
    "Award ID",
    "Recipient Name",
    "Award Amount",
    "Awarding Agency",
    "Awarding Sub Agency",
    "Start Date",
    "End Date",
    "NAICS",
    "PSC",
    "Contract Award Type",
    "Last Modified Date",
    "generated_internal_id",
  ];
  if (includePotentialEnd) {
    fields.push("Period of Performance Potential End Date");
  }

  type SearchResp = {
    results?: RecompeteRow[];
    page_metadata?: { hasNext?: boolean; page?: number };
  };

  // --- Scan pages (DESC by End Date) with early-stop + budget ----------
  type Shaped = {
    awardId: string;
    generatedInternalId: string;
    incumbent: string;
    amount: number;
    currentEndDate: string;
    daysUntilCurrentEnd: number;
    potentialEndDate?: string | null;
    extendableDays?: number | null;
    awardingAgency: string;
    awardingSubAgency: string | null;
    naicsCode: string | null;
    pscCode: string | null;
    contractAwardType: string | null;
    setAsideDescription: string | null;
    startDate: string | null;
    description: string | null;
  };

  const results: Shaped[] = [];
  let scanned = 0;
  let missingEndDate = 0;
  let pastWindow = false;
  let scanTruncated = false;

  for (let p = 1; p <= scanBudgetPages; p++) {
    const resp = await postUsas<SearchResp>("search/spending_by_award", {
      filters,
      fields,
      sort: "End Date",
      order: "desc",
      limit: 100,
      page: p,
      subawards: false,
    });
    const rows = resp.results ?? [];
    for (const row of rows) {
      scanned++;
      const end = row["End Date"] ?? null;
      const d = daysUntil(end, nowMs);
      if (d === null) {
        // Null/unparseable/absurd end date — COUNT it, never silently drop.
        missingEndDate++;
        continue;
      }
      if (d > windowEndDays) continue; // far future (incl. data errors) → skip
      if (d < windowStartDays) {
        // DESC ⇒ everything after this row is earlier ⇒ safe to stop.
        pastWindow = true;
        break;
      }
      const amount = row["Award Amount"] ?? 0;
      if (amount < minAwardValue) continue;
      const potentialEnd = includePotentialEnd
        ? row["Period of Performance Potential End Date"] ?? null
        : undefined;
      let extendableDays: number | null | undefined;
      if (includePotentialEnd) {
        const pd = daysUntil(potentialEnd ?? null, nowMs);
        extendableDays = pd === null ? null : pd - d;
      }
      results.push({
        awardId: row["Award ID"] ?? "",
        generatedInternalId: row.generated_internal_id ?? "",
        incumbent: row["Recipient Name"] ?? "",
        amount,
        currentEndDate: end as string,
        daysUntilCurrentEnd: d,
        ...(includePotentialEnd
          ? { potentialEndDate: potentialEnd ?? null, extendableDays }
          : {}),
        awardingAgency: row["Awarding Agency"] ?? "",
        awardingSubAgency: row["Awarding Sub Agency"] ?? null,
        naicsCode: row.NAICS?.code ?? null,
        pscCode: row.PSC?.code ?? null,
        contractAwardType: row["Contract Award Type"] ?? null,
        // Set-aside VALUE is not a search output field (filter-only) → null
        // here; the caller reads it per-award via usas_get_award_detail.
        setAsideDescription: null,
        startDate: row["Start Date"] ?? null,
        description: null,
      });
    }
    if (pastWindow) break;
    if (!resp.page_metadata?.hasNext) break;
    if (p === scanBudgetPages && !pastWindow) scanTruncated = true;
  }

  // Deterministic order: current end date ascending (soonest recompete first),
  // tiebreak by descending amount then awardId so paging is stable.
  results.sort((a, b) => {
    if (a.daysUntilCurrentEnd !== b.daysUntilCurrentEnd)
      return a.daysUntilCurrentEnd - b.daysUntilCurrentEnd;
    if (b.amount !== a.amount) return b.amount - a.amount;
    return a.awardId.localeCompare(b.awardId);
  });

  const totalInWindow = results.length; // EXACT iff not scanTruncated
  const startIdx = (page - 1) * pageSize;
  const pageSlice = results.slice(startIdx, startIdx + pageSize);

  // --- Truthful _meta ---------------------------------------------------
  // totalAvailable is a REAL count only when we scanned the whole window
  // (early-stop fired). If the scan budget truncated, it is unknown → null,
  // and the returned set is a lower bound.
  const totalAvailable = scanTruncated ? null : totalInWindow;
  const nextOffset = startIdx + pageSize;
  const hasMore = scanTruncated
    ? true // more may exist beyond the scanned pages
    : nextOffset < totalInWindow;
  const truncated = hasMore || scanTruncated;

  const notes: string[] = [
    `Completeness boundary: only contracts with a recorded action in the last ${actionDateLookbackYears} year(s) are included (an action_date lower bound is required to make the End-Date sort reach the window; contracts with no action in that span are not returned).`,
    "Recompete window is applied client-side on the current period-of-performance END date; the API cannot filter by PoP end date server-side, so results are sorted by End Date (desc) and windowed here.",
    "HONEST CEILING: this tool emits PUBLIC signals only. Past-performance/CPARS ratings, protest history, and the incumbent's option-exercise intent are NOT public — it never emits a composite 'recompete vulnerability' score. Judge each row with off-platform intelligence.",
  ];
  if (missingEndDate > 0) {
    notes.push(
      `${missingEndDate} scanned award(s) had no usable current PoP end date and were counted but excluded from the window (never silently dropped).`,
    );
  }
  if (scanTruncated) {
    notes.push(
      `Scan budget of ${scanBudgetPages} page(s) (${scanned} awards) was exhausted before reaching the end of the window, so totalAvailable is unknown (null) and the returned recompetes are a LOWER BOUND. This agency×NAICS slice has a very large tail of long-duration/far-future contracts — narrow it (add pscCodes, a higher minAwardValue, a set-aside, or a tighter agency/sub-agency) or raise scanBudgetPages to get an exact window count.`,
    );
  }
  if (filtersDropped.includes("setAside")) {
    notes.push(
      `The requested set-aside code is not a recognized USAspending set_aside_type_code and was NOT applied (results are unfiltered on set-aside). Valid codes: ${[...SET_ASIDE_CODES].join(", ")}.`,
    );
  }

  const data = {
    recompetes: pageSlice,
    page,
    pageSize,
  };

  return withMeta(data, {
    source: RECOMPETE_SOURCE,
    keylessMode: true,
    returned: pageSlice.length,
    totalAvailable,
    truncated,
    pagination: {
      offset: startIdx,
      limit: pageSize,
      nextOffset: hasMore ? nextOffset : null,
      hasMore,
    },
    filtersApplied,
    filtersDropped,
    fieldsUnavailable: [
      ...RECOMPETE_FIELDS_UNAVAILABLE,
      "setAsideDescription(search-omits; use usas_get_award_detail)",
    ],
    notes,
  });
}

/**
 * DEPRECATED alias — kept working so existing callers of
 * `usas_search_expiring_contracts` don't break. Maps the old params onto
 * `searchRecompetes` and re-shapes the output to the legacy `{ contracts,
 * searchedCount }` keys the smoke/edge tests assert on. Prefer
 * `usas_search_recompetes`.
 */
export async function searchExpiringContracts(args: {
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  monthsUntilExpiry?: number;
  minAwardValue?: number;
  limit?: number;
}) {
  const windowEndDays = Math.round((args.monthsUntilExpiry ?? 12) * 30.44);
  const pageSize = args.limit ?? 10;
  const bundle = await searchRecompetes({
    agency: args.agency,
    naics: args.naics,
    windowStartDays: -30, // legacy tool dropped rows expired > 30d ago
    windowEndDays,
    minAwardValue: args.minAwardValue ?? 100_000,
    pageSize,
    page: 1,
  });

  // Re-shape to the legacy contract row + keep the truthful _meta, appending a
  // deprecation note.
  type Recompete = (typeof bundle.data.recompetes)[number];
  const contracts = bundle.data.recompetes.map((r: Recompete) => ({
    awardId: r.awardId,
    recipient: r.incumbent,
    amount: r.amount,
    endDate: r.currentEndDate,
    potentialEndDate: r.potentialEndDate ?? null,
    awardingAgency: r.awardingAgency,
    awardingSubAgency: r.awardingSubAgency ?? undefined,
    naicsCode: r.naicsCode ?? undefined,
    setAsideDescription: r.setAsideDescription ?? undefined,
    description: r.description ?? undefined,
    daysUntilExpiry: r.daysUntilCurrentEnd,
    generatedInternalId: r.generatedInternalId,
  }));

  const data = {
    contracts,
    // Legacy field: previously the count of value-filtered candidates. Now the
    // number of in-window recompetes returned on this page (honest, non-zero
    // where data exists).
    searchedCount: contracts.length,
  };

  const meta: Partial<ResponseMeta> = {
    ...bundle.meta,
    notes: [
      "deprecated: use usas_search_recompetes — this alias re-shapes the corrected recompete-radar output onto the legacy { contracts, searchedCount } keys.",
      ...(bundle.meta.notes ?? []),
    ],
  };
  return withMeta(data, meta);
}

// ─── Aggregate analysis: time series ──────────────────────────────

export async function spendingOverTime(args: {
  group?: "fiscal_year" | "quarter" | "month";
  agency?: string;
  naics?: string;
  setAside?: string;
}) {
  const filters = buildFilters(args);
  type Resp = {
    group?: string;
    results?: {
      time_period?: { fiscal_year?: string; quarter?: string; month?: string };
      aggregated_amount?: number;
      Contract_Obligations?: number;
      Grant_Obligations?: number;
      Idv_Obligations?: number;
    }[];
  };
  const json = await postUsas<Resp>("search/spending_over_time/", {
    group: args.group ?? "fiscal_year",
    filters,
  });
  return {
    group: json.group,
    timeline: (json.results ?? []).map((r) => ({
      timePeriod: r.time_period ?? {},
      total: r.aggregated_amount ?? 0,
      contractObligations: r.Contract_Obligations ?? 0,
      grantObligations: r.Grant_Obligations ?? 0,
      idvObligations: r.Idv_Obligations ?? 0,
    })),
  };
}

// ─── Aggregate analysis: PSC spending ─────────────────────────────

export async function searchPscSpending(args: {
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  limit?: number;
}) {
  const filters = buildFilters(args);
  type Resp = {
    results?: { code?: string; name?: string; amount?: number }[];
    page_metadata?: CategoryPageMeta;
  };
  const limit = args.limit ?? 10;
  const json = await postUsas<Resp>(
    "search/spending_by_category/psc",
    { filters, limit, page: 1 },
  );
  const results = json.results ?? [];
  const data = {
    psc: results.map((r) => ({
      pscCode: r.code ?? "",
      pscName: r.name ?? "",
      amount: r.amount ?? 0,
    })),
  };
  return withMeta(
    data,
    categoryAggregateMeta({
      source: "usaspending.gov/api/v2 search/spending_by_category/psc",
      returned: results.length,
      limit,
      hasNext: json.page_metadata?.hasNext,
    }),
  );
}

// ─── Aggregate analysis: state / territory ─────────────────────────

export async function searchStateSpending(args: {
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  limit?: number;
}) {
  const filters = buildFilters(args);
  type Resp = {
    results?: { code?: string; name?: string; amount?: number }[];
    page_metadata?: CategoryPageMeta;
  };
  const limit = args.limit ?? 10;
  const json = await postUsas<Resp>(
    "search/spending_by_category/state_territory",
    { filters, limit, page: 1 },
  );
  const results = json.results ?? [];
  const data = {
    states: results.map((r) => ({
      stateCode: r.code ?? "",
      stateName: r.name ?? "",
      amount: r.amount ?? 0,
    })),
  };
  return withMeta(
    data,
    categoryAggregateMeta({
      source:
        "usaspending.gov/api/v2 search/spending_by_category/state_territory",
      returned: results.length,
      limit,
      hasNext: json.page_metadata?.hasNext,
      extraNotes: [
        "There are ~59 U.S. states/territories total; a capped result is a top-N by amount, not all places that received funding.",
      ],
    }),
  );
}

// ─── Aggregate analysis: CFDA (grants) ─────────────────────────────

export async function searchCfdaSpending(args: {
  agency?: string;
  fiscalYear?: number;
  limit?: number;
}) {
  // CFDA is grants — different award_type_codes
  const filters: UsasFilters = {
    award_type_codes: ["02", "03", "04", "05"], // grants
  };
  if (args.agency) {
    filters.agencies = [
      { type: "awarding", tier: "toptier", name: args.agency },
    ];
  }
  if (args.fiscalYear) {
    filters.time_period = [
      {
        start_date: `${args.fiscalYear - 1}-10-01`,
        end_date: `${args.fiscalYear}-09-30`,
      },
    ];
  }
  type Resp = {
    results?: { code?: string; name?: string; amount?: number }[];
    page_metadata?: CategoryPageMeta;
  };
  const limit = args.limit ?? 10;
  const json = await postUsas<Resp>(
    "search/spending_by_category/cfda",
    { filters, limit, page: 1 },
  );
  const results = json.results ?? [];
  const data = {
    programs: results.map((r) => ({
      cfdaCode: r.code ?? "",
      programName: r.name ?? "",
      amount: r.amount ?? 0,
    })),
  };
  return withMeta(
    data,
    categoryAggregateMeta({
      source: "usaspending.gov/api/v2 search/spending_by_category/cfda",
      returned: results.length,
      limit,
      hasNext: json.page_metadata?.hasNext,
      extraNotes: [
        "This is a grants view (award types 02/03/04/05); contracts are excluded.",
      ],
    }),
  );
}

// ─── Aggregate analysis: federal account (TAS) ─────────────────────

export async function searchFederalAccountSpending(args: {
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  limit?: number;
}) {
  const filters = buildFilters(args);
  type Resp = {
    results?: { code?: string; name?: string; amount?: number }[];
    page_metadata?: CategoryPageMeta;
  };
  const limit = args.limit ?? 10;
  const json = await postUsas<Resp>(
    "search/spending_by_category/federal_account",
    { filters, limit, page: 1 },
  );
  const results = json.results ?? [];
  const data = {
    accounts: results.map((r) => ({
      tasCode: r.code ?? "",
      accountName: r.name ?? "",
      amount: r.amount ?? 0,
    })),
  };
  return withMeta(
    data,
    categoryAggregateMeta({
      source:
        "usaspending.gov/api/v2 search/spending_by_category/federal_account",
      returned: results.length,
      limit,
      hasNext: json.page_metadata?.hasNext,
    }),
  );
}

// ─── Aggregate analysis: awarding agency ──────────────────────────

export async function searchAgencySpending(args: {
  naics?: string;
  fiscalYear?: number;
  setAside?: string;
  limit?: number;
}) {
  const filters = buildFilters(args);
  type Resp = {
    results?: {
      name?: string;
      code?: string;
      amount?: number;
      agency_slug?: string;
    }[];
    page_metadata?: CategoryPageMeta;
  };
  const limit = args.limit ?? 10;
  const json = await postUsas<Resp>(
    "search/spending_by_category/awarding_agency",
    { filters, limit, page: 1 },
  );
  const results = json.results ?? [];
  const data = {
    agencies: results.map((r) => ({
      name: r.name ?? "",
      code: r.code ?? "",
      slug: r.agency_slug ?? "",
      amount: r.amount ?? 0,
    })),
  };
  return withMeta(
    data,
    categoryAggregateMeta({
      source:
        "usaspending.gov/api/v2 search/spending_by_category/awarding_agency",
      returned: results.length,
      limit,
      hasNext: json.page_metadata?.hasNext,
    }),
  );
}

// ─── Sub-agency breakdown ─────────────────────────────────────────

export async function searchSubAgencySpending(args: {
  agency: string;
  fiscalYear?: number;
}) {
  const filters = buildFilters(args);
  type Resp = {
    results?: { name?: string; amount?: number; count?: number }[];
    page_metadata?: CategoryPageMeta;
  };
  const limit = 10;
  const json = await postUsas<Resp>(
    "search/spending_by_category/awarding_subagency",
    { filters, limit, page: 1 },
  );
  const results = json.results ?? [];
  // The awarding_subagency endpoint returns `amount` but NOT a per-subagency
  // award `count` (verified 2026-07-03). Emitting `awards: 0` would be a
  // FABRICATED count (0 reads as "zero contracts", not "unknown") — the exact B1
  // class. So `awards` is `null` (honest "unavailable"), consistent with
  // searchAwards' B1 fix, AND flagged in `_meta.fieldsUnavailable` + a note. An
  // AI that ignores `_meta` still sees null, never a fake 0.
  const data = {
    subAgencies: results.map((r) => ({
      name: r.name ?? "",
      amount: r.amount ?? 0,
      awards: null as number | null,
    })),
  };
  return withMeta(
    data,
    categoryAggregateMeta({
      source:
        "usaspending.gov/api/v2 search/spending_by_category/awarding_subagency",
      returned: results.length,
      limit,
      hasNext: json.page_metadata?.hasNext,
      fieldsUnavailable: ["awards"],
      extraNotes: [
        "Per-subagency award COUNTS are not returned by this endpoint — the `awards` field is null for every row (unavailable, NOT a real count and NOT 0). Use amount for ranking; do not report `awards` as a contract count.",
      ],
    }),
  );
}

// ─── Agency profile ───────────────────────────────────────────────

export async function getAgencyProfile(toptierCode: string) {
  type Resp = {
    fiscal_year?: number;
    toptier_code?: string;
    name?: string;
    abbreviation?: string;
    mission?: string;
    website?: string;
    subtier_agency_count?: number;
    congressional_justification_url?: string;
  };
  const json = await getUsas<Resp>(`agency/${toptierCode}/`);
  return {
    fiscalYear: json.fiscal_year,
    toptierCode: json.toptier_code,
    name: json.name,
    abbreviation: json.abbreviation,
    mission: json.mission,
    website: json.website,
    subtierAgencyCount: json.subtier_agency_count,
    congressionalJustificationUrl: json.congressional_justification_url,
  };
}

export async function getAgencyAwardsSummary(args: {
  toptierCode: string;
  fiscalYear?: number;
}) {
  const fy = args.fiscalYear ?? new Date().getUTCFullYear();
  type Resp = {
    fiscal_year?: number;
    toptier_code?: string;
    transaction_count?: number;
    obligations?: number;
    latest_action_date?: string;
  };
  const json = await getUsas<Resp>(
    `agency/${args.toptierCode}/awards/?fiscal_year=${fy}`,
  );
  return {
    fiscalYear: json.fiscal_year,
    toptierCode: json.toptier_code,
    transactionCount: json.transaction_count ?? 0,
    obligations: json.obligations ?? 0,
    latestActionDate: json.latest_action_date,
  };
}

export async function getAgencyBudgetFunction(args: {
  toptierCode: string;
  fiscalYear?: number;
  limit?: number;
}) {
  const fy = args.fiscalYear ?? new Date().getUTCFullYear();
  const limit = args.limit ?? 10;
  type Resp = {
    toptier_code?: string;
    fiscal_year?: number;
    results?: {
      name?: string;
      children?: {
        name?: string;
        obligated_amount?: number;
        gross_outlay_amount?: number;
      }[];
    }[];
    // Unlike the spending_by_category/* endpoints, agency/budget_function
    // DOES report a real grand total in page_metadata.total (verified
    // 2026-07-03: e.g. DoD → total:6 while a 3-row page has hasNext:true).
    page_metadata?: { page?: number; total?: number; hasNext?: boolean };
  };
  const json = await getUsas<Resp>(
    `agency/${args.toptierCode}/budget_function/?fiscal_year=${fy}&limit=${limit}`,
  );
  const results = json.results ?? [];
  const total = json.page_metadata?.total ?? null;
  const data = {
    toptierCode: json.toptier_code,
    fiscalYear: json.fiscal_year,
    functions: results.map((r) => ({
      name: r.name ?? "",
      programs: (r.children ?? []).map((c) => ({
        name: c.name ?? "",
        obligated: c.obligated_amount ?? 0,
        outlays: c.gross_outlay_amount ?? 0,
      })),
    })),
  };
  const hasMore =
    total !== null ? results.length < total : (json.page_metadata?.hasNext ?? false);
  return withMeta(data, {
    source: "usaspending.gov/api/v2 agency/{code}/budget_function",
    keylessMode: true,
    returned: results.length,
    // Real total from the endpoint (budget-function count for the FY).
    totalAvailable: total,
    truncated: hasMore,
    pagination: {
      offset: 0,
      limit,
      nextOffset: hasMore ? results.length : null,
      hasMore,
    },
    filtersApplied: [],
    filtersDropped: [],
    fieldsUnavailable: [],
    notes: hasMore
      ? [
          `Showing the top ${limit} budget functions; ${total ?? "more"} exist for FY${fy}. Raise limit to see the rest.`,
        ]
      : [],
  });
}

// ─── Recipient list + profile ─────────────────────────────────────

export async function searchRecipients(args: {
  keyword: string;
  recipientLevel?: "P" | "C" | "R";
  limit?: number;
}) {
  type Resp = {
    page_metadata?: { total?: number };
    results?: {
      id?: string;
      duns?: string;
      uei?: string;
      name?: string;
      recipient_level?: string;
      amount?: number;
    }[];
  };
  const limit = args.limit ?? 10;
  const body: Record<string, unknown> = {
    keyword: args.keyword,
    limit,
    page: 1,
  };
  if (args.recipientLevel) {
    body.recipient_level = args.recipientLevel;
  }
  const json = await postUsas<Resp>("recipient/", body);
  const results = json.results ?? [];
  // recipient/ DOES report a real grand total in page_metadata.total
  // (verified 2026-07-03: "booz" → total:512). Keep it in _meta.totalAvailable
  // and derive truncation from returned < total. null (not 0) when absent so
  // we never claim a total the endpoint didn't give.
  const total = json.page_metadata?.total ?? null;
  const data = {
    totalRecords: json.page_metadata?.total ?? 0,
    recipients: results.map((r) => ({
      id: r.id ?? "",
      duns: r.duns,
      uei: r.uei,
      name: r.name ?? "",
      level: r.recipient_level,
      totalAmount: r.amount ?? 0,
    })),
  };
  const hasMore = total !== null ? results.length < total : results.length >= limit;
  return withMeta(data, {
    source: "usaspending.gov/api/v2 recipient/",
    keylessMode: true,
    returned: results.length,
    totalAvailable: total,
    truncated: hasMore,
    pagination: {
      offset: 0,
      limit,
      nextOffset: hasMore ? results.length : null,
      hasMore,
    },
    filtersApplied: [],
    filtersDropped: [],
    fieldsUnavailable: [],
    notes: hasMore
      ? [
          `Showing the top ${limit} recipients by amount; ${total ?? "more"} match the keyword. Raise limit or page to see more.`,
        ]
      : [],
  });
}

export async function getRecipientProfile(recipientId: string) {
  type Resp = {
    name?: string;
    alternate_names?: string[];
    duns?: string;
    uei?: string;
    recipient_id?: string;
    recipient_level?: string;
    parent_id?: string;
    parent_name?: string;
    business_types?: string[];
    location?: {
      address_line1?: string;
      city_name?: string;
      state_code?: string;
      country_name?: string;
      zip5?: string;
    };
    total_transaction_amount?: number;
    total_transactions?: number;
  };
  const json = await getUsas<Resp>(
    `recipient/${encodeURIComponent(recipientId)}/`,
  );
  return {
    name: json.name ?? "",
    alternateNames: json.alternate_names ?? [],
    duns: json.duns,
    uei: json.uei,
    recipientId: json.recipient_id,
    level: json.recipient_level,
    parentId: json.parent_id,
    parentName: json.parent_name,
    businessTypes: json.business_types ?? [],
    location: json.location ?? {},
    totalAmount: json.total_transaction_amount ?? 0,
    totalTransactions: json.total_transactions ?? 0,
  };
}

// ─── Reference / autocomplete ─────────────────────────────────────

export async function lookupAgency(searchText: string) {
  // Cache: agency lookups are extremely repeat-prone (`VA`, `DHS`, etc.)
  // and effectively static across a session.
  return memoize(`usas:agency:${searchText.toLowerCase()}`, async () => {
    type Resp = {
      results?: {
        toptier_flag?: boolean;
        toptier_agency?: {
          name?: string;
          abbreviation?: string;
          toptier_code?: string;
        };
      }[];
    };
    // Via postUsas (fetchWithRetry) so a DOWN service THROWS upstream_unavailable
    // instead of returning `{ matches: [] }` — which an AI reads as "no such
    // agency" when the endpoint is merely down. This was the last silent-empty-
    // on-outage in the codebase; now consistent with autocompleteNaics/Recipient
    // (a GENUINE no-match still returns an honest empty `matches`).
    const json = await postUsas<Resp>("autocomplete/funding_agency/", {
      search_text: searchText,
      limit: 5,
    });
    return {
      matches: (json.results ?? []).map((r) => ({
        name: r.toptier_agency?.name ?? "",
        abbreviation: r.toptier_agency?.abbreviation,
        toptierCode: r.toptier_agency?.toptier_code,
        isToptier: !!r.toptier_flag,
      })),
    };
  });
}

export async function autocompleteNaics(args: {
  searchText: string;
  limit?: number;
}) {
  const limit = args.limit ?? 10;
  return memoize(
    `usas:naics:${args.searchText.toLowerCase()}:${limit}`,
    async () => {
      type Resp = {
        results?: {
          naics?: string;
          naics_description?: string;
          year_retired?: string | null;
        }[];
      };
      const json = await postUsas<Resp>("autocomplete/naics/", {
        search_text: args.searchText,
        limit,
      });
      const results = json.results ?? [];
      const data = {
        naics: results.map((r) => ({
          code: r.naics ?? "",
          description: r.naics_description ?? "",
          retired: !!r.year_retired,
        })),
      };
      return withMeta(data, referenceMeta({
        source: "usaspending.gov/api/v2 autocomplete/naics",
        returned: results.length,
        limit,
        // autocomplete/naics returns only {results} — no total (verified
        // 2026-07-03). A full page means more matches likely exist.
        totalAvailable: null,
      }));
    },
  );
}

export async function autocompleteRecipient(args: {
  searchText: string;
  limit?: number;
}) {
  const limit = args.limit ?? 10;
  return memoize(
    `usas:recipient:${args.searchText.toLowerCase()}:${limit}`,
    async () => {
      type Resp = {
        // NOTE: this endpoint's top-level `count` equals the RETURNED row
        // count (verified 2026-07-03: 5 asked → count:5), NOT a grand total —
        // so it is NOT a usable totalAvailable (spec §3.3: never substitute
        // page size for an unknown total). Left as null.
        count?: number;
        results?: {
          recipient_name?: string;
          uei?: string;
          duns?: string;
        }[];
      };
      const json = await postUsas<Resp>("autocomplete/recipient/", {
        search_text: args.searchText,
        limit,
      });
      const results = json.results ?? [];
      const data = {
        recipients: results.map((r) => ({
          name: r.recipient_name ?? "",
          uei: r.uei,
          duns: r.duns,
        })),
      };
      return withMeta(data, referenceMeta({
        source: "usaspending.gov/api/v2 autocomplete/recipient",
        returned: results.length,
        limit,
        totalAvailable: null,
      }));
    },
  );
}

export async function naicsHierarchy(args: { naicsFilter?: string }) {
  return memoize(`usas:naics-hierarchy:${args.naicsFilter ?? ""}`, async () => {
    type Resp = {
      results?: {
        naics?: string;
        naics_description?: string;
        count?: number;
        children?: unknown[];
      }[];
    };
    const path = args.naicsFilter
      ? `references/naics/?filter=${encodeURIComponent(args.naicsFilter)}`
      : "references/naics/";
    const json = await getUsas<Resp>(path);
    const results = json.results ?? [];
    const data = {
      hierarchy: results.map((r) => ({
        code: r.naics ?? "",
        description: r.naics_description ?? "",
        count: r.count ?? 0,
        hasChildren: !!(r.children && r.children.length > 0),
      })),
    };
    // references/naics has NO limit param and NO total (verified 2026-07-03:
    // returns the full level — 24 sectors unfiltered, or the filter's matches).
    // So this response IS complete for the requested level; nodes with
    // hasChildren can be expanded by passing that code as naicsFilter.
    return withMeta(data, referenceMeta({
      source: "usaspending.gov/api/v2 references/naics",
      returned: results.length,
      limit: results.length, // no limit param → returned count is the whole set
      totalAvailable: results.length,
      limitHonored: false,
      extraNotes: [
        "This is the NAICS hierarchy level for the requested filter (complete); drill into a node by calling again with its code as naicsFilter.",
      ],
    }));
  });
}

export async function glossary(args: { limit?: number; search?: string }) {
  const limit = args.limit ?? 25;
  return memoize(`usas:glossary:${args.search ?? ""}:${limit}`, async () => {
    type Resp = {
      // references/glossary DOES report a real grand total in
      // page_metadata.count (verified 2026-07-03: 151, stable across limits).
      page_metadata?: { count?: number };
      results?: { term?: string; slug?: string; plain?: string }[];
    };
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (args.search) params.set("search", args.search);
    const json = await getUsas<Resp>(`references/glossary/?${params.toString()}`);
    const results = json.results ?? [];
    const total = json.page_metadata?.count ?? null;
    const data = {
      totalRecords: json.page_metadata?.count ?? 0,
      terms: results.map((r) => ({
        term: r.term ?? "",
        slug: r.slug ?? "",
        definition: r.plain ?? "",
      })),
    };
    return withMeta(data, referenceMeta({
      source: "usaspending.gov/api/v2 references/glossary",
      returned: results.length,
      limit,
      totalAvailable: total,
    }));
  });
}

export async function listToptierAgencies(args: { limit?: number }) {
  const limit = args.limit ?? 50;
  return memoize(`usas:toptier:${limit}`, async () => {
    type Resp = {
      results?: {
        agency_name?: string;
        abbreviation?: string;
        toptier_code?: string;
        agency_slug?: string;
        active_fy?: string;
        obligated_amount?: number;
      }[];
    };
    const json = await getUsas<Resp>(
      `references/toptier_agencies/?limit=${limit}`,
    );
    const results = json.results ?? [];
    const data = {
      agencies: results.map((r) => ({
        name: r.agency_name ?? "",
        abbreviation: r.abbreviation,
        toptierCode: r.toptier_code,
        slug: r.agency_slug,
        activeFiscalYear: r.active_fy,
        obligatedAmount: r.obligated_amount ?? 0,
      })),
    };
    // IMPORTANT: this endpoint IGNORES the `limit` param (verified 2026-07-03:
    // limit=3 AND limit=1000 both return all 111 toptier agencies). So the
    // response is ALWAYS the complete set — truncated:false, and the returned
    // count IS the total. Deriving truncation from `returned >= limit` would be
    // a false positive, so limitHonored:false forces complete.
    return withMeta(data, referenceMeta({
      source: "usaspending.gov/api/v2 references/toptier_agencies",
      returned: results.length,
      limit,
      totalAvailable: results.length,
      limitHonored: false,
      extraNotes: [
        "The toptier_agencies endpoint returns the COMPLETE list of ~111 toptier agencies regardless of the `limit` value (limit is ignored upstream).",
      ],
    }));
  });
}
