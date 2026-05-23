// cockpit broker — the per-session control loop. A parked session long-polls
// GET /api/wait; the UI (or `cockpit send`) POSTs /api/respond, which appends a
// response record to that session's log and wakes the matching parked wait.
// Routing is keyed by sessionId (a Map, not a flat queue) so concurrent
// sessions never steal each other's events.
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readRegistry } from "./registry";

const UUID_RE = /^[0-9a-f-]{36}$/;

// At most one outstanding wait per session (the session is parked while
// waiting). Lives in the daemon process — a restarted daemon simply has no
// parked sessions (they re-poll), so no persistence is needed.
const pendingWaits = new Map<string, (answer: string | null) => void>();

// ---------- central dir (overridable for tests) ----------

function cockpitHome(): string {
  return process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
}

// The shared secret the daemon wrote on bind. Read fresh per request so a
// daemon restart (new token) is picked up without caching staleness.
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

// Single-hop long-poll budget. Kept under the daemon's 255s idleTimeout (see
// serve-dashboard.ts) so the hop resolves with a re-pollable sentinel before
// Bun can drop the idle socket; cockpit wait simply re-polls. Overridable so
// tests don't wait minutes.
function waitTimeoutMs(): number {
  const v = parseInt(process.env.COCKPIT_WAIT_TIMEOUT_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 240_000;
}

function logPathFor(sessionId: string): string | null {
  return readRegistry().find((e) => e.sessionId === sessionId)?.logPath ?? null;
}

function json(payload: object, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// ---------- GET /api/wait?session=<uuid>&token=<t> ----------

export function handleWait(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") || "";
  const token = url.searchParams.get("token") || "";
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (!UUID_RE.test(session)) return json({ error: "invalid session" }, 400);

  // Replace any stale resolver for this session — only one park at a time.
  pendingWaits.get(session)?.(null);

  return new Promise<Response>((resolve) => {
    let settled = false;
    const resolver = (answer: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingWaits.get(session) === resolver) pendingWaits.delete(session);
      resolve(
        answer === null
          ? json({ answer: null, timeout: true }) // re-pollable sentinel
          : json({ answer }),
      );
    };
    const timer = setTimeout(() => resolver(null), waitTimeoutMs());
    pendingWaits.set(session, resolver);
    // Client hung up (e.g. cockpit wait killed) — drop the parked entry.
    req.signal?.addEventListener("abort", () => resolver(null));
  });
}

// ---------- POST /api/respond { session, answer, token } ----------

export async function handleRespond(req: Request): Promise<Response> {
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
  const answer = typeof body.answer === "string" ? body.answer : "";

  // Append a durable response record (streams to the UI via the log SSE).
  const logPath = logPathFor(session);
  if (logPath) {
    const rec = { type: "response", answer, ts: new Date().toISOString() };
    try {
      appendFileSync(logPath, JSON.stringify(rec) + "\n");
    } catch {
      // best-effort; still try to wake a parked wait below
    }
  }

  // Wake the parked wait if one exists; otherwise the answer is logged only.
  const resolver = pendingWaits.get(session);
  if (resolver) {
    pendingWaits.delete(session);
    resolver(answer);
    return json({ delivered: true });
  }
  return json({ delivered: false });
}
