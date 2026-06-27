// Open a URL in the user's default browser, the OS-native way. Best-effort; failure is silent.
// Kept free of any renderer/OpenTUI imports so non-TTY callers (the CLI lifecycle) can use it
// without pulling in the full-screen TUI runtime.

import { spawnSync } from "node:child_process";

/** Open a URL in the user's default browser. Best-effort; failure is silent. */
export function openSystemUrl(url: string): void {
  const [command, args] = openCommand();
  spawnSync(command, [...args, url], { stdio: "ignore" });
}

function openCommand(): readonly [string, readonly string[]] {
  if (process.platform === "darwin") return ["open", []];
  // `start` is a cmd builtin; the empty "" is its window-title argument so a quoted URL is not eaten.
  if (process.platform === "win32") return ["cmd", ["/c", "start", ""]];
  return ["xdg-open", []];
}
