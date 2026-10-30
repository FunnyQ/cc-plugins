#!/usr/bin/env bun

import {
  requireExecutable,
  newcomer,
  parseTerminalBrowsers,
  selectTarget,
  terminalOpenArgs,
  herdrTabCreateArgs,
  parseHerdrTab,
  herdrTabLabel,
  appBrowserArgv,
  appPlaceOf,
  appTabName,
  type HerdrTab,
  type Tab,
  type Target,
} from "./terminal-browser";

export type { Tab, Target } from "./terminal-browser";
import {
  attach,
  axTree,
  clickPoint,
  clickRef,
  collectConsole,
  cookieSetParams,
  cookiesClear,
  cookiesGet,
  cookiesSet,
  emulate,
  evaluate,
  formatEvalResult,
  history,
  landed,
  navigate,
  pageText,
  pageTimeOrigin,
  reload,
  screenshot,
  setHeaders,
  selectorClick,
  selectorPress,
  selectorType,
  sincePageLoad,
  waitFor,
  watchPage,
  wheel,
  CDP_TIMEOUT_MS,
  type CdpSession,
  type ConsoleEntry,
  type DeviceMetrics,
  type WatchEvent,
} from "./ops";

export type TargetDescriptor = {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
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
  full: boolean;
  passthrough: string[] | null;
};

export const USAGE = `browser.ts <command> [args] [--view ID]

  open <url> [--new] [--split right|left|down|up] [--ratio 0.4]
                              loads the url in the live browser; --new, or no
                              live browser, opens one in its own Herdr tab;
                              --split carves the focused pane instead
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
  screenshot --output <path> [--full]  --full captures the whole page; it is
                              reliable on a static page only, see SKILL.md
  cookies [get] | cookies set <name> <value> [--url U] [--domain D] [--path P]
                              [--http-only] [--secure] [--same-site Lax] [--expires N]
  headers '{"Authorization":"Bearer ..."}'   sent with every request from now on
  emulate --device iphone|ipad|laptop|desktop | --size 1440x900
                              sticky: the way back is another size
  endpoint                    CDP urls for Playwright, Browser Use, and friends
  raw -- <agent-browser cmd>  anything not native yet: cookies, har, route, pdf,
                              trace, record, diff, vitals, a11y. Verbose --
                              prefer the native command when there is one`;

// Maps rather than object literals: `token in obj` would match `__proto__`.
const VALUE_FLAGS = new Map<
  string,
  "view" | "body" | "device" | "size" | "split" | "ratio" | "output"
>([
  ["--view", "view"],
  ["--body", "body"],
  ["--device", "device"],
  ["--size", "size"],
  ["--split", "split"],
  ["--ratio", "ratio"],
  ["--output", "output"],
]);

const BOOLEAN_FLAGS = new Map<string, "all" | "fresh" | "full">([
  ["--all", "all"],
  ["--new", "fresh"],
  ["--full", "full"],
]);

export function parseArgv(argv: string[]): Invocation {
  const positionals: string[] = [];
  const parsed: Invocation = {
    command: null,
    args: [],
    view: null,
    all: false,
    body: null,
    device: null,
    size: null,
    fresh: false,
    split: null,
    ratio: null,
    output: null,
    full: false,
    passthrough: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      parsed.passthrough = argv.slice(index + 1);
      break;
    }
    const valued = VALUE_FLAGS.get(token);
    if (valued) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`missing ${token} value`);
      }
      parsed[valued] = value;
      index += 1;
      continue;
    }
    const flagged = BOOLEAN_FLAGS.get(token);
    if (flagged) {
      parsed[flagged] = true;
      continue;
    }
    positionals.push(token);
  }

  parsed.command = positionals[0] ?? null;
  parsed.args = positionals.slice(1);
  return parsed;
}

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
    nodes
      .filter((node) => node.nodeId !== undefined)
      .map((node) => [node.nodeId, node]),
  );
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

// /json/close answers with plain text, not JSON, and its body is never read.
export async function cdp<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${body.trim()}`);
  }
  try {
    return JSON.parse(body) as T;
  } catch {
    return {} as T;
  }
}

export async function closeTab(base: string, targetId: string): Promise<void> {
  await cdp(`${base}/json/close/${encodeURIComponent(targetId)}`);
}

// A hung child would otherwise become every command's latency. The child has to
// be killed too, or the pipes keep this process alive past the throw. The signal
// reaches the child alone, never the group: terminal-browser's own Electron
// process is detached and meant to outlive the CLI call.
export type RunOpts = {
  timeoutMs?: number;
  env?: Record<string, string>;
  failureName?: string;
};

export async function run(
  command: string[],
  { timeoutMs, env, failureName }: RunOpts = {},
): Promise<string> {
  const dependency =
    command[0] === "terminal-browser"
      ? "terminal-browser"
      : command[0] === HERDR_BIN ? "herdr" : null;
  if (dependency) requireExecutable(command[0], dependency);
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env:
      command[0] === "terminal-browser" && inHerdrApp()
        ? withoutGhostty({ ...process.env, ...env })
        : env
          ? { ...process.env, ...env }
          : process.env,
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
                new Error(
                  `${command.join(" ")} timed out after ${timeoutMs}ms`,
                ),
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
      `${failureName ?? command.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`,
    );
  }
  return stdout;
}

// herdr-app hands its terminals Ghostty's TERM_PROGRAM and resources dir, so
// terminal-browser picks its Ghostty adapter and fails: "Ghostty is not
// running, so there is no window to script". Without the two it finds its
// browsers.
function withoutGhostty(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const { TERM_PROGRAM: _t, GHOSTTY_RESOURCES_DIR: _g, ...rest } = env;
  return rest;
}

function inHerdrApp(): boolean {
  return !!process.env.HC_TERMINAL_ID && !process.env.HERDR_PANE_ID;
}

export function resolveMetrics(
  device: string | null,
  size: string | null,
): DeviceMetrics {
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

function requireArg(value: string | null | undefined, message: string): string {
  if (!value) {
    throw new Error(message);
  }
  return value;
}

const PROBE_TIMEOUT_MS = 3_000;

export async function terminalTargets(
  exec: typeof run = run,
  platform: NodeJS.Platform = process.platform,
  which: (executable: string) => string | null = Bun.which,
): Promise<Target[]> {
  requireExecutable("terminal-browser", "terminal-browser", platform, which);
  return parseTerminalBrowsers(
    await exec(["terminal-browser", "ls", "--all", "--json"], {
      timeoutMs: PROBE_TIMEOUT_MS,
    }),
  );
}

async function pageSocket(base: string, targetId: string): Promise<string> {
  const descriptors = await cdp<TargetDescriptor[]>(`${base}/json/list`);
  // Every terminal-browser pane shares one Electron process and one CDP port,
  // so /json/list carries other panes' pages too. Falling back to "the first
  // page" would silently drive somebody else's pane.
  const match = descriptors.find((descriptor) => descriptor.id === targetId);
  const socket = match?.webSocketDebuggerUrl;
  if (!socket) {
    throw new Error(`tab ${targetId} exposes no CDP page socket`);
  }
  return socket;
}

async function refreshStrip(
  id: string,
  targets: () => Promise<Target[]>,
): Promise<Tab[] | null> {
  return (await targets()).find((live) => live.id === id)?.tabs ?? null;
}

export type Deps = {
  run: typeof run;
  terminalTargets: () => Promise<Target[]>;
};

const LIVE: Deps = { run, terminalTargets };

const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";

// terminal-browser's herdr adapter picks the browser's home from HERDR_PANE_ID
// and nothing else — its getCurrentPane() returns {id: env.HERDR_PANE_ID}. So
// "open in a new tab" is: make the tab, then point that one variable at its
// root pane. Returns null outside herdr, where terminal-browser does its own
// placement.
async function herdrTab(exec: typeof run): Promise<HerdrTab | null> {
  const workspace = process.env.HERDR_WORKSPACE_ID;
  if (!process.env.HERDR_PANE_ID || !workspace) {
    return null;
  }
  return parseHerdrTab(
    await exec([HERDR_BIN, ...herdrTabCreateArgs(workspace, process.cwd())]),
  );
}

// terminal-browser hands the pane back to a shell rather than closing it, so
// the tab `open` made outlives its browser as an idle shell in the strip.
async function closeHostTab(
  tab: string | null,
  exec: typeof run,
): Promise<void> {
  if (!tab) {
    return;
  }
  const label = herdrTabLabel(
    await exec([HERDR_BIN, "tab", "get", tab]).catch(() => ""),
  );
  if (label !== "browser") {
    return;
  }
  await exec([HERDR_BIN, "tab", "close", tab]).catch(() => {});
}

export async function openTerminal(
  url: string,
  split: string | null,
  ratio: string | null,
  before: Target[],
  deps: Deps = LIVE,
): Promise<Target> {
  if (inHerdrApp()) {
    return openInHerdrApp(url, split, ratio, before, deps);
  }
  const tab = split === null ? await herdrTab(deps.run) : null;
  try {
    await deps.run(
      ["terminal-browser", ...terminalOpenArgs(url, split, ratio)],
      {
        env: tab
          ? { HERDR_PANE_ID: tab.pane, HERDR_TAB_ID: tab.tab }
          : undefined,
      },
    );
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const found = newcomer(before, await deps.terminalTargets());
      if (found) {
        // terminal-browser splits rather than takes over, so the tab we made
        // still holds the shell pane it was born with. Left alone it sits
        // beside the browser as dead space for the rest of the session.
        if (tab && found.pane && found.pane !== tab.pane) {
          await deps
            .run([HERDR_BIN, "pane", "close", tab.pane])
            .catch(() => {});
        }
        return found;
      }
      await Bun.sleep(250);
    }
    throw new Error("opened the browser but it never reported the page");
  } catch (error) {
    if (tab) {
      await deps.run([HERDR_BIN, "tab", "close", tab.tab]).catch(() => {});
    }
    throw error;
  }
}

async function openInHerdrApp(
  url: string,
  split: string | null,
  ratio: string | null,
  before: Target[],
  deps: Deps,
): Promise<Target> {
  if (ratio !== null) {
    throw new Error(
      "--ratio is not supported under herdr-app, which sizes the pane itself",
    );
  }
  if (split !== null && split !== "right" && split !== "down") {
    throw new Error(`herdr-app splits only right or down, not ${split}`);
  }
  const terminal = process.env.HC_TERMINAL_ID!;
  const place = appPlaceOf(await deps.run(["herdr-app", "ls"]), terminal);
  if (!place) {
    throw new Error(
      `${terminal} is not shown in herdr-app, so it has no space to open a tab in`,
    );
  }
  const argv = appBrowserArgv(url);
  const created = JSON.parse(
    await deps.run(
      split === null
        ? [
            "herdr-app",
            "do",
            "tab.new",
            JSON.stringify({
              name: appTabName(url),
              space: place.space,
              folder: process.cwd(),
              argv,
            }),
          ]
        : [
            "herdr-app",
            "do",
            "pane.split",
            JSON.stringify({ direction: split, pane: place.pane, argv }),
          ],
    ),
  );
  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const found = newcomer(before, await deps.terminalTargets());
      if (found) return found;
      await Bun.sleep(250);
    }
    throw new Error("opened the browser but it never reported the page");
  } catch (error) {
    await deps
      .run(
        split === null
          ? [
              "herdr-app",
              "do",
              "tab.close",
              JSON.stringify({ id: created.tab, confirmed: true }),
            ]
          : [
              "herdr-app",
              "do",
              "pane.close",
              JSON.stringify({ pane: created.pane }),
            ],
      )
      .catch(() => {});
    throw error;
  }
}

export async function main(argv: string[], deps: Deps = LIVE): Promise<void> {
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
    full,
    passthrough,
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

  const terminal = await deps.terminalTargets();

  let target: Target;

  if (command === "open") {
    const url = requireArg(args[0], "missing URL");
    if (!fresh && terminal.length > 0) {
      target = selectTarget(terminal, view);
      const socket = await attach(
        await pageSocket(target.cdpHttp, target.activeTargetId),
      );
      try {
        console.log(await navigate(socket, url));
      } finally {
        socket.close();
      }
      const refreshed = await refreshStrip(target.id, deps.terminalTargets);
      console.log(refreshed ? formatTabs(refreshed) : `closed ${target.id}`);
      return;
    }
    target = await openTerminal(url, split, ratio, terminal, deps);
    console.log(`view ${target.id} pane ${target.pane ?? "-"}`);
    console.log(formatTabs(target.tabs));
    return;
  }

  target = selectTarget(terminal, view);
  const base = target.cdpHttp;

  // The escape hatch to agent-browser's full surface. Anything this skill has
  // not made native yet still runs, at agent-browser's own output size — its
  // snapshot is ~5x ours on a real page, so prefer the native command when one
  // exists.
  if (command === "raw") {
    if (!passthrough || passthrough.length === 0) {
      throw new Error("raw needs a command after --, e.g. raw -- get title");
    }
    const out = await deps.run(
      [
        "terminal-browser",
        "action",
        "--browser",
        target.id,
        "--",
        ...passthrough,
      ],
      // The default error echoes the whole command line back, which here is the
      // agent's own words plus plumbing it never typed. Errors are the common
      // case with a guessed selector, so that echo is the expensive one.
      { failureName: `raw ${passthrough[0]}` },
    );
    const trimmed = out.trimEnd();
    if (trimmed) {
      console.log(trimmed);
    }
    return;
  }

  if (command === "endpoint") {
    console.log(`view        ${target.id}`);
    console.log(`cdp_http    ${base}`);
    console.log(
      `browser_ws  ${(await cdp<any>(`${base}/json/version`))?.webSocketDebuggerUrl ?? "-"}`,
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
    await deps.run([
      "terminal-browser",
      "new-tab",
      "--browser",
      target.id,
      url,
    ]);
    const refreshed = await refreshStrip(target.id, deps.terminalTargets);
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
        throw new Error(
          `tab ${row} carries no terminal-browser id to activate`,
        );
      }
      await deps.run([
        "terminal-browser",
        "action",
        "--browser",
        target.id,
        "--tab",
        String(strip),
        "--follow",
        "--",
        "get",
        "url",
      ]);
    } else {
      await closeTab(base, targetId);
    }
    const refreshed = await refreshStrip(target.id, deps.terminalTargets);
    if (!refreshed) {
      await closeHostTab(target.hostTab, deps.run);
      console.log(`closed ${target.id}`);
      return;
    }
    console.log(formatTabs(refreshed));
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
      console.log(formatSnapshot(await axTree(session)));
      return;
    }
    if (command === "click-ref") {
      console.log(
        await clickRef(
          session,
          requireArg(args[0], "missing ref from `snapshot`"),
        ),
      );
      return;
    }
    if (command === "emulate") {
      console.log(await emulate(session, resolveMetrics(device, size)));
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
          await evaluate(
            session,
            requireArg(args[0], "missing expression"),
            true,
          ),
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
        await waitFor(
          session,
          requireArg(args[0], "missing expression"),
          timeoutMs,
        ),
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
      await clickPoint(
        session,
        coordinate(args[0], "x"),
        coordinate(args[1], "y"),
      );
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
    if (command === "cookies") {
      const operation = args[0] ?? "get";
      if (operation === "get") {
        console.log(await cookiesGet(session));
      } else if (operation === "clear") {
        console.log(await cookiesClear(session));
      } else if (operation === "set") {
        console.log(await cookiesSet(session, cookieSetParams(args.slice(1))));
      } else {
        throw new Error(
          `unknown cookies operation ${operation} (get, set, clear)`,
        );
      }
      return;
    }
    if (command === "headers") {
      console.log(
        await setHeaders(session, requireArg(args[0], "missing JSON object")),
      );
      return;
    }
    if (command === "screenshot") {
      console.log(
        await screenshot(
          session,
          requireArg(output, "missing --output PATH"),
          full,
        ),
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
