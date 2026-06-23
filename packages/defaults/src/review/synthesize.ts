// The structured side of review: a throw-on-mismatch parser for the pass reply (the agent returns
// JSON against `findingsSchema`), and the pure synthesis of the review result into the single
// `reviewSummary` markdown. Risk is computed here, in code - the agent never sets the overall
// risk. No `ctx`, so all of this is unit-testable in isolation.

import { parseAgentFindingsOutput, type Finding, renderFindingForPr } from "@tml/core";

export type { Finding };
export type Risk = "low" | "medium" | "high";

export interface PassResult {
  readonly findings: Finding[];
}

/** A pass paired with the human-facing section title `summarize` renders it under. */
export interface ReviewPass {
  readonly title: string;
  readonly result: PassResult;
}

/** Validate one pass's structured reply into a `PassResult`, throwing on anything malformed. */
export function parsePassResult(output: unknown): PassResult {
  if (typeof output !== "object" || output === null) {
    throw new Error("review: the agent did not return a structured pass result");
  }
  return {
    findings: parseAgentFindingsOutput(output, {
      namespace: "review",
      sourceName: "review",
      enforceActionForDisposition: true,
    }),
  };
}

/** Strongest disposition wins. */
export function riskOf(findings: readonly Finding[]): Risk {
  if (findings.some((f) => f.disposition === "blocker")) return "high";
  if (findings.some((f) => f.disposition === "should-fix")) return "medium";
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

/** Fold the passes into the `reviewSummary` markdown. Above the fold: risk, a one-line tally,
 *  and the fixes applied. The full review breakdown is tucked into a collapsible `<details>` so
 *  the PR body stays scannable. Deterministic. */
export function summarize(
  passes: readonly ReviewPass[],
  fixSummary: string,
  options: SummarizeOptions = {},
): string {
  const all = passes.flatMap((p) => p.result.findings);
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

  const head: string[] = [`**Risk: ${riskOf(all)}**`, ""];

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
    if (pass.result.findings.length === 0) continue;
    body.push(`### ${pass.title}`);
    for (const f of pass.result.findings) body.push(renderFinding(f, fixedFindingIds));
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
