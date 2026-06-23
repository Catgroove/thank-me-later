/** @jsxImportSource @opentui/solid */
// The left rail: the assembled Pipeline as one ordered list, exactly as emitted by `run:started`.
// Generic over the Pipeline - every Step renders identically (glyph, name, elapsed, short headline),
// with no branching on Step names or semantics. The active Step shows a spinner - or, when it is
// blocked awaiting a human decision, a static amber glyph so it reads as "waiting on you", not
// "busy". The selected Step is highlighted. An active Step that declares phases shows its
// current-group phases as a sub-tree,
// so a multi-pass Step (e.g. review) is no longer an opaque single spinner.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { PhaseView, ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";
import {
  latestGroupPhases,
  phaseElapsed,
  railWidth,
  stepElapsed,
  statusColor,
  statusGlyph,
  WAITING_COLOR,
  WAITING_GLYPH,
} from "./format.ts";
import { effectiveIndex, type NavState } from "./navigation.ts";
import { ensureSpinner } from "./spinner.ts";

export interface RailProps {
  readonly view: Accessor<ViewState>;
  readonly nav: Accessor<NavState>;
  readonly now: Accessor<number>;
}

function PhaseRow(props: { phase: PhaseView; last: boolean; now: number }) {
  const elapsed = () => phaseElapsed(props.phase, props.now);
  const count = () =>
    props.phase.status === "done" && props.phase.findings.length > 0
      ? ` ${props.phase.findings.length}`
      : "";
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text fg="#475569">{props.last ? " └ " : " ├ "}</text>
      {props.phase.status === "active" ? (
        <spinner name="dots" color={statusColor("active")} />
      ) : (
        <text fg={statusColor(props.phase.status)}>{statusGlyph(props.phase.status)}</text>
      )}
      <text flexGrow={1} marginLeft={1} fg="#94a3b8">
        {sanitize(props.phase.label)}
      </text>
      <text fg="#64748b">
        {elapsed() === "" ? "" : ` ${elapsed()}`}
        {count()}
      </text>
    </box>
  );
}

export function PipelineRail(props: RailProps) {
  ensureSpinner(); // make the <spinner> element resolvable before the rail renders one
  const selected = () => effectiveIndex(props.nav(), props.view());
  return (
    <box
      flexDirection="column"
      width={railWidth(props.view())}
      border
      borderColor="#334155"
      title="pipeline"
      padding={0}
    >
      <For each={props.view().steps}>
        {(step, index) => {
          const isSelected = () => index() === selected();
          const pendingAt = () => {
            const pending = props.view().pendingInteraction;
            return pending?.step === step.name ? pending.at : undefined;
          };
          const elapsed = () => stepElapsed(step, props.now(), pendingAt());
          const phases = () => (step.status === "active" ? latestGroupPhases(step) : []);
          return (
            <box flexDirection="column">
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={isSelected() ? "#1e293b" : undefined}
              >
                {step.status !== "active" ? (
                  <text fg={statusColor(step.status)}>{statusGlyph(step.status)}</text>
                ) : pendingAt() !== undefined ? (
                  <text fg={WAITING_COLOR}>{WAITING_GLYPH}</text>
                ) : (
                  <spinner name="dots" color={statusColor("active")} />
                )}
                <text flexGrow={1} marginLeft={1} fg={isSelected() ? "#e2e8f0" : "#cbd5e1"}>
                  {sanitize(step.name)}
                </text>
                <text fg="#64748b">{elapsed() === "" ? "" : ` ${elapsed()}`}</text>
              </box>
              <Show when={phases().length > 0}>
                <For each={phases()}>
                  {(phase, i) => (
                    <PhaseRow phase={phase} last={i() === phases().length - 1} now={props.now()} />
                  )}
                </For>
              </Show>
            </box>
          );
        }}
      </For>
    </box>
  );
}
