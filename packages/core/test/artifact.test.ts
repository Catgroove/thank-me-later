import { describe, expect, test } from "bun:test";
import { defineArtifact, type Produced } from "../src/artifact.ts";

describe("defineArtifact", () => {
  test("returns a token carrying its name", () => {
    const diff = defineArtifact<string>()("diff");
    expect(diff.name).toBe("diff");
  });

  test("the phantom value field is never present at runtime", () => {
    const diff = defineArtifact<string>()("diff");
    expect(Object.keys(diff)).toEqual(["name"]);
  });
});

// --- Type-level checks (compile-time). A wrong type here fails `tsc`. ---

type Expect<T extends true> = T;
type Equal<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

const diff = defineArtifact<string>()("diff");
const count = defineArtifact<number>()("count");

// The name is preserved as a literal, not widened to `string`.
export type _Name = Expect<Equal<typeof diff.name, "diff">>;

// The token carries the value type for inference.
export type _Value = Expect<Equal<NonNullable<(typeof diff)["_type"]>, string>>;

// `Produced` maps a tuple of tokens to a keyed object of their value types.
export type _Produced = Expect<
  Equal<Produced<[typeof diff, typeof count]>, { diff: string; count: number }>
>;

// Negative: the value types are real — `count` is a number, not a string, so
// this equality is false and `Expect` rejects it (the error is the proof).
// @ts-expect-error — Produced<count> is { count: number }, not { count: string }
export type _Neg = Expect<Equal<Produced<[typeof count]>, { count: string }>>;
