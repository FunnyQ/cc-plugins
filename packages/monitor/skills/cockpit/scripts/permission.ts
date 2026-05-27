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
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonResponse as json } from "./http";

const UUID_RE = /^[0-9a-f-]{36}$/;

type Behavior = "allow" | "deny";

type PendingRequest = {
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  expires: number;
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
// resolver first.
type ParkedPull = {
  resolve: (v: { requestId: string; behavior: Behavior } | null) => void;
};
const pendingPulls = new Map<string, ParkedPull>();

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

// ---------- pure helpers (unit-tested) ----------

// True iff the pending request (if any) is still within its TTL.
export function takePending(sessionId: string): PendingRequest | null {
  const e = pendingBySession.get(sessionId);
  if (!e) return null;
  if (e.expires <= Date.now()) {
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

  pendingBySession.set(session, {
    requestId,
    toolName,
    description,
    inputPreview,
    expires: Date.now() + stashTtlMs(),
  });

  broadcast(session, {
    type: "request",
    request_id: requestId,
    tool_name: toolName,
    description,
    input_preview: inputPreview,
  });

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

  // The request is being answered — clear it so a duplicate verdict is rejected.
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
// per session) under the wait budget; resolves with {request_id, behavior} or a
// re-pollable {verdict:null, timeout:true}. Aborts on req.signal.

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
    const resolver = (v: { requestId: string; behavior: Behavior } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pendingPulls.get(session)?.resolve === resolver)
        pendingPulls.delete(session);
      resolve(
        v === null
          ? json({ verdict: null, timeout: true }) // re-pollable sentinel
          : json({ request_id: v.requestId, behavior: v.behavior }),
      );
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
  // otherwise (already resolved or superseded).
  const pending = takePending(session);
  if (pending && pending.requestId === requestId) {
    pendingBySession.delete(session);
    broadcast(session, {
      type: "resolved",
      request_id: requestId,
      source: "elsewhere",
    });
    return json({ resolved: true });
  }
  return json({ resolved: false });
}
