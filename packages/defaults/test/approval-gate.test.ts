import { describe, expect, test } from "bun:test";
import { makeFinding, type ApprovalDecision, type Finding } from "@tml/core";
import { executeRoundLoopWithApproval } from "../src/approval-gate.ts";
import { fakeCtx } from "./fake-ctx.ts";

function finding(title: string): Finding {
  return makeFinding("approval", {
    severity: "error",
    action: "ask-user",
    title,
    detail: `${title} detail`,
  });
}

describe("executeRoundLoopWithApproval", () => {
  test("records user-authored fix findings once", async () => {
    const selected = finding("selected");
    const userFinding = finding("user supplied");
    const decision: ApprovalDecision = {
      action: "fix",
      selectedFindingIds: [selected.id],
      userFindings: [userFinding],
      notes: { [selected.id]: "focus here" },
    };
    const fixInputs: Finding[][] = [];
    let checks = 0;
    const { ctx } = fakeCtx({ approveFindings: () => Promise.resolve(decision) });

    const result = await executeRoundLoopWithApproval(ctx, {
      stepName: "approval-test",
      commit: false,
      async check() {
        checks += 1;
        return { findings: checks === 1 ? [selected] : [] };
      },
      async fix(input) {
        fixInputs.push([...input.findings]);
        return { summary: "fixed" };
      },
    });

    expect(fixInputs[0]?.map((f) => f.id)).toEqual([selected.id, userFinding.id]);
    expect(fixInputs[0]?.[0]?.detail).toContain("Operator note: focus here");
    const userFixRound = result.rounds.find((round) => round.trigger === "user_fix");
    expect(userFixRound?.findings.filter((f) => f.id === userFinding.id)).toHaveLength(1);
    expect(userFixRound?.findings.find((f) => f.id === selected.id)?.detail).not.toContain(
      "Operator note",
    );
    expect(userFixRound?.userNotes).toEqual({ [selected.id]: "focus here" });
  });
});
