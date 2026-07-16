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
import { type MetaBundle } from "./meta.js";
export declare const OSCAL_HOST = "raw.githubusercontent.com";
export type NistControl = {
    id: string;
    family: string;
    title: string;
    statement: string;
    guidance: string | null;
    enhancements: {
        id: string;
        title: string;
    }[];
};
/**
 * Look up NIST SP 800-53 Rev 5 controls by controlId (exact, e.g. "AC-2"), family
 * (exact family letter or name, e.g. "AC" / "Access Control"), and/or keyword
 * (case-insensitive substring over title + statement). Client-side filters over the
 * cached OSCAL catalog; honest `_meta` (exact match total; provenance disclosed).
 */
export declare function searchControls(args: {
    controlId?: string;
    family?: string;
    keyword?: string;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
//# sourceMappingURL=nist-controls.d.ts.map