import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
