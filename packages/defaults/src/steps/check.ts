// The agent-driven check Steps. Each check is a core round loop: a fresh read-only check pass
// produces structured Findings, a fresh fix pass handles selected auto-fix Findings, and a fresh
// verification pass confirms the result. Toolchain discovery stays inside the prompts - tml never
// hardcodes repo-specific commands.

import {
  defineStep,
  executeRoundLoop,
  makeFinding,
  type Finding,
  type Git,
  type GitStatus,
  type Step,
} from "@tml/core";
import {
  checkFindingsSchema,
  checkFixPrompt,
  checkPrompt,
  formatPrompt,
  lintPrompt,
  testPrompt,
  typecheckPrompt,
} from "../prompts.ts";

const SEVERITIES: ReadonlySet<string> = new Set(["error", "warning", "info"]);
const ACTIONS: ReadonlySet<string> = new Set(["auto-fix", "ask-user", "no-op"]);

export function checkStep(name: string, goal: string): Step {
  return defineStep({
    name,
    async run(ctx) {
      const result = await executeRoundLoop(ctx, {
        async check(input) {
          const before = await ctx.git.status();
          const agentResult = await ctx.agent.run(checkPrompt({ name, goal, ...input }), {
            schema: checkFindingsSchema,
          });
          await revertRogueEdits(ctx.git, before, (m) => ctx.log(m));
          return {
            findings: parseCheckResult(
              name,
              agentResult.output,
              agentResult.summary,
              agentResult.ok,
            ),
          };
        },
        async fix(input) {
          const agentResult = await ctx.agent.run(
            checkFixPrompt({
              name,
              goal,
              findings: input.findings,
              historyText: input.historyText,
            }),
          );
          return { summary: agentResult.summary };
        },
        commitMessage: `chore: apply fixes from ${name}`,
      });

      return { artifacts: {}, rounds: result.rounds };
    },
  });
}

function parseCheckResult(name: string, output: unknown, summary: string, ok: boolean): Finding[] {
  if (output === undefined) {
    return ok
      ? []
      : [
          makeFinding(name, {
            severity: "error",
            action: "ask-user",
            title: `${name} check did not return structured findings`,
            detail: summary,
          }),
        ];
  }
  if (typeof output !== "object" || output === null) {
    throw new Error(`${name}: the agent did not return a structured check result`);
  }
  const obj = output as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) {
    throw new Error(`${name}: the check result is missing a findings array`);
  }
  return obj.findings.map((raw, i) => parseFinding(name, raw, i));
}

function parseFinding(namespace: string, raw: unknown, index: number): Finding {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${namespace}: finding ${index} is not an object`);
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) {
    throw new Error(`${namespace}: finding ${index} has an invalid severity`);
  }
  if (typeof f.action !== "string" || !ACTIONS.has(f.action)) {
    throw new Error(`${namespace}: finding ${index} has an invalid action`);
  }
  if (typeof f.title !== "string" || f.title.trim().length === 0) {
    throw new Error(`${namespace}: finding ${index} is missing a title`);
  }
  if (typeof f.detail !== "string") {
    throw new Error(`${namespace}: finding ${index} is missing a detail`);
  }
  return makeFinding(namespace, {
    severity: f.severity as Finding["severity"],
    action: f.action as Finding["action"],
    title: f.title.trim(),
    detail: f.detail.trim(),
    ...(typeof f.location === "string" && f.location.trim().length > 0
      ? { location: f.location.trim() }
      : {}),
  });
}

/** The set of files git reports as changed (staged or unstaged), for before/after comparison. */
function touched(status: GitStatus): string {
  return [...status.staged, ...status.unstaged].sort().join("\n");
}

async function revertRogueEdits(
  git: Git,
  before: GitStatus,
  log: (message: string) => void,
): Promise<void> {
  if (touched(await git.status()) === touched(before)) return;
  log("warning: a check round modified the worktree; reverting before continuing");
  await git.discardChanges();
}

export const formatStep = (): Step => checkStep("format", formatPrompt);
export const lintStep = (): Step => checkStep("lint", lintPrompt);
export const typecheckStep = (): Step => checkStep("typecheck", typecheckPrompt);
export const testStep = (): Step => checkStep("test", testPrompt);
