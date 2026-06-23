// Isolated ship workspace creation. A `tml ship` run snapshots the live checkout once, then runs
// the pipeline in this disposable clone so user edits, generated files, and review resets never
// touch or race with the source checkout.

import { copyFile, lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface WorkspaceSnapshot {
  readonly sourceBranch: string;
  readonly sourceHead: string;
}

export interface CreateIsolatedWorkspaceOptions {
  /** Overlay staged, unstaged, and untracked source changes. Defaults to true for legacy callers. */
  readonly overlayChanges?: boolean;
}

interface GitRunOptions {
  readonly allowExitCodes?: readonly number[];
}

async function git(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const allowed = opts.allowExitCodes ?? [0];
  if (!allowed.includes(exitCode)) {
    throw new Error(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout;
}

async function sourceStatus(sourcePath: string): Promise<string> {
  return git(sourcePath, ["status", "--porcelain=v1", "-z"]);
}

/** The current branch for branch-scoped resume, or undefined when detached/unreadable. */
export async function currentWorkspaceSourceBranch(
  sourcePath: string,
): Promise<string | undefined> {
  try {
    const branch = (await git(sourcePath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return branch.length === 0 || branch === "HEAD" ? undefined : branch;
  } catch {
    return undefined;
  }
}

/** Remove a disposable workspace. The guard keeps catastrophic paths from being deleted. */
export async function removeIsolatedWorkspace(workspacePath: string): Promise<void> {
  const target = resolve(workspacePath);
  if (target === "/" || target.length < 8) {
    throw new Error(`refusing to remove unsafe workspace path: ${workspacePath}`);
  }
  await rm(target, { recursive: true, force: true });
}

/** Create `workspacePath` as a clone of `sourcePath`, optionally overlaid with local changes. */
export async function createIsolatedWorkspace(
  sourcePath: string,
  workspacePath: string,
  opts: CreateIsolatedWorkspaceOptions = {},
): Promise<WorkspaceSnapshot> {
  const source = resolve(sourcePath);
  const workspace = resolve(workspacePath);
  const overlayChanges = opts.overlayChanges ?? true;
  const before = await sourceStatus(source);
  if (!overlayChanges && before.length > 0) {
    throw new Error("tml ship: source checkout must be clean before creating the run workspace.");
  }
  const sourceHead = (await git(source, ["rev-parse", "HEAD"])).trim();
  const sourceBranch = (await git(source, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  await removeIsolatedWorkspace(workspace);
  await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
  try {
    await git(source, ["clone", "--no-checkout", "--no-hardlinks", source, workspace]);
    await mirrorRemotes(source, workspace);
    await copyLocalUserIdentity(source, workspace);
    if (sourceBranch === "HEAD") {
      await git(workspace, ["checkout", "--detach", sourceHead]);
    } else {
      await git(workspace, ["checkout", "-B", sourceBranch, sourceHead]);
    }

    if (overlayChanges) {
      await applyPatch(
        workspace,
        await git(source, ["diff", "--binary", "--cached", "HEAD", "--"]),
      );
      await applyPatch(workspace, await git(source, ["diff", "--binary", "--"]));
      await copyUntrackedFiles(source, workspace);
    }

    const after = await sourceStatus(source);
    if (after !== before) {
      throw new Error("tml ship: checkout changed while snapshotting; rerun tml ship.");
    }
    return { sourceBranch, sourceHead };
  } catch (error) {
    await removeIsolatedWorkspace(workspace);
    throw error;
  }
}

async function mirrorRemotes(source: string, workspace: string): Promise<void> {
  for (const remote of splitLines(await git(workspace, ["remote"]))) {
    await git(workspace, ["remote", "remove", remote]);
  }
  for (const remote of splitLines(await git(source, ["remote"]))) {
    const fetchUrl = (await git(source, ["remote", "get-url", remote])).trim();
    await git(workspace, ["remote", "add", remote, fetchUrl]);
    const pushUrl = (
      await git(source, ["remote", "get-url", "--push", remote], { allowExitCodes: [0, 2] })
    ).trim();
    if (pushUrl.length > 0 && pushUrl !== fetchUrl) {
      await git(workspace, ["remote", "set-url", "--push", remote, pushUrl]);
    }
  }
}

async function copyLocalUserIdentity(source: string, workspace: string): Promise<void> {
  for (const key of ["user.name", "user.email"]) {
    const value = (
      await git(source, ["config", "--local", "--get", key], { allowExitCodes: [0, 1] })
    ).trim();
    if (value.length > 0) await git(workspace, ["config", "--local", key, value]);
  }
}

async function applyPatch(workspace: string, patch: string): Promise<void> {
  if (patch.trim().length === 0) return;
  const path = join(workspace, `.tml-snapshot-${process.pid}-${randomUUID()}.patch`);
  await writeFile(path, patch, "utf8");
  try {
    await git(workspace, ["apply", "--whitespace=nowarn", path]);
  } finally {
    await rm(path, { force: true });
  }
}

async function copyUntrackedFiles(source: string, workspace: string): Promise<void> {
  const out = await git(source, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const file of out.split("\0")) {
    if (file.length === 0) continue;
    await copyPath(join(source, file), join(workspace, file));
  }
}

async function copyPath(source: string, target: string): Promise<void> {
  const stat = await lstat(source);
  await mkdir(dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  if (!stat.isFile()) return;
  await copyFile(source, target);
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
