import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadTmlConfig } from "../src/load.ts";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tml-load-"));
  dirs.push(dir);
  return dir;
}
function writeConfig(dir: string, config: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tml.json"),
    typeof config === "string" ? config : JSON.stringify(config),
  );
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Inject both layers as temp dirs and a bare env, so no test reads the real ~/.config or .git.
function load(globalDir: string, projectRoot: string) {
  return loadTmlConfig(projectRoot, { configHome: globalDir, projectRoot, env: {} });
}

describe("loadTmlConfig", () => {
  test("no files → empty selection and no plugin paths (zero-config)", () => {
    const loaded = load(tempDir(), tempDir());
    expect(loaded.selection).toEqual({});
    expect(loaded.pluginPaths).toEqual([]);
  });

  test("project overrides global per key; models merge; disable unions", () => {
    const globalDir = tempDir();
    const projectRoot = tempDir();
    writeConfig(globalDir, {
      harness: "pi",
      branch: "auto",
      maxFixAttempts: 2,
      models: { default: "haiku", review: "sonnet" },
      disable: ["typecheck"],
    });
    writeConfig(projectRoot, {
      branch: "require",
      maxFixAttempts: 4,
      models: { review: "opus" },
      disable: ["lint"],
    });
    const { selection } = load(globalDir, projectRoot);
    expect(selection.harness).toBe("pi"); // global, not overridden
    expect(selection.branch).toBe("require"); // project wins
    expect(selection.maxFixAttempts).toBe(4); // project wins
    expect(selection.models).toEqual({ default: "haiku", review: "opus" }); // merged, project key wins
    expect(selection.disable).toEqual(["typecheck", "lint"]); // union, order-preserving
  });

  test("plugins concatenate global-then-project, each resolved against its own config dir", () => {
    const globalDir = tempDir();
    const projectRoot = tempDir();
    writeConfig(globalDir, { plugins: ["./g.ts"] });
    writeConfig(projectRoot, { plugins: ["./sub/p.ts"] });
    const { pluginPaths } = load(globalDir, projectRoot);
    expect(pluginPaths).toEqual([resolve(globalDir, "g.ts"), resolve(projectRoot, "sub/p.ts")]);
  });

  test("a bare (non-path) plugin entry is a clear error — remote plugins are deferred", () => {
    const projectRoot = tempDir();
    writeConfig(projectRoot, { plugins: ["@acme/tml-step"] });
    expect(() => load(tempDir(), projectRoot)).toThrow(/not a local path/);
  });

  test("malformed JSON throws naming the offending file", () => {
    const projectRoot = tempDir();
    writeConfig(projectRoot, "{ not json ]");
    expect(() => load(tempDir(), projectRoot)).toThrow(
      new RegExp(projectRoot.replace(/[/\\]/g, ".")),
    ); // path in message
    expect(() => load(tempDir(), projectRoot)).toThrow(/not valid JSON/);
  });

  test("an unknown top-level key is rejected", () => {
    const projectRoot = tempDir();
    writeConfig(projectRoot, { harnes: "pi" }); // typo
    expect(() => load(tempDir(), projectRoot)).toThrow(/unknown key "harnes"/);
  });

  test("a wrong-typed key is rejected", () => {
    const projectRoot = tempDir();
    writeConfig(projectRoot, { disable: "typecheck" }); // should be an array
    expect(() => load(tempDir(), projectRoot)).toThrow(/"disable".*array of strings/);
  });

  test("model ids, maxFixAttempts, and $schema have validated types", () => {
    const badModel = tempDir();
    writeConfig(badModel, { models: { review: 42 } });
    expect(() => load(tempDir(), badModel)).toThrow(/"models.review".*string model id/);

    const badMax = tempDir();
    writeConfig(badMax, { maxFixAttempts: -1 });
    expect(() => load(tempDir(), badMax)).toThrow(/"maxFixAttempts".*non-negative integer/);

    const badSchema = tempDir();
    writeConfig(badSchema, { $schema: 42 });
    expect(() => load(tempDir(), badSchema)).toThrow(/"\$schema".*string/);
  });
});
