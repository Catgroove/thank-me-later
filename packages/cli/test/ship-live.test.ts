import { describe, expect, test } from "bun:test";

// Opt-in end-to-end smoke for the real `tml ship`. Skipped by default so the suite stays
// hermetic (no git mutations, no `gh`, no `pi`, no network). Set TML_SHIP_LIVE=1 AND point
// TML_SHIP_LIVE_REPO at a *disposable* repo that has an authenticated `gh` remote and `pi`
// available — this actually creates a branch, commits, pushes, and opens a PR there. It
// catches drift the hermetic fakes can't (in-place git plumbing, provider argv/JSONL, gh wiring).
const LIVE = process.env.TML_SHIP_LIVE === "1";
const REPO = process.env.TML_SHIP_LIVE_REPO;

const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

describe("tml ship — live smoke (opt-in)", () => {
  if (!LIVE || !REPO) {
    console.log(
      "[ship live.test] skipped — set TML_SHIP_LIVE=1 and TML_SHIP_LIVE_REPO=<disposable repo " +
        "with an authenticated gh remote + pi> to run a real `tml ship` end-to-end (branch → " +
        "describe → commits/checks/review → push → open PR → ci-wait). It mutates that repo " +
        "and opens a PR.",
    );
    test.skip("set TML_SHIP_LIVE=1 + TML_SHIP_LIVE_REPO to run a real ship", () => {});
    return;
  }

  test("runs the full pipeline in the checkout and finishes", async () => {
    const proc = Bun.spawn(["bun", "run", ENTRY, "ship"], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(stdout).toContain("run started");
    expect(stdout).toContain("run finished");
    expect(exitCode).toBe(0);
  }, 600_000);
});
