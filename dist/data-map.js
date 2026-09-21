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
/**
 * Verified 2026-09-21 — all keyless.
 */
export const DATA_MAP_ENTRIES = [
    // ── State-level ──────────────────────────────────────────────────────────
    {
        state: "VA",
        jurisdiction: "Virginia",
        dataLabel: "eVA PO line items 2023",
        tool: "ckan_query",
        keyArgs: "host=data.virginia.gov, resourceId=3c7f1bde-35b0-4fbf-b89c-978a19124d53",
        rows: 1693227,
        approximate: false,
        notNote: "the live eVA portal (login-gated)",
        extra: "Years 2016–2026 have separate resourceIds; ckan_discover_datasets host=data.virginia.gov q=eVA procurement lists them (2024=25a59527, 2025=b8dc22a8, 2026=76f6831d)",
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
        notNote: "rows are bid LINE ITEMS not projects (8,861 rows = 412 distinct project_ids — report project count not row count); TxDOT highway lettings ONLY, not all Texas procurement; rolling window only (past lettings dropped, cannot answer historical questions); ESBD/TxSmartBuy non-TxDOT solicitations are absent",
        extra: "★First live state solicitation feed in this map. Use $select=count(distinct project_id) for open-bid count.",
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
];
/** Format a row count for display */
function fmtRows(e) {
    if (e.rows === null)
        return "?";
    const n = e.rows >= 1000000 ? `${Math.round(e.rows / 1000000)}M` :
        e.rows >= 1000 ? `${(e.rows / 1000).toFixed(0).replace(/\.0$/, "")}k` :
            String(e.rows);
    return e.approximate ? `~${n}` : n;
}
/**
 * Render the state-level entries as a Markdown table.
 * Matches the format in SKILL.md §State & local data map.
 */
export function renderStateTableMarkdown() {
    const header = "| Jurisdiction | Data | Tool · key args | Rows | NOT |\n" +
        "|---|---|---|---|---|\n";
    const rows = DATA_MAP_ENTRIES.map((e) => {
        const extra = e.extra ? ` ${e.extra}` : "";
        return `| **${e.jurisdiction}** | ${e.dataLabel} | \`${e.tool}\` ${e.keyArgs} | ${fmtRows(e)} | ${e.notNote}${extra} |`;
    });
    return header + rows.join("\n");
}
/** Full resource content: header + state table */
export function renderDataMapMarkdown() {
    return `# State & local data map

Agent-readable lookup: jurisdiction → data type → exact tool call → verified row count → what it is NOT (the most common source of agent error).

**State-level open-data sources (verified 2026-09-21, all keyless):**

${renderStateTableMarkdown()}

**County & city** — use \`socrata_discover_datasets\` to find dataset IDs for: NYC (data.cityofnewyork.us), Chicago (data.cityofchicago.org), Austin TX (data.austintexas.gov), Dallas TX (www.dallasopendata.com), LA (controllerdata.lacity.org), King County WA (data.kingcounty.gov), Cook County IL (datacatalog.cookcountyil.gov), Montgomery County MD (data.montgomerycountymd.gov). For Hennepin County MN and Charlotte-Mecklenburg NC capital project pipelines, use \`arcgis_feature_query\` (hennepin_transportation_cip / charlotte_mecklenburg_cip) — these are CIP pipelines, NOT solicitation or award registers.

**State portals with no keyless procurement content (measured absence, not unexplored):**
- Login-gated or WAF-blocked live-bid portals: CA (Cal eProcure), TX ESBD/TxSmartBuy non-TxDOT (TxDOT lettings ARE available via qh8x-rm8r above), OH, NC, MI, and Periscope-based portals for IL/MA/NJ live bids.
- Portal exists but carries no procurement datasets: PA (data.pa.gov is live; scoped catalog has 0 bid/vendor/procurement datasets matching).
- No state-level open-data portal: FL (data.fl.gov NXDOMAIN), GA (data.georgia.gov NXDOMAIN). These states have no keyless state procurement data source — this is a measured absence, not a connectivity block.
`;
}
//# sourceMappingURL=data-map.js.map