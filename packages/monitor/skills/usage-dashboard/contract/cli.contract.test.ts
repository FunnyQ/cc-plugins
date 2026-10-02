// Black-box contract for the atlas CLI subcommands (contracts.md §4). Launcher-driven:
// runs COCKPIT_BIN, or the locally built release binary.
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { atlasCommand, type AtlasSub } from "./launcher";
import { freePort, makeFixtureHome, STUB_PATHS } from "./fixtures";

type Fixture = Awaited<ReturnType<typeof makeFixtureHome>>;

const fixtures: Fixture[] = [];
async function fixture(): Promise<Fixture> {
  const f = await makeFixtureHome();
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});

async function run(
  f: Fixture,
  sub: AtlasSub,
  opts: { args?: string[]; stdin?: string; env?: Record<string, string> } = {},
) {
  const started = performance.now();
  const proc = Bun.spawn(atlasCommand(sub, opts.args), {
    env: { ...f.env, ...opts.env },
    stdin:
      opts.stdin === undefined
        ? "ignore"
        : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code, elapsedMs: performance.now() - started };
}

async function waitFor(
  check: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await Bun.sleep(100);
  }
  return check();
}

const cacheDir = (f: Fixture) => join(f.home, ".cache", "token-atlas");
const rateLimitsPath = (f: Fixture) => join(cacheDir(f), "rate-limits.json");
const defaultDb = (f: Fixture) =>
  join(f.env.XDG_DATA_HOME, "q-lab", "token-atlas", "rollup.db");

const RATE_LIMITS = {
  five_hour: { used_percentage: 42.5, resets_at: 1790000000 },
  seven_day: { used_percentage: 7, resets_at: 1790500000 },
};

describe("measure", () => {
  test("rate_limits input writes the exact cache record", async () => {
    const f = await fixture();
    const before = Date.now();
    const r = await run(f, "measure", {
      stdin: JSON.stringify({ model: { id: "x" }, rate_limits: RATE_LIMITS }),
    });
    const after = Date.now();
    expect(r.code).toBe(0);
    const text = readFileSync(rateLimitsPath(f), "utf8");
    const parsed = JSON.parse(text);
    expect(text).toBe(JSON.stringify(parsed, null, 2));
    expect(text.endsWith("\n")).toBe(false);
    expect(Object.keys(parsed)).toEqual([
      "capturedAt",
      "capturedAtEpochMs",
      "rate_limits",
    ]);
    expect(parsed.rate_limits).toEqual(RATE_LIMITS);
    expect(parsed.capturedAtEpochMs).toBeGreaterThanOrEqual(before);
    expect(parsed.capturedAtEpochMs).toBeLessThanOrEqual(after);
    expect(parsed.capturedAt).toBe(
      new Date(parsed.capturedAtEpochMs).toISOString(),
    );
  });

  for (const [name, stdin] of [
    ["no rate_limits", JSON.stringify({ model: { id: "x" } })],
    ["non-JSON", "not json {"],
  ] as const) {
    test(`${name} stdin creates no cache file in a fresh home`, async () => {
      const f = await fixture();
      // The fixture may pre-seed the cache; start from a fresh one for this case.
      const path = rateLimitsPath(f);
      if (existsSync(path)) await Bun.file(path).delete();
      const r = await run(f, "measure", { stdin });
      expect(r.code).toBe(0);
      expect(existsSync(path)).toBe(false);
    });

    test(`${name} stdin keeps a pre-seeded cache file byte-identical`, async () => {
      const f = await fixture();
      const path = rateLimitsPath(f);
      mkdirSync(cacheDir(f), { recursive: true });
      const seeded = '{"seeded":true}';
      writeFileSync(path, seeded);
      const r = await run(f, "measure", { stdin });
      expect(r.code).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(seeded);
    });
  }

  test("rollup nudge creates its marker, runs rollup-update, and throttles", async () => {
    const f = await fixture();
    const marker = join(cacheDir(f), ".rollup-nudge");
    await run(f, "measure", { stdin: "{}" });
    expect(existsSync(marker)).toBe(true);
    // 15 s: a cold detached rollup-update over the fixture corpus, with slack for a loaded CI box.
    expect(await waitFor(() => existsSync(defaultDb(f)), 15_000)).toBe(true);
    const mtime = statSync(marker).mtimeMs;
    await run(f, "measure", { stdin: "{}" });
    expect(statSync(marker).mtimeMs).toBe(mtime);
  }, 30_000);

  for (const [name, url] of [
    ["unset", undefined],
    ["whitespace-only", "   "],
  ] as const) {
    test(`push nudge never fires with LLM_QUOTA_INGEST_URL ${name}`, async () => {
      const f = await fixture();
      const env: Record<string, string> = {};
      if (url !== undefined) env.LLM_QUOTA_INGEST_URL = url;
      await run(f, "measure", { stdin: "{}", env });
      expect(existsSync(join(cacheDir(f), ".push-nudge"))).toBe(false);
    });
  }

  test("push nudge fires with LLM_QUOTA_INGEST_URL set", async () => {
    const f = await fixture();
    await run(f, "measure", {
      stdin: "{}",
      env: { LLM_QUOTA_INGEST_URL: f.stub.url + STUB_PATHS.ingest },
    });
    expect(existsSync(join(cacheDir(f), ".push-nudge"))).toBe(true);
  });

  test("exits promptly without waiting on nudged children", async () => {
    const f = await fixture();
    const r = await run(f, "measure", { stdin: "{}" });
    expect(r.stdout).toBe("");
    // Catches a hook that waits on its nudges; cannot prove the child is fully detached.
    expect(r.elapsedMs).toBeLessThan(2_000);
  });
});

describe("push-usage", () => {
  const ingestRequests = (f: Fixture) =>
    f.stub.requests.filter((req) => req.path === STUB_PATHS.ingest);

  test("no URL: exit 0 and no ingest request", async () => {
    const f = await fixture();
    const r = await run(f, "push-usage");
    expect(r.code).toBe(0);
    expect(ingestRequests(f)).toHaveLength(0);
  });

  test("URL + secret: one POST with exact headers and body keys", async () => {
    const f = await fixture();
    const r = await run(f, "push-usage", {
      env: {
        LLM_QUOTA_INGEST_URL: f.stub.url + STUB_PATHS.ingest,
        LLM_QUOTA_INGEST_SECRET: "s3cret",
      },
    });
    expect(r.code).toBe(0);
    const reqs = ingestRequests(f);
    expect(reqs).toHaveLength(1);
    const [req] = reqs;
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["x-auth-token"]).toBe("s3cret");
    const body = JSON.parse(req.body);
    expect(Object.keys(body)).toEqual(["capturedAt", "claude", "codex"]);
    expect(typeof body.capturedAt).toBe("number");
  });

  test("URL without secret: x-auth-token is empty", async () => {
    const f = await fixture();
    await run(f, "push-usage", {
      env: { LLM_QUOTA_INGEST_URL: f.stub.url + STUB_PATHS.ingest },
    });
    const reqs = ingestRequests(f);
    expect(reqs).toHaveLength(1);
    expect(reqs[0].headers["x-auth-token"]).toBe("");
  });

  test("ingest responding 500 still exits 0", async () => {
    const f = await fixture();
    f.stub.respondWith(STUB_PATHS.ingest, 500, '{"error":"boom"}');
    const r = await run(f, "push-usage", {
      env: { LLM_QUOTA_INGEST_URL: f.stub.url + STUB_PATHS.ingest },
    });
    expect(r.code).toBe(0);
    expect(ingestRequests(f)).toHaveLength(1);
  });

  test("unreachable ingest URL still exits 0", async () => {
    const f = await fixture();
    const closed = await freePort();
    const r = await run(f, "push-usage", {
      env: { LLM_QUOTA_INGEST_URL: `http://127.0.0.1:${closed}/ingest` },
    });
    expect(r.code).toBe(0);
  });
});

describe("rollup-update", () => {
  const countJsonl = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce(
      (n, e) =>
        n +
        (e.isDirectory()
          ? countJsonl(join(dir, e.name))
          : e.name.endsWith(".jsonl")
            ? 1
            : 0),
      0,
    );

  test("prints filesScanned/rebuilt/usageHourlyRows in order, exit 0", async () => {
    const f = await fixture();
    const r = await run(f, "rollup-update");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(r.stdout.trimEnd()).toBe(JSON.stringify(out, null, 2));
    expect(Object.keys(out)).toEqual([
      "filesScanned",
      "rebuilt",
      "usageHourlyRows",
    ]);
    expect(typeof out.filesScanned).toBe("number");
    expect(typeof out.rebuilt).toBe("boolean");
    expect(typeof out.usageHourlyRows).toBe("number");
    expect(out.filesScanned).toBe(
      countJsonl(join(f.home, ".claude", "projects")),
    );
  });

  test("--db writes only the given path", async () => {
    const f = await fixture();
    const db = join(f.env.XDG_DATA_HOME, "custom", "alt.db");
    mkdirSync(join(f.env.XDG_DATA_HOME, "custom"), { recursive: true });
    const r = await run(f, "rollup-update", { args: ["--db", db] });
    expect(r.code).toBe(0);
    expect(existsSync(db)).toBe(true);
    expect(existsSync(defaultDb(f))).toBe(false);
  });

  test("--rebuild reports rebuilt true; a plain rerun reports false", async () => {
    const f = await fixture();
    const first = await run(f, "rollup-update", { args: ["--rebuild"] });
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout).rebuilt).toBe(true);
    const second = await run(f, "rollup-update");
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).rebuilt).toBe(false);
  });
});

describe("stats", () => {
  test("prints JSON with the exact top-level key order", async () => {
    const f = await fixture();
    const r = await run(f, "stats");
    expect(r.code).toBe(0);
    expect(Object.keys(JSON.parse(r.stdout))).toEqual([
      "period",
      "summary",
      "byModel",
      "pricingMeta",
      "budget",
      "usageLimits",
      "codexUsageLimits",
      "dataHealth",
      "daily",
      "ledger",
      "hourlyUsage",
      "activityDays",
      "hourlyDistribution",
      "weekHourMatrix",
      "dailyHourCounts",
      "projects",
      "sessions",
      "insights",
      "meta",
    ]);
  }, 30_000);
});

describe("live", () => {
  test("prints the {sessions, cockpitUp, cockpitPort} object, no trailing newline", async () => {
    const f = await fixture();
    expect(existsSync(join(f.env.COCKPIT_HOME, "daemon.json"))).toBe(false);
    const r = await run(f, "live");
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(r.stdout).toBe(JSON.stringify(out, null, 2));
    expect(Object.keys(out)).toEqual(["sessions", "cockpitUp", "cockpitPort"]);
    expect(Array.isArray(out.sessions)).toBe(true);
    expect(out.cockpitUp).toBe(false);
    expect(out.cockpitPort).toBeNull();
  });
});
