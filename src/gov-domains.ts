/**
 * get.gov — the authoritative US .gov domain registry (CISA). KEYLESS.
 *
 * The .gov program (run by CISA) publishes the COMPLETE registry as CSVs in its
 * official repo github.com/cisagov/dotgov-data — the canonical published location
 * (get.gov links there; there is no query API for the full set). It is NOT a .gov
 * API host, so provenance is disclosed on every response (the ProPublica /
 * CourtListener republisher pattern — except here CISA is the first-party registrar).
 *
 * B2G value: resolve WHICH organization owns a .gov domain, enumerate federal
 * agencies, and MAP SLED entities (state / county / city / school-district /
 * special-district / tribal) for market targeting — a distinct authoritative
 * gov-org registry no other tool here exposes.
 *
 * SSRF: fixed host `raw.githubusercontent.com` + fixed path prefix
 * `/cisagov/dotgov-data/main/` + a scope-selected FIXED filename (federal | full) —
 * no free host, path, or filename. `redirect:"error"` on the fetch.
 *
 * PII: the CSV carries a "Security contact email" column (an ORG security mailbox,
 * e.g. security@agency.gov). We DROP it — this tool resolves ORGANIZATIONS, not
 * contacts, and excluding it keeps the output free of contact info.
 *
 * Filtering is CLIENT-SIDE over the full published CSV (the registry has no query
 * API) — disclosed in `_meta.notes`. `totalAvailable` is the EXACT match count.
 */

import { getText } from "./datasource.js";
import { driftError } from "./datasource.js";
import { memoize } from "./cache.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

export const DOTGOV_HOST = "raw.githubusercontent.com";
const DOTGOV_PATH_PREFIX = "https://raw.githubusercontent.com/cisagov/dotgov-data/main/";

// scope → the pinned filename (no free path). "all" = federal + SLED (~16k rows),
// "federal" = federal only (~1.3k rows).
const DOTGOV_FILES = {
  all: "current-full.csv",
  federal: "current-federal.csv",
} as const;
export type GovDomainScope = keyof typeof DOTGOV_FILES;

const SOURCE_LABEL = "getgov:cisagov/dotgov-data";
const PROVENANCE_NOTE =
  "Source: the CISA get.gov OFFICIAL .gov domain registry, published as CSV at github.com/cisagov/dotgov-data (the canonical location; get.gov links there). CISA is the first-party .gov registrar; this is authoritative public data served from GitHub, not a .gov API host.";
const CLIENT_FILTER_NOTE =
  "The registry has no query API — the full published CSV is fetched and filtered CLIENT-SIDE (organization/domain/city are case-insensitive SUBSTRING matches; state/domainType are case-insensitive). totalAvailable is the EXACT count of matching rows.";
const FRESHNESS_NOTE =
  "The CISA dotgov-data CSV is refreshed ~daily; this response reflects the currently-published snapshot (served from a 6-hour cache).";
const EMAIL_DROP_NOTE =
  "The registry's 'Security contact email' column (an organization security mailbox) is intentionally EXCLUDED — this tool resolves organizations, not contacts.";

export type GovDomainRow = {
  domain: string;
  domainType: string;
  organization: string;
  suborganization: string | null;
  city: string | null;
  state: string | null;
};

// ─── Minimal RFC-4180 CSV parser (quoted fields + embedded commas/newlines) ──
/**
 * Parse a full CSV document into rows of string fields. Handles double-quoted
 * fields, escaped `""` quotes, and commas/newlines INSIDE quotes. Self-contained
 * (no external dep) — the get.gov CSV is small (~1.4 MB) so a whole-string parse is
 * fine. Returns every record's raw field array (including the header row).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // consume the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // CRLF: the \n case pushes the record; ignore the stray CR.
    } else {
      field += c;
    }
  }
  // Flush a trailing field/row if the file did not end with a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Coerce a CSV field to a trimmed non-empty string, else null (never ""). */
function s(v: string | undefined): string | null {
  if (v === undefined) return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Fetch + parse ONE scope's registry CSV into rows, memoized ~6h. Header-mapped by
 * COLUMN NAME (not fixed index) so an upstream column reorder does not silently
 * mis-map; a missing required header ⇒ schema_drift (never a fake-empty). The
 * "Security contact email" column is dropped at the map step.
 */
async function loadRegistry(scope: GovDomainScope): Promise<GovDomainRow[]> {
  return memoize(`getgov:${scope}`, async () => {
    const url = `${DOTGOV_PATH_PREFIX}${DOTGOV_FILES[scope]}`;
    // Belt-and-suspenders SSRF: the URL is built only from the pinned prefix +
    // pinned filename, but assert it before the fetch.
    const built = new URL(url);
    if (built.hostname !== DOTGOV_HOST || built.protocol !== "https:") {
      throw driftError(
        SOURCE_LABEL,
        `Constructed get.gov URL host ${JSON.stringify(built.hostname)} is not ${DOTGOV_HOST} over https — refusing to fetch (SSRF safety).`,
      );
    }
    const text = await getText(url, { label: SOURCE_LABEL, redirect: "error", timeoutMs: 20_000 });
    const rows = parseCsv(text);
    const headerRow = rows[0];
    if (!headerRow) {
      throw driftError(SOURCE_LABEL, "get.gov registry CSV was empty — treating as schema drift, never a fake-empty result.");
    }
    const header = headerRow.map((h) => h.trim());
    const idx = (name: string) => header.indexOf(name);
    const iDomain = idx("Domain name");
    const iType = idx("Domain type");
    const iOrg = idx("Organization name");
    const iSub = idx("Suborganization name");
    const iCity = idx("City");
    const iState = idx("State");
    // The four load-bearing columns MUST be present (a rename ⇒ schema drift, not a
    // silently mis-mapped/empty result).
    if (iDomain < 0 || iType < 0 || iOrg < 0) {
      throw driftError(
        SOURCE_LABEL,
        `get.gov registry CSV header is missing a required column (Domain name / Domain type / Organization name) — schema drift. Got: ${header.join(", ")}.`,
      );
    }
    return rows.slice(1).map((r) => ({
      domain: (r[iDomain] ?? "").trim(),
      domainType: (r[iType] ?? "").trim(),
      organization: (r[iOrg] ?? "").trim(),
      suborganization: iSub >= 0 ? s(r[iSub]) : null,
      city: iCity >= 0 ? s(r[iCity]) : null,
      state: iState >= 0 ? s(r[iState]) : null,
      // NOTE: "Security contact email" is deliberately NOT read/emitted.
    }));
  });
}

// ─── Tool: search_gov_domains ─────────────────────────────────────
/**
 * Search the CISA get.gov .gov domain registry. Client-side filters over the
 * published CSV: organization/domain/city are case-insensitive SUBSTRING matches;
 * state (2-letter) and domainType are case-insensitive. scope 'all' (federal + SLED,
 * default) | 'federal'. Honest `_meta` (exact match total; provenance + client-side
 * disclosure).
 */
export async function searchGovDomains(args: {
  scope?: GovDomainScope;
  organization?: string;
  domain?: string;
  domainType?: string;
  state?: string;
  city?: string;
  limit?: number;
  offset?: number;
}): Promise<MetaBundle> {
  const scope: GovDomainScope = args.scope ?? "all";
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  const all = await loadRegistry(scope);

  const filtersApplied: string[] = [];
  const ci = (v: string | undefined) => (v ?? "").toLowerCase();
  const orgQ = ci(args.organization);
  const domQ = ci(args.domain);
  const typeQ = ci(args.domainType);
  const stateQ = ci(args.state);
  const cityQ = ci(args.city);
  if (args.organization !== undefined) filtersApplied.push("organization");
  if (args.domain !== undefined) filtersApplied.push("domain");
  if (args.domainType !== undefined) filtersApplied.push("domainType");
  if (args.state !== undefined) filtersApplied.push("state");
  if (args.city !== undefined) filtersApplied.push("city");

  const matched = all.filter((row) => {
    if (orgQ && !row.organization.toLowerCase().includes(orgQ)) return false;
    if (domQ && !row.domain.toLowerCase().includes(domQ)) return false;
    if (typeQ && !row.domainType.toLowerCase().includes(typeQ)) return false;
    if (stateQ && (row.state ?? "").toLowerCase() !== stateQ) return false;
    if (cityQ && !(row.city ?? "").toLowerCase().includes(cityQ)) return false;
    return true;
  });

  const totalAvailable = matched.length;
  const page = matched.slice(offset, offset + limit);
  const returned = page.length;
  const hasMore = offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  return withMeta(
    { scope, domains: page },
    {
      source: `getgov ${DOTGOV_FILES[scope]} (CISA .gov registry, keyless)`,
      keylessMode: true,
      returned,
      totalAvailable,
      truncated: hasMore,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: ["securityContactEmail (org mailbox — intentionally excluded)"],
      pagination: { offset, limit, hasMore, nextOffset },
      notes: [PROVENANCE_NOTE, CLIENT_FILTER_NOTE, FRESHNESS_NOTE, EMAIL_DROP_NOTE],
    } satisfies Partial<ResponseMeta>,
  );
}
