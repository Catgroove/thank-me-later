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
    const detail = toolDetail(event.args);
    return detail === undefined
      ? { kind: "tool", name: event.toolName, phase: "start" }
      : { kind: "tool", name: event.toolName, phase: "start", detail };
  }
  if (event.type === "tool_execution_end" && typeof event.toolName === "string") {
    return { kind: "tool", name: event.toolName, phase: "end" };
  }
  return null;
}

const DETAIL_MAX = 80;

/**
 * Extract `AgentProgress.tool.detail` — a short human label for the tool call — from pi's
 * `tool_execution_start.args` (field names captured from a real `pi --mode json` run,
 * 2026-06-14): bash → `command`, read/write/edit → `path`. Collapsed to a single trimmed
 * line and truncated; absent when there is no usable string argument.
 */
function toolDetail(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const raw = record.command ?? record.path;
  if (typeof raw !== "string") return undefined;
  const line = raw.replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  return line.length > DETAIL_MAX ? `${line.slice(0, DETAIL_MAX - 1)}…` : line;
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
