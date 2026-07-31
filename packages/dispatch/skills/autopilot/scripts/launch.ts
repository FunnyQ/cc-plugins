import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { decideStartup } from "./daemon-decision";
import { readRecord, removeRecord } from "./daemon-record";

const DEFAULT_PORT = 5757;
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 500;

export type Args = { plan: string; port: number; open: boolean };

export function parseArgs(
  argv: string[],
): { ok: true; args: Args } | { ok: false; message: string } {
  let plan: string | undefined;
  let port = DEFAULT_PORT;
  let open = true;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--plan") {
      plan = argv[index + 1];
      index += 1;
    } else if (argument === "--port") {
      port = Number(argv[index + 1]);
      index += 1;
    } else if (argument === "--no-open") {
      open = false;
    }
  }

  if (plan === undefined || !isAbsolute(plan)) {
    return { ok: false, message: "--plan must be an absolute path" };
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: "--port must be an integer from 1 to 65535" };
  }

  return { ok: true, args: { plan, port, open } };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function validatePlanDir(
  planDir: string,
): { ok: true } | { ok: false; message: string } {
  if (!isDirectory(planDir)) {
    return {
      ok: false,
      message: existsSync(planDir)
        ? "--plan must be a directory"
        : "--plan directory does not exist",
    };
  }

  if (!isDirectory(join(planDir, "tasks"))) {
    return { ok: false, message: "--plan must contain a tasks/ directory" };
  }

  return { ok: true };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which flightdeck daemon answers this port, or null when none does.
 *
 * "Something answered HTTP" is not proof of a flightdeck: another service may
 * hold the port, and the operating system recycles pids. The daemon states its
 * own pid and plan here, so reuse opens our page and never a stranger's, and a
 * SIGTERM only ever reaches a process that identified itself as ours.
 */
export async function identifyDaemon(
  port: number,
): Promise<{ pid: number; plan: string } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    if (!response.ok) return null;

    const body = (await response.json()) as Record<string, unknown>;
    if (
      body?.flightdeck !== true ||
      !Number.isInteger(body.pid) ||
      typeof body.plan !== "string"
    ) {
      return null;
    }

    return { pid: body.pid as number, plan: body.plan };
  } catch {
    return null;
  }
}

async function poll(check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (await check()) return true;

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  return false;
}

function openBrowser(url: string): void {
  try {
    const command =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url];
    Bun.spawn(command, {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    }).unref();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`flightdeck notice: browser opener unavailable: ${message}`);
  }
}

export async function main(): Promise<void> {
  const parsed = parseArgs(Bun.argv.slice(2));

  if (!parsed.ok) {
    console.error(`flightdeck error: ${parsed.message}`);
    process.exitCode = 2;
    return;
  }

  const validation = validatePlanDir(parsed.args.plan);

  if (!validation.ok) {
    console.error(`flightdeck error: ${validation.message}`);
    process.exitCode = 2;
    return;
  }

  const { plan, port, open } = parsed.args;
  const decision = decideStartup(
    readRecord(),
    { root: import.meta.dir, plan, port },
    isProcessAlive,
  );

  if (decision.action === "supersede") {
    // Signal only a daemon that identified itself as the one in the record. An
    // unidentified port is left alone: the bind below then fails loudly instead
    // of this launcher killing a process that merely inherited a recycled pid.
    const running = await identifyDaemon(decision.info.port);

    if (running?.pid === decision.info.pid) {
      try {
        process.kill(decision.info.pid, "SIGTERM");
      } catch {
        // The server may exit between the liveness check and the signal.
      }

      if (!(await poll(async () => (await identifyDaemon(port)) === null))) {
        console.error(
          `flightdeck error: port ${decision.info.port} did not close`,
        );
        process.exitCode = 1;
        return;
      }
    } else {
      removeRecord();
    }
  }

  // A live pid is not a live daemon: the operating system recycles pids, and a
  // hung server still holds one. Reuse only a record whose port answers as that
  // very daemon, or the launcher prints a URL that opens something else.
  const reusable =
    decision.action === "reuse" &&
    (await identifyDaemon(port))?.pid === decision.info.pid;

  if (decision.action === "reuse" && !reusable) {
    removeRecord();
  }

  if (!reusable) {
    const scriptPath = join(import.meta.dir, "flightdeck.ts");
    const child = Bun.spawn(
      ["bun", scriptPath, "--serve", "--plan", plan, "--port", String(port)],
      { detached: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    child.unref();

    const started = await poll(async () => {
      const record = readRecord();
      return (
        record?.pid === child.pid &&
        record.port === port &&
        (await identifyDaemon(port))?.pid === child.pid
      );
    });

    if (!started) {
      console.error(
        `flightdeck error: server failed to answer on port ${port}`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const url = `http://localhost:${port}/`;
  console.log(url);

  if (open) {
    openBrowser(url);
  }
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error("flightdeck error:", error.message);
    process.exit(1);
  });
}
