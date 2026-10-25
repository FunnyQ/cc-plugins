// bun geometry-cli.ts <chrome> <page.html> → {"faults":[...]} on stdout; runs as a child, since a mod has no Bun global
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { faults, MEASURE } from "./geometry";
import type { Measure } from "./geometry";

const [chromePath, page] = process.argv.slice(2) as [string, string];
const profile = mkdtempSync(join(tmpdir(), "runes-geometry-"));
const chrome = Bun.spawn(
  [
    chromePath,
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);

try {
  let port = 0;
  for (let i = 0; i < 200 && !port; i++) {
    await Bun.sleep(25);
    const file = Bun.file(join(profile, "DevToolsActivePort"));
    if (await file.exists()) port = Number((await file.text()).split("\n")[0]);
  }
  const targets = (await (
    await fetch(`http://127.0.0.1:${port}/json/list`)
  ).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const socket = new WebSocket(
    targets.find((t) => t.type === "page")!.webSocketDebuggerUrl,
  );
  await new Promise((resolve) => (socket.onopen = resolve));
  const waiting = new Map<number, (reply: any) => void>();
  socket.onmessage = (e) => {
    const reply = JSON.parse(String(e.data));
    waiting.get(reply.id)?.(reply);
  };
  let id = 0;
  const send = (method: string, params = {}) =>
    new Promise<any>((resolve) => {
      waiting.set(++id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string) =>
    (
      await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.result.value;

  const byWidth: Record<number, Measure> = {};
  // emulated, not --window-size: headless Chrome lays a 420 window out wider and crops it, which reads as clipping
  for (const width of [1280, 420]) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send("Page.navigate", { url: `file://${page}` });
    for (
      let i = 0;
      i < 100 && (await evaluate("document.readyState")) !== "complete";
      i++
    )
      await Bun.sleep(20);
    byWidth[width] = JSON.parse(await evaluate(MEASURE));
  }
  console.log(JSON.stringify({ faults: faults(byWidth) }));
} finally {
  chrome.kill();
  await chrome.exited;
  // Chrome's helpers still write the profile for a moment after the main process exits
  rmSync(profile, { recursive: true, force: true, maxRetries: 10 });
}
