import { describe, expect, test } from "bun:test";
import {
  branchNamePrompt,
  branchNameSchema,
  formatPrompt,
  lintPrompt,
  prDescriptionPrompt,
  prDescriptionSchema,
  reviewPrompt,
  testPrompt,
  typecheckPrompt,
} from "../src/prompts.ts";

describe("default pipeline prompts", () => {
  test("check prompts are non-empty and toolchain-agnostic (no hard-coded tools)", () => {
    for (const prompt of [formatPrompt, lintPrompt, typecheckPrompt, testPrompt, reviewPrompt]) {
      expect(prompt.length).toBeGreaterThan(0);
      // Agent-driven: the agent discovers the toolchain, so we never name one.
      expect(prompt.toLowerCase()).not.toContain("npm");
      expect(prompt.toLowerCase()).not.toContain("eslint");
    }
  });

  test("review + PR-description prompts tell the agent to compute the diff itself", () => {
    expect(reviewPrompt).toContain("default branch");
    expect(prDescriptionPrompt("notes")).toContain("diff");
  });

  test("prDescriptionPrompt embeds the reviewer notes", () => {
    expect(prDescriptionPrompt("FOUND A BUG")).toContain("FOUND A BUG");
  });

  test("prDescriptionSchema requires title and body", () => {
    expect(prDescriptionSchema.required).toEqual(["title", "body"]);
  });

  test("branchNamePrompt asks for a name from the whole diff; schema requires branch", () => {
    expect(branchNamePrompt).toContain("diff");
    expect(branchNamePrompt).toContain("untracked");
    expect(branchNamePrompt).toContain("kebab-case");
    expect(branchNameSchema.required).toEqual(["branch"]);
  });
});
