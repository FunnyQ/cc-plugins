import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRecord } from "./daemon-record";
import { createServer, parseArgs } from "./flightdeck";

let fixtureRoot: string;
let plan: string;
let originalDataHome: string | undefined;
const servers: Bun.Server[] = [];

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "dispatch-flightdeck-"));
  plan = join(fixtureRoot, "plan");
  mkdirSync(join(plan, "tasks"), { recursive: true });
  originalDataHome = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(fixtureRoot, "data");
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));

  if (originalDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalDataHome;
  }

  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("module import", () => {
  test("exposes helpers without starting a server", () => {
    expect(typeof parseArgs).toBe("function");
    expect(typeof createServer).toBe("function");
  });
});

describe("parseArgs", () => {
  function messageOf(argv: string[]): string {
    const parsed = parseArgs(argv);
    return parsed.ok ? "" : parsed.message;
  }

  test("parses plan and port", () => {
    expect(parseArgs(["--serve", "--plan", plan, "--port", "6000"])).toEqual({
      ok: true,
      plan,
      port: 6000,
    });
  });

  test("uses the default port", () => {
    expect(parseArgs(["--serve", "--plan", plan])).toEqual({
      ok: true,
      plan,
      port: 5757,
    });
  });

  test("rejects an out-of-range port", () => {
    expect(messageOf(["--serve", "--plan", plan, "--port", "65536"])).toContain(
      "--port",
    );
  });

  test("reports a plan directory that does not exist", () => {
    expect(
      messageOf(["--serve", "--plan", join(fixtureRoot, "absent")]),
    ).toContain("does not exist");
  });

  test("rejects a relative plan", () => {
    expect(messageOf(["--serve", "--plan", "relative/plan"])).toContain(
      "absolute",
    );
  });

  test("rejects a plan without tasks", () => {
    const emptyPlan = join(fixtureRoot, "empty-plan");
    mkdirSync(emptyPlan);

    expect(messageOf(["--serve", "--plan", emptyPlan])).toContain("tasks/");
  });
});

describe("createServer", () => {
  test("rejects a port that is already bound", async () => {
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("occupied"),
    });
    servers.push(occupied);

    await expect(createServer(plan, occupied.port)).rejects.toThrow(
      `port ${occupied.port} is already in use`,
    );
  });

  test("serves the dashboard and returns 404 for unknown paths", async () => {
    const server = await createServer(plan, 0);
    servers.push(server);

    const rootResponse = await fetch(`http://127.0.0.1:${server.port}/`);
    const missingResponse = await fetch(
      `http://127.0.0.1:${server.port}/missing-file.txt`,
    );

    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toContain("<title>Hangar</title>");
    expect(missingResponse.status).toBe(404);
    expect(server.hostname).toBe("127.0.0.1");
    expect(readRecord()).toEqual({
      pid: process.pid,
      port: server.port,
      root: import.meta.dir,
      plan,
    });
  });

  test("identifies itself on the health endpoint", async () => {
    const server = await createServer(plan, 0);
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${server.port}/api/health`);

    expect(await response.json()).toEqual({
      flightdeck: true,
      pid: process.pid,
      plan,
    });
  });

  test("rejects traversal paths", async () => {
    const server = await createServer(plan, 0);
    servers.push(server);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`,
    );

    expect(response.status).toBe(404);
  });
});
