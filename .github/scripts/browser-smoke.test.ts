import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { newProfile, recordInstance, shutdown, isAlive, type Instance } from "../../packages/browsers/skills/shared/instances";
import { browserStateDir } from "../../packages/browsers/skills/shared/platform";
import { parseOptions, runSmoke, runCommand, reclaimOwned, type SmokeDependencies, type CommandResult } from "./browser-smoke";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function fixture(platform: "darwin" | "linux" | "win32" = "linux") {
  const calls: { argv: string[]; root?: string; timeout: number }[] = [];
  const disposed: string[] = [];
  const reclaimed: string[] = [];
  const messages: string[] = [];
  const owned = new Map<string, string[]>();
  const unrelated = ["unrelated-concurrent-id"];
  let leaf = 0;
  let intercept: (argv: string[], root?: string) => CommandResult | undefined = () => undefined;
  const deps: SmokeDependencies = {
    platform,
    resolve: (name) => `/native/${name}`,
    run: async (argv, timeout, env) => {
      const root = env?.Q_BROWSER_STATE_DIR;
      calls.push({ argv, root, timeout });
      const result = intercept(argv, root);
      if (result) return result;
      if (argv[1] === "--version") return ok(`${argv[0]} 123.4`);
      if (argv[0] === "powershell.exe") return ok("123.4");
      const command = argv[2];
      const name = argv[1]!.includes("chrome") ? "chrome" : "firefox";
      if (command === "open") {
        if (platform === "win32" && name === "firefox")
          return { exitCode: 1, stdout: "", stderr: "firefox not supported on Windows" };
        owned.set(root!, [`${name}-owned`]);
        return ok(`${name}-owned ${name} headless data:text/html Smoke`);
      }
      if (command === "status") return ok(`${name}-owned ${name} headless Smoke`);
      if (command === "eval") return ok("sent:hello|sent:hello");
      if (command === "click" && argv.at(-1) === "#missing")
        return { exitCode: 1, stdout: "", stderr: "no such element: #missing" };
      if (command === "close") { owned.delete(root!); return ok(`closed ${name}-owned`); }
      return ok();
    },
    createScratch: (name) => join(process.cwd(), `.smoke-fixture-${name}-${++leaf}`),
    dispose: (root) => { disposed.push(root); },
    read: async () => png,
    reclaim: async (_name, root) => {
      reclaimed.push(...(owned.get(root) ?? []));
      owned.delete(root);
    },
    report: (message) => { messages.push(message); },
  };
  return { deps, calls, disposed, reclaimed, messages, owned, unrelated,
    intercept: (fn: typeof intercept) => { intercept = fn; } };
}

const normal = { checkPrerequisites: false };
describe("required browser smoke", () => {
  test("rejects unknown and repeated flags", () => {
    expect(parseOptions([])).toEqual(normal);
    expect(parseOptions(["--check-prerequisites"])).toEqual({ checkPrerequisites: true });
    expect(() => parseOptions(["--skip-firefox"])).toThrow("unknown");
    expect(() => parseOptions(["--check-prerequisites", "--check-prerequisites"])).toThrow();
  });
  for (const missing of ["chrome", "firefox"]) {
    test(`missing ${missing} fails before any launch`, async () => {
      const f = fixture();
      f.deps.resolve = (name) => { if (name === missing) throw new Error(`no ${name} found`); return `/native/${name}`; };
      await expect(runSmoke(normal, f.deps)).rejects.toThrow(missing);
      expect(f.calls.every(({ argv }) => argv[1] === "--version")).toBe(true);
      expect(f.disposed).toEqual([]);
    });
  }
  for (const result of [{ exitCode: 1, stdout: "", stderr: "version unavailable" }, ok("")]) {
    test("failed or empty version fails preflight", async () => {
      const f = fixture();
      f.intercept((argv) => argv[1] === "--version" ? result : undefined);
      await expect(runSmoke(normal, f.deps)).rejects.toThrow("chrome");
      expect(f.calls).toHaveLength(1);
    });
  }
  test("Windows reads Chrome's version from the executable, since chrome.exe --version opens a browser", async () => {
    const f = fixture("win32");
    f.intercept((argv) => argv[0] === "powershell.exe" ? ok("156.0.8078.48") : undefined);
    await runSmoke({ checkPrerequisites: true }, f.deps);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.argv).not.toContain("--version");
    expect(f.calls[0]!.argv.at(-1)).toContain("VersionInfo.ProductVersion");
    expect(f.messages.join("\n")).toContain("/native/chrome\nversion: 156.0.8078.48");
  });
  test("preflight reports selected paths and measured versions without opening", async () => {
    const f = fixture();
    await runSmoke({ checkPrerequisites: true }, f.deps);
    expect(f.calls).toHaveLength(2);
    expect(f.messages.join("\n")).toContain("/native/firefox 123.4");
    expect(f.disposed).toEqual([]);
  });
  test("separate bounded CLI commands reuse returned ids and private roots", async () => {
    const f = fixture();
    await runSmoke(normal, f.deps);
    for (const name of ["chrome", "firefox"]) {
      const calls = f.calls.filter(({ argv }) => argv[1]?.endsWith(`${name}.ts`));
      expect(calls.map(({ argv }) => argv[2])).toEqual(["open", "status", "type", "click", "wait", "eval", "click", "screenshot", "close"]);
      expect(calls[0]!.argv).toContain("--new");
      for (const call of calls.slice(1)) {
        expect(call.argv).toContain(`${name}-owned`);
        expect(call.root).toBe(calls[0]!.root);
        expect(call.timeout).toBeGreaterThan(0);
      }
      const shot = calls.find(({ argv }) => argv[2] === "screenshot")!.argv.at(-1)!;
      expect(shot).toContain("smoke 截圖.png");
    }
    expect(f.disposed).toHaveLength(2);
    expect(f.unrelated).toEqual(["unrelated-concurrent-id"]);
  });
  test("Windows checks Firefox refusal once without requiring its binary", async () => {
    const f = fixture("win32");
    f.deps.resolve = (name) => { expect(name).toBe("chrome"); return "/native/chrome"; };
    await runSmoke(normal, f.deps);
    expect(f.calls.filter(({ argv }) => argv[1]?.endsWith("firefox.ts"))).toHaveLength(1);
  });
  for (const refusal of [ok("not supported on Windows"), { exitCode: 1, stdout: "", stderr: "other error" }]) {
    test("wrong Windows refusal fails", async () => {
      const f = fixture("win32");
      f.intercept((argv) => argv[1]?.endsWith("firefox.ts") ? refusal : undefined);
      await expect(runSmoke(normal, f.deps)).rejects.toThrow("Firefox refusal");
    });
  }
  for (const command of ["open", "status", "type", "click", "wait", "eval", "screenshot", "close"]) {
    test(`${command} failure propagates stderr and cleans owned state`, async () => {
      const f = fixture();
      f.intercept((argv) => argv[2] === command ? { exitCode: 7, stdout: "", stderr: `${command} broken` } : undefined);
      await expect(runSmoke(normal, f.deps)).rejects.toThrow(`${command} broken`);
      expect(f.disposed).toHaveLength(1);
      expect(f.calls.every(({ argv }) => !argv.includes("unrelated-concurrent-id"))).toBe(true);
    });
  }
  for (const command of ["open", "status", "eval", "close"]) {
    test(`incorrect ${command} content fails`, async () => {
      const f = fixture();
      f.intercept((argv) => argv[2] === command ? ok("incorrect") : undefined);
      await expect(runSmoke(normal, f.deps)).rejects.toThrow();
    });
  }
  test("missing-element click must fail with its expected diagnostic", async () => {
    const f = fixture();
    f.intercept((argv) => argv.at(-1) === "#missing" ? ok() : undefined);
    await expect(runSmoke(normal, f.deps)).rejects.toThrow("missing-element");
  });
  test("invalid PNG fails and closes instance", async () => {
    const f = fixture();
    f.deps.read = async () => new Uint8Array([137, 80, 78, 71]);
    await expect(runSmoke(normal, f.deps)).rejects.toThrow("PNG");
    expect(f.calls.at(-1)!.argv[2]).toBe("close");
  });
  test("primary action diagnostic survives close and reclamation failures; root retained", async () => {
    const f = fixture();
    f.intercept((argv) => ["type", "close"].includes(argv[2]!) ? { exitCode: 1, stdout: "", stderr: `${argv[2]} broken` } : undefined);
    f.deps.reclaim = async () => { throw new Error("still alive; profile retained"); };
    await expect(runSmoke(normal, f.deps)).rejects.toThrow(/type broken[\s\S]*close broken[\s\S]*profile retained/);
    expect(f.disposed).toEqual([]);
  });
  test("registration before id timeout reclaims private records only during concurrent launch", async () => {
    const f = fixture();
    f.intercept((argv, root) => {
      if (argv[2] === "open") {
        f.owned.set(root!, ["provisional-owned"]);
        f.unrelated.push("concurrent-new-browser");
        throw new Error("timed out after registration; stderr: readiness stalled");
      }
    });
    await expect(runSmoke(normal, f.deps)).rejects.toThrow("timed out after registration");
    expect(f.reclaimed).toEqual(["provisional-owned"]);
    expect(f.unrelated).toEqual(["unrelated-concurrent-id", "concurrent-new-browser"]);
    expect(f.calls.some(({ argv }) => argv[2] === "close")).toBe(false);
    expect(f.disposed).toHaveLength(1);
  });
  test("action timeout retains diagnostics and still closes the returned id", async () => {
    const f = fixture();
    f.intercept((argv) => {
      if (argv[2] === "wait") throw new Error("wait timed out; stderr: stalled action");
    });
    await expect(runSmoke(normal, f.deps)).rejects.toThrow("stalled action");
    expect(f.calls.at(-1)!.argv).toContain("chrome-owned");
    expect(f.calls.at(-1)!.argv[2]).toBe("close");
    expect(f.disposed).toHaveLength(1);
  });
  for (const missing of ["chrome", "firefox"]) {
    test(`preflight-only also rejects missing ${missing}`, async () => {
      const f = fixture();
      f.deps.resolve = (name) => { if (name === missing) throw new Error(`no ${name} found`); return `/native/${name}`; };
      await expect(runSmoke({ checkPrerequisites: true }, f.deps)).rejects.toThrow(missing);
      expect(f.calls.every(({ argv }) => argv[1] === "--version")).toBe(true);
    });
  }
  test("native lifecycle reclaims a provisional process while concurrent unrelated process survives", async () => {
    const root = mkdtempSync(join(process.cwd(), ".smoke-ownership-"));
    const privateRoot = join(root, "private");
    const unrelatedRoot = join(root, "unrelated");
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const launch = (state: string): Instance => {
      const { id, profile } = newProfile(state);
      const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)", "--", `--user-data-dir=${profile}`], { stdout: "ignore", stderr: "ignore", detached: true });
      children.push(child);
      const instance = { id, profile, pid: child.pid, port: 0, browser: "chrome", headless: true };
      recordInstance(state, instance);
      return instance;
    };
    const privateState = browserStateDir("chrome", process.platform as "darwin" | "linux" | "win32", { Q_BROWSER_STATE_DIR: privateRoot });
    const unrelatedState = browserStateDir("chrome", process.platform as "darwin" | "linux" | "win32", { Q_BROWSER_STATE_DIR: unrelatedRoot });
    let owned: Instance | undefined;
    let unrelated: Instance | undefined;
    const f = fixture();
    f.deps.createScratch = () => privateRoot;
    f.deps.reclaim = reclaimOwned;
    f.deps.dispose = (path) => rmSync(path, { recursive: true, force: true });
    f.deps.run = async (argv) => {
      if (argv[1] === "--version") return ok("Browser 123.4");
      owned = launch(privateState);
      unrelated = launch(unrelatedState);
      await runCommand([process.execPath, "-e", 'console.error("registered before id"); setInterval(() => {}, 1000)'], 2000);
      throw new Error("expected timeout");
    };
    try {
      await expect(runSmoke(normal, f.deps)).rejects.toThrow("registered before id");
      expect(isAlive(owned!.pid)).toBe(false);
      expect(existsSync(privateRoot)).toBe(false);
      expect(isAlive(unrelated!.pid)).toBe(true);
      expect(existsSync(unrelated!.profile)).toBe(true);
    } finally {
      for (const [state, instance] of [[privateState, owned], [unrelatedState, unrelated]] as const) {
        if (instance && existsSync(instance.profile)) await shutdown(state, instance);
      }
      await Promise.all(children.map((child) => child.exited));
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
  test("real child timeout terminates and awaits the CLI, retaining stderr", async () => {
    await expect(runCommand([process.execPath, "-e", 'console.error("stalled child"); setInterval(() => {}, 1000)'], 150)).rejects.toThrow(/timed out[\s\S]*stalled child/);
  });
});
