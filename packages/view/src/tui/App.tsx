/** @jsxImportSource @opentui/solid */
// The TUI root: header, the Pipeline rail + Step inspector body, a live activity strip, and the
// pending-interaction / abort-confirmation drawers. It owns the keyboard: navigation folds through
// the pure `navOnKey`, approval keys through the pure approval helpers, and abort goes through the
// injected `onAbort`. Nothing here branches on default Step names - it is generic over the Pipeline.

import { For, Show, createEffect, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";
import { runElapsed, statusColor } from "./format.ts";
import { initialNav, navOnKey, type NavState } from "./navigation.ts";
import { buildDecision, initialSelection, toggleSelection } from "./approval.ts";
import type { ActivePrompt } from "./interaction.ts";
import { PipelineRail } from "./PipelineRail.tsx";
import { StepInspector } from "./StepInspector.tsx";
import { InteractionDrawer } from "./InteractionDrawer.tsx";
import { KeyHelp } from "./KeyHelp.tsx";

export interface AppProps {
  readonly view: Accessor<ViewState>;
  readonly now: Accessor<number>;
  readonly prompt: Accessor<ActivePrompt | undefined>;
  /** Abort the Run (ends it with `run:cancelled`); supplied by the CLI. */
  readonly onAbort: () => void;
}

export function App(props: AppProps) {
  const [nav, setNav] = createSignal<NavState>(initialNav);
  const [selection, setSelection] = createSignal<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = createSignal(0);
  const [confirmAbort, setConfirmAbort] = createSignal(false);

  // Reset the approval selection/focus whenever a fresh approval prompt opens.
  createEffect(() => {
    const p = props.prompt();
    if (p?.kind === "approval") {
      setSelection(initialSelection(p.input));
      setFocused(0);
    }
  });

  const handleApproval = (
    p: Extract<ActivePrompt, { kind: "approval" }>,
    key: KeyEvent,
  ): boolean => {
    const findings = p.input.findings;
    switch (key.name) {
      case "space": {
        const id = findings[focused()]?.id;
        if (id !== undefined) setSelection(toggleSelection(selection(), id));
        return true;
      }
      case "a":
        p.submit({ action: "approve" });
        return true;
      case "s":
        p.submit({ action: "skip" });
        return true;
      case "x":
        p.submit({ action: "abort" });
        return true;
      case "f": {
        const decision = buildDecision("fix", selection());
        if (decision !== undefined) p.submit(decision);
        return true;
      }
      case "j":
      case "down":
        setFocused(Math.min(focused() + 1, Math.max(0, findings.length - 1)));
        return true;
      case "k":
      case "up":
        setFocused(Math.max(focused() - 1, 0));
        return true;
      default:
        return false;
    }
  };

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;

    // Abort confirmation takes precedence: it can only be answered, never navigated past.
    if (confirmAbort()) {
      if (key.name === "y" || (key.ctrl && key.name === "c")) {
        props.onAbort();
        return;
      }
      if (key.name === "n" || key.name === "escape") setConfirmAbort(false);
      return;
    }

    // ctrl-c always opens the abort confirmation; a second ctrl-c (handled above) aborts at once.
    if (key.ctrl && key.name === "c") {
      setConfirmAbort(true);
      return;
    }

    const p = props.prompt();
    // `q` opens abort confirmation only when no interaction is pending (so it can't eat a keystroke).
    if (key.name === "q" && p === undefined) {
      setConfirmAbort(true);
      return;
    }

    if (p?.kind === "ask") return; // the focused <input> owns typing; escape must not dismiss
    if (p?.kind === "approval" && handleApproval(p, key)) return;

    // Read-only navigation, allowed even behind the approval drawer.
    setNav(navOnKey(nav(), { name: key.name, shift: key.shift }, props.view()));
  });

  const onAskSubmit = (value: string) => {
    const p = props.prompt();
    if (p?.kind === "ask") p.submit(value);
  };

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#0b1120">
      <Header view={props.view} now={props.now} />
      <box flexGrow={1} flexDirection="row">
        <PipelineRail view={props.view} nav={nav} now={props.now} />
        <StepInspector view={props.view} nav={nav} now={props.now} />
      </box>
      <Show when={nav().showGlobalActivity}>
        <GlobalActivity view={props.view} />
      </Show>
      <LiveStrip view={props.view} />
      <Show when={nav().showHelp}>
        <KeyHelp />
      </Show>
      <Show when={props.prompt() !== undefined}>
        <InteractionDrawer
          prompt={props.prompt}
          selection={selection}
          focused={focused}
          onAskSubmit={onAskSubmit}
        />
      </Show>
      <Show when={confirmAbort()}>
        <AbortConfirm />
      </Show>
      <FooterKeys />
    </box>
  );
}

function Header(props: { view: Accessor<ViewState>; now: Accessor<number> }) {
  const status = () => props.view().status;
  const active = () => props.view().activeStep;
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor="#111827">
      <text fg="#38bdf8" attributes={1}>
        tml ship
      </text>
      <text flexGrow={1} marginLeft={2} fg={statusColor(stepStatusOf(status()))}>
        {status()}
        {active() ? ` · ${sanitize(active() ?? "")}` : ""}
      </text>
      <text fg="#64748b">{runElapsed(props.view(), props.now())}</text>
      <Show when={props.view().prUrl !== undefined}>
        <text marginLeft={2} fg="#22d3ee">
          {sanitize(props.view().prUrl ?? "")}
        </text>
      </Show>
    </box>
  );
}

/** Map the Run status onto a Step status so the header can reuse the shared status palette. */
function stepStatusOf(status: ViewState["status"]): "active" | "done" | "failed" | "skipped" {
  if (status === "finished") return "done";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "skipped";
  return "active";
}

function LiveStrip(props: { view: Accessor<ViewState> }) {
  const latest = () => props.view().globalActivity.at(-1);
  const line = () => {
    const entry = latest();
    if (entry === undefined) return "";
    if (entry.kind === "tool") {
      return `${entry.step}: ⚙ ${entry.tool?.name ?? ""}${entry.tool?.detail ? ` · ${entry.tool.detail}` : ""}`;
    }
    const text =
      (entry.text ?? "")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .at(-1) ?? "";
    return text === "" ? "" : `${entry.step}: ${text}`;
  };
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor="#111827">
      <text fg="#94a3b8" truncate>
        {sanitize(line())}
      </text>
    </box>
  );
}

function GlobalActivity(props: { view: Accessor<ViewState> }) {
  return (
    <box flexDirection="column" border borderColor="#334155" title="activity" height={8}>
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1}>
        <For each={props.view().globalActivity}>
          {(entry) => (
            <text fg="#94a3b8" wrapMode="word">
              {sanitize(
                `${entry.step}: ${
                  entry.kind === "tool"
                    ? `⚙ ${entry.tool?.name ?? ""}`
                    : (entry.text ?? "").replace(/\n+/g, " ")
                }`,
              )}
            </text>
          )}
        </For>
      </scrollbox>
    </box>
  );
}

function AbortConfirm() {
  return (
    <box border borderColor="#ef4444" title="abort" padding={1} backgroundColor="#1f1311">
      <text fg="#fca5a5">
        Abort the Run? y to confirm · n to keep going · ctrl-c again to abort now
      </text>
    </box>
  );
}

function FooterKeys() {
  return (
    <box paddingLeft={1} backgroundColor="#0b1120">
      <text fg="#475569">
        j/k move · . follow · tab tabs · enter expand · g activity · ? help · q abort
      </text>
    </box>
  );
}
