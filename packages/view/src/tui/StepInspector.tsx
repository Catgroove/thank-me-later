/** @jsxImportSource @opentui/solid */
// The right pane: a generic per-Step inspector with fixed tabs (Summary, Artifacts, Findings,
// Rounds). Every Step - bundled or plugin - renders through the same tabs; nothing here branches on
// Step names or artifact meanings. Durations and Round/Finding data come straight from the folded
// ViewState (engine facts), never from scraping rendered Markdown. The live activity trail is the
// App's always-visible bottom panel, not a tab here.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
// Accessor is used both as a prop type and for the keyed <Show> render-prop param below.
import type { Finding, RoundRecord } from "@tml/core";
import type { StepView, ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";
import { stepElapsed } from "./format.ts";
import { TABS, effectiveIndex, type NavState, type Tab } from "./navigation.ts";

export interface InspectorProps {
  readonly view: Accessor<ViewState>;
  readonly nav: Accessor<NavState>;
  readonly now: Accessor<number>;
}

const SEVERITY_COLOR: Record<Finding["severity"], string> = {
  error: "#ef4444",
  warning: "#f59e0b",
  info: "#38bdf8",
};

function TabBar(props: { active: Tab }) {
  return (
    <box flexDirection="row" paddingLeft={1} paddingBottom={1}>
      <For each={TABS}>
        {(tab) => (
          <text
            marginRight={2}
            fg={tab === props.active ? "#38bdf8" : "#64748b"}
            attributes={tab === props.active ? 1 : 0}
          >
            {tab}
          </text>
        )}
      </For>
    </box>
  );
}

function Summary(props: { step: StepView; now: number }) {
  // Read `props.step` inside JSX (never hoisted into a const) so the panel stays reactive when the
  // selected Step changes under j/k - hoisting captures a stale StepView and freezes the tab.
  return (
    <box flexDirection="column">
      <text fg="#cbd5e1">status: {props.step.status}</text>
      <Show when={stepElapsed(props.step, props.now) !== ""}>
        <text fg="#94a3b8">elapsed: {stepElapsed(props.step, props.now)}</text>
      </Show>
      <Show when={props.step.headline !== undefined}>
        <text fg="#e2e8f0" wrapMode="word">
          {sanitize(props.step.headline ?? "", { preserveNewlines: true })}
        </text>
      </Show>
      <Show when={props.step.currentTool !== undefined}>
        <text fg="#a78bfa">
          ⚙ {sanitize(props.step.currentTool?.name ?? "")}
          {props.step.currentTool?.detail ? ` · ${sanitize(props.step.currentTool.detail)}` : ""}
        </text>
      </Show>
      <Show when={props.step.error !== undefined}>
        <text fg="#ef4444" wrapMode="word">
          error: {sanitize(props.step.error ?? "", { preserveNewlines: true })}
        </text>
      </Show>
      <Show
        when={
          props.step.artifacts.length === 0 &&
          props.step.rounds.length === 0 &&
          props.step.headline === undefined
        }
      >
        <text fg="#64748b">No facts recorded yet.</text>
      </Show>
    </box>
  );
}

function Artifacts(props: { step: StepView; expanded: boolean }) {
  return (
    <box flexDirection="column">
      <Show
        when={props.step.artifacts.length > 0}
        fallback={<text fg="#64748b">No artifacts.</text>}
      >
        <For each={props.step.artifacts}>
          {(artifact) => (
            <box flexDirection="column" marginBottom={artifact.rendered ? 1 : 0}>
              <text fg="#cbd5e1">• {sanitize(artifact.name)}</text>
              <Show when={artifact.rendered !== undefined}>
                <text fg="#94a3b8" wrapMode="word">
                  {props.expanded
                    ? sanitize(artifact.rendered ?? "", { preserveNewlines: true })
                    : sanitize((artifact.rendered ?? "").split("\n")[0] ?? "").slice(0, 200)}
                </text>
              </Show>
            </box>
          )}
        </For>
      </Show>
    </box>
  );
}

function FindingLine(props: { finding: Finding }) {
  const f = props.finding;
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={SEVERITY_COLOR[f.severity]}>
        [{f.severity}] {sanitize(f.title)} ({f.action})
        {f.location ? ` — ${sanitize(f.location)}` : ""}
      </text>
      <text fg="#94a3b8" wrapMode="word" marginLeft={2}>
        {sanitize(f.detail, { preserveNewlines: true })}
      </text>
    </box>
  );
}

function Findings(props: { step: StepView }) {
  return (
    <box flexDirection="column">
      <Show
        when={props.step.findings.length > 0}
        fallback={<text fg="#64748b">No current findings.</text>}
      >
        <For each={props.step.findings}>{(finding) => <FindingLine finding={finding} />}</For>
      </Show>
    </box>
  );
}

function RoundLine(props: { round: RoundRecord }) {
  const r = props.round;
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg="#cbd5e1">
        round {r.index} · {r.trigger} · {r.findings.length} finding
        {r.findings.length === 1 ? "" : "s"}
        {r.commitSha ? ` · ${sanitize(r.commitSha.slice(0, 8))}` : ""}
      </text>
      <Show when={r.fixSummary !== undefined && r.fixSummary.trim() !== ""}>
        <text fg="#94a3b8" wrapMode="word" marginLeft={2}>
          {sanitize(r.fixSummary ?? "", { preserveNewlines: true })}
        </text>
      </Show>
      <Show when={(r.selectedFindingIds?.length ?? 0) > 0}>
        <text fg="#64748b" marginLeft={2}>
          selected: {sanitize((r.selectedFindingIds ?? []).join(", "))}
        </text>
      </Show>
    </box>
  );
}

function Rounds(props: { step: StepView }) {
  return (
    <box flexDirection="column">
      <Show
        when={props.step.rounds.length > 0}
        fallback={<text fg="#64748b">No rounds recorded.</text>}
      >
        <For each={props.step.rounds}>{(round) => <RoundLine round={round} />}</For>
      </Show>
    </box>
  );
}

export function StepInspector(props: InspectorProps) {
  const step = (): StepView | undefined =>
    props.view().steps[effectiveIndex(props.nav(), props.view())];
  const tab = () => props.nav().tab;
  return (
    <box flexGrow={1} flexDirection="column" border borderColor="#334155" title="step" padding={0}>
      <Show when={step()} fallback={<text fg="#64748b">No Step selected.</text>}>
        {(s: Accessor<StepView>) => (
          <box flexDirection="column" flexGrow={1}>
            <box flexDirection="row" paddingLeft={1}>
              <text fg="#e2e8f0" attributes={1}>
                {sanitize(s().name)}
              </text>
            </box>
            <TabBar active={tab()} />
            <scrollbox flexGrow={1} paddingLeft={1} paddingRight={1}>
              <Show when={tab() === "summary"}>
                <Summary step={s()} now={props.now()} />
              </Show>
              <Show when={tab() === "artifacts"}>
                <Artifacts step={s()} expanded={props.nav().expanded} />
              </Show>
              <Show when={tab() === "findings"}>
                <Findings step={s()} />
              </Show>
              <Show when={tab() === "rounds"}>
                <Rounds step={s()} />
              </Show>
            </scrollbox>
          </box>
        )}
      </Show>
    </box>
  );
}
