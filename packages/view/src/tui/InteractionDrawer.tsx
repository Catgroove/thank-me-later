/** @jsxImportSource @opentui/solid */
// The pending-interaction drawer: a tight, blocking decision surface for `ctx.ask` (free text) and
// `ctx.approveFindings` (a single choice). It shows only what the decision needs - the prompt, a
// one-line severity summary, and a highlighted action menu - and never dumps finding detail or round
// history, which live in the inspector's Findings/Rounds tabs (reachable with `tab` while open).
// Generic over findings; the drawer renders, App owns the keyboard. Escape never dismisses it.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { sanitize } from "./sanitize.ts";
import { actionOptions, summaryLine } from "./approval.ts";
import type { ActivePrompt } from "./interaction.ts";

export interface DrawerProps {
  readonly prompt: Accessor<ActivePrompt | undefined>;
  /** Index of the focused action in the approval menu. */
  readonly focused: Accessor<number>;
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
              focused={props.focused}
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

function ApprovalBody(props: {
  prompt: Extract<ActivePrompt, { kind: "approval" }>;
  focused: Accessor<number>;
}) {
  const input = () => props.prompt.input;
  const options = () => actionOptions(input());
  return (
    <box flexDirection="column">
      <text fg="#fde68a" wrapMode="word">
        {sanitize(input().prompt, { preserveNewlines: true })}
      </text>
      <text fg="#a8a29e" marginTop={1}>
        {summaryLine(input().findings)}
      </text>
      <Show when={input().findings.length > 0}>
        <text fg="#78716c">tab to inspect details</text>
      </Show>
      <box flexDirection="column" marginTop={1}>
        <For each={options()}>
          {(option, index) => {
            const isFocused = () => index() === props.focused();
            return (
              <box
                backgroundColor={isFocused() ? "#f59e0b" : "#1c1917"}
                paddingLeft={1}
                paddingRight={1}
              >
                <text fg={isFocused() ? "#1c1917" : "#e7e5e4"} attributes={isFocused() ? 1 : 0}>
                  {isFocused() ? "▸ " : "  "}
                  {option.label} ({option.key})
                </text>
              </box>
            );
          }}
        </For>
      </box>
      <text fg="#78716c" marginTop={1}>
        ↑/↓ move · enter confirm
      </text>
    </box>
  );
}
