// Locate, parse, and merge `tml.json` — the declarative config. Two layers:
//   • global   — $XDG_CONFIG_HOME/tml/tml.json  (or ~/.config/tml/tml.json)
//   • project  — <git-root>/tml.json            (walking up from cwd; falls back to cwd)
// They deep-merge with the project winning per key; the `plugins` arrays concatenate (global
// then project) and `disable` unions; provider/branch scalars are project-over-global. Plugin
// entries are resolved to absolute paths against *their own* config file's directory (so a
// global plugin path isn't reinterpreted relative to the repo). Missing files → empty config,
// which is the zero-config path: `tml ship` then runs the bundled defaults unchanged.
//
// This module is pure IO + shape-checking; it does NOT import or run plugins (that is the
// assembly step in `config.ts`). Remote/published plugins are deferred: a non-path
// `plugins` entry is a clear error, not an npm fetch.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ModelMap, Selection } from "@tml/core";
import { errorMessage } from "./error.ts";

const FILENAME = "tml.json";
const ALLOWED_KEYS = new Set([
  "$schema",
  "harness",
  "gitProvider",
  "branch",
  "models",
  "disable",
  "plugins",
]);

export interface LoadOptions {
  /** Global config dir. Defaults to $XDG_CONFIG_HOME/tml or ~/.config/tml. Tests inject a temp dir. */
  configHome?: string;
  /** Project root holding `tml.json`. Defaults to the git-root walk from cwd. */
  projectRoot?: string;
  /** Environment lookup (for XDG_CONFIG_HOME). Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

export interface Loaded {
  /** The merged declarative knobs, ready to hand to `createAssembly`. */
  selection: Selection;
  /** Absolute paths to local plugin files, global first then project. */
  pluginPaths: string[];
}

interface RawConfig {
  harness?: string;
  gitProvider?: string;
  branch?: string;
  models?: ModelMap;
  disable?: string[];
  plugins?: string[];
}

export function loadTmlConfig(cwd: string, opts: LoadOptions = {}): Loaded {
  const env = opts.env ?? process.env;
  const globalDir = opts.configHome ?? defaultConfigHome(env);
  const projectRoot = opts.projectRoot ?? findProjectRoot(cwd);

  const globalFile = join(globalDir, FILENAME);
  const projectFile = join(projectRoot, FILENAME);
  const global = readConfig(globalFile);
  const project = readConfig(projectFile);

  const pluginPaths = [
    ...resolvePlugins(global?.plugins, globalDir, globalFile),
    ...resolvePlugins(project?.plugins, projectRoot, projectFile),
  ];

  return { selection: mergeSelection(global, project), pluginPaths };
}

function defaultConfigHome(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME;
  return xdg !== undefined && xdg.length > 0 ? join(xdg, "tml") : join(homedir(), ".config", "tml");
}

/** Walk up from cwd to the nearest dir containing `.git`; fall back to cwd when not in a repo. */
export function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}

function readConfig(path: string): RawConfig | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`tml: cannot read ${path}: ${errorMessage(error)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`tml: ${path} is not valid JSON: ${errorMessage(error)}`);
  }
  return validate(data, path);
}

function validate(data: unknown, path: string): RawConfig {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`tml: ${path} must be a JSON object.`);
  }
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(
        `tml: unknown key "${key}" in ${path} (allowed: ${[...ALLOWED_KEYS].join(", ")}).`,
      );
    }
  }
  assertString(obj, "$schema", path);
  assertString(obj, "harness", path);
  assertString(obj, "gitProvider", path);
  assertString(obj, "branch", path);
  assertModels(obj, path);
  assertStringArray(obj, "disable", path);
  assertStringArray(obj, "plugins", path);
  return obj as RawConfig;
}

function assertString(obj: Record<string, unknown>, key: string, path: string): void {
  if (obj[key] !== undefined && typeof obj[key] !== "string") {
    throw new Error(`tml: "${key}" in ${path} must be a string.`);
  }
}

function assertStringArray(obj: Record<string, unknown>, key: string, path: string): void {
  const value = obj[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`tml: "${key}" in ${path} must be an array of strings.`);
  }
}

function assertModels(obj: Record<string, unknown>, path: string): void {
  const value = obj.models;
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`tml: "models" in ${path} must be an object of step-name → model id.`);
  }
  const badKey = Object.entries(value).find(([, model]) => typeof model !== "string")?.[0];
  if (badKey !== undefined) {
    throw new Error(`tml: "models.${badKey}" in ${path} must be a string model id.`);
  }
}

/** Resolve each local plugin path against its config file's dir; a non-path entry is an error. */
function resolvePlugins(plugins: string[] | undefined, baseDir: string, file: string): string[] {
  if (plugins === undefined) return [];
  return plugins.map((entry) => {
    if (isAbsolute(entry) || entry.startsWith("./") || entry.startsWith("../")) {
      return resolve(baseDir, entry);
    }
    throw new Error(
      `tml: plugin "${entry}" in ${file} is not a local path. ` +
        `Remote/published plugins are not supported yet — use a relative ("./…") or absolute path.`,
    );
  });
}

function mergeSelection(global: RawConfig | undefined, project: RawConfig | undefined): Selection {
  const harness = project?.harness ?? global?.harness;
  const gitProvider = project?.gitProvider ?? global?.gitProvider;
  const branch = project?.branch ?? global?.branch;
  const models = mergeModels(global?.models, project?.models);
  const disable = union(global?.disable, project?.disable);
  return {
    ...(harness !== undefined ? { harness } : {}),
    ...(gitProvider !== undefined ? { gitProvider } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(models !== undefined ? { models } : {}),
    ...(disable !== undefined ? { disable } : {}),
  };
}

/** Shallow-merge the flat model map: project keys override global keys. */
function mergeModels(global?: ModelMap, project?: ModelMap): ModelMap | undefined {
  if (global === undefined) return project;
  if (project === undefined) return global;
  return { ...global, ...project };
}

/** Union two `disable` lists (global ++ project), de-duplicated, order-preserving. */
function union(global?: string[], project?: string[]): string[] | undefined {
  if (global === undefined && project === undefined) return undefined;
  return [...new Set([...(global ?? []), ...(project ?? [])])];
}
