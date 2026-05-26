import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelNotification,
  createSerialNotifier,
  ensureServer,
  isUp,
  nextReconnectDelayMs,
  readDaemonCoords,
  readProcessInfo,
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
  test("frames inbox messages as Claude channel notifications", () => {
    expect(channelNotification("hi")).toEqual({
      method: "notifications/claude/channel",
      params: { content: "hi", meta: { source: "cockpit" } },
    });
  });
});

describe("serial notifier", () => {
  test("returns synchronously without awaiting the slow notify", () => {
    let resolved = false;
    const deliver = createSerialNotifier(
      () =>
        new Promise<void>((r) =>
          setTimeout(() => ((resolved = true), r()), 50),
        ),
    );
    deliver("a");
    // The call must not block on the in-flight notification.
    expect(resolved).toBe(false);
  });

  test("delivers messages in order even when notify resolves out of order", async () => {
    const order: string[] = [];
    const deliver = createSerialNotifier(
      (text) =>
        new Promise<void>((r) => {
          // "a" resolves slower than "b" — serialization must still keep order.
          const delay = text === "a" ? 30 : 5;
          setTimeout(() => (order.push(text), r()), delay);
        }),
    );
    deliver("a");
    deliver("b");
    deliver("c");
    await Bun.sleep(80);
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("a failing notify does not break the chain and reaches onError", async () => {
    const order: string[] = [];
    const errors: unknown[] = [];
    const deliver = createSerialNotifier(
      (text) =>
        text === "boom"
          ? Promise.reject(new Error("boom"))
          : (order.push(text), Promise.resolve()),
      (err) => errors.push(err),
    );
    deliver("one");
    deliver("boom");
    deliver("two");
    await Bun.sleep(20);
    expect(order).toEqual(["one", "two"]);
    expect((errors[0] as Error).message).toBe("boom");
  });
});
