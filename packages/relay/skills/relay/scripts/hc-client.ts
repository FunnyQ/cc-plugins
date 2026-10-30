import { basename } from "path";
import type { CallerLocation, HerdAgent, HerdClient } from "./live";

export type HcRunner = (cmd: string[]) => Promise<string>;

const hcRunner: HcRunner = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    let message = stderr.trim() || `${cmd.join(" ")} exited ${code}`;
    try {
      message = JSON.parse(stderr).error?.message ?? message;
    } catch {}
    throw new Error(message);
  }
  return stdout;
};

function randomSuffix(): string {
  return crypto.randomUUID().slice(0, 4);
}

function statusOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "state" in raw) {
    return String((raw as { state: unknown }).state);
  }
  return "unknown";
}

/** relay's live pane under herdr-app, talking to herdr-core's `hc` directly so
 *  it needs no herd.ts from a herdr plugin release that predates herdr-app. */
export function createHcClient(
  env: Record<string, string | undefined>,
  run: HcRunner = hcRunner,
  suffix: () => string = randomSuffix,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): HerdClient & { callerLocation(): Promise<CallerLocation | null> } {
  const json = async (cmd: string[]) => JSON.parse(await run(cmd));

  async function get(target: string): Promise<{ status: string }> {
    const t = await json(["hc", "get", "--json", target]);
    return { status: statusOf(t.status) };
  }

  return {
    async callerLocation() {
      const self = env.HC_TERMINAL_ID;
      if (!self) return null;
      const labels = (await json(["hc", "get", "--json", self])).labels ?? {};
      const workspaceId = labels["herdr.space"];
      if (!workspaceId) return null;
      return {
        workspaceId,
        tabId: labels["herdr.tab"] ?? "",
        paneId: self,
        source: "env",
      };
    },

    // `--no-notify`: hc otherwise types `<hc from=…>` notes about the pane into
    // the caller, which is blocked in this very relay call. `--rm` drops the
    // terminal when the agent exits, and herdr-app closes its tab with it.
    async spawn(opts) {
      const name = `${opts.role}-${suffix()}`;
      const cmd = ["hc", "run", "--bg", "--json", "--no-notify", "--rm"];
      cmd.push("--name", name);
      if (opts.cwd) cmd.push("--cwd", opts.cwd);
      if (opts.workspace) cmd.push("--label", `herdr.space=${opts.workspace}`);
      if (opts.env?.length) cmd.push("env", ...opts.env);
      cmd.push(opts.agent);
      // hc's manual: Codex without --no-daemon runs its commands outside hc.
      if (basename(opts.agent) === "codex") cmd.push("--no-daemon");
      cmd.push(...(opts.argv ?? []));
      const { address } = await json(cmd);

      // herdr-app shows the terminal ~0.4s after hc starts it (measured).
      for (let attempt = 0; attempt < 20; attempt++) {
        const layout = await json(["herdr-app", "ls"]).catch(() => null);
        const tab = (layout?.spaces ?? [])
          .flatMap((space: any) => space.tabs ?? [])
          .find((tab: any) =>
            (tab.terminals ?? []).some((t: any) => t.terminal === address),
          );
        if (tab) {
          await run([
            "herdr-app",
            "do",
            "tab.rename",
            JSON.stringify({ id: tab.id, name }),
          ]).catch(() => {});
          break;
        }
        await sleep(150);
      }
      return { name };
    },

    // A harness reports no status until it is past its startup dialogs, and
    // `hc send` presses Enter, which would answer one of them.
    async send(target, text) {
      if ((await get(target)).status === "unknown") {
        throw new Error(
          `${target} has not reported a status yet — it may be on a startup dialog (folder trust, login); read it with \`hc read ${target}\``,
        );
      }
      return json(["hc", "send", "--json", "--", target, text]);
    },

    keys: (target, ...keys) => run(["hc", "keys", target, ...keys]),

    wait: (target, opts = {}) =>
      json([
        "hc",
        "wait",
        "--json",
        target,
        "--timeout",
        String(Math.ceil((opts.timeoutMs ?? 15_000) / 1000)),
      ]),

    get,

    read: (target) => run(["hc", "read", "--lines", "60", target]),

    async list(): Promise<HerdAgent[]> {
      const listed = await json(["hc", "ls", "--json"]);
      return (listed.terminals ?? []).map((t: any) => ({
        name: t.name ?? null,
        type: t.agent ?? null,
        status: statusOf(t.status),
        paneId: t.address,
        cwd: t.cwd,
      }));
    },

    // A --rm terminal is removed as soon as it dies, so hc kill answers
    // "was removed" for a kill that worked.
    close: (target) =>
      json(["hc", "kill", "--json", target]).catch((error: Error) => {
        if (!/was removed/.test(error.message)) throw error;
        return { killed: target };
      }),
  };
}
