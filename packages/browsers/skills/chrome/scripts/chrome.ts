#!/usr/bin/env bun

// One entry point: parse the argv, find or launch an instance, run one command
// over the Chrome DevTools Protocol, print one line. Every instance is its own
// process with a throwaway profile, so two agents never share a browser — and
// none touches the Chrome you have open, which refuses remote debugging on its
// default profile anyway.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { connectPage, type Page } from "./cdp";
import {
  isAlive,
  liveInstances,
  newProfile,
  pickInstance,
  recordInstance,
  resolveBinary,
  shutdown,
  type Instance,
} from "../../shared/instances";
import { keyEvent, need, parseSize, printable } from "../../shared/webdriver";

export type Invocation = {
  command: string | null;
  args: string[];
  id: string | null;
  headed: boolean;
  fresh: boolean;
  full: boolean;
  size: string | null;
  output: string | null;
};

const STATE_DIR = "/tmp/q-lab/browsers/chrome";
const DEFAULT_SIZE = "1440x900";
const LAUNCH_TIMEOUT_MS = 20_000;
const LOAD_TIMEOUT_MS = 15_000;
// Measured on a local link: a 10ms window missed 1 in 5 navigations, 30ms missed none.
const NAVIGATION_GRACE_MS = 50;

// macOS app bundles only; add Linux paths when this runs anywhere else.
export const BINARIES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

const VALUE_FLAGS = new Set(["--id", "--size", "--output"]);

export function parseArgs(argv: string[]): Invocation {
  const invocation: Invocation = {
    command: null,
    args: [],
    id: null,
    headed: false,
    fresh: false,
    full: false,
    size: null,
    output: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--zen")
      throw new Error("chrome has no --zen: use the firefox skill");
    if (VALUE_FLAGS.has(token)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${token} needs a value`);
      if (token === "--id") invocation.id = value;
      if (token === "--size") invocation.size = value;
      if (token === "--output") invocation.output = value;
    } else if (token === "--headed") invocation.headed = true;
    else if (token === "--new") invocation.fresh = true;
    else if (token === "--full") invocation.full = true;
    else if (invocation.command === null) invocation.command = token;
    else invocation.args.push(token);
  }
  return invocation;
}

async function launch(invocation: Invocation): Promise<Instance> {
  const binary = resolveBinary("chrome", BINARIES);
  const { width, height } = parseSize(invocation.size ?? DEFAULT_SIZE);
  const { id, profile } = newProfile(STATE_DIR);
  const headless = !invocation.headed;
  const child = Bun.spawn(
    [
      binary,
      // Port 0: Chrome binds a free port itself and writes it to DevToolsActivePort,
      // so there is no window between choosing a port and another process taking it.
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      `--window-size=${width},${height}`,
      ...(headless ? ["--headless=new"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"], detached: true },
  );
  child.unref();

  const instance: Instance = {
    id,
    pid: child.pid,
    port: 0,
    profile,
    browser: "chrome",
    headless,
  };
  const portFile = join(profile, "DevToolsActivePort");
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  for (;;) {
    const lines = existsSync(portFile)
      ? readFileSync(portFile, "utf8").split("\n")
      : [];
    if (lines.length > 1) {
      instance.port = Number(lines[0]);
      recordInstance(STATE_DIR, instance);
      return instance;
    }
    if (Date.now() > deadline || !isAlive(child.pid)) {
      await shutdown(STATE_DIR, instance);
      throw new Error(
        `chrome did not open DevTools within ${LAUNCH_TIMEOUT_MS}ms`,
      );
    }
    await Bun.sleep(50);
  }
}

async function withPage<T>(
  instance: Instance,
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const page = await connectPage(instance.port);
  try {
    await page.send("Page.enable");
    return await run(page);
  } finally {
    page.close();
  }
}

async function evaluate(page: Page, expression: string): Promise<unknown> {
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(
      exceptionDetails.exception?.description ?? exceptionDetails.text,
    );
  }
  return result.value;
}

/** Runs a navigation and waits for it to land: a new document loads, a same-document one only moves. */
async function navigated(page: Page, start: () => Promise<any>): Promise<void> {
  const landed = page.nextEvent(
    ["Page.loadEventFired", "Page.navigatedWithinDocument"],
    LOAD_TIMEOUT_MS,
  );
  const result = await start();
  if (result?.errorText)
    throw new Error(`navigation failed: ${result.errorText}`);
  await landed;
}

/** Runs an input action and, when it starts loading a page, waits until loading stops — as WebDriver's click does. */
async function interacted(
  page: Page,
  act: () => Promise<unknown>,
): Promise<void> {
  // Grace window, not a guarantee: a navigation a page timer starts later than this is not waited for.
  const started = page
    .nextEvent(["Page.frameStartedLoading"], NAVIGATION_GRACE_MS)
    .catch(() => null);
  const stopped = page.nextEvent(["Page.frameStoppedLoading"], LOAD_TIMEOUT_MS);
  stopped.catch(() => {});
  await act();
  if (await started) await stopped;
}

async function title(page: Page): Promise<string> {
  return String(await evaluate(page, "document.title"));
}

/** Scrolls the element into view and returns its centre in viewport pixels. */
async function centre(
  page: Page,
  selector: string,
): Promise<{ x: number; y: number }> {
  const point = await evaluate(
    page,
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!point) throw new Error(`no such element: ${selector}`);
  return point as { x: number; y: number };
}

async function focus(page: Page, selector: string): Promise<void> {
  const found = await evaluate(
    page,
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); el?.focus(); return !!el; })()`,
  );
  if (!found) throw new Error(`no such element: ${selector}`);
}

async function run(invocation: Invocation): Promise<string> {
  const { command, args } = invocation;

  if (command === "open") {
    const [url] = need(args, 1, "open <url> [--new] [--headed] [--size WxH]");
    const live = liveInstances(STATE_DIR);
    const reuse = !invocation.fresh && live.length > 0;
    const instance = reuse
      ? pickInstance(live, invocation.id)
      : await launch(invocation);
    return withPage(instance, async (page) => {
      if (reuse && invocation.size) {
        const { windowId } = await page.send("Browser.getWindowForTarget");
        await page.send("Browser.setWindowBounds", {
          windowId,
          bounds: parseSize(invocation.size),
        });
      }
      await navigated(page, () => page.send("Page.navigate", { url }));
      return `${instance.id} chrome ${instance.headless ? "headless" : "headed"} ${url} ${await title(page)}`;
    });
  }

  if (command === "status") {
    const live = liveInstances(STATE_DIR);
    if (live.length === 0) return "no instance is open";
    const lines = await Promise.all(
      live.map(async (instance) => {
        const where = await withPage(
          instance,
          async (page) =>
            `${await evaluate(page, "location.href")} ${await title(page)}`,
        ).catch((error: Error) => `unreachable: ${error.message}`);
        return `${instance.id} chrome ${instance.headless ? "headless" : "headed"} ${where}`;
      }),
    );
    return lines.join("\n");
  }

  if (command === "close") {
    const instance = pickInstance(liveInstances(STATE_DIR), invocation.id);
    await shutdown(STATE_DIR, instance);
    return `closed ${instance.id}`;
  }

  const instance = pickInstance(liveInstances(STATE_DIR), invocation.id);
  return withPage(instance, async (page) => {
    switch (command) {
      case "goto": {
        const [url] = need(args, 1, "goto <url>");
        await navigated(page, () => page.send("Page.navigate", { url }));
        return `${url} ${await title(page)}`;
      }
      case "back":
      case "forward": {
        const { currentIndex, entries } = await page.send(
          "Page.getNavigationHistory",
        );
        const entry = entries[currentIndex + (command === "back" ? -1 : 1)];
        if (!entry) throw new Error(`no history entry to go ${command} to`);
        await navigated(page, () =>
          page.send("Page.navigateToHistoryEntry", { entryId: entry.id }),
        );
        return String(await evaluate(page, "location.href"));
      }
      case "reload":
        await navigated(page, () => page.send("Page.reload"));
        return String(await evaluate(page, "location.href"));
      case "text":
        return String(await evaluate(page, "document.body?.innerText ?? ''"));
      case "eval": {
        const [expression] = need(args, 1, "eval <expression>");
        return printable(await evaluate(page, expression));
      }
      case "screenshot": {
        if (!invocation.output)
          throw new Error("usage: screenshot --output <path> [--full]");
        let params: object = { format: "png" };
        if (invocation.full) {
          const { cssContentSize } = await page.send("Page.getLayoutMetrics");
          params = {
            format: "png",
            captureBeyondViewport: true,
            clip: {
              x: 0,
              y: 0,
              width: cssContentSize.width,
              height: cssContentSize.height,
              scale: 1,
            },
          };
        }
        const { data } = await page.send("Page.captureScreenshot", params);
        await Bun.write(invocation.output, Buffer.from(data, "base64"));
        return invocation.output;
      }
      case "click": {
        const [selector] = need(args, 1, "click <selector>");
        const { x, y } = await centre(page, selector);
        const press = { x, y, button: "left", clickCount: 1 };
        // Sent back to back and awaited together: CDP keeps the order on one session.
        await interacted(page, () =>
          Promise.all([
            page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }),
            page.send("Input.dispatchMouseEvent", {
              type: "mousePressed",
              ...press,
            }),
            page.send("Input.dispatchMouseEvent", {
              type: "mouseReleased",
              ...press,
            }),
          ]),
        );
        return `clicked ${selector}`;
      }
      case "type": {
        const [selector, ...words] = need(args, 2, "type <selector> <text>");
        await focus(page, selector);
        await page.send("Input.insertText", { text: words.join(" ") });
        return `typed into ${selector}`;
      }
      case "press": {
        const [first, second] = need(args, 1, "press [selector] <key>");
        const key = second ?? first!;
        if (second !== undefined) await focus(page, first!);
        const event = keyEvent(key);
        await interacted(page, () =>
          Promise.all([
            page.send("Input.dispatchKeyEvent", { type: "keyDown", ...event }),
            page.send("Input.dispatchKeyEvent", {
              type: "keyUp",
              ...event,
              text: undefined,
            }),
          ]),
        );
        return `pressed ${key}`;
      }
      case "wait": {
        const [expression, timeout = "10000"] = need(
          args,
          1,
          "wait <expression> [timeoutMs]",
        );
        const started = Date.now();
        for (;;) {
          if (await evaluate(page, `!!(${expression})`))
            return `ok ${Date.now() - started}ms`;
          if (Date.now() - started > Number(timeout)) {
            throw new Error(
              `timed out after ${timeout}ms waiting for ${expression}`,
            );
          }
          await Bun.sleep(100);
        }
      }
      default:
        throw new Error(
          `unknown command ${command ?? "(none)"}; commands: open goto back forward reload status text eval screenshot click type press wait close`,
        );
    }
  });
}

if (import.meta.main) {
  try {
    console.log(await run(parseArgs(Bun.argv.slice(2))));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
