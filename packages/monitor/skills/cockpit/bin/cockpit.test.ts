import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const source = join(import.meta.dir, "cockpit");
const binary = '#!/bin/sh\nprintf "FAKE %s %s\\n" "$COCKPIT_PLUGIN_ROOT" "$*"\n';
const os = Bun.spawnSync(["uname", "-s"]).stdout.toString().trim();
const arch = Bun.spawnSync(["uname", "-m"]).stdout.toString().trim();
const target = os === "Darwin" ? (arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin") : (arch === "x86_64" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl");
const crate = join(import.meta.dir, "../../../cockpit-rs");
const releaseScript = join(crate, "scripts/build-release.sh");
const hasCargo = Bun.spawnSync(["sh", "-c", "command -v cargo"]).exitCode === 0;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture(options: { wrongHash?: boolean; missing?: boolean; delay?: number; assetDelay?: number; version?: string; assetsDir?: string } = {}) {
  const version = options.version ?? "9.9.9";
  const root = mkdtempSync(join(import.meta.dir, ".test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const plugin = join(root, "monitor");
  const shim = join(plugin, "skills/cockpit/bin/cockpit");
  mkdirSync(dirname(shim), { recursive: true });
  copyFileSync(source, shim);
  chmodSync(shim, 0o755);
  mkdirSync(join(plugin, ".claude-plugin"));
  writeFileSync(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ version }));
  const home = join(root, "home");
  mkdirSync(home);
  const data = join(root, "data");
  const installed = join(data, `q-lab/cockpit-bin/${version}/cockpit`);
  let requests = 0;
  let assets = 0;
  const ranges: (string | null)[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 60,
    async fetch(request) {
      requests++;
      if (options.delay) await Bun.sleep(options.delay);
      if (options.missing) return new Response("missing", { status: 404 });
      const path = new URL(request.url).pathname;
      if (options.assetsDir && path.startsWith(`/monitor-v${version}/`)) {
        const name = path.slice(`/monitor-v${version}/`.length);
        if (name === `cockpit-${target}` || name === "SHA256SUMS") return new Response(Bun.file(join(options.assetsDir, name)));
      }
      if (path === `/monitor-v${version}/cockpit-${target}`) {
        assets++;
        const range = request.headers.get("range");
        ranges.push(range);
        if (options.assetDelay) await Bun.sleep(options.assetDelay);
        const from = Number(range?.match(/^bytes=(\d+)-$/)?.[1] ?? 0);
        return from ? new Response(binary.slice(from), { status: 206, headers: { "content-range": `bytes ${from}-${binary.length - 1}/${binary.length}` } }) : new Response(binary);
      }
      if (path === `/monitor-v${version}/SHA256SUMS`) {
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
  return { root, plugin: realpathSync(plugin), shim, installed, run, place, requests: () => requests, assets: () => assets, ranges };
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
  // The binary migrates a legacy ~/.cockpit only while the XDG cockpit home is absent.
  expect(existsSync(join(f.root, "data/q-lab/cockpit"))).toBe(false);
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

test("Resume partial download", async () => {
  const f = fixture();
  mkdirSync(dirname(dirname(f.installed)), { recursive: true });
  writeFileSync(`${dirname(f.installed)}.part`, binary.slice(0, 10));
  success(await f.run(), f.plugin);
  expect(f.ranges).toEqual(["bytes=10-"]);
  expect(existsSync(`${dirname(f.installed)}.part`)).toBe(false);
});

test("Background download outlives the foreground deadline", async () => {
  const f = fixture({ assetDelay: 31000 });
  expect(await f.run(["hook", "session-start"])).toEqual({ code: 0, stdout: "", stderr: "" });
  const deadline = Date.now() + 40000;
  while (!existsSync(f.installed) && Date.now() < deadline) await Bun.sleep(100);
  expect(existsSync(f.installed)).toBe(true);
}, 45000);

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
  writeFileSync(uname, '#!/bin/sh\ncase "$1" in -s) echo Plan9;; -m) echo mips;; -sm) echo Plan9 mips;; esac\n'); chmodSync(uname, 0o755);
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
  const old = new Date(Date.now() - 720000); utimesSync(lock, old, old);
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

// musl build needs cargo-zigbuild; covered by CI.
test.skipIf(!hasCargo || os !== "Darwin")("release script assets are shim-compatible", async () => {
  const version = readFileSync(join(crate, "Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)![1]!;
  const assetsDir = mkdtempSync(join(import.meta.dir, ".test-assets-"));
  cleanups.push(() => rmSync(assetsDir, { recursive: true, force: true }));
  for (const args of [[target, assetsDir], ["--sums", assetsDir]]) {
    const proc = Bun.spawn([releaseScript, ...args], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited, stderr).toBe(0);
  }
  const f = fixture({ version, assetsDir });
  const result = await f.run();
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain(version);
}, 180000);

test.skipIf(!hasCargo)("release version entries preserve Cargo.lock for --locked builds", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".test-bump-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cpSync(crate, root, { recursive: true, filter: (path) => path !== join(crate, "target") });
  const config = JSON.parse(readFileSync(join(crate, "../../../.chronicle/release.json"), "utf8"));
  const entries = config.components.find((component: { name: string }) => component.name === "monitor").versionFiles;
  const nextVersion = "99.0.0";
  for (const name of ["Cargo.toml", "Cargo.lock"]) {
    const entry = entries.find((file: { path: string }) => file.path === `packages/monitor/cockpit-rs/${name}`);
    expect(entry).toBeDefined();
    const path = join(root, name);
    const before = readFileSync(path, "utf8");
    if (name === "Cargo.toml") {
      expect(entry.kind).toBe("toml");
      writeFileSync(path, before.replace(/^version = "[^"]+"/m, `version = "${nextVersion}"`));
    } else {
      // A name anchor prevents bumping dependency versions in Cargo.lock.
      expect(entry.kind).toBeUndefined();
      const pattern = new RegExp(entry.pattern);
      const match = before.match(pattern);
      expect(match).not.toBeNull();
      const after = before.replace(pattern, match![0].replace(match![1]!, nextVersion));
      expect(after.replace(`name = "cockpit"\nversion = "${nextVersion}"`, match![0])).toBe(before);
      writeFileSync(path, after);
    }
  }
  const proc = Bun.spawn(["cargo", "build", "--locked", "--manifest-path", join(root, "Cargo.toml")], {
    env: { ...process.env, CARGO_TARGET_DIR: join(crate, "target") }, stdout: "pipe", stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited, stderr).toBe(0);
}, 180000);
