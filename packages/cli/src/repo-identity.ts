// Resolve which repo a checkout belongs to, so `tml stats` folds every clone and worktree of one
// project into a single row. Identity is the git remote `origin`: separate clones, branch worktrees,
// and tml's disposable run workspaces all share it. A checkout whose origin can't be read (no remote,
// or the directory was deleted after the run) falls back to its directory name. Reads are git-only
// side effects, injected so the resolver is testable without a real repo on disk.

import { basename } from "node:path";

export type OriginReader = (checkoutPath: string) => Promise<string | undefined>;

/** Map each unique checkout path to its repo name, resolving origins concurrently. */
export async function resolveRepoNames(
  checkoutPaths: Iterable<string>,
  readOrigin: OriginReader = gitOriginUrl,
): Promise<Map<string, string>> {
  const unique = [...new Set(checkoutPaths)];
  const resolved = await Promise.all(
    unique.map(async (path) => {
      const name = repoNameFromUrl((await readOrigin(path)) ?? "") ?? (basename(path) || path);
      return [path, name] as const;
    }),
  );
  return new Map(resolved);
}

/** Last path segment of a git remote URL (https or ssh), without the `.git` suffix. */
export function repoNameFromUrl(url: string): string | undefined {
  const cleaned = url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (cleaned === "") return undefined;
  const match = /[/:]([^/:]+)$/.exec(cleaned);
  return match ? match[1] : undefined;
}

async function gitOriginUrl(checkoutPath: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "-C", checkoutPath, "config", "--get", "remote.origin.url"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const url = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && url !== "" ? url : undefined;
  } catch {
    return undefined;
  }
}
