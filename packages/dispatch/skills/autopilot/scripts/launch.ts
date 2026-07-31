import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { decideStartup } from "./daemon-decision";
import { readRecord } from "./daemon-record";

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

export function validatePlanDir(
  planDir: string,
): { ok: true } | { ok: false; message: string } {
  try {
    if (!statSync(planDir).isDirectory()) {
      return { ok: false, message: "--plan must be a directory" };
    }
  } catch {
    return { ok: false, message: "--plan directory does not exist" };
  }

  try {
    if (!statSync(join(planDir, "tasks")).isDirectory()) {
      return { ok: false, message: "--plan must contain a tasks/ directory" };
    }
  } catch {
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

function delay(milliseconds: number): Promise<void> {
  return Bun.sleep(milliseconds);
}

async function portAnswers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return true;
  } catch {
    return false;
  }
}

async function waitForPort(port: number, answers: boolean): Promise<boolean> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if ((await portAnswers(port)) === answers) {
      return true;
    }

    await delay(POLL_INTERVAL_MS);
  }

  return false;
}

async function waitForServer(port: number, pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    const record = readRecord();

    if (record?.pid === pid && record.port === port && (await portAnswers(port))) {
      return true;
    }

    await delay(POLL_INTERVAL_MS);
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
  const parsed = parseArgs(Bun.argv.slice(2).filter((arg) => arg !== "--serve"));

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
    try {
      process.kill(decision.info.pid, "SIGTERM");
    } catch {
      // The server may exit between the liveness check and the signal.
    }

    if (!(await waitForPort(decision.info.port, false))) {
      console.error(`flightdeck error: port ${decision.info.port} did not close`);
      process.exitCode = 1;
      return;
    }
  }

  if (decision.action !== "reuse") {
    const scriptPath = join(import.meta.dir, "flightdeck.ts");
    const child = Bun.spawn(
      ["bun", scriptPath, "--serve", "--plan", plan, "--port", String(port)],
      { detached: true, stdio: ["ignore", "ignore", "ignore"] },
    );
    child.unref();

    if (!(await waitForServer(port, child.pid))) {
      console.error(`flightdeck error: server failed to answer on port ${port}`);
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
