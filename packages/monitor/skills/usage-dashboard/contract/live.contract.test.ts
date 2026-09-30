// `atlas live` on the extended fixture must reproduce golden/live.json, recorded from the TS live.ts before its deletion.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { atlasCommand } from "./launcher";
import { makeFixtureHome } from "./fixtures";
import { extendLiveFixture } from "./live-fixture";
import { fixtureRoot, normalizeFixturePaths, readGolden } from "./golden";

type Fixture = Awaited<ReturnType<typeof makeFixtureHome>>;
let f: Fixture;

beforeAll(async () => {
  f = await makeFixtureHome();
  await extendLiveFixture(f.home);
});
afterAll(async () => {
  await f?.cleanup();
});

test("Rust atlas live deep-equals golden/live.json", async () => {
  const proc = Bun.spawn(atlasCommand("live"), { env: f.env, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  expect(out.endsWith("\n")).toBe(false);
  const golden = await readGolden<{
    sessions: Array<{ status: string; cockpit: boolean; provider: string }>;
    cockpitUp: boolean;
    cockpitPort: number;
  }>("live.json");
  expect(normalizeFixturePaths(JSON.parse(out), fixtureRoot(f))).toEqual(golden);

  // Guard the fixture itself: every status and a cockpit tag per provider must appear.
  const statuses = new Set(golden.sessions.map((s) => s.status));
  for (const s of ["busy", "idle", "waiting", "active-inferred", "recent"]) {
    expect(statuses.has(s)).toBe(true);
  }
  const tagged = golden.sessions.filter((s) => s.cockpit).map((s) => s.provider).sort();
  expect(tagged).toEqual(["claude", "codex", "opencode"]);
  expect(golden.cockpitUp).toBe(true);
  expect(golden.cockpitPort).toBe(5999);
});
