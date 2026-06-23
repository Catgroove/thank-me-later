import { describe, expect, test } from "bun:test";
import { type Finding, parseReviewFindings, riskOf, summarize } from "../src/review/synthesize.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return { id: "finding:1", disposition: "nit", action: "no-op", title: "T", detail: "D", ...over };
}

describe("parseReviewFindings", () => {
  test("parses a well-formed result", () => {
    const findings = parseReviewFindings({
      findings: [
        {
          disposition: "should-fix",
          action: "auto-fix",
          title: "x",
          detail: "y",
          location: "a.ts:1",
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.location).toBe("a.ts:1");
  });

  test("omits an empty location", () => {
    const findings = parseReviewFindings({
      findings: [{ disposition: "nit", action: "no-op", title: "t", detail: "d", location: "  " }],
    });
    expect(findings[0]?.location).toBeUndefined();
  });

  test("throws on a non-object, missing findings, or bad enum/title", () => {
    expect(() => parseReviewFindings(null)).toThrow();
    expect(() => parseReviewFindings({})).toThrow();
    expect(() =>
      parseReviewFindings({
        findings: [{ disposition: "bogus", action: "no-op", title: "t", detail: "d" }],
      }),
    ).toThrow();
    expect(() =>
      parseReviewFindings({
        findings: [{ disposition: "nit", action: "no-op", title: "", detail: "d" }],
      }),
    ).toThrow();
  });

  test("constrains actions by disposition", () => {
    expect(() =>
      parseReviewFindings({
        findings: [{ disposition: "blocker", action: "no-op", title: "t", detail: "d" }],
      }),
    ).toThrow(/blocker and should-fix findings must be auto-fix or ask-user/);
    expect(() =>
      parseReviewFindings({
        findings: [{ disposition: "should-fix", action: "no-op", title: "t", detail: "d" }],
      }),
    ).toThrow(/blocker and should-fix findings must be auto-fix or ask-user/);
  });
});

describe("riskOf", () => {
  test("empty findings are low", () => expect(riskOf([])).toBe("low"));
  test("a should-fix is medium", () =>
    expect(riskOf([finding({ disposition: "should-fix" })])).toBe("medium"));
  test("a blocker is high", () =>
    expect(riskOf([finding({ disposition: "blocker" })])).toBe("high"));
});

describe("summarize", () => {
  test("renders risk, the findings breakdown, disposition labels, and fixes", () => {
    const findings = [
      finding({
        disposition: "should-fix",
        action: "auto-fix",
        title: "Scope creep",
        detail: "two",
      }),
      finding({ disposition: "blocker", action: "auto-fix", title: "NPE", detail: "null deref" }),
    ];
    const out = summarize(findings, "fixed the NPE");
    expect(out).toContain("**Risk: high**"); // blocker present
    expect(out).toContain("<details>"); // full breakdown is collapsible
    expect(out).toContain("Should fix:");
    expect(out).toContain("Blocker:");
    expect(out).toContain("2 still need an auto-fix"); // headline tally
    expect(out).toContain("**Fixes applied:** fixed the NPE");
  });

  test("ask-user findings are listed with a decision hint", () => {
    const out = summarize(
      [finding({ action: "ask-user", title: "API shape", detail: "confirm the contract" })],
      "",
    );
    expect(out).toContain("API shape");
    expect(out.toLowerCase()).toContain("needs your decision");
  });

  test("no findings at all renders a clean low-risk summary", () => {
    const out = summarize([], "");
    expect(out).toContain("**Risk: low**");
    expect(out).toContain("No findings.");
  });
});
