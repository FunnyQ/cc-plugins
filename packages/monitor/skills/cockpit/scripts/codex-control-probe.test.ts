import { describe, expect, test } from "bun:test";
import {
  formatHumanReport,
  parseArgs,
  runProbe,
  type JsonRpcTransport,
} from "./codex-control-probe";

class FakeTransport implements JsonRpcTransport {
  calls: Array<{ method: string; params: unknown }> = [];

  constructor(private responses: Record<string, unknown> = {}) {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method in this.responses) return this.responses[method];
    return {};
  }

  close(): void {}
}

describe("codex control probe args", () => {
  test("parses thread, send, and json flags", () => {
    expect(parseArgs(["--thread", "abc", "--send", "hello", "--json"])).toEqual(
      {
        threadId: "abc",
        sendText: "hello",
        json: true,
        help: false,
      },
    );
  });

  test("rejects missing flag values", () => {
    expect(() => parseArgs(["--thread"])).toThrow("missing value for --thread");
    expect(() => parseArgs(["--send"])).toThrow("missing value for --send");
  });
});

describe("codex control probe", () => {
  test("dry run initializes and lists threads without starting a turn", async () => {
    const transport = new FakeTransport({
      "thread/loaded/list": { threads: [] },
    });
    const report = await runProbe(
      {},
      {
        cliVersion: () => "codex 1.2.3",
        startRemoteControl: () => ({}),
        createProxyTransport: async () => transport,
        createDirectTransport: async () => transport,
      },
    );

    expect(report).toMatchObject({
      ok: true,
      codexCliVersion: "codex 1.2.3",
      daemonReady: true,
      controlMode: "remote-control",
      rpcReady: true,
      threadResolved: false,
      warnings: [],
      errors: [],
    });
    expect(transport.calls.map((c) => c.method)).toEqual([
      "initialize",
      "thread/loaded/list",
    ]);
  });

  test("resumes a selected thread without starting a turn in dry run", async () => {
    const transport = new FakeTransport({
      "thread/loaded/list": { threads: [] },
      "thread/resume": { thread: { id: "t1" } },
    });
    const report = await runProbe(
      { threadId: "t1" },
      {
        cliVersion: () => "codex 1.2.3",
        startRemoteControl: () => ({}),
        createProxyTransport: async () => transport,
        createDirectTransport: async () => transport,
      },
    );

    expect(report).toMatchObject({
      ok: true,
      threadId: "t1",
      threadResolved: true,
      resumeOk: true,
    });
    expect(report.turnStartOk).toBeUndefined();
    expect(transport.calls.map((c) => c.method)).toEqual([
      "initialize",
      "thread/resume",
    ]);
  });

  test("starts a turn only when send text is explicit", async () => {
    const transport = new FakeTransport({
      "thread/resume": { thread: { id: "t1" } },
      "turn/start": { turn: { id: "turn1" } },
    });
    const report = await runProbe(
      { threadId: "t1", sendText: "hello" },
      {
        cliVersion: () => "codex 1.2.3",
        startRemoteControl: () => ({}),
        createProxyTransport: async () => transport,
        createDirectTransport: async () => transport,
      },
    );

    expect(report).toMatchObject({
      ok: true,
      threadResolved: true,
      resumeOk: true,
      turnStartOk: true,
    });
    const turnStart = transport.calls.find((c) => c.method === "turn/start");
    expect(turnStart?.params).toEqual({
      threadId: "t1",
      input: [{ type: "text", text: "hello", text_elements: [] }],
    });
  });

  test("send without thread is rejected before RPC", async () => {
    let created = false;
    const report = await runProbe(
      { sendText: "hello" },
      {
        cliVersion: () => "codex 1.2.3",
        startRemoteControl: () => ({}),
        createProxyTransport: async () => {
          created = true;
          return new FakeTransport();
        },
        createDirectTransport: async () => {
          created = true;
          return new FakeTransport();
        },
      },
    );

    expect(created).toBe(false);
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(["--send requires --thread"]);
  });

  test("reports daemon startup failure", async () => {
    const report = await runProbe(
      {},
      {
        cliVersion: () => "codex 1.2.3",
        startRemoteControl: () => {
          throw new Error("no daemon");
        },
        createProxyTransport: async () => new FakeTransport(),
        createDirectTransport: async () => {
          throw new Error("no direct");
        },
      },
    );

    expect(report).toMatchObject({
      ok: false,
      daemonReady: false,
      rpcReady: false,
      threadResolved: false,
      warnings: ["remote-control start failed: no daemon"],
      errors: ["direct app-server failed: no direct"],
    });
  });

  test("falls back to direct app-server when remote-control is unavailable", async () => {
    const proxy = new FakeTransport();
    const direct = new FakeTransport();
    const report = await runProbe(
      {},
      {
        cliVersion: () => "codex 1.2.3",
        startRemoteControl: () => {
          throw new Error("standalone missing");
        },
        createProxyTransport: async () => proxy,
        createDirectTransport: async () => direct,
      },
    );

    expect(report).toMatchObject({
      ok: true,
      daemonReady: false,
      controlMode: "direct-app-server",
      rpcReady: true,
      warnings: ["remote-control start failed: standalone missing"],
      errors: [],
    });
    expect(proxy.calls).toEqual([]);
    expect(direct.calls.map((c) => c.method)).toEqual([
      "initialize",
      "thread/loaded/list",
    ]);
  });

  test("falls back to direct app-server when remote-control proxy hangs", async () => {
    const direct = new FakeTransport();
    const report = await runProbe(
      {},
      {
        cliVersion: () => "codex 1.2.3",
        startRemoteControl: () => ({}),
        createProxyTransport: async () => ({
          request: async () => {
            throw new Error("initialize timed out");
          },
          close() {},
        }),
        createDirectTransport: async () => direct,
      },
    );

    expect(report).toMatchObject({
      ok: true,
      daemonReady: true,
      controlMode: "direct-app-server",
      rpcReady: true,
      warnings: ["remote-control proxy failed: initialize timed out"],
      errors: [],
    });
    expect(direct.calls.map((c) => c.method)).toEqual([
      "initialize",
      "thread/loaded/list",
    ]);
  });
});

describe("codex control probe output", () => {
  test("formats a compact human report", () => {
    expect(
      formatHumanReport({
        ok: true,
        codexCliVersion: "codex 1.2.3",
        daemonReady: true,
        controlMode: "remote-control",
        rpcReady: true,
        threadResolved: false,
        warnings: [],
        errors: [],
      }),
    ).toContain("ok: true");
  });
});
