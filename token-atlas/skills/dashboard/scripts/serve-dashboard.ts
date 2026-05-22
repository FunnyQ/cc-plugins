#!/usr/bin/env bun
import { statSync, existsSync } from "node:fs";
import { extname, resolve, relative, isAbsolute } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildStats } from "./api.ts";
import {
  getLiveSessions,
  streamTranscript,
  getTranscriptHistory,
  jsonResponse,
  jsonError,
} from "./live.ts";

const DIST = resolve(import.meta.dir, "..", "dashboard", "dist");
const DEFAULT_PORT = 5938;

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

function handleLive(): Response {
  try {
    return jsonResponse({ sessions: getLiveSessions() });
  } catch (err) {
    return jsonError(err);
  }
}

function handleStream(req: Request): Response {
  const url = new URL(req.url);
  return streamTranscript(
    url.searchParams.get("id") ?? url.searchParams.get("session"),
    url.searchParams.get("provider"),
  );
}

function handleTranscript(req: Request): Response {
  const url = new URL(req.url);
  return getTranscriptHistory(
    url.searchParams.get("id") ?? url.searchParams.get("session"),
    Number(url.searchParams.get("before")),
    Number(url.searchParams.get("limit")),
    url.searchParams.get("provider"),
  );
}

// ---------- server ----------

const port = parsePort();
killPort(port);

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/api/stats") return handleStats();
    if (url.pathname === "/api/live") return handleLive();
    if (url.pathname === "/api/stream") return handleStream(req);
    if (url.pathname === "/api/transcript") return handleTranscript(req);
    return serveStatic(url.pathname);
  },
});

const url = `http://localhost:${server.port}`;
console.log(`Claude Stats Dashboard → ${url}`);

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
