import { describe, expect, test } from "bun:test";
import {
  type Finding,
  type ReviewPass,
  parsePassResult,
  riskOf,
  summarize,
} from "../src/review/synthesize.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return { id: "finding:1", severity: "info", action: "no-op", title: "T", detail: "D", ...over };
}

describe("parsePassResult", () => {
  test("parses a well-formed result", () => {
    const r = parsePassResult({
      findings: [
        { severity: "warning", action: "auto-fix", title: "x", detail: "y", location: "a.ts:1" },
      ],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.location).toBe("a.ts:1");
  });

  test("omits an empty location", () => {
    const r = parsePassResult({
      findings: [{ severity: "info", action: "no-op", title: "t", detail: "d", location: "  " }],
    });
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
      parsePassResult({
        findings: [{ severity: "info", action: "no-op", title: "", detail: "d" }],
      }),
    ).toThrow();
  });

  test("constrains actions by severity", () => {
    expect(() =>
      parsePassResult({
        findings: [{ severity: "error", action: "no-op", title: "t", detail: "d" }],
      }),
    ).toThrow(/error and warning findings must be auto-fix or ask-user/);
    expect(() =>
      parsePassResult({
        findings: [{ severity: "info", action: "auto-fix", title: "t", detail: "d" }],
      }),
    ).toThrow(/info findings must be no-op/);
  });
});

describe("riskOf", () => {
  test("empty findings are low", () => expect(riskOf([])).toBe("low"));
  test("a warning is medium", () =>
    expect(riskOf([finding({ severity: "warning" })])).toBe("medium"));
  test("an error is high", () => expect(riskOf([finding({ severity: "error" })])).toBe("high"));
});

describe("summarize", () => {
  test("renders risk, non-empty sections, severity labels, and fixes; omits empty sections", () => {
    const passes: ReviewPass[] = [
      { title: "Empty review", result: { findings: [] } },
      {
        title: "Thermo-nuclear code quality review",
        result: {
          findings: [
            finding({ severity: "warning", title: "Scope creep", detail: "two features" }),
          ],
        },
      },
      {
        title: "Correctness & testing",
        result: {
          findings: [
            finding({
              severity: "error",
              action: "auto-fix",
              title: "NPE",
              detail: "null deref",
            }),
          ],
        },
      },
    ];
    const out = summarize(passes, "fixed the NPE");
    expect(out).toContain("**Risk: high**"); // error present
    expect(out).toContain("<details>"); // full breakdown is collapsible
    expect(out).toContain("### Thermo-nuclear code quality review");
    expect(out).toContain("Warning:");
    expect(out).toContain("Error:");
    expect(out).toContain("1 fixed"); // headline tally
    expect(out).toContain("~~"); // the auto-fixed error is struck through
    expect(out).toContain("(fixed)");
    expect(out).toContain("**Fixes applied:** fixed the NPE");
    expect(out).not.toContain("### Empty review"); // empty section omitted
  });

  test("ask-user findings are listed with a decision hint", () => {
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
    );
    expect(out).toContain("API shape");
    expect(out.toLowerCase()).toContain("needs your decision");
  });

  test("no findings at all renders a clean low-risk summary", () => {
    const out = summarize(
      [{ title: "Thermo-nuclear code quality review", result: { findings: [] } }],
      "",
    );
    expect(out).toContain("**Risk: low**");
    expect(out).toContain("No findings.");
  });
});
