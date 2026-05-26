#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export type DaemonCoords = { port: number; token: string };
export type ProcessInfo = { pid: number; port: number };
type ChannelServer = Server & {
  notification(input: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<void>;
};

export const CHANNEL_INSTRUCTIONS =
  'Messages from the cockpit dashboard arrive as <channel source="cockpit">...</channel>. ' +
  "When you want to address the user in the cockpit UI directly, call the reply tool with your message.";

export const REPLY_TOOL = {
  name: "reply",
  description: "Send a message to the cockpit dashboard UI",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Message to show in cockpit",
      },
    },
    required: ["text"],
  },
};

function cockpitHome(): string {
  return process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
}

function daemonInfoPath(): string {
  return join(cockpitHome(), "daemon.json");
}

function atlasInfoPath(): string {
  return join(cockpitHome(), "atlas.json");
}

export function readDaemonCoords(path = daemonInfoPath()): DaemonCoords | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw?.port === "number" && typeof raw?.token === "string") {
      return { port: raw.port, token: raw.token };
    }
  } catch {
    // missing/corrupt daemon info — caller decides whether to retry or idle
  }
  return null;
}

export function readProcessInfo(path: string): ProcessInfo | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw?.pid === "number" && typeof raw?.port === "number") {
      return { pid: raw.pid, port: raw.port };
    }
  } catch {
    // missing/corrupt info means "not up"
  }
  return null;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function isUp(
  infoPath: string,
  alive: (pid: number) => boolean = isAlive,
): boolean {
  const info = readProcessInfo(infoPath);
  return !!info && alive(info.pid);
}

export function ensureServer(
  scriptPath: string,
  infoPath: string,
  alive: (pid: number) => boolean = isAlive,
): boolean {
  if (isUp(infoPath, alive)) return false;
  spawn("bun", [scriptPath, "--no-open"], {
    detached: true,
    stdio: "ignore",
  }).unref();
  return true;
}

export function channelNotification(text: string) {
  return {
    method: "notifications/claude/channel",
    params: { content: text, meta: { source: "cockpit" } },
  };
}

export async function postReply(opts: {
  coords: DaemonCoords;
  sessionId: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const r = await fetchImpl(`http://127.0.0.1:${opts.coords.port}/api/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session: opts.sessionId,
      text: opts.text,
      token: opts.coords.token,
    }),
  });
  if (!r.ok) throw new Error(`reply failed: ${r.status}`);
  const body = (await r.json()) as { delivered?: unknown };
  return typeof body.delivered === "number" ? body.delivered : 0;
}

export function createMcpServer(opts: {
  sessionId: string | null;
  coords: () => DaemonCoords | null;
  fetchImpl?: typeof fetch;
}): ChannelServer {
  const mcp = new Server(
    { name: "cockpit-channel", version: "0.0.1" },
    {
      capabilities: {
        experimental: { "claude/channel": {} },
        tools: {},
      },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  ) as ChannelServer;

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [REPLY_TOOL],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== "reply") {
      throw new Error(`unknown tool: ${req.params.name}`);
    }
    const args = (req.params.arguments ?? {}) as { text?: unknown };
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (!text) throw new Error("reply.text is required");
    if (!opts.sessionId) throw new Error("CLAUDE_CODE_SESSION_ID is missing");
    const coords = opts.coords();
    if (!coords) throw new Error("cockpit daemon is unavailable");
    await postReply({
      coords,
      sessionId: opts.sessionId,
      text,
      fetchImpl: opts.fetchImpl,
    });
    return { content: [{ type: "text", text: "sent" }] };
  });

  return mcp;
}

function monitorScript(relativeFromMonitor: string): string {
  return resolve(import.meta.dir, "..", "..", relativeFromMonitor);
}

function cockpitServerScript(): string {
  return join(import.meta.dir, "cockpit-server.ts");
}

function atlasServerScript(): string {
  return monitorScript("usage-dashboard/scripts/atlas-server.ts");
}

async function waitForDaemonCoords(
  timeoutMs = 3000,
): Promise<DaemonCoords | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const coords = readDaemonCoords();
    if (coords) return coords;
    await Bun.sleep(100);
  }
  return readDaemonCoords();
}

async function ensureMonitorServers(): Promise<DaemonCoords | null> {
  ensureServer(cockpitServerScript(), daemonInfoPath());
  ensureServer(atlasServerScript(), atlasInfoPath());
  return await waitForDaemonCoords();
}

async function pullInboxLoop(opts: {
  mcp: ChannelServer;
  sessionId: string;
  coords: () => DaemonCoords | null;
  ensure: () => Promise<DaemonCoords | null>;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let coords = opts.coords();
  while (true) {
    if (!coords) coords = await opts.ensure();
    if (!coords) {
      await Bun.sleep(1000);
      continue;
    }

    try {
      const r = await fetchImpl(
        `http://127.0.0.1:${coords.port}/api/inbox?session=${opts.sessionId}&token=${coords.token}`,
      );
      if (!r.ok) throw new Error(`inbox failed: ${r.status}`);
      const body = (await r.json()) as { message?: unknown };
      if (typeof body.message === "string" && body.message !== "") {
        await opts.mcp.notification(channelNotification(body.message));
      }
    } catch (err) {
      console.error(
        `cockpit-channel: inbox poll failed (${(err as Error).message}); reconnecting`,
      );
      coords = await opts.ensure();
      await Bun.sleep(1000);
    }
  }
}

async function main(): Promise<void> {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID || null;
  if (!sessionId) {
    console.error(
      "cockpit-channel: CLAUDE_CODE_SESSION_ID is missing; channel will stay idle",
    );
  }

  const initialCoords = await ensureMonitorServers();
  if (!initialCoords) {
    console.error(
      "cockpit-channel: cockpit daemon unavailable; retrying in loop",
    );
  }

  const mcp = createMcpServer({
    sessionId,
    coords: readDaemonCoords,
  });
  await mcp.connect(new StdioServerTransport());

  if (!sessionId) return;
  await pullInboxLoop({
    mcp,
    sessionId,
    coords: readDaemonCoords,
    ensure: ensureMonitorServers,
  });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`cockpit-channel: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
