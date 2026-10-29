import { describe, expect, test } from "bun:test";
import { parseArgs } from "./firefox";

describe("parseArgs", () => {
  test("splits the command, positionals, and flags", () => {
    expect(
      parseArgs([
        "open",
        "http://a",
        "--zen",
        "--headed",
        "--size",
        "800x600",
        "--id",
        "k",
      ]),
    ).toMatchObject({
      command: "open",
      args: ["http://a"],
      zen: true,
      headed: true,
      size: "800x600",
      id: "k",
    });
  });

  test("keeps a positional that only looks like a flag value", () => {
    expect(parseArgs(["type", "#q", "--full"])).toMatchObject({
      command: "type",
      args: ["#q"],
      full: true,
    });
  });

  test("rejects a value flag with nothing after it", () => {
    expect(() => parseArgs(["screenshot", "--output"])).toThrow(
      "--output needs a value",
    );
  });
});

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execute, launch } from "./firefox";

for (const zen of [false, true]) {
  test(`native ${zen ? "Zen" : "Firefox"} selection records before protocol readiness`, async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "gecko-launch-"));
    const browser = zen ? "zen" : "firefox";
    let profile = "";
    try {
      const instance = await launch(
        parseArgs(["open", "about:blank", ...(zen ? ["--zen"] : [])]),
        {
          input: { platform: "linux", env: {}, wsl: true },
          stateDir,
          resolve: (name, candidates) => {
            expect(name).toBe(browser);
            expect(candidates[0]).toBe(browser);
            expect(
              candidates.some((candidate) => candidate.includes(".app")),
            ).toBe(false);
            return `/opt/程式 空間/${browser}`;
          },
          spawn: (argv) => {
            expect(argv[0]).toBe(`/opt/程式 空間/${browser}`);
            profile = argv[argv.indexOf("-profile") + 1]!;
            return { pid: process.pid, unref() {} };
          },
          ready: async (port) => {
            const id = profile.slice(profile.lastIndexOf("-") + 1);
            const provisional = JSON.parse(
              readFileSync(join(stateDir, "instances", `${id}.json`), "utf8"),
            );
            expect(provisional.port).toBe(port);
            expect(provisional.browser).toBe(browser);
            expect(readFileSync(join(profile, "user.js"), "utf8")).toContain(
              `marionette.port", ${port}`,
            );
          },
        },
      );
      expect(instance.browser).toBe(browser);
      expect(instance.profile.startsWith(stateDir)).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test(`Windows ${zen ? "Zen" : "Firefox"} refusal precedes parsing and execution`, async () => {
    let operations = 0;
    await expect(
      execute(
        ["open", ...(zen ? ["--zen"] : []), "--id"],
        "win32",
        async () => {
          operations++;
          return "unexpected";
        },
      ),
    ).rejects.toThrow(/not supported on Windows.*chrome skill/);
    expect(operations).toBe(0);
  });
}

for (const zen of [false, true]) {
  test(`unsupported Windows ${zen ? "Zen" : "Firefox"} executable invocation exits nonzero`, async () => {
    const source = `import { execute } from ${JSON.stringify(new URL("./firefox.ts", import.meta.url).href)};
      try { await execute(${JSON.stringify(zen ? ["--zen", "--id"] : ["--id"])}, "win32", async () => { throw new Error("browser operation reached"); }); }
      catch (error) { console.error(error.message); process.exit(1); }`;
    const child = Bun.spawn([process.execPath, "--eval", source], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).not.toBe(0);
    const error = await new Response(child.stderr).text();
    expect(error).toContain("not supported on Windows");
    expect(error).toContain("chrome skill");
    expect(error).toContain(zen ? "zen" : "firefox");
  });
}
