// createPiHarness — composes the spawn seam, argv builder, JSONL mapper, and
// schema parser into core's `Harness` (spec 0005). The provider stays
// thin: `run` spawns `pi --mode json`, streams stdout through pure mappers to fire
// `onProgress` live and accumulate the answer, then resolves an `AgentResult` when
// the agent's turn ends. The only state is the (injectable) spawn seam.

import { AbortError, type AgentResult, type Harness } from "@tml/core";

import { isAgentEnd, parseModels, parsePiEvent, toProgress } from "./map.ts";
import { parseStructuredText, withInlinedSchema } from "./schema.ts";
import { defaultSpawn, type PiSpawn } from "./spawn.ts";

export interface PiHarnessOptions {
  /** Override the spawn seam; tests inject a fake yielding canned JSONL. */
  readonly spawn?: PiSpawn;
}

export function createPiHarness(cwd: string, opts: PiHarnessOptions = {}): Harness {
  const spawn = opts.spawn ?? defaultSpawn;

  return {
    async run(task, runOpts) {
      const signal = runOpts?.signal;
      if (signal?.aborted) throw new AbortError();

      const schema = runOpts?.schema;
      const prompt = schema ? withInlinedSchema(task, schema) : task;
      const args = ["-p", "--mode", "json", "--no-session"];
      if (runOpts?.model) args.push("--model", runOpts.model);
      args.push(prompt);
      const proc = spawn(args, { cwd });

      const onAbort = () => proc.kill();
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        let text = "";
        let sawEnd = false;
        for await (const line of proc.stdout) {
          const event = parsePiEvent(line);
          if (event === null) continue;
          if (isAgentEnd(event)) sawEnd = true;
          const progress = toProgress(event);
          if (progress !== null) {
            runOpts?.onProgress?.(progress);
            if (progress.kind === "text") text += progress.text;
          }
        }

        const { exitCode, stderr } = await proc.done;
        // Abort wins over the (killed) exit code: report cancellation, not failure.
        if (signal?.aborted) throw new AbortError();
        if (exitCode !== 0) throw new Error(`pi failed (exit ${exitCode}): ${stderr.trim()}`);
        if (!sawEnd) throw new Error("pi produced no agent_end event (truncated stream)");

        const result: AgentResult = { ok: true, summary: text };
        return schema ? { ...result, output: parseStructuredText(text, schema) } : result;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    async listModels() {
      const proc = spawn(["--list-models"], { cwd });
      let out = "";
      for await (const line of proc.stdout) out += `${line}\n`;
      const { exitCode, stderr } = await proc.done;
      if (exitCode !== 0) {
        throw new Error(`pi --list-models failed (exit ${exitCode}): ${stderr.trim()}`);
      }
      return parseModels(out);
    },
  };
}
