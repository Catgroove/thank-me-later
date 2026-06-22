import { describe, expect, test } from "bun:test";
import { renderApprovalInput, sanitizeTerminalText } from "../src/approval.ts";

describe("CLI approval rendering", () => {
  test("escapes terminal control characters in approval findings", () => {
    const chunks: string[] = [];
    const originalWrite = Reflect.get(process.stderr, "write") as typeof process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      renderApprovalInput({
        prompt: "Review these findings",
        findings: [
          {
            id: "finding\u001b[31m",
            severity: "error",
            action: "ask-user",
            location: "build\nspoofed line",
            title: "bad\u001b[2Jtitle",
            detail: "detail\rrewrite",
          },
        ],
        selectedFindingIds: ["finding\u001b[31m"],
      });
    } finally {
      process.stderr.write = originalWrite;
    }

    const output = chunks.join("");
    expect(output).toContain("bad\\u001b[2Jtitle");
    expect(output).toContain("build\\u000aspoofed line");
    expect(output).toContain("detail\\u000drewrite");
    expect(output).toContain("finding\\u001b[31m");
    expect(output).not.toContain("\u001b[2J");
    expect(output).not.toContain("build\nspoofed line");
  });

  test("preserves intended prompt newlines while escaping terminal controls", () => {
    expect(sanitizeTerminalText("line 1\nline 2\u001b[0m", { preserveNewlines: true })).toBe(
      "line 1\nline 2\\u001b[0m",
    );
  });
});
