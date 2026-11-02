import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, tempRoot } from "./tune";

const TUNE = join(import.meta.dir, "tune.ts");
const run = (...args: string[]) =>
  Bun.spawnSync(["bun", TUNE, ...args], { stdout: "pipe", stderr: "pipe" });

describe("tempRoot", () => {
  test("is /tmp/q-lab/atelier/tune on POSIX and under tmpdir on Windows", () => {
    expect(tempRoot("darwin")).toBe("/tmp/q-lab/atelier/tune");
    expect(tempRoot("win32")).toBe(join(tmpdir(), "q-lab", "atelier", "tune"));
  });
});

describe("parseArgs", () => {
  test("reads the command, one positional and the flags", () => {
    expect(parseArgs(["open", "spec.json", "--no-open"])).toEqual({
      command: "open",
      positional: ["spec.json"],
      flags: { "no-open": true },
    });
    expect(parseArgs(["wait", "--timeout", "30", "--dir", "/x"]).flags).toEqual(
      { timeout: "30", dir: "/x" },
    );
  });
});

describe("tune CLI", () => {
  const work = mkdtempSync(join(tmpdir(), "atelier-cli-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  test("open refuses a broken spec with the reason and exit 2", () => {
    const bad = join(work, "bad.json");
    writeFileSync(bad, JSON.stringify({ params: [] }));
    const res = run("open", bad, "--no-open");
    expect(res.exitCode).toBe(2);
    expect(res.stderr.toString()).toContain("params");
  });

  test("open → Apply → wait → stop, end to end", async () => {
    const spec = join(work, "glow.json");
    writeFileSync(join(work, "glow.html"), "<div>glow</div>");
    writeFileSync(
      spec,
      JSON.stringify({
        snippet: "glow.html",
        params: [{ id: "glow", type: "range", min: 0, max: 1, default: 0.3 }],
      }),
    );
    const opened = run("open", spec, "--no-open");
    expect(opened.exitCode).toBe(0);
    const out = opened.stdout.toString();
    const url = out.match(/^url: (\S+)$/m)?.[1];
    const dir = out.match(/^dir: (\S+)$/m)?.[1];
    expect(url).toBeDefined();
    expect(dir).toBeDefined();

    try {
      expect(run("inject", "--dir", dir!).stdout.toString().trim()).toBe(
        `import("${url}inject.js")`,
      );
      expect(run("wait", "--dir", dir!, "--timeout", "1").exitCode).toBe(3);
      await fetch(`${url}apply`, {
        method: "POST",
        body: JSON.stringify({ values: { glow: 0.45 } }),
      });
      const waited = run("wait", "--dir", dir!, "--timeout", "5");
      expect(waited.exitCode).toBe(0);
      expect(JSON.parse(waited.stdout.toString())).toEqual({ glow: 0.45 });
    } finally {
      expect(run("stop", "--dir", dir!).exitCode).toBe(0);
    }
    await expect(
      fetch(url!).then(
        () => "up",
        () => "down",
      ),
    ).resolves.toBe("down");
  });
});
