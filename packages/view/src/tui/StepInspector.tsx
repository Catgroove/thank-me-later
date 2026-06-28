/** @jsxImportSource @opentui/solid */
// The right pane: a generic per-Step inspector with fixed tabs (Summary, Artifacts, Findings,
// Rounds). Every Step - bundled or plugin - renders through the same tabs; nothing here branches on
// Step names or artifact meanings. Durations and Round/Finding data come straight from the folded
// ViewState (engine facts), never from scraping rendered Markdown. The live activity trail is the
// App's always-visible bottom panel, not a tab here.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
// Accessor is used both as a prop type and for the keyed <Show> render-prop param below.
import type { FindingLifecycle, RoundRecord } from "@tml/core";
import { isFixAttemptRound } from "@tml/core";
import type { PhaseView, StepView, ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";
import {
  byDisposition,
  DISPOSITION_COLOR,
  findingMarker,
  latestGroupPhases,
  phaseElapsed,
  progressLine,
  statusColor,
  statusGlyph,
  STATUS_META,
  stepChecklist,
  stepElapsed,
} from "./format.ts";
import { theme } from "./theme.ts";
import { SECTION_LABEL, SECTION_ORDER } from "./approval.ts";
import { TABS, effectiveIndex, type NavState, type Tab } from "./navigation.ts";

export interface InspectorProps {
  readonly view: Accessor<ViewState>;
  readonly nav: Accessor<NavState>;
  readonly now: Accessor<number>;
  /**
   * The id of the finding the operator is currently on in the approval drawer's action list, or
   * undefined when no approval is pending. The Findings tab highlights this finding so it is clear
   * which detailed finding the action list is pointing at.
   */
  readonly focusedFindingId?: Accessor<string | undefined>;
}

function TabBar(props: { active: Tab }) {
  return (
    <box flexDirection="row" paddingLeft={1} paddingBottom={1}>
      <For each={TABS}>
        {(tab) => (
          <text
            marginRight={2}
            fg={tab === props.active ? theme.accent : theme.textFaint}
            attributes={tab === props.active ? 1 : 0}
          >
            {tab}
          </text>
        )}
      </For>
    </box>
  );
}

function PhaseLine(props: { phase: PhaseView; now: number }) {
  const elapsed = () => phaseElapsed(props.phase, props.now);
  return (
    <box flexDirection="row">
      <text fg={statusColor(props.phase.status)}>{statusGlyph(props.phase.status)}</text>
      <text flexGrow={1} marginLeft={1} fg={theme.textMuted}>
        {sanitize(props.phase.label)}
      </text>
      <text fg={theme.textFaint}>
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
        <text fg={theme.textFaint}>phases:</text>
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
      <text fg={theme.text}>status: {props.step.status}</text>
      <Show when={stepElapsed(props.step, props.now, props.pendingAt) !== ""}>
        <text fg={theme.textMuted}>
          elapsed: {stepElapsed(props.step, props.now, props.pendingAt)}
        </text>
      </Show>
      <Show when={props.step.headline !== undefined}>
        <text fg={theme.text} wrapMode="word">
          {sanitize(props.step.headline ?? "", { preserveNewlines: true })}
        </text>
      </Show>
      <Show when={props.step.error !== undefined}>
        <text fg={theme.failed} wrapMode="word">
          error: {sanitize(props.step.error ?? "", { preserveNewlines: true })}
        </text>
      </Show>
      <Phases step={props.step} now={props.now} />
    </box>
  );
}

function Artifacts(props: { step: StepView; expanded: boolean }) {
  return (
    <box flexDirection="column">
      <Show
        when={props.step.artifacts.length > 0}
        fallback={<text fg={theme.textFaint}>no artifacts.</text>}
      >
        <For each={props.step.artifacts}>
          {(artifact) => (
            <box flexDirection="column" marginBottom={artifact.rendered ? 1 : 0}>
              <text fg={theme.text}>• {sanitize(artifact.name)}</text>
              <Show when={artifact.rendered !== undefined}>
                <text fg={theme.textMuted} wrapMode="word">
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

// The detailed view of a finding: the status glyph, the `[disposition]` severity badge, and the
// title flow as one wrapping line (inline spans, so a long title wraps to the full left edge rather
// than hanging-indenting under the badge); the file:line sits below as a dim secondary header, then
// the evidence. The glyph and its colour carry the lifecycle status - the aggregate tally at the top
// of the tab spells it out in words - so there is no right-hand tag to collide with the title. The
// badge carries severity colour; the title carries prominence. Focused background matches the drawer.
function FindingLine(props: { entry: FindingLifecycle; focused?: boolean }) {
  const f = () => props.entry.finding;
  const meta = () => STATUS_META[props.entry.status];
  const marker = () => findingMarker(f());
  // Resolved findings recede (dim) so the eye lands on what still needs work.
  const dim = () => meta().resolved;
  const badgeColor = () => (dim() ? theme.textFaint : DISPOSITION_COLOR[f().disposition]);
  const titleColor = () => (dim() ? theme.textFaint : theme.text);
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.focused ? theme.focusBg : undefined}
    >
      <text wrapMode="word">
        <span style={{ fg: meta().color }}>{meta().glyph} </span>
        <span style={{ fg: badgeColor() }}>{marker()} </span>
        <strong style={{ fg: titleColor() }}>{sanitize(f().title)}</strong>
      </text>
      <Show when={f().location}>
        <text fg={theme.textFaint} wrapMode="word">
          {sanitize(f().location ?? "")}
        </text>
      </Show>
      <text fg={theme.textMuted} wrapMode="word">
        {sanitize(f().detail, { preserveNewlines: true })}
      </text>
    </box>
  );
}

// the set the next round will fix on its own, then purely informational notes. The grouping and its
// canonical order are shared with the approval drawer (SECTION_ORDER/SECTION_LABEL), so the section
// header carries the action and the per-line `(action)` tag drops away. The per-line status glyph
// adds the orthogonal progress dimension: which of those findings are still pending, fixed, or decided.
function FindingSection(props: { label: string; entries: FindingLifecycle[]; focusedId?: string }) {
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.textFaint} attributes={1}>
        {props.label} ({props.entries.length})
      </text>
      <For each={props.entries}>
        {(entry) => <FindingLine entry={entry} focused={entry.finding.id === props.focusedId} />}
      </For>
    </box>
  );
}

function Findings(props: { step: StepView; focusedId?: string }) {
  const entries = () => stepChecklist(props.step);
  return (
    <box flexDirection="column">
      <Show
        when={entries().length > 0}
        fallback={<text fg={theme.textFaint}>no current findings.</text>}
      >
        <Show when={progressLine(entries()) !== ""}>
          <text fg={theme.text} marginBottom={1}>
            {progressLine(entries())}
          </text>
        </Show>
        <For each={SECTION_ORDER}>
          {(action) => {
            const items = () =>
              entries()
                .filter((e) => e.finding.action === action)
                .sort((a, b) => byDisposition(a.finding, b.finding));
            return (
              <Show when={items().length > 0}>
                <FindingSection
                  label={SECTION_LABEL[action]}
                  entries={items()}
                  focusedId={props.focusedId}
                />
              </Show>
            );
          }}
        </For>
      </Show>
    </box>
  );
}

function RoundLine(props: { round: RoundRecord; fixNumber?: number }) {
  const r = props.round;
  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={theme.text}>
        round {r.index} · {r.trigger}
        {props.fixNumber !== undefined ? ` · fix ${props.fixNumber}` : ""} · {r.findings.length}{" "}
        finding
        {r.findings.length === 1 ? "" : "s"}
        {r.commitSha ? ` · ${sanitize(r.commitSha.slice(0, 8))}` : ""}
      </text>
      <Show when={r.fixSummary !== undefined && r.fixSummary.trim() !== ""}>
        <text fg={theme.textMuted} wrapMode="word" marginLeft={2}>
          {sanitize(r.fixSummary ?? "", { preserveNewlines: true })}
        </text>
      </Show>
      <Show when={(r.selectedFindingIds?.length ?? 0) > 0}>
        <text fg={theme.textFaint} marginLeft={2}>
          selected: {sanitize((r.selectedFindingIds ?? []).join(", "))}
        </text>
      </Show>
    </box>
  );
}

function Rounds(props: { step: StepView }) {
  // The persisted round index counts every pass; operators reason in fix attempts, so number the
  // actual fix rounds on their own running counter and surface that alongside.
  const items = () => {
    let fixNumber = 0;
    return props.step.rounds.map((round) => {
      const isFix = isFixAttemptRound(round);
      if (isFix) fixNumber += 1;
      return { round, fixNumber: isFix ? fixNumber : undefined };
    });
  };
  return (
    <box flexDirection="column">
      <Show
        when={props.step.rounds.length > 0}
        fallback={<text fg={theme.textFaint}>no rounds recorded.</text>}
      >
        <For each={items()}>
          {(item) => <RoundLine round={item.round} fixNumber={item.fixNumber} />}
        </For>
      </Show>
    </box>
  );
}

export function StepInspector(props: InspectorProps) {
  const step = (): StepView | undefined =>
    props.view().steps[effectiveIndex(props.nav(), props.view())];
  const tab = () => props.nav().tab;
  return (
    <box
      flexGrow={1}
      flexDirection="column"
      border
      borderColor={theme.border}
      title="step"
      padding={0}
    >
      <Show when={step()} fallback={<text fg={theme.textFaint}>no step selected.</text>}>
        {(s: Accessor<StepView>) => (
          <box flexDirection="column" flexGrow={1}>
            <box flexDirection="row" paddingLeft={1}>
              <text fg={theme.text} attributes={1}>
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
                <Findings step={s()} focusedId={props.focusedFindingId?.()} />
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
