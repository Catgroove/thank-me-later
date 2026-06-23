/** The message of a thrown value, falling back to its string form for non-Error throws. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
