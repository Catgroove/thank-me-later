import { describe, expect, test } from "bun:test";
import { compareVersions, resolveLatestVersion, update } from "../src/update.ts";
import { VERSION } from "../src/version.ts";

/** A fetch stub that returns a 302 with the given Location, or throws when location is null. */
function redirectFetch(location: string | null): typeof fetch {
  return (async () => {
    if (location === null) throw new Error("network down");
    return new Response(null, { status: 302, headers: { location } });
  }) as unknown as typeof fetch;
}

const INSTALLED = "/home/u/.local/bin/tml"; // a compiled-install execPath

describe("compareVersions", () => {
  test("orders by major, minor, patch and ignores a leading v", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("v1.2.0", "1.1.9")).toBe(1);
    expect(compareVersions("0.2.1", "v0.2.1")).toBe(0);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });
});

describe("resolveLatestVersion", () => {
  test("parses the bare version from the releases/latest redirect", async () => {
    const v = await resolveLatestVersion(
      redirectFetch("https://github.com/Catgroove/thank-me-later/releases/tag/v0.9.3"),
    );
    expect(v).toBe("0.9.3");
  });

  test("returns null when the redirect has no /tag/ segment (no releases yet)", async () => {
    const v = await resolveLatestVersion(
      redirectFetch("https://github.com/Catgroove/thank-me-later/releases"),
    );
    expect(v).toBeNull();
  });

  test("returns null on a network error", async () => {
    expect(await resolveLatestVersion(redirectFetch(null))).toBeNull();
  });
});

describe("update", () => {
  test("reports up to date and does not spawn when current is latest", async () => {
    const lines: string[] = [];
    let spawned = false;
    const code = await update({
      execPath: INSTALLED,
      fetch: redirectFetch(`https://x/releases/tag/v${VERSION}`),
      spawn: async () => {
        spawned = true;
        return 0;
      },
      log: (l) => lines.push(l),
      error: () => {},
    });

    expect(code).toBe(0);
    expect(spawned).toBe(false);
    expect(lines.join("\n")).toContain("already up to date");
  });

  test("spawns the installer pinned to the latest tag and the install dir", async () => {
    let received: { tag: string; installDir: string } | undefined;
    const code = await update({
      execPath: INSTALLED,
      fetch: redirectFetch("https://x/releases/tag/v9.9.9"),
      spawn: async (input) => {
        received = input;
        return 0;
      },
      log: () => {},
      error: () => {},
    });

    expect(code).toBe(0);
    expect(received).toEqual({ tag: "v9.9.9", installDir: "/home/u/.local/bin" });
  });

  test("returns 1 and prints the manual command when the installer fails", async () => {
    const errors: string[] = [];
    const code = await update({
      execPath: INSTALLED,
      fetch: redirectFetch("https://x/releases/tag/v9.9.9"),
      spawn: async () => 1,
      log: () => {},
      error: (l) => errors.push(l),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain('TML_VERSION="v9.9.9"');
    expect(errors.join("\n")).toContain('TML_INSTALL_DIR="/home/u/.local/bin"');
  });

  test("--check reports the upgrade without spawning", async () => {
    const lines: string[] = [];
    let spawned = false;
    const code = await update({
      check: true,
      execPath: INSTALLED,
      fetch: redirectFetch("https://x/releases/tag/v9.9.9"),
      spawn: async () => {
        spawned = true;
        return 0;
      },
      log: (l) => lines.push(l),
      error: () => {},
    });

    expect(code).toBe(0);
    expect(spawned).toBe(false);
    expect(lines.join("\n")).toContain(`v${VERSION} -> v9.9.9`);
  });

  test("refuses to self-update when running under bun (not a compiled install)", async () => {
    const errors: string[] = [];
    const code = await update({
      execPath: "/usr/local/bin/bun",
      fetch: redirectFetch("https://x/releases/tag/v9.9.9"),
      spawn: async () => 0,
      log: () => {},
      error: (l) => errors.push(l),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("not a compiled install");
  });

  test("returns 1 when the latest release cannot be resolved", async () => {
    const errors: string[] = [];
    const code = await update({
      execPath: INSTALLED,
      fetch: redirectFetch(null),
      spawn: async () => 0,
      log: () => {},
      error: (l) => errors.push(l),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("could not determine the latest release");
  });
});
