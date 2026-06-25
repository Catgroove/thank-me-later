import type { Ctx, Git, GitStatus } from "@tml/core";

function touched(status: GitStatus): string {
  return [...status.staged, ...status.unstaged].sort().join("\n");
}

/**
 * Run a read-only agent pass, reverting any worktree edits it leaves behind. The pass is supposed
 * not to touch files; if it does, {@link revertIfWorktreeChanged} discards the changes and logs
 * `warning` so only a later, deliberate fix round can mutate the worktree.
 */
export async function guardReadOnly<T>(
  ctx: Pick<Ctx, "git" | "log">,
  warning: string,
  pass: () => Promise<T>,
): Promise<T> {
  const before = await ctx.git.status();
  try {
    return await pass();
  } finally {
    await revertIfWorktreeChanged(ctx.git, before, (m) => ctx.log(m), warning);
  }
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
