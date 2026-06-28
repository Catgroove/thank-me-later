// The startup gate's decision and its option set. When a bare `tml` finds a Run for the current
// branch, the gate offers a choice instead of silently starting fresh. The option set depends on
// whether that Run is genuinely live: a live Run can be attached to but not re-entered for writing
// (its owner holds it), so resume is offered only when the Run is not live.

export type GateDecision = "resume" | "attach" | "fresh" | "list" | "quit";

export interface GateOption {
  readonly key: string;
  readonly decision: GateDecision;
  readonly label: string;
}

/**
 * The actions to offer for the candidate Run. A live Run (someone is running it now) offers attach,
 * not resume; any other Run (parked, orphaned, or on another host) offers resume. Both always offer
 * a fresh run and the full list.
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
