/** @jsxImportSource @opentui/solid */
// The pending-interaction drawer. `ask` is a focused text input. `approveFindings` is a blocking,
// explicit decision surface: findings are visible with checkboxes, the operator can toggle the fix
// selection, and the Fix action sends exactly that visible selection.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { Finding, FindingAction } from "@tml/core";
import { sanitize } from "./sanitize.ts";
import { actionOptions, findingSections, SECTION_LABEL, summaryLine } from "./approval.ts";
import { theme } from "./theme.ts";
import type { ActivePrompt } from "./interaction.ts";

export type ApprovalFocusArea = "findings" | "actions";

// Each action category gets a recognizable icon and accent color so the operator can tell at a
// glance what a finding will do: a decision only they can make, a fix the next round applies on its
// own, or a note that changes nothing. The icon repeats the meaning the color carries so it survives
// in a monochrome terminal; the header label is shared with the findings inspector (SECTION_LABEL).
const SECTION_STYLE: Record<FindingAction, { readonly icon: string; readonly color: string }> = {
  "ask-user": { icon: "◆", color: theme.waiting },
  "auto-fix": { icon: "↻", color: theme.accent },
  "no-op": { icon: "▪", color: theme.textMuted },
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
          borderColor={theme.borderWarn}
          title={prompt().kind === "ask" ? "input needed" : "approval needed"}
          padding={1}
          backgroundColor={theme.overlayBg}
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
      <text fg={theme.waiting} wrapMode="word">
        {sanitize(props.prompt.prompt, { preserveNewlines: true })}
      </text>
      <box marginTop={1} border borderColor={theme.border}>
        {/* OpenTUI's input passes the typed string on submit; widen the param to satisfy JSX typing. */}
        <input
          focused
          onSubmit={(value: unknown) => props.onAskSubmit(typeof value === "string" ? value : "")}
        />
      </box>
      <text fg={theme.textFaint} marginTop={1}>
        enter to submit
      </text>
    </box>
  );
}

// The drawer is a pick-list, not a detail view: each finding is just its selection checkbox and
// title. Severity, location, and evidence live in the step's findings tab, so repeating them here
// would only duplicate that detailed view and crowd the decision surface.
function FindingRow(props: { finding: Finding; selected: boolean; focused: boolean }) {
  return (
    <box
      flexDirection="row"
      backgroundColor={props.focused ? theme.focusBg : undefined}
      paddingLeft={1}
      paddingRight={1}
    >
      <text flexShrink={0} fg={theme.text}>
        {props.selected ? "[x]" : "[ ]"}
      </text>
      <text flexGrow={1} flexShrink={1} marginLeft={1} fg={theme.text} wrapMode="word">
        {sanitize(props.finding.title)}
      </text>
    </box>
  );
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
      <text fg={theme.waiting} wrapMode="word">
        {sanitize(input().prompt, { preserveNewlines: true })}
      </text>
      <text fg={theme.textMuted} marginTop={1}>
        {summaryLine(input().findings)} · {props.selectedFindingIds().length} selected for fix
      </text>
      <For each={sections()}>
        {(section, sectionIndex) => {
          const style = SECTION_STYLE[section.action];
          // Findings keep one flat index across every section so the focus highlight lines up with
          // the navigation index, which walks the same section order (orderedFindings).
          const offset = () =>
            sections()
              .slice(0, sectionIndex())
              .reduce((total, prior) => total + prior.findings.length, 0);
          return (
            <box flexDirection="column" marginTop={1}>
              <text fg={style.color} attributes={1}>
                {style.icon} {SECTION_LABEL[section.action]} ({section.findings.length})
              </text>
              <For each={section.findings}>
                {(finding, findingIndex) => {
                  const focused = () =>
                    props.focusArea() === "findings" &&
                    offset() + findingIndex() === props.focusedFinding();
                  return (
                    <FindingRow
                      finding={finding}
                      selected={selected(finding.id)}
                      focused={focused()}
                    />
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
                backgroundColor={focused() ? theme.actionFocusBg : undefined}
                paddingLeft={1}
                paddingRight={1}
              >
                <text
                  fg={focused() ? theme.actionFocusFg : theme.text}
                  attributes={focused() ? 1 : 0}
                >
                  {focused() ? "▸ " : "  "}
                  {option.label} ({option.key})
                </text>
              </box>
            );
          }}
        </For>
      </box>
      <text fg={theme.textFaint} marginTop={1}>
        tab findings/actions · ↑/↓ move · space toggles finding · enter confirm/toggle · f fixes
        selected
      </text>
    </box>
  );
}
