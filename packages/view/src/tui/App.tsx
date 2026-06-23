/** @jsxImportSource @opentui/solid */
// The TUI root: header, the Pipeline rail + Step inspector body, an always-visible activity panel,
// and the pending-interaction / abort-confirmation drawers. It owns the keyboard: navigation folds
// through the pure `navOnKey`, approval keys through the pure approval helpers, and abort goes through
// the injected `onAbort`. Nothing here branches on default Step names - it is generic over the Pipeline.

import { For, Show, createEffect, createSignal } from "solid-js";
import type { Accessor } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { ActivityEntry, ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";
import { runElapsed, statusColor } from "./format.ts";
import { initialNav, navOnKey, type NavState } from "./navigation.ts";
import {
  actionOptions,
  buildDecision,
  orderedFindings,
  suggestedSelection,
  toggleSelection,
  type ApprovalAction,
} from "./approval.ts";
import type { ActivePrompt } from "./interaction.ts";
import { PipelineRail } from "./PipelineRail.tsx";
import { StepInspector } from "./StepInspector.tsx";
import { InteractionDrawer, type ApprovalFocusArea } from "./InteractionDrawer.tsx";
import { KeyHelp } from "./KeyHelp.tsx";

export interface AppProps {
  readonly view: Accessor<ViewState>;
  readonly now: Accessor<number>;
  readonly prompt: Accessor<ActivePrompt | undefined>;
  /** Copy the active mouse selection to the clipboard; supplied by the CLI renderer. */
  readonly onCopySelection: () => boolean;
  /** Abort the Run (ends it with `run:cancelled`); supplied by the CLI. */
  readonly onAbort: () => void;
}

export function App(props: AppProps) {
  const [nav, setNav] = createSignal<NavState>(initialNav);
  const [approvalFocusArea, setApprovalFocusArea] = createSignal<ApprovalFocusArea>("findings");
  const [focusedFinding, setFocusedFinding] = createSignal(0);
  const [focusedAction, setFocusedAction] = createSignal(0);
  const [selectedFindingIds, setSelectedFindingIds] = createSignal<readonly string[]>([]);
  const [confirmAbort, setConfirmAbort] = createSignal(false);

  // The finding the action list is currently on, surfaced to the inspector so its Findings tab can
  // highlight the same finding. Undefined unless an approval is pending - nothing to point at otherwise.
  const focusedFindingId = (): string | undefined => {
    const p = props.prompt();
    if (p?.kind !== "approval") return undefined;
    return p.input.findings[focusedFinding()]?.id;
  };

  // Seed a fresh approval prompt with its suggested fix selection, show that selection visibly, and
  // pull the inspector onto the findings tab so the detailed findings are in view while deciding.
  createEffect(() => {
    const p = props.prompt();
    if (p?.kind !== "approval") return;
    setApprovalFocusArea(p.input.findings.length > 0 ? "findings" : "actions");
    setFocusedFinding(0);
    setFocusedAction(0);
    setSelectedFindingIds(suggestedSelection(p.input));
    setNav((n) => ({ ...n, tab: "findings", followActive: true }));
  });

  createEffect(() => {
    const options = actionOptions(selectedFindingIds());
    if (focusedAction() >= options.length) setFocusedAction(Math.max(0, options.length - 1));
  });

  const handleApproval = (
    p: Extract<ActivePrompt, { kind: "approval" }>,
    key: KeyEvent,
  ): boolean => {
    // Traverse findings in the same section order the drawer renders, so j/k moves top-to-bottom
    // through the visible groups rather than the prompt's raw arrival order.
    const findings = orderedFindings(p.input.findings);
    const options = actionOptions(selectedFindingIds());
    const submit = (action: ApprovalAction) => {
      const decision = buildDecision(action, selectedFindingIds());
      if (decision !== undefined) p.submit(decision);
    };
    const toggleFocusedFinding = () => {
      const finding = findings[focusedFinding()];
      if (finding !== undefined)
        setSelectedFindingIds(toggleSelection(selectedFindingIds(), finding.id));
    };
    switch (key.name) {
      case "tab":
        setApprovalFocusArea(approvalFocusArea() === "findings" ? "actions" : "findings");
        return true;
      case "j":
      case "down":
        if (approvalFocusArea() === "findings") {
          setFocusedFinding(Math.min(focusedFinding() + 1, Math.max(0, findings.length - 1)));
        } else {
          setFocusedAction(Math.min(focusedAction() + 1, options.length - 1));
        }
        return true;
      case "k":
      case "up":
        if (approvalFocusArea() === "findings") {
          setFocusedFinding(Math.max(focusedFinding() - 1, 0));
        } else {
          setFocusedAction(Math.max(focusedAction() - 1, 0));
        }
        return true;
      case "space":
        if (approvalFocusArea() === "findings") toggleFocusedFinding();
        return true;
      case "return":
      case "enter": {
        if (approvalFocusArea() === "findings") {
          toggleFocusedFinding();
          return true;
        }
        const option = options[focusedAction()];
        if (option !== undefined) submit(option.action);
        return true;
      }
      default: {
        // Direct shortcut letters (f/a/s/x) submit their action; other keys fall through to nav.
        const option = options.find((candidate) => candidate.key === key.name);
        if (option === undefined) return false;
        submit(option.action);
        return true;
      }
    }
  };

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;

    if (isCopySelectionKey(key) && props.onCopySelection()) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }

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
    <box flexDirection="column" width="100%" height="100%" paddingTop={1} backgroundColor="#0b1120">
      <Header view={props.view} now={props.now} />
      <box flexGrow={7} flexBasis={0} flexDirection="row">
        <PipelineRail view={props.view} nav={nav} now={props.now} />
        <StepInspector
          view={props.view}
          nav={nav}
          now={props.now}
          focusedFindingId={focusedFindingId}
        />
      </box>
      {/* The activity panel yields the lower region to a blocking drawer: the Run is paused on a
          decision, so no activity is flowing, and the drawer is the surface that needs the room. */}
      <Show when={props.prompt() === undefined && !confirmAbort()}>
        <ActivityPanel view={props.view} />
      </Show>
      <Show when={nav().showHelp}>
        <KeyHelp />
      </Show>
      <Show when={props.prompt() !== undefined}>
        <InteractionDrawer
          prompt={props.prompt}
          approvalFocusArea={approvalFocusArea}
          focusedFinding={focusedFinding}
          focusedAction={focusedAction}
          selectedFindingIds={selectedFindingIds}
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

function isCopySelectionKey(key: KeyEvent): boolean {
  const name = key.name.toLowerCase();
  return name === "y" || (name === "c" && (key.meta || key.super === true));
}

function Header(props: { view: Accessor<ViewState>; now: Accessor<number> }) {
  const status = () => props.view().status;
  const active = () => props.view().activeStep;
  const elapsed = () => runElapsed(props.view(), props.now());
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1} backgroundColor="#111827">
      <text fg="#38bdf8" attributes={1}>
        tml ship
      </text>
      <text flexGrow={1} marginLeft={2} fg={statusColor(stepStatusOf(status()))}>
        {status()}
        {active() ? ` · ${sanitize(active() ?? "")}` : ""}
      </text>
      <Show when={elapsed() !== ""}>
        <text fg="#64748b">total {elapsed()}</text>
      </Show>
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

/** One cross-Step activity line: a dim `step:` prefix and the entry, coloured by kind (purple tool). */
function ActivityLine(props: { entry: ActivityEntry }) {
  const e = props.entry;
  const line = () => {
    const prefix = `${e.step}: `;
    if (e.kind === "tool") {
      const label = `${e.tool?.name ?? ""}${e.tool?.detail ? ` · ${e.tool.detail}` : ""}`;
      return `${prefix}⚙ ${label}${e.phase === "end" ? " (done)" : ""}`;
    }
    const body = (e.text ?? "").replace(/\n+/g, " ");
    return e.kind === "log" ? `${prefix}· ${body}` : `${prefix}${body}`;
  };
  return (
    <text
      fg={e.kind === "tool" ? "#a78bfa" : e.kind === "log" ? "#94a3b8" : "#cbd5e1"}
      wrapMode="word"
    >
      {sanitize(line())}
    </text>
  );
}

/**
 * The always-visible activity panel: the full cross-Step trail, sticky-scrolled to the latest line.
 * It replaces both the old one-line strip and the toggled overlay - one surface, no flag, no tab.
 * `flexBasis={0}` + the 7:3 grow split with the rail/inspector row gives it ~30% of the body height,
 * independent of how much either side's content happens to fill.
 */
function ActivityPanel(props: { view: Accessor<ViewState> }) {
  return (
    <box
      flexGrow={3}
      flexBasis={0}
      flexDirection="column"
      border
      borderColor="#a78bfa"
      title="activity"
    >
      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" paddingLeft={1} paddingRight={1}>
        <Show
          when={props.view().globalActivity.length > 0}
          fallback={<text fg="#64748b">No activity yet.</text>}
        >
          <For each={props.view().globalActivity}>{(entry) => <ActivityLine entry={entry} />}</For>
        </Show>
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
        j/k move · . follow · tab tabs · enter expand · y/cmd-c copy selection · ? help · q abort
      </text>
    </box>
  );
}
