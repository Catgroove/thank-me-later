// Structured output for a harness with no native schema flag: inline the schema
// into the prompt, then parse the JSON back out of the agent's free-text reply.
// Pure (string + schema → value), unit-tested directly. (AgentRunOpts.schema
// contract. Lifts into @tml/core if a second harness needs it.)
//
// Models wrap JSON in prose and ```json fences inconsistently, so we try, in order:
// fenced ```json blocks, then the last bare balanced {…} object; then check the
// minimally interpreted schema: object type and required keys only. Nothing valid → throw.

/** Append the schema and a JSON-only instruction to the task prompt. */
export function withInlinedSchema(task: string, schema: object): string {
  return [
    task,
    "",
    "Respond with ONLY a single JSON object matching this JSON Schema - no prose, no",
    "explanation, optionally inside one ```json fenced block:",
    JSON.stringify(schema),
  ].join("\n");
}

/** Parse the structured object out of `text` and check required schema fields, or throw. */
export function parseStructuredText(text: string, schema: object): unknown {
  const candidates = [...fencedJsonBlocks(text), ...bareJsonObjects(text)];
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }
    const problem = validate(value, schema);
    if (problem === null) return value;
    lastError = new Error(problem);
  }
  throw new Error(
    `no JSON object satisfying required schema fields found in agent output${lastError ? `: ${lastError.message}` : ""}`,
  );
}

/** Bodies of every ```json … ``` fenced block, in order. */
function fencedJsonBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fence = /```json\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null = fence.exec(text);
  while (match !== null) {
    if (match[1] !== undefined) blocks.push(match[1].trim());
    match = fence.exec(text);
  }
  return blocks;
}

/** Brace-balanced `{…}` substrings, last first (models put the answer last). */
function bareJsonObjects(text: string): string[] {
  const found: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "{") continue;
    const end = scanBalanced(text, i);
    if (end > 0) {
      found.push(text.slice(i, end));
      i = end - 1;
    }
  }
  return found.reverse();
}

/** Exclusive end index of the balanced object starting at `{`, or -1; respects strings. */
function scanBalanced(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Minimal schema check: object type + required keys present. Returns a problem or null. */
function validate(value: unknown, schema: object): string | null {
  const s = schema as { type?: string; required?: string[] };
  if (s.type === "object" || s.required !== undefined) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return "expected a JSON object";
    }
    for (const key of s.required ?? []) {
      if (!(key in (value as Record<string, unknown>))) return `missing required field "${key}"`;
    }
  }
  return null;
}
