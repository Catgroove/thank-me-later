import { describe, expect, test } from "bun:test";
import { listModelsArgs, runArgs } from "../src/args.ts";

describe("runArgs", () => {
  test("builds the non-interactive JSONL run argv with the prompt last", () => {
    expect(runArgs("format the repo")).toEqual([
      "-p",
      "--mode",
      "json",
      "--no-session",
      "format the repo",
    ]);
  });

  test("requests an isolated task instead of continuing a pi session", () => {
    expect(runArgs("format the repo")).toContain("--no-session");
  });

  test("inserts --model before the prompt when a model is pinned", () => {
    expect(runArgs("review", "anthropic/sonnet:high")).toEqual([
      "-p",
      "--mode",
      "json",
      "--no-session",
      "--model",
      "anthropic/sonnet:high",
      "review",
    ]);
  });

  test("omits --model for an empty model id", () => {
    expect(runArgs("x", "")).not.toContain("--model");
  });
});

describe("listModelsArgs", () => {
  test("is --list-models", () => {
    expect(listModelsArgs()).toEqual(["--list-models"]);
  });
});
