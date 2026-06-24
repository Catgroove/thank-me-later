// The single structured event stream the headless engine emits during a Run.
// The standalone TUI, CLI logs, and host Adapters are all consumers of this one
// stream; the engine itself renders nothing. Events are emitted live as they
// occur — including `agent:progress` mid-Step — not batched at
// Step boundaries. `run:finished` means success; `run:paused` means the host asked the
// engine to stop after a boundary Step; `run:failed` carries a failure; `run:cancelled` is an
// external Abort (distinct from the `cancel()` flow signal).
// The `type` is the discriminant, so there is no redundant `ok` flag.
//
// Every event carries `at`: the epoch-millisecond timestamp the engine stamped it
// with as it emitted. Renderers may keep their own ticking clock for a live elapsed
// display, but completed Step durations derive from these timestamps - never from a
// renderer-local guess. The engine is the single source of timing truth.

import type { ApprovalFindingsInput } from "./round-approval.ts";
import type { AgentProgress } from "./providers/harness.ts";
import type { Finding, RoundRecord } from "./round.ts";

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
  // A Step opened a named span of work within itself - e.g. one review pass. Purely observational:
  // it lets presenters show what a Step is doing mid-run without the Step decomposing into separate
  // Steps. `group` is an optional caller-supplied label (e.g. a round) so related phases nest.
  | {
      type: "phase:started";
      at: number;
      step: string;
      phaseId: string;
      phase: string;
      group?: string;
    }
  // The matching span closed. `status` is `error` if the span's work threw (then the Step's own
  // failure path takes over). `findings` are the phase's own findings, surfaced live as the phase
  // resolves - a preview ahead of the deduped, authoritative set carried by `round:recorded`.
  | {
      type: "phase:finished";
      at: number;
      step: string;
      phaseId: string;
      phase: string;
      group?: string;
      findings: Finding[];
      status: "ok" | "error";
    }
  // The Run's pull request is open on the Git provider — freshly opened, or rediscovered on a re-run.
  // Carries the URL so a consumer can surface a clickable link at the end of the Run.
  | { type: "pr:opened"; at: number; url: string }
  | { type: "step:skipped"; at: number; step: string }
  | { type: "step:finished"; at: number; step: string }
  | { type: "ask:pending"; at: number; step: string; prompt: string }
  | { type: "approval:pending"; at: number; step: string; input: ApprovalFindingsInput }
  | { type: "run:finished"; at: number }
  | { type: "run:paused"; at: number; step: string }
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
