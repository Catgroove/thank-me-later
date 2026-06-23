import { describe, expect, test } from "bun:test";
import { makeFinding, type ApprovalDecision } from "@tml/core";
import { initialView, present, type ViewState } from "../src/present.ts";
import type { RunEvent, RunEventInput } from "@tml/core";
import { effectiveIndex, initialNav, navOnKey, TABS } from "../src/tui/navigation.ts";
import {
  actionOptions,
  buildDecision,
  findingSections,
  orderedFindings,
  suggestedSelection,
  summaryLine,
  toggleSelection,
} from "../src/tui/approval.ts";
import { createInteractions, type ActivePrompt } from "../src/tui/interaction.ts";
import { epilogueLines } from "../src/tui/epilogue.ts";
import { sanitize } from "../src/tui/sanitize.ts";
import { formatDuration, stepElapsed, statusGlyph } from "../src/tui/format.ts";

const stamp = (event: RunEventInput, i: number): RunEvent => ({ ...event, at: i }) as RunEvent;
const fold = (events: RunEventInput[]): ViewState =>
  events.reduce<ViewState>((v, e, i) => present(v, stamp(e, i)), initialView);

// A deliberately non-default Pipeline: proves nothing branches on bundled Step names.
const PLUGIN_PIPELINE = ["alpha-plugin", "custom-thing", "ze-last-step"];
const baseView = fold([{ type: "run:started", pipeline: PLUGIN_PIPELINE }]);

describe("tui navigation", () => {
  test("j/k move selection and break follow-active; . restores it", () => {
    let nav = initialNav;
    expect(nav.followActive).toBe(true);
    nav = navOnKey(nav, { name: "j" }, baseView);
    expect(nav.followActive).toBe(false);
    expect(effectiveIndex(nav, baseView)).toBe(1);
    nav = navOnKey(nav, { name: "j" }, baseView);
    expect(effectiveIndex(nav, baseView)).toBe(2);
    nav = navOnKey(nav, { name: "j" }, baseView); // clamps at the last Step
    expect(effectiveIndex(nav, baseView)).toBe(2);
    nav = navOnKey(nav, { name: "k" }, baseView);
    expect(effectiveIndex(nav, baseView)).toBe(1);
    nav = navOnKey(nav, { name: "." }, baseView);
    expect(nav.followActive).toBe(true);
  });

  test("follow-active tracks the active Step regardless of plugin Step names", () => {
    const view = fold([
      { type: "run:started", pipeline: PLUGIN_PIPELINE },
      { type: "step:started", step: "custom-thing" },
    ]);
    expect(view.steps[effectiveIndex(initialNav, view)]?.name).toBe("custom-thing");
  });

  test("tab / shift-tab cycle the inspector tabs", () => {
    let nav = initialNav;
    expect(nav.tab).toBe("summary");
    nav = navOnKey(nav, { name: "tab" }, baseView);
    expect(nav.tab).toBe(TABS[1]);
    nav = navOnKey(nav, { name: "tab", shift: true }, baseView);
    expect(nav.tab).toBe("summary");
    nav = navOnKey(nav, { name: "tab", shift: true }, baseView); // wraps backwards
    expect(nav.tab).toBe(TABS[TABS.length - 1]);
  });

  test("? toggles help and enter toggles expansion; g is no longer bound", () => {
    let nav = initialNav;
    expect(navOnKey(nav, { name: "g" }, baseView)).toBe(nav); // activity is always-on now, no toggle
    nav = navOnKey(nav, { name: "?" }, baseView);
    expect(nav.showHelp).toBe(true);
    nav = navOnKey(nav, { name: "return" }, baseView);
    expect(nav.expanded).toBe(true);
  });

  test("an unhandled key returns the same nav object (no-op)", () => {
    const nav = initialNav;
    expect(navOnKey(nav, { name: "z" }, baseView)).toBe(nav);
  });
});

describe("tui approval helpers", () => {
  const f1 = makeFinding("x", {
    disposition: "blocker",
    action: "auto-fix",
    title: "a",
    detail: "d",
  });
  const f2 = makeFinding("x", {
    disposition: "should-fix",
    action: "ask-user",
    title: "b",
    detail: "e",
  });

  test("actionOptions offers fix only when the operator selected findings", () => {
    expect(actionOptions([f1.id]).map((o) => o.action)).toEqual([
      "fix",
      "approve",
      "skip",
      "abort",
    ]);
    expect(actionOptions([]).map((o) => o.action)).toEqual(["approve", "skip", "abort"]);
  });

  test("suggestedSelection filters suggested ids to known findings", () => {
    expect(
      suggestedSelection({
        prompt: "p",
        findings: [f1, f2],
        suggestedFindingIds: [f1.id, "stale"],
      }),
    ).toEqual([f1.id]);
    expect(suggestedSelection({ prompt: "p", findings: [f1, f2] })).toEqual([]);
  });

  test("toggleSelection toggles one visible finding id", () => {
    expect(toggleSelection([], f1.id)).toEqual([f1.id]);
    expect(toggleSelection([f1.id, f2.id], f1.id)).toEqual([f2.id]);
  });

  test("buildDecision maps actions; fix sends only the visible selection", () => {
    expect(buildDecision("approve", [])).toEqual({ action: "approve" });
    expect(buildDecision("skip", [])).toEqual({ action: "skip" });
    expect(buildDecision("abort", [])).toEqual({ action: "abort" });
    expect(buildDecision("fix", [f1.id])).toEqual({ action: "fix", selectedFindingIds: [f1.id] });
    expect(buildDecision("fix", [])).toBeUndefined();
  });

  test("summaryLine tallies dispositions, dropping the redundant total for one bucket", () => {
    expect(summaryLine([f1, f2])).toBe("1 blocker · 1 should-fix · 2 findings");
    expect(summaryLine([f1])).toBe("1 blocker");
    expect(summaryLine([])).toBe("No findings.");
  });

  test("findingSections groups by action, most-actionable first, dropping empty sections", () => {
    const noop = makeFinding("x", { disposition: "nit", action: "no-op", title: "c", detail: "f" });
    // Input arrives auto-fix, ask-user, no-op; sections come back ask-user, auto-fix, no-op.
    const sections = findingSections([f1, f2, noop]);
    expect(sections.map((s) => s.action)).toEqual(["ask-user", "auto-fix", "no-op"]);
    expect(sections.map((s) => s.findings)).toEqual([[f2], [f1], [noop]]);
    // Sections with no findings are omitted entirely.
    expect(findingSections([f1]).map((s) => s.action)).toEqual(["auto-fix"]);
    expect(findingSections([])).toEqual([]);
  });

  test("orderedFindings flattens sections into the navigation order the drawer renders", () => {
    const noop = makeFinding("x", { disposition: "nit", action: "no-op", title: "c", detail: "f" });
    expect(orderedFindings([f1, noop, f2])).toEqual([f2, f1, noop]);
  });
});

describe("tui interaction controller", () => {
  test("ask publishes a prompt and resolves when submit is called; then clears", async () => {
    let active: ActivePrompt | undefined;
    const interactions = createInteractions((p) => {
      active = p;
    });
    const answer = interactions.ask("ship it?");
    expect(active?.kind).toBe("ask");
    if (active?.kind !== "ask") throw new Error("expected ask prompt");
    expect(active.prompt).toBe("ship it?");
    active.submit("yes");
    expect(active).toBeUndefined(); // cleared on submit
    expect(await answer).toBe("yes");
  });

  test("approveFindings resolves with the decision the drawer submits", async () => {
    let active: ActivePrompt | undefined;
    const interactions = createInteractions((p) => {
      active = p;
    });
    const decision = interactions.approveFindings({ prompt: "review", findings: [] });
    if (active?.kind !== "approval") throw new Error("expected approval prompt");
    const fix: ApprovalDecision = { action: "fix", selectedFindingIds: ["id-1"] };
    active.submit(fix);
    expect(await decision).toEqual(fix);
  });
});

describe("tui epilogue (generic over the Pipeline)", () => {
  test("a finished Run summarizes status, tally, and PR url without naming bundled Steps", () => {
    const view = fold([
      { type: "run:started", pipeline: PLUGIN_PIPELINE },
      { type: "step:started", step: "alpha-plugin" },
      { type: "step:finished", step: "alpha-plugin" },
      { type: "step:skipped", step: "custom-thing" },
      { type: "pr:opened", url: "https://git.test/pr/3" },
      { type: "step:started", step: "ze-last-step" },
      { type: "step:finished", step: "ze-last-step" },
      { type: "run:finished" },
    ]);
    const lines = epilogueLines(view, 100);
    expect(lines[0]).toContain("ship finished");
    expect(lines.join("\n")).toContain("2 done");
    expect(lines.join("\n")).toContain("1 skipped");
    expect(lines.join("\n")).toContain("https://git.test/pr/3");
  });

  test("a failed Run names the failing Step and error", () => {
    const view = fold([
      { type: "run:started", pipeline: PLUGIN_PIPELINE },
      { type: "step:started", step: "custom-thing" },
      { type: "run:failed", step: "custom-thing", error: "boom" },
    ]);
    const lines = epilogueLines(view, 100);
    expect(lines[0]).toContain("failed at custom-thing");
    expect(lines.join("\n")).toContain("boom");
  });

  test("a cancelled Run reports cancellation at the active Step", () => {
    const view = fold([
      { type: "run:started", pipeline: PLUGIN_PIPELINE },
      { type: "step:started", step: "ze-last-step" },
      { type: "run:cancelled", step: "ze-last-step" },
    ]);
    expect(epilogueLines(view, 100)[0]).toContain("cancelled");
  });
});

describe("tui formatting", () => {
  test("formatDuration is compact and human", () => {
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(12_000)).toBe("12s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });

  test("stepElapsed prefers a recorded duration, else lives off `now`", () => {
    expect(
      stepElapsed(
        {
          name: "x",
          status: "done",
          artifacts: [],
          rounds: [],
          findings: [],
          activity: [],
          phases: [],
          durationMs: 1500,
        },
        0,
      ),
    ).toBe("1.5s");
    expect(
      stepElapsed(
        {
          name: "x",
          status: "active",
          startedAt: 1000,
          artifacts: [],
          rounds: [],
          findings: [],
          activity: [],
          phases: [],
        },
        3000,
      ),
    ).toBe("2.0s");
  });

  test("statusGlyph covers every status", () => {
    expect(statusGlyph("pending")).toBeTruthy();
    expect(statusGlyph("active")).toBeTruthy();
    expect(statusGlyph("done")).toBeTruthy();
    expect(statusGlyph("skipped")).toBeTruthy();
    expect(statusGlyph("failed")).toBeTruthy();
  });
});

describe("tui sanitize", () => {
  test("escapes terminal control sequences but can preserve newlines", () => {
    expect(sanitize("bad[2Jtitle")).toBe("bad\\u001b[2Jtitle");
    expect(sanitize("a\nb")).toBe("a\\u000ab");
    expect(sanitize("a\nb", { preserveNewlines: true })).toBe("a\nb");
  });
});
