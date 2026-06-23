// Escape terminal control characters before drawing untrusted strings (agent text, finding titles,
// prompts, artifact bodies) in the TUI. Without this, a crafted artifact could emit cursor moves or
// screen clears and corrupt the alternate-screen layout. Newlines may be preserved where a multi-line
// block is intended; every other C0/C1 control becomes a visible `\uXXXX` escape.

export function sanitize(
  value: string,
  options: { readonly preserveNewlines?: boolean } = {},
): string {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    if (!isControl || (options.preserveNewlines === true && character === "\n")) {
      output += character;
    } else {
      output += `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
  return output;
}
