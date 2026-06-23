/** @jsxImportSource @opentui/solid */
// The left rail: the assembled Pipeline as one ordered list, exactly as emitted by `run:started`.
// Generic over the Pipeline - every Step renders identically (glyph, name, elapsed, short headline),
// with no branching on Step names, groups, or semantics. The active Step shows a spinner; the
// selected Step is highlighted.

import { For } from "solid-js";
import type { Accessor } from "solid-js";
import type { ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";
import { stepElapsed, statusColor, statusGlyph } from "./format.ts";
import { effectiveIndex, type NavState } from "./navigation.ts";
import { ensureSpinner } from "./spinner.ts";

export interface RailProps {
  readonly view: Accessor<ViewState>;
  readonly nav: Accessor<NavState>;
  readonly now: Accessor<number>;
}

export function PipelineRail(props: RailProps) {
  ensureSpinner(); // make the <spinner> element resolvable before the rail renders one
  const selected = () => effectiveIndex(props.nav(), props.view());
  return (
    <box
      flexDirection="column"
      width={30}
      border
      borderColor="#334155"
      title="pipeline"
      padding={0}
    >
      <For each={props.view().steps}>
        {(step, index) => {
          const isSelected = () => index() === selected();
          const elapsed = () => stepElapsed(step, props.now());
          return (
            <box
              flexDirection="row"
              paddingLeft={1}
              paddingRight={1}
              backgroundColor={isSelected() ? "#1e293b" : undefined}
            >
              {step.status === "active" ? (
                <spinner name="dots" color={statusColor("active")} />
              ) : (
                <text fg={statusColor(step.status)}>{statusGlyph(step.status)}</text>
              )}
              <text flexGrow={1} marginLeft={1} fg={isSelected() ? "#e2e8f0" : "#cbd5e1"}>
                {sanitize(step.name)}
              </text>
              <text fg="#64748b">{elapsed() === "" ? "" : ` ${elapsed()}`}</text>
            </box>
          );
        }}
      </For>
    </box>
  );
}
