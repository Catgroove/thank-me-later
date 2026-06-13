import { describe, expect, test } from "bun:test";
import { parseStructuredText, withInlinedSchema } from "../src/schema.ts";
import { SCHEMA_BARE_TEXT, SCHEMA_FENCED_TEXT } from "./fixtures.ts";

const schema = {
  type: "object",
  required: ["ok", "count"],
  properties: { ok: { type: "boolean" }, count: { type: "number" } },
};

describe("withInlinedSchema", () => {
  test("appends the schema and a JSON-only instruction to the task", () => {
    const prompt = withInlinedSchema("review the diff", schema);
    expect(prompt).toContain("review the diff");
    expect(prompt).toContain(JSON.stringify(schema));
    expect(prompt.toLowerCase()).toContain("json");
  });
});

describe("parseStructuredText", () => {
  test("parses a fenced ```json block", () => {
    expect(parseStructuredText(SCHEMA_FENCED_TEXT, schema)).toEqual({ ok: true, count: 2 });
  });

  test("parses a bare JSON object that follows prose", () => {
    expect(parseStructuredText(SCHEMA_BARE_TEXT, schema)).toEqual({ ok: false, count: 0 });
  });

  test("prefers the fenced block, and picks the last bare object otherwise", () => {
    const text = 'first {"ok":true} then the real answer {"ok":false,"count":9}';
    expect(parseStructuredText(text, schema)).toEqual({ ok: false, count: 9 });
  });

  test("throws when no JSON object is present", () => {
    expect(() => parseStructuredText("no json here, sorry", schema)).toThrow(/no schema-valid/);
  });

  test("throws when JSON is present but missing a required field", () => {
    expect(() => parseStructuredText('{"ok":true}', schema)).toThrow(/missing required field/);
  });
});
