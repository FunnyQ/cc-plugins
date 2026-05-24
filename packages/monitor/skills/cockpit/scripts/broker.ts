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
import { callMatches, latestOpenCallId } from "./call-log";

const UUID_RE = /^[0-9a-f-]{36}$/;

// At most one outstanding wait per session (the session is parked while
// waiting). Lives in the daemon process — a restarted daemon simply has no
// parked sessions (they re-poll), so no persistence is needed. Each park
// records the callId it's waiting on, so an answer to a different (stale) card
// can't wake it — see callMatches.
type ParkedWait = {
  callId: string | null;
  resolve: (answer: string | null) => void;
};
const pendingWaits = new Map<string, ParkedWait>();

// Answers that arrived before any wait was parked. The `cockpit wait` background
// task cold-starts a few seconds after the needs_your_call is logged, but the
// needs-call card appears in the dashboard immediately — so the user can answer
// faster than the wait can register its long-poll. Without this, that answer is
// logged but never delivered, and the wait parks afterward and hangs. Stash it
// per session so the next wait hop drains it instead. Only an open needs_your_call
// stashes (see handleRespond), and the entry is TTL-bounded, so a stale answer
// can't be mis-delivered to a later, unrelated call.
const stashedAnswers = new Map<
  string,
  { answer: string; callId: string | null; expires: number }
>();

function stashTtlMs(): number {
  const v = parseInt(process.env.COCKPIT_STASH_TTL_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
}

function stashAnswer(
  session: string,
  answer: string,
  callId: string | null,
): void {
  stashedAnswers.set(session, {
    answer,
    callId,
    expires: Date.now() + stashTtlMs(),
  });
}

// Drain the stash for a session, but only if it's meant for the call this wait
// is parked on (callMatches tolerates a null on either side). A stash for a
// different, superseded call is left in place to expire on its own.
function takeStashedAnswer(
  session: string,
  expectedCall: string | null,
): string | null {
  const e = stashedAnswers.get(session);
  if (!e) return null;
  if (!callMatches(e.callId, expectedCall)) return null;
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
// cockpit-server.ts) so the hop resolves with a re-pollable sentinel before
// Bun can drop the idle socket; cockpit wait simply re-polls. Overridable so
// tests don't wait minutes.
function waitTimeoutMs(): number {
  const v = parseInt(process.env.COCKPIT_WAIT_TIMEOUT_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 240_000;
}

function logPathFor(sessionId: string): string | null {
  return readRegistry().find((e) => e.sessionId === sessionId)?.logPath ?? null;
}

// The id of the session's most recent still-open needs_your_call, or null.
// Responds are human-paced and these logs are small, so reading the file here
// is cheap. Scanning logic lives in call-log.ts so the CLI agrees with us.
function openCallId(logPath: string): string | null {
  try {
    return latestOpenCallId(readFileSync(logPath, "utf8").split("\n"));
  } catch {
    return null;
  }
}

// ---------- GET /api/wait?session=<uuid>&token=<t> ----------

export function handleWait(req: Request): Response | Promise<Response> {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") || "";
  const token = url.searchParams.get("token") || "";
  // The callId this wait is parked on. Optional: legacy callers omit it and
  // fall back to session-only routing (see callMatches).
  const callId = url.searchParams.get("call") || null;
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (!UUID_RE.test(session)) return json({ error: "invalid session" }, 400);

  // An answer may have arrived before this wait parked (the cold-start race) —
  // deliver it immediately instead of parking and hanging on it.
  const stashed = takeStashedAnswer(session, callId);
  if (stashed !== null) return json({ answer: stashed });

  // The named call is no longer the open one (answered elsewhere, or a newer
  // call superseded it) — don't park on a moot question and hang until the
  // ceiling. Tell the client so it stops re-polling. Only enforced when a
  // callId is named; legacy session-only waits keep their old behavior.
  if (callId !== null) {
    const logPath = logPathFor(session);
    if (logPath && openCallId(logPath) !== callId) {
      return json({ answer: null, superseded: true });
    }
  }

  // Replace any stale resolver for this session — only one park at a time.
  pendingWaits.get(session)?.resolve(null);

  return new Promise<Response>((resolve) => {
    let settled = false;
    const resolver = (answer: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingWaits.get(session)?.resolve === resolver)
        pendingWaits.delete(session);
      resolve(
        answer === null
          ? json({ answer: null, timeout: true }) // re-pollable sentinel
          : json({ answer }),
      );
    };
    const timer = setTimeout(() => resolver(null), waitTimeoutMs());
    pendingWaits.set(session, { callId, resolve: resolver });
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
  const bodyCall = typeof body.call === "string" ? body.call : null;

  // Resolve which call this answer targets BEFORE appending the response record
  // (which would otherwise make the call look answered). Prefer an explicit
  // callId from the client; else fall back to the session's currently open
  // call. Only an open call earns a stash — a stray send to an idle session
  // must not pre-load the next, unrelated wait.
  const logPath = logPathFor(session);
  const openCall = logPath ? openCallId(logPath) : null;
  const targetCall = bodyCall ?? openCall;

  // Append a durable response record (streams to the UI via the log SSE). It
  // carries the callId it answers so the UI resolves the right card.
  if (logPath) {
    const rec = {
      id: crypto.randomUUID(),
      type: "response",
      call: targetCall,
      answer,
      ts: new Date().toISOString(),
    };
    try {
      appendFileSync(logPath, JSON.stringify(rec) + "\n");
    } catch {
      // best-effort; still try to wake a parked wait below
    }
  }

  // Wake the parked wait only when it's parked on the same call (callMatches
  // tolerates a null on either side for legacy callers). Otherwise, for an open
  // call, stash the answer so the next matching wait hop delivers it (the wait
  // may still be cold-starting) instead of losing it. The response is already
  // durably logged above.
  const parked = pendingWaits.get(session);
  if (parked && callMatches(parked.callId, targetCall)) {
    pendingWaits.delete(session);
    parked.resolve(answer);
    return json({ delivered: true });
  }
  if (openCall !== null) stashAnswer(session, answer, targetCall);
  return json({ delivered: false });
}
