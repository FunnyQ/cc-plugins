import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleOpenCodeControlStatus,
  handleSendOpenCodeMessage,
  type OpenCodeSendReport,
} from "./opencode-send";

const SID = "ses_1331e37f0ffeUdVFaTgUqoSGKY";
const TOKEN = "tok";

let dir: string;

function req(body: unknown): Request {
  return new Request("http://127.0.0.1/api/send-opencode-message", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function report(
  overrides: Partial<OpenCodeSendReport> = {},
): OpenCodeSendReport {
  return {
    ok: true,
    ready: true,
    serverUrl: "http://127.0.0.1:9123",
    sessionFound: true,
    delivered: true,
    inputId: "msg_test",
    delivery: "async",
    warnings: [],
    errors: [],
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cockpit-opencode-send-"));
  process.env.COCKPIT_HOME = dir;
  writeFileSync(
    join(dir, "daemon.json"),
    JSON.stringify({ pid: process.pid, port: 5858, token: TOKEN }),
  );
});

afterEach(() => {
  delete process.env.COCKPIT_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe("handleSendOpenCodeMessage", () => {
  test("sends text through the OpenCode prompt API", async () => {
    const calls: any[] = [];
    const r = await handleSendOpenCodeMessage(
      req({ session: SID, text: "hello", token: TOKEN }),
      async (opts) => {
        calls.push(opts);
        return report();
      },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      delivered: true,
      delivery: "async",
      inputId: "msg_test",
      serverUrl: "http://127.0.0.1:9123",
      warnings: [],
    });
    expect(calls).toEqual([{ sessionId: SID, text: "hello" }]);
  });

  test("rejects auth, invalid session, and empty text", async () => {
    expect(
      (
        await handleSendOpenCodeMessage(
          req({ session: SID, text: "x", token: "bad" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleSendOpenCodeMessage(
          req({ session: "bad", text: "x", token: TOKEN }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleSendOpenCodeMessage(
          req({ session: SID, text: " ", token: TOKEN }),
        )
      ).status,
    ).toBe(400);
  });

  test("returns OpenCode errors when prompt delivery fails", async () => {
    const r = await handleSendOpenCodeMessage(
      req({ session: SID, text: "hello", token: TOKEN }),
      async () =>
        report({
          ok: false,
          ready: false,
          delivered: false,
          inputId: undefined,
          errors: ["OpenCode session not found"],
        }),
    );

    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({
      error: "OpenCode session not found",
      warnings: [],
    });
  });
});

describe("sendOpenCodePrompt", () => {
  test("uses the official async session prompt API", async () => {
    const { sendOpenCodePrompt } = await import("./opencode-send");
    const originalFetch = globalThis.fetch;
    const calls: { url: string; init?: RequestInit }[] = [];
    process.env.OPENCODE_SERVER_URL = "http://127.0.0.1:4888";
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "http://127.0.0.1:4888/global/health") {
        return Response.json({ healthy: true, version: "1.17.7" });
      }
      if (url === `http://127.0.0.1:4888/session/${SID}`) {
        return Response.json({
          id: SID,
          directory: "/tmp/project",
        });
      }
      if (
        url ===
        `http://127.0.0.1:4888/session/${SID}/prompt_async?directory=%2Ftmp%2Fproject`
      ) {
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const result = await sendOpenCodePrompt({
        sessionId: SID,
        text: "hello",
      });

      expect(result.ok).toBe(true);
      expect(result.delivered).toBe(true);
      expect(result.delivery).toBe("async");
      const sendCall = calls.at(-1);
      expect(sendCall?.url).toBe(
        `http://127.0.0.1:4888/session/${SID}/prompt_async?directory=%2Ftmp%2Fproject`,
      );
      expect(JSON.parse(String(sendCall?.init?.body))).toEqual({
        parts: [{ type: "text", text: "hello" }],
      });
    } finally {
      globalThis.fetch = originalFetch;
      delete process.env.OPENCODE_SERVER_URL;
    }
  });
});

describe("handleOpenCodeControlStatus", () => {
  test("reports ready when the OpenCode session is reachable", async () => {
    const calls: any[] = [];
    const r = await handleOpenCodeControlStatus(
      new Request(
        `http://127.0.0.1/api/opencode-control/status?session=${SID}&token=${TOKEN}`,
      ),
      async (sessionId) => {
        calls.push(sessionId);
        return report({ delivered: false, inputId: undefined });
      },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ready: true,
      serverUrl: "http://127.0.0.1:9123",
      warnings: [],
      errors: [],
    });
    expect(calls).toEqual([SID]);
  });

  test("reports not ready when OpenCode server cannot find the session", async () => {
    const r = await handleOpenCodeControlStatus(
      new Request(
        `http://127.0.0.1/api/opencode-control/status?session=${SID}&token=${TOKEN}`,
      ),
      async () =>
        report({
          ok: false,
          ready: false,
          sessionFound: false,
          delivered: false,
          inputId: undefined,
          errors: ["OpenCode session not found"],
        }),
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ready: false,
      serverUrl: "http://127.0.0.1:9123",
      warnings: [],
      errors: ["OpenCode session not found"],
    });
  });

  test("rejects unauthorized and invalid sessions", async () => {
    expect(
      (
        await handleOpenCodeControlStatus(
          new Request(
            `http://127.0.0.1/api/opencode-control/status?session=${SID}&token=bad`,
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleOpenCodeControlStatus(
          new Request(
            `http://127.0.0.1/api/opencode-control/status?session=bad&token=${TOKEN}`,
          ),
        )
      ).status,
    ).toBe(400);
  });
});
