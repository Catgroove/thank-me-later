// Harness — the Provider that runs an AI coding agent. tml calls
// `agent.run(task)` and the agent does the work; the harness is Claude Code,
// opencode, codex, pi, etc., behind one interface. An agent *streams*, so `run`
// returns a `Promise<AgentResult>` that resolves when the turn ends — it is not a
// pollable `Pending` (the Harness streams, only the GitProvider polls). Each
// `run` call is one isolated agent task: it must not continue prior
// conversational state unless a future option explicitly asks for that. A Step
// runs on the Harness's own default model unless it pins a raw, harness-specific id.
//
// Progress is a polymorphic capability: a harness reports what the
// agent is doing through `onProgress`, normalized to `AgentProgress`, and the
// engine turns that into the one event stream. A run is cancellable via `signal`.

/** Normalized, harness-agnostic agent activity surfaced as `agent:progress`. */
export type AgentProgress =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly phase: "start" | "end";
      // A short, single-line human label for the call (bash → the command, read → the path),
      // for the presentation layer — never structured data. Harnesses populate it.
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

/** Whether a Harness's underlying agent CLI is actually present on this machine. */
export interface HarnessDetection {
  /** True when the agent's executable is resolvable on this machine. */
  readonly installed: boolean;
  /** The resolved executable path when found. */
  readonly path?: string;
}

export interface Harness {
  /**
   * Execute one isolated agent task.
   *
   * Implementations must not continue or reuse previous conversational state.
   * If a backend has sessions by default, the Harness must disable them or create
   * a fresh task for every call. Session continuation requires a future explicit
   * option; it is not part of today's contract.
   */
  run(task: string, opts?: AgentRunOpts): Promise<AgentResult>;
  /** Optional capability: the engine validates pinned models when present. */
  listModels?(): Promise<string[]>;
  /**
   * Optional capability: report whether the backing agent CLI is installed on this
   * machine. `tml agents` surfaces this; a Harness that omits it is reported as unknown.
   */
  detect?(): Promise<HarnessDetection>;
}
