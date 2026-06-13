// Harness — the Provider that runs an AI coding agent (ADR-0005). tml calls
// `agent.run(task)` and the agent does the work; the harness is Claude Code,
// opencode, codex, pi, etc., behind one interface. An agent task is long-running,
// so `run` returns a Pending driven by `until`. A Step runs on the Harness's own
// default model unless it pins a raw, harness-specific id.

import type { Pending } from "../pending.ts";

export interface AgentResult {
  readonly ok: boolean;
  readonly summary: string;
}

export interface Harness {
  run(task: string, opts?: { model?: string }): Pending<AgentResult>;
  /** Optional capability: the engine validates pinned models when present. */
  listModels?(): Promise<string[]>;
}
