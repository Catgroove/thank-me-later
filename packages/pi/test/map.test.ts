import { describe, expect, test } from "bun:test";
import { isAgentEnd, parseModels, parsePiEvent, type PiEvent, toProgress } from "../src/map.ts";
import { NO_AGENT_END_LINES, NO_TOOLS_LINES, TOOL_LINES } from "./fixtures.ts";

const events = (lines: readonly string[]): PiEvent[] =>
  lines.map(parsePiEvent).filter((e): e is PiEvent => e !== null);

describe("parsePiEvent", () => {
  test("parses a JSONL line into an event", () => {
    expect(parsePiEvent(`{"type":"agent_end","messages":[]}`)?.type).toBe("agent_end");
  });

  test("returns null for blank, unparseable, or typeless lines", () => {
    expect(parsePiEvent("")).toBeNull();
    expect(parsePiEvent("   ")).toBeNull();
    expect(parsePiEvent("not json")).toBeNull();
    expect(parsePiEvent(`{"no":"type"}`)).toBeNull();
  });
});

describe("toProgress", () => {
  test("maps a text_delta to text progress", () => {
    const ev = parsePiEvent(
      `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hi"}}`,
    );
    expect(ev && toProgress(ev)).toEqual({ kind: "text", text: "Hi" });
  });

  test("maps tool_execution_start/end to tool progress with the tool name", () => {
    const start = parsePiEvent(`{"type":"tool_execution_start","toolName":"ls","args":{}}`);
    const end = parsePiEvent(`{"type":"tool_execution_end","toolName":"ls","result":{}}`);
    expect(start && toProgress(start)).toEqual({ kind: "tool", name: "ls", phase: "start" });
    expect(end && toProgress(end)).toEqual({ kind: "tool", name: "ls", phase: "end" });
  });

  test("ignores thinking, toolcall arg-streaming, text framing, and session/turn noise", () => {
    const noise = [
      `{"type":"session"}`,
      `{"type":"agent_start"}`,
      `{"type":"turn_start"}`,
      `{"type":"message_start","message":{"role":"assistant"}}`,
      `{"type":"message_update","assistantMessageEvent":{"type":"thinking_start"}}`,
      `{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","content":""}}`,
      `{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}`,
      `{"type":"message_update","assistantMessageEvent":{"type":"text_end","content":"Hi"}}`,
      `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start"}}`,
      `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"{}"}}`,
      `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","toolCall":{"name":"ls"}}}`,
      `{"type":"message_end","message":{"role":"assistant","stopReason":"toolUse"}}`,
      `{"type":"turn_end"}`,
      `{"type":"agent_end","messages":[]}`,
    ];
    for (const line of noise) {
      const ev = parsePiEvent(line);
      expect(ev && toProgress(ev)).toBeNull();
    }
  });

  test("the no-tools fixture yields exactly one text progress ('Hi')", () => {
    const progress = events(NO_TOOLS_LINES)
      .map(toProgress)
      .filter((p) => p !== null);
    expect(progress).toEqual([{ kind: "text", text: "Hi" }]);
  });

  test("the tool fixture yields tool start/end then the final text, in stream order", () => {
    const progress = events(TOOL_LINES)
      .map(toProgress)
      .filter((p) => p !== null);
    expect(progress).toEqual([
      { kind: "tool", name: "ls", phase: "start" },
      { kind: "tool", name: "ls", phase: "end" },
      { kind: "text", text: "done" },
    ]);
  });
});

describe("isAgentEnd", () => {
  test("true only for agent_end", () => {
    expect(events(NO_TOOLS_LINES).some(isAgentEnd)).toBe(true);
    expect(events(NO_AGENT_END_LINES).some(isAgentEnd)).toBe(false);
  });
});

describe("parseModels", () => {
  test("returns one trimmed id per non-blank line", () => {
    expect(parseModels("anthropic/sonnet\nopenai/gpt-5.5\n\n  google/gemini  \n")).toEqual([
      "anthropic/sonnet",
      "openai/gpt-5.5",
      "google/gemini",
    ]);
  });
});
