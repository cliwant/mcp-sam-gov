/**
 * Toolset profiles for MCP_SAM_GOV_TOOLSETS.
 *
 * Each of the 152 registered tools belongs to exactly one named toolset.
 * A user may load a subset by setting the env var (comma- or space-separated,
 * case-insensitive). Unset or "all" → all 152 tools loaded (default; byte-
 * identical to today's behaviour). Unknown names → stderr warning AND a note
 * in the server instructions; if no valid name remains → fall back to all,
 * with a stderr warning and an instructions note.
 *
 * `feedback` and `api_key_status` are always loaded in every profile.
 * Their toolset mapping is "core" (so a one-set-per-tool mapping is maintained),
 * but `resolveToolsets` always injects them into any profile's loaded set.
 * They are listed in the README table as "always loaded".
 *
 * Available toolsets:
 *   core        — SAM.gov discovery/awards/wage determinations/exclusions/integrity,
 *                 Grants.gov, all USAspending, FPDS, GAO, FAR/eCFR/Federal Register,
 *                 SBA, OFAC, GSA labor-rate benchmarks; api_key_status + feedback
 *                 (always loaded in every profile)
 *   sled        — State/local (SLED): OpenGov, Bonfire, ArcGIS, Socrata,
 *                 data.gov/CKAN, Tableau, Open Checkbook, search.gov domains
 *   vetting     — Partner due-diligence: FAC, FDIC, EPA ECHO/TRI,
 *                 CourtListener, nonprofit (IRS 990), Senate LDA lobbying
 *   disclosure  — SEC EDGAR financial filings and XBRL frames
 *   regulatory  — Regulations.gov, Congress.gov, GovInfo
 *   pricing     — GSA per-diem, BLS, Treasury, BEA, Census business-patterns,
 *                 FRED, DOL, USITC HTS
 *   health      — CMS, NPPES, NIH, NSF, ClinicalTrials.gov, openFDA
 *   safety      — NHTSA vehicle recalls, CPSC consumer-product recalls
 *   geo         — Census geocode, FEMA disasters, NWS alerts, CBP border wait
 *                 times, data.gov catalog
 *   cyber       — NVD CVE, CISA KEV, NIST SP 800-53
 */

/** Every valid toolset name. */
export const ALL_TOOLSET_NAMES = [
  "core",
  "sled",
  "vetting",
  "disclosure",
  "regulatory",
  "pricing",
  "health",
  "safety",
  "geo",
  "cyber",
] as const;

export type ToolsetName = typeof ALL_TOOLSET_NAMES[number];

/**
 * Short 2–4 word description for each toolset, shown in the server instructions
 * when a profile is active so agents know what other sets exist.
 */
export const TOOLSET_HINTS: Readonly<Record<ToolsetName, string>> = {
  core:        "SAM, USAspending, FAR",
  sled:        "state/local procurement",
  vetting:     "FAC, FDIC, EPA, OFAC",
  disclosure:  "SEC EDGAR filings",
  regulatory:  "Regs.gov, Congress, GovInfo",
  pricing:     "GSA, BLS, Treasury, DOL",
  health:      "CMS, NIH, openFDA",
  safety:      "NHTSA, CPSC recalls",
  geo:         "Census geocode, FEMA, NWS",
  cyber:       "CVE, CISA KEV, NIST",
};

/**
 * Tools that are always loaded regardless of the active profile.
 * Their toolset mapping is "core" (one-set-per-tool), but resolveToolsets
 * injects them into every profile's loaded set.
 */
export const ALWAYS_LOADED_TOOLS: ReadonlySet<string> = new Set([
  "feedback",
  "api_key_status",
]);

/**
 * Canonical mapping: tool name → toolset.
 * Every registered tool must appear exactly once.
 * Tests enforce: union === all 152 tools, no entry for an unregistered name.
 *
 * After moves (review 2026-09-18):
 *   ofac_screen_entity       vetting → core  (govcon users screen SAM exclusions + OFAC together)
 *   gsa_benchmark_labor_rates pricing → core  (proposal pricing; needed in core govcon workflows)
 *   hts_lookup               geo → pricing    (tariff/duty data; groups with cost/rate tools)
 *
 * Resulting counts: core=60, sled=13, vetting=16, disclosure=8, regulatory=9,
 *   pricing=15, health=17, safety=3, geo=8, cyber=3.  Total=152.
 */
export const TOOL_TOOLSET_MAP: Readonly<Record<string, ToolsetName>> = {
  // ── core (60) ──────────────────────────────────────────────────────────────
  // SAM.gov: discovery, attachments, wage-determinations, exclusions, integrity
  sam_search_opportunities:    "core",
  sam_search_shaping:          "core",
  sam_get_opportunity:         "core",
  sam_fetch_description:       "core",
  sam_attachment_url:          "core",
  sam_fetch_attachment_text:   "core",
  sam_lookup_organization:     "core",
  sam_lookup_notice_fields:    "core",
  sam_check_exclusions:        "core",
  sam_get_wage_rates:          "core",
  sam_search_wage_determinations: "core",
  sam_integrity_lookup:        "core",
  // Grants.gov
  grants_search:               "core",
  grants_get_opportunity:      "core",
  // USAspending (29)
  usas_search_awards:          "core",
  usas_search_individual_awards: "core",
  usas_search_subagency_spending: "core",
  usas_lookup_agency:          "core",
  usas_search_awards_by_recipient: "core",
  usas_search_subawards:       "core",
  usas_search_recompetes:      "core",
  usas_search_expiring_contracts: "core",
  usas_get_award_detail:       "core",
  usas_analyze_incumbent:      "core",
  usas_spending_over_time:     "core",
  usas_search_psc_spending:    "core",
  usas_search_state_spending:  "core",
  usas_search_cfda_spending:   "core",
  usas_search_federal_account_spending: "core",
  usas_search_agency_spending: "core",
  usas_get_agency_profile:     "core",
  usas_get_agency_awards_summary: "core",
  usas_get_agency_budget_function: "core",
  usas_search_recipients:      "core",
  usas_get_recipient_profile:  "core",
  usas_autocomplete_naics:     "core",
  usas_autocomplete_recipient: "core",
  usas_disaster_spending:      "core",
  usas_glossary:               "core",
  usas_list_disaster_codes:    "core",
  usas_list_toptier_agencies:  "core",
  usas_naics_hierarchy:        "core",
  usas_search_teaming_partners: "core",
  // FPDS
  fpds_search_awards:          "core",
  // GAO
  gao_protest_lookup:          "core",
  // FAR / DFARS
  far_search:                  "core",
  far_clause_lookup:           "core",
  far_compliance_matrix:       "core",
  // eCFR
  ecfr_search:                 "core",
  ecfr_list_titles:            "core",
  ecfr_get_section:            "core",
  // Federal Register
  fed_register_search_documents: "core",
  fed_register_get_document:   "core",
  fed_register_list_agencies:  "core",
  fed_register_public_inspection: "core",
  // SBA
  sba_size_standard:           "core",
  // OFAC (moved from vetting — govcon users screen SAM exclusions + OFAC together)
  ofac_screen_entity:          "core",
  // GSA labor-rate benchmarks (moved from pricing — needed in core proposal-pricing)
  gsa_benchmark_labor_rates:   "core",
  // Always-loaded utilities (every profile; mapped to core for 1-set invariant)
  api_key_status:              "core",
  feedback:                    "core",

  // ── sled (13) ──────────────────────────────────────────────────────────────
  // State/local procurement + spend
  opengov_list_governments:    "sled",
  opengov_search_solicitations: "sled",
  bonfire_list_organizations:  "sled",
  bonfire_search_opportunities: "sled",
  arcgis_hub_discover_datasets: "sled",
  arcgis_feature_query:        "sled",
  socrata_discover_datasets:   "sled",
  socrata_query:               "sled",
  ckan_discover_datasets:      "sled",
  ckan_query:                  "sled",
  tableau_view_csv:            "sled",
  open_checkbook_search:       "sled",
  search_gov_domains:          "sled",

  // ── vetting (16) ───────────────────────────────────────────────────────────
  // Partner due-diligence (ofac_screen_entity moved to core)
  fac_search_audits:           "vetting",
  fac_get_findings:            "vetting",
  fdic_search_institutions:    "vetting",
  fdic_institution_financials: "vetting",
  fdic_institution_history:    "vetting",
  fdic_bank_failures:          "vetting",
  fdic_branch_deposits:        "vetting",
  fdic_industry_summary:       "vetting",
  fdic_risk_ratios:            "vetting",
  echo_search_facilities:      "vetting",
  echo_facility_report:        "vetting",
  epa_tri_facilities:          "vetting",
  courtlistener_search_opinions: "vetting",
  courtlistener_search_dockets: "vetting",
  nonprofit_search:            "vetting",
  nonprofit_financials:        "vetting",
  lda_search_filings:          "vetting",

  // ── disclosure (8) ─────────────────────────────────────────────────────────
  // SEC EDGAR
  edgar_company_concept:       "disclosure",
  edgar_company_facts:         "disclosure",
  edgar_company_filings:       "disclosure",
  edgar_daily_filing_index:    "disclosure",
  edgar_filing_index:          "disclosure",
  edgar_full_text_search:      "disclosure",
  edgar_lookup_cik:            "disclosure",
  edgar_xbrl_frames:           "disclosure",

  // ── regulatory (9) ─────────────────────────────────────────────────────────
  // Regulations.gov, Congress.gov, GovInfo
  regulations_search_documents: "regulatory",
  regulations_search_comments: "regulatory",
  regulations_search_dockets:  "regulatory",
  regulations_get_docket:      "regulatory",
  congress_search_bills:       "regulatory",
  congress_get_bill:           "regulatory",
  govinfo_list_collections:    "regulatory",
  govinfo_search_packages:     "regulatory",
  govinfo_get_package:         "regulatory",

  // ── pricing (15) ───────────────────────────────────────────────────────────
  // GSA per-diem, BLS, Treasury, BEA, Census business-patterns, FRED, DOL, USITC HTS
  // (gsa_benchmark_labor_rates moved to core; hts_lookup moved in from geo)
  gsa_perdiem_rates:           "pricing",
  bls_oews_wages:              "pricing",
  bls_qcew:                    "pricing",
  bls_timeseries:              "pricing",
  treasury_avg_interest_rates: "pricing",
  treasury_debt_to_penny:      "pricing",
  treasury_monthly_statement:  "pricing",
  treasury_query_dataset:      "pricing",
  bea_regional_data:           "pricing",
  census_business_patterns:    "pricing",
  fred_search_series:          "pricing",
  fred_series_observations:    "pricing",
  dol_list_datasets:           "pricing",
  dol_get_dataset:             "pricing",
  hts_lookup:                  "pricing",

  // ── health (17) ────────────────────────────────────────────────────────────
  // CMS, NPPES, NIH, NSF, ClinicalTrials.gov, openFDA
  cms_medicare_provider_services: "health",
  cms_hospital_compare:        "health",
  cms_facility_directory:      "health",
  cms_dmepos_suppliers:        "health",
  cms_revoked_providers:       "health",
  cms_query_dataset:           "health",
  cms_search_datasets:         "health",
  nppes_lookup_provider:       "health",
  nih_reporter_search_projects: "health",
  nsf_search_awards:           "health",
  nsf_get_award:               "health",
  clinicaltrials_search_studies: "health",
  clinicaltrials_get_study:    "health",
  clinicaltrials_facet_counts: "health",
  openfda_enforcement:         "health",
  openfda_device_clearances:   "health",
  openfda_drug_approvals:      "health",

  // ── safety (3) ─────────────────────────────────────────────────────────────
  // NHTSA, CPSC
  nhtsa_recalls:               "safety",
  nhtsa_complaints:            "safety",
  cpsc_recalls:                "safety",

  // ── geo (8) ────────────────────────────────────────────────────────────────
  // Census geocode, FEMA, NWS, CBP, data.gov catalog
  // (hts_lookup moved to pricing)
  census_geocode_address:      "geo",
  census_geographies_by_coordinates: "geo",
  fema_disaster_declarations:  "geo",
  fema_search_hazard_mitigation: "geo",
  fema_search_public_assistance: "geo",
  nws_active_alerts:           "geo",
  cbp_border_wait_times:       "geo",
  datagov_search_datasets:     "geo",

  // ── cyber (3) ──────────────────────────────────────────────────────────────
  // NVD CVE, CISA KEV, NIST 800-53
  cve_lookup:                  "cyber",
  cisa_kev_lookup:             "cyber",
  nist_800_53_controls:        "cyber",
};

export type ResolveResult = {
  /** Tools that are loaded (by name). */
  loaded: Set<string>;
  /** Valid toolset names that were requested. */
  sets: string[];
  /** Names that were not recognised as valid toolset names. */
  unknown: string[];
  /** True if we fell back to all because no valid name survived. */
  fellBack: boolean;
};

/**
 * Parse MCP_SAM_GOV_TOOLSETS and return the set of tool names to expose.
 *
 * Pure: takes the env value and the full tool-name list as inputs, reads
 * nothing from `process.env`, and has no side-effects. Call sites (server.ts)
 * are responsible for logging any warnings to stderr.
 *
 * `feedback` and `api_key_status` are always injected into `loaded` regardless
 * of the requested profile (ALWAYS_LOADED_TOOLS invariant).
 *
 * @param envValue  The raw value of MCP_SAM_GOV_TOOLSETS (undefined / empty = all).
 * @param toolNames The complete list of registered tool names (from TOOLS).
 */
export function resolveToolsets(
  envValue: string | undefined,
  toolNames: readonly string[],
): ResolveResult {
  const allLoaded = new Set(toolNames);

  // Unset or empty → all.
  if (!envValue || !envValue.trim()) {
    return { loaded: allLoaded, sets: ["all"], unknown: [], fellBack: false };
  }

  // Split on commas and/or whitespace, normalise to lower-case.
  const tokens = envValue
    .split(/[\s,]+/)
    .map((t) => t.toLowerCase().trim())
    .filter(Boolean);

  // "all" anywhere → all.
  if (tokens.includes("all")) {
    return { loaded: allLoaded, sets: ["all"], unknown: [], fellBack: false };
  }

  const validSet = new Set<string>(ALL_TOOLSET_NAMES);
  const validNames: string[] = [];
  const unknownNames: string[] = [];

  for (const token of tokens) {
    if (validSet.has(token)) {
      if (!validNames.includes(token)) validNames.push(token);
    } else {
      unknownNames.push(token);
    }
  }

  // No valid names → fall back to all.
  if (validNames.length === 0) {
    return {
      loaded: allLoaded,
      sets: ["all"],
      unknown: unknownNames,
      fellBack: true,
    };
  }

  // Build the loaded set: union of all tools in the requested toolsets.
  const requestedSets = new Set(validNames);
  const loaded = new Set<string>();
  for (const toolName of toolNames) {
    const ts = TOOL_TOOLSET_MAP[toolName];
    if (ts && requestedSets.has(ts)) {
      loaded.add(toolName);
    }
  }

  // Always inject always-loaded tools (feedback, api_key_status) regardless
  // of the profile. They are already in core's mapping but must appear in every
  // profile's loaded set.
  for (const toolName of toolNames) {
    if (ALWAYS_LOADED_TOOLS.has(toolName)) {
      loaded.add(toolName);
    }
  }

  return {
    loaded,
    sets: validNames,
    unknown: unknownNames,
    fellBack: false,
  };
}

/**
 * Filter a tool list to only those in the loaded set.
 * Exported so server.ts can call this and tests can import and verify the logic
 * without mutating dist/server.js.
 */
export function filterToolsFor<T extends { name: string }>(
  tools: readonly T[],
  loaded: ReadonlySet<string>,
): T[] {
  return tools.filter((t) => loaded.has(t.name));
}

/**
 * Build the structured tool_not_loaded error envelope.
 * Exported so server.ts can call this and tests can import and verify the logic
 * without mutating dist/server.js.
 *
 * @param toolName   The name of the tool that was called but not loaded.
 * @param loadedSets The currently loaded toolset names (from ResolveResult.sets).
 */
export function toolNotLoadedEnvelope(
  toolName: string,
  loadedSets: readonly string[],
): {
  ok: false;
  error: { kind: "tool_not_loaded"; message: string; retryable: false };
} {
  const toolset = TOOL_TOOLSET_MAP[toolName] ?? "unknown";
  // Suggest the union of currently loaded sets + the needed set (not just the
  // needed set alone, which would silently drop the user's current profile).
  const isAll = loadedSets.length === 1 && loadedSets[0] === "all";
  let suggestion: string;
  if (isAll) {
    // All tools are already loaded — the tool simply doesn't exist.
    suggestion = `MCP_SAM_GOV_TOOLSETS=all`;
  } else if (toolset === "unknown") {
    suggestion = `MCP_SAM_GOV_TOOLSETS=all`;
  } else {
    // Build union: current loaded sets + the required set, deduped.
    const unionSets = [...loadedSets];
    if (!unionSets.includes(toolset)) unionSets.push(toolset);
    suggestion = `MCP_SAM_GOV_TOOLSETS=${unionSets.join(",")}`;
  }
  const error = {
    kind: "tool_not_loaded" as const,
    message:
      `Tool '${toolName}' belongs to the '${toolset}' toolset, which is not loaded. ` +
      `Set ${suggestion} to enable it.`,
    retryable: false as const,
  };
  return { ok: false as const, error };
}
