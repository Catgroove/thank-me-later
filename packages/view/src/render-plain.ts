// Plain (non-TTY) renderer: append-only, no spinner, no cursor codes — the output
// pipes and CI get. It is thin over `ViewState`: the coalesced assistant
// text lives in `view.text` (the shared fold did the coalescing); this renderer only
// decides *when* to flush it (at tool/step boundaries) and emits labelled lines for
// step transitions and tool activity. One line per call to `writeLine`.

import type { RunEvent } from "@tml/core";
import type { ViewState } from "./present.ts";
import type { Renderer } from "./renderer.ts";

/** Build a plain renderer that emits one line per `writeLine` call (the sink adds newlines). */
export function createPlainRenderer(writeLine: (line: string) => void): Renderer {
  // How much of the active step's `view.text` has already been flushed. `view.text`
  // resets to "" on every `step:started`, so this resets to 0 there too.
  let flushedLen = 0;

  function flushText(view: ViewState): void {
    const segment = view.text.slice(flushedLen).trim();
    flushedLen = view.text.length;
    if (segment !== "") writeLine(`    ${segment}`);
  }

  // The PR link, appended to whichever run-end line we emit so it survives the CI wait.
  const prSuffix = (view: ViewState): string => (view.prUrl ? ` · ${view.prUrl}` : "");

  return {
    render(view: ViewState, event: RunEvent): void {
      switch (event.type) {
        case "run:started":
          writeLine("▶ run started:");
          for (const step of event.pipeline) writeLine(`  ${step}`);
          return;
        case "step:started":
          flushedLen = 0; // the fold reset view.text for the new step
          writeLine(`  ▸ ${event.step}`);
          return;
        case "agent:progress":
          // Text is accumulated in view.text by the fold; a tool start is a flush boundary.
          if (event.progress.kind === "tool" && event.progress.phase === "start") {
            flushText(view);
            const { name, detail } = event.progress;
            writeLine(`    ⚙ ${name}${detail ? ` · ${detail}` : ""}`);
          }
          return;
        case "step:log":
          flushText(view);
          writeLine(`    · ${event.message}`);
          return;
        case "artifact:written":
          flushText(view);
          writeLine(`    + ${event.artifact}`);
          return;
        case "pr:opened":
          // Held in view.prUrl; surfaced on the run-end line, not inline.
          return;
        case "ask:pending":
          flushText(view);
          writeLine(`  ? ${event.step}: ${event.prompt}`);
          return;
        case "step:finished":
          flushText(view);
          writeLine(`  ✓ ${event.step}`);
          return;
        case "step:skipped":
          flushText(view);
          writeLine(`  ⤼ ${event.step} (skipped)`);
          return;
        case "run:finished":
          flushText(view);
          writeLine(`■ run finished${prSuffix(view)}`);
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
