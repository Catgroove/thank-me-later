import { describe, expect, test } from "bun:test";
import {
  architecturePrompt,
  architectureSchema,
  branchNamePrompt,
  branchNameSchema,
  checkFindingsSchema,
  checkFixPrompt,
  ciFixPrompt,
  checkPrompt,
  contextPrompt,
  correctnessPrompt,
  designPrompt,
  findingsSchema,
  fixPrompt,
  formatPrompt,
  lintPrompt,
  microPrompt,
  prDescriptionPrompt,
  prDescriptionSchema,
  testPrompt,
  typecheckPrompt,
} from "../src/prompts.ts";

const reviewPasses = [
  contextPrompt("a body"),
  architecturePrompt("intent"),
  correctnessPrompt("intent"),
  designPrompt("intent"),
  microPrompt("intent"),
];

describe("default pipeline prompts", () => {
  test("check + review prompts are non-empty and name no specific toolchain", () => {
    for (const prompt of [formatPrompt, lintPrompt, typecheckPrompt, testPrompt, ...reviewPasses]) {
      expect(prompt.length).toBeGreaterThan(0);
      // Agent-driven: the agent discovers the toolchain, so we never name one.
      expect(prompt.toLowerCase()).not.toContain("npm");
      expect(prompt.toLowerCase()).not.toContain("eslint");
    }
  });

  test("checkPrompt creates structured read-only check and verification prompts", () => {
    const initial = checkPrompt({
      name: "lint",
      goal: lintPrompt,
      trigger: "initial",
      historyText: "No prior rounds.",
    });
    const verify = checkPrompt({
      name: "lint",
      goal: lintPrompt,
      trigger: "verify",
      historyText: "Round 0: initial",
    });
    expect(initial).toContain("Check step: lint");
    expect(initial).toContain("structured findings");
    expect(initial.toLowerCase()).toContain("do not modify");
    expect(verify).toContain("Prior check round history");
    expect(verify).toContain("Round 0: initial");
  });

  test("checkFixPrompt lists selected findings and keeps command discovery agent-driven", () => {
    const prompt = checkFixPrompt({
      name: "typecheck",
      goal: typecheckPrompt,
      historyText: "Round 0: initial",
      findings: [
        {
          id: "typecheck:1",
          severity: "error",
          action: "auto-fix",
          title: "Bad type",
          detail: "number assigned to string",
          location: "src/a.ts:1",
        },
      ],
    });
    expect(prompt).toContain("Fix step: typecheck");
    expect(prompt).toContain("typecheck:1");
    expect(prompt).toContain("Bad type");
    expect(prompt.toLowerCase()).toContain("discover");
    expect(prompt.toLowerCase()).toContain("do not commit");
  });

  test("ciFixPrompt includes failed logs and leaves commit and push to tml", () => {
    const prompt = ciFixPrompt({
      historyText: "Round 0: initial",
      failedLogs: "stack trace",
      checks: [{ name: "build", status: "completed", conclusion: "failure" }],
      findings: [
        {
          id: "ci:1",
          severity: "error",
          action: "auto-fix",
          title: "build did not pass",
          detail: "CI reported failure.",
          location: "build",
        },
      ],
    });

    expect(prompt).toContain("ci:1");
    expect(prompt).toContain("stack trace");
    expect(prompt).toContain("Prior CI round history");
    expect(prompt.toLowerCase()).toContain("do not commit or push");
  });

  test("each review pass computes the diff itself and stays read-only", () => {
    for (const prompt of reviewPasses) {
      expect(prompt).toContain("diff");
      expect(prompt.toLowerCase()).toContain("do not modify");
      expect(prompt.toLowerCase()).toContain("do not run");
    }
  });

  test("the context pass embeds the description and asks for an understanding", () => {
    expect(contextPrompt("WHY THIS EXISTS")).toContain("WHY THIS EXISTS");
    expect(contextPrompt("x")).toContain("understanding");
    expect(contextPrompt("")).toContain("no description provided");
  });

  test("the architecture pass can block on scope or approach", () => {
    expect(architecturePrompt("")).toContain("block");
    expect(architecturePrompt("")).toContain("proceed");
  });

  test("later passes thread the context understanding when present", () => {
    expect(correctnessPrompt("MARKER-INTENT")).toContain("MARKER-INTENT");
    expect(correctnessPrompt("")).not.toContain("context pass");
  });

  test("the micro pass guards safety-critical code from the delete-list", () => {
    const p = microPrompt("").toLowerCase();
    expect(p).toContain("security");
    expect(p).toContain("validation");
    expect(p).toContain("yagni");
  });

  test("the fix prompt lists findings and forbids explanatory comments", () => {
    const p = fixPrompt([
      {
        severity: "warning",
        action: "auto-fix",
        title: "Off-by-one",
        detail: "loop overruns",
        location: "src/x.ts:10",
      },
    ]);
    expect(p).toContain("Off-by-one");
    expect(p).toContain("src/x.ts:10");
    expect(p.toLowerCase()).toContain("smallest");
    expect(p.toLowerCase()).toContain("do not add code comments");
  });

  test("findings schemas require findings and constrain severity + action", () => {
    for (const schema of [findingsSchema, checkFindingsSchema]) {
      expect(schema.required).toEqual(["findings"]);
      expect(schema.properties.findings.items.properties.severity.enum).toEqual([
        "error",
        "warning",
        "info",
      ]);
      expect(schema.properties.findings.items.properties.action.enum).toEqual([
        "auto-fix",
        "ask-user",
        "no-op",
      ]);
    }
  });

  test("architectureSchema requires a verdict so the block gate cannot silently downgrade", () => {
    expect(architectureSchema.required).toEqual(["findings", "verdict"]);
    expect(architectureSchema.properties.verdict.enum).toEqual(["proceed", "block"]);
  });

  test("prDescriptionPrompt embeds the reviewer notes; schema requires title and body", () => {
    expect(prDescriptionPrompt("FOUND A BUG")).toContain("FOUND A BUG");
    expect(prDescriptionPrompt("notes")).toContain("diff");
    expect(prDescriptionSchema.required).toEqual(["title", "body"]);
  });

  test("branchNamePrompt asks for a name from the whole diff; schema requires branch", () => {
    expect(branchNamePrompt).toContain("diff");
    expect(branchNamePrompt).toContain("untracked");
    expect(branchNamePrompt).toContain("kebab-case");
    expect(branchNameSchema.required).toEqual(["branch"]);
  });
});
