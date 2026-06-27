// @tml/pi — the pi Harness Provider: implements core's `Harness` by shelling out
// to `pi --mode json`, the symmetric analogue of `@tml/github`'s Git provider over `gh`
// (spec 0005). The Harness streams (Promise + onProgress); only the
// Git provider polls. pi is also an extensible "everything is a plugin" host, so this
// package MAY later add an Adapter (trigger + event-stream rendering) — a separate,
// deferred role. ACP is a future *additional* backend, not the boundary.

export { createPiHarness, type PiHarnessOptions } from "./harness.ts";
export type { PiProcess, PiSpawn, PiWhich } from "./spawn.ts";
