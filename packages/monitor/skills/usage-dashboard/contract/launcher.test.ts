import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { atlasCommand, DEFAULT_BIN, type AtlasSub } from "./launcher";

const SUBS: AtlasSub[] = ["serve", "stats", "live", "rollup-update", "measure", "push-usage"];
const MISSING =
  "atlas contract suite: no binary — run cargo build --release --manifest-path packages/monitor/cockpit-rs/Cargo.toml or set COCKPIT_BIN";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.COCKPIT_BIN;
});
afterEach(() => {
  if (saved === undefined) delete process.env.COCKPIT_BIN;
  else process.env.COCKPIT_BIN = saved;
});

describe("atlas launcher", () => {
  test("set COCKPIT_BIN maps each subcommand to `<bin> atlas <sub>`", () => {
    process.env.COCKPIT_BIN = "/opt/cockpit";
    for (const sub of SUBS) {
      expect(atlasCommand(sub, ["--port", "1"])).toEqual(["/opt/cockpit", "atlas", sub, "--port", "1"]);
    }
  });

  test("unset COCKPIT_BIN runs the absolute local release binary", () => {
    delete process.env.COCKPIT_BIN;
    const expected = resolve(import.meta.dir, "../../../cockpit-rs/target/release/cockpit");
    expect(DEFAULT_BIN).toBe(expected);
    for (const sub of SUBS) expect(atlasCommand(sub, ["-x"])).toEqual([expected, "atlas", sub, "-x"]);
  });

  test("a missing default binary throws the exact message at import", () => {
    // A copy of the launcher where ../../../cockpit-rs/target/release/cockpit does not exist.
    const dir = mkdtempSync(join(tmpdir(), "atlas-launcher-"));
    try {
      const copy = join(dir, "a/b/c/launcher.ts");
      cpSync(join(import.meta.dir, "launcher.ts"), copy);
      expect(existsSync(join(dir, "cockpit-rs"))).toBe(false);
      const child = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(copy)})`], {
        env: { PATH: process.env.PATH ?? "" },
        cwd: tmpdir(),
        stderr: "pipe",
      });
      expect(child.exitCode).not.toBe(0);
      expect(child.stderr.toString()).toContain(MISSING);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
