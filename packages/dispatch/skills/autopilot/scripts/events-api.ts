import {
  existsSync,
  statSync,
  watch as fsWatch,
  type FSWatcher,
} from "node:fs";
import { dirname } from "node:path";
import { parseLines } from "../../flightplan/scripts/lib/flightlog";
import type { FlightlogEntry } from "../../flightplan/scripts/lib/flightlog";
import { aggregateFleet } from "./fleet";
import { nextCursor, readRange, splitCompleteLines } from "./tail";
import { attributeUsage } from "./usage-attribute";
import { createTranscriptSource, type TranscriptSource } from "./usage-source";
import type { AgentUsage, UsageRollup } from "./usage-types";

const SNAPSHOT_DEBOUNCE_MS = 250;
const POLL_MS = 2_000;
const HEARTBEAT_MS = 25_000;

export type FleetSnapshot = {
  rows: ReturnType<typeof aggregateFleet>;
  entryCount: number;
  logPresent: boolean;
  /**
   * Plan-wide token rollup. Always present; every counter is 0 and
   * `agentCount` is 0 when no transcript was found.
   */
  usage: UsageRollup;
};

export type Debouncer = {
  schedule: () => void;
  cancel: () => void;
};

export function formatFleetFrame(
  entries: FlightlogEntry[],
  logPresent: boolean,
  agents: AgentUsage[],
): string {
  const attributed = attributeUsage(aggregateFleet(entries), agents);
  const payload: FleetSnapshot = {
    rows: attributed.rows,
    entryCount: entries.length,
    logPresent,
    usage: attributed.rollup,
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
  return { entries: parseLines(complete), partial };
}

export function createDebouncer(
  callback: () => void,
  delay: number,
): Debouncer {
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
  logPath: string,
  planDir: string,
  options?: { projectsRoot?: string; source?: TranscriptSource },
): Response {
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
  // Created once per stream, never per snapshot: its cursors are what make each
  // re-read incremental. Two open tabs get two sources with independent cursors.
  const usageSource =
    options?.source ?? createTranscriptSource(planDir, options?.projectsRoot);

  function readAgents(): AgentUsage[] {
    try {
      return usageSource.read();
    } catch {
      // A broken token panel must not take the fleet panel down with it.
      return [];
    }
  }

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
        // Affordable only because `read()` is incremental: an unchanged transcript
        // costs one `stat` and zero bytes read. A source that re-parsed a whole
        // file per call would turn this 250ms debounce into a repeated full scan
        // of every transcript the plan ever produced.
        enqueue(formatFleetFrame(entries, logPresent, readAgents()));
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
          const grew = stat.size > from;
          if (grew) {
            const bytes = readRange(logPath, from, stat.size);
            const decoded = decodeLogChunk(decoder, bytes, heldPartial);
            entries.push(...decoded.entries);
            heldPartial = decoded.partial;
            cursor = stat.size;
          }
          if ((grew || !wasPresent || reset) && !initializing) {
            debounce.schedule();
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
