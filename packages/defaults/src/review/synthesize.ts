// The structured side of the multi-pass review: a throw-on-mismatch parser for each pass's
// reply (the agent returns JSON against `findingsSchema`), and the pure synthesis of all passes
// into the single `reviewSummary` markdown. Risk is computed here, in code - the agent never sets
// the overall risk. No `ctx`, so all of this is unit-testable in isolation.

import { parseAgentFindingsOutput, type Finding, renderFindingForPr } from "@tml/core";

export type { Finding };
export type Verdict = "proceed" | "block";
export type Risk = "low" | "medium" | "high";

export interface PassResult {
  readonly findings: Finding[];
  /** Set by the context pass: a plain-language restatement of the change, threaded forward. */
  readonly understanding?: string;
  /** Set by the architecture pass: `block` records a high-risk concern (it does not halt). */
  readonly verdict?: Verdict;
}

/** A pass paired with the human-facing section title `summarize` renders it under. */
export interface ReviewPass {
  readonly title: string;
  readonly result: PassResult;
}

function normalizeFindingKeyPart(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function findingDedupeKey(finding: Finding): string {
  const title = normalizeFindingKeyPart(finding.title);
  const location = normalizeFindingKeyPart(finding.location);
  if (location.length > 0) return `${location}\u0000${title}`;
  return `${title}\u0000${normalizeFindingKeyPart(finding.detail)}`;
}

function severityPriority(severity: Finding["severity"]): number {
  if (severity === "error") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function actionPriority(action: Finding["action"]): number {
  if (action === "auto-fix") return 3;
  if (action === "ask-user") return 2;
  return 1;
}

function findingPriority(finding: Finding): readonly [number, number] {
  return [severityPriority(finding.severity), actionPriority(finding.action)];
}

function isHigherPriority(candidate: Finding, current: Finding): boolean {
  const [candidateSeverity, candidateAction] = findingPriority(candidate);
  const [currentSeverity, currentAction] = findingPriority(current);
  return (
    candidateSeverity > currentSeverity ||
    (candidateSeverity === currentSeverity && candidateAction > currentAction)
  );
}

/** Keep one report per finding key, preferring the highest-severity, most-actionable version. */
export function dedupeReviewPasses(passes: readonly ReviewPass[]): ReviewPass[] {
  const best = new Map<string, Finding>();
  for (const pass of passes) {
    for (const finding of pass.result.findings) {
      const key = findingDedupeKey(finding);
      const current = best.get(key);
      if (current === undefined || isHigherPriority(finding, current)) best.set(key, finding);
    }
  }
  return passes.map((pass) => ({
    title: pass.title,
    result: {
      ...pass.result,
      findings: pass.result.findings.filter(
        (finding) => best.get(findingDedupeKey(finding)) === finding,
      ),
    },
  }));
}

const VERDICTS: ReadonlySet<string> = new Set(["proceed", "block"]);

/** Validate one pass's structured reply into a `PassResult`, throwing on anything malformed. */
export function parsePassResult(output: unknown): PassResult {
  if (typeof output !== "object" || output === null) {
    throw new Error("review: the agent did not return a structured pass result");
  }
  const obj = output as Record<string, unknown>;
  const findings = parseAgentFindingsOutput(output, {
    namespace: "review",
    sourceName: "review",
    enforceActionForSeverity: true,
  });
  const result: { -readonly [K in keyof PassResult]: PassResult[K] } = { findings };
  if (typeof obj.understanding === "string" && obj.understanding.trim().length > 0) {
    result.understanding = obj.understanding.trim();
  }
  if (obj.verdict !== undefined) {
    if (typeof obj.verdict !== "string" || !VERDICTS.has(obj.verdict)) {
      throw new Error("review: the pass result has an invalid verdict");
    }
    result.verdict = obj.verdict as Verdict;
  }
  return result;
}

/** Highest severity wins; a blocking verdict forces high regardless of the findings. */
export function riskOf(findings: readonly Finding[], blocked = false): Risk {
  if (blocked || findings.some((f) => f.severity === "error")) return "high";
  if (findings.some((f) => f.severity === "warning")) return "medium";
  return "low";
}

function renderFinding(f: Finding, fixedFindingIds: ReadonlySet<string> | undefined): string {
  const text = renderFindingForPr(f);
  // By default, preserve the original one-shot review behavior: auto-fix findings in the
  // summarized passes were handed to the fix pass and read as already handled. Round-based review
  // can pass an explicit fixed-id set when summarizing a verification pass, where an auto-fix
  // finding still present is unresolved and must not be struck through.
  if (f.action === "auto-fix" && (fixedFindingIds === undefined || fixedFindingIds.has(f.id))) {
    return `- ~~${text.slice(2)}~~ (fixed)`;
  }
  return text;
}

export interface SummarizeOptions {
  readonly fixedFindingIds?: readonly string[];
}

/** Fold the passes into the `reviewSummary` markdown. Above the fold: a blocking banner (if
 *  any), the risk, a one-line tally, and the fixes applied. The full per-phase breakdown is
 *  tucked into a collapsible `<details>` so the PR body stays scannable. Deterministic. */
export function summarize(
  passes: readonly ReviewPass[],
  fixSummary: string,
  options: SummarizeOptions = {},
): string {
  const all = passes.flatMap((p) => p.result.findings);
  const blocked = passes.some((p) => p.result.verdict === "block");
  const fixes = fixSummary.trim();
  const fixedFindingIds =
    options.fixedFindingIds === undefined ? undefined : new Set(options.fixedFindingIds);

  const fixed = all.filter(
    (f) => f.action === "auto-fix" && (fixedFindingIds === undefined || fixedFindingIds.has(f.id)),
  ).length;
  const unresolvedAutoFix = all.filter(
    (f) => f.action === "auto-fix" && fixedFindingIds !== undefined && !fixedFindingIds.has(f.id),
  ).length;
  const decide = all.filter((f) => f.action === "ask-user").length;
  const info = all.filter((f) => f.action === "no-op").length;

  const head: string[] = [];
  if (blocked) {
    head.push(
      "> **Blocking concern (architecture & scope).** This change was flagged as fundamentally " +
        "risky, out of scope, or too large to review safely - expand the full review below " +
        "before merging.",
      "",
    );
  }
  head.push(`**Risk: ${riskOf(all, blocked)}**`, "");

  const tally = [
    fixed > 0 ? `${fixed} fixed` : null,
    unresolvedAutoFix > 0
      ? `${unresolvedAutoFix} ${unresolvedAutoFix === 1 ? "still needs" : "still need"} an auto-fix`
      : null,
    decide > 0 ? `${decide} ${decide === 1 ? "needs" : "need"} your decision` : null,
    info > 0 ? `${info} informational` : null,
  ].filter((s): s is string => s !== null);
  if (tally.length > 0) head.push(tally.join(" · "), "");
  if (fixes.length > 0) head.push(`**Fixes applied:** ${fixes}`, "");

  // The full, per-phase breakdown - collapsed by default.
  const body: string[] = [];
  for (const pass of passes) {
    if (pass.result.findings.length === 0 && pass.result.verdict !== "block") continue;
    body.push(`### ${pass.title}`);
    if (pass.result.findings.length === 0) {
      body.push("- Blocking verdict returned without specific findings.");
    } else {
      for (const f of pass.result.findings) body.push(renderFinding(f, fixedFindingIds));
    }
    body.push("");
  }

  const lines = [...head];
  if (body.length > 0) {
    lines.push("<details>", "<summary>Full review</summary>", "", ...body, "</details>");
  } else {
    lines.push("No findings.");
  }
  return lines.join("\n").trim();
}
