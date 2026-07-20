/**
 * nist-controls.ts — NIST SP 800-53 Rev 5 security & privacy CONTROLS catalog
 * (OSCAL, keyless). The cyber-compliance controls backbone for FedRAMP / CMMC / RMF
 * work: look up a control (AC-2, SC-7, …) or a family (Access Control, System &
 * Communications Protection, …) and get its title, requirement STATEMENT, discussion
 * guidance, and control enhancements. No other tool here exposes the controls catalog
 * (we have NVD CVEs + CISA KEV, but not the requirement side).
 *
 * SOURCE: NIST's OFFICIAL OSCAL content, published at github.com/usnistgov/oscal-content
 * (the canonical machine-readable release; the .gov PDF is the human copy). NOT a
 * .gov API host, so provenance is disclosed on every response (the ProPublica /
 * CourtListener / get.gov republisher idiom — here NIST is the first-party author).
 *
 * PATTERN: the CISA-KEV static-file idiom (nvd.ts) — a fixed-host const URL fetched
 * via getJson (redirect:"error" + 30s timeout), memoized 6h, with a plausibility
 * FLOOR (a truncated catalog must NEVER read as "control not found"), then
 * client-side filter/lookup. An outage/4xx/timeout THROWS (never a fake empty).
 *
 * SSRF: fixed host `raw.githubusercontent.com` + a fixed, pinned path (no free
 * host/path). Filtering is CLIENT-SIDE over the parsed catalog.
 */

import { getJson, driftError } from "./datasource.js";
import { memoize } from "./cache.js";
import { withMeta, type MetaBundle, type ResponseMeta } from "./meta.js";

export const OSCAL_HOST = "raw.githubusercontent.com";
const OSCAL_URL =
  "https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json";
const OSCAL_LABEL = "nist-oscal:sp800-53r5";
const OSCAL_TIMEOUT_MS = 30_000;
const OSCAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
// Plausibility floor: 800-53 Rev5 has 20 control families and ~1000 controls. A
// truncated catalog with far fewer must THROW, never read as "control not found".
const FAMILY_FLOOR = 15;

const PROVENANCE_NOTE =
  "Source: NIST SP 800-53 Rev 5 OSCAL catalog, published at github.com/usnistgov/oscal-content (NIST's canonical machine-readable release; authoritative first-party data served from GitHub, not a .gov API host).";
const CLIENT_FILTER_NOTE =
  "The catalog has no query API — the full published OSCAL JSON is fetched (cached 6h) and filtered CLIENT-SIDE (controlId exact, family exact, keyword = case-insensitive substring over title+statement). totalAvailable is the EXACT match count.";
const REFERENCE_NOTE =
  "This is the REQUIREMENT catalog (control text), NOT an assessment or an authorization. A control's applicability depends on the system's FIPS-199 impact baseline (Low/Moderate/High) and overlay — which this catalog does not encode.";

// ─── Parsed shapes ────────────────────────────────────────────────
export type NistControl = {
  id: string; // display form, e.g. "AC-2"
  family: string; // e.g. "AC — Access Control"
  title: string;
  status: string | null; // OSCAL status prop, e.g. "withdrawn"; null when active
  statement: string | null; // requirement prose; NULL when absent (a WITHDRAWN control has none) — never ""
  guidance: string | null; // discussion prose
  incorporatedInto: string[]; // withdrawn control ⇒ the control id(s) it was folded into (e.g. ["AC-2","AU-6"])
  enhancements: { id: string; title: string }[]; // e.g. AC-2(1)
};

type OscalPart = {
  name?: string;
  prose?: string;
  props?: { name?: string; value?: string }[];
  parts?: OscalPart[];
};
type OscalControl = {
  id?: string;
  title?: string;
  props?: { name?: string; value?: string }[];
  links?: { href?: string; rel?: string }[];
  parts?: OscalPart[];
  controls?: OscalControl[];
};
type OscalGroup = { id?: string; title?: string; controls?: OscalControl[] };

/** OSCAL control id ("ac-2", "ac-2.1") → display id ("AC-2", "AC-2(1)"). */
function displayId(rawId: string): string {
  const m = /^([a-z]+)-(\d+)(?:\.(\d+))?$/i.exec(rawId.trim());
  if (!m) return rawId.toUpperCase();
  const fam = (m[1] ?? "").toUpperCase();
  // Strip leading zeros so a zero-padded input ('AC-02') normalizes to the catalog's
  // canonical unpadded form ('AC-2') — else an exact controlId lookup would miss.
  const num = String(Number(m[2] ?? "0"));
  const enh = m[3] !== undefined ? String(Number(m[3])) : undefined;
  return enh !== undefined ? `${fam}-${num}(${enh})` : `${fam}-${num}`;
}

/** Recursively collect a statement part's prose as labelled, indented lines. */
function collectProse(part: OscalPart, depth: number, out: string[]): void {
  const label = part.props?.find((p) => p.name === "label")?.value;
  const indent = "  ".repeat(depth);
  const prefix = label ? `${label} ` : "";
  if (part.prose && part.prose.trim().length > 0) {
    out.push(`${indent}${prefix}${part.prose.trim()}`);
  } else if (label) {
    out.push(`${indent}${prefix}`.trimEnd());
  }
  for (const sub of part.parts ?? []) collectProse(sub, depth + 1, out);
}

function partProse(control: OscalControl, name: string): string | null {
  const part = (control.parts ?? []).find((p) => p.name === name);
  if (!part) return null;
  const out: string[] = [];
  collectProse(part, 0, out);
  const text = out.join("\n").trim();
  return text.length > 0 ? text : null;
}

function mapControl(control: OscalControl, family: string): NistControl {
  const status =
    (control.props ?? []).find((p) => p.name === "status")?.value?.trim() || null;
  // A withdrawn control carries `links[] rel="incorporated-into"` → the control(s)
  // it was folded into (e.g. AC-13 → AC-2, AU-6). Surface them so a withdrawn
  // control is never mistaken for an active requirement.
  const incorporatedInto = (control.links ?? [])
    .filter((l) => l.rel === "incorporated-into" && typeof l.href === "string")
    .map((l) => displayId(String(l.href).replace(/^#/, "")))
    .filter((x) => x.length > 0);
  return {
    id: displayId(control.id ?? ""),
    family,
    title: (control.title ?? "").trim(),
    status,
    // [P3] absent statement ⇒ null, NEVER "" — a withdrawn control has no
    // requirement text; "" would misread as "an active control with a blank
    // requirement".
    statement: partProse(control, "statement"),
    guidance: partProse(control, "guidance"),
    incorporatedInto,
    enhancements: (control.controls ?? []).map((e) => ({
      id: displayId(e.id ?? ""),
      title: (e.title ?? "").trim(),
    })),
  };
}

/**
 * Fetch + parse the OSCAL catalog into a flat list of TOP-LEVEL controls, memoized
 * 6h. Header/shape guarded: `catalog.groups` MUST be an array with ≥ FAMILY_FLOOR
 * families (else driftError — a truncated catalog is NEVER a fake empty). Enhancements
 * are carried on each control (not indexed as top-level entries).
 */
type OscalMetadata = { version: string | null; lastModified: string | null };

async function loadControls(): Promise<{
  controls: NistControl[];
  metadata: OscalMetadata;
}> {
  return memoize(
    "nist:sp800-53r5",
    async () => {
      const built = new URL(OSCAL_URL);
      if (built.hostname !== OSCAL_HOST || built.protocol !== "https:") {
        throw driftError(OSCAL_LABEL, `Constructed OSCAL URL host ${JSON.stringify(built.hostname)} is not ${OSCAL_HOST} over https — refusing to fetch (SSRF safety).`);
      }
      const body = (await getJson(OSCAL_URL, {
        label: OSCAL_LABEL,
        redirect: "error",
        timeoutMs: OSCAL_TIMEOUT_MS,
      })) as {
        catalog?: {
          groups?: unknown;
          metadata?: { version?: unknown; "last-modified"?: unknown };
        };
      };
      const groups = body.catalog?.groups;
      if (!Array.isArray(groups) || groups.length < FAMILY_FLOOR) {
        throw driftError(
          OSCAL_LABEL,
          `OSCAL catalog.groups missing or implausibly small (${Array.isArray(groups) ? groups.length : "not-an-array"} < ${FAMILY_FLOOR} families) — treating as schema drift / truncation, never a fake-empty catalog.`,
        );
      }
      // [P5 freshness] The OSCAL catalog is a moving static file on the `main`
      // branch — surface its exact version + last-modified so a compliance caller
      // knows WHICH point-release (5.1.1 / 5.2.0 …) they are reading.
      const md = body.catalog?.metadata ?? {};
      const metadata: OscalMetadata = {
        version: typeof md.version === "string" ? md.version : null,
        lastModified:
          typeof md["last-modified"] === "string" ? md["last-modified"] : null,
      };
      const controls: NistControl[] = [];
      for (const g of groups as OscalGroup[]) {
        const family = `${(g.id ?? "").toUpperCase()} — ${(g.title ?? "").trim()}`;
        for (const c of g.controls ?? []) controls.push(mapControl(c, family));
      }
      return { controls, metadata };
    },
    OSCAL_CACHE_TTL_MS,
  );
}

// ─── Tool: nist_800_53_controls ───────────────────────────────────
/**
 * Look up NIST SP 800-53 Rev 5 controls by controlId (exact, e.g. "AC-2"), family
 * (exact family letter or name, e.g. "AC" / "Access Control"), and/or keyword
 * (case-insensitive substring over title + statement). Client-side filters over the
 * cached OSCAL catalog; honest `_meta` (exact match total; provenance disclosed).
 */
export async function searchControls(args: {
  controlId?: string;
  family?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
}): Promise<MetaBundle> {
  const limit = args.limit ?? 25;
  const offset = args.offset ?? 0;
  const { controls: all, metadata } = await loadControls();

  const filtersApplied: string[] = [];
  const idQ = args.controlId !== undefined ? displayId(args.controlId) : undefined;
  const famQ = args.family?.trim().toLowerCase();
  const kwQ = args.keyword?.trim().toLowerCase();
  if (args.controlId !== undefined) filtersApplied.push("controlId");
  if (args.family !== undefined) filtersApplied.push("family");
  if (args.keyword !== undefined) filtersApplied.push("keyword");

  const matched = all.filter((c) => {
    if (idQ && c.id.toUpperCase() !== idQ.toUpperCase()) return false;
    if (famQ) {
      // family field is "AC — Access Control"; match either the letter code or a
      // substring of the title (both case-insensitive).
      const fam = c.family.toLowerCase();
      const code = (fam.split("—")[0] ?? "").trim();
      if (code !== famQ && !fam.includes(famQ)) return false;
    }
    if (kwQ) {
      // Search the title + requirement statement AND each enhancement's title, so a
      // term that lives only in an enhancement (e.g. "multi-factor" → IA-2(1)) still
      // surfaces the parent control. filtersApplied still lists 'keyword'.
      const hay = `${c.title}\n${c.statement ?? ""}\n${c.enhancements.map((e) => e.title).join("\n")}`.toLowerCase();
      if (!hay.includes(kwQ)) return false;
    }
    return true;
  });

  const totalAvailable = matched.length;
  const page = matched.slice(offset, offset + limit);
  const returned = page.length;
  const hasMore = offset + returned < totalAvailable;
  const nextOffset = hasMore ? offset + returned : null;

  const versionLabel = metadata.version ? `Rev ${metadata.version}` : "Rev 5";
  const notes: string[] = [PROVENANCE_NOTE, CLIENT_FILTER_NOTE, REFERENCE_NOTE];
  notes.push(
    `OSCAL catalog ${metadata.version ? `version ${metadata.version}` : "revision 5"}${metadata.lastModified ? `, last-modified ${metadata.lastModified.slice(0, 10)}` : ""} — fetched live from the usnistgov/oscal-content \`main\` branch (a MOVING target; control text can change between point releases, e.g. 5.1.1 → 5.2.0). Cite the version above, not just "Rev 5".`,
  );
  const withdrawnOnPage = page.filter((c) => c.status === "withdrawn").length;
  if (withdrawnOnPage > 0) {
    notes.push(
      `${withdrawnOnPage} of the returned control(s) are WITHDRAWN (status:"withdrawn") — a withdrawn control has NO requirement text (statement:null) and is NOT an active requirement; see its incorporatedInto for the control(s) that superseded it.`,
    );
  }

  return withMeta(
    { controls: page },
    {
      source: `NIST SP 800-53 ${versionLabel} (OSCAL catalog, keyless)`,
      keylessMode: true,
      returned,
      totalAvailable,
      truncated: hasMore,
      filtersApplied,
      filtersDropped: [],
      fieldsUnavailable: [],
      pagination: { offset, limit, hasMore, nextOffset },
      notes,
    } satisfies Partial<ResponseMeta>,
  );
}
