import { describe, expect, test } from "bun:test";
import {
  currentFindings,
  findingId,
  makeFinding,
  renderFindingForPr,
  renderPipelineSummaryForPr,
  renderRoundForPr,
  renderRoundsForPr,
  renderUnresolvedFindingsForPr,
  summarizeStepRounds,
  type FindingInput,
} from "../src/round.ts";

const input: FindingInput = {
  severity: "warning",
  action: "ask-user",
  title: "Confirm contract",
  detail: "The new behavior changes the public surface.",
  location: "src/api.ts:12",
};

describe("shared finding records", () => {
  test("finding IDs are deterministic and namespaced", () => {
    expect(findingId("review", input)).toBe(findingId("review", { ...input }));
    expect(findingId("lint", input)).not.toBe(findingId("review", input));
  });

  test("makeFinding attaches the deterministic ID", () => {
    expect(makeFinding("review", input)).toEqual({ ...input, id: findingId("review", input) });
  });
});

describe("PR summary rendering", () => {
  test("renders findings and rounds without side effects", () => {
    const finding = makeFinding("review", input);
    expect(renderFindingForPr(finding)).toContain("Warning: `src/api.ts:12` Confirm contract");

    const round = {
      step: "review",
      index: 0,
      trigger: "initial" as const,
      findings: [finding],
      selectedFindingIds: [finding.id],
      fixSummary: "No safe fix applied.",
      commitSha: "abc123",
    };
    const rendered = renderRoundForPr(round);
    expect(rendered).toContain("### review round 0");
    expect(rendered).toContain("Fixes applied: No safe fix applied.");
    expect(rendered).toContain(finding.id);
    expect(renderRoundsForPr([round])).toBe(rendered);
    expect(renderRoundsForPr([])).toBe("No rounds recorded.");
  });

  test("summarizes current unresolved findings from the latest round per Step", () => {
    const reviewFinding = makeFinding("review", input);
    const lintFinding = makeFinding("lint", {
      severity: "error",
      action: "auto-fix",
      title: "Lint failed",
      detail: "Run the formatter.",
    });
    const rounds = [
      { step: "review", index: 0, trigger: "initial" as const, findings: [reviewFinding] },
      { step: "lint", index: 0, trigger: "initial" as const, findings: [lintFinding] },
      { step: "lint", index: 1, trigger: "auto_fix" as const, findings: [lintFinding] },
      { step: "lint", index: 2, trigger: "verify" as const, findings: [] },
    ];

    expect(currentFindings(rounds)).toEqual([reviewFinding]);
    expect(summarizeStepRounds(rounds)).toEqual([
      {
        step: "review",
        rounds: 1,
        autoFixes: 0,
        finalTrigger: "initial",
        finalFindings: 1,
        status: "unresolved",
      },
      {
        step: "lint",
        rounds: 3,
        autoFixes: 1,
        finalTrigger: "verify",
        finalFindings: 0,
        status: "clean",
      },
    ]);
    expect(renderPipelineSummaryForPr(rounds)).toContain("| lint | clean | 3 | 1 | verify | 0 |");
    expect(renderUnresolvedFindingsForPr(rounds)).toContain("Confirm contract");
    expect(renderUnresolvedFindingsForPr(rounds)).not.toContain("Lint failed");
  });
});
