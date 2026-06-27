/** @jsxImportSource @opentui/solid */
// The help overlay (toggled with `?`): the fixed, generic keybindings. No Step-specific entries.

import { For } from "solid-js";
import { theme } from "./theme.ts";

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["j / k, ↑ / ↓", "move step selection"],
  [".", "follow the active step"],
  ["tab / shift-tab", "switch inspector tabs"],
  ["enter", "expand / collapse the focused item"],
  ["mouse select, y / cmd-c", "copy the selection"],
  ["o", "open the PR in your browser (once opened)"],
  ["?", "toggle this help"],
  ["q / ctrl-c", "abort the run (confirm)"],
];

export function KeyHelp() {
  return (
    <box
      flexDirection="column"
      border
      borderColor={theme.borderAccent}
      title="keys"
      padding={1}
      backgroundColor={theme.overlayBg}
    >
      <For each={KEYS}>
        {([key, description]) => (
          <box flexDirection="row">
            <text fg={theme.accent} width={18}>
              {key}
            </text>
            <text fg={theme.text}>{description}</text>
          </box>
        )}
      </For>
    </box>
  );
}
