/**
 * Federal Register notice classifier — heuristic, keyless, deterministic.
 *
 * Maps a single Federal Register document (or a precomputed bundle of
 * {title, abstract, type, agencies, cfrReferences}) to one of five
 * federal-contracting-relevant classes plus a confidence score.
 *
 * Why heuristic, not ML: the signal is overwhelmingly in the title +
 * CFR refs + a small lexicon of trigger phrases. Rule-based gives us
 * deterministic, auditable, cite-able classification with zero deps,
 * which is what an MCP-served tool actually needs (no model warmup,
 * no token spend, transparent to the calling agent).
 *
 * Classes (priority order — higher priority wins on tie):
 *   1. far_amendment       — FAR (CFR title 48) rule changes; highest specificity
 *   2. set_aside_policy    — small business / 8(a) / SDVOSB / WOSB / HUBZone
 *   3. system_retirement   — sunset, retirement, replacement, decommission of fed system
 *   4. rule_change         — generic substantive rule (Rule, Proposed Rule)
 *   5. admin_paperwork     — Paperwork Reduction Act notices, info collection, etc.
 *
 * Each class has a list of trigger patterns (regex on lowercased text)
 * and weight contributions. The `signals` field in the output names
 * which patterns matched — so the agent can quote evidence.
 */
export type FedRegClass = "far_amendment" | "set_aside_policy" | "system_retirement" | "rule_change" | "admin_paperwork" | "uncategorized";
export type ClassificationInput = {
    title?: string;
    abstract?: string;
    /** "RULE" | "PRORULE" | "NOTICE" | "PRESDOCU" | "UNKNOWN" */
    type?: string;
    /** typeDisplay from the API: "Rule" | "Proposed Rule" | "Notice" | ... */
    typeDisplay?: string;
    agencies?: Array<{
        name?: string;
        slug?: string;
    }>;
    cfrReferences?: Array<{
        title?: string | number;
        part?: string;
        chapter?: string;
    }>;
};
export type ClassificationResult = {
    primaryClass: FedRegClass;
    confidence: "high" | "medium" | "low";
    /** 0–100, derived from matched signal weights */
    score: number;
    signals: Array<{
        class: FedRegClass;
        pattern: string;
        weight: number;
    }>;
    /** Score by class for callers that want to inspect ambiguous cases. */
    scoresByClass: Record<FedRegClass, number>;
    rationale: string;
};
export declare function classifyDocument(input: ClassificationInput): ClassificationResult;
/**
 * Batch-classify a list of FedReg search results.
 *
 * Returns the original list re-shaped with classification + a top-level
 * histogram of class counts, so callers can immediately answer:
 *   "of the last 50 SBA notices, how many were paperwork vs. real rules?"
 */
export declare function classifyBatch<T extends ClassificationInput>(docs: T[]): {
    documents: Array<T & {
        classification: ClassificationResult;
    }>;
    histogram: Record<FedRegClass, number>;
};
//# sourceMappingURL=fedreg-classifier.d.ts.map