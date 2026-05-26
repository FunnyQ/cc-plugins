#!/usr/bin/env bun
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";

type JsonRpcMessage =
  | {
      jsonrpc: "2.0";
      id: number;
      result?: unknown;
      error?: { message?: string };
    }
  | { jsonrpc: "2.0"; method: string; params?: unknown };

type JsonRpcNotification = Extract<JsonRpcMessage, { method: string }>;

export type ProbeOptions = {
  threadId?: string;
  sendText?: string;
  waitForCompletion?: boolean;
  json?: boolean;
  help?: boolean;
};

export type ProbeReport = {
  ok: boolean;
  codexCliVersion?: string;
  daemonReady: boolean;
  controlMode?: "remote-control" | "direct-app-server";
  rpcReady: boolean;
  threadId?: string;
  threadResolved: boolean;
  resumeOk?: boolean;
  turnId?: string;
  turnStartOk?: boolean;
  turnSteerOk?: boolean;
  turnCompletedOk?: boolean;
  turnStatus?: string;
  warnings: string[];
  errors: string[];
};

export type JsonRpcTransport = {
  request(method: string, params?: unknown): Promise<unknown>;
  waitForNotification?: (
    predicate: (message: JsonRpcNotification) => boolean,
    timeoutMs: number,
  ) => Promise<JsonRpcNotification>;
  close(): void;
};

export type ProbeDeps = {
  cliVersion: () => string;
  startRemoteControl: () => unknown;
  createProxyTransport: () => Promise<JsonRpcTransport>;
  createDirectTransport: () => Promise<JsonRpcTransport>;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseArgs(argv: string[]): ProbeOptions {
  const out: ProbeOptions = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
    } else if (arg === "--json") {
      out.json = true;
    } else if (arg === "--wait") {
      out.waitForCompletion = true;
    } else if (arg === "--thread") {
      const value = argv[++i];
      if (!value) throw new Error("missing value for --thread");
      out.threadId = value;
    } else if (arg === "--send") {
      const value = argv[++i];
      if (!value) throw new Error("missing value for --send");
      out.sendText = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

export function usage(): string {
  return [
    "Usage: bun codex-control-probe.ts [--json] [--thread <id>] [--send <text>] [--wait]",
    "",
    "Dry-run by default: starts/checks Codex remote-control and probes JSON-RPC.",
    "A real Codex turn is created only when --thread and --send are both present.",
    "--wait waits for turn completion after submitting a Codex turn.",
  ].join("\n");
}

class StdioJsonRpcTransport implements JsonRpcTransport {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private notificationWaiters = new Set<{
    predicate: (message: JsonRpcNotification) => boolean;
    resolve: (message: JsonRpcNotification) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.handleData(chunk));
    proc.stderr.resume();
    proc.on("close", (code) => {
      const err = new Error(
        `codex app-server proxy closed (${code ?? "signal"})`,
      );
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const waiter of this.notificationWaiters) waiter.reject(err);
      this.notificationWaiters.clear();
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.proc.stdin.write(`${payload}\n`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10_000).unref();
    });
  }

  close(): void {
    this.proc.kill();
  }

  waitForNotification(
    predicate: (message: JsonRpcNotification) => boolean,
    timeoutMs: number,
  ): Promise<JsonRpcNotification> {
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message: JsonRpcNotification) => {
          clearTimeout(waiter.timer);
          this.notificationWaiters.delete(waiter);
          resolve(message);
        },
        reject: (err: Error) => {
          clearTimeout(waiter.timer);
          this.notificationWaiters.delete(waiter);
          reject(err);
        },
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new Error("turn completion timed out"));
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.notificationWaiters.add(waiter);
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const idx = this.buffer.indexOf("\n");
      if (idx === -1) return;
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (!("id" in message)) {
      this.handleNotification(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "JSON-RPC error"));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(message: JsonRpcNotification): void {
    for (const waiter of [...this.notificationWaiters]) {
      if (waiter.predicate(message)) waiter.resolve(message);
    }
  }
}

class UnixWebSocketJsonRpcTransport implements JsonRpcTransport {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private handshakeDone = false;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private notificationWaiters = new Set<{
    predicate: (message: JsonRpcNotification) => boolean;
    resolve: (message: JsonRpcNotification) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private ready: Promise<void>;

  constructor(private socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.handleData(chunk));
    socket.on("close", () =>
      this.rejectAll(new Error("Codex remote-control socket closed")),
    );
    socket.on("error", (err) => this.rejectAll(err));
    this.ready = this.handshake();
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    await this.ready;
    const id = this.nextId++;
    this.socket.write(this.encodeFrame(JSON.stringify({ id, method, params })));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 10_000).unref();
    });
  }

  close(): void {
    this.socket.destroy();
  }

  waitForNotification(
    predicate: (message: JsonRpcNotification) => boolean,
    timeoutMs: number,
  ): Promise<JsonRpcNotification> {
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message: JsonRpcNotification) => {
          clearTimeout(waiter.timer);
          this.notificationWaiters.delete(waiter);
          resolve(message);
        },
        reject: (err: Error) => {
          clearTimeout(waiter.timer);
          this.notificationWaiters.delete(waiter);
          reject(err);
        },
        timer: setTimeout(() => {
          this.notificationWaiters.delete(waiter);
          reject(new Error("turn completion timed out"));
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.notificationWaiters.add(waiter);
    });
  }

  private handshake(): Promise<void> {
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const timer = setTimeout(() => {
        reject(new Error("remote-control websocket handshake timed out"));
      }, 10_000);
      timer.unref();
      const onData = () => {
        const idx = this.buffer.indexOf("\r\n\r\n");
        if (idx === -1) return;
        const head = this.buffer.subarray(0, idx + 4).toString("utf8");
        this.buffer = this.buffer.subarray(idx + 4);
        if (!head.startsWith("HTTP/1.1 101")) {
          clearTimeout(timer);
          reject(new Error("remote-control websocket upgrade failed"));
          return;
        }
        this.handshakeDone = true;
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.decodeBufferedFrames();
        resolve();
      };
      this.socket.on("data", onData);
      this.socket.write(
        [
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.handshakeDone) this.decodeBufferedFrames();
  }

  private decodeBufferedFrames(): void {
    for (;;) {
      if (this.buffer.length < 2) return;
      const start = 0;
      let offset = 2;
      const opcode = this.buffer[0] & 0x0f;
      let len = this.buffer[1] & 0x7f;
      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const bigLen = this.buffer.readBigUInt64BE(offset);
        offset += 8;
        if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.rejectAll(new Error("remote-control frame too large"));
          this.close();
          return;
        }
        len = Number(bigLen);
      }
      const masked = (this.buffer[1] & 0x80) !== 0;
      let mask: Buffer | null = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      this.buffer = this.buffer.subarray(offset + len);
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      if (opcode === 8) {
        this.close();
        return;
      }
      if (opcode !== 1) continue;
      this.handleLine(payload.toString("utf8"));
      if (this.buffer.length === start) return;
    }
  }

  private encodeFrame(text: string): Buffer {
    const payload = Buffer.from(text);
    const mask = randomBytes(4);
    const header: number[] = [0x81];
    if (payload.length < 126) {
      header.push(0x80 | payload.length);
    } else if (payload.length < 65536) {
      header.push(0x80 | 126, payload.length >> 8, payload.length & 0xff);
    } else {
      header.push(
        0x80 | 127,
        0,
        0,
        0,
        0,
        (payload.length / 0x1000000) & 0xff,
        (payload.length / 0x10000) & 0xff,
        (payload.length / 0x100) & 0xff,
        payload.length & 0xff,
      );
    }
    const out = Buffer.alloc(header.length + mask.length + payload.length);
    Buffer.from(header).copy(out, 0);
    mask.copy(out, header.length);
    for (let i = 0; i < payload.length; i++) {
      out[header.length + mask.length + i] = payload[i] ^ mask[i % 4];
    }
    return out;
  }

  private handleLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (!("id" in message)) {
      this.handleNotification(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "JSON-RPC error"));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleNotification(message: JsonRpcNotification): void {
    for (const waiter of [...this.notificationWaiters]) {
      if (waiter.predicate(message)) waiter.resolve(message);
    }
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    for (const waiter of this.notificationWaiters) waiter.reject(err);
    this.notificationWaiters.clear();
  }
}

function defaultCliVersion(): string {
  return execFileSync("codex", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function defaultStartRemoteControl(): unknown {
  const raw = execFileSync("codex", ["remote-control", "start", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return raw ? JSON.parse(raw) : {};
}

async function defaultCreateTransport(): Promise<JsonRpcTransport> {
  const socketPath = join(
    homedir(),
    ".codex",
    "app-server-control",
    "app-server-control.sock",
  );
  if (!existsSync(socketPath)) {
    throw new Error(`remote-control socket not found at ${socketPath}`);
  }
  return new UnixWebSocketJsonRpcTransport(createConnection(socketPath));
}

async function defaultCreateDirectTransport(): Promise<JsonRpcTransport> {
  return new StdioJsonRpcTransport(
    spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

function defaultDeps(): ProbeDeps {
  return {
    cliVersion: defaultCliVersion,
    startRemoteControl: defaultStartRemoteControl,
    createProxyTransport: defaultCreateTransport,
    createDirectTransport: defaultCreateDirectTransport,
  };
}

export function directDeps(): ProbeDeps {
  return {
    cliVersion: defaultCliVersion,
    startRemoteControl: () => {
      throw new Error("remote-control skipped");
    },
    createProxyTransport: defaultCreateTransport,
    createDirectTransport: defaultCreateDirectTransport,
  };
}

function initializeParams() {
  return {
    clientInfo: {
      name: "cockpit-codex-control-probe",
      title: "Cockpit Codex Control Probe",
      version: "0.0.1",
    },
    capabilities: {
      experimentalApi: true,
      requestAttestation: false,
      optOutNotificationMethods: [],
    },
  };
}

function userTextInput(text: string) {
  return [{ type: "text", text, text_elements: [] }];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function activeTurnId(resumeResult: unknown): string | null {
  const root = objectValue(resumeResult);
  const thread = objectValue(root?.thread);
  const status = objectValue(thread?.status);
  if (status?.type !== "active") return null;
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = objectValue(turns[i]);
    if (turn?.status === "inProgress") return stringValue(turn.id);
  }
  return null;
}

function startedTurnId(startResult: unknown): string | null {
  const root = objectValue(startResult);
  return stringValue(objectValue(root?.turn)?.id);
}

async function waitForTurnCompletion(
  transport: JsonRpcTransport,
  threadId: string,
  turnId: string,
): Promise<string | null> {
  if (!transport.waitForNotification) return null;
  const notification = await transport.waitForNotification(
    (message) => {
      const params = objectValue(message.params);
      if (params?.threadId !== threadId) return false;
      if (message.method === "turn/completed") {
        return objectValue(params.turn)?.id === turnId;
      }
      if (message.method === "error") return params.turnId === turnId;
      return false;
    },
    30 * 60 * 1000,
  );

  const params = objectValue(notification.params);
  if (notification.method === "error") {
    const error = objectValue(params?.error);
    const message =
      stringValue(error?.message) ||
      stringValue(error?.type) ||
      "Codex turn failed";
    throw new Error(message);
  }
  return stringValue(objectValue(params?.turn)?.status);
}

async function executeProbeRequests(
  transport: JsonRpcTransport,
  opts: ProbeOptions,
  report: ProbeReport,
): Promise<{ keepTransportOpen: boolean }> {
  await transport.request("initialize", initializeParams());
  report.rpcReady = true;

  if (!opts.threadId) {
    await transport.request("thread/loaded/list", { limit: 10 });
    report.ok = true;
    return { keepTransportOpen: false };
  }

  const resumeResult = await transport.request("thread/resume", {
    threadId: opts.threadId,
  });
  report.threadResolved = true;
  report.resumeOk = true;

  if (opts.sendText) {
    const activeTurn = activeTurnId(resumeResult);
    if (activeTurn) {
      const steerResult = await transport.request("turn/steer", {
        threadId: opts.threadId,
        input: userTextInput(opts.sendText),
        expectedTurnId: activeTurn,
      });
      report.turnId =
        stringValue(objectValue(steerResult)?.turnId) || activeTurn;
      report.turnSteerOk = true;
    } else {
      const startResult = await transport.request("turn/start", {
        threadId: opts.threadId,
        input: userTextInput(opts.sendText),
      });
      report.turnId = startedTurnId(startResult) || undefined;
      report.turnStartOk = true;
    }

    if (report.turnId) {
      if (opts.waitForCompletion) {
        const status = await waitForTurnCompletion(
          transport,
          opts.threadId,
          report.turnId,
        );
        if (status) report.turnStatus = status;
        report.turnCompletedOk = true;
      } else if (transport.waitForNotification) {
        void waitForTurnCompletion(transport, opts.threadId, report.turnId)
          .catch(() => undefined)
          .finally(() => transport.close());
        report.ok = true;
        return { keepTransportOpen: true };
      }
    }
  }

  report.ok = true;
  return { keepTransportOpen: false };
}

function turnSubmitted(report: ProbeReport): boolean {
  return !!(report.turnId || report.turnStartOk || report.turnSteerOk);
}

function resetRpcAttempt(report: ProbeReport): void {
  report.rpcReady = false;
  report.threadResolved = false;
  report.resumeOk = undefined;
  report.turnId = undefined;
  report.turnStartOk = undefined;
  report.turnSteerOk = undefined;
  report.turnCompletedOk = undefined;
  report.turnStatus = undefined;
}

export async function runProbe(
  opts: ProbeOptions,
  deps: ProbeDeps = defaultDeps(),
): Promise<ProbeReport> {
  const report: ProbeReport = {
    ok: false,
    daemonReady: false,
    rpcReady: false,
    threadId: opts.threadId,
    threadResolved: false,
    warnings: [],
    errors: [],
  };

  if (opts.sendText && !opts.threadId) {
    report.errors.push("--send requires --thread");
    return report;
  }

  try {
    report.codexCliVersion = deps.cliVersion();
  } catch (err) {
    report.errors.push(`codex --version failed: ${errorMessage(err)}`);
  }

  let createTransport = deps.createProxyTransport;
  try {
    deps.startRemoteControl();
    report.daemonReady = true;
    report.controlMode = "remote-control";
  } catch (err) {
    report.warnings.push(`remote-control start failed: ${errorMessage(err)}`);
    createTransport = deps.createDirectTransport;
    report.controlMode = "direct-app-server";
  }

  let transport: JsonRpcTransport | null = null;
  try {
    transport = await createTransport();
    const result = await executeProbeRequests(transport, opts, report);
    if (!result.keepTransportOpen) transport.close();
    return report;
  } catch (err) {
    if (turnSubmitted(report)) {
      report.ok = false;
      report.errors.push(
        `${report.controlMode ?? "Codex control"} failed after Codex turn was submitted: ${errorMessage(err)}`,
      );
      transport?.close();
      return report;
    }
    if (report.controlMode !== "remote-control") {
      report.errors.push(`direct app-server failed: ${errorMessage(err)}`);
      transport?.close();
      return report;
    }
    report.warnings.push(`remote-control proxy failed: ${errorMessage(err)}`);
    transport?.close();
    transport = null;
  }

  report.controlMode = "direct-app-server";
  resetRpcAttempt(report);
  try {
    transport = await deps.createDirectTransport();
    const result = await executeProbeRequests(transport, opts, report);
    if (result.keepTransportOpen) transport = null;
    return report;
  } catch (err) {
    report.errors.push(`direct app-server failed: ${errorMessage(err)}`);
    return report;
  } finally {
    transport?.close();
  }
}

export function runDirectProbe(opts: ProbeOptions): Promise<ProbeReport> {
  const report: ProbeReport = {
    ok: false,
    daemonReady: false,
    controlMode: "direct-app-server",
    rpcReady: false,
    threadId: opts.threadId,
    threadResolved: false,
    warnings: [],
    errors: [],
  };

  if (opts.sendText && !opts.threadId) {
    report.errors.push("--send requires --thread");
    return Promise.resolve(report);
  }

  try {
    report.codexCliVersion = defaultCliVersion();
  } catch (err) {
    report.errors.push(`codex --version failed: ${errorMessage(err)}`);
  }

  return defaultCreateDirectTransport()
    .then(async (transport) => {
      let shouldClose = true;
      try {
        const result = await executeProbeRequests(transport, opts, report);
        shouldClose = !result.keepTransportOpen;
        return report;
      } catch (err) {
        if (turnSubmitted(report)) {
          report.ok = false;
          report.errors.push(
            `direct app-server failed after Codex turn was submitted: ${errorMessage(err)}`,
          );
          return report;
        }
        report.errors.push(`direct app-server failed: ${errorMessage(err)}`);
        return report;
      } finally {
        if (shouldClose) transport.close();
      }
    })
    .catch((err) => {
      report.errors.push(`direct app-server failed: ${errorMessage(err)}`);
      return report;
    });
}

export function formatHumanReport(report: ProbeReport): string {
  const lines = [
    `ok: ${report.ok}`,
    `codexCliVersion: ${report.codexCliVersion ?? "(unknown)"}`,
    `daemonReady: ${report.daemonReady}`,
    `controlMode: ${report.controlMode ?? "(none)"}`,
    `rpcReady: ${report.rpcReady}`,
    `threadId: ${report.threadId ?? "(none)"}`,
    `threadResolved: ${report.threadResolved}`,
  ];
  if (report.resumeOk !== undefined) lines.push(`resumeOk: ${report.resumeOk}`);
  if (report.turnStartOk !== undefined)
    lines.push(`turnStartOk: ${report.turnStartOk}`);
  if (report.turnSteerOk !== undefined)
    lines.push(`turnSteerOk: ${report.turnSteerOk}`);
  if (report.turnCompletedOk !== undefined)
    lines.push(`turnCompletedOk: ${report.turnCompletedOk}`);
  if (report.turnStatus !== undefined)
    lines.push(`turnStatus: ${report.turnStatus}`);
  if (report.warnings.length) {
    lines.push("warnings:");
    for (const warning of report.warnings) lines.push(`- ${warning}`);
  }
  if (report.errors.length) {
    lines.push("errors:");
    for (const err of report.errors) lines.push(`- ${err}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  let opts: ProbeOptions;
  try {
    opts = parseArgs(Bun.argv.slice(2));
  } catch (err) {
    console.error(errorMessage(err));
    console.error(usage());
    process.exit(1);
  }

  if (opts.help) {
    console.log(usage());
    return;
  }

  const report = await runProbe(opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHumanReport(report));
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(errorMessage(err));
    process.exit(1);
  });
}
