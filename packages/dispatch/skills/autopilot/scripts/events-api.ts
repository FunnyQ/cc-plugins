import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import { dirname } from "node:path";
import { parseLog } from "../../flightplan/scripts/lib/flightlog";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import { aggregateFleet } from "./fleet";
import { nextCursor, splitCompleteLines } from "./tail";

const SNAPSHOT_DEBOUNCE_MS = 250;
const POLL_MS = 2_000;
const HEARTBEAT_MS = 25_000;

export type FleetSnapshot = {
  rows: ReturnType<typeof aggregateFleet>;
  entryCount: number;
  logPresent: boolean;
};

export type Debouncer = {
  schedule: () => void;
  cancel: () => void;
};

export function formatFleetFrame(
  entries: FlightlogEntry[],
  logPresent: boolean,
): string {
  const payload: FleetSnapshot = {
    rows: aggregateFleet(entries),
    entryCount: entries.length,
    logPresent,
  };
  return `event: fleet\ndata: ${JSON.stringify(payload)}\n\n`;
}

export function decodeLogChunk(
  decoder: TextDecoder,
  bytes: Uint8Array,
  heldPartial: string,
): { entries: FlightlogEntry[]; partial: string } {
  const text = heldPartial + decoder.decode(bytes, { stream: true });
  const { complete, partial } = splitCompleteLines(text);
  return { entries: parseLog(complete.join("\n")), partial };
}

export function createDebouncer(callback: () => void, delay: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule() {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        callback();
      }, delay);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

export function eventsHandler(
  request: Request,
  planDir: string,
  logPath: string,
): Response {
  void planDir;
  let fileWatcher: FSWatcher | null = null;
  let directoryWatcher: FSWatcher | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let cursor = 0;
  let inode: number | null = null;
  let heldPartial = "";
  let entries: FlightlogEntry[] = [];
  let logPresent = false;
  const decoder = new TextDecoder();
  let cleanupStream = (): void => {};

  const stream = new ReadableStream<string>({
    start(controller) {
      let initializing = true;
      const enqueue = (frame: string): void => {
        if (closed) return;
        try {
          controller.enqueue(frame);
        } catch {
          cleanup();
        }
      };
      const emitSnapshot = (): void => {
        enqueue(formatFleetFrame(entries, logPresent));
      };
      const debounce = createDebouncer(emitSnapshot, SNAPSHOT_DEBOUNCE_MS);

      function cleanup(): void {
        if (closed) return;
        closed = true;
        fileWatcher?.close();
        directoryWatcher?.close();
        fileWatcher = null;
        directoryWatcher = null;
        if (poll !== null) clearInterval(poll);
        if (heartbeat !== null) clearInterval(heartbeat);
        poll = null;
        heartbeat = null;
        debounce.cancel();
        entries = [];
        request.signal.removeEventListener("abort", cleanup);
      }
      cleanupStream = cleanup;

      const attachFileWatcher = (): void => {
        fileWatcher?.close();
        fileWatcher = null;
        if (!existsSync(logPath)) return;
        try {
          fileWatcher = fsWatch(logPath, checkFile);
        } catch {
          // The poll remains active when a platform cannot watch this file.
        }
      };

      const attachDirectoryWatcher = (): void => {
        if (directoryWatcher !== null) return;
        try {
          directoryWatcher = fsWatch(dirname(logPath), checkFile);
        } catch {
          // The poll retries after the flightlog directory appears.
        }
      };

      function resetTail(): void {
        cursor = 0;
        heldPartial = "";
        entries = [];
        decoder.decode();
      }

      function readRange(from: number, size: number): Uint8Array {
        const bytes = Buffer.allocUnsafe(size - from);
        const descriptor = openSync(logPath, "r");
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

      function checkFile(): void {
        if (closed) return;
        attachDirectoryWatcher();

        if (!existsSync(logPath)) {
          if (logPresent) {
            logPresent = false;
            inode = null;
            resetTail();
            fileWatcher?.close();
            fileWatcher = null;
            if (!initializing) debounce.schedule();
          }
          return;
        }

        try {
          const stat = statSync(logPath);
          const replaced = inode !== null && stat.ino !== inode;
          const next = nextCursor(cursor, stat.size);
          const reset = replaced || next.reset;
          if (reset) {
            resetTail();
            attachFileWatcher();
          }

          const wasPresent = logPresent;
          logPresent = true;
          inode = stat.ino;
          const from = reset ? 0 : next.from;
          if (stat.size > from) {
            const bytes = readRange(from, stat.size);
            const decoded = decodeLogChunk(decoder, bytes, heldPartial);
            entries.push(...decoded.entries);
            heldPartial = decoded.partial;
            cursor = stat.size;
            if (!initializing) debounce.schedule();
          } else if (!wasPresent || reset) {
            if (!initializing) debounce.schedule();
          }

          if (fileWatcher === null) attachFileWatcher();
        } catch {
          // A concurrent append or replacement is retried by the next signal.
        }
      }

      request.signal.addEventListener("abort", cleanup, { once: true });
      attachDirectoryWatcher();
      checkFile();
      emitSnapshot();
      initializing = false;
      poll = setInterval(checkFile, POLL_MS);
      heartbeat = setInterval(() => enqueue(":heartbeat\n\n"), HEARTBEAT_MS);
    },
    cancel() {
      cleanupStream();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
