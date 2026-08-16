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
// stash guidance here, and experimental.chat.system.transform injects it into
// the next request and consumes it, so each message reaches the model exactly
// once, the way Claude's additionalContext does.
//
// Lifecycle: a stash that no request ever consumes (a session that ends right
// after its last nudge, or a created-stash for a session the user never sends
// a message to) would otherwise accumulate one entry per session while the
// server lives. Guidance is time-sensitive, so the cap keeps the map bounded
// by evicting the least-recently-stashed entries — an unconsumed stash is
// garbage, never a delivery promise. TUI runs die with the server; the cap
// covers `serve`.
const PENDING_GUIDANCE = new Map<string, string[]>();
const GUIDANCE_CAP = 32;

/** Append a message to a session's pending guidance and enforce the cap.
 *  Map iteration order is insertion order, so the oldest key comes first —
 *  but `set` on an existing key keeps its original position, which would make
 *  a long-lived session the first one evicted. Delete before re-inserting so
 *  the freshest stash moves to the back and the eviction is genuinely LRU. */
function stashPending(
  pending: Map<string, string[]>,
  sessionID: string,
  message: string,
  cap = GUIDANCE_CAP,
): void {
  const messages = [...(pending.get(sessionID) ?? []), message];
  pending.delete(sessionID);
  pending.set(sessionID, messages);
  while (pending.size > cap) pending.delete(pending.keys().next().value!);
}

/** Take a session's pending guidance, if any, and clear it. */
function consumePending(
  pending: Map<string, string[]>,
  sessionID: string,
): string[] | null {
  const messages = pending.get(sessionID);
  if (!messages?.length) return null;
  pending.delete(sessionID);
  return messages;
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
        try {
          const sessionID = event.properties?.sessionID;

          if (event.type === "session.created") {
            const result = await run(
              ["bun", join(root, DECISION_LOG_START)],
              "{}",
            );
            const message = withOpenCodeNote(result?.stdout ?? null);
            if (message && sessionID) {
              stashPending(PENDING_GUIDANCE, sessionID, message);
            }
            if (result?.stderr) {
              await logFailure(client, result.stderr.trimEnd());
            }
          }

          if (event.type === "session.idle") {
            // scribe-nudge reads its session id and cwd from stdin and returns
            // immediately when that parse fails, so an empty stdin silently
            // disables the nudge entirely. The payload is the behavior.
            const result = await run(
              ["bun", join(root, SCRIBE_NUDGE)],
              JSON.stringify({ session_id: sessionID, cwd }),
            );
            // S15: OpenCode receives the Claude hook wrapper, not plain reminder text.
            const message = withOpenCodeNote(
              result ? sessionMessage(result.stdout) : null,
            );
            if (message && sessionID) {
              // Append to anything still pending (a created-guidance never
              // consumed, for instance) so both reach the model in order.
              stashPending(PENDING_GUIDANCE, sessionID, message);
            }
            if (result?.stderr) {
              await logFailure(client, result.stderr.trimEnd());
            }
          }
        } catch {
          // Session handlers log and never throw.
          await logFailure(client, "q-lab session hook failed");
        }
      },

      // S19: the model reads guidance from the system prompt. Consume-on-first-
      // request mirrors Claude's additionalContext, which also lands once. The
      // idle stash is spawned asynchronously, so a message sent immediately
      // after an idle turn may beat the stash and defer the nudge one turn.
      "experimental.chat.system.transform": async (
        input: { sessionID?: string },
        output: { system: string[] },
      ) => {
        const pending = input.sessionID
          ? consumePending(PENDING_GUIDANCE, input.sessionID)
          : null;
        if (!pending) return;
        output.system.push(...pending);
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
    consumePending,
    GUIDANCE_CAP,
    COMMIT_COMMAND,
    FLIGHTPLAN_TASK,
  },
);

export { QLabPlugin };
