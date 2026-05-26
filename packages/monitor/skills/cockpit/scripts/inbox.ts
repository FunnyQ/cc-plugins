import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonResponse as json } from "./http";

const UUID_RE = /^[0-9a-f-]{36}$/;

type ParkedInbox = { resolve: (message: string | null) => void };
const pendingInbox = new Map<string, ParkedInbox>();
const stashed = new Map<string, { text: string; expires: number }>();

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

function waitTimeoutMs(): number {
  const v = parseInt(process.env.COCKPIT_WAIT_TIMEOUT_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 240_000;
}

function stashTtlMs(): number {
  const v = parseInt(process.env.COCKPIT_STASH_TTL_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
}

function takeStashed(session: string): string | null {
  const e = stashed.get(session);
  if (!e) return null;
  stashed.delete(session);
  return e.expires > Date.now() ? e.text : null;
}

export function hasChannel(sessionId: string): boolean {
  return pendingInbox.has(sessionId);
}

export function handleInbox(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") || "";
  const token = url.searchParams.get("token") || "";
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (!UUID_RE.test(session)) return json({ error: "invalid session" }, 400);

  const stashedText = takeStashed(session);
  if (stashedText !== null) return json({ message: stashedText });

  pendingInbox.get(session)?.resolve(null);

  return new Promise<Response>((resolve) => {
    let settled = false;
    const resolver = (message: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingInbox.get(session)?.resolve === resolver)
        pendingInbox.delete(session);
      resolve(
        message === null
          ? json({ message: null, timeout: true })
          : json({ message }),
      );
    };
    const timer = setTimeout(() => resolver(null), waitTimeoutMs());
    pendingInbox.set(session, { resolve: resolver });
    req.signal?.addEventListener("abort", () => resolver(null));
  });
}

export async function handleSendMessage(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const session = body?.session;
  const token = body?.token;
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (typeof session !== "string" || !UUID_RE.test(session)) {
    return json({ error: "invalid session" }, 400);
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (text.trim() === "") return json({ error: "empty text" }, 400);

  const parked = pendingInbox.get(session);
  if (parked) {
    pendingInbox.delete(session);
    parked.resolve(text);
    return json({ delivered: true });
  }

  stashed.set(session, { text, expires: Date.now() + stashTtlMs() });
  return json({ delivered: false });
}
