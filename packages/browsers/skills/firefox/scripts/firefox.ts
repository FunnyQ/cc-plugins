#!/usr/bin/env bun

// One entry point: parse the argv, find or launch an instance, run one command
// over Marionette, print one line. Every instance is its own process with a
// throwaway profile and its own port, so two agents never share a browser.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect, type Client } from "./marionette";
import {
  freePort,
  isAlive,
  liveInstances,
  newProfile,
  pickInstance,
  recordInstance,
  resolveBinary,
  shutdown,
  type Instance,
} from "../../shared/instances";
import {
  ELEMENT_KEY,
  keyText,
  need,
  parseSize,
  printable,
  script,
} from "../../shared/webdriver";

export type Browser = "firefox" | "zen";

export type Invocation = {
  command: string | null;
  args: string[];
  id: string | null;
  zen: boolean;
  headed: boolean;
  fresh: boolean;
  full: boolean;
  size: string | null;
  output: string | null;
};

const STATE_DIR = "/tmp/q-lab/browsers/firefox";
const DEFAULT_SIZE = "1440x900";
const LAUNCH_TIMEOUT_MS = 20_000;

// macOS app bundles only; add Linux paths when this runs anywhere else.
export const BINARIES: Record<Browser, string[]> = {
  firefox: [
    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
  ],
  zen: ["/Applications/Zen.app/Contents/MacOS/zen"],
};

const VALUE_FLAGS = new Set(["--id", "--size", "--output"]);

export function parseArgs(argv: string[]): Invocation {
  const invocation: Invocation = {
    command: null,
    args: [],
    id: null,
    zen: false,
    headed: false,
    fresh: false,
    full: false,
    size: null,
    output: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (VALUE_FLAGS.has(token)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${token} needs a value`);
      if (token === "--id") invocation.id = value;
      if (token === "--size") invocation.size = value;
      if (token === "--output") invocation.output = value;
    } else if (token === "--zen") invocation.zen = true;
    else if (token === "--headed") invocation.headed = true;
    else if (token === "--new") invocation.fresh = true;
    else if (token === "--full") invocation.full = true;
    else if (invocation.command === null) invocation.command = token;
    else invocation.args.push(token);
  }
  return invocation;
}

async function launch(invocation: Invocation): Promise<Instance> {
  const browser: Browser = invocation.zen ? "zen" : "firefox";
  const binary = resolveBinary(browser, BINARIES[browser]);
  const { width, height } = parseSize(invocation.size ?? DEFAULT_SIZE);
  const { id, profile } = newProfile(STATE_DIR);
  // Port picked then released: another process can take it in between, and the
  // launch then times out rather than attaching to a stranger.
  const port = await freePort();
  writeFileSync(
    join(profile, "user.js"),
    [
      `user_pref("marionette.port", ${port});`,
      `user_pref("browser.shell.checkDefaultBrowser", false);`,
      `user_pref("browser.startup.homepage_override.mstone", "ignore");`,
      `user_pref("browser.aboutwelcome.enabled", false);`,
      `user_pref("datareporting.policy.dataSubmissionEnabled", false);`,
      `user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);`,
    ].join("\n"),
  );
  const headless = !invocation.headed;
  const argv = [
    binary,
    "--marionette",
    "--no-remote",
    "-profile",
    profile,
    "--width",
    String(width),
    "--height",
    String(height),
    ...(headless ? ["--headless"] : []),
    "about:blank",
  ];
  const child = Bun.spawn(argv, {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  child.unref();
  const instance: Instance = {
    id,
    pid: child.pid,
    port,
    profile,
    browser,
    headless,
  };
  recordInstance(STATE_DIR, instance);

  const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
  for (;;) {
    try {
      (await connect(port, 2_000)).close();
      return instance;
    } catch {
      if (Date.now() > deadline || !isAlive(child.pid)) {
        await shutdown(STATE_DIR, instance);
        throw new Error(
          `${browser} did not open Marionette on port ${port} within ${LAUNCH_TIMEOUT_MS}ms`,
        );
      }
      await Bun.sleep(50);
    }
  }
}

/** Marionette holds one session at a time, so each command opens and closes its own. */
async function withSession<T>(
  instance: Instance,
  run: (send: Client["send"]) => Promise<T>,
): Promise<T> {
  const client = await connect(instance.port);
  try {
    await client.send("WebDriver:NewSession", { capabilities: {} });
    try {
      return await run(client.send);
    } finally {
      await client.send("WebDriver:DeleteSession").catch(() => {});
    }
  } finally {
    client.close();
  }
}

async function element(
  send: Client["send"],
  selector: string,
): Promise<string> {
  const found = await send("WebDriver:FindElement", {
    using: "css selector",
    value: selector,
  });
  return found.value[ELEMENT_KEY];
}

const HISTORY = {
  back: "WebDriver:Back",
  forward: "WebDriver:Forward",
  reload: "WebDriver:Refresh",
};

async function run(invocation: Invocation): Promise<string> {
  const { command, args } = invocation;

  if (command === "open") {
    const [url] = need(
      args,
      1,
      "open <url> [--new] [--zen] [--headed] [--size WxH]",
    );
    const live = liveInstances(STATE_DIR);
    const reuse = !invocation.fresh && live.length > 0;
    const instance = reuse
      ? pickInstance(live, invocation.id)
      : await launch(invocation);
    return withSession(instance, async (send) => {
      if (reuse && invocation.size) {
        await send("WebDriver:SetWindowRect", parseSize(invocation.size));
      }
      await send("WebDriver:Navigate", { url });
      const title = (await send("WebDriver:GetTitle")).value;
      return `${instance.id} ${instance.browser} ${instance.headless ? "headless" : "headed"} ${url} ${title}`;
    });
  }

  if (command === "status") {
    const live = liveInstances(STATE_DIR);
    if (live.length === 0) return "no instance is open";
    const lines = await Promise.all(
      live.map(async (instance) => {
        const where = await withSession(instance, async (send) => {
          const url = (await send("WebDriver:GetCurrentURL")).value;
          const title = (await send("WebDriver:GetTitle")).value;
          return `${url} ${title}`;
        }).catch((error: Error) => `unreachable: ${error.message}`);
        return `${instance.id} ${instance.browser} ${instance.headless ? "headless" : "headed"} ${where}`;
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
  return withSession(instance, async (send) => {
    switch (command) {
      case "goto": {
        const [url] = need(args, 1, "goto <url>");
        await send("WebDriver:Navigate", { url });
        return `${url} ${(await send("WebDriver:GetTitle")).value}`;
      }
      case "back":
      case "forward":
      case "reload": {
        await send(HISTORY[command]);
        return (await send("WebDriver:GetCurrentURL")).value;
      }
      case "text":
        return (
          await send("WebDriver:ExecuteScript", {
            script: "return document.body?.innerText ?? '';",
            args: [],
          })
        ).value;
      case "eval": {
        const [expression] = need(args, 1, "eval <expression>");
        return printable(
          (
            await send("WebDriver:ExecuteScript", {
              script: script(expression),
              args: [],
            })
          ).value,
        );
      }
      case "screenshot": {
        if (!invocation.output)
          throw new Error("usage: screenshot --output <path> [--full]");
        const shot = await send("WebDriver:TakeScreenshot", {
          full: invocation.full,
        });
        await Bun.write(invocation.output, Buffer.from(shot.value, "base64"));
        return invocation.output;
      }
      case "click": {
        const [selector] = need(args, 1, "click <selector>");
        await send("WebDriver:ElementClick", {
          id: await element(send, selector),
        });
        return `clicked ${selector}`;
      }
      case "type": {
        const [selector, ...words] = need(args, 2, "type <selector> <text>");
        await send("WebDriver:ElementSendKeys", {
          id: await element(send, selector),
          text: words.join(" "),
        });
        return `typed into ${selector}`;
      }
      case "press": {
        const [first, second] = need(args, 1, "press [selector] <key>");
        const selector = second === undefined ? null : first!;
        const key = second ?? first!;
        const id = selector
          ? await element(send, selector)
          : (await send("WebDriver:GetActiveElement")).value[ELEMENT_KEY];
        await send("WebDriver:ElementSendKeys", { id, text: keyText(key) });
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
          const { value } = await send("WebDriver:ExecuteScript", {
            script: script(`!!(${expression})`),
            args: [],
          });
          if (value) return `ok ${Date.now() - started}ms`;
          if (Date.now() - started > Number(timeout))
            throw new Error(
              `timed out after ${timeout}ms waiting for ${expression}`,
            );
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
