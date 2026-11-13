import { dirname, join, resolve } from "node:path";

type HookKind = "command" | "file_path";
type HookResult = { exitCode: number; stdout: string; stderr: string };
type EditArgs = {
  path?: unknown;
  content?: unknown;
  oldString?: unknown;
  newString?: unknown;
};

// Declared locally: the plugin is loaded through a symlink whose parent has no
// node_modules, so a bare `@opencode/plugin` import would fail to resolve.
// Shapes are pinned from the npm @opencode/plugin@2.2.7 and
// @opencode/schema@2.2.7 declarations — the release that matches the installed
// binary, not the V1 @opencode-ai/plugin SDK beside the config.
type SubscriptionEvent = {
  type: string;
  data?: {
    sessionID?: string;
    location?: { directory?: string };
  };
};
type ContextEvent = {
  sessionID?: string;
  system: Array<{ type: "text"; text: string }>;
};
type ToolBeforeEvent = { tool: string; sessionID?: string; input: unknown };
type ToolAfterEvent = {
  tool: string;
  sessionID?: string;
  input: unknown;
  status: "completed" | "error";
  result?: { content?: string | ReadonlyArray<unknown>; output?: string };
};
type PluginContext = {
  location: { directory: string };
  event: {
    subscribe(options?: {
      signal?: AbortSignal;
    }): AsyncIterable<SubscriptionEvent>;
  };
  session: {
    hook(
      name: "context",
      callback: (event: ContextEvent) => void | Promise<void>,
    ): Promise<unknown>;
  };
  tool: {
    hook(
      name: "execute.before",
      callback: (event: ToolBeforeEvent) => void | Promise<void>,
    ): Promise<unknown>;
    hook(
      name: "execute.after",
      callback: (event: ToolAfterEvent) => void | Promise<void>,
    ): Promise<unknown>;
  };
};

const CHECK_BRANCH = "packages/chronicle/hooks/check-branch.sh";
const FLIGHTPLAN_LINT = "packages/dispatch/hooks/flightplan-lint.sh";
const COMMENT_GUARD = "packages/guard/hooks/comment-guard.ts";
const COCKPIT_SHIM = "packages/monitor/skills/cockpit/bin/cockpit";

// Each shell hook opens with a gate that discards almost every call it receives.
// Mirroring that gate here keeps the common tool call from paying a bash + jq
// spawn; the script stays the verdict authority for everything that passes.
const COMMIT_COMMAND = /git\s+commit/; // packages/chronicle/hooks/commit-command.ts
const FLIGHTPLAN_TASK =
  /(^|[/\\])docs[/\\].+[/\\]tasks[/\\][a-z][a-z0-9]*[/\\][0-9]{2}-.+\.md$/; // packages/dispatch/hooks/task-path.ts
// comment-core.ts BY_EXT and BY_NAME. Widening this alone only wastes a spawn;
// narrowing it past the hook silently stops guarding a language, so
// plugin.test.ts cross-checks both directions against syntaxFor.
const COMMENT_GUARDED =
  /(\.(rb|rake|gemspec|py|sh|bash|zsh|fish|yaml|yml|toml|ex|exs|pl|pm|r|env|ini|conf|properties|graphql|gql|tf|hcl|js|mjs|cjs|jsx|ts|mts|cts|tsx|jsonc|json5|go|rs|c|h|cpp|cc|cxx|hpp|hh|hxx|m|mm|cs|java|kt|kts|scala|swift|dart|zig|proto|css|scss|sass|less|styl|html|htm|xml|svg|vue|svelte|astro|erb|haml|slim|php|sql|lua|hs)|(^|[\\/])(rakefile|gemfile|guardfile|capfile|brewfile|procfile|makefile|dockerfile|justfile)(\.[^\\/]*)?)$/i;

// S9/S10/S17: OpenCode has no Agent tool, no "fork" subagent, and a spawned
// subagent inherits no context. The cockpit scripts are shared with Claude Code
// and emit Claude's spawn wording, so the OpenCode reading is *appended* rather
// than substituted — an upstream reword can never silently defeat a note that
// only adds a sentence, the way a text substitution would.
const OPENCODE_SPAWN_NOTE =
  'OPENCODE: ignore any instruction above to spawn a "fork" subagent, in whatever form it is written — neither the Agent tool nor a fork subagent exists here. Spawn with the subagent tool as `general`, and pass the parent session id literally in the prompt, because an OpenCode subagent inherits no context.';

// S19: the session scripts write guidance Claude consumes as hook context, but
// OpenCode feeds the model from the system prompt, not from plugin output — a
// console write would be red TUI noise the model never reads. The event
// subscription seeds this map synchronously, and the session context hook
// materializes the seeds and injects the result into the model requests of the
// turn, so each message reaches the model the way Claude's additionalContext
// does.
//
// Seeds, not messages (S20): the subscription consumes the event stream
// independently of model requests, so an async stash could lose the race to the
// first request, leaving the model with no guidance and no error. A seed lands
// synchronously the instant the event is dispatched; the awaited context hook
// runs the script itself, exactly when a request makes the guidance worth
// materializing.
//
// No consume-once (S21): the context hook triggers for every agent-loop request
// of the turn, and tool-driven continuations re-trigger it too. A
// consume-on-first-request design hands the guidance to one request only; a
// seed therefore rides up to PUSH_CAP requests, and the session.idle handler
// retires the entry at the turn boundary — the guidance rides the first turn
// only, the per-turn nudge rides the next turn. V2 gives the throwaway title
// request its own hook, so unlike the V1 transform the context hook no longer
// burns a push on it.
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
  cwd?: string;
};
const PENDING_GUIDANCE = new Map<string, PendingGuidance>();
const GUIDANCE_CAP = 32;
const PUSH_CAP = 3;

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

/** comment-guard reads Claude's hook shape — a tool name plus snake_case
 *  tool_input keys. OpenCode names the same arguments in camelCase, so the
 *  translation belongs here; the script stays Claude-shaped for both harnesses. */
function commentPayload(tool: string, args: EditArgs): string {
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  return JSON.stringify({
    tool_name: tool === "write" ? "Write" : "Edit",
    tool_input: {
      file_path: str(args.path),
      content: str(args.content),
      old_string: str(args.oldString),
      new_string: str(args.newString),
    },
  });
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
  cwd?: string,
): Promise<HookResult | null> {
  try {
    const child = Bun.spawn(command, {
      stdin: new Blob([stdin]),
      stdout: "pipe",
      stderr: "pipe",
      ...(cwd ? { cwd } : {}),
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
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

// V2 dropped client.app.log and swallows plugin stderr (2.2.7), so a failure
// written here reaches neither the model nor the server log; debug by writing
// to a file.
function logFailure(message: string): void {
  console.error(`[q-lab] ${message}`);
}

function patchWrites(
  patchText: string,
  cwd: string,
): Array<{ tool: string; args: EditArgs }> {
  const files: Array<{
    tool: string;
    path: string;
    removed: string[];
    added: string[];
  }> = [];
  let current: (typeof files)[number] | undefined;
  for (const line of patchText.split(/\r?\n/)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      current =
        header[1] === "Delete"
          ? undefined
          : {
              tool: header[1] === "Add" ? "write" : "edit",
              path: resolve(cwd, header[2].trim()),
              removed: [],
              added: [],
            };
      if (current) files.push(current);
    } else if (current && line.startsWith("*** Move to: ")) {
      current.path = resolve(cwd, line.slice("*** Move to: ".length).trim());
    } else if (current && line.startsWith("+")) {
      current.added.push(line.slice(1));
    } else if (current && line.startsWith("-")) {
      current.removed.push(line.slice(1));
    }
  }
  return files.map(({ tool, path, removed, added }) => ({
    tool,
    args:
      tool === "write"
        ? { path, content: added.join("\n") }
        : { path, oldString: removed.join("\n"), newString: added.join("\n") },
  }));
}

function seedFromEvent(event: SubscriptionEvent): void {
  const sessionID = event.data?.sessionID;
  if (!sessionID) return;

  if (event.type === "session.created") {
    stashPending(PENDING_GUIDANCE, sessionID, {
      items: [CREATED_SEED],
      pushes: 0,
      cwd: event.data?.location?.directory,
    });
  }

  // V2 verified on 2.2.7: a CLI turn ends with execution.succeeded, not
  // session.idle; handling both is idempotent.
  const nudged =
    event.type === "session.idle" ||
    event.type === "session.execution.succeeded";
  if (
    nudged ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  ) {
    const cwd = PENDING_GUIDANCE.get(sessionID)?.cwd;
    PENDING_GUIDANCE.delete(sessionID);
    stashPending(PENDING_GUIDANCE, sessionID, {
      items: nudged ? [IDLE_SEED] : [],
      pushes: 0,
      cwd,
    });
  }
}

const definition = {
  id: "q-lab",
  // Hook registrations are disposed with the plugin; the subscription is the
  // only resource this returns cleanup for.
  async setup(ctx: PluginContext): Promise<() => void> {
    // S8: symlink-loaded modules expose the checkout's real directory here.
    const root = dirname(import.meta.dir);
    // V2: ctx.location is the plugin instance's directory, not every session's.
    const cwd = ctx.location.directory;

    const contextHook = async (event: ContextEvent) => {
      const pending = event.sessionID
        ? PENDING_GUIDANCE.get(event.sessionID)
        : undefined;
      if (!pending || pending.pushes >= PUSH_CAP) return;
      const payloadCwd = pending.cwd ?? cwd;

      const messages: string[] = [];
      for (const item of pending.items) {
        if (item === CREATED_SEED) {
          // The payload names the session the guidance tells the model to
          // scribe against. `provider` marks it as ours: a directory lookup
          // would pick whichever OpenCode session touched this worktree last.
          const result = await run(
            [join(root, COCKPIT_SHIM), "hook", "session-start"],
            JSON.stringify({
              session_id: event.sessionID,
              cwd: payloadCwd,
              provider: "opencode",
            }),
          );
          if (result?.stderr) logFailure(result.stderr.trimEnd());
          const message = withOpenCodeNote(result?.stdout ?? null);
          if (message) messages.push(message);
        } else if (item === IDLE_SEED) {
          // scribe-nudge reads its session id and cwd from stdin and returns
          // immediately when that parse fails, so an empty stdin silently
          // disables the nudge entirely. The payload is the behavior.
          const result = await run(
            [join(root, COCKPIT_SHIM), "hook", "stop"],
            JSON.stringify({
              session_id: event.sessionID,
              cwd: payloadCwd,
              provider: "opencode",
            }),
          );
          if (result?.stderr) logFailure(result.stderr.trimEnd());
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
      if (messages.length) {
        event.system.push(
          ...messages.map((text) => ({ type: "text" as const, text })),
        );
      }
    };

    const toolBefore = async (event: ToolBeforeEvent) => {
      // V2 renamed the bash tool to `shell`; both spellings stay gated so a
      // rename in either direction cannot silently drop the branch guard.
      const command = (event.input as { command?: unknown } | undefined)
        ?.command;
      if (
        (event.tool !== "shell" && event.tool !== "bash") ||
        typeof command !== "string"
      )
        return;
      if (!COMMIT_COMMAND.test(command)) return;

      const result = await run(
        ["bash", join(root, CHECK_BRANCH)],
        hookPayload("command", command),
        event.sessionID
          ? (PENDING_GUIDANCE.get(event.sessionID)?.cwd ?? cwd)
          : cwd,
      );
      if (!result) return;

      const message = guardVerdict(result.exitCode, result.stdout);
      // S3: this throw blocks the command and surfaces the guard message verbatim.
      // The branch guard is the module's only intentional failure path.
      if (message) throw message;
    };

    const toolAfter = async (event: ToolAfterEvent) => {
      const sessionCwd = event.sessionID
        ? (PENDING_GUIDANCE.get(event.sessionID)?.cwd ?? cwd)
        : cwd;
      const writes: Array<{ tool: string; args: EditArgs }> = [];
      if (event.tool === "write" || event.tool === "edit") {
        writes.push({ tool: event.tool, args: event.input as EditArgs });
      } else if (event.tool === "patch") {
        const patchText = (event.input as { patchText?: unknown } | undefined)
          ?.patchText;
        if (typeof patchText === "string")
          writes.push(...patchWrites(patchText, sessionCwd));
      }

      let feedback = "";
      for (const { tool, args } of writes) {
        // V2 renamed the edit/write file argument from `filePath` to `path`.
        if (typeof args.path !== "string") continue;
        const filePath = args.path;

        // Two independent hooks share this event and their gates do not overlap,
        // so neither may return early on the other's behalf.
        if (FLIGHTPLAN_TASK.test(filePath)) {
          const result = await run(
            ["bash", join(root, FLIGHTPLAN_LINT)],
            hookPayload("file_path", filePath),
            sessionCwd,
          );
          const message = result && lintVerdict(result.exitCode, result.stderr);
          // S4: the write has landed, so append lint feedback without blocking it.
          if (message) feedback += message;
        }

        if (COMMENT_GUARDED.test(filePath)) {
          const result = await run(
            ["bun", join(root, COMMENT_GUARD)],
            commentPayload(tool, args),
            sessionCwd,
          );
          const message = result && lintVerdict(result.exitCode, result.stderr);
          if (message) feedback += message;
        }
      }

      // The runtime reads result.content back after this hook, so the feedback
      // rides the result the model receives. An errored tool changed no file.
      if (!feedback || event.status !== "completed" || !event.result) return;
      // The runtime shows `output` only while `content` is empty, so content
      // written here must carry the output with it.
      const { content, output } = event.result;
      event.result.content =
        typeof content === "string" && content
          ? content + feedback
          : Array.isArray(content) && content.length
            ? [...content, { type: "text" as const, text: feedback }]
            : [{ type: "text" as const, text: `${output ?? ""}${feedback}` }];
    };

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          seedFromEvent(event);
        }
      } catch (error) {
        if (!controller.signal.aborted)
          logFailure(`event subscription ended: ${String(error)}`);
      }
    })();

    await ctx.session.hook("context", contextHook);
    await ctx.tool.hook("execute.before", toolBefore);
    await ctx.tool.hook("execute.after", toolAfter);

    return () => controller.abort();
  },
};

const QLabPlugin = Object.assign(definition, {
  seedFromEvent,
  guardVerdict,
  hookPayload,
  commentPayload,
  lintVerdict,
  withOpenCodeNote,
  stashPending,
  GUIDANCE_CAP,
  PENDING_GUIDANCE,
  PUSH_CAP,
  COMMIT_COMMAND,
  FLIGHTPLAN_TASK,
  COMMENT_GUARDED,
});

export { QLabPlugin };
export default QLabPlugin;
