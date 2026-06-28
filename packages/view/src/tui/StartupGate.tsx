/** @jsxImportSource @opentui/solid */
// The startup gate: shown when a bare `tml` finds a Run for the current branch. It presents the
// candidate Run and the choices (attach/resume, fresh, list), and resolves a `GateDecision`. It
// conducts nothing - the CLI maps the decision onto resume, the viewer, the picker, or a fresh run.

import { For, Show } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { RunMetadata } from "@tml/core";
import { type GateDecision, gateOptions } from "../gate.ts";
import { displayState, humanizeAge, runLabel, shortRunId, stateColor } from "../run-format.ts";
import { sanitize } from "./sanitize.ts";

export interface StartupGateProps {
  readonly run: RunMetadata;
  /** Whether the candidate Run is genuinely live (its owner process is running). */
  readonly live: boolean;
  readonly now: number;
  readonly onResolve: (decision: GateDecision) => void;
}

export function StartupGate(props: StartupGateProps) {
  const options = (): ReturnType<typeof gateOptions> => gateOptions(props.live);
  const state = (): string => displayState(props.run, props.now);

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    if ((key.ctrl && key.name === "c") || key.name === "escape") {
      props.onResolve("quit");
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      // Enter takes the primary action (attach for a live Run, resume otherwise).
      props.onResolve(options()[0]?.decision ?? "fresh");
      return;
    }
    const option = options().find((candidate) => candidate.key === key.name);
    if (option !== undefined) {
      props.onResolve(option.decision);
      return;
    }
    if (key.name === "q") props.onResolve("quit");
  });

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      paddingTop={1}
      paddingLeft={1}
      backgroundColor="#0b1120"
    >
      <text fg="#38bdf8" attributes={1}>
        tml
      </text>
      <text marginTop={1} fg="#cbd5e1">
        {props.live
          ? "A run for this branch is already in progress:"
          : "There's an unfinished run for this branch:"}
      </text>
      <box marginTop={1} flexDirection="row">
        <text fg={stateColor(state())} width={11}>
          {state()}
        </text>
        <text fg="#cbd5e1" marginLeft={1}>
          {sanitize(runLabel(props.run))}
        </text>
        <text fg="#7fb0e8" marginLeft={2}>
          {shortRunId(props.run.runId)}
        </text>
        <text fg="#64748b" marginLeft={2}>
          {humanizeAge(props.now - Date.parse(props.run.updatedAt))}
        </text>
        <Show when={props.run.owner !== undefined && props.live}>
          <text fg="#64748b" marginLeft={2}>
            {`pid ${props.run.owner?.pid}`}
          </text>
        </Show>
      </box>
      <Show when={props.run.prUrl !== undefined}>
        <text marginTop={1} fg="#22d3ee">
          {sanitize(props.run.prUrl ?? "")}
        </text>
      </Show>
      <box marginTop={1} flexDirection="column">
        <For each={options()}>
          {(option) => (
            <box flexDirection="row">
              <text fg="#38bdf8" width={4}>
                {option.key}
              </text>
              <text fg="#cbd5e1">{option.label}</text>
            </box>
          )}
        </For>
      </box>
      <text marginTop={1} fg="#475569">
        enter takes the first option · q quits
      </text>
    </box>
  );
}
