// The startup gate's decision and its option set. When a bare `tml` finds a Run for the current
// branch, the gate offers a choice instead of silently starting fresh. The option set depends on
// whether that Run is safely resumable: a live or unknown Run can be attached to but not re-entered
// for writing, so resume is offered only when the Run is orphaned or parked.

export type GateDecision = "resume" | "attach" | "fresh" | "list" | "quit";

export interface GateOption {
  readonly key: string;
  readonly decision: GateDecision;
  readonly label: string;
}

/**
 * The actions to offer for the candidate Run. A live or unknown Run offers attach, not resume; a
 * parked or orphaned Run offers resume. Both always offer a fresh run and the full list.
 */
export function gateOptions(live: boolean): GateOption[] {
  const primary: GateOption = live
    ? { key: "a", decision: "attach", label: "attach" }
    : { key: "r", decision: "resume", label: "resume" };
  return [
    primary,
    { key: "f", decision: "fresh", label: "start fresh" },
    { key: "l", decision: "list", label: "list all runs" },
  ];
}
