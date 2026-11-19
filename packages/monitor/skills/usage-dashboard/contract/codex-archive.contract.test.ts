import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { renameSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atlasCommand, type AtlasSub } from "./launcher";
import { FIXTURE_IDS, makeFixtureHome } from "./fixtures";

type Fixture = Awaited<ReturnType<typeof makeFixtureHome>>;
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function run(f: Fixture, sub: AtlasSub, args: string[] = []) {
  const proc = Bun.spawn(atlasCommand(sub, args), {
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  return JSON.parse(stdout);
}

const VOLATILE = new Set([
  "generatedAt",
  "dataHealth",
  "codexSessionFileCount",
  "codexThreadRowCount",
]);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(stable);
    return items.every(
      (item) => typeof item === "object" && item && "id" in item,
    )
      ? items.sort((a, b) =>
          String((a as { id: string }).id).localeCompare(
            String((b as { id: string }).id),
          ),
        )
      : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !VOLATILE.has(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function rolloutPath(f: Fixture, id: string): string {
  const db = new Database(join(f.home, ".codex", "state_5.sqlite"));
  const row = db
    .query("select rollout_path from threads where id = ?")
    .get(id) as { rollout_path: string };
  db.close();
  return row.rollout_path;
}

function dropRow(f: Fixture, id: string): void {
  const db = new Database(join(f.home, ".codex", "state_5.sqlite"));
  db.query("delete from threads where id = ?").run(id);
  db.close();
}

test("a stats run captures Codex usage, so every report survives deleting the rollout and index row", async () => {
  const f = await makeFixtureHome();
  fixtures.push(f);
  const before = stable(await run(f, "stats"));

  const coverage = await run(f, "codex-archive", [
    "--older-than",
    "0",
    "--dry-run",
  ]);
  expect(coverage.counts).toEqual({ unchanged: 2, incomplete: 1 });
  expect(coverage.verified).toBe(2);

  const t1 = rolloutPath(f, FIXTURE_IDS.codexThreadRollout);
  const t2 = rolloutPath(f, FIXTURE_IDS.codexThreadModelFromRollout);
  const t1Body = await Bun.file(t1).text();
  rmSync(t1);
  dropRow(f, FIXTURE_IDS.codexThreadRollout);
  rmSync(t2);

  const after = stable(await run(f, "stats"));
  expect(after).toEqual(before);
  const mini = (after as { byModel: { model: string }[] }).byModel.find(
    (row) => row.model === "codex:gpt-5.1-codex-mini",
  );
  expect(mini).toMatchObject({
    inputTokens: 3000,
    cacheReadTokens: 1000,
    outputTokens: 500,
    reasoningTokens: 120,
    costUSD: 0.001775,
  });
  expect(stable(await run(f, "stats"))).toEqual(before);

  const restored = join(f.home, ".codex", "sessions", "restored", "t1.jsonl");
  mkdirSync(join(restored, ".."), { recursive: true });
  await Bun.write(restored, t1Body);
  expect(stable(await run(f, "stats"))).toEqual(before);
});

test("a rollout deleted before any stats run is not captured", async () => {
  const baseline = await makeFixtureHome();
  const f = await makeFixtureHome();
  fixtures.push(baseline, f);
  const before = stable(await run(baseline, "stats"));
  rmSync(rolloutPath(f, FIXTURE_IDS.codexThreadRollout));
  dropRow(f, FIXTURE_IDS.codexThreadRollout);
  expect(stable(await run(f, "stats"))).not.toEqual(before);
});
