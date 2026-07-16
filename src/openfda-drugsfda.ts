/**
 * openfda-drugsfda.ts — openFDA DRUG APPROVALS (Drugs@FDA, api.fda.gov) — the
 * PHARMA REGULATORY-APPROVAL lane. FDA-approved drug applications (NDA/ANDA/BLA):
 * the sponsor, the application number, each approved product (brand/generic name,
 * dosage form, route, marketing status), and the submission/approval history.
 * Answers "what drugs did sponsor X get approved, and which are still marketed" —
 * pharma vendor product/approval intelligence.
 *
 * ★ SAME SOURCE + ENVELOPE + CRUX as openfda.ts / openfda-device.ts (ADR-0054/0056).
 *   Same host (api.fda.gov), same envelope `{ meta:{ results:{ skip,limit,total }},
 *   results:[…] }`, same ★no-match→HTTP-404-NOT_FOUND-as-honest-empty crux, same
 *   optional query-key K-test, same fixed-host SSRF idiom, same structured-only (no
 *   raw Lucene passthrough) search. REUSES openfda.ts's `fetchOpenfda`,
 *   `readOpenfdaError`, `luceneQuote`, `openfdaApiKey`, `OPENFDA_HOST` verbatim.
 *
 *   GET https://api.fda.gov/drug/drugsfda.json?search=<lucene>&limit=&skip=[&api_key=]
 *   → { meta:{ results:{ skip,limit,total }}, results:[ { application_number,
 *       sponsor_name, products:[…], submissions:[…] } ] }.
 *
 * ★ HONESTY (mirrors the siblings exactly): [P1] totalAvailable = meta.results.total
 *   EXACT (never results.length); skip/limit offset pagination. [★P2] 404 NOT_FOUND
 *   ⇒ honest empty (never thrown); other 4xx ⇒ invalid_input surfacing openFDA's
 *   message; 5xx/429 ⇒ THROW. [P3] every scalar via `str` (null-never-""); nested
 *   products/submissions arrays default to [] and each field is str (never fabricated).
 *   [P4] meta.results / results absent-or-mis-shaped ⇒ driftError. [K-test] the
 *   OPTIONAL OPENFDA_API_KEY rides ONLY &api_key=; label/source name mode only.
 *   [SSRF] fixed host; all VALUES Lucene-escaped + phrase-quoted via URLSearchParams.
 */

import { ToolErrorCarrier, errorFromResponse } from "./errors.js";
import { driftError } from "./datasource.js";
import { str } from "./coerce.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";
import {
  OPENFDA_HOST,
  fetchOpenfda,
  readOpenfdaError,
  luceneQuote,
  openfdaApiKey,
} from "./openfda.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** host+path-only label (→ ToolError.upstreamEndpoint); NEVER carries the key. */
const DRUGSFDA_LABEL = "openfda:/drug/drugsfda";

// ─── Honesty notes ────────────────────────────────────────────────
const NOT_DETERMINATION_NOTE =
  "openFDA Drugs@FDA records are FDA-published drug-application data; treat approval/marketing status as of the source's last publication. This is reference data, not a live regulatory determination.";
const KEYLESS_NOTE =
  "Keyless: no OPENFDA_API_KEY is set. openFDA allows ~1000 requests/day without a key; a free key raises the rate limit (get one at https://open.fda.gov/apis/authentication/).";
const KEYED_NOTE =
  "OPENFDA_API_KEY is set — it rides ONLY the &api_key= query parameter to api.fda.gov (openFDA has no header option), raising the rate limit. Its value is NEVER logged, echoed, or placed in this response.";
const NO_FILTER_NOTE =
  "No structured filters were applied — this is an unscoped scan of the WHOLE Drugs@FDA collection. Add sponsorName / brandName / activeIngredient / applicationNumber to scope the result set.";
const MARKETING_NOTE =
  "products[].marketingStatus is the FDA marketing category (e.g. 'Prescription', 'Over-the-counter', 'Discontinued', 'None (Tentative Approval)') — a 'Discontinued' product is NOT an approval revocation. submissions[] is the application's action history (ORIG approval + subsequent supplements).";

// ─── Curated row shape ────────────────────────────────────────────
export type DrugsfdaProduct = {
  brandName: string | null;
  genericIngredients: { name: string | null; strength: string | null }[];
  dosageForm: string | null;
  route: string | null;
  marketingStatus: string | null;
};
export type DrugsfdaSubmission = {
  submissionType: string | null; // ORIG / SUPPL
  submissionNumber: string | null;
  submissionStatus: string | null; // AP (approved) etc.
  submissionStatusDate: string | null; // YYYYMMDD string, preserved (P3)
  submissionClass: string | null;
};
export type DrugsfdaApplication = {
  applicationNumber: string | null;
  sponsorName: string | null;
  products: DrugsfdaProduct[];
  submissions: DrugsfdaSubmission[];
};

/** Map ONE Drugs@FDA result row → the curated shape. Every scalar via `str`. */
function mapApplication(row: unknown): DrugsfdaApplication {
  const r = (row ?? {}) as Record<string, unknown>;
  const products = Array.isArray(r.products) ? r.products : [];
  const submissions = Array.isArray(r.submissions) ? r.submissions : [];
  return {
    applicationNumber: str(r.application_number),
    sponsorName: str(r.sponsor_name),
    products: products.map((p) => {
      const pr = (p ?? {}) as Record<string, unknown>;
      const ings = Array.isArray(pr.active_ingredients) ? pr.active_ingredients : [];
      return {
        brandName: str(pr.brand_name),
        genericIngredients: ings.map((a) => {
          const ai = (a ?? {}) as Record<string, unknown>;
          return { name: str(ai.name), strength: str(ai.strength) };
        }),
        dosageForm: str(pr.dosage_form),
        route: str(pr.route),
        marketingStatus: str(pr.marketing_status),
      };
    }),
    submissions: submissions.map((s) => {
      const su = (s ?? {}) as Record<string, unknown>;
      return {
        submissionType: str(su.submission_type),
        submissionNumber: str(su.submission_number),
        submissionStatus: str(su.submission_status),
        submissionStatusDate: str(su.submission_status_date),
        submissionClass: str(su.submission_class_code_description),
      };
    }),
  };
}

// ─── Lucene search assembly (structured-only; injection-safe) ─────
export type DrugsfdaFilters = {
  sponsorName?: string; // → sponsor_name
  brandName?: string; // → products.brand_name
  activeIngredient?: string; // → products.active_ingredients.name
  applicationNumber?: string; // → application_number
};

export function buildDrugsfdaSearch(f: DrugsfdaFilters): string {
  const clauses: string[] = [];
  if (f.sponsorName !== undefined)
    clauses.push(`sponsor_name:${luceneQuote(f.sponsorName)}`);
  if (f.brandName !== undefined)
    clauses.push(`products.brand_name:${luceneQuote(f.brandName)}`);
  if (f.activeIngredient !== undefined)
    clauses.push(`products.active_ingredients.name:${luceneQuote(f.activeIngredient)}`);
  if (f.applicationNumber !== undefined)
    clauses.push(`application_number:${luceneQuote(f.applicationNumber)}`);
  return clauses.join(" AND ");
}

// ─── Tool: openfda_drug_approvals ─────────────────────────────────
export type DrugApprovalsArgs = DrugsfdaFilters & {
  limit?: number;
  skip?: number;
};

/**
 * Search openFDA Drugs@FDA drug-approval applications with structured filters →
 * curated application rows (sponsor, application number, approved products, submission
 * history) + honest `_meta`. KEYLESS (OPTIONAL OPENFDA_API_KEY only raises the rate
 * limit). totalAvailable = meta.results.total (EXACT); skip/limit pagination. A
 * no-match query (openFDA HTTP 404 NOT_FOUND) ⇒ an honest empty, never a throw.
 */
export async function drugApprovals(args: DrugApprovalsArgs): Promise<MetaBundle> {
  const limit = clampLimit(args.limit);
  const skip = clampSkip(args.skip);

  const filters: DrugsfdaFilters = {
    sponsorName: args.sponsorName,
    brandName: args.brandName,
    activeIngredient: args.activeIngredient,
    applicationNumber: args.applicationNumber,
  };
  const search = buildDrugsfdaSearch(filters);
  const filtersApplied: string[] = [];
  if (args.sponsorName !== undefined) filtersApplied.push("sponsorName");
  if (args.brandName !== undefined) filtersApplied.push("brandName");
  if (args.activeIngredient !== undefined) filtersApplied.push("activeIngredient");
  if (args.applicationNumber !== undefined) filtersApplied.push("applicationNumber");

  const params = new URLSearchParams();
  if (search !== "") params.set("search", search);
  params.set("limit", String(limit));
  params.set("skip", String(skip));
  const key = openfdaApiKey();
  if (key !== undefined) params.set("api_key", key); // OPTIONAL — &api_key= ONLY

  const url = `https://${OPENFDA_HOST}/drug/drugsfda.json?${params.toString()}`;

  const res = await fetchOpenfda(url, DRUGSFDA_LABEL);

  if (res.status === 404) {
    const { code, message } = await readOpenfdaError(res);
    if (code === "NOT_FOUND") {
      return emptyResult(limit, skip, filtersApplied, key !== undefined);
    }
    throw new ToolErrorCarrier({
      ...errorFromResponse(res, DRUGSFDA_LABEL),
      message: message
        ? `openFDA returned HTTP 404 at ${DRUGSFDA_LABEL}: ${message}`
        : `Resource not found at ${DRUGSFDA_LABEL} (HTTP 404).`,
    });
  }

  if (res.status >= 400 && res.status < 500 && res.status !== 429) {
    const { message } = await readOpenfdaError(res);
    throw new ToolErrorCarrier({
      kind: "invalid_input",
      retryable: false,
      message: message
        ? `openFDA rejected the request (HTTP ${res.status}) at ${DRUGSFDA_LABEL}: ${message}`
        : `Bad request (HTTP ${res.status}) at ${DRUGSFDA_LABEL}.`,
      upstreamStatus: res.status,
      upstreamEndpoint: DRUGSFDA_LABEL,
    });
  }

  if (!res.ok) {
    throw new ToolErrorCarrier(errorFromResponse(res, DRUGSFDA_LABEL));
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw driftError(
        DRUGSFDA_LABEL,
        `openFDA ${DRUGSFDA_LABEL} returned a non-JSON body at HTTP 200 — schema drift (never read as an empty result).`,
      );
    }
    throw e;
  }

  const b = (body ?? {}) as { meta?: unknown; results?: unknown };
  const meta = (b.meta ?? {}) as { results?: unknown };
  const metaResults = meta.results as { total?: unknown } | undefined;
  if (metaResults === undefined || metaResults === null || typeof metaResults !== "object") {
    throw driftError(
      DRUGSFDA_LABEL,
      `openFDA ${DRUGSFDA_LABEL} shape drift — meta.results (the skip/limit/total carrier) is missing.`,
    );
  }
  if (!Array.isArray(b.results)) {
    throw driftError(
      DRUGSFDA_LABEL,
      `openFDA ${DRUGSFDA_LABEL} shape drift — results must be an array.`,
    );
  }

  const applications = (b.results as unknown[]).map(mapApplication);
  const returned = applications.length;

  const rawTotal = metaResults.total;
  const totalAvailable =
    typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : null;
  const hasMore = totalAvailable !== null && skip + returned < totalAvailable;
  const nextOffset = hasMore ? skip + returned : null;

  const notes: string[] = [NOT_DETERMINATION_NOTE, MARKETING_NOTE, keyNote(key !== undefined)];
  if (filtersApplied.length === 0) notes.push(NO_FILTER_NOTE);

  return withMeta(
    { applications },
    {
      source: `${OPENFDA_HOST} /drug/drugsfda (openFDA Drugs@FDA approvals; ${
        key !== undefined ? "OPENFDA_API_KEY rate-limit key applied" : "keyless"
      })`,
      keylessMode: true,
      returned,
      totalAvailable,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset: skip, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}

// ─── Small helpers ────────────────────────────────────────────────
function keyNote(hasKey: boolean): string {
  return hasKey ? KEYED_NOTE : KEYLESS_NOTE;
}

function emptyResult(
  limit: number,
  skip: number,
  filtersApplied: string[],
  hasKey: boolean,
): MetaBundle {
  return withMeta(
    { applications: [] as DrugsfdaApplication[] },
    {
      source: `${OPENFDA_HOST} /drug/drugsfda (openFDA Drugs@FDA approvals; ${
        hasKey ? "OPENFDA_API_KEY rate-limit key applied" : "keyless"
      })`,
      keylessMode: true,
      returned: 0,
      totalAvailable: 0,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset: skip, limit, hasMore: false, nextOffset: null },
      notes: [
        "No Drugs@FDA applications matched this query (openFDA returned HTTP 404 NOT_FOUND — the source's honest no-match). This is an exact empty, not an error.",
        NOT_DETERMINATION_NOTE,
        keyNote(hasKey),
      ],
    } satisfies Partial<ResponseMeta>,
  );
}

function clampLimit(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_LIMIT;
  const n = Math.floor(v);
  if (n < 1) return 1;
  if (n > MAX_LIMIT) return MAX_LIMIT;
  return n;
}

function clampSkip(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  const n = Math.floor(v);
  return n < 0 ? 0 : n;
}
