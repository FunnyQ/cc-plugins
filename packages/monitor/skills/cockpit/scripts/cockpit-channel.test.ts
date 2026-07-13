import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  ABANDONED,
  abortableSleep,
  channelNotification,
  claudeSessionsDir,
  compareVersions,
  createMcpServer,
  POLL_FLOOR_MS,
  pollFloorDelayMs,
  pullInboxLoop,
  versionFromRoot,
  createSerialNotifier,
  ensureServer,
  isUp,
  nextReconnectDelayMs,
  PERMISSION_VERDICT_METHOD,
  permissionRequestPayload,
  permissionResolvedPayload,
  permissionVerdictNotification,
  pullVerdict,
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

// The MCP SDK's StdioServerTransport listens only for stdin 'data' and 'error' — it
// never exits on EOF. Without an explicit abort path the channel outlives its Claude
// session as a PPID=1 orphan, polling the daemon forever.
describe("channel shutdown", () => {
  const coords = () => ({ port: 1, token: "t" });
  const mcp = { notification: async () => {} } as never;

  const inboxLoop = (
    signal: AbortSignal,
    fetchImpl: typeof fetch,
  ): Promise<void> =>
    pullInboxLoop({
      mcp,
      sessionId: SID,
      coords,
      ensure: async () => coords(),
      fetchImpl,
      signal,
    });

  const parked = () =>
    new Response(JSON.stringify({ message: null, timeout: true }));

  test("abortableSleep returns at once when already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    await abortableSleep(30_000, ac.signal);
    expect(Date.now() - started).toBeLessThan(200);
  });

  // Bun.sleep() ignores AbortSignal, so a SIGTERM landing mid-backoff would otherwise
  // be stalled for up to the full 30s reconnect delay.
  test("abortableSleep wakes early when aborted mid-sleep", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const slept = abortableSleep(30_000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    await slept;
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("pullInboxLoop resolves once the signal aborts", async () => {
    const ac = new AbortController();
    let polls = 0;
    const loop = inboxLoop(ac.signal, (async () => {
      polls++;
      return parked();
    }) as unknown as typeof fetch);
    setTimeout(() => ac.abort(), 50);
    await loop;
    expect(polls).toBeGreaterThan(0);
  }, 3000);

  test("pullInboxLoop never polls if the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let polls = 0;
    await inboxLoop(ac.signal, (async () => {
      polls++;
      return parked();
    }) as unknown as typeof fetch);
    expect(polls).toBe(0);
  }, 2000);

  test("pullInboxLoop resolves when an in-flight poll is aborted", async () => {
    const ac = new AbortController();
    const loop = inboxLoop(
      ac.signal,
      ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        })) as unknown as typeof fetch,
    );
    setTimeout(() => ac.abort(), 20);
    await loop;
  }, 2000);
});

// ensureServer used to gate on liveness alone, so after an upgrade the new-version
// channel kept reusing the OLD daemon and cockpit-server's own root-aware supersede
// (startupGuard) never ran. Superseding on ANY root mismatch would instead start a kill
// war between two legitimately live channels on different versions, so the tiebreak must
// be a total order: newest version wins.
describe("root-aware ensureServer", () => {
  const V = (v: string) =>
    `/Users/x/.claude/plugins/cache/q-lab-marketplace/monitor/${v}/skills/cockpit/scripts`;
  const DEV =
    "/Users/x/Projects/cc-plugins/packages/monitor/skills/cockpit/scripts";

  const daemonAt = (root: string | undefined) => {
    const path = join(dir, "daemon.json");
    writeFileSync(
      path,
      JSON.stringify({ pid: 4242, port: 5858, token: "t", root }),
    );
    return path;
  };

  const spawns = () => {
    const calls: string[][] = [];
    const impl = ((_cmd: string, args: string[]) => {
      calls.push(args);
      return { unref() {} };
    }) as never;
    return { calls, impl };
  };

  test("parses the version out of a cached plugin root", () => {
    expect(versionFromRoot(V("3.18.5"))).toBe("3.18.5");
    expect(versionFromRoot(DEV)).toBeNull();
  });

  test("compares versions numerically, not lexically", () => {
    expect(compareVersions("3.19.0", "3.9.0")).toBeGreaterThan(0);
    expect(compareVersions("3.18.5", "3.18.10")).toBeLessThan(0);
    expect(compareVersions("3.18.5", "3.18.5")).toBe(0);
  });

  test("reuses a live daemon from the same install", () => {
    const { calls, impl } = spawns();
    expect(
      ensureServer(
        "s.ts",
        daemonAt(V("3.19.0")),
        () => true,
        impl,
        V("3.19.0"),
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("supersedes a live daemon from an older install", () => {
    const { calls, impl } = spawns();
    expect(
      ensureServer(
        "s.ts",
        daemonAt(V("3.18.4")),
        () => true,
        impl,
        V("3.19.0"),
      ),
    ).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("stands down for a live daemon from a NEWER install", () => {
    const { calls, impl } = spawns();
    expect(
      ensureServer(
        "s.ts",
        daemonAt(V("3.19.0")),
        () => true,
        impl,
        V("3.18.4"),
      ),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("reuses rather than fight when a root carries no version", () => {
    const { calls, impl } = spawns();
    expect(
      ensureServer("s.ts", daemonAt(DEV), () => true, impl, V("3.19.0")),
    ).toBe(false);
    expect(
      ensureServer("s.ts", daemonAt(V("3.19.0")), () => true, impl, DEV),
    ).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("still spawns when no daemon is alive", () => {
    const { calls, impl } = spawns();
    expect(
      ensureServer(
        "s.ts",
        daemonAt(V("3.19.0")),
        () => false,
        impl,
        V("3.19.0"),
      ),
    ).toBe(true);
    expect(calls).toHaveLength(1);
  });

  // The regression the naive fix would introduce: two live channels on different
  // versions each respawning their own daemon, forever.
  test("two live channels on different versions converge instead of warring", () => {
    const { calls, impl } = spawns();
    const older = V("3.18.4");
    const newer = V("3.19.0");
    let daemonRoot = older;

    for (let round = 0; round < 5; round++) {
      // The newer channel supersedes exactly once, then both settle.
      if (ensureServer("s.ts", daemonAt(daemonRoot), () => true, impl, newer)) {
        daemonRoot = newer;
      }
      // The older channel must never take the port back.
      expect(
        ensureServer("s.ts", daemonAt(daemonRoot), () => true, impl, older),
      ).toBe(false);
    }
    expect(daemonRoot).toBe(newer);
    expect(calls).toHaveLength(1);
  });
});

// The daemon paces these loops by parking each poll for ~240s. That contract breaks the
// moment a second poller shares the session id: the daemon evicts the parked poll and
// answers {timeout:true} instantly (HTTP 200 — the SUCCESS path), so an unfloored loop
// re-polls at once. Two such loops ping-pong at thousands of req/s.
describe("poll floor", () => {
  const coords = () => ({ port: 1, token: "t" });

  test("no delay once the floor has already elapsed", () => {
    expect(pollFloorDelayMs(POLL_FLOOR_MS)).toBe(0);
    expect(pollFloorDelayMs(POLL_FLOOR_MS + 5_000)).toBe(0);
  });

  test("pads a fast poll up to the floor, plus jitter", () => {
    expect(pollFloorDelayMs(0, 1000, () => 0)).toBe(1000);
    expect(pollFloorDelayMs(900, 1000, () => 0)).toBe(100);
    // Jitter de-synchronises pollers that would otherwise stay in lockstep.
    expect(pollFloorDelayMs(0, 1000, () => 0.5)).toBeGreaterThan(1000);
  });

  test("pullInboxLoop stays bounded when the daemon answers instantly", async () => {
    const ac = new AbortController();
    let polls = 0;
    const loop = pullInboxLoop({
      mcp: { notification: async () => {} } as never,
      sessionId: SID,
      coords,
      ensure: async () => coords(),
      signal: ac.signal,
      fetchImpl: (async () => {
        polls++;
        return new Response(JSON.stringify({ message: null, timeout: true }));
      }) as unknown as typeof fetch,
    });
    setTimeout(() => ac.abort(), 400);
    await loop;
    // Unfloored this spins thousands of times in 400ms.
    expect(polls).toBeLessThanOrEqual(2);
  }, 3000);

  test("pullInboxLoop re-parks immediately after delivering a real message", async () => {
    const ac = new AbortController();
    let polls = 0;
    const fallbackAbort = setTimeout(() => ac.abort(), 100);
    await pullInboxLoop({
      mcp: { notification: async () => {} } as never,
      sessionId: SID,
      coords,
      ensure: async () => coords(),
      signal: ac.signal,
      floorMs: 1000,
      fetchImpl: (async () => {
        polls++;
        if (polls === 2) ac.abort();
        return new Response(JSON.stringify({ message: `message-${polls}` }));
      }) as unknown as typeof fetch,
    });
    clearTimeout(fallbackAbort);
    expect(polls).toBe(2);
  }, 2000);

  test("pullVerdict stays bounded on the timeout sentinel", async () => {
    const ac = new AbortController();
    let polls = 0;
    const pull = pullVerdict({
      sessionId: SID,
      coords,
      ensure: async () => coords(),
      signal: ac.signal,
      fetchImpl: (async () => {
        polls++;
        return new Response(JSON.stringify({ verdict: null, timeout: true }));
      }) as unknown as typeof fetch,
    });
    setTimeout(() => ac.abort(), 400);
    await pull;
    expect(polls).toBeLessThanOrEqual(2);
  }, 3000);
});

// Every test above injects sessionFileFinder, so the real lookup never ran under
// test — which is how a missing `homedir` import shipped. Unset the override so
// claudeSessionsDir() takes the branch production actually takes.
describe("claude sessions dir", () => {
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.COCKPIT_CLAUDE_SESSIONS_DIR;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.COCKPIT_CLAUDE_SESSIONS_DIR;
    else process.env.COCKPIT_CLAUDE_SESSIONS_DIR = prev;
  });

  test("falls back to ~/.claude/sessions when the override is unset", () => {
    delete process.env.COCKPIT_CLAUDE_SESSIONS_DIR;
    expect(claudeSessionsDir()).toBe(join(homedir(), ".claude", "sessions"));
  });

  test("honors the COCKPIT_CLAUDE_SESSIONS_DIR override", () => {
    process.env.COCKPIT_CLAUDE_SESSIONS_DIR = "/tmp/cockpit-sessions";
    expect(claudeSessionsDir()).toBe("/tmp/cockpit-sessions");
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
      // This asserts the round-trip, not the ping-pong floor: the mock answers the
      // timeout sentinel instantly, which in production means an evicted poll and
      // would (correctly) be padded to POLL_FLOOR_MS. See "poll floor" for that.
      floorMs: 0,
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

describe("pullVerdict — abandon / abort sentinel", () => {
  const coords = () => ({ port: 5858, token: "tok" });
  const ensure = async () => ({ port: 5858, token: "tok" });

  test("returns ABANDONED when the daemon reports {abandoned:true}", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ abandoned: true }))) as any;
    const out = await pullVerdict({
      sessionId: SID,
      coords,
      ensure,
      fetchImpl,
    });
    expect(out).toBe(ABANDONED);
  });

  test("returns ABANDONED when the budget elapses on repeated timeout sentinels", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ verdict: null, timeout: true }))) as any;
    const out = await pullVerdict({
      sessionId: SID,
      coords,
      ensure,
      fetchImpl,
      budgetMs: 30, // tiny budget — a couple of sentinel re-polls then give up
    });
    expect(out).toBe(ABANDONED);
  });

  test("returns ABANDONED when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as any;
    const out = await pullVerdict({
      sessionId: SID,
      coords,
      ensure,
      fetchImpl,
      signal: ac.signal,
    });
    expect(out).toBe(ABANDONED);
    expect(called).toBe(false); // bailed before fetching
  });

  test("returns ABANDONED when aborted mid-flight (fetch rejects)", async () => {
    const ac = new AbortController();
    const fetchImpl = (async (_url: string, init?: any) => {
      // Simulate an abort that rejects the in-flight fetch.
      ac.abort();
      const err = new Error("aborted");
      (err as any).name = "AbortError";
      if (init?.signal?.aborted) throw err;
      throw err;
    }) as any;
    const out = await pullVerdict({
      sessionId: SID,
      coords,
      ensure,
      fetchImpl,
      signal: ac.signal,
    });
    expect(out).toBe(ABANDONED);
  });

  test("still returns a real verdict on the happy path", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ request_id: "abcde", behavior: "deny" }),
      )) as any;
    const out = await pullVerdict({
      sessionId: SID,
      coords,
      ensure,
      fetchImpl,
    });
    expect(out).toEqual({ request_id: "abcde", behavior: "deny" });
  });
});

describe("permission relay — supersede aborts the prior in-flight pull", () => {
  test("a new request aborts the prior pull; the abandoned pull sends no verdict", async () => {
    const mcp = createMcpServer();
    const sent: any[] = [];
    (mcp as any).notification = async (n: any) => {
      sent.push(n);
    };

    // Track each pull's signal so we can assert the first was aborted.
    const pullSignals: (AbortSignal | undefined)[] = [];
    const fetchImpl = (async (url: string, init?: any) => {
      if (url.includes("/api/permission-request")) return new Response("{}");
      if (url.includes("/api/permission-pull")) {
        const signal: AbortSignal | undefined = init?.signal;
        pullSignals.push(signal);
        const idx = pullSignals.length;
        if (idx === 1) {
          // First pull: park forever until aborted, then surface the abort.
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const err = new Error("aborted");
              (err as any).name = "AbortError";
              reject(err);
            });
          });
        }
        // Second pull (new request): resolve with a real verdict.
        return new Response(
          JSON.stringify({ request_id: "bbbbb", behavior: "allow" }),
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

    // Request 1 — parks a pull that will hang until aborted.
    await handler({
      method: "notifications/claude/channel/permission_request",
      params: { request_id: "aaaaa", tool_name: "Bash" },
    });
    await Bun.sleep(20);
    expect(pullSignals[0]?.aborted).toBe(false);

    // Request 2 — must abort request 1's pull, then run to a real verdict.
    await handler({
      method: "notifications/claude/channel/permission_request",
      params: { request_id: "bbbbb", tool_name: "Write" },
    });
    await Bun.sleep(50);

    // Request 1's pull was aborted (so it sent NO verdict).
    expect(pullSignals[0]?.aborted).toBe(true);
    // Only request 2's verdict was emitted.
    expect(sent).toEqual([
      {
        method: PERMISSION_VERDICT_METHOD,
        params: { request_id: "bbbbb", behavior: "allow" },
      },
    ]);
  });
});
