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
/** The X-Api-Key header — the ONLY carrier of the secret. Never logged/echoed. */
export declare function keyHeader(): Record<string, string>;
/** true when no real DATA_GOV_API_KEY is configured (drives the disclosure note). */
export declare function usingDemoKey(): boolean;
/** Key-MODE label for `_meta.source` — the MODE, never the value. */
export declare function keyModeLabel(): string;
/** Push the key-mode disclosure note (DEMO_KEY ceiling OR configured-key). */
export declare function pushKeyNote(notes: string[]): void;
//# sourceMappingURL=datagovKey.d.ts.map