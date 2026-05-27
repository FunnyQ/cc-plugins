// cockpit permission broker — relays a tool-permission prompt from the channel
// out to the UI and the verdict back. Three flows, all in-memory and keyed by
// session AND request_id (a stale verdict from a superseded card can't resolve a
// newer request):
//   - request fan-out: the channel POSTs /api/permission-request; the daemon
//     stashes it (TTL) and fans a {type:"request"} SSE frame to subscribed UI
//     tabs (GET /api/permission-stream); a tab that subscribes a moment later
//     replays the stashed pending request.
//   - verdict round-trip: the UI POSTs /api/permission-verdict; the daemon wakes
//     the channel's parked long-poll (GET /api/permission-pull) — or stashes the
//     verdict for the next pull (cold-start race) — and broadcasts a "resolved"
//     SSE frame.
//   - resolved broadcast (best-effort): the channel POSTs /api/permission-resolved
//     if Claude Code ever tells it the request was answered elsewhere (terminal /
//     hook / timeout — undocumented), so the UI's modal closes promptly.
// A restarted daemon simply has no pending requests; clients re-poll. Same
// cockpitHome()/daemonToken()/UUID_RE/env-override helpers as broker.ts/inbox.ts.
import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonResponse as json } from "./http";
import { resolveClaudeTranscriptPath } from "./transcript-stream";

const UUID_RE = /^[0-9a-f-]{36}$/;

type Behavior = "allow" | "deny";

// The parked-pull wake contract (see protocol.md): a pull resolves with EITHER a
// real verdict {requestId, behavior}, OR null (re-pollable timeout sentinel),
// OR {abandoned:true} when the request was resolved elsewhere (superseded by a
// newer request, or the transcript advanced past the blocking turn). The channel
// treats {abandoned:true} like an abort — it stops pulling without echoing a
// verdict.
type PullResult =
  | { requestId: string; behavior: Behavior }
  | { abandoned: true };

type PendingRequest = {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  expires: number;
  // Transcript watcher torn down on ANY resolution path (verdict / supersede /
  // transcript-progress / TTL) so no watcher leaks past the request it guards.
  watcher: FSWatcher | null;
  // Proactive expiry timer: fires at `expires` to actively sweep an orphan
  // request (no UI pull, no verdict, fs.watch missed progress) so the watcher
  // never leaks waiting for a passive takePending() that may never come.
  expiryTimer: ReturnType<typeof setTimeout> | null;
};
// One in-flight request per session (Claude serializes tool prompts). Holds the
// stash for a UI tab that subscribes just after the request fans out.
const pendingBySession = new Map<string, PendingRequest>();

// UI SSE subscribers per session — a fan-out Set so multiple tabs each get the
// request/resolved frames.
const streams = new Map<string, Set<ReadableStreamDefaultController>>();

// Verdict waiting to be pulled by the channel's long-poll (cold-start race: the
// verdict can arrive before the channel re-parks its pull).
type StashedVerdict = {
  requestId: string;
  behavior: Behavior;
  expires: number;
};
const verdictStash = new Map<string, StashedVerdict>();

// At most one parked channel pull per session. Re-parking resolves any stale
// resolver first. A resolver accepts a real verdict, null (timeout sentinel), or
// {abandoned:true} (resolved-elsewhere — supersede or transcript progress).
type ParkedPull = {
  resolve: (v: PullResult | null) => void;
};
const pendingPulls = new Map<string, ParkedPull>();

// Wake a session's parked pull (if any) with {abandoned:true}, so the channel
// stops waiting on a request that was resolved outside cockpit.
function abandonParkedPull(session: string): void {
  const parked = pendingPulls.get(session);
  if (parked) {
    pendingPulls.delete(session);
    parked.resolve({ abandoned: true });
  }
}

// ---------- central dir + token (overridable for tests) ----------

function cockpitHome(): string {
  return process.env.COCKPIT_HOME || join(homedir(), ".cockpit");
}

// The shared secret the daemon wrote on bind. Read fresh per request so a daemon
// restart (new token) is picked up without caching staleness.
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

// Single-hop long-poll budget. Kept under the daemon's 255s idleTimeout so the
// pull resolves with a re-pollable sentinel before Bun drops the idle socket.
function waitTimeoutMs(): number {
  const v = parseInt(process.env.COCKPIT_WAIT_TIMEOUT_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 240_000;
}

function stashTtlMs(): number {
  const v = parseInt(process.env.COCKPIT_STASH_TTL_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 60_000;
}

const HEARTBEAT_MS = 25_000;

// Ignore transcript events for this long after registration: the tool_use line
// that TRIGGERED the permission prompt is written ~simultaneously, so an event
// inside this window is the request's own line, not the resolution that follows.
function transcriptGuardMs(): number {
  const v = parseInt(process.env.COCKPIT_TRANSCRIPT_GUARD_MS || "", 10);
  return Number.isFinite(v) && v > 0 ? v : 1000;
}

// ---------- pure helpers (unit-tested) ----------

// Pure decision: does a transcript file event count as "the turn moved forward"
// (⇒ the blocking permission was resolved elsewhere)? A pending permission
// BLOCKS the turn, so the first FORWARD append after the guard window proves
// resolution. We require BOTH: past the guard window (so the triggering
// tool_use line doesn't count) AND the file grew beyond its registration size
// (a forward append, not a truncate/touch).
export function isForwardProgress(args: {
  registeredAt: number;
  registeredSize: number;
  now: number;
  newSize: number;
  guardMs: number;
}): boolean {
  if (args.now - args.registeredAt < args.guardMs) return false;
  return args.newSize > args.registeredSize;
}

// Tear down a pending request's transcript watcher + proactive expiry timer
// (idempotent). Called by every resolution path before the entry is dropped.
function teardownWatcher(pending: PendingRequest | undefined | null): void {
  if (pending?.watcher) {
    try {
      pending.watcher.close();
    } catch {
      // already closed — ignore
    }
    pending.watcher = null;
  }
  if (pending?.expiryTimer) {
    clearTimeout(pending.expiryTimer);
    pending.expiryTimer = null;
  }
}

// True iff the pending request (if any) is still within its TTL.
export function takePending(sessionId: string): PendingRequest | null {
  const e = pendingBySession.get(sessionId);
  if (!e) return null;
  if (e.expires <= Date.now()) {
    // TTL elapsed — clear it AND tear down its watcher so nothing leaks.
    teardownWatcher(e);
    pendingBySession.delete(sessionId);
    return null;
  }
  return e;
}

export function hasPendingRequest(sessionId: string): boolean {
  return takePending(sessionId) !== null;
}

// Drain the stash for a session, but only if it's the verdict for the request
// this pull expects. A non-matching stash is left to expire on its own.
function takeStashedVerdict(
  session: string,
): { requestId: string; behavior: Behavior } | null {
  const e = verdictStash.get(session);
  if (!e) return null;
  verdictStash.delete(session);
  if (e.expires <= Date.now()) return null;
  return { requestId: e.requestId, behavior: e.behavior };
}

// Fan a JSON frame to every SSE subscriber on a session. Dead controllers are
// swept on enqueue failure.
function broadcast(session: string, frame: object): void {
  const subs = streams.get(session);
  if (!subs) return;
  const chunk = `data: ${JSON.stringify(frame)}\n\n`;
  for (const controller of [...subs]) {
    try {
      controller.enqueue(chunk);
    } catch {
      subs.delete(controller);
    }
  }
}

// Mark a pending request resolved-elsewhere: tear down its watcher, clear it,
// broadcast a {resolved, source:"elsewhere"} frame, and wake any parked pull
// with {abandoned:true}. Shared by supersede and transcript-progress. No-op if
// the session's pending request no longer matches (already resolved).
function resolveElsewhere(session: string, requestId: string): boolean {
  const pending = pendingBySession.get(session);
  if (!pending || pending.requestId !== requestId) return false;
  teardownWatcher(pending);
  pendingBySession.delete(session);
  broadcast(session, {
    type: "resolved",
    request_id: requestId,
    source: "elsewhere",
  });
  abandonParkedPull(session);
  return true;
}

// Watch a session's transcript file for forward progress. Because a pending
// permission BLOCKS the turn, the first forward append after the guard window
// means the prompt was answered outside cockpit (TUI or auto-approve hook) — so
// we resolve-elsewhere. Returns the watcher (or null if the transcript can't be
// found / watch can't start). Errors are swallowed: a missing watcher just means
// the UI falls back to its TTL, which is still correct.
function watchTranscriptForProgress(
  session: string,
  requestId: string,
): FSWatcher | null {
  const path = resolveClaudeTranscriptPath(session);
  if (!path) return null;
  let registeredSize: number;
  try {
    registeredSize = statSync(path).size;
  } catch {
    return null;
  }
  const registeredAt = Date.now();
  const guardMs = transcriptGuardMs();
  try {
    return watch(path, () => {
      let newSize: number;
      try {
        newSize = statSync(path).size;
      } catch {
        return; // transcript vanished — let the TTL handle it
      }
      if (
        isForwardProgress({
          registeredAt,
          registeredSize,
          now: Date.now(),
          newSize,
          guardMs,
        })
      ) {
        resolveElsewhere(session, requestId);
      }
    });
  } catch {
    return null;
  }
}

// ---------- POST /api/permission-request ----------
// { session, token, request_id, tool_name, description, input_preview }

export async function handlePermissionRequest(req: Request): Promise<Response> {
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
  const requestId = body?.request_id;
  if (typeof requestId !== "string" || requestId === "") {
    return json({ error: "invalid request_id" }, 400);
  }
  const toolName = typeof body.tool_name === "string" ? body.tool_name : "";
  const description =
    typeof body.description === "string" ? body.description : "";
  const inputPreview =
    typeof body.input_preview === "string" ? body.input_preview : "";

  // Supersede: if a DIFFERENT request is already pending for this session, the
  // arrival of a new one proves the old resolved elsewhere (Claude serializes
  // tool prompts). Close the old card + wake its parked pull before storing the
  // new request. resolveElsewhere() tears down the prior watcher.
  const prior = pendingBySession.get(session);
  if (prior && prior.requestId !== requestId) {
    resolveElsewhere(session, prior.requestId);
  }

  pendingBySession.set(session, {
    requestId,
    toolName,
    description,
    inputPreview,
    expires: Date.now() + stashTtlMs(),
    watcher: null,
    expiryTimer: null,
  });

  broadcast(session, {
    type: "request",
    request_id: requestId,
    tool_name: toolName,
    description,
    input_preview: inputPreview,
  });

  // Primary lone-ghost fix: watch the transcript so a TUI/hook resolution closes
  // the card without waiting for the UI TTL. Re-read the entry to attach (it may
  // have just been swept by a concurrent TTL takePending — unlikely but safe).
  const entry = pendingBySession.get(session);
  if (entry && entry.requestId === requestId) {
    entry.watcher = watchTranscriptForProgress(session, requestId);
    // Proactive backstop: actively sweep this entry at its TTL so the watcher
    // can't leak on an orphan request that no verdict/supersede/progress ever
    // resolves. Guarded by reference equality so a superseding request that
    // already replaced this entry isn't clobbered. unref() so a pending timer
    // never keeps the daemon (or a test process) alive.
    const timer = setTimeout(() => {
      if (pendingBySession.get(session) === entry) {
        teardownWatcher(entry);
        pendingBySession.delete(session);
      }
    }, stashTtlMs());
    (timer as { unref?: () => void }).unref?.();
    entry.expiryTimer = timer;
  }

  return json({ ok: true });
}

// ---------- GET /api/permission-stream?session=<uuid>&token=<t> ----------
// UI subscribes. Emits "request" frames (replays a stashed pending request on
// subscribe) and "resolved" frames. Pings ~25s. Cleans up on cancel.

export function handlePermissionStream(req: Request): Response {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") || "";
  const token = url.searchParams.get("token") || "";
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (!UUID_RE.test(session)) return json({ error: "invalid session" }, 400);

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let self: ReadableStreamDefaultController | null = null;

  const cleanup = () => {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    const subs = streams.get(session);
    if (subs && self) {
      subs.delete(self);
      if (subs.size === 0) streams.delete(session);
    }
  };

  const stream = new ReadableStream({
    start(controller) {
      self = controller;
      let subs = streams.get(session);
      if (!subs) {
        subs = new Set();
        streams.set(session, subs);
      }
      subs.add(controller);

      controller.enqueue(": connected\n\n");

      // Replay a still-pending request to a tab that subscribed just after the
      // request fanned out (the request frame would otherwise be missed).
      const pending = takePending(session);
      if (pending) {
        controller.enqueue(
          `data: ${JSON.stringify({
            type: "request",
            request_id: pending.requestId,
            tool_name: pending.toolName,
            description: pending.description,
            input_preview: pending.inputPreview,
          })}\n\n`,
        );
      }

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(": ping\n\n");
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
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

// ---------- POST /api/permission-verdict ----------
// { session, token, request_id, behavior }

export async function handlePermissionVerdict(req: Request): Promise<Response> {
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
  const requestId = body?.request_id;
  if (typeof requestId !== "string" || requestId === "") {
    return json({ error: "invalid request_id" }, 400);
  }
  const behavior = body?.behavior;
  if (behavior !== "allow" && behavior !== "deny") {
    return json({ error: "invalid behavior" }, 400);
  }

  // Reject a verdict whose request_id doesn't match the session's pending
  // request — a late UI click on a superseded card must not resolve a newer one.
  const pending = takePending(session);
  if (!pending || pending.requestId !== requestId) {
    return json({ error: "stale request" }, 409);
  }

  // The request is being answered — tear down its transcript watcher and clear
  // it so a duplicate verdict is rejected and no watcher leaks.
  teardownWatcher(pending);
  pendingBySession.delete(session);

  // Deliver to a parked channel pull, else stash for the next pull (the channel
  // may still be re-parking its long-poll).
  const parked = pendingPulls.get(session);
  if (parked) {
    pendingPulls.delete(session);
    parked.resolve({ requestId, behavior });
  } else {
    verdictStash.set(session, {
      requestId,
      behavior,
      expires: Date.now() + stashTtlMs(),
    });
  }

  broadcast(session, {
    type: "resolved",
    request_id: requestId,
    source: "ui",
  });

  return json({ delivered: !!parked });
}

// ---------- GET /api/permission-pull?session=<uuid>&token=<t> ----------
// Channel long-polls for the verdict. Drains the stash first; else parks (one
// per session) under the wait budget; resolves with {request_id, behavior}, a
// re-pollable {verdict:null, timeout:true}, or {abandoned:true} (resolved
// elsewhere — supersede / transcript progress). Aborts on req.signal.

export function handlePermissionPull(
  req: Request,
): Response | Promise<Response> {
  const url = new URL(req.url);
  const session = url.searchParams.get("session") || "";
  const token = url.searchParams.get("token") || "";
  if (token !== daemonToken()) return json({ error: "unauthorized" }, 401);
  if (!UUID_RE.test(session)) return json({ error: "invalid session" }, 400);

  // A verdict may have arrived before this pull parked (the cold-start race) —
  // deliver it immediately instead of parking.
  const stashed = takeStashedVerdict(session);
  if (stashed !== null) {
    return json({ request_id: stashed.requestId, behavior: stashed.behavior });
  }

  // Replace any stale resolver for this session — only one park at a time.
  pendingPulls.get(session)?.resolve(null);

  return new Promise<Response>((resolve) => {
    let settled = false;
    const resolver = (v: PullResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingPulls.get(session)?.resolve === resolver)
        pendingPulls.delete(session);
      if (v === null) {
        resolve(json({ verdict: null, timeout: true })); // re-pollable sentinel
      } else if ("abandoned" in v) {
        resolve(json({ abandoned: true })); // resolved elsewhere — stop pulling
      } else {
        resolve(json({ request_id: v.requestId, behavior: v.behavior }));
      }
    };
    const timer = setTimeout(() => resolver(null), waitTimeoutMs());
    pendingPulls.set(session, { resolve: resolver });
    // Client hung up — drop the parked entry.
    req.signal?.addEventListener("abort", () => resolver(null));
  });
}

// ---------- POST /api/permission-resolved ----------
// { session, token, request_id }   (best-effort)
// The channel calls this IF it ever receives a cancel/resolved notification from
// Claude Code (undocumented — see protocol.md). Clears the pending request and
// broadcasts {type:"resolved", source:"elsewhere"}. Safe no-op if it's gone.

export async function handlePermissionResolved(
  req: Request,
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
  if (typeof session !== "string" || !UUID_RE.test(session)) {
    return json({ error: "invalid session" }, 400);
  }
  const requestId = body?.request_id;
  if (typeof requestId !== "string" || requestId === "") {
    return json({ error: "invalid request_id" }, 400);
  }

  // Only clear/broadcast if it matches the still-pending request; a no-op
  // otherwise (already resolved or superseded). resolveElsewhere() tears down the
  // watcher and wakes any parked pull with {abandoned:true}.
  return json({ resolved: resolveElsewhere(session, requestId) });
}
