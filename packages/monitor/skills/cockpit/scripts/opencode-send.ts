import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonResponse as json } from "./http";

const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9_-]{8,160}$/;
const DEFAULT_OPENCODE_PORT = 9124;
const SERVER_CANDIDATES = [
  "http://127.0.0.1:4096",
  "http://127.0.0.1:9123",
  `http://127.0.0.1:${DEFAULT_OPENCODE_PORT}`,
];

type SendOpenCodePromptOptions = {
  sessionId: string;
  text: string;
};

export type OpenCodeSendReport = {
  ok: boolean;
  ready: boolean;
  serverUrl?: string;
  sessionFound: boolean;
  delivered: boolean;
  sessionDirectory?: string;
  inputId?: string;
  delivery?: "async";
  warnings: string[];
  errors: string[];
};

type SendOpenCodePrompt = (
  opts: SendOpenCodePromptOptions,
) => Promise<OpenCodeSendReport>;

type CheckOpenCodeSession = (sessionId: string) => Promise<OpenCodeSendReport>;

let startedServer = false;

function cockpitHome(): string {
  return process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
}

function daemonToken(): string | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(cockpitHome(), "daemon.json"), "utf8"),
    );
    return typeof raw?.token === "string" ? raw.token : null;
  } catch {
    return null;
  }
}

function normalizeServerUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function isOpenCodeServer(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/global/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!r.ok) return false;
    const j: any = await r.json();
    return j?.healthy === true;
  } catch {
    return false;
  }
}

async function waitForServer(url: string): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    if (await isOpenCodeServer(url)) return true;
    await Bun.sleep(200);
  }
  return false;
}

async function discoverOpenCodeServer(): Promise<string | null> {
  const envUrl = process.env.OPENCODE_SERVER_URL;
  const candidates = [
    ...(envUrl ? [normalizeServerUrl(envUrl)] : []),
    ...SERVER_CANDIDATES,
  ];
  for (const url of candidates) {
    if (await isOpenCodeServer(url)) return url;
  }
  return null;
}

async function ensureOpenCodeServer(): Promise<string | null> {
  const existing = await discoverOpenCodeServer();
  if (existing) return existing;
  if (!startedServer) {
    startedServer = true;
    const proc = spawn(
      "opencode",
      [
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(DEFAULT_OPENCODE_PORT),
      ],
      { stdio: "ignore" },
    );
    proc.unref();
  }
  const url = `http://127.0.0.1:${DEFAULT_OPENCODE_PORT}`;
  return (await waitForServer(url)) ? url : null;
}

async function checkOpenCodeSession(
  sessionId: string,
): Promise<OpenCodeSendReport> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const serverUrl = await ensureOpenCodeServer();
  if (!serverUrl) {
    return {
      ok: false,
      ready: false,
      sessionFound: false,
      delivered: false,
      warnings,
      errors: ["OpenCode server unavailable"],
    };
  }

  try {
    const r = await fetch(
      `${serverUrl}/session/${encodeURIComponent(sessionId)}`,
      { signal: AbortSignal.timeout(2_000) },
    );
    if (r.status === 404) {
      errors.push("OpenCode session not found");
      return {
        ok: false,
        ready: false,
        serverUrl,
        sessionFound: false,
        delivered: false,
        warnings,
        errors,
      };
    }
    if (!r.ok) throw new Error(`OpenCode session check failed: ${r.status}`);
    const j: any = await r.json().catch(() => ({}));
    return {
      ok: true,
      ready: true,
      serverUrl,
      sessionFound: true,
      delivered: false,
      sessionDirectory: typeof j?.directory === "string" ? j.directory : "",
      warnings,
      errors,
    };
  } catch (err) {
    errors.push(errorMessage(err));
    return {
      ok: false,
      ready: false,
      serverUrl,
      sessionFound: false,
      delivered: false,
      warnings,
      errors,
    };
  }
}

export async function sendOpenCodePrompt({
  sessionId,
  text,
}: SendOpenCodePromptOptions): Promise<OpenCodeSendReport> {
  const ready = await checkOpenCodeSession(sessionId);
  if (!ready.ok || !ready.serverUrl) return ready;

  try {
    const url = new URL(
      `${ready.serverUrl}/session/${encodeURIComponent(sessionId)}/prompt_async`,
    );
    if (ready.sessionDirectory) {
      url.searchParams.set("directory", ready.sessionDirectory);
    }
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text }],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) {
      const message =
        j?.data?.message ||
        j?.message ||
        j?.error ||
        `OpenCode prompt failed: ${r.status}`;
      return {
        ...ready,
        ok: false,
        delivered: false,
        errors: [...ready.errors, message],
      };
    }

    return {
      ...ready,
      delivered: true,
      delivery: "async",
    };
  } catch (err) {
    return {
      ...ready,
      ok: false,
      delivered: false,
      errors: [...ready.errors, errorMessage(err)],
    };
  }
}

export async function handleSendOpenCodeMessage(
  req: Request,
  sendPrompt: SendOpenCodePrompt = sendOpenCodePrompt,
): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const session = body?.session;
  const token = body?.token;
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (typeof session !== "string" || !OPENCODE_SESSION_RE.test(session)) {
    return json({ error: "invalid session" }, 400);
  }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text === "") return json({ error: "empty text" }, 400);

  const report = await sendPrompt({ sessionId: session, text });
  if (!report.ok || !report.delivered) {
    return json(
      {
        error: report.errors.join("; ") || "OpenCode send failed",
        warnings: report.warnings,
      },
      502,
    );
  }

  return json({
    delivered: true,
    delivery: report.delivery,
    inputId: report.inputId,
    serverUrl: report.serverUrl,
    warnings: report.warnings,
  });
}

export async function handleOpenCodeControlStatus(
  req: Request,
  checkSession: CheckOpenCodeSession = checkOpenCodeSession,
): Promise<Response> {
  const url = new URL(req.url);
  const session = url.searchParams.get("session");
  const token = url.searchParams.get("token");
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (typeof session !== "string" || !OPENCODE_SESSION_RE.test(session)) {
    return json({ error: "invalid session" }, 400);
  }

  const report = await checkSession(session);
  return json({
    ready: !!(report.ok && report.ready),
    serverUrl: report.serverUrl,
    warnings: report.warnings,
    errors: report.errors,
  });
}
