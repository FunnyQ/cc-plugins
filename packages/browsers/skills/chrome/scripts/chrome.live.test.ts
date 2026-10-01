import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BINARIES } from "./chrome";

// Launches a real headless browser, so it skips on a machine without one.
const installed = BINARIES.some((path) => existsSync(path));
const cli = join(import.meta.dir, "chrome.ts");

function run(...argv: string[]): { code: number; out: string; err: string } {
  const result = Bun.spawnSync(["bun", cli, ...argv]);
  return {
    code: result.exitCode,
    out: result.stdout.toString().trim(),
    err: result.stderr.toString().trim(),
  };
}

// Async, unlike `run`: a server in this process cannot answer while spawnSync blocks it.
async function runAsync(
  ...argv: string[]
): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["bun", cli, ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(child.stdout).text()).trim();
  return { code: await child.exited, out };
}

describe.skipIf(!installed)("chrome CLI against a real browser", () => {
  // Firefox and Safari wait for a navigation their click starts; CDP returns at once.
  test("a click that navigates returns after the new page has loaded", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        // Measured: the next command already waits for the new document to commit, but
        // not for its subresources — a screenshot then misses this image.
        if (path === "/slow.png") {
          await Bun.sleep(1000);
          return new Response("x");
        }
        if (path === "/two") {
          return new Response("<title>Two</title><img src=/slow.png>", {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response('<title>One</title><a id=go href="/two">go</a>', {
          headers: { "content-type": "text/html" },
        });
      },
    });
    const opened = await runAsync(
      "open",
      "--new",
      `http://127.0.0.1:${server.port}/`,
    );
    expect(opened.code).toBe(0);
    const id = opened.out.split(" ")[0]!;

    try {
      expect((await runAsync("click", "--id", id, "#go")).code).toBe(0);
      expect(
        (
          await runAsync(
            "eval",
            "--id",
            id,
            "document.readyState + ' ' + document.title",
          )
        ).out,
      ).toBe("complete Two");
    } finally {
      await runAsync("close", "--id", id);
      server.stop(true);
    }
  }, 60_000);

  test("drives a page from open to close", async () => {
    const page =
      "data:text/html,<title>T</title><form onsubmit=\"document.title='sent:'+q.value;return false\"><input id=q></form>";
    const opened = run("open", "--new", page);
    expect(opened.code).toBe(0);
    const id = opened.out.split(" ")[0]!;

    try {
      expect(run("type", "--id", id, "#q", "hello").code).toBe(0);
      expect(run("press", "--id", id, "#q", "Enter").code).toBe(0);
      expect(
        run("wait", "--id", id, "document.title === 'sent:hello'", "3000").code,
      ).toBe(0);

      const missing = run("click", "--id", id, "#missing");
      expect(missing.code).toBe(1);
      expect(missing.err).toBe("no such element: #missing");

      const scratch = mkdtempSync(join(tmpdir(), "chrome-live-"));
      try {
        const shot = join(scratch, "page.png");
        expect(
          run("screenshot", "--id", id, "--full", "--output", shot).code,
        ).toBe(0);
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
