/** @jsxImportSource @opentui/solid */
// The pending-interaction drawer. `ask` is a focused text input. `approveFindings` is a blocking,
// explicit decision surface: findings are visible with checkboxes, the operator can toggle the fix
// selection, and the Fix action sends exactly that visible selection.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { Finding, FindingAction, FindingDisposition } from "@tml/core";
import { sanitize } from "./sanitize.ts";
import { actionOptions, findingSections, summaryLine } from "./approval.ts";
import type { ActivePrompt } from "./interaction.ts";

export type ApprovalFocusArea = "findings" | "actions";

// Each action category gets a recognizable icon, header label, and accent color so the operator can
// tell at a glance what a finding will do: a decision only they can make, a fix the next round
// applies on its own, or a note that changes nothing. The icon repeats the meaning the color carries
// so it survives in a monochrome terminal.
const SECTION_META: Record<
  FindingAction,
  { readonly icon: string; readonly label: string; readonly color: string }
> = {
  "ask-user": { icon: "◆", label: "Needs your decision", color: "#f59e0b" },
  "auto-fix": { icon: "↻", label: "Auto-fix next round", color: "#38bdf8" },
  "no-op": { icon: "▪", label: "Informational", color: "#94a3b8" },
};

const DISPOSITION_COLOR: Record<FindingDisposition, string> = {
  blocker: "#ef4444",
  "should-fix": "#f59e0b",
  consider: "#38bdf8",
  nit: "#94a3b8",
};

export interface DrawerProps {
  readonly prompt: Accessor<ActivePrompt | undefined>;
  /** Which approval region owns j/k and enter. */
  readonly approvalFocusArea: Accessor<ApprovalFocusArea>;
  /** Index of the focused finding in the approval list. */
  readonly focusedFinding: Accessor<number>;
  /** Index of the focused action in the approval menu. */
  readonly focusedAction: Accessor<number>;
  /** Finding ids selected for a fix decision. */
  readonly selectedFindingIds: Accessor<readonly string[]>;
  /** Submit the typed text for an ask prompt. */
  readonly onAskSubmit: (value: string) => void;
}

export function InteractionDrawer(props: DrawerProps) {
  return (
    <Show when={props.prompt()}>
      {(prompt: Accessor<ActivePrompt>) => (
        <box
          flexDirection="column"
          border
          borderColor="#f59e0b"
          title={prompt().kind === "ask" ? "input needed" : "approval needed"}
          padding={1}
          backgroundColor="#1c1917"
        >
          <Show when={prompt().kind === "ask"}>
            <AskBody
              prompt={prompt() as Extract<ActivePrompt, { kind: "ask" }>}
              onAskSubmit={props.onAskSubmit}
            />
          </Show>
          <Show when={prompt().kind === "approval"}>
            <ApprovalBody
              prompt={prompt() as Extract<ActivePrompt, { kind: "approval" }>}
              focusArea={props.approvalFocusArea}
              focusedFinding={props.focusedFinding}
              focusedAction={props.focusedAction}
              selectedFindingIds={props.selectedFindingIds}
            />
          </Show>
        </box>
      )}
    </Show>
  );
}

function AskBody(props: {
  prompt: Extract<ActivePrompt, { kind: "ask" }>;
  onAskSubmit: (value: string) => void;
}) {
  return (
    <box flexDirection="column">
      <text fg="#fde68a" wrapMode="word">
        {sanitize(props.prompt.prompt, { preserveNewlines: true })}
      </text>
      <box marginTop={1} border borderColor="#57534e">
        {/* OpenTUI's input passes the typed string on submit; widen the param to satisfy JSX typing. */}
        <input
          focused
          onSubmit={(value: unknown) => props.onAskSubmit(typeof value === "string" ? value : "")}
        />
      </box>
      <text fg="#78716c" marginTop={1}>
        enter to submit
      </text>
    </box>
  );
}

// The action category is carried by the section header now, so the per-row label drops the
// redundant `(action)` tag and leads with the disposition instead.
function findingLabel(finding: Finding): string {
  const location = finding.location ? ` - ${finding.location}` : "";
  return `[${finding.disposition}] ${finding.title}${location}`;
}

function ApprovalBody(props: {
  prompt: Extract<ActivePrompt, { kind: "approval" }>;
  focusArea: Accessor<ApprovalFocusArea>;
  focusedFinding: Accessor<number>;
  focusedAction: Accessor<number>;
  selectedFindingIds: Accessor<readonly string[]>;
}) {
  const input = () => props.prompt.input;
  const options = () => actionOptions(props.selectedFindingIds());
  const selected = (id: string) => props.selectedFindingIds().includes(id);
  const sections = () => findingSections(input().findings);
  return (
    <box flexDirection="column">
      <text fg="#fde68a" wrapMode="word">
        {sanitize(input().prompt, { preserveNewlines: true })}
      </text>
      <text fg="#a8a29e" marginTop={1}>
        {summaryLine(input().findings)} · {props.selectedFindingIds().length} selected for fix
      </text>
      <For each={sections()}>
        {(section, sectionIndex) => {
          const meta = SECTION_META[section.action];
          // Findings keep one flat index across every section so the focus highlight lines up with
          // the navigation index, which walks the same section order (orderedFindings).
          const offset = () =>
            sections()
              .slice(0, sectionIndex())
              .reduce((total, prior) => total + prior.findings.length, 0);
          return (
            <box flexDirection="column" marginTop={1}>
              <text fg={meta.color} attributes={1}>
                {meta.icon} {meta.label} ({section.findings.length})
              </text>
              <For each={section.findings}>
                {(finding, findingIndex) => {
                  const focused = () =>
                    props.focusArea() === "findings" &&
                    offset() + findingIndex() === props.focusedFinding();
                  return (
                    <box
                      backgroundColor={focused() ? "#334155" : "#1c1917"}
                      paddingLeft={1}
                      paddingRight={1}
                    >
                      <text
                        fg={focused() ? "#e2e8f0" : DISPOSITION_COLOR[finding.disposition]}
                        wrapMode="word"
                      >
                        {selected(finding.id) ? "[x] " : "[ ] "}
                        {sanitize(findingLabel(finding))}
                      </text>
                    </box>
                  );
                }}
              </For>
            </box>
          );
        }}
      </For>
      <box flexDirection="column" marginTop={1}>
        <For each={options()}>
          {(option, index) => {
            const focused = () =>
              props.focusArea() === "actions" && index() === props.focusedAction();
            return (
              <box
                backgroundColor={focused() ? "#f59e0b" : "#1c1917"}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={focused() ? "#1c1917" : "#e7e5e4"} attributes={focused() ? 1 : 0}>
                  {focused() ? "▸ " : "  "}
                  {option.label} ({option.key})
                </text>
              </box>
            );
          }}
        </For>
      </box>
      <text fg="#78716c" marginTop={1}>
        tab findings/actions · ↑/↓ move · space toggles finding · enter confirm/toggle · f fixes
        selected
      </text>
    </box>
  );
}
