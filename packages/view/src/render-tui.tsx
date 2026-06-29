/** @jsxImportSource @opentui/solid */
// The full-screen OpenTUI/Solid renderer for `tml ship`. It is a Renderer + interactive responder,
// not a second Conductor: `ship()` still owns the loop and feeds it folded ViewStates, while this
// supplies `ctx.ask`/`ctx.approveFindings` drawers, an abort path, and a post-close epilogue.
//
// Rendering policy (per the spec): fold every event, never drop facts; batch noisy `agent:progress`
// commits onto a microtask; flush urgent events (pending interactions, terminal states) immediately;
// run at OpenTUI's default cadence capped to 30 FPS; animate only live surfaces. There is no custom
// permanent render loop - Solid's reactivity drives OpenTUI's on-demand rendering.

import { spawnSync } from "node:child_process";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { ApprovalDecision, ApprovalFindingsInput, RunEvent } from "@tml/core";
import { openSystemUrl } from "./open-url.ts";
import { initialView, type ViewState } from "./present.ts";
import type { InteractiveRenderer, Renderer } from "./renderer.ts";
import type { RunMetadata } from "@tml/core";
import type { GateDecision } from "./gate.ts";
import type { PickerOutcome } from "./picker.ts";
import { App } from "./tui/App.tsx";
import { createInteractions, type ActivePrompt } from "./tui/interaction.ts";
import { epilogueLines } from "./tui/epilogue.ts";
import { RunList } from "./tui/RunList.tsx";
import { StartupGate } from "./tui/StartupGate.tsx";

export interface TuiRendererOptions {
  /** Abort the Run when the user closes the TUI while it is active. */
  readonly onAbort?: () => void;
  /** Clock for live elapsed displays and the epilogue. Defaults to `Date.now`; injectable for tests. */
  readonly now?: () => number;
}

/** Events that must paint immediately rather than wait for the batched microtask flush. */
function isUrgent(event: RunEvent): boolean {
  return (
    event.type === "ask:pending" ||
    event.type === "approval:pending" ||
    event.type === "run:failed" ||
    event.type === "run:finished" ||
    event.type === "run:parked" ||
    event.type === "watch:checking" ||
    event.type === "watch:waiting" ||
    event.type === "run:cancelled"
  );
}

function copySelectedText(cli: CliRenderer): boolean {
  const selection = cli.getSelection();
  if (selection === null) return false;

  const text = selection.getSelectedText();
  if (text.length === 0) return false;

  // OSC52 reports that the escape sequence was written, not that the terminal accepted it. Also
  // write the local clipboard when possible so local TUI sessions work in terminals that ignore OSC52.
  const copied = writeSystemClipboard(text) || cli.copyToClipboardOSC52(text);
  if (copied) cli.clearSelection();
  return true;
}

function writeSystemClipboard(text: string): boolean {
  for (const [command, args] of clipboardCommands()) {
    const result = spawnSync(command, args, { input: text, stdio: ["pipe", "ignore", "ignore"] });
    if (result.error === undefined && result.status === 0) return true;
  }
  return false;
}

function clipboardCommands(): ReadonlyArray<readonly [string, readonly string[]]> {
  if (process.platform === "darwin") return [["pbcopy", []]];
  if (process.platform === "win32") return [["clip.exe", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ];
}

export async function createTuiRenderer(
  options: TuiRendererOptions = {},
): Promise<InteractiveRenderer> {
  const now = options.now ?? (() => Date.now());
  const onAbort = options.onAbort ?? (() => undefined);

  const [view, setView] = createSignal<ViewState>(initialView);
  const [nowSig, setNow] = createSignal<number>(now());
  const [prompt, setPrompt] = createSignal<ActivePrompt | undefined>(undefined);
  const interactions = createInteractions(setPrompt);

  // The user leaving a completed Run: the renderer's completion hook keeps the TUI up after the
  // pipeline ends; the App calls `onDismiss` when a dismiss key is pressed in a terminal state.
  let resolveDismiss: (() => void) | undefined;
  const dismissed = new Promise<void>((resolve) => {
    resolveDismiss = resolve;
  });
  const onDismiss = (): void => resolveDismiss?.();

  // ctrl-c is handled by the TUI (delivered as a keypress in raw mode), not by an automatic process
  // exit. Mouse is on so the activity panel and inspector scrollboxes take the wheel directly (the
  // scrollbox consumes scroll events itself - no per-element wiring); this is the cost of giving up
  // the terminal's native click-drag text selection. Cap the cadence at 30 FPS, alternate screen.
  const cli = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 30,
    screenMode: "alternate-screen",
  });

  await render(
    () =>
      App({
        view,
        now: nowSig,
        prompt,
        onCopySelection: () => copySelectedText(cli),
        onOpenUrl: openSystemUrl,
        onAbort,
        onDismiss,
      }),
    cli,
  );

  // A 1s tick drives live elapsed displays only; the spinner animates itself. This is not a render
  // loop - it is a low-frequency state nudge that stops as soon as the renderer closes.
  const clock = setInterval(() => setNow(now()), 1000);
  (clock as { unref?: () => void }).unref?.();

  // Batch noisy commits: keep the latest folded state and commit once per microtask, except urgent
  // events which paint right away so a pending prompt / terminal state is never delayed.
  let latest = initialView;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    setView(latest);
  };

  let closed = false;
  return {
    render(next: ViewState, event: RunEvent): void {
      latest = next;
      if (isUrgent(event)) {
        scheduled = false;
        setView(next);
      } else if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    ask(promptText: string): Promise<string> {
      return interactions.ask(promptText);
    },
    approveFindings(input: ApprovalFindingsInput): Promise<ApprovalDecision> {
      return interactions.approveFindings(input);
    },
    complete(finalView: ViewState): Promise<void> | void {
      if (
        finalView.status === "finished" ||
        finalView.status === "parked" ||
        finalView.status === "failed"
      )
        return dismissed;
    },
    close(): void {
      if (closed) return;
      closed = true;
      resolveDismiss?.(); // a forced close (e.g. a signal) must never leave an awaiter hanging
      clearInterval(clock);
      cli.destroy(); // leaves the alternate screen and restores the terminal
    },
    epilogue(finalView: ViewState): void {
      const lines = epilogueLines(finalView, now());
      if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
    },
  };
}

export interface ViewerRendererOptions {
  /** Clock for live elapsed displays. Defaults to `Date.now`; injectable for tests. */
  readonly now?: () => number;
}

/** A read-only renderer that also reports when the user has detached, so an attach loop can stop. */
export interface ViewerRenderer extends Renderer {
  dismissed(): boolean;
}

/**
 * The read-only viewer renderer: the same OpenTUI dashboard as `createTuiRenderer`, mounted in
 * read-only mode. It conducts nothing - it folds a Run's recorded events (replay) or tails a live
 * Run (attach). `complete` keeps the dashboard up until the user detaches, for any terminal status
 * (a cancelled Run is just as worth reading as a finished one); a quit key resolves the wait.
 */
export async function createViewerRenderer(
  options: ViewerRendererOptions = {},
): Promise<ViewerRenderer> {
  const now = options.now ?? (() => Date.now());
  const [view, setView] = createSignal<ViewState>(initialView);
  const [nowSig, setNow] = createSignal<number>(now());
  const [prompt] = createSignal<ActivePrompt | undefined>(undefined);

  let dismissedFlag = false;
  let resolveDismiss: (() => void) | undefined;
  const dismissed = new Promise<void>((resolve) => {
    resolveDismiss = resolve;
  });
  const onDismiss = (): void => {
    dismissedFlag = true;
    resolveDismiss?.();
  };

  const cli = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 30,
    screenMode: "alternate-screen",
  });

  await render(
    () =>
      App({
        view,
        now: nowSig,
        prompt,
        readOnly: true,
        onCopySelection: () => copySelectedText(cli),
        onOpenUrl: openSystemUrl,
        onAbort: () => undefined,
        onDismiss,
      }),
    cli,
  );

  const clock = setInterval(() => setNow(now()), 1000);
  (clock as { unref?: () => void }).unref?.();

  let latest = initialView;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    setView(latest);
  };

  let closed = false;
  return {
    render(next: ViewState, event: RunEvent): void {
      latest = next;
      if (isUrgent(event)) {
        scheduled = false;
        setView(next);
      } else if (!scheduled) {
        scheduled = true;
        queueMicrotask(flush);
      }
    },
    complete(): Promise<void> {
      return dismissed; // stay up until the user detaches, whatever the terminal status
    },
    dismissed(): boolean {
      return dismissedFlag;
    },
    close(): void {
      if (closed) return;
      closed = true;
      dismissedFlag = true;
      resolveDismiss?.();
      clearInterval(clock);
      cli.destroy();
    },
  };
}

/**
 * Open the Run picker: mount the read-only list, wait for the user to choose a Run (or quit), tear
 * the screen down, and return the outcome. The CLI maps it onto resume or the viewer. Mounting and
 * teardown are fully contained here so the next renderer (viewer / engine) starts from a clean terminal.
 */
export async function runPicker(
  runs: readonly RunMetadata[],
  options: { now?: number } = {},
): Promise<PickerOutcome> {
  const now = options.now ?? Date.now();
  const cli = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 30,
    screenMode: "alternate-screen",
  });

  let resolveOutcome: ((outcome: PickerOutcome) => void) | undefined;
  const chosen = new Promise<PickerOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  await render(
    () => RunList({ runs, now, onResolve: (outcome) => resolveOutcome?.(outcome) }),
    cli,
  );

  try {
    return await chosen;
  } finally {
    cli.destroy();
  }
}

/**
 * Show the startup gate for a candidate Run and return the user's decision. Mounting and teardown
 * are contained here so the chosen action (resume / viewer / picker / fresh run) starts clean.
 */
export async function runStartupGate(input: {
  run: RunMetadata;
  live: boolean;
  now?: number;
}): Promise<GateDecision> {
  const now = input.now ?? Date.now();
  const cli = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: true,
    targetFps: 30,
    screenMode: "alternate-screen",
  });

  let resolveDecision: ((decision: GateDecision) => void) | undefined;
  const decided = new Promise<GateDecision>((resolve) => {
    resolveDecision = resolve;
  });

  await render(
    () =>
      StartupGate({
        run: input.run,
        live: input.live,
        now,
        onResolve: (decision) => resolveDecision?.(decision),
      }),
    cli,
  );

  try {
    return await decided;
  } finally {
    cli.destroy();
  }
}
