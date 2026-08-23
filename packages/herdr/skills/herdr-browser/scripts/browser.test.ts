import { afterAll, describe, expect, test } from "bun:test";

import {
  cdp,
  DEVICES,
  closeTab,
  formatEntries,
  formatSnapshot,
  formatWatch,
  formatTabs,
  parseArgv,
  resolveMetrics,
  resolveTargetId,
  run,
  type Tab,
} from "./browser";
// The watch/console data model moved to the driver; these tests span both
// layers on purpose — they check that what ops produces is what browser prints.
import {
  applyWatchMessage,
  attach,
  renderCallArguments,
  settleEvents,
  sincePageLoad,
  type ConsoleEntry,
} from "./ops";

describe("parseArgv", () => {
  test("reads command and args, defaulting every flag", () => {
    expect(parseArgv(["open", "https://example.com"])).toEqual({
      command: "open",
      args: ["https://example.com"],
      view: null,
      all: false,
      device: null,
      size: null,
      body: null,
      fresh: false,
      split: null,
      ratio: null,
      output: null,
      full: false,
      passthrough: null,
    });
  });

  test("hands everything after -- to the passthrough, flags included", () => {
    const parsed = parseArgv([
      "raw",
      "--",
      "snapshot",
      "--json",
      "--view",
      "x",
    ]);
    expect(parsed.command).toBe("raw");
    expect(parsed.passthrough).toEqual(["snapshot", "--json", "--view", "x"]);
    // our own parser must not have eaten the agent-browser flags
    expect(parsed.view).toBeNull();
    expect(parsed.args).toEqual([]);
  });

  test("still reads our flags before the --", () => {
    const parsed = parseArgv(["raw", "--view", "abc", "--", "get", "url"]);
    expect(parsed.view).toBe("abc");
    expect(parsed.passthrough).toEqual(["get", "url"]);
  });

  test("takes --split and --ratio off the positionals", () => {
    const parsed = parseArgv([
      "open",
      "https://example.com",
      "--split",
      "down",
      "--ratio",
      "0.4",
    ]);
    expect(parsed.args).toEqual(["https://example.com"]);
    expect(parsed.split).toBe("down");
    expect(parsed.ratio).toBe("0.4");
  });

  test("reads --new as a switch", () => {
    expect(parseArgv(["open", "https://example.com", "--new"])).toMatchObject({
      command: "open",
      args: ["https://example.com"],
      fresh: true,
    });
  });

  test("reads --full as a switch", () => {
    expect(
      parseArgv(["screenshot", "--output", "/tmp/a.png", "--full"]),
    ).toMatchObject({
      command: "screenshot",
      args: [],
      output: "/tmp/a.png",
      full: true,
    });
  });

  test("strips flags from anywhere in the argv", () => {
    expect(parseArgv(["--view", "v1", "activate", "T1"])).toMatchObject({
      command: "activate",
      args: ["T1"],
      view: "v1",
    });
    expect(parseArgv(["activate", "T1", "--view", "v1"])).toMatchObject({
      command: "activate",
      args: ["T1"],
      view: "v1",
    });
  });

  test("reads --all as a switch", () => {
    expect(parseArgv(["console", "--all"])).toMatchObject({
      command: "console",
      args: [],
      all: true,
    });
    expect(parseArgv(["console"]).all).toBe(false);
  });

  test("keeps every argument for the commands that forward them", () => {
    expect(parseArgv(["type", "#q", "hello world"]).args).toEqual([
      "#q",
      "hello world",
    ]);
    const shot = parseArgv(["screenshot", "--output", "/tmp/a.png"]);
    expect(shot.args).toEqual([]);
    expect(shot.output).toBe("/tmp/a.png");
  });

  test("keeps the first positional when no flag is given", () => {
    expect(parseArgv(["tabs"]).command).toBe("tabs");
  });

  test("reports a flag without a value", () => {
    expect(() => parseArgv(["tabs", "--view"])).toThrow("missing --view value");
  });

  test("returns no command for an empty argv", () => {
    expect(parseArgv([]).command).toBeNull();
  });
});

describe("network recording", () => {
  const sent = (requestId: string, url: string) => ({
    method: "Network.requestWillBeSent",
    params: { requestId, request: { url } },
  });

  test("records a response with its status and type", () => {
    const exchanges = applyWatchMessage([], {
      method: "Network.responseReceived",
      params: {
        requestId: "1",
        type: "Document",
        response: { url: "http://x/", status: 200 },
      },
    });
    expect(formatWatch(settleEvents(exchanges))).toBe("200 Document http://x/");
  });

  test("keeps a request that failed, naming it from the earlier event", () => {
    let exchanges = applyWatchMessage([], sent("2", "http://x/api"));
    exchanges = applyWatchMessage(exchanges, {
      method: "Network.loadingFailed",
      params: { requestId: "2", type: "Fetch", errorText: "net::ERR_FAILED" },
    });
    expect(formatWatch(settleEvents(exchanges))).toBe(
      "FAIL Fetch http://x/api net::ERR_FAILED",
    );
  });

  test("names the blocked reason when Chrome gives one", () => {
    let exchanges = applyWatchMessage([], sent("3", "http://x/ad.js"));
    exchanges = applyWatchMessage(exchanges, {
      method: "Network.loadingFailed",
      params: {
        requestId: "3",
        type: "Script",
        errorText: "net::ERR_BLOCKED_BY_CLIENT",
        blockedReason: "inspector",
      },
    });
    expect(formatWatch(settleEvents(exchanges))).toContain("(inspector)");
  });

  test("drops the sent event once its response lands", () => {
    let exchanges = applyWatchMessage([], sent("4", "http://x/app.js"));
    exchanges = applyWatchMessage(exchanges, {
      method: "Network.responseReceived",
      params: {
        requestId: "4",
        type: "Script",
        response: { url: "http://x/app.js", status: 200 },
      },
    });
    expect(settleEvents(exchanges)).toHaveLength(1);
  });

  test("ignores CDP messages it does not track", () => {
    expect(
      applyWatchMessage([], { method: "Page.frameNavigated", params: {} }),
    ).toEqual([]);
  });

  test("records console calls with their level", () => {
    const events = applyWatchMessage([], {
      method: "Runtime.consoleAPICalled",
      params: { type: "warning", args: [{ value: "slow" }, { value: 42 }] },
    });
    expect(formatWatch(events)).toBe("warning slow 42");
  });

  test("records the uncaught exception the console buffer never sees", () => {
    const events = applyWatchMessage([], {
      method: "Runtime.exceptionThrown",
      params: {
        exceptionDetails: {
          text: "Uncaught",
          exception: {
            description: "TypeError: null has no boom\n    at x.js:18",
          },
        },
      },
    });
    expect(formatWatch(events)).toBe("EXCEPTION TypeError: null has no boom");
  });

  test("keeps console and network in the order they arrived", () => {
    let events = applyWatchMessage([], sent("5", "http://x/a.js"));
    events = applyWatchMessage(events, {
      method: "Runtime.consoleAPICalled",
      params: { type: "log", args: [{ value: "boot" }] },
    });
    events = applyWatchMessage(events, {
      method: "Network.responseReceived",
      params: {
        requestId: "5",
        type: "Script",
        response: { url: "http://x/a.js", status: 200 },
      },
    });
    expect(formatWatch(settleEvents(events))).toBe(
      "log boot\n200 Script http://x/a.js",
    );
  });
});

describe("renderCallArguments", () => {
  test("prefers a value, falls back to the description, then the type", () => {
    expect(
      renderCallArguments([
        { value: "a" },
        { description: "Object {x: 1}" },
        { type: "function" },
      ]),
    ).toBe("a Object {x: 1} function");
  });

  test("survives a call with no arguments", () => {
    expect(renderCallArguments()).toBe("");
  });
});

describe("formatSnapshot document order", () => {
  // getFullAXTree returns a flat array whose order is Chromium's serialization,
  // not the document's. The tree only exists in childIds.
  const scrambled = [
    {
      nodeId: "9",
      role: { value: "link" },
      name: { value: "Legal" },
      backendDOMNodeId: 91,
    },
    {
      nodeId: "1",
      role: { value: "RootWebArea" },
      name: { value: "x" },
      childIds: ["2", "3"],
    },
    { nodeId: "3", role: { value: "contentinfo" }, childIds: ["9"] },
    { nodeId: "2", role: { value: "navigation" }, childIds: ["4"] },
    {
      nodeId: "4",
      role: { value: "link" },
      name: { value: "Home" },
      backendDOMNodeId: 12,
    },
  ];

  test("walks childIds from the root instead of trusting the array", () => {
    expect(formatSnapshot(scrambled)).toBe('12 link "Home"\n91 link "Legal"');
  });

  test("still reports nodes the root cannot reach, rather than dropping them", () => {
    const orphaned = [
      ...scrambled,
      {
        nodeId: "77",
        role: { value: "button" },
        name: { value: "Orphan" },
        backendDOMNodeId: 77,
      },
    ];
    expect(formatSnapshot(orphaned)).toContain('77 button "Orphan"');
  });

  test("survives a childIds cycle without hanging", () => {
    const cyclic = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      {
        nodeId: "2",
        role: { value: "link" },
        name: { value: "A" },
        backendDOMNodeId: 5,
        childIds: ["1"],
      },
    ];
    expect(formatSnapshot(cyclic)).toBe('5 link "A"');
  });
});

describe("formatSnapshot", () => {
  const node = (id: number, role: string, name: string) => ({
    backendDOMNodeId: id,
    role: { value: role },
    name: { value: name },
  });

  test("keeps only what an agent can act on", () => {
    expect(
      formatSnapshot([
        node(1, "link", "Guidelines"),
        node(2, "StaticText", "just words"),
        node(3, "button", "Submit"),
      ]),
    ).toBe('1 link "Guidelines"\n3 button "Submit"');
  });

  test("drops a node with no name or no ref to click", () => {
    expect(
      formatSnapshot([
        { backendDOMNodeId: 4, role: { value: "link" }, name: { value: "" } },
        { role: { value: "button" }, name: { value: "Ghost" } },
      ]),
    ).toBe("");
  });
});

describe("resolveMetrics", () => {
  test("names widths an agent would ask for", () => {
    expect(DEVICES.iphone.width).toBe(390);
    expect(resolveMetrics("iphone", null).width).toBe(390);
    expect(resolveMetrics("desktop", null).mobile).toBe(false);
  });

  test("takes an explicit size, since there is no clear", () => {
    expect(resolveMetrics(null, "2686x1400")).toEqual({
      width: 2686,
      height: 1400,
      scale: 1,
      mobile: false,
    });
  });

  test("rejects a malformed size", () => {
    expect(() => resolveMetrics(null, "wide")).toThrow(/invalid size: wide/);
  });

  test("rejects an unknown device", () => {
    expect(() => resolveMetrics("watch", null)).toThrow(
      /unknown device: watch/,
    );
  });

  test("insists on one of the two", () => {
    expect(() => resolveMetrics(null, null)).toThrow(/--device|--size/);
  });
});

describe("sincePageLoad", () => {
  const entries: ConsoleEntry[] = [
    { level: "log", text: "previous page", timestamp: 100 },
    { level: "error", text: "this page", timestamp: 200 },
    { level: "warning", text: "later still", timestamp: 300 },
  ];

  test("drops entries logged before the page loaded", () => {
    expect(sincePageLoad(entries, 200).map((entry) => entry.text)).toEqual([
      "this page",
      "later still",
    ]);
  });

  test("keeps everything when the page would not report an origin", () => {
    expect(sincePageLoad(entries, null)).toEqual(entries);
  });
});

describe("formatEntries", () => {
  test("prints one level-and-text line per entry", () => {
    expect(
      formatEntries([
        { level: "error", text: "boom", timestamp: 1 },
        { level: "log", text: "fine", timestamp: 2 },
      ]),
    ).toBe("error boom\nlog fine");
  });
});

const tab = (id: string, active = false): Tab => ({
  id: null,
  targetId: id,
  title: "Hacker News",
  url: "https://news.ycombinator.com/",
  active,
});

describe("resolveTargetId", () => {
  const tabs = [tab("AAAA", true), tab("BBBB")];

  test("takes the printed row number", () => {
    expect(resolveTargetId(tabs, "2")).toBe("BBBB");
  });

  test("takes a full target id", () => {
    expect(resolveTargetId(tabs, "AAAA")).toBe("AAAA");
  });

  test("rejects a row that is not listed", () => {
    expect(() => resolveTargetId(tabs, "3")).toThrow("no tab 3; there are 2");
  });

  test("rejects an unknown target id", () => {
    expect(() => resolveTargetId(tabs, "ZZZZ")).toThrow(
      "unknown targetId: ZZZZ",
    );
  });
});

describe("formatTabs", () => {
  test("numbers the rows and stars the active one", () => {
    expect(formatTabs([tab("AAAA"), tab("BBBB", true)])).toBe(
      [
        "1  https://news.ycombinator.com/ Hacker News",
        "2* https://news.ycombinator.com/ Hacker News",
      ].join("\n"),
    );
  });

  test("leaves no trailing space when a tab has no title", () => {
    expect(formatTabs([{ ...tab("AAAA"), title: "" }])).toBe(
      "1  https://news.ycombinator.com/",
    );
  });
});

describe("gateway calls", () => {
  const requests: Array<{ method: string; path: string; search: string }> = [];

  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
      });
      if (url.pathname === "/json/list") {
        return Response.json([
          {
            id: "T1",
            title: "Example Domain",
            url: "https://example.com/",
            webSocketDebuggerUrl: "ws://x/devtools/page/T1",
          },
          {
            id: "T2",
            title: "Hacker News",
            url: "https://news.ycombinator.com/",
            webSocketDebuggerUrl: "ws://x/devtools/page/T2",
          },
        ]);
      }
      if (url.pathname.startsWith("/json/close/")) {
        return new Response("Target is closing");
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  afterAll(() => server.stop(true));

  test("closeTab tolerates a plain-text answer", async () => {
    requests.length = 0;
    await closeTab(base, "T2");
    expect(requests.map((request) => request.path)).toEqual(["/json/close/T2"]);
  });

  test("a failed call reports status and body", async () => {
    await expect(cdp(`${base}/json/nope`)).rejects.toThrow(/404 not found/);
  });
});

describe("attach", () => {
  // Each method drives one transport outcome; "Silent.hang" answers nothing.
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      return server.upgrade(request)
        ? undefined
        : new Response("expected a websocket", { status: 400 });
    },
    websocket: {
      message(socket, raw) {
        const { id, method } = JSON.parse(String(raw));
        if (method === "Ok.echo") {
          socket.send(JSON.stringify({ id, result: { ok: true } }));
        } else if (method === "Fail.protocol") {
          socket.send(
            JSON.stringify({
              id,
              error: { code: -32000, message: "Cannot find context" },
            }),
          );
        } else if (method === "Drop.socket") {
          socket.close();
        } else if (method === "Emit.event") {
          socket.send(
            JSON.stringify({ method: "Runtime.consoleAPICalled", params: {} }),
          );
          socket.send(JSON.stringify({ id, result: {} }));
        }
      },
    },
  });
  const wsUrl = `ws://127.0.0.1:${server.port}`;

  afterAll(() => server.stop(true));

  test("resolves with the reply's result", async () => {
    const session = await attach(wsUrl);
    expect(await session.send("Ok.echo")).toEqual({ ok: true });
    session.close();
  });

  test("rejects a protocol error instead of answering with it", async () => {
    const session = await attach(wsUrl);
    // Resolving here is what let a failed eval print an empty line as success.
    await expect(session.send("Fail.protocol")).rejects.toThrow(
      /Fail\.protocol failed: Cannot find context/,
    );
    session.close();
  });

  test("fails every call in flight when the socket closes", async () => {
    const session = await attach(wsUrl);
    const hung = session.send("Silent.hang");
    await session.send("Drop.socket").catch(() => {});
    await expect(hung).rejects.toThrow(/closed the CDP connection/);
  });

  test("fails a call made after the socket already closed", async () => {
    const session = await attach(wsUrl);
    await session.send("Drop.socket").catch(() => {});
    await Bun.sleep(50);
    // timeoutMs 0 on purpose: with no deadline to rescue it, a call the drain
    // does not catch stays pending forever.
    await expect(session.send("Ok.echo", {}, 0)).rejects.toThrow(
      /closed the CDP connection/,
    );
  });

  test("gives up on a command the browser never answers", async () => {
    const session = await attach(wsUrl);
    await expect(session.send("Silent.hang", {}, 100)).rejects.toThrow(
      /Silent\.hang got no answer in 100ms/,
    );
    session.close();
  });

  test("waits without a deadline when the timeout is disabled", async () => {
    const session = await attach(wsUrl);
    const hung = session.send("Silent.hang", {}, 0);
    const outcome = await Promise.race([
      hung.then(() => "settled").catch(() => "settled"),
      Bun.sleep(200).then(() => "pending"),
    ]);
    expect(outcome).toBe("pending");
    session.close();
  });

  test("routes a reply-less message to the event handler", async () => {
    const session = await attach(wsUrl);
    const seen: string[] = [];
    session.onEvent((message) => seen.push(message.method));
    await session.send("Emit.event");
    expect(seen).toEqual(["Runtime.consoleAPICalled"]);
    session.close();
  });
});

describe("run timeout", () => {
  test("kills a command that hangs, instead of waiting on it forever", async () => {
    const startedAt = Date.now();
    expect(run(["sleep", "10"], { timeoutMs: 200 })).rejects.toThrow(
      /timed out/,
    );
    await Bun.sleep(600);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("names the command it gave up on", async () => {
    expect(run(["sleep", "10"], { timeoutMs: 100 })).rejects.toThrow(
      /sleep 10/,
    );
  });

  test("leaves a command that answers in time alone", async () => {
    expect((await run(["echo", "hi"], { timeoutMs: 5_000 })).trim()).toBe("hi");
  });

  test("waits indefinitely when no timeout is given", async () => {
    expect((await run(["echo", "hi"])).trim()).toBe("hi");
  });
});
