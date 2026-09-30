import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseEnv, cleanup, freePort, makeHomes, startDaemon, stopDaemon, type Env, type Homes } from "./fixtures";
import { command } from "./launcher";

const SESSION = "11111111-2222-4333-8444-555555555555";
const TOKEN = "channel-contract-token";
const PREFIX = "notifications/claude/channel";
type Rpc = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type RecordedRequest = { method: string; path: string; query: Record<string, string>; body: Record<string, unknown> | null; at: number };

async function deadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() >= end) throw new Error("Condition did not become true before deadline");
    await Bun.sleep(20);
  }
}

class McpClient {
  readonly proc;
  readonly notifications: Rpc[] = [];
  readonly stderr: Promise<string>;
  private id = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private failure: Error | undefined;

  constructor(env: Env) {
    this.proc = Bun.spawn(command("channel", []), { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
    this.stderr = new Response(this.proc.stderr).text();
    void this.read().catch((error: Error) => {
      this.failure = error;
      for (const pending of this.pending.values()) pending.reject(error);
    });
  }

  private async read(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          const message = JSON.parse(line) as Rpc;
          if (message.jsonrpc !== "2.0") throw new Error(`Invalid JSON-RPC: ${line}`);
          if (message.id !== undefined) {
            const pending = this.pending.get(message.id);
            if (!pending) throw new Error(`Unexpected response id: ${message.id}`);
            if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
            else pending.resolve(message.result);
          } else this.notifications.push(message);
        }
      }
      if (buffer.trim()) throw new Error(`Incomplete JSON-RPC: ${buffer}`);
      throw new Error("Channel stdout closed");
    } finally { reader.releaseLock(); }
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.failure) throw this.failure;
    const id = ++this.id;
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    try { return await deadline(response, 5000, method); }
    finally { this.pending.delete(id); }
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async nextNotification(method: string, timeoutMs = 5000): Promise<Rpc> {
    await until(() => {
      if (this.failure) throw this.failure;
      return this.notifications.some((message) => message.method === method);
    }, timeoutMs);
    return this.notifications.splice(this.notifications.findIndex((message) => message.method === method), 1)[0]!;
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "contract-client", version: "1.0.0" } });
    this.notify("notifications/initialized");
    return result;
  }

  async close(): Promise<void> {
    if (this.proc.exitCode === null) this.proc.stdin.end();
    try { await deadline(this.proc.exited, 3000, "channel cleanup"); }
    finally {
      if (this.proc.exitCode === null) {
        this.proc.kill("SIGKILL");
        await deadline(this.proc.exited, 3000, "channel forced cleanup");
      }
    }
  }
}

class StubDaemon {
  readonly requests: RecordedRequest[] = [];
  private queues = new Map<string, Record<string, unknown>[]>();
  private parked = new Map<string, (value: Record<string, unknown>) => void>();
  readonly server;

  constructor(h: Homes, port: number) {
    this.server = Bun.serve({ hostname: "127.0.0.1", port, fetch: async (req) => {
      const url = new URL(req.url);
      this.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: req.method === "POST" ? await req.json() as Record<string, unknown> : null, at: Date.now() });
      if (url.pathname === "/api/inbox" || url.pathname === "/api/permission-pull") {
        const queued = this.queues.get(url.pathname)?.shift();
        if (queued) return Response.json(queued);
        return new Promise<Response>((resolve) => {
          const finish = (value: Record<string, unknown>) => {
            clearTimeout(timer);
            this.parked.delete(url.pathname);
            resolve(Response.json(value));
          };
          // Mimic inbox.ts handleInbox and permission.ts handlePermissionPull sentinels.
          const timer = setTimeout(() => finish(url.pathname === "/api/inbox" ? { message: null, timeout: true } : { verdict: null, timeout: true }), 500);
          this.parked.set(url.pathname, finish);
        });
      }
      // Mimic permission.ts handlePermissionRequest / handlePermissionResolved.
      if (url.pathname === "/api/permission-request") return Response.json({ ok: true });
      if (url.pathname === "/api/permission-resolved") return Response.json({ resolved: true });
      return new Response("Unknown route", { status: 404 });
    } });
    writeCoords(h, port);
  }

  push(path: string, value: Record<string, unknown>): void {
    const parked = this.parked.get(path);
    if (parked) parked(value);
    else {
      const queue = this.queues.get(path) ?? [];
      queue.push(value);
      this.queues.set(path, queue);
    }
  }

  assertAuth(): void {
    expect(this.requests.length).toBeGreaterThan(0);
    for (const req of this.requests) {
      expect(req.method).toBe(req.path === "/api/inbox" || req.path === "/api/permission-pull" ? "GET" : "POST");
      expect(req.method === "GET" ? req.query : { session: req.body?.session, token: req.body?.token }).toEqual({ session: SESSION, token: TOKEN });
    }
  }

  stop(): void {
    for (const finish of [...this.parked.values()]) finish({ timeout: true });
    this.server.stop(true);
  }
}

function writeCoords(h: Homes, port: number): void {
  // pins TS quirk: an alive pid with an unversioned root is reused even if its port is unreachable.
  writeFileSync(join(h.cockpitHome, "daemon.json"), JSON.stringify({ pid: process.pid, port, token: TOKEN, root: "/unversioned/test/root" }));
}

async function withStub(run: (client: McpClient, stub: StubDaemon) => Promise<void>): Promise<void> {
  const h = makeHomes();
  const stub = new StubDaemon(h, await freePort());
  const client = new McpClient(baseEnv(h, { CLAUDE_CODE_SESSION_ID: SESSION }));
  try { await run(client, stub); }
  finally { try { await client.close(); } finally { stub.stop(); cleanup(h.root); } }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function terminate(pid: number): Promise<void> {
  if (alive(pid)) process.kill(pid, "SIGTERM");
  try { await until(() => !alive(pid), 3000); }
  finally {
    if (alive(pid)) { process.kill(pid, "SIGKILL"); await until(() => !alive(pid), 3000); }
  }
}

describe("channel: handshake", () => {
  test("pins initialization, empty tools, and ping over raw stdio", async () => withStub(async (client, stub) => {
    const result = await client.initialize() as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.serverInfo).toEqual({ name: "cockpit-channel", version: "0.0.1" });
    expect(result.capabilities).toEqual({ experimental: { "claude/channel": {}, "claude/channel/permission": {} }, tools: {} });
    expect(result.instructions).toBe('Messages from the cockpit dashboard arrive as <channel source="cockpit">...</channel>.');
    expect(await client.request("tools/list")).toEqual({ tools: [] });
    expect(await client.request("ping")).toEqual({});
    await until(() => stub.requests.length > 0);
    stub.assertAuth();
  }));
});

describe("channel: inbox", () => {
  test("delivers two messages in order with exact params", async () => withStub(async (client, stub) => {
    await client.initialize();
    // Mimic inbox.ts handleInbox delivered response.
    stub.push("/api/inbox", { message: "first" });
    stub.push("/api/inbox", { message: "second" });
    for (const content of ["first", "second"]) expect(await client.nextNotification(PREFIX)).toEqual({ jsonrpc: "2.0", method: PREFIX, params: { content, meta: { source: "cockpit" } } });
    stub.assertAuth();
  }));
  test("re-polls timeout replies with the one-second request-start floor", async () => withStub(async (client, stub) => {
    await client.initialize();
    await until(() => stub.requests.filter((req) => req.path === "/api/inbox").length >= 3, 3000);
    const polls = stub.requests.filter((req) => req.path === "/api/inbox");
    // pins TS quirk: the floor includes parked time, with up to 250 ms additional jitter.
    for (let i = 1; i < polls.length; i++) expect(polls[i]!.at - polls[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    stub.assertAuth();
  }));
});

describe("channel: permission", () => {
  test("relays request and verdict, all cancel spellings, and the undocumented fallback", async () => withStub(async (client, stub) => {
    await client.initialize();
    const params = { request_id: "request-1", tool_name: "Bash", description: "Run command", input_preview: "pwd" };
    client.notify(`${PREFIX}/permission_request`, params);
    await until(() => stub.requests.some((req) => req.path === "/api/permission-request"));
    expect(stub.requests.find((req) => req.path === "/api/permission-request")?.body).toEqual({ session: SESSION, token: TOKEN, ...params });
    // Mimic permission.ts handlePermissionPull delivered verdict.
    stub.push("/api/permission-pull", { request_id: params.request_id, behavior: "allow" });
    expect(await client.nextNotification(`${PREFIX}/permission`)).toEqual({ jsonrpc: "2.0", method: `${PREFIX}/permission`, params: { request_id: params.request_id, behavior: "allow" } });
    // pins TS quirk: undocumented permission-prefixed methods are forwarded as resolved.
    for (const suffix of ["permission_cancel", "permission_resolved", "permission_cancelled", "permission_foo"]) {
      const count = stub.requests.filter((req) => req.path === "/api/permission-resolved").length;
      client.notify(`${PREFIX}/${suffix}`, { request_id: suffix });
      await until(() => stub.requests.filter((req) => req.path === "/api/permission-resolved").length === count + 1);
      expect(stub.requests.filter((req) => req.path === "/api/permission-resolved").at(-1)?.body).toEqual({ session: SESSION, token: TOKEN, request_id: suffix });
    }
    const posts = stub.requests.filter((req) => req.method === "POST").length;
    client.notify("notifications/unrelated", { request_id: "ignored" });
    expect(await client.request("ping")).toEqual({});
    await Bun.sleep(150);
    expect(stub.requests.filter((req) => req.method === "POST").length).toBe(posts);
    expect(client.proc.exitCode).toBeNull();
    stub.assertAuth();
  }));
});

describe("channel: lifecycle", () => {
  test("stdin EOF exits with code zero within three seconds", async () => withStub(async (client) => {
    await client.initialize();
    client.proc.stdin.end();
    expect(await deadline(client.proc.exited, 3000, "EOF exit")).toBe(0);
  }));
  test("SIGTERM exits within three seconds", async () => withStub(async (client) => {
    await client.initialize();
    client.proc.kill("SIGTERM");
    expect(await deadline(client.proc.exited, 3000, "SIGTERM exit")).toBe(0);
  }));
  test("an unreachable daemon keeps the channel alive and retries with backoff", async () => {
    const h = makeHomes();
    writeCoords(h, await freePort());
    const client = new McpClient(baseEnv(h, { CLAUDE_CODE_SESSION_ID: SESSION }));
    try {
      await client.initialize();
      await Bun.sleep(3000);
      expect(client.proc.exitCode).toBeNull();
      expect(await client.request("ping")).toEqual({});
      await client.close();
      const stderr = await deadline(client.stderr, 3000, "retry diagnostics");
      expect(stderr).toContain("reconnecting in 1000ms");
      expect(stderr).toContain("reconnecting in 2000ms");
      expect(JSON.parse(readFileSync(join(h.cockpitHome, "daemon.json"), "utf8")).pid).toBe(process.pid);
    } finally { try { await client.close(); } finally { cleanup(h.root); } }
  }, 10000);
});

describe("channel: spawn", () => {
  test("starts a real daemon on the inherited free port and removes both processes", async () => {
    const h = makeHomes();
    const port = await freePort();
    const path = join(h.cockpitHome, "daemon.json");
    const client = new McpClient(baseEnv(h, { CLAUDE_CODE_SESSION_ID: SESSION, COCKPIT_SERVER_PORT: String(port) }));
    let pid: number | undefined;
    try {
      await until(() => existsSync(path), 10000);
      const info = JSON.parse(readFileSync(path, "utf8")) as { pid: number; port: number };
      pid = info.pid;
      expect(info.port).toBe(port);
      expect(alive(pid)).toBe(true);
      const response = await fetch(`http://127.0.0.1:${port}/api/token`, { signal: AbortSignal.timeout(5000) });
      expect(response.ok).toBe(true);
      await response.arrayBuffer();
      await client.initialize();
      // pins TS quirk: a live channel respawns a terminated daemon, so close stdin before waiting.
      process.kill(pid, "SIGTERM");
      client.proc.stdin.end();
      await client.close();
      await until(() => !alive(pid!), 3000);
      expect(alive(pid)).toBe(false);
    } finally {
      try { await client.close(); }
      finally {
        try {
          if (pid !== undefined) await terminate(pid);
          if (existsSync(path)) {
            const recordedPid = JSON.parse(readFileSync(path, "utf8")).pid as number;
            if (recordedPid !== pid) await terminate(recordedPid);
          }
        } finally { cleanup(h.root); }
      }
    }
  }, 20000);
  test("an explicit --port wins over COCKPIT_SERVER_PORT", async () => {
    const h = makeHomes();
    const envPort = await freePort();
    let port = await freePort();
    while (port === envPort) port = await freePort();
    try {
      const daemon = await startDaemon(baseEnv(h, { COCKPIT_SERVER_PORT: String(envPort) }), { port });
      try { expect(daemon.info.port).toBe(port); }
      finally { await stopDaemon(daemon); }
      expect(alive(daemon.proc.pid)).toBe(false);
    } finally { cleanup(h.root); }
  }, 15000);
});
