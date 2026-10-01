#!/usr/bin/env bun

// One entry point: parse the argv, find or start the one Safari session, run one
// command over safaridriver's W3C WebDriver REST API, print one line. Safari allows
// a single automation session per machine, so there is no instance to pick: every
// caller shares the session recorded here until someone runs `close`.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { freePort, isAlive } from "../../shared/instances";
import {
  ELEMENT_KEY,
  keyText,
  need,
  parseSize,
  printable,
  script,
} from "../../shared/webdriver";

export type Invocation = {
  command: string | null;
  args: string[];
  size: string | null;
  output: string | null;
};

type Session = { driverPid: number; port: number; sessionId: string };

const DRIVER = "/usr/bin/safaridriver";
const STATE_DIR = "/tmp/q-lab/browsers/safari";
const RECORD = join(STATE_DIR, "session.json");
const DRIVER_TIMEOUT_MS = 10_000;

const VALUE_FLAGS = new Set(["--size", "--output"]);
const REFUSED: Record<string, string> = {
  "--headed":
    "safari has no --headed: it always opens one visible automation window",
  "--zen": "safari has no --zen: use the firefox skill",
  "--new":
    "safari has no --new: Safari allows one automation session per machine",
  "--id": "safari has no --id: there is only ever one session",
  "--full": "safari has no --full: WebDriver screenshots the viewport only",
};

export function parseArgs(argv: string[]): Invocation {
  const invocation: Invocation = {
    command: null,
    args: [],
    size: null,
    output: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (REFUSED[token]) throw new Error(REFUSED[token]);
    if (VALUE_FLAGS.has(token)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${token} needs a value`);
      if (token === "--size") invocation.size = value;
      else invocation.output = value;
    } else if (invocation.command === null) invocation.command = token;
    else invocation.args.push(token);
  }
  return invocation;
}

export function settle(status: number, body: any): unknown {
  const error = body?.value?.error;
  if (error)
    throw new Error(
      body.value.message ? `${error}: ${body.value.message}` : error,
    );
  if (status < 200 || status > 299)
    throw new Error(`safaridriver answered HTTP ${status}`);
  return body?.value;
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: object,
): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return settle(response.status, await response.json().catch(() => null));
}

/** The recorded session, if its driver still answers for it; a dead one is cleared. */
async function liveSession(): Promise<Session | null> {
  if (!existsSync(RECORD)) return null;
  const session = JSON.parse(readFileSync(RECORD, "utf8")) as Session;
  if (isAlive(session.driverPid)) {
    try {
      await call(session.port, "GET", `/session/${session.sessionId}/url`);
      return session;
    } catch {
      // A window the user closed by breaking the glass pane leaves the driver up.
    }
    process.kill(session.driverPid, "SIGTERM");
  }
  rmSync(RECORD, { force: true });
  return null;
}

async function start(): Promise<Session> {
  if (!existsSync(DRIVER))
    throw new Error(
      `no safaridriver at ${DRIVER}; Safari's driver ships with macOS`,
    );
  mkdirSync(STATE_DIR, { recursive: true });
  const port = await freePort();
  const driver = Bun.spawn([DRIVER, "-p", String(port)], {
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
  });
  driver.unref();

  const deadline = Date.now() + DRIVER_TIMEOUT_MS;
  for (;;) {
    try {
      if ((await call(port, "GET", "/status"))?.ready) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline || !isAlive(driver.pid)) {
      if (isAlive(driver.pid)) process.kill(driver.pid, "SIGTERM");
      throw new Error(
        `safaridriver did not answer on port ${port} within ${DRIVER_TIMEOUT_MS}ms`,
      );
    }
    await Bun.sleep(100);
  }

  try {
    const created = await call(port, "POST", "/session", {
      capabilities: { alwaysMatch: { browserName: "safari" } },
    });
    const session: Session = {
      driverPid: driver.pid,
      port,
      sessionId: created.sessionId,
    };
    writeFileSync(RECORD, JSON.stringify(session));
    return session;
  } catch (error) {
    process.kill(driver.pid, "SIGTERM");
    const message = error instanceof Error ? error.message : String(error);
    if (/already paired/.test(message)) {
      throw new Error(
        "another WebDriver session holds Safari — run `close`, or end that session first",
      );
    }
    if (message.startsWith("session not created")) {
      throw new Error(
        `${message}\nRun \`safaridriver --enable\` once to allow remote automation.`,
      );
    }
    throw error;
  }
}

async function run(invocation: Invocation): Promise<string> {
  const { command, args } = invocation;

  if (command === "close") {
    const session = await liveSession();
    if (!session) return "no session is open";
    await call(session.port, "DELETE", `/session/${session.sessionId}`).catch(
      () => {},
    );
    process.kill(session.driverPid, "SIGTERM");
    rmSync(RECORD, { force: true });
    return `closed ${session.sessionId}`;
  }

  if (command === "status") {
    const session = await liveSession();
    if (!session) return "no session is open";
    const path = `/session/${session.sessionId}`;
    return `${session.sessionId} ${await call(session.port, "GET", `${path}/url`)} ${await call(session.port, "GET", `${path}/title`)}`;
  }

  const existing = await liveSession();
  if (command !== "open" && !existing)
    throw new Error("no session is open — run `open <url>` first");
  const session = existing ?? (await start());
  const path = `/session/${session.sessionId}`;
  const send = (method: string, suffix: string, body?: object) =>
    call(session.port, method, `${path}${suffix}`, body);
  const element = async (selector: string): Promise<string> =>
    (
      await send("POST", "/element", { using: "css selector", value: selector })
    )[ELEMENT_KEY];

  switch (command) {
    case "open": {
      const [url] = need(args, 1, "open <url> [--size WxH]");
      if (invocation.size)
        await send("POST", "/window/rect", parseSize(invocation.size));
      await send("POST", "/url", { url });
      return `${session.sessionId} ${url} ${await send("GET", "/title")}`;
    }
    case "goto": {
      const [url] = need(args, 1, "goto <url>");
      await send("POST", "/url", { url });
      return `${url} ${await send("GET", "/title")}`;
    }
    case "back":
    case "forward":
    case "reload":
      await send("POST", command === "reload" ? "/refresh" : `/${command}`, {});
      return send("GET", "/url");
    case "text":
      return send("POST", "/execute/sync", {
        script: "return document.body?.innerText ?? '';",
        args: [],
      });
    case "eval": {
      const [expression] = need(args, 1, "eval <expression>");
      return printable(
        await send("POST", "/execute/sync", {
          script: script(expression),
          args: [],
        }),
      );
    }
    case "screenshot": {
      if (!invocation.output)
        throw new Error("usage: screenshot --output <path>");
      await Bun.write(
        invocation.output,
        Buffer.from(await send("GET", "/screenshot"), "base64"),
      );
      return invocation.output;
    }
    case "click": {
      const [selector] = need(args, 1, "click <selector>");
      await send("POST", `/element/${await element(selector)}/click`, {});
      return `clicked ${selector}`;
    }
    case "type": {
      const [selector, ...words] = need(args, 2, "type <selector> <text>");
      await send("POST", `/element/${await element(selector)}/value`, {
        text: words.join(" "),
      });
      return `typed into ${selector}`;
    }
    case "press": {
      const [first, second] = need(args, 1, "press [selector] <key>");
      const key = second ?? first!;
      const id =
        second === undefined
          ? (await send("GET", "/element/active"))[ELEMENT_KEY]
          : await element(first!);
      await send("POST", `/element/${id}/value`, { text: keyText(key) });
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
        if (
          await send("POST", "/execute/sync", {
            script: script(`!!(${expression})`),
            args: [],
          })
        ) {
          return `ok ${Date.now() - started}ms`;
        }
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
