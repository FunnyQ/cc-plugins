#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  NotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { findSession } from "./find-session";

export type DaemonCoords = { port: number; token: string };
export type ProcessInfo = { pid: number; port: number };
type SpawnImpl = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;
const UUID_RE = /^[0-9a-f-]{36}$/;
type ChannelServer = Server & {
  notification(input: {
    method: string;
    params?: Record<string, unknown>;
  }): Promise<void>;
};

export const CHANNEL_INSTRUCTIONS =
  'Messages from the cockpit dashboard arrive as <channel source="cockpit">...</channel>.';

function cockpitHome(): string {
  return process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
}

function daemonInfoPath(): string {
  return join(cockpitHome(), "daemon.json");
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
  spawnImpl: SpawnImpl = spawn,
): boolean {
  if (isUp(infoPath, alive)) return false;
  spawnImpl("bun", [scriptPath, "--no-open"], {
    detached: true,
    stdio: "ignore",
  }).unref();
  return true;
}

export function nextReconnectDelayMs(failureCount: number): number {
  const capped = Math.min(Math.max(failureCount, 0), 5);
  return Math.min(1000 * 2 ** capped, 30_000);
}

export function channelNotification(text: string) {
  return {
    method: "notifications/claude/channel",
    params: { content: text, meta: { source: "cockpit" } },
  };
}

// --- Permission relay (see docs/permission-relay/tasks/_context/protocol.md) ---

// Inbound: the session asks the channel to approve/deny a tool use.
export const PERMISSION_REQUEST_METHOD =
  "notifications/claude/channel/permission_request";
// Outbound: the channel returns the verdict.
export const PERMISSION_VERDICT_METHOD =
  "notifications/claude/channel/permission";
// Best-effort, UNDOCUMENTED: a follow-up if a request is resolved elsewhere
// (terminal/hook/timeout). The real method name is unconfirmed; we register a
// couple of plausible spellings defensively and also catch unknown permission
// notifications via the fallback handler. Never depended upon.
export const PERMISSION_CANCEL_METHODS = [
  "notifications/claude/channel/permission_cancel",
  "notifications/claude/channel/permission_resolved",
  "notifications/claude/channel/permission_cancelled",
] as const;

export const PermissionRequestSchema = NotificationSchema.extend({
  method: z.literal(PERMISSION_REQUEST_METHOD),
});

export type PermissionRequestParams = {
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
};

export type PermissionVerdict = {
  request_id: string;
  behavior: "allow" | "deny";
};

// Pure: map an inbound permission_request's params + the channel's identity into
// the POST body for /api/permission-request. Missing string fields coerce to ""
// so a partial notification still forwards cleanly (the broker validates).
export function permissionRequestPayload(
  sessionId: string,
  token: string,
  params: Record<string, unknown> | undefined,
): {
  session: string;
  token: string;
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
} {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    session: sessionId,
    token,
    request_id: str(params?.request_id),
    tool_name: str(params?.tool_name),
    description: str(params?.description),
    input_preview: str(params?.input_preview),
  };
}

// Pure: map a verdict pulled from the daemon into the outbound notification the
// SDK sends back into the session. request_id is echoed VERBATIM — Claude only
// accepts a verdict whose request_id matches a pending request.
export function permissionVerdictNotification(verdict: PermissionVerdict) {
  return {
    method: PERMISSION_VERDICT_METHOD,
    params: { request_id: verdict.request_id, behavior: verdict.behavior },
  };
}

// Pure: build the POST body the channel sends IF it ever observes a
// cancel/resolved notification (best-effort; see protocol.md).
export function permissionResolvedPayload(
  sessionId: string,
  token: string,
  params: Record<string, unknown> | undefined,
): { session: string; token: string; request_id: string } {
  const rid = params?.request_id;
  return {
    session: sessionId,
    token,
    request_id: typeof rid === "string" ? rid : "",
  };
}

// Injecting a channel message (`mcp.notification`) is coupled to the session's
// turn — its await can hang for the whole time the agent is WORKING. If the
// inbox loop awaited it inline, it would stop re-parking the `/api/inbox`
// long-poll for that entire turn, and `hasChannel` (which only sees a parked
// poll) would read false → the UI send box disables mid-turn. So delivery runs
// off a serialized side-chain: the loop fires-and-forgets, re-parks the poll
// immediately, and notifications still arrive in order.
export function createSerialNotifier(
  notify: (text: string) => Promise<void>,
  onError: (err: unknown) => void = () => {},
): (text: string) => void {
  let chain: Promise<void> = Promise.resolve();
  return (text: string) => {
    chain = chain.then(() => notify(text)).catch(onError);
  };
}

export function sessionIdFromCommand(command: string): string | null {
  const parts = command.match(/(?:[^\s"']+|["'][^"']*["'])+/g) ?? [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].replace(/^["']|["']$/g, "");
    if (part === "--session-id") {
      const next = (parts[i + 1] || "").replace(/^["']|["']$/g, "");
      return UUID_RE.test(next) ? next : null;
    }
    const m = part.match(/^--session-id=([0-9a-f-]{36})$/);
    if (m && UUID_RE.test(m[1])) return m[1];
  }
  return null;
}

function processField(pid: number, field: "ppid" | "command"): string | null {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Walk up our ancestor process chain (max 8 hops), returning the first non-null
// extraction. The channel MCP server is spawned by the Claude CLI process, so an
// ancestor pid identifies our host session.
function walkAncestors(
  startPid: number,
  extract: (pid: number) => string | null,
): string | null {
  let pid = startPid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const found = extract(pid);
    if (found) return found;
    const parent = Number(processField(pid, "ppid"));
    if (!Number.isFinite(parent) || parent === pid) return null;
    pid = parent;
  }
  return null;
}

function sessionIdFromAncestors(startPid = process.ppid): string | null {
  return walkAncestors(startPid, (pid) => {
    const command = processField(pid, "command");
    return command ? sessionIdFromCommand(command) : null;
  });
}

function claudeSessionsDir(): string {
  return (
    process.env.COCKPIT_CLAUDE_SESSIONS_DIR ||
    join(homedir(), ".claude", "sessions")
  );
}

// Claude writes ~/.claude/sessions/<pid>.json per running session, keyed by the
// CLI process pid and carrying its authoritative sessionId. Matching an ancestor
// pid to its file yields the real session id — unlike the newest-mtime transcript
// guess, which races sibling sessions in the same project (and silently latches
// the wrong id, leaving the cockpit send box disabled).
function sessionIdFromSessionFile(pid: number): string | null {
  try {
    const d = JSON.parse(
      readFileSync(join(claudeSessionsDir(), `${pid}.json`), "utf8"),
    ) as { pid?: unknown; sessionId?: unknown };
    if (
      d?.pid === pid &&
      typeof d.sessionId === "string" &&
      UUID_RE.test(d.sessionId)
    ) {
      return d.sessionId;
    }
  } catch {
    // no file for this pid, or malformed — keep walking ancestors
  }
  return null;
}

function sessionIdFromAncestorFiles(startPid = process.ppid): string | null {
  return walkAncestors(startPid, sessionIdFromSessionFile);
}

export async function resolveClaudeSessionId(
  opts: {
    project?: string;
    timeoutMs?: number;
    finder?: (provider: "claude", project: string) => string | null;
    ancestorFinder?: () => string | null;
    sessionFileFinder?: () => string | null;
  } = {},
): Promise<string | null> {
  const fromEnv = process.env.CLAUDE_CODE_SESSION_ID?.trim();
  if (fromEnv && UUID_RE.test(fromEnv)) return fromEnv;

  const fromSessionFile = (
    opts.sessionFileFinder ?? sessionIdFromAncestorFiles
  )();
  if (fromSessionFile) return fromSessionFile;

  const fromAncestors = (opts.ancestorFinder ?? sessionIdFromAncestors)();
  if (fromAncestors) return fromAncestors;

  const project =
    opts.project ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const finder = opts.finder ?? findSession;
  const deadline = Date.now() + (opts.timeoutMs ?? 3000);
  while (Date.now() < deadline) {
    const found = finder("claude", project);
    if (found) return found;
    await Bun.sleep(100);
  }
  return finder("claude", project);
}

// The channel exposes no tools — agent→UI output rides the transcript, which
// cockpit already renders. We still declare an (empty) tools capability and a
// ListTools handler so a client's tools/list resolves cleanly to an empty set.
export function createMcpServer(): ChannelServer {
  const mcp = new Server(
    { name: "cockpit-channel", version: "0.0.1" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        tools: {},
      },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  ) as ChannelServer;

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

  return mcp;
}

function cockpitServerScript(): string {
  return join(import.meta.dir, "cockpit-server.ts");
}

async function waitForDaemonCoords(
  timeoutMs = 3000,
): Promise<DaemonCoords | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const coords = isUp(daemonInfoPath()) ? readDaemonCoords() : null;
    if (coords) return coords;
    await Bun.sleep(100);
  }
  return isUp(daemonInfoPath()) ? readDaemonCoords() : null;
}

// The channel's only hard dependency is the cockpit daemon (it owns /api/inbox).
// The usage dashboard (atlas) is not needed for the channel to work, so it's left
// to the usage-dashboard skill to start on demand — we don't force a 5938 server
// onto every channel-flagged session.
async function ensureCockpitDaemon(): Promise<DaemonCoords | null> {
  ensureServer(cockpitServerScript(), daemonInfoPath());
  return await waitForDaemonCoords();
}

// Long-poll the daemon for a verdict, re-polling on the {verdict:null,
// timeout:true} sentinel (mirrors the inbox re-park pattern) until a real
// {request_id, behavior} arrives. Independent of the inbox poll. Returns null if
// coords are unavailable / the daemon stays unreachable past the retry budget.
async function pullVerdict(opts: {
  sessionId: string;
  coords: () => DaemonCoords | null;
  ensure: () => Promise<DaemonCoords | null>;
  fetchImpl?: typeof fetch;
  maxFailures?: number;
}): Promise<PermissionVerdict | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxFailures = opts.maxFailures ?? 6;
  let coords = opts.coords();
  let failures = 0;
  while (true) {
    if (!coords) coords = await opts.ensure();
    if (!coords) {
      if (failures >= maxFailures) return null;
      await Bun.sleep(nextReconnectDelayMs(failures++));
      continue;
    }
    try {
      const r = await fetchImpl(
        `http://127.0.0.1:${coords.port}/api/permission-pull?session=${opts.sessionId}&token=${coords.token}`,
      );
      if (!r.ok) throw new Error(`permission-pull failed: ${r.status}`);
      const body = (await r.json()) as {
        request_id?: unknown;
        behavior?: unknown;
        verdict?: unknown;
        timeout?: unknown;
      };
      failures = 0;
      // Re-pollable sentinel — keep waiting.
      if (body.timeout === true) continue;
      if (
        typeof body.request_id === "string" &&
        (body.behavior === "allow" || body.behavior === "deny")
      ) {
        return { request_id: body.request_id, behavior: body.behavior };
      }
      // Unexpected shape — re-poll rather than echo a bogus verdict.
    } catch (err) {
      if (failures >= maxFailures) return null;
      const delay = nextReconnectDelayMs(failures++);
      console.error(
        `cockpit-channel: permission-pull failed (${(err as Error).message}); retrying in ${delay}ms`,
      );
      coords = await opts.ensure();
      await Bun.sleep(delay);
    }
  }
}

// Register the permission relay on the MCP server: forward inbound requests to
// the daemon, pull the verdict, and echo it back into the session. The verdict
// round-trip runs off a fire-and-forget serialized chain so a slow wait NEVER
// blocks the inbox loop (the inbox poll must keep re-parking — hasChannel depends
// on it). Verdict pulls are independent of the inbox poll.
export function registerPermissionRelay(opts: {
  mcp: ChannelServer;
  sessionId: string;
  coords: () => DaemonCoords | null;
  ensure: () => Promise<DaemonCoords | null>;
  fetchImpl?: typeof fetch;
}): void {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let chain: Promise<void> = Promise.resolve();
  const onError = (err: unknown) =>
    console.error(
      `cockpit-channel: permission relay failed (${(err as Error).message})`,
    );

  // POST a JSON body whose shape depends on the fresh daemon token (the body
  // carries the auth token, so we resolve coords first, then build the body).
  const post = async (
    path: string,
    buildBody: (coords: DaemonCoords) => unknown,
  ): Promise<void> => {
    const coords = opts.coords() ?? (await opts.ensure());
    if (!coords) throw new Error("cockpit daemon unavailable");
    const r = await fetchImpl(`http://127.0.0.1:${coords.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody(coords)),
    });
    if (!r.ok) throw new Error(`${path} failed: ${r.status}`);
  };

  const handleRequest = async (params?: Record<string, unknown>) => {
    await post("/api/permission-request", (coords) =>
      permissionRequestPayload(opts.sessionId, coords.token, params),
    );
    const verdict = await pullVerdict({
      sessionId: opts.sessionId,
      coords: opts.coords,
      ensure: opts.ensure,
      fetchImpl,
    });
    if (!verdict) return; // gave up; terminal dialog still resolves locally
    await opts.mcp.notification(permissionVerdictNotification(verdict));
  };

  opts.mcp.setNotificationHandler(PermissionRequestSchema, (notification) => {
    const params = notification.params as Record<string, unknown> | undefined;
    // Fire-and-forget on a serialized chain — never block the SDK's notification
    // dispatch (which shares the read loop with the inbox poll's re-parking).
    chain = chain.then(() => handleRequest(params)).catch(onError);
  });

  // Defensive: if Claude ever notifies the channel that a request was resolved
  // elsewhere (UNDOCUMENTED — see protocol.md), forward it so the UI can close
  // instantly. The exact method is unconfirmed; register a few plausible names
  // AND a fallback that sniffs any unhandled "permission"-shaped notification.
  const handleCancel = (params?: Record<string, unknown>) => {
    chain = chain
      .then(() =>
        post("/api/permission-resolved", (coords) =>
          permissionResolvedPayload(opts.sessionId, coords.token, params),
        ),
      )
      .catch(onError);
  };
  for (const method of PERMISSION_CANCEL_METHODS) {
    const schema = NotificationSchema.extend({ method: z.literal(method) });
    opts.mcp.setNotificationHandler(schema, (notification) =>
      handleCancel(notification.params as Record<string, unknown> | undefined),
    );
  }

  // Catch-all for the unknown spelling: forward only permission-cancel-shaped
  // methods we don't already handle; never touch the inbox/verdict methods.
  const prior = opts.mcp.fallbackNotificationHandler;
  opts.mcp.fallbackNotificationHandler = async (notification) => {
    const method = notification.method;
    if (
      typeof method === "string" &&
      method.startsWith("notifications/claude/channel/permission") &&
      method !== PERMISSION_REQUEST_METHOD &&
      method !== PERMISSION_VERDICT_METHOD &&
      !(PERMISSION_CANCEL_METHODS as readonly string[]).includes(method)
    ) {
      console.error(
        `cockpit-channel: observed undocumented permission notification "${method}" — forwarding as resolved`,
      );
      handleCancel(notification.params as Record<string, unknown> | undefined);
      return;
    }
    if (prior) await prior(notification);
  };
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
  let failures = 0;
  // Fire-and-forget delivery: never blocks the loop from re-parking the poll.
  const deliver = createSerialNotifier(
    (text) => opts.mcp.notification(channelNotification(text)),
    (err) =>
      console.error(
        `cockpit-channel: notification failed (${(err as Error).message})`,
      ),
  );
  while (true) {
    if (!coords) coords = await opts.ensure();
    if (!coords) {
      const delay = nextReconnectDelayMs(failures++);
      console.error(
        `cockpit-channel: cockpit daemon unavailable; retrying in ${delay}ms`,
      );
      await Bun.sleep(delay);
      continue;
    }

    try {
      const r = await fetchImpl(
        `http://127.0.0.1:${coords.port}/api/inbox?session=${opts.sessionId}&token=${coords.token}`,
      );
      if (!r.ok) throw new Error(`inbox failed: ${r.status}`);
      const body = (await r.json()) as { message?: unknown };
      failures = 0;
      if (typeof body.message === "string" && body.message !== "") {
        deliver(body.message);
      }
    } catch (err) {
      const delay = nextReconnectDelayMs(failures++);
      console.error(
        `cockpit-channel: inbox poll failed (${(err as Error).message}); reconnecting in ${delay}ms`,
      );
      coords = await opts.ensure();
      await Bun.sleep(delay);
    }
  }
}

async function main(): Promise<void> {
  const sessionId = await resolveClaudeSessionId();
  if (!sessionId) {
    console.error(
      "cockpit-channel: could not resolve a Claude session id; channel will stay idle",
    );
  }

  const initialCoords = await ensureCockpitDaemon();
  if (!initialCoords) {
    console.error(
      "cockpit-channel: cockpit daemon unavailable; retrying in loop",
    );
  }

  const mcp = createMcpServer();

  if (sessionId) {
    // Relay handlers must be registered BEFORE connect so an early
    // permission_request isn't dropped by the SDK's default fallback.
    registerPermissionRelay({
      mcp,
      sessionId,
      coords: readDaemonCoords,
      ensure: ensureCockpitDaemon,
    });
  }

  await mcp.connect(new StdioServerTransport());

  if (!sessionId) return;
  await pullInboxLoop({
    mcp,
    sessionId,
    coords: readDaemonCoords,
    ensure: ensureCockpitDaemon,
  });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`cockpit-channel: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
