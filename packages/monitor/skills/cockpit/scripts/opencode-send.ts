import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonResponse as json } from "./http";

const OPENCODE_SESSION_RE = /^ses_[A-Za-z0-9_-]{8,160}$/;

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
  delivery?: "tui";
  warnings: string[];
  errors: string[];
};

type SendOpenCodePrompt = (
  opts: SendOpenCodePromptOptions,
) => Promise<OpenCodeSendReport>;

type CheckOpenCodeSession = (sessionId: string) => Promise<OpenCodeSendReport>;

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

function discoverOpenCodeTuiProcessUrls(): string[] {
  try {
    const out = execFileSync("ps", ["-axo", "command"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /(^|[/\s])opencode(\s|$)/.test(line))
      .filter((line) => !/\bopencode\s+(serve|web|attach)\b/.test(line))
      .map((line) => {
        const port =
          line.match(/--port(?:=|\s+)(\d{1,5})/)?.[1] ||
          line.match(/-p\s+(\d{1,5})/)?.[1];
        if (!port) return null;
        const hostname =
          line.match(/--hostname(?:=|\s+)(\S+)/)?.[1] || "127.0.0.1";
        return `http://${hostname}:${port}`;
      })
      .filter((url): url is string => !!url);
  } catch {
    return [];
  }
}

async function discoverOpenCodeServer(): Promise<string | null> {
  const envUrl =
    process.env.OPENCODE_TUI_SERVER_URL || process.env.OPENCODE_SERVER_URL;
  const candidates = [
    ...(envUrl ? [normalizeServerUrl(envUrl)] : []),
    ...discoverOpenCodeTuiProcessUrls(),
  ];
  for (const url of candidates) {
    if (await isOpenCodeServer(url)) return url;
  }
  return null;
}

async function ensureOpenCodeServer(): Promise<string | null> {
  return await discoverOpenCodeServer();
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
      errors: [
        "OpenCode TUI server unavailable. Start the visible TUI with opencode --port <n>, or set OPENCODE_TUI_SERVER_URL=http://127.0.0.1:<n> before starting cockpit.",
      ],
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
    const appendUrl = new URL(`${ready.serverUrl}/tui/append-prompt`);
    const submitUrl = new URL(`${ready.serverUrl}/tui/submit-prompt`);
    if (ready.sessionDirectory) {
      appendUrl.searchParams.set("directory", ready.sessionDirectory);
      submitUrl.searchParams.set("directory", ready.sessionDirectory);
    }
    const append = await fetch(appendUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5_000),
    });
    const appendJson: any = await append.json().catch(() => ({}));
    if (!append.ok || appendJson !== true) {
      const message =
        appendJson?.data?.message ||
        appendJson?.message ||
        appendJson?.error ||
        `OpenCode TUI append failed: ${append.status}`;
      return {
        ...ready,
        ok: false,
        delivered: false,
        errors: [...ready.errors, message],
      };
    }

    const submit = await fetch(submitUrl, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
    const submitJson: any = await submit.json().catch(() => ({}));
    if (!submit.ok || submitJson !== true) {
      const message =
        submitJson?.data?.message ||
        submitJson?.message ||
        submitJson?.error ||
        `OpenCode TUI submit failed: ${submit.status}`;
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
      delivery: "tui",
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
