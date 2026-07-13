/**
 * Pricing tier (keyless) — labor-rate grounding for federal-contract pricing.
 *
 * Three keyless tools, every endpoint LIVE-VERIFIED 2026-07-03:
 *   - sam_search_wage_determinations → SAM SGS search (index=sca|dbra)
 *   - sam_get_wage_rates            → SAM WDOL detail (rates parsed from TEXT)
 *   - gsa_benchmark_labor_rates     → GSA CALC v3 ceiling-rate distribution
 *
 * The defining constraint of the two SAM tools: the actual wage RATES live
 * inside a plain-text `document` blob (a fixed-width wage-determination form),
 * NOT structured JSON. So `sam_get_wage_rates` parses best-effort and ALWAYS
 * exposes a `parseConfidence` + a `format:"parsed"|"raw"|"both"` escape hatch so
 * an AI can read the raw text when parsing is low-confidence. Truthfulness is
 * the product: we never fake structure and we disclose every caveat in `_meta`.
 *
 * The defining constraint of the CALC tool: it returns a DISTRIBUTION of
 * awarded CEILING (catalog) rates that are FULLY BURDENED — never a single
 * "the rate". Its total count SATURATES at 10000 (relation:"gte") for broad
 * queries. It honors page_size up to at least 200 (we request 100 rows/page),
 * and its rows are GLOBALLY sorted ASCENDING by current_price. So when the exact
 * total is KNOWN we read the true min/median/max at the quantile RANKS of that
 * sorted index (exact stats over all matches, from a few targeted pages — NOT a
 * leading subsample); only when the count is SATURATED (true total unknown) do we
 * fall back to a leading-rows sample and DISCLOSE median/max as a downward-biased
 * lower bound. A drifted CALC envelope (no hits{} / hits.hits not an array / no
 * numeric total) THROWS schema_drift rather than fabricating an empty distribution.
 */

import { fetchWithRetry, ToolErrorCarrier } from "./errors.js";
import { withMeta } from "./meta.js";

// ─── Shared HTTP ─────────────────────────────────────────────────

// SAM's public SGS/WDOL endpoints gate on a browser-y User-Agent AND require
// `Accept: application/hal+json` (SCA detail can 406 without it). Mirror the
// SamGovClient's UA so behavior is consistent across the server.
const SAM_UA =
  "Mozilla/5.0 (compatible; @cliwant/mcp-sam-gov; +https://github.com/cliwant/mcp-sam-gov)";
const SAM_HAL_HEADERS = {
  Accept: "application/hal+json",
  "User-Agent": SAM_UA,
} as const;

const SGS_BASE = "https://sam.gov/api/prod/sgs/v1/search";
const WDOL_BASE = "https://sam.gov/api/prod/wdol/v1/wd";
const CALC_BASE =
  "https://api.gsa.gov/acquisition/calc/v3/api/ceilingrates/";

async function getJson<T>(
  url: string,
  headers: Record<string, string>,
  label: string,
  timeoutMs = 15_000,
): Promise<T> {
  const r = await fetchWithRetry(
    url,
    { headers, signal: AbortSignal.timeout(timeoutMs) },
    label,
  );
  return (await r.json()) as T;
}

// ─── Coverage normalization ──────────────────────────────────────

/**
 * Map the user-facing coverage enum to the SGS `index`. CRITICAL: the API
 * accepts `sca` and `dbra` — a literal `dba` returns HTTP 400, so we normalize
 * `dba`→`dbra` (LIVE-VERIFIED 2026-07-03).
 */
function coverageToIndex(coverage: string): "sca" | "dbra" {
  const c = coverage.trim().toLowerCase();
  if (c === "sca") return "sca";
  // dba, dbra, davis-bacon → dbra
  return "dbra";
}

// ─── 1. sam_search_wage_determinations ───────────────────────────

const WD_SEARCH_SOURCE = "sam.gov/sgs/v1 search (keyless HAL)";

type SgsStateSca = {
  code?: string;
  name?: string;
  isStateWide?: boolean;
  counties?: {
    include?: { code?: number | string; value?: string }[] | null;
    exclude?: { code?: number | string; value?: string }[] | null;
  } | null;
};

type SgsResult = {
  fullReferenceNumber?: string;
  shortReferenceNumber?: string;
  revisionNumber?: number;
  type?: { code?: string; value?: string };
  title?: string;
  isActive?: boolean;
  isStandard?: boolean;
  publishDate?: number | string;
  modifiedDate?: number | string;
  year?: number;
  rollover?: boolean;
  constructionTypes?: unknown;
  services?: { code?: string; value?: string }[];
  allReferenceNumbers?: { wdNumber?: string }[];
  // SCA: location.states[]; DBA: location.state (single) + counties[]
  location?: {
    states?: SgsStateSca[];
    state?: {
      code?: string;
      name?: string;
      counties?: { code?: number | string; value?: string }[] | null;
    };
    additionalInfo?: unknown;
  };
};

type SgsSearchResp = {
  _embedded?: { results?: SgsResult[] };
  page?: {
    size?: number;
    totalElements?: number;
    totalPages?: number;
    number?: number;
    maxAllowedRecords?: number;
  };
};

/** Normalize a state code from either the SCA or DBA location shape. */
function resultStateCodes(r: SgsResult): string[] {
  const codes = new Set<string>();
  for (const s of r.location?.states ?? []) {
    if (s.code) codes.add(String(s.code).toUpperCase());
  }
  const single = r.location?.state?.code;
  if (single) codes.add(String(single).toUpperCase());
  return [...codes];
}

/** Normalize the county list (name + code) from either shape. */
function resultCounties(r: SgsResult): { code: string; name: string }[] {
  const out: { code: string; name: string }[] = [];
  for (const s of r.location?.states ?? []) {
    for (const c of s.counties?.include ?? []) {
      if (c.value) out.push({ code: String(c.code ?? ""), name: c.value });
    }
  }
  for (const c of r.location?.state?.counties ?? []) {
    if (c.value) out.push({ code: String(c.code ?? ""), name: c.value });
  }
  return out;
}

function epochToIso(v: number | string | undefined): string | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n)) {
    // SGS publish/modified dates are epoch ms.
    const d = new Date(n);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  // Some fields already come as YYYY-MM-DD.
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
}

export async function searchWageDeterminations(args: {
  coverage: string;
  state?: string;
  county?: string;
  query?: string;
  activeOnly?: boolean;
  standardOnly?: boolean;
  limit?: number;
  page?: number;
}) {
  const index = coverageToIndex(args.coverage);
  const activeOnly = args.activeOnly ?? true;
  const standardOnly = args.standardOnly ?? true;
  const limit = Math.min(50, Math.max(1, Math.floor(args.limit ?? 20)));
  const page = Math.max(0, Math.floor(args.page ?? 0));
  const stateFilter = args.state?.trim().toUpperCase() || undefined;
  const countyFilter = args.county?.trim().toLowerCase() || undefined;

  const params = new URLSearchParams({
    index,
    size: String(limit),
    page: String(page),
    mode: "search",
    sort: "-modifiedDate",
  });
  if (activeOnly) params.set("is_active", "true");
  if (standardOnly) params.set("is_standard", "true");
  // `q` matches WD number/title ONLY (NOT occupation) — verified q=guard→0.
  if (args.query) params.set("q", args.query);
  // `state` IS honored server-side (LIVE-VERIFIED 2026-07-03: index=sca&state=VA
  // → 30 vs 1028 unfiltered, and every returned WD's location contains VA;
  // state=ZZ → 0). It wants the 2-letter USPS code (a full name like "Virginia"
  // → 0). This CORRECTS the earlier brief which assumed state was ignored.
  const filtersApplied: string[] = [`coverage(${index})`];
  const filtersDropped: string[] = [];
  const notes: string[] = [];
  if (activeOnly) filtersApplied.push("activeOnly");
  if (standardOnly) filtersApplied.push("standardOnly");
  if (args.query) filtersApplied.push("query(WD number/title only)");
  if (stateFilter) {
    if (/^[A-Z]{2}$/.test(stateFilter)) {
      params.set("state", stateFilter);
      filtersApplied.push("state(server-side)");
    } else {
      // Not a 2-letter code → the server would return 0; apply client-side
      // instead so a full name still works, and disclose it.
      filtersDropped.push("state(server-side; not a 2-letter code)");
      notes.push(
        `The state value '${args.state}' is not a 2-letter USPS code; the SGS 'state' param only matches 2-letter codes (a full name returns 0), so it was applied CLIENT-SIDE over the fetched page instead. Pass a 2-letter code (e.g. 'VA') for a precise server-side filter.`,
      );
    }
  }

  const url = `${SGS_BASE}?${params.toString()}`;
  const json = await getJson<SgsSearchResp>(url, SAM_HAL_HEADERS, `sam:sgs:${index}`);
  const rawResults = json._embedded?.results ?? [];
  const serverTotal = json.page?.totalElements ?? null;

  // Client-side filtering: county is NOT a documented SGS server param, so it
  // is applied here over the fetched page. A non-2-letter state also lands here.
  const needsClientState = filtersDropped.some((f) => f.startsWith("state"));
  let filtered = rawResults;
  if (needsClientState && stateFilter) {
    filtered = filtered.filter((r) =>
      resultStateCodes(r).some((c) => c === stateFilter || r.location?.state?.name?.toUpperCase() === stateFilter),
    );
  }
  if (countyFilter) {
    filtersApplied.push("county(client-side)");
    filtered = filtered.filter((r) =>
      resultCounties(r).some((c) => c.name.toLowerCase().includes(countyFilter)),
    );
    notes.push(
      "County is filtered CLIENT-SIDE over the fetched page only (the SGS API has no county filter). A county filter combined with a small limit can miss WDs on later pages — raise `limit` or narrow by `state` (server-side) to be sure.",
    );
  }

  const determinations = filtered.map((r) => {
    const coverageCode = r.type?.code ?? (index === "sca" ? "SCA" : "DBA");
    return {
      fullReferenceNumber: r.fullReferenceNumber ?? "",
      shortReferenceNumber: r.shortReferenceNumber ?? null,
      revisionNumber: r.revisionNumber ?? null,
      coverage: coverageCode, // "SCA" | "DBA"
      title: r.title ?? null,
      isActive: r.isActive ?? null,
      isStandard: r.isStandard ?? null,
      publishDate: epochToIso(r.publishDate),
      modifiedDate: epochToIso(r.modifiedDate),
      states: resultStateCodes(r),
      counties: resultCounties(r).map((c) => c.name),
      // SCA-only extras when present.
      services: (r.services ?? []).map((s) => s.value ?? s.code ?? "").filter(Boolean),
      // DBA-only extras.
      year: r.year ?? null,
      constructionTypes: r.constructionTypes ?? null,
      allReferenceNumbers: (r.allReferenceNumbers ?? [])
        .map((a) => a.wdNumber)
        .filter((x): x is string => Boolean(x)),
    };
  });

  notes.push(
    `Use sam_get_wage_rates with a fullReferenceNumber + revisionNumber to read the actual prevailing-wage rate table (the rates are parsed from the WD's plain-text document). ${index === "sca" ? "SCA WDs carry a WD-wide Health & Welfare rate." : "DBA WDs carry PER-CRAFT fringe rates."}`,
  );
  notes.push(
    "The `q` parameter matches the WD number/title only — it does NOT search by occupation or job title (e.g. q=guard returns 0). To find rates for a specific occupation, open the WD and read its rate table.",
  );

  // totalAvailable: the server total is REAL for the coverage/active/standard/
  // query/state filters (state is server-side). But when we additionally filter
  // client-side (county, or a non-code state), the returned page count no longer
  // reflects a full server total for THAT combined filter → null it out and say so.
  const clientFiltered = Boolean(countyFilter) || needsClientState;
  const totalAvailable = clientFiltered ? null : serverTotal;
  const returned = determinations.length;
  const truncated = clientFiltered
    ? true // page-bounded client filter → can't prove completeness
    : serverTotal !== null && page * limit + returned < serverTotal;

  if (clientFiltered) {
    notes.push(
      "totalAvailable is null because a client-side filter (county and/or a non-code state) was applied over just the fetched page — the true match count for the combined filter is unknown. The server-side total for the coverage/state/active filters was " +
        (serverTotal ?? "unknown") +
        ".",
    );
  }

  return withMeta(
    { determinations, coverageIndex: index, page, limit },
    {
      source: WD_SEARCH_SOURCE,
      keylessMode: true,
      returned,
      totalAvailable,
      truncated,
      pagination: {
        offset: page * limit,
        limit,
        nextOffset: truncated ? (page + 1) * limit : null,
        hasMore: truncated,
      },
      filtersApplied,
      filtersDropped,
      fieldsUnavailable: [],
      notes,
    },
  );
}

// ─── 2. sam_get_wage_rates ───────────────────────────────────────

const WD_DETAIL_SOURCE = "sam.gov/wdol/v1 wd detail (keyless HAL)";

type WdDetailResp = {
  fullReferenceNumber?: string;
  revisionNumber?: number;
  location?: {
    mapping?: { state?: string; counties?: (number | string)[]; statewideFlag?: boolean }[];
  };
  document?: string;
  constructionType?: string;
  shortName?: string;
  year?: number;
  publishDate?: string;
  active?: boolean;
  standard?: boolean;
};

type WdHistoryResp = {
  _embedded?: {
    wageDetermination?: {
      fullReferenceNumber?: string;
      revisionNumber?: number;
      publishDate?: string;
      active?: boolean;
      standard?: boolean;
    }[];
  };
};

/** Resolve the latest ACTIVE revision for a WD reference via /history. */
async function latestActiveRevision(
  fullReferenceNumber: string,
): Promise<number | null> {
  const url = `${WDOL_BASE}/${encodeURIComponent(fullReferenceNumber)}/history`;
  const json = await getJson<WdHistoryResp>(url, SAM_HAL_HEADERS, "sam:wdol:history");
  const revs = json._embedded?.wageDetermination ?? [];
  // Newest-first per the API; prefer the newest active, else the newest overall.
  const active = revs.find((r) => r.active && typeof r.revisionNumber === "number");
  if (active?.revisionNumber !== undefined) return active.revisionNumber;
  const any = revs.find((r) => typeof r.revisionNumber === "number");
  return any?.revisionNumber ?? null;
}

/**
 * Parse an SCA `document` blob into rate rows + WD-wide H&W + EO minimum.
 *
 * SCA fixed-width lines look like:
 *   `01011 - Accounting Clerk I                       22.78`
 * (5-digit occupation code, title, trailing hourly base rate). Section headers
 * like `01000 - Administrative Support ...` have NO trailing rate → skipped.
 * H&W is WD-wide: `HEALTH & WELFARE: $5.55 per hour ...`. The EO floor is read
 * from whichever EO the text cites (13658 or 14026) — never hardcoded.
 */
function parseScaDocument(doc: string) {
  const lines = doc.split(/\r?\n/);
  const rates: {
    code: string;
    title: string;
    baseRate: number;
    footnotes: number[] | null;
  }[] = [];
  // `01011 - Title .......... 22.78`  → code, title, rate (rate is the LAST
  // number on the line; titles never end in a bare decimal).
  const rateRe = /^\s*(\d{5})\s*-\s*(.+?)\s+(\d{1,3}\.\d{2})\s*$/;
  for (const line of lines) {
    const m = rateRe.exec(line);
    if (m && m[1] && m[2] && m[3]) {
      // Real SCA WDs carry a FOOTNOTE column: an occupation with special pay
      // rules shows "(see N)" between the title and the rate (e.g. Weather
      // Observers → night/Sunday differential; Computer Employees → FLSA
      // exemption). The footnote MATERIALLY changes pay, so extract it as a
      // structured signal and strip it from the title (collapsing the column
      // whitespace) rather than letting "(see 2)" + a run of spaces pollute the
      // occupation name. (Synthetic fixtures lacked this; found via real-WD replay.)
      const footnotes: number[] = [];
      const title = m[2]
        .replace(/\(see\s*(\d+)\)/gi, (_full, n) => {
          footnotes.push(Number(n));
          return " ";
        })
        .replace(/\.+$/, "")
        .replace(/\s+/g, " ")
        .trim();
      rates.push({
        code: m[1],
        title,
        baseRate: Number(m[3]),
        footnotes: footnotes.length ? footnotes : null,
      });
    }
  }

  // WD-wide Health & Welfare — prefer the plain "HEALTH & WELFARE: $X" line
  // (there is also a separate "HEALTH & WELFARE EO 13706: $Y" sick-leave line;
  // capture the primary one, not the EO-13706 variant).
  let healthAndWelfarePerHour: number | null = null;
  for (const line of lines) {
    const hw = /HEALTH\s*&\s*WELFARE\s*:\s*\$?\s*(\d+\.\d{2})\s*per hour/i.exec(line);
    if (hw && hw[1]) {
      healthAndWelfarePerHour = Number(hw[1]);
      break;
    }
  }

  const eo = parseExecutiveOrderMinimum(doc);

  // Confidence: high when we found a plausible number of coded rates AND a H&W.
  const parseConfidence: "high" | "low" =
    rates.length >= 5 && healthAndWelfarePerHour !== null ? "high" : "low";

  return { rates, healthAndWelfarePerHour, executiveOrderMinimum: eo, parseConfidence };
}

/**
 * Parse a DBA `document` blob into per-craft rate + fringe rows.
 *
 * DBA lines carry two money columns under a `Rates   Fringes` header:
 *   `ELECTRICIAN......................$ 34.50   10.81`
 * BUT the craft label frequently WRAPS across several lines (a long scope
 * description), and only the LAST line of the wrap carries the `$ rate fringe`:
 *   `BRICKLAYER/STONE MASON: ZONE 1 (The Counties of `
 *   `Polk, Warren, and Dallas for all Crafts, and Linn `
 *   `County Carpenters only.)............................$ 37.44   19.17`
 * So we ACCUMULATE the non-rate lines and, when a rate line closes a block,
 * join them into the full label. We also expose a short `craft` (the class name
 * before the first ':' or '(') so the AI has a clean occupation name. DBA fringe
 * is PER-CRAFT (contrast SCA's single WD-wide H&W). A rate-identifier header
 * (e.g. "SAIA2026-001", "CARP1319") is tracked as `rateIdentifier`.
 */
function parseDbaDocument(doc: string) {
  const lines = doc.split(/\r?\n/);
  const rates: {
    craft: string;
    title: string;
    baseRate: number;
    fringePerHour: number | null;
    rateIdentifier: string | null;
  }[] = [];
  // The rate is the LAST money column(s) on the closing line.
  const rateLineRe = /^(.*?)\.*\$\s*(\d{1,3}\.\d{2})(?:\s+(\d{1,3}\.\d{2}))?\s*$/;
  // A union/rate identifier header: e.g. "CARP1319", "SAIA2026-001", "PLUM0198-005".
  const idRe = /^\s*([A-Z]{2,5}\d{3,4}(?:-\d{2,3})?)\b/;

  let buffer: string[] = [];
  let currentId: string | null = null;
  for (const raw of lines) {
    const line = raw ?? "";
    const idm = idRe.exec(line);
    if (idm && idm[1] && !/\$/.test(line)) {
      currentId = idm[1];
      // An identifier header is not part of a craft label.
      continue;
    }
    const m = rateLineRe.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      // Closing line of a (possibly wrapped) craft block.
      const tail = m[1];
      const fullLabel = [...buffer, tail]
        .join(" ")
        .replace(/\.{2,}/g, " ") // collapse dot leaders
        .replace(/\s+/g, " ")
        // Strip the "Rates   Fringes" column header if it bled into the label
        // (it can precede the first craft with no blank line between).
        .replace(/^\s*Rates\s+Fringes\s*/i, "")
        .replace(/\s*\)\s*$/, ")")
        .trim();
      buffer = [];
      if (fullLabel && /[A-Za-z]/.test(fullLabel)) {
        // Short craft class = text before the first ':' or '(' (the scope).
        const craft = fullLabel.split(/[:(]/)[0]?.trim() || fullLabel;
        rates.push({
          craft,
          title: fullLabel,
          baseRate: Number(m[2]),
          fringePerHour: m[3] !== undefined ? Number(m[3]) : null,
          rateIdentifier: currentId,
        });
      }
      continue;
    }
    // A non-rate, non-id content line → part of a wrapping craft label. Ignore
    // pure separators / page furniture (dashes, blank lines) and the column
    // header row.
    const trimmed = line.trim();
    if (/^Rates\s+Fringes$/i.test(trimmed)) {
      buffer = [];
    } else if (trimmed && !/^[-_=]{3,}$/.test(trimmed) && /[A-Za-z]/.test(trimmed)) {
      buffer.push(trimmed);
    } else {
      // Blank or separator resets an in-progress wrap so stray text never
      // bleeds into the next craft.
      buffer = [];
    }
  }
  const eo = parseExecutiveOrderMinimum(doc);
  const parseConfidence: "high" | "low" = rates.length >= 3 ? "high" : "low";
  return { rates, executiveOrderMinimum: eo, parseConfidence };
}

/**
 * Read the EO minimum-wage floor from the WD text. The document cites EO 13658
 * OR EO 14026 with a "at least $XX.XX per hour" figure — we read whichever the
 * text carries (both the EO number and the dollar figure) and NEVER hardcode.
 */
function parseExecutiveOrderMinimum(
  doc: string,
): { executiveOrder: string; minimumWage: number } | null {
  // Look for "$XX.XX per hour" appearing near an "Executive Order NNNNN" cite.
  // The canonical phrasing is "... must pay all covered workers at least
  // $13.65 per hour ...". Prefer a line/paragraph that also names the EO.
  const eoNumMatch = /Executive Order\s+(\d{5})/i.exec(doc);
  const wageMatch = /at least\s+\$\s*(\d{1,2}\.\d{2})\s+per hour/i.exec(doc);
  if (wageMatch && wageMatch[1]) {
    return {
      executiveOrder: eoNumMatch && eoNumMatch[1] ? `EO ${eoNumMatch[1]}` : "unknown",
      minimumWage: Number(wageMatch[1]),
    };
  }
  return null;
}

export async function getWageRates(args: {
  reference: string;
  revision?: number;
  coverage?: string;
  format?: "parsed" | "raw" | "both";
}) {
  const format = args.format ?? "parsed";
  const reference = args.reference.trim();

  // Resolve the revision: use the caller's, else the latest ACTIVE via /history.
  let revision = args.revision;
  let revisionResolvedFromHistory = false;
  if (revision === undefined || revision === null) {
    const latest = await latestActiveRevision(reference);
    if (latest === null) {
      throw new ToolErrorCarrier({
        kind: "not_found",
        message: `No wage-determination history found for reference '${reference}' on sam.gov/wdol. Verify the fullReferenceNumber via sam_search_wage_determinations.`,
        retryable: false,
        upstreamEndpoint: `wdol/v1/wd/${reference}/history`,
      });
    }
    revision = latest;
    revisionResolvedFromHistory = true;
  }

  const url = `${WDOL_BASE}/${encodeURIComponent(reference)}/${encodeURIComponent(String(revision))}`;
  // A genuinely-absent WD → structured not_found; a 5xx/429 stays retryable
  // (fetchWithRetry throws a classified ToolErrorCarrier — do not swallow).
  let detail: WdDetailResp;
  try {
    detail = await getJson<WdDetailResp>(url, SAM_HAL_HEADERS, "sam:wdol:detail");
  } catch (e) {
    if (e instanceof ToolErrorCarrier && e.toolError.kind === "not_found") {
      throw new ToolErrorCarrier({
        kind: "not_found",
        message: `No wage determination found at ${reference}/${revision} on sam.gov/wdol. Resolve a valid reference+revision via sam_search_wage_determinations.`,
        retryable: false,
        upstreamEndpoint: `wdol/v1/wd/${reference}/${revision}`,
      });
    }
    throw e;
  }

  const doc = detail.document ?? "";
  if (!doc) {
    throw new ToolErrorCarrier({
      kind: "schema_drift",
      message: `Wage determination ${reference}/${revision} returned no document text — cannot read rates.`,
      retryable: false,
      upstreamEndpoint: `wdol/v1/wd/${reference}/${revision}`,
    });
  }

  // Decide SCA vs DBA. Prefer the caller's hint; else infer from the reference
  // shape / document content (DBA refs are like "IA20260028" / craft columns).
  const coverageHint = args.coverage ? coverageToIndex(args.coverage) : null;
  const looksDba =
    coverageHint === "dbra" ||
    (coverageHint === null &&
      (/[A-Z]{2}\d{6,}/.test(reference) || /\bFringes\b/.test(doc)) &&
      !/^\d{4}-\d{4}$/.test(reference));
  const coverage: "SCA" | "DBA" = looksDba ? "DBA" : "SCA";

  const sourceUrl = `https://sam.gov/wage-determination/${reference}/${revision}`;
  const notes: string[] = [];
  const fieldsUnavailable: string[] = [];

  let parsed:
    | ReturnType<typeof parseScaDocument>
    | ReturnType<typeof parseDbaDocument>
    | null = null;
  let parseConfidence: "high" | "low" = "low";
  const data: Record<string, unknown> = {
    reference,
    revision,
    coverage,
    active: detail.active ?? null,
    standard: detail.standard ?? null,
    publishDate: detail.publishDate ?? null,
    sourceUrl,
    locationMapping: (detail.location?.mapping ?? []).map((m) => ({
      state: m.state ?? null,
      counties: m.counties ?? [],
      statewide: m.statewideFlag ?? false,
    })),
  };

  if (format !== "raw") {
    if (coverage === "SCA") {
      const p = parseScaDocument(doc);
      parsed = p;
      parseConfidence = p.parseConfidence;
      data.rates = p.rates;
      data.healthAndWelfarePerHour = p.healthAndWelfarePerHour;
      data.executiveOrderMinimumWage = p.executiveOrderMinimum;
      if (p.healthAndWelfarePerHour === null) {
        fieldsUnavailable.push("healthAndWelfarePerHour");
      }
      notes.push(
        "SCA wage determination: `healthAndWelfarePerHour` is a WD-WIDE Health & Welfare rate that applies to ALL listed occupations (it is NOT per-occupation). Each rate row's `baseRate` is the hourly minimum for that occupation code.",
      );
      if (p.rates.some((r) => r.footnotes && r.footnotes.length)) {
        notes.push(
          "Some occupations carry `footnotes` (the WD's numbered '(see N)' markers) — these signal MATERIAL extra pay rules (e.g. night/Sunday differential, FLSA exemption) beyond the listed baseRate. The footnote NUMBERS are surfaced per rate row; call again with format:'raw' (or 'both') to read the exact footnote text.",
        );
      }
    } else {
      const p = parseDbaDocument(doc);
      parsed = p;
      parseConfidence = p.parseConfidence;
      data.rates = p.rates;
      data.executiveOrderMinimumWage = p.executiveOrderMinimum;
      notes.push(
        "DBA (Davis-Bacon) wage determination: each rate row carries its OWN `fringePerHour` (fringe is PER-CRAFT, not a single WD-wide figure). Craft labels are parsed from a fixed-width text form and may include wrapped scope text; set format:'raw' to read the exact document.",
      );
    }
    data.parseConfidence = parseConfidence;
    if (parsed && parsed.executiveOrderMinimum === null) {
      fieldsUnavailable.push("executiveOrderMinimumWage");
      notes.push(
        "No Executive Order minimum-wage figure could be parsed from this WD's text.",
      );
    } else if (parsed && parsed.executiveOrderMinimum) {
      notes.push(
        `Executive-order minimum-wage FLOOR parsed from the WD text: ${parsed.executiveOrderMinimum.executiveOrder} at $${parsed.executiveOrderMinimum.minimumWage.toFixed(2)}/hour. This floor is read from whichever EO the document cites (13658 vs 14026) and applies on top of any lower listed base rate.`,
      );
    }
    if (parseConfidence === "low") {
      notes.push(
        "parseConfidence is LOW — the fixed-width layout did not match cleanly. Prefer the raw `document` text (call again with format:'raw' or 'both') rather than trusting the parsed rows.",
      );
    }
  }

  if (format === "raw" || format === "both") {
    data.document = doc;
  }
  if (format === "raw") {
    // Raw mode: we deliberately do not assert parsed structure.
    data.parseConfidence = "low";
    notes.push(
      "format:'raw' — the full wage-determination text is returned in `document`; no rate parsing was applied.",
    );
  }

  notes.push(
    "Wage rates are PARSED best-effort from the WD's plain-text document (SAM does not expose them as structured JSON)." +
      (revisionResolvedFromHistory
        ? ` Revision ${revision} was resolved as the latest ACTIVE revision via /history (you did not pass one).`
        : ""),
  );

  return withMeta(data, {
    source: WD_DETAIL_SOURCE,
    keylessMode: true,
    returned: Array.isArray(data.rates) ? (data.rates as unknown[]).length : 1,
    totalAvailable: Array.isArray(data.rates) ? (data.rates as unknown[]).length : 1,
    truncated: false,
    filtersApplied: [`coverage(${coverage})`, `revision(${revision})`],
    filtersDropped: [],
    fieldsUnavailable,
    notes,
  });
}

// ─── 3. gsa_benchmark_labor_rates ────────────────────────────────

const CALC_SOURCE = "api.gsa.gov CALC v3 ceilingrates (keyless)";

type CalcSource = {
  labor_category?: string;
  current_price?: number;
  next_year_price?: number;
  second_year_price?: number;
  education_level?: string;
  min_years_experience?: number;
  business_size?: string;
  security_clearance?: string | boolean;
  worksite?: string;
  sin?: string;
  schedule?: string;
  vendor_name?: string;
  idv_piid?: string;
  contract_start?: string;
  contract_end?: string;
};

type CalcResp = {
  hits?: {
    total?: { value?: number; relation?: string };
    hits?: { _source?: CalcSource }[];
  };
};

// Filters LIVE-VERIFIED to narrow via `filter=field:value` (2026-07-03):
// business_size, education_level (uses SHORT CODES like BA/MA/AA/HS/PHD — the
// returned field shows full words too, so codes≠displayed), min_years_experience,
// experience_range, sin. price_range / security_clearance / worksite did NOT
// narrow via filter and are treated as non-filterable here (price_range re-
// confirmed a no-op 2026-07-05 and again 2026-07-12 — see F1 in the handler).
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? null;
  if (hi === null) return null;
  if (sorted.length % 2 === 0) {
    const lo = sorted[mid - 1] ?? hi;
    return (lo + hi) / 2;
  }
  return hi;
}

/**
 * Shape-drift guard for the CALC v3 envelope. A valid 200 MUST carry
 * `hits:{ total:{ value:<number> }, hits:[…] }`. A drifted shape — `hits`
 * null/absent/non-object, `hits.hits` not an array, or `hits.total.value` not a
 * number — would otherwise be SILENTLY mapped to an empty/degraded distribution
 * (a fabricated-empty). So we THROW schema_drift instead (mirrors the getWageRates
 * empty-document discipline in this file). A GENUINE zero-results response — a
 * well-formed envelope with `hits.hits:[]` and `total.value:0` — PASSES the guard
 * and stays an honest empty; ONLY a shape drift throws.
 */
function assertCalcEnvelope(resp: CalcResp, label: string): void {
  const hits = (resp as { hits?: unknown }).hits;
  if (hits === null || typeof hits !== "object" || Array.isArray(hits)) {
    throw new ToolErrorCarrier({
      kind: "schema_drift",
      message: `GSA CALC v3 (${label}) returned an HTTP 200 without a hits{} object — the ceilingrates envelope changed. Refusing to fabricate an empty rate distribution.`,
      retryable: false,
      upstreamEndpoint: CALC_BASE,
    });
  }
  const h = hits as { hits?: unknown; total?: unknown };
  if (!Array.isArray(h.hits)) {
    throw new ToolErrorCarrier({
      kind: "schema_drift",
      message: `GSA CALC v3 (${label}) returned an HTTP 200 whose hits.hits is not an array — the ceilingrates envelope changed. Refusing to fabricate an empty rate distribution.`,
      retryable: false,
      upstreamEndpoint: CALC_BASE,
    });
  }
  const total = h.total as { value?: unknown } | null | undefined;
  if (total === null || typeof total !== "object" || typeof total.value !== "number") {
    throw new ToolErrorCarrier({
      kind: "schema_drift",
      message: `GSA CALC v3 (${label}) returned an HTTP 200 without a numeric hits.total.value — the ceilingrates total envelope changed. Refusing to fabricate a match count.`,
      retryable: false,
      upstreamEndpoint: CALC_BASE,
    });
  }
}

export async function benchmarkLaborRates(args: {
  laborCategory: string;
  businessSize?: string;
  educationLevel?: string;
  minYearsExperience?: number;
  experienceRange?: string;
  sin?: string;
  priceRange?: string;
  maxSamplePages?: number;
}) {
  const laborCategory = args.laborCategory.trim();
  // Page in bounded chunks to build a representative distribution sample
  // without unbounded fetching. CALC honors page_size up to at least 200
  // (LIVE-VERIFIED), so 100 rows/page captures most categories' full
  // population within the default page budget.
  const PAGE_ROWS = 100;
  const maxSamplePages = Math.min(10, Math.max(1, Math.floor(args.maxSamplePages ?? 3)));

  const filters: string[] = [];
  const filtersApplied: string[] = ["laborCategory(exact)"];
  const filtersDropped: string[] = [];
  if (args.businessSize) {
    filters.push(`business_size:${args.businessSize}`);
    filtersApplied.push(`businessSize`);
  }
  if (args.educationLevel) {
    filters.push(`education_level:${args.educationLevel}`);
    filtersApplied.push(`educationLevel`);
  }
  if (args.minYearsExperience !== undefined) {
    filters.push(`min_years_experience:${args.minYearsExperience}`);
    filtersApplied.push(`minYearsExperience`);
  }
  if (args.experienceRange) {
    filters.push(`experience_range:${args.experienceRange}`);
    filtersApplied.push(`experienceRange`);
  }
  if (args.sin) {
    filters.push(`sin:${args.sin}`);
    filtersApplied.push(`sin`);
  }
  if (args.priceRange) {
    // F1 (P4 no-silent-filter, HIGH — money domain): CALC v3 IGNORES the
    // price_range filter — it does NOT narrow the result set (LIVE-RE-CONFIRMED
    // 2026-07-12: `search=labor_category:Paralegal` returns total {value:10,
    // relation:"eq"} with the SAME rows whether price_range is absent, 1000-2000,
    // or 200-300). Claiming it in filtersApplied — and advising an agent to use
    // it to narrow — would be a money-domain lie (the distribution below is over
    // the UN-narrowed set). So we do NOT send the no-op param, and disclose it as
    // DROPPED (never applied) with a best-effort note (see the notes block).
    filtersDropped.push("priceRange");
  }

  function buildUrl(matcher: "search" | "q", page: number): string {
    const p = new URLSearchParams();
    if (matcher === "search") p.set("search", `labor_category:${laborCategory}`);
    else p.set("q", laborCategory);
    p.set("page", String(page));
    p.set("page_size", String(PAGE_ROWS));
    p.set("ordering", "current_price");
    let qs = p.toString();
    for (const f of filters) qs += `&filter=${encodeURIComponent(f)}`;
    return `${CALC_BASE}?${qs}`;
  }

  // Primary: exact field match. Fall back to loose `q` ONLY if exact returns 0.
  let matcher: "search" | "q" = "search";
  let first = await getJson<CalcResp>(buildUrl("search", 1), { Accept: "application/json" }, "gsa:calc:search");
  // Shape-drift guard BEFORE reading the total (a drifted `hits:null` would read as
  // totalValue 0, silently trigger the `q` fallback, and end as a fabricated-empty).
  assertCalcEnvelope(first, "search");
  let totalValue = first.hits?.total?.value ?? 0;
  let totalRelation = first.hits?.total?.relation ?? "eq";
  let fuzzy = false;
  if (totalValue === 0) {
    const q = await getJson<CalcResp>(buildUrl("q", 1), { Accept: "application/json" }, "gsa:calc:q");
    assertCalcEnvelope(q, "q");
    if ((q.hits?.total?.value ?? 0) > 0) {
      matcher = "q";
      fuzzy = true;
      first = q;
      totalValue = q.hits?.total?.value ?? 0;
      totalRelation = q.hits?.total?.relation ?? "eq";
    }
  }

  // ── Build the current-price distribution ────────────────────────────────
  // CALC serves a GLOBALLY ascending-by-current_price list and reports an exact
  // `total` for non-saturated queries (descending sort → HTTP 406; the
  // `price_range` filter does NOT narrow — both LIVE-VERIFIED 2026-07-05). So the
  // first N rows are the CHEAPEST N: sampling only those and reporting
  // min/median/max understates the distribution badly (a 2000+-row category
  // understated its median by ~35% and its max by ~70% in practice). When the
  // total is KNOWN we therefore read the EXACT min/median/max by paging straight
  // to the quantile RANKS, touching only a few targeted pages. Only when the
  // count is SATURATED (true total unknown) do we fall back to a leading-rows
  // sample — and then we DISCLOSE that median/max are a downward-biased lower
  // bound, never presenting them as the true distribution.
  const saturated = totalRelation !== "eq"; // e.g. "gte" at the 10000 cap
  const matchCount = totalValue;

  const firstRows = (first.hits?.hits ?? []).map((h) => h._source ?? {});
  const pageCache = new Map<number, CalcSource[]>([[1, firstRows]]);
  async function rowsForPage(pg: number): Promise<CalcSource[]> {
    const cached = pageCache.get(pg);
    if (cached) return cached;
    const r = await getJson<CalcResp>(
      buildUrl(matcher, pg),
      { Accept: "application/json" },
      "gsa:calc:page",
    );
    assertCalcEnvelope(r, `page ${pg}`);
    const pr = (r.hits?.hits ?? []).map((h) => h._source ?? {});
    pageCache.set(pg, pr);
    return pr;
  }
  // Exact current_price at a 0-indexed GLOBAL rank in the ascending list. Sets
  // `rankClamped` if the requested offset isn't present (CALC limited deep
  // paging, or the total exceeded the paginable rows) so we DOWNGRADE from
  // "exact" rather than silently report a clamped (low) value as the truth.
  let rankClamped = false;
  async function priceAtRank(rank: number): Promise<number | null> {
    const pg = Math.floor(rank / PAGE_ROWS) + 1;
    const off = rank % PAGE_ROWS;
    const pr = await rowsForPage(pg);
    let row = pr[off];
    if (row === undefined) {
      rankClamped = true;
      row = pr[pr.length - 1];
    }
    const v = row?.current_price;
    return typeof v === "number" ? v : null;
  }

  let currentRateStat: {
    min: number | null;
    median: number | null;
    max: number | null;
    n: number;
  };
  let statsExact: boolean;
  let rows: CalcSource[]; // rows backing the SOFT stats (escalation/education/samples)

  if (!saturated && matchCount > 0) {
    // EXACT path: read the true min/median/max by rank. For an even population
    // the median is the mean of the two central ranks.
    const minV = await priceAtRank(0);
    const maxV = await priceAtRank(matchCount - 1);
    let medianV: number | null;
    if (matchCount % 2 === 0) {
      const a = await priceAtRank(matchCount / 2 - 1);
      const b = await priceAtRank(matchCount / 2);
      medianV = a !== null && b !== null ? (a + b) / 2 : (a ?? b);
    } else {
      medianV = await priceAtRank((matchCount - 1) / 2);
    }
    // If a rank couldn't be reached (paging cap) or a price was missing, the
    // read is no longer provably exact — degrade honestly to the fallback story.
    statsExact =
      !rankClamped && minV !== null && medianV !== null && maxV !== null;
    currentRateStat = { min: minV, median: medianV, max: maxV, n: matchCount };
    // Soft stats run over the STRATIFIED union of the quantile pages we fetched
    // (low/median/high bands) — far more representative than the first N
    // cheapest rows, though not exhaustive.
    rows = [...pageCache.values()].flat();
  } else {
    // FALLBACK (saturated / unknown total): we cannot locate the quantile ranks,
    // so sample the leading (cheapest) pages. min stays exact; median/max are a
    // DISCLOSED downward-biased lower bound over the lowest-priced rows.
    for (let page = 2; page <= maxSamplePages; page++) {
      const pr = await rowsForPage(page);
      if (pr.length === 0) break;
      if (pr.length < PAGE_ROWS) break;
    }
    rows = [...pageCache.values()].flat();
    const cur = rows
      .map((r) => r.current_price)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);
    currentRateStat = {
      min: cur[0] ?? null,
      median: median(cur),
      max: cur[cur.length - 1] ?? null,
      n: cur.length,
    };
    statsExact = false;
  }

  const nextYear = rows.map((r) => r.next_year_price).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);
  const secondYear = rows.map((r) => r.second_year_price).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);

  // The distinct education_level values actually PRESENT in the fetched rows (the
  // vocabulary is inconsistent — a mix of codes and full words), so the AI sees
  // the real values rather than a fabricated canonical set.
  const educationLevelsInSample = [
    ...new Set(rows.map((r) => r.education_level).filter((x): x is string => Boolean(x))),
  ];

  const data = {
    laborCategory,
    matcher, // "search" (exact) | "q" (fuzzy fallback)
    fuzzy,
    matchCount,
    matchCountSaturated: saturated,
    filtersApplied: filters,
    sampleSize: rows.length,
    currentRate: currentRateStat,
    // Whether currentRate {min,median,max} are EXACT over all matches (read at
    // the quantile ranks) or a downward-biased lower bound over a leading sample
    // (saturated/unknown total). An AI must NOT read a biased median as the
    // market middle — this flag + the notes say which it is.
    currentRateExact: statsExact,
    escalatedRate: {
      nextYearMedian: median(nextYear),
      secondYearMedian: median(secondYear),
    },
    educationLevelsInSample,
    sampleRows: rows.slice(0, 10).map((r) => ({
      laborCategory: r.labor_category ?? null,
      currentRate: r.current_price ?? null,
      nextYearRate: r.next_year_price ?? null,
      secondYearRate: r.second_year_price ?? null,
      educationLevel: r.education_level ?? null,
      minYearsExperience: r.min_years_experience ?? null,
      businessSize: r.business_size ?? null,
      securityClearance: r.security_clearance ?? null,
      worksite: r.worksite ?? null,
      sin: r.sin ?? null,
      schedule: r.schedule ?? null,
      vendor: r.vendor_name ?? null,
      idvPiid: r.idv_piid ?? null,
    })),
  };

  const notes: string[] = [
    "CALC rates are awarded CEILING (catalog) rates from GSA schedule contracts — they are NOT actual task-order prices paid, and real competed prices are frequently lower.",
    "CALC rates are FULLY BURDENED (they already include the contractor's wrap: overhead, G&A, fringe, and fee) — do NOT re-apply a wrap rate on top.",
    "The escalatedRate medians (nextYear/secondYear) are each vendor's own contracted escalation, NOT a market escalation index — treat them as a distribution, not a forecast.",
    statsExact
      ? `currentRate {min, median, max} are EXACT over all ${matchCount} matches — read directly at the quantile ranks of CALC's ascending price-sorted index, NOT a leading subsample. (min/median/max come from separate paged requests, so under an active CALC index refresh they could reflect slightly different snapshots.) escalatedRate medians and educationLevelsInSample are computed over a ${rows.length}-row sample covering the low, median, and high price points, so treat those two as representative estimates rather than exhaustive.`
      : `currentRate.min is exact, but currentRate.median/max are computed over the ${rows.length} LOWEST-priced sampled row(s) and are a DOWNWARD-BIASED LOWER BOUND: CALC returns rows in ascending price order and the exact total was not known (saturated), so the true median/max are HIGHER than reported. Narrow with filters (businessSize, educationLevel code, minYearsExperience, sin) or a more specific laborCategory to get an exact count and unbiased statistics.`,
  ];
  if (args.priceRange) {
    // F1: disclose that priceRange was NOT applied (CALC v3 ignores it), so the
    // agent never treats the distribution as narrowed to that price band.
    notes.push(
      "priceRange was NOT applied and is reported in _meta.filtersDropped: GSA CALC v3 IGNORES the price_range filter (it does not narrow the result set — live-verified), so the counts/distribution above are over the UN-narrowed set. To narrow, use businessSize / educationLevel (code) / minYearsExperience / sin, or a more specific laborCategory, instead.",
    );
  }
  if (saturated) {
    notes.push(
      `matchCount is SATURATED: the API returned relation='${totalRelation}' at ${matchCount}, so the true match total is AT LEAST ${matchCount} (unknown exact). totalAvailable is null. Narrow with filters (businessSize, educationLevel code, minYearsExperience, sin) or a more specific laborCategory for an exact count.`,
    );
  }
  if (fuzzy) {
    notes.push(
      `No exact labor_category match for '${laborCategory}' — FELL BACK to a loose keyword (q) match, which is broad and low-precision (q matches many unrelated categories). Treat these results as FUZZY; refine the laborCategory to a canonical CALC label for a precise band.`,
    );
  }
  if (args.educationLevel) {
    notes.push(
      "CALC's education_level FILTER expects short codes (e.g. BA, MA, AA, HS, PHD) — the returned education_level FIELD may show full words ('Bachelors','Masters','High School') for the same rows, so filter values differ from displayed values. If the filter did not narrow, try the short-code form. See educationLevelsInSample for the actual returned vocabulary.",
    );
  }

  return withMeta(data, {
    source: CALC_SOURCE,
    keylessMode: true,
    returned: rows.length,
    // totalAvailable is REAL only when relation === "eq"; saturated → null.
    totalAvailable: saturated ? null : matchCount,
    // `truncated` keeps its codebase-wide meaning: fewer rows were RETURNED than
    // exist (we page only to the quantile ranks, not the whole set). Distribution
    // completeness is a SEPARATE signal — `currentRateExact` above — so a consumer
    // is never told "complete data" when only a sample of rows came back, yet also
    // learns the min/median/max are exact.
    truncated: rows.length < matchCount,
    filtersApplied,
    filtersDropped,
    fieldsUnavailable: [],
    notes,
  });
}
