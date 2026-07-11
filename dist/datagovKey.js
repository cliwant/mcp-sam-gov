/**
 * datagovKey.ts — the SHARED api.data.gov KEY seam (ADR-0010 §2).
 *
 * These api.data.gov key helpers were originally module-private in `datagov.ts`
 * (ADR-0007, the FIRST keyed source). GovInfo (ADR-0010) is the SECOND consumer
 * of the identical DATA_GOV_API_KEY / DEMO_KEY / X-Api-Key discipline, which is
 * the trigger to promote the helper to a single audited home — the exact
 * `coerce.ts` precedent applied to a SECRET: a leak-discipline regression must now
 * fail BOTH consumers' key-never-leaks tests at once, not hide in one of two
 * drifting copies. `datagov.ts` AND `govinfo.ts` each import from here; NEITHER
 * imports the other.
 *
 * This extraction is BEHAVIOR BYTE-IDENTICAL to the prior inlined `datagov.ts`
 * code — these are pure functions that read `process.env` at CALL time, so moving
 * them changes nothing (datagov's key handling, `_meta`, tools/list snapshot, and
 * its key-never-leaks K-test all stay green; the K-test spies on the GLOBAL
 * `fetch`, which is unaffected by this move).
 *
 * ★ THE KEY-SECURITY DISCIPLINE (ADR-0007 §2 — the load-bearing rules):
 *  1. The key travels in `headers:{ "X-Api-Key": <key> }` ONLY — NEVER in the
 *     URL/query (no `?api_key=`).
 *  2. `_meta.source`/`notes` are host + key-MODE only ("…(DEMO_KEY)" /
 *     "…(DATA_GOV_API_KEY)") — never the URL, never the key value, never the
 *     `X-Api-Key` header.
 *  3. Never commit the key — read from env only; the DEMO_KEY fallback is a
 *     literal public constant (safe in source), the real key never is.
 */
// ─── Key resolver (the load-bearing secret discipline) ────────────
// The key is read from env; if unset/empty it falls back to the public literal
// "DEMO_KEY". `keyHeader()` is the ONLY place the value is used — it is placed in
// the `X-Api-Key` request header and NOWHERE else (never the URL, never the label,
// never `_meta`, never a log).
const DEMO_KEY = "DEMO_KEY";
function resolvedKey() {
    const raw = process.env.DATA_GOV_API_KEY;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed ? trimmed : DEMO_KEY;
}
/** The X-Api-Key header — the ONLY carrier of the secret. Never logged/echoed. */
export function keyHeader() {
    return { "X-Api-Key": resolvedKey() };
}
/** true when no real DATA_GOV_API_KEY is configured (drives the disclosure note). */
export function usingDemoKey() {
    const raw = process.env.DATA_GOV_API_KEY;
    return !(typeof raw === "string" && raw.trim());
}
/** Key-MODE label for `_meta.source` — the MODE, never the value. */
export function keyModeLabel() {
    return usingDemoKey() ? "DEMO_KEY" : "DATA_GOV_API_KEY";
}
// The DEMO_KEY disclosure (m4-note: NO hardcoded verification date — "approximately
// 10 requests/hour", not a pinned date).
const DEMO_KEY_NOTE = "Using the shared api.data.gov DEMO_KEY — approximately 10 requests/hour, shared across all DEMO_KEY callers (limits reached quickly). Set DATA_GOV_API_KEY for production; free key at https://api.data.gov/signup/.";
const CONFIGURED_KEY_NOTE = "Using a configured DATA_GOV_API_KEY (value never logged).";
/** Push the key-mode disclosure note (DEMO_KEY ceiling OR configured-key). */
export function pushKeyNote(notes) {
    notes.push(usingDemoKey() ? DEMO_KEY_NOTE : CONFIGURED_KEY_NOTE);
}
//# sourceMappingURL=datagovKey.js.map