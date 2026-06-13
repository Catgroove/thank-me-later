// The single structured event stream the headless engine emits during a Run
// (ADR-0002). The standalone TUI, CLI logs, and host Adapters are all consumers
// of this one stream; the engine itself renders nothing. `run:finished` means
// success; `run:failed` carries the failure — the `type` is the discriminant, so
// there is no redundant `ok` flag.

export type RunEvent =
  | { type: "run:started"; pipeline: string[] }
  | { type: "step:started"; step: string }
  | { type: "step:log"; step: string; message: string }
  | { type: "artifact:written"; step: string; artifact: string }
  | { type: "step:skipped"; step: string }
  | { type: "step:finished"; step: string }
  | { type: "ask:pending"; step: string; prompt: string }
  | { type: "run:finished" }
  | { type: "run:failed"; step?: string; error: string };
