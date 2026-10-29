import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

const CHILD = `
import { homedir, tmpdir } from "node:os";
import { realpathSync } from "node:fs";
const { inherited, ...payload } = JSON.parse(await Bun.stdin.text());
const names = ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "PATH", "Path", "RUNES_FIXTURE_MARKER"];
process.stdout.write(JSON.stringify({
  env: Object.fromEntries(names.map(name => [name, process.env[name] ?? null])),
  home: payload.resolveHome ? realpathSync.native(homedir()) : null,
  tmp: realpathSync.native(tmpdir()),
  payload,
  inherited: Object.entries(inherited).every(([name, value]) => process.env[name] === value),
}));
`;

for (const homeState of ["supplied", "absent", "empty"] as const) {
  test(`a Bun child preserves ${homeState} home values, isolated temp and JSON transport`, async () => {
    const root = mkdtempSync(join(import.meta.dir, ".platform-fixture-"));
    try {
      const home = join(root, "home 空間 & %#'");
      const tmp = join(root, "temp 空間 & %#'");
      mkdirSync(home);
      mkdirSync(tmp);
      const env = { ...process.env };
      for (const name of Object.keys(env)) {
        if (
          ["HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP"].includes(
            name.toUpperCase(),
          )
        ) {
          delete env[name];
        }
      }
      if (process.platform !== "win32" && env.Path === undefined) {
        env.Path = "fixture Windows Path spelling";
      }
      if (homeState !== "absent") {
        env.HOME = homeState === "empty" ? "" : home;
        env.USERPROFILE = env.HOME;
      }
      Object.assign(env, {
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        RUNES_FIXTURE_MARKER: "inherited 空間",
      });
      const payload = {
        resolveHome: homeState === "supplied",
        runtime: {
          platform: "win32",
          wsl: false,
          home: "C:\\Users\\Q 空間",
          tmp: "C:\\Temp\\& %#'",
        },
        unc: "\\\\server\\share\\Q 空間",
        text: "quotes \" and apostrophes ' and newline\n",
      };
      const child = Bun.spawn([process.execPath, "-e", CHILD], {
        env,
        stdin: new TextEncoder().encode(
          JSON.stringify({ ...payload, inherited: env }),
        ),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      const result = JSON.parse(stdout);
      const expectedHome =
        homeState === "absent" ? null : homeState === "empty" ? "" : home;
      expect(result.env.HOME).toBe(expectedHome);
      expect(result.env.USERPROFILE).toBe(expectedHome);
      for (const name of ["TMPDIR", "TEMP", "TMP"])
        expect(result.env[name]).toBe(tmp);
      for (const name of ["PATH", "Path"]) {
        if (env[name] !== undefined || process.platform !== "win32") {
          expect(result.env[name]).toBe(env[name] ?? null);
        }
      }
      expect(result.inherited).toBe(true);
      expect(result.env.RUNES_FIXTURE_MARKER).toBe("inherited 空間");
      expect(result.home).toBe(
        homeState === "supplied" ? realpathSync.native(home) : null,
      );
      expect(result.tmp).toBe(realpathSync.native(tmp));
      expect(result.payload).toEqual(payload);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

import { childEnv, parseOperation, resolveRuntime, scratchRoot } from "./platform";
import { discoverChrome, executeOperation, openArtifact } from "./platform-cli";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CLI = join(import.meta.dir, "platform-cli.ts");
const childOperation = async (input: string, env = process.env) => {
  const child = Bun.spawn([process.execPath, CLI], {
    env: { ...env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const win = resolveRuntime("win32", { USERPROFILE: "C:\\Users\\Q 空間" }, "C:\\Temp", "");
test("runtime resolves Windows HOME and USERPROFILE without changing Unix scratch roots", () => {
  for (const HOME of [undefined, ""]) {
    const info = resolveRuntime("win32", { HOME, USERPROFILE: win.home }, win.tmp, "");
    expect(info.home).toBe(win.home);
    expect(childEnv(info)).toEqual({ HOME: win.home, USERPROFILE: win.home });
    expect(scratchRoot(info)).toBe("C:\\Temp/q-lab/runes");
  }
  expect(resolveRuntime("win32", { HOME: "D:/custom", USERPROFILE: win.home }, win.tmp, "").home).toBe("D:/custom");
  for (const platform of ["linux", "darwin"] as const)
    expect(scratchRoot(resolveRuntime(platform, { HOME: "/home/q" }, "/temp", ""))).toBe("/tmp/q-lab/runes");
  expect(resolveRuntime("linux", { HOME: "/home/q" }, "/tmp", "Microsoft kernel").wsl).toBe(true);
  expect(resolveRuntime("linux", { HOME: "/home/q", WSL_DISTRO_NAME: "Ubuntu" }, "/tmp", "").wsl).toBe(true);
  expect(() => resolveRuntime("win32", {}, win.tmp, "")).toThrow("home");
});

for (const payload of ["{", "null", "[]", '{}', '{"op":"exec","argv":["rm"]}', '{"op":"info","path":"x"}', '{"op":"mkdir","directory":""}', '{"op":"open","path":1}', '{"op":"trash","paths":[]}', '{"op":"cleanup-check","page":"x.png"}']) {
  test(`actual platform child rejects invalid input ${payload}`, async () => {
    const result = await childOperation(payload);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("runes platform:");
  });
}

test("actual platform child recursively creates hostile path data with no Unix mkdir", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".platform-fixture-"));
  try {
    const directory = join(root, "space 空間 & %#'", "nested");
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.toLowerCase() === "path") delete env[name];
    env.PATH = root;
    const result = await childOperation(JSON.stringify({ op: "mkdir", directory }), env);
    expect(result.exitCode).toBe(0);
    expect(existsSync(directory)).toBe(true);
    const failed = await childOperation(JSON.stringify({ op: "mkdir", directory: join(CLI, "child") }));
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain("mkdir");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual cleanup child removes only the two derived screenshots", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".platform-fixture-"));
  try {
    const page = join(root, "page 空間 & %#'.html");
    const base = page.slice(0, -5);
    for (const name of [page, `${base}.check.png`, `${base}.check-narrow.png`, `${base}.other.png`]) writeFileSync(name, "keep");
    const result = await childOperation(JSON.stringify({ op: "cleanup-check", page }));
    expect(result.exitCode).toBe(0);
    expect(existsSync(`${base}.check.png`)).toBe(false);
    expect(existsSync(`${base}.check-narrow.png`)).toBe(false);
    expect(readFileSync(page, "utf8")).toBe("keep");
    expect(existsSync(`${base}.other.png`)).toBe(true);
    expect((await childOperation(JSON.stringify({ op: "cleanup-check", page }))).exitCode).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("opener selection retains data and distinguishes missing commands from failed exits", async () => {
  const path = "C:\\Users\\Q 空間\\page & %#'.html";
  const calls: { argv: string[]; stdin?: string }[] = [];
  const run = async (argv: string[], stdin?: string) => { calls.push({ argv, stdin }); return { exitCode: 0, stdout: "", stderr: "" }; };
  await openArtifact(path, win, run);
  expect(calls[0]!.argv[0]).toBe("powershell.exe");
  expect(JSON.parse(calls[0]!.stdin!).path).toBe(path);
  expect(calls[0]!.argv.join(" ")).not.toContain(path);
  calls.length = 0;
  await openArtifact("C:\\Users\\Q 空間\\page.html", win, run);
  expect(calls[0]!.argv.slice(0, 5)).toEqual(["cmd.exe", "/d", "/c", "start", ""]);
  for (const platform of ["linux", "darwin"] as const) {
    calls.length = 0;
    await openArtifact(path, { ...win, platform }, run);
    expect(calls[0]!.argv).toEqual([platform === "darwin" ? "open" : "xdg-open", path]);
  }
  await expect(openArtifact("/page.html", { ...win, platform: "linux" }, async () => ({ exitCode: 7, stdout: "", stderr: "denied" }))).rejects.toThrow("exited 7: denied");
  await expect(openArtifact("/page.html", { ...win, platform: "linux" }, async () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); })).rejects.toThrow("not available");
});

test("WSL converts local paths before Windows fallback", async () => {
  const calls: { argv: string[]; stdin?: string }[] = [];
  await openArtifact("/home/q/空間 & %#'.html", { ...win, platform: "linux", wsl: true }, async (argv, stdin) => {
    calls.push({ argv, stdin });
    if (argv[0] === "wslview") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { exitCode: 0, stdout: argv[0] === "wslpath" ? "C:\\空間 & %#'.html\n" : "", stderr: "" };
  });
  expect(calls.map(c => c.argv[0])).toEqual(["wslview", "wslpath", "powershell.exe"]);
  expect(JSON.parse(calls[2]!.stdin!).path).toBe("C:\\空間 & %#'.html");
});

test("unavailable and failed trash never permanently delete a page", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".platform-fixture-"));
  try {
    const page = join(root, "page.html"); writeFileSync(page, "retain");
    const op = parseOperation(JSON.stringify({ op: "trash", paths: [page] }));
    for (const missing of [true, false]) {
      await expect(executeOperation(op, { ...win, platform: "linux" }, async () => {
        if (missing) throw Object.assign(new Error("missing"), { code: "ENOENT" });
        return { exitCode: 5, stdout: "", stderr: "recycle refused" };
      })).rejects.toThrow();
      expect(readFileSync(page, "utf8")).toBe("retain");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual info child returns the runtime snapshot and preserves supplied HOME", async () => {
  const result = await childOperation('{"op":"info"}');
  expect(result.exitCode).toBe(0);
  const info = JSON.parse(result.stdout);
  expect(info.platform).toBe(process.platform);
  expect(info.home).toBe(process.env.HOME || process.env.USERPROFILE);
  expect(info.chrome).toBe(discoverChrome());
  expect(typeof info.wsl).toBe("boolean");
  expect(typeof info.tmp).toBe("string");
});

test("actual opener process receives hostile Windows paths only on structured stdin", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".platform-fixture-"));
  try {
    const script = join(root, "receiver.ts");
    const capture = join(root, "received.json");
    writeFileSync(script, 'await Bun.write(process.env.RUNES_CAPTURE!, JSON.stringify({argv: process.argv.slice(2), stdin: await Bun.stdin.text()}));');
    const executable = process.platform === "win32" ? join(root, "powershell.exe.cmd") : join(root, "powershell.exe");
    writeFileSync(executable, process.platform === "win32"
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!${process.execPath}\n${readFileSync(script, "utf8")}`);
    if (process.platform !== "win32") {
      const { chmodSync } = await import("node:fs"); chmodSync(executable, 0o755);
    }
    const env = { ...process.env, RUNES_CAPTURE: capture };
    for (const name of Object.keys(env)) if (name.toLowerCase() === "path") delete env[name];
    env.PATH = root;
    const path = "C:\\Users\\Q 空間\\a & %#'.html";
    const code = `import {openArtifact} from ${JSON.stringify(join(import.meta.dir, "platform-cli.ts"))}; await openArtifact(${JSON.stringify(path)}, ${JSON.stringify(win)});`;
    const child = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    const received = JSON.parse(readFileSync(capture, "utf8"));
    expect(JSON.parse(received.stdin)).toEqual({ path });
    expect(received.argv).not.toContain(path);
    expect(received.argv.at(-1)).not.toContain(path);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual trash child reports missing facility and retains the page", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".platform-fixture-"));
  try {
    const page = join(root, "page 空間 & %#'.html"); writeFileSync(page, "retained");
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.toLowerCase() === "path") delete env[name];
    env.PATH = root;
    const result = await childOperation(JSON.stringify({ op: "trash", paths: [page] }), env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("runes platform:");
    expect(readFileSync(page, "utf8")).toBe("retained");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("WSL falls back after a nonzero wslview exit and preserves both failure diagnostics", async () => {
  await expect(openArtifact("/home/q/page.html", { ...win, platform: "linux", wsl: true }, async (argv) => ({
    exitCode: 4, stdout: "", stderr: argv[0] === "wslview" ? "viewer denied" : "conversion denied",
  }))).rejects.toThrow("wslview exited 4: viewer denied; Windows fallback failed: wslpath exited 4: conversion denied");
});

test("permission-denied openers are not reported as missing", async () => {
  await expect(openArtifact("/home/q/page.html", { ...win, platform: "linux" }, async () => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  })).rejects.toThrow("permission denied");
});

test("actual pasted-image child retains the missing-image diagnostic with no transcript directory", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".platform-fixture-"));
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "transcript/open-image.ts"), "missing-session", "1"], {
      env: { ...process.env, HOME: root, USERPROFILE: root },
      stdin: new TextEncoder().encode("prompt"), stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    expect((await new Response(child.stderr).text()).trim()).toBe("no image #1 in this session's transcript yet");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual opener process receives the empty Windows title and simple path as separate arguments", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(import.meta.dir, ".platform-fixture-"));
  try {
    const executable = join(root, "cmd.exe");
    const capture = join(root, "received.json");
    writeFileSync(executable, `#!${process.execPath}\nawait Bun.write(process.env.RUNES_CAPTURE!, JSON.stringify(process.argv.slice(2)));`);
    const { chmodSync } = await import("node:fs"); chmodSync(executable, 0o755);
    const env = { ...process.env, RUNES_CAPTURE: capture };
    for (const name of Object.keys(env)) if (name.toLowerCase() === "path") delete env[name];
    env.PATH = root;
    const path = "C:\\Users\\Q 空間\\page #'.html";
    const code = `import {openArtifact} from ${JSON.stringify(join(import.meta.dir, "platform-cli.ts"))}; await openArtifact(${JSON.stringify(path)}, ${JSON.stringify(win)});`;
    const child = Bun.spawn([process.execPath, "-e", code], { env, stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual(["/d", "/c", "start", "", path]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const home of [undefined, ""]) {
  test(`actual info child handles ${home === undefined ? "absent" : "empty"} HOME explicitly`, async () => {
    const env = { ...process.env, USERPROFILE: "C:\\Users\\Q 空間" };
    for (const name of Object.keys(env)) if (name.toUpperCase() === "HOME") delete env[name];
    if (home !== undefined) env.HOME = home;
    const result = await childOperation('{"op":"info"}', env);
    if (process.platform === "win32") {
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).home).toBe(env.USERPROFILE);
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("could not resolve home");
    }
  });
}

test("Chrome discovery uses the platform order and environment roots", () => {
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  expect(discoverChrome("darwin", {}, path => path === mac)).toBe(mac);
  expect(discoverChrome("darwin", {}, () => false)).toBeNull();
  const env = { ProgramFiles: "D:\\Apps", "ProgramFiles(x86)": "E:\\Apps", LOCALAPPDATA: "F:\\Q Space" };
  const candidates = Object.values(env).map(root => root + "\\Google\\Chrome\\Application\\chrome.exe");
  for (let first = 0; first < candidates.length; first++) {
    expect(discoverChrome("win32", env, path => candidates.slice(first).includes(path))).toBe(candidates[first]);
  }
  expect(discoverChrome("win32", env, () => false)).toBeNull();
  expect(discoverChrome("win32", {}, () => true)).toBeNull();
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (let first = 0; first < names.length; first++) {
    const tried: string[] = [];
    expect(discoverChrome("linux", { WSL_DISTRO_NAME: "Ubuntu", ...env }, () => true, name => {
      tried.push(name);
      return names.indexOf(name) >= first ? "/usr/bin/" + name : null;
    })).toBe("/usr/bin/" + names[first]);
    expect(tried).toEqual(names.slice(0, first + 1));
  }
  expect(discoverChrome("linux", env, () => true, () => null)).toBeNull();
  expect(discoverChrome("linux", env, () => true, () => "/mnt/c/chrome.exe")).toBeNull();
});

import { parseScreenshotArgs, takeScreenshot } from "./explain/checker-cli";
import { pathToFileURL } from "node:url";

test("screenshot helper accepts exactly one mode and one HTML page", () => {
  for (const args of [[], ["wide"], ["other", "page.html"], ["wide", "page.png"], ["wide", "page.html", "extra"], ["wide", ""], ["wide", "page.html\0"]]) {
    expect(() => parseScreenshotArgs(args)).toThrow();
  }
  expect(parseScreenshotArgs(["wide", "page.html"])).toEqual({ mode: "wide", page: "page.html" });
  expect(parseScreenshotArgs(["narrow", "page.html"])).toEqual({ mode: "narrow", page: "page.html" });
});

test("screenshot helper encodes the URL, derives outputs and removes profiles after exit", async () => {
  for (const mode of ["wide", "narrow"] as const) {
    const page = join(import.meta.dir, "page 空間 & %#'.html");
    let profile = "";
    const output = await takeScreenshot({ mode, page }, () => "/chrome", async argv => {
      expect(argv[0]).toBe("/chrome");
      expect(argv).toContain("--window-size=" + (mode === "wide" ? "1280,4000" : "420,7000"));
      expect(argv.at(-1)).toBe(pathToFileURL(page).href);
      profile = argv.find(arg => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
      expect(existsSync(profile)).toBe(true);
      const output = page.replace(/\.html$/, mode === "wide" ? ".check.png" : ".check-narrow.png");
      expect(argv).toContain("--screenshot=" + output);
      return 0;
    });
    expect(output).toBe(page.replace(/\.html$/, mode === "wide" ? ".check.png" : ".check-narrow.png"));
    expect(existsSync(profile)).toBe(false);
  }
});

test("screenshot helper reports failure and removes profiles on nonzero exit or spawn failure", async () => {
  for (const throws of [false, true]) {
    let profile = "";
    await expect(takeScreenshot({ mode: "wide", page: "page.html" }, () => "/chrome", async argv => {
      profile = argv.find(arg => arg.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
      if (throws) throw new Error("spawn refused");
      return 7;
    })).rejects.toThrow(throws ? "spawn refused" : "Chrome exited 7");
    expect(existsSync(profile)).toBe(false);
  }
  await expect(takeScreenshot({ mode: "wide", page: "page.html" }, () => null)).rejects.toThrow("no Chrome");
});

test("actual screenshot CLI rejects invalid arguments with a diagnostic and no stdout", async () => {
  for (const args of [[], ["wide"], ["unknown", "page.html"], ["wide", "page.png"], ["narrow", "page.html", "extra"]]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "explain/checker-cli.ts"), ...args], {
      stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("runes checker: expected wide|narrow and one .html page");
  }
});
