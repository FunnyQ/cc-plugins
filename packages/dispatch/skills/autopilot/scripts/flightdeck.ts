import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { removeRecord, writeRecord } from "./daemon-record";
import { serveStatic } from "./static-serve";

const DEFAULT_PORT = 5757;
const distRoot = resolve(import.meta.dir, "..", "dashboard", "dist");

export type FlightdeckOptions = {
  serve?: boolean;
  plan?: string;
  port?: number;
  error?: string;
};

function hasTasksDirectory(plan: string): boolean {
  try {
    return statSync(join(plan, "tasks")).isDirectory();
  } catch {
    return false;
  }
}

export function parseArgs(argv: string[]): FlightdeckOptions {
  let serve = false;
  let plan: string | undefined;
  let port = DEFAULT_PORT;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--serve") {
      serve = true;
    } else if (argument === "--plan") {
      plan = argv[index + 1];
      index += 1;
    } else if (argument === "--port") {
      port = Number(argv[index + 1]);
      index += 1;
    }
  }

  if (!serve) {
    return { error: "--serve is required" };
  }

  if (plan === undefined || !isAbsolute(plan)) {
    return { error: "--plan must be an absolute path" };
  }

  if (!hasTasksDirectory(plan)) {
    return { error: "--plan must contain a tasks/ directory" };
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: "--port must be an integer from 1 to 65535" };
  }

  return { serve, plan, port };
}

export async function createServer(
  plan: string,
  port: number,
): Promise<Bun.Server> {
  if (!isAbsolute(plan) || !hasTasksDirectory(plan)) {
    throw new Error("plan must be absolute and contain a tasks/ directory");
  }

  let server: Bun.Server;

  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        return serveStatic(distRoot, new URL(request.url).pathname);
      },
    });
  } catch {
    throw new Error(`port ${port} is already in use`);
  }

  try {
    writeRecord({
      pid: process.pid,
      port: server.port,
      root: import.meta.dir,
      plan,
    });
  } catch (error) {
    await server.stop(true);
    throw error;
  }

  return server;
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));

  if (options.error !== undefined) {
    console.error(`flightdeck error: ${options.error}`);
    process.exit(2);
  }

  const server = await createServer(options.plan!, options.port!);
  const shutdown = async () => {
    removeRecord();
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main().catch((error: Error) => {
    console.error("flightdeck error:", error.message);
    process.exit(1);
  });
}
