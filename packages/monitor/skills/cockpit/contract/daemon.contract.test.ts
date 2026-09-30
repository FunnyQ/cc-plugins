import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { command, PLUGIN_ROOT } from "./launcher";
import {
  appendTrail, baseEnv, cleanup, DECISION_RECORD, fixtureEnv, freePort, makeHomes,
  makeProviderFixtures, openSse, readJsonl, run, seedRegistry, seedTrail,
  startDaemon, stopDaemon, type Daemon, type Env, type Homes, type ProviderFixtures,
  type RegistryEntry,
} from "./fixtures";

const tunables = {
  COCKPIT_WAIT_TIMEOUT_MS: "1500", COCKPIT_STASH_TTL_MS: "2000",
  COCKPIT_TAIL_POLL_MS: "100", COCKPIT_RESOLVE_POLL_MS: "100",
  COCKPIT_TRANSCRIPT_GUARD_MS: "100", COCKPIT_CHANNEL_TTL_MS: "200",
};
const call = (id = crypto.randomUUID()) => ({ ...DECISION_RECORD, id, needs_your_call: true });
const transcriptPath = (f: ProviderFixtures) => join(f.claudeProjectsDir, f.projectDir.replace(/[/.]/g, "-"), `${f.claudeSessionId}.jsonl`);

// Register hooks in each describe so filtered port groups have isolated lifecycles.
function group(extra?: (h: Homes, f: ProviderFixtures) => Env) {
  const c = {} as { h: Homes; f: ProviderFixtures; env: Env; d: Daemon; trail: string; entries: RegistryEntry[] };
  beforeAll(async () => {
    c.h = makeHomes();
    try {
      c.f = makeProviderFixtures(c.h);
      c.trail = seedTrail(c.f.projectDir, c.f.claudeSessionId, [call()]);
      c.entries = [{ provider: "claude", project: c.f.projectDir, sessionId: c.f.claudeSessionId,
        title: "Contract session", titleResolved: true, logPath: c.trail, lastHeartbeat: new Date().toISOString() }];
      seedRegistry(c.h.cockpitHome, c.entries);
      c.env = baseEnv(c.h, { ...fixtureEnv(c.f), ...tunables, ...extra?.(c.h, c.f) });
      c.d = await startDaemon(c.env);
    } catch (error) {
      cleanup(c.h.root);
      throw error;
    }
  }, 15000);
  afterAll(async () => {
    try { if (c.d) await stopDaemon(c.d); } finally { if (c.h) cleanup(c.h.root); }
  });
  return c;
}

function url(d: Daemon, path: string, query: Record<string, string> = {}) {
  return `${d.base}${path}?${new URLSearchParams({ token: d.token, ...query })}`;
}
async function json(res: Response, status = 200): Promise<any> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("no-store");
  return res.json();
}
async function get(d: Daemon, path: string, query: Record<string, string> = {}, status = 200) {
  return json(await fetch(url(d, path, query)), status);
}
async function post(d: Daemon, path: string, body: object, status = 200) {
  return json(await fetch(`${d.base}${path}`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: d.token, ...body }) }), status);
}
function wait(d: Daemon, session: string, query: Record<string, string> = {}) {
  return get(d, "/api/wait", { session, require_watcher: "1", ...query });
}
async function stream(address: string) {
  const s = await openSse(address);
  expect(s.response.status).toBe(200);
  expect(s.response.headers.get("content-type")).toBe("text/event-stream");
  expect(s.response.headers.get("cache-control")).toBe("no-cache");
  return s;
}
function subscribe(d: Daemon, session: string) {
  return stream(url(d, "/api/permission-stream", { session }));
}
function responseRecord(path: string, id: string, answer: string) {
  const rec = readJsonl(path).at(-1);
  expect(Object.keys(rec).sort()).toEqual(["answer", "call", "id", "ts", "type"]);
  expect(rec).toEqual({ type: "response", call: id, answer, id: expect.any(String), ts: expect.any(String) });
}

// Startup exercises replacement sequentially, while keeping at most one daemon alive.
describe("server: startup", () => {
  const c = group();
  test("writes the exact daemon record and reuses its live PID", async () => {
    const raw = readFileSync(join(c.h.cockpitHome, "daemon.json"), "utf8");
    expect(raw).toBe(JSON.stringify(c.d.info, null, 2) + "\n");
    expect(Object.keys(c.d.info)).toEqual(["pid", "port", "token", "root"]);
    expect(c.d.token).toMatch(/^[0-9a-f]{32}$/);
    expect(c.d.info).toEqual({ pid: c.d.proc.pid, port: c.d.port, root: expect.any(String), token: expect.any(String) });
    expect(c.d.info.root).toBe(join(PLUGIN_ROOT, "skills/cockpit/scripts"));
    const second = run("server", ["--no-open", "--port", String(await freePort())], { env: c.env });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toBe(`cockpit daemon already running → http://localhost:${c.d.port} (pid ${c.d.proc.pid})\n`);
    expect(second.stderr).toBe("");
    expect(() => process.kill(c.d.proc.pid, 0)).not.toThrow();
    expect(JSON.parse(readFileSync(join(c.h.cockpitHome, "daemon.json"), "utf8"))).toEqual(c.d.info);
  });
  test("uses the environment port when no port flag is present", async () => {
    await stopDaemon(c.d);
    const port = await freePort();
    const proc = Bun.spawn(command("server", ["--no-open"]), {
      env: { ...c.env, COCKPIT_SERVER_PORT: String(port) }, stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(proc.stdout).text();
    const stderr = new Response(proc.stderr).text();
    const base = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        expect(proc.exitCode).toBeNull();
        try {
          const info = JSON.parse(readFileSync(join(c.h.cockpitHome, "daemon.json"), "utf8"));
          if (info.pid === proc.pid && info.port === port) {
            const res = await fetch(`${base}/api/token`, { signal: AbortSignal.timeout(100) });
            if (res.ok) {
              expect(await json(res)).toEqual({ token: info.token });
              c.d = { proc, port, base, token: info.token, info };
              ready = true;
              break;
            }
            await res.body?.cancel();
          }
        } catch { /* The record and listener become ready asynchronously. */ }
        await Bun.sleep(50);
      }
      expect(ready).toBe(true);
    } finally {
      await stopDaemon({ proc, port, base, token: "", info: null });
      expect(await stdout).toBe(`cockpit → http://localhost:${port}\n`);
      expect(await stderr).toBe("");
      c.d = await startDaemon(c.env);
    }
  }, 15000);
  test("replaces a different-root live process with SIGTERM", async () => {
    await stopDaemon(c.d);
    const dummy = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    try {
      writeFileSync(join(c.h.cockpitHome, "daemon.json"), JSON.stringify({ pid: dummy.pid, port: c.d.port, token: "old", root: "/different/install" }));
      c.d = await startDaemon(c.env);
      await dummy.exited;
      expect(dummy.signalCode).toBe("SIGTERM");
      expect(c.d.info.pid).toBe(c.d.proc.pid);
      expect(c.d.info.pid).not.toBe(dummy.pid);
    } finally { if (dummy.exitCode === null) { dummy.kill(); await dummy.exited; } }
  });
  test("starts fresh from a dead PID", async () => {
    await stopDaemon(c.d);
    const dead = c.d.proc.pid;
    writeFileSync(join(c.h.cockpitHome, "daemon.json"), JSON.stringify({ ...c.d.info, pid: dead }));
    c.d = await startDaemon(c.env);
    expect(c.d.info.pid).not.toBe(dead);
    expect(await get(c.d, "/api/token")).toEqual({ token: c.d.token });
  });
});

describe("server: meta", () => {
  const c = group();
  test("returns exactly the public token envelope", async () => {
    expect(await get(c.d, "/api/token", { token: "wrong" })).toEqual({ token: c.d.token });
  });
  test("reads the token fresh for every request and accepts POST", async () => {
    const path = join(c.h.cockpitHome, "daemon.json");
    const raw = readFileSync(path, "utf8");
    try {
      writeFileSync(path, JSON.stringify({ ...c.d.info, token: "replacement-token" }));
      expect(await get(c.d, "/api/token")).toEqual({ token: "replacement-token" });
      expect(await json(await fetch(c.d.base + "/api/token", { method: "POST" }))).toEqual({ token: "replacement-token" });
      writeFileSync(path, "{}");
      expect(await get(c.d, "/api/token", {}, 503)).toEqual({ error: "daemon token unavailable" });
    } finally { writeFileSync(path, raw); }
  });
});

describe("server: static", () => {
  const c = group();
  test("serves index and extension MIME types with no-cache", async () => {
    for (const [path, mime, file] of [["/", "text/html; charset=utf-8", "index.html"],
      ["/app.js", "application/javascript; charset=utf-8", "app.js"], ["/style.css", "text/css; charset=utf-8", "style.css"]]) {
      const res = await fetch(c.d.base + path, { headers: { "accept-encoding": "identity" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(mime!);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(await res.text()).toBe(readFileSync(join(PLUGIN_ROOT, "skills/cockpit/dashboard/dist", file!), "utf8"));
    }
  });
  test("revalidates ETag and separates gzip from plain representations", async () => {
    const plain = await fetch(c.d.base + "/app.js", { headers: { "accept-encoding": "identity" } });
    const etag = plain.headers.get("etag")!;
    expect(etag).toMatch(/^W\/".+"$/);
    const text = await plain.text();
    const cached = await fetch(c.d.base + "/app.js", { headers: { "accept-encoding": "identity", "if-none-match": etag } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("etag")).toBe(etag);
    expect(cached.headers.get("cache-control")).toBe("no-cache");
    expect(cached.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(await cached.text()).toBe("");
    const compressed = await fetch(c.d.base + "/app.js", { headers: { "accept-encoding": "gzip" } });
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-type")).toBe("application/javascript; charset=utf-8");
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("vary")).toBe("Accept-Encoding");
    expect(compressed.headers.get("etag")).not.toBe(etag);
    expect(compressed.headers.get("cache-control")).toBe("no-cache");
    expect(await compressed.text()).toBe(text);
  });
  test("compresses each available text extension and revalidates gzip", async () => {
    for (const path of ["/index.html", "/app.js", "/style.css", "/vendor/purify.es.mjs"]) {
      const plain = await fetch(c.d.base + path, { headers: { "accept-encoding": "identity" } });
      expect(plain.status).toBe(200);
      expect(plain.headers.get("content-encoding")).toBeNull();
      expect(plain.headers.get("vary")).toBeNull();
      const text = await plain.text();
      const gzip = await fetch(c.d.base + path, { headers: { "accept-encoding": "br, gzip" } });
      expect(gzip.status).toBe(200);
      expect(gzip.headers.get("content-encoding")).toBe("gzip");
      expect(gzip.headers.get("vary")).toBe("Accept-Encoding");
      const etag = gzip.headers.get("etag")!;
      expect(etag).toMatch(/-gz"$/);
      expect(await gzip.text()).toBe(text);
      const cached = await fetch(c.d.base + path, { headers: { "accept-encoding": "gzip", "if-none-match": etag } });
      expect(cached.status).toBe(304);
      expect(cached.headers.get("etag")).toBe(etag);
      expect(cached.headers.get("content-type")).toBe(plain.headers.get("content-type"));
      expect(cached.headers.get("cache-control")).toBe("no-cache");
      expect(await cached.text()).toBe("");
    }
  });
  test("refuses unknown paths and literal/encoded traversal without SPA fallback", async () => {
    // pins TS quirk: URL normalization consumes dot segments before static routing.
    for (const path of ["/no/such/page", "/modules", "/vendor/", "/../../package.json", "/%2e%2e/%2e%2e/package.json", "/%2e%2e%2fpackage.json"]) {
      const res = await fetch(c.d.base + path);
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("text/plain;charset=utf-8");
      expect(res.headers.get("cache-control")).toBeNull();
      expect(await res.text()).toBe("Not found");
    }
  });
});

describe("server: views", () => {
  const c = group();
  test("shapes registry projects, live sessions, ended sessions and one subagent", async () => {
    const stale = crypto.randomUUID();
    const trail = seedTrail(c.f.projectDir, stale, []);
    utimesSync(trail, new Date(0), new Date(0));
    seedRegistry(c.h.cockpitHome, [...c.entries, { ...c.entries[0]!, sessionId: stale, title: "Ended", logPath: trail, lastHeartbeat: "2000-01-01T00:00:00.000Z" }]);
    const subdir = join(transcriptPath(c.f).slice(0, -6), "subagents");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(join(subdir, "agent-fixture.jsonl"), JSON.stringify({ type: "user", message: { role: "user", content: "Work" } }) + "\n");
    const sessions = (await get(c.d, "/api/sessions")).sessions;
    expect(sessions).toHaveLength(4);
    const live = sessions.find((s: any) => s.sessionId === c.f.claudeSessionId);
    const { titleResolved: _, ...entry } = c.entries[0]!;
    expect(live).toEqual({ ...entry, status: "active", liveStatus: "your-call", subagents: 1, channel: false, tracked: true });
    expect(Object.keys(live).sort()).toEqual(["channel", "lastHeartbeat", "liveStatus", "logPath", "project", "provider", "sessionId", "status", "subagents", "title", "tracked"]);
    expect(sessions.find((s: any) => s.sessionId === stale)).toEqual({ provider: "claude", project: c.f.projectDir,
      sessionId: stale, title: "Ended", logPath: trail, status: "ended", liveStatus: "ended", subagents: 0,
      channel: false, lastHeartbeat: "2000-01-01T00:00:00.000Z", tracked: true });
    expect(await get(c.d, "/api/projects")).toEqual({ projects: [{ project: c.f.projectDir, name: "project", activeCount: 3, sessionCount: 4, lastHeartbeat: c.entries[0]!.lastHeartbeat }] });
  });
  test("reads project instructions and DESIGN.md, including missing design", async () => {
    const query = { project: c.f.projectDir };
    expect(await get(c.d, "/api/project-info", query)).toEqual({ claudeMd: null, agentsMd: null, tokens: null });
    expect(await get(c.d, "/api/design-system", query, 404)).toEqual({ error: "DESIGN.md not found" });
    writeFileSync(join(c.f.projectDir, "CLAUDE.md"), "Project instructions\n");
    writeFileSync(join(c.f.projectDir, "AGENTS.md"), "Agent instructions\n");
    writeFileSync(join(c.f.projectDir, "DESIGN.md"), '---\nname: Fixture Design\ncolors:\n  background: "#ffffff"\n  foreground: "#000000"\n  accent: "#ff0000"\n---\n');
    expect(await get(c.d, "/api/project-info", query)).toEqual({ claudeMd: "Project instructions\n", agentsMd: "Agent instructions\n", tokens: { colorBg: "#ffffff", colorFg: "#000000", accent: "#ff0000" } });
    expect(await get(c.d, "/api/design-system", query)).toEqual({ name: "Fixture Design", description: "", colors: [
      { key: "background", name: "Background", value: "#ffffff" }, { key: "foreground", name: "Foreground", value: "#000000" }, { key: "accent", name: "Accent", value: "#ff0000" }],
      typography: [], rounded: [], spacing: [], components: [], rules: [] });
    expect(await get(c.d, "/api/project-info", {}, 400)).toEqual({ error: "unknown project" });
    expect(await get(c.d, "/api/design-system", {}, 404)).toEqual({ error: "project required" });
  });
  test("pins the public views' missing and bad token behavior", async () => {
    // pins TS quirk: none of the four view handlers authenticates a token.
    for (const path of ["/api/projects", "/api/sessions", "/api/project-info", "/api/design-system"]) {
      const expected = await get(c.d, path, { project: c.f.projectDir });
      for (const token of ["", "bad"]) {
        expect(await get(c.d, path, { token, project: c.f.projectDir })).toEqual(expected);
      }
    }
  });
});

describe("server: log-stream", () => {
  const { renameSync } = require("node:fs") as typeof import("node:fs");
  const c = group();
  test("replays backlog and streams an append within two seconds", async () => {
    const s = await stream(url(c.d, "/api/log/stream", { project: c.f.projectDir, session: c.f.claudeSessionId }));
    try {
      expect(s.response.status).toBe(200);
      expect(s.response.headers.get("content-type")).toBe("text/event-stream");
      expect(s.response.headers.get("cache-control")).toBe("no-cache");
      expect(await s.next()).toEqual({ event: "message", data: readJsonl(c.trail)[0] });
      expect(await s.next()).toEqual({ event: "backlog-done", data: {} });
      const rec = call();
      appendTrail(c.trail, rec);
      expect(await s.next(2000)).toEqual({ event: "message", data: rec });
    } finally { await s.close(); }
  });
  test("returns 400 for missing and invalid session parameters", async () => {
    for (const session of ["", "../../bad"]) {
      expect(await get(c.d, "/api/log/stream", { project: c.f.projectDir, session }, 400)).toEqual({ error: "invalid project/session" });
    }
  });
  test("rejects an unrelated project before opening SSE", async () => {
    expect(await get(c.d, "/api/log/stream", {
      project: c.f.projectDir + "-unrelated", session: c.f.claudeSessionId,
    }, 400)).toEqual({ error: "invalid project/session" });
  });
  test("resolves a file created after the connection opens", async () => {
    const session = crypto.randomUUID();
    const s = await stream(url(c.d, "/api/log/stream", { project: c.f.projectDir, session }));
    try {
      const rec = call();
      seedTrail(c.f.projectDir, session, [rec]);
      expect(await s.next(1500)).toEqual({ event: "message", data: rec });
      expect(await s.next()).toEqual({ event: "backlog-done", data: {} });
    } finally { await s.close(); }
  });
  test("resets backlog after truncation and atomic replacement", async () => {
    const session = crypto.randomUUID();
    const original = { text: "Original record is longer than the truncated record" };
    const path = seedTrail(c.f.projectDir, session, [original]);
    const s = await stream(url(c.d, "/api/log/stream", { project: c.f.projectDir, session }));
    try {
      expect(await s.next()).toEqual({ event: "message", data: original });
      expect(await s.next()).toEqual({ event: "backlog-done", data: {} });
      const truncated = { text: "short" };
      writeFileSync(path, JSON.stringify(truncated) + "\n");
      expect(await s.next(1500)).toEqual({ event: "message", data: truncated });
      expect(await s.next()).toEqual({ event: "backlog-done", data: {} });
      const replacement = { text: "replacement" };
      writeFileSync(path + ".replacement", JSON.stringify(replacement) + "\n");
      renameSync(path + ".replacement", path);
      expect(await s.next(1500)).toEqual({ event: "message", data: replacement });
      expect(await s.next()).toEqual({ event: "backlog-done", data: {} });
      const appended = call();
      appendTrail(path, appended);
      expect(await s.next(1500)).toEqual({ event: "message", data: appended });
    } finally { await s.close(); }
  });

});

describe("server: log-stream watcher", () => {
  const c = group(() => ({ COCKPIT_TAIL_POLL_MS: "2000" }));
  test("delivers watched appends before the two-second fallback poll", async () => {
    const session = crypto.randomUUID();
    const path = seedTrail(c.f.projectDir, session, []);
    const s = await stream(url(c.d, "/api/log/stream", { project: c.f.projectDir, session }));
    try {
      expect(await s.next()).toEqual({ event: "backlog-done", data: {} });
      const rec = call();
      appendTrail(path, rec);
      expect(await s.next(1500)).toEqual({ event: "message", data: rec });
    } finally { await s.close(); }
  });
});

describe("server: transcript", () => {
  const c = group();
  test("pages Claude history using byte cursors", async () => {
    const records = readJsonl(transcriptPath(c.f));
    const first = await get(c.d, "/api/transcript/history", { session: c.f.claudeSessionId, before: String(statSync(transcriptPath(c.f)).size), limit: "2" });
    expect(first.entries).toEqual(records.slice(1));
    expect(first.historyStart).toBe(Buffer.byteLength(JSON.stringify(records[0]) + "\n"));
    expect(first.hasMore).toBe(true);
    expect(await get(c.d, "/api/transcript/history", { session: c.f.claudeSessionId, before: String(first.historyStart), limit: "2" })).toEqual({ entries: records.slice(0, 1), historyStart: 0, hasMore: false });
  });
  test("streams Claude backlog and a newly appended transcript line", async () => {
    const s = await stream(url(c.d, "/api/transcript/stream", { session: c.f.claudeSessionId }));
    try {
      expect(s.response.status).toBe(200);
      expect(s.response.headers.get("content-type")).toBe("text/event-stream");
      expect(s.response.headers.get("cache-control")).toBe("no-cache");
      for (const rec of readJsonl(transcriptPath(c.f))) expect(await s.next()).toEqual({ event: "message", data: rec });
      expect(await s.next()).toEqual({ event: "backlog-done", data: { historyStart: 0, hasMore: false } });
      const rec = { type: "assistant", uuid: crypto.randomUUID(), message: { role: "assistant", content: "Appended answer" } };
      appendTrail(transcriptPath(c.f), rec);
      expect(await s.next(2000)).toEqual({ event: "message", data: rec });
    } finally { await s.close(); }
  });
  test("serves Codex history, backlog and live rollout appends", async () => {
    const path = join(c.f.codexSessionsDir, `rollout-${c.f.codexThreadId}.jsonl`);
    const query = { session: c.f.codexThreadId, provider: "codex" };
    expect(await get(c.d, "/api/transcript/history", { ...query, before: String(statSync(path).size) })).toEqual({ entries: readJsonl(path), historyStart: 0, hasMore: false });
    const s = await stream(url(c.d, "/api/transcript/stream", query));
    try {
      expect(await s.next()).toEqual({ event: "message", data: readJsonl(path)[0] });
      expect(await s.next()).toEqual({ event: "backlog-done", data: { historyStart: 0, hasMore: false } });
      const rec = { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "New Codex answer" }] } };
      appendTrail(path, rec);
      expect(await s.next(2000)).toEqual({ event: "message", data: rec });
    } finally { await s.close(); }
  });
  test("pins OpenCode empty history and database backlog/live messages", async () => {
    const query = { session: c.f.opencodeSessionId, provider: "opencode" };
    // pins TS quirk: OpenCode history always returns an empty page.
    expect(await get(c.d, "/api/transcript/history", { ...query, before: "999999" })).toEqual({ entries: [], historyStart: 0, hasMore: false });
    const s = await stream(url(c.d, "/api/transcript/stream", query));
    try {
      expect(await s.next()).toEqual({ event: "message", data: { type: "user", uuid: "msg_fixture", timestamp: expect.any(String), message: { role: "user", content: "Fixture request" }, provider: "opencode" } });
      expect(await s.next()).toEqual({ event: "backlog-done", data: {} });
      const db = new Database(c.f.opencodeDb);
      try { db.query("insert into message values (?, ?, ?, ?, ?)").run("msg_new", c.f.opencodeSessionId, Date.now() + 1000, Date.now() + 1000, JSON.stringify({ role: "assistant", content: "New OpenCode answer" })); } finally { db.close(); }
      expect(await s.next(2000)).toEqual({ event: "message", data: { type: "assistant", uuid: "msg_new", timestamp: expect.any(String), message: { role: "assistant", content: "New OpenCode answer" }, provider: "opencode" } });
    } finally { await s.close(); }
  });
});

describe("server: broker", () => {
  const c = group();
  test("replaces one park without cross-delivering another session", async () => {
    const session = crypto.randomUUID(), other = crypto.randomUUID();
    const first = get(c.d, "/api/wait", { session });
    const separate = get(c.d, "/api/wait", { session: other });
    await Bun.sleep(100);
    const replacement = get(c.d, "/api/wait", { session });
    expect(await first).toEqual({ answer: null, timeout: true });
    expect(await post(c.d, "/api/respond", { session, answer: "One" })).toEqual({ delivered: true });
    expect(await replacement).toEqual({ answer: "One" });
    expect(await post(c.d, "/api/respond", { session: other, answer: "Two" })).toEqual({ delivered: true });
    expect(await separate).toEqual({ answer: "Two" });
  });
  test("keeps mismatched stashes and expires matching stashes", async () => {
    const rec = call();
    appendTrail(c.trail, rec);
    await post(c.d, "/api/respond", { session: c.f.claudeSessionId, call: rec.id, answer: "Saved" });
    expect(await wait(c.d, c.f.claudeSessionId, { call: crypto.randomUUID() })).toEqual({ answer: null, superseded: true });
    expect(await wait(c.d, c.f.claudeSessionId, { call: rec.id })).toEqual({ answer: "Saved" });
    const expired = call();
    appendTrail(c.trail, expired);
    await post(c.d, "/api/respond", { session: c.f.claudeSessionId, answer: "Expired" });
    await Bun.sleep(2100);
    expect(await wait(c.d, c.f.claudeSessionId, { call: expired.id })).toEqual({ answer: null, superseded: true });
  });
  test("does not wake a wait for a different call and appends exactly one ordered response", async () => {
    const current = call();
    appendTrail(c.trail, current);
    const parked = get(c.d, "/api/wait", { session: c.f.claudeSessionId, call: current.id });
    await Bun.sleep(100);
    const before = readJsonl(c.trail).length;
    const stale = crypto.randomUUID();
    expect(await post(c.d, "/api/respond", { session: c.f.claudeSessionId, call: stale, answer: "Old" })).toEqual({ delivered: false });
    expect(readJsonl(c.trail).length).toBe(before + 1);
    const record = readJsonl(c.trail).at(-1);
    expect(Object.keys(record)).toEqual(["id", "type", "call", "answer", "ts"]);
    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    responseRecord(c.trail, stale, "Old");
    expect(await post(c.d, "/api/respond", { session: c.f.claudeSessionId, call: current.id, answer: 42 })).toEqual({ delivered: true });
    expect(await parked).toEqual({ answer: "" });
    expect(await wait(c.d, c.f.claudeSessionId, { call: stale })).toEqual({ answer: "Old" });
  });
  test("validates JSON, then token, then session and toggle types", async () => {
    for (const path of ["/api/respond", "/api/answer-here"]) {
      expect(await json(await fetch(`${c.d.base}${path}`, { method: "POST", body: "{" }), 400)).toEqual({ error: "invalid json" });
    }
    expect(await post(c.d, "/api/respond", { session: "bad", token: "bad" }, 401)).toEqual({ error: "unauthorized" });
    expect(await post(c.d, "/api/respond", { session: "bad" }, 400)).toEqual({ error: "invalid session" });
    expect(await get(c.d, "/api/wait", { session: "bad" }, 400)).toEqual({ error: "invalid session" });
    expect(await post(c.d, "/api/answer-here", { on: "true" }, 400)).toEqual({ error: "invalid on" });
  });
  test("defaults answer_here off and persists authenticated toggles", async () => {
    expect(await get(c.d, "/api/answer-here")).toEqual({ answer_here: false });
    for (const token of ["", "bad"]) {
      expect(await get(c.d, "/api/answer-here", { token }, 401)).toEqual({ error: "unauthorized" });
      expect(await post(c.d, "/api/answer-here", { token, on: true }, 401)).toEqual({ error: "unauthorized" });
      expect(await get(c.d, "/api/wait", { session: c.f.claudeSessionId, token }, 401)).toEqual({ error: "unauthorized" });
      expect(await post(c.d, "/api/respond", { token, session: c.f.claudeSessionId, answer: "bad" }, 401)).toEqual({ error: "unauthorized" });
    }
    expect(await post(c.d, "/api/answer-here", { on: true })).toEqual({ answer_here: true });
    expect(await get(c.d, "/api/answer-here")).toEqual({ answer_here: true });
    const path = join(c.h.configHome, "q-lab/cockpit/config.json");
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ answer_here: true });
    expect(raw).toBe(JSON.stringify({ answer_here: true }, null, 2) + "\n");
    expect(await post(c.d, "/api/answer-here", { on: false })).toEqual({ answer_here: false });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ answer_here: false });
  });
  test("parks without the opt-in presence gate even with answer_here off", async () => {
    const started = Date.now();
    expect(await get(c.d, "/api/wait", { session: c.f.claudeSessionId })).toEqual({ answer: null, timeout: true });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
  });
  test("reports toggle_off and then no_tab when no subscriber is live", async () => {
    expect(await wait(c.d, c.f.claudeSessionId)).toEqual({ answer: null, not_watching: true, reason: "toggle_off" });
    await post(c.d, "/api/answer-here", { on: true });
    expect(await wait(c.d, c.f.claudeSessionId)).toEqual({ answer: null, not_watching: true, reason: "no_tab" });
    await post(c.d, "/api/answer-here", { on: false });
  });
  test("drains stashed answers before the gate and records the open call linkage", async () => {
    const rec = call();
    appendTrail(c.trail, rec);
    expect(await post(c.d, "/api/respond", { session: c.f.claudeSessionId, answer: "Proceed" })).toEqual({ delivered: false });
    responseRecord(c.trail, rec.id, "Proceed");
    expect(await wait(c.d, c.f.claudeSessionId, { call: rec.id })).toEqual({ answer: "Proceed" });
  });
  test("reports superseded before the presence gate", async () => {
    const old = call(), current = call();
    appendTrail(c.trail, old);
    appendTrail(c.trail, current);
    expect(await wait(c.d, c.f.claudeSessionId, { call: old.id })).toEqual({ answer: null, superseded: true });
  });
});

describe("server: presence", () => {
  const c = group();
  test("parks with a live subscriber and times out", async () => {
    await post(c.d, "/api/answer-here", { on: true });
    const s = await subscribe(c.d, c.f.claudeSessionId);
    try { expect(await wait(c.d, c.f.claudeSessionId)).toEqual({ answer: null, timeout: true }); }
    finally { await s.close(); }
  });
  test("respond wakes the subscribed session and appends the linked response", async () => {
    await post(c.d, "/api/answer-here", { on: true });
    const s = await subscribe(c.d, c.f.claudeSessionId);
    try {
      const rec = call();
      appendTrail(c.trail, rec);
      const parked = wait(c.d, c.f.claudeSessionId, { call: rec.id });
      await Bun.sleep(100);
      expect(await post(c.d, "/api/respond", { session: c.f.claudeSessionId, answer: "First answer", call: rec.id })).toEqual({ delivered: true });
      expect(await parked).toEqual({ answer: "First answer" });
      responseRecord(c.trail, rec.id, "First answer");
    } finally { await s.close(); }
  });
  test("keeps two subscribed sessions' answers and trails separate", async () => {
    await post(c.d, "/api/answer-here", { on: true });
    const other = crypto.randomUUID(), firstCall = call(), secondCall = call();
    appendTrail(c.trail, firstCall);
    const otherTrail = seedTrail(c.f.projectDir, other, [secondCall]);
    seedRegistry(c.h.cockpitHome, [...c.entries, { ...c.entries[0]!, sessionId: other, logPath: otherTrail }]);
    const first = await subscribe(c.d, c.f.claudeSessionId);
    const second = await subscribe(c.d, other);
    try {
      const one = wait(c.d, c.f.claudeSessionId, { call: firstCall.id });
      let secondSettled = false;
      const two = wait(c.d, other, { call: secondCall.id }).then((value) => { secondSettled = true; return value; });
      await Bun.sleep(100);
      expect(await post(c.d, "/api/respond", { session: c.f.claudeSessionId, answer: "One" })).toEqual({ delivered: true });
      expect(await one).toEqual({ answer: "One" });
      await Bun.sleep(100);
      expect(secondSettled).toBe(false);
      expect(await post(c.d, "/api/respond", { session: other, answer: "Two" })).toEqual({ delivered: true });
      expect(await two).toEqual({ answer: "Two" });
      responseRecord(c.trail, firstCall.id, "One");
      responseRecord(otherTrail, secondCall.id, "Two");
    } finally { await first.close(); await second.close(); }
  });
  test("drops presence after the subscriber closes", async () => {
    await post(c.d, "/api/answer-here", { on: true });
    const s = await subscribe(c.d, c.f.claudeSessionId);
    await s.close();
    await Bun.sleep(150);
    expect(await wait(c.d, c.f.claudeSessionId)).toEqual({ answer: null, not_watching: true, reason: "no_tab" });
  });
});

describe("server: inbox", () => {
  const c = group();
  test("replaces polls and isolates sessions while preserving untrimmed text", async () => {
    const session = crypto.randomUUID(), other = crypto.randomUUID();
    const first = get(c.d, "/api/inbox", { session });
    const separate = get(c.d, "/api/inbox", { session: other });
    await Bun.sleep(100);
    const replacement = get(c.d, "/api/inbox", { session });
    expect(await first).toEqual({ message: null, timeout: true });
    expect(await post(c.d, "/api/send-message", { session, text: " One " })).toEqual({ delivered: true });
    expect(await replacement).toEqual({ message: " One " });
    expect(await post(c.d, "/api/send-message", { session: other, text: "Two" })).toEqual({ delivered: true });
    expect(await separate).toEqual({ message: "Two" });
    expect(await post(c.d, "/api/send-message", { session, text: "\u0085" })).toEqual({ delivered: false });
    expect(await get(c.d, "/api/inbox", { session })).toEqual({ message: "\u0085" });
  });
  test("expires stashes and validates messages in order", async () => {
    const session = crypto.randomUUID();
    await post(c.d, "/api/send-message", { session, text: "Expired" });
    await Bun.sleep(2100);
    expect(await get(c.d, "/api/inbox", { session })).toEqual({ message: null, timeout: true });
    expect(await json(await fetch(`${c.d.base}/api/send-message`, { method: "POST", body: "{" }), 400)).toEqual({ error: "invalid json" });
    expect(await post(c.d, "/api/send-message", { token: "bad", session: "bad", text: "" }, 401)).toEqual({ error: "unauthorized" });
    expect(await post(c.d, "/api/send-message", { session: 42, text: "Hello" }, 400)).toEqual({ error: "invalid session" });
    expect(await get(c.d, "/api/inbox", { session: "bad" }, 400)).toEqual({ error: "invalid session" });
    for (const text of [42, "", " \t\n", "\ufeff"]) {
      expect(await post(c.d, "/api/send-message", { session, text }, 400)).toEqual({ error: "empty text" });
    }
  });
  test("delivers a message to a parked poll", async () => {
    const poll = get(c.d, "/api/inbox", { session: c.f.claudeSessionId });
    await Bun.sleep(100);
    expect(await post(c.d, "/api/send-message", { session: c.f.claudeSessionId, text: "Message one" })).toEqual({ delivered: true });
    expect(await poll).toEqual({ message: "Message one" });
  });
  test("reports no channel as delivered:false and drains the stash", async () => {
    const session = crypto.randomUUID();
    // pins TS quirk: no-channel sends return delivered:false, without an error.
    expect(await post(c.d, "/api/send-message", { session, text: "Stashed message" })).toEqual({ delivered: false });
    expect(await get(c.d, "/api/inbox", { session })).toEqual({ message: "Stashed message" });
  });
  test("returns the timeout sentinel and rejects invalid tokens", async () => {
    expect(await get(c.d, "/api/inbox", { session: crypto.randomUUID() })).toEqual({ message: null, timeout: true });
    expect(await get(c.d, "/api/inbox", { session: c.f.claudeSessionId, token: "bad" }, 401)).toEqual({ error: "unauthorized" });
    expect(await post(c.d, "/api/send-message", { session: c.f.claudeSessionId, token: "bad", text: "No" }, 401)).toEqual({ error: "unauthorized" });
  });
});

describe("server: permission", () => {
  const c = group();
  test("pushes requests and resolves a parked pull with a UI verdict", async () => {
    const session = c.f.claudeSessionId;
    const s = await subscribe(c.d, session);
    try {
      const request = { session, request_id: "permission-one", tool_name: "Bash", description: "Run command", input_preview: "echo yes" };
      expect(await post(c.d, "/api/permission-request", request)).toEqual({ ok: true });
      const { session: _, ...frame } = request;
      expect(await s.next()).toEqual({ event: "message", data: { type: "request", ...frame } });
      const pull = get(c.d, "/api/permission-pull", { session });
      await Bun.sleep(100);
      expect(await post(c.d, "/api/permission-verdict", { session, request_id: request.request_id, behavior: "allow" })).toEqual({ delivered: true });
      expect(await pull).toEqual({ request_id: request.request_id, behavior: "allow" });
      expect(await s.next()).toEqual({ event: "message", data: { type: "resolved", request_id: request.request_id, source: "ui" } });
      expect(await post(c.d, "/api/permission-verdict", { session, request_id: request.request_id, behavior: "deny" }, 409)).toEqual({ error: "stale request" });
    } finally { await s.close(); }
  });
  test("withdraws resolved-elsewhere prompts and abandons their parked pull", async () => {
    const session = c.f.claudeSessionId;
    const s = await subscribe(c.d, session);
    try {
      expect(await post(c.d, "/api/permission-request", { session, request_id: "permission-two" })).toEqual({ ok: true });
      expect(await s.next()).toEqual({ event: "message", data: { type: "request", request_id: "permission-two", tool_name: "", description: "", input_preview: "" } });
      const pull = get(c.d, "/api/permission-pull", { session });
      await Bun.sleep(100);
      expect(await post(c.d, "/api/permission-resolved", { session, request_id: "permission-two" })).toEqual({ resolved: true });
      expect(await pull).toEqual({ abandoned: true });
      expect(await s.next()).toEqual({ event: "message", data: { type: "resolved", request_id: "permission-two", source: "elsewhere" } });
      expect(await post(c.d, "/api/permission-resolved", { session, request_id: "permission-two" })).toEqual({ resolved: false });
    } finally { await s.close(); }
  });
  test("pins permission timeout and every guarded route's token rejection", async () => {
    expect(await get(c.d, "/api/permission-pull", { session: crypto.randomUUID() })).toEqual({ verdict: null, timeout: true });
    for (const token of ["", "bad"]) {
      for (const path of ["/api/permission-stream", "/api/permission-pull"]) {
        expect(await get(c.d, path, { session: c.f.claudeSessionId, token }, 401)).toEqual({ error: "unauthorized" });
      }
      for (const path of ["/api/permission-request", "/api/permission-verdict", "/api/permission-resolved"]) {
        expect(await post(c.d, path, { session: c.f.claudeSessionId, token, request_id: "bad", behavior: "allow" }, 401)).toEqual({ error: "unauthorized" });
      }
    }
  });
});

function isolatedPath(h: Homes) {
  const bin = join(h.root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), "#!/bin/sh\nprintf 'COMMAND\\n'\n");
  chmodSync(join(bin, "ps"), 0o755);
  return bin;
}

describe("server: codex", () => {
  const c = group((h) => ({ PATH: isolatedPath(h) }));
  test("validates JSON, token, session and text before probing", async () => {
    expect(await json(await fetch(c.d.base + "/api/send-codex-message", { method: "POST", body: "{" }), 400)).toEqual({ error: "invalid json" });
    for (const token of ["", "bad"]) {
      expect(await get(c.d, "/api/codex-control/status", { session: "bad", token }, 401)).toEqual({ error: "unauthorized" });
      expect(await post(c.d, "/api/send-codex-message", { session: "bad", token, text: "" }, 401)).toEqual({ error: "unauthorized" });
    }
    for (const session of ["", "bad", c.f.codexThreadId.toUpperCase()]) {
      expect(await get(c.d, "/api/codex-control/status", { session }, 400)).toEqual({ error: "invalid session" });
      expect(await post(c.d, "/api/send-codex-message", { session, text: "Hello" }, 400)).toEqual({ error: "invalid session" });
    }
    for (const text of ["", "  \n ", null, 123, {}]) {
      expect(await post(c.d, "/api/send-codex-message", { session: c.f.codexThreadId, text }, 400)).toEqual({ error: "empty text" });
    }
    const path = join(c.h.cockpitHome, "daemon.json");
    try {
      writeFileSync(path, JSON.stringify({ ...c.d.info, token: "replacement" }));
      expect(await get(c.d, "/api/codex-control/status", { session: "bad" }, 401)).toEqual({ error: "unauthorized" });
      expect(await get(c.d, "/api/codex-control/status", { session: "bad", token: "replacement" }, 400)).toEqual({ error: "invalid session" });
      expect(await post(c.d, "/api/send-codex-message", { session: "bad", token: "replacement", text: "Hello" }, 400)).toEqual({ error: "invalid session" });
    } finally {
      writeFileSync(path, JSON.stringify(c.d.info));
    }
  });
  test("reports unavailable control and failed sends without a Codex binary/socket", async () => {
    expect(await get(c.d, "/api/codex-control/status", { session: c.f.codexThreadId, token: "bad" }, 401)).toEqual({ error: "unauthorized" });
    expect(await post(c.d, "/api/send-codex-message", { session: c.f.codexThreadId, token: "bad", text: "Hello" }, 401)).toEqual({ error: "unauthorized" });
    if (process.env.COCKPIT_BIN) {
      // Rust reports spawn failures instead of inheriting TS's unhandled ENOENT crash.
      const status = await get(c.d, "/api/codex-control/status", { session: c.f.codexThreadId });
      expect(status).toEqual({
        ready: false,
        controlMode: "direct-app-server",
        warnings: [expect.stringMatching(/^remote-control start failed: .+/)],
        errors: [
          expect.stringMatching(/^codex --version failed: .+/),
          expect.stringMatching(/^direct app-server failed: .+/),
        ],
      });
      const send = await post(c.d, "/api/send-codex-message", { session: c.f.codexThreadId, text: "Hello" }, 502);
      expect(send).toEqual({ error: status.errors.join("; "), warnings: status.warnings });
      expect(c.d.proc.exitCode).toBeNull();
      return;
    }
    // pins TS quirk: missing codex emits an unhandled spawn ENOENT; both routes drop HTTP and exit 1.
    for (const path of ["/api/codex-control/status", "/api/send-codex-message"]) {
      if (c.d.proc.exitCode !== null) c.d = await startDaemon(c.env);
      const body = JSON.stringify({ token: c.d.token, session: c.f.codexThreadId, text: "Hello" });
      // Use a single HTTP attempt: fetch retries GET resets and hides them as ConnectionRefused.
      const response = new Promise<number | undefined>((resolve, reject) => {
        const req = request(url(c.d, path, { session: c.f.codexThreadId }), {
          method: path.endsWith("status") ? "GET" : "POST",
          agent: false,
          headers: { "content-type": "application/json" },
        }, (res) => { res.resume(); resolve(res.statusCode); });
        req.on("error", reject);
        req.end(path.endsWith("status") ? undefined : body);
      });
      await expect(response).rejects.toMatchObject({ code: "ECONNRESET" });
      expect(await c.d.proc.exited).toBe(1);
      expect(c.d.proc.signalCode).toBeNull();
    }
  });
});

describe("server: opencode", () => {
  let bridge: ReturnType<typeof Bun.serve>;
  let mode: "unavailable" | "ready" | "missing" = "unavailable";
  let appendBody: unknown = true;
  let submitBody: unknown = true;
  const seen: Array<{ method: string; path: string; directory: string | null; body: unknown }> = [];
  // One isolated daemon sees only this candidate; health false excludes it initially.
  beforeAll(() => {
    bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      expect(req.headers.has("authorization")).toBe(false);
      const u = new URL(req.url);
      const body = req.method === "POST" && u.pathname === "/tui/append-prompt" ? await req.json() : null;
      seen.push({ method: req.method, path: u.pathname, directory: u.searchParams.get("directory"), body });
      if (u.pathname === "/global/health") return Response.json({ healthy: mode !== "unavailable" });
      if (u.pathname.startsWith("/session/")) return mode === "missing" ? Response.json({}, { status: 404 }) : Response.json({ id: u.pathname.slice(9), directory: c.f.projectDir });
      if (u.pathname === "/tui/append-prompt") return Response.json(appendBody);
      if (u.pathname === "/tui/submit-prompt") return Response.json(submitBody);
      return new Response("Not found", { status: 404 });
    } });
  });
  const c = group((h) => ({ PATH: isolatedPath(h), OPENCODE_TUI_SERVER_URL: `http://127.0.0.1:${bridge.port}` }));
  afterAll(() => { bridge?.stop(true); });
  test("reports unavailable when discovery has no healthy candidate", async () => {
    const error = "OpenCode TUI server unavailable. Start the visible TUI with opencode --port <n>, or set OPENCODE_TUI_SERVER_URL=http://127.0.0.1:<n> before starting cockpit.";
    expect(await get(c.d, "/api/opencode-control/status", { session: c.f.opencodeSessionId })).toEqual({ ready: false, warnings: [], errors: [error] });
    expect(await post(c.d, "/api/send-opencode-message", { session: c.f.opencodeSessionId, text: "Hello" }, 502)).toEqual({ error, warnings: [] });
  });
  test("delivers through health, session, append and submit in that order", async () => {
    mode = "ready";
    seen.length = 0;
    expect(await post(c.d, "/api/send-opencode-message", { session: c.f.opencodeSessionId, text: "Hello OpenCode" })).toEqual({ delivered: true, delivery: "tui", serverUrl: `http://127.0.0.1:${bridge.port}`, warnings: [] });
    expect(seen).toEqual([
      { method: "GET", path: "/global/health", directory: null, body: null },
      { method: "GET", path: `/session/${c.f.opencodeSessionId}`, directory: null, body: null },
      { method: "POST", path: "/tui/append-prompt", directory: c.f.projectDir, body: { text: "Hello OpenCode" } },
      { method: "POST", path: "/tui/submit-prompt", directory: c.f.projectDir, body: null },
    ]);
  });
  test("requires true bodies and follows JavaScript truthiness for errors", async () => {
    mode = "ready";
    for (const [body, error] of [
      [{ data: { message: "append denied" } }, "append denied"],
      [{ data: { message: 0 }, message: false, error: "fallback error" }, "fallback error"],
      [{ data: { message: 42 }, message: "ignored" }, "42"],
      [{ data: { message: {} } }, "[object Object]"],
      [{ data: { message: [] } }, "OpenCode send failed"],
      [false, "OpenCode TUI append failed: 200"],
    ] as const) {
      appendBody = body;
      seen.length = 0;
      expect(await post(c.d, "/api/send-opencode-message", { session: c.f.opencodeSessionId, text: "Hello" }, 502)).toEqual({ error, warnings: [] });
      expect(seen.map((r) => r.path)).toEqual(["/global/health", `/session/${c.f.opencodeSessionId}`, "/tui/append-prompt"]);
    }
    appendBody = true;
    submitBody = { message: "submit denied" };
    expect(await post(c.d, "/api/send-opencode-message", { session: c.f.opencodeSessionId, text: "Hello" }, 502)).toEqual({ error: "submit denied", warnings: [] });
    submitBody = true;
  });
  test("compares fresh daemon tokens including null without coercion", async () => {
    const path = join(c.h.cockpitHome, "daemon.json");
    try {
      writeFileSync(path, JSON.stringify({ ...c.d.info, token: "replacement" }));
      expect(await get(c.d, "/api/opencode-control/status", { session: "bad" }, 401)).toEqual({ error: "unauthorized" });
      expect(await get(c.d, "/api/opencode-control/status", { session: "bad", token: "replacement" }, 400)).toEqual({ error: "invalid session" });
      writeFileSync(path, "{}");
      expect(await json(await fetch(c.d.base + "/api/opencode-control/status?session=bad"), 400)).toEqual({ error: "invalid session" });
      expect(await post(c.d, "/api/send-opencode-message", { token: null, session: "bad" }, 400)).toEqual({ error: "invalid session" });
      expect(await post(c.d, "/api/send-opencode-message", { token: 0, session: "bad" }, 401)).toEqual({ error: "unauthorized" });
      expect(await json(await fetch(c.d.base + "/api/send-opencode-message", { method: "POST", body: JSON.stringify({ session: "bad" }) }), 401)).toEqual({ error: "unauthorized" });
    } finally { writeFileSync(path, JSON.stringify(c.d.info)); }
  });
  test("reports a missing session and rejects bad tokens", async () => {
    mode = "missing";
    seen.length = 0;
    expect(await post(c.d, "/api/send-opencode-message", { session: c.f.opencodeSessionId, text: "Hello" }, 502)).toEqual({ error: "OpenCode session not found", warnings: [] });
    expect(seen.map((r) => r.path)).toEqual(["/global/health", `/session/${c.f.opencodeSessionId}`]);
    expect(await get(c.d, "/api/opencode-control/status", { session: c.f.opencodeSessionId, token: "bad" }, 401)).toEqual({ error: "unauthorized" });
    expect(await post(c.d, "/api/send-opencode-message", { session: c.f.opencodeSessionId, text: "Hello", token: "bad" }, 401)).toEqual({ error: "unauthorized" });
  });
});


describe("server: opencode closed candidate", () => {
  let closedPort: number;
  beforeAll(async () => { closedPort = await freePort(); });
  const c = group((h) => ({ PATH: isolatedPath(h), OPENCODE_TUI_SERVER_URL: `http://127.0.0.1:${closedPort}` }));
  test("returns unavailable status and 502 within two seconds per request", async () => {
    const error = "OpenCode TUI server unavailable. Start the visible TUI with opencode --port <n>, or set OPENCODE_TUI_SERVER_URL=http://127.0.0.1:<n> before starting cockpit.";
    let started = performance.now();
    expect(await get(c.d, "/api/opencode-control/status", { session: c.f.opencodeSessionId })).toEqual({ ready: false, warnings: [], errors: [error] });
    expect(performance.now() - started).toBeLessThan(2000);
    started = performance.now();
    expect(await post(c.d, "/api/send-opencode-message", { session: c.f.opencodeSessionId, text: "Hello" }, 502)).toEqual({ error, warnings: [] });
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("server: opencode candidate timeouts and auth", () => {
  const bridges: Array<ReturnType<typeof Bun.serve>> = [];
  const seen: string[] = [];
  beforeAll(() => {
    for (let index = 0; index < 3; index++) {
      bridges.push(Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
        expect(req.headers.get("authorization")).toBe("Basic dXNlcjpzZWNyZXQ=");
        const path = new URL(req.url).pathname;
        seen.push(`${index}:${path}`);
        if (index < 2) {
          await Bun.sleep(3500);
          return Response.json({ healthy: true });
        }
        if (path === "/global/health") return Response.json({ healthy: true });
        if (path.startsWith("/session/")) return Response.json({ directory: "" });
        expect(new URL(req.url).search).toBe("");
        return Response.json(true);
      } }));
    }
  });
  const c = group((h) => {
    const path = isolatedPath(h);
    writeFileSync(join(path, "ps"), `#!/bin/sh
printf '%s\n' 'COMMAND' 'opencode --port ${bridges[1].port}' '/usr/local/bin/opencode -p ${bridges[2].port} --hostname 127.0.0.1'
`);
    return { PATH: path, OPENCODE_TUI_SERVER_URL: `http://127.0.0.1:${bridges[0].port}///`,
      OPENCODE_SERVER_URL: "http://127.0.0.1:1", OPENCODE_SERVER_USERNAME: "user", OPENCODE_SERVER_PASSWORD: "secret" };
  });
  afterAll(() => { for (const bridge of bridges) bridge.stop(true); });
  test("times out two candidates in TS order and delivers through the third", async () => {
    const started = performance.now();
    expect(await post(c.d, "/api/send-opencode-message", { session: c.f.opencodeSessionId, text: "Hello" })).toEqual({
      delivered: true, delivery: "tui", serverUrl: `http://127.0.0.1:${bridges[2].port}`, warnings: [],
    });
    expect(seen).toEqual(["0:/global/health", "1:/global/health", "2:/global/health",
      `2:/session/${c.f.opencodeSessionId}`, "2:/tui/append-prompt", "2:/tui/submit-prompt"]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1900);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
