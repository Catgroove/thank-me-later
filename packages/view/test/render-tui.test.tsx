/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import { makeFinding } from "@tml/core";
import { initialView, present, type ViewState } from "../src/present.ts";
import type { RunEvent, RunEventInput } from "@tml/core";
import { App } from "../src/tui/App.tsx";
import type { ActivePrompt } from "../src/tui/interaction.ts";

const stamp = (event: RunEventInput, i: number): RunEvent => ({ ...event, at: i }) as RunEvent;
const fold = (events: RunEventInput[]): ViewState =>
  events.reduce<ViewState>((v, e, i) => present(v, stamp(e, i)), initialView);

// Plugin-like Step names: the TUI must render these exactly like bundled Steps.
const PIPELINE = ["alpha-plugin", "custom-thing", "ze-last-step"];

describe("TUI App (no real terminal)", () => {
  test("renders arbitrary assembled Pipeline Steps with no default-name assumptions", async () => {
    const view = fold([
      { type: "run:started", pipeline: PIPELINE },
      { type: "step:started", step: "alpha-plugin" },
      { type: "step:finished", step: "alpha-plugin" },
      { type: "step:started", step: "custom-thing" },
    ]);
    const [getView] = createSignal(view);
    const [now] = createSignal(1000);
    const [prompt] = createSignal<ActivePrompt | undefined>(undefined);

    const t = await testRender(
      () => App({ view: getView, now, prompt, onCopySelection: () => false, onAbort: () => {} }),
      {
        width: 100,
        height: 24,
      },
    );
    await t.flush();
    const frame = t.captureCharFrame();
    for (const name of PIPELINE) expect(frame).toContain(name);
    expect(frame).toContain("tml ship");
    t.renderer.destroy();
  });

  test("renders an active Step's phases as a sub-tree in the rail", async () => {
    const view = fold([
      { type: "run:started", pipeline: ["review"] },
      { type: "step:started", step: "review" },
      {
        type: "phase:started",
        step: "review",
        phaseId: "phase-1",
        phase: "Context & intent",
        group: "initial",
      },
      {
        type: "phase:finished",
        step: "review",
        phaseId: "phase-1",
        phase: "Context & intent",
        group: "initial",
        findings: [],
        status: "ok",
      },
      {
        type: "phase:started",
        step: "review",
        phaseId: "phase-2",
        phase: "Architecture & scope",
        group: "initial",
      },
    ]);
    const [getView] = createSignal(view);
    const [now] = createSignal(1000);
    const [prompt] = createSignal<ActivePrompt | undefined>(undefined);

    const t = await testRender(
      () => App({ view: getView, now, prompt, onCopySelection: () => false, onAbort: () => {} }),
      {
        width: 100,
        height: 24,
      },
    );
    await t.flush();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Context & intent");
    expect(frame).toContain("Architecture & scope");
    t.renderer.destroy();
  });

  test("shows the approval drawer with its findings when an interaction is pending", async () => {
    const view = fold([
      { type: "run:started", pipeline: PIPELINE },
      { type: "step:started", step: "custom-thing" },
    ]);
    const [getView] = createSignal(view);
    const [now] = createSignal(1000);
    const [prompt] = createSignal<ActivePrompt | undefined>({
      kind: "approval",
      input: {
        prompt: "Approve these findings",
        findings: [
          makeFinding("x", {
            disposition: "should-fix",
            action: "ask-user",
            title: "Tighten the retry",
            detail: "consider a backoff",
          }),
          makeFinding("x", {
            disposition: "nit",
            action: "auto-fix",
            title: "Reformat the import",
            detail: "oxfmt will handle it",
          }),
        ],
      },
      submit: () => {},
    });

    const t = await testRender(
      () => App({ view: getView, now, prompt, onCopySelection: () => false, onAbort: () => {} }),
      {
        width: 100,
        height: 24,
      },
    );
    await t.flush();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Approve these findings"); // the prompt
    expect(frame).toContain("1 should-fix"); // disposition summary
    expect(frame).toContain("0 selected for fix");
    expect(frame).toContain("Tighten the retry"); // visible finding selection row
    expect(frame).toContain("approval needed"); // the drawer is the primary surface
    // Findings are split into action sections instead of one flat list.
    expect(frame).toContain("Needs your decision");
    expect(frame).toContain("Auto-fix");
    // The per-row action tag is gone now that the section header carries it.
    expect(frame).not.toContain("(ask-user)");
    t.renderer.destroy();
  });
});
