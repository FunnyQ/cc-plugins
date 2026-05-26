import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { jsonResponse as json } from "./http";

const UUID_RE = /^[0-9a-f-]{36}$/;
const TICKET_TTL_MS = 60_000;

type Sub = (text: string) => boolean;
const subscribers = new Map<string, Set<Sub>>();
const tickets = new Map<string, { session: string; expiresAt: number }>();

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

function validateSession(session: string): boolean {
  return UUID_RE.test(session);
}

function addSubscriber(session: string, sub: Sub): () => void {
  const set = subscribers.get(session) ?? new Set<Sub>();
  set.add(sub);
  subscribers.set(session, set);
  return () => {
    set.delete(sub);
    if (set.size === 0) subscribers.delete(session);
  };
}

export function subscriberCount(session: string): number {
  return subscribers.get(session)?.size ?? 0;
}

function cleanupTickets(now = Date.now()): void {
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
}

function issueTicket(session: string): { ticket: string; expiresAt: number } {
  cleanupTickets();
  const ticket = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + TICKET_TTL_MS;
  tickets.set(ticket, { session, expiresAt });
  return { ticket, expiresAt };
}

function consumeTicket(session: string, ticket: string): boolean {
  cleanupTickets();
  const entry = tickets.get(ticket);
  if (!entry || entry.session !== session) return false;
  tickets.delete(ticket);
  return true;
}

export async function handleReplyTicket(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const session = body?.session;
  const token = body?.token;
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (typeof session !== "string" || !validateSession(session)) {
    return json({ error: "invalid session" }, 400);
  }
  return json(issueTicket(session));
}

export async function handleReply(req: Request): Promise<Response> {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const session = body?.session;
  const token = body?.token;
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (typeof session !== "string" || !validateSession(session)) {
    return json({ error: "invalid session" }, 400);
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (text.trim() === "") return json({ error: "empty text" }, 400);

  const subs = subscribers.get(session);
  let delivered = 0;
  for (const fn of [...(subs ?? [])]) {
    if (fn(text)) delivered += 1;
    else subs?.delete(fn);
  }
  if (subs?.size === 0) subscribers.delete(session);
  return json({ delivered });
}

export function handleReplyStream(req: Request): Response {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") || "";
  const ticket = url.searchParams.get("ticket") || "";
  if (!validateSession(session)) return json({ error: "invalid session" }, 400);
  if (!consumeTicket(session, ticket))
    return json({ error: "unauthorized" }, 401);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(ctrl) {
      let closed = false;
      let remove = () => {};
      let ping: ReturnType<typeof setInterval> | null = null;
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        remove();
        try {
          ctrl.close();
        } catch {
          // already closed
        }
      };
      const send = (chunk: string): boolean => {
        if (closed) return false;
        try {
          ctrl.enqueue(encoder.encode(chunk));
          return true;
        } catch {
          cleanup();
          return false;
        }
      };
      remove = addSubscriber(session, (text) => {
        return send(`data: ${JSON.stringify({ text })}\n\n`);
      });
      send(": connected\n\n");
      ping = setInterval(() => send(": ping\n\n"), 25_000);
      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
