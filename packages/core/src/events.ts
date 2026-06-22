// The single structured event stream the headless engine emits during a Run.
// The standalone TUI, CLI logs, and host Adapters are all consumers of this one
// stream; the engine itself renders nothing. Events are emitted live as they
// occur — including `agent:progress` mid-Step — not batched at
// Step boundaries. `run:finished` means success; `run:failed` carries a failure;
// `run:cancelled` is an external Abort (distinct from the `cancel()` flow signal).
// The `type` is the discriminant, so there is no redundant `ok` flag.

import type { ApproveFindingsInput } from "./approval.ts";
import type { AgentProgress } from "./providers/harness.ts";

export type RunEvent =
  | { type: "run:started"; pipeline: string[] }
  | { type: "step:started"; step: string }
  | { type: "step:log"; step: string; message: string }
  | { type: "agent:progress"; step: string; progress: AgentProgress }
  // `artifact` is the declared name; `rendered` is its human string form when the produced
  // value is a string (absent for non-string artifacts). The engine relays it unjudged — the
  // presenter decides which artifacts to surface, and how to clip/label them.
  | { type: "artifact:written"; step: string; artifact: string; rendered?: string }
  // The Run's pull request is open on the Git provider — freshly opened, or rediscovered on a re-run.
  // Carries the URL so a consumer can surface a clickable link at the end of the Run.
  | { type: "pr:opened"; url: string }
  | { type: "step:skipped"; step: string }
  | { type: "step:finished"; step: string }
  | { type: "ask:pending"; step: string; prompt: string }
  | { type: "approval:pending"; step: string; input: ApproveFindingsInput }
  | { type: "run:finished" }
  | { type: "run:cancelled"; step?: string }
  | { type: "run:failed"; step?: string; error: string };
