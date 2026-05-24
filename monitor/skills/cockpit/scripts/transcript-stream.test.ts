// Tests for the live-transcript SSE engine (server/04).
// Run: bun test monitor/skills/cockpit/scripts/transcript-stream.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Database } from "bun:sqlite";
import {
  handleTranscriptHistory,
  handleTranscriptStream,
  isInsideCodexSessions,
  isInsideProjects,
  resolveClaudeTranscriptPath,
  resolveCodexRolloutPath,
} from "./transcript-stream";

const SID = "22222222-2222-2222-2222-222222222222";

let projectsDir: string;
let codexDir: string;
let codexSessionsDir: string;
let logPath: string;
let codexLogPath: string;

function transcriptReq(session: string, provider?: string): Request {
  const suffix = provider ? `&provider=${provider}` : "";
  return new Request(
    `http://127.0.0.1/api/transcript/stream?session=${session}${suffix}`,
  );
}

// Read SSE text from a Response body until `predicate(buf)` is true or the
// timeout elapses, then cancel. The stream never closes on its own (heartbeat).
async function collect(
  res: Response,
  predicate: (buf: string) => boolean,
  timeoutMs = 2500,
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
      // In-process the stream yields the string chunks we enqueued; over the
      // wire Bun.serve encodes them to bytes. Handle both.
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
    try {
      await reader.cancel();
    } catch {
      // already closed
    }
  }
  return buf;
}

beforeEach(() => {
  projectsDir = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-claude-")));
  codexDir = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-codex-")));
  codexSessionsDir = join(codexDir, "sessions");
  mkdirSync(codexSessionsDir, { recursive: true });
  process.env.COCKPIT_CLAUDE_PROJECTS_DIR = projectsDir;
  process.env.COCKPIT_CODEX_DIR = codexDir;
  process.env.COCKPIT_CODEX_SESSIONS_DIR = codexSessionsDir;
  // snappy polling so resilience cases settle within test timeouts
  process.env.COCKPIT_RESOLVE_POLL_MS = "100";
  process.env.COCKPIT_TAIL_POLL_MS = "100";
  const projectSub = join(projectsDir, "-Users-q-some-project");
  mkdirSync(projectSub, { recursive: true });
  logPath = join(projectSub, `${SID}.jsonl`);
  writeFileSync(
    logPath,
    [
      JSON.stringify({
        type: "user",
        uuid: "u1",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({ type: "file-history-snapshot", uuid: "noise1" }), // metadata noise → filtered
      "this is not json {{", // malformed → skipped
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        message: { role: "assistant", content: "hello" },
      }),
      "",
    ].join("\n"),
  );

  codexLogPath = join(codexSessionsDir, `${SID}.jsonl`);
  writeFileSync(
    codexLogPath,
    [
      JSON.stringify({
        type: "response_item",
        uuid: "c1",
        payload: { type: "message", role: "assistant", content: "codex hi" },
      }),
      JSON.stringify({
        type: "response_item",
        uuid: "c-noise",
        payload: { type: "reasoning" },
      }),
      "",
    ].join("\n"),
  );
  const db = new Database(join(codexDir, "state_5.sqlite"));
  db.run(
    `create table threads (
      id text primary key,
      rollout_path text not null,
      archived integer not null default 0
    )`,
  );
  db.run(`insert into threads (id, rollout_path, archived) values (?, ?, 0)`, [
    SID,
    relative(codexDir, codexLogPath),
  ]);
  db.close();
});

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true });
  rmSync(codexDir, { recursive: true, force: true });
  delete process.env.COCKPIT_CLAUDE_PROJECTS_DIR;
  delete process.env.COCKPIT_CODEX_DIR;
  delete process.env.COCKPIT_CODEX_SESSIONS_DIR;
  delete process.env.COCKPIT_RESOLVE_POLL_MS;
  delete process.env.COCKPIT_TAIL_POLL_MS;
});

describe("transcript-stream backlog", () => {
  test("emits conversation frames then a backlog-done marker, skipping noise + malformed", async () => {
    const res = handleTranscriptStream(transcriptReq(SID));
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const buf = await collect(res, (b) => b.includes("backlog-done"));
    expect(buf).toContain("backlog-done");
    const dataFrames = buf
      .split("\n\n")
      .filter((f) => f.startsWith("data:") && !f.includes("backlog-done"))
      .map((f) => JSON.parse(f.replace(/^data:\s*/, "")));
    const uuids = dataFrames.map((d) => d.uuid);
    expect(uuids).toEqual(["u1", "a1"]); // noise + malformed dropped
  });

  test("a live append pushes a new frame after backlog-done", async () => {
    const res = handleTranscriptStream(transcriptReq(SID));
    const buf = await collect(res, (b) => {
      if (b.includes("backlog-done") && !b.includes("a2")) {
        // append once we've seen the backlog marker
        appendFileSync(
          logPath,
          JSON.stringify({
            type: "assistant",
            uuid: "a2",
            message: { content: "more" },
          }) + "\n",
        );
      }
      return b.includes("a2");
    });
    expect(buf).toContain("a2");
  });

  test("codex provider streams response_item message frames", async () => {
    const res = handleTranscriptStream(transcriptReq(SID, "codex"));
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const buf = await collect(res, (b) => b.includes("backlog-done"));
    expect(buf).toContain("c1");
    expect(buf).not.toContain("c-noise");
  });
});

describe("transcript-stream backlog cursor", () => {
  test("backlog-done frame carries historyStart + hasMore; a fully-covered file reports no more", async () => {
    const res = handleTranscriptStream(transcriptReq(SID));
    const buf = await collect(res, (b) => b.includes("backlog-done"));
    // The frame after the `event: backlog-done` line is its JSON data payload.
    const frame = buf.split("\n\n").find((f) => f.includes("backlog-done"));
    expect(frame).toBeDefined();
    const dataLine = frame!.split("\n").find((l) => l.startsWith("data:"));
    const meta = JSON.parse(dataLine!.replace(/^data:\s*/, ""));
    expect(typeof meta.historyStart).toBe("number");
    expect(typeof meta.hasMore).toBe("boolean");
    // The tiny fixture fits entirely in the backlog window, so we reached the
    // start of the file: cursor 0, nothing older to page.
    expect(meta.historyStart).toBe(0);
    expect(meta.hasMore).toBe(false);
  });
});

describe("transcript-stream history (reverse pagination)", () => {
  const HID = "44444444-4444-4444-4444-444444444444";
  let histPath: string;

  function historyReq(
    session: string,
    before: number,
    limit?: number,
    provider?: string,
  ): Request {
    const lim = limit != null ? `&limit=${limit}` : "";
    const prov = provider ? `&provider=${provider}` : "";
    return new Request(
      `http://127.0.0.1/api/transcript/history?session=${session}&before=${before}${lim}${prov}`,
    );
  }

  beforeEach(() => {
    histPath = join(projectsDir, "-Users-q-some-project", `${HID}.jsonl`);
    writeFileSync(
      histPath,
      Array.from({ length: 6 }, (_, i) =>
        JSON.stringify({
          type: "assistant",
          uuid: `h${i}`,
          message: { content: `line ${i}` },
        }),
      ).join("\n") + "\n",
    );
  });

  test("before<=0 returns an empty page (no read)", async () => {
    const res = handleTranscriptHistory(historyReq(HID, 0));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ entries: [], historyStart: 0, hasMore: false });
  });

  test("pages backward from EOF: limit caps the page, cursor advances, hasMore set", async () => {
    const size = statSync(histPath).size;
    const first = await handleTranscriptHistory(
      historyReq(HID, size, 2),
    ).json();
    expect(first.entries.map((e: { uuid: string }) => e.uuid)).toEqual([
      "h4",
      "h5",
    ]); // last 2, oldest-first
    expect(first.hasMore).toBe(true);
    expect(first.historyStart).toBeGreaterThan(0);
    expect(first.historyStart).toBeLessThan(size);

    // Next page using the returned cursor yields the entries just before.
    const second = await handleTranscriptHistory(
      historyReq(HID, first.historyStart, 2),
    ).json();
    expect(second.entries.map((e: { uuid: string }) => e.uuid)).toEqual([
      "h2",
      "h3",
    ]);
  });

  test("reaching the start of file reports hasMore:false, cursor 0", async () => {
    const size = statSync(histPath).size;
    const all = await handleTranscriptHistory(historyReq(HID, size, 50)).json();
    expect(all.entries).toHaveLength(6);
    expect(all.historyStart).toBe(0);
    expect(all.hasMore).toBe(false);
  });

  test("invalid session / provider → 400", async () => {
    expect(handleTranscriptHistory(historyReq("not-a-uuid", 100)).status).toBe(
      400,
    );
    expect(
      handleTranscriptHistory(historyReq(HID, 100, 10, "other")).status,
    ).toBe(400);
  });
});

describe("transcript-stream resilience", () => {
  // Resilience case 1: a transcript can be selected before its file exists
  // (Claude/Codex create it moments later). The stream must stay open — not
  // 404 — and start streaming once the file appears.
  test("a transcript that appears after connect still streams", async () => {
    const lateId = "33333333-3333-3333-3333-333333333333";
    const res = handleTranscriptStream(transcriptReq(lateId));
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const buf = await collect(
      res,
      (b) => {
        if (!b.includes("late1")) {
          // file did not exist at connect; create it now
          writeFileSync(
            join(projectsDir, "-Users-q-some-project", `${lateId}.jsonl`),
            JSON.stringify({
              type: "assistant",
              uuid: "late1",
              message: { content: "arrived" },
            }) + "\n",
          );
        }
        return b.includes("backlog-done");
      },
      4000,
    );
    expect(buf).toContain("late1");
    expect(buf).toContain("backlog-done");
  });
});

describe("transcript-stream validation", () => {
  test("non-uuid session → 400, no stream", async () => {
    const res = handleTranscriptStream(transcriptReq("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("path-traversal session string is rejected by the uuid gate → 400", async () => {
    const res = handleTranscriptStream(transcriptReq("..%2f..%2fetc%2fpasswd"));
    expect(res.status).toBe(400);
  });

  test("unknown provider → 400", async () => {
    const res = handleTranscriptStream(transcriptReq(SID, "other"));
    expect(res.status).toBe(400);
  });
});

describe("path helpers", () => {
  test("resolveClaudeTranscriptPath finds the fixture, returns undefined otherwise", () => {
    expect(resolveClaudeTranscriptPath(SID)).toBe(logPath);
    expect(
      resolveClaudeTranscriptPath("00000000-0000-0000-0000-000000000000"),
    ).toBeUndefined();
  });

  test("isInsideProjects confines to the projects root", () => {
    expect(isInsideProjects(logPath)).toBe(true);
    expect(isInsideProjects(join(projectsDir, "..", "escape.jsonl"))).toBe(
      false,
    );
    expect(isInsideProjects("/etc/passwd")).toBe(false);
  });

  test("resolveCodexRolloutPath finds the fixture and confines to sessions root", () => {
    expect(resolveCodexRolloutPath(SID)).toBe(codexLogPath);
    expect(
      resolveCodexRolloutPath("00000000-0000-0000-0000-000000000000"),
    ).toBeUndefined();
    expect(isInsideCodexSessions(codexLogPath)).toBe(true);
    expect(isInsideCodexSessions(join(codexSessionsDir, "..", "escape"))).toBe(
      false,
    );
  });
});
