/**
 * OpenFEMA — keyless federal disaster declarations + emergency-assistance spend
 * (ADR-0016). A NEW DOMAIN: federal disaster declarations + FEMA Public Assistance
 * grants to state/local/tribal applicants (the SLED emergency-spend / B2G-adjacent
 * angle). Fully PUBLIC, KEYLESS (no key, no token, no header — OpenFEMA is
 * unauthenticated). Nth consumer of the fetch/map/meta shape after treasury /
 * edgar / socrata / ckan.
 *   Row query: https://www.fema.gov/api/open/{version}/{EntityName}?{OData params}
 *
 * REUSE (writes ZERO fetch/coercion/error code): `getJson`+`redirect:"error"`
 * (datasource.ts), `num`/`str` (coerce.ts), `driftError` (datasource.ts),
 * `withMeta`/`buildMeta` (meta.ts), the errors.ts taxonomy. COPIES (does NOT
 * import) the socrata/ckan fixed-host SSRF + honesty PATTERN. NEW (small): the
 * OData `$filter` builder (structured args → escaped filter string) + the
 * `FEMA_DATASETS` registry (entityName+version+per-tool field-whitelist pins).
 *
 * ★ THE TOTAL-HONESTY CRUX — `metadata.count` (`$inlinecount=allpages`).
 * OpenFEMA reports the exact FILTERED total in `metadata.count` — a real JSON
 * NUMBER — but ONLY when the query carries `$inlinecount=allpages`. WITHOUT it,
 * `metadata.count` is `0` — a SENTINEL, not the real total (live-verified
 * 2026-07-12: `?$top=1` → count:0; `?$top=1&$inlinecount=allpages` → count:70049).
 * So `getOpenFema` ALWAYS sets `$inlinecount=allpages` (inside the fetch fn, not
 * the caller — no code path can omit it) and reads `metadata.count` as
 * `totalAvailable`. Reading count off a query that omitted inlinecount would
 * report `totalAvailable:0` on a full page — a data-absence-as-zero lie. The count
 * is EXACT (respects the filter), so `hasMore`/`complete` are exact — NO
 * totalIsLowerBound / totalIsEstimated hedge.
 *
 * ★ Entity-keyed envelope (the shape quirk). Results live under `body[EntityName]`
 * (e.g. `body.DisasterDeclarationsSummaries`), NOT a fixed `results`/`data`. The
 * dataset registry carries the entity name, known ahead of the fetch. `metadata`
 * carries the exact filtered `count`.
 *
 * ★ SSRF guard (policy① — mirror socrata.ts / ckan.ts fixed-host). Fixed host
 * `www.fema.gov` + a CURATED dataset registry pinning `{entityName, version}` (no
 * free host, no free path, no free version — HMA's live v2→v4 drift is exactly why
 * version is pinned, never a caller param):
 *   1. `datasetKey` ∈ the frozen `FEMA_DATASETS` registry (belt-and-suspenders
 *      recheck in the fetch fn → invalid_input before any fetch);
 *   2. construct `https://www.fema.gov/api/open/${version}/${entityName}?${params}`
 *      (host + path segments come ONLY from the pinned registry entry — nothing
 *      caller-supplied interpolates into the path), then ASSERT the built URL's
 *      hostname === "www.fema.gov" and protocol === "https:" (else invalid_input);
 *   3. OData params via URLSearchParams — `$inlinecount`/`$top`/`$skip` set by the
 *      module; `$filter` is MODULE-BUILT from structured args against a per-tool
 *      field whitelist (NO raw caller `$filter` — no tool exposes one). String
 *      values escape a single-quote by DOUBLING it (`'`→`''`, e.g. `O'Brien` →
 *      `'O''Brien'`) then wrap in `'...'`; numbers are unquoted; booleans render
 *      `true`/`false`. An un-whitelisted field is rejected (invalid_input) — zero
 *      filter-injection surface AND guaranteed-valid, live-verified field names;
 *   4. `redirect:"error"` on every fetch — a direct-JSON endpoint 3xx is anomalous
 *      → fail closed, never follow off-host.
 *
 * ★ Silent-filter trap AVOIDED (unlike ECHO). A bad `$filter`/`$orderby` field is
 * NOT silently ignored — OpenFEMA returns HTTP 400 (live-verified). We never
 * present unfiltered-as-filtered. We still module-build `$filter` from a per-tool
 * whitelist (belt-and-suspenders: no 400 in normal use + no injection surface).
 *
 * ★ 200-HTML maintenance-page guard (ADR-0016 OQ1). FEMA's Drupal can serve an
 * "experiencing technical difficulties" HTML page. Observed failures were HTTP 404
 * (→ not_found, thrown before r.json()); but IF an outage returns that page at
 * HTTP 200, getJson's r.json() throws a SyntaxError. `getOpenFema` catches it →
 * `driftError` (never a fake-empty, and a clean classification). Shared getJson
 * stays byte-identical (the shape-drift check stays at the call site).
 *
 * ★ PER-DATASET FIELD NAMES DIFFER — live-verified (ADR-0016 M1). `state eq 'CA'`
 * works on DisasterDeclarationsSummaries (1689) but `stateAbbreviation` → HTTP 400
 * there; conversely `stateAbbreviation eq 'LA'` works on
 * PublicAssistanceFundedProjectsDetails (39444) but `state` → HTTP 400 there. Each
 * tool maps its user-facing `state` arg to ITS dataset's real OData field. Every
 * shipped filter below NARROWS its dataset (live-verified 2026-07-12); a field
 * that 400s or is silently ignored is NOT shipped.
 *
 * HMA v4 (HazardMitigationAssistanceProjects) is a 3rd-tool backlog item (per
 * ADR-0016 §3) — slice 1 ships the 2 core tools.
 */

import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { num } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` from this module (fema.num === coerce.num === socrata.num === ckan.num).
export { num };

// ─── Fixed host + curated dataset registry (SSRF core) ────────────
export const FEMA_HOST = "www.fema.gov";

// The HazardMitigationAssistanceProjects dataset filters on the FULL state NAME
// ('Alabama'), NOT the 2-letter code the SIBLING FEMA tools (PA/declarations) use —
// so a caller who naturally passes 'AL' (as those tools accept) would get a
// confidently-wrong empty (total:0). Map a 2-letter USPS code → the canonical FEMA
// full name so the HMA tool accepts EITHER form; a full name (or an unknown token)
// passes through unchanged. (Same confidently-wrong-empty class this codebase guards
// elsewhere — don't ship a new tool with that foot-gun.)
const US_STATE_ABBR_TO_NAME: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia",
  FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon",
  PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  PR: "Puerto Rico", VI: "Virgin Islands", GU: "Guam", AS: "American Samoa",
  MP: "Northern Mariana Islands",
};

/** Resolve a HMA `state` arg: a 2-letter USPS code → the FEMA full name; a full
 *  name (or any non-2-letter token) is returned unchanged. */
export function resolveHmaState(state: string): string {
  const t = state.trim();
  if (/^[A-Za-z]{2}$/.test(t)) {
    const full = US_STATE_ABBR_TO_NAME[t.toUpperCase()];
    if (full) return full;
  }
  return state;
}

/** A pinned dataset entry — the single source of truth for entityName + version
 *  + the per-tool $filter field whitelist + the amount fields to null-coerce. */
type FemaDatasetDef = {
  /** The OData EntityName — ALSO the envelope's results key (`body[entityName]`). */
  entityName: string;
  /** The per-dataset API version — PINNED, never a caller param (HMA drift). */
  version: string;
  /** The live-verified $filter field whitelist for THIS dataset (each NARROWS;
   *  a bad field → HTTP 400 — see ADR-0016 M1). Belt-and-suspenders: the builder
   *  rejects any field not in this set (invalid_input). */
  filterFields: ReadonlySet<string>;
  /** Amount fields to run through `num` (null-never-0): a real 0 stays 0, absent/
   *  ""/"null" → null. Empty for datasets with no money columns. */
  amountFields: readonly string[];
};

/**
 * The frozen dataset registry (SSRF core — no free host, no free path, no free
 * version). Each entry's count + fields are LIVE-VERIFIED keyless (2026-07-12).
 * Adding a dataset later = a registry edit + a live
 * `$top=1&$inlinecount=allpages` verify (entity key, version, count) + a test
 * note — NEVER a free runtime param. Re-verify periodically against
 * `/api/open/v1/DataSets` (versions drift: HMA already moved v2→v4).
 */
export const FEMA_DATASETS = {
  // SLED emergency spend — 803,904 rows (2026-07-12). stateAbbreviation is THIS
  // dataset's state field (`state` → HTTP 400 here). NO `applicantName` field
  // exists (only applicantId + applicationTitle).
  public_assistance: {
    entityName: "PublicAssistanceFundedProjectsDetails",
    version: "v2",
    filterFields: new Set([
      "stateAbbreviation", // state → 39444 for 'LA'
      "disasterNumber", // → 15 for 3638
      "applicantId", // → 8 for '015-UF5E0-00'
      "damageCategoryCode", // → 232398 for 'B'
      "incidentType", // → 80407 for 'Flood'
      "projectAmount", // ge 1e6 → 25284; le 10000 → 354953
      "declarationDate", // ge '2024-01-01' → 30082
    ]),
    amountFields: [
      "projectAmount",
      "federalShareObligated",
      "totalObligated",
      "mitigationAmount",
    ],
  },
  // Declared disasters — 70,049 rows (2026-07-12). `state` is THIS dataset's state
  // field (`stateAbbreviation` → HTTP 400 here). Program flags are BOOLEAN
  // (`eq true`; `eq 1` → HTTP 400).
  disaster_declarations: {
    entityName: "DisasterDeclarationsSummaries",
    version: "v2",
    filterFields: new Set([
      "state", // → 1689 for 'CA'
      "incidentType", // → 11346 for 'Flood'
      "declarationType", // DR 46462 / EM 21471 / FM 2116
      "fyDeclared", // → 2147 for 2024
      "disasterNumber", // → 64 for 4611
      "declarationDate", // ge '2024-01-01' → 5067
      "paProgramDeclared", // eq true → 65534
      "iaProgramDeclared", // eq true → 17187
    ]),
    amountFields: [],
  },
  // Hazard Mitigation Assistance projects — 56,034 rows (LIVE-VERIFIED 2026-07-16).
  // The disaster-RESILIENCE grant axis (HMGP/FMA/PDM/BRIC mitigation grants to
  // state/local/tribal subrecipients) — distinct from PA's disaster-RECOVERY spend.
  // The planned "3rd tool" of ADR-0016 §3. THIS dataset's `state` is the FULL state
  // NAME ('Alabama'; `stateAbbreviation` → HTTP 400). Every field below LIVE-VERIFIED
  // to NARROW (2026-07-16): state 2457/'Alabama', programArea 42657/'HMGP',
  // disasterNumber 330/1605, status 36123/'Closed', programFy 2780/2005, region
  // 15922/4, projectAmount ge 1e6 → 10257.
  hazard_mitigation: {
    entityName: "HazardMitigationAssistanceProjects",
    version: "v4",
    filterFields: new Set([
      "state",
      "programArea",
      "disasterNumber",
      "status",
      "programFy",
      "region",
      "projectAmount",
    ]),
    amountFields: [
      "projectAmount",
      "federalShareObligated",
      "initialObligationAmount",
      "netValueBenefits",
    ],
  },
} satisfies Record<string, FemaDatasetDef>;

export type FemaDatasetKey = keyof typeof FEMA_DATASETS;

const SOURCE_LABEL = "openfema:" + FEMA_HOST;

// ─── OData $filter builder (module-built; per-tool whitelist; escaped) ──
type FilterOp = "eq" | "ge" | "le";
export type FilterClause =
  | { field: string; op: FilterOp; type: "string"; value: string }
  | { field: string; op: FilterOp; type: "number"; value: number }
  | { field: string; op: FilterOp; type: "boolean"; value: boolean };

/** OData string-literal escaping: double every single-quote (`'` → `''`). This is
 *  the ONLY escaping OData needs for a `'...'` literal — zero injection surface. */
export function escapeODataString(v: string): string {
  return v.replace(/'/g, "''");
}

/** Render ONE clause's value: strings quoted+escaped, numbers bare, booleans
 *  `true`/`false`. */
function renderValue(c: FilterClause): string {
  switch (c.type) {
    case "string":
      return `'${escapeODataString(c.value)}'`;
    case "number":
      return String(c.value);
    case "boolean":
      return c.value ? "true" : "false";
  }
}

/**
 * Build the `$filter` string from structured clauses against the dataset's
 * whitelist. Each clause's field MUST be in `FEMA_DATASETS[datasetKey].filterFields`
 * (belt-and-suspenders — the tool functions only ever pass whitelisted fields, but
 * an un-whitelisted field is a hard invalid_input, never silently dropped). Returns
 * null when there are no clauses (⇒ no `$filter` param).
 */
export function buildFilter(
  datasetKey: FemaDatasetKey,
  clauses: FilterClause[],
): string | null {
  if (clauses.length === 0) return null;
  const allowed = FEMA_DATASETS[datasetKey].filterFields;
  return clauses
    .map((c) => {
      if (!allowed.has(c.field)) {
        throw new ToolErrorCarrier({
          kind: "invalid_input",
          message: `OpenFEMA $filter field ${JSON.stringify(c.field)} is not in the ${datasetKey} whitelist — refusing to build an un-whitelisted filter (SSRF/injection safety).`,
          retryable: false,
        });
      }
      return `${c.field} ${c.op} ${renderValue(c)}`;
    })
    .join(" and ");
}

// ─── fetch layer ──────────────────────────────────────────────────
export type FemaRow = Record<string, unknown>;

/**
 * GET one OpenFEMA dataset page. SSRF guard (belt-and-suspenders behind the pinned
 * registry): datasetKey ∈ registry, and the CONSTRUCTED URL's hostname ===
 * www.fema.gov (https). ALWAYS sets `$inlinecount=allpages` (the total-honesty
 * crux — no code path can omit it) + `redirect:"error"` (B1); NO headers (keyless).
 * Reuses errors.ts retry/timeout/taxonomy (429 → rate_limited; 5xx →
 * upstream_unavailable; 404 → not_found; 400 → invalid_input). A 200-non-JSON
 * (Drupal maintenance page) → SyntaxError → driftError (ADR-0016 OQ1). Returns the
 * parsed body (unknown; the caller validates the entity-keyed shape).
 */
async function getOpenFema(
  datasetKey: FemaDatasetKey,
  params: URLSearchParams,
): Promise<{ body: unknown; entityName: string }> {
  const def = FEMA_DATASETS[datasetKey];
  if (!def) {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `OpenFEMA dataset ${JSON.stringify(datasetKey)} is not in the curated registry. Allowed: ${Object.keys(FEMA_DATASETS).join(", ")}.`,
      retryable: false,
    });
  }
  // ★ ALWAYS send $inlinecount=allpages — WITHOUT it metadata.count is a 0
  // sentinel, not the real total (a data-absence-as-zero lie). Set HERE (not the
  // caller) so no code path can omit it. Dropping this line turns a fault test RED.
  params.set("$inlinecount", "allpages");

  const url = `https://${FEMA_HOST}/api/open/${def.version}/${def.entityName}?${params.toString()}`;
  // Belt-and-suspenders: host + path come ONLY from the pinned registry entry;
  // assert the built URL cannot have been steered off-host.
  const built = new URL(url);
  if (built.hostname !== FEMA_HOST || built.protocol !== "https:") {
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      message: `Constructed OpenFEMA URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${FEMA_HOST} over https — refusing to fetch (SSRF safety).`,
      retryable: false,
    });
  }

  let body: unknown;
  try {
    // Keyless ⇒ NO headers key (byte-clean init); B1 redirect:"error"; host-only
    // label → ToolError.upstreamEndpoint.
    body = await getJson(url, { label: SOURCE_LABEL, redirect: "error" });
  } catch (e) {
    // Preserve the structured taxonomy (404/429/5xx/400/timeout) unchanged.
    if (e instanceof ToolErrorCarrier) throw e;
    // ★ OQ1 — a 200 non-JSON body (Drupal "technical difficulties" HTML) makes
    // getJson's r.json() throw a SyntaxError. Classify it as schema_drift (an
    // honest THROW + a clean classification), never a fake-empty. Shared getJson
    // stays byte-identical (the check is at THIS call site).
    if (e instanceof SyntaxError) {
      throw driftError(
        SOURCE_LABEL,
        "OpenFEMA returned non-JSON at HTTP 200 — possible maintenance page",
      );
    }
    throw e;
  }
  return { body, entityName: def.entityName };
}

// ─── map + meta ───────────────────────────────────────────────────
const SHAPE_NOTE =
  "OpenFEMA OData envelope: rows live under the entity key (e.g. body.DisasterDeclarationsSummaries) and totalAvailable is the EXACT filtered total from metadata.count (we always send $inlinecount=allpages). Never inferred from the page length.";
const AMOUNT_NOTE =
  "Amount fields (projectAmount / federalShareObligated / totalObligated / mitigationAmount) are number|null — a real 0 stays 0; absent/empty is null (never 0).";
const DATE_NOTE =
  "Date filters use OData ISO compares on declarationDate; a bare 'YYYY-MM-DD' means midnight-UTC start of that day (pass a full ISO datetime for finer bounds; a 'to' bound is exclusive of intra-day times after midnight).";

/**
 * Coerce the declared amount fields through `num` (null-never-0): a real 0 stays
 * 0; absent/""/"null" → null. Every declared amount field is always present as
 * number|null in the output (honest "unknown", never a fabricated 0). Datasets
 * with no amount fields pass rows through verbatim.
 */
function coerceAmounts(
  rows: FemaRow[],
  amountFields: readonly string[],
): FemaRow[] {
  if (amountFields.length === 0) return rows;
  return rows.map((row) => {
    const out: FemaRow = { ...row };
    for (const f of amountFields) out[f] = num(out[f]);
    return out;
  });
}

/**
 * Validate the entity-keyed envelope + build the honest `_meta`. PRIMARY response:
 *   - `body[entityName]` MUST be an array → else driftError (nothing valid to return).
 *   - `metadata.count` MUST be a number (with $inlinecount it is the exact filtered
 *     total) → else driftError. `totalAvailable = num(metadata.count)` — the EXACT
 *     total, NEVER the page length (a wide page byte-truncates below $top).
 *   - pagination: offset=$skip, limit=$top, hasMore = offset+returned <
 *     totalAvailable (exact — no hedge), nextOffset. genuine-empty (count:0, []) →
 *     complete:true/0 (via buildMeta). outage/5xx/timeout/400/404 already THREW in
 *     getOpenFema (never a fake empty).
 */
function shapeResponse(args: {
  body: unknown;
  datasetKey: FemaDatasetKey;
  offset: number;
  limit: number;
  filtersApplied: string[];
}): MetaBundle {
  const def = FEMA_DATASETS[args.datasetKey];
  const b = (args.body ?? {}) as {
    metadata?: { count?: unknown };
  } & Record<string, unknown>;

  const rawRows = b[def.entityName];
  if (!Array.isArray(rawRows)) {
    throw driftError(
      SOURCE_LABEL,
      `OpenFEMA ${def.entityName} returned an unexpected shape (body[${JSON.stringify(def.entityName)}] must be an array of rows).`,
    );
  }
  // ★ The single most important honesty line: totalAvailable is the EXACT filtered
  // metadata.count, NEVER rows.length. typeof-check BEFORE num() (num cannot tell a
  // non-number from an absent one). Mutating this to rows.length must turn a test RED.
  if (typeof b.metadata?.count !== "number") {
    throw driftError(
      SOURCE_LABEL,
      `OpenFEMA ${def.entityName} returned a non-number metadata.count — with $inlinecount=allpages it must be the exact filtered total; treating as schema drift.`,
    );
  }
  const totalAvailable = num(b.metadata.count);

  const rows = coerceAmounts(rawRows as FemaRow[], def.amountFields);
  const returned = rows.length;
  // `returned > 0` guard (matches nvd/usaspending): an EMPTY page MUST terminate the
  // walk. OpenFEMA's metadata.count can EXCEED the rows it will actually serve via
  // $skip/$top (live: the ~822k-row public_assistance set stops serving rows well
  // before its count), so without this guard a near-end offset yields returned:0 while
  // offset < count ⇒ hasMore:true, nextOffset === offset — a non-advancing cursor an
  // agent following nextOffset re-requests forever (empty page, re-scan, repeat).
  const hasMore =
    returned > 0 && totalAvailable !== null && args.offset + returned < totalAvailable;
  const nextOffset = hasMore ? args.offset + returned : null;

  const notes: string[] = [SHAPE_NOTE];
  if (def.amountFields.length > 0) notes.push(AMOUNT_NOTE);
  if (args.filtersApplied.some((f) => /date/i.test(f))) notes.push(DATE_NOTE);
  // Byte-cap disclosure: a wide page can byte-truncate below $top while more rows
  // remain — metadata.count is authoritative, so page via $skip.
  if (returned < args.limit && hasMore) {
    notes.push(
      "This page returned fewer rows than the requested limit while more remain (OpenFEMA byte-truncates a wide page below $top); metadata.count is authoritative — page with a larger offset ($skip).",
    );
  }
  // Phantom tail: OpenFEMA returned 0 rows though metadata.count is higher — its count
  // can exceed the rows it will serve via pagination, so the walk is COMPLETE here even
  // though returned:0 < count. Disclose it so the count is not read as a reachable target.
  if (returned === 0 && totalAvailable !== null && args.offset > 0 && args.offset < totalAvailable) {
    notes.push(
      `OpenFEMA served 0 rows at offset ${args.offset} although metadata.count is ${totalAvailable} — its count can exceed the rows actually pageable via $skip/$top, so pagination is COMPLETE here (do not treat count as a reachable row target; narrow the filter for an exact set).`,
    );
  }
  // Deep-offset caveat on the ~800k PA set (ADR-0016 OQ2).
  if (args.offset > 100000) {
    notes.push(
      "Deep offset (>100000): very deep $skip into a large dataset may degrade upstream; prefer narrowing the filter over paging deep.",
    );
  }

  return withMeta(
    {
      dataset: def.entityName,
      rows,
    },
    {
      source: `OpenFEMA ${def.entityName} (keyless)`,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied: args.filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset: args.offset, limit: args.limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Tool 1: fema_search_public_assistance ────────────────────────
/**
 * Search FEMA Public Assistance funded projects (SLED emergency spend to state /
 * local / tribal applicants). Dataset PublicAssistanceFundedProjectsDetails v2.
 * Structured filters → module-built `$filter` (each field LIVE-VERIFIED to narrow):
 *   state → stateAbbreviation eq · disasterNumber eq · applicantId eq ·
 *   damageCategoryCode eq (e.g. "B" = Emergency Protective Measures) ·
 *   incidentType eq · minProjectAmount → projectAmount ge · maxProjectAmount →
 *   projectAmount le · declaredDateFrom/To → declarationDate ge/le.
 * Rows carry projectAmount / federalShareObligated / totalObligated /
 * mitigationAmount as number|null. Honest `_meta` (totalAvailable = exact filtered
 * metadata.count).
 */
export async function searchPublicAssistance(args: {
  state?: string;
  disasterNumber?: number;
  applicantId?: string;
  damageCategoryCode?: string;
  incidentType?: string;
  minProjectAmount?: number;
  maxProjectAmount?: number;
  declaredDateFrom?: string;
  declaredDateTo?: string;
  limit?: number;
  offset?: number;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;

  const clauses: FilterClause[] = [];
  const filtersApplied: string[] = [];
  if (args.state !== undefined) {
    clauses.push({ field: "stateAbbreviation", op: "eq", type: "string", value: args.state });
    filtersApplied.push("state");
  }
  if (args.disasterNumber !== undefined) {
    clauses.push({ field: "disasterNumber", op: "eq", type: "number", value: args.disasterNumber });
    filtersApplied.push("disasterNumber");
  }
  if (args.applicantId !== undefined) {
    clauses.push({ field: "applicantId", op: "eq", type: "string", value: args.applicantId });
    filtersApplied.push("applicantId");
  }
  if (args.damageCategoryCode !== undefined) {
    clauses.push({ field: "damageCategoryCode", op: "eq", type: "string", value: args.damageCategoryCode });
    filtersApplied.push("damageCategoryCode");
  }
  if (args.incidentType !== undefined) {
    clauses.push({ field: "incidentType", op: "eq", type: "string", value: args.incidentType });
    filtersApplied.push("incidentType");
  }
  if (args.minProjectAmount !== undefined) {
    clauses.push({ field: "projectAmount", op: "ge", type: "number", value: args.minProjectAmount });
    filtersApplied.push("minProjectAmount");
  }
  if (args.maxProjectAmount !== undefined) {
    clauses.push({ field: "projectAmount", op: "le", type: "number", value: args.maxProjectAmount });
    filtersApplied.push("maxProjectAmount");
  }
  if (args.declaredDateFrom !== undefined) {
    clauses.push({ field: "declarationDate", op: "ge", type: "string", value: args.declaredDateFrom });
    filtersApplied.push("declaredDateFrom");
  }
  if (args.declaredDateTo !== undefined) {
    clauses.push({ field: "declarationDate", op: "le", type: "string", value: args.declaredDateTo });
    filtersApplied.push("declaredDateTo");
  }

  const params = new URLSearchParams();
  params.set("$top", String(limit));
  params.set("$skip", String(offset));
  const filter = buildFilter("public_assistance", clauses);
  if (filter) params.set("$filter", filter);

  const { body } = await getOpenFema("public_assistance", params);
  return shapeResponse({ body, datasetKey: "public_assistance", offset, limit, filtersApplied });
}

// ─── Tool 2: fema_disaster_declarations ───────────────────────────
/**
 * Look up FEMA disaster / emergency declarations. Dataset
 * DisasterDeclarationsSummaries v2. Structured filters → module-built `$filter`
 * (each field LIVE-VERIFIED to narrow):
 *   state → state eq · incidentType eq (e.g. "Flood") · declarationType eq
 *   (DR/EM/FM) · fyDeclared eq · disasterNumber eq · declaredDateFrom/To →
 *   declarationDate ge/le · paProgramDeclared / iaProgramDeclared → eq true/false
 *   (BOOLEAN — `eq 1` 400s upstream).
 * Honest `_meta` (totalAvailable = exact filtered metadata.count).
 */
export async function disasterDeclarations(args: {
  state?: string;
  incidentType?: string;
  declarationType?: string;
  fyDeclared?: number;
  disasterNumber?: number;
  declaredDateFrom?: string;
  declaredDateTo?: string;
  paProgramDeclared?: boolean;
  iaProgramDeclared?: boolean;
  limit?: number;
  offset?: number;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;

  const clauses: FilterClause[] = [];
  const filtersApplied: string[] = [];
  if (args.state !== undefined) {
    clauses.push({ field: "state", op: "eq", type: "string", value: args.state });
    filtersApplied.push("state");
  }
  if (args.incidentType !== undefined) {
    clauses.push({ field: "incidentType", op: "eq", type: "string", value: args.incidentType });
    filtersApplied.push("incidentType");
  }
  if (args.declarationType !== undefined) {
    clauses.push({ field: "declarationType", op: "eq", type: "string", value: args.declarationType });
    filtersApplied.push("declarationType");
  }
  if (args.fyDeclared !== undefined) {
    clauses.push({ field: "fyDeclared", op: "eq", type: "number", value: args.fyDeclared });
    filtersApplied.push("fyDeclared");
  }
  if (args.disasterNumber !== undefined) {
    clauses.push({ field: "disasterNumber", op: "eq", type: "number", value: args.disasterNumber });
    filtersApplied.push("disasterNumber");
  }
  if (args.declaredDateFrom !== undefined) {
    clauses.push({ field: "declarationDate", op: "ge", type: "string", value: args.declaredDateFrom });
    filtersApplied.push("declaredDateFrom");
  }
  if (args.declaredDateTo !== undefined) {
    clauses.push({ field: "declarationDate", op: "le", type: "string", value: args.declaredDateTo });
    filtersApplied.push("declaredDateTo");
  }
  if (args.paProgramDeclared !== undefined) {
    clauses.push({ field: "paProgramDeclared", op: "eq", type: "boolean", value: args.paProgramDeclared });
    filtersApplied.push("paProgramDeclared");
  }
  if (args.iaProgramDeclared !== undefined) {
    clauses.push({ field: "iaProgramDeclared", op: "eq", type: "boolean", value: args.iaProgramDeclared });
    filtersApplied.push("iaProgramDeclared");
  }

  const params = new URLSearchParams();
  params.set("$top", String(limit));
  params.set("$skip", String(offset));
  const filter = buildFilter("disaster_declarations", clauses);
  if (filter) params.set("$filter", filter);

  const { body } = await getOpenFema("disaster_declarations", params);
  return shapeResponse({ body, datasetKey: "disaster_declarations", offset, limit, filtersApplied });
}

// ─── Tool 3: fema_search_hazard_mitigation ────────────────────────
/**
 * Search FEMA Hazard Mitigation Assistance projects (the disaster-RESILIENCE grant
 * axis — HMGP/FMA/PDM/BRIC mitigation grants to state/local/tribal subrecipients,
 * distinct from Public Assistance's disaster-RECOVERY spend). Dataset
 * HazardMitigationAssistanceProjects v4. Structured filters → module-built `$filter`
 * (each field LIVE-VERIFIED to narrow):
 *   state → state eq (FULL state NAME, e.g. "Alabama" — NOT the 2-letter code;
 *   stateAbbreviation 400s here) · programArea eq (HMGP / FMA / PDM / BRIC / LPDM /
 *   FMA-SL) · disasterNumber eq · status eq (e.g. "Closed") · programFy eq ·
 *   region eq (FEMA region number 1–10) · minProjectAmount → projectAmount ge ·
 *   maxProjectAmount → projectAmount le.
 * Rows carry projectAmount / federalShareObligated / initialObligationAmount /
 * netValueBenefits as number|null. Honest `_meta` (totalAvailable = exact filtered
 * metadata.count).
 */
export async function searchHazardMitigation(args: {
  state?: string;
  programArea?: string;
  disasterNumber?: number;
  status?: string;
  programFy?: number;
  region?: number;
  minProjectAmount?: number;
  maxProjectAmount?: number;
  limit?: number;
  offset?: number;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;

  const clauses: FilterClause[] = [];
  const filtersApplied: string[] = [];
  if (args.state !== undefined) {
    // Accept a 2-letter code (as the sibling FEMA tools do) OR a full name — HMA's
    // upstream filters on the FULL name, so a bare 'AL' would silently return 0.
    clauses.push({ field: "state", op: "eq", type: "string", value: resolveHmaState(args.state) });
    filtersApplied.push("state");
  }
  if (args.programArea !== undefined) {
    clauses.push({ field: "programArea", op: "eq", type: "string", value: args.programArea });
    filtersApplied.push("programArea");
  }
  if (args.disasterNumber !== undefined) {
    clauses.push({ field: "disasterNumber", op: "eq", type: "number", value: args.disasterNumber });
    filtersApplied.push("disasterNumber");
  }
  if (args.status !== undefined) {
    clauses.push({ field: "status", op: "eq", type: "string", value: args.status });
    filtersApplied.push("status");
  }
  if (args.programFy !== undefined) {
    clauses.push({ field: "programFy", op: "eq", type: "number", value: args.programFy });
    filtersApplied.push("programFy");
  }
  if (args.region !== undefined) {
    clauses.push({ field: "region", op: "eq", type: "number", value: args.region });
    filtersApplied.push("region");
  }
  if (args.minProjectAmount !== undefined) {
    clauses.push({ field: "projectAmount", op: "ge", type: "number", value: args.minProjectAmount });
    filtersApplied.push("minProjectAmount");
  }
  if (args.maxProjectAmount !== undefined) {
    clauses.push({ field: "projectAmount", op: "le", type: "number", value: args.maxProjectAmount });
    filtersApplied.push("maxProjectAmount");
  }

  const params = new URLSearchParams();
  params.set("$top", String(limit));
  params.set("$skip", String(offset));
  const filter = buildFilter("hazard_mitigation", clauses);
  if (filter) params.set("$filter", filter);

  const { body } = await getOpenFema("hazard_mitigation", params);
  return shapeResponse({ body, datasetKey: "hazard_mitigation", offset, limit, filtersApplied });
}
