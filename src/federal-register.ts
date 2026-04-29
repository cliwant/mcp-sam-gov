/**
 * Federal Register API v1 wrappers (keyless, no registration).
 *
 * Federal Register is the daily journal of the US federal government —
 * proposed rules, final rules, presidential documents, public notices.
 * Critical context for any federal contracting question that touches
 * regulation, set-aside policy, or new acquisition guidance.
 *
 * Endpoints:
 *   - documents.json — search across documents (filters: agencies,
 *     conditions, type, date range)
 *   - documents/{number}.json — single document detail (full body URL,
 *     abstract, citation, effective date)
 *   - agencies.json — agency reference list
 *
 * All endpoints are public + keyless (no API key, no registration).
 * Rate-limit: documented as ~1000 req/hour per IP (informal).
 */

import { fetchWithRetry } from "./errors.js";
import { memoize } from "./cache.js";

const FED_REG = "https://www.federalregister.gov/api/v1";

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetchWithRetry(
    url,
    {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    },
    `federal-register:${url.split("/api/v1/")[1] ?? url}`,
  );
  return (await r.json()) as T;
}

export type FedRegDocumentType =
  | "RULE"
  | "PRORULE"
  | "NOTICE"
  | "PRESDOCU"
  | "UNKNOWN";

const TYPE_MAP: Record<string, FedRegDocumentType> = {
  Rule: "RULE",
  "Proposed Rule": "PRORULE",
  Notice: "NOTICE",
  "Presidential Document": "PRESDOCU",
};

export async function searchDocuments(args: {
  query?: string;
  agencySlugs?: string[]; // e.g. ["veterans-affairs-department", "defense-department"]
  type?: "RULE" | "PRORULE" | "NOTICE" | "PRESDOCU";
  publicationDateFrom?: string; // YYYY-MM-DD
  publicationDateTo?: string;
  effectiveDateFrom?: string;
  perPage?: number;
}) {
  const url = new URL(`${FED_REG}/documents.json`);
  url.searchParams.set("per_page", String(args.perPage ?? 10));
  if (args.query) {
    url.searchParams.set("conditions[term]", args.query);
  }
  for (const slug of args.agencySlugs ?? []) {
    url.searchParams.append("conditions[agencies][]", slug);
  }
  if (args.type) {
    url.searchParams.append("conditions[type][]", args.type);
  }
  if (args.publicationDateFrom) {
    url.searchParams.set(
      "conditions[publication_date][gte]",
      args.publicationDateFrom,
    );
  }
  if (args.publicationDateTo) {
    url.searchParams.set(
      "conditions[publication_date][lte]",
      args.publicationDateTo,
    );
  }
  if (args.effectiveDateFrom) {
    url.searchParams.set(
      "conditions[effective_date][gte]",
      args.effectiveDateFrom,
    );
  }

  type Resp = {
    count?: number;
    total_pages?: number;
    results?: {
      title?: string;
      type?: string;
      abstract?: string;
      document_number?: string;
      html_url?: string;
      pdf_url?: string;
      publication_date?: string;
      effective_on?: string;
      agencies?: { name?: string; slug?: string }[];
    }[];
  };
  const json = await fetchJson<Resp>(url.toString());
  return {
    totalRecords: json.count ?? 0,
    totalPages: json.total_pages ?? 0,
    documents: (json.results ?? []).map((d) => ({
      documentNumber: d.document_number ?? "",
      title: d.title ?? "",
      type: TYPE_MAP[d.type ?? ""] ?? "UNKNOWN",
      typeDisplay: d.type ?? "",
      abstract: d.abstract ?? "",
      htmlUrl: d.html_url ?? "",
      pdfUrl: d.pdf_url,
      publicationDate: d.publication_date ?? "",
      effectiveDate: d.effective_on,
      agencies: (d.agencies ?? []).map((a) => ({
        name: a.name ?? "",
        slug: a.slug ?? "",
      })),
    })),
  };
}

export async function getDocument(documentNumber: string) {
  type Resp = {
    title?: string;
    type?: string;
    abstract?: string;
    document_number?: string;
    html_url?: string;
    pdf_url?: string;
    body_html_url?: string;
    publication_date?: string;
    effective_on?: string;
    citation?: string;
    page_length?: number;
    raw_text_url?: string;
    agencies?: { name?: string; slug?: string }[];
    cfr_references?: { title?: string; part?: string; chapter?: string }[];
  };
  const json = await fetchJson<Resp>(
    `${FED_REG}/documents/${encodeURIComponent(documentNumber)}.json`,
  );
  return {
    documentNumber: json.document_number ?? "",
    title: json.title ?? "",
    type: TYPE_MAP[json.type ?? ""] ?? "UNKNOWN",
    typeDisplay: json.type ?? "",
    abstract: json.abstract ?? "",
    htmlUrl: json.html_url ?? "",
    pdfUrl: json.pdf_url,
    rawTextUrl: json.raw_text_url,
    publicationDate: json.publication_date ?? "",
    effectiveDate: json.effective_on,
    citation: json.citation,
    pageCount: json.page_length,
    agencies: (json.agencies ?? []).map((a) => ({
      name: a.name ?? "",
      slug: a.slug ?? "",
    })),
    cfrReferences: (json.cfr_references ?? []).map((c) => ({
      title: c.title ?? "",
      part: c.part,
      chapter: c.chapter,
    })),
  };
}

export async function listAgencies(args: { perPage?: number }) {
  return memoize(`fedreg:agencies:${args.perPage ?? 100}`, async () => {
    type Resp = Array<{
      id?: number;
      name?: string;
      short_name?: string;
      slug?: string;
      description?: string;
      parent_id?: number | null;
      json_url?: string;
    }>;
    const json = await fetchJson<Resp>(
      `${FED_REG}/agencies.json?per_page=${args.perPage ?? 100}`,
    );
    return {
      agencies: (json ?? []).map((a) => ({
        id: a.id ?? 0,
        name: a.name ?? "",
        shortName: a.short_name,
        slug: a.slug ?? "",
        description: a.description ?? "",
        parentId: a.parent_id,
      })),
    };
  });
}
