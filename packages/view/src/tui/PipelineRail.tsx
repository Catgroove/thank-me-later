/** @jsxImportSource @opentui/solid */
// The left rail: the assembled Pipeline rendered one Step per row, by Step name. The active Step
// shows a spinner - or, when it is blocked awaiting a human decision, a static amber glyph so it
// reads as "waiting on you", not "busy". The selected Step is highlighted. An active Step that
// declares phases shows its current-group phases as a sub-tree, so a multi-pass Step is no longer
// an opaque single spinner.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { PhaseView, StepView, ViewState } from "../present.ts";
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
import { theme } from "./theme.ts";
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
      <text flexShrink={0} fg={theme.textFaint}>
        {props.last ? " └ " : " ├ "}
      </text>
      {props.phase.status === "active" ? (
        <spinner name="dots" color={statusColor("active")} />
      ) : (
        <text flexShrink={0} fg={statusColor(props.phase.status)}>
          {statusGlyph(props.phase.status)}
        </text>
      )}
      <text
        flexGrow={1}
        flexShrink={1}
        marginLeft={1}
        fg={theme.textMuted}
        wrapMode="none"
        truncate
      >
        {sanitize(props.phase.label)}
      </text>
      <text flexShrink={0} marginLeft={1} fg={theme.textFaint} wrapMode="none">
        {elapsed()}
        {count()}
      </text>
    </box>
  );
}

function StepRailRow(props: RailProps & { step: StepView; stepIndex: Accessor<number> }) {
  const isSelected = () => props.stepIndex() === effectiveIndex(props.nav(), props.view());
  const pendingAt = () => {
    const pending = props.view().pendingInteraction;
    return pending?.step === props.step.name ? pending.at : undefined;
  };
  const elapsed = () => stepElapsed(props.step, props.now(), pendingAt());
  const phases = () => (props.step.status === "active" ? latestGroupPhases(props.step) : []);
  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={isSelected() ? theme.selectionBg : undefined}
      >
        {props.step.status !== "active" ? (
          <text flexShrink={0} fg={statusColor(props.step.status)}>
            {statusGlyph(props.step.status)}
          </text>
        ) : pendingAt() !== undefined ? (
          <text flexShrink={0} fg={WAITING_COLOR}>
            {WAITING_GLYPH}
          </text>
        ) : (
          <spinner name="dots" color={statusColor("active")} />
        )}
        <text
          flexGrow={1}
          flexShrink={1}
          marginLeft={1}
          fg={isSelected() ? theme.focusFg : theme.text}
          wrapMode="none"
          truncate
        >
          {sanitize(props.step.name)}
        </text>
        <text flexShrink={0} marginLeft={1} fg={theme.textFaint} wrapMode="none">
          {elapsed()}
        </text>
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
}

export function PipelineRail(props: RailProps) {
  ensureSpinner(); // make the <spinner> element resolvable before the rail renders one
  return (
    <box
      flexDirection="column"
      width={railWidth(props.view())}
      border
      borderColor={theme.border}
      title="pipeline"
      padding={0}
    >
      <For each={props.view().steps}>
        {(step, stepIndex) => <StepRailRow {...props} step={step} stepIndex={stepIndex} />}
      </For>
    </box>
  );
}
