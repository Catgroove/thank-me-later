import { describe, expect, test } from "bun:test";
import {
  type Finding,
  type ReviewPass,
  parsePassResult,
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
    const out = summarize([{ title: "Context & intent", result: { findings: [] } }], "");
    expect(out).toContain("**Risk: low**");
    expect(out).toContain("No findings.");
  });
});
