// Pure `pi` argv builders. `-p` non-interactive, `--mode json` for the JSONL
// stream, `--no-session` so each `agent.run` is independent (one task per Step;
// spec 0005). `--model` only when the Step pins a raw, harness-specific id.
// Context-file discovery (AGENTS.md/CLAUDE.md) stays on so the agent sees the repo.

/** Build argv for a single agent run; `prompt` is the final positional arg. */
export function runArgs(prompt: string, model?: string): string[] {
  const args = ["-p", "--mode", "json", "--no-session"];
  if (model !== undefined && model !== "") args.push("--model", model);
  args.push(prompt);
  return args;
}

/** Build argv for the optional `listModels()` capability. */
export function listModelsArgs(): string[] {
  return ["--list-models"];
}
