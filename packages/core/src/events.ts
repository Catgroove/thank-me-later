// The single structured event stream the headless engine emits during a Run.
// The standalone TUI, CLI logs, and host Adapters are all consumers of this one
// stream; the engine itself renders nothing. Events are emitted live as they
// occur — including `agent:progress` mid-Step — not batched at
// Step boundaries. `run:finished` means success; `run:failed` carries a failure;
// `run:cancelled` is an external Abort (distinct from the `cancel()` flow signal).
// The `type` is the discriminant, so there is no redundant `ok` flag.
//
// Every event carries `at`: the epoch-millisecond timestamp the engine stamped it
// with as it emitted. Renderers may keep their own ticking clock for a live elapsed
// display, but completed Step durations derive from these timestamps - never from a
// renderer-local guess. The engine is the single source of timing truth.

import type { ApproveFindingsInput } from "./approval.ts";
import type { AgentProgress } from "./providers/harness.ts";
import type { RoundRecord } from "./round.ts";

export type RunEvent =
  | { type: "run:started"; at: number; pipeline: string[] }
  | { type: "step:started"; at: number; step: string }
  | { type: "step:log"; at: number; step: string; message: string }
  | { type: "agent:progress"; at: number; step: string; progress: AgentProgress }
  // `artifact` is the declared name; `rendered` is its human string form when the produced
  // value is a string (absent for non-string artifacts). The engine relays it unjudged — the
  // presenter decides which artifacts to surface, and how to clip/label them.
  | { type: "artifact:written"; at: number; step: string; artifact: string; rendered?: string }
  // A Step recorded a completed Round. Factual, not UI-specific: it exposes the existing domain
  // model so presenters can render Findings and Round history without scraping PR Markdown or
  // waiting for an approval gate. The `round` is the fully normalized record (with `step`, `index`).
  | { type: "round:recorded"; at: number; step: string; round: RoundRecord }
  // The Run's pull request is open on the Git provider — freshly opened, or rediscovered on a re-run.
  // Carries the URL so a consumer can surface a clickable link at the end of the Run.
  | { type: "pr:opened"; at: number; url: string }
  | { type: "step:skipped"; at: number; step: string }
  | { type: "step:finished"; at: number; step: string }
  | { type: "ask:pending"; at: number; step: string; prompt: string }
  | { type: "approval:pending"; at: number; step: string; input: ApproveFindingsInput }
  | { type: "run:finished"; at: number }
  | { type: "run:cancelled"; at: number; step?: string }
  | { type: "run:failed"; at: number; step?: string; error: string };

/**
 * A `RunEvent` before the engine stamps it with `at`. The engine constructs events in this shape
 * and a single stamping path adds `at`, so timestamping can never be forgotten at a call site.
 * `Omit` is applied per union member (distributive) so each member keeps its own discriminated shape.
 */
export type RunEventInput = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, "at">
    : never
  : never;
