// Harness — the Provider that runs an AI coding agent (ADR-0005). tml calls
// `agent.run(task)` and the agent does the work; the harness is Claude Code,
// opencode, codex, pi, etc., behind one interface. An agent task is long-running,
// so `run` returns a Pending driven by `until`. A Step runs on the Harness's own
// default model unless it pins a raw, harness-specific id.
//
// Progress is a polymorphic capability (ADR-0008): a harness reports what the
// agent is doing through `onProgress`, normalized to `AgentProgress`, and the
// engine turns that into the one event stream. A run is cancellable via `signal`.

import type { Pending } from "../pending.ts";

/** Normalized, harness-agnostic agent activity surfaced as `agent:progress`. */
export type AgentProgress =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly phase: "start" | "end";
      readonly detail?: string;
    };

export interface AgentResult {
  readonly ok: boolean;
  readonly summary: string;
  /** Parsed structured output, present only when a `schema` was requested. */
  readonly output?: unknown;
}

export interface AgentRunOpts {
  /** Raw, harness-specific model id (e.g. "anthropic/sonnet:high"). */
  readonly model?: string;
  /** Request structured final output; the harness inlines it and parses the reply. */
  readonly schema?: object;
  /** Streaming progress hook; the engine wires this to the event stream. */
  readonly onProgress?: (progress: AgentProgress) => void;
  /** Abort the agent run (the engine passes `ctx.signal`). */
  readonly signal?: AbortSignal;
}

export interface Harness {
  run(task: string, opts?: AgentRunOpts): Pending<AgentResult>;
  /** Optional capability: the engine validates pinned models when present. */
  listModels?(): Promise<string[]>;
}
