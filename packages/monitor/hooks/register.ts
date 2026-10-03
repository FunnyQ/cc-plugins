import type { EngineInterface, Register } from "claude-code";

type Coords = { port: number; token: string };
type Verdict = "allow" | "deny";
type PendingCall = {
  tool: string;
  args: Record<string, unknown>;
  isOpen: boolean;
  open: () => void;
};

// A PermissionRequest carries no tool_use_id, so the dialog finds its call here by tool and input.
const calls = new Map<string, PendingCall>();
// Calls the dashboard approved: their second pass through tool.check must not ask again.
const granted = new Set<string>();
// The promise, not its value, so concurrent callers share one `ensure-daemon` spawn.
let coords: Promise<Coords | undefined> | undefined;
// The loop a session switch retires may still sit in a fetch parked on the old session id.
let generation = 0;

// `$.http.fetch` aborts at 30s, so a throw this late is the daemon's long-poll outliving it, not a failure.
const FETCH_ABORT_MS = 29_000;
const MAX_BACKOFF_MS = 30_000;
const PREVIEW_CHARS = 2_000;
const ID_SWITCH_POLL_MS = 100;
const ID_SWITCH_TRIES = 50;

function daemon($: EngineInterface): Promise<Coords | undefined> {
  if (coords) return coords;
  const pending = $.process
    .run([`${$.plugin.root}/skills/cockpit/bin/cockpit`, "ensure-daemon"])
    .then((run) =>
      run.exitCode === 0 ? (JSON.parse(run.stdout) as Coords) : undefined,
    );
  coords = pending;
  const forget = () => {
    if (coords === pending) coords = undefined;
  };
  pending.then((c) => c || forget(), forget);
  return pending;
}

function sleep($: EngineInterface, ms: number): Promise<void> {
  return new Promise((resolve) => $.clock.after(ms, resolve));
}

async function request(
  $: EngineInterface,
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown> | "parked" | undefined> {
  const c = await daemon($);
  if (!c) return undefined;
  const started = Date.now();
  try {
    const res = await $.http.fetch(
      // Every GET caller already carries a `?session=` query.
      body
        ? `http://127.0.0.1:${c.port}${path}`
        : `http://127.0.0.1:${c.port}${path}&token=${c.token}`,
      body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...body, token: c.token }),
          }
        : undefined,
    );
    if (res.ok) return JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    if (Date.now() - started >= FETCH_ABORT_MS) return "parked";
  }
  // A restarted daemon rotates its port and token, so the next call re-reads them.
  coords = undefined;
  return undefined;
}

async function pollInbox($: EngineInterface, mine: number, endedId?: string) {
  // The engine switches the id after session.end resolves; a poll parked on the ended id would hold the new session off for 30s.
  for (let i = 0; i < ID_SWITCH_TRIES && (await $.session.id()) === endedId; i++) {
    await sleep($, ID_SWITCH_POLL_MS);
  }
  let failures = 0;
  while (generation === mine) {
    const session = await $.session.id();
    const body = await request($, `/api/inbox?session=${session}`);
    if (body) {
      failures = 0;
      // Not awaited: the prompt waits for the session to go idle, and the daemon holds only one undelivered message.
      // asUser, because the person typed it in the dashboard; framed, the model reads it as the plugin speaking.
      if (body !== "parked" && typeof body.message === "string")
        void $.prompt.submit({ text: body.message, asUser: true });
      continue;
    }
    const delay = Math.min(1000 * 2 ** failures++, MAX_BACKOFF_MS);
    await sleep($, delay);
  }
}

async function relay(
  $: EngineInterface,
  id: string,
  tool: string,
  args: Record<string, unknown>,
  isSettled: () => boolean,
): Promise<Verdict | undefined> {
  const session = await $.session.id();
  const sent = await request($, "/api/permission-request", {
    session,
    request_id: id,
    tool_name: tool,
    description: typeof args.description === "string" ? args.description : "",
    input_preview: (typeof args.command === "string"
      ? args.command
      : JSON.stringify(args)
    ).slice(0, PREVIEW_CHARS),
  });
  if (!sent) return undefined;
  while (!isSettled()) {
    const body = await request($, `/api/permission-pull?session=${session}`);
    if (body === "parked" || body?.timeout === true) continue;
    if (!body || body.abandoned === true) return undefined;
    if (
      body.request_id === id &&
      (body.behavior === "allow" || body.behavior === "deny")
    )
      return body.behavior;
  }
  return undefined;
}

async function resolved($: EngineInterface, id: string) {
  await request($, "/api/permission-resolved", {
    session: await $.session.id(),
    request_id: id,
  });
}

export const register: Register = (on) => {
  // Feeds the usage dashboard's rate-limit cache and rollup nudge without wrapping the person's statusline.
  on("session.measure", async ($, e, next) => {
    const result = await next(e);
    // `cockpit atlas measure` reads the statusline's stdin shape, so both writers share one cache format.
    const payload: {
      rate_limits?: Record<
        string,
        { used_percentage: number; resets_at?: number }
      >;
    } = {};
    if (e.rateLimits.length > 0) {
      payload.rate_limits = Object.fromEntries(
        e.rateLimits.map((w) => [
          w.kind,
          {
            used_percentage: w.percentUsed,
            resets_at:
              w.resetsAt === undefined
                ? undefined
                : Date.parse(w.resetsAt) / 1000,
          },
        ]),
      );
    }
    await $.process.run(
      [`${$.plugin.root}/skills/cockpit/bin/cockpit`, "atlas", "measure"],
      {
        stdin: JSON.stringify(payload),
      },
    );
    return result;
  });

  // Delivers dashboard messages as prompts; the loop outlives this hook and dies with a reload.
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    void pollInbox($, ++generation);
    return result;
  });

  // `/clear` and `/resume` end the session but not the process, and no session.start follows them.
  on("session.end", async ($, e, next) => {
    const result = await next(e);
    generation++;
    if (e.reason === "clear" || e.reason === "resume") void pollInbox($, generation, e.sessionId);
    return result;
  });

  on("classic.PermissionRequest", async ($, e, next) => {
    const result = await next(e);
    // Only a request no hook beneath answered becomes the terminal dialog the dashboard races.
    if (!result.decision) {
      const input = JSON.stringify(e.tool_input);
      const waiting = [...calls.values()].filter(
        (c) => c.tool === e.tool_name && !c.isOpen,
      );
      (
        waiting.find((c) => JSON.stringify(c.args) === input) ??
        (waiting.length === 1 ? waiting[0] : undefined)
      )?.open();
    }
    return result;
  });

  on("tool.check", async ($, e, next) => {
    const verdict = await next(e);
    // Lifts only the ask: a deny beneath still stands on the approved call's second pass.
    if (
      e.tool_use_id &&
      granted.has(e.tool_use_id) &&
      verdict.decision === "ask"
    ) {
      return {
        decision: "allow",
        reason: "Approved from the cockpit dashboard",
      };
    }
    return verdict;
  });

  on("tool.call", async ($, e, next) => {
    const id = e.tool_use_id;
    if (!id) return next(e);
    const {
      tool,
      tool_use_id: _id,
      agentId: _agent,
      consent: _consent,
      ...args
    } = e as typeof e & {
      consent?: string;
    };
    let open = () => {};
    const opened = new Promise<void>((resolve) => (open = resolve));
    const call: PendingCall = {
      tool,
      args,
      isOpen: false,
      open: () => {
        call.isOpen = true;
        open();
      },
    };
    calls.set(id, call);
    let isSettled = false;
    try {
      type Outcome =
        | { result: Awaited<ReturnType<typeof next>> }
        | { verdict: Verdict };
      const engine: Promise<Outcome> = next(e).then((result) => ({ result }));
      const dashboard: Promise<Outcome> = opened.then(async () => {
        const verdict = await relay($, id, tool, args, () => isSettled);
        return verdict ? { verdict } : engine;
      });
      const first = await Promise.race([engine, dashboard]);
      isSettled = true;
      if ("result" in first) {
        if (call.isOpen) await resolved($, id);
        return first.result;
      }
      if (first.verdict === "deny")
        return { deny: "Denied from the cockpit dashboard." };
      // The engine's own dialog is still pending; a second pass aborts it and runs the tool past tool.check.
      granted.add(id);
      try {
        return await next(e);
      } finally {
        granted.delete(id);
      }
    } finally {
      calls.delete(id);
    }
  });
};
