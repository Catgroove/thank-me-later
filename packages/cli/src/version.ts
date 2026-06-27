// The binary's own version and the GitHub repo it ships from. `bun build --compile` inlines this
// JSON import at build time, freezing the version the release was cut at (the release workflow bumps
// `package.json` before compiling, so the frozen value is correct). `REPO` is the single slug shared
// by the releases URL (update check) and the installer URL (`tml update`); it mirrors `install.sh`.

import pkg from "../package.json";

export const VERSION: string = pkg.version;
export const REPO = "Catgroove/thank-me-later";
