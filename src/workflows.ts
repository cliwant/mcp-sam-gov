/**
 * Workflow primitives — composite tools that chain 4-7 underlying
 * tool calls into one structured response.
 *
 * Why: agents can chain individual tools, but orchestration is fragile
 * (LLM picks wrong order, loses context between calls, mishandles
 * partial failures). These primitives encode the canonical chain
 * once + handle partial-failure gracefully.
 *
 * Each primitive returns:
 *   - successful sections fully expanded
 *   - failed sections wrapped in { error } so the agent can decide
 *     whether to retry or surface the gap
 *   - a `summary` string the agent can use as a one-liner
 */

import * as usas from "./usaspending.js";
import * as fedreg from "./federal-register.js";
import { SamGovClient, type SamSetAside } from "./sam-gov/index.js";
import { toToolError, type ToolError } from "./errors.js";

type SectionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ToolError };

async function safe<T>(
  fn: () => Promise<T>,
  label: string,
): Promise<SectionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: toToolError(e, label) };
  }
}

/**
 * captureBrief — federal capture intelligence, 6 sections, 1 call.
 *
 * Chain:
 *   1. usas_lookup_agency            → canonical agency name + toptier code
 *   2. usas_search_subagency_spending → which office actually buys
 *   3. usas_search_awards            → top recipients (competitive map)
 *   4. usas_search_expiring_contracts → recompete pile next 12 months
 *   5. fed_register_search_documents → recent regulatory activity
 *   6. sam_search_opportunities      → active live opps right now
 *
 * Partial-failure tolerant: if step 5 (Federal Register) fails, the
 * other 5 sections still return useful data with section 5 wrapped
 * in { ok: false, error }.
 */
export async function captureBrief(args: {
  agency: string;
  naics: string;
  fiscalYear?: number;
  sam: SamGovClient;
}): Promise<{
  inputs: { agency: string; naics: string; fiscalYear: number };
  agency: SectionResult<{
    canonical: string;
    toptierCode: string;
    abbreviation?: string;
    matches: number;
  }>;
  subagencyBreakdown: SectionResult<unknown>;
  topRecipients: SectionResult<unknown>;
  recompetePile: SectionResult<unknown>;
  recentRegulatoryActivity: SectionResult<unknown>;
  activeOpportunities: SectionResult<unknown>;
  summary: string;
}> {
  const fiscalYear = args.fiscalYear ?? new Date().getFullYear();

  // Step 1: resolve agency name (sequential — others depend on it)
  const agencyResult = await safe(async () => {
    const r = await usas.lookupAgency(args.agency);
    const m = r.matches[0];
    if (!m) {
      throw new Error(
        `No USAspending agency matched "${args.agency}". Try a full name (e.g. "Department of Veterans Affairs") or abbreviation ("VA", "DHS").`,
      );
    }
    return {
      canonical: m.name,
      toptierCode: m.toptierCode ?? "",
      abbreviation: m.abbreviation,
      matches: r.matches.length,
    };
  }, "usas_lookup_agency");

  // If agency lookup failed, downstream sections can't run with a
  // canonical name. We attempt them with the raw input as best-effort
  // (USAspending will mostly return empty rather than crash).
  const canonicalAgency = agencyResult.ok
    ? agencyResult.data.canonical
    : args.agency;

  // Steps 2-6: parallel where independent
  const [
    subagencyBreakdown,
    topRecipients,
    recompetePile,
    recentRegulatoryActivity,
    activeOpportunities,
  ] = await Promise.all([
    safe(
      () =>
        usas.searchSubAgencySpending({
          agency: canonicalAgency,
          fiscalYear,
        }),
      "usas_search_subagency_spending",
    ),
    safe(
      () =>
        usas.searchAwards({
          agency: canonicalAgency,
          naics: args.naics,
          fiscalYear,
        }),
      "usas_search_awards",
    ),
    safe(
      () =>
        usas.searchExpiringContracts({
          agency: canonicalAgency,
          naics: args.naics,
          monthsUntilExpiry: 12,
          limit: 10,
        }),
      "usas_search_expiring_contracts",
    ),
    safe(async () => {
      // FedReg uses agency slugs, not toptier names. Best effort:
      // pull the agency list and try a fuzzy match. If we can't
      // resolve, search globally.
      const agenciesResp = await fedreg.listAgencies({ perPage: 500 });
      const agencyName = canonicalAgency.toLowerCase();
      const matched = agenciesResp.agencies.find(
        (a: { name: string; slug: string }) =>
          a.name.toLowerCase().includes(agencyName) ||
          agencyName.includes(a.name.toLowerCase()),
      );
      return await fedreg.searchDocuments({
        agencySlugs: matched ? [matched.slug] : undefined,
        publicationDateFrom: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10),
        perPage: 10,
      });
    }, "fed_register_search_documents"),
    safe(
      () =>
        args.sam.searchOpportunities({
          ncode: args.naics,
          organizationName: canonicalAgency,
          limit: 10,
        }),
      "sam_search_opportunities",
    ),
  ]);

  // Synthesize one-line summary from sections that succeeded
  const lines: string[] = [];
  if (agencyResult.ok) {
    lines.push(
      `Agency: ${agencyResult.data.canonical} (toptier ${agencyResult.data.toptierCode}).`,
    );
  } else {
    lines.push(`Agency lookup failed: ${agencyResult.error.message}`);
  }
  if (subagencyBreakdown.ok) {
    const r = subagencyBreakdown.data as { results?: unknown[] };
    lines.push(
      `${r.results?.length ?? 0} sub-agencies with FY${fiscalYear} spending.`,
    );
  }
  if (topRecipients.ok) {
    const r = topRecipients.data as { results?: unknown[] };
    lines.push(
      `${r.results?.length ?? 0} top recipients in NAICS ${args.naics}.`,
    );
  }
  if (recompetePile.ok) {
    const r = recompetePile.data as { results?: unknown[] };
    lines.push(`${r.results?.length ?? 0} contracts expiring in next 12 months.`);
  }
  if (recentRegulatoryActivity.ok) {
    const r = recentRegulatoryActivity.data as { results?: unknown[] };
    lines.push(`${r.results?.length ?? 0} Federal Register documents in last 90 days.`);
  }
  if (activeOpportunities.ok) {
    const r = activeOpportunities.data as { opportunitiesData?: unknown[] };
    lines.push(`${r.opportunitiesData?.length ?? 0} active SAM.gov opportunities.`);
  }
  const failedSections = [
    !agencyResult.ok && "agency",
    !subagencyBreakdown.ok && "subagency",
    !topRecipients.ok && "recipients",
    !recompetePile.ok && "recompete",
    !recentRegulatoryActivity.ok && "fedReg",
    !activeOpportunities.ok && "samOpps",
  ].filter(Boolean);
  if (failedSections.length) {
    lines.push(`(${failedSections.length} section(s) failed: ${failedSections.join(", ")}.)`);
  }

  return {
    inputs: { agency: args.agency, naics: args.naics, fiscalYear },
    agency: agencyResult,
    subagencyBreakdown,
    topRecipients,
    recompetePile,
    recentRegulatoryActivity,
    activeOpportunities,
    summary: lines.join(" "),
  };
}

/**
 * recompeteRadar — focused recompete intelligence for a specific NAICS x agency.
 *
 * Lighter than captureBrief — purpose-built for "what's expiring + who holds it".
 *
 * Chain:
 *   1. usas_lookup_agency          → canonical name
 *   2. usas_search_expiring_contracts → contracts ending in N months
 *   3. usas_search_awards (current FY) → who currently dominates
 *   4. fed_register_search_documents → any rule changes that affect recompetes
 */
export async function recompeteRadar(args: {
  agency: string;
  naics: string;
  monthsUntilExpiry?: number;
  minAwardValueUsd?: number;
}): Promise<{
  inputs: {
    agency: string;
    naics: string;
    monthsUntilExpiry: number;
    minAwardValueUsd?: number;
  };
  agency: SectionResult<{ canonical: string; toptierCode: string }>;
  expiringContracts: SectionResult<unknown>;
  currentTopRecipients: SectionResult<unknown>;
  rulesAffectingRecompete: SectionResult<unknown>;
  summary: string;
}> {
  const monthsUntilExpiry = args.monthsUntilExpiry ?? 12;
  const fiscalYear = new Date().getFullYear();

  const agencyResult = await safe(async () => {
    const r = await usas.lookupAgency(args.agency);
    const m = r.matches[0];
    if (!m) {
      throw new Error(`No USAspending agency matched "${args.agency}".`);
    }
    return {
      canonical: m.name,
      toptierCode: m.toptierCode ?? "",
    };
  }, "usas_lookup_agency");

  const canonicalAgency = agencyResult.ok
    ? agencyResult.data.canonical
    : args.agency;

  const [expiringContracts, currentTopRecipients, rulesAffectingRecompete] =
    await Promise.all([
      safe(
        () =>
          usas.searchExpiringContracts({
            agency: canonicalAgency,
            naics: args.naics,
            monthsUntilExpiry,
            minAwardValue: args.minAwardValueUsd,
            limit: 20,
          }),
        "usas_search_expiring_contracts",
      ),
      safe(
        () =>
          usas.searchAwards({
            agency: canonicalAgency,
            naics: args.naics,
            fiscalYear,
          }),
        "usas_search_awards",
      ),
      safe(
        () =>
          fedreg.searchDocuments({
            query: `recompete OR set-aside OR ${args.naics}`,
            publicationDateFrom: new Date(
              Date.now() - 180 * 24 * 60 * 60 * 1000,
            )
              .toISOString()
              .slice(0, 10),
            perPage: 5,
          }),
        "fed_register_search_documents",
      ),
    ]);

  const lines: string[] = [];
  if (agencyResult.ok) {
    lines.push(`Agency: ${agencyResult.data.canonical}.`);
  }
  if (expiringContracts.ok) {
    const r = expiringContracts.data as { results?: unknown[] };
    lines.push(
      `${r.results?.length ?? 0} contracts expiring in next ${monthsUntilExpiry} months in NAICS ${args.naics}.`,
    );
  }
  if (currentTopRecipients.ok) {
    const r = currentTopRecipients.data as { results?: unknown[] };
    lines.push(`${r.results?.length ?? 0} current top recipients (FY${fiscalYear}).`);
  }
  if (rulesAffectingRecompete.ok) {
    const r = rulesAffectingRecompete.data as { results?: unknown[] };
    lines.push(`${r.results?.length ?? 0} potentially-relevant FedReg docs (last 6 months).`);
  }

  return {
    inputs: {
      agency: args.agency,
      naics: args.naics,
      monthsUntilExpiry,
      minAwardValueUsd: args.minAwardValueUsd,
    },
    agency: agencyResult,
    expiringContracts,
    currentTopRecipients,
    rulesAffectingRecompete,
    summary: lines.join(" "),
  };
}

/**
 * vendorProfile — full picture of a federal vendor in 1 call.
 *
 * Chain:
 *   1. usas_autocomplete_recipient → confirm canonical name
 *   2. usas_search_recipients      → parent / child / total spend
 *   3. usas_search_awards_by_recipient → recent line items
 *   4. usas_search_subawards (where they appear as a sub) → teaming network
 */
export async function vendorProfile(args: {
  recipientName: string;
  fiscalYear?: number;
}): Promise<{
  inputs: { recipientName: string; fiscalYear: number };
  canonical: SectionResult<{
    canonicalName: string;
    matches: Array<{ name: string; uei?: string; duns?: string }>;
  }>;
  recipientHierarchy: SectionResult<unknown>;
  recentAwards: SectionResult<unknown>;
  subawardAppearances: SectionResult<unknown>;
  summary: string;
}> {
  const fiscalYear = args.fiscalYear ?? new Date().getFullYear();

  const canonical = await safe(async () => {
    const r = await usas.autocompleteRecipient({
      searchText: args.recipientName,
      limit: 5,
    });
    const m = r.recipients[0];
    if (!m) {
      throw new Error(
        `No USAspending recipient matched "${args.recipientName}". Try a partial name or DBA.`,
      );
    }
    return {
      canonicalName: m.name,
      matches: r.recipients.map((x) => ({
        name: x.name,
        uei: x.uei,
        duns: x.duns,
      })),
    };
  }, "usas_autocomplete_recipient");

  const canonicalName = canonical.ok
    ? canonical.data.canonicalName
    : args.recipientName;

  const [recipientHierarchy, recentAwards, subawardAppearances] =
    await Promise.all([
      safe(
        () =>
          usas.searchRecipients({
            keyword: canonicalName,
            limit: 10,
          }),
        "usas_search_recipients",
      ),
      safe(
        () =>
          usas.searchAwardsByRecipient({
            recipientName: canonicalName,
            fiscalYear,
            limit: 20,
          }),
        "usas_search_awards_by_recipient",
      ),
      safe(
        () =>
          usas.searchSubawards({
            primeRecipientName: canonicalName,
            fiscalYear,
            limit: 10,
          }),
        "usas_search_subawards",
      ),
    ]);

  const lines: string[] = [];
  if (canonical.ok) {
    lines.push(`Recipient: ${canonical.data.canonicalName}.`);
  }
  if (recentAwards.ok) {
    const r = recentAwards.data as { results?: unknown[] };
    lines.push(`${r.results?.length ?? 0} prime awards in FY${fiscalYear}.`);
  }
  if (subawardAppearances.ok) {
    const r = subawardAppearances.data as { results?: unknown[] };
    lines.push(
      `${r.results?.length ?? 0} prime contracts where this firm appears (own or as sub).`,
    );
  }

  return {
    inputs: { recipientName: args.recipientName, fiscalYear },
    canonical,
    recipientHierarchy,
    recentAwards,
    subawardAppearances,
    summary: lines.join(" "),
  };
}
