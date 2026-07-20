/**
 * cbp-border.ts — CBP Border Wait Times (bwt.cbp.gov, KEYLESS) — the FREIGHT /
 * LOGISTICS lane. Live COMMERCIAL-VEHICLE (freight-truck) wait times at every US
 * land border port (Canadian + Mexican): per-port lane delays, operational status,
 * and open-lane counts. (The raw feed also carries passenger/pedestrian lanes, but
 * this tool surfaces ONLY the commercial-vehicle lanes — the freight lane.)
 * Answers "what's the current commercial-truck delay at port
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
import { getJson, driftError } from "./datasource.js";
import { memoize } from "./cache.js";
import { num } from "./coerce.js";
import { withMeta } from "./meta.js";
export const CBP_HOST = "bwt.cbp.gov";
const CBP_URL = "https://bwt.cbp.gov/api/bwtnew";
const CBP_LABEL = "cbp:border-wait-times";
const CBP_TIMEOUT_MS = 15_000;
// Real-time feed — a SHORT 60s cache (upstream politeness) while staying fresh; the
// per-lane update_time is the authoritative freshness signal, disclosed per port.
const CBP_CACHE_TTL_MS = 60_000;
const FRESHNESS_NOTE = "REAL-TIME operational data: each lane carries its own asOf/updateTime (surfaced verbatim) — this is a live border-wait snapshot, not a historical series. A closed port or lane reports operationalStatus accordingly; its delayMinutes is null (UNKNOWN), never a fabricated 0.";
const PROVENANCE_NOTE = "Source: CBP Border Wait Times API (bwt.cbp.gov), keyless. Covers all US land border ports on the Canadian and Mexican borders.";
/** Trim to a non-empty string or null (never ""). */
function s(v) {
    if (typeof v !== "string")
        return v == null ? null : String(v);
    const t = v.trim();
    return t.length > 0 ? t : null;
}
/** Map ONE lane object → curated lane (delay/lanes via `num`: 0 stays 0, ""→null). */
function mapLane(lane) {
    const l = (lane ?? {});
    return {
        operationalStatus: s(l.operational_status),
        delayMinutes: num(l.delay_minutes),
        lanesOpen: num(l.lanes_open),
        updateTime: s(l.update_time),
    };
}
function mapPort(port) {
    const cv = (port.commercial_vehicle_lanes ?? {});
    const date = s(port.date);
    const time = s(port.time);
    return {
        portNumber: s(port.port_number),
        portName: s(port.port_name),
        crossingName: s(port.crossing_name),
        border: s(port.border),
        portStatus: s(port.port_status),
        asOf: date && time ? `${date} ${time}` : (date ?? time),
        commercialVehicle: {
            maxLanes: num(cv.maximum_lanes),
            standard: mapLane(cv.standard_lanes),
            fast: mapLane(cv.FAST_lanes),
        },
    };
}
/** Fetch + parse the full port array, memoized 60s. A non-array body ⇒ driftError. */
async function loadPorts() {
    return memoize("cbp:bwt", async () => {
        const built = new URL(CBP_URL);
        if (built.hostname !== CBP_HOST || built.protocol !== "https:") {
            throw driftError(CBP_LABEL, `Constructed CBP URL host ${JSON.stringify(built.hostname)} is not ${CBP_HOST} over https — refusing to fetch (SSRF safety).`);
        }
        const body = await getJson(CBP_URL, { label: CBP_LABEL, redirect: "error", timeoutMs: CBP_TIMEOUT_MS });
        if (!Array.isArray(body)) {
            throw driftError(CBP_LABEL, "CBP Border Wait Times returned a non-array body — schema drift, never a fake-empty result.");
        }
        return body.map(mapPort);
    }, CBP_CACHE_TTL_MS);
}
// ─── Tool: cbp_border_wait_times ──────────────────────────────────
/**
 * List CBP land-border-port COMMERCIAL-VEHICLE (freight-truck) wait times, optionally
 * filtered by border (Canadian/Mexican) and/or port name (substring, applied
 * CLIENT-SIDE over the full fetched set and disclosed as such). Passenger/pedestrian
 * lanes are NOT surfaced (freight lane only). Honest `_meta` (exact match total +
 * real-time freshness).
 */
export async function borderWaitTimes(args) {
    const limit = args.limit ?? 100;
    const offset = args.offset ?? 0;
    const all = await loadPorts();
    const filtersApplied = [];
    const filtersDropped = [];
    const borderQ = args.border?.trim().toLowerCase();
    const portQ = args.portName?.trim().toLowerCase();
    // [filter honesty] Only claim a filter APPLIED when its query is non-empty — a
    // border:"" / portName:"" (or whitespace) narrows nothing, so reporting it as
    // applied while returning every port would be a false filtersApplied.
    if (args.border !== undefined) {
        if (borderQ)
            filtersApplied.push("border");
        else
            filtersDropped.push("border(empty)");
    }
    if (args.portName !== undefined) {
        if (portQ)
            filtersApplied.push("portName");
        else
            filtersDropped.push("portName(empty)");
    }
    const matched = all.filter((p) => {
        if (borderQ && !(p.border ?? "").toLowerCase().includes(borderQ))
            return false;
        if (portQ && !(p.portName ?? "").toLowerCase().includes(portQ))
            return false;
        return true;
    });
    const totalAvailable = matched.length;
    const page = matched.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < totalAvailable;
    const nextOffset = hasMore ? offset + returned : null;
    const notes = [PROVENANCE_NOTE, FRESHNESS_NOTE];
    if (filtersApplied.length > 0) {
        notes.push("border / portName are applied CLIENT-SIDE over the full live port set (fetched in ONE request — the CBP feed has no server-side filter); totalAvailable is the EXACT matched count over that full set.");
    }
    return withMeta({ ports: page }, {
        source: "bwt.cbp.gov Border Wait Times (keyless)",
        keylessMode: true,
        returned,
        totalAvailable,
        truncated: hasMore,
        filtersApplied,
        filtersDropped,
        fieldsUnavailable: [],
        pagination: { offset, limit, hasMore, nextOffset },
        notes,
    });
}
//# sourceMappingURL=cbp-border.js.map