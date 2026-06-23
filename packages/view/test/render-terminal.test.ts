import { describe, expect, test } from "bun:test";
import type { RunEvent, RunEventInput } from "@tml/core";
import { initialView, present } from "../src/present.ts";
import { createTerminalRenderer, type TerminalRendererOptions } from "../src/render-terminal.ts";

/** Stamp a deterministic `at` so fixtures can be written without one. */
const stamp = (event: RunEventInput, i: number): RunEvent => ({ ...event, at: i }) as RunEvent;

/** Drive a sequence through the fold + TTY renderer, capturing the raw chunks written. */
function renderRaw(
  events: RunEventInput[],
  options: Partial<TerminalRendererOptions> = {},
): string {
  let out = "";
  const renderer = createTerminalRenderer({
    write: (chunk) => {
      out += chunk;
    },
    columns: 80,
    term: "xterm",
    intervalMs: 0, // no animation timer in tests
    now: () => 0,
    color: false, // keep assertions ANSI-color-free unless a test opts in
    ...options,
  });
  let view = initialView;
  events.forEach((raw, i) => {
    const event = stamp(raw, i);
    view = present(view, event);
    renderer.render(view, event);
  });
  renderer.close();
  return out;
}

/** Drive a sequence through the fold + plain (append-only) renderer, collecting the lines. */
function renderLines(events: RunEventInput[], options: { verbose?: boolean } = {}): string[] {
  let out = "";
  const renderer = createTerminalRenderer({
    plain: true,
    write: (chunk) => {
      out += chunk;
    },
    ...options,
  });
  let view = initialView;
  events.forEach((raw, i) => {
    const event = stamp(raw, i);
    view = present(view, event);
    renderer.render(view, event);
  });
  renderer.close();
  // The plain path writes each line as `<line>\n`; split back into lines, dropping the trailing "".
  return out.split("\n").slice(0, -1);
}

const HAPPY: RunEventInput[] = [
  { type: "run:started", pipeline: ["format", "lint"] },
  { type: "step:started", step: "format" },
  {
    type: "agent:progress",
    step: "format",
    progress: { kind: "text", text: "Running the formatter now." },
  },
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

describe("createTerminalRenderer (TTY)", () => {
  test("quiet (default): seals step results and the run end, keeps chatter transient", () => {
    const out = renderRaw(HAPPY);
    expect(out).toContain("✓ format");
    expect(out).toContain("⤼ lint (skipped)");
    expect(out).toContain("■ run finished");
    // Chatter and tool calls ride the transient live line — they never seal into scrollback
    // (a sealed line is followed by `\n`; a live line is not).
    expect(out).not.toContain("⚙ bash · bun run fmt\n");
    // A Braille spinner frame is used in a normal terminal.
    expect(out).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  test("verbose heads the step, commits each command, and keeps the spinner bare", () => {
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["lint"] },
        { type: "step:started", step: "lint" },
        {
          type: "agent:progress",
          step: "lint",
          progress: { kind: "tool", name: "bash", phase: "start", detail: "bun run lint" },
        },
        {
          type: "agent:progress",
          step: "lint",
          progress: { kind: "tool", name: "bash", phase: "end" },
        },
        {
          type: "agent:progress",
          step: "lint",
          progress: { kind: "tool", name: "read", phase: "start", detail: "src/index.ts" },
        },
      ],
      { verbose: true },
    );
    // The step name heads its block; the commands commit beneath it as permanent ⚙ lines.
    expect(out).toContain("▸ lint");
    expect(out).toContain("⚙ bash · bun run lint");
    expect(out).toContain("⚙ read · src/index.ts");
    // The spinner is a bare liveness indicator — the step name lives on the header, not here.
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] lint/);
  });

  test("verbose separates steps with a blank line, but not before the first", () => {
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["branch", "lint"] },
        { type: "step:started", step: "branch" },
        { type: "step:finished", step: "branch" },
        { type: "step:started", step: "lint" },
        { type: "step:finished", step: "lint" },
        { type: "run:finished" },
      ],
      { verbose: true },
    );
    // The second header is preceded by a committed blank line (a bare `\n` after the
    // cleared live line); the first follows its cleared line immediately, with no blank.
    const blankBefore = (name: string) => `\x1b[2K\n  ▸ ${name}`;
    expect(out).toContain(blankBefore("lint"));
    expect(out).not.toContain(blankBefore("branch"));
  });

  test("verbose streams prose on a single live line, sealing filled lines into scrollback", () => {
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["describe"] },
        { type: "step:started", step: "describe" },
        {
          type: "agent:progress",
          step: "describe",
          progress: { kind: "text", text: "alpha bravo charlie delta echo" },
        },
      ],
      { columns: 20, verbose: true },
    );
    // Filled lines seal into scrollback (committed above)...
    expect(out).toContain("alpha bravo");
    expect(out).toContain("charlie delta");
    // ...and only the volatile last line stays live, with the spinner trailing it inline.
    expect(out).toMatch(/echo [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  test("verbose seals pending prose before a log line", () => {
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["check"] },
        { type: "step:started", step: "check" },
        {
          type: "agent:progress",
          step: "check",
          progress: { kind: "text", text: "about to poll" },
        },
        { type: "step:log", step: "check", message: "ci: pending" },
        { type: "step:finished", step: "check" },
      ],
      { verbose: true },
    );
    const prose = out.indexOf("about to poll\n");
    const log = out.indexOf("· ci: pending\n");
    expect(prose).toBeGreaterThanOrEqual(0);
    expect(log).toBeGreaterThan(prose);
  });

  test("verbose does not drop pending prose when the terminal is resized mid-stream", () => {
    let out = "";
    let columns = 20;
    const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => columns });
    try {
      const renderer = createTerminalRenderer({
        write: (chunk) => {
          out += chunk;
        },
        term: "xterm",
        intervalMs: 0,
        now: () => 0,
        color: false,
        verbose: true,
      });
      let view = initialView;
      let tick = 0;
      const send = (raw: RunEventInput): void => {
        const event = stamp(raw, (tick += 1));
        view = present(view, event);
        renderer.render(view, event);
      };

      send({ type: "run:started", pipeline: ["describe"] });
      send({ type: "step:started", step: "describe" });
      send({
        type: "agent:progress",
        step: "describe",
        progress: { kind: "text", text: "alpha bravo charlie delta echo" },
      });
      columns = 80;
      send({
        type: "agent:progress",
        step: "describe",
        progress: { kind: "text", text: " foxtrot golf" },
      });
      send({ type: "step:finished", step: "describe" });
      send({ type: "run:finished" });
      renderer.close();
    } finally {
      if (originalColumns === undefined) {
        Reflect.deleteProperty(process.stdout, "columns");
      } else {
        Object.defineProperty(process.stdout, "columns", originalColumns);
      }
    }

    expect(out).toContain("alpha bravo\n");
    expect(out).toContain("charlie delta\n");
    expect(out).toContain("echo foxtrot golf\n");
  });

  test("never moves the cursor up — the live region is one line (tmux-/resize-safe)", () => {
    // The whole point of the rewrite: zero `\x1b[<n>A`, so a viewport scrolled under us
    // (tmux copy mode) or a resize can't desync the cursor and smear the live region.
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["describe", "lint"] },
        { type: "step:started", step: "describe" },
        {
          type: "agent:progress",
          step: "describe",
          progress: { kind: "text", text: "alpha bravo charlie delta echo foxtrot golf hotel" },
        },
        {
          type: "agent:progress",
          step: "describe",
          progress: { kind: "tool", name: "bash", phase: "start", detail: "git diff" },
        },
        {
          type: "agent:progress",
          step: "describe",
          progress: { kind: "text", text: "more words streamed after the tool call as well" },
        },
        { type: "step:finished", step: "describe" },
        { type: "step:started", step: "lint" },
        { type: "step:skipped", step: "lint" },
        { type: "run:finished" },
      ],
      { columns: 24, verbose: true },
    );
    // Cursor-up is ESC `[` <optional digits> `A`; scan for it without a control char in a regex.
    const movesCursorUp = out.split("\x1b[").some((part) => /^[0-9]*A/.test(part));
    expect(movesCursorUp).toBe(false);
  });

  test("emits ANSI cursor control for the live region", () => {
    const out = renderRaw(HAPPY);
    // biome-ignore lint: explicit ESC for the clear-region sequence.
    expect(out).toContain("\x1b[");
  });

  test("shows elapsed time on a committed step", () => {
    // step:started reads the clock (0); the commit on step:finished reads it again (3000).
    const stamps = [0, 3000];
    let i = 0;
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["test"] },
        { type: "step:started", step: "test" },
        { type: "step:finished", step: "test" },
        { type: "run:finished" },
      ],
      { now: () => stamps[Math.min(i++, stamps.length - 1)] ?? 0 },
    );
    expect(out).toContain("✓ test  (3s)");
  });

  test("falls back to an ASCII glyph set on a dumb terminal", () => {
    const out = renderRaw(HAPPY, { term: "dumb" });
    expect(out).toContain("[ok] format");
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  test("quiet: short artifact inline, narrative artifact + PR sealed in the results block", () => {
    const out = renderRaw([
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
    expect(out).toContain("✓ branch  feat/x"); // short artifact reads inline
    expect(out).not.toContain("✓ review  handles"); // narrative one is not crammed inline
    expect(out).toContain("── results");
    expect(out).toContain("review  handles empty argv"); // results block, labeled by step
    expect(out).toContain("pr      https://git-provider.test/pr/7");
    expect(out).toContain("■ run finished");
  });

  test("quiet: dumps the failing step's retained trail, then the failure line", () => {
    const out = renderRaw([
      { type: "run:started", pipeline: ["test"] },
      { type: "step:started", step: "test" },
      { type: "agent:progress", step: "test", progress: { kind: "text", text: "running tests" } },
      { type: "step:log", step: "test", message: "3 failures" },
      { type: "run:failed", step: "test", error: "tests failed" },
    ]);
    expect(out).toContain("running tests"); // dumped prose
    expect(out).toContain("· 3 failures"); // dumped log
    expect(out).toMatch(/run failed at test: tests failed/);
  });

  test("seals an escalation prompt — it blocks the run, so it can't be transient", () => {
    const out = renderRaw([
      { type: "run:started", pipeline: ["lint"] },
      { type: "step:started", step: "lint" },
      { type: "ask:pending", step: "lint", prompt: "Fix lint errors?" },
    ]);
    expect(out).toContain("? lint: Fix lint errors?\n"); // sealed (a permanent line ends with \n)
    expect(out.slice(out.lastIndexOf("? lint"))).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  test("seals a structured approval prompt with the finding count", () => {
    const out = renderRaw([
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
              disposition: "should-fix",
              action: "auto-fix",
              title: "Fix me",
              detail: "Needs a fix.",
            },
            {
              id: "review:2",
              disposition: "blocker",
              action: "ask-user",
              title: "Confirm",
              detail: "Needs a decision.",
            },
          ],
        },
      },
    ]);
    expect(out).toContain("? review: Review findings (2 findings)\n");
    expect(out.slice(out.lastIndexOf("? review"))).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  test("color: wraps results and outcomes in SGR codes when enabled", () => {
    const out = renderRaw(
      [
        { type: "run:started", pipeline: ["review"] },
        { type: "step:started", step: "review" },
        { type: "artifact:written", step: "review", artifact: "reviewSummary", rendered: "ok" },
        { type: "step:finished", step: "review" },
        { type: "run:finished" },
      ],
      { color: true },
    );
    expect(out).toContain("\x1b[32m"); // green ✓ on a step that produced an artifact
    expect(out).toContain("\x1b[2m"); // dim elapsed
    expect(out).toContain("\x1b[1m"); // bold run header
  });
});

const TRAIL: RunEventInput[] = [
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

describe("createTerminalRenderer (plain)", () => {
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

  test("verbose splits multiline prose into one sink line per output line", () => {
    const lines = renderLines(
      [
        { type: "run:started", pipeline: ["x"] },
        { type: "step:started", step: "x" },
        { type: "agent:progress", step: "x", progress: { kind: "text", text: "a\nb" } },
        { type: "step:finished", step: "x" },
      ],
      { verbose: true },
    );
    expect(lines).toEqual(["▶ ship", "  x", "  ▸ x", "    a", "    b", "  ✓ x"]);
  });

  test("step:log lines show in both modes (CI progress)", () => {
    const events: RunEventInput[] = [
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
              disposition: "should-fix",
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
