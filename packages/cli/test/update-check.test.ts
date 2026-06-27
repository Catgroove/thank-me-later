import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeStartCheck, notifierSuppressed, updateNotice } from "../src/update-check.ts";
import { VERSION } from "../src/version.ts";

const dirs: string[] = [];
function tempCache(): string {
  const dir = mkdtempSync(join(tmpdir(), "tml-update-check-"));
  dirs.push(dir);
  return join(dir, "update-check.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function redirectFetch(location: string): typeof fetch {
  return (async () =>
    new Response(null, { status: 302, headers: { location } })) as unknown as typeof fetch;
}

describe("notifierSuppressed", () => {
  test("suppressed in a non-TTY context", () => {
    expect(notifierSuppressed({}, false)).toBe(true);
  });
  test("suppressed by CI and the opt-out vars even on a TTY", () => {
    expect(notifierSuppressed({ CI: "1" }, true)).toBe(true);
    expect(notifierSuppressed({ NO_UPDATE_NOTIFIER: "1" }, true)).toBe(true);
    expect(notifierSuppressed({ TML_NO_UPDATE_NOTIFIER: "1" }, true)).toBe(true);
  });
  test("active on an interactive TTY with no opt-out", () => {
    expect(notifierSuppressed({}, true)).toBe(false);
  });
});

describe("maybeStartCheck", () => {
  test("does nothing when suppressed", () => {
    expect(maybeStartCheck({ suppressed: true, path: tempCache() })).toBeUndefined();
  });

  test("writes the resolved version to the cache when due", async () => {
    const path = tempCache();
    await maybeStartCheck({
      suppressed: false,
      now: 1_000,
      path,
      fetch: redirectFetch("https://x/releases/tag/v0.9.3"),
    });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      lastCheckAt: 1_000,
      latestVersion: "0.9.3",
    });
  });

  test("skips the check when the cache is younger than the TTL", () => {
    const path = tempCache();
    writeFileSync(path, JSON.stringify({ lastCheckAt: 1_000, latestVersion: "0.9.3" }), "utf8");
    const fresh = maybeStartCheck({
      suppressed: false,
      now: 1_000 + 60_000, // one minute later
      path,
      fetch: redirectFetch("https://x/releases/tag/v1.0.0"),
    });
    expect(fresh).toBeUndefined(); // not due, so no check fired
  });

  test("re-checks once the cache is older than the TTL", async () => {
    const path = tempCache();
    writeFileSync(path, JSON.stringify({ lastCheckAt: 1_000, latestVersion: "0.9.3" }), "utf8");
    const due = maybeStartCheck({
      suppressed: false,
      now: 1_000 + 25 * 60 * 60 * 1000, // 25h later
      path,
      fetch: redirectFetch("https://x/releases/tag/v1.0.0"),
    });
    expect(due).toBeDefined();
    await due;
    expect(JSON.parse(readFileSync(path, "utf8")).latestVersion).toBe("1.0.0");
  });
});

describe("updateNotice", () => {
  test("null when suppressed", () => {
    const path = tempCache();
    writeFileSync(path, JSON.stringify({ lastCheckAt: 1, latestVersion: "9.9.9" }), "utf8");
    expect(updateNotice({ suppressed: true, path })).toBeNull();
  });

  test("null when there is no cache", () => {
    expect(
      updateNotice({ suppressed: false, path: join(tmpdir(), "tml-absent-cache.json") }),
    ).toBeNull();
  });

  test("null when the cached version is not newer than the installed one", () => {
    const path = tempCache();
    writeFileSync(path, JSON.stringify({ lastCheckAt: 1, latestVersion: VERSION }), "utf8");
    expect(updateNotice({ suppressed: false, path })).toBeNull();
  });

  test("formats the two-line notice when a newer version is cached", () => {
    const path = tempCache();
    writeFileSync(path, JSON.stringify({ lastCheckAt: 1, latestVersion: "9.9.9" }), "utf8");
    const notice = updateNotice({ suppressed: false, path });
    expect(notice).toBe(
      `A new version of tml is available: v${VERSION} -> v9.9.9\nRun \`tml update\` to update.`,
    );
  });
});

// Sanity: the absent-cache test above must not have created a file.
test("absent cache path is not created by updateNotice", () => {
  expect(existsSync(join(tmpdir(), "tml-absent-cache.json"))).toBe(false);
});
