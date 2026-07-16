/**
 * cbp-border.ts — CBP Border Wait Times (bwt.cbp.gov, KEYLESS) — the FREIGHT /
 * LOGISTICS lane. Live commercial-vehicle (and passenger) wait times at every US
 * land border port (Canadian + Mexican): per-port lane delays, operational status,
 * and open-lane counts. Answers "what's the current commercial-truck delay at port
 * X" — real-time freight-crossing situational awareness for logistics/trade vendors.
 *
 * SOURCE: CBP's official Border Wait Times API (bwt.cbp.gov/api/bwtnew) — a .gov host,
 * keyless, returns a JSON ARRAY of ports. This is REAL-TIME operational data: each
 * lane carries its own `update_time` (surfaced verbatim) — freshness is disclosed and
 * never implied to be live-to-the-second.
 *
 * HONESTY: fixed host + redirect:"error" (SSRF); a non-array body ⇒ driftError (never
 * a fake empty); an outage/4xx/timeout THROWS. delay/lanes are upstream STRINGS →
 * number|null (a real 0 stays 0; an empty/N/A value is null, NEVER a fabricated 0 — a
 * closed lane's delay is UNKNOWN, not "0 minutes"). totalAvailable = the EXACT count
 * of matched ports (client-side filter; the API returns the whole set).
 */
import { type MetaBundle } from "./meta.js";
export declare const CBP_HOST = "bwt.cbp.gov";
export type CbpLane = {
    operationalStatus: string | null;
    delayMinutes: number | null;
    lanesOpen: number | null;
    updateTime: string | null;
};
export type CbpPort = {
    portNumber: string | null;
    portName: string | null;
    crossingName: string | null;
    border: string | null;
    portStatus: string | null;
    asOf: string | null;
    commercialVehicle: {
        maxLanes: number | null;
        standard: CbpLane;
        fast: CbpLane;
    };
};
/**
 * List CBP land-border-port commercial-vehicle (+ passenger) wait times, optionally
 * filtered by border (Canadian/Mexican) and/or port name (substring). Client-side
 * filter over the live feed; honest `_meta` (exact match total + real-time freshness).
 */
export declare function borderWaitTimes(args: {
    border?: string;
    portName?: string;
    limit?: number;
    offset?: number;
}): Promise<MetaBundle>;
//# sourceMappingURL=cbp-border.d.ts.map