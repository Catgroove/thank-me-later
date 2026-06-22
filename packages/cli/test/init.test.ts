import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/init.ts";

const dirs: string[] = [];
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tml-init-"));
  mkdirSync(join(dir, ".git")); // make it the project root the loader would resolve to
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const EXPECTED = `{
  "$schema": "https://raw.githubusercontent.com/Catgroove/thank-me-later/master/packages/cli/schema/tml.schema.json",
  "harness": "pi",
  "gitProvider": "github",
  "branch": "ai"
}
`;

describe("init", () => {
  test("writes a starter tml.json at the project root and returns 0", async () => {
    const dir = tempRepo();
    const lines: string[] = [];
    const code = await init({ cwd: dir, log: (l) => lines.push(l) });

    expect(code).toBe(0);
    const written = readFileSync(join(dir, "tml.json"), "utf8");
    expect(written).toBe(EXPECTED);
    // The scaffold parses and carries the documented defaults.
    expect(JSON.parse(written)).toMatchObject({
      harness: "pi",
      gitProvider: "github",
      branch: "ai",
    });
    expect(lines.join("\n")).toContain("wrote");
  });

  test("refuses to overwrite an existing tml.json without --force", async () => {
    const dir = tempRepo();
    const target = join(dir, "tml.json");
    writeFileSync(target, `{ "branch": "require" }`, "utf8");

    const lines: string[] = [];
    const code = await init({ cwd: dir, log: (l) => lines.push(l) });

    expect(code).toBe(1);
    expect(readFileSync(target, "utf8")).toBe(`{ "branch": "require" }`); // untouched
    expect(lines.join("\n")).toMatch(/already exists.*--force/);
  });

  test("--force overwrites an existing tml.json", async () => {
    const dir = tempRepo();
    const target = join(dir, "tml.json");
    writeFileSync(target, `{ "branch": "require" }`, "utf8");

    const code = await init({ cwd: dir, force: true, log: () => {} });

    expect(code).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(EXPECTED);
  });

  test("resolves the target to the git root when run from a subdirectory", async () => {
    const dir = tempRepo();
    const sub = join(dir, "packages", "deep");
    mkdirSync(sub, { recursive: true });

    const code = await init({ cwd: sub, log: () => {} });

    expect(code).toBe(0);
    expect(existsSync(join(dir, "tml.json"))).toBe(true); // root, not the subdir
    expect(existsSync(join(sub, "tml.json"))).toBe(false);
  });

  test("does not touch disk when write/exists are injected", async () => {
    const dir = tempRepo();
    let writtenTo: string | undefined;
    let writtenContent: string | undefined;
    const code = await init({
      cwd: dir,
      exists: () => false,
      write: (path, content) => {
        writtenTo = path;
        writtenContent = content;
      },
      log: () => {},
    });

    expect(code).toBe(0);
    expect(writtenTo).toBe(join(dir, "tml.json"));
    expect(writtenContent).toBe(EXPECTED);
    expect(existsSync(join(dir, "tml.json"))).toBe(false); // the real fs was never written
  });

  test("returns 1 with a concise error when writing fails", async () => {
    const dir = tempRepo();
    const errors: string[] = [];
    const code = await init({
      cwd: dir,
      exists: () => false,
      write: () => {
        throw new Error("disk full");
      },
      log: () => {},
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("disk full");
    expect(existsSync(join(dir, "tml.json"))).toBe(false);
  });
});
