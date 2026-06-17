// The agent task strings for the default pipeline. Checks are agent-driven: each prompt
// tells the agent *what* to achieve and lets it discover the toolchain via shell access —
// no tml-side detection, so the pipeline works in any language (ARCHITECTURE). Kept pure
// and snapshot-tested; the Steps are thin wrappers that pass these to `ctx.agent.run`.

import type { Finding } from "./review/synthesize.ts";

export const formatPrompt =
  "Format this repository using its own formatter (discover it from the project config). " +
  "Apply the changes in place. If there is no formatter configured, do nothing.";

export const lintPrompt =
  "Lint this repository using its own linter (discover it from the project config) and fix " +
  "every issue you can, applying the changes in place. If a problem needs a human judgement " +
  "call, leave it and report it. If there is no linter configured, do nothing.";

export const typecheckPrompt =
  "Type-check this repository using its own type checker (discover it from the project " +
  "config) and fix every type error you can, applying the changes in place. If there is no " +
  "type checker configured, do nothing.";

export const testPrompt =
  "Run this repository's test suite (discover the command from the project config). Fix the " +
  "failures you can and re-run until the suite passes or only failures needing human " +
  "judgement remain. If there are no tests, do nothing.";

// --- Review: five read-only passes that mimic a staff engineer, plus one fix pass. -----------
// Each review pass computes the diff itself, stays read-only, and returns findings against
// `findingsSchema`. The fix pass is the only one that edits files. `understanding` from the
// context pass is threaded into the later passes so every lens shares the same comprehension.

// Shared instructions for the read-only passes: scope, the read-only contract, and the
// finding model the structured output must follow.
const reviewGround =
  "Review the changes on this branch against the repository's default branch (compute the diff " +
  "yourself with git, including staged, unstaged, and untracked changes). This is a read-only " +
  "pass: do not modify any files, and do not run the test suite — a dedicated test step already " +
  "ran. Return findings as structured output; each finding has a severity (critical | warning | " +
  "nit), an action (auto-fix for a safe non-functional change; ask-user when it needs the " +
  "author's intent or alters behaviour; no-op when purely informational), a short title, an " +
  'evidence-based detail (quantify where you can), and an optional location "path:line". ' +
  "Report only real problems — a difference from your personal preference is not a finding.";

function priorContext(understanding: string): string {
  const note = understanding.trim();
  return note.length > 0 ? `\n\nWhat this change is for (from the context pass):\n${note}` : "";
}

/** Pass 0 — comprehension: restate the intent and judge whether the description is adequate. */
export function contextPrompt(prBody: string): string {
  const body = prBody.trim().length > 0 ? prBody.trim() : "(no description provided)";
  return (
    "You are a staff engineer starting a review. Before judging the code, understand why it " +
    "exists. " +
    reviewGround +
    "\n\nFirst, restate in your own words what this change does and why, and put that in the " +
    "`understanding` field. Then judge whether the intent is clear and the proposed description " +
    "adequate — raise a finding when the description is missing, vague, or contradicts the diff." +
    "\n\nProposed pull-request description:\n" +
    body
  );
}

/** Pass 1 — architecture, approach & scope: the "drop everything and reject" gate. */
export function architecturePrompt(understanding: string): string {
  return (
    "Phase: architecture, approach & scope — the 'drop everything and reject' pass. " +
    reviewGround +
    priorContext(understanding) +
    "\n\nDoes this change need to exist, and does it solve a real problem? Does the approach " +
    "align with the system's architecture (read CLAUDE.md and docs/ if useful)? Is unrelated " +
    "refactoring or feature creep bundled in? Is the change too large to review safely? If it is " +
    'fundamentally misguided, out of scope, or too big, set `verdict` to "block"; otherwise set ' +
    'it to "proceed".'
  );
}

/** Pass 2 — correctness & testing: tests first, then implementation and blast radius. */
export function correctnessPrompt(understanding: string): string {
  return (
    "Phase: correctness & testing. " +
    reviewGround +
    priorContext(understanding) +
    "\n\nReview the tests first: do they assert correct behaviour, or merely mirror the " +
    "implementation? Are edge cases and unhappy paths covered? Then the implementation: does it " +
    "do what it claims; what is the blast radius (inspect call sites, shared helpers, and the " +
    "invariants the changed code touches — not just the changed lines); are there regressions or " +
    "side effects elsewhere?"
  );
}

/** Pass 3 — design, extensibility & non-functional concerns. */
export function designPrompt(understanding: string): string {
  return (
    "Phase: design, extensibility & non-functional concerns. " +
    reviewGround +
    priorContext(understanding) +
    "\n\nDesign: could an existing pattern have served instead of new code; is something " +
    "hardcoded that should be configurable; is a new pattern introduced where an old one " +
    "suffices; are components too tightly coupled? Non-functional: performance (N+1 queries, " +
    "unbounded loops, hot-path allocation, sync work that should be async), security (input " +
    "validation, secret handling, injection, treating external data as untrusted), observability " +
    "(will we know if this fails in production?), and concurrency (races, shared-state safety)."
  );
}

/** Pass 4 — maintainability & micro-detail, including a guardrailed over-engineering sweep. */
export function microPrompt(understanding: string): string {
  return (
    "Phase: maintainability & micro-detail. " +
    reviewGround +
    priorContext(understanding) +
    "\n\nNaming (are things named for what they are?), readability (is anything needlessly " +
    "clever?), and comments (do they explain why, not what?). Also hunt over-engineering: flag " +
    "code that need not exist (YAGNI), dead or speculative code, and propose a delete-list — but " +
    "never propose removing trust-boundary validation, data-loss handling, security, or " +
    "accessibility. Most findings here are nits."
  );
}

/** The fix pass — the only one that edits files; applies the auto-fix findings in place. */
export function fixPrompt(findings: readonly Finding[]): string {
  const list = findings
    .map((f) => `- ${f.title}${f.location ? ` (${f.location})` : ""}: ${f.detail}`)
    .join("\n");
  return (
    "A review of this branch produced the findings below. Apply fixes for them in place. Always " +
    "start by double-checking that each finding is legitimate, and skip any that are not. Prefer " +
    "the smallest correct root-cause fix within the changed area over patching only the reported " +
    "line. Do not revert the author's intentional changes, and do not add code comments " +
    "explaining your fixes. Summarise what you changed in one short line.\n\nFindings:\n" +
    list
  );
}

/** JSON Schema for a review pass's structured reply; parsed back by `parsePassResult`. */
export const findingsSchema = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["critical", "warning", "nit"] },
          action: { type: "string", enum: ["auto-fix", "ask-user", "no-op"] },
          title: { type: "string" },
          detail: { type: "string" },
          location: { type: "string" },
        },
        required: ["severity", "action", "title", "detail"],
        additionalProperties: false,
      },
    },
    understanding: { type: "string" },
    verdict: { type: "string", enum: ["proceed", "block"] },
  },
  required: ["findings"],
  additionalProperties: false,
} as const;

/** The architecture pass's schema: the shared finding model plus a *required* `verdict`. Making
 *  the verdict mandatory here (it is optional on `findingsSchema`, which the other passes share)
 *  keeps the block gate from silently downgrading to non-blocking when the agent omits it. */
export const architectureSchema = {
  ...findingsSchema,
  required: ["findings", "verdict"],
} as const;

/**
 * The prompt handed to the agent when a rebase stops on conflicts. The rebase is in progress; the
 * agent resolves the markers, stages each file, and runs `git rebase --continue` to completion.
 */
export function rebaseConflictPrompt(onto: string, files: readonly string[]): string {
  return (
    `A git rebase onto ${onto} has stopped on merge conflicts. Resolve it to completion.\n\n` +
    `Conflicted files:\n${files.map((f) => `- ${f}`).join("\n")}\n\n` +
    "Resolve every conflict marker (<<<<<<< ======= >>>>>>>), preserving the intent of both this " +
    "branch's changes and the upstream changes. Stage each resolved file with `git add <file>`, " +
    "then run `git rebase --continue`. If further conflicts surface, resolve those too. Do not " +
    "touch files that have no conflicts, and do not abort the rebase."
  );
}

/** The prompt for the AI branch name; the harness returns it as structured `{ branch }`. */
export const branchNamePrompt =
  "Suggest a single git branch name for the work being shipped (compute the diff yourself " +
  "with git, including staged, unstaged, and untracked changes). Use a Conventional-Commits " +
  "type prefix (feat/, fix/, chore/, etc.) and kebab-case, e.g. feat/add-json-flag. Set the " +
  "branch field to only the branch name.";

/** JSON Schema for the branch name the harness parses back out of the reply. */
export const branchNameSchema = {
  type: "object",
  properties: {
    branch: { type: "string" },
  },
  required: ["branch"],
  additionalProperties: false,
} as const;

/**
 * The prompt for the PR title + body; the harness returns it as structured `{ title, body }`.
 * `describe` runs this before review (so there are no notes yet); `review` notes are folded into
 * the body later by `open-pr`. Reviewer notes are appended only when provided.
 */
export function prDescriptionPrompt(review?: string): string {
  const base =
    "Write a pull request title and body for the changes on this branch (compute the diff " +
    "yourself with git, including staged, unstaged, and untracked changes). The title must be a " +
    'Conventional Commits subject (e.g. "feat(scope): summary"). The body should explain what ' +
    "changed and why, in Markdown.";
  return review ? `${base}\n\nReviewer notes from this run:\n${review}` : base;
}

/** JSON Schema for the PR description the harness parses back out of the reply. */
export const prDescriptionSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
  },
  required: ["title", "body"],
  additionalProperties: false,
} as const;
