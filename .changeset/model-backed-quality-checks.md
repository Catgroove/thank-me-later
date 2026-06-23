---
"@tml/defaults": patch
"tml": patch
---

Run the default format and lint gates as model-backed source inspection instead of invoking repository quality toolchains during check rounds. Checks now carry an explicit inspect/run mode, so a gate that must execute its toolchain (typecheck, test) opts into running its command while format and lint stay read-only.
