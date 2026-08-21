#!/usr/bin/env bun

// One entry point for the whole skill. terminal-browser answers "where is the
// CDP endpoint"; every page operation then runs over CDP. Output is lines, not
// pretty JSON, to stay cheap to read.

import {
  INSTALL_HINT,
  newcomer,
  parseTerminalBrowsers,
  selectTarget,
  terminalOpenArgs,
  type Tab,
  type Target,
} from "./backends";

export type { Tab, Target } from "./backends";
import {
  clickPoint,
  evaluate,
  formatEvalResult,
  history,
  landed,
  navigate,
  pageText,
  reload,
  screenshot,
  selectorClick,
  selectorPress,
  selectorType,
  waitFor,
  wheel,
  type CdpSession,
} from "./ops";

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

export type Invocation = {
  command: string | null;
  args: string[];
  view: string | null;
  all: boolean;
  body: string | null;
  device: string | null;
  size: string | null;
  fresh: boolean;
  split: string | null;
  ratio: string | null;
  output: string | null;
};

export type ConsoleEntry = {
  level: string;
  text: string;
  timestamp: number;
};

export const USAGE = `browser.ts <command> [args] [--view ID]

  open <url> [--new] [--split right|left|down|up] [--ratio 0.4]
                              loads the url in the live browser; --new, or no
                              live browser, opens one in a pane beside you
  status                      url, title, then the tab list
  tabs | new-tab <url> | activate <n> | close <n>
  text                        page text
  goto <url> | back | forward | reload
  snapshot                    actionable elements as "ref role name"
  click-ref <ref>             click one of them
  selector-click <sel> | type <sel> <text> | press [sel] <key>
  click <x> <y> | wheel <x> <y> <deltaY>
  eval <expression> | wait <expression> [timeoutMs]
  console [--all]             this page load's entries; --all keeps older ones
  watch [url] [--body <url-fragment>]  reload or navigate, then report every
                              request, console line, and uncaught exception
  screenshot --output <path>
  emulate --device iphone|ipad|laptop|desktop | --size 1440x900
                              sticky: the way back is another size
  endpoint                    CDP urls for Playwright, Browser Use, and friends`;

export function parseArgv(argv: string[]): Invocation {
  const positionals: string[] = [];
  let view: string | null = null;
  let all = false;
  let body: string | null = null;
  let device: string | null = null;
  let size: string | null = null;
  let fresh = false;
  let split: string | null = null;
  let ratio: string | null = null;
  let output: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (
      token === "--view" ||
      token === "--body" ||
      token === "--device" ||
      token === "--size" ||
      token === "--split" ||
      token === "--ratio" ||
      token === "--output"
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
      } else if (token === "--split") {
        split = value;
      } else if (token === "--ratio") {
        ratio = value;
      } else {
        output = value;
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
    all,
    body,
    device,
    size,
    fresh,
    split,
    ratio,
    output,
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

// getFullAXTree answers with a flat array whose order is Chromium's own
// serialization, not the document's — on Hacker News that puts the footer links
// ahead of the stories. Document order lives in childIds, so the tree has to be
// walked. Anything the root cannot reach still gets reported, at the end.
export function documentOrder(nodes: any[]): any[] {
  const byId = new Map(
    nodes.filter((node) => node.nodeId !== undefined).map((node) => [node.nodeId, node]),
  );
  // Identity, not nodeId: a node carrying no nodeId must not collapse into
  // every other one that also carries none.
  const seen = new Set<any>();
  const ordered: any[] = [];
  const walk = (node: any): void => {
    if (!node || seen.has(node)) {
      return;
    }
    seen.add(node);
    ordered.push(node);
    for (const child of node.childIds ?? []) {
      walk(byId.get(child));
    }
  };
  walk(nodes.find((node) => node.role?.value === "RootWebArea") ?? nodes[0]);
  return [...ordered, ...nodes.filter((node) => !seen.has(node))];
}

export function formatSnapshot(nodes: any[]): string {
  return documentOrder(nodes)
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

// Runtime.enable replays the whole buffer, so entries from pages visited earlier
// sit in front of this page's. performance.timeOrigin is the cut.
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

export async function closeTab(base: string, targetId: string): Promise<void> {
  await cdp(`${base}/json/close/${encodeURIComponent(targetId)}`, "GET");
}

// A hung child would otherwise become every command's latency. The child has to
// be killed too, or the pipes keep this process alive past the throw. The signal
// reaches the child alone, never the group: terminal-browser's own Electron
// process is detached and meant to outlive the CLI call.
export async function run(
  command: string[],
  timeoutMs?: number,
): Promise<string> {
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline =
    timeoutMs === undefined
      ? []
      : [
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              child.kill();
              reject(
                new Error(`${command.join(" ")} timed out after ${timeoutMs}ms`),
              );
            }, timeoutMs);
          }),
        ];
  const [stdout, stderr, code] = await Promise.race([
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]),
    ...deadline,
  ]);
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(
      `${command.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`,
    );
  }
  return stdout;
}

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
async function pageTimeOrigin(session: CdpSession): Promise<number | null> {
  try {
    const value = (await evaluate(session, "performance.timeOrigin"))?.value;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

// Runtime.enable replays the console the page collected before we attached, so
// a short-lived CLI reads the same buffer a resident daemon would have kept.
async function collectConsole(session: CdpSession): Promise<ConsoleEntry[]> {
  const entries: ConsoleEntry[] = [];
  session.onEvent((message) => {
    if (message.method === "Runtime.consoleAPICalled") {
      entries.push({
        level: message.params.type,
        text: renderCallArguments(message.params.args),
        timestamp: message.params.timestamp,
      });
    }
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      entries.push({
        level: "exception",
        text: (
          details?.exception?.description ??
          details?.text ??
          "uncaught exception"
        ).split("\n")[0],
        timestamp: message.params.timestamp,
      });
    }
  });
  await session.send("Runtime.enable");
  // The replay arrives as events after the reply, so it needs a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return entries;
}

function requireArg(value: string | null | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

// Long enough for a healthy terminal-browser to answer, short enough that a
// wedged one costs a pause rather than a hang.
const PROBE_TIMEOUT_MS = 3_000;

async function terminalTargets(): Promise<Target[]> {
  if (!Bun.which("terminal-browser")) {
    throw new Error(INSTALL_HINT);
  }
  return parseTerminalBrowsers(
    await run(["terminal-browser", "ls", "--all", "--json"], PROBE_TIMEOUT_MS),
  );
}

async function pageSocket(base: string, targetId: string): Promise<string> {
  const descriptors = await cdp<TargetDescriptor[]>(`${base}/json/list`, "GET");
  // Every terminal-browser pane shares one Electron process and one CDP port,
  // so /json/list carries other panes' pages too. Falling back to "the first
  // page" would silently drive somebody else's pane.
  const match = descriptors.find((descriptor) => descriptor.id === targetId);
  const socket = (match as any)?.webSocketDebuggerUrl;
  if (!socket) {
    throw new Error(`tab ${targetId} exposes no CDP page socket`);
  }
  return socket;
}

// The tab strip is a snapshot taken before the command ran, so anything that
// navigates, opens, or closes a tab has to re-read it — printing the stale one
// describes the page as it was, which reads exactly like success. null means
// the browser itself is gone: closing the last tab closes the pane.
async function refreshStrip(id: string): Promise<Tab[] | null> {
  return (await terminalTargets()).find((live) => live.id === id)?.tabs ?? null;
}

async function openTerminal(
  url: string,
  split: string | null,
  ratio: string | null,
  before: Target[],
): Promise<Target> {
  await run(["terminal-browser", ...terminalOpenArgs(url, split, ratio)]);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = newcomer(before, await terminalTargets());
    if (found) {
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("opened the browser but it never reported the page");
}

async function main(argv: string[]): Promise<void> {
  const {
    command,
    args,
    view,
    all,
    body,
    device,
    size,
    fresh,
    split,
    ratio,
    output,
  } = parseArgv(argv);

  if (
    !command ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    console.log(USAGE);
    return;
  }

  const terminal = await terminalTargets();

  let target: Target;

  if (command === "open") {
    const url = requireArg(args[0], "missing URL");
    if (!fresh && terminal.length > 0) {
      target = selectTarget(terminal, view);
      const socket = await attach(await pageSocket(target.cdpHttp, target.activeTargetId));
      try {
        console.log(await navigate(socket, url));
      } finally {
        socket.close();
      }
      const refreshed = await refreshStrip(target.id);
      console.log(refreshed ? formatTabs(refreshed) : `closed ${target.id}`);
      return;
    }
    target = await openTerminal(url, split, ratio, terminal);
    console.log(`view ${target.id} pane ${target.pane ?? "-"}`);
    console.log(formatTabs(target.tabs));
    return;
  }

  target = selectTarget(terminal, view);
  const base = target.cdpHttp;

  if (command === "endpoint") {
    console.log(`view        ${target.id}`);
    console.log(`cdp_http    ${base}`);
    console.log(
      `browser_ws  ${(await cdp<any>(`${base}/json/version`, "GET"))?.webSocketDebuggerUrl ?? "-"}`,
    );
    return;
  }

  // CDP /json/list orders by recency, the tab strip by creation, so the row
  // numbers only match what the user sees if terminal-browser's own list wins.
  const tabs = target.tabs;

  if (command === "tabs") {
    console.log(formatTabs(tabs));
    return;
  }

  if (command === "new-tab") {
    const url = requireArg(args[0], "missing URL");
    // Electron answers /json/new with a 500; terminal-browser's own command is
    // what keeps the new tab in its tab strip anyway.
    await run(["terminal-browser", "new-tab", "--browser", target.id, url]);
    const refreshed = await refreshStrip(target.id);
    console.log(refreshed ? formatTabs(refreshed) : `closed ${target.id}`);
    return;
  }

  if (command === "activate" || command === "close") {
    const row = requireArg(args[0], "missing tab");
    const targetId = resolveTargetId(tabs, row);
    if (command === "activate") {
      // CDP /json/activate leaves terminal-browser's tab strip untouched — the
      // tab never comes forward and the command reads as a success. Only the
      // strip's own id can bring it to the front.
      const strip = tabs.find((tab) => tab.targetId === targetId)?.id;
      if (strip === null || strip === undefined) {
        throw new Error(`tab ${row} carries no terminal-browser id to activate`);
      }
      await run([
        "terminal-browser", "action",
        "--browser", target.id,
        "--tab", String(strip),
        "--follow", "--", "get", "url",
      ]);
    } else {
      await closeTab(base, targetId);
    }
    const refreshed = await refreshStrip(target.id);
    console.log(refreshed ? formatTabs(refreshed) : `closed ${target.id}`);
    return;
  }

  const session = await attach(await pageSocket(base, target.activeTargetId));
  try {
    if (command === "watch") {
      const recorded = await watchPage(session, args[0] ?? null, body);
      console.log(formatWatch(recorded.events));
      if (recorded.body !== null) {
        console.log(`\n--- body ---\n${recorded.body}`);
      }
      return;
    }
    if (command === "console") {
      const entries = await collectConsole(session);
      const timeOrigin = all ? null : await pageTimeOrigin(session);
      console.log(formatEntries(sincePageLoad(entries, timeOrigin)));
      return;
    }
    if (command === "snapshot") {
      await session.send("Accessibility.enable");
      const tree = await session.send("Accessibility.getFullAXTree");
      console.log(formatSnapshot(tree?.nodes ?? []));
      return;
    }
    if (command === "click-ref") {
      console.log(
        await clickRef(session, requireArg(args[0], "missing ref from `snapshot`")),
      );
      return;
    }
    if (command === "emulate") {
      console.log(await emulate(session, device, size));
      return;
    }
    if (command === "text") {
      console.log(await pageText(session));
      return;
    }
    if (command === "status") {
      console.log(await landed(session));
      console.log(formatTabs(tabs));
      return;
    }
    if (command === "goto") {
      console.log(await navigate(session, requireArg(args[0], "missing URL")));
      return;
    }
    if (command === "back" || command === "forward") {
      console.log(await history(session, command));
      return;
    }
    if (command === "reload") {
      console.log(await reload(session));
      return;
    }
    if (command === "eval") {
      console.log(
        formatEvalResult(
          await evaluate(session, requireArg(args[0], "missing expression"), true),
        ),
      );
      return;
    }
    if (command === "wait") {
      const timeoutMs = args[1] === undefined ? 5_000 : Number(args[1]);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`invalid timeout: ${args[1]}`);
      }
      console.log(
        await waitFor(session, requireArg(args[0], "missing expression"), timeoutMs),
      );
      return;
    }
    if (command === "selector-click") {
      console.log(
        await selectorClick(session, requireArg(args[0], "missing selector")),
      );
      return;
    }
    if (command === "type") {
      console.log(
        await selectorType(
          session,
          requireArg(args[0], "missing selector"),
          requireArg(args.slice(1).join(" "), "missing text"),
        ),
      );
      return;
    }
    if (command === "press") {
      const [first, second] = args;
      requireArg(first, "missing key or selector");
      console.log(
        await selectorPress(session, second ? first : null, second ?? first),
      );
      return;
    }
    if (command === "click") {
      await clickPoint(session, coordinate(args[0], "x"), coordinate(args[1], "y"));
      console.log("ok");
      return;
    }
    if (command === "wheel") {
      await wheel(
        session,
        coordinate(args[0], "x"),
        coordinate(args[1], "y"),
        coordinate(args[2], "deltaY"),
      );
      console.log("ok");
      return;
    }
    if (command === "screenshot") {
      console.log(
        await screenshot(session, requireArg(output, "missing --output PATH")),
      );
      return;
    }
    throw new Error(`unknown command: ${command}`);
  } finally {
    session.close();
  }
}

export function coordinate(raw: string | undefined, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`missing or invalid ${name}: ${raw ?? ""}`);
  }
  return value;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
