import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { atlasCommand, isRust, type AtlasSub } from "./launcher";

const SCRIPTS = resolve(import.meta.dir, "../scripts");
const SUBS: Array<[AtlasSub, string]> = [
  ["serve", "atlas-server.ts"],
  ["stats", "api.ts"],
  ["live", "live.ts"],
  ["rollup-update", "rollup-update.ts"],
  ["statusline", "statusline-collector.ts"],
  ["push-usage", "push-usage.ts"],
];

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.COCKPIT_BIN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.COCKPIT_BIN;
  else process.env.COCKPIT_BIN = saved;
});

describe("atlas launcher", () => {
  test("unset COCKPIT_BIN maps each subcommand to its TS script", () => {
    delete process.env.COCKPIT_BIN;
    expect(isRust()).toBe(false);
    for (const [sub, script] of SUBS) {
      const argv = atlasCommand(sub, ["--flag", "value"]);
      expect(argv).toEqual(["bun", join(SCRIPTS, script), "--flag", "value"]);
      expect(isAbsolute(argv[1])).toBe(true);
      expect(existsSync(argv[1])).toBe(true);
    }
    expect(atlasCommand("stats")).toEqual(["bun", join(SCRIPTS, "api.ts")]);
  });

  test("empty COCKPIT_BIN still means the TS", () => {
    process.env.COCKPIT_BIN = "";
    expect(isRust()).toBe(false);
    expect(atlasCommand("live")[0]).toBe("bun");
  });

  test("set COCKPIT_BIN maps each subcommand to `<bin> atlas <sub>`", () => {
    process.env.COCKPIT_BIN = "/opt/cockpit";
    expect(isRust()).toBe(true);
    for (const [sub] of SUBS) {
      expect(atlasCommand(sub, ["--port", "1"])).toEqual([
        "/opt/cockpit",
        "atlas",
        sub,
        "--port",
        "1",
      ]);
    }
    expect(atlasCommand("stats")).toEqual(["/opt/cockpit", "atlas", "stats"]);
  });

  test("paths do not depend on the caller's cwd", () => {
    const source = `const { atlasCommand } = await import(${JSON.stringify(join(import.meta.dir, "launcher.ts"))}); console.log(JSON.stringify(atlasCommand("stats")));`;
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    const child = Bun.spawnSync([process.execPath, "-e", source], {
      env,
      cwd: tmpdir(),
    });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual([
      "bun",
      join(SCRIPTS, "api.ts"),
    ]);
  });
});
