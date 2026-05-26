import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonResponse as json } from "./http";

const UUID_RE = /^[0-9a-f-]{36}$/;

type Sub = (text: string) => void;
const subscribers = new Map<string, Set<Sub>>();

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
  subs?.forEach((fn) => fn(text));
  return json({ delivered: subs?.size ?? 0 });
}

export function handleReplyStream(req: Request): Response {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") || "";
  const token = url.searchParams.get("token") || "";
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (!validateSession(session)) return json({ error: "invalid session" }, 400);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(ctrl) {
      const send = (chunk: string) => ctrl.enqueue(encoder.encode(chunk));
      const remove = addSubscriber(session, (text) => {
        send(`data: ${JSON.stringify({ text })}\n\n`);
      });
      send(": connected\n\n");
      const ping = setInterval(() => send(": ping\n\n"), 25_000);
      req.signal?.addEventListener("abort", () => {
        clearInterval(ping);
        remove();
        try {
          ctrl.close();
        } catch {
          // already closed
        }
      });
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
