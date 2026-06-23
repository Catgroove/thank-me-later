import type { Git, GitStatus } from "@tml/core";

function touched(status: GitStatus): string {
  return [...status.staged, ...status.unstaged].sort().join("\n");
}

/** Discard edits made by a read-only agent pass when the worktree changed unexpectedly. */
export async function revertIfWorktreeChanged(
  git: Git,
  before: GitStatus,
  log: (message: string) => void,
  message: string,
): Promise<boolean> {
  if (touched(await git.status()) === touched(before)) return false;
  log(message);
  await git.discardChanges();
  return true;
}
