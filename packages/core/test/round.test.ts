import { describe, expect, test } from "bun:test";
import {
  currentFindings,
  findingId,
  findingLifecycle,
  makeFinding,
  renderFindingForPr,
  renderPipelineSummaryForPr,
  renderRoundForPr,
  renderRoundsForPr,
  renderUnresolvedFindingsForPr,
  summarizeStepRounds,
  type Finding,
  type FindingInput,
  type RoundRecord,
} from "../src/round.ts";

const input: FindingInput = {
  disposition: "should-fix",
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
    expect(renderFindingForPr(finding)).toContain("Should fix: `src/api.ts:12` Confirm contract");

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
      disposition: "blocker",
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

describe("finding lifecycle", () => {
  const autoFix = (title: string): Finding =>
    makeFinding("review", { disposition: "should-fix", action: "auto-fix", title, detail: "" });
  const askUser = (title: string): Finding =>
    makeFinding("review", { disposition: "blocker", action: "ask-user", title, detail: "" });
  const info = (title: string): Finding =>
    makeFinding("review", { disposition: "nit", action: "no-op", title, detail: "" });

  const round = (
    index: number,
    r: Partial<RoundRecord> & Pick<RoundRecord, "trigger">,
  ): RoundRecord => ({
    step: "review",
    index,
    findings: [],
    ...r,
  });

  const status = (lifecycle: ReturnType<typeof findingLifecycle>): Record<string, string> =>
    Object.fromEntries(lifecycle.map((l) => [l.finding.title, l.status]));

  const a = autoFix("a");
  const b = autoFix("b");
  const c = info("c");
  const d = askUser("d");

  test("auto-fix findings show pending the moment they are selected", () => {
    const rounds = [
      round(0, { trigger: "initial", findings: [a, b, c], selectedFindingIds: [a.id, b.id] }),
    ];
    expect(status(findingLifecycle(rounds))).toEqual({ a: "pending", b: "pending", c: "open" });
  });

  test("a verified-gone finding is fixed; one that came back is unresolved", () => {
    const rounds = [
      round(0, { trigger: "initial", findings: [a, b, c], selectedFindingIds: [a.id, b.id] }),
      round(1, { trigger: "auto_fix", findings: [a, b], selectedFindingIds: [a.id, b.id] }),
      // b survives the fix, c is still reported, a is gone.
      round(2, { trigger: "verify", findings: [b, c] }),
    ];
    expect(status(findingLifecycle(rounds, { settled: true }))).toEqual({
      a: "fixed",
      b: "unresolved",
      c: "open",
    });
  });

  test("operator approving leaves accepted; skipping leaves skipped", () => {
    const base = round(0, { trigger: "initial", findings: [d] });
    expect(
      status(
        findingLifecycle([
          base,
          round(1, { trigger: "user_fix", findings: [d], resolution: "approved" }),
        ]),
      ),
    ).toEqual({ d: "accepted" });
    expect(
      status(
        findingLifecycle([
          base,
          round(1, { trigger: "user_fix", findings: [d], resolution: "skipped" }),
        ]),
      ),
    ).toEqual({ d: "skipped" });
  });

  test("an operator fix that does not clear the finding is unresolved", () => {
    const rounds = [
      round(0, { trigger: "initial", findings: [d] }),
      round(1, { trigger: "user_fix", findings: [d], selectedFindingIds: [d.id] }),
      round(2, { trigger: "verify", findings: [d] }),
    ];
    expect(status(findingLifecycle(rounds, { settled: true }))).toEqual({ d: "unresolved" });
  });

  test("a finding that vanishes without being acted on is dropped from the list", () => {
    const rounds = [
      round(0, { trigger: "initial", findings: [c] }),
      round(1, { trigger: "verify", findings: [] }),
    ];
    expect(findingLifecycle(rounds)).toEqual([]);
  });

  test("a queued fix that will never run collapses to unresolved once settled", () => {
    const rounds = [round(0, { trigger: "initial", findings: [a], selectedFindingIds: [a.id] })];
    expect(status(findingLifecycle(rounds))).toEqual({ a: "pending" });
    expect(status(findingLifecycle(rounds, { settled: true }))).toEqual({ a: "unresolved" });
  });
});
