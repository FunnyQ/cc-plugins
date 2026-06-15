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
    delivery: "steer",
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
      delivery: "steer",
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
