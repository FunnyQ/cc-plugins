import { dirname, join } from "node:path";

type HookKind = "command" | "file_path";
type HookResult = { exitCode: number; stdout: string; stderr: string };

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

async function runHook(
  root: string,
  relScript: string,
  payload: string,
): Promise<HookResult | null> {
  const script = join(root, relScript);

  // A missing script is a silent no-op so a partial checkout cannot break tools.
  if (!(await Bun.file(script).exists())) return null;

  try {
    const process = Bun.spawn([script], {
      stdin: new Blob([payload]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      process.stdout.text(),
      process.stderr.text(),
    ]);

    return { exitCode, stdout, stderr };
  } catch {
    // Spawn failures fail open; the branch-guard verdict is the only intentional failure.
    return null;
  }
}

async function runScript(
  root: string,
  relScript: string,
  args: string[],
): Promise<HookResult | null> {
  const script = join(root, relScript);

  // A missing session script is a silent no-op.
  if (!(await Bun.file(script).exists())) return null;

  try {
    const process = Bun.spawn(["bun", script, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      process.stdout.text(),
      process.stderr.text(),
    ]);

    return { exitCode, stdout, stderr };
  } catch {
    // Session hooks only report; a broken decision log must never kill a session.
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

const QLabPlugin = Object.assign(
  async function QLabPlugin() {
    // S8: symlink-loaded modules expose the checkout's real directory here.
    const root = dirname(import.meta.dir);

    return {
      // S1/S2: created is session-scoped and idle is turn-scoped.
      event: async ({ event }: { event: { type: string } }) => {
        try {
          if (event.type === "session.created") {
            const result = await runScript(
              root,
              "packages/monitor/skills/cockpit/scripts/decision-log-start.ts",
              [],
            );
            if (result?.stdout) console.error(result.stdout.trimEnd());
            if (result?.stderr) console.error(result.stderr.trimEnd());
          }

          if (event.type === "session.idle") {
            const result = await runScript(
              root,
              "packages/monitor/skills/cockpit/scripts/scribe-nudge.ts",
              [],
            );
            // S15: OpenCode receives the Claude hook wrapper, not plain reminder text.
            const message = result && sessionMessage(result.stdout);
            if (message) console.error(message.trimEnd());
            if (result?.stderr) console.error(result.stderr.trimEnd());
          }
        } catch {
          // Session handlers log to stderr and never throw.
          console.error("q-lab session hook failed");
        }
      },

      "tool.execute.before": async (
        input: { tool: string },
        output: { args: { command?: unknown } },
      ) => {
        // S5: tool arguments live on the second handler parameter.
        if (input.tool !== "bash" || typeof output.args.command !== "string") return;

        const result = await runHook(
          root,
          "packages/chronicle/hooks/check-branch.sh",
          hookPayload("command", output.args.command),
        );
        if (!result) return;

        const message = guardVerdict(result.exitCode, result.stdout);
        // S3: this throw blocks the command and surfaces the guard message verbatim.
        // The branch guard is the module's only intentional failure path.
        if (message) throw message;
      },

      "tool.execute.after": async (
        input: { tool: string },
        output: { args: { filePath?: unknown }; output: string },
      ) => {
        // S5: tool arguments live on the second handler parameter.
        if (
          (input.tool !== "write" && input.tool !== "edit") ||
          typeof output.args.filePath !== "string"
        ) {
          return;
        }

        const result = await runHook(
          root,
          "packages/dispatch/hooks/flightplan-lint.sh",
          hookPayload("file_path", output.args.filePath),
        );
        if (!result) return;

        const message = lintVerdict(result.exitCode, result.stderr);
        // S4: the write has landed, so append lint feedback without blocking it.
        if (message) output.output += message;
      },
    };
  },
  { guardVerdict, hookPayload, lintVerdict },
);

export { QLabPlugin };
