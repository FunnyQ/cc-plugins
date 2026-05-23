#!/usr/bin/env bun
// cockpit daemon — one global Bun server on 127.0.0.1, serves the no-build SPA
// and the cockpit APIs. Reuses an already-running instance via a PID file
// (~/.cockpit/daemon.json) so starting twice never double-binds.
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
import { spawn, spawnSync } from "node:child_process";

const DIST = resolve(import.meta.dir, "..", "dashboard", "dist");
const DEFAULT_PORT = 5858;

type DaemonInfo = { pid: number; port: number; token: string };

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

function killPort(port: number): void {
  if (process.platform === "win32") return;
  const lsof = spawnSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8" });
  const pids = (lsof.stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (pids.length === 0) return;
  console.log(`Port ${port} in use by PID(s) ${pids.join(", ")} — killing.`);
  spawnSync("kill", ["-9", ...pids]);
  // brief settle so the next bind doesn't EADDRINUSE
  spawnSync("sleep", ["0.2"]);
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

// If a live daemon already owns the PID file, print its URL and exit (reuse).
function reuseIfRunning(): void {
  const info = readDaemonInfo();
  if (info && isAlive(info.pid)) {
    console.log(
      `cockpit daemon already running → http://localhost:${info.port} (pid ${info.pid})`,
    );
    process.exit(0);
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

// ---------- json helpers (copied from token-atlas live.ts) ----------

function jsonResponse(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function jsonError(err: unknown, status = 500): Response {
  const msg = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: msg }, status);
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

reuseIfRunning();

const port = parsePort();
killPort(port);

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    // endpoints wired by later tasks:
    // if (url.pathname === "/api/projects") return handleProjects()
    // if (url.pathname === "/api/sessions") return handleSessions()
    // if (url.pathname === "/api/log/stream") return handleLogStream(req)
    // if (url.pathname === "/api/transcript/stream") return handleTranscriptStream(req)
    // if (url.pathname === "/api/wait") return handleWait(req)
    // if (url.pathname === "/api/respond") return handleRespond(req)
    return serveStatic(url.pathname);
  },
});

writeDaemonInfo({
  pid: process.pid,
  port: server.port,
  token: randomBytes(16).toString("hex"),
});

const url = `http://localhost:${server.port}`;
console.log(`cockpit → ${url}`);

if (!NO_OPEN) {
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
