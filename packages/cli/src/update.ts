// `tml update` — move the installed binary to the latest release. tml has a single distribution
// channel (the curl installer), so rather than re-implement the installer's os/arch mapping, atomic
// replace, and PATH handling, `update` re-runs `install.sh` itself with the target version pinned —
// one source of truth for "how tml installs." The latest version is resolved by reading the redirect
// of `…/releases/latest` (no `gh`, no API rate limit). Side effects (fetch, spawn, execPath, output)
// are injected so the whole flow is testable without touching the network or the filesystem.

import { basename, dirname } from "node:path";
import { errorMessage } from "./error.ts";
import { REPO, VERSION } from "./version.ts";

export type Fetch = typeof fetch;

const INSTALL_URL = `https://raw.githubusercontent.com/${REPO}/master/install.sh`;

/** Numeric `vX.Y.Z` compare (leading `v` ignored): -1 if a<b, 0 if equal, 1 if a>b. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

function parts(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(".")
    .map((n) => Number.parseInt(n, 10) || 0);
}

/**
 * Resolve the latest released version (bare `X.Y.Z`, no `v`) from GitHub's `releases/latest`
 * redirect: a no-follow request 302s to `…/releases/tag/vX.Y.Z`, and the tag is the last path
 * segment of the `Location` header. Returns `null` on a network error or when no release exists
 * (the redirect lands somewhere without a `/tag/` segment).
 */
export async function resolveLatestVersion(fetchImpl: Fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`https://github.com/${REPO}/releases/latest`, {
      redirect: "manual",
    });
    const location = res.headers.get("location");
    if (location === null) return null;
    const match = /\/tag\/([^/?#]+)/.exec(location);
    if (match === null) return null;
    return decodeURIComponent(match[1]).replace(/^v/, "");
  } catch {
    return null;
  }
}

export interface UpdateDeps {
  /** `--check`: report the comparison and exit without installing. */
  check?: boolean;
  fetch?: Fetch;
  /** The running binary's path; defaults to process.execPath. */
  execPath?: string;
  /** Run the installer for `tag`, installing into `installDir`; returns its exit code. */
  spawn?: (input: { tag: string; installDir: string }) => Promise<number>;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

export async function update(deps: UpdateDeps = {}): Promise<number> {
  const fetchImpl = deps.fetch ?? fetch;
  const execPath = deps.execPath ?? process.execPath;
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  // A compiled binary's execPath is the tml binary itself; under `bun run src/index.ts` it is the
  // bun binary. Refuse there rather than overwrite the user's bun with a tml binary.
  if (isDevExecPath(execPath)) {
    error(
      "tml update: not a compiled install (running under bun); install the binary to self-update.",
    );
    return 1;
  }

  const latest = await resolveLatestVersion(fetchImpl);
  if (latest === null) {
    error("tml update: could not determine the latest release.");
    return 1;
  }

  if (compareVersions(latest, VERSION) <= 0) {
    log(`tml is already up to date (v${VERSION}).`);
    return 0;
  }

  if (deps.check === true) {
    log(`A new version of tml is available: v${VERSION} -> v${latest}`);
    log("Run `tml update` to update.");
    return 0;
  }

  const installDir = dirname(execPath);
  const tag = `v${latest}`;
  log(`Updating tml: v${VERSION} -> ${tag}`);

  const spawn = deps.spawn ?? defaultSpawn;
  let code: number;
  try {
    code = await spawn({ tag, installDir });
  } catch (caught) {
    error(errorMessage(caught));
    code = 1;
  }
  if (code !== 0) {
    error("tml update: the installer failed. Run it yourself:");
    error(
      `  TML_INSTALL_DIR="${installDir}" TML_VERSION="${tag}" sh -c 'curl -fsSL ${INSTALL_URL} | sh'`,
    );
    return 1;
  }
  log(`Updated tml to ${tag}.`);
  return 0;
}

/** Re-run the canonical installer, pinned to `tag` and targeting the current install dir. */
async function defaultSpawn(input: { tag: string; installDir: string }): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", `curl -fsSL ${INSTALL_URL} | sh`], {
    env: { ...process.env, TML_VERSION: input.tag, TML_INSTALL_DIR: input.installDir },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc.exited;
}

function isDevExecPath(execPath: string): boolean {
  const base = basename(execPath).toLowerCase();
  return base === "bun" || base === "bun.exe" || base.startsWith("bun-");
}
