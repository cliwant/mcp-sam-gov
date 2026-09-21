/**
 * State & local data map — single source of truth.
 *
 * These entries are exported for:
 *   (a) the MCP resource samgov://data-map/state-local (resources/read)
 *   (b) consistency tests (SKILL.md table must agree on domain/id/rows)
 *
 * Keep verified row counts and notes current here only; SKILL.md table and
 * the resource content are generated from this array.
 */

export type DataMapTool =
  | "socrata_query"
  | "ckan_query"
  | "tableau_view_csv"
  | "open_checkbook_search";

export interface DataMapEntry {
  /** Two-letter state abbreviation for grouping */
  state: string;
  /** Human-readable jurisdiction name */
  jurisdiction: string;
  /** Short description of what the dataset contains */
  dataLabel: string;
  /** Tool to call */
  tool: DataMapTool;
  /** Key args to pass — human-readable form for doc */
  keyArgs: string;
  /** Verified approximate row count (null = not precisely known) */
  rows: number | null;
  /** Approximate flag — when true prefix rows with '~' */
  approximate: boolean;
  /** What this dataset is NOT (common agent error) */
  notNote: string;
  /** Extra notes (optional) */
  extra?: string;
}

/**
 * Verified 2026-09-21 — all keyless.
 */
export const DATA_MAP_ENTRIES: DataMapEntry[] = [
  // ── State-level ──────────────────────────────────────────────────────────
  {
    state: "CA",
    jurisdiction: "California",
    dataLabel: "DGS Purchase Order Data 2012–2015",
    tool: "ckan_query",
    keyArgs: "host=data.ca.gov, resourceId=bb82edc5-9c78-44e2-8947-68ece26197c5",
    rows: 344504,
    approximate: false,
    notNote: "live Cal eProcure portal (WAF-403); FY2012–2015 only — no post-2015 rows",
  },
  {
    state: "CA",
    jurisdiction: "California",
    dataLabel: "DGS-Approved Non-Competitive Bids",
    tool: "ckan_query",
    keyArgs: "host=data.ca.gov, resourceId=14932789-485b-481b-910a-dafb40d3471c",
    rows: 480,
    approximate: false,
    notNote: "open competitive solicitations; sole-source/non-competitive award register",
  },
  {
    state: "OK",
    jurisdiction: "Oklahoma",
    dataLabel: "Vendor Payments FY2019 Q1 (OMES)",
    tool: "ckan_query",
    keyArgs: "host=data.ok.gov, resourceId=cc443616-15eb-4a1f-8d87-93e5711ac43c",
    rows: 286185,
    approximate: false,
    notNote: "bids or awards; vendor PAYMENTS — per-quarter resources, one fiscal year = 4 calls",
  },
  {
    state: "VA",
    jurisdiction: "Virginia",
    dataLabel: "eVA PO line items 2023",
    tool: "ckan_query",
    keyArgs: "host=data.virginia.gov, resourceId=3c7f1bde-35b0-4fbf-b89c-978a19124d53",
    rows: 1693227,
    approximate: false,
    notNote: "the live eVA portal (login-gated)",
    extra:
      "Years 2016–2026 have separate resourceIds; ckan_discover_datasets host=data.virginia.gov q=eVA procurement lists them (2024=25a59527, 2025=b8dc22a8, 2026=76f6831d)",
  },
  {
    state: "MA",
    jurisdiction: "Massachusetts",
    dataLabel: "Comptroller vendor payments (CTHRU)",
    tool: "socrata_query",
    keyArgs: "domain=cthru.data.socrata.com, datasetId=pegc-naaa",
    rows: 49000000,
    approximate: true,
    notNote: "an award or bid register; these are payment transactions",
  },
  {
    state: "NJ",
    jurisdiction: "New Jersey",
    dataLabel: "YourMoney agency purchasing by vendor",
    tool: "socrata_query",
    keyArgs: "domain=data.nj.gov, datasetId=ubnu-tqu7",
    rows: 660425,
    approximate: false,
    notNote: "a solicitation or bid register; agency expenditure rows",
  },
  {
    state: "NY",
    jurisdiction: "New York",
    dataLabel: "State authority procurement contracts",
    tool: "socrata_query",
    keyArgs: "domain=data.ny.gov, datasetId=ehig-g5x3",
    rows: 275763,
    approximate: false,
    notNote: "all NYS agencies (authorities only) and NOT active solicitations",
  },
  {
    state: "NY",
    jurisdiction: "New York",
    dataLabel: "MTA procurement contracts",
    tool: "socrata_query",
    keyArgs: "domain=data.ny.gov, datasetId=twsw-2mqa",
    rows: 107503,
    approximate: false,
    notNote: "a live MTA bid portal; MTA historical contract records",
  },
  {
    state: "WA",
    jurisdiction: "Washington",
    dataLabel: "Agency contract register",
    tool: "socrata_query",
    keyArgs: "domain=data.wa.gov, datasetId=s8d5-pj78",
    rows: 79329,
    approximate: false,
    notNote: "a solicitation or bid feed; awarded contract records",
  },
  {
    state: "WA",
    jurisdiction: "Washington",
    dataLabel: "Master-contract sales by vendor/customer",
    tool: "socrata_query",
    keyArgs: "domain=data.wa.gov, datasetId=n8q6-4twj",
    rows: 245831,
    approximate: false,
    notNote: "open bids; sales reported off statewide master contracts",
  },
  {
    state: "MT",
    jurisdiction: "Montana",
    dataLabel: "DOA contracts awarded",
    tool: "tableau_view_csv",
    keyArgs: "view=mt_contracts_awarded",
    rows: 4554,
    approximate: true,
    notNote: "a bid portal; awarded records only, freshness set by publisher",
  },
  {
    state: "SD",
    jurisdiction: "South Dakota",
    dataLabel: "Open Checkbook vendor payments",
    tool: "open_checkbook_search",
    keyArgs: "portal=sd",
    rows: 741000,
    approximate: true,
    notNote: "an award register; only ~3 most-recent FYs, exact-match filters",
  },
  {
    state: "IL",
    jurisdiction: "Illinois",
    dataLabel: "CDB capital project future bids",
    tool: "socrata_query",
    keyArgs: "domain=data.illinois.gov, datasetId=6rb8-ntpm",
    rows: 48,
    approximate: false,
    notNote: "a comprehensive solicitation feed; only ~48 upcoming CDB capital bids",
  },
  {
    state: "IL",
    jurisdiction: "Illinois",
    dataLabel: "IDHR certified eligible bidders",
    tool: "socrata_query",
    keyArgs: "domain=data.illinois.gov, datasetId=w8h2-q8hu",
    rows: 7848,
    approximate: false,
    notNote: "a bid or award register; vendor-eligibility directory only",
  },
  // ── Texas — verified 2026-09-21 ──────────────────────────────────────────
  {
    state: "TX",
    jurisdiction: "Texas",
    dataLabel: "TxDOT current lettings (★live bid-line items)",
    tool: "socrata_query",
    keyArgs: "domain=data.texas.gov, datasetId=qh8x-rm8r",
    rows: 8861,
    approximate: false,
    notNote:
      "rows are bid LINE ITEMS not projects (8,861 rows = 412 distinct project_ids — report project count not row count); TxDOT highway lettings ONLY, not all Texas procurement; rolling window only (past lettings dropped, cannot answer historical questions); ESBD/TxSmartBuy non-TxDOT solicitations are absent",
    extra:
      "★First live state solicitation feed in this map. Use $select=count(distinct project_id) for open-bid count.",
  },
  {
    state: "TX",
    jurisdiction: "Texas",
    dataLabel: "DIR Cooperative Contract Sales FY2010–FY2025 (archive)",
    tool: "socrata_query",
    keyArgs: "domain=data.texas.gov, datasetId=w64c-ndf7",
    rows: 10749743,
    approximate: false,
    notNote: "bids or awards; purchase line items off DIR cooperative contracts (historical)",
  },
  {
    state: "TX",
    jurisdiction: "Texas",
    dataLabel: "DIR Cooperative & Tele Contract Sales FY2026",
    tool: "socrata_query",
    keyArgs: "domain=data.texas.gov, datasetId=a743-wj72",
    rows: 2077855,
    approximate: false,
    notNote: "historical FY2026 purchase lines (same shape as w64c-ndf7); not bids",
  },
  {
    state: "TX",
    jurisdiction: "Texas",
    dataLabel: "DIR Current Active Cooperative Contracts",
    tool: "socrata_query",
    keyArgs: "domain=data.texas.gov, datasetId=vipt-h4ye",
    rows: 5167,
    approximate: false,
    notNote: "a solicitation feed; active cooperative contract register (not TxDOT lettings)",
  },
  {
    state: "TX",
    jurisdiction: "Texas",
    dataLabel: "TCEQ Current Contracts & Purchase Orders",
    tool: "socrata_query",
    keyArgs: "domain=data.texas.gov, datasetId=svjm-sdfz",
    rows: 2067,
    approximate: false,
    notNote: "statewide; one agency (TCEQ) only",
  },
  // ── Maryland — verified 2026-09-21 ───────────────────────────────────────
  {
    state: "MD",
    jurisdiction: "Maryland",
    dataLabel: "eMaryland Marketplace (eMMA) bids — FY2018 exemplar",
    tool: "socrata_query",
    keyArgs: "domain=opendata.maryland.gov, datasetId=pgna-cxjh",
    rows: 107303,
    approximate: false,
    notNote:
      "rows are bid LINE ITEMS not bids — FY2018 is 107,303 rows for only 3,067 bids (35× overcount); always use $select=count(distinct bid_number) for actual bid count. Coverage stops at FY2019 — eMMA migrated to Periscope mid-FY2019; there is no FY2020+ mirror and this dataset cannot answer questions about current Maryland bids",
    extra:
      "All six FY datasetIds: FY2018=pgna-cxjh (107,303 rows/3,067 bids), FY2017=qkjf-rv4t (64,331/4,943), FY2016=7ang-84wj (45,204/4,818), FY2015=3hzs-sazv (46,895/4,898), FY2014=itax-4ccz (45,551/4,884), FY2019=ttg5-zfzj (4,623/388 — small because eMMA migrated to Periscope mid-year; first row is a sparse placeholder, subsequent rows are complete).",
  },
  // ── Oregon — verified 2026-09-21 ─────────────────────────────────────────
  {
    state: "OR",
    jurisdiction: "Oregon",
    dataLabel: "OregonBuys Purchases and Contracts FY2022–FY2025",
    tool: "socrata_query",
    keyArgs: "domain=data.oregon.gov, datasetId=qyug-f2km",
    rows: 109119,
    approximate: false,
    notNote:
      "open solicitations — these are issued purchase orders and contracts (not bids). ORPIN was the retired system; OregonBuys is its replacement. qyug-f2km covers sent_date 2021-07-01 → 2025-07-01 (FY2022–FY2025); 92,224 distinct po_nbr",
    extra:
      "Historical ORPIN datasets (retired system, same domain): Contracts Issued=6e9e-sfc4 (93,846 rows), Contracts Expired=8izy-bwhd (92,755 rows), Statewide Price Agreement Spend=gart-52me (5,224 rows). All keyless.",
  },
  // ── Vermont — verified 2026-09-21 ────────────────────────────────────────
  {
    state: "VT",
    jurisdiction: "Vermont",
    dataLabel: "Purchase Orders with Vendor Information (current FY, live-ish)",
    tool: "socrata_query",
    keyArgs: "domain=data.vermont.gov, datasetId=8ewu-igdm",
    rows: 111271,
    approximate: false,
    notNote:
      "a bid or award register — issued purchase orders. 39,882 distinct po_id (~2.8 line items per PO). po_date 2025-07-02 → 2026-06-19 (current fiscal year, so this is live-ish state spend, not an archive)",
  },
  // ── Colorado (City of Denver on state portal) — verified 2026-09-21 ──────
  {
    state: "CO",
    jurisdiction: "City of Denver",
    dataLabel: "City of Denver Procurement Transactions (on CO state portal)",
    tool: "socrata_query",
    keyArgs: "domain=data.colorado.gov, datasetId=66zf-qjdd",
    rows: 76357,
    approximate: false,
    notNote:
      "Colorado STATE procurement — this is City of Denver spend hosted on the Colorado state portal (data.colorado.gov). An agent that reads the domain as the jurisdiction gets this wrong. Updated 2026-09-20.",
  },
  {
    state: "CO",
    jurisdiction: "City of Denver",
    dataLabel: "City of Denver Checkbook (on CO state portal)",
    tool: "socrata_query",
    keyArgs: "domain=data.colorado.gov, datasetId=wnau-xrqi",
    rows: 154595,
    approximate: false,
    notNote:
      "Colorado STATE procurement — this is City of Denver checkbook data hosted on the Colorado state portal (data.colorado.gov). An agent that reads the domain as the jurisdiction gets this wrong. Updated 2026-09-20.",
  },
];

/**
 * Format a row count for display.
 *
 * HONESTY: an EXACT count (approximate:false) is printed in full with thousands
 * separators — never rounded. The table header promises a "verified row count",
 * so rounding a measured 1,693,227 to "2M" would overstate it by 18% while still
 * reading as exact. Only an entry explicitly marked `approximate` is rounded, and
 * that form always carries a leading `~` so the reader can tell the two apart.
 */
function fmtRows(e: DataMapEntry): string {
  if (e.rows === null) return "?";
  if (!e.approximate) return e.rows.toLocaleString("en-US");
  // Keep 2 significant figures below 10 units so "~5k" never stands in for a
  // measured 4,554 (a 10% overstatement); 49,000,000 still renders "~49M".
  const scale = (v: number, suffix: string) =>
    `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : String(Math.round(v))}${suffix}`;
  const n = e.rows >= 1000000 ? scale(e.rows / 1000000, "M") :
    e.rows >= 1000 ? scale(e.rows / 1000, "k") :
    String(e.rows);
  return `~${n}`;
}

/**
 * Render the state-level entries as a Markdown table.
 * Matches the format in SKILL.md §State & local data map.
 */
export function renderStateTableMarkdown(): string {
  const header =
    "| Jurisdiction | Data | Tool · key args | Rows | NOT |\n" +
    "|---|---|---|---|---|\n";
  const rows = DATA_MAP_ENTRIES.map((e) => {
    const extra = e.extra ? ` ${e.extra}` : "";
    return `| **${e.jurisdiction}** | ${e.dataLabel} | \`${e.tool}\` ${e.keyArgs} | ${fmtRows(e)} | ${e.notNote}${extra} |`;
  });
  return header + rows.join("\n");
}

/** Full resource content: header + state table */
export function renderDataMapMarkdown(): string {
  return `# State & local data map

Agent-readable lookup: jurisdiction → data type → exact tool call → verified row count → what it is NOT (the most common source of agent error).

**State-level open-data sources (verified 2026-09-21, all keyless):**

${renderStateTableMarkdown()}

**County & city** — use \`socrata_discover_datasets\` to find dataset IDs for: NYC (data.cityofnewyork.us), Chicago (data.cityofchicago.org), Austin TX (data.austintexas.gov), Dallas TX (www.dallasopendata.com), LA (controllerdata.lacity.org), King County WA (data.kingcounty.gov), Cook County IL (datacatalog.cookcountyil.gov), Montgomery County MD (data.montgomerycountymd.gov). For Hennepin County MN and Charlotte-Mecklenburg NC capital project pipelines, use \`arcgis_feature_query\` (hennepin_transportation_cip / charlotte_mecklenburg_cip) — these are CIP pipelines, NOT solicitation or award registers.

**State portals with no keyless procurement content (measured absence, not unexplored):**
- Login-gated or WAF-blocked live-bid portals: CA (Cal eProcure), TX ESBD/TxSmartBuy non-TxDOT (TxDOT lettings ARE available via qh8x-rm8r above), OH, NC, MI, and Periscope-based portals for IL/MA/NJ live bids.
- Portal exists but carries no procurement datasets: PA (data.pa.gov is live; scoped catalog has 0 bid/vendor/procurement datasets matching). Michigan (data.michigan.gov) was checked 2026-09-21 and carries only NIGP commodity code reference tables (w3u3-uptp 9,333 rows; jv5q-yp8x 235 rows) — not procurement transactions.
- No state-level open-data portal: FL (data.fl.gov NXDOMAIN), GA (data.georgia.gov NXDOMAIN). These states have no keyless state procurement data source — this is a measured absence, not a connectivity block.
`;
}
