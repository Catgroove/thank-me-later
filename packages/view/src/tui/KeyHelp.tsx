/** @jsxImportSource @opentui/solid */
// The help overlay (toggled with `?`): the fixed, generic keybindings. No Step-specific entries.

import { For } from "solid-js";

const KEYS: ReadonlyArray<readonly [string, string]> = [
  ["j / k, ↑ / ↓", "move Step selection"],
  [".", "follow the active Step"],
  ["tab / shift-tab", "switch inspector tabs"],
  ["enter", "expand / collapse the focused item"],
  ["?", "toggle this help"],
  ["q / ctrl-c", "abort the Run (confirm)"],
];

export function KeyHelp() {
  return (
    <box
      flexDirection="column"
      border
      borderColor="#38bdf8"
      title="keys"
      padding={1}
      backgroundColor="#0f172a"
    >
      <For each={KEYS}>
        {([key, description]) => (
          <box flexDirection="row">
            <text fg="#38bdf8" width={18}>
              {key}
            </text>
            <text fg="#cbd5e1">{description}</text>
          </box>
        )}
      </For>
    </box>
  );
}
