import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { command, SCRIPTS_DIR } from "./launcher";
import { baseEnv, cleanup, fixtureEnv, freePort, makeHomes, makeProviderFixtures, readJsonl, run, startDaemon, stopDaemon, type Daemon, type Env } from "./fixtures";

let h: ReturnType<typeof makeHomes>;
let f: ReturnType<typeof makeProviderFixtures>;
let env: Env;
let daemons: Daemon[];
let children: ReturnType<typeof Bun.spawn>[];
let controllers: AbortController[];
let servers: ReturnType<typeof Bun.serve>[];
beforeEach(() => {
  h = makeHomes(); f = makeProviderFixtures(h);
  env = baseEnv(h, fixtureEnv(f)); daemons = []; children = []; controllers = []; servers = [];
});
afterEach(async () => {
  for (const c of controllers) c.abort();
  for (const p of children) { if (p.exitCode === null) p.kill("SIGKILL"); await p.exited; }
  for (const s of servers) s.stop(true);
  for (const d of daemons) await stopDaemon(d);
  cleanup(h.root);
});
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const cli = (argv: string[]) => run("cli", argv, { env, cwd: f.projectDir });
const trail = () => join(f.projectDir, ".cockpit/logs", `${f.claudeSessionId}.jsonl`);
const config = () => join(h.configHome, "q-lab/cockpit/config.json");
const registry = () => join(h.cockpitHome, "registry.json");
function success(argv: string[], stdout: string) { expect(cli(argv)).toEqual({ exitCode: 0, stdout, stderr: "" }); }
function seed() {
  const path = trail(); mkdirSync(join(f.projectDir, ".cockpit/logs"), { recursive: true });
  const call = crypto.randomUUID();
  writeFileSync(path, JSON.stringify({ id: call, type: "decision", decision: "Choose", reason: "Need input", needs_your_call: true, timestamp: new Date().toISOString() }) + "\n");
  writeFileSync(registry(), JSON.stringify({ sessions: [{ provider: "claude", project: f.projectDir, sessionId: f.claudeSessionId, logPath: path, lastHeartbeat: new Date().toISOString() }] }, null, 2));
  return call;
}
async function daemon() {
  env.COCKPIT_WAIT_TIMEOUT_MS = "1500";
  const d = await startDaemon(env); daemons.push(d); return d;
}
function background(argv: string[]) {
  const proc = Bun.spawn(command("cli", argv), { env, cwd: f.projectDir, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  children.push(proc);
  const result = Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
  return { proc, result };
}
async function watch(d: Daemon) {
  const c = new AbortController(); controllers.push(c);
  const response = await fetch(`${d.base}/api/permission-stream?session=${f.claudeSessionId}&token=${d.token}`, { signal: c.signal });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  await reader.read();
  return reader;
}
async function park() {
  const pending = background(["wait", f.claudeSessionId]);
  await Bun.sleep(250);
  expect(pending.proc.exitCode).toBeNull();
  return pending;
}
const usage = [
  "usage: cockpit <log|scribe|prep|config|wait|send|restart|nudge> [args]",
  "  cockpit log    --session <id> --decision D --reason R [--tradeoff T]",
  '                 [--facet "LABEL: text"]... [--file p]... [--option o]...',
  "                 [--diagram MERMAID] [--needs-call]",
  "  cockpit scribe --type <kind> --text <body> [--title <headline>]",
  "                 [--file <path>]... [--diagram MERMAID] [--session <id>]",
  "  cockpit scribe --recent [N] | --prep [--provider <p>]",
  "  cockpit prep   [--provider <p>]",
  "  cockpit config --log-language <lang> | get-language",
  "                 | --answer-here on|off | get-answer-here",
  "  cockpit wait   <sessionId>", "  cockpit send   <sessionId> <answer>",
  "  cockpit restart [--port N] [--no-open]",
  "  cockpit nudge  <on|off|toggle|clear|status> [--scope session|project|user]",
].join("\n") + "\n";

describe("cli: trail", () => {
  test("log records, registry heartbeat, calls, scribe and prep", async () => {
    const sid = f.claudeSessionId;
    success(["log", "--session", sid, "--decision", "Use files", "--reason", "Portable", "--tradeoff", "IO", "--facet", "RISK: latency", "--file", "a.ts", "--option", "SQLite"], `cockpit: logged decision for ${sid}\n`);
    const [record] = readJsonl(trail());
    expect(record).toEqual({ id: expect.any(String), type: "decision", kind: "decision", source: "agent", decision: "Use files", reason: "Portable", tradeoff: "IO", facets: [{ label: "RISK", text: "latency" }], needs_your_call: false, options: ["SQLite"], files: ["a.ts"], timestamp: expect.any(String) });
    expect(record.id).toMatch(/^[0-9a-f-]{36}$/); expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
    const entry = json(registry()).sessions[0];
    expect(entry).toEqual({ provider: "claude", project: f.projectDir, sessionId: sid, logPath: trail(), lastHeartbeat: expect.any(String) });
    await Bun.sleep(5);
    const callResult = cli(["log", "--session", sid, "--decision", "Choose", "--reason", "Input", "--needs-call"]);
    const call = readJsonl(trail())[1];
    expect(callResult).toEqual({ exitCode: 0, stdout: `cockpit: logged decision for ${sid}\n  call:  ${call.id}\n`, stderr: "" });
    expect(call.needs_your_call).toBe(true); expect(call.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(json(registry()).sessions).toHaveLength(1);
    expect(Date.parse(json(registry()).sessions[0].lastHeartbeat)).toBeGreaterThan(Date.parse(entry.lastHeartbeat));
    success(["scribe", "--session", sid, "--type", "learning", "--text", "Body", "--title", "Lesson", "--file", "a.ts"], `cockpit: scribed learning for ${sid}\n`);
    // pins TS quirk: scribe uses the decision record type, with source and kind identifying it.
    expect(readJsonl(trail())[2]).toEqual({ id: expect.any(String), type: "decision", kind: "learning", source: "scribe", decision: "Lesson", reason: "Body", tradeoff: "", facets: [], needs_your_call: false, options: [], files: ["a.ts"], timestamp: expect.any(String) });
    // pins TS quirk: prep does not print the seeded trail.
    success(["prep", "--session", sid], `Session id:\n${sid}\n\nDecision-log language:\nEnglish\n`);
  });
  test("diagram lint preserves valid source and rejects malformed source without writing", () => {
    const args = ["log", "--session", f.claudeSessionId, "--decision", "Diagram", "--reason", "Show flow", "--diagram"];
    success([...args, "flowchart LR\n  A-->B"], `cockpit: logged decision for ${f.claudeSessionId}\n`);
    expect(readJsonl(trail())[0].diagram).toBe("flowchart LR\n  A-->B");
    const before = readFileSync(trail(), "utf8");
    const result = cli([...args, "flowchart LR\n  A-->"]);
    expect(result.exitCode).toBe(1); expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("cockpit log: --diagram failed lint — fix the Mermaid source and re-run:\n");
    expect(result.stderr).toContain("\n  - "); expect(readFileSync(trail(), "utf8")).toBe(before);
  });
  test("help and unknown subcommand do not write", () => {
    success(["log", "--help"], usage); expect(existsSync(trail())).toBe(false); expect(existsSync(registry())).toBe(false);
    expect(cli(["unknown"])).toEqual({ exitCode: 1, stdout: "", stderr: 'cockpit: unknown subcommand "unknown"\nusage: cockpit <log|scribe|prep|config|wait|send|restart|nudge> [args]\n' });
  });
});

describe("cli: config", () => {
  test("language and answer-here round trip", () => {
    success(["config", "get-language"], "English\n");
    success(["config", "--log-language", "zh-TW"], "cockpit: log_language = zh-TW\n");
    success(["config", "get-language"], "zh-TW\n");
    for (const state of ["on", "off"]) {
      success(["config", "--answer-here", state], `cockpit: answer_here = ${state}\n`);
      expect(json(config())).toEqual({ log_language: "zh-TW", answer_here: state === "on" });
      success(["config", "get-answer-here"], `${state}\n`);
    }
    expect(readFileSync(config(), "utf8")).toBe(JSON.stringify(json(config()), null, 2) + "\n");
  });
  test("nudge actions, persistence and session > project > user precedence", () => {
    env.CLAUDE_CODE_SESSION_ID = f.claudeSessionId;
    const states: Record<string, string> = { session: "default", project: "default", user: "default" };
    function nudge(action: string, scope: string, state: string) {
      if (action !== "status") states[scope] = state;
      const effective = [states.session, states.project, states.user].find(s => s !== "default") ?? "ON";
      success(["nudge", action, "--scope", scope], `scribe nudges: ${effective} (effective)${action === "status" ? "" : ` — ${scope} set to ${state}`}\n  session: ${states.session} · project: ${states.project} · user: ${states.user}\n`);
    }
    nudge("status", "session", "default"); nudge("off", "user", "OFF"); nudge("on", "project", "ON"); nudge("off", "session", "OFF");
    expect(json(config()).nudges).toEqual({ user: "off", projects: { [f.projectDir]: "on" } });
    const store = json(join(h.cockpitHome, "scribe-nudge-toggle.json"));
    expect(store).toEqual({ [f.claudeSessionId]: { state: "off", ts: expect.any(Number) } });
    for (const scope of ["session", "project", "user"]) {
      nudge("status", scope, states[scope]); nudge("toggle", scope, states[scope] === "OFF" ? "ON" : "OFF");
      nudge("on", scope, "ON"); nudge("off", scope, "OFF"); nudge("clear", scope, "default");
    }
    expect(json(join(h.cockpitHome, "scribe-nudge-toggle.json"))).toEqual({});
    expect(json(config()).nudges).toEqual({});
  });
});

describe("cli: find-session", () => {
  test("resolves each provider and pins missing transcripts and invalid provider", () => {
    for (const [provider, sid] of [["claude", f.claudeSessionId], ["codex", f.codexThreadId], ["opencode", f.opencodeSessionId]]) success(["find-session", "--provider", provider, f.projectDir], `${sid}\n`);
    const missing = join(h.root, "empty"); mkdirSync(missing);
    expect(cli(["find-session", "--provider", "claude", missing])).toEqual({ exitCode: 1, stdout: "", stderr: `find-session: no transcript dir for ${missing}\n  (looked in ${join(f.claudeProjectsDir, missing.replace(/[/.]/g, "-"))})\n` });
    expect(cli(["find-session", "--provider", "x", f.projectDir])).toEqual({ exitCode: 1, stdout: "", stderr: 'find-session: invalid provider "x"\n' });
  });
});

describe("cli: wait", () => {
  test("answer-here off returns not_watching exit 4", async () => {
    seed(); await daemon();
    success(["config", "--answer-here", "off"], "cockpit: answer_here = off\n");
    expect(await background(["wait", f.claudeSessionId]).result).toEqual({ exitCode: 4, stdout: "", stderr: "cockpit wait: nobody is watching — the answer-here switch is off\n" });
  });
  test("live watcher parks and respond prints the answer", async () => {
    const call = seed(); const d = await daemon(); success(["config", "--answer-here", "on"], "cockpit: answer_here = on\n");
    await watch(d); const p = await park();
    const r = await fetch(`${d.base}/api/respond`, { method: "POST", body: JSON.stringify({ session: f.claudeSessionId, call, answer: "Proceed", token: d.token }) });
    expect(await r.json()).toEqual({ delivered: true });
    expect(await p.result).toEqual({ exitCode: 0, stdout: "Proceed\n", stderr: "" });
  });
  test("new call while parked returns superseded exit 3", async () => {
    seed(); const d = await daemon(); success(["config", "--answer-here", "on"], "cockpit: answer_here = on\n");
    await watch(d); const p = await park();
    expect(cli(["log", "--session", f.claudeSessionId, "--needs-call", "--decision", "New", "--reason", "Changed"]).exitCode).toBe(0);
    // pins TS quirk: supersession is detected on the next hop, not when the trail changes.
    expect(await p.result).toEqual({ exitCode: 3, stdout: "", stderr: "cockpit wait: call is no longer open (superseded)\n" });
  });
  test("max wait ends with no answer", async () => {
    seed(); const d = await daemon(); success(["config", "--answer-here", "on"], "cockpit: answer_here = on\n");
    env.COCKPIT_WAIT_MAX_MS = "100"; await watch(d);
    expect(await background(["wait", f.claudeSessionId]).result).toEqual({ exitCode: 1, stdout: "", stderr: "cockpit wait: no answer received\n" });
  });
});

describe("cli: send", () => {
  async function observedSend(d: Daemon, args: string[]) {
    const requests: { path: string; method: string; body: unknown }[] = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: await freePort(), async fetch(req) {
      const url = new URL(req.url); const body = await req.text();
      requests.push({ path: url.pathname, method: req.method, body: JSON.parse(body) });
      return fetch(`${d.base}${url.pathname}`, { method: req.method, headers: { "Content-Type": "application/json" }, body });
    } });
    servers.push(server);
    writeFileSync(join(h.cockpitHome, "daemon.json"), JSON.stringify({ ...d.info, port: server.port }));
    const result = await background(["send", ...args]).result;
    writeFileSync(join(h.cockpitHome, "daemon.json"), JSON.stringify(d.info));
    expect(requests).toEqual([{ path: "/api/respond", method: "POST", body: { session: f.claudeSessionId, answer: args[1], call: args.includes("--call") ? args.at(-1) : readJsonl(trail())[0].id, token: d.token } }]);
    return result;
  }
  test("respond delivers to parked wait and records exactly one response without inbox requests", async () => {
    const call = seed(); const d = await daemon(); success(["config", "--answer-here", "on"], "cockpit: answer_here = on\n");
    await watch(d); const p = await park();
    expect(await observedSend(d, [f.claudeSessionId, "Ship it"])).toEqual({ exitCode: 0, stdout: "delivered: true\n", stderr: "" });
    expect(await p.result).toEqual({ exitCode: 0, stdout: "Ship it\n", stderr: "" });
    expect(readJsonl(trail()).filter(r => r.type === "response")).toEqual([{ id: expect.any(String), type: "response", call, answer: "Ship it", ts: expect.any(String) }]);
  });
  test("nobody parked still logs answer and explicit call overrides resolution", async () => {
    const call = seed(); const d = await daemon();
    const stdout = "delivered: false\n  (answer logged, but the session isn't parked/listening right now)\n";
    expect(await observedSend(d, [f.claudeSessionId, "Later"])).toEqual({ exitCode: 0, stdout, stderr: "" });
    expect(readJsonl(trail()).at(-1)).toEqual({ id: expect.any(String), type: "response", call, answer: "Later", ts: expect.any(String) });
    expect(await observedSend(d, [f.claudeSessionId, "Override", "--call", "explicit-call"])).toEqual({ exitCode: 0, stdout, stderr: "" });
    expect(readJsonl(trail()).at(-1).call).toBe("explicit-call");
  });
  test("missing args and daemon non-2xx fail", async () => {
    expect(cli(["send"])).toEqual({ exitCode: 1, stdout: "", stderr: "cockpit send: <sessionId> <answer> is required\n" });
    seed(); const d = await daemon(); const before = readFileSync(trail(), "utf8");
    // pins TS quirk: changing daemon.json.token changes the daemon's own token too.
    const rejecting = Bun.serve({ hostname: "127.0.0.1", port: await freePort(), fetch() {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    } });
    servers.push(rejecting);
    writeFileSync(join(h.cockpitHome, "daemon.json"), JSON.stringify({ ...d.info, port: rejecting.port, token: "wrong" }));
    expect(await background(["send", f.claudeSessionId, "No"]).result).toEqual({ exitCode: 1, stdout: "", stderr: "cockpit send: unauthorized (HTTP 401)\n" });
    expect(readFileSync(trail(), "utf8")).toBe(before);
  });
});

describe("cli: restart", () => {
  test("restart supersedes the daemon and serves this install", async () => {
    const d = await daemon();
    try {
      const result = await background(["restart", "--no-open", "--port", String(d.port)]).result;
      const info = json(join(h.cockpitHome, "daemon.json"));
      expect(result).toEqual({ exitCode: 0, stdout: `cockpit: daemon restarted → http://localhost:${d.port} (pid ${info.pid})\n  serving: ${SCRIPTS_DIR}\n`, stderr: "" });
      expect(info.pid).not.toBe(d.proc.pid); expect(info.root).toBe(SCRIPTS_DIR); expect(info.root).toEndWith("/skills/cockpit/scripts");
      await d.proc.exited; expect(() => process.kill(d.proc.pid, 0)).toThrow();
    } finally {
      const info = json(join(h.cockpitHome, "daemon.json"));
      if (info.pid !== d.proc.pid) {
        try { process.kill(info.pid, "SIGTERM"); } catch {}
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try { process.kill(info.pid, 0); } catch { break; }
          await Bun.sleep(25);
        }
        try { process.kill(info.pid, "SIGKILL"); } catch {}
      }
    }
  });
});
