import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handlePermissionPull,
  handlePermissionRequest,
  handlePermissionResolved,
  handlePermissionStream,
  handlePermissionVerdict,
  hasPendingRequest,
  isForwardProgress,
} from "./permission";

const TOKEN = "test-token";
const RID = "abcde"; // 5 letters, the request_id shape

// A fresh session id per test: the broker's state lives in module-level Maps, so
// reusing one id would let a stash from one test contaminate the next.
let SID: string;
let cockpitHome: string;

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

function post(path: string, payload: object): Request {
  return req(path, { method: "POST", body: JSON.stringify(payload) });
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

// Read SSE data frames from a stream Response until `count` JSON frames are seen
// (": ..." comments are skipped). Cancels the reader once satisfied.
async function readFrames(res: Response, count: number): Promise<any[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const frames: any[] = [];
  let buf = "";
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    // Bun may enqueue either a string or a typed array onto the controller.
    buf +=
      typeof value === "string"
        ? value
        : decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (line) frames.push(JSON.parse(line.slice("data: ".length)));
    }
  }
  await reader.cancel();
  return frames;
}

beforeEach(() => {
  SID = crypto.randomUUID();
  cockpitHome = mkdtempSync(join(tmpdir(), "cockpit-perm-"));
  process.env.COCKPIT_HOME = cockpitHome;
  process.env.COCKPIT_WAIT_TIMEOUT_MS = "80";
  process.env.COCKPIT_STASH_TTL_MS = "1000";
  writeFileSync(
    join(cockpitHome, "daemon.json"),
    JSON.stringify({ pid: process.pid, port: 5858, token: TOKEN }),
  );
});

afterEach(() => {
  delete process.env.COCKPIT_HOME;
  delete process.env.COCKPIT_WAIT_TIMEOUT_MS;
  delete process.env.COCKPIT_STASH_TTL_MS;
  rmSync(cockpitHome, { recursive: true, force: true });
});

describe("permission request → stream fan-out", () => {
  test("a request fans a 'request' frame to a subscribed stream", async () => {
    const stream = handlePermissionStream(
      req(`/api/permission-stream?session=${SID}&token=${TOKEN}`),
    );
    const frames = readFrames(stream, 1);
    await Bun.sleep(10);
    const res = await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        tool_name: "Bash",
        description: "run ls",
        input_preview: "ls -la",
      }),
    );
    expect(await json(res)).toEqual({ ok: true });
    expect(await frames).toEqual([
      {
        type: "request",
        request_id: RID,
        tool_name: "Bash",
        description: "run ls",
        input_preview: "ls -la",
      },
    ]);
  });

  test("a tab subscribing after the request still sees it (stash replay)", async () => {
    await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        tool_name: "Write",
        description: "write file",
        input_preview: "/tmp/x.txt",
      }),
    );
    const stream = handlePermissionStream(
      req(`/api/permission-stream?session=${SID}&token=${TOKEN}`),
    );
    const frames = await readFrames(stream, 1);
    expect(frames[0]).toEqual({
      type: "request",
      request_id: RID,
      tool_name: "Write",
      description: "write file",
      input_preview: "/tmp/x.txt",
    });
  });
});

describe("permission verdict → pull round-trip", () => {
  test("a verdict wakes a parked pull and emits a 'resolved' frame", async () => {
    // pending request must exist for the verdict to match
    await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        tool_name: "Bash",
        description: "",
        input_preview: "",
      }),
    );
    const stream = handlePermissionStream(
      req(`/api/permission-stream?session=${SID}&token=${TOKEN}`),
    );
    // first frame is the replayed request; second will be the resolved
    const frames = readFrames(stream, 2);

    const pull = handlePermissionPull(
      req(`/api/permission-pull?session=${SID}&token=${TOKEN}`),
    );
    await Bun.sleep(10);
    const verdict = await handlePermissionVerdict(
      post("/api/permission-verdict", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        behavior: "allow",
      }),
    );
    expect(await json(verdict)).toEqual({ delivered: true });
    expect(await json(await pull)).toEqual({
      request_id: RID,
      behavior: "allow",
    });
    expect((await frames)[1]).toEqual({
      type: "resolved",
      request_id: RID,
      source: "ui",
    });
    expect(hasPendingRequest(SID)).toBe(false);
  });

  test("a verdict before the pull parks is stashed and drained next pull", async () => {
    await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        tool_name: "Bash",
        description: "",
        input_preview: "",
      }),
    );
    const verdict = await handlePermissionVerdict(
      post("/api/permission-verdict", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        behavior: "deny",
      }),
    );
    expect(await json(verdict)).toEqual({ delivered: false });
    const pull = await handlePermissionPull(
      req(`/api/permission-pull?session=${SID}&token=${TOKEN}`),
    );
    expect(await json(pull)).toEqual({ request_id: RID, behavior: "deny" });
  });

  test("the pull resolves with a re-pollable timeout sentinel", async () => {
    const pull = await handlePermissionPull(
      req(`/api/permission-pull?session=${SID}&token=${TOKEN}`),
    );
    expect(await json(pull)).toEqual({ verdict: null, timeout: true });
  });

  test("a second pull replaces the first", async () => {
    const first = handlePermissionPull(
      req(`/api/permission-pull?session=${SID}&token=${TOKEN}`),
    );
    await Bun.sleep(10);
    const second = handlePermissionPull(
      req(`/api/permission-pull?session=${SID}&token=${TOKEN}`),
    );
    expect(await json(await first)).toEqual({ verdict: null, timeout: true });
  });
});

describe("stale / mismatched request_id rejection", () => {
  test("a verdict for a non-pending request is rejected (409)", async () => {
    const res = await handlePermissionVerdict(
      post("/api/permission-verdict", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        behavior: "allow",
      }),
    );
    expect(res.status).toBe(409);
  });

  test("a verdict whose id ≠ the pending request id is rejected, resolves nothing", async () => {
    await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: "fresh",
        tool_name: "Bash",
        description: "",
        input_preview: "",
      }),
    );
    const res = await handlePermissionVerdict(
      post("/api/permission-verdict", {
        session: SID,
        token: TOKEN,
        request_id: "stale",
        behavior: "allow",
      }),
    );
    expect(res.status).toBe(409);
    // the fresh request is untouched
    expect(hasPendingRequest(SID)).toBe(true);
    // no verdict was stashed — the next pull times out
    const pull = await handlePermissionPull(
      req(`/api/permission-pull?session=${SID}&token=${TOKEN}`),
    );
    expect(await json(pull)).toEqual({ verdict: null, timeout: true });
  });
});

describe("permission-resolved (best-effort elsewhere)", () => {
  test("clears the pending request and broadcasts source:'elsewhere'", async () => {
    await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        tool_name: "Bash",
        description: "",
        input_preview: "",
      }),
    );
    const stream = handlePermissionStream(
      req(`/api/permission-stream?session=${SID}&token=${TOKEN}`),
    );
    const frames = readFrames(stream, 2); // request replay + resolved

    const res = await handlePermissionResolved(
      post("/api/permission-resolved", {
        session: SID,
        token: TOKEN,
        request_id: RID,
      }),
    );
    expect(await json(res)).toEqual({ resolved: true });
    expect((await frames)[1]).toEqual({
      type: "resolved",
      request_id: RID,
      source: "elsewhere",
    });
    expect(hasPendingRequest(SID)).toBe(false);
  });

  test("is a safe no-op when the request is already gone", async () => {
    const res = await handlePermissionResolved(
      post("/api/permission-resolved", {
        session: SID,
        token: TOKEN,
        request_id: RID,
      }),
    );
    expect(await json(res)).toEqual({ resolved: false });
  });
});

describe("supersede on a new request", () => {
  test("a new request closes the old card + wakes the parked pull with abandoned", async () => {
    // First request, with a UI tab subscribed.
    await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: "aaaaa",
        tool_name: "Bash",
        description: "",
        input_preview: "",
      }),
    );
    const stream = handlePermissionStream(
      req(`/api/permission-stream?session=${SID}&token=${TOKEN}`),
    );
    // frames: [0] replayed request(aaaaa), [1] resolved(aaaaa,elsewhere),
    //         [2] request(bbbbb)
    const frames = readFrames(stream, 3);

    // Channel parks a pull waiting on the first request's verdict.
    const pull = handlePermissionPull(
      req(`/api/permission-pull?session=${SID}&token=${TOKEN}`),
    );
    await Bun.sleep(10);

    // A NEW request lands for the same session → supersede.
    await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: "bbbbb",
        tool_name: "Write",
        description: "",
        input_preview: "",
      }),
    );

    // The parked pull is woken with {abandoned:true}.
    expect(await json(await pull)).toEqual({ abandoned: true });

    const got = await frames;
    expect(got[1]).toEqual({
      type: "resolved",
      request_id: "aaaaa",
      source: "elsewhere",
    });
    expect(got[2]).toMatchObject({ type: "request", request_id: "bbbbb" });
    // The new request is now the pending one.
    expect(hasPendingRequest(SID)).toBe(true);
  });
});

describe("transcript forward-progress pure decision", () => {
  test("inside the guard window never counts, even if the file grew", () => {
    expect(
      isForwardProgress({
        registeredAt: 1000,
        registeredSize: 50,
        now: 1500, // 500ms < 1000ms guard
        newSize: 80,
        guardMs: 1000,
      }),
    ).toBe(false);
  });

  test("past the guard window + a forward append counts as progress", () => {
    expect(
      isForwardProgress({
        registeredAt: 1000,
        registeredSize: 50,
        now: 2200, // 1200ms > 1000ms guard
        newSize: 80,
        guardMs: 1000,
      }),
    ).toBe(true);
  });

  test("past the guard window but no growth (touch/truncate) does not count", () => {
    expect(
      isForwardProgress({
        registeredAt: 1000,
        registeredSize: 50,
        now: 2200,
        newSize: 50,
        guardMs: 1000,
      }),
    ).toBe(false);
    expect(
      isForwardProgress({
        registeredAt: 1000,
        registeredSize: 50,
        now: 2200,
        newSize: 30, // shrank
        guardMs: 1000,
      }),
    ).toBe(false);
  });
});

describe("transcript-resolve closes a ghost modal", () => {
  test("a forward append after the guard closes the card + wakes the pull", async () => {
    // Lay down a fake transcript for SID under a temp projects dir.
    const projectsDir = mkdtempSync(join(tmpdir(), "cockpit-proj-"));
    const projDir = join(projectsDir, "-tmp-proj");
    mkdirSync(projDir, { recursive: true });
    const transcript = join(projDir, `${SID}.jsonl`);
    writeFileSync(transcript, '{"type":"user"}\n');
    process.env.COCKPIT_CLAUDE_PROJECTS_DIR = projectsDir;
    process.env.COCKPIT_TRANSCRIPT_GUARD_MS = "50"; // short guard for the test
    // The pull's wait budget must outlast the guard + fs.watch latency below,
    // else the long-poll times out (re-pollable sentinel) before the watcher
    // fires. beforeEach sets a tiny 80ms budget for the timeout-path test.
    process.env.COCKPIT_WAIT_TIMEOUT_MS = "3000";

    try {
      await handlePermissionRequest(
        post("/api/permission-request", {
          session: SID,
          token: TOKEN,
          request_id: RID,
          tool_name: "Bash",
          description: "",
          input_preview: "",
        }),
      );
      const stream = handlePermissionStream(
        req(`/api/permission-stream?session=${SID}&token=${TOKEN}`),
      );
      const frames = readFrames(stream, 2); // replay request + resolved
      const pull = handlePermissionPull(
        req(`/api/permission-pull?session=${SID}&token=${TOKEN}`),
      );

      // Wait past the guard, then append a forward line (the resolution).
      await Bun.sleep(120);
      appendFileSync(transcript, '{"type":"assistant"}\n');

      expect(await json(await pull)).toEqual({ abandoned: true });
      expect((await frames)[1]).toEqual({
        type: "resolved",
        request_id: RID,
        source: "elsewhere",
      });
      expect(hasPendingRequest(SID)).toBe(false);
    } finally {
      delete process.env.COCKPIT_CLAUDE_PROJECTS_DIR;
      delete process.env.COCKPIT_TRANSCRIPT_GUARD_MS;
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });

  test("an append INSIDE the guard window does NOT close the card", async () => {
    const projectsDir = mkdtempSync(join(tmpdir(), "cockpit-proj-"));
    const projDir = join(projectsDir, "-tmp-proj");
    mkdirSync(projDir, { recursive: true });
    const transcript = join(projDir, `${SID}.jsonl`);
    writeFileSync(transcript, '{"type":"user"}\n');
    process.env.COCKPIT_CLAUDE_PROJECTS_DIR = projectsDir;
    process.env.COCKPIT_TRANSCRIPT_GUARD_MS = "5000"; // long guard

    try {
      await handlePermissionRequest(
        post("/api/permission-request", {
          session: SID,
          token: TOKEN,
          request_id: RID,
          tool_name: "Bash",
          description: "",
          input_preview: "",
        }),
      );
      // The triggering tool_use line is written ~simultaneously — simulate it.
      appendFileSync(transcript, '{"type":"assistant","tool_use":1}\n');
      await Bun.sleep(60);
      // Still pending: the in-guard event was ignored.
      expect(hasPendingRequest(SID)).toBe(true);
    } finally {
      delete process.env.COCKPIT_CLAUDE_PROJECTS_DIR;
      delete process.env.COCKPIT_TRANSCRIPT_GUARD_MS;
      rmSync(projectsDir, { recursive: true, force: true });
    }
  });
});

describe("watcher teardown on every resolution path", () => {
  // A leaked watcher keeps the temp transcript's inode open; we assert teardown
  // indirectly: after a resolution, a later forward append must NOT fire another
  // resolved frame (the watcher is gone, so nothing reacts to the file).
  async function setupWatchedRequest(): Promise<{
    transcript: string;
    projectsDir: string;
  }> {
    const projectsDir = mkdtempSync(join(tmpdir(), "cockpit-proj-"));
    const projDir = join(projectsDir, "-tmp-proj");
    mkdirSync(projDir, { recursive: true });
    const transcript = join(projDir, `${SID}.jsonl`);
    writeFileSync(transcript, '{"type":"user"}\n');
    process.env.COCKPIT_CLAUDE_PROJECTS_DIR = projectsDir;
    process.env.COCKPIT_TRANSCRIPT_GUARD_MS = "30";
    await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        tool_name: "Bash",
        description: "",
        input_preview: "",
      }),
    );
    return { transcript, projectsDir };
  }

  async function teardownEnv(projectsDir: string): Promise<void> {
    delete process.env.COCKPIT_CLAUDE_PROJECTS_DIR;
    delete process.env.COCKPIT_TRANSCRIPT_GUARD_MS;
    rmSync(projectsDir, { recursive: true, force: true });
  }

  test("a UI verdict tears down the watcher (no later ghost resolve)", async () => {
    const { transcript, projectsDir } = await setupWatchedRequest();
    try {
      const verdict = await handlePermissionVerdict(
        post("/api/permission-verdict", {
          session: SID,
          token: TOKEN,
          request_id: RID,
          behavior: "allow",
        }),
      );
      expect(verdict.status).toBe(200);
      // Subscribe AFTER the verdict; a now-torn-down watcher must emit nothing.
      const stream = handlePermissionStream(
        req(`/api/permission-stream?session=${SID}&token=${TOKEN}`),
      );
      const frames = readFrames(stream, 1);
      await Bun.sleep(60);
      appendFileSync(transcript, '{"type":"assistant"}\n');
      await Bun.sleep(60);
      // Race the read against a short timer — no frame should arrive.
      const got = await Promise.race([
        frames,
        new Promise<string>((r) => setTimeout(() => r("none"), 80)),
      ]);
      expect(got).toBe("none");
    } finally {
      await teardownEnv(projectsDir);
    }
  });

  test("permission-resolved tears down the watcher", async () => {
    const { transcript, projectsDir } = await setupWatchedRequest();
    try {
      await handlePermissionResolved(
        post("/api/permission-resolved", {
          session: SID,
          token: TOKEN,
          request_id: RID,
        }),
      );
      expect(hasPendingRequest(SID)).toBe(false);
      // The watcher is gone; a forward append must not resurrect anything.
      const stream = handlePermissionStream(
        req(`/api/permission-stream?session=${SID}&token=${TOKEN}`),
      );
      const frames = readFrames(stream, 1);
      await Bun.sleep(60);
      appendFileSync(transcript, '{"type":"assistant"}\n');
      const got = await Promise.race([
        frames,
        new Promise<string>((r) => setTimeout(() => r("none"), 80)),
      ]);
      expect(got).toBe("none");
    } finally {
      await teardownEnv(projectsDir);
    }
  });
});

describe("auth + validation failures", () => {
  test("every handler returns 401 on a bad token", async () => {
    expect(
      (
        await handlePermissionRequest(
          post("/api/permission-request", {
            session: SID,
            token: "nope",
            request_id: RID,
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      handlePermissionStream(
        req(`/api/permission-stream?session=${SID}&token=nope`),
      ).status,
    ).toBe(401);
    expect(
      (
        await handlePermissionVerdict(
          post("/api/permission-verdict", {
            session: SID,
            token: "nope",
            request_id: RID,
            behavior: "allow",
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        (await handlePermissionPull(
          req(`/api/permission-pull?session=${SID}&token=nope`),
        )) as Response
      ).status,
    ).toBe(401);
    expect(
      (
        await handlePermissionResolved(
          post("/api/permission-resolved", {
            session: SID,
            token: "nope",
            request_id: RID,
          }),
        )
      ).status,
    ).toBe(401);
  });

  test("every handler returns 400 on a bad session id", async () => {
    expect(
      (
        await handlePermissionRequest(
          post("/api/permission-request", {
            session: "bad",
            token: TOKEN,
            request_id: RID,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      handlePermissionStream(
        req(`/api/permission-stream?session=bad&token=${TOKEN}`),
      ).status,
    ).toBe(400);
    expect(
      (
        await handlePermissionVerdict(
          post("/api/permission-verdict", {
            session: "bad",
            token: TOKEN,
            request_id: RID,
            behavior: "allow",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        (await handlePermissionPull(
          req(`/api/permission-pull?session=bad&token=${TOKEN}`),
        )) as Response
      ).status,
    ).toBe(400);
    expect(
      (
        await handlePermissionResolved(
          post("/api/permission-resolved", {
            session: "bad",
            token: TOKEN,
            request_id: RID,
          }),
        )
      ).status,
    ).toBe(400);
  });

  test("verdict rejects a bad behavior (400)", async () => {
    const res = await handlePermissionVerdict(
      post("/api/permission-verdict", {
        session: SID,
        token: TOKEN,
        request_id: RID,
        behavior: "maybe",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("request rejects an empty request_id (400)", async () => {
    const res = await handlePermissionRequest(
      post("/api/permission-request", {
        session: SID,
        token: TOKEN,
        request_id: "",
      }),
    );
    expect(res.status).toBe(400);
  });
});
