import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage, jsonResponse as json } from "./http";
import { daemonToken } from "./cockpit-home";

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
  delivery?: "tui" | "service";
  warnings: string[];
  errors: string[];
};

type SendOpenCodePrompt = (
  opts: SendOpenCodePromptOptions,
) => Promise<OpenCodeSendReport>;

type CheckOpenCodeSession = (sessionId: string) => Promise<OpenCodeSendReport>;

function normalizeServerUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function openCodeHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers = { ...extra };
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (password) {
    const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
    headers.authorization = `Basic ${btoa(`${username}:${password}`)}`;
  }
  return headers;
}

async function isOpenCodeServer(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/global/health`, {
      headers: openCodeHeaders(),
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

// opencode 2.x runs one background service per user; the TUI is its client and
// opens no port of its own, so the 1.x `--port` discovery below finds nothing.
type OpenCodeService = { url: string; password: string };

function serviceHeaders(
  service: OpenCodeService,
  extra: Record<string, string> = {},
): Record<string, string> {
  // The 2.x CLI hard-codes the username; only the password is configurable.
  return {
    ...extra,
    authorization: `Basic ${btoa(`opencode:${service.password}`)}`,
  };
}

function readServiceRegistration(): Partial<OpenCodeService> {
  const stateHome =
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  try {
    const entry = JSON.parse(
      readFileSync(join(stateHome, "opencode", "service.json"), "utf8"),
    );
    return {
      url: typeof entry?.url === "string" ? entry.url : undefined,
      password:
        typeof entry?.password === "string" ? entry.password : undefined,
    };
  } catch {
    return {};
  }
}

// Credentials in a URL would ride serverUrl back to the dashboard.
function stripUserInfo(value: string): string {
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    return normalizeServerUrl(u.toString());
  } catch {
    return normalizeServerUrl(value);
  }
}

type ServiceDiscovery =
  | { service: OpenCodeService }
  | { error: string }
  | { warning?: string };

async function discoverOpenCodeService(): Promise<ServiceDiscovery> {
  // A URL and its password come from the same source, as the opencode CLI
  // pairs them: an env URL with a registration password would hand one
  // service's password to another.
  const envUrl = process.env.OPENCODE_SERVER_URL;
  const { url, password } = envUrl
    ? {
        url: envUrl,
        password:
          process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD,
      }
    : readServiceRegistration();
  if (!url || !password) return {};
  const service = { url: stripUserInfo(url), password };
  let r: Response;
  try {
    r = await fetch(`${service.url}/api/info`, {
      headers: serviceHeaders(service),
      signal: AbortSignal.timeout(1_000),
    });
  } catch {
    return { warning: `Could not reach OpenCode service at ${service.url}` };
  }
  if (r.status === 401 || r.status === 403) {
    return {
      error: `OpenCode service at ${service.url} rejected the password (${r.status}). Check OPENCODE_PASSWORD or the service registration.`,
    };
  }
  // Unknown paths return the web UI's HTML with a 200, so only a parsed
  // version proves this is the 2.x API.
  const j: any = r.ok ? await r.json().catch(() => null) : null;
  return typeof j?.version === "string" ? { service } : {};
}

async function checkServiceSession(
  service: OpenCodeService,
  sessionId: string,
): Promise<OpenCodeSendReport> {
  const base = {
    serverUrl: service.url,
    delivered: false,
    warnings: [] as string[],
  };
  try {
    const r = await fetch(
      `${service.url}/api/session/${encodeURIComponent(sessionId)}`,
      {
        headers: serviceHeaders(service),
        signal: AbortSignal.timeout(2_000),
      },
    );
    if (r.status === 404) {
      return {
        ...base,
        ok: false,
        ready: false,
        sessionFound: false,
        errors: ["OpenCode session not found"],
      };
    }
    if (!r.ok) throw new Error(`OpenCode session check failed: ${r.status}`);
    const j: any = await r.json().catch(() => null);
    if (!j?.data || typeof j.data !== "object") {
      return {
        ...base,
        ok: false,
        ready: false,
        sessionFound: false,
        errors: ["OpenCode returned an unexpected response from /api/session"],
      };
    }
    const directory = j.data.directory;
    return {
      ...base,
      ok: true,
      ready: true,
      sessionFound: true,
      sessionDirectory: typeof directory === "string" ? directory : "",
      errors: [],
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      ready: false,
      sessionFound: false,
      errors: [errorMessage(err)],
    };
  }
}

async function sendServicePrompt(
  service: OpenCodeService,
  sessionId: string,
  text: string,
): Promise<OpenCodeSendReport> {
  const ready = await checkServiceSession(service, sessionId);
  if (!ready.ok) return ready;
  try {
    const r = await fetch(
      `${service.url}/api/session/${encodeURIComponent(sessionId)}/prompt`,
      {
        method: "POST",
        headers: serviceHeaders(service, {
          "content-type": "application/json",
        }),
        // steer lands the message in the running turn instead of after it.
        body: JSON.stringify({ text, delivery: "steer" }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j?.data) {
      const message =
        j?.data?.message ||
        j?.message ||
        j?.error ||
        `OpenCode prompt failed: ${r.status}`;
      return { ...ready, ok: false, errors: [...ready.errors, message] };
    }
    return { ...ready, delivered: true, delivery: "service" };
  } catch (err) {
    return {
      ...ready,
      ok: false,
      errors: [...ready.errors, errorMessage(err)],
    };
  }
}

function serviceFailure(error: string): OpenCodeSendReport {
  return {
    ok: false,
    ready: false,
    sessionFound: false,
    delivered: false,
    warnings: [],
    errors: [error],
  };
}

function withWarning(
  report: OpenCodeSendReport,
  warning: string | undefined,
): OpenCodeSendReport {
  return warning
    ? { ...report, warnings: [warning, ...report.warnings] }
    : report;
}

async function checkOpenCodeSession(
  sessionId: string,
): Promise<OpenCodeSendReport> {
  const found = await discoverOpenCodeService();
  if ("service" in found) return checkServiceSession(found.service, sessionId);
  if ("error" in found) return serviceFailure(found.error);
  return withWarning(await checkOpenCodeTuiSession(sessionId), found.warning);
}

const UPGRADE_NOTICE =
  "This OpenCode session runs opencode 1.x, whose TUI bridge cockpit will drop. Run `opencode upgrade` to move to 2.x.";
const toastedServers = new Set<string>();

// The bridge only exists on 1.x, so reaching it proves the version. Toasted
// once per server per daemon, so every send does not repeat it.
async function toastUpgradeNotice(serverUrl: string): Promise<void> {
  if (toastedServers.has(serverUrl)) return;
  toastedServers.add(serverUrl);
  try {
    await fetch(`${serverUrl}/tui/show-toast`, {
      method: "POST",
      headers: openCodeHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({
        title: "cockpit",
        message: UPGRADE_NOTICE,
        variant: "warning",
      }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // The notice also rides the report's warnings; a lost toast costs nothing.
  }
}

async function checkOpenCodeTuiSession(
  sessionId: string,
): Promise<OpenCodeSendReport> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const serverUrl = await discoverOpenCodeServer();
  if (!serverUrl) {
    return {
      ok: false,
      ready: false,
      sessionFound: false,
      delivered: false,
      warnings,
      errors: [
        "OpenCode server unavailable. Keep an opencode 2.x TUI open so its background service is running, or on opencode 1.x start the TUI with opencode --port <n> (or set OPENCODE_TUI_SERVER_URL=http://127.0.0.1:<n>) before starting cockpit.",
      ],
    };
  }

  try {
    const r = await fetch(
      `${serverUrl}/session/${encodeURIComponent(sessionId)}`,
      {
        headers: openCodeHeaders(),
        signal: AbortSignal.timeout(2_000),
      },
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
      warnings: [...warnings, UPGRADE_NOTICE],
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
  const found = await discoverOpenCodeService();
  if ("service" in found) {
    return sendServicePrompt(found.service, sessionId, text);
  }
  if ("error" in found) return serviceFailure(found.error);
  const ready = withWarning(
    await checkOpenCodeTuiSession(sessionId),
    found.warning,
  );
  if (!ready.ok || !ready.serverUrl) return ready;
  await toastUpgradeNotice(ready.serverUrl);

  try {
    const appendUrl = new URL(`${ready.serverUrl}/tui/append-prompt`);
    const submitUrl = new URL(`${ready.serverUrl}/tui/submit-prompt`);
    if (ready.sessionDirectory) {
      appendUrl.searchParams.set("directory", ready.sessionDirectory);
      submitUrl.searchParams.set("directory", ready.sessionDirectory);
    }
    const append = await fetch(appendUrl, {
      method: "POST",
      headers: openCodeHeaders({ "content-type": "application/json" }),
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
      headers: openCodeHeaders(),
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
