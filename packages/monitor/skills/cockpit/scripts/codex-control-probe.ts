#!/usr/bin/env bun
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";

type JsonRpcMessage =
  | {
      jsonrpc: "2.0";
      id: number;
      result?: unknown;
      error?: { message?: string };
    }
  | { jsonrpc: "2.0"; method: string; params?: unknown };

export type ProbeOptions = {
  threadId?: string;
  sendText?: string;
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
  turnStartOk?: boolean;
  warnings: string[];
  errors: string[];
};

export type JsonRpcTransport = {
  request(method: string, params?: unknown): Promise<unknown>;
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
    "Usage: bun codex-control-probe.ts [--json] [--thread <id>] [--send <text>]",
    "",
    "Dry-run by default: starts/checks Codex remote-control and probes JSON-RPC.",
    "A real Codex turn is created only when --thread and --send are both present.",
  ].join("\n");
}

class StdioJsonRpcTransport implements JsonRpcTransport {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(private proc: ChildProcessWithoutNullStreams) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.handleData(chunk));
    proc.on("close", (code) => {
      const err = new Error(
        `codex app-server proxy closed (${code ?? "signal"})`,
      );
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
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
    if (!("id" in message)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || "JSON-RPC error"));
    } else {
      pending.resolve(message.result);
    }
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
  return new StdioJsonRpcTransport(
    spawn("codex", ["app-server", "proxy"], {
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
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

async function executeProbeRequests(
  transport: JsonRpcTransport,
  opts: ProbeOptions,
  report: ProbeReport,
): Promise<void> {
  await transport.request("initialize", initializeParams());
  report.rpcReady = true;

  if (!opts.threadId) {
    await transport.request("thread/loaded/list", { limit: 10 });
    report.ok = true;
    return;
  }

  await transport.request("thread/resume", { threadId: opts.threadId });
  report.threadResolved = true;
  report.resumeOk = true;

  if (opts.sendText) {
    await transport.request("turn/start", {
      threadId: opts.threadId,
      input: userTextInput(opts.sendText),
    });
    report.turnStartOk = true;
  }

  report.ok = true;
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
    await executeProbeRequests(transport, opts, report);
    return report;
  } catch (err) {
    if (report.controlMode !== "remote-control") {
      report.errors.push(`direct app-server failed: ${errorMessage(err)}`);
      return report;
    }
    report.warnings.push(`remote-control proxy failed: ${errorMessage(err)}`);
    transport?.close();
    transport = null;
  }

  report.controlMode = "direct-app-server";
  report.rpcReady = false;
  report.threadResolved = false;
  report.resumeOk = undefined;
  report.turnStartOk = undefined;
  try {
    transport = await deps.createDirectTransport();
    await executeProbeRequests(transport, opts, report);
    return report;
  } catch (err) {
    report.errors.push(`direct app-server failed: ${errorMessage(err)}`);
    return report;
  } finally {
    transport?.close();
  }
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
