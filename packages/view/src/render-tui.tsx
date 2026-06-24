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
import type { ApprovalDecision, ApproveFindingsInput, RunEvent } from "@tml/core";
import { initialView, type ViewState } from "./present.ts";
import type { InteractiveRenderer } from "./renderer.ts";
import { App } from "./tui/App.tsx";
import { createInteractions, type ActivePrompt } from "./tui/interaction.ts";
import { epilogueLines } from "./tui/epilogue.ts";

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
    approveFindings(input: ApproveFindingsInput): Promise<ApprovalDecision> {
      return interactions.approveFindings(input);
    },
    complete(finalView: ViewState): Promise<void> | void {
      if (finalView.status === "finished" || finalView.status === "failed") return dismissed;
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
