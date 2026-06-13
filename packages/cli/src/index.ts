#!/usr/bin/env bun

import { createEngine, type RunEvent } from "@tml/core";
import { demoConfig } from "./demo-pipeline.ts";

function formatEvent(event: RunEvent): string {
  switch (event.type) {
    case "run:started":
      return `▶ run started: ${event.pipeline.join(" → ")}`;
    case "step:started":
      return `  ▸ ${event.step}`;
    case "step:log":
      return `    · ${event.message}`;
    case "agent:progress": {
      const p = event.progress;
      return p.kind === "text"
        ? `    · ${p.text}`
        : `    ⚙ ${p.name} ${p.phase}${p.detail ? `: ${p.detail}` : ""}`;
    }
    case "artifact:written":
      return `    + ${event.artifact}`;
    case "step:skipped":
      return `  ⤼ ${event.step} (skipped)`;
    case "step:finished":
      return `  ✓ ${event.step}`;
    case "ask:pending":
      return `  ? ${event.step}: ${event.prompt}`;
    case "run:finished":
      return "■ run finished";
    case "run:cancelled":
      return `◼ run cancelled${event.step ? ` at ${event.step}` : ""}`;
    case "run:failed":
      return `✗ run failed${event.step ? ` at ${event.step}` : ""}: ${event.error}`;
  }
}

async function ship(): Promise<number> {
  try {
    let failed = false;
    let cancelled = false;
    for await (const event of createEngine(demoConfig()).run()) {
      console.log(formatEvent(event));
      if (event.type === "run:failed") failed = true;
      if (event.type === "run:cancelled") cancelled = true;
    }
    // 130 = the conventional SIGINT exit code; an Abort is not a failure.
    return cancelled ? 130 : failed ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === "ship") return ship();
  console.error(`Unknown command: ${command ?? "(none)"}. Try: tml ship`);
  return 1;
}

process.exit(await main(process.argv.slice(2)));
