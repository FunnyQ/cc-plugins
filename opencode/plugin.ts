import { dirname, join } from "node:path";

type HookKind = "command" | "file_path";
type HookResult = { exitCode: number; stdout: string; stderr: string };

const CHECK_BRANCH = "packages/chronicle/hooks/check-branch.sh";
const FLIGHTPLAN_LINT = "packages/dispatch/hooks/flightplan-lint.sh";
const DECISION_LOG_START =
  "packages/monitor/skills/cockpit/scripts/decision-log-start.ts";
const SCRIBE_NUDGE = "packages/monitor/skills/cockpit/scripts/scribe-nudge.ts";

// Each shell hook opens with a gate that discards almost every call it receives.
// Mirroring that gate here keeps the common tool call from paying a bash + jq
// spawn; the script stays the verdict authority for everything that passes.
const COMMIT_COMMAND = /git\s+commit/; // check-branch.sh:13
const FLIGHTPLAN_TASK =
  /(^|\/)docs\/.+\/tasks\/[a-z][a-z0-9]*\/[0-9]{2}-.+\.md$/; // flightplan-lint.sh:28

// S9/S10/S17: OpenCode has no Agent tool, no "fork" subagent, and a spawned
// subagent inherits no context. The cockpit scripts are shared with Claude Code
// and emit Claude's spawn wording, so the OpenCode reading is *appended* rather
// than substituted — an upstream reword can never silently defeat a note that
// only adds a sentence, the way a text substitution would.
const OPENCODE_SPAWN_NOTE =
  'OPENCODE: ignore any Agent(subagent_type: "fork") instruction above — that tool does not exist here. Spawn with the task tool as `general`, and pass the parent session id literally in the prompt, because an OpenCode subagent inherits no context.';

// S19: the session scripts write guidance Claude consumes as hook context, but
// OpenCode feeds the model from the system prompt, not from plugin output — a
// console write would be red TUI noise the model never reads. The event hooks
// seed this map synchronously, and experimental.chat.system.transform
// materializes the seeds and injects the result into the requests of the turn,
// so each message reaches the model the way Claude's additionalContext does.
//
// Seeds, not messages (S20): opencode dispatches the `event` hook
// fire-and-forget — `void hook["event"]?.(...)` is never awaited — but awaits
// the transform. An async stash (spawn the script, then set the entry) could
// lose the race to the first request, leaving the model with no guidance and
// no error. A seed lands synchronously the instant the event is dispatched,
// so the awaited transform always sees it; the transform runs the script
// itself, exactly when a request makes the guidance worth materializing.
//
// No consume-once (S21): the runtime triggers the transform for EVERY LLM
// request in the session, and the first one is the throwaway title generator
// (~2KB prompt; its output never surfaces). A consume-on-first-request design
// hands the guidance to that request and the real one never sees it. A seed
// therefore rides up to PUSH_CAP requests (the title request is harmless
// noise), and the session.idle handler retires the entry at the turn
// boundary — the guidance rides the first turn only, the per-turn nudge rides
// the next turn.
//
// Lifecycle: an entry that no request ever rides (a session that ends right
// after its last nudge, or a created-seed for a session the user never sends
// a message to) would otherwise accumulate one entry per session while the
// server lives. Guidance is time-sensitive, so the cap keeps the map bounded
// by evicting the least-recently-stashed entries — an entry no request ever
// rides is garbage, never a delivery promise. TUI runs die with the server;
// the cap covers `serve`.
type PendingGuidance = {
  /** Seeds until the first request materializes them, resolved strings after
   *  — the scripts run once per turn, never once per request. */
  items: string[];
  /** How many requests of this turn already received the push. */
  pushes: number;
};
const PENDING_GUIDANCE = new Map<string, PendingGuidance>();
const GUIDANCE_CAP = 32;
// Title + real request (+ a retry) must all ride before the push stops.
const PUSH_CAP = 3;

// Placeholders the transform materializes by running the matching script.
// \u0000 keeps them disjoint from any script output, which is plain text.
const CREATED_SEED = "\u0000created-guidance";
const IDLE_SEED = "\u0000idle-nudge";

/** Store a session's guidance entry and enforce the cap.
 *  Map iteration order is insertion order, so the oldest key comes first —
 *  but `set` on an existing key keeps its original position, which would make
 *  a long-lived session the first one evicted. Delete before re-inserting so
 *  the freshest stash moves to the back and the eviction is genuinely LRU. */
function stashPending(
  pending: Map<string, PendingGuidance>,
  sessionID: string,
  entry: PendingGuidance,
  cap = GUIDANCE_CAP,
): void {
  pending.delete(sessionID);
  pending.set(sessionID, entry);
  while (pending.size > cap) pending.delete(pending.keys().next().value!);
}

function hookPayload(kind: HookKind, value: string): string {
  return JSON.stringify({ tool_input: { [kind]: value } });
}

function guardVerdict(exitCode: number, stdout: string): string | null {
  if (exitCode !== 0 || !stdout) return null;

  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { permissionDecision?: unknown };
      systemMessage?: unknown;
    };

    return parsed.hookSpecificOutput?.permissionDecision === "ask" &&
      typeof parsed.systemMessage === "string"
      ? parsed.systemMessage
      : null;
  } catch {
    // Malformed or unexpected hook output means no verdict, never a crash.
    return null;
  }
}

function lintVerdict(exitCode: number, stderr: string): string | null {
  return exitCode === 2 && stderr ? stderr : null;
}

/** Spawn and collect. Every failure mode — a missing script after a partial
 *  checkout, a bad interpreter, a refused spawn — collapses to `null`, which
 *  every caller treats as "no verdict". The branch guard's thrown message is
 *  the module's only intentional failure path. */
async function run(
  command: string[],
  stdin: string,
): Promise<HookResult | null> {
  try {
    const child = Bun.spawn(command, {
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout.text(),
      child.stderr.text(),
    ]);

    return { exitCode, stdout, stderr };
  } catch {
    return null;
  }
}

function sessionMessage(stdout: string): string | null {
  if (!stdout) return null;

  try {
    const parsed = JSON.parse(stdout) as {
      hookSpecificOutput?: { additionalContext?: unknown };
      systemMessage?: unknown;
    };
    const message =
      parsed.hookSpecificOutput?.additionalContext ?? parsed.systemMessage;
    return typeof message === "string" ? message : null;
  } catch {
    return stdout;
  }
}

function withOpenCodeNote(message: string | null): string | null {
  const trimmed = message?.trimEnd();
  return trimmed ? `${trimmed}\n\n${OPENCODE_SPAWN_NOTE}` : null;
}

// client.app.log is the structured logging surface — plugin stderr would be
// rendered red in the TUI, so genuine failures go here instead of the console.
type PluginClient = {
  app: {
    log: (options: {
      body: {
        service: string;
        level: "debug" | "info" | "error" | "warn";
        message: string;
      };
    }) => Promise<unknown> | unknown;
  };
};

async function logFailure(client: PluginClient | undefined, message: string) {
  try {
    await client?.app.log({
      body: { service: "q-lab", level: "error", message },
    });
  } catch {
    // The log endpoint is best-effort; never let it break a hook.
  }
}

const QLabPlugin = Object.assign(
  async function QLabPlugin(context?: {
    directory?: string;
    worktree?: string;
    client?: PluginClient;
  }) {
    // S8: symlink-loaded modules expose the checkout's real directory here.
    const root = dirname(import.meta.dir);
    // S11: the plugin context carries the session's worktree and directory.
    const cwd = context?.worktree ?? context?.directory ?? process.cwd();
    const client = context?.client;

    return {
      // S1/S2: created is session-scoped and idle is turn-scoped.
      event: async ({
        event,
      }: {
        event: { type: string; properties?: { sessionID?: string } };
      }) => {
        const sessionID = event.properties?.sessionID;
        if (!sessionID) return;

        // S20: seed synchronously — never spawn here. The event dispatch is
        // fire-and-forget, so anything async could land after the first
        // request's transform has already read an empty stash. The transform
        // materializes the seed by running the script (it is awaited). Map
        // writes cannot throw, so this handler needs no failure path.
        if (event.type === "session.created") {
          stashPending(PENDING_GUIDANCE, sessionID, {
            items: [CREATED_SEED],
            pushes: 0,
          });
        }

        if (event.type === "session.idle") {
          // S21: turn boundary — anything the turn already rode retires, and
          // a fresh entry seeds the nudge for the next turn's requests.
          PENDING_GUIDANCE.delete(sessionID);
          stashPending(PENDING_GUIDANCE, sessionID, {
            items: [IDLE_SEED],
            pushes: 0,
          });
        }
      },

      // S19/S20/S21: the model reads guidance from the system prompt. The
      // transform is triggered for EVERY LLM request in the session — the
      // first is the throwaway title generator, so consume-once would hand
      // the guidance to a request whose output never surfaces. A seed rides
      // up to PUSH_CAP requests (the title request is harmless noise) and the
      // turn-ending idle retires it. agent.generate triggers without a
      // sessionID and no-ops here.
      "experimental.chat.system.transform": async (
        input: { sessionID?: string },
        output: { system: string[] },
      ) => {
        const pending = input.sessionID
          ? PENDING_GUIDANCE.get(input.sessionID)
          : undefined;
        if (!pending || pending.pushes >= PUSH_CAP) return;

        const messages: string[] = [];
        for (const item of pending.items) {
          if (item === CREATED_SEED) {
            const result = await run(
              ["bun", join(root, DECISION_LOG_START)],
              "{}",
            );
            if (result?.stderr) {
              await logFailure(client, result.stderr.trimEnd());
            }
            const message = withOpenCodeNote(result?.stdout ?? null);
            if (message) messages.push(message);
          } else if (item === IDLE_SEED) {
            // scribe-nudge reads its session id and cwd from stdin and returns
            // immediately when that parse fails, so an empty stdin silently
            // disables the nudge entirely. The payload is the behavior.
            const result = await run(
              ["bun", join(root, SCRIBE_NUDGE)],
              JSON.stringify({ session_id: input.sessionID, cwd }),
            );
            if (result?.stderr) {
              await logFailure(client, result.stderr.trimEnd());
            }
            // S15: OpenCode receives the Claude hook wrapper, not plain
            // reminder text.
            const message = withOpenCodeNote(
              result ? sessionMessage(result.stdout) : null,
            );
            if (message) messages.push(message);
          } else {
            // Already materialized by an earlier request of this turn.
            messages.push(item);
          }
        }
        // Materialize once, then replay. Re-running a script per push would
        // assume it is a pure function of its input; scribe-nudge is not —
        // it writes a marker and throttles for 8 minutes, so a re-run inside
        // the turn returns nothing and every request after the first would
        // push an empty message. Caching the resolved strings is also what
        // makes PUSH_CAP count requests instead of subprocess spawns.
        pending.items = messages;
        pending.pushes += 1;
        if (messages.length) output.system.push(...messages);
      },

      "tool.execute.before": async (
        input: { tool: string },
        output: { args: { command?: unknown } },
      ) => {
        // S5: tool arguments live on the second handler parameter.
        if (input.tool !== "bash" || typeof output.args.command !== "string")
          return;
        if (!COMMIT_COMMAND.test(output.args.command)) return;

        const result = await run(
          [join(root, CHECK_BRANCH)],
          hookPayload("command", output.args.command),
        );
        if (!result) return;

        const message = guardVerdict(result.exitCode, result.stdout);
        // S3: this throw blocks the command and surfaces the guard message verbatim.
        // The branch guard is the module's only intentional failure path.
        if (message) throw message;
      },

      "tool.execute.after": async (
        input: { tool: string; args: { filePath?: unknown } },
        output: { output: string },
      ) => {
        // S5a is before-hook-specific: after-hooks carry the arguments on the
        // FIRST parameter (`input.args`) and the tool result on the second —
        // reading output.args.filePath here throws and fails the write.
        if (
          (input.tool !== "write" && input.tool !== "edit") ||
          typeof input.args.filePath !== "string"
        ) {
          return;
        }
        if (!FLIGHTPLAN_TASK.test(input.args.filePath)) return;

        const result = await run(
          [join(root, FLIGHTPLAN_LINT)],
          hookPayload("file_path", input.args.filePath),
        );
        if (!result) return;

        const message = lintVerdict(result.exitCode, result.stderr);
        // S4: the write has landed, so append lint feedback without blocking it.
        if (message) output.output += message;
      },
    };
  },
  {
    guardVerdict,
    hookPayload,
    lintVerdict,
    withOpenCodeNote,
    stashPending,
    GUIDANCE_CAP,
    PUSH_CAP,
    COMMIT_COMMAND,
    FLIGHTPLAN_TASK,
  },
);

export { QLabPlugin };
