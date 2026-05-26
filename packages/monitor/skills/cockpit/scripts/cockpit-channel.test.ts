import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelNotification,
  ensureServer,
  isUp,
  nextReconnectDelayMs,
  postReply,
  readDaemonCoords,
  readProcessInfo,
  REPLY_TOOL,
  resolveClaudeSessionId,
  sessionIdFromCommand,
} from "./cockpit-channel";

const SID = "cccccccc-3333-3333-3333-333333333333";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cockpit-channel-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon coords", () => {
  test("reads daemon port and token", () => {
    const path = join(dir, "daemon.json");
    writeFileSync(path, JSON.stringify({ pid: 1, port: 5858, token: "tok" }));
    expect(readDaemonCoords(path)).toEqual({ port: 5858, token: "tok" });
  });

  test("invalid daemon coords return null", () => {
    const path = join(dir, "daemon.json");
    writeFileSync(path, JSON.stringify({ pid: 1, port: 5858 }));
    expect(readDaemonCoords(path)).toBeNull();
  });

  test("isUp depends on a live pid from the info file", () => {
    const path = join(dir, "atlas.json");
    writeFileSync(path, JSON.stringify({ pid: 123, port: 5938 }));
    expect(readProcessInfo(path)).toEqual({ pid: 123, port: 5938 });
    expect(isUp(path, (pid) => pid === 123)).toBe(true);
    expect(isUp(path, () => false)).toBe(false);
  });

  test("ensureServer reuses live process and spawns stale process with --no-open", () => {
    const path = join(dir, "daemon.json");
    writeFileSync(path, JSON.stringify({ pid: 123, port: 5858 }));
    const calls: any[] = [];
    const spawnImpl = (command: string, args: string[], options: any) => {
      calls.push({ command, args, options });
      return { unref() {} } as any;
    };

    expect(ensureServer("/tmp/server.ts", path, () => true, spawnImpl)).toBe(
      false,
    );
    expect(calls).toEqual([]);

    expect(ensureServer("/tmp/server.ts", path, () => false, spawnImpl)).toBe(
      true,
    );
    expect(calls).toEqual([
      {
        command: "bun",
        args: ["/tmp/server.ts", "--no-open"],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
  });

  test("reconnect backoff grows and caps", () => {
    expect(nextReconnectDelayMs(0)).toBe(1000);
    expect(nextReconnectDelayMs(1)).toBe(2000);
    expect(nextReconnectDelayMs(2)).toBe(4000);
    expect(nextReconnectDelayMs(3)).toBe(8000);
    expect(nextReconnectDelayMs(99)).toBe(30000);
  });
});

describe("session resolution", () => {
  test("uses CLAUDE_CODE_SESSION_ID when present", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = SID;
    try {
      const resolved = await resolveClaudeSessionId({
        finder: () => {
          throw new Error("finder should not run");
        },
      });
      expect(resolved).toBe(SID);
    } finally {
      delete process.env.CLAUDE_CODE_SESSION_ID;
    }
  });

  test("falls back to the Claude session finder", async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const resolved = await resolveClaudeSessionId({
      project: "/tmp/project",
      timeoutMs: 1,
      ancestorFinder: () => null,
      finder: (provider, project) => {
        expect(provider).toBe("claude");
        expect(project).toBe("/tmp/project");
        return SID;
      },
    });
    expect(resolved).toBe(SID);
  });

  test("parses --session-id from command text", () => {
    expect(sessionIdFromCommand(`claude --session-id ${SID} --debug`)).toBe(
      SID,
    );
    expect(sessionIdFromCommand(`claude --session-id=${SID} --debug`)).toBe(
      SID,
    );
  });

  test("ancestor session id outranks transcript fallback", async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const resolved = await resolveClaudeSessionId({
      ancestorFinder: () => SID,
      finder: () => "dddddddd-4444-4444-4444-444444444444",
    });
    expect(resolved).toBe(SID);
  });
});

describe("protocol framing", () => {
  test("declares reply tool schema", () => {
    expect(REPLY_TOOL).toMatchObject({
      name: "reply",
      inputSchema: { required: ["text"] },
    });
  });

  test("frames inbox messages as Claude channel notifications", () => {
    expect(channelNotification("hi")).toEqual({
      method: "notifications/claude/channel",
      params: { content: "hi", meta: { source: "cockpit" } },
    });
  });
});

describe("reply POST", () => {
  test("posts session, text, and token to /api/reply", async () => {
    let seen: any = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen = {
          url: new URL(req.url).pathname,
          body: await req.json(),
        };
        return Response.json({ delivered: 2 });
      },
    });
    try {
      const delivered = await postReply({
        coords: { port: server.port, token: "tok" },
        sessionId: SID,
        text: "hello",
      });
      expect(delivered).toBe(2);
      expect(seen).toEqual({
        url: "/api/reply",
        body: { session: SID, text: "hello", token: "tok" },
      });
    } finally {
      server.stop(true);
    }
  });
});
