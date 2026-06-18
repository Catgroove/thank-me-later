import { describe, expect, test } from "bun:test";
import {
  type Finding,
  type ReviewPass,
  parsePassResult,
  replaceReviewBlock,
  reviewBlock,
  riskOf,
  summarize,
} from "../src/review/synthesize.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return { severity: "nit", action: "no-op", title: "T", detail: "D", ...over };
}

describe("parsePassResult", () => {
  test("parses a well-formed result and keeps optional fields", () => {
    const r = parsePassResult({
      findings: [
        { severity: "warning", action: "auto-fix", title: "x", detail: "y", location: "a.ts:1" },
      ],
      understanding: "does X",
      verdict: "proceed",
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.location).toBe("a.ts:1");
    expect(r.understanding).toBe("does X");
    expect(r.verdict).toBe("proceed");
  });

  test("omits empty optional fields", () => {
    const r = parsePassResult({
      findings: [{ severity: "nit", action: "no-op", title: "t", detail: "d", location: "  " }],
      understanding: "   ",
    });
    expect(r.understanding).toBeUndefined();
    expect(r.verdict).toBeUndefined();
    expect(r.findings[0]?.location).toBeUndefined();
  });

  test("throws on a non-object, missing findings, or bad enum/title", () => {
    expect(() => parsePassResult(null)).toThrow();
    expect(() => parsePassResult({})).toThrow();
    expect(() =>
      parsePassResult({
        findings: [{ severity: "bogus", action: "no-op", title: "t", detail: "d" }],
      }),
    ).toThrow();
    expect(() =>
      parsePassResult({ findings: [{ severity: "nit", action: "no-op", title: "", detail: "d" }] }),
    ).toThrow();
    expect(() => parsePassResult({ findings: [], verdict: "blocked" })).toThrow();
  });
});

describe("riskOf", () => {
  test("empty findings are low", () => expect(riskOf([])).toBe("low"));
  test("a warning is medium", () =>
    expect(riskOf([finding({ severity: "warning" })])).toBe("medium"));
  test("a critical is high", () =>
    expect(riskOf([finding({ severity: "critical" })])).toBe("high"));
  test("a block forces high even with no findings", () => expect(riskOf([], true)).toBe("high"));
});

describe("summarize", () => {
  test("renders risk, non-empty sections, severity labels, and fixes; omits empty sections", () => {
    const passes: ReviewPass[] = [
      { title: "Context & intent", result: { findings: [] } },
      {
        title: "Architecture & scope",
        result: {
          findings: [
            finding({ severity: "warning", title: "Scope creep", detail: "two features" }),
          ],
          verdict: "proceed",
        },
      },
      {
        title: "Correctness & testing",
        result: {
          findings: [
            finding({
              severity: "critical",
              action: "auto-fix",
              title: "NPE",
              detail: "null deref",
            }),
          ],
        },
      },
    ];
    const out = summarize(passes, "fixed the NPE");
    expect(out).toContain("**Risk: high**"); // critical present
    expect(out).toContain("<details>"); // full breakdown is collapsible
    expect(out).toContain("### Architecture & scope");
    expect(out).toContain("Warning:");
    expect(out).toContain("Critical:");
    expect(out).toContain("✅ 1 fixed"); // headline tally
    expect(out).toContain("~~"); // the auto-fixed critical is struck through
    expect(out).toContain("✅ fixed");
    expect(out).toContain("**Fixes applied:** fixed the NPE");
    expect(out).not.toContain("### Context & intent"); // empty section omitted
  });

  test("a block verdict adds a banner and forces high risk", () => {
    const out = summarize(
      [{ title: "Architecture & scope", result: { findings: [], verdict: "block" } }],
      "",
    );
    expect(out.toLowerCase()).toContain("blocking concern");
    expect(out).toContain("**Risk: high**");
    expect(out).toContain("### Architecture & scope");
    expect(out).toContain("Blocking verdict returned without specific findings");
    expect(out).not.toContain("**Fixes applied:**"); // nothing fixed → line omitted
  });

  test("ask-user findings are not listed (they become threads); openThreads drives the tally", () => {
    const out = summarize(
      [
        {
          title: "Design & non-functional",
          result: {
            findings: [
              finding({ action: "ask-user", title: "API shape", detail: "confirm the contract" }),
            ],
          },
        },
      ],
      "",
      2, // two open threads need a decision
    );
    expect(out).toContain("2 threads need your decision"); // tally is driven by the thread count
    expect(out).not.toContain("API shape"); // but the finding itself is not rendered
    expect(out).not.toContain("### Design & non-functional"); // the otherwise-empty section is dropped
  });

  test("unthreaded ask-user findings are listed in the full review", () => {
    const unthreaded = finding({
      action: "ask-user",
      title: "API shape",
      detail: "confirm the contract",
    });
    const out = summarize(
      [{ title: "Design & non-functional", result: { findings: [unthreaded] } }],
      "",
      0,
      [unthreaded],
    );
    expect(out).toContain("### Design & non-functional");
    expect(out).toContain("API shape");
    expect(out).toContain("confirm the contract");
  });

  test("the decision tally is singular for one open thread and absent for none", () => {
    const passes: ReviewPass[] = [{ title: "Context & intent", result: { findings: [] } }];
    expect(summarize(passes, "", 1)).toContain("1 thread needs your decision");
    expect(summarize(passes, "", 0)).not.toContain("your decision");
  });

  test("no findings at all renders a clean low-risk summary", () => {
    const out = summarize([{ title: "Context & intent", result: { findings: [] } }], "");
    expect(out).toContain("**Risk: low**");
    expect(out).toContain("No findings.");
  });
});

describe("review block helpers", () => {
  test("reviewBlock wraps the summary in the delimited region", () => {
    const block = reviewBlock("**Risk: low**");
    expect(block).toBe("<!-- tml:review -->\n**Risk: low**\n<!-- /tml:review -->");
  });

  test("replaceReviewBlock appends when the body has no block yet", () => {
    const out = replaceReviewBlock("Just prose.", reviewBlock("HEADLINE"));
    expect(out).toBe("Just prose.\n\n<!-- tml:review -->\nHEADLINE\n<!-- /tml:review -->");
  });

  test("replaceReviewBlock appends to an empty body without leading whitespace", () => {
    expect(replaceReviewBlock("", reviewBlock("X"))).toBe(
      "<!-- tml:review -->\nX\n<!-- /tml:review -->",
    );
  });

  test("replaceReviewBlock swaps only the delimited region, keeping surrounding prose", () => {
    const body = "Before.\n\n<!-- tml:review -->old<!-- /tml:review -->\n\nAfter.";
    const out = replaceReviewBlock(body, reviewBlock("new"));
    expect(out).toContain("Before.");
    expect(out).toContain("After.");
    expect(out).not.toContain("old");
    expect(out).toContain("<!-- tml:review -->\nnew\n<!-- /tml:review -->");
    expect(out.match(/<!-- tml:review -->/g)).toHaveLength(1);
  });
});
