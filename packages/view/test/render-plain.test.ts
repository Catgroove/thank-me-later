import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@tml/core";
import { initialView, present } from "../src/present.ts";
import { createPlainRenderer } from "../src/render-plain.ts";

/** Drive a sequence through the fold + plain renderer, collecting the emitted lines. */
function renderLines(events: RunEvent[], options: { verbose?: boolean } = {}): string[] {
  const lines: string[] = [];
  const renderer = createPlainRenderer((line) => lines.push(line), options);
  let view = initialView;
  for (const event of events) {
    view = present(view, event);
    renderer.render(view, event);
  }
  renderer.close();
  return lines;
}

const TRAIL: RunEvent[] = [
  { type: "run:started", pipeline: ["format", "lint"] },
  { type: "step:started", step: "format" },
  { type: "agent:progress", step: "format", progress: { kind: "text", text: "Running " } },
  { type: "agent:progress", step: "format", progress: { kind: "text", text: "the formatter." } },
  {
    type: "agent:progress",
    step: "format",
    progress: { kind: "tool", name: "bash", phase: "start", detail: "bun run fmt" },
  },
  {
    type: "agent:progress",
    step: "format",
    progress: { kind: "tool", name: "bash", phase: "end" },
  },
  { type: "step:finished", step: "format" },
  { type: "step:started", step: "lint" },
  { type: "step:skipped", step: "lint" },
  { type: "run:finished" },
];

describe("createPlainRenderer", () => {
  test("quiet (default): drops agent prose and tool lines, keeps step structure", () => {
    expect(renderLines(TRAIL)).toEqual([
      "▶ ship",
      "  format",
      "  lint",
      "  ▸ format",
      "  ✓ format",
      "  ▸ lint",
      "  ⤼ lint (skipped)",
      "■ run finished",
    ]);
  });

  test("verbose: seals the full trail — coalesced prose + one line per tool", () => {
    expect(renderLines(TRAIL, { verbose: true })).toEqual([
      "▶ ship",
      "  format",
      "  lint",
      "  ▸ format",
      "    Running the formatter.", // coalesced, flushed at the tool boundary
      "    ⚙ bash · bun run fmt",
      "  ✓ format",
      "  ▸ lint",
      "  ⤼ lint (skipped)",
      "■ run finished",
    ]);
  });

  test("verbose never emits a line per text delta (no token spam)", () => {
    const lines = renderLines(
      [
        { type: "run:started", pipeline: ["x"] },
        { type: "step:started", step: "x" },
        { type: "agent:progress", step: "x", progress: { kind: "text", text: "a" } },
        { type: "agent:progress", step: "x", progress: { kind: "text", text: "b" } },
        { type: "agent:progress", step: "x", progress: { kind: "text", text: "c" } },
        { type: "step:finished", step: "x" },
      ],
      { verbose: true },
    );
    expect(lines).toEqual(["▶ ship", "  x", "  ▸ x", "    abc", "  ✓ x"]);
  });

  test("step:log lines show in both modes (CI progress)", () => {
    const events: RunEvent[] = [
      { type: "run:started", pipeline: ["ci-wait"] },
      { type: "step:started", step: "ci-wait" },
      { type: "step:log", step: "ci-wait", message: "ci: build → success" },
      { type: "step:finished", step: "ci-wait" },
    ];
    expect(renderLines(events)).toContain("    · ci: build → success");
    expect(renderLines(events, { verbose: true })).toContain("    · ci: build → success");
  });

  test("approval prompts show the structured finding count", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      {
        type: "approval:pending",
        step: "review",
        input: {
          prompt: "Review findings",
          findings: [
            {
              id: "review:1",
              severity: "warning",
              action: "auto-fix",
              title: "Fix me",
              detail: "Needs a fix.",
            },
          ],
        },
      },
    ]);
    expect(lines).toContain("  ? review: Review findings (1 finding)");
  });

  test("shows a short artifact inline, routes a narrative one to the results block", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["branch", "review", "open-pr"] },
      { type: "step:started", step: "branch" },
      { type: "artifact:written", step: "branch", artifact: "branchName", rendered: "feat/x" },
      { type: "step:finished", step: "branch" },
      { type: "step:started", step: "review" },
      {
        type: "artifact:written",
        step: "review",
        artifact: "reviewSummary",
        rendered: "handles empty argv\ntests cover both",
      },
      { type: "step:finished", step: "review" },
      { type: "step:started", step: "open-pr" },
      { type: "pr:opened", url: "https://git-provider.test/pr/7" },
      { type: "artifact:written", step: "open-pr", artifact: "pullRequest" }, // object, no rendered
      { type: "step:finished", step: "open-pr" },
      { type: "run:finished" },
    ]);
    expect(lines).toEqual([
      "▶ ship",
      "  branch",
      "  review",
      "  open-pr",
      "  ▸ branch",
      "  ✓ branch  feat/x", // short → inline
      "  ▸ review",
      "  ✓ review", // narrative → no inline; full text in the block
      "  ▸ open-pr",
      "  ✓ open-pr",
      `  ── results ${"─".repeat(20)}`,
      "  review  handles empty argv",
      "          tests cover both",
      "  pr      https://git-provider.test/pr/7",
      "■ run finished",
    ]);
  });

  test("keeps a readable gap after long results-block labels", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["security-review"] },
      { type: "step:started", step: "security-review" },
      {
        type: "artifact:written",
        step: "security-review",
        artifact: "reviewSummary",
        rendered: "line one\nline two",
      },
      { type: "step:finished", step: "security-review" },
      { type: "run:finished" },
    ]);
    expect(lines).toContain("  security-review  line one");
    expect(lines).toContain("                   line two");
  });

  test("reports a failure with its step and error", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["test"] },
      { type: "step:started", step: "test" },
      { type: "run:failed", step: "test", error: "boom" },
    ]);
    expect(lines.at(-1)).toBe("✗ run failed at test: boom");
  });

  test("the PR URL lands in the results block, not on the run-finished line", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["open-pr", "ci-wait"] },
      { type: "step:started", step: "open-pr" },
      { type: "pr:opened", url: "https://git-provider.test/pr/7" },
      { type: "step:finished", step: "open-pr" },
      { type: "step:started", step: "ci-wait" },
      { type: "step:finished", step: "ci-wait" },
      { type: "run:finished" },
    ]);
    expect(lines).toContain("  pr      https://git-provider.test/pr/7");
    expect(lines.at(-1)).toBe("■ run finished");
  });

  test("appends the PR link to a failure line (no results block on failure)", () => {
    const lines = renderLines([
      { type: "run:started", pipeline: ["open-pr", "ci-wait"] },
      { type: "step:started", step: "open-pr" },
      { type: "pr:opened", url: "https://git-provider.test/pr/7" },
      { type: "step:finished", step: "open-pr" },
      { type: "step:started", step: "ci-wait" },
      { type: "run:failed", step: "ci-wait", error: "checks red" },
    ]);
    expect(lines.at(-1)).toBe(
      "✗ run failed at ci-wait: checks red · https://git-provider.test/pr/7",
    );
  });
});
