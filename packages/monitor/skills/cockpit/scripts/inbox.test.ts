import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleInbox, handleSendMessage, hasChannel } from "./inbox";

const SID = "aaaaaaaa-1111-1111-1111-111111111111";
const TOKEN = "test-token";

let cockpitHome: string;

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init);
}

async function json(res: Response): Promise<any> {
  return await res.json();
}

beforeEach(() => {
  cockpitHome = mkdtempSync(join(tmpdir(), "cockpit-inbox-"));
  process.env.COCKPIT_HOME = cockpitHome;
  process.env.COCKPIT_WAIT_TIMEOUT_MS = "80";
  process.env.COCKPIT_STASH_TTL_MS = "1000";
  writeFileSync(
    join(cockpitHome, "daemon.json"),
    JSON.stringify({ pid: process.pid, port: 5858, token: TOKEN }),
  );
});

afterEach(() => {
  delete process.env.COCKPIT_HOME;
  delete process.env.COCKPIT_WAIT_TIMEOUT_MS;
  delete process.env.COCKPIT_STASH_TTL_MS;
  delete process.env.COCKPIT_CHANNEL_TTL_MS;
  rmSync(cockpitHome, { recursive: true, force: true });
});

describe("inbox broker", () => {
  test("send wakes a parked inbox poll", async () => {
    const inbox = handleInbox(req(`/api/inbox?session=${SID}&token=${TOKEN}`));
    await Bun.sleep(10);
    const sent = await handleSendMessage(
      req("/api/send-message", {
        method: "POST",
        body: JSON.stringify({ session: SID, text: "hello", token: TOKEN }),
      }),
    );
    expect(await json(sent)).toEqual({ delivered: true });
    expect(await json(await inbox)).toEqual({ message: "hello" });
  });

  test("send before poll stashes and the next inbox drains it", async () => {
    const sent = await handleSendMessage(
      req("/api/send-message", {
        method: "POST",
        body: JSON.stringify({ session: SID, text: "early", token: TOKEN }),
      }),
    );
    expect(await json(sent)).toEqual({ delivered: false });
    const inbox = await handleInbox(
      req(`/api/inbox?session=${SID}&token=${TOKEN}`),
    );
    expect(await json(inbox)).toEqual({ message: "early" });
  });

  test("a second inbox poll replaces the first", async () => {
    const first = handleInbox(req(`/api/inbox?session=${SID}&token=${TOKEN}`));
    await Bun.sleep(10);
    const second = handleInbox(req(`/api/inbox?session=${SID}&token=${TOKEN}`));
    expect(await json(await first)).toEqual({ message: null, timeout: true });
    await Bun.sleep(10);
    await handleSendMessage(
      req("/api/send-message", {
        method: "POST",
        body: JSON.stringify({ session: SID, text: "new", token: TOKEN }),
      }),
    );
    expect(await json(await second)).toEqual({ message: "new" });
  });

  test("rejects bad token, invalid session, and empty text", async () => {
    expect(
      (await handleInbox(req(`/api/inbox?session=${SID}&token=nope`))).status,
    ).toBe(401);
    expect(
      (await handleInbox(req(`/api/inbox?session=bad&token=${TOKEN}`))).status,
    ).toBe(400);
    const empty = await handleSendMessage(
      req("/api/send-message", {
        method: "POST",
        body: JSON.stringify({ session: SID, text: " ", token: TOKEN }),
      }),
    );
    expect(empty.status).toBe(400);
  });

  test("poll resolves with timeout sentinel", async () => {
    const res = await handleInbox(
      req(`/api/inbox?session=${SID}&token=${TOKEN}`),
    );
    expect(await json(res)).toEqual({ message: null, timeout: true });
  });
});

describe("channel presence (hasChannel TTL)", () => {
  const PSID = "bbbbbbbb-2222-2222-2222-222222222222";

  test("stays true across the gap after a poll resolves, within TTL", async () => {
    process.env.COCKPIT_CHANNEL_TTL_MS = "200";
    // While parked, presence is true.
    const inbox = handleInbox(req(`/api/inbox?session=${PSID}&token=${TOKEN}`));
    await Bun.sleep(10);
    expect(hasChannel(PSID)).toBe(true);
    // After the poll times out, presence must NOT flicker false in the re-park gap.
    await json(await inbox);
    expect(hasChannel(PSID)).toBe(true);
  });

  test("goes false once the TTL lapses with no further polls", async () => {
    process.env.COCKPIT_CHANNEL_TTL_MS = "40";
    await json(
      await handleInbox(req(`/api/inbox?session=${PSID}&token=${TOKEN}`)),
    );
    expect(hasChannel(PSID)).toBe(true);
    await Bun.sleep(60);
    expect(hasChannel(PSID)).toBe(false);
  });

  test("unknown session has no channel", () => {
    expect(hasChannel("ffffffff-9999-9999-9999-999999999999")).toBe(false);
  });
});
