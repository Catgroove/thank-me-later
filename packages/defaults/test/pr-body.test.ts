import { describe, expect, test } from "bun:test";
import { makeFinding, type RoundRecord } from "@tml/core";
import { buildDefaultPrBody, updateDefaultPrBody } from "../src/pr-body.ts";

const finding = makeFinding("review", {
  disposition: "should-fix",
  action: "ask-user",
  title: "Confirm behavior",
  detail: "Public behavior changed.",
});

const rounds: RoundRecord[] = [
  { step: "quality", index: 0, trigger: "initial", findings: [finding] },
  { step: "quality", index: 1, trigger: "auto_fix", findings: [finding] },
  { step: "quality", index: 2, trigger: "verify", findings: [] },
  { step: "review", index: 0, trigger: "initial", findings: [finding] },
];

describe("default PR body", () => {
  test("builds deterministic generated sections from artifacts and rounds", () => {
    const body = buildDefaultPrBody({
      description: "Fixes the boundary case.",
      reviewSummary: "Review found one behavior question.",
      rounds,
    });

    expect(body).toContain("<!-- tml:summary:start -->");
    expect(body).toContain("## Intent\nFixes the boundary case.");
    expect(body).toContain("## Risk assessment");
    expect(body).toContain("Review found one behavior question.");
    expect(body).toContain("| quality | clean | 3 | 1 | verify | 0 |");
    expect(body).toContain("Confirm behavior");
    expect(body).toContain("<!-- tml:summary:end -->");
  });

  test("replaces only the generated block on rerun", () => {
    const original = [
      "Human intro.",
      "",
      buildDefaultPrBody({ description: "old", reviewSummary: "old risk", rounds: [] }),
      "",
      "Human footer.",
    ].join("\n");

    const updated = updateDefaultPrBody(original, {
      description: "new description",
      reviewSummary: "new risk",
      rounds,
    });

    expect(updated).toContain("Human intro.");
    expect(updated).toContain("Human footer.");
    expect(updated).toContain("new risk");
    expect(updated).not.toContain("old risk");
    expect(updated.match(/tml:summary:start/g)).toHaveLength(1);
  });

  test("appends a generated block when an existing body has no markers", () => {
    const updated = updateDefaultPrBody("Human prose.", {
      description: "Generated description.",
      reviewSummary: "",
      rounds: [],
    });

    expect(updated).toStartWith("Human prose.");
    expect(updated).toContain("No unresolved findings.");
  });
});
