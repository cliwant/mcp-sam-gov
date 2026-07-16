/**
 * nws-weather.ts — National Weather Service active alerts (api.weather.gov, KEYLESS)
 * — the DISASTER / CLIMATE-READINESS lane. Current watches, warnings, and advisories
 * (event, severity, urgency, area, effective/expires window, instructions). Pairs
 * directly with the FEMA tools (disaster declarations → public assistance → hazard
 * mitigation → LIVE active weather) to complete a disaster-response-readiness view:
 * where severe-weather events are active NOW, ahead of the declarations/contracts
 * that follow.
 *
 * SOURCE: NWS api.weather.gov (a .gov host), keyless. Requires a descriptive
 * User-Agent (NWS policy) — sent from a fixed constant; no token. Returns a GeoJSON
 * FeatureCollection. This is REAL-TIME data (currently-active alerts) — freshness is
 * disclosed and never implied to be a historical series.
 *
 * HONESTY: fixed host + redirect:"error" (SSRF); `state` is a 2-letter charclass (the
 * server-side ?area= filter); event/severity are applied CLIENT-SIDE over the returned
 * set; a non-FeatureCollection / non-array body ⇒ driftError; an outage/4xx/timeout
 * THROWS. A genuine no-active-alerts result ⇒ an HONEST EMPTY (returned:0), never an
 * error. totalAvailable = the EXACT count of matched active alerts. Every scalar via
 * `str` (null-never-empty-string); dates preserved as ISO strings.
 */
import { ToolErrorCarrier } from "./errors.js";
import { getJson, driftError } from "./datasource.js";
import { str } from "./coerce.js";
import { withMeta } from "./meta.js";
export const NWS_HOST = "api.weather.gov";
const NWS_ACTIVE_URL = "https://api.weather.gov/alerts/active";
const NWS_LABEL = "nws:/alerts/active";
const NWS_TIMEOUT_MS = 15_000;
// NWS asks every client to send a descriptive User-Agent (with contact). No token.
const NWS_USER_AGENT = "cliwant-mcp-sam-gov (https://github.com/cliwant/mcp-sam-gov)";
const STATE_RE = /^[A-Za-z]{2}$/;
const PROVENANCE_NOTE = "Source: NWS api.weather.gov active-alerts feed (keyless; a descriptive User-Agent is sent per NWS policy).";
const FRESHNESS_NOTE = "REAL-TIME: these are the alerts ACTIVE at request time (a live snapshot, not a historical archive). Read effective/onset/expires/ends for each alert's window; an expired alert is not returned. A no-active-alerts result is an HONEST empty (returned:0), never an error.";
function mapAlert(feature) {
    const p = (feature ?? {}).properties ?? {};
    return {
        id: str(p.id),
        event: str(p.event),
        headline: str(p.headline),
        severity: str(p.severity),
        urgency: str(p.urgency),
        certainty: str(p.certainty),
        category: str(p.category),
        status: str(p.status),
        messageType: str(p.messageType),
        areaDesc: str(p.areaDesc),
        effective: str(p.effective),
        onset: str(p.onset),
        expires: str(p.expires),
        ends: str(p.ends),
        senderName: str(p.senderName),
        description: str(p.description),
        instruction: str(p.instruction),
        response: str(p.response),
    };
}
async function loadActiveAlerts(state) {
    const params = new URLSearchParams();
    if (state !== undefined)
        params.set("area", state.toUpperCase());
    const url = params.toString() ? `${NWS_ACTIVE_URL}?${params.toString()}` : NWS_ACTIVE_URL;
    const built = new URL(url);
    if (built.hostname !== NWS_HOST || built.protocol !== "https:") {
        throw driftError(NWS_LABEL, `Constructed NWS URL host ${JSON.stringify(built.hostname)} is not ${NWS_HOST} over https — refusing to fetch (SSRF safety).`);
    }
    const body = (await getJson(url, {
        label: NWS_LABEL,
        redirect: "error",
        timeoutMs: NWS_TIMEOUT_MS,
        headers: { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" },
    }));
    if (body.type !== "FeatureCollection" || !Array.isArray(body.features)) {
        throw driftError(NWS_LABEL, "NWS active-alerts body is not a GeoJSON FeatureCollection with a features[] array — schema drift, never a fake-empty result.");
    }
    return body.features.map(mapAlert);
}
// ─── Tool: nws_active_alerts ──────────────────────────────────────
/**
 * List CURRENTLY-ACTIVE NWS weather alerts, optionally scoped by `state` (server-side
 * ?area=) and filtered client-side by `event` (substring) and/or `severity` (exact).
 * Honest `_meta` (exact match total + real-time freshness; a no-alerts result is an
 * honest empty).
 */
export async function activeAlerts(args) {
    if (args.state !== undefined && !STATE_RE.test(args.state)) {
        throw new ToolErrorCarrier({
            kind: "invalid_input",
            retryable: false,
            message: `Invalid state ${JSON.stringify(args.state)} — expected a 2-letter US state/territory code (^[A-Za-z]{2}$), e.g. "CA".`,
            upstreamEndpoint: NWS_LABEL,
        });
    }
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    const all = await loadActiveAlerts(args.state);
    const filtersApplied = [];
    if (args.state !== undefined)
        filtersApplied.push("state");
    const eventQ = args.event?.trim().toLowerCase();
    const sevQ = args.severity?.trim().toLowerCase();
    if (args.event !== undefined)
        filtersApplied.push("event");
    if (args.severity !== undefined)
        filtersApplied.push("severity");
    const matched = all.filter((a) => {
        if (eventQ && !(a.event ?? "").toLowerCase().includes(eventQ))
            return false;
        if (sevQ && (a.severity ?? "").toLowerCase() !== sevQ)
            return false;
        return true;
    });
    const totalAvailable = matched.length;
    const page = matched.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    return withMeta({ alerts: page }, {
        source: "api.weather.gov active alerts (NWS, keyless)",
        keylessMode: true,
        returned,
        totalAvailable,
        truncated: hasMore,
        filtersApplied,
        filtersDropped: [],
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes: [PROVENANCE_NOTE, FRESHNESS_NOTE],
    });
}
//# sourceMappingURL=nws-weather.js.map