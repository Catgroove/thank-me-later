// Commits, as steps. tml ship runs in place and lands the work as a clean history so a
// reviewer can tell *your change* from *what tml changed on top of it*:
//
//   commit-change   — your work (subject = the `describe` title)
//   commit(<steps>) — the fixes a group of Steps made
//
// `commitStep` is the primitive: stage everything, and commit — or skip if the stage was empty, so
// a Step that changed nothing leaves no empty commit. `commitGroup` is sugar: it returns the wrapped
// Steps followed by a commit Step whose message names exactly those Steps, so the commit is never
// detached from what produced it. It expands into the flat pipeline (the engine still sees, renders,
// and validates every Step — no nesting); change the grouping by moving Steps in or out of the call.

import { type Artifact, defineStep, skip, type Step } from "@tml/core";

/** A commit message: a literal subject, or an artifact a producing Step wrote (e.g. the PR title). */
export type CommitMessage = string | Artifact<string, string>;

export function commitStep(name: string, message: CommitMessage): Step {
  const fromArtifact = typeof message !== "string";
  return defineStep({
    name,
    consumes: fromArtifact ? [message] : [],
    async run(ctx) {
      const subject = (fromArtifact ? ctx.read(message) : message).trim();
      if (subject.length === 0) throw new Error(`${name}: commit message must not be empty`);

      await ctx.git.stageAll();
      const { staged } = await ctx.git.status();
      if (staged.length === 0) {
        ctx.log("nothing to commit");
        return skip();
      }
      await ctx.git.commit(subject);
      return {};
    },
  });
}

/**
 * Wrap Steps so their combined changes land in one commit. Returns `[...steps, commitStep]` — pure
 * composition, spread into the pipeline — with a message and name derived from the wrapped Steps.
 */
export function commitGroup(...steps: Step[]): Step[] {
  const names = steps.map((s) => s.name);
  return [
    ...steps,
    commitStep(`commit(${names.join("+")})`, `chore: apply fixes from ${names.join(", ")}`),
  ];
}
