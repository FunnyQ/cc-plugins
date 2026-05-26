import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  channelNotification,
  isUp,
  postReply,
  readDaemonCoords,
  readProcessInfo,
  REPLY_TOOL,
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
