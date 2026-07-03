/**
 * GAO bid-protest lookup (keyless) — recent Comptroller General bid-protest
 * decisions from the public GAO "Legal Products" RSS feed, optionally enriched
 * from each decision's public product page.
 *
 * HONEST SCOPE (the defining constraint of this tool)
 * ---------------------------------------------------
 * Keyless access covers ONLY the RECENT decisions carried by the public
 * Legal-Products RSS feed (a rolling ~25-item window). GAO's faceted historical
 * bid-protest search (by protester / agency / outcome / date across all years,
 * at https://www.gao.gov/legal/bid-protests/search) is WAF-protected against
 * automated clients and is available cleanly only via a PAID third-party API.
 * So this tool NEVER presents "recent" as "all": its `_meta` is ALWAYS
 * `complete:false` + `truncated:true`, `totalAvailable` is `null` (the feed is
 * not a count of all protests), and a top-level `accessNote` + a `_meta` note
 * spell out the boundary. This is an intentional PARTIAL close of a capability
 * that a competitor (Tango) sells as a paid feature.
 *
 * LIVE-VERIFIED 2026-07-03
 * ------------------------
 *   - `GET https://www.gao.gov/rss/reportslegal.xml` with a browser UA → HTTP
 *     200, application/rss+xml, ~14.6 KB, 26 <item>s. The feed carries GAO
 *     Legal Products — bid-protest DECISIONS *and* other legal products
 *     (Congressional Review Act regulatory reviews, legal opinions), so it MUST
 *     be filtered down to bid protests.
 *   - Each <item> has <title>, <link> (…/products/b-XXXXXX), <description>,
 *     <pubDate>, <guid>. A reconsideration reads "FCN Inc.--Reconsideration" →
 *     /products/b-424249.2; a costs decision "Accura Engineering--Costs".
 *   - Bid-protest items are reliably identified by their DESCRIPTION language
 *     ("protest(s)", "protester", "request(s) reconsideration of our decision")
 *     — regulatory reviews instead read "GAO reviewed the …'s new rule entitled".
 *     Protest B-numbers are the B-4xxxxx series; CRA reviews are B-33xxxx.
 *   - `GET https://www.gao.gov/products/b-XXXXXX` (browser UA) is cleanly
 *     parseable for protester (+ city/state), contracting agency, decision date,
 *     outcome ("We deny/sustain/dismiss the protest"), a solicitation number
 *     when present, and a decision-PDF link (/assets/.../NNNNNN.pdf).
 */
type Outcome = "sustained" | "denied" | "dismissed" | "withdrawn";
type Decision = {
    bNumber: string;
    protester: string | null;
    agency: string | null;
    decisionDate: string | null;
    solicitationNumber: string | null;
    outcome: Outcome | null;
    title: string;
    decisionUrl: string;
    pdfUrl: string | null;
    summary: string | null;
};
export declare function gaoProtestLookup(args: {
    agency?: string;
    protester?: string;
    solicitationNumber?: string;
    outcome?: "sustained" | "denied" | "dismissed" | "withdrawn" | "any";
    bNumber?: string;
    limit?: number;
    enrich?: boolean;
}): Promise<import("./meta.js").MetaBundle<{
    accessNote: string;
    decisions: Decision[];
}>>;
export {};
//# sourceMappingURL=gao.d.ts.map