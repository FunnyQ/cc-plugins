import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baseEnv, cleanup, freePort, makeHomes, run } from "./fixtures";

let h: ReturnType<typeof makeHomes>;
let pid: number | undefined;
beforeEach(() => { h = makeHomes(); pid = undefined; });
afterEach(() => {
  // The daemon is detached from the CLI, so the record is the only handle on it.
  if (pid) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  cleanup(h.root);
});

describe("cockpit ensure-daemon", () => {
  test("spawns a daemon, prints its coordinates as one JSON line, and reuses it", async () => {
    // The default port 5858 may hold the developer's real daemon.
    const want = await freePort();
    const env = baseEnv(h, { COCKPIT_SERVER_PORT: String(want) });
    const first = run("cli", ["ensure-daemon"], { env });
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    expect(first.stdout.endsWith("\n")).toBe(true);
    expect(first.stdout.trim().split("\n")).toHaveLength(1);
    const { port, token } = JSON.parse(first.stdout);
    expect(port).toBe(want);
    expect(typeof token).toBe("string");
    pid = JSON.parse(readFileSync(join(h.cockpitHome, "daemon.json"), "utf8")).pid;

    // Mirrors startDaemon's readiness probe: the token route answers once the listener is up.
    const res = await fetch(`http://127.0.0.1:${port}/api/token`);
    expect(res.ok).toBe(true);
    expect((await res.json()).token).toBe(token);

    const second = run("cli", ["ensure-daemon"], { env });
    expect(second).toEqual({ exitCode: 0, stdout: first.stdout, stderr: "" });
  }, 20000);
});
