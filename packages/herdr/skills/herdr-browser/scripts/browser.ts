#!/usr/bin/env bun

// One entry point for the whole skill. `open` reuses the live browser pane, or
// places one in a Herdr tab; the tab commands drive Chromium through the
// view-scoped CDP gateway the plugin CLI does not expose; everything else
// forwards to the plugin CLI with the view pinned. Output is lines, not pretty JSON, to stay cheap to read.

export type ViewInfo = {
  view_id: string;
  pane_id: string | null;
  url: string;
  title: string;
};

export type Automation = {
  view_id: string;
  cdp_http_url: string;
  browser_ws_url: string;
  active_target_id: string;
  active_page_ws_url: string | null;
};

export type WatchEvent =
  | {
      kind: "net";
      requestId: string;
      type: string;
      url: string;
      status: number | null;
      failure: string | null;
    }
  | { kind: "console"; level: string; text: string }
  | { kind: "exception"; text: string };

export type TargetDescriptor = {
  id: string;
  title: string;
  url: string;
};

export type Tab = {
  targetId: string;
  title: string;
  url: string;
  active: boolean;
};

export const PLACEMENTS = ["tab", "split", "overlay", "zoomed"] as const;

export type Placement = (typeof PLACEMENTS)[number];

export type Invocation = {
  command: string | null;
  args: string[];
  view: string | null;
  placement: Placement;
  all: boolean;
  body: string | null;
  device: string | null;
  size: string | null;
  fresh: boolean;
};

export type ConsoleEntry = {
  level: string;
  text: string;
  timestamp: number;
};

// Commands the plugin CLI already implements against the active Chromium tab.
// The value is its name there; arguments pass through untouched.
export const PASSTHROUGH: Record<string, string> = {
  goto: "open",
  eval: "eval",
  screenshot: "screenshot",
  "selector-click": "selector-click",
  type: "type",
  press: "press",
  wait: "wait",
  click: "click",
  wheel: "wheel",
  back: "back",
  forward: "forward",
  reload: "reload",
  status: "status",
};

export const USAGE = `browser.ts <command> [args] [--view VIEW_ID]

  open <url> [--new] [--placement tab|split|overlay|zoomed]
                              loads the url in the live browser pane; --new, or
                              no live pane, puts one in a Herdr tab (default tab)
  tabs                        list Chromium tabs
  new-tab <url>               Chromium tab in the open pane
  activate <n|targetId>       bring a tab to front
  close <n|targetId>          close a tab
  text                        active tab's page text
  goto <url>                  navigate the active tab
  eval <expression>           evaluate in the active tab
  screenshot --output <path>
  selector-click <selector> | type <selector> <text> | press [selector] <key>
  wait <expression> [timeoutMs] | click <x> <y> | wheel <x> <y> <deltaY>
  console [--all]             this page load's entries; --all keeps older ones
  back | forward | reload | status
  watch [url] [--body <url-fragment>]  reload or navigate, then report every
                              request, console line, and uncaught exception
  snapshot                    interactive elements as "ref role name"
  click-ref <ref>             click an element from the latest snapshot
  emulate --device iphone|ipad|laptop|desktop | --size 1440x900
                              sticky: the way back is another size
  endpoint                    CDP urls for Playwright, Browser Use, and friends`;

export function parseArgv(argv: string[]): Invocation {
  const positionals: string[] = [];
  let view: string | null = null;
  let placement: Placement = "tab";
  let all = false;
  let body: string | null = null;
  let device: string | null = null;
  let size: string | null = null;
  let fresh = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (
      token === "--view" ||
      token === "--placement" ||
      token === "--body" ||
      token === "--device" ||
      token === "--size"
    ) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`missing ${token} value`);
      }
      if (token === "--view") {
        view = value;
      } else if (token === "--body") {
        body = value;
      } else if (token === "--device") {
        device = value;
      } else if (token === "--size") {
        size = value;
      } else {
        if (!PLACEMENTS.includes(value as Placement)) {
          throw new Error(
            `invalid placement: ${value} (${PLACEMENTS.join(", ")})`,
          );
        }
        placement = value as Placement;
      }
      index += 1;
      continue;
    }
    if (token === "--all") {
      all = true;
      continue;
    }
    if (token === "--new") {
      fresh = true;
      continue;
    }
    positionals.push(token);
  }

  return {
    command: positionals[0] ?? null,
    args: positionals.slice(1),
    view,
    placement,
    all,
    body,
    device,
    size,
    fresh,
  };
}

// A view outlives the pane that owned it by some seconds, and a view whose pane
// is gone renders nowhere. Only panes Herdr still lists count.
export function renderedViews(
  views: ViewInfo[],
  livePaneIds: Set<string>,
): ViewInfo[] {
  return views.filter((view) => view.pane_id && livePaneIds.has(view.pane_id));
}

export async function waitForView(
  load: () => Promise<ViewInfo[]>,
  match: (views: ViewInfo[]) => ViewInfo | undefined,
  attempts = 40,
  delayMs = 250,
): Promise<ViewInfo> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = match(await load());
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("opened the browser pane but its view never appeared");
}

export function selectViewId(
  views: ViewInfo[],
  requested: string | null,
): string {
  if (views.length === 0) {
    throw new Error("no browser pane is rendering; run `open <url>` first");
  }
  if (!requested && views.length > 1) {
    const listing = views
      .map((view) => `  ${view.view_id} ${view.pane_id} ${view.url}`)
      .join("\n");
    throw new Error(
      `several browser panes are live; pass --view VIEW_ID\n${listing}`,
    );
  }
  const viewId = requested ?? views[0].view_id;
  if (!views.some((view) => view.view_id === viewId)) {
    throw new Error(`unknown view: ${viewId}`);
  }
  return viewId;
}

// A second pane costs a Herdr tab and leaves `--view` mandatory for every later
// command, so `open` lands in the pane already on screen unless told otherwise.
export function reuseViewId(
  views: ViewInfo[],
  requested: string | null,
  fresh: boolean,
): string | null {
  if (fresh || views.length === 0) {
    return null;
  }
  return selectViewId(views, requested);
}

export function toTab(
  descriptor: TargetDescriptor,
  activeTargetId: string,
): Tab {
  return {
    targetId: descriptor.id,
    title: descriptor.title,
    url: descriptor.url,
    active: descriptor.id === activeTargetId,
  };
}

// Target ids are 32 hex characters. Let the printed row number stand in.
export function resolveTargetId(tabs: Tab[], argument: string): string {
  if (/^\d+$/.test(argument)) {
    const tab = tabs[Number.parseInt(argument, 10) - 1];
    if (!tab) {
      throw new Error(`no tab ${argument}; there are ${tabs.length}`);
    }
    return tab.targetId;
  }
  if (!tabs.some((tab) => tab.targetId === argument)) {
    throw new Error(`unknown targetId: ${argument}`);
  }
  return argument;
}

// CDP only reports while a client is attached, so recording means driving the
// navigation ourselves. A request that never gets a response still matters — a
// blocked or refused fetch is usually the bug — and an uncaught exception never
// reaches the console buffer at all.
export function renderCallArguments(args: any[] = []): string {
  return args
    .map((arg) =>
      arg?.value !== undefined
        ? String(arg.value)
        : (arg?.description ?? arg?.type ?? ""),
    )
    .join(" ");
}

export function applyWatchMessage(
  events: WatchEvent[],
  message: { method?: string; params?: any },
): WatchEvent[] {
  if (message.method === "Network.responseReceived") {
    const { requestId, type, response } = message.params;
    return [
      ...events,
      {
        kind: "net",
        requestId,
        type,
        url: response.url,
        status: response.status,
        failure: null,
      },
    ];
  }
  if (message.method === "Network.loadingFailed") {
    const { requestId, type, errorText, blockedReason } = message.params;
    return [
      ...events,
      {
        kind: "net",
        requestId,
        type: type ?? "Other",
        url: "",
        status: null,
        failure: blockedReason ? `${errorText} (${blockedReason})` : errorText,
      },
    ];
  }
  if (message.method === "Network.requestWillBeSent") {
    // Only used to give a failed exchange its url once the failure arrives.
    const { requestId, request } = message.params;
    return [
      ...events,
      {
        kind: "net",
        requestId,
        type: "pending",
        url: request.url,
        status: null,
        failure: null,
      },
    ];
  }
  if (message.method === "Runtime.consoleAPICalled") {
    return [
      ...events,
      {
        kind: "console",
        level: message.params.type,
        text: renderCallArguments(message.params.args),
      },
    ];
  }
  if (message.method === "Runtime.exceptionThrown") {
    const { exceptionDetails } = message.params;
    return [
      ...events,
      {
        kind: "exception",
        text:
          exceptionDetails?.exception?.description ??
          exceptionDetails?.text ??
          "uncaught exception",
      },
    ];
  }
  return events;
}

// requestWillBeSent rows exist to name the failures; drop the ones that landed.
export function settleEvents(events: WatchEvent[]): WatchEvent[] {
  const urls = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "net" && event.url) {
      urls.set(event.requestId, event.url);
    }
  }
  const settled = new Set(
    events
      .filter((event) => event.kind === "net" && event.type !== "pending")
      .map(
        (event) => (event as Extract<WatchEvent, { kind: "net" }>).requestId,
      ),
  );
  return events
    .filter(
      (event) =>
        event.kind !== "net" ||
        event.type !== "pending" ||
        !settled.has(event.requestId),
    )
    .map((event) =>
      event.kind === "net"
        ? {
            ...event,
            url: event.url || urls.get(event.requestId) || "",
            type: event.type === "pending" ? "Other" : event.type,
          }
        : event,
    );
}

export function formatWatch(events: WatchEvent[]): string {
  return events
    .map((event) => {
      if (event.kind === "console") {
        return `${event.level} ${event.text}`;
      }
      if (event.kind === "exception") {
        return `EXCEPTION ${event.text.split("\n")[0]}`;
      }
      return event.failure
        ? `FAIL ${event.type} ${event.url} ${event.failure}`
        : `${event.status} ${event.type} ${event.url}`;
    })
    .join("\n");
}

// Only roles an agent can act on. The full tree is ~8x larger and mostly text.
export const INTERACTIVE_ROLES = [
  "link",
  "button",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "slider",
  "menuitem",
  "tab",
  "switch",
];

export function formatSnapshot(nodes: any[]): string {
  return nodes
    .filter(
      (node) =>
        INTERACTIVE_ROLES.includes(node.role?.value) &&
        node.name?.value &&
        node.backendDOMNodeId !== undefined,
    )
    .map(
      (node) =>
        `${node.backendDOMNodeId} ${node.role.value} ${JSON.stringify(node.name.value)}`,
    )
    .join("\n");
}

export const DEVICES: Record<
  string,
  { width: number; height: number; scale: number; mobile: boolean }
> = {
  iphone: { width: 390, height: 844, scale: 3, mobile: true },
  ipad: { width: 820, height: 1180, scale: 2, mobile: true },
  laptop: { width: 1440, height: 900, scale: 2, mobile: false },
  desktop: { width: 1920, height: 1080, scale: 1, mobile: false },
};

// The daemon keeps one console buffer per view, so entries from pages visited
// earlier sit in front of this page's. performance.timeOrigin is the cut.
export function sincePageLoad(
  entries: ConsoleEntry[],
  timeOrigin: number | null,
): ConsoleEntry[] {
  if (timeOrigin === null) {
    return entries;
  }
  return entries.filter((entry) => entry.timestamp >= timeOrigin);
}

export function formatEntries(entries: ConsoleEntry[]): string {
  return entries.map((entry) => `${entry.level} ${entry.text}`).join("\n");
}

export function formatTabs(tabs: Tab[]): string {
  return tabs
    .map((tab, index) =>
      `${index + 1}${tab.active ? "*" : " "} ${tab.url} ${tab.title}`.trimEnd(),
    )
    .join("\n");
}

// activate and close answer with plain text, not JSON.
export async function cdp<T>(url: string, method: "GET" | "PUT"): Promise<T> {
  const response = await fetch(url, { method });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${url} failed: ${response.status} ${body.trim()}`,
    );
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    return {} as T;
  }
}

export async function listTabs(
  base: string,
  activeTargetId: string,
): Promise<Tab[]> {
  const descriptors = await cdp<TargetDescriptor[]>(`${base}/json/list`, "GET");
  return descriptors.map((descriptor) => toTab(descriptor, activeTargetId));
}

export async function newTab(
  base: string,
  url: string,
): Promise<TargetDescriptor> {
  return await cdp<TargetDescriptor>(
    `${base}/json/new?url=${encodeURIComponent(url)}`,
    "PUT",
  );
}

export async function activateTab(
  base: string,
  targetId: string,
): Promise<void> {
  await cdp(`${base}/json/activate/${encodeURIComponent(targetId)}`, "GET");
}

export async function closeTab(base: string, targetId: string): Promise<void> {
  await cdp(`${base}/json/close/${encodeURIComponent(targetId)}`, "GET");
}

async function run(command: string[], viewId?: string): Promise<string> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: viewId
      ? { ...process.env, HERDR_BROWSER_VIEW_ID: viewId }
      : process.env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${command.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`,
    );
  }
  return stdout;
}

// Every command needs the plugin, so the failure has to carry the way out of it.
export function resolvePluginRoot(raw: string): string {
  const plugin = JSON.parse(raw)?.result?.plugins?.[0];
  if (!plugin?.plugin_root) {
    throw new Error(
      "herdr plugin official.browser is not installed\n" +
        "install it: herdr plugin install ogulcancelik/herdr-browser",
    );
  }
  if (plugin.enabled === false) {
    throw new Error(
      "herdr plugin official.browser is disabled\n" +
        "enable it: herdr plugin enable official.browser",
    );
  }
  return plugin.plugin_root;
}

async function pluginCli(): Promise<string[]> {
  const raw = await run([
    "herdr",
    "plugin",
    "list",
    "--plugin",
    "official.browser",
    "--json",
  ]);
  return ["bun", "run", `${resolvePluginRoot(raw)}/src/cli.ts`];
}

async function livePaneIds(): Promise<Set<string>> {
  const raw = await run(["herdr", "pane", "list"]);
  const panes = JSON.parse(raw)?.result?.panes ?? [];
  return new Set(
    panes.map((pane: { pane_id: string }) => pane.pane_id).filter(Boolean),
  );
}

async function loadViews(cli: string[]): Promise<ViewInfo[]> {
  const views: ViewInfo[] =
    JSON.parse(await run([...cli, "views"])).views ?? [];
  return renderedViews(views, await livePaneIds());
}

// The pane creates its own first tab, so hand it the url and let it land there.
async function openPane(url: string, placement: Placement): Promise<string> {
  if (!process.env.HERDR_ENV) {
    throw new Error("not inside a Herdr session; start Herdr, then retry");
  }
  const raw = await run([
    "herdr",
    "plugin",
    "pane",
    "open",
    "--plugin",
    "official.browser",
    "--entrypoint",
    "browser",
    "--placement",
    placement,
    "--env",
    `HERDR_BROWSER_INITIAL_URL=${url}`,
  ]);
  const paneId = JSON.parse(raw)?.result?.plugin_pane?.pane?.pane_id;
  if (!paneId) {
    throw new Error("herdr did not report the opened pane id");
  }
  return paneId;
}

type CdpSession = {
  send: (method: string, params?: unknown) => Promise<any>;
  onEvent: (handler: (message: any) => void) => void;
  close: () => void;
};

async function attach(pageWsUrl: string): Promise<CdpSession> {
  const socket = new WebSocket(pageWsUrl);
  const pending = new Map<number, (result: any) => void>();
  let handler: ((message: any) => void) | null = null;
  let messageId = 0;

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)?.(message.result ?? message.error);
      pending.delete(message.id);
      return;
    }
    handler?.(message);
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () =>
      reject(new Error(`cannot attach to ${pageWsUrl}`)),
    );
  });

  return {
    send: (method, params = {}) => {
      messageId += 1;
      socket.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve) => pending.set(messageId, resolve));
    },
    onEvent: (next) => {
      handler = next;
    },
    close: () => socket.close(),
  };
}

async function watchPage(
  session: CdpSession,
  url: string | null,
  bodyNeedle: string | null,
  idleMs = 1_500,
  capMs = 15_000,
): Promise<{ events: WatchEvent[]; body: string | null }> {
  let events: WatchEvent[] = [];
  let lastEventAt = Date.now();

  session.onEvent((message) => {
    const before = events.length;
    events = applyWatchMessage(events, message);
    if (events.length !== before) {
      lastEventAt = Date.now();
    }
  });

  await session.send("Network.enable");
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  // Runtime.enable replays the console messages the page already collected;
  // those belong to the load we are about to replace.
  await session.send("Runtime.discardConsoleEntries");
  events = [];
  lastEventAt = Date.now();
  await session.send(url ? "Page.navigate" : "Page.reload", url ? { url } : {});

  const startedAt = Date.now();
  while (Date.now() - lastEventAt < idleMs && Date.now() - startedAt < capMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const settled = settleEvents(events);
  let body: string | null = null;
  let device: string | null = null;
  let size: string | null = null;
  if (bodyNeedle) {
    const match = settled.find(
      (event) => event.kind === "net" && event.url.includes(bodyNeedle),
    ) as Extract<WatchEvent, { kind: "net" }> | undefined;
    if (!match) {
      throw new Error(`no request url contains ${bodyNeedle}`);
    }
    body =
      (
        await session.send("Network.getResponseBody", {
          requestId: match.requestId,
        })
      )?.body ?? null;
  }
  return { events: settled, body };
}

// backendDOMNodeId survives a detach but not a navigation or a re-render, so
// snapshot and click-ref belong next to each other in time.
async function clickRef(session: CdpSession, ref: string): Promise<string> {
  const resolved = await session.send("DOM.resolveNode", {
    backendNodeId: Number.parseInt(ref, 10),
  });
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error(`ref ${ref} is no longer on the page; snapshot again`);
  }
  const clicked = await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      "function(){this.scrollIntoView({block:'center'});this.click();return this.textContent?.trim().slice(0,80)??''}",
    returnByValue: true,
  });
  return clicked?.result?.value ?? "";
}

// Device metrics are the one override that outlives the session that set it —
// emulated media and network conditions die on detach, so this does not offer
// them. There is no clear either: the way back is another size.
export function resolveMetrics(
  device: string | null,
  size: string | null,
): { width: number; height: number; scale: number; mobile: boolean } {
  if (size) {
    const match = /^(\d+)x(\d+)$/.exec(size);
    if (!match) {
      throw new Error(`invalid size: ${size} (expected WIDTHxHEIGHT)`);
    }
    return {
      width: Number(match[1]),
      height: Number(match[2]),
      scale: 1,
      mobile: false,
    };
  }
  if (!device) {
    throw new Error("pass --device <name> or --size <WIDTHxHEIGHT>");
  }
  const metrics = DEVICES[device];
  if (!metrics) {
    throw new Error(
      `unknown device: ${device} (${Object.keys(DEVICES).join(", ")})`,
    );
  }
  return metrics;
}

async function emulate(
  session: CdpSession,
  device: string | null,
  size: string | null,
): Promise<string> {
  const metrics = resolveMetrics(device, size);
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: metrics.width,
    height: metrics.height,
    deviceScaleFactor: metrics.scale,
    mobile: metrics.mobile,
  });
  return `${metrics.width}x${metrics.height}`;
}

// about:blank and error pages can refuse to evaluate; then every entry stands.
async function pageTimeOrigin(
  cli: string[],
  viewId: string,
): Promise<number | null> {
  try {
    const value = JSON.parse(
      await run([...cli, "eval", "performance.timeOrigin"], viewId),
    ).value;
    return typeof value === "number" ? value : Number(value) || null;
  } catch {
    return null;
  }
}

function requireArg(value: string | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

async function main(argv: string[]): Promise<void> {
  const { command, args, view, placement, all, body, device, size, fresh } =
    parseArgv(argv);

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    console.log(USAGE);
    return;
  }

  const cli = await pluginCli();

  if (command === "open") {
    const url = requireArg(args[0], "missing URL");
    const reused = reuseViewId(await loadViews(cli), view, fresh);
    if (reused) {
      await run([...cli, PASSTHROUGH.goto, url], reused);
      const automation: Automation = JSON.parse(
        await run([...cli, "connect", "--view", reused]),
      );
      console.log(`view ${reused} reused`);
      console.log(
        formatTabs(
          await listTabs(automation.cdp_http_url, automation.active_target_id),
        ),
      );
      return;
    }
    const paneId = await openPane(url, placement);
    const opened = await waitForView(
      () => loadViews(cli),
      (views) => views.find((candidate) => candidate.pane_id === paneId),
    );
    const automation: Automation = JSON.parse(
      await run([...cli, "connect", "--view", opened.view_id]),
    );
    console.log(`view ${automation.view_id} pane ${paneId}`);
    console.log(
      formatTabs(
        await listTabs(automation.cdp_http_url, automation.active_target_id),
      ),
    );
    return;
  }

  const viewId = selectViewId(await loadViews(cli), view);

  if (command === "text") {
    console.log(JSON.parse(await run([...cli, "text"], viewId)).text ?? "");
    return;
  }

  if (command === "console") {
    const entries: ConsoleEntry[] =
      JSON.parse(await run([...cli, "console"], viewId)).entries ?? [];
    const timeOrigin = all ? null : await pageTimeOrigin(cli, viewId);
    console.log(formatEntries(sincePageLoad(entries, timeOrigin)));
    return;
  }

  const proxied = PASSTHROUGH[command];
  if (proxied) {
    process.stdout.write(await run([...cli, proxied, ...args], viewId));
    return;
  }

  const automation: Automation = JSON.parse(
    await run([...cli, "connect", "--view", viewId]),
  );
  const base = automation.cdp_http_url;

  if (
    command === "watch" ||
    command === "snapshot" ||
    command === "click-ref" ||
    command === "emulate"
  ) {
    if (!automation.active_page_ws_url) {
      throw new Error("the active tab exposes no CDP page socket");
    }
    const session = await attach(automation.active_page_ws_url);
    try {
      if (command === "watch") {
        const recorded = await watchPage(session, args[0] ?? null, body);
        console.log(formatWatch(recorded.events));
        if (recorded.body !== null) {
          console.log(`\n--- body ---\n${recorded.body}`);
        }
      } else if (command === "snapshot") {
        await session.send("Accessibility.enable");
        const tree = await session.send("Accessibility.getFullAXTree");
        console.log(formatSnapshot(tree?.nodes ?? []));
      } else if (command === "click-ref") {
        const label = await clickRef(
          session,
          requireArg(args[0], "missing ref from `snapshot`"),
        );
        console.log(label);
      } else {
        console.log(await emulate(session, device, size));
      }
    } finally {
      session.close();
    }
    return;
  }

  if (command === "endpoint") {
    console.log(`view        ${automation.view_id}`);
    console.log(`cdp_http    ${automation.cdp_http_url}`);
    console.log(`browser_ws  ${automation.browser_ws_url}`);
    console.log(`plugin_cli  ${cli.join(" ")}`);
    return;
  }

  const tabs = await listTabs(base, automation.active_target_id);

  if (command === "tabs") {
    console.log(formatTabs(tabs));
    return;
  }

  if (command === "new-tab") {
    const created = await newTab(base, requireArg(args[0], "missing URL"));
    console.log(formatTabs(await listTabs(base, created.id)));
    return;
  }

  if (command === "activate") {
    const targetId = resolveTargetId(tabs, requireArg(args[0], "missing tab"));
    await activateTab(base, targetId);
    console.log(formatTabs(await listTabs(base, targetId)));
    return;
  }

  if (command === "close") {
    await closeTab(
      base,
      resolveTargetId(tabs, requireArg(args[0], "missing tab")),
    );
    console.log(formatTabs(await listTabs(base, automation.active_target_id)));
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
