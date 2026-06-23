// `review` - a pre-push review of the branch's diff that mimics how a staff engineer reads a
// change: focused read-only passes over one injected diff (context -> architecture -> correctness
// + NFR -> structural maintainability), then a core round loop applies safe fixes and verifies
// them with fresh passes. Read-only is the passes' contract; the prompts ask for it and a
// before/after worktree check reverts any edits a pass makes anyway, so only the fix callback can
// change files. Synthesis and the overall
// risk are computed in code (see `../review/synthesize.ts`), not by the agent. The architecture
// pass can `block`, which is recorded as a high-risk banner and routed through the approval gate.
// The resulting markdown becomes the `reviewSummary` artifact `open-pr` folds into the PR body.

import {
  defineStep,
  executeRoundLoop,
  type Ctx,
  makeFinding,
  renderRoundsForPr,
  type Finding,
  type Harness,
  type RoundCheckInput,
  type RoundRecord,
  type Step,
} from "@tml/core";
import { prBody, reviewSummary } from "../artifacts.ts";
import { revertIfWorktreeChanged } from "../git-guard.ts";
import {
  architecturePrompt,
  architectureSchema,
  contextPrompt,
  correctnessPrompt,
  findingsSchema,
  fixPrompt,
  structuralPrompt,
} from "../prompts.ts";
import {
  dedupeReviewPasses,
  type PassResult,
  type ReviewPass,
  parsePassResult,
  summarize,
} from "../review/synthesize.ts";

const REVIEW_PASS_TITLES = {
  context: "Context & intent",
  architecture: "Architecture & scope",
  correctness: "Correctness, tests & non-functional",
  structural: "Structural maintainability",
} as const;

const BLOCK_FALLBACK_FINDING = makeFinding("review", {
  severity: "error",
  action: "ask-user",
  title: "Blocking architecture verdict",
  detail:
    "The architecture pass returned a block verdict without a specific finding, meaning the " +
    "change was judged fundamentally risky, out of scope, or too large to review safely. " +
    "Approve explicitly before proceeding.",
  blocking: true,
});

/** Run one read-only review pass: structured reply against the given schema, validated. */
async function runPass(
  agent: Harness,
  prompt: string,
  schema: object = findingsSchema,
): Promise<PassResult> {
  const result = await agent.run(prompt, { schema });
  return parsePassResult(result.output);
}

const READ_ONLY_EDIT_WARNING =
  "warning: a read-only review pass modified the worktree; reverting before continuing";

async function runGuardedPass(
  ctx: Ctx,
  prompt: string,
  schema: object = findingsSchema,
): Promise<PassResult> {
  const before = await ctx.git.status();
  try {
    return await runPass(ctx.agent, prompt, schema);
  } finally {
    await revertIfWorktreeChanged(ctx.git, before, (m) => ctx.log(m), READ_ONLY_EDIT_WARNING);
  }
}

function withRoundHistory(prompt: string, input: RoundCheckInput): string {
  if (input.trigger === "initial") return prompt;
  const history = input.historyText.trim();
  if (history.length === 0 || history === "No prior rounds.") return prompt;
  return (
    prompt +
    "\n\nPrior review round history from this run. Use it explicitly: verify that previous " +
    "auto-fix findings were actually fixed, do not re-report resolved findings, and explain any " +
    "remaining or newly introduced findings against the current diff.\n" +
    history
  );
}

/** A human label grouping a round's passes, so the presenter can show the current round only. */
function passGroup(input: RoundCheckInput): string {
  return input.trigger === "initial" ? "initial" : `verify · attempt ${input.attempt}`;
}

/** A pass's own findings, surfaced live as the phase resolves (before the deduped round set). */
const passFindings = (result: PassResult): readonly Finding[] => result.findings;

const MAX_TEST_CONTEXT_CHARS = 12_000;

function truncateTestContext(text: string): string {
  return text.length > MAX_TEST_CONTEXT_CHARS
    ? `${text.slice(0, MAX_TEST_CONTEXT_CHARS)}\n\n[truncated after ${MAX_TEST_CONTEXT_CHARS} characters]`
    : text;
}

function formatTestRoundContext(rounds: readonly RoundRecord[]): string {
  if (rounds.length === 0) return "No test step rounds were recorded.";
  const latest = rounds.reduce((a, b) => (b.index > a.index ? b : a));
  const status = latest.findings.length === 0 ? "passed" : "has unresolved findings";
  const lines = [`Latest test step status: ${status}.`, "", renderRoundsForPr(rounds)];
  return truncateTestContext(lines.join("\n").trim());
}

function hasBlockVerdict(passes: readonly ReviewPass[]): boolean {
  return passes.some((pass) => pass.result.verdict === "block");
}

function markBlockingFinding(finding: Finding): Finding {
  const severity = finding.severity === "info" ? "warning" : finding.severity;
  return makeFinding("review", {
    severity,
    action: "ask-user",
    title: finding.title,
    detail: finding.detail,
    ...(finding.location ? { location: finding.location } : {}),
    blocking: true,
  });
}

function markBlockRequiresUser(result: PassResult): PassResult {
  if (result.verdict !== "block") return result;
  if (result.findings.length === 0) return result;
  return { ...result, findings: result.findings.map(markBlockingFinding) };
}

function ensureBlockHasFinding(passes: readonly ReviewPass[]): ReviewPass[] {
  if (!hasBlockVerdict(passes)) return [...passes];
  return passes.map((pass) => {
    if (pass.result.verdict !== "block" || pass.result.findings.length > 0) return pass;
    return {
      ...pass,
      result: { ...pass.result, findings: [BLOCK_FALLBACK_FINDING] },
    };
  });
}

function reviewFindings(passes: readonly ReviewPass[]): Finding[] {
  return passes.flatMap((pass) => pass.result.findings);
}

async function runPostContextPasses(
  ctx: Ctx,
  input: RoundCheckInput,
  understanding: string,
  diff: string,
  testResults: string,
): Promise<readonly [PassResult, PassResult, PassResult]> {
  const prompts = {
    architecture: withRoundHistory(architecturePrompt(understanding, diff), input),
    correctness: withRoundHistory(correctnessPrompt(understanding, diff, testResults), input),
    structural: withRoundHistory(structuralPrompt(understanding, diff), input),
  };
  const group = passGroup(input);
  const phase = (label: string, run: () => Promise<PassResult>) =>
    ctx.phase(label, run, { group, findings: passFindings });
  const before = await ctx.git.status();
  const settled = await Promise.allSettled([
    phase(REVIEW_PASS_TITLES.architecture, async () =>
      markBlockRequiresUser(await runPass(ctx.agent, prompts.architecture, architectureSchema)),
    ),
    phase(REVIEW_PASS_TITLES.correctness, () => runPass(ctx.agent, prompts.correctness)),
    phase(REVIEW_PASS_TITLES.structural, () => runPass(ctx.agent, prompts.structural)),
  ]);
  const tainted = await revertIfWorktreeChanged(
    ctx.git,
    before,
    (m) => ctx.log(m),
    READ_ONLY_EDIT_WARNING,
  );
  const rejected = settled.find((result) => result.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
  const results = settled.map((result) => {
    if (result.status !== "fulfilled") throw new Error("unreachable rejected review pass");
    return result.value;
  }) as [PassResult, PassResult, PassResult];
  if (!tainted) return results;

  ctx.log("warning: rerunning read-only review passes serially after reverting rogue edits");
  return [
    await phase(REVIEW_PASS_TITLES.architecture, async () =>
      markBlockRequiresUser(await runGuardedPass(ctx, prompts.architecture, architectureSchema)),
    ),
    await phase(REVIEW_PASS_TITLES.correctness, () => runGuardedPass(ctx, prompts.correctness)),
    await phase(REVIEW_PASS_TITLES.structural, () => runGuardedPass(ctx, prompts.structural)),
  ];
}

async function runReviewPasses(
  ctx: Ctx<readonly [typeof prBody]>,
  input: RoundCheckInput,
): Promise<ReviewPass[]> {
  const body = ctx.read(prBody);
  const diff = await ctx.git.diffAgainst(await ctx.git.defaultBranch());
  const testResults = formatTestRoundContext(ctx.rounds("test"));
  const context = await ctx.phase(
    REVIEW_PASS_TITLES.context,
    () => runGuardedPass(ctx, withRoundHistory(contextPrompt(body, diff), input)),
    { group: passGroup(input), findings: passFindings },
  );
  const understanding = context.understanding ?? "";
  const [architecture, correctness, structural] = await runPostContextPasses(
    ctx,
    input,
    understanding,
    diff,
    testResults,
  );

  return ensureBlockHasFinding(
    dedupeReviewPasses([
      { title: REVIEW_PASS_TITLES.context, result: context },
      { title: REVIEW_PASS_TITLES.architecture, result: architecture },
      { title: REVIEW_PASS_TITLES.correctness, result: correctness },
      { title: REVIEW_PASS_TITLES.structural, result: structural },
    ]),
  );
}

function fixSummaries(rounds: readonly { readonly fixSummary?: string }[]): string {
  return rounds
    .map((round) => round.fixSummary?.trim() ?? "")
    .filter((summary) => summary.length > 0)
    .join("; ");
}

export function reviewStep(): Step {
  return defineStep({
    name: "review",
    consumes: [prBody],
    produces: [reviewSummary],
    async run(ctx) {
      let latestPasses: ReviewPass[] = [];

      const result = await executeRoundLoop(ctx, {
        stepName: "review",
        async check(input) {
          latestPasses = await runReviewPasses(ctx, input);
          return { findings: reviewFindings(latestPasses) };
        },
        stopPolicy() {
          return hasBlockVerdict(latestPasses) ? "needs_user" : undefined;
        },
        async fix(input) {
          return ctx.phase(
            "Apply fixes",
            async () => {
              const result = await ctx.agent.run(fixPrompt(input.findings, input.historyText));
              return { summary: result.summary };
            },
            { group: `fix · attempt ${input.attempt}` },
          );
        },
        commitMessage: "chore: apply fixes from review",
        recordRounds: "live",
      });

      return {
        artifacts: {
          reviewSummary: summarize(latestPasses, fixSummaries(result.rounds), {
            fixedFindingIds: [],
          }),
        },
        rounds: [],
      };
    },
  });
}
