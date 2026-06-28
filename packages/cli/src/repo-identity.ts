// Resolve which repo a checkout belongs to, so `tml stats` folds every clone and worktree of one
// project into a single row. Identity is the git remote `origin`: separate clones, branch worktrees,
// and tml's disposable run workspaces all share it. A checkout whose origin can't be read (no remote,
// or the directory was deleted after the run) falls back to its directory name. Reads are git-only
// side effects, injected so the resolver is testable without a real repo on disk.

import { basename } from "node:path";

export type OriginReader = (checkoutPath: string) => Promise<string | undefined>;

/** Map each unique checkout path to its repo identity, resolving origins concurrently. */
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

/** Host and path of a git remote URL, without credentials or the `.git` suffix. */
export function repoNameFromUrl(url: string): string | undefined {
  const cleaned = url
    .trim()
    .replace(/\/$/, "")
    .replace(/\.git$/, "");
  if (cleaned === "") return undefined;

  try {
    const parsed = new URL(cleaned);
    const path = parsed.pathname.replace(/^\/+/, "");
    return parsed.host !== "" && path !== "" ? `${parsed.host}/${path}` : undefined;
  } catch {
    const scp = /^(?:[^@]+@)?([^/:]+):(.+)$/.exec(cleaned);
    if (scp) return `${scp[1]}/${scp[2].replace(/^\/+/, "")}`;
    return cleaned;
  }
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
