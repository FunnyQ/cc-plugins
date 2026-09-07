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

// Every synthetic source below reads its file whole; only the windowing and the
// metadata on top of it differ per test.
function readWholeSync(path: string, size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  return buf;
}

// A minimal line-oriented source: every non-empty line becomes one SSE frame.
function lineSource(path: string, watch?: WatchFn): TailSource {
  return {
    resolve: (): ResolveResult => ({ kind: "ready", path }),
    readBacklog: (p, size) => {
      const buf = readWholeSync(p, size);
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

  // Reset used to bypass readBacklog and read the file whole, which both blew
  // the string limit on a rotated multi-GB transcript and would have replayed
  // every line to the client.
  test("reset 走 readBacklog，不自己整檔重讀", async () => {
    const path = join(dir, "bounded.jsonl");
    writeFileSync(path, "one\n");

    // Bounded to the last line: anything earlier reaching the client means the
    // reset read the file itself.
    let backlogCalls = 0;
    const source: TailSource = {
      resolve: (): ResolveResult => ({ kind: "ready", path }),
      readBacklog: (p, size) => {
        backlogCalls += 1;
        const buf = readWholeSync(p, size);
        const all = buf.toString("utf-8").split("\n").filter(Boolean);
        return { complete: all.slice(-1).join("\n"), partial: "" };
      },
      emit: (enqueue, text) => {
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (t) enqueue(`data: ${t}\n\n`);
        }
      },
    };

    const res = createTailStream(source);
    let replaced = false;
    let appended = false;
    const buf = await collect(
      res,
      (b) => {
        // Staged: appending before the reset backlog is read would make the
        // appended line the last one, and the assertion would pass vacuously.
        if (!replaced && b.includes("one")) {
          replaced = true;
          const tmp = join(dir, "bounded.tmp");
          writeFileSync(tmp, "skipped-a\nskipped-b\nlast-of-replacement\n");
          renameSync(tmp, path);
          return false;
        }
        if (replaced && !appended && b.includes("last-of-replacement")) {
          appended = true;
          appendFileSync(path, "appended\n");
        }
        return b.includes("appended");
      },
      4000,
    );

    expect(backlogCalls).toBeGreaterThan(1); // attach, then again for the reset
    expect(buf).toContain("last-of-replacement"); // the bounded backlog
    expect(buf).toContain("appended"); // normal tailing resumes after
    expect(buf).not.toContain("skipped-a"); // never read outside the bound
    expect(buf).not.toContain("skipped-b");
  });

  // A reset that reads is a reset that can fail. Committing `inode` before the
  // read means the next poll no longer sees a replacement, so it resumes at the
  // old file's offset and skips past the head of the new one — the lines are
  // gone with nothing raised. Nothing may move until the read returns.
  test("readBacklog 失敗時整個 reset 不生效，下一輪重試", async () => {
    const path = join(dir, "retry.jsonl");
    writeFileSync(path, "old\n");

    let failNext = false;
    let backlogCalls = 0;
    const source: TailSource = {
      resolve: (): ResolveResult => ({ kind: "ready", path }),
      readBacklog: (p, size) => {
        backlogCalls += 1;
        if (failNext) {
          failNext = false;
          throw new Error("read failed");
        }
        const buf = readWholeSync(p, size);
        return splitCompleteLines(buf.toString("utf-8"));
      },
      emit: (enqueue, text) => {
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (t) enqueue(`data: ${t}\n\n`);
        }
      },
    };

    const res = createTailStream(source);
    let replaced = false;
    const buf = await collect(
      res,
      (b) => {
        if (!replaced && b.includes("old")) {
          replaced = true;
          // The replacement is longer than the old file, so a stale offset lands
          // mid-file and swallows NEW instead of reporting anything.
          failNext = true;
          const tmp = join(dir, "retry.tmp");
          writeFileSync(tmp, "NEW\nTAIL\n");
          renameSync(tmp, path);
        }
        return b.includes("TAIL");
      },
      4000,
    );

    expect(backlogCalls).toBeGreaterThan(2); // attach, the failure, the retry
    expect(buf).toContain("NEW"); // head of the replacement, not skipped
    expect(buf).toContain("TAIL");
  });

  // attach sets `inode` before it reads the backlog, so a backlog that throws
  // (the "vanished between resolve and read" case its own catch names) leaves
  // inode set and offset at 0. Neither reset condition then holds, and the
  // append path below reads `st.size - 0` — the whole file, which is the
  // original bug on a 2.4 GB transcript.
  test("attach 的 backlog 失敗後，不會退化成整檔 append 讀取", async () => {
    const path = join(dir, "anchor.jsonl");
    writeFileSync(path, "a\nb\nc\n");

    let calls = 0;
    const source: TailSource = {
      resolve: (): ResolveResult => ({ kind: "ready", path }),
      readBacklog: (p, size) => {
        calls += 1;
        if (calls === 1) throw new Error("vanished");
        const all = readWholeSync(p, size)
          .toString("utf-8")
          .split("\n")
          .filter(Boolean);
        return { complete: all.slice(-1).join("\n"), partial: "" };
      },
      emit: (enqueue, text) => {
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (t) enqueue(`data: ${t}\n\n`);
        }
      },
    };

    const res = createTailStream(source);
    const buf = await collect(res, (b) => b.includes("data: c"), 4000);

    expect(calls).toBeGreaterThan(1); // the failed attach, then a real retry
    expect(buf).toContain("data: c"); // the bounded window
    expect(buf).not.toContain("data: a"); // never replayed whole
    expect(buf).not.toContain("data: b");
  });

  // The reset backlog is bounded, so the client needs the window it actually
  // got. Dropping backlogMeta leaves the reverse-scroll cursor pointing into the
  // file that was replaced: the panel shows a tail it cannot page back from.
  test("reset 重送 backlog-done，帶新的分頁 cursor", async () => {
    const path = join(dir, "meta.jsonl");
    writeFileSync(path, "one\n");

    const source: TailSource = {
      resolve: (): ResolveResult => ({ kind: "ready", path }),
      readBacklog: (p, size) => {
        const buf = readWholeSync(p, size);
        const all = buf.toString("utf-8").split("\n").filter(Boolean);
        const kept = all.slice(-1);
        return {
          complete: kept.join("\n"),
          partial: "",
          backlogMeta: {
            historyStart: size,
            hasMore: all.length > kept.length,
          },
        };
      },
      emit: (enqueue, text) => {
        for (const line of text.split("\n")) {
          const t = line.trim();
          if (t) enqueue(`data: ${t}\n\n`);
        }
      },
    };

    const res = createTailStream(source);
    let replaced = false;
    const buf = await collect(
      res,
      (b) => {
        if (!replaced && b.includes("one")) {
          replaced = true;
          const tmp = join(dir, "meta.tmp");
          writeFileSync(tmp, "a\nb\nc\nlast\n");
          renameSync(tmp, path);
        }
        // Wait for the second marker, not the data: the reset emits its lines
        // first, so stopping at "last" cuts the frame under test.
        return (b.match(/event: backlog-done/g) ?? []).length >= 2;
      },
      4000,
    );

    const doneFrames = [...buf.matchAll(/event: backlog-done\ndata: (.*)\n/g)];
    expect(doneFrames.length).toBe(2); // attach, then the reset
    const second = JSON.parse(doneFrames[1]![1]!);
    expect(second.hasMore).toBe(true); // a\nb\nc are pageable
    expect(second.historyStart).toBe(11); // "a\nb\nc\nlast\n"
  });
});
