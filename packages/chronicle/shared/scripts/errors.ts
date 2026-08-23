/** Narrows an unknown catch binding to the string a result payload can carry. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
