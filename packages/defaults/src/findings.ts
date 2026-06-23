import { makeFinding, type Finding, type FindingAction, type FindingSeverity } from "@tml/core";

const SEVERITIES: ReadonlySet<string> = new Set<FindingSeverity>(["error", "warning", "info"]);
const ACTIONS: ReadonlySet<string> = new Set<FindingAction>(["auto-fix", "ask-user", "no-op"]);

export interface ParseAgentFindingsOptions {
  readonly namespace: string;
  readonly sourceName?: string;
  readonly enforceActionForSeverity?: boolean;
}

/** Validate an agent's structured `{ findings }` reply into core Findings. */
export function parseAgentFindingsOutput(
  output: unknown,
  options: ParseAgentFindingsOptions,
): Finding[] {
  const sourceName = options.sourceName ?? options.namespace;
  if (typeof output !== "object" || output === null) {
    throw new Error(`${sourceName}: the agent did not return a structured findings result`);
  }
  const obj = output as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) {
    throw new Error(`${sourceName}: the result is missing a findings array`);
  }
  return obj.findings.map((raw, i) => parseAgentFinding(raw, i, options));
}

function parseAgentFinding(
  raw: unknown,
  index: number,
  options: ParseAgentFindingsOptions,
): Finding {
  const sourceName = options.sourceName ?? options.namespace;
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${sourceName}: finding ${index} is not an object`);
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) {
    throw new Error(`${sourceName}: finding ${index} has an invalid severity`);
  }
  if (typeof f.action !== "string" || !ACTIONS.has(f.action)) {
    throw new Error(`${sourceName}: finding ${index} has an invalid action`);
  }
  if (options.enforceActionForSeverity && !isAllowedActionForSeverity(f.severity, f.action)) {
    throw new Error(
      `${sourceName}: finding ${index} has action ${f.action} for severity ${f.severity}; ` +
        "error and warning findings must be auto-fix or ask-user, and info findings must be no-op",
    );
  }
  if (typeof f.title !== "string" || f.title.trim().length === 0) {
    throw new Error(`${sourceName}: finding ${index} is missing a title`);
  }
  if (typeof f.detail !== "string") {
    throw new Error(`${sourceName}: finding ${index} is missing a detail`);
  }
  return makeFinding(options.namespace, {
    severity: f.severity as Finding["severity"],
    action: f.action as Finding["action"],
    title: f.title.trim(),
    detail: f.detail.trim(),
    ...(typeof f.location === "string" && f.location.trim().length > 0
      ? { location: f.location.trim() }
      : {}),
  });
}

function isAllowedActionForSeverity(severity: string, action: string): boolean {
  if (severity === "info") return action === "no-op";
  return action === "auto-fix" || action === "ask-user";
}
