import { createInterface } from "node:readline/promises";
import type { ApprovalDecision, ApproveFindingsInput, Finding } from "@tml/core";

export type ApprovalResponder = (input: ApproveFindingsInput) => Promise<ApprovalDecision>;

export function createCliApprovalResponder(): ApprovalResponder {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    return () =>
      Promise.reject(
        new Error("structured approval requires an interactive terminal; rerun tml ship in a TTY"),
      );
  }

  return async (input) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      renderApprovalInput(input);
      while (true) {
        const answer = (await rl.question("approval [approve|fix <ids>|skip|abort]> ")).trim();
        const decision = parseDecision(answer, input);
        if (decision !== undefined) return decision;
        process.stderr.write(
          "Enter approve, skip, abort, or fix followed by finding numbers or ids.\n",
        );
      }
    } finally {
      rl.close();
    }
  };
}

export function renderApprovalInput(input: ApproveFindingsInput): void {
  process.stderr.write(`\n${sanitizeTerminalText(input.prompt, { preserveNewlines: true })}\n`);
  if (input.context?.trim()) {
    process.stderr.write(
      `\n${sanitizeTerminalText(input.context.trim(), { preserveNewlines: true })}\n`,
    );
  }
  process.stderr.write("\nFindings:\n");
  input.findings.forEach((finding, index) => {
    process.stderr.write(`${index + 1}. ${formatFinding(finding)}\n`);
    process.stderr.write(`   id: ${sanitizeTerminalText(finding.id)}\n`);
  });
  if (input.selectedFindingIds && input.selectedFindingIds.length > 0) {
    const selection = input.selectedFindingIds.map((id) => sanitizeTerminalText(id)).join(", ");
    process.stderr.write(`Suggested fix selection: ${selection}\n`);
  }
}

export function sanitizeTerminalText(
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

function formatFinding(finding: Finding): string {
  const location = finding.location ? ` ${sanitizeTerminalText(finding.location)}` : "";
  return `${finding.severity}${location}: ${sanitizeTerminalText(finding.title)} - ${sanitizeTerminalText(finding.detail)} (${finding.action})`;
}

function parseDecision(answer: string, input: ApproveFindingsInput): ApprovalDecision | undefined {
  const [rawCommand, ...rawArgs] = answer.split(/\s+/).filter((part) => part.length > 0);
  const command = rawCommand?.toLowerCase();
  if (command === "approve" || command === "a") return { action: "approve" };
  if (command === "skip" || command === "s") return { action: "skip" };
  if (command === "abort" || command === "x" || command === "q") return { action: "abort" };
  if (command !== "fix" && command !== "f") return undefined;

  const ids = resolveIds(rawArgs.length === 0 ? (input.selectedFindingIds ?? []) : rawArgs, input);
  return ids.length > 0 ? { action: "fix", selectedFindingIds: ids } : undefined;
}

function resolveIds(values: readonly string[], input: ApproveFindingsInput): string[] {
  const ids: string[] = [];
  for (const value of values.flatMap((part) => part.split(","))) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const index = Number(trimmed);
    const id = Number.isInteger(index) ? input.findings[index - 1]?.id : trimmed;
    if (id !== undefined && input.findings.some((finding) => finding.id === id)) ids.push(id);
  }
  return [...new Set(ids)];
}
