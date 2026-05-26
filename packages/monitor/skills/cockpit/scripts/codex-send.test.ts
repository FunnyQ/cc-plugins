import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCodexControlStatus, handleSendCodexMessage } from "./codex-send";
import type { ProbeReport } from "./codex-control-probe";

const SID = "019e64f1-2115-7f43-8aa7-12b3b46b3904";
const TOKEN = "tok";

let dir: string;

function req(body: unknown): Request {
  return new Request("http://127.0.0.1/api/send-codex-message", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function report(overrides: Partial<ProbeReport> = {}): ProbeReport {
  return {
    ok: true,
    daemonReady: false,
    controlMode: "direct-app-server",
    rpcReady: true,
    threadId: SID,
    threadResolved: true,
    resumeOk: true,
    turnStartOk: true,
    warnings: [],
    errors: [],
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cockpit-codex-send-"));
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

describe("handleSendCodexMessage", () => {
  test("sends a Codex turn through direct app-server mode", async () => {
    const calls: any[] = [];
    const r = await handleSendCodexMessage(
      req({ session: SID, text: "hello", token: TOKEN }),
      async (opts) => {
        calls.push(opts);
        return report();
      },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      delivered: true,
      controlMode: "direct-app-server",
      warnings: [],
    });
    expect(calls).toEqual([{ threadId: SID, sendText: "hello" }]);
  });

  test("rejects auth, invalid session, and empty text", async () => {
    expect(
      (
        await handleSendCodexMessage(
          req({ session: SID, text: "x", token: "bad" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleSendCodexMessage(
          req({ session: "bad", text: "x", token: TOKEN }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleSendCodexMessage(
          req({ session: SID, text: " ", token: TOKEN }),
        )
      ).status,
    ).toBe(400);
  });

  test("returns probe errors when Codex control fails", async () => {
    const r = await handleSendCodexMessage(
      req({ session: SID, text: "hello", token: TOKEN }),
      async () =>
        report({
          ok: false,
          threadResolved: false,
          resumeOk: undefined,
          turnStartOk: undefined,
          errors: ["direct app-server failed: nope"],
        }),
    );

    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({
      error: "direct app-server failed: nope",
      warnings: [],
    });
  });
});

describe("handleCodexControlStatus", () => {
  test("reports ready when the Codex thread can be resumed", async () => {
    const calls: any[] = [];
    const r = await handleCodexControlStatus(
      new Request(
        `http://127.0.0.1/api/codex-control/status?session=${SID}&token=${TOKEN}`,
      ),
      async (opts) => {
        calls.push(opts);
        return report();
      },
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ready: true,
      controlMode: "direct-app-server",
      warnings: [],
      errors: [],
    });
    expect(calls).toEqual([{ threadId: SID }]);
  });

  test("reports not ready when Codex resume fails", async () => {
    const r = await handleCodexControlStatus(
      new Request(
        `http://127.0.0.1/api/codex-control/status?session=${SID}&token=${TOKEN}`,
      ),
      async () =>
        report({
          ok: false,
          resumeOk: undefined,
          errors: ["direct app-server failed: nope"],
        }),
    );

    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      ready: false,
      controlMode: "direct-app-server",
      warnings: [],
      errors: ["direct app-server failed: nope"],
    });
  });

  test("rejects unauthorized and invalid sessions", async () => {
    expect(
      (
        await handleCodexControlStatus(
          new Request(
            `http://127.0.0.1/api/codex-control/status?session=${SID}&token=bad`,
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleCodexControlStatus(
          new Request(
            `http://127.0.0.1/api/codex-control/status?session=bad&token=${TOKEN}`,
          ),
        )
      ).status,
    ).toBe(400);
  });
});
