// `ci-wait` - the last Step: poll the Git provider's checks for the opened PR until they settle,
// then run the same issue -> fix -> verification loop used by local checks. Failed CI checks become
// core findings, the fix pass gets failed logs when the Git provider can provide them, and each
// successful fix commit is pushed back to the PR branch before verification polls CI again.

import {
  TimeoutError,
  defineStep,
  executeRoundLoop,
  makeFinding,
  type CheckRun,
  type Finding,
  type Step,
} from "@tml/core";
import { pullRequest } from "../artifacts.ts";
import { ciFixPrompt } from "../prompts.ts";

/** CI poll cadence, in milliseconds: poll every 10s, give up after 30min. Tune as runs inform us. */
const EVERY_MS = 10_000;
const TIMEOUT_MS = 30 * 60_000;
const MAX_CI_AUTO_FIX_ATTEMPTS = 3;

function isGreen(check: CheckRun): boolean {
  return (
    check.status === "completed" &&
    (check.conclusion === "success" || check.conclusion === "neutral")
  );
}

function findingForCheck(check: CheckRun): Finding | null {
  if (isGreen(check)) return null;
  const status = check.conclusion ?? check.status;
  return makeFinding("ci", {
    severity: check.status === "completed" ? "error" : "warning",
    action:
      check.status === "completed" && check.conclusion === "failure" ? "auto-fix" : "ask-user",
    title: `${check.name} did not pass`,
    detail: `CI reported ${status}.`,
    location: check.name,
  });
}

function timeoutFinding(prNumber: number): Finding {
  return makeFinding("ci", {
    severity: "warning",
    action: "ask-user",
    title: "CI did not settle before the timeout",
    detail: `Checks for PR #${prNumber} were still pending when the CI wait timeout elapsed.`,
  });
}

function failedCheckNames(findings: readonly Finding[]): string[] {
  return findings
    .map((finding) => finding.location)
    .filter((name): name is string => name !== undefined && name.trim().length > 0);
}

export function ciWaitStep(): Step {
  return defineStep({
    name: "ci-wait",
    consumes: [pullRequest],
    resume: "reconcile",
    async run(ctx) {
      const pr = ctx.read(pullRequest);
      let latestChecks: CheckRun[] = [];

      const result = await executeRoundLoop(ctx, {
        maxAutoFixAttempts: MAX_CI_AUTO_FIX_ATTEMPTS,
        async check() {
          try {
            latestChecks = await ctx.until(ctx.gitProvider.getChecks(pr.number), {
              every: EVERY_MS,
              timeout: TIMEOUT_MS,
            });
          } catch (error) {
            if (error instanceof TimeoutError) {
              return { findings: [timeoutFinding(pr.number)] };
            }
            throw error;
          }
          for (const check of latestChecks) {
            ctx.log(`ci: ${check.name} -> ${check.conclusion ?? check.status}`);
          }
          return {
            findings: latestChecks.flatMap((check) => {
              const finding = findingForCheck(check);
              return finding ? [finding] : [];
            }),
          };
        },
        async fix(input) {
          const failedLogs =
            (await ctx.gitProvider.getFailedCheckLogs?.({
              prNumber: pr.number,
              checkNames: failedCheckNames(input.findings),
            })) ?? "";
          const agentResult = await ctx.agent.run(
            ciFixPrompt({
              findings: input.findings,
              checks: latestChecks,
              failedLogs,
              historyText: input.historyText,
            }),
          );
          return { summary: agentResult.summary };
        },
        commitMessage: "chore: apply fixes from CI",
        async commit({ ctx, message }) {
          const subject = message?.trim() ?? "";
          if (subject.length === 0)
            throw new Error("ci-wait: fix commit message must not be empty");
          await ctx.git.stageAll();
          const { staged } = await ctx.git.status();
          if (staged.length === 0) {
            ctx.log("ci-wait: fix produced no commit");
            return {};
          }
          const commit = await ctx.git.commit(subject);
          await ctx.git.push({ branch: pr.head });
          return { commitSha: commit.sha };
        },
      });

      return { artifacts: {}, rounds: result.rounds };
    },
  });
}
