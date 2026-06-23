/** @jsxImportSource @opentui/solid */
// The right pane: a generic per-Step inspector with fixed tabs (Summary, Artifacts, Findings,
// Rounds). Every Step - bundled or plugin - renders through the same tabs; nothing here branches on
// Step names or artifact meanings. Durations and Round/Finding data come straight from the folded
// ViewState (engine facts), never from scraping rendered Markdown. The live activity trail is the
// App's always-visible bottom panel, not a tab here.

import { For, Show } from "solid-js";
import type { Accessor } from "solid-js";
// Accessor is used both as a prop type and for the keyed <Show> render-prop param below.
import type { FindingLifecycle, FindingStatus, RoundRecord } from "@tml/core";
import { findingLifecycle } from "@tml/core";
import type { PhaseView, StepView, ViewState } from "../present.ts";
import { sanitize } from "./sanitize.ts";
import {
  DISPOSITION_COLOR,
  findingMarker,
  latestGroupPhases,
  phaseElapsed,
  statusColor,
  statusGlyph,
  stepElapsed,
} from "./format.ts";
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

/**
 * The Step's findings as a cumulative checklist with their lifecycle status, derived from the whole
 * round history (not just the latest round) so resolved findings stay visible with a ✓ instead of
 * silently vanishing. A finding the current passes have surfaced but not yet recorded in a round is
 * appended as a live `open` preview, so findings still appear the moment a pass lands.
 */
function checklist(step: StepView): FindingLifecycle[] {
  const lifecycle = findingLifecycle(step.rounds, { settled: step.status !== "active" });
  const known = new Set(lifecycle.map((entry) => entry.finding.id));
  const preview: FindingLifecycle[] = [];
  for (const phase of latestGroupPhases(step)) {
    for (const finding of phase.findings) {
      if (known.has(finding.id)) continue;
      known.add(finding.id);
      preview.push({ finding, status: "open" });
    }
  }
  return [...lifecycle, ...preview];
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
      <Show when={props.step.error !== undefined}>
        <text fg="#ef4444" wrapMode="word">
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

// Each lifecycle status gets a checkbox-style glyph, a short tag, and a color, so the Findings tab
// reads as a to-do list that checks itself off: queued fixes show ⟳ pending, a verified fix shows a
// green ✓, an operator decision shows its outcome. Resolved items recede (dim) so attention lands on
// what still needs work.
const STATUS_META: Record<
  FindingStatus,
  {
    readonly glyph: string;
    readonly tag: string;
    readonly color: string;
    readonly resolved: boolean;
  }
> = {
  open: { glyph: "○", tag: "", color: "#94a3b8", resolved: false },
  pending: { glyph: "⟳", tag: "pending", color: "#38bdf8", resolved: false },
  fixed: { glyph: "✓", tag: "fixed", color: "#22c55e", resolved: true },
  unresolved: { glyph: "✗", tag: "unresolved", color: "#ef4444", resolved: false },
  accepted: { glyph: "✓", tag: "accepted as-is", color: "#22c55e", resolved: true },
  skipped: { glyph: "⤼", tag: "skipped", color: "#9ca3af", resolved: true },
};

/** A one-line progress tally above the sections, so overall progress reads at a glance. */
function progressLine(entries: readonly FindingLifecycle[]): string {
  const count = (predicate: (entry: FindingLifecycle) => boolean) =>
    entries.filter(predicate).length;
  const parts: string[] = [];
  const pending = count((e) => e.status === "pending");
  const needsYou = count((e) => e.status === "open" && e.finding.action === "ask-user");
  const unresolved = count((e) => e.status === "unresolved");
  const fixed = count((e) => e.status === "fixed");
  const accepted = count((e) => e.status === "accepted");
  const skipped = count((e) => e.status === "skipped");
  if (pending > 0) parts.push(`⟳ ${pending} pending`);
  if (needsYou > 0) parts.push(`${needsYou} needs you`);
  if (unresolved > 0) parts.push(`✗ ${unresolved} unresolved`);
  if (fixed > 0) parts.push(`✓ ${fixed} fixed`);
  if (accepted > 0) parts.push(`✓ ${accepted} accepted`);
  if (skipped > 0) parts.push(`⤼ ${skipped} skipped`);
  return parts.join(" · ");
}

function FindingLine(props: { entry: FindingLifecycle; focused?: boolean }) {
  const f = () => props.entry.finding;
  const meta = () => STATUS_META[props.entry.status];
  // The focused background matches the approval drawer's focused-finding row so the two surfaces
  // read as pointing at the same finding.
  const marker = () => findingMarker(f());
  // Resolved findings dim so the eye lands on what still needs work; open/pending keep the finding's
  // disposition color.
  const titleColor = () => (meta().resolved ? "#64748b" : DISPOSITION_COLOR[f().disposition]);
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={props.focused ? "#334155" : undefined}
    >
      <box flexDirection="row">
        <text fg={meta().color}>{meta().glyph}</text>
        <text flexGrow={1} marginLeft={1} fg={titleColor()}>
          {marker()} {sanitize(f().title)}
          {f().location ? ` — ${sanitize(f().location ?? "")}` : ""}
        </text>
        <Show when={meta().tag !== ""}>
          <text fg={meta().color}>{meta().tag}</text>
        </Show>
      </box>
      <text fg="#94a3b8" wrapMode="word" marginLeft={2}>
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
      <text fg="#64748b" attributes={1}>
        {props.label} ({props.entries.length})
      </text>
      <For each={props.entries}>
        {(entry) => <FindingLine entry={entry} focused={entry.finding.id === props.focusedId} />}
      </For>
    </box>
  );
}

function Findings(props: { step: StepView; focusedId?: string }) {
  const entries = () => checklist(props.step);
  return (
    <box flexDirection="column">
      <Show when={entries().length > 0} fallback={<text fg="#64748b">No current findings.</text>}>
        <Show when={progressLine(entries()) !== ""}>
          <text fg="#cbd5e1" marginBottom={1}>
            {progressLine(entries())}
          </text>
        </Show>
        <For each={SECTION_ORDER}>
          {(action) => {
            const items = () => entries().filter((e) => e.finding.action === action);
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
      <text fg="#cbd5e1">
        round {r.index} · {r.trigger}
        {props.fixNumber !== undefined ? ` · fix ${props.fixNumber}` : ""} · {r.findings.length}{" "}
        finding
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
  // The persisted round index counts every pass; operators reason in fix attempts, so number the
  // fix rounds (auto_fix/user_fix) on their own running counter and surface that alongside.
  const items = () => {
    let fixNumber = 0;
    return props.step.rounds.map((round) => {
      const isFix = round.trigger === "auto_fix" || round.trigger === "user_fix";
      if (isFix) fixNumber += 1;
      return { round, fixNumber: isFix ? fixNumber : undefined };
    });
  };
  return (
    <box flexDirection="column">
      <Show
        when={props.step.rounds.length > 0}
        fallback={<text fg="#64748b">No rounds recorded.</text>}
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
