// Passive update notifier. After a run, when a newer release exists, the CLI prints a one-line
// nudge. The check never blocks the command and never adds latency on the hot path: it is fired
// non-blocking at startup and the result is cached to disk (1-day TTL); the notice is printed from
// that cache, so the common case does zero network I/O. tml's primary command (`ship`) is
// long-lived, so the background check completes during the run and is cached for the next one —
// which is why no detached child process is needed. Suppressed in CI, in pipes, and on opt-out.

import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compareVersions, type Fetch, resolveLatestVersion } from "./update.ts";
import { VERSION } from "./version.ts";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface CacheState {
  readonly lastCheckAt: number;
  readonly latestVersion: string | null;
}

function cachePath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".cache");
  return join(base, "tml", "update-check.json");
}

/** The notifier is silent in non-interactive contexts and when explicitly opted out. */
export function notifierSuppressed(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean | undefined = process.stderr.isTTY,
): boolean {
  if (!isTTY) return true;
  return Boolean(env.CI || env.NO_UPDATE_NOTIFIER || env.TML_NO_UPDATE_NOTIFIER);
}

function readCache(path: string): CacheState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheState;
    return typeof parsed.lastCheckAt === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export interface CheckDeps {
  fetch?: Fetch;
  now?: number;
  path?: string;
  suppressed?: boolean;
}

/**
 * If a check is due (no fresh cache) and the notifier is not suppressed, fire one in the background
 * and return the in-flight promise; otherwise return undefined. Production ignores the return (the
 * check runs concurrently with the command); tests await it. Never throws — a failed check just
 * leaves the cache stale for next time.
 */
export function maybeStartCheck(deps: CheckDeps = {}): Promise<void> | undefined {
  if (deps.suppressed ?? notifierSuppressed()) return undefined;
  const now = deps.now ?? Date.now();
  const path = deps.path ?? cachePath();
  const cache = readCache(path);
  if (cache !== null && now - cache.lastCheckAt < ONE_DAY_MS) return undefined;
  return runCheck({ fetch: deps.fetch ?? fetch, now, path });
}

async function runCheck(input: { fetch: Fetch; now: number; path: string }): Promise<void> {
  const latestVersion = await resolveLatestVersion(input.fetch);
  const state: CacheState = { lastCheckAt: input.now, latestVersion };
  try {
    await mkdir(dirname(input.path), { recursive: true });
    await writeFile(input.path, JSON.stringify(state), "utf8");
  } catch {
    // Best-effort cache; a write failure just means we re-check next run.
  }
}

export interface NoticeDeps {
  path?: string;
  suppressed?: boolean;
}

/** The cached notice, or null when suppressed, uncached, or already current. */
export function updateNotice(deps: NoticeDeps = {}): string | null {
  if (deps.suppressed ?? notifierSuppressed()) return null;
  const cache = readCache(deps.path ?? cachePath());
  if (cache === null || cache.latestVersion === null) return null;
  if (compareVersions(cache.latestVersion, VERSION) <= 0) return null;
  return `A new version of tml is available: v${VERSION} -> v${cache.latestVersion}\nRun \`tml update\` to update.`;
}
