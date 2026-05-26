#!/usr/bin/env bun
// cockpit daemon — one global Bun server on 127.0.0.1, serves the no-build SPA
// and the cockpit APIs. A PID file (~/.cockpit/daemon.json) records the running
// instance's pid/port/token/root: starting twice from the same install reuses it
// (never double-binds), but a launcher from a moved or updated install supersedes
// the stale daemon (whose served paths would 404). See daemon-lifecycle.ts.
import {
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { extname, resolve, relative, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { projectsPayload, sessionsPayload } from "./registry";
import { handleLogStream } from "./log-stream";
import {
  handleTranscriptHistory,
  handleTranscriptStream,
} from "./transcript-stream";
import { handleWait, handleRespond } from "./broker";
import { handleInbox, handleSendMessage } from "./inbox";
import { handleCodexControlStatus, handleSendCodexMessage } from "./codex-send";
import { handleProjectInfo } from "./project-info";
import { handleDesignSystem } from "./design-system";
import { jsonResponse, jsonError } from "./http";
import { decideStartup, type DaemonInfo } from "./daemon-lifecycle";

const DIST = resolve(import.meta.dir, "..", "dashboard", "dist");
const DEFAULT_PORT = 5858;
// Identifies this install in daemon.json so a moved/updated launcher can tell a
// stale daemon (different root) from a real running singleton (same root).
const ROOT = import.meta.dir;

// ---------- central dir (overridable for tests) ----------

function cockpitHome(): string {
  return process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
}

function daemonInfoPath(): string {
  return join(cockpitHome(), "daemon.json");
}

// ---------- args ----------

function parsePort(): number {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--port");
  if (idx >= 0 && argv[idx + 1]) {
    const p = parseInt(argv[idx + 1], 10);
    if (Number.isFinite(p) && p > 0 && p < 65536) return p;
  }
  return DEFAULT_PORT;
}

const NO_OPEN = process.argv.includes("--no-open");

// Open the URL in the default browser. Called both on a fresh bind and when we
// reuse an already-running daemon, so re-running the skill always lands the user
// on the cockpit even when the daemon was started headless (the channel MCP
// starts it with --no-open).
function openBrowser(url: string): void {
  if (NO_OPEN) return;
  const opener =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(opener, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // ignore — URL already printed
  }
}

// ---------- PID-file reuse ----------

function readDaemonInfo(): DaemonInfo | null {
  try {
    const raw = readFileSync(daemonInfoPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.pid === "number" && typeof parsed?.port === "number") {
      return parsed as DaemonInfo;
    }
  } catch {
    // missing or corrupt — treat as no daemon
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH → no such process (dead); EPERM → exists but not ours (alive).
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function writeDaemonInfo(info: DaemonInfo): void {
  const home = cockpitHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(daemonInfoPath(), JSON.stringify(info, null, 2) + "\n");
}

// Block until `pid` is gone (so it releases the port), up to `timeoutMs`.
function waitForExit(pid: number, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    Bun.sleepSync(50);
  }
}

// Decide reuse / supersede / start against the recorded daemon. On reuse, print
// the URL and exit. On supersede (the running daemon is from a moved or
// out-of-date install — its served paths are stale), terminate it and fall
// through to bind fresh. On start, just fall through.
function startupGuard(): void {
  const decision = decideStartup(readDaemonInfo(), ROOT, isAlive);
  if (decision.action === "reuse") {
    const { info } = decision;
    console.log(
      `cockpit daemon already running → http://localhost:${info.port} (pid ${info.pid})`,
    );
    openBrowser(`http://localhost:${info.port}`);
    process.exit(0);
  }
  if (decision.action === "supersede") {
    const { info } = decision;
    console.log(
      `superseding stale cockpit daemon (pid ${info.pid}, root ${info.root ?? "unknown"}) — this install is ${ROOT}`,
    );
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      // already gone
    }
    waitForExit(info.pid, 1500);
    if (isAlive(info.pid)) {
      try {
        process.kill(info.pid, "SIGKILL");
      } catch {
        // already gone
      }
      waitForExit(info.pid, 1000);
    }
    Bun.sleepSync(100); // let the socket fully release before we bind
  }
}

// ---------- mime ----------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// ---------- api handlers ----------

function handleSessions(): Response {
  try {
    return jsonResponse(sessionsPayload());
  } catch (err) {
    return jsonError(err);
  }
}

function handleProjects(): Response {
  try {
    return jsonResponse(projectsPayload());
  } catch (err) {
    return jsonError(err);
  }
}

// The SPA needs the daemon token to POST /api/respond (bridge). Localhost-only
// (the server binds 127.0.0.1), read fresh from daemon.json so it survives a
// restart. Never hardcode it in the page.
function handleToken(): Response {
  const info = readDaemonInfo();
  if (!info?.token) return jsonError("daemon token unavailable", 503);
  return jsonResponse({ token: info.token });
}

// ---------- static serving ----------

function isInsideDist(filePath: string): boolean {
  const rel = relative(DIST, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function serveStatic(pathname: string): Response {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = resolve(DIST, "." + rel);
  if (!isInsideDist(filePath) || !existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    if (!statSync(filePath).isFile()) {
      return new Response("Not found", { status: 404 });
    }
  } catch {
    return new Response("Not found", { status: 404 });
  }
  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Type": mimeFor(filePath),
      "Cache-Control": "no-cache",
    },
  });
}

// ---------- server ----------

startupGuard();

const port = parsePort();

function buildServer() {
  return Bun.serve({
    port,
    hostname: "127.0.0.1",
    // The long-poll (/api/wait) holds a connection up to ~240s with no data, and
    // the SSE streams only ping every 25s. Bun's default idleTimeout is 10s —
    // which would silently drop a parked wait and stall live streams. Raise it to
    // the max (255s); the broker hop (240s) and SSE pings (25s) both fit under it.
    idleTimeout: 255,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/projects") return handleProjects();
      if (url.pathname === "/api/token") return handleToken();
      if (url.pathname === "/api/design-system") return handleDesignSystem();
      if (url.pathname === "/api/project-info") return handleProjectInfo(req);
      if (url.pathname === "/api/sessions") return handleSessions();
      if (url.pathname === "/api/log/stream") return handleLogStream(req);
      if (url.pathname === "/api/transcript/stream")
        return handleTranscriptStream(req);
      if (url.pathname === "/api/transcript/history")
        return handleTranscriptHistory(req);
      if (url.pathname === "/api/wait") return handleWait(req);
      if (url.pathname === "/api/respond") return handleRespond(req);
      if (url.pathname === "/api/inbox") return handleInbox(req);
      if (url.pathname === "/api/send-message") return handleSendMessage(req);
      if (url.pathname === "/api/codex-control/status")
        return handleCodexControlStatus(req);
      if (url.pathname === "/api/send-codex-message")
        return handleSendCodexMessage(req);
      return serveStatic(url.pathname);
    },
  });
}

// startupGuard() already exited (reuse) or cleared a stale daemon (supersede).
// If we're here the port should be free; if some *other* process holds it, do
// NOT kill it (it isn't ours) — fail with a clear message instead.
let server: ReturnType<typeof Bun.serve>;
try {
  server = buildServer();
} catch (err) {
  if ((err as { code?: string }).code === "EADDRINUSE") {
    console.error(
      `cockpit: port ${port} is in use by another process — stop it or pass --port <n>.`,
    );
    process.exit(1);
  }
  throw err;
}

writeDaemonInfo({
  pid: process.pid,
  port: server.port,
  token: randomBytes(16).toString("hex"),
  root: ROOT,
});

const url = `http://localhost:${server.port}`;
console.log(`cockpit → ${url}`);
openBrowser(url);
