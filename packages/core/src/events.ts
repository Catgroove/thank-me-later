// The single structured event stream the headless engine emits during a Run
// (ADR-0002). The standalone TUI, CLI logs, and host Adapters are all consumers
// of this one stream; the engine itself renders nothing. Events are emitted live
// as they occur — including `agent:progress` mid-Step (ADR-0008) — not batched at
// Step boundaries. `run:finished` means success; `run:failed` carries a failure;
// `run:cancelled` is an external Abort (distinct from the `cancel()` flow signal).
// The `type` is the discriminant, so there is no redundant `ok` flag.

import type { AgentProgress } from "./providers/harness.ts";

export type RunEvent =
  | { type: "run:started"; pipeline: string[] }
  | { type: "step:started"; step: string }
  | { type: "step:log"; step: string; message: string }
  | { type: "agent:progress"; step: string; progress: AgentProgress }
  | { type: "artifact:written"; step: string; artifact: string }
  | { type: "step:skipped"; step: string }
  | { type: "step:finished"; step: string }
  | { type: "ask:pending"; step: string; prompt: string }
  | { type: "run:finished" }
  | { type: "run:cancelled"; step?: string }
  | { type: "run:failed"; step?: string; error: string };
