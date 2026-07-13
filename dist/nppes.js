/**
 * NPPES NPI Registry — CMS/HHS healthcare-provider identity/credentialing lane
 * (keyless). Source #27 on the R2 `getJson` port (ADR-0036).
 *
 * ONE tool `nppes_lookup_provider` over the CMS/HHS National Plan & Provider
 * Enumeration System (`https://npiregistry.cms.hhs.gov/api/?version=2.1`) — the
 * authoritative PUBLIC registry of every US healthcare provider (individual
 * NPI-1 + organization NPI-2). The B2G unlock: vet a healthcare
 * subcontractor/provider/org for a VA/HHS/CMS contract — validate an NPI,
 * confirm taxonomy (specialty), enumeration status (Active), practice state, and
 * org/name match for credentialing / teaming due-diligence.
 *
 * TWO modes, inferred from `number` (NO mode flag):
 *   - EXACT-NPI (`number` supplied): validate `^\d{10}$` + the CMS Luhn
 *     (Luhn over `80840` + the first 9 digits, 14 total) CLIENT-SIDE →
 *     `invalid_input` on failure (a typo must NEVER fake a not-found; NPPES
 *     validates ONLY length, so the Luhn pre-check is LOAD-BEARING). ★ M1: the
 *     outgoing query carries `number` (+`version`) as the SOLE param — a
 *     co-supplied filter is NEVER forwarded (NPPES AND-combines a number with
 *     filters, so `number=<active NPI>&last_name=Zztypo` → result_count:0, a
 *     FALSE "does not exist"). Co-filters are dropped from the wire and surfaced
 *     as a CLIENT-SIDE post-match annotation (`data.filterMatch`).
 *   - SEARCH: by first_name / last_name / organization_name /
 *     taxonomy_description / city / postal_code (REQUIRED-one set), refined by
 *     state / enumeration_type (REFINERS — never sufficient alone, S2),
 *     paginated (limit ≤ 200, skip ≤ 1000 — our POLICY reach cap, S3).
 *
 * HONESTY (writes ZERO fetch/coerce/error/meta code — REUSES getJson/throughGate/
 * driftError + coerce.num/str + withMeta/buildMeta):
 *   P1 result_count === results.length (else driftError); NPPES exposes NO
 *      grand-total field → totalAvailable is a LOWER BOUND on a full page
 *      (totalIsLowerBound) + the ≤200/≤1000 policy caps disclosed.
 *   P2 `^\d{10}$` + CMS-Luhn → invalid_input (typo never fakes not-found); a
 *      genuine {result_count:0} → honest found:false; a {Errors:[…]} 200 body
 *      (NO results key — the NSF serviceNotification twin) → THROW; any
 *      4xx/5xx/timeout/off-host-redirect/non-JSON → THROW.
 *   P3 active = basic.status === "A" (deactivated/absent ⇒ NOT active); epochs
 *      (created_epoch/last_updated_epoch, ms numeric STRINGS) via coerce.num
 *      (null-never-0).
 *   P4 no silent filter drop (per-mode filtersApplied/filtersDropped; the M1
 *      exact-mode drop disclosed via filterMatch + a note).
 *
 * SSRF (the NSF fixed-host idiom, COPIED not imported): host + path + version are
 * compile-time CONSTANTS; every caller input rides in a MODULE-BUILT
 * URLSearchParams assembled key-by-key from validated typed args (NO raw-query
 * passthrough) + a post-construction hostname/protocol assert + redirect:"error".
 *
 * PII boundary (S3): NPPES public professional-registration data is IN-SCOPE per
 * the shipped NSF-PI-name precedent (src/nsf.ts surfaces PI names/emails),
 * bounded to a per-query targeted lookup (the ≤1,200 reach is a courtesy cap;
 * cross-query enumeration is NOT architecturally prevented, matching NSF). The
 * mandatory not-a-fitness/cross-check-SAM+OFAC caveat rides EVERY response.
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, throughGate, driftError } from "./datasource.js";
import { num, str } from "./coerce.js";
import { withMeta } from "./meta.js";
// Re-export the shared honesty coercion (single audited copy in ./coerce.js —
// ADR-0005 v2 FIX-C) so the fault suite's num-parity guard resolves the SAME
// `num` (nppes.num === coerce.num — a num regression fails together).
export { num };
// ─── Fixed endpoint (SSRF core — compile-time CONSTANTS) ──────────
const NPPES_HOST = "npiregistry.cms.hhs.gov";
const NPPES_PATH = "/api/";
const NPPES_URL = `https://${NPPES_HOST}${NPPES_PATH}`;
// `version=2.1` is REQUIRED by NPPES (omitting it → {Errors:"Unsupported Version"}).
const NPPES_VERSION = "2.1";
// HOST-only label. Surfaces in ToolError.upstreamEndpoint; keyless → no token.
const NPPES_LABEL = "nppes:/api";
// Modest self-throttle (courteous to a single public gov host; matches the
// ECHO/CKAN defensive posture — no documented hard rate limit was hit).
const NPPES_GATE_MIN_INTERVAL_MS = 200;
// ─── Pagination caps (the honesty frontier) ──────────────────────
const NPPES_MAX_LIMIT = 200; // the API silently CLAMPS >200 → we reject loudly.
const NPPES_DEFAULT_LIMIT = 10; // NPPES default page size.
// ★ Our OWN server POLICY cap (S3): NPPES no longer enforces a skip ceiling
// (skip=100000 works live) → we impose ≤1000 as the anti-bulk-harvest boundary.
const NPPES_MAX_SKIP = 1000;
// ─── Client-side value grammars (SSRF + honesty guards) ──────────
const NPI_RE = /^\d{10}$/;
const ENUM_TYPES = new Set(["NPI-1", "NPI-2"]);
const MAX_TEXT_LEN = 100;
// Frozen US state/territory 2-letter USPS enum (UPPERCASE-only). Built FROM this
// array by the Zod enum in server.ts (single source of truth). state is a REFINER
// only (S2) — never sufficient alone.
export const NPPES_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL",
    "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
    "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH",
    "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
    "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI",
    "WY", "AS", "GU", "MP", "PR", "VI",
];
const NPPES_STATES_SET = new Set(NPPES_STATES);
// The REQUIRED-one criterion set (S2). `number` triggers exact mode; the rest are
// the search-mode required-one set. state + enumeration_type are REFINERS ONLY.
const SEARCH_REQUIRED_FIELDS = [
    "first_name",
    "last_name",
    "organization_name",
    "taxonomy_description",
    "city",
    "postal_code",
];
// Free-text fields that accept a trailing `*` wildcard (≥2 leading literal chars).
const TEXT_FIELDS = [
    "first_name",
    "last_name",
    "organization_name",
    "taxonomy_description",
    "city",
];
// The co-filters an exact-NPI query may carry (all DROPPED from the wire, M1).
const CO_FILTER_FIELDS = [
    "first_name",
    "last_name",
    "organization_name",
    "taxonomy_description",
    "city",
    "postal_code",
    "state",
    "enumeration_type",
];
// ─── Disclosure constants (honesty obligations — verbatim, fault-asserted) ──
/**
 * ★ S3 — the mandatory not-a-fitness-determination caveat carried in EVERY
 * response (mirrors OFAC_NOT_DETERMINATION_NOTE). Kept verbatim so the fault
 * suite can assert it. It discloses (1) not a determination + cross-check SAM/OFAC;
 * (2) individual (NPI-1) records may surface personal/home addresses + phone/fax
 * verbatim, with NO enrichment or cross-source join.
 */
export const NPPES_NOT_DETERMINATION_NOTE = "Public professional-registration data (CMS NPPES NPI Registry). Confirms enumeration / identity / taxonomy only — it is NOT a fitness, exclusion, licensure, or sanctions determination. Cross-check SAM exclusions + OFAC for debarment/sanctions and the state licensing board for licensure. Individual (NPI-1) records may include personal / home practice or mailing addresses plus telephone/fax surfaced VERBATIM from the public registry; this tool performs NO enrichment and NO cross-source join on them.";
/** ★ S3 — the per-query reach-cap POLICY disclosure carried on EVERY response. */
export const NPPES_REACH_CAP_NOTE = "This vetting tool reaches at most the first ~1,200 matches per query (limit ≤ 200, skip ≤ 1,000) as a deliberate targeted-lookup boundary — NPPES itself no longer enforces a skip ceiling. This is a PER-QUERY cap only; cross-query enumeration (iterating name/city/postal filters) is NOT architecturally prevented (inherent to any search API), matching the NSF precedent. Narrow your filters (name + state + taxonomy) for a complete, targeted result set rather than paging deeper.";
/** P1 — the lower-bound disclosure (built with the observed floor N). */
function lowerBoundNote(atLeast) {
    return `NPPES does not expose a match total; a full page was returned, so this query has AT LEAST ${atLeast} matching provider(s) and the exact total is unknown — narrow filters (name + state + taxonomy) for a complete, targeted result.`;
}
const SOURCE = "npiregistry.cms.hhs.gov /api (NPPES NPI Registry, keyless)";
/** "true"/true → true, "false"/false → false, absent/other → null. */
function boolOrNull(x) {
    if (x === true)
        return true;
    if (x === false)
        return false;
    if (x === "true")
        return true;
    if (x === "false")
        return false;
    return null;
}
function rec(x) {
    return x !== null && typeof x === "object" && !Array.isArray(x)
        ? x
        : {};
}
/** Map ONE address/practiceLocation entry (identical mapping — S1: NEVER merged). */
function mapAddress(raw) {
    const a = rec(raw);
    return {
        purpose: str(a.address_purpose),
        address1: str(a.address_1),
        address2: str(a.address_2),
        city: str(a.city),
        state: str(a.state),
        postalCode: str(a.postal_code),
        telephone: str(a.telephone_number),
        fax: str(a.fax_number),
        countryCode: str(a.country_code),
        countryName: str(a.country_name),
        addressType: str(a.address_type),
    };
}
function mapTaxonomy(raw) {
    const t = rec(raw);
    return {
        code: str(t.code),
        desc: str(t.desc),
        primary: boolOrNull(t.primary),
        state: str(t.state),
        license: str(t.license),
        taxonomyGroup: str(t.taxonomy_group),
    };
}
function mapArray(raw, fn) {
    if (!Array.isArray(raw))
        return [];
    return raw.map(fn);
}
/** Verbatim array passthrough (identifiers/otherNames/endpoints — never flattened). */
function verbatimArray(raw) {
    return Array.isArray(raw) ? raw : [];
}
/**
 * Map ONE NPPES results[] record → the curated provider shape. Every scalar is
 * null-never-fabricated (str/num). `active` is derived ONLY from status === "A"
 * (P3); epochs are ms numeric STRINGS → num (null-never-0). Arrays are surfaced
 * verbatim / mapped element-wise — NEVER flattened, addresses[] and
 * practiceLocations[] kept SEPARATE (S1).
 */
function mapProvider(raw) {
    const r = rec(raw);
    const basic = rec(r.basic);
    const status = str(basic.status);
    return {
        number: str(r.number),
        enumerationType: str(r.enumeration_type),
        active: status === "A",
        status,
        basic: {
            firstName: str(basic.first_name),
            lastName: str(basic.last_name),
            middleName: str(basic.middle_name),
            namePrefix: str(basic.name_prefix),
            nameSuffix: str(basic.name_suffix),
            credential: str(basic.credential),
            sex: str(basic.sex),
            soleProprietor: str(basic.sole_proprietor),
            organizationName: str(basic.organization_name),
            organizationalSubpart: str(basic.organizational_subpart),
            authorizedOfficialFirstName: str(basic.authorized_official_first_name),
            authorizedOfficialLastName: str(basic.authorized_official_last_name),
            authorizedOfficialMiddleName: str(basic.authorized_official_middle_name),
            authorizedOfficialTitleOrPosition: str(basic.authorized_official_title_or_position),
            authorizedOfficialTelephoneNumber: str(basic.authorized_official_telephone_number),
            status,
            enumerationDate: str(basic.enumeration_date),
            certificationDate: str(basic.certification_date),
            lastUpdated: str(basic.last_updated),
        },
        taxonomies: Array.isArray(r.taxonomies)
            ? r.taxonomies.map(mapTaxonomy)
            : [],
        addresses: mapArray(r.addresses, mapAddress),
        practiceLocations: mapArray(r.practiceLocations, mapAddress),
        identifiers: verbatimArray(r.identifiers),
        otherNames: verbatimArray(r.other_names),
        endpoints: verbatimArray(r.endpoints),
        createdEpoch: num(r.created_epoch),
        lastUpdatedEpoch: num(r.last_updated_epoch),
    };
}
// ─── CMS NPI Luhn check (LOAD-BEARING — NPPES validates ONLY length) ──
/**
 * Validate the CMS NPI check digit: the Luhn algorithm over `80840` + the first 9
 * NPI digits (14 digits total, ISO/IEC 7812) must reproduce the 10th NPI digit.
 * `npi` MUST already be `^\d{10}$`. A Luhn-FAILING 10-digit string is provably
 * NOT a valid NPI ⇒ invalid_input (a typo must NOT read as found:false).
 */
export function cmsLuhnValid(npi) {
    if (!NPI_RE.test(npi))
        return false;
    const base = "80840" + npi.slice(0, 9); // 14 digits
    let sum = 0;
    let doubleIt = true; // the rightmost base digit is the 2nd-from-right in the full 15-digit number → doubled
    for (let i = base.length - 1; i >= 0; i--) {
        let d = base.charCodeAt(i) - 48;
        if (doubleIt) {
            d *= 2;
            if (d > 9)
                d -= 9;
        }
        sum += d;
        doubleIt = !doubleIt;
    }
    const check = (10 - (sum % 10)) % 10;
    return check === npi.charCodeAt(9) - 48;
}
// ─── Text sanitization + wildcard grammar (S2) ──────────────────
function invalidInput(message) {
    return new ToolErrorCarrier({
        kind: "invalid_input",
        message,
        retryable: false,
        upstreamEndpoint: NPPES_LABEL,
    });
}
/** Strip control chars + trim. URLSearchParams encodes the rest (no SSRF surface). */
function sanitizeText(v) {
    let out = "";
    for (const ch of v) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f)
            continue; // drop C0 control chars + DEL
        out += ch;
    }
    return out.trim();
}
/**
 * ★ S2 — a trailing `*` wildcard requires ≥2 leading literal chars (NPPES live:
 * `last_name=a*` → {Errors:"Wildcards require at least two leading characters"}).
 * A `*` anywhere but a single trailing position is rejected (NPPES supports only a
 * trailing wildcard).
 */
function checkWildcard(field, v) {
    if (!v.includes("*"))
        return;
    if (v.indexOf("*") !== v.length - 1 || v.indexOf("*") !== v.lastIndexOf("*")) {
        throw invalidInput(`Invalid wildcard in ${field} ${JSON.stringify(v)} — NPPES supports only a SINGLE TRAILING '*' wildcard.`);
    }
    const literal = v.slice(0, -1);
    if (literal.length < 2) {
        throw invalidInput(`Invalid wildcard in ${field} ${JSON.stringify(v)} — a trailing '*' requires at least 2 leading literal characters (NPPES rejects a single-leading-char wildcard).`);
    }
}
// ─── SSRF-guarded fetch (module-built URLSearchParams + hostname assert) ──
/**
 * GET NPPES with the module-built query. SSRF: host+path+version are constants;
 * every value rides in URLSearchParams (no host-alteration surface); then the
 * CONSTRUCTED URL's hostname === NPPES_HOST (https) assertion. redirect:"error"
 * (off-host 3xx fails closed — body never read). Keyless — the only header is
 * implicit; NO apiKey. Returns the parsed JSON (caller validates the envelope).
 */
async function nppesGet(params) {
    const built = new URL(`${NPPES_URL}?${params.toString()}`);
    if (built.hostname !== NPPES_HOST || built.protocol !== "https:") {
        throw invalidInput(`Constructed NPPES URL host ${JSON.stringify(built.hostname)} (${built.protocol}) is not ${NPPES_HOST} over https — refusing to fetch (SSRF safety).`);
    }
    // ★ W3-2 — the SyntaxError→schema_drift catch-ladder (fema.ts:262-275 shape).
    // getJson's r.json() runs OUTSIDE fetchWithRetry, so a 200 non-JSON body (an
    // npiregistry HTML/WAF/maintenance masquerade) throws a raw SyntaxError; toToolError
    // has NO schema_drift branch → it would degrade to kind:"unknown". Preserve the
    // fetchWithRetry taxonomy (429/404/5xx/400/timeout ToolErrorCarrier) FIRST (a
    // broader catch would reclassify a 429 to schema_drift), reclassify the SyntaxError
    // SECOND, bare-rethrow LAST.
    try {
        return await throughGate("nppes", NPPES_GATE_MIN_INTERVAL_MS, () => getJson(built.toString(), { label: NPPES_LABEL, redirect: "error" }));
    }
    catch (e) {
        if (e instanceof ToolErrorCarrier)
            throw e;
        if (e instanceof SyntaxError)
            throw driftError(NPPES_LABEL, "NPPES returned a non-JSON body at HTTP 200 — schema drift.");
        throw e;
    }
}
/**
 * Validate the HTTP-200 body envelope. Guard ORDER (a 200 body can carry an error):
 *   (a) NON-object body ⇒ driftError.
 *   (b) `Errors` present (array, non-empty) ⇒ THROW invalid_input surfacing
 *       Errors[0].description — the NSF serviceNotification twin (NEVER read the
 *       missing `results` as an empty result).
 *   (c) `results` absent / non-array (and no Errors) ⇒ driftError (nothing
 *       trustworthy — never a fake empty).
 *   (d) `result_count` absent / non-finite ⇒ driftError.
 *   (e) result_count !== results.length ⇒ driftError (the count-parity guard, P1).
 * A genuine {result_count:0, results:[]} (both keys) is DISTINCT — it returns 0
 * honestly (the caller renders found:false / an empty list).
 */
function parseNppesBody(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw driftError(NPPES_LABEL, "NPPES returned a 200 body that is not an object {result_count, results} — refusing to report it as an empty result.");
    }
    const b = body;
    const errors = b.Errors;
    if (Array.isArray(errors) && errors.length > 0) {
        const first = rec(errors[0]);
        const desc = str(first.description) ?? "(no description)";
        const field = str(first.field);
        throw invalidInput(`NPPES rejected the request [Errors]: ${desc}${field ? ` (field: ${field})` : ""}. (A 200 body carrying Errors and NO results key is a body-level loud-fail — never read as an empty result.)`);
    }
    if (!Array.isArray(b.results)) {
        throw driftError(NPPES_LABEL, "NPPES 200 body is missing the `results` array with no `Errors` — nothing trustworthy to report (treating as schema drift, never a fake empty).");
    }
    const results = b.results;
    const rc = b.result_count;
    if (typeof rc !== "number" || !Number.isFinite(rc)) {
        throw driftError(NPPES_LABEL, "NPPES `result_count` absent/non-numeric — cannot report a trustworthy count (schema drift). typeof-checked BEFORE any coercion.");
    }
    if (rc !== results.length) {
        throw driftError(NPPES_LABEL, `NPPES result_count (${rc}) !== results.length (${results.length}) — the count-parity guard tripped (never present a page count that disagrees with the rows).`);
    }
    return { resultCount: rc, results };
}
// ─── The M1 client-side post-match (exact-NPI co-filter annotation) ──
/** Uppercase-normalize + drop a trailing `*` for a client-side compare. */
function normCmp(v) {
    const t = v.trim();
    const wild = t.endsWith("*");
    return { target: (wild ? t.slice(0, -1) : t).toUpperCase(), wild };
}
function scalarMatches(candidate, target, wild) {
    if (candidate === null)
        return false;
    const c = candidate.trim().toUpperCase();
    return wild ? c.startsWith(target) : c === target;
}
/**
 * ★ M1 (option b) — did the returned record match ONE co-supplied filter? Computed
 * CLIENT-SIDE (the filter was NOT sent to the wire). A `false` means "the NPI is
 * valid/active but does NOT match your supplied value for this field" — NEVER a
 * reason to zero the record into found:false.
 */
function fieldMatches(field, value, p) {
    const { target, wild } = normCmp(value);
    const allAddr = [...p.addresses, ...p.practiceLocations];
    switch (field) {
        case "first_name":
            return (scalarMatches(p.basic.firstName, target, wild) ||
                scalarMatches(p.basic.authorizedOfficialFirstName, target, wild));
        case "last_name":
            return (scalarMatches(p.basic.lastName, target, wild) ||
                scalarMatches(p.basic.authorizedOfficialLastName, target, wild));
        case "organization_name":
            return scalarMatches(p.basic.organizationName, target, wild);
        case "city":
            return allAddr.some((a) => scalarMatches(a.city, target, wild));
        case "state":
            return (allAddr.some((a) => scalarMatches(a.state, target, wild)) ||
                p.taxonomies.some((t) => scalarMatches(t.state, target, wild)));
        case "postal_code":
            // Postal codes vary (5 vs 9 digit) → a prefix match on the supplied value.
            return allAddr.some((a) => a.postalCode !== null && a.postalCode.trim().toUpperCase().startsWith(target));
        case "enumeration_type":
            return p.enumerationType === value;
        case "taxonomy_description":
            return p.taxonomies.some((t) => t.desc !== null && t.desc.trim().toUpperCase().includes(target));
        default:
            return false;
    }
}
// ─── The tool ─────────────────────────────────────────────────────
/**
 * `nppes_lookup_provider` — keyless NPPES NPI Registry lookup. Mode inferred from
 * `number`: EXACT-NPI detail (Luhn-validated, number-only wire, M1 co-filter
 * annotation) OR a filtered SEARCH (required-one gate + refiners, S2; ≤200/≤1000
 * pagination policy caps, S3). NEVER fakes a not-found: a typo'd NPI ⇒
 * invalid_input; a {Errors} body ⇒ THROW; a genuine {result_count:0} ⇒ honest
 * found:false / empty. The not-a-fitness caveat + reach-cap policy ride EVERY
 * response.
 */
export async function lookupProvider(args) {
    const hasNumber = args.number !== undefined && args.number !== null && String(args.number).trim() !== "";
    // ── Sanitize + wildcard-validate the free-text fields up front (both modes). ──
    const text = {};
    for (const f of TEXT_FIELDS) {
        const raw = args[f];
        if (raw === undefined || raw === null)
            continue;
        const v = sanitizeText(String(raw));
        if (v === "")
            continue;
        if (v.length > MAX_TEXT_LEN) {
            throw invalidInput(`${f} exceeds ${MAX_TEXT_LEN} characters — narrow the value.`);
        }
        checkWildcard(f, v);
        text[f] = v;
    }
    if (args.postal_code !== undefined && args.postal_code !== null) {
        const pc = sanitizeText(String(args.postal_code));
        if (pc !== "") {
            if (pc.length > MAX_TEXT_LEN)
                throw invalidInput("postal_code is too long.");
            checkWildcard("postal_code", pc);
            text.postal_code = pc;
        }
    }
    // ── enumeration_type / state refiner validation (REFINERS ONLY — S2). ──
    let enumType;
    if (args.enumeration_type !== undefined && args.enumeration_type !== null && String(args.enumeration_type).trim() !== "") {
        enumType = String(args.enumeration_type).trim();
        if (!ENUM_TYPES.has(enumType)) {
            throw invalidInput(`Invalid enumeration_type ${JSON.stringify(enumType)} — expected 'NPI-1' or 'NPI-2'.`);
        }
    }
    let state;
    if (args.state !== undefined && args.state !== null && String(args.state).trim() !== "") {
        state = String(args.state).trim().toUpperCase();
        if (!NPPES_STATES_SET.has(state)) {
            throw invalidInput(`Invalid state ${JSON.stringify(args.state)} — expected a USPS 2-letter state/territory code (a non-state value silently returns 0 on NPPES, indistinguishable from 'no provider').`);
        }
    }
    // ═══════════════════════════════════════════════════════════════
    // EXACT-NPI MODE (M1) — number-only wire; co-filters annotated client-side.
    // ═══════════════════════════════════════════════════════════════
    if (hasNumber) {
        const npi = String(args.number).trim();
        if (!NPI_RE.test(npi)) {
            throw invalidInput(`Invalid number ${JSON.stringify(npi)} — an NPI is exactly 10 digits (^\\d{10}$).`);
        }
        if (!cmsLuhnValid(npi)) {
            throw invalidInput(`NPI ${JSON.stringify(npi)} fails the CMS check-digit (Luhn over 80840+first-9) — it is provably NOT a valid NPI (a typo must never read as 'provider does not exist'). NPPES validates only length, so this pre-check is load-bearing.`);
        }
        // ★ M1 — build the wire query with `number` (+`version`) as the SOLE params.
        //    NO co-supplied filter is ever forwarded (NPPES AND-combines a number with
        //    filters → a mismatched filter would zero a real, active provider).
        const params = new URLSearchParams();
        params.set("version", NPPES_VERSION);
        params.set("number", npi);
        // The co-filters the caller supplied (DROPPED from the wire, annotated below).
        const coFilters = {};
        for (const f of CO_FILTER_FIELDS) {
            if (f === "state") {
                if (state !== undefined)
                    coFilters.state = state;
            }
            else if (f === "enumeration_type") {
                if (enumType !== undefined)
                    coFilters.enumeration_type = enumType;
            }
            else {
                const tv = text[f];
                if (tv !== undefined)
                    coFilters[f] = tv;
            }
        }
        const droppedFilters = Object.keys(coFilters);
        const parsed = parseNppesBody(await nppesGet(params));
        const notes = [];
        if (parsed.resultCount === 0) {
            // Genuine not-found (honest found:false — NEVER a fake or a thrown empty).
            notes.push(`No NPPES record for NPI ${JSON.stringify(npi)} (found:false — the NPI is Luhn-valid but not in the ACTIVE NPPES registry: it may never have been assigned OR was deactivated; NPPES search returns active records). This is an honest not-found, not a fitness determination.`);
            if (droppedFilters.length > 0) {
                notes.push(exactDropNote(droppedFilters));
            }
            notes.push(NPPES_NOT_DETERMINATION_NOTE, NPPES_REACH_CAP_NOTE);
            return withMeta({ found: false, provider: null }, {
                source: SOURCE,
                keylessMode: true,
                returned: 0,
                totalAvailable: 0,
                filtersApplied: ["number"],
                filtersDropped: droppedFilters,
                fieldsUnavailable: [],
                notes,
            });
        }
        // result_count ≥ 1 (an NPI is unique — take the first; parity already asserted).
        const provider = mapProvider(parsed.results[0]);
        // ★ M1 (option b) — client-side post-match annotation for each dropped filter.
        let filterMatch;
        if (droppedFilters.length > 0) {
            filterMatch = {};
            for (const f of droppedFilters) {
                filterMatch[f] = fieldMatches(f, coFilters[f], provider);
            }
            notes.push(exactDropNote(droppedFilters));
            const mismatched = droppedFilters.filter((f) => filterMatch[f] === false);
            if (mismatched.length > 0) {
                notes.push(`The NPI is active/enumerated, but it does NOT match your supplied ${mismatched.join(", ")} (checked client-side — see data.filterMatch). A mismatch does NOT mean the NPI is invalid; it means the registry record differs from your expectation for that field.`);
            }
        }
        if (!provider.active) {
            notes.push(`provider.active is false (basic.status = ${JSON.stringify(provider.status)}); status is NOT 'A'. Not a fitness determination.`);
        }
        notes.push(NPPES_NOT_DETERMINATION_NOTE, NPPES_REACH_CAP_NOTE);
        const data = { found: true, provider };
        if (filterMatch !== undefined) {
            data.filterMatch = filterMatch;
            data.filtersDropped = droppedFilters;
        }
        return withMeta(data, {
            source: SOURCE,
            keylessMode: true,
            returned: 1,
            totalAvailable: 1,
            filtersApplied: ["number"],
            filtersDropped: droppedFilters,
            fieldsUnavailable: [],
            notes,
        });
    }
    // ═══════════════════════════════════════════════════════════════
    // SEARCH MODE — required-one gate (S2) + refiners; ≤200/≤1000 caps (S3).
    // ═══════════════════════════════════════════════════════════════
    // ── Required-criterion gate (S2): at least ONE of the required-one set. state +
    //    enumeration_type are REFINERS ONLY — never sufficient alone. ──
    const suppliedRequired = SEARCH_REQUIRED_FIELDS.filter((f) => text[f] !== undefined);
    if (suppliedRequired.length === 0) {
        const hadRefinerOnly = state !== undefined || enumType !== undefined;
        throw invalidInput(hadRefinerOnly
            ? "state and enumeration_type are REFINERS ONLY — NPPES rejects them as the sole criterion. Supply at least one of: number, first_name, last_name, organization_name, taxonomy_description, city, postal_code."
            : "At least one search criterion is required: number, first_name, last_name, organization_name, taxonomy_description, city, or postal_code (state / enumeration_type alone are not valid NPPES criteria).");
    }
    // ── Limit + skip guards (S3 policy caps — belt-and-suspenders behind Zod). ──
    const limit = args.limit ?? NPPES_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > NPPES_MAX_LIMIT) {
        throw invalidInput(`limit ${JSON.stringify(args.limit)} out of range — NPPES caps a page at ${NPPES_MAX_LIMIT} (the API silently clamps >${NPPES_MAX_LIMIT}; this tool rejects it loudly). Use 1..${NPPES_MAX_LIMIT}.`);
    }
    const skip = args.skip ?? 0;
    if (!Number.isInteger(skip) || skip < 0 || skip > NPPES_MAX_SKIP) {
        throw invalidInput(`skip ${JSON.stringify(args.skip)} out of range — this vetting tool caps reach at skip ≤ ${NPPES_MAX_SKIP} (a deliberate targeted-lookup POLICY boundary; NPPES itself no longer enforces a skip ceiling). Narrow your filters rather than paging deeper.`);
    }
    // ── Build the wire query key-by-key from validated typed args (SSRF: no raw
    //    passthrough). Refiners ride along ONLY alongside a required criterion. ──
    const params = new URLSearchParams();
    params.set("version", NPPES_VERSION);
    const filtersApplied = [];
    for (const f of SEARCH_REQUIRED_FIELDS) {
        const v = text[f];
        if (v !== undefined) {
            params.set(f, v);
            filtersApplied.push(f);
        }
    }
    if (state !== undefined) {
        params.set("state", state);
        filtersApplied.push("state");
    }
    if (enumType !== undefined) {
        params.set("enumeration_type", enumType);
        filtersApplied.push("enumeration_type");
    }
    params.set("limit", String(limit));
    params.set("skip", String(skip));
    const parsed = parseNppesBody(await nppesGet(params));
    const providers = parsed.results.map(mapProvider);
    const returned = providers.length;
    // ── Pagination + lower-bound honesty (P1). No grand total exists → a full page
    //    means MORE may exist; totalAvailable is the KNOWN lower bound skip+returned. ──
    const pageFull = returned === limit;
    const candidateNext = skip + returned;
    const nextSkip = pageFull && candidateNext <= NPPES_MAX_SKIP ? candidateNext : null;
    const hasMore = nextSkip !== null;
    const totalAvailable = skip + returned;
    const notes = [];
    if (pageFull) {
        notes.push(lowerBoundNote(totalAvailable));
        if (nextSkip === null) {
            notes.push(`A full page was returned but the next page would exceed the skip ≤ ${NPPES_MAX_SKIP} policy cap — additional matches exist but are NOT reachable via this tool. Narrow your filters for a complete set.`);
        }
    }
    else if (returned === 0) {
        notes.push(`No NPPES providers matched (found:false / empty — an honest zero, distinct from an outage or a body-level error). Not a fitness determination.`);
    }
    notes.push(NPPES_NOT_DETERMINATION_NOTE, NPPES_REACH_CAP_NOTE);
    const meta = {
        source: SOURCE,
        keylessMode: true,
        // A full page is never complete (more may exist, reachable or not).
        truncated: pageFull,
        returned,
        totalAvailable,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset: skip, limit, hasMore, nextOffset: nextSkip },
        notes,
    };
    if (pageFull)
        meta.totalIsLowerBound = true;
    return withMeta({ providers }, meta);
}
/** The M1 exact-mode filter-drop disclosure (dropped filters + why). */
function exactDropNote(dropped) {
    return `\`number\` is an EXACT NPI lookup: your other supplied filter(s) [${dropped.join(", ")}] were NOT sent to the wire — NPPES AND-combines a number with filters, so a mismatched filter would falsely zero a real, active provider into 'not found'. They were checked CLIENT-SIDE against the returned record instead (see data.filterMatch). Remove them, or use search mode (no number) to filter on the wire.`;
}
//# sourceMappingURL=nppes.js.map