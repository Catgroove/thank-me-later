import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../src/worktree.ts";

/** Fire a setup git command at `cwd`, ignoring output (test scaffolding only). */
async function setup(cwd: string, ...args: string[]): Promise<void> {
  await Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("createWorktree (real git, against a throwaway temp repo)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tml-wt-"));
    await setup(dir, "init", "-q");
    await setup(dir, "config", "user.email", "test@tml.dev");
    await setup(dir, "config", "user.name", "tml test");
    // A committed file, then a dirty working tree on top of it.
    await writeFile(join(dir, "committed.txt"), "v1\n");
    await setup(dir, "add", "-A");
    await setup(dir, "commit", "-m", "root", "-q");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("snapshots committed + staged + unstaged + untracked into the worktree", async () => {
    await writeFile(join(dir, "committed.txt"), "v2\n"); // unstaged modification
    await writeFile(join(dir, "staged.txt"), "staged\n");
    await setup(dir, "add", "staged.txt"); // staged addition
    await writeFile(join(dir, "untracked.txt"), "untracked\n"); // untracked

    const wt = await createWorktree(dir);

    expect(await readFile(join(wt.path, "committed.txt"), "utf8")).toBe("v2\n");
    expect(await readFile(join(wt.path, "staged.txt"), "utf8")).toBe("staged\n");
    expect(await readFile(join(wt.path, "untracked.txt"), "utf8")).toBe("untracked\n");

    await wt.dispose();
  });

  test("leaves the live checkout untouched and dispose() removes only the worktree", async () => {
    await writeFile(join(dir, "committed.txt"), "v2\n");

    const wt = await createWorktree(dir);
    expect(await exists(wt.path)).toBe(true);

    // The live checkout still has its dirty file exactly as before.
    expect(await readFile(join(dir, "committed.txt"), "utf8")).toBe("v2\n");

    await wt.dispose();
    expect(await exists(wt.path)).toBe(false);
    // The repo and its working tree survive disposal.
    expect(await readFile(join(dir, "committed.txt"), "utf8")).toBe("v2\n");
  });

  test("works on a clean repo (no uncommitted changes)", async () => {
    const wt = await createWorktree(dir);
    expect(await readFile(join(wt.path, "committed.txt"), "utf8")).toBe("v1\n");
    await wt.dispose();
  });
});
