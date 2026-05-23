// Tests for the live-transcript SSE engine (server/04).
// Run: bun test cockpit/skills/cockpit/scripts/transcript-stream.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleTranscriptStream,
  isInsideProjects,
  resolveClaudeTranscriptPath,
} from "./transcript-stream";

const SID = "22222222-2222-2222-2222-222222222222";

let projectsDir: string;
let logPath: string;

function transcriptReq(session: string): Request {
  return new Request(
    `http://127.0.0.1/api/transcript/stream?session=${session}`,
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
  process.env.COCKPIT_CLAUDE_PROJECTS_DIR = projectsDir;
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
});

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true });
  delete process.env.COCKPIT_CLAUDE_PROJECTS_DIR;
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

  test("valid uuid with no transcript file → 404", async () => {
    const res = handleTranscriptStream(
      transcriptReq("00000000-0000-0000-0000-000000000000"),
    );
    expect(res.status).toBe(404);
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
});
