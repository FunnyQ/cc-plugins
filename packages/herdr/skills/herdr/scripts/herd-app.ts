import {
  cleanLabel,
  createBroker,
  HerdrError,
  type AgentInfo,
  type AgentLocation,
  type HerdDeps,
  type SendResult,
  type SpawnOpts,
  type SpawnResult,
} from "./herd.ts";

export type AppRunner = (
  cmd: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;

export const appRunner: AppRunner = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

/** herdr-app runs each terminal's argv as given, so the first message has to
 *  ride the harness's own prompt argument: opencode reads a bare positional as
 *  its project directory, and Codex must run with `--no-daemon` or its
 *  commands execute outside hc (`hc --skill`). */
export function harnessArgv(
  agent: string,
  extra: string[] = [],
  task?: string,
): string[] {
  const base = agent === "codex" ? ["codex", "--no-daemon"] : [agent];
  const prompt =
    task === undefined
      ? []
      : agent === "opencode"
        ? ["--prompt", task]
        : [task];
  return [...base, ...extra, ...prompt];
}

function statusOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "state" in raw) {
    return String((raw as { state: unknown }).state);
  }
  return "unknown";
}

export function createHerdApp(
  run: AppRunner = appRunner,
  deps: HerdDeps & { selfPaneId?: string } = {},
) {
  async function call(cmd: string[]): Promise<any> {
    const result = await run(cmd);
    let parsed: any = null;
    try {
      parsed = JSON.parse(result.stdout.trim() || result.stderr.trim());
    } catch {}
    if (result.code !== 0 || parsed?.error) {
      const message =
        (typeof parsed?.error === "string"
          ? parsed.error
          : parsed?.error?.message) ||
        result.stderr.trim() ||
        `${cmd.join(" ")} exited ${result.code}`;
      throw new HerdrError(message, parsed?.error?.kind);
    }
    return parsed;
  }

  async function directory(): Promise<AgentLocation[]> {
    const listed = await call(["hc", "ls", "--json"]);
    return (listed.terminals ?? [])
      .filter((t: any) => t.state === "live" && typeof t.status === "string")
      .map((t: any): AgentLocation => {
        const [space, tab] = String(t.where ?? "").split(" / ", 2);
        return {
          name: t.name ?? null,
          type: t.agent ?? null,
          status: t.status,
          paneId: t.address,
          tabId: "",
          workspaceId: "",
          terminalId: t.address,
          cwd: t.cwd,
          focused: false,
          workspaceLabel: cleanLabel(space),
          tabLabel: cleanLabel(tab),
        };
      });
  }

  async function get(target: string): Promise<AgentInfo> {
    const t = await call(["hc", "get", "--json", target]);
    return {
      name: t.name ?? null,
      type: t.status?.app ?? null,
      status: statusOf(t.status),
      paneId: t.address,
      tabId: t.labels?.["herdr.tab"] ?? "",
      workspaceId: t.labels?.["herdr.space"] ?? "",
      terminalId: t.address,
      cwd: t.cwd,
      focused: false,
    };
  }

  async function spawn(opts: SpawnOpts): Promise<SpawnResult> {
    const name = opts.tabLabel ?? opts.role;
    const created = await call([
      "herdr-app",
      "do",
      "space.new",
      JSON.stringify({
        name,
        folder: opts.cwd,
        argv: harnessArgv(opts.agent, opts.argv, opts.task),
      }),
    ]);
    if (!created.terminal) {
      throw new HerdrError("space.new did not return a terminal");
    }
    return {
      name: created.terminal,
      type: opts.agent,
      status: "unknown",
      paneId: created.terminal,
      tabId: created.tab ?? "",
      workspaceId: created.space ?? "",
      terminalId: created.terminal,
      cwd: opts.cwd ?? "",
      focused: false,
      task: opts.task === undefined ? undefined : { sent: true },
    };
  }

  /** A harness reports no status until it is past its startup dialogs, and
   *  `hc send` presses Enter: on Claude's folder-trust dialog that answers
   *  "No, exit". */
  async function send(target: string, text: string): Promise<SendResult> {
    if ((await get(target)).status === "unknown") {
      throw new HerdrError(
        `${target} has not reported a status yet — it may be waiting on a startup dialog (folder trust, login). Read it with \`hc read ${target}\` and ask the person.`,
      );
    }
    await call(["hc", "send", "--json", "--", target, text]);
    return { target, paneId: target, submitted: true, waited: false };
  }

  async function wait(
    target: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const seconds = Math.ceil((opts.timeoutMs ?? 15_000) / 1000);
    return call(["hc", "wait", "--json", target, "--timeout", String(seconds)]);
  }

  /** Only ever reached for a space `ask` spawned itself, so closing the whole
   *  space takes nothing the person opened. */
  async function close(target: string): Promise<unknown> {
    const { workspaceId } = await get(target);
    if (!workspaceId) {
      return call(["hc", "kill", "--json", target]);
    }
    return call([
      "herdr-app",
      "do",
      "space.close",
      JSON.stringify({ id: workspaceId, confirmed: true }),
    ]);
  }

  return {
    directory,
    get,
    send,
    ...createBroker({ directory, get, spawn, send, wait, close }, deps),
  };
}
