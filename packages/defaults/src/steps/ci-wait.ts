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
  type Ctx,
  type Finding,
  type Pending,
  type Step,
} from "@tml/core";
import { pullRequest } from "../artifacts.ts";
import { ciFixPrompt } from "../prompts.ts";
import { fixCommitSubject } from "../semantic-commit.ts";
import type { FixLoopPolicy } from "./fix-loop.ts";

/** CI poll cadence, in milliseconds: poll every 10s, give up after 30min. Tune as runs inform us. */
const EVERY_MS = 10_000;
const TIMEOUT_MS = 30 * 60_000;
/**
 * How many consecutive empty rollups to tolerate before concluding the PR has no CI. Right after a
 * PR opens, GitHub reports an empty status-check rollup for the first few seconds - before the
 * workflow's check runs register against the head commit. Polling at {@link EVERY_MS}, this is the
 * grace window (~1 min) we give those checks to appear; only once it elapses still-empty do we
 * accept "no CI" and let the gate pass.
 */
const EMPTY_POLLS_BEFORE_NO_CI = 6;

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
    disposition: check.status === "completed" ? "blocker" : "should-fix",
    action:
      check.status === "completed" && check.conclusion === "failure" ? "auto-fix" : "ask-user",
    title: `${check.name} did not pass`,
    detail: `CI reported ${status}.`,
    location: check.name,
  });
}

function timeoutFinding(prNumber: number): Finding {
  return makeFinding("ci", {
    disposition: "should-fix",
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

function ciTestingSummary(checks: readonly CheckRun[]): string {
  if (checks.length === 0) return "No CI checks were reported.";
  const green = checks.filter(isGreen).length;
  const failed = checks.filter((check) => check.status === "completed" && !isGreen(check)).length;
  const pending = checks.length - green - failed;
  return `${green} green, ${failed} failed, ${pending} pending CI checks.`;
}

/**
 * Wait for the status-check rollup to settle, guarding against the empty-rollup race: GitHub
 * reports no checks for the first seconds after a push, and the raw provider poller treats that
 * empty set as "settled, all green" - a false pass that resolves the gate in a fraction of a
 * second. So while the rollup is empty we keep polling. When `requireChecks` is set (a fix commit
 * just landed, so the checks we saw must re-run) we never accept an empty rollup and lean on the
 * outer timeout. Otherwise - the initial wait, where the repo may genuinely have no CI - we accept
 * empty only after it persists across {@link EMPTY_POLLS_BEFORE_NO_CI} polls.
 */
function waitForChecks(ctx: Ctx, prNumber: number, requireChecks: boolean): Pending<CheckRun[]> {
  const pending = ctx.gitProvider.getChecks(prNumber);
  let emptyPolls = 0;
  return {
    async poll() {
      const result = await pending.poll();
      if (!result.done || result.value.length > 0) return result;
      emptyPolls += 1;
      if (requireChecks) return { done: false };
      return emptyPolls >= EMPTY_POLLS_BEFORE_NO_CI ? result : { done: false };
    },
  };
}

async function failedLogsForFindings(
  ctx: Ctx,
  prNumber: number,
  findings: readonly Finding[],
): Promise<string> {
  try {
    return (
      (await ctx.gitProvider.getFailedCheckLogs?.({
        prNumber,
        checkNames: failedCheckNames(findings),
      })) ?? ""
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log(`ci-wait: failed to retrieve failed check logs: ${message}`);
    return "";
  }
}

export function ciWaitStep(policy: FixLoopPolicy = {}): Step {
  return defineStep({
    name: "ci-wait",
    display: { group: "pr-gate", label: "ci" },
    consumes: [pullRequest],
    resume: "reconcile",
    async run(ctx) {
      const pr = ctx.read(pullRequest);
      let latestChecks: CheckRun[] = [];
      let pushedFixCommit = false;

      const result = await executeRoundLoop(ctx, {
        stepName: "ci-wait",
        maxAutoFixAttempts: policy.maxAutoFixAttempts,
        async check(input) {
          try {
            const requireChecks = input.trigger === "verify" && pushedFixCommit;
            const pendingChecks = waitForChecks(ctx, pr.number, requireChecks);
            latestChecks = await ctx.until(pendingChecks, {
              every: EVERY_MS,
              timeout: TIMEOUT_MS,
            });
          } catch (error) {
            if (error instanceof TimeoutError) {
              return { findings: [timeoutFinding(pr.number)] };
            }
            throw error;
          }
          if (latestChecks.length > 0) pushedFixCommit = false;
          for (const check of latestChecks) {
            ctx.log(`ci: ${check.name} -> ${check.conclusion ?? check.status}`);
          }
          return {
            findings: latestChecks.flatMap((check) => {
              const finding = findingForCheck(check);
              return finding ? [finding] : [];
            }),
            testing: {
              summary: ciTestingSummary(latestChecks),
              tested: latestChecks.length > 0,
              artifacts: latestChecks.map(
                (check) => `${check.name}: ${check.conclusion ?? check.status}`,
              ),
            },
          };
        },
        async fix(input) {
          const failedLogs = await failedLogsForFindings(ctx, pr.number, input.findings);
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
        commitMessage: (_input, result) => fixCommitSubject("ci", result.summary),
        async commit({ ctx, message }) {
          const subject = message?.trim() ?? "";
          if (subject.length === 0)
            throw new Error("ci-wait: fix commit message must not be empty");
          await ctx.git.stageAll();
          const { staged } = await ctx.git.status();
          if (staged.length === 0) {
            ctx.log("ci-wait: fix produced no commit");
            return { progress: "no_progress" };
          }
          const commit = await ctx.git.commit(subject);
          await ctx.git.push({ branch: pr.head });
          pushedFixCommit = true;
          return { progress: "progressed", commitSha: commit.sha };
        },
      });

      return { artifacts: {}, rounds: result.rounds };
    },
  });
}
