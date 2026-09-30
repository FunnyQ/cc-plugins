import type { Subprocess } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { command, PLUGIN_ROOT, underTest, type Proc } from "./launcher";

export type Env = Record<string, string>;
export type Homes = { cockpitHome: string; configHome: string; dataHome: string; root: string };

export function makeHomes(): Homes {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-contract-")));
  const homes = {
    root,
    cockpitHome: join(root, "cockpit"),
    configHome: join(root, "config"),
    dataHome: join(root, "data"),
  };
  for (const dir of [homes.cockpitHome, homes.configHome, homes.dataHome]) mkdirSync(dir);
  return homes;
}

export async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port === 5858 ? freePort() : port;
}

export function baseEnv(h: Homes, extra: Env = {}): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of Object.keys(env)) {
    if (
      ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_PROJECT_DIR", "PLUGIN_ROOT", "RELAY_DELEGATED", "Q_DELEGATION_HOME"].includes(key) ||
      key.startsWith("OPENCODE_") ||
      (key.startsWith("COCKPIT_") && key !== "COCKPIT_BIN" && key !== "COCKPIT_PLUGIN_ROOT")
    ) delete env[key];
  }
  Object.assign(env, { HOME: h.root, COCKPIT_HOME: h.cockpitHome, XDG_CONFIG_HOME: h.configHome, XDG_DATA_HOME: h.dataHome });
  if (underTest === "rust") env.COCKPIT_PLUGIN_ROOT = PLUGIN_ROOT;
  return { ...env, ...extra };
}

export type ProviderFixtures = {
  claudeProjectsDir: string; claudeSessionsDir: string;
  codexDir: string; codexStateDb: string; codexSessionsDir: string;
  opencodeDb: string; projectDir: string; claudeSessionId: string;
  codexThreadId: string; opencodeSessionId: string;
};

export function makeProviderFixtures(h: Homes): ProviderFixtures {
  const f: ProviderFixtures = {
    claudeProjectsDir: join(h.root, "claude/projects"),
    claudeSessionsDir: join(h.root, "claude/sessions"),
    codexDir: join(h.root, "codex"),
    codexStateDb: join(h.root, "codex/state_5.sqlite"),
    codexSessionsDir: join(h.root, "codex/sessions"),
    opencodeDb: join(h.root, "opencode/opencode.db"),
    projectDir: join(h.root, "project"),
    claudeSessionId: crypto.randomUUID(),
    codexThreadId: crypto.randomUUID(),
    opencodeSessionId: `ses_${crypto.randomUUID().replaceAll("-", "")}`,
  };
  for (const dir of [f.claudeProjectsDir, f.claudeSessionsDir, f.codexSessionsDir, join(h.root, "opencode"), f.projectDir]) mkdirSync(dir, { recursive: true });
  const git = Bun.spawnSync(["git", "init", "-q"], { cwd: f.projectDir, env: baseEnv(h) });
  if (git.exitCode !== 0) throw new Error(`Fixture git init failed: ${git.stderr.toString()}`);
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const claudeDir = join(f.claudeProjectsDir, f.projectDir.replace(/[/.]/g, "-"));
  mkdirSync(claudeDir);
  const claudeEntries = [
    { type: "user", message: { role: "user", content: "Fixture request" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Fixture answer" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tool-fixture", name: "Read", input: { file_path: "README.md" } }] } },
  ];
  writeFileSync(join(claudeDir, `${f.claudeSessionId}.jsonl`), claudeEntries.map((entry) => JSON.stringify({ ...entry, uuid: crypto.randomUUID(), timestamp })).join("\n") + "\n");
  writeFileSync(join(f.claudeSessionsDir, `${process.pid}.json`), JSON.stringify({ sessionId: f.claudeSessionId, cwd: f.projectDir, startedAt: now, updatedAt: now, status: "idle" }));
  const rollout = join(f.codexSessionsDir, `rollout-${f.codexThreadId}.jsonl`);
  writeFileSync(rollout, JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Fixture request" }] } }) + "\n");
  const codex = new Database(f.codexStateDb, { create: true });
  try {
    codex.exec(`create table threads (
      id text primary key, cwd text, title text, archived integer, rollout_path text,
      created_at integer, updated_at integer, created_at_ms integer, updated_at_ms integer
    )`);
    codex.query("insert into threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(f.codexThreadId, f.projectDir, "Fixture thread", 0, rollout, Math.floor(now / 1000), Math.floor(now / 1000), now, now);
  } finally {
    codex.close();
  }
  const opencode = new Database(f.opencodeDb, { create: true });
  try {
    opencode.exec(`create table session (
      id text primary key, directory text, title text, time_created integer,
      time_updated integer, time_archived integer
    );
    create table message (
      id text primary key, session_id text, time_created integer, time_updated integer, data text
    );
    create table part (
      id text primary key, message_id text, time_created integer, data text
    );`);
    opencode.query("insert into session values (?, ?, ?, ?, ?, ?)").run(f.opencodeSessionId, f.projectDir, "Fixture session", now, now, null);
    // The transcript reader accepts message content when the joined part table is empty.
    opencode.query("insert into message values (?, ?, ?, ?, ?)").run("msg_fixture", f.opencodeSessionId, now, now, JSON.stringify({ role: "user", content: "Fixture request" }));
  } finally {
    opencode.close();
  }
  return f;
}

export function fixtureEnv(f: ProviderFixtures): Env {
  return {
    COCKPIT_CLAUDE_PROJECTS_DIR: f.claudeProjectsDir,
    COCKPIT_CLAUDE_SESSIONS_DIR: f.claudeSessionsDir,
    COCKPIT_CODEX_DIR: f.codexDir,
    COCKPIT_CODEX_STATE_DB: f.codexStateDb,
    COCKPIT_CODEX_SESSIONS_DIR: f.codexSessionsDir,
    COCKPIT_OPENCODE_DB: f.opencodeDb,
  };
}

export type Daemon = { proc: Subprocess; port: number; token: string; base: string; info: any };

export async function startDaemon(env: Env, opts: { port?: number } = {}): Promise<Daemon> {
  if (!env.COCKPIT_HOME) throw new Error("startDaemon requires an isolated COCKPIT_HOME");
  const port = opts.port ?? await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(command("server", ["--no-open", "--port", String(port)]), { env, stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  const deadline = Date.now() + 10000;
  try {
    for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt++) {
      if (proc.exitCode !== null) throw new Error("Daemon exited before readiness");
      try {
        const info = JSON.parse(readFileSync(join(env.COCKPIT_HOME, "daemon.json"), "utf8"));
        if (info.port === port && info.pid === proc.pid) {
          const response = await fetch(`${base}/api/token`, { signal: AbortSignal.timeout(100) });
          if (response.ok) {
            await response.arrayBuffer();
            return { proc, port, token: info.token, base, info };
          }
          await response.body?.cancel();
        }
      } catch {
        // A partially written daemon record or refused connection is retried.
      }
      await Bun.sleep(50);
    }
    throw new Error("Daemon did not become ready within 100 probes (10 s maximum)");
  } catch (error) {
    await stopDaemon({ proc, port, token: "", base, info: null });
    throw new Error(`${error}\n${await stdout}\n${await stderr}`);
  }
}

export async function stopDaemon(d: Daemon): Promise<void> {
  if (d.proc.exitCode !== null) return;
  d.proc.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    d.proc.exited.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 3000); }),
  ]);
  clearTimeout(timer);
  if (!exited) {
    d.proc.kill("SIGKILL");
    await d.proc.exited;
  }
}

export function run(proc: Proc, argv: string[], opts: { env: Env; cwd?: string; stdin?: string }): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(command(proc, argv), {
    env: opts.env, cwd: opts.cwd,
    stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
    stdout: "pipe", stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

export function readJsonl(path: string): any[] {
  return readFileSync(path, "utf8").split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

export function cleanup(...dirs: string[]): void {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}
