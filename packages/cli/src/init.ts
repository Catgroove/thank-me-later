// `tml init` — scaffold a starter `tml.json`. Writes to the git project root (where the loader
// reads it, via the shared `findProjectRoot`), refusing to clobber an existing file unless
// `--force`. Knobs-only by design: the scaffold lists the common scalar selections; the
// array/object knobs (`models`/`disable`/`plugins`) are added by hand when needed — the
// `$schema` points editors at the full set.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "./error.ts";
import { findProjectRoot } from "./load.ts";

/** Seams, injected by tests; production uses the real filesystem and console. */
export interface InitDeps {
  /** Where to scaffold from; defaults to process.cwd(). The file lands at the git root above it. */
  cwd?: string;
  /** Overwrite an existing tml.json. */
  force?: boolean;
  /** Existence check for the target file; defaults to fs.existsSync. */
  exists?: (path: string) => boolean;
  /** File writer; defaults to fs.writeFileSync(…, "utf8"). */
  write?: (path: string, content: string) => void;
  /** Line sink for user-facing output; defaults to console.log. */
  log?: (line: string) => void;
  /** Error sink for failed scaffolding; defaults to console.error. */
  error?: (line: string) => void;
}

const FILENAME = "tml.json";

// The starter config. `$schema` points at the in-repo schema on `master` so editors get
// autocomplete with zero extra setup; the values are the defaults, written explicitly so a
// new user has a visible, editable starting point.
const STARTER = `{
  "$schema": "https://raw.githubusercontent.com/Catgroove/thank-me-later/master/packages/cli/schema/tml.schema.json",
  "harness": "pi",
  "gitProvider": "github",
  "branch": "ai"
}
`;

export async function init(deps: InitDeps = {}): Promise<number> {
  const cwd = deps.cwd ?? process.cwd();
  const exists = deps.exists ?? existsSync;
  const write = deps.write ?? ((path, content) => writeFileSync(path, content, "utf8"));
  const log = deps.log ?? ((line) => console.log(line));
  const error = deps.error ?? ((line) => console.error(line));

  try {
    const target = join(findProjectRoot(cwd), FILENAME);

    if (exists(target) && deps.force !== true) {
      log(`tml.json already exists at ${target}; use --force to overwrite.`);
      return 1;
    }

    write(target, STARTER);
    log(`✓ wrote ${target}`);
    log("Run `tml` to ship your work.");
    return 0;
  } catch (caught) {
    error(`tml init: ${errorMessage(caught)}`);
    return 1;
  }
}
