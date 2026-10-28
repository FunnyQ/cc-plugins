import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "hook.ts");
const manifest = join(import.meta.dir, "../../../.claude-plugin/plugin.json");

test("manifest runs the cockpit hooks through bun hook.ts in exec form", () => {
  const { hooks } = JSON.parse(readFileSync(manifest, "utf8"));
  expect(hooks.SessionStart[0].matcher).toBe("startup|resume|clear|compact");
  expect(hooks.SessionStart[1].matcher).toBe("startup|resume|clear|compact");
  expect(hooks.SessionStart[0].hooks[0]).toEqual({
    type: "command",
    command:
      'bun "${CLAUDE_PLUGIN_ROOT}/skills/install/scripts/setup.ts" --session-check',
    timeout: 20,
  });
  expect(hooks.SessionStart[1].hooks[0]).toEqual({
    type: "command",
    command: "bun",
    args: ["${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/hook.ts", "session-start"],
    timeout: 5,
  });
  expect(hooks.Stop[0].hooks[0]).toEqual({
    type: "command",
    command: "bun",
    args: ["${CLAUDE_PLUGIN_ROOT}/skills/cockpit/bin/hook.ts", "stop"],
    timeout: 10,
  });
});

test.skipIf(process.platform === "win32")(
  "POSIX passes argv, stdin, stdout, stderr and exit code through the shim",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "hook-test-"));
    try {
      const fake = join(dir, "fake");
      writeFileSync(
        fake,
        '#!/bin/sh\necho "ARGS $*"\ncat\necho "MARKER-STDERR" >&2\nexit 3\n',
      );
      chmodSync(fake, 0o755);
      const result = Bun.spawnSync(["bun", entry, "session-start"], {
        stdin: Buffer.from("payload"),
        env: { ...process.env, COCKPIT_BIN: fake },
      });
      const stdout = result.stdout.toString();
      expect(stdout).toContain("hook session-start");
      expect(stdout).toContain("payload");
      expect(result.stderr.toString()).toContain("MARKER-STDERR");
      expect(result.exitCode).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "win32 drains stdin to EOF, then exits 0 with no output",
  async () => {
    const proc = Bun.spawn(["bun", entry, "stop"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write('{"hook_event_name":');
    await proc.stdin.flush();
    await Bun.sleep(300);
    expect(proc.exitCode).toBeNull();
    proc.stdin.write('"Stop"}');
    await proc.stdin.end();
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await new Response(proc.stderr).text()).toBe("");
  },
);
