#!/usr/bin/env bun
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { browserCandidates, browserStateDir, nativePlatformInput, type Platform } from "../../packages/browsers/skills/shared/platform";
import { liveInstances, resolveBinary, shutdown } from "../../packages/browsers/skills/shared/instances";

type Browser = "chrome" | "firefox";
export type CommandResult = { exitCode: number; stdout: string; stderr: string };
export type RunCommand = (argv: string[], timeoutMs: number, env?: Record<string, string | undefined>) => Promise<CommandResult>;
export type SmokeOptions = { checkPrerequisites: boolean };
export type SmokeDependencies = {
  platform: Platform;
  resolve: (name: Browser) => string;
  run: RunCommand;
  createScratch: (name: Browser) => string;
  dispose: (root: string) => void;
  read: (path: string) => Promise<Uint8Array>;
  reclaim: (name: Browser, root: string) => Promise<void>;
  report: (message: string) => void;
};

const repository = resolve(import.meta.dir, "../..");
const cli = (name: Browser) => join(repository, "packages/browsers/skills", name, "scripts", `${name}.ts`);
const diagnostic = (error: unknown) => error instanceof Error ? error.message : String(error);
const page = "data:text/html," + encodeURIComponent('<title>Smoke</title><input id=q><button id=b onclick="document.title=\'sent:\'+document.getElementById(\'q\').value;document.getElementById(\'result\').textContent=document.title">Send</button><p id=result>ready</p>');

export function parseOptions(argv: string[]): SmokeOptions {
  if (argv.length === 0) return { checkPrerequisites: false };
  if (argv.length === 1 && argv[0] === "--check-prerequisites") return { checkPrerequisites: true };
  throw new Error(`unknown arguments: ${argv.join(" ")}; usage: bun .github/scripts/browser-smoke.ts [--check-prerequisites]`);
}

export const runCommand: RunCommand = async (argv, timeoutMs, env) => {
  const child = Bun.spawn(argv, { env: { ...process.env, ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error(`child timed out after ${timeoutMs}ms: ${argv.join(" ")}\n${stderr}`);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timer);
  }
};

export async function reclaimOwned(name: Browser, root: string): Promise<void> {
  const state = browserStateDir(name, process.platform as Platform, { Q_BROWSER_STATE_DIR: root });
  const failures: string[] = [];
  for (const instance of liveInstances(state)) {
    try { await shutdown(state, instance); }
    catch (error) { failures.push(diagnostic(error)); }
  }
  if (failures.length) throw new Error(failures.join("\n"));
  if (liveInstances(state).length) throw new Error(`owned ${name} still alive; retained ${root}`);
}

const defaults: SmokeDependencies = {
  platform: process.platform as Platform,
  resolve: (name) => {
    const input = nativePlatformInput();
    return resolveBinary(name, browserCandidates(name, input), input);
  },
  run: runCommand,
  createScratch: (name) => mkdtempSync(join(repository, `.browser-smoke-${name}-`)),
  dispose: (root) => rmSync(root, { recursive: true, force: true }),
  read: async (path) => new Uint8Array(await Bun.file(path).arrayBuffer()),
  reclaim: reclaimOwned,
  report: console.log,
};

function requireSuccess(result: CommandResult, operation: string): string {
  if (result.exitCode !== 0) throw new Error(`${operation} exited ${result.exitCode}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

export async function runSmoke(options: SmokeOptions, deps: SmokeDependencies = defaults): Promise<void> {
  const required: Browser[] = deps.platform === "win32" ? ["chrome"] : ["chrome", "firefox"];
  for (const name of required) {
    try {
      const binary = deps.resolve(name);
      const version = requireSuccess(await deps.run([binary, "--version"], 10_000), `${name} version`);
      if (!/\d/.test(version)) throw new Error(`version reporting returned no measured version: ${version}`);
      deps.report(`${name}: ${binary}\nversion: ${version}`);
    } catch (error) { throw new Error(`${name} prerequisite: ${diagnostic(error)}`); }
  }
  if (options.checkPrerequisites) return;
  if (deps.platform === "win32") {
    const refusal = await deps.run([process.execPath, cli("firefox"), "open", "about:blank"], 10_000);
    if (refusal.exitCode === 0 || !`${refusal.stderr}\n${refusal.stdout}`.includes("not supported on Windows"))
      throw new Error(`Firefox refusal assertion failed (exit ${refusal.exitCode}): ${refusal.stderr}\n${refusal.stdout}`);
    deps.report("Firefox refusal on native Windows verified");
  }
  for (const name of required) {
    const root = deps.createScratch(name);
    const env = { Q_BROWSER_STATE_DIR: root };
    const invoke = (args: string[]) => deps.run([process.execPath, cli(name), ...args], 45_000, env);
    const command = async (args: string[]) => requireSuccess(await invoke(args), `${name} ${args[0]}`);
    let id: string | undefined;
    const failures: string[] = [];
    try {
      const opened = await command(["open", "--new", page]);
      const match = opened.match(new RegExp(`^(\\S+) ${name} (?:headless|headed) `));
      if (!match) throw new Error(`invalid open response: ${opened}`);
      id = match[1]!;
      const status = await command(["status", "--id", id]);
      if (!status.startsWith(`${id} ${name} `) || status.includes("unreachable:")) throw new Error(`incorrect status: ${status}`);
      await command(["type", "--id", id, "#q", "hello"]);
      await command(["click", "--id", id, "#b"]);
      await command(["wait", "--id", id, "document.title === 'sent:hello' && document.getElementById('result').textContent === 'sent:hello'", "5000"]);
      const content = await command(["eval", "--id", id, "document.title + '|' + document.getElementById('result').textContent"]);
      if (content !== "sent:hello|sent:hello") throw new Error(`incorrect page content: ${content}`);
      const missing = await invoke(["click", "--id", id, "#missing"]);
      if (missing.exitCode === 0 || !missing.stderr.includes("no such element")) throw new Error(`missing-element assertion failed: exit ${missing.exitCode}; ${missing.stderr}`);
      const output = join(root, "smoke 截圖.png");
      await command(["screenshot", "--id", id, "--output", output]);
      const bytes = await deps.read(output);
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (!signature.every((value, index) => bytes[index] === value)) throw new Error(`invalid PNG signature: ${output}`);
    } catch (error) { failures.push(`${name}: ${diagnostic(error)}`); }
    finally {
      if (id) {
        try {
          const closed = await command(["close", "--id", id]);
          if (closed !== `closed ${id}`) throw new Error(`incorrect close response: ${closed}`);
        } catch (error) { failures.push(`${name} cleanup: ${diagnostic(error)}`); }
      }
      let reclaimed = false;
      try { await deps.reclaim(name, root); reclaimed = true; }
      catch (error) { failures.push(`${name} cleanup: ${diagnostic(error)}; retained ${root}`); }
      if (reclaimed) {
        try { deps.dispose(root); }
        catch (error) { failures.push(`${name} scratch cleanup: ${diagnostic(error)}`); }
      }
    }
    if (failures.length) throw new Error(failures.join("\n"));
    deps.report(`${name}: smoke passed; owned instance ${id} closed`);
  }
}

if (import.meta.main) {
  try { await runSmoke(parseOptions(Bun.argv.slice(2))); }
  catch (error) { console.error(diagnostic(error)); process.exitCode = 1; }
}
