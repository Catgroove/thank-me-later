import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "@tml/core";
import type { Finding } from "../src/review/synthesize.ts";
import {
  existingKeys,
  findingKey,
  findingMarker,
  findingThreadBody,
  isTmlThread,
  parseLocation,
  threadKey,
} from "../src/review/threads.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return { severity: "warning", action: "ask-user", title: "T", detail: "D", ...over };
}

function thread(over: Partial<ReviewThread> = {}): ReviewThread {
  return { id: "RT", body: "", resolved: false, comments: [], ...over };
}

describe("findingKey", () => {
  test("is stable across runs for the same path:line:title", () => {
    const f = finding({ title: "Confirm contract", location: "src/a.ts:12" });
    expect(findingKey(f)).toBe(findingKey({ ...f }));
  });

  test("differs when path/line/title differ", () => {
    const base = finding({ title: "x", location: "a.ts:1" });
    expect(findingKey(base)).not.toBe(findingKey({ ...base, title: "y" }));
    expect(findingKey(base)).not.toBe(findingKey({ ...base, location: "a.ts:2" }));
  });
});

describe("marker round-trip", () => {
  test("findingMarker embeds the key and threadKey reads it back", () => {
    const key = findingKey(finding({ location: "a.ts:1" }));
    const body = `${findingMarker(key)}\n\ndetail`;
    expect(threadKey(thread({ body }))).toBe(key);
  });

  test("isTmlThread is true only for marked threads", () => {
    expect(isTmlThread(thread({ body: findingMarker("k") }))).toBe(true);
    expect(isTmlThread(thread({ body: "a human comment" }))).toBe(false);
    expect(threadKey(thread({ body: "no marker" }))).toBe(null);
  });

  test("findingThreadBody carries the marker, a severity badge, title, and detail", () => {
    const f = finding({
      severity: "critical",
      title: "Confirm",
      detail: "intent?",
      location: "a.ts:3",
    });
    const body = findingThreadBody(f);
    expect(threadKey(thread({ body }))).toBe(findingKey(f));
    expect(body).toContain("🔴 **Critical**"); // severity surfaced per comment, CodeRabbit-style
    expect(body).toContain("Confirm");
    expect(body).toContain("intent?");
  });

  test("findingThreadBody badges each severity level", () => {
    expect(findingThreadBody(finding({ severity: "warning" }))).toContain("🟠 **Warning**");
    expect(findingThreadBody(finding({ severity: "nit" }))).toContain("🔵 **Nit**");
  });
});

describe("existingKeys", () => {
  test("collects keys from tml threads (open and resolved), ignoring others", () => {
    const k1 = findingKey(finding({ location: "a.ts:1", title: "A" }));
    const k2 = findingKey(finding({ location: "b.ts:2", title: "B" }));
    const threads = [
      thread({ id: "1", body: findingMarker(k1), resolved: false }),
      thread({ id: "2", body: findingMarker(k2), resolved: true }),
      thread({ id: "3", body: "a human thread" }),
    ];
    const keys = existingKeys(threads);
    expect(keys.has(k1)).toBe(true);
    expect(keys.has(k2)).toBe(true); // resolved still counts — never re-post a settled finding
    expect(keys.size).toBe(2);
  });
});

describe("parseLocation", () => {
  test("splits path:line", () => {
    expect(parseLocation("src/app.ts:42")).toEqual({ path: "src/app.ts", line: 42 });
  });
  test("null for missing or unparseable locations", () => {
    expect(parseLocation(undefined)).toBe(null);
    expect(parseLocation("src/app.ts")).toBe(null);
    expect(parseLocation("no line here")).toBe(null);
  });
});
