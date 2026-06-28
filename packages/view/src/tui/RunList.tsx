/** @jsxImportSource @opentui/solid */
// The Run picker screen: a selectable list of the checkout's recent Runs. It owns the keyboard and
// resolves a `PickerOutcome` (the CLI maps that onto resume or the read-only viewer). It is generic
// over Runs - no Pipeline or Step-name assumptions - and folds selection through the pure `pickerOnKey`.

import { For, Show, createSignal } from "solid-js";
import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { RunMetadata } from "@tml/core";
import { defaultAction, initialPicker, pickerOnKey, type PickerOutcome } from "../picker.ts";
import { displayState, humanizeAge, runLabel, shortRunId, stateColor } from "../run-format.ts";
import { sanitize } from "./sanitize.ts";

export interface RunListProps {
  readonly runs: readonly RunMetadata[];
  readonly now: number;
  readonly onResolve: (outcome: PickerOutcome) => void;
}

export function RunList(props: RunListProps) {
  const [picker, setPicker] = createSignal(initialPicker);
  const selected = (): RunMetadata | undefined => props.runs[picker().index];

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;
    const run = selected();
    switch (key.name) {
      case "q":
      case "escape":
        props.onResolve({ kind: "quit" });
        return;
      case "return":
      case "enter":
        if (run !== undefined) {
          props.onResolve({ kind: "select", run, action: defaultAction(run, props.now) });
        }
        return;
      case "v":
        if (run !== undefined) props.onResolve({ kind: "select", run, action: "view" });
        return;
      case "r":
        // Resume only makes sense for an unfinished Run; for a finished one, fall back to viewing it.
        if (run !== undefined) {
          props.onResolve({
            kind: "select",
            run,
            action: run.status === "finished" ? "view" : "resume",
          });
        }
        return;
      default:
        setPicker(pickerOnKey(picker(), key.name, props.runs.length));
    }
  });

  return (
    <box flexDirection="column" width="100%" height="100%" paddingTop={1} backgroundColor="#0b1120">
      <box paddingLeft={1} paddingRight={1} backgroundColor="#111827">
        <text fg="#38bdf8" attributes={1}>
          tml runs
        </text>
        <text marginLeft={2} fg="#64748b">
          {`${props.runs.length} run${props.runs.length === 1 ? "" : "s"} for this checkout`}
        </text>
      </box>
      <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <box flexDirection="row">
          <text fg="#475569" width={11}>
            state
          </text>
          <text fg="#475569" flexGrow={1}>
            branch
          </text>
          <text fg="#475569" width={10}>
            id
          </text>
          <text fg="#475569" width={6}>
            age
          </text>
        </box>
        <For each={props.runs}>
          {(run, i) => <RunRow run={run} now={props.now} selected={i() === picker().index} />}
        </For>
      </box>
      <box paddingLeft={1} backgroundColor="#0b1120">
        <text fg="#475569">j/k move · enter open · r resume · v view · q quit</text>
      </box>
    </box>
  );
}

function RunRow(props: { run: RunMetadata; now: number; selected: boolean }) {
  const state = (): string => displayState(props.run, props.now);
  return (
    <box flexDirection="row" backgroundColor={props.selected ? "#1e293b" : undefined}>
      <text fg="#64748b" width={2}>
        {props.selected ? "▸" : " "}
      </text>
      <text fg={stateColor(state())} width={9}>
        {state()}
      </text>
      <text fg="#cbd5e1" flexGrow={1}>
        {sanitize(runLabel(props.run))}
      </text>
      <text fg="#7fb0e8" width={10}>
        {shortRunId(props.run.runId)}
      </text>
      <text fg="#64748b" width={6}>
        {humanizeAge(props.now - Date.parse(props.run.updatedAt))}
      </text>
      <Show when={props.run.prUrl !== undefined}>
        <text fg="#22d3ee" marginLeft={1}>
          {sanitize(props.run.prUrl ?? "")}
        </text>
      </Show>
    </box>
  );
}
