import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";

import { join, relative } from "node:path";
import {
  FIXTURE_IDS,
  FIXTURE_NOW_MS,
  FIXTURE_PROJECTS,
  makeFixtureHome,
  STUB_PATHS,
} from "./fixtures";
import { atlasCommand } from "./launcher";

type Fixture = Awaited<ReturnType<typeof makeFixtureHome>>;
type Run = { code: number; out: string; err: string };

// Async on purpose: the stub lives in this process, so a sync spawn would deadlock it.
async function stats(f: Fixture, args: string[] = []): Promise<Run> {
  const proc = Bun.spawn(atlasCommand("stats", args), {
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out, err };
}

function listTree(root: string): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else {
        const st = statSync(path);
        out.push([relative(root, path), st.size, st.mtimeMs]);
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

const A = FIXTURE_IDS.claudeSessionA;

describe("fixture home", () => {
  test("holds one input per engine rule", async () => {
    const f = await makeFixtureHome();
    try {
      for (const rel of [
        `.claude/projects/-work-proj-a/${A}.jsonl`,
        `.claude/projects/-work-proj-a/${A}/subagents/${FIXTURE_IDS.claudeSubagent}.jsonl`,
        `.claude/projects/-work-proj-b/${FIXTURE_IDS.claudeSessionB}.jsonl`,
        ".claude/stats-cache.json",
        ".claude/history.jsonl",
        `.claude/sessions/${FIXTURE_IDS.claudePidLive}.json`,
        ".codex/state_5.sqlite",
        ".codex/auth.json",
        ".local/share/opencode/opencode.db",
        `.local/share/opencode/storage/session/proj_legacy/${FIXTURE_IDS.openCodeLegacySession}.json`,
        `.local/share/opencode/storage/message/${FIXTURE_IDS.openCodeLegacySession}/msg_legacy_1.json`,
        ".config/cc-dashboard/pricing.json",
        ".config/cc-dashboard/budget.json",
        ".cache/token-atlas/rate-limits.json",
      ]) {
        expect(existsSync(join(f.home, rel))).toBe(true);
      }
      expect(
        existsSync(join(f.home, ".cache/token-atlas/codex-usage-limits.json")),
      ).toBe(false);
      const rollouts = listTree(join(f.home, ".codex/sessions"));
      expect(
        rollouts.map(([rel]) => rel.split("/").slice(0, 3).join("/")),
      ).toEqual(["2026/09/27", "2026/09/28"]);
    } finally {
      await f.cleanup();
    }
  });

  test("two homes match in relative paths, sizes, and mtimes", async () => {
    const [one, two] = [await makeFixtureHome(), await makeFixtureHome()];
    try {
      expect(one.home).not.toBe(two.home);
      const tree = listTree(one.home);
      expect(tree.length).toBeGreaterThan(10);
      expect(listTree(two.home)).toEqual(tree);
    } finally {
      await one.cleanup();
      await two.cleanup();
    }
  });

  test("env is exactly PATH plus the fixture values", async () => {
    const f = await makeFixtureHome();
    try {
      expect(Object.keys(f.env).sort()).toEqual(
        [
          "PATH",
          "HOME",
          "XDG_DATA_HOME",
          "XDG_CONFIG_HOME",
          "COCKPIT_HOME",
          "TZ",
          "TOKEN_ATLAS_NOW_MS",
          "TOKEN_ATLAS_OPENROUTER_URL",
          "TOKEN_ATLAS_CODEX_USAGE_URL",
          "TOKEN_ATLAS_CODEX_TOKEN_URL",
        ].sort(),
      );
      expect(f.env.HOME).toBe(f.home);
      expect(f.env.TZ).toBe("Asia/Taipei");
      expect(f.env.TOKEN_ATLAS_NOW_MS).toBe(String(FIXTURE_NOW_MS));
    } finally {
      await f.cleanup();
    }
  });

  test("stub answers unknown paths 200 {} and honours respondWith", async () => {
    const f = await makeFixtureHome();
    try {
      const ingest = await fetch(f.stub.url + STUB_PATHS.ingest, {
        method: "POST",
        headers: { "X-Auth-Token": "s3cret" },
        body: '{"a":1}',
      });
      expect(ingest.status).toBe(200);
      expect(await ingest.json()).toEqual({});
      expect(f.stub.requests.at(-1)).toMatchObject({
        path: STUB_PATHS.ingest,
        method: "POST",
        body: '{"a":1}',
      });
      expect(f.stub.requests.at(-1)!.headers["x-auth-token"]).toBe("s3cret");

      f.stub.respondWith(STUB_PATHS.openRouter, 500, '{"error":"boom"}');
      const forced = await fetch(f.stub.url + STUB_PATHS.openRouter);
      expect(forced.status).toBe(500);
      expect(await forced.text()).toBe('{"error":"boom"}');
    } finally {
      await f.cleanup();
    }
  });
});

describe("TS engine against the fixture home", () => {
  let f: Fixture;
  let first: Run;
  beforeAll(async () => {
    f = await makeFixtureHome();
    first = await stats(f);
  }, 60_000);
  afterAll(async () => {
    await f.cleanup();
  });

  test("full payload reports tokens for every provider", () => {
    expect(first.err).toBe("");
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.out);
    const providers = payload.summary.providers;
    // summary.providers carries sessions and messages; token totals live in byModel.
    for (const provider of ["claude", "codex", "opencode"] as const) {
      expect(providers[provider].totalSessions).toBeGreaterThan(0);
      const tokens = payload.byModel
        .filter((m: { provider: string }) => m.provider === provider)
        .reduce(
          (sum: number, m: Record<string, number>) =>
            sum + m.inputTokens + m.outputTokens + m.cacheReadTokens,
          0,
        );
      expect(tokens).toBeGreaterThan(0);
    }
    expect(payload.meta.generatedAt).toBe(
      new Date(FIXTURE_NOW_MS).toISOString(),
    );
    expect(payload.pricingMeta.openRouter).toEqual({
      attempted: true,
      used: true,
      error: null,
    });
  });

  test("stub saw OpenRouter and the Codex 401 → refresh → retry", () => {
    const seen = f.stub.requests.map((r) => `${r.method} ${r.path}`);
    expect(seen).toContain(`GET ${STUB_PATHS.openRouter}`);
    expect(seen).toContain(`POST ${STUB_PATHS.codexToken}`);
    const usageAuth = f.stub.requests
      .filter((r) => r.path === STUB_PATHS.codexUsage)
      .map((r) => r.headers.authorization);
    expect(usageAuth).toEqual([
      `Bearer ${FIXTURE_IDS.staleCodexAccessToken}`,
      `Bearer ${FIXTURE_IDS.freshCodexAccessToken}`,
    ]);
    const refresh = f.stub.requests.find(
      (r) => r.path === STUB_PATHS.codexToken,
    )!;
    expect(refresh.body).toContain("grant_type=refresh_token");
  });

  test("a second run prints identical JSON", async () => {
    const second = await stats(f);
    expect(second.code).toBe(0);
    expect(second.out).toBe(first.out);
  }, 60_000);

  test("source claude exercises every transcript rule", async () => {
    const run = await stats(f, ["--source", "claude"]);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.out);
    expect(Object.keys(out)).toEqual([
      "usage",
      "ledger",
      "transcriptFileCount",
      "statsCache",
      "history",
      "usageLimits",
    ]);
    expect(Object.keys(out.usage)).toEqual([
      "modelUsage",
      "dailyModelUsage",
      "hourlyUsage",
      "projectTokens",
      "projectModelUsage",
    ]);
    expect(out.transcriptFileCount).toBe(3);
    const opus = out.usage.modelUsage["claude-opus-4-7"];
    // First snapshot billed: output 10, not the later snapshot's 250.
    expect(opus.outputTokens).toBe(10 + 3 + 600);
    // The timeless entry counts in totals but in no hourly bucket.
    expect(opus.inputTokens).toBe(100 + 7 + 300);
    const hourlyOpusInput = Object.values(
      out.usage.hourlyUsage as Record<
        string,
        { usageByModel: Record<string, { inputTokens: number }> }
      >,
    ).reduce(
      (sum, bucket) =>
        sum + (bucket.usageByModel["claude:claude-opus-4-7"]?.inputTokens ?? 0),
      0,
    );
    expect(hourlyOpusInput).toBe(400);
    expect(out.usage.hourlyUsage["0"]).toBeUndefined();
    // req_A2 appears in the parent and the subagent transcript; billed once.
    expect(out.usage.modelUsage["claude-sonnet-4-6"].inputTokens).toBe(50 + 40);
    const hours = Object.keys(out.usage.hourlyUsage);
    expect(hours.length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(out.usage.dailyModelUsage).sort()).toEqual([
      "2026-09-26",
      "2026-09-27",
      "2026-09-28",
    ]);
    // The subagent file folds into its parent's session row.
    const parent = out.ledger.find(
      (row: { id: string }) => row.id === `claude:${A}`,
    );
    expect(parent).toMatchObject({
      projectPath: FIXTURE_PROJECTS.a,
      interactions: 3,
      toolCalls: 3,
    });
    // Set → sorted array through the source replacer.
    expect(out.history.dailyHistory["2026-09-28"].sessionIds).toEqual([
      FIXTURE_IDS.claudeSessionB,
    ]);
    expect(out.usageLimits.stale).toBe(false);
  });

  test("source codex", async () => {
    const run = await stats(f, ["--source", "codex"]);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.out);
    expect(Object.keys(out)).toEqual(["usage", "usageLimits"]);
    expect(Object.keys(out.usage.modelUsage).length).toBeGreaterThan(0);
    // Model comes from the rollout when the thread row has none.
    expect(out.usage.modelUsage["codex:gpt-5.1-codex-mini"]).toBeDefined();
    expect(out.usage.ledger.map((row: { id: string }) => row.id)).toContain(
      `codex:${FIXTURE_IDS.codexThreadNoRollout}`,
    );
    expect(out.usageLimits.plan).toBe("plus");
  });

  test("source opencode", async () => {
    const run = await stats(f, ["--source", "opencode"]);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.out);
    expect(Object.keys(out)).toEqual(["usage"]);
    expect(out.usage.totalToolCalls).toBe(2);
    expect(out.usage.openCodeSessionFileCount).toBe(1);
    expect(out.usage.openCodeMessageFileCount).toBe(1);
    expect(out.usage.modelUsage["opencode:claude-sonnet-4-6"].costUSD).toBe(
      0.0123,
    );
  });

  test("source pricing", async () => {
    const run = await stats(f, ["--source", "pricing"]);
    expect(run.code).toBe(0);
    const out = JSON.parse(run.out);
    expect(Object.keys(out)).toEqual(["table", "meta", "sourceByModel"]);
    expect(out.sourceByModel["claude-sonnet-4-6"]).toBe("override");
    expect(out.sourceByModel["mistralai/mistral-large-unused"]).toBe("live");
  });

  test("unknown or missing source exits 2 with usage", async () => {
    for (const args of [["--source", "nope"], ["--source"]]) {
      const run = await stats(f, args);
      expect(run.code).toBe(2);
      expect(run.out).toBe("");
      expect(run.err).toContain("--source claude|codex|opencode|pricing");
    }
  });
});
