import { afterAll, describe, expect, test } from "bun:test";

import {
  activateTab,
  applyWatchMessage,
  cdp,
  DEVICES,
  closeTab,
  formatEntries,
  formatSnapshot,
  formatWatch,
  formatTabs,
  listTabs,
  newTab,
  parseArgv,
  renderCallArguments,
  renderedViews,
  resolveMetrics,
  resolvePluginRoot,
  resolveTargetId,
  run,
  settleEvents,
  sincePageLoad,
  toTab,
  waitForView,
  type Tab,
  type ViewInfo,
} from "./browser";

describe("parseArgv", () => {
  test("reads command and args, defaulting every flag", () => {
    expect(parseArgv(["open", "https://example.com"])).toEqual({
      command: "open",
      args: ["https://example.com"],
      view: null,
      placement: null,
      all: false,
      device: null,
      size: null,
      body: null,
      fresh: false,
      backend: null,
      split: null,
      ratio: null,
      output: null,
    });
  });

  test("reads --backend, and rejects one that is neither", () => {
    expect(parseArgv(["text", "--backend", "herdr"]).backend).toBe("herdr");
    expect(() => parseArgv(["text", "--backend", "firefox"])).toThrow(/firefox/);
  });

  test("takes --split and --ratio off the positionals", () => {
    const parsed = parseArgv([
      "open", "https://example.com", "--split", "down", "--ratio", "0.4",
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

  test("reads a placement", () => {
    expect(
      parseArgv(["open", "https://example.com", "--placement", "split"])
        .placement,
    ).toBe("split");
  });

  test("rejects an unknown placement", () => {
    expect(() => parseArgv(["open", "u", "--placement", "window"])).toThrow(
      /invalid placement: window/,
    );
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
    { nodeId: "9", role: { value: "link" }, name: { value: "Legal" }, backendDOMNodeId: 91 },
    { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "x" }, childIds: ["2", "3"] },
    { nodeId: "3", role: { value: "contentinfo" }, childIds: ["9"] },
    { nodeId: "2", role: { value: "navigation" }, childIds: ["4"] },
    { nodeId: "4", role: { value: "link" }, name: { value: "Home" }, backendDOMNodeId: 12 },
  ];

  test("walks childIds from the root instead of trusting the array", () => {
    expect(formatSnapshot(scrambled)).toBe(
      '12 link "Home"\n91 link "Legal"',
    );
  });

  test("still reports nodes the root cannot reach, rather than dropping them", () => {
    const orphaned = [
      ...scrambled,
      { nodeId: "77", role: { value: "button" }, name: { value: "Orphan" }, backendDOMNodeId: 77 },
    ];
    expect(formatSnapshot(orphaned)).toContain('77 button "Orphan"');
  });

  test("survives a childIds cycle without hanging", () => {
    const cyclic = [
      { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
      { nodeId: "2", role: { value: "link" }, name: { value: "A" }, backendDOMNodeId: 5, childIds: ["1"] },
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
  const entries = [
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

describe("resolvePluginRoot", () => {
  test("takes the root of the first listed plugin", () => {
    const raw = JSON.stringify({
      result: { plugins: [{ plugin_root: "/plugins/official.browser" }] },
    });
    expect(resolvePluginRoot(raw)).toBe("/plugins/official.browser");
  });

  test("tells an empty list how to install the plugin", () => {
    const raw = JSON.stringify({ result: { plugins: [] } });
    expect(() => resolvePluginRoot(raw)).toThrow(
      "herdr plugin install ogulcancelik/herdr-browser",
    );
  });

  test("tells a disabled plugin how to enable it", () => {
    const raw = JSON.stringify({
      result: {
        plugins: [{ plugin_root: "/plugins/official.browser", enabled: false }],
      },
    });
    expect(() => resolvePluginRoot(raw)).toThrow(
      "herdr plugin enable official.browser",
    );
  });
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

const view = (id: string, paneId: string | null = null): ViewInfo => ({
  view_id: id,
  pane_id: paneId,
  url: "https://example.com/",
  title: "Example Domain",
});

describe("renderedViews", () => {
  test("keeps views whose pane is still live", () => {
    const views = [view("v1", "w1:p1"), view("v2", "w1:p2")];
    expect(renderedViews(views, new Set(["w1:p2"]))).toEqual([views[1]]);
  });

  test("drops a view that outlived its closed pane", () => {
    expect(renderedViews([view("v1", "w1:p9")], new Set(["w1:p1"]))).toEqual(
      [],
    );
  });

  test("drops a headless view that no pane renders", () => {
    expect(renderedViews([view("v1", null)], new Set(["w1:p1"]))).toEqual([]);
  });
});

describe("waitForView", () => {
  const byPane =
    (paneId: string) =>
    (views: ViewInfo[]): ViewInfo | undefined =>
      views.find((candidate) => candidate.pane_id === paneId);

  test("returns the view belonging to the pane it opened", async () => {
    const answers: ViewInfo[][] = [
      [],
      [view("old", "w1:p1")],
      [view("old", "w1:p1"), view("fresh", "w1:p2")],
    ];
    let calls = 0;
    const found = await waitForView(
      async () => answers[calls++],
      byPane("w1:p2"),
      5,
      0,
    );
    expect(found.view_id).toBe("fresh");
    expect(calls).toBe(3);
  });

  test("gives up after the last attempt", async () => {
    let calls = 0;
    const wait = waitForView(
      async () => {
        calls += 1;
        return [];
      },
      byPane("w1:p2"),
      3,
      0,
    );
    await expect(wait).rejects.toThrow(/never appeared/);
    expect(calls).toBe(3);
  });
});

describe("toTab", () => {
  const descriptor = {
    id: "T1",
    title: "Hacker News",
    url: "https://news.ycombinator.com/",
    webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/page/T1",
  };

  test("marks the active target", () => {
    expect(toTab(descriptor, "T1").active).toBe(true);
    expect(toTab(descriptor, "T2").active).toBe(false);
  });

  test("drops the websocket url", () => {
    expect(toTab(descriptor, "T1")).toEqual({
      id: null,
      targetId: "T1",
      title: "Hacker News",
      url: "https://news.ycombinator.com/",
      active: true,
    });
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
      if (url.pathname === "/json/new") {
        return Response.json({
          id: "T2",
          title: "",
          url: url.searchParams.get("url"),
          webSocketDebuggerUrl: "ws://x/devtools/page/T2",
        });
      }
      if (url.pathname.startsWith("/json/activate/")) {
        return new Response("Target activated");
      }
      if (url.pathname.startsWith("/json/close/")) {
        return new Response("Target is closing");
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;

  afterAll(() => server.stop(true));

  test("listTabs maps descriptors and flags the active tab", async () => {
    expect(await listTabs(base, "T2")).toEqual([
      {
        id: null,
        targetId: "T1",
        title: "Example Domain",
        url: "https://example.com/",
        active: false,
      },
      {
        id: null,
        targetId: "T2",
        title: "Hacker News",
        url: "https://news.ycombinator.com/",
        active: true,
      },
    ]);
  });

  test("newTab PUTs the url intact through the query string", async () => {
    requests.length = 0;
    const created = await newTab(base, "https://example.com/a?b=c&d=e#f");
    expect(created.url).toBe("https://example.com/a?b=c&d=e#f");
    expect(requests[0]).toEqual({
      method: "PUT",
      path: "/json/new",
      search: `?url=${encodeURIComponent("https://example.com/a?b=c&d=e#f")}`,
    });
  });

  test("activateTab and closeTab tolerate plain-text answers", async () => {
    requests.length = 0;
    await activateTab(base, "T1");
    await closeTab(base, "T2");
    expect(requests.map((request) => request.path)).toEqual([
      "/json/activate/T1",
      "/json/close/T2",
    ]);
  });

  test("a failed call reports status and body", async () => {
    await expect(cdp(`${base}/json/nope`, "GET")).rejects.toThrow(
      /404 not found/,
    );
  });
});

describe("run timeout", () => {
  test("kills a command that hangs, instead of waiting on it forever", async () => {
    const startedAt = Date.now();
    expect(run(["sleep", "10"], undefined, 200)).rejects.toThrow(/timed out/);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("names the command it gave up on", async () => {
    expect(run(["sleep", "10"], undefined, 100)).rejects.toThrow(/sleep 10/);
  });

  test("leaves a command that answers in time alone", async () => {
    expect((await run(["echo", "hi"], undefined, 5_000)).trim()).toBe("hi");
  });

  test("waits indefinitely when no timeout is given", async () => {
    expect((await run(["echo", "hi"])).trim()).toBe("hi");
  });
});
