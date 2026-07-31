/** Split a chunk into complete lines and the trailing partial remainder. */
export function splitCompleteLines(text: string): {
  complete: string[];
  partial: string;
} {
  const parts = text.split("\n");
  const partial = parts.pop() ?? "";
  return { complete: parts, partial };
}

/**
 * Decide how to advance after a stat. A file smaller than the cursor means it was
 * truncated or replaced, so the cursor resets to zero and the whole file is re-read.
 */
export function nextCursor(
  prev: number,
  size: number,
): { from: number; reset: boolean } {
  if (size < prev) return { from: 0, reset: true };
  return { from: prev, reset: false };
}
