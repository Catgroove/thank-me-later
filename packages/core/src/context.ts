// The Run context handed to every Step's `run`. Reads are typed to the Step's
// declared `consumes` (the `C` tuple), so a Step can only read artifacts it
// declared, and the engine has already guaranteed at assembly time that a
// producer exists. Providers are the three distinct, typed domain interfaces;
// `until` is the engine-owned temporal primitive; `ask` escalates a
// free-text decision; `approveFindings` escalates a structured finding gate.

import type { ApprovalDecision, ApproveFindingsInput } from "./approval.ts";
import type { Artifact } from "./artifact.ts";
import type { Pending } from "./pending.ts";
import type { GitProvider } from "./providers/git-provider.ts";
import type { Git } from "./providers/git.ts";
import type { Harness } from "./providers/harness.ts";
import type { Finding, RoundRecord } from "./round.ts";

/** Options for a `phase` span: a grouping label and a way to surface the span's findings live. */
export interface PhaseOptions<T> {
  /** A label grouping related phases (e.g. a round), so presenters can nest them. */
  readonly group?: string;
  /** Extract the phase's findings from its result, surfaced live when the phase resolves. */
  readonly findings?: (result: T) => readonly Finding[];
}

export interface Ctx<
  C extends readonly Artifact<unknown, string>[] = readonly Artifact<unknown, string>[],
> {
  /** Read a consumed artifact's value. Only tokens declared in `consumes` are accepted. */
  read<A extends C[number]>(artifact: A): A extends Artifact<infer T, string> ? T : never;

  readonly git: Git;
  readonly gitProvider: GitProvider;
  readonly agent: Harness;

  /** Aborts when the Run is cancelled; observed by `until` and the agent. */
  readonly signal: AbortSignal;

  /** Drive an eventually-consistent Provider result to resolution. */
  until<T>(
    pending: Pending<T>,
    opts?: { every?: number; timeout?: number; signal?: AbortSignal },
  ): Promise<T>;

  /** Escalate a decision to a human or agent; resolves to their free-text reply. */
  ask(prompt: string): Promise<string>;

  /** Escalate a finding-based gate; resolves to a structured approval decision. */
  approveFindings(input: ApproveFindingsInput): Promise<ApprovalDecision>;

  /** Completed rounds from earlier Steps in this Run, including journal-replayed rounds. */
  rounds(step?: string): readonly RoundRecord[];

  /** Emit a progress line into the Run's event stream. */
  log(message: string): void;

  /**
   * Run `fn` as a named, observable span within the Step. Brackets the work with `phase:started`
   * and `phase:finished` events so presenters can show what a Step is doing mid-run without it
   * decomposing into separate Steps. Returns whatever `fn` returns; rethrows if `fn` throws (after
   * emitting a `phase:finished` with `status: "error"`).
   */
  phase<T>(label: string, fn: () => Promise<T>, opts?: PhaseOptions<T>): Promise<T>;
}
