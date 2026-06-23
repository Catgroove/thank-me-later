/** @jsxImportSource @opentui/solid */
// The pending-interaction drawer: visually primary, blocking surface for `ctx.ask` (free text) and
// `ctx.approveFindings` (structured selection). Generic over findings - no Step-name coupling. The
// drawer renders; App owns the keyboard and calls the prompt's `submit`. Escape never dismisses it.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { sanitize } from "./sanitize.ts";
import type { ActivePrompt } from "./interaction.ts";

export interface DrawerProps {
  readonly prompt: Accessor<ActivePrompt | undefined>;
  /** Current finding-selection set (approval only). */
  readonly selection: Accessor<ReadonlySet<string>>;
  /** Index of the focused finding (approval only). */
  readonly focused: Accessor<number>;
  /** Submit the typed text for an ask prompt. */
  readonly onAskSubmit: (value: string) => void;
}

const SEVERITY_COLOR: Record<"error" | "warning" | "info", string> = {
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#38bdf8",
};

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
              selection={props.selection}
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
  selection: Accessor<ReadonlySet<string>>;
  focused: Accessor<number>;
}) {
  const input = () => props.prompt.input;
  return (
    <box flexDirection="column">
      <text fg="#fde68a" wrapMode="word">
        {sanitize(input().prompt, { preserveNewlines: true })}
      </text>
      <Show when={(input().context ?? "").trim() !== ""}>
        <text fg="#a8a29e" wrapMode="word" marginTop={1}>
          {sanitize(input().context ?? "", { preserveNewlines: true })}
        </text>
      </Show>
      <box flexDirection="column" marginTop={1}>
        <Show
          when={input().findings.length > 0}
          fallback={<text fg="#a8a29e">No findings to review.</text>}
        >
          <For each={input().findings}>
            {(finding, index) => {
              const checked = () => props.selection().has(finding.id);
              const isFocused = () => index() === props.focused();
              return (
                <text
                  fg={isFocused() ? "#e7e5e4" : SEVERITY_COLOR[finding.severity]}
                  wrapMode="word"
                >
                  {isFocused() ? "›" : " "} [{checked() ? "x" : " "}] {finding.severity}{" "}
                  {sanitize(finding.title)}
                </text>
              );
            }}
          </For>
        </Show>
      </box>
      <text fg="#78716c" marginTop={1}>
        space toggle · a approve · f fix selected · s skip · x abort
      </text>
    </box>
  );
}
