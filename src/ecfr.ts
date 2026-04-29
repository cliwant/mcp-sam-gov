/**
 * eCFR (Electronic Code of Federal Regulations) wrappers (keyless).
 *
 * eCFR is the up-to-date version of the CFR — Title 48 = FAR (Federal
 * Acquisition Regulation), Title 2 = Federal financial assistance, etc.
 * For a federal contractor, eCFR is the primary source for regulation
 * text the agent should quote when answering compliance questions.
 *
 * Endpoints:
 *   - /versioner/v1/titles.json — list 50 CFR titles + last-amended dates
 *   - /search/v1/results — full-text search across the entire CFR
 *
 * Both keyless. Documented at https://www.ecfr.gov/developers/.
 */

const ECFR = "https://www.ecfr.gov/api";

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) {
    throw new Error(`eCFR ${url} returned ${r.status}`);
  }
  return (await r.json()) as T;
}

export async function listTitles() {
  type Resp = {
    titles?: {
      number?: number;
      name?: string;
      latest_amended_on?: string;
      latest_issue_date?: string;
      up_to_date_as_of?: string;
      reserved?: boolean;
    }[];
  };
  const json = await fetchJson<Resp>(`${ECFR}/versioner/v1/titles.json`);
  return {
    titles: (json.titles ?? []).map((t) => ({
      number: t.number ?? 0,
      name: t.name ?? "",
      latestAmendedOn: t.latest_amended_on,
      latestIssueDate: t.latest_issue_date,
      upToDateAsOf: t.up_to_date_as_of,
      reserved: !!t.reserved,
    })),
  };
}

export async function search(args: {
  query: string;
  titleNumber?: number;
  perPage?: number;
}) {
  const url = new URL(`${ECFR}/search/v1/results`);
  url.searchParams.set("query", args.query);
  url.searchParams.set("per_page", String(args.perPage ?? 5));
  if (args.titleNumber) {
    // eCFR search filter: hierarchy[title]=N (NOT just title=N — that's
    // an "unpermitted parameter" error from the eCFR API).
    url.searchParams.set("hierarchy[title]", String(args.titleNumber));
  }

  type Resp = {
    results?: {
      starts_on?: string;
      ends_on?: string | null;
      type?: string;
      hierarchy?: {
        title?: string;
        chapter?: string;
        subchapter?: string;
        part?: string;
        subpart?: string;
        section?: string;
      };
      hierarchy_headings?: Record<string, string | null>;
      headings?: Record<string, string | null>;
      full_text_excerpt?: string;
      score?: number;
    }[];
  };
  const json = await fetchJson<Resp>(url.toString());
  return {
    results: (json.results ?? []).map((r) => ({
      type: r.type ?? "",
      title: r.hierarchy?.title ?? "",
      chapter: r.hierarchy?.chapter,
      part: r.hierarchy?.part,
      subpart: r.hierarchy?.subpart,
      section: r.hierarchy?.section,
      headingPath: Object.values(r.hierarchy_headings ?? {})
        .filter(Boolean)
        .join(" › "),
      excerpt: stripHtml(r.full_text_excerpt ?? ""),
      score: r.score ?? 0,
      // Stable ecfr.gov URL pattern from the hierarchy
      ecfrUrl: r.hierarchy
        ? buildEcfrUrl(r.hierarchy)
        : "",
      effectiveOn: r.starts_on ?? "",
    })),
  };
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEcfrUrl(h: {
  title?: string;
  chapter?: string;
  part?: string;
  section?: string;
}): string {
  const base = `https://www.ecfr.gov/current/title-${h.title}`;
  if (h.section) return `${base}/section-${h.section}`;
  if (h.part) return `${base}/part-${h.part}`;
  if (h.chapter) return `${base}/chapter-${h.chapter}`;
  return base;
}
