// The local RoundRecord journal. It is append-only JSONL under the same out-of-tree state root
// described for the Checkpoint journal, keyed by checkout path so clones do not collide.

import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RoundRecord } from "./round.ts";

export interface RoundJournal {
  append(record: RoundRecord): Promise<void>;
}

export function roundJournalPath(cwd: string): string {
  const key = createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
  return join(homedir(), ".local", "state", "tml", key, "rounds.jsonl");
}

export function createFileRoundJournal(cwd: string): RoundJournal {
  const path = roundJournalPath(cwd);
  return {
    async append(record) {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
    },
  };
}
