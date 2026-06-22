import { describe, expect, test } from "bun:test";
import {
  findingId,
  makeFinding,
  renderFindingForPr,
  renderRoundForPr,
  renderRoundsForPr,
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
});
