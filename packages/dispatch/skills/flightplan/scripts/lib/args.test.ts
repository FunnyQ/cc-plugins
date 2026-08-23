import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { flagValue } from "./args";

const ARGS_MODULE = join(import.meta.dir, "args.ts");

/**
 * `flagValue` exits the process on a bad flag, so the rejecting cases run in a
 * child. The resolving cases run in-process.
 */
async function runFlagValue(
  argv: string[],
  name: string,
  opts?: { allowDashValue?: boolean },
): Promise<{ code: number; stderr: string }> {
  const src = `import { flagValue } from ${JSON.stringify(ARGS_MODULE)};
flagValue(${JSON.stringify(argv)}, ${JSON.stringify(name)}, ${JSON.stringify(opts ?? {})});`;
  const proc = Bun.spawn(["bun", "-e", src], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

describe("flagValue", () => {
  test("returns the following token", () => {
    expect(flagValue(["--log", "run.jsonl"], "--log")).toBe("run.jsonl");
  });

  test("returns undefined when the flag is absent", () => {
    expect(flagValue(["--attempt", "3"], "--log")).toBeUndefined();
  });

  test("rejects the next flag as a value — `--log --attempt 3`", async () => {
    const { code, stderr } = await runFlagValue(
      ["--log", "--attempt", "3"],
      "--log",
    );
    expect(code).toBe(2);
    expect(stderr).toContain("Missing value after --log");
  });

  test("rejects a trailing flag with nothing after it", async () => {
    const { code, stderr } = await runFlagValue(["--log"], "--log");
    expect(code).toBe(2);
    expect(stderr).toContain("Missing value after --log");
  });

  test("allowDashValue lets free text open with `--`", () => {
    expect(
      flagValue(["--message", "--- done"], "--message", {
        allowDashValue: true,
      }),
    ).toBe("--- done");
  });

  test("allowDashValue still rejects a missing value", async () => {
    const { code } = await runFlagValue(["--message"], "--message", {
      allowDashValue: true,
    });
    expect(code).toBe(2);
  });
});
