import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Opt-in: Safari has no headless mode, so this opens a window that takes focus and
// a glass pane that swallows input — never something a plain `bun test .` may do.
const enabled = process.env.SAFARI_LIVE === "1";
const cli = join(import.meta.dir, "safari.ts");

function run(...argv: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["bun", cli, ...argv]);
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

describe.skipIf(!enabled)(
  "safari CLI against real Safari (SAFARI_LIVE=1)",
  () => {
    test("drives a page from open to close", async () => {
      const page =
        "data:text/html,<title>T</title><input id=q><button id=b onclick=\"document.title=document.getElementById('q').value\">go</button>";
      expect(run("open", page).code).toBe(0);

      try {
        expect(run("type", "#q", "hello").code).toBe(0);
        expect(run("click", "#b").code).toBe(0);
        expect(run("wait", "document.title === 'hello'", "3000").code).toBe(0);

        const missing = run("click", "#missing");
        expect(missing.code).toBe(1);
        expect(missing.err).toBe("no such element");

        const scratch = mkdtempSync(join(tmpdir(), "safari-live-"));
        try {
          const shot = join(scratch, "page.png");
          expect(run("screenshot", "--output", shot).code).toBe(0);
          const header = new Uint8Array(
            await Bun.file(shot).slice(0, 4).arrayBuffer(),
          );
          expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47]);
        } finally {
          rmSync(scratch, { recursive: true, force: true });
        }
      } finally {
        expect(run("close").out).toStartWith("closed ");
      }
    }, 60_000);
  },
);
