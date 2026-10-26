import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLogPath } from "../../flightplan/scripts/lib/flightlog";
import * as eventsApi from "./events-api";
import { readRecord } from "./daemon-record";
import { createServer, parseArgs } from "./flightdeck";

let fixtureRoot: string;
let plan: string;
let originalDataHome: string | undefined;
const servers: Bun.Server<unknown>[] = [];

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

  test("carries --projects-root through", () => {
    const projects = join(fixtureRoot, "projects");

    expect(
      parseArgs(["--serve", "--plan", plan, "--projects-root", projects]),
    ).toEqual({ ok: true, plan, port: 5757, projectsRoot: projects });
  });

  test("rejects --projects-root with nothing after it rather than falling back to ~/.claude/projects", () => {
    expect(messageOf(["--serve", "--plan", plan, "--projects-root"])).toContain(
      "--projects-root",
    );
  });

  test("rejects --projects-root followed by another flag", () => {
    expect(
      messageOf([
        "--serve",
        "--plan",
        plan,
        "--projects-root",
        "--port",
        "6000",
      ]),
    ).toContain("--projects-root");
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

    await expect(createServer(plan, occupied.port!)).rejects.toThrow(
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
      port: server.port!,
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

function graphPlan(): string {
  const dir = join(fixtureRoot, "contract-run");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "graph.json"),
    JSON.stringify({
      version: 1,
      title: "Contract Run",
      repoRoot: "/declared/repository",
      lanes: ["z-build", "a-review", "m-empty"],
      nodes: [
        { ref: "z-build/01", lane: "z-build", title: "Build" },
        {
          ref: "a-review/01",
          lane: "a-review",
          title: "Review",
          dependsOn: ["z-build/01"],
        },
      ],
    }),
  );
  return dir;
}

function writeTrail(dir: string, entries: object[]): void {
  mkdirSync(join(dir, ".flightlog"), { recursive: true });
  writeFileSync(
    runLogPath(dir),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

const started = {
  kind: "note",
  ts: "2026-09-06T00:00:00Z",
  task: "z-build/01",
  role: "dev",
  phase: "start",
  message: "building",
};

describe("source routing", () => {
  test("accepts graph directories through the serving argument parser", () => {
    const dir = graphPlan();
    expect(parseArgs(["--serve", "--plan", dir])).toEqual({
      ok: true,
      plan: dir,
      port: 5757,
    });
  });

  test("names both accepted shapes when createServer rejects a plan", async () => {
    await expect(createServer(fixtureRoot, 0)).rejects.toThrow(
      "plan must be absolute and contain a tasks/ directory or a graph.json file",
    );
  });

  test("keeps the detected source when the graph disappears and tasks appear", async () => {
    const dir = graphPlan();
    const server = await createServer(dir, 0);
    servers.push(server);
    rmSync(join(dir, "graph.json"));
    mkdirSync(join(dir, "tasks"));
    const response = await fetch(`http://127.0.0.1:${server.port}/api/tree`);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.deckSource).toBe("graph");
    expect(payload.tasks).toEqual([]);
    expect(payload.errors).toEqual([
      expect.objectContaining({
        file: join(dir, "graph.json"),
        reason: expect.stringContaining("Cannot read"),
      }),
    ]);
  });

  test("rejects a non-directory with the server's validation message", async () => {
    const file = join(fixtureRoot, "file");
    writeFileSync(file, "");
    await expect(createServer(file, 0)).rejects.toThrow(
      "plan must be absolute and contain a tasks/ directory or a graph.json file",
    );
  });

  test("assembles graph metadata, declared lane order, states, and counts", async () => {
    const dir = graphPlan();
    writeTrail(dir, [
      { kind: "state", ts: started.ts, task: "z-build/01", state: "done" },
    ]);
    const server = await createServer(dir, 0);
    servers.push(server);
    const payload = await (
      await fetch(`http://127.0.0.1:${server.port}/api/tree`)
    ).json();
    expect(payload).toMatchObject({
      deckSource: "graph",
      slug: "contract-run",
      planTitle: "Contract Run",
      repo: "repository",
      buckets: ["z-build", "a-review", "m-empty"],
      errors: [],
      counts: {
        total: 2,
        done: 1,
        inProgress: 0,
        ready: 1,
        blocked: 0,
        invalid: 0,
      },
    });
    expect(payload.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "z-build/01",
          title: "Build",
          state: "done",
        }),
        expect.objectContaining({
          ref: "a-review/01",
          title: "Review",
          state: "ready",
          dependsOn: ["z-build/01"],
        }),
      ]),
    );
    appendFileSync(
      runLogPath(dir),
      JSON.stringify({
        kind: "state",
        ts: started.ts,
        task: "a-review/01",
        state: "done",
      }) + "\n",
    );
    const updated = await (
      await fetch(`http://127.0.0.1:${server.port}/api/tree`)
    ).json();
    expect(updated.counts.done).toBe(2);
  });

  test("surfaces both graph and trail errors with title fallback", async () => {
    const dir = graphPlan();
    writeFileSync(
      join(dir, "graph.json"),
      JSON.stringify({
        version: 1,
        repoRoot: "/declared/repository",
        lanes: ["z-build"],
        nodes: [
          {
            ref: "z-build/01",
            lane: "z-build",
            title: "Build",
            dependsOn: ["missing-step/01"],
          },
        ],
      }),
    );
    writeTrail(dir, [{ ...started, task: "unknown-step/01" }]);
    const server = await createServer(dir, 0);
    servers.push(server);
    const payload = await (
      await fetch(`http://127.0.0.1:${server.port}/api/tree`)
    ).json();
    expect(payload.planTitle).toBe("contract-run");
    expect(payload.counts.ready).toBe(1);
    expect(payload.errors).toEqual([
      expect.objectContaining({
        file: join(dir, "graph.json"),
        reason: expect.stringContaining("missing-step/01"),
      }),
      expect.objectContaining({
        reason: expect.stringContaining("unknown-step/01"),
      }),
    ]);
  });

  test("re-reads graph.json repoRoot on every events connection", async () => {
    const dir = graphPlan();
    writeTrail(dir, [started]);
    const handler = spyOn(eventsApi, "eventsHandler");
    const controller = new AbortController();
    try {
      const server = await createServer(dir, 0);
      servers.push(server);
      const graphFile = join(dir, "graph.json");
      const graph = JSON.parse(readFileSync(graphFile, "utf8"));
      writeFileSync(
        graphFile,
        JSON.stringify({ ...graph, repoRoot: "/repaired/repository" }),
      );
      await fetch(`http://127.0.0.1:${server.port}/api/events`, {
        signal: controller.signal,
      });
      expect(handler.mock.lastCall![3]).toMatchObject({
        repoRoot: "/repaired/repository",
      });
    } finally {
      controller.abort();
      handler.mockRestore();
    }
  });

  for (const deckSource of ["tasks", "graph"] as const) {
    test(`serves and tails the shared trail for ${deckSource}, forwarding source options`, async () => {
      const dir = deckSource === "graph" ? graphPlan() : plan;
      if (deckSource === "tasks") writeFileSync(join(dir, "graph.json"), "{}");
      writeTrail(dir, [started]);
      const handler = spyOn(eventsApi, "eventsHandler");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const server = await createServer(
          dir,
          0,
          join(fixtureRoot, "projects"),
        );
        servers.push(server);
        const tree = await (
          await fetch(`http://127.0.0.1:${server.port}/api/tree`)
        ).json();
        expect(tree.deckSource).toBe(deckSource);
        if (deckSource === "tasks") expect(tree.tasks).toEqual([]);
        const response = await fetch(
          `http://127.0.0.1:${server.port}/api/events`,
          { signal: controller.signal },
        );
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
          "text/event-stream",
        );
        expect(handler).toHaveBeenLastCalledWith(
          expect.any(Request),
          runLogPath(dir),
          dir,
          {
            projectsRoot: join(fixtureRoot, "projects"),
            deckSource,
            repoRoot:
              deckSource === "graph" ? "/declared/repository" : undefined,
          },
        );
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        async function nextFleet() {
          for (;;) {
            const end = buffer.indexOf("\n\n");
            if (end !== -1) {
              const frame = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              if (frame.startsWith("event: fleet\n"))
                return JSON.parse(frame.split("\n")[1]!.slice(6));
            } else {
              const chunk = await reader.read();
              if (chunk.done)
                throw new Error("SSE stream ended before fleet snapshot");
              buffer += decoder.decode(chunk.value, { stream: true });
            }
          }
        }
        const initial = await nextFleet();
        expect(initial).toMatchObject({ entryCount: 1, logPresent: true });
        expect(initial.rows[0]).toMatchObject({
          ref: started.task,
          status: "in-flight",
        });
        appendFileSync(
          runLogPath(dir),
          JSON.stringify({ ...started, phase: "end", message: "built" }) + "\n",
        );
        const updated = await nextFleet();
        expect(updated.entryCount).toBe(2);
        expect(updated.rows[0].status).not.toBe("in-flight");
      } finally {
        clearTimeout(timeout);
        controller.abort();
        handler.mockRestore();
      }
    });
  }
});
