import { describe, expect, test } from "bun:test";
import {
  AssemblyError,
  createAssembly,
  type Forge,
  type ForgeFactory,
  type Harness,
  type HarnessFactory,
  type Step,
} from "../src/index.ts";

// Minimal Provider stand-ins — assembly only cares about *which* factory ran and with what cwd,
// never about Provider behavior, so a tagged object cast to the interface is enough.
const fakeForge = (tag: string): Forge => ({ tag }) as unknown as Forge;
const fakeHarness = (tag: string): Harness => ({ tag }) as unknown as Harness;
const tagOf = (provider: unknown): string => (provider as { tag: string }).tag;

const step = (name: string): Step => ({
  name,
  consumes: [],
  produces: [],
  run: () => Promise.resolve({}),
});

/** An assembly with the built-in providers seeded, as the host does before running plugins. */
function seeded(selection: Parameters<typeof createAssembly>[0], cwd = "/repo") {
  const a = createAssembly(selection, cwd);
  a.tml.registerForge("github", (c) => fakeForge(`github@${c}`));
  a.tml.registerHarness("pi", (c) => fakeHarness(`pi@${c}`));
  return a;
}

describe("createAssembly", () => {
  test("append + build resolves the default providers and preserves step order", () => {
    const a = seeded({});
    a.tml.pipeline.append(step("a"), step("b"), step("c"));
    const config = a.build();
    expect(config.pipeline.map((s) => s.name)).toEqual(["a", "b", "c"]);
    expect(tagOf(config.providers.forge)).toBe("github@/repo");
    expect(tagOf(config.providers.agent)).toBe("pi@/repo");
    expect(config.models).toBeUndefined();
  });

  test("insertBefore / insertAfter / replace / remove reshape the pipeline", () => {
    const a = seeded({});
    a.tml.pipeline.append(step("a"), step("b"), step("c"));
    a.tml.pipeline.insertAfter("a", step("a2"));
    a.tml.pipeline.insertBefore("c", step("b2"));
    a.tml.pipeline.replace("b", step("B"));
    a.tml.pipeline.remove("a");
    expect(a.build().pipeline.map((s) => s.name)).toEqual(["a2", "B", "b2", "c"]);
  });

  test("patching an unknown Step name throws AssemblyError naming the valid steps", () => {
    const a = seeded({});
    a.tml.pipeline.append(step("a"));
    expect(() => a.tml.pipeline.insertAfter("nope", step("x"))).toThrow(AssemblyError);
    expect(() => a.tml.pipeline.insertAfter("nope", step("x"))).toThrow(/"a"/);
  });

  test("disable removes a Step; an unknown disable name throws AssemblyError", () => {
    const a = seeded({ disable: ["b"] });
    a.tml.pipeline.append(step("a"), step("b"), step("c"));
    expect(a.build().pipeline.map((s) => s.name)).toEqual(["a", "c"]);

    const bad = seeded({ disable: ["ghost"] });
    bad.tml.pipeline.append(step("a"));
    expect(() => bad.build()).toThrow(AssemblyError);
  });

  test("an explicit provider name selects its factory; an unknown name throws", () => {
    const a = createAssembly({ forge: "gitlab", harness: "claude" }, "/repo");
    a.tml.registerForge("gitlab", () => fakeForge("gitlab"));
    a.tml.registerHarness("claude", () => fakeHarness("claude"));
    a.tml.pipeline.append(step("a"));
    expect(tagOf(a.build().providers.forge)).toBe("gitlab");
    expect(tagOf(a.build().providers.agent)).toBe("claude");

    const missing = seeded({ harness: "nope" });
    missing.tml.pipeline.append(step("a"));
    expect(() => missing.build()).toThrow(/harness "nope" is not registered/);
  });

  test("models flow into the Config; branch flows into tml.config for plugins to read", () => {
    const a = seeded({ models: { default: "haiku", review: "opus" }, branch: "require" });
    expect(a.tml.config.branch).toBe("require");
    a.tml.pipeline.append(step("review"));
    expect(a.build().models).toEqual({ default: "haiku", review: "opus" });
  });

  test("factories receive the assembly cwd", () => {
    const seen: string[] = [];
    const forge: ForgeFactory = (c) => {
      seen.push(`forge:${c}`);
      return fakeForge(c);
    };
    const harness: HarnessFactory = (c) => {
      seen.push(`harness:${c}`);
      return fakeHarness(c);
    };
    const a = createAssembly({}, "/work/dir");
    a.tml.registerForge("github", forge);
    a.tml.registerHarness("pi", harness);
    a.tml.pipeline.append(step("a"));
    a.build();
    expect(seen).toEqual(["forge:/work/dir", "harness:/work/dir"]);
  });

  test("build() is idempotent — disable does not mutate the shared pipeline", () => {
    const a = seeded({ disable: ["b"] });
    a.tml.pipeline.append(step("a"), step("b"));
    expect(a.build().pipeline.map((s) => s.name)).toEqual(["a"]);
    expect(a.build().pipeline.map((s) => s.name)).toEqual(["a"]);
  });

  test("a model configured for a disabled Step is dropped with the Step", () => {
    const a = seeded({ disable: ["b"], models: { default: "haiku", b: "opus" } });
    a.tml.pipeline.append(step("a"), step("b"));
    expect(a.build().models).toEqual({ default: "haiku" });
  });
});
