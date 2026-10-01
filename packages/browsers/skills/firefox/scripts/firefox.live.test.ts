import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BINARIES } from "./firefox";

// Launches a real headless browser, so it skips on a machine without one.
const installed = BINARIES.firefox.some((path) => existsSync(path));
const cli = join(import.meta.dir, "firefox.ts");

function run(...argv: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["bun", cli, ...argv]);
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

describe.skipIf(!installed)("firefox CLI against a real browser", () => {
  test("drives a page from open to close", async () => {
    const page =
      "data:text/html,<title>T</title><input id=q><button id=b onclick=\"document.title=document.getElementById('q').value\">go</button>";
    const opened = run("open", "--new", page);
    expect(opened.code).toBe(0);
    const id = opened.out.split(" ")[0]!;

    try {
      expect(run("type", "--id", id, "#q", "hello").code).toBe(0);
      expect(run("click", "--id", id, "#b").code).toBe(0);
      expect(
        run("wait", "--id", id, "document.title === 'hello'", "3000").code,
      ).toBe(0);
      expect(run("eval", "--id", id, "document.title").out).toBe("hello");

      const missing = run("click", "--id", id, "#missing");
      expect(missing.code).toBe(1);
      expect(missing.err).toContain("no such element");

      const scratch = mkdtempSync(join(tmpdir(), "firefox-live-"));
      try {
        const shot = join(scratch, "page.png");
        expect(run("screenshot", "--id", id, "--output", shot).code).toBe(0);
        const header = new Uint8Array(
          await Bun.file(shot).slice(0, 4).arrayBuffer(),
        );
        expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47]);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    } finally {
      expect(run("close", "--id", id).out).toBe(`closed ${id}`);
    }
  }, 60_000);
});
