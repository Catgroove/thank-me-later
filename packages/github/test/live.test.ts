// Opt-in live smoke: the only test that touches real `gh`. Skipped unless
// TML_GH_LIVE=1, so the default suite stays network-/auth-free. Run it inside an
// authenticated `gh` GitHub checkout to catch `gh` argv / JSON drift the canned
// fixtures can't:  TML_GH_LIVE=1 bun test github
//
// It exercises the read path only (no PR is opened): findPullRequest threads real
// `gh pr list` + the GraphQL snapshot through the mappers.

import { describe, expect, test } from "bun:test";

import { createGitHubForge } from "../src/forge.ts";

const LIVE = process.env.TML_GH_LIVE === "1";

if (!LIVE) {
  console.log(
    "[live.test] skipped — set TML_GH_LIVE=1 (authenticated gh, inside a GitHub repo) to exercise the real findPullRequest read path (gh pr list + GraphQL snapshot + mapping).",
  );
}

describe("live gh smoke (opt-in)", () => {
  test.skipIf(!LIVE)(
    "findPullRequest resolves against the cwd repo without side effects",
    async () => {
      const forge = createGitHubForge(process.cwd());
      const pr = await forge.findPullRequest("main");
      if (pr !== null) {
        expect(typeof pr.number).toBe("number");
        expect(pr.url).toContain("/pull/");
        expect(["open", "closed", "merged"]).toContain(pr.state);
      }
    },
  );
});
