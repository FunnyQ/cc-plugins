import { closeSync, openSync, readSync } from "node:fs";

const DEFAULT_CHUNK = 1 << 20;

/**
 * Read a byte range in bounded chunks. Yields fewer bytes than asked when the
 * file shrank mid-read, nothing at all for an empty range.
 *
 * Chunked because `size - from` is bounded by nothing: `nextCursor` resets to 0
 * on a truncated or replaced file, and a cold pass starts there, so the range is
 * routinely the whole file. Chunks are freshly allocated, so a caller may hold
 * one past the next iteration.
 */
export function* readRangeChunks(
  path: string,
  from: number,
  size: number,
  chunkSize: number = DEFAULT_CHUNK,
): Generator<Uint8Array> {
  const total = size - from;
  if (total <= 0) return;

  const descriptor = openSync(path, "r");
  try {
    let read = 0;
    while (read < total) {
      const want = Math.min(chunkSize, total - read);
      const bytes = Buffer.allocUnsafe(want);
      const count = readSync(descriptor, bytes, 0, want, from + read);
      if (count === 0) break;
      read += count;
      yield bytes.subarray(0, count);
    }
  } finally {
    closeSync(descriptor);
  }
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

/** The bookkeeping `tailFileChunks` owns; a caller adds its own domain fields. */
export type TailState = {
  cursor: number;
  partial: string;
  decoder: TextDecoder;
};

/**
 * Tail `file` from `state.cursor` to `size`, calling `onReset` first when the
 * file was truncated or replaced.
 *
 * Shared for two orderings invisible at the call site that both fail silently:
 * the generator opens lazily, so the first chunk is pulled before `onReset` (an
 * unopenable file must not clear state it will never refill); and `cursor`
 * advances per chunk, since `onLine` already has those lines.
 */
export function tailFileChunks<S extends TailState>(
  file: string,
  state: S,
  size: number,
  onReset: (state: S) => void,
  onLine: (state: S, line: string) => void,
  chunkSize?: number, // Only tests need to set this.
): void {
  const next = nextCursor(state.cursor, size);
  const from = next.reset ? 0 : next.from;
  if (size <= from) return; // Nothing new since the last pass.

  const chunks = readRangeChunks(file, from, size, chunkSize);
  const firstChunk = chunks.next();

  if (next.reset) {
    state.partial = "";
    state.decoder.decode(); // Flush pending multi-byte state from the old content.
    onReset(state);
  }

  let consumed = from;
  for (let step = firstChunk; !step.done; step = chunks.next()) {
    const text = state.decoder.decode(step.value, { stream: true });
    const { complete, partial } = splitCompleteLines(state.partial + text);
    state.partial = partial;
    consumed += step.value.length;
    state.cursor = consumed;

    for (const line of complete) onLine(state, line);
  }
}
