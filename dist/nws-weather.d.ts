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
import { type MetaBundle } from "./meta.js";
export declare const NWS_HOST = "api.weather.gov";
export type NwsAlert = {
    id: string | null;
    event: string | null;
    headline: string | null;
    severity: string | null;
    urgency: string | null;
    certainty: string | null;
    category: string | null;
    status: string | null;
    messageType: string | null;
    areaDesc: string | null;
    effective: string | null;
    onset: string | null;
    expires: string | null;
    ends: string | null;
    senderName: string | null;
    description: string | null;
    instruction: string | null;
    response: string | null;
};
/**
 * List CURRENTLY-ACTIVE NWS weather alerts, optionally scoped by `state` (server-side
 * ?area=) and filtered client-side by `event` (substring) and/or `severity` (exact).
 * Honest `_meta` (exact match total + real-time freshness; a no-alerts result is an
 * honest empty).
 */
export declare function activeAlerts(args: {
    state?: string;
    event?: string;
    severity?: string;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
//# sourceMappingURL=nws-weather.d.ts.map