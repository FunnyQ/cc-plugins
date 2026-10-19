import { closeSync, openSync, readSync } from "node:fs";

const DEFAULT_CHUNK = 1 << 20;

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

export function splitCompleteLines(text: string): {
  complete: string[];
  partial: string;
} {
  const parts = text.split("\n");
  const partial = parts.pop() ?? "";
  return { complete: parts, partial };
}

export function nextCursor(
  prev: number,
  size: number,
): { from: number; reset: boolean } {
  if (size < prev) return { from: 0, reset: true };
  return { from: prev, reset: false };
}

export type TailState = {
  cursor: number;
  partial: string;
  decoder: TextDecoder;
};

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
