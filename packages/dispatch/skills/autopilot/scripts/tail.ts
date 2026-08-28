import { closeSync, openSync, readSync } from "node:fs";

/** Read a byte range out of a file. Returns fewer bytes than asked when the file shrank mid-read. */
export function readRange(
  path: string,
  from: number,
  size: number,
): Uint8Array {
  const bytes = Buffer.allocUnsafe(size - from);
  const descriptor = openSync(path, "r");
  let offset = 0;
  try {
    while (offset < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        offset,
        bytes.length - offset,
        from + offset,
      );
      if (count === 0) break;
      offset += count;
    }
  } finally {
    closeSync(descriptor);
  }
  return bytes.subarray(0, offset);
}

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
