// Plain renderer: append-only output for pipes and CI. It mirrors the TTY renderer's content,
// but has no transient live line, cursor codes, spinner, or color. One line per `writeLine` call.

import type { RunEvent } from "@tml/core";
import { approvalPrompt, isNarrativeArtifact, narrativeSteps, resultLabelWidth } from "./format.ts";
import type { ViewState } from "./present.ts";
import type { Renderer } from "./renderer.ts";

/** Build a plain renderer that emits one line per `writeLine` call (the sink adds newlines). */
export function createPlainRenderer(
  writeLine: (line: string) => void,
  options: { verbose?: boolean } = {},
): Renderer {
  const verbose = options.verbose ?? false;
  // How much of the active step's `view.text` has already been flushed. `view.text` resets to ""
  // on every `step:started`, so this resets to 0 there too. Only verbose actually emits prose.
  let flushedLen = 0;

  function flushText(view: ViewState): void {
    const segment = view.text.slice(flushedLen).trim();
    flushedLen = view.text.length;
    if (!verbose || segment === "") return;
    for (const line of segment.split("\n")) writeLine(`    ${line}`);
  }

  // The PR link, appended to a cancelled/failed run-end line (those carry no results block).
  const prSuffix = (view: ViewState): string =>
    view.prUrl !== undefined ? ` · ${view.prUrl}` : "";

  /** The end-of-run results block: narrative artifacts (in full) + the PR URL. */
  function resultsBlock(view: ViewState): void {
    const narrative = narrativeSteps(view);
    if (narrative.length === 0 && view.prUrl === undefined) return;
    writeLine(`  ── results ${"─".repeat(20)}`);
    const labelWidth = resultLabelWidth(narrative, view.prUrl !== undefined);
    const cont = " ".repeat(2 + labelWidth);
    for (const step of narrative) {
      const [first, ...rest] = (step.rendered ?? "").split("\n");
      writeLine(`  ${step.name.padEnd(labelWidth)}${first ?? ""}`);
      for (const line of rest) writeLine(`${cont}${line}`);
    }
    if (view.prUrl !== undefined) writeLine(`  ${"pr".padEnd(labelWidth)}${view.prUrl}`);
  }

  return {
    render(view: ViewState, event: RunEvent): void {
      switch (event.type) {
        case "run:started":
          writeLine("▶ ship");
          for (const step of event.pipeline) writeLine(`  ${step}`);
          return;
        case "step:started":
          flushedLen = 0; // the fold reset view.text for the new step
          writeLine(`  ▸ ${event.step}`);
          return;
        case "agent:progress":
          // Prose accumulates in view.text; a tool start is a flush boundary. Both are verbose-only.
          if (event.progress.kind === "tool" && event.progress.phase === "start") {
            flushText(view);
            if (verbose) {
              const { name, detail } = event.progress;
              writeLine(`    ⚙ ${name}${detail !== undefined ? ` · ${detail}` : ""}`);
            }
          }
          return;
        case "step:log":
          flushText(view);
          writeLine(`    · ${event.message}`);
          return;
        case "artifact:written":
          // Surfaced on the step's result line and in the results block — no separate line here.
          return;
        case "pr:opened":
          // Held in view.prUrl; surfaced in the results block, not inline.
          return;
        case "ask:pending":
          flushText(view);
          writeLine(`  ? ${event.step}: ${event.prompt}`);
          return;
        case "approval:pending":
          flushText(view);
          writeLine(`  ? ${event.step}: ${approvalPrompt(event)}`);
          return;
        case "step:finished": {
          flushText(view);
          const rendered = view.steps.find((step) => step.name === event.step)?.rendered;
          // Narrative artifacts surface in the results block; only short ones read inline here.
          const inline =
            rendered !== undefined && !isNarrativeArtifact(rendered) ? `  ${rendered}` : "";
          writeLine(`  ✓ ${event.step}${inline}`);
          return;
        }
        case "step:skipped":
          flushText(view);
          writeLine(`  ⤼ ${event.step} (skipped)`);
          return;
        case "run:finished":
          flushText(view);
          resultsBlock(view);
          writeLine("■ run finished");
          return;
        case "run:cancelled":
          flushText(view);
          writeLine(`◼ run cancelled${event.step ? ` at ${event.step}` : ""}${prSuffix(view)}`);
          return;
        case "run:failed":
          flushText(view);
          writeLine(
            `✗ run failed${event.step ? ` at ${event.step}` : ""}: ${event.error}${prSuffix(view)}`,
          );
          return;
      }
    },
    close(): void {
      // Nothing buffered across calls beyond view.text, which the terminal events flush.
    },
  };
}
