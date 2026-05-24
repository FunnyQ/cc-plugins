// Tests for the shared resilient SSE tailer. Drives createTailStream directly
// with a synthetic line-based source so the three resilience guarantees can be
// exercised in isolation: file appears later, watch() throws (poll fallback),
// and the file is atomically replaced then appended.
// Run: bun test packages/monitor/skills/cockpit/scripts/sse-tailer.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTailStream,
  splitCompleteLines,
  type ResolveResult,
  type TailSource,
  type WatchFn,
} from "./sse-tailer";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-tailer-")));
  // poll fast so fallback paths settle within the test timeout
  process.env.COCKPIT_RESOLVE_POLL_MS = "80";
  process.env.COCKPIT_TAIL_POLL_MS = "80";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.COCKPIT_RESOLVE_POLL_MS;
  delete process.env.COCKPIT_TAIL_POLL_MS;
});

// A minimal line-oriented source: every non-empty line becomes one SSE frame.
function lineSource(path: string, watch?: WatchFn): TailSource {
  return {
    resolve: (): ResolveResult => ({ kind: "ready", path }),
    readBacklog: (p, size) => {
      const buf = Buffer.allocUnsafe(size);
      const fd = openSync(p, "r");
      try {
        readSync(fd, buf, 0, size, 0);
      } finally {
        closeSync(fd);
      }
      return splitCompleteLines(buf.toString("utf-8"));
    },
    emit: (enqueue, text) => {
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (t) enqueue(`data: ${t}\n\n`);
      }
    },
    watch,
  };
}

async function collect(
  res: Response,
  predicate: (buf: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("timeout")), timeoutMs),
  );
  try {
    while (true) {
      const { value, done } = (await Promise.race([
        reader.read(),
        timeout,
      ])) as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      if (value)
        buf +=
          typeof value === "string"
            ? value
            : dec.decode(value as Uint8Array, { stream: true });
      if (predicate(buf)) break;
    }
  } catch {
    // timeout — return whatever accumulated
  } finally {
    await reader.cancel().catch(() => {});
  }
  return buf;
}

describe("createTailStream", () => {
  test("a hard resolve failure becomes an HTTP error, not a stream", () => {
    const res = createTailStream({
      resolve: () => ({ kind: "fail", message: "nope", status: 403 }),
      readBacklog: () => ({ complete: "", partial: "" }),
      emit: () => {},
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  // Resilience case 1
  test("a file that appears after connect still streams its backlog", async () => {
    const path = join(dir, "later.jsonl");
    const res = createTailStream(lineSource(path));
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const buf = await collect(res, (b) => {
      if (!b.includes("appeared")) writeFileSync(path, "appeared\n");
      return b.includes("backlog-done");
    });
    expect(buf).toContain("appeared");
    expect(buf).toContain("backlog-done");
  });

  // Resilience case 2: fs.watch is unreliable / fails to attach. The low-freq
  // poll must still deliver appends.
  test("appends are delivered via poll when watch() throws", async () => {
    const path = join(dir, "nowatch.jsonl");
    writeFileSync(path, "first\n");
    const throwingWatch: WatchFn = () => {
      throw new Error("watch unavailable");
    };
    const res = createTailStream(lineSource(path, throwingWatch));
    const buf = await collect(res, (b) => {
      if (b.includes("backlog-done") && !b.includes("second")) {
        appendFileSync(path, "second\n");
      }
      return b.includes("second");
    });
    expect(buf).toContain("first"); // backlog
    expect(buf).toContain("second"); // delivered without any working watcher
  });

  // Resilience case 3: atomic replace gives the path a new inode. The cursor
  // must reset and re-tail the new file rather than getting stuck.
  test("re-tails after the file is atomically replaced then appended", async () => {
    const path = join(dir, "rotated.jsonl");
    writeFileSync(path, "one\n");
    const res = createTailStream(lineSource(path));
    let replaced = false;
    const buf = await collect(
      res,
      (b) => {
        if (!replaced && b.includes("one")) {
          replaced = true;
          // atomic replace: write a sibling then rename over the path → new inode
          const tmp = join(dir, "rotated.tmp");
          writeFileSync(tmp, "two\n");
          renameSync(tmp, path);
          appendFileSync(path, "three\n");
        }
        return b.includes("three");
      },
      4000,
    );
    expect(buf).toContain("two"); // content of the replacement file
    expect(buf).toContain("three"); // append after replacement
  });
});
