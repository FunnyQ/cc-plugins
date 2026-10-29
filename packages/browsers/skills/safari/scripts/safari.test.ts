import { describe, expect, test } from "bun:test";
import { parseArgs, settle } from "./safari";

describe("parseArgs", () => {
  test("splits the command, positionals, and flags", () => {
    expect(parseArgs(["screenshot", "--output", "/tmp/a.png"])).toMatchObject({
      command: "screenshot",
      args: [],
      output: "/tmp/a.png",
    });
    expect(parseArgs(["open", "http://a", "--size", "800x600"])).toMatchObject({
      command: "open",
      args: ["http://a"],
      size: "800x600",
    });
  });

  // Safari has one automation window and no headless mode, so the Firefox flags mean nothing here.
  test("rejects a flag Safari cannot honour", () => {
    expect(() => parseArgs(["open", "http://a", "--headed"])).toThrow(
      "safari has no --headed: it always opens one visible automation window",
    );
    expect(() =>
      parseArgs(["screenshot", "--output", "a.png", "--full"]),
    ).toThrow("safari has no --full");
  });
});

describe("settle", () => {
  test("returns the value of a successful response", () => {
    expect(settle(200, { value: "S" })).toBe("S");
  });

  // Measured: a missing element answers 404 with an empty message.
  test("names the error even when the message is empty", () => {
    expect(() =>
      settle(404, {
        value: { error: "no such element", message: "", stacktrace: "" },
      }),
    ).toThrow(/^no such element$/);
  });

  test("passes the driver message through, so start can tell its causes apart", () => {
    const message =
      "Could not create a session: The Safari instance is already paired with another WebDriver session.";
    expect(() =>
      settle(500, { value: { error: "session not created", message } }),
    ).toThrow(`session not created: ${message}`);
  });

  test("fails on a non-2xx status that carries no error object", () => {
    expect(() => settle(502, null)).toThrow("safaridriver answered HTTP 502");
  });
});

import { execute } from "./safari";

for (const platform of ["linux", "win32"]) {
  test(`Safari refuses ${platform} before parsing or state/driver operations`, async () => {
    let operations = 0;
    await expect(
      execute(["--headed"], platform, async () => {
        operations++;
        return "unexpected";
      }),
    ).rejects.toThrow("macOS only");
    expect(operations).toBe(0);
  });
}

test("unsupported Safari executable invocation exits nonzero", async () => {
  const source = `import { execute } from ${JSON.stringify(new URL("./safari.ts", import.meta.url).href)};
    try { await execute(["--headed"], "linux", async () => { throw new Error("driver operation reached"); }); }
    catch (error) { console.error(error.message); process.exit(1); }`;
  const child = Bun.spawn([process.execPath, "--eval", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).not.toBe(0);
  expect(await new Response(child.stderr).text()).toContain("macOS only");
});
