// The structured side of the multi-pass review: the finding model, a throw-on-mismatch parser
// for each pass's reply (the agent returns JSON against `findingsSchema`), and the pure synthesis
// of all passes into the single `reviewSummary` markdown. Risk is computed here, in code — the
// agent never sets the overall risk. No `ctx`, so all of this is unit-testable in isolation.

export type Severity = "critical" | "warning" | "nit";
export type Action = "auto-fix" | "ask-user" | "no-op";
export type Verdict = "proceed" | "block";
export type Risk = "low" | "medium" | "high";

export interface Finding {
  readonly severity: Severity;
  readonly action: Action;
  readonly title: string;
  readonly detail: string;
  readonly location?: string;
}

export interface PassResult {
  readonly findings: Finding[];
  /** Set by the context pass: a plain-language restatement of the change, threaded forward. */
  readonly understanding?: string;
  /** Set by the architecture pass: `block` records a high-risk concern (it does not halt). */
  readonly verdict?: Verdict;
}

/** A pass paired with the human-facing section title `summarize` renders it under. */
export interface ReviewPass {
  readonly title: string;
  readonly result: PassResult;
}

const SEVERITIES: ReadonlySet<string> = new Set(["critical", "warning", "nit"]);
const ACTIONS: ReadonlySet<string> = new Set(["auto-fix", "ask-user", "no-op"]);
const VERDICTS: ReadonlySet<string> = new Set(["proceed", "block"]);

/** Validate one pass's structured reply into a `PassResult`, throwing on anything malformed. */
export function parsePassResult(output: unknown): PassResult {
  if (typeof output !== "object" || output === null) {
    throw new Error("review: the agent did not return a structured pass result");
  }
  const obj = output as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) {
    throw new Error("review: the pass result is missing a `findings` array");
  }
  const findings = obj.findings.map((raw, i) => parseFinding(raw, i));
  const result: { -readonly [K in keyof PassResult]: PassResult[K] } = { findings };
  if (typeof obj.understanding === "string" && obj.understanding.trim().length > 0) {
    result.understanding = obj.understanding.trim();
  }
  if (obj.verdict !== undefined) {
    if (typeof obj.verdict !== "string" || !VERDICTS.has(obj.verdict)) {
      throw new Error("review: the pass result has an invalid verdict");
    }
    result.verdict = obj.verdict as Verdict;
  }
  return result;
}

function parseFinding(raw: unknown, index: number): Finding {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`review: finding ${index} is not an object`);
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) {
    throw new Error(`review: finding ${index} has an invalid severity`);
  }
  if (typeof f.action !== "string" || !ACTIONS.has(f.action)) {
    throw new Error(`review: finding ${index} has an invalid action`);
  }
  if (typeof f.title !== "string" || f.title.trim().length === 0) {
    throw new Error(`review: finding ${index} is missing a title`);
  }
  if (typeof f.detail !== "string") {
    throw new Error(`review: finding ${index} is missing a detail`);
  }
  const finding: { -readonly [K in keyof Finding]: Finding[K] } = {
    severity: f.severity as Severity,
    action: f.action as Action,
    title: f.title.trim(),
    detail: f.detail.trim(),
  };
  if (typeof f.location === "string" && f.location.trim().length > 0) {
    finding.location = f.location.trim();
  }
  return finding;
}

/** Highest severity wins; a blocking verdict forces high regardless of the findings. */
export function riskOf(findings: readonly Finding[], blocked = false): Risk {
  if (blocked || findings.some((f) => f.severity === "critical")) return "high";
  if (findings.some((f) => f.severity === "warning")) return "medium";
  return "low";
}

function label(severity: Severity): string {
  if (severity === "critical") return "Critical:";
  if (severity === "warning") return "Warning:";
  return "Nit:";
}

function renderFinding(f: Finding): string {
  const loc = f.location ? ` \`${f.location}\`` : "";
  const hint = f.action === "ask-user" ? " _(needs your decision)_" : "";
  return `- ${label(f.severity)}${loc} ${f.title} — ${f.detail}${hint}`;
}

/** Fold the passes into the `reviewSummary` markdown: banner (if blocked), risk, per-phase
 *  sections, and the fixes applied. Deterministic — same input, same output. */
export function summarize(passes: readonly ReviewPass[], fixSummary: string): string {
  const all = passes.flatMap((p) => p.result.findings);
  const blockedPass = passes.find((p) => p.result.verdict === "block");
  const blocked = blockedPass !== undefined;
  const lines: string[] = [];

  if (blocked) {
    lines.push(
      "> **Blocking concern (architecture & scope).** This change was flagged as fundamentally " +
        `risky, out of scope, or too large to review safely — see the ${blockedPass.title} ` +
        "section below before merging.",
      "",
    );
  }
  lines.push(`**Risk: ${riskOf(all, blocked)}**`, "");

  for (const pass of passes) {
    if (pass.result.findings.length === 0 && pass.result.verdict !== "block") continue;
    lines.push(`### ${pass.title}`);
    if (pass.result.findings.length === 0) {
      lines.push("- Blocking verdict returned without specific findings.");
    } else {
      for (const f of pass.result.findings) lines.push(renderFinding(f));
    }
    lines.push("");
  }
  if (all.length === 0 && !blocked) lines.push("No findings.", "");

  const fixes = fixSummary.trim();
  lines.push("### Fixes applied", fixes.length > 0 ? fixes : "None.");
  return lines.join("\n").trim();
}
