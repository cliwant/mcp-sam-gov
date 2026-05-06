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

export type FedRegClass =
  | "far_amendment"
  | "set_aside_policy"
  | "system_retirement"
  | "rule_change"
  | "admin_paperwork"
  | "uncategorized";

export type ClassificationInput = {
  title?: string;
  abstract?: string;
  /** "RULE" | "PRORULE" | "NOTICE" | "PRESDOCU" | "UNKNOWN" */
  type?: string;
  /** typeDisplay from the API: "Rule" | "Proposed Rule" | "Notice" | ... */
  typeDisplay?: string;
  agencies?: Array<{ name?: string; slug?: string }>;
  cfrReferences?: Array<{ title?: string | number; part?: string; chapter?: string }>;
};

export type ClassificationResult = {
  primaryClass: FedRegClass;
  confidence: "high" | "medium" | "low";
  /** 0–100, derived from matched signal weights */
  score: number;
  signals: Array<{ class: FedRegClass; pattern: string; weight: number }>;
  /** Score by class for callers that want to inspect ambiguous cases. */
  scoresByClass: Record<FedRegClass, number>;
  rationale: string;
};

type Pattern = {
  /** Class this pattern contributes to. */
  cls: FedRegClass;
  /** Human-readable name for `signals` output. */
  name: string;
  /** Where to look. */
  field: "title" | "abstract" | "any" | "cfr" | "type";
  /** Regex (case-insensitive) or exact-match check for `cfr` / `type`. */
  test: RegExp | ((input: ClassificationInput) => boolean);
  /** Score weight when matched. */
  weight: number;
};

const PATTERNS: Pattern[] = [
  // ─── FAR amendment (highest specificity) ─────────────────────
  {
    cls: "far_amendment",
    name: "cfr-title-48-far",
    field: "cfr",
    test: (i) =>
      (i.cfrReferences ?? []).some(
        (c) => String(c.title) === "48",
      ),
    weight: 50,
  },
  {
    cls: "far_amendment",
    name: "title-far-clause-or-case",
    field: "title",
    test: /\b(far\s+(?:case|clause|rule|amendment|update)|federal\s+acquisition\s+regulation)\b/i,
    weight: 40,
  },
  {
    cls: "far_amendment",
    name: "title-dfars",
    field: "title",
    test: /\bdfars\b|\bdefense\s+federal\s+acquisition\s+regulation\b/i,
    weight: 35,
  },
  {
    cls: "far_amendment",
    name: "abstract-far-clause",
    field: "abstract",
    test: /\bfar\s+(?:clause|case|part|subpart)\s+\d/i,
    weight: 25,
  },

  // ─── Set-aside policy ────────────────────────────────────────
  {
    cls: "set_aside_policy",
    name: "title-small-business",
    field: "title",
    test: /\bsmall\s+business\b|\b8\(a\)\b|\bsdvosb\b|\bwosb\b|\bhubzone\b|\bservice[-\s]disabled\s+veteran\b|\bwomen[-\s]owned\b|\bsocially\s+(?:and|&)\s+economically\s+disadvantaged\b/i,
    weight: 35,
  },
  {
    cls: "set_aside_policy",
    name: "title-set-aside",
    field: "title",
    test: /\bset[-\s]aside\b|\bsole\s+source\b/i,
    weight: 30,
  },
  {
    cls: "set_aside_policy",
    name: "title-size-standard",
    field: "title",
    test: /\bsize\s+standard\b/i,
    weight: 30,
  },
  {
    cls: "set_aside_policy",
    name: "cfr-title-13",
    field: "cfr",
    test: (i) =>
      (i.cfrReferences ?? []).some(
        (c) => String(c.title) === "13" && (c.part === "121" || c.part === "124" || c.part === "125" || c.part === "126" || c.part === "127" || c.part === "128"),
      ),
    weight: 30,
  },
  {
    cls: "set_aside_policy",
    name: "agency-sba",
    field: "any",
    test: (i) =>
      (i.agencies ?? []).some((a) => /small[-\s]business|sba/i.test(a.name ?? "") || a.slug === "small-business-administration"),
    weight: 15,
  },

  // ─── System retirement / sunset ──────────────────────────────
  {
    cls: "system_retirement",
    name: "title-sunset-retire",
    field: "title",
    test: /\b(sunset|retir(?:e|ement|ing)|decommissioning|decommission|wind[-\s]down|phase[-\s]out|discontinu(?:e|ation|ing)|terminat(?:e|ion|ing)\s+of\s+(?:the\s+)?(?:program|system|portal))\b/i,
    weight: 35,
  },
  {
    cls: "system_retirement",
    name: "title-replace-with",
    field: "title",
    test: /\b(replace[ds]?\s+by|replacement\s+for|migrating\s+from|migrat(?:e|ing)\s+to)\b/i,
    weight: 20,
  },
  {
    cls: "system_retirement",
    name: "abstract-sunset-replacement",
    field: "abstract",
    test: /\b(will\s+be\s+(?:retired|sunset|decommissioned)|no\s+longer\s+be\s+available|cease\s+operations?)\b/i,
    weight: 25,
  },

  // ─── Admin / paperwork (PRA notices, info collection) ────────
  {
    cls: "admin_paperwork",
    name: "title-paperwork-reduction",
    field: "title",
    test: /\bpaperwork\s+reduction\s+act\b/i,
    weight: 40,
  },
  {
    cls: "admin_paperwork",
    name: "title-information-collection",
    field: "title",
    test: /\b(information\s+collection|agency\s+information\s+collection|submission\s+to\s+omb|request\s+for\s+comments?\s+on\s+(?:proposed|new|extension|reinstatement))\b/i,
    weight: 30,
  },
  {
    cls: "admin_paperwork",
    name: "title-30-day-60-day-notice",
    field: "title",
    test: /\b(?:30|60)[-\s]day\s+notice\b/i,
    weight: 25,
  },
  {
    cls: "admin_paperwork",
    name: "title-meeting-or-hearing",
    field: "title",
    test: /\b(public\s+meeting|notice\s+of\s+meeting|advisory\s+committee\s+meeting|public\s+hearing)\b/i,
    weight: 20,
  },
  {
    cls: "admin_paperwork",
    name: "title-privacy-act-system",
    field: "title",
    test: /\bprivacy\s+act\s+(?:of\s+1974\s*;\s*)?system\s+of\s+records?\b|\bsorn\b/i,
    weight: 25,
  },

  // ─── Generic rule change (catch-all when nothing more specific) ──
  {
    cls: "rule_change",
    name: "type-rule",
    field: "type",
    test: (i) => i.type === "RULE" || i.typeDisplay === "Rule",
    weight: 15,
  },
  {
    cls: "rule_change",
    name: "type-proposed-rule",
    field: "type",
    test: (i) => i.type === "PRORULE" || i.typeDisplay === "Proposed Rule",
    weight: 15,
  },
  {
    cls: "rule_change",
    name: "title-final-rule",
    field: "title",
    test: /\b(final\s+rule|proposed\s+rule|interim\s+final\s+rule|direct\s+final\s+rule)\b/i,
    weight: 15,
  },
  {
    cls: "rule_change",
    name: "title-amendment-revision",
    field: "title",
    test: /\b(amendment\s+to|revisions?\s+to|amendments?\s+to)\b/i,
    weight: 10,
  },
];

function fieldText(input: ClassificationInput, field: Pattern["field"]): string {
  switch (field) {
    case "title":
      return (input.title ?? "").toLowerCase();
    case "abstract":
      return (input.abstract ?? "").toLowerCase();
    case "any":
      return [
        input.title ?? "",
        input.abstract ?? "",
        ...(input.agencies ?? []).map((a) => a.name ?? ""),
      ]
        .join(" \n ")
        .toLowerCase();
    default:
      return "";
  }
}

const ZERO_SCORES: Record<FedRegClass, number> = {
  far_amendment: 0,
  set_aside_policy: 0,
  system_retirement: 0,
  rule_change: 0,
  admin_paperwork: 0,
  uncategorized: 0,
};

const CLASS_PRIORITY: FedRegClass[] = [
  "far_amendment",
  "set_aside_policy",
  "system_retirement",
  "admin_paperwork",
  "rule_change",
];

export function classifyDocument(input: ClassificationInput): ClassificationResult {
  const scoresByClass: Record<FedRegClass, number> = { ...ZERO_SCORES };
  const signals: ClassificationResult["signals"] = [];

  for (const p of PATTERNS) {
    let matched = false;
    if (typeof p.test === "function") {
      matched = p.test(input);
    } else {
      const text = fieldText(input, p.field);
      if (text) matched = p.test.test(text);
    }
    if (matched) {
      scoresByClass[p.cls] += p.weight;
      signals.push({ class: p.cls, pattern: p.name, weight: p.weight });
    }
  }

  // Pick winner: highest score, ties broken by CLASS_PRIORITY order.
  let primary: FedRegClass = "uncategorized";
  let bestScore = 0;
  for (const cls of CLASS_PRIORITY) {
    if (scoresByClass[cls] > bestScore) {
      bestScore = scoresByClass[cls];
      primary = cls;
    }
  }

  // If admin_paperwork outscored rule_change but the doc is also a Rule,
  // PRA scoring should still win — admin scores are higher by design.

  // Confidence buckets:
  //   ≥ 50  → high
  //   20–49 → medium
  //   1–19  → low
  //   0     → uncategorized
  const score = Math.min(100, bestScore);
  let confidence: ClassificationResult["confidence"] = "low";
  if (score >= 50) confidence = "high";
  else if (score >= 20) confidence = "medium";

  if (bestScore === 0) {
    primary = "uncategorized";
  }

  const rationale = buildRationale(primary, signals, input);

  return {
    primaryClass: primary,
    confidence,
    score,
    signals: signals.filter((s) => s.class === primary),
    scoresByClass,
    rationale,
  };
}

function buildRationale(
  cls: FedRegClass,
  signals: ClassificationResult["signals"],
  input: ClassificationInput,
): string {
  if (cls === "uncategorized") {
    return "No federal-contracting-relevant signals matched. The notice may be a generic agency action outside this classifier's scope.";
  }
  const own = signals.filter((s) => s.class === cls).map((s) => s.pattern);
  const labels: Record<FedRegClass, string> = {
    far_amendment: "FAR amendment",
    set_aside_policy: "Set-aside / small business policy",
    system_retirement: "System retirement / sunset",
    rule_change: "Generic rule change",
    admin_paperwork: "Administrative paperwork (PRA / info collection)",
    uncategorized: "Uncategorized",
  };
  const docType = input.typeDisplay || input.type || "Document";
  return `Classified as "${labels[cls]}" (${docType}). Matched signals: ${own.join(", ") || "(none — fallback)"}.`;
}

/**
 * Batch-classify a list of FedReg search results.
 *
 * Returns the original list re-shaped with classification + a top-level
 * histogram of class counts, so callers can immediately answer:
 *   "of the last 50 SBA notices, how many were paperwork vs. real rules?"
 */
export function classifyBatch<T extends ClassificationInput>(
  docs: T[],
): {
  documents: Array<T & { classification: ClassificationResult }>;
  histogram: Record<FedRegClass, number>;
} {
  const histogram: Record<FedRegClass, number> = { ...ZERO_SCORES };
  const documents = docs.map((d) => {
    const classification = classifyDocument(d);
    histogram[classification.primaryClass] = (histogram[classification.primaryClass] ?? 0) + 1;
    return { ...d, classification };
  });
  return { documents, histogram };
}
