import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleReply,
  handleReplyStream,
  subscriberCount,
} from "./reply-fanout";

const SID = "bbbbbbbb-2222-2222-2222-222222222222";
const TOKEN = "test-token";

let cockpitHome: string;

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

beforeEach(() => {
  cockpitHome = mkdtempSync(join(tmpdir(), "cockpit-reply-"));
  process.env.COCKPIT_HOME = cockpitHome;
  writeFileSync(
    join(cockpitHome, "daemon.json"),
    JSON.stringify({ pid: process.pid, port: 5858, token: TOKEN }),
  );
});

afterEach(() => {
  delete process.env.COCKPIT_HOME;
  rmSync(cockpitHome, { recursive: true, force: true });
});

describe("reply fan-out", () => {
  test("reply fans out to an open SSE subscriber", async () => {
    const ac = new AbortController();
    const streamRes = handleReplyStream(
      req(`/api/reply/stream?session=${SID}&token=${TOKEN}`, {
        signal: ac.signal,
      }),
    );
    const reader = streamRes.body!.getReader();
    const connected = await reader.read();
    expect(new TextDecoder().decode(connected.value)).toContain(": connected");
    expect(subscriberCount(SID)).toBe(1);

    const reply = await handleReply(
      req("/api/reply", {
        method: "POST",
        body: JSON.stringify({ session: SID, text: "hello", token: TOKEN }),
      }),
    );
    expect(await json(reply)).toEqual({ delivered: 1 });
    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe(
      'data: {"text":"hello"}\n\n',
    );

    ac.abort();
    await Bun.sleep(10);
    expect(subscriberCount(SID)).toBe(0);
  });

  test("reply with no subscribers returns delivered zero", async () => {
    const reply = await handleReply(
      req("/api/reply", {
        method: "POST",
        body: JSON.stringify({ session: SID, text: "hello", token: TOKEN }),
      }),
    );
    expect(await json(reply)).toEqual({ delivered: 0 });
  });

  test("validates token, session, and text", async () => {
    expect(
      handleReplyStream(req(`/api/reply/stream?session=${SID}&token=nope`))
        .status,
    ).toBe(401);
    expect(
      handleReplyStream(req(`/api/reply/stream?session=bad&token=${TOKEN}`))
        .status,
    ).toBe(400);
    const empty = await handleReply(
      req("/api/reply", {
        method: "POST",
        body: JSON.stringify({ session: SID, text: "", token: TOKEN }),
      }),
    );
    expect(empty.status).toBe(400);
  });
});
