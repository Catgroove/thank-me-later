// Artifact tokens — the typed handles Steps declare and read.
//
// `defineArtifact` *declares* an artifact (its name + value type); a Step
// *produces its value* at runtime. Steps reference artifacts by token, never by
// the producing Step's identity, so plugins stay decoupled.

/**
 * A typed handle to a named value that flows between Steps. Carries the
 * artifact's `name` as a literal type and, phantom-only, its value type — the
 * literal name is what lets {@link Produced} compute a keyed object.
 */
export interface Artifact<T, Name extends string = string> {
  readonly name: Name;
  /** Phantom: makes the value type inferrable. Never present at runtime. */
  readonly _type?: T;
}

/**
 * Declare an artifact. Curried so the value type is given explicitly while the
 * name literal is inferred — TypeScript cannot partially infer type arguments,
 * so a single call would force you to spell the name twice:
 *
 *     const diff = defineArtifact<string>()("diff");   // Artifact<string, "diff">
 */
export function defineArtifact<T>(): <const Name extends string>(name: Name) => Artifact<T, Name> {
  return (name) => ({ name });
}

/**
 * The record a Step returns: one key per produced artifact, each typed by its
 * token.
 *
 *     Produced<[Artifact<string, "diff">, Artifact<number, "n">]>
 *       === { diff: string; n: number }
 */
export type Produced<P extends readonly Artifact<unknown, string>[]> = {
  [A in P[number] as A["name"]]: A extends Artifact<infer T, string> ? T : never;
};
