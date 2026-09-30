// Differential contract for `atlas live`: TS live.ts vs the Rust port on one extended fixture.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { atlasCommand, isRust, SCRIPTS_DIR } from "./launcher";
import { makeFixtureHome } from "./fixtures";
import { extendLiveFixture } from "./live-fixture";
import { join } from "node:path";

type Fixture = Awaited<ReturnType<typeof makeFixtureHome>>;
let f: Fixture | undefined;

beforeAll(async () => {
  if (!isRust()) return;
  f = await makeFixtureHome();
  await extendLiveFixture(f.home);
});
afterAll(async () => {
  await f?.cleanup();
});

async function run(cmd: string[], env: Record<string, string>) {
  const proc = Bun.spawn(cmd, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([
    new Response(proc.stdout).text(),
    proc.exited,
  ]);
  expect(code).toBe(0);
  return stdout;
}

// It runs both implementations side by side, so it only means something when COCKPIT_BIN is set.
test.skipIf(!isRust())("Rust atlas live deep-equals TS live.ts", async () => {
  const env = f!.env;
  const tsOut = await run(["bun", join(SCRIPTS_DIR, "live.ts")], env);
  const rustOut = await run(atlasCommand("live"), env);
  expect(rustOut.endsWith("\n")).toBe(false);
  const ts = JSON.parse(tsOut);
  const rust = JSON.parse(rustOut);
  expect(rust).toEqual(ts);

  // Guard the fixture itself: every status and a cockpit tag per provider must appear.
  const statuses = new Set(ts.sessions.map((s: { status: string }) => s.status));
  for (const s of ["busy", "idle", "waiting", "active-inferred", "recent"]) {
    expect(statuses.has(s)).toBe(true);
  }
  const tagged = ts.sessions
    .filter((s: { cockpit: boolean }) => s.cockpit === true)
    .map((s: { provider: string }) => s.provider)
    .sort();
  expect(tagged).toEqual(["claude", "codex", "opencode"]);
  expect(ts.cockpitUp).toBe(true);
  expect(ts.cockpitPort).toBe(5999);
});
