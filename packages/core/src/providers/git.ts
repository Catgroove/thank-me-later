// Git — the local VCS Provider (ADR-0005). One of three distinct, typed Provider
// interfaces, deliberately not collapsed into a generic Provider.
//
// `createGit(cwd)` is the real implementation: it shells out to the system `git`
// against a caller-supplied repo directory. No worktree yet (that is a later
// spec); production passes the live checkout, tests pass a throwaway temp repo.

export interface CommitResult {
  readonly sha: string;
}

export interface GitStatus {
  readonly branch: string;
  readonly staged: string[];
  readonly unstaged: string[];
}

export interface Git {
  currentBranch(): Promise<string>;
  createBranch(name: string): Promise<void>;
  checkout(name: string): Promise<void>;
  stageAll(): Promise<void>;
  commit(message: string): Promise<CommitResult>;
  status(): Promise<GitStatus>;
  push(opts?: { setUpstream?: boolean }): Promise<void>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

export function createGit(cwd: string): Git {
  const branch = async () => (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  return {
    currentBranch: branch,

    async createBranch(name) {
      await git(cwd, ["checkout", "-b", name]);
    },

    async checkout(name) {
      await git(cwd, ["checkout", name]);
    },

    async stageAll() {
      await git(cwd, ["add", "-A"]);
    },

    async commit(message) {
      await git(cwd, ["commit", "-m", message]);
      return { sha: (await git(cwd, ["rev-parse", "HEAD"])).trim() };
    },

    async status() {
      const out = await git(cwd, ["status", "--porcelain"]);
      const staged: string[] = [];
      const unstaged: string[] = [];
      for (const line of out.split("\n")) {
        if (line.length === 0) continue;
        const index = line[0];
        const worktree = line[1];
        const file = line.slice(3);
        // Untracked files report as "??" — count them as unstaged (new work).
        if (index !== " " && index !== "?") staged.push(file);
        if (worktree !== " ") unstaged.push(file);
      }
      return { branch: await branch(), staged, unstaged };
    },

    async push(opts) {
      if (opts?.setUpstream) {
        await git(cwd, ["push", "--set-upstream", "origin", await branch()]);
        return;
      }
      await git(cwd, ["push"]);
    },
  };
}
