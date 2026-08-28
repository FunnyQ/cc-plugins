import { isAbsolute, join, resolve } from "node:path";
import { removeRecord, writeRecord } from "./daemon-record";
import { runLogPath } from "../../flightplan/scripts/lib/flightlog";
import { eventsHandler } from "./events-api";
import {
  main as launchMain,
  parseArgs as parsePlanArgs,
  validatePlanDir,
} from "./launch";
import { serveStatic } from "./static-serve";
import { buildTreePayload, loadPlan } from "./tree-api";

const distRoot = resolve(import.meta.dir, "..", "dashboard", "dist");

export type FlightdeckOptions =
  | { ok: true; plan: string; port: number; projectsRoot?: string }
  | { ok: false; message: string };

/** The serving entry point shares the launcher's flag shapes and plan rules. */
export function parseArgs(argv: string[]): FlightdeckOptions {
  const parsed = parsePlanArgs(argv);

  if (!parsed.ok) {
    return { ok: false, message: parsed.message };
  }

  const validation = validatePlanDir(parsed.args.plan);

  if (!validation.ok) {
    return { ok: false, message: validation.message };
  }

  // Not part of the launcher's own flag set: it exists so a manual gate can point
  // at a generated fixture instead of whatever transcripts survive on this machine.
  //
  // The missing-value case errors rather than swallowing the next token, which is
  // the bug `lib/args.ts` was written to kill. That helper is not reused here
  // because it reports by exiting the process, and this function is a pure parser
  // its own unit tests call — an exit would take the test runner down with it.
  const projectsRootIndex = argv.indexOf("--projects-root");
  const projectsRoot =
    projectsRootIndex === -1 ? undefined : argv[projectsRootIndex + 1];

  if (
    projectsRootIndex !== -1 &&
    (projectsRoot === undefined || projectsRoot.startsWith("--"))
  ) {
    return { ok: false, message: "Missing value after --projects-root" };
  }

  return {
    ok: true,
    plan: parsed.args.plan,
    port: parsed.args.port,
    projectsRoot,
  };
}

export async function createServer(
  plan: string,
  port: number,
  projectsRoot?: string,
): Promise<Bun.Server<unknown>> {
  if (!isAbsolute(plan) || !validatePlanDir(plan).ok) {
    throw new Error("plan must be absolute and contain a tasks/ directory");
  }

  let server: Bun.Server<unknown>;

  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      async fetch(request) {
        const url = new URL(request.url);

        // The launcher's identity check: a port answering HTTP is not proof of a
        // flightdeck, and a pid can be recycled. This names the process it is safe
        // to reuse or to signal.
        if (url.pathname === "/api/health") {
          return Response.json({
            flightdeck: true,
            pid: process.pid,
            plan,
          });
        }

        if (url.pathname === "/api/tree") {
          const result = buildTreePayload(await loadPlan(plan));
          return new Response(JSON.stringify(result), {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.pathname === "/api/events") {
          return eventsHandler(request, runLogPath(plan), plan, {
            projectsRoot,
          });
        }

        return serveStatic(distRoot, url.pathname);
      },
    });
  } catch {
    throw new Error(`port ${port} is already in use`);
  }

  try {
    writeRecord({
      pid: process.pid,
      port: server.port!,
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
  if (!Bun.argv.slice(2).includes("--serve")) {
    await launchMain();
    return;
  }

  const options = parseArgs(Bun.argv.slice(2));

  if (!options.ok) {
    console.error(`flightdeck error: ${options.message}`);
    process.exit(2);
  }

  const server = await createServer(
    options.plan,
    options.port,
    options.projectsRoot,
  );
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
