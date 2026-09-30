// `atlas serve` startup decisions and atlas.json (contracts.md §3).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, makeFixtureHome } from "./fixtures.ts";
import { isRust } from "./launcher.ts";
import { spawnAtlas, startAtlas, type AtlasProc } from "./serve.ts";

type Fixture = Awaited<ReturnType<typeof makeFixtureHome>>;

let fx: Fixture;
const procs: AtlasProc[] = [];
const kills: Array<() => void> = [];

beforeEach(async () => {
  fx = await makeFixtureHome();
});
afterEach(async () => {
  for (const kill of kills.splice(0)) kill();
  for (const p of procs.splice(0)) await p.stop();
  await fx.cleanup();
});

const atlasJson = () => join(fx.env.COCKPIT_HOME, "atlas.json");
const start = async (port: number) => {
  const p = await startAtlas(fx.env, port);
  procs.push(p);
  return p;
};
const exitWithin = (proc: { exited: Promise<number> }, ms: number) =>
  Promise.race([
    proc.exited,
    Bun.sleep(ms).then(() => {
      throw new Error(`process still running after ${ms} ms`);
    }),
  ]);
const refuses = async (port: number) => {
  try {
    await fetch(`http://127.0.0.1:${port}/`);
    return false;
  } catch {
    return true;
  }
};

describe("atlas.json", () => {
  test("exact text after start", async () => {
    const atlas = await start(await freePort());
    const text = readFileSync(atlasJson(), "utf8");
    const { root } = JSON.parse(text);
    expect(root.endsWith("/skills/usage-dashboard/scripts")).toBe(true);
    expect(text).toBe(
      JSON.stringify({ pid: atlas.proc.pid, port: atlas.port, root }, null, 2) +
        "\n",
    );
  });

  test("corrupt atlas.json → normal start, rewritten", async () => {
    writeFileSync(atlasJson(), "{not json");
    const atlas = await start(await freePort());
    const info = JSON.parse(readFileSync(atlasJson(), "utf8"));
    expect(info.pid).toBe(atlas.proc.pid);
    expect(info.port).toBe(atlas.port);
  });
});

test("reuse: same install prints the running server and exits 0", async () => {
  const first = await start(await freePort());
  const secondPort = await freePort();
  const second = spawnAtlas(fx.env, secondPort);
  kills.push(() => second.proc.kill("SIGKILL"));
  expect(await exitWithin(second.proc, 5000)).toBe(0);
  await second.drained;
  expect(second.stdout()).toBe(
    `Claude Stats Dashboard already running → http://localhost:${first.port} (pid ${first.proc.pid})\n`,
  );
  expect(await refuses(secondPort)).toBe(true);
});

// Optional: proves a TS server and a Rust server from one checkout write the same root.
test.skipIf(!isRust())(
  "mixed fleet: Rust reuses a running TS server",
  async () => {
    const bin = process.env.COCKPIT_BIN;
    delete process.env.COCKPIT_BIN;
    let ts: AtlasProc;
    try {
      ts = await start(await freePort());
    } finally {
      process.env.COCKPIT_BIN = bin;
    }
    const rust = spawnAtlas(fx.env, await freePort());
    kills.push(() => rust.proc.kill("SIGKILL"));
    expect(await exitWithin(rust.proc, 5000)).toBe(0);
    await rust.drained;
    expect(rust.stdout()).toBe(
      `Claude Stats Dashboard already running → http://localhost:${ts.port} (pid ${ts.proc.pid})\n`,
    );
  },
);

test("supersede: a live foreign root is killed and replaced", async () => {
  const sleeper = Bun.spawn(["sleep", "60"]);
  kills.push(() => sleeper.kill("SIGKILL"));
  const foreignRoot = "/elsewhere/skills/usage-dashboard/scripts";
  writeFileSync(
    atlasJson(),
    JSON.stringify({
      pid: sleeper.pid,
      port: await freePort(),
      root: foreignRoot,
    }),
  );
  const atlas = await start(await freePort());
  expect(atlas.stdout()).toContain(
    `superseding stale atlas server (pid ${sleeper.pid}, root ${foreignRoot}) — this install is `,
  );
  await exitWithin(sleeper, 3000);
  expect((await fetch(`http://127.0.0.1:${atlas.port}/`)).status).toBe(200);
  expect(JSON.parse(readFileSync(atlasJson(), "utf8")).pid).toBe(
    atlas.proc.pid,
  );
});

test("port in use: exit 1 with the exact stderr line", async () => {
  const port = await freePort();
  const holder = Bun.listen({
    hostname: "127.0.0.1",
    port,
    socket: { data() {} },
  });
  kills.push(() => holder.stop(true));
  const run = spawnAtlas(fx.env, port);
  kills.push(() => run.proc.kill("SIGKILL"));
  expect(await exitWithin(run.proc, 10_000)).toBe(1);
  await run.drained;
  expect(run.stderr()).toContain(
    `atlas: port ${port} is in use by another process — stop it or pass --port <n>.`,
  );
});
