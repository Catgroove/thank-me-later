// @tml/defaults — the blessed default pipeline, shipped as just another Plugin
// built on the same primitives (ARCHITECTURE.md). The real
// branch → format → lint → typecheck → test → review → open-pr → ci-wait
// pipeline lands in a later spec. Placeholder export keeps the package valid.
export const PACKAGE = "@tml/defaults" as const;
