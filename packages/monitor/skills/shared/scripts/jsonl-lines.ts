// Line reader for the JSONL transcripts. Whole-file reads are unsurvivable
// here: transcripts reach 2.4 GB, and materialising one fails differently per
// machine — an uncatchable bun assertion, ENOMEM, or a silently empty decode.
// Sync because `updateRollup` and its four callers are.
import { closeSync, openSync, readSync } from "node:fs";

/** Byte offset consumed through the last *complete* line. */
export type LineCursor = { bytesConsumed: number };

export type JsonlLinesOptions = {
  /** Must sit on a line boundary. */
  start?: number;
  /** Only tests need to set this. */
  chunkSize?: number;
  /**
   * Default `true` matches the `split("\n")` this replaced; dropping the
   * unterminated tail would under-count tokens rather than raise. The rollup
   * ingest passes `false` so a half-written line waits for the next run.
   */
  emitPartial?: boolean;
  /** `for..of` swallows a return value, so the boundary comes back here. */
  cursor?: LineCursor;
};

const DEFAULT_CHUNK = 1 << 20;
const NEWLINE = 0x0a;

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * Yield the file's lines, holding at most one chunk plus the current line.
 * A missing or unreadable file yields nothing.
 *
 * Split on `0x0a` in the Buffer and decode each line after: `0x0a` never occurs
 * inside a UTF-8 multibyte sequence, so decoding per chunk instead would corrupt
 * any character straddling a chunk edge.
 */
export function* readJsonlLines(
  file: string,
  opts: JsonlLinesOptions = {},
): Generator<string> {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  const start = opts.start ?? 0;
  const emitPartial = opts.emitPartial ?? true;
  const cursor = opts.cursor;
  if (cursor) cursor.bytesConsumed = start;

  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return;
  }

  try {
    const chunk = Buffer.allocUnsafe(chunkSize);
    // Joined once per line, not per chunk: the latter makes a long line quadratic.
    const carry: Buffer[] = [];
    let carryLen = 0;
    let pos = start;
    let consumed = start;

    for (;;) {
      let n: number;
      try {
        n = readSync(fd, chunk, 0, chunkSize, pos);
      } catch {
        break;
      }
      if (n <= 0) break;
      pos += n;

      // allocUnsafe: past `n` the chunk still holds the previous read's bytes.
      const view = chunk.subarray(0, n);
      let from = 0;
      for (;;) {
        const nl = view.indexOf(NEWLINE, from);
        if (nl === -1) break;
        const len = nl - from;
        let line: string;
        if (carryLen > 0) {
          // Consumed before the next read, so the view needs no copy out of `chunk`.
          carry.push(view.subarray(from, nl));
          line = Buffer.concat(carry, carryLen + len).toString("utf-8");
          consumed += carryLen + len + 1;
          carry.length = 0;
          carryLen = 0;
        } else {
          line = view.toString("utf-8", from, nl);
          consumed += len + 1;
        }
        if (cursor) cursor.bytesConsumed = consumed;
        yield stripCr(line);
        from = nl + 1;
      }

      if (from < n) {
        // Survives into the next read, so it must be copied out of `chunk`.
        const rest = Buffer.from(view.subarray(from, n));
        carry.push(rest);
        carryLen += rest.length;
      }
    }

    if (carryLen > 0 && emitPartial) {
      const line = Buffer.concat(carry, carryLen).toString("utf-8");
      consumed += carryLen;
      if (cursor) cursor.bytesConsumed = consumed;
      yield stripCr(line);
    }
  } finally {
    closeSync(fd);
  }
}
