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

import { fetchWithRetry } from "./errors.js";
import { memoize } from "./cache.js";
import { withMeta, type MetaBundle } from "./meta.js";

const SPENDING_BY_AWARD_SOURCE =
  "usaspending.gov/api/v2 search/spending_by_award";
const SPENDING_BY_CATEGORY_RECIPIENT_SOURCE =
  "usaspending.gov/api/v2 search/spending_by_category/recipient";

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
      recipient: r["Recipient Name"] ?? "",
      amount: r["Award Amount"] ?? 0,
      awardingAgency: r["Awarding Agency"] ?? "",
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
      recipient: r["Recipient Name"] ?? "",
      amount: r["Award Amount"] ?? 0,
      awardingAgency: r["Awarding Agency"] ?? "",
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

export async function getAwardDetail(generatedInternalId: string) {
  try {
    const r = await fetch(
      `${USAS}/awards/${encodeURIComponent(generatedInternalId)}/`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!r.ok) return null;
    type Resp = {
      piid?: string;
      description?: string;
      total_obligation?: number;
      base_and_all_options?: number;
      period_of_performance?: {
        start_date?: string;
        end_date?: string;
        potential_end_date?: string;
      };
      latest_transaction_contract_data?: {
        type_set_aside?: string;
        type_set_aside_description?: string;
        extent_competed?: string;
        number_of_offers_received?: string;
        naics?: string;
        naics_description?: string;
      };
      awarding_agency?: {
        toptier_agency?: { name?: string };
        subtier_agency?: { name?: string };
      };
      recipient?: { recipient_name?: string };
    };
    const json = (await r.json()) as Resp;
    const ltc = json.latest_transaction_contract_data ?? {};
    return {
      awardId: json.piid ?? "",
      recipient: json.recipient?.recipient_name ?? "",
      totalObligation: json.total_obligation ?? 0,
      baseAndAllOptions: json.base_and_all_options ?? 0,
      periodOfPerformance: {
        startDate: json.period_of_performance?.start_date ?? null,
        endDate: json.period_of_performance?.end_date ?? null,
        potentialEndDate: json.period_of_performance?.potential_end_date ?? null,
      },
      description: json.description ?? "",
      setAsideType: ltc.type_set_aside,
      setAsideDescription: ltc.type_set_aside_description,
      competitionExtent: ltc.extent_competed,
      numberOfOffers: ltc.number_of_offers_received,
      awardingAgency: json.awarding_agency?.toptier_agency?.name,
      awardingSubAgency: json.awarding_agency?.subtier_agency?.name,
      naicsCode: ltc.naics,
      naicsDescription: ltc.naics_description,
    };
  } catch {
    return null;
  }
}

// ─── Recompete radar ──────────────────────────────────────────────

export async function searchExpiringContracts(args: {
  agency?: string;
  naics?: string;
  fiscalYear?: number;
  monthsUntilExpiry?: number;
  minAwardValue?: number;
  limit?: number;
}) {
  const filters = buildFilters(args);
  type SearchResp = {
    results?: {
      "Award ID"?: string;
      "Recipient Name"?: string;
      "Award Amount"?: number;
      generated_internal_id?: string;
    }[];
  };
  const search = await postUsas<SearchResp>("search/spending_by_award", {
    filters,
    fields: ["Award ID", "Recipient Name", "Award Amount"],
    limit: 50,
    page: 1,
    subawards: false,
    sort: "Award Amount",
    order: "desc",
  });

  const candidates = (search.results ?? []).filter(
    (r) =>
      (r["Award Amount"] ?? 0) >= (args.minAwardValue ?? 100_000) &&
      r.generated_internal_id,
  );

  // Enrich up to 8 in parallel — be polite to USAspending.
  const enrich = candidates.slice(0, 8);
  const details = await Promise.all(
    enrich.map((r) => getAwardDetail(r.generated_internal_id!)),
  );

  const now = Date.now();
  const cutoffDays = (args.monthsUntilExpiry ?? 12) * 30;
  const contracts = details
    .map((d, idx) => {
      if (!d || !d.periodOfPerformance.endDate) return null;
      const end = new Date(d.periodOfPerformance.endDate).getTime();
      if (Number.isNaN(end)) return null;
      const days = Math.ceil((end - now) / (24 * 60 * 60 * 1000));
      if (days < -30 || days > cutoffDays) return null;
      const orig = enrich[idx] ?? {};
      return {
        awardId: d.awardId || orig["Award ID"] || "",
        recipient: d.recipient || orig["Recipient Name"] || "",
        amount: d.totalObligation || orig["Award Amount"] || 0,
        endDate: d.periodOfPerformance.endDate,
        potentialEndDate: d.periodOfPerformance.potentialEndDate,
        awardingAgency: d.awardingAgency ?? "",
        awardingSubAgency: d.awardingSubAgency,
        naicsCode: d.naicsCode,
        setAsideDescription: d.setAsideDescription,
        description: d.description,
        daysUntilExpiry: days,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, args.limit ?? 10)
    .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);

  return { contracts, searchedCount: candidates.length };
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
  };
  const json = await postUsas<Resp>(
    "search/spending_by_category/psc",
    { filters, limit: args.limit ?? 10, page: 1 },
  );
  return {
    psc: (json.results ?? []).map((r) => ({
      pscCode: r.code ?? "",
      pscName: r.name ?? "",
      amount: r.amount ?? 0,
    })),
  };
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
  };
  const json = await postUsas<Resp>(
    "search/spending_by_category/state_territory",
    { filters, limit: args.limit ?? 10, page: 1 },
  );
  return {
    states: (json.results ?? []).map((r) => ({
      stateCode: r.code ?? "",
      stateName: r.name ?? "",
      amount: r.amount ?? 0,
    })),
  };
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
  };
  const json = await postUsas<Resp>(
    "search/spending_by_category/cfda",
    { filters, limit: args.limit ?? 10, page: 1 },
  );
  return {
    programs: (json.results ?? []).map((r) => ({
      cfdaCode: r.code ?? "",
      programName: r.name ?? "",
      amount: r.amount ?? 0,
    })),
  };
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
  };
  const json = await postUsas<Resp>(
    "search/spending_by_category/federal_account",
    { filters, limit: args.limit ?? 10, page: 1 },
  );
  return {
    accounts: (json.results ?? []).map((r) => ({
      tasCode: r.code ?? "",
      accountName: r.name ?? "",
      amount: r.amount ?? 0,
    })),
  };
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
  };
  const json = await postUsas<Resp>(
    "search/spending_by_category/awarding_agency",
    { filters, limit: args.limit ?? 10, page: 1 },
  );
  return {
    agencies: (json.results ?? []).map((r) => ({
      name: r.name ?? "",
      code: r.code ?? "",
      slug: r.agency_slug ?? "",
      amount: r.amount ?? 0,
    })),
  };
}

// ─── Sub-agency breakdown ─────────────────────────────────────────

export async function searchSubAgencySpending(args: {
  agency: string;
  fiscalYear?: number;
}) {
  const filters = buildFilters(args);
  type Resp = {
    results?: { name?: string; amount?: number; count?: number }[];
  };
  const json = await postUsas<Resp>(
    "search/spending_by_category/awarding_subagency",
    { filters, limit: 10, page: 1 },
  );
  return {
    subAgencies: (json.results ?? []).map((r) => ({
      name: r.name ?? "",
      amount: r.amount ?? 0,
      awards: r.count ?? 0,
    })),
  };
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
  };
  const json = await getUsas<Resp>(
    `agency/${args.toptierCode}/budget_function/?fiscal_year=${fy}&limit=${args.limit ?? 10}`,
  );
  return {
    toptierCode: json.toptier_code,
    fiscalYear: json.fiscal_year,
    functions: (json.results ?? []).map((r) => ({
      name: r.name ?? "",
      programs: (r.children ?? []).map((c) => ({
        name: c.name ?? "",
        obligated: c.obligated_amount ?? 0,
        outlays: c.gross_outlay_amount ?? 0,
      })),
    })),
  };
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
  const body: Record<string, unknown> = {
    keyword: args.keyword,
    limit: args.limit ?? 10,
    page: 1,
  };
  if (args.recipientLevel) {
    body.recipient_level = args.recipientLevel;
  }
  const json = await postUsas<Resp>("recipient/", body);
  return {
    totalRecords: json.page_metadata?.total ?? 0,
    recipients: (json.results ?? []).map((r) => ({
      id: r.id ?? "",
      duns: r.duns,
      uei: r.uei,
      name: r.name ?? "",
      level: r.recipient_level,
      totalAmount: r.amount ?? 0,
    })),
  };
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
  try {
    const r = await fetch(`${USAS}/autocomplete/funding_agency/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ search_text: searchText, limit: 5 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return { matches: [] };
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
    const json = (await r.json()) as Resp;
    return {
      matches: (json.results ?? []).map((r) => ({
        name: r.toptier_agency?.name ?? "",
        abbreviation: r.toptier_agency?.abbreviation,
        toptierCode: r.toptier_agency?.toptier_code,
        isToptier: !!r.toptier_flag,
      })),
    };
  } catch {
    return { matches: [] };
  }
  });
}

export async function autocompleteNaics(args: {
  searchText: string;
  limit?: number;
}) {
  return memoize(
    `usas:naics:${args.searchText.toLowerCase()}:${args.limit ?? 10}`,
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
        limit: args.limit ?? 10,
      });
      return {
        naics: (json.results ?? []).map((r) => ({
          code: r.naics ?? "",
          description: r.naics_description ?? "",
          retired: !!r.year_retired,
        })),
      };
    },
  );
}

export async function autocompleteRecipient(args: {
  searchText: string;
  limit?: number;
}) {
  return memoize(
    `usas:recipient:${args.searchText.toLowerCase()}:${args.limit ?? 10}`,
    async () => {
      type Resp = {
        results?: {
          recipient_name?: string;
          uei?: string;
          duns?: string;
        }[];
      };
      const json = await postUsas<Resp>("autocomplete/recipient/", {
        search_text: args.searchText,
        limit: args.limit ?? 10,
      });
      return {
        recipients: (json.results ?? []).map((r) => ({
          name: r.recipient_name ?? "",
          uei: r.uei,
          duns: r.duns,
        })),
      };
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
    return {
      hierarchy: (json.results ?? []).map((r) => ({
        code: r.naics ?? "",
        description: r.naics_description ?? "",
        count: r.count ?? 0,
        hasChildren: !!(r.children && r.children.length > 0),
      })),
    };
  });
}

export async function glossary(args: { limit?: number; search?: string }) {
  return memoize(`usas:glossary:${args.search ?? ""}:${args.limit ?? 25}`, async () => {
    type Resp = {
      page_metadata?: { count?: number };
      results?: { term?: string; slug?: string; plain?: string }[];
    };
    const params = new URLSearchParams();
    params.set("limit", String(args.limit ?? 25));
    if (args.search) params.set("search", args.search);
    const json = await getUsas<Resp>(`references/glossary/?${params.toString()}`);
    return {
      totalRecords: json.page_metadata?.count ?? 0,
      terms: (json.results ?? []).map((r) => ({
        term: r.term ?? "",
        slug: r.slug ?? "",
        definition: r.plain ?? "",
      })),
    };
  });
}

export async function listToptierAgencies(args: { limit?: number }) {
  return memoize(`usas:toptier:${args.limit ?? 50}`, async () => {
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
      `references/toptier_agencies/?limit=${args.limit ?? 50}`,
    );
    return {
      agencies: (json.results ?? []).map((r) => ({
        name: r.agency_name ?? "",
        abbreviation: r.abbreviation,
        toptierCode: r.toptier_code,
        slug: r.agency_slug,
        activeFiscalYear: r.active_fy,
        obligatedAmount: r.obligated_amount ?? 0,
      })),
    };
  });
}
