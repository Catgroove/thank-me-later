// A throwaway pipeline that exercises the @tml/core engine end-to-end:
// snapshot → derive (artifact threading) → maybe-skip (a flow signal) → ci-wait
// (a Pending driven by ctx.until). The Forge/Harness here are in-memory stand-ins;
// the real Providers (@tml/github, @tml/pi) land in later specs.

import {
  type CheckRun,
  type Config,
  defineArtifact,
  defineConfig,
  defineStep,
  type Forge,
  type Harness,
  type Pending,
  skip,
} from "@tml/core";

const demoForge: Forge = {
  findPullRequest: () => Promise.resolve(null),
  openPullRequest: (input) =>
    Promise.resolve({
      number: 1,
      url: "https://forge.demo/pr/1",
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
      state: "open",
      mergeable: "mergeable",
      checks: [],
      threads: [],
    }),
  getPullRequest: () => Promise.reject(new Error("demo Forge stores no PRs")),
  getChecks: (): Pending<CheckRun[]> => ({
    poll: () =>
      Promise.resolve({
        done: true,
        value: [{ name: "ci", status: "completed", conclusion: "success" }],
      }),
  }),
};

const demoAgent: Harness = {
  run: (task) => ({
    poll: () => Promise.resolve({ done: true, value: { ok: true, summary: `ran: ${task}` } }),
  }),
};

const snapshot = defineArtifact<string>()("snapshot");
const derived = defineArtifact<number>()("derived");

export function demoConfig(): Config {
  const snap = defineStep({
    name: "snapshot",
    produces: [snapshot],
    run: () => Promise.resolve({ snapshot: "demo-state" }),
  });

  const derive = defineStep({
    name: "derive",
    consumes: [snapshot],
    produces: [derived],
    run(ctx) {
      const length = ctx.read(snapshot).length;
      ctx.log(`derived ${length} from snapshot`);
      return Promise.resolve({ derived: length });
    },
  });

  const maybeSkip = defineStep({
    name: "maybe-skip",
    run: () => Promise.resolve(skip()),
  });

  const ciWait = defineStep({
    name: "ci-wait",
    async run(ctx) {
      const checks = await ctx.until(ctx.forge.getChecks(1), { every: 1 });
      ctx.log(`ci: ${checks[0]?.conclusion}`);
      return {};
    },
  });

  return defineConfig({
    pipeline: [snap, derive, maybeSkip, ciWait],
    providers: { forge: demoForge, agent: demoAgent },
  });
}
