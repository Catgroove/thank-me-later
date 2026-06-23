/** @jsxImportSource @opentui/solid */
// The right pane: a generic per-Step inspector with fixed tabs (Summary, Artifacts, Findings,
// Rounds). Every Step - bundled or plugin - renders through the same tabs; nothing here branches on
// Step names or artifact meanings. Durations and Round/Finding data come straight from the folded
// ViewState (engine facts), never from scraping rendered Markdown. The live activity trail is the
// App's always-visible bottom panel, not a tab here.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
// Accessor is used both as a prop type and for the keyed <Show> render-prop param below.
import type { Finding, FindingAction, RoundRecord } from "@tml/core";
import type { PhaseView, StepView, ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";
import {
  latestGroupPhases,
  phaseElapsed,
  statusColor,
  statusGlyph,
  stepElapsed,
} from "./format.ts";
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

/** A finding's identity for live de-dup: the same finding reported by two passes shows once. */
function dedupeById(findings: readonly Finding[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const f of findings) {
    if (!seen.has(f.id)) {
      seen.add(f.id);
      out.push(f);
    }
  }
  return out;
}

/**
 * The findings to show: the latest recorded Round's deduped set once a Round exists, else a live
 * preview from the current group's resolved phases (so findings appear as each pass lands, before
 * the round is recorded).
 */
function visibleFindings(step: StepView): Finding[] {
  const phaseFindings = dedupeById(latestGroupPhases(step).flatMap((phase) => phase.findings));
  if (phaseFindings.length > 0 && step.status === "active") return phaseFindings;
  if (step.rounds.length > 0) return step.findings;
  return phaseFindings;
}

function PhaseLine(props: { phase: PhaseView; now: number }) {
  const elapsed = () => phaseElapsed(props.phase, props.now);
  return (
    <box flexDirection="row">
      <text fg={statusColor(props.phase.status)}>{statusGlyph(props.phase.status)}</text>
      <text flexGrow={1} marginLeft={1} fg="#94a3b8">
        {sanitize(props.phase.label)}
      </text>
      <text fg="#64748b">
        {elapsed() === "" ? "" : ` ${elapsed()}`}
        {props.phase.status === "done" && props.phase.findings.length > 0
          ? ` ${props.phase.findings.length}`
          : ""}
      </text>
    </box>
  );
}

function Phases(props: { step: StepView; now: number }) {
  const phases = () => latestGroupPhases(props.step);
  return (
    <Show when={phases().length > 0}>
      <box flexDirection="column" marginTop={1}>
        <text fg="#64748b">phases:</text>
        <For each={phases()}>{(phase) => <PhaseLine phase={phase} now={props.now} />}</For>
      </box>
    </Show>
  );
}

function Summary(props: { step: StepView; now: number; pendingAt?: number }) {
  // Read `props.step` inside JSX (never hoisted into a const) so the panel stays reactive when the
  // selected Step changes under j/k - hoisting captures a stale StepView and freezes the tab.
  return (
    <box flexDirection="column">
      <text fg="#cbd5e1">status: {props.step.status}</text>
      <Show when={stepElapsed(props.step, props.now, props.pendingAt) !== ""}>
        <text fg="#94a3b8">elapsed: {stepElapsed(props.step, props.now, props.pendingAt)}</text>
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
      <Phases step={props.step} now={props.now} />
      <Show
        when={
          props.step.artifacts.length === 0 &&
          props.step.rounds.length === 0 &&
          props.step.phases.length === 0 &&
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
        [{f.severity}] {sanitize(f.title)}
        {f.location ? ` — ${sanitize(f.location)}` : ""}
      </text>
      <text fg="#94a3b8" wrapMode="word" marginLeft={2}>
        {sanitize(f.detail, { preserveNewlines: true })}
      </text>
    </box>
  );
}

// Findings split by what happens to them, most-actionable first: a decision the user must make, then
// the set the next round will fix on its own, then purely informational notes. Grouping replaces the
// per-line `(action)` tag - the section header now carries it - so the user sees at a glance what
// needs them versus what the pipeline handles.
const FINDING_SECTIONS: readonly { action: FindingAction; label: string }[] = [
  { action: "ask-user", label: "Needs your decision" },
  { action: "auto-fix", label: "Auto-fix" },
  { action: "no-op", label: "Informational" },
];

function FindingSection(props: { label: string; findings: Finding[] }) {
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg="#64748b" attributes={1}>
        {props.label} ({props.findings.length})
      </text>
      <For each={props.findings}>{(finding) => <FindingLine finding={finding} />}</For>
    </box>
  );
}

function Findings(props: { step: StepView }) {
  const findings = () => visibleFindings(props.step);
  return (
    <box flexDirection="column">
      <Show when={findings().length > 0} fallback={<text fg="#64748b">No current findings.</text>}>
        <For each={FINDING_SECTIONS}>
          {(section) => {
            const items = () => findings().filter((f) => f.action === section.action);
            return (
              <Show when={items().length > 0}>
                <FindingSection label={section.label} findings={items()} />
              </Show>
            );
          }}
        </For>
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
                <Summary
                  step={s()}
                  now={props.now()}
                  pendingAt={
                    props.view().pendingInteraction?.step === s().name
                      ? props.view().pendingInteraction?.at
                      : undefined
                  }
                />
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
