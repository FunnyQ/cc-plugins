import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelNotification,
  createMcpServer,
  createSerialNotifier,
  ensureServer,
  isUp,
  nextReconnectDelayMs,
  PERMISSION_VERDICT_METHOD,
  permissionRequestPayload,
  permissionResolvedPayload,
  permissionVerdictNotification,
  readDaemonCoords,
  readProcessInfo,
  registerPermissionRelay,
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
      sessionFileFinder: () => null,
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
      sessionFileFinder: () => null,
      ancestorFinder: () => SID,
      finder: () => "dddddddd-4444-4444-4444-444444444444",
    });
    expect(resolved).toBe(SID);
  });

  test("session file outranks both ancestor command and transcript", async () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    const resolved = await resolveClaudeSessionId({
      sessionFileFinder: () => SID,
      ancestorFinder: () => "cccccccc-3333-3333-3333-333333333333",
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

describe("permission relay — pure mappings", () => {
  test("request params → POST payload carries all four fields plus session/token", () => {
    expect(
      permissionRequestPayload(SID, "tok", {
        request_id: "abcde",
        tool_name: "Bash",
        description: "Run a command",
        input_preview: '{"command":"ls -la"}',
      }),
    ).toEqual({
      session: SID,
      token: "tok",
      request_id: "abcde",
      tool_name: "Bash",
      description: "Run a command",
      input_preview: '{"command":"ls -la"}',
    });
  });

  test("request payload coerces missing/non-string fields to empty strings", () => {
    expect(permissionRequestPayload(SID, "tok", undefined)).toEqual({
      session: SID,
      token: "tok",
      request_id: "",
      tool_name: "",
      description: "",
      input_preview: "",
    });
    expect(
      permissionRequestPayload(SID, "tok", { request_id: 42, tool_name: null }),
    ).toEqual({
      session: SID,
      token: "tok",
      request_id: "",
      tool_name: "",
      description: "",
      input_preview: "",
    });
  });

  test("verdict → outbound notification echoes request_id verbatim", () => {
    expect(
      permissionVerdictNotification({ request_id: "qweas", behavior: "allow" }),
    ).toEqual({
      method: "notifications/claude/channel/permission",
      params: { request_id: "qweas", behavior: "allow" },
    });
    expect(
      permissionVerdictNotification({ request_id: "zzzzz", behavior: "deny" }),
    ).toEqual({
      method: "notifications/claude/channel/permission",
      params: { request_id: "zzzzz", behavior: "deny" },
    });
  });

  test("resolved payload carries session/token + request_id (coerced)", () => {
    expect(
      permissionResolvedPayload(SID, "tok", { request_id: "abcde" }),
    ).toEqual({ session: SID, token: "tok", request_id: "abcde" });
    expect(permissionResolvedPayload(SID, "tok", undefined)).toEqual({
      session: SID,
      token: "tok",
      request_id: "",
    });
  });
});

describe("permission relay — registration & round-trip", () => {
  test("createMcpServer declares the claude/channel/permission capability", () => {
    const mcp = createMcpServer();
    expect((mcp as any)._capabilities?.experimental).toEqual({
      "claude/channel": {},
      "claude/channel/permission": {},
    });
  });

  test("registers a permission_request handler (and defensive cancel handlers)", () => {
    const mcp = createMcpServer();
    registerPermissionRelay({
      mcp,
      sessionId: SID,
      coords: () => ({ port: 5858, token: "tok" }),
      ensure: async () => ({ port: 5858, token: "tok" }),
      fetchImpl: (async () => new Response("{}")) as any,
    });
    const methods = [...(mcp as any)._notificationHandlers.keys()];
    expect(methods).toContain(
      "notifications/claude/channel/permission_request",
    );
    expect(typeof (mcp as any).fallbackNotificationHandler).toBe("function");
  });

  test("a permission_request POSTs the request, pulls the verdict, then notifies", async () => {
    const mcp = createMcpServer();
    const calls: { url: string; body?: any }[] = [];
    const sent: any[] = [];
    (mcp as any).notification = async (n: any) => {
      sent.push(n);
    };
    let pulls = 0;
    const fetchImpl = (async (url: string, init?: any) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      if (url.includes("/api/permission-request")) return new Response("{}");
      if (url.includes("/api/permission-pull")) {
        pulls++;
        // First pull returns the re-pollable timeout sentinel; second returns
        // the verdict — exercises the re-poll loop.
        return pulls === 1
          ? new Response(JSON.stringify({ verdict: null, timeout: true }))
          : new Response(
              JSON.stringify({ request_id: "abcde", behavior: "allow" }),
            );
      }
      return new Response("{}", { status: 404 });
    }) as any;

    registerPermissionRelay({
      mcp,
      sessionId: SID,
      coords: () => ({ port: 5858, token: "tok" }),
      ensure: async () => ({ port: 5858, token: "tok" }),
      fetchImpl,
    });

    const handler = (mcp as any)._notificationHandlers.get(
      "notifications/claude/channel/permission_request",
    );
    await handler({
      method: "notifications/claude/channel/permission_request",
      params: {
        request_id: "abcde",
        tool_name: "Bash",
        description: "Run ls",
        input_preview: '{"command":"ls"}',
      },
    });
    // Let the fire-and-forget chain settle (timeout sentinel → re-poll).
    await Bun.sleep(50);

    const reqCall = calls.find((c) =>
      c.url.includes("/api/permission-request"),
    );
    expect(reqCall?.body).toEqual({
      session: SID,
      token: "tok",
      request_id: "abcde",
      tool_name: "Bash",
      description: "Run ls",
      input_preview: '{"command":"ls"}',
    });
    expect(pulls).toBe(2);
    expect(sent).toEqual([
      {
        method: PERMISSION_VERDICT_METHOD,
        params: { request_id: "abcde", behavior: "allow" },
      },
    ]);
  });

  test("a defensive cancel notification POSTs /api/permission-resolved", async () => {
    const mcp = createMcpServer();
    const calls: { url: string; body?: any }[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      return new Response("{}");
    }) as any;
    registerPermissionRelay({
      mcp,
      sessionId: SID,
      coords: () => ({ port: 5858, token: "tok" }),
      ensure: async () => ({ port: 5858, token: "tok" }),
      fetchImpl,
    });
    // Unknown-but-permission-shaped method → caught by the fallback handler.
    await (mcp as any).fallbackNotificationHandler({
      method: "notifications/claude/channel/permission_done",
      params: { request_id: "abcde" },
    });
    await Bun.sleep(20);
    const resolved = calls.find((c) =>
      c.url.includes("/api/permission-resolved"),
    );
    expect(resolved?.body).toEqual({
      session: SID,
      token: "tok",
      request_id: "abcde",
    });
  });
});
