// Captured `pi --mode json` JSONL, trimmed to the fields the mapper reads (the real
// events carry large duplicated `partial`/`message` snapshots we don't consume). Each
// const is an array of stdout lines, exactly as `PiProcess.stdout` yields them.
//
// Capture command (2026-06-14):
//   pi -p --mode json --no-session --no-tools "say hi in one word"
//   pi -p --mode json --no-session --tools ls "list files with ls, then say done"
// Refresh these if pi's JSONL shape drifts (the opt-in live smoke catches that).

/** A no-tools run: thinking + text noise, one `text_delta` ("Hi"), clean `agent_end`. */
export const NO_TOOLS_LINES: readonly string[] = [
  `{"type":"session","version":3,"id":"019ec314","cwd":"/tmp"}`,
  `{"type":"agent_start"}`,
  `{"type":"turn_start"}`,
  `{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"say hi in one word"}]}}`,
  `{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"say hi in one word"}]}}`,
  `{"type":"message_start","message":{"role":"assistant","content":[]}}`,
  `{"type":"message_update","assistantMessageEvent":{"type":"thinking_start","contentIndex":0}}`,
  `{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","contentIndex":0,"content":""}}`,
  `{"type":"message_update","assistantMessageEvent":{"type":"text_start","contentIndex":1}}`,
  `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"Hi"}}`,
  `{"type":"message_update","assistantMessageEvent":{"type":"text_end","contentIndex":1,"content":"Hi"}}`,
  `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hi"}],"stopReason":"stop"}}`,
  `{"type":"turn_end"}`,
  `{"type":"agent_end","messages":[]}`,
];

/** A tool-using run: toolcall arg-streaming (noise), `tool_execution_*`, then text + end. */
export const TOOL_LINES: readonly string[] = [
  `{"type":"session","version":3,"id":"019ec32a","cwd":"/tmp"}`,
  `{"type":"agent_start"}`,
  `{"type":"turn_start"}`,
  `{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"list files with ls, then say done"}]}}`,
  `{"type":"message_start","message":{"role":"assistant","content":[]}}`,
  `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_start","contentIndex":0,"partial":{"content":[{"type":"toolCall","id":"call_1","name":"ls"}]}}}`,
  `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","contentIndex":0,"delta":"{}"}}`,
  `{"type":"message_update","assistantMessageEvent":{"type":"toolcall_end","contentIndex":0,"toolCall":{"type":"toolCall","id":"call_1","name":"ls","arguments":{}}}}`,
  `{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"call_1","name":"ls"}],"stopReason":"toolUse"}}`,
  `{"type":"tool_execution_start","toolCallId":"call_1","toolName":"ls","args":{}}`,
  `{"type":"tool_execution_end","toolCallId":"call_1","toolName":"ls","result":{"content":[{"type":"text","text":"a.txt\\nb.txt"}]}}`,
  `{"type":"turn_start"}`,
  `{"type":"message_start","message":{"role":"assistant","content":[]}}`,
  `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"done"}}`,
  `{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stopReason":"stop"}}`,
  `{"type":"turn_end"}`,
  `{"type":"agent_end","messages":[]}`,
];

/** A run that emits a structured JSON answer in a fenced block (for schema parsing). */
export const SCHEMA_FENCED_TEXT = 'Here is the result:\n```json\n{"ok": true, "count": 2}\n```\n';

/** A run that emits a bare JSON object after reasoning prose (no fence). */
export const SCHEMA_BARE_TEXT = 'I inspected the repo and conclude:\n{"ok": false, "count": 0}';

/** A truncated/failed stream: no `agent_end`. Pair with a non-zero `done` in tests. */
export const NO_AGENT_END_LINES: readonly string[] = [
  `{"type":"session","version":3,"id":"019ec999","cwd":"/tmp"}`,
  `{"type":"agent_start"}`,
  `{"type":"turn_start"}`,
];

/** Sample `pi --list-models` stdout (one id per line, blanks ignored). */
export const LIST_MODELS_LINES: readonly string[] = [
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5.5",
  "",
  "google/gemini-3-pro",
];
