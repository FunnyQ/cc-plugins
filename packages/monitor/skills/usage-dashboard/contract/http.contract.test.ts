// Black-box HTTP surface of `atlas serve` (contracts.md §2), run against whichever
// server atlasCommand() selects.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { isRust } from "./launcher.ts";
import {
  FIXTURE_IDS,
  STUB_PATHS,
  freePort,
  makeFixtureHome,
} from "./fixtures.ts";
import { rawGet, startAtlas, type AtlasProc } from "./serve.ts";

type Fixture = Awaited<ReturnType<typeof makeFixtureHome>>;

const DIST = join(import.meta.dir, "..", "dashboard", "dist");
const STATS_KEYS = [
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
];
const STATS_ETAG = /^W\/"[^-"]+-\d+:\d+(\.\d+)?"$/;
const JSON_TYPE = "application/json; charset=utf-8";

// One fixture home plus one server; torn down by the describe's afterAll.
function useServer(prepare?: (fx: Fixture) => void | Promise<void>) {
  const ctx = {} as { fx: Fixture; atlas: AtlasProc; base: string };
  beforeAll(async () => {
    ctx.fx = await makeFixtureHome();
    await prepare?.(ctx.fx);
    ctx.atlas = await startAtlas(ctx.fx.env, await freePort());
    ctx.base = `http://127.0.0.1:${ctx.atlas.port}`;
  });
  afterAll(async () => {
    await ctx.atlas?.stop();
    await ctx.fx?.cleanup();
  });
  return ctx;
}

const gzipGet = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    headers: { "Accept-Encoding": "gzip", ...headers },
    decompress: false,
  });
const plainGet = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, {
    headers: { "Accept-Encoding": "identity", ...headers },
    decompress: false,
  });

describe("/api/stats", () => {
  const ctx = useServer();

  test("gzip: 200 with the 19 top-level keys on the wire", async () => {
    const res = await gzipGet(`${ctx.base}/api/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("content-type")).toBe(JSON_TYPE);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const raw = new Uint8Array(await res.arrayBuffer());
    const body = JSON.parse(new TextDecoder().decode(Bun.gunzipSync(raw)));
    expect(Object.keys(body)).toEqual(STATS_KEYS);
  });

  test("plain: no Content-Encoding, JSON body", async () => {
    const res = await plainGet(`${ctx.base}/api/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toBe(JSON_TYPE);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(Object.keys(await res.json())).toEqual(STATS_KEYS);
  });

  test("ETag shape, stability, and 304", async () => {
    const a = (await plainGet(`${ctx.base}/api/stats`)).headers.get("etag")!;
    const b = (await plainGet(`${ctx.base}/api/stats`)).headers.get("etag")!;
    expect(a).toMatch(STATS_ETAG);
    expect(b).toBe(a);
    const res = await plainGet(`${ctx.base}/api/stats`, {
      "If-None-Match": a,
    });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("etag")).toBe(a);
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
  });

  test("touching a transcript changes the ETag", async () => {
    const before = (await plainGet(`${ctx.base}/api/stats`)).headers.get(
      "etag",
    );
    const transcript = join(
      ctx.fx.home,
      ".claude",
      "projects",
      "-work-proj-a",
      `${FIXTURE_IDS.claudeSessionA}.jsonl`,
    );
    writeFileSync(transcript, readFileSync(transcript));
    const later = Date.now() / 1000 + 60;
    utimesSync(transcript, later, later);
    const after = (await plainGet(`${ctx.base}/api/stats`)).headers.get("etag");
    expect(after).toMatch(STATS_ETAG);
    expect(after).not.toBe(before);
  });
});

describe("/api/stats BOOT_ID", () => {
  let fx: Fixture;
  let atlas: AtlasProc | undefined;
  beforeAll(async () => {
    fx = await makeFixtureHome();
  });
  afterEach(async () => {
    await atlas?.stop();
    atlas = undefined;
  });
  afterAll(async () => {
    await fx.cleanup();
  });

  test("two launches over the same files give different ETags", async () => {
    const etags: string[] = [];
    for (let i = 0; i < 2; i++) {
      atlas = await startAtlas(fx.env, await freePort());
      const res = await plainGet(`http://127.0.0.1:${atlas.port}/api/stats`);
      etags.push(res.headers.get("etag")!);
      await atlas.stop();
      atlas = undefined;
    }
    expect(etags[0]).toMatch(STATS_ETAG);
    expect(etags[1]).toMatch(STATS_ETAG);
    expect(etags[0]).not.toBe(etags[1]);
  });
});

async function liveOf(base: string) {
  const res = await gzipGet(`${base}/api/live`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe(JSON_TYPE);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("content-encoding")).toBeNull();
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(
    ["cockpitPort", "cockpitUp", "sessions"].sort(),
  );
  expect(Array.isArray(body.sessions)).toBe(true);
  return body as { cockpitUp: boolean; cockpitPort: number | null };
}

// The live module caches daemon.json for 5 s on the pinned clock, so each state gets its own server.
const writeDaemon = (fx: Fixture, pid: number) =>
  writeFileSync(
    join(fx.env.COCKPIT_HOME, "daemon.json"),
    JSON.stringify({ pid, port: 5999, token: "t", root: "/x" }),
  );

describe("/api/live with a live daemon pid", () => {
  const ctx = useServer((fx) => writeDaemon(fx, process.pid));
  test("cockpitUp true, cockpitPort from daemon.json", async () => {
    const body = await liveOf(ctx.base);
    expect(body.cockpitUp).toBe(true);
    expect(body.cockpitPort).toBe(5999);
  });
});

describe("/api/live with a dead daemon pid", () => {
  const ctx = useServer(async (fx) => {
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeDaemon(fx, dead.pid);
  });
  test("cockpitUp false, cockpitPort null", async () => {
    const body = await liveOf(ctx.base);
    expect(body.cockpitUp).toBe(false);
    expect(body.cockpitPort).toBeNull();
  });
});

describe("/api/live with no daemon.json", () => {
  const ctx = useServer();
  test("cockpitUp false, cockpitPort null", async () => {
    const body = await liveOf(ctx.base);
    expect(body.cockpitUp).toBe(false);
    expect(body.cockpitPort).toBeNull();
  });
});

const REFRESH_KEYS = [
  "ok",
  "openRouterError",
  "overridePath",
  "resolved",
  "unresolved",
  "writtenCount",
];

// Tests run in file order: the OpenRouter 500 and the corrupt override stay forced once set.
describe("POST /api/pricing/refresh", () => {
  const ctx = useServer();
  const overrideFile = () =>
    join(ctx.fx.home, ".config", "cc-dashboard", "pricing.json");
  const refresh = (body?: string) =>
    fetch(`${ctx.base}/api/pricing/refresh`, {
      method: "POST",
      ...(body === undefined
        ? {}
        : { body, headers: { "Content-Type": "application/json" } }),
    });

  test("models body: resolves, drops non-strings, writes the override", async () => {
    const res = await refresh(
      JSON.stringify({ models: ["claude:claude-opus-4-7", 42] }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(REFRESH_KEYS);
    expect(body.ok).toBe(true);
    expect(body.openRouterError).toBeNull();
    expect(body.resolved).toEqual([
      { model: "claude:claude-opus-4-7", key: "claude-opus-4-7" },
    ]);
    expect(body.unresolved).toEqual([]);
    expect(body.writtenCount).toBe(1);
    expect(body.overridePath.startsWith("~")).toBe(true);
    const text = readFileSync(overrideFile(), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const written = JSON.parse(text);
    expect(Object.keys(written)).toEqual(["models"]);
    expect(written.models["claude-opus-4-7"]).toBeDefined();
  });

  test("no body: derives the model list, 200 ok", async () => {
    const res = await refresh();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(REFRESH_KEYS);
    expect(body.ok).toBe(true);
  });

  test("OpenRouter 500 is recorded, not thrown", async () => {
    ctx.fx.stub.respondWith(STUB_PATHS.openRouter, 500, "{}");
    const res = await refresh(
      JSON.stringify({ models: ["claude:claude-opus-4-7"] }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.openRouterError).toBe("HTTP 500");
  });

  test("corrupt override file: 500 Override unreadable", async () => {
    writeFileSync(overrideFile(), "{not json");
    const res = await refresh(
      JSON.stringify({ models: ["claude:claude-opus-4-7"] }),
    );
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["error"]);
    expect(body.error.startsWith("Override unreadable: ")).toBe(true);
  });
});

describe("static files", () => {
  const ctx = useServer();

  test("/ serves dist/index.html", async () => {
    const res = await plainGet(`${ctx.base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(
      readFileSync(join(DIST, "index.html"), "utf8"),
    );
  });

  test("JavaScript MIME", async () => {
    const res = await plainGet(`${ctx.base}/vendor/petite-vue.es.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/javascript; charset=utf-8",
    );
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  for (const path of [
    "/assets/dashboard-bg-dawn.jpg",
    "/fonts/fraunces-variable.woff2",
  ]) {
    test(`${path} is never gzipped`, async () => {
      const res = await gzipGet(`${ctx.base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("etag")).not.toContain("-gz");
    });
  }

  test("/app.js gzip ETag carries -gz, plain does not", async () => {
    const gz = await gzipGet(`${ctx.base}/app.js`);
    expect(gz.status).toBe(200);
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gz.headers.get("cache-control")).toBe("no-cache");
    expect(gz.headers.get("etag")!.endsWith('-gz"')).toBe(true);
    const plain = await plainGet(`${ctx.base}/app.js`);
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("etag")).not.toContain("-gz");
  });

  test("If-None-Match on a static ETag → 304", async () => {
    const etag = (await plainGet(`${ctx.base}/app.js`)).headers.get("etag")!;
    const res = await plainGet(`${ctx.base}/app.js`, { "If-None-Match": etag });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
  });

  for (const path of [
    "/../package.json",
    "/%2e%2e/package.json",
    "/missing.js",
  ]) {
    test(`${path} → 404 Not found`, async () => {
      const res = await rawGet(ctx.atlas.port, path);
      expect(res.status).toBe(404);
      expect(res.body).toBe("Not found");
    });
  }
});

describe("concurrency", () => {
  let fx: Fixture;
  let atlas: AtlasProc | undefined;
  let tmp: string;
  afterAll(async () => {
    await atlas?.stop();
    await fx?.cleanup();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  // Skipped for TS: it builds stats synchronously on its one event loop, so /api/live blocks behind it.
  test.skipIf(!isRust())("live answers during a stats build", async () => {
    fx = await makeFixtureHome();
    tmp = mkdtempSync(join(tmpdir(), "atlas-barrier-"));
    const barrier = join(tmp, "barrier");
    atlas = await startAtlas(
      { ...fx.env, TOKEN_ATLAS_TEST_BUILD_BARRIER: barrier },
      await freePort(),
    );
    const base = `http://127.0.0.1:${atlas.port}`;
    let statsDone = false;
    const stats = fetch(`${base}/api/stats`).then((r) => {
      statsDone = true;
      return r;
    });
    const deadline = Date.now() + 10_000;
    while (!existsSync(`${barrier}.entered`)) {
      if (Date.now() > deadline) throw new Error("build never entered");
      await Bun.sleep(10);
    }
    const t0 = performance.now();
    const live = await fetch(`${base}/api/live`);
    const elapsed = performance.now() - t0;
    expect(live.status).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    expect(statsDone).toBe(false);
    mkdirSync(tmp, { recursive: true });
    writeFileSync(barrier, "");
    expect((await stats).status).toBe(200);
  });
});
