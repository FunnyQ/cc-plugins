import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  cdp,
  DEVICES,
  closeTab,
  documentOrder,
  formatEntries,
  formatSnapshot,
  formatWatch,
  formatTabs,
  main,
  openTerminal,
  parseArgv,
  resolveMetrics,
  resolveTargetId,
  run,
  terminalTargets,
  type Deps,
  type Tab,
  type Target,
} from "./browser";
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

describe("documentOrder", () => {
  test("keeps every node without a nodeId instead of collapsing them into one", () => {
    const a = { role: { value: "link" } };
    const b = { role: { value: "button" } };
    const c = { role: { value: "link" } };
    const ordered = documentOrder([a, b, c]);
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered)).toEqual(new Set([a, b, c]));
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

const NO_DEADLINE = 0;

describe("attach", () => {
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
    await expect(session.send("Ok.echo", {}, NO_DEADLINE)).rejects.toThrow(
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
  const hang = [process.execPath, "-e", "setTimeout(() => {}, 10_000)"];
  const echo = [process.execPath, "-e", 'console.log("hi")'];

  test("kills a command that hangs, instead of waiting on it forever", async () => {
    const startedAt = Date.now();
    await expect(run(hang, { timeoutMs: 200 })).rejects.toThrow(
      /timed out/,
    );
    await Bun.sleep(600);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("names the command it gave up on", async () => {
    await expect(run(hang, { timeoutMs: 100 })).rejects.toThrow(
      hang.join(" "),
    );
  });

  test("leaves a command that answers in time alone", async () => {
    expect((await run(echo, { timeoutMs: 5_000 })).trim()).toBe("hi");
  });

  test("waits indefinitely when no timeout is given", async () => {
    expect((await run(echo)).trim()).toBe("hi");
  });
});

describe("commands that change the tab strip", () => {
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/json/list") {
        return Response.json([
          { id: "T1", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}` },
        ]);
      }
      if (url.pathname.startsWith("/json/close/")) {
        return new Response("Target is closing");
      }
      return server.upgrade(request)
        ? undefined
        : new Response("not found", { status: 404 });
    },
    websocket: {
      message(socket, raw) {
        const { id, method, params } = JSON.parse(String(raw));
        const value =
          method === "Runtime.evaluate" &&
          params.expression === "document.readyState"
            ? "complete"
            : ["https://example.com/", "Example"];
        socket.send(JSON.stringify({ id, result: { result: { value } } }));
      },
    },
  });
  afterAll(() => server.stop(true));

  const browser = (tabs: Tab[]): Target => ({
    id: "B1",
    cdpHttp: `http://127.0.0.1:${server.port}`,
    activeTargetId: "T1",
    pane: null,
    hostTab: null,
    url: "https://example.com/",
    title: "Example",
    tabs,
  });
  const stale: Tab[] = [
    {
      id: 1,
      targetId: "T1",
      url: "https://old.test/",
      title: "Old",
      active: true,
    },
    {
      id: 2,
      targetId: "T2",
      url: "https://two.test/",
      title: "Two",
      active: false,
    },
  ];
  const fresh: Tab[] = [
    {
      id: 1,
      targetId: "T1",
      url: "https://new.test/",
      title: "New",
      active: true,
    },
  ];

  async function printed(argv: string[], after: Target[]): Promise<string> {
    const reads = [[browser(stale)], after];
    const deps: Deps = {
      run: async () => "",
      terminalTargets: async () => reads.shift() ?? [],
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(argv, deps);
      return log.mock.calls.map((call) => call.join(" ")).join("\n");
    } finally {
      log.mockRestore();
    }
  }

  for (const argv of [
    ["open", "https://new.test/"],
    ["new-tab", "https://new.test/"],
    ["activate", "1"],
    ["close", "2"],
  ]) {
    test(`${argv[0]} prints the strip re-read after it ran, not the stale snapshot that reads like success`, async () => {
      const out = await printed(argv, [browser(fresh)]);
      expect(out).toContain(formatTabs(fresh));
      expect(out).not.toContain(formatTabs(stale));
    });

    test(`${argv[0]} prints closed <id> when the re-read finds the browser gone`, async () => {
      const out = await printed(argv, []);
      expect(out.split("\n").at(-1)).toBe("closed B1");
    });
  }
});

describe("openTerminal", () => {
  test("a failed open closes the herdr tab it made, so no empty tab reads as an opened browser", async () => {
    const saved = {
      pane: process.env.HERDR_PANE_ID,
      workspace: process.env.HERDR_WORKSPACE_ID,
    };
    process.env.HERDR_PANE_ID = "P0";
    process.env.HERDR_WORKSPACE_ID = "W0";
    const calls: string[][] = [];
    const deps: Deps = {
      run: async (command) => {
        calls.push(command);
        if (command[0] === "terminal-browser") {
          throw new Error("terminal-browser open failed: boom");
        }
        return JSON.stringify({
          result: { root_pane: { pane_id: "P9", tab_id: "T9" } },
        });
      },
      terminalTargets: async () => [],
    };
    try {
      await expect(
        openTerminal("https://example.com/", null, null, [], deps),
      ).rejects.toThrow(/boom/);
    } finally {
      for (const [key, value] of [
        ["HERDR_PANE_ID", saved.pane],
        ["HERDR_WORKSPACE_ID", saved.workspace],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(calls.at(-1)?.slice(1)).toEqual(["tab", "close", "T9"]);
  });

  describe("under herdr-app", () => {
    const keys = ["HC_TERMINAL_ID", "HERDR_PANE_ID"] as const;
    let saved: (string | undefined)[] = [];
    beforeEach(() => {
      saved = keys.map((key) => process.env[key]);
      process.env.HC_TERMINAL_ID = "t46";
      delete process.env.HERDR_PANE_ID;
    });
    afterEach(() => {
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    });

    const own: Target = {
      id: "new-view",
      cdpHttp: "http://127.0.0.1:1",
      activeTargetId: "target",
      pane: null,
      hostTab: null,
      url: "about:blank",
      title: "",
      tabs: [],
    };
    const layout = JSON.stringify({
      spaces: [
        {
          id: "sp1",
          tabs: [{ id: "tb1", terminals: [{ terminal: "t46", pane: "p1" }] }],
        },
      ],
    });
    const argv = (url: string) => [
      "env",
      "-u",
      "TERM_PROGRAM",
      "-u",
      "GHOSTTY_RESOURCES_DIR",
      "terminal-browser",
      "open",
      url,
    ];

    function fake(calls: string[][], screen = layout): Deps["run"] {
      return async (command) => {
        calls.push(command);
        if (command[0] === "herdr-app" && command[1] === "ls") return screen;
        if (command[1] === "status") return JSON.stringify({ tab: "tb0" });
        if (command[2] === "tab.new")
          return JSON.stringify({ space: "sp1", tab: "tb9", terminal: "t4f" });
        if (command[2] === "pane.split")
          return JSON.stringify({ pane: "p9", terminal: "t4f" });
        return "{}";
      };
    }

    test("opens the browser in a new tab of this space, named after the host, and shows the person's tab again", async () => {
      const calls: string[][] = [];
      let reads = 0;
      const found = await openTerminal(
        "https://example.com/a",
        null,
        null,
        [],
        {
          run: fake(calls),
          terminalTargets: async () => (reads++ === 0 ? [] : [own]),
        },
      );
      expect(found.id).toBe("new-view");
      expect(calls).toEqual([
        ["herdr-app", "ls"],
        ["herdr-app", "status"],
        [
          "herdr-app",
          "do",
          "tab.new",
          JSON.stringify({
            name: "example.com",
            space: "sp1",
            folder: process.cwd(),
            argv: argv("https://example.com/a"),
          }),
        ],
        ["herdr-app", "do", "tab.select", JSON.stringify({ id: "tb0" })],
      ]);
    });

    test("a URL with no host names the tab browser", async () => {
      const calls: string[][] = [];
      await openTerminal("about:blank", null, null, [], {
        run: fake(calls),
        terminalTargets: async () => [own],
      });
      expect(JSON.parse(calls[2][3]).name).toBe("browser");
    });

    test("--split splits this terminal's pane", async () => {
      const calls: string[][] = [];
      await openTerminal("about:blank", "down", null, [], {
        run: fake(calls),
        terminalTargets: async () => [own],
      });
      expect(calls[1]).toEqual([
        "herdr-app",
        "do",
        "pane.split",
        JSON.stringify({
          direction: "down",
          pane: "p1",
          argv: argv("about:blank"),
        }),
      ]);
    });

    test("--split left is refused, since herdr-app splits only right or down", async () => {
      const calls: string[][] = [];
      await expect(
        openTerminal("about:blank", "left", null, [], {
          run: fake(calls),
          terminalTargets: async () => [own],
        }),
      ).rejects.toThrow(/right or down/);
      expect(calls.some((c) => c[1] === "do")).toBe(false);
    });

    test("a terminal herdr-app does not show is refused", async () => {
      await expect(
        openTerminal("about:blank", null, null, [], {
          run: fake([], JSON.stringify({ spaces: [] })),
          terminalTargets: async () => [own],
        }),
      ).rejects.toThrow(/t46 is not shown in herdr-app/);
    });

    test("a browser that never reports has its tab closed", async () => {
      const calls: string[][] = [];
      const failure = new Error("gone");
      await expect(
        openTerminal("about:blank", null, null, [], {
          run: fake(calls),
          terminalTargets: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(calls.at(-1)).toEqual([
        "herdr-app",
        "do",
        "tab.close",
        JSON.stringify({ id: "tb9", confirmed: true }),
      ]);
    });

    test("a split browser that never reports has its pane closed", async () => {
      const calls: string[][] = [];
      await expect(
        openTerminal("about:blank", "right", null, [], {
          run: fake(calls),
          terminalTargets: async () => {
            throw new Error("gone");
          },
        }),
      ).rejects.toThrow("gone");
      expect(calls.at(-1)).toEqual([
        "herdr-app",
        "do",
        "pane.close",
        JSON.stringify({ pane: "p9" }),
      ]);
    });
  });
});

describe("browser prerequisite boundary", () => {
  test("a missing terminal-browser reports its platform, without invoking a CLI", async () => {
    let ran = false;
    await expect(terminalTargets(async () => {
      ran = true;
      return "";
    }, "win32", () => null)).rejects.toThrow(/terminal-browser is not installed[\s\S]*native Windows/);
    expect(ran).toBe(false);
  });

  test("a found terminal-browser CLI error is propagated as a CLI error", async () => {
    const error = new Error("terminal-browser ls failed: connection refused");
    await expect(terminalTargets(async (command) => {
      expect(command).toEqual(["terminal-browser", "ls", "--all", "--json"]);
      throw error;
    }, "win32", () => "C:/Program Files/terminal-browser.exe")).rejects.toBe(error);
  });

  test("run diagnoses a missing Herdr executable before spawning", async () => {
    const which = spyOn(Bun, "which").mockReturnValue(null);
    const spawn = spyOn(Bun, "spawn");
    try {
      await expect(run([process.env.HERDR_BIN_PATH || "herdr", "tab", "create"])).rejects.toThrow(/herdr is not installed/);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      which.mockRestore();
      spawn.mockRestore();
    }
  });

  test("run preserves errors from a found Herdr CLI override", async () => {
    const saved = process.env.HERDR_BIN_PATH;
    process.env.HERDR_BIN_PATH = process.execPath;
    try {
      const modulePath = `./browser.ts?found-cli=${Date.now()}`;
      const isolated: typeof import("./browser") = await import(modulePath);
      await expect(isolated.run([
        process.execPath,
        "-e",
        'console.error("connection refused"); process.exit(7)',
      ])).rejects.toThrow(/failed: connection refused/);
    } finally {
      if (saved === undefined) delete process.env.HERDR_BIN_PATH;
      else process.env.HERDR_BIN_PATH = saved;
    }
  });
});

describe("Herdr executable and cleanup ownership", () => {
  test("all tab and pane calls keep a spaced override as one argv element", async () => {
    const keys = ["HERDR_BIN_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID"] as const;
    const saved = keys.map((key) => process.env[key]);
    const executable = "C:/Program Files/Herdr/herdr.exe";
    process.env.HERDR_BIN_PATH = executable;
    process.env.HERDR_PANE_ID = "initiator";
    process.env.HERDR_WORKSPACE_ID = "workspace";
    const modulePath = `./browser.ts?override=${Date.now()}`;
    const isolated: typeof import("./browser") = await import(modulePath);
    const calls: string[][] = [];
    const own: Target = {
      id: "new-view", cdpHttp: "http://127.0.0.1:1", activeTargetId: "target",
      pane: "new-browser-pane", hostTab: "new-tab", url: "about:blank", title: "", tabs: [],
    };
    const other: Target = { ...own, id: "other-view", pane: "other-pane", hostTab: "other-tab" };
    const created = JSON.stringify({ result: { root_pane: { pane_id: "new-shell", tab_id: "new-tab" } } });
    const deps: Deps = {
      run: async (command, options) => {
        calls.push(command);
        if (command[0] === "terminal-browser") {
          expect(options?.env).toEqual({ HERDR_PANE_ID: "new-shell", HERDR_TAB_ID: "new-tab" });
          return "";
        }
        return created;
      },
      terminalTargets: async () => [other, own],
    };
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await isolated.main(["open", "https://example.com/?q=a&b=%20", "--new"], {
        ...deps,
        terminalTargets: (() => {
          let reads = 0;
          return async () => reads++ === 0 ? [other] : [other, own];
        })(),
      });
      expect(calls).toEqual([
        [executable, "tab", "create", "--workspace", "workspace", "--cwd", process.cwd(), "--label", "browser", "--no-focus"],
        ["terminal-browser", "open", "https://example.com/?q=a&b=%20"],
        [executable, "pane", "close", "new-shell"],
      ]);

      calls.length = 0;
      await expect(isolated.main(["raw", "--", "get", "title"], deps)).rejects.toThrow(/--view/);
      await isolated.main(["raw", "--view", "other-view", "--", "get", "title"], {
        ...deps,
        run: async (command) => { calls.push(command); return "Other view"; },
      });
      expect(calls).toEqual([["terminal-browser", "action", "--browser", "other-view", "--", "get", "title"]]);

      const server = Bun.serve({ port: 0, fetch: () => new Response("Target is closing") });
      try {
        for (const label of ["browser", "unrelated"]) {
          calls.length = 0;
          let reads = 0;
          await isolated.main(["close", "1", "--view", "new-view"], {
            run: async (command) => {
              calls.push(command);
              return JSON.stringify({ result: { tab: { label } } });
            },
            terminalTargets: async () => reads++ === 0
              ? [other, { ...own, cdpHttp: `http://127.0.0.1:${server.port}`, tabs: [{ ...tab("target", true), id: 7 }] }]
              : [other],
          });
          expect(calls).toEqual(label === "browser"
            ? [[executable, "tab", "get", "new-tab"], [executable, "tab", "close", "new-tab"]]
            : [[executable, "tab", "get", "new-tab"]]);
        }
      } finally {
        server.stop(true);
      }

      calls.length = 0;
      const failure = new Error("open failed after tab creation");
      await expect(isolated.openTerminal("about:blank", null, null, [other], {
        ...deps,
        run: async (command) => {
          calls.push(command);
          if (command[0] === "terminal-browser") throw failure;
          return created;
        },
      })).rejects.toBe(failure);
      expect(calls.at(-1)).toEqual([executable, "tab", "close", "new-tab"]);
      expect(calls.filter((command) => command.includes("close"))).toEqual([[executable, "tab", "close", "new-tab"]]);

      calls.length = 0;
      await expect(isolated.openTerminal("about:blank", "right", "0.4", [other], {
        ...deps,
        run: async (command) => { calls.push(command); throw failure; },
      })).rejects.toBe(failure);
      expect(calls).toEqual([["terminal-browser", "open", "about:blank", "--split", "right", "--size", "0.4"]]);

      calls.length = 0;
      await expect(isolated.openTerminal("about:blank", null, null, [other], {
        ...deps,
        terminalTargets: async () => { throw failure; },
      })).rejects.toBe(failure);
      expect(calls.filter((command) => command.includes("close"))).toEqual([[executable, "tab", "close", "new-tab"]]);
    } finally {
      log.mockRestore();
      keys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    }
  });
});
