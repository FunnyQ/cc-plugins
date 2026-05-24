// Tests for the decision-log SSE handler (server/03).
// Run: bun test packages/monitor/skills/cockpit/scripts/log-stream.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLogStream } from "./log-stream";

const CLI = join(import.meta.dir, "cockpit.ts");
const SID = "22222222-2222-2222-2222-222222222222";

let projectDir: string;
let cockpitHome: string;
let logPath: string;

function cli(args: string[]) {
  Bun.spawnSync(["bun", CLI, ...args], {
    cwd: projectDir,
    env: { ...process.env, COCKPIT_HOME: cockpitHome },
  });
}

// Collect SSE frames from a handler Response until `done(frames)` is true or
// `ms` elapses. Returns the parsed frames seen so far + a cancel fn.
async function collect(
  res: Response,
  done: (frames: string[]) => boolean,
  ms = 2500,
): Promise<string[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buffer = "";
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ value: undefined; done: false }>((r) =>
        setTimeout(() => r({ value: undefined, done: false }), remaining),
      ),
    ]);
    if (chunk.value) {
      buffer +=
        typeof chunk.value === "string"
          ? chunk.value
          : decoder.decode(chunk.value, { stream: true });
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        frames.push(buffer.slice(0, i));
        buffer = buffer.slice(i + 2);
      }
      if (done(frames)) break;
    }
    if (chunk.done) break;
  }
  await reader.cancel().catch(() => {});
  return frames;
}

function dataFrames(frames: string[]): any[] {
  return frames
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice(f.indexOf("data:") + 5).trim())
    .filter((d) => d && d !== "{}")
    .map((d) => {
      try {
        return JSON.parse(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function streamReq() {
  const u = new URL("http://localhost/api/log/stream");
  u.searchParams.set("project", projectDir);
  u.searchParams.set("session", SID);
  return new Request(u.toString());
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-log-proj-")));
  cockpitHome = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-log-home-")));
  process.env.COCKPIT_HOME = cockpitHome;
  // snappy polling so resilience cases settle within test timeouts
  process.env.COCKPIT_RESOLVE_POLL_MS = "100";
  process.env.COCKPIT_TAIL_POLL_MS = "100";
  logPath = join(projectDir, ".cockpit", "logs", `${SID}.jsonl`);
  cli([
    "start",
    "--session",
    SID,
    "--session-goal",
    "g",
    "--project-goal",
    "p",
  ]);
});

afterEach(() => {
  delete process.env.COCKPIT_HOME;
  delete process.env.COCKPIT_RESOLVE_POLL_MS;
  delete process.env.COCKPIT_TAIL_POLL_MS;
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(cockpitHome, { recursive: true, force: true });
});

describe("handleLogStream", () => {
  test("emits backlog records then a backlog-done marker", async () => {
    cli(["log", "--session", SID, "--decision", "d1", "--reason", "r1"]);
    const res = handleLogStream(streamReq());
    const frames = await collect(res, (f) =>
      f.some((x) => x.startsWith("event: backlog-done")),
    );
    const recs = dataFrames(frames);
    expect(recs[0].type).toBe("goal");
    expect(recs.some((r) => r.type === "decision" && r.decision === "d1")).toBe(
      true,
    );
    expect(frames.some((f) => f.startsWith("event: backlog-done"))).toBe(true);
  });

  test("appending a record pushes a new frame within ~1s", async () => {
    const res = handleLogStream(streamReq());
    // append shortly after the stream opens; collect until the live record shows
    const framesP = collect(
      res,
      (f) => dataFrames(f).some((r) => r.decision === "live1"),
      3000,
    );
    setTimeout(() => {
      cli(["log", "--session", SID, "--decision", "live1", "--reason", "r"]);
    }, 400);
    const frames = await framesP;
    expect(dataFrames(frames).some((r) => r.decision === "live1")).toBe(true);
  });

  test("a malformed line is skipped, later valid records still stream", async () => {
    cli(["log", "--session", SID, "--decision", "good1", "--reason", "r"]);
    appendFileSync(logPath, "this is not json {{\n");
    cli(["log", "--session", SID, "--decision", "good2", "--reason", "r"]);
    const res = handleLogStream(streamReq());
    const frames = await collect(res, (f) =>
      f.some((x) => x.startsWith("event: backlog-done")),
    );
    const decisions = dataFrames(frames)
      .filter((r) => r.type === "decision")
      .map((r) => r.decision);
    expect(decisions).toEqual(["good1", "good2"]);
  });

  // Resilience case 1: a stream may open before the session's log file exists.
  // It must wait (not error) and start streaming once the file is written.
  test("a log file created after connect still streams", async () => {
    const lateSid = "33333333-3333-3333-3333-333333333333";
    const u = new URL("http://localhost/api/log/stream");
    u.searchParams.set("project", projectDir);
    u.searchParams.set("session", lateSid);
    const res = handleLogStream(new Request(u.toString()));
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const framesP = collect(
      res,
      (f) => dataFrames(f).some((r) => r.type === "goal"),
      4000,
    );
    setTimeout(() => {
      cli([
        "start",
        "--session",
        lateSid,
        "--session-goal",
        "late",
        "--project-goal",
        "p",
      ]);
    }, 200);
    const frames = await framesP;
    expect(dataFrames(frames).some((r) => r.type === "goal")).toBe(true);
  });

  test("invalid/non-uuid session returns an error, no crash", async () => {
    const u = new URL("http://localhost/api/log/stream");
    u.searchParams.set("project", projectDir);
    u.searchParams.set("session", "not-a-uuid");
    const res = handleLogStream(new Request(u.toString()));
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("path traversal in session is rejected by the uuid gate", async () => {
    const u = new URL("http://localhost/api/log/stream");
    u.searchParams.set("project", projectDir);
    u.searchParams.set("session", "../../../../etc/passwd");
    const res = handleLogStream(new Request(u.toString()));
    expect(res.status).toBe(400);
  });

  test("missing project param returns an error", async () => {
    const u = new URL("http://localhost/api/log/stream");
    u.searchParams.set("session", SID);
    const res = handleLogStream(new Request(u.toString()));
    expect(res.status).toBe(400);
  });
});
