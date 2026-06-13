// Pure mapping from pi's `--mode json` JSONL events onto core's `AgentProgress`.
// No I/O, no `pi`, no `cwd` — just parsed-value → value, so it is unit-tested
// directly against fixtures. (ADR-0009; spec 0005.)
//
// pi streams many event kinds; we surface only two as progress:
//   • assistant text  — `message_update` → `assistantMessageEvent.type === "text_delta"`
//   • tool activity   — top-level `tool_execution_start` / `tool_execution_end`
// Everything else (thinking_*, the `toolcall_*` argument-streaming, text_start/end,
// message_start/end echoes, session/turn framing) is deliberately ignored.

import type { AgentProgress } from "@tml/core";

/** A parsed pi event. Only `type` is guaranteed; readers narrow the rest. */
export interface PiEvent {
  readonly type: string;
  readonly assistantMessageEvent?: { readonly type?: string; readonly delta?: string };
  readonly toolName?: string;
  readonly [key: string]: unknown;
}

/** Parse one JSONL line into an event, or `null` for blank/unparseable lines. */
export function parsePiEvent(line: string): PiEvent | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as PiEvent).type === "string"
    ) {
      return value as PiEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/** Map an event to a progress item, or `null` if it carries no surfaceable progress. */
export function toProgress(event: PiEvent): AgentProgress | null {
  if (event.type === "message_update") {
    const inner = event.assistantMessageEvent;
    if (inner?.type === "text_delta" && typeof inner.delta === "string") {
      return { kind: "text", text: inner.delta };
    }
    return null; // toolcall_*, thinking_*, text_start/end → ignored
  }
  if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
    return { kind: "tool", name: event.toolName, phase: "start" };
  }
  if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
    return { kind: "tool", name: event.toolName, phase: "end" };
  }
  return null;
}

/** True for the terminal event of a successful run. */
export function isAgentEnd(event: PiEvent): boolean {
  return event.type === "agent_end";
}

/** Parse `pi --list-models` stdout: one model id per non-blank line. */
export function parseModels(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
