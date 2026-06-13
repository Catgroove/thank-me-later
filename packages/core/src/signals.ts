// Flow signals — values a Step *returns* to redirect Pipeline control
// (CONTEXT: "Flow signal"). Distinct from Ask, which is an *awaited* escalation
// effect, not a returned signal.
//
// A returned FlowSignal and a produced-artifacts record are both plain objects,
// so each signal carries a module-private brand the engine checks to tell them
// apart — an artifact innocently named "kind" can never be mistaken for one.

const BRAND: unique symbol = Symbol("tml.flowSignal");

export type FlowSignal =
  | { kind: "skip" }
  | { kind: "cancel"; reason?: string }
  | { kind: "goto"; step: string }
  | { kind: "retry"; reason?: string };

function brand<S extends FlowSignal>(signal: S): S {
  return Object.defineProperty(signal, BRAND, { value: true, enumerable: false });
}

/** Skip this Step and continue to the next. */
export function skip(): FlowSignal {
  return brand({ kind: "skip" });
}

/** End the Run early, successfully. */
export function cancel(reason?: string): FlowSignal {
  return brand({ kind: "cancel", reason });
}

/** Jump to the named Step. */
export function goto(step: string): FlowSignal {
  return brand({ kind: "goto", step });
}

/** Re-run the current Step (engine-capped). */
export function retry(reason?: string): FlowSignal {
  return brand({ kind: "retry", reason });
}

/** True iff `value` was produced by one of the signal constructors above. */
export function isFlowSignal(value: unknown): value is FlowSignal {
  return typeof value === "object" && value !== null && BRAND in value;
}
