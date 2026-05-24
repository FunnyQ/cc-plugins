// cockpit broker — the per-session control loop. A parked session long-polls
// GET /api/wait; the UI (or `cockpit send`) POSTs /api/respond, which appends a
// response record to that session's log and wakes the matching parked wait.
// Routing is keyed by sessionId (a Map, not a flat queue) so concurrent
// sessions never steal each other's events.
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readRegistry } from "./registry";
import { jsonResponse as json } from "./http";

const UUID_RE = /^[0-9a-f-]{36}$/;

// At most one outstanding wait per session (the session is parked while
// waiting). Lives in the daemon process — a restarted daemon simply has no
// parked sessions (they re-poll), so no persistence is needed.
const pendingWaits = new Map<string, (answer: string | null) => void>();

// Answers that arrived before any wait was parked. The `cockpit wait` background
// task cold-starts a few seconds after the needs_your_call is logged, but the
// needs-call card appears in the dashboard immediately — so the user can answer
// faster than the wait can register its long-poll. Without this, that answer is
// logged but never delivered, and the wait parks afterward and hangs. Stash it
// per session so the next wait hop drains it instead. Only an open needs_your_call
// stashes (see handleRespond), and the entry is TTL-bounded, so a stale answer
// can't be mis-delivered to a later, unrelated call.
const stashedAnswers = new Map<string, { answer: string; expires: number }>();

function stashTtlMs(): number {
  const v = parseInt(process.env.COCKPIT_STASH_TTL_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
}

function stashAnswer(session: string, answer: string): void {
  stashedAnswers.set(session, { answer, expires: Date.now() + stashTtlMs() });
}

function takeStashedAnswer(session: string): string | null {
  const e = stashedAnswers.get(session);
  if (!e) return null;
  stashedAnswers.delete(session);
  return e.expires > Date.now() ? e.answer : null;
}

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

// Is the session's most recent needs_your_call still unanswered? Scans the
// decision log from the end: the first response record means the latest call is
// already answered (no open call); a needs_your_call decision reached first means
// it's still open. Responds are human-paced and these logs are small, so reading
// the file here is cheap.
function hasOpenCall(logPath: string): boolean {
  let lines: string[];
  try {
    lines = readFileSync(logPath, "utf8").split("\n");
  } catch {
    return false;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let rec: any;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.type === "response") return false; // latest call already answered
    if (rec.type === "decision" && rec.needs_your_call === true) return true;
  }
  return false;
}

// ---------- GET /api/wait?session=<uuid>&token=<t> ----------

export function handleWait(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") || "";
  const token = url.searchParams.get("token") || "";
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (!UUID_RE.test(session)) return json({ error: "invalid session" }, 400);

  // An answer may have arrived before this wait parked (the cold-start race) —
  // deliver it immediately instead of parking and hanging on it.
  const stashed = takeStashedAnswer(session);
  if (stashed !== null) return json({ answer: stashed });

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

  // Decide whether this answer is worth stashing BEFORE we append the response
  // record (which would otherwise make the call look answered). Only an open
  // needs_your_call earns a stash — a stray send to an idle session must not
  // pre-load the next, unrelated wait.
  const logPath = logPathFor(session);
  const open = logPath ? hasOpenCall(logPath) : false;

  // Append a durable response record (streams to the UI via the log SSE).
  if (logPath) {
    const rec = {
      id: crypto.randomUUID(),
      type: "response",
      answer,
      ts: new Date().toISOString(),
    };
    try {
      appendFileSync(logPath, JSON.stringify(rec) + "\n");
    } catch {
      // best-effort; still try to wake a parked wait below
    }
  }

  // Wake the parked wait if one exists; otherwise, for an open call, stash the
  // answer so the next wait hop delivers it (the wait may still be cold-starting)
  // instead of losing it. The response is already durably logged above.
  const resolver = pendingWaits.get(session);
  if (resolver) {
    pendingWaits.delete(session);
    resolver(answer);
    return json({ delivered: true });
  }
  if (open) stashAnswer(session, answer);
  return json({ delivered: false });
}
