// The agent task strings for the default pipeline. Checks are agent-driven: each prompt
// tells the agent *what* to achieve and lets it discover the toolchain via shell access —
// no tml-side detection, so the pipeline works in any language (ARCHITECTURE). Kept pure
// and snapshot-tested; the Steps are thin wrappers that pass these to `ctx.agent.run`.

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

export const reviewPrompt =
  "Review the changes on this branch against the repository's default branch (compute the " +
  "diff yourself with git). Look for correctness bugs, missed edge cases, and unintended " +
  "changes; apply safe fixes in place and summarise what you found and changed.";

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

/** The prompt for the PR title + body; the harness returns it as structured `{ title, body }`. */
export function prDescriptionPrompt(review: string): string {
  return (
    "Write a pull request title and body for the changes on this branch (compute the diff " +
    "yourself with git). The title must be a Conventional Commits subject (e.g. " +
    '"feat(scope): summary"). The body should explain what changed and why, in Markdown.\n\n' +
    `Reviewer notes from this run:\n${review}`
  );
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
