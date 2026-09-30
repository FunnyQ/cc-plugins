import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const source = join(import.meta.dir, "cockpit");
const binary = '#!/bin/sh\nprintf "FAKE %s %s\\n" "$COCKPIT_PLUGIN_ROOT" "$*"\n';
const os = Bun.spawnSync(["uname", "-s"]).stdout.toString().trim();
const arch = Bun.spawnSync(["uname", "-m"]).stdout.toString().trim();
const target = os === "Darwin" ? (arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin") : (arch === "x86_64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl");
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(options: { wrongHash?: boolean; missing?: boolean; delay?: number } = {}) {
  const root = mkdtempSync(join(import.meta.dir, ".test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, "monitor");
  const shim = join(plugin, "skills/cockpit/bin/cockpit");
  mkdirSync(dirname(shim), { recursive: true });
  copyFileSync(source, shim);
  chmodSync(shim, 0o755);
  mkdirSync(join(plugin, ".claude-plugin"));
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), '{"version":"9.9.9"}');
  const home = join(root, "home");
  mkdirSync(home);
  const data = join(root, "data");
  const installed = join(data, "q-lab/cockpit/bin/9.9.9/cockpit");
  let requests = 0;
  let assets = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests++;
      if (options.delay) await Bun.sleep(options.delay);
      if (options.missing) return new Response("missing", { status: 404 });
      const path = new URL(request.url).pathname;
      if (path === `/monitor-v9.9.9/cockpit-${target}`) { assets++; return new Response(binary); }
      if (path === "/monitor-v9.9.9/SHA256SUMS") {
        const hash = options.wrongHash ? "0".repeat(64) : createHash("sha256").update(binary).digest("hex");
        return new Response(`${hash}  cockpit-${target}\n`);
      }
      return new Response("missing", { status: 404 });
    },
  });
  cleanups.push(() => { server.stop(true); });
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, XDG_DATA_HOME: data, COCKPIT_HOME: join(root, "cockpit-home"), COCKPIT_RELEASE_BASE_URL: `http://127.0.0.1:${server.port}` };
  delete env.COCKPIT_BIN;
  delete env.COCKPIT_PLUGIN_ROOT;
  async function run(args: string[] = ["--version"], extra: Record<string, string> = {}, command = shim) {
    const proc = Bun.spawn([command, ...args], { env: { ...env, ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
  }
  function place(path = installed) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, binary); chmodSync(path, 0o755); return path; }
  return { root, plugin: realpathSync(plugin), shim, installed, run, place, requests: () => requests, assets: () => assets };
}

function success(result: { stdout: string; stderr: string; code: number }, plugin: string, args = "--version") {
  expect(result).toEqual({ code: 0, stdout: `FAKE ${plugin} ${args}\n`, stderr: "" });
}

test("COCKPIT_BIN exec", async () => {
  const f = fixture();
  const override = f.place(join(f.root, "override"));
  rmSync(join(f.plugin, ".claude-plugin"), { recursive: true });
  success(await f.run(["log", "two words"], { COCKPIT_BIN: override, COCKPIT_PLUGIN_ROOT: "override-root" }), "override-root", "log two words");
  expect(f.requests()).toBe(0);
});

test("Cached binary", async () => {
  const f = fixture(); f.place();
  success(await f.run(), f.plugin);
  expect(f.requests()).toBe(0);
  const versionFile = join(f.plugin, ".claude-plugin/plugin.json");
  writeFileSync(versionFile, "{}");
  expect(await f.run()).toEqual({ code: 1, stdout: "", stderr: `cockpit: cannot read version from ${versionFile}\n` });
});

test("Download + verify + install", async () => {
  const f = fixture();
  expect(existsSync(dirname(dirname(f.installed)))).toBe(false);
  success(await f.run(), f.plugin);
  expect(statSync(f.installed).mode & 0o111).not.toBe(0);
  const requests = f.requests();
  expect(requests).toBe(2);
  success(await f.run(), f.plugin);
  expect(f.requests()).toBe(requests);
});

test("Checksum mismatch", async () => {
  const f = fixture({ wrongHash: true });
  const result = await f.run();
  expect(result.code).toBe(1);
  expect(result.stderr).toBe(`cockpit: binary for 9.9.9/${target} unavailable (checksum mismatch); retry later or set COCKPIT_BIN\n`);
  expect(existsSync(f.installed)).toBe(false);
  expect(readdirSync(dirname(dirname(f.installed)))).toEqual([]);
});

test("Hook fail-soft", async () => {
  const f = fixture({ delay: 100 });
  const start = performance.now();
  expect(await f.run(["hook", "session-start"])).toEqual({ code: 0, stdout: "", stderr: "" });
  expect(performance.now() - start).toBeLessThan(1000);
  const deadline = Date.now() + 5000;
  while ((!existsSync(f.installed) || existsSync(`${dirname(f.installed)}.lock`)) && Date.now() < deadline) await Bun.sleep(25);
  expect(existsSync(f.installed)).toBe(true);
});

test("Foreground failure", async () => {
  const f = fixture({ missing: true });
  const result = await f.run();
  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(/^cockpit: binary for 9\.9\.9\/[^ ]+ unavailable \(download failed\); retry later or set COCKPIT_BIN\n$/);
});

test("Unsupported platform", async () => {
  const f = fixture();
  const stubs = join(f.root, "stubs"); mkdirSync(stubs);
  const uname = join(stubs, "uname");
  writeFileSync(uname, '#!/bin/sh\ncase "$1" in -s) echo Plan9;; -m) echo mips;; esac\n'); chmodSync(uname, 0o755);
  expect(await f.run([], { PATH: `${stubs}:${process.env.PATH}` })).toEqual({ code: 1, stdout: "", stderr: "cockpit: unsupported platform Plan9/mips\n" });
  expect(f.requests()).toBe(0);
});

test("Symlinked invocation", async () => {
  const f = fixture(); f.place();
  const link = join(f.root, "link"); mkdirSync(link);
  const direct = join(link, "cockpit"); symlinkSync("../monitor/skills/cockpit/bin/cockpit", direct);
  success(await f.run(undefined, {}, direct), f.plugin);
  const skills = join(f.root, "opencode/skills"); mkdirSync(skills, { recursive: true });
  symlinkSync(join(f.plugin, "skills/cockpit"), join(skills, "cockpit"));
  success(await f.run(undefined, {}, join(skills, "cockpit/bin/cockpit")), f.plugin);
});

test("Concurrent lock", async () => {
  const f = fixture({ delay: 300 });
  const results = await Promise.all([f.run(), f.run()]);
  for (const result of results) success(result, f.plugin);
  expect(f.assets()).toBe(1);
  rmSync(dirname(f.installed), { recursive: true });
  const lock = `${dirname(f.installed)}.lock`; mkdirSync(lock);
  const old = new Date(Date.now() - 300000); utimesSync(lock, old, old);
  success(await f.run(), f.plugin);
  expect(f.assets()).toBe(2);
  expect(existsSync(lock)).toBe(false);
  rmSync(dirname(f.installed), { recursive: true });
  mkdirSync(lock);
  const started = performance.now();
  const blocked = await f.run();
  expect(blocked).toEqual({ code: 1, stdout: "", stderr: `cockpit: binary for 9.9.9/${target} unavailable (timed out waiting for another download); retry later or set COCKPIT_BIN\n` });
  expect(performance.now() - started).toBeLessThan(31000);
  expect(f.assets()).toBe(2);
  expect(existsSync(lock)).toBe(true);
}, 35000);
