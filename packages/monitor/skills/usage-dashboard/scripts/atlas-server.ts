#!/usr/bin/env bun
import {
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { extname, resolve, relative, isAbsolute, join } from "node:path";
import { spawn } from "node:child_process";
import { buildStats, refreshPricingOverride } from "./api.ts";
import {
  getLiveSessions,
  cockpitDaemonPort,
  jsonResponse,
  jsonError,
} from "./live.ts";
import { decideStartup, type AtlasInfo } from "./atlas-lifecycle";
import { cockpitHome } from "../../cockpit/scripts/cockpit-home";

const DIST = resolve(import.meta.dir, "..", "dashboard", "dist");
const DEFAULT_PORT = 5938;
const ROOT = import.meta.dir;

// ---------- central dir ----------

function atlasInfoPath(): string {
  return join(cockpitHome(), "atlas.json");
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
// reuse an already-running server, so re-running the skill always lands the user
// on the dashboard even when the daemon was started headless (e.g. --no-open).
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

function readAtlasInfo(): AtlasInfo | null {
  try {
    const raw = readFileSync(atlasInfoPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.pid === "number" &&
      typeof parsed?.port === "number" &&
      typeof parsed?.root === "string"
    ) {
      return parsed as AtlasInfo;
    }
  } catch {
    // missing or corrupt — treat as no atlas server
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

function writeAtlasInfo(info: AtlasInfo): void {
  const home = cockpitHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(atlasInfoPath(), JSON.stringify(info, null, 2) + "\n");
}

function waitForExit(pid: number, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return;
    Bun.sleepSync(50);
  }
}

function startupGuard(): void {
  const decision = decideStartup(readAtlasInfo(), ROOT, isAlive);
  if (decision.action === "reuse") {
    const { info } = decision;
    console.log(
      `Claude Stats Dashboard already running → http://localhost:${info.port} (pid ${info.pid})`,
    );
    openBrowser(`http://localhost:${info.port}`);
    process.exit(0);
  }
  if (decision.action === "supersede") {
    const { info } = decision;
    console.log(
      `superseding stale atlas server (pid ${info.pid}, root ${info.root ?? "unknown"}) — this install is ${ROOT}`,
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
    Bun.sleepSync(100);
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

// ---------- handlers ----------

function isInsideDist(filePath: string): boolean {
  const rel = relative(DIST, filePath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function serveStatic(pathname: string): Response {
  // Default to index.html
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
  // Bun.file is async/streamed — does not block the event loop.
  return new Response(Bun.file(filePath), {
    headers: {
      "Content-Type": mimeFor(filePath),
      "Cache-Control": "no-cache",
    },
  });
}

async function handleStats(): Promise<Response> {
  try {
    return jsonResponse(await buildStats());
  } catch (err) {
    return jsonError(err);
  }
}

async function handlePricingRefresh(req: Request): Promise<Response> {
  try {
    let models: string[] | undefined;
    try {
      const body = (await req.json()) as { models?: unknown };
      if (Array.isArray(body?.models)) {
        models = body.models.filter((m): m is string => typeof m === "string");
      }
    } catch {
      // No/invalid body — fall back to deriving the model list server-side.
    }
    return jsonResponse(await refreshPricingOverride(models));
  } catch (err) {
    return jsonError(err);
  }
}

function handleLive(): Response {
  try {
    const cockpitPort = cockpitDaemonPort();
    return jsonResponse({
      sessions: getLiveSessions(),
      cockpitUp: cockpitPort !== null,
      cockpitPort,
    });
  } catch (err) {
    return jsonError(err);
  }
}

// ---------- server ----------

const port = parsePort();
startupGuard();

let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/stats") return handleStats();
      if (url.pathname === "/api/live") return handleLive();
      if (url.pathname === "/api/pricing/refresh" && req.method === "POST")
        return handlePricingRefresh(req);
      return serveStatic(url.pathname);
    },
  });
} catch (err) {
  if ((err as { code?: string }).code === "EADDRINUSE") {
    console.error(
      `atlas: port ${port} is in use by another process — stop it or pass --port <n>.`,
    );
    process.exit(1);
  }
  throw err;
}

writeAtlasInfo({
  pid: process.pid,
  port: server.port,
  root: ROOT,
});

const url = `http://localhost:${server.port}`;
console.log(`Claude Stats Dashboard → ${url}`);
openBrowser(url);
