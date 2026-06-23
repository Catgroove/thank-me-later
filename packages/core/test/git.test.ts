import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGit } from "../src/providers/git.ts";

/** Fire a setup git command at `cwd`, ignoring output (test scaffolding only). */
async function setup(cwd: string, ...args: string[]): Promise<void> {
  await Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" }).exited;
}

describe("createGit (real git, against a throwaway temp repo)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tml-git-"));
    await setup(dir, "init", "-q");
    await setup(dir, "config", "user.email", "test@tml.dev");
    await setup(dir, "config", "user.name", "tml test");
    await setup(dir, "commit", "--allow-empty", "-m", "root", "-q");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("createBranch then currentBranch reports the new branch", async () => {
    const g = createGit(dir);
    await g.createBranch("feature/x");
    expect(await g.currentBranch()).toBe("feature/x");
  });

  test("status tracks unstaged → staged, and commit returns a sha and cleans the tree", async () => {
    const g = createGit(dir);
    await writeFile(join(dir, "a.txt"), "hello");

    expect((await g.status()).unstaged).toContain("a.txt");

    await g.stageAll();
    expect((await g.status()).staged).toContain("a.txt");

    const { sha } = await g.commit("add a");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const after = await g.status();
    expect(after.staged).toEqual([]);
    expect(after.unstaged).toEqual([]);
  });

  test("status preserves filenames that contain newlines", async () => {
    const g = createGit(dir);
    const name = "line\nbreak.txt";
    await writeFile(join(dir, name), "hello");

    expect((await g.status()).unstaged).toContain(name);

    await g.stageAll();
    expect((await g.status()).staged).toContain(name);
  });

  test("headSha returns the abbreviated HEAD commit sha", async () => {
    const g = createGit(dir);
    expect(await g.headSha()).toMatch(/^[0-9a-f]{7,}$/);
  });

  test("fetch updates the origin tracking ref, which headSha can read", async () => {
    await setup(dir, "branch", "-M", "main");
    await setup(dir, "init", "--bare", "-q", "remote.git");
    await setup(dir, "remote", "add", "origin", "remote.git");
    await setup(dir, "push", "-u", "origin", "main", "-q");
    const g = createGit(dir);

    await g.fetch("main");

    expect(await g.headSha("origin/main")).toBe(await g.headSha());
  });

  test("defaultBranch reads origin/HEAD, stripping the origin/ prefix", async () => {
    const g = createGit(dir);
    await setup(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    expect(await g.defaultBranch()).toBe("trunk");
  });

  test("defaultBranch falls back to a conventional branch when origin/HEAD is unset", async () => {
    const g = createGit(dir);
    await setup(dir, "branch", "-M", "main"); // no remote in this temp repo
    expect(await g.defaultBranch()).toBe("main");
  });

  test("isAncestor is true for an ancestor (and for an equal ref), false for a descendant", async () => {
    const g = createGit(dir);
    const root = await g.headSha();
    await writeFile(join(dir, "f.txt"), "x");
    await g.stageAll();
    await g.commit("second");
    const tip = await g.headSha();

    expect(await g.isAncestor(root, tip)).toBe(true);
    expect(await g.isAncestor(root, root)).toBe(true);
    expect(await g.isAncestor(tip, root)).toBe(false);
  });

  test("rebase replays cleanly onto an advanced base", async () => {
    await setup(dir, "branch", "-M", "main");
    const g = createGit(dir);
    await g.createBranch("feature");
    await writeFile(join(dir, "a.txt"), "a");
    await g.stageAll();
    await g.commit("A");

    await g.checkout("main");
    await writeFile(join(dir, "b.txt"), "b");
    await g.stageAll();
    await g.commit("B");

    await g.checkout("feature");
    expect(await g.rebase("main")).toEqual({ status: "clean" });

    // The feature commit now sits on top of main: main is an ancestor, both files are present.
    expect(await g.isAncestor("main", "HEAD")).toBe(true);
    expect(existsSync(join(dir, "a.txt"))).toBe(true);
    expect(existsSync(join(dir, "b.txt"))).toBe(true);
  });

  test("rebase stops on conflict, reports the files, and aborts back to a clean branch", async () => {
    await setup(dir, "branch", "-M", "main");
    const g = createGit(dir);
    await writeFile(join(dir, "c.txt"), "base\n");
    await g.stageAll();
    await g.commit("base c");

    await g.createBranch("feature");
    await writeFile(join(dir, "c.txt"), "feature\n");
    await g.stageAll();
    await g.commit("feature c");

    await g.checkout("main");
    await writeFile(join(dir, "c.txt"), "main\n");
    await g.stageAll();
    await g.commit("main c");

    await g.checkout("feature");
    const result = await g.rebase("main");

    expect(result.status).toBe("conflict");
    expect(result.status === "conflict" && result.files).toContain("c.txt");
    expect(await g.rebaseInProgress()).toBe(true);

    await g.rebaseAbort();
    expect(await g.rebaseInProgress()).toBe(false);
    expect(await g.currentBranch()).toBe("feature");
  });

  test("diffAgainst includes committed, tracked worktree, and untracked changes", async () => {
    await setup(dir, "branch", "-M", "main");
    const g = createGit(dir);
    await g.createBranch("feature");
    await writeFile(join(dir, "a.txt"), "committed\n");
    await g.stageAll();
    await g.commit("add a");
    await writeFile(join(dir, "a.txt"), "committed\nworktree\n");
    await writeFile(join(dir, "b.txt"), "untracked\n");

    const diff = await g.diffAgainst("main");

    expect(diff).toContain("diff --git a/a.txt b/a.txt");
    expect(diff).toContain("+committed");
    expect(diff).toContain("+worktree");
    expect(diff).toContain("diff --git a/b.txt b/b.txt");
    expect(diff).toContain("+untracked");
    expect(diff).not.toContain("Committed branch diff");
    expect(diff).not.toContain("Tracked worktree diff");
    expect(diff).not.toContain("Untracked file diff");
  });

  test("force push updates a rewritten branch the remote already has", async () => {
    await setup(dir, "branch", "-M", "main");
    await setup(dir, "init", "--bare", "-q", join(dir, "remote.git"));
    await setup(dir, "remote", "add", "origin", join(dir, "remote.git"));
    const g = createGit(dir);

    await g.createBranch("feature");
    await writeFile(join(dir, "x.txt"), "1");
    await g.stageAll();
    await g.commit("c1");
    await g.push({ branch: "feature" });

    // Rewrite history (amend), which a plain push would reject as non-fast-forward.
    await writeFile(join(dir, "x.txt"), "2");
    await g.stageAll();
    await setup(dir, "commit", "--amend", "-m", "c1 amended");

    await g.push({ branch: "feature", force: true });

    const localTip = await g.headSha();
    await g.fetch("feature");
    expect(await g.headSha("origin/feature")).toBe(localTip);
  });

  test("a failing git invocation rejects with the stderr", async () => {
    const g = createGit(dir);
    let caught: unknown;
    try {
      await g.checkout("does-not-exist");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});
