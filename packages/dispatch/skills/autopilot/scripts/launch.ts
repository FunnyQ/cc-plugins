import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { detectSource } from "./graph-source";
import { decideStartup, type StartupDecision } from "./daemon-decision";
import { type DaemonInfo, readRecord, removeRecord } from "./daemon-record";

const DEFAULT_PORT = 5757;
const POLL_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 500;

export type Args = { plan: string; port: number; open: boolean };

// the dispatch mod reads this line back, because a launch's --plan is often a shell variable the command text never expands
export const planLine = (plan: string) => `flightdeck plan: ${plan}`;

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): { ok: true; args: Args } | { ok: false; message: string } {
  let plan: string | undefined;
  let port = DEFAULT_PORT;
  let open = env.CLAUDECODE !== "1";

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
    } else if (argument === "--open") {
      open = true;
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

  if (detectSource(planDir) === "none") {
    return {
      ok: false,
      message: "--plan must contain a tasks/ directory or a graph.json file",
    };
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

export async function supersede(info: DaemonInfo): Promise<boolean> {
  const running = await identifyDaemon(info.port);

  if (running?.pid === info.pid) {
    try {
      process.kill(info.pid, "SIGTERM");
    } catch {
      // The server may exit between the liveness check and the signal.
    }

    if (!(await poll(async () => (await identifyDaemon(info.port)) === null))) {
      console.error(`flightdeck error: port ${info.port} did not close`);
      return false;
    }
  } else {
    removeRecord();
  }

  return true;
}

export async function canReuse(
  decision: StartupDecision,
  port: number,
): Promise<boolean> {
  return (
    decision.action === "reuse" &&
    (await identifyDaemon(port))?.pid === decision.info.pid
  );
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

  if (decision.action === "supersede" && !(await supersede(decision.info))) {
    process.exitCode = 1;
    return;
  }

  const reusable = await canReuse(decision, port);

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
  console.log(planLine(plan));

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
