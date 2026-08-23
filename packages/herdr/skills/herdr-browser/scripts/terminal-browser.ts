// terminal-browser owns the Chromium behind a Herdr pane and hands out a plain
// CDP endpoint, so the rest of the skill only needs it reduced to a Target.

export type Tab = {
  // The backend's own id for this tab. terminal-browser needs it to bring a tab
  // to the front; CDP alone cannot.
  id: number | null;
  targetId: string;
  title: string;
  url: string;
  active: boolean;
};

export type Target = {
  id: string;
  cdpHttp: string;
  activeTargetId: string;
  pane: string | null;
  // The herdr tab holding that pane. `open` makes a tab per browser, so this is
  // what has to be cleaned up when the last page tab closes the browser.
  hostTab: string | null;
  url: string;
  title: string;
  // terminal-browser's own tab strip, in the order the user sees it. CDP
  // /json/list is not a substitute: it orders by recency, and every pane shares
  // one Electron process and one port, so it carries other panes' pages too.
  tabs: Tab[];
};

export const SPLIT_DIRECTIONS = ["right", "left", "down", "up"] as const;

export const INSTALL_HINT =
  "terminal-browser is not installed\n" +
  "  install it: curl -fsSL https://terminal-browser.sh/install | bash";

export function cdpBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

// `terminal-browser ls --all --json`. One browser is one target: its tabs share
// the port, and `tabs`/`activate` already drive them through CDP.
export function parseTerminalBrowsers(raw: string): Target[] {
  const browsers = JSON.parse(raw)?.browsers ?? [];
  return browsers
    .filter((browser: any) => typeof browser?.cdpPort === "number")
    .map((browser: any) => {
      const raw = browser.tabs ?? [];
      const active = raw.find((tab: any) => tab.active) ?? raw[0];
      const tabs: Tab[] = raw.map((tab: any) => ({
        id: typeof tab.id === "number" ? tab.id : null,
        targetId: tab.targetId,
        title: tab.title ?? "",
        url: tab.url ?? "",
        active: Boolean(tab.active),
      }));
      return {
        id: String(browser.key),
        cdpHttp: cdpBase(browser.cdpPort),
        activeTargetId: active?.targetId ?? "",
        pane: browser.pane?.pane ?? null,
        hostTab: browser.pane?.tab ?? null,
        url: active?.url ?? "",
        title: active?.title ?? "",
        tabs,
      };
    });
}

export function selectTarget(targets: Target[], requested: string | null): Target {
  if (targets.length === 0) {
    throw new Error("no browser is live; run `open <url>` first");
  }
  if (!requested && targets.length > 1) {
    const listing = targets
      .map((target) => `  ${target.id} ${target.pane ?? "-"} ${target.url}`)
      .join("\n");
    throw new Error(`several browsers are live; pass --view ID\n${listing}`);
  }
  const id = requested ?? targets[0].id;
  const found = targets.find((target) => target.id === id);
  if (!found) {
    throw new Error(`unknown view: ${id}`);
  }
  return found;
}

// terminal-browser places by splitting the focused pane and nothing else.
export function terminalOpenArgs(
  url: string,
  direction: string | null,
  ratio: string | null,
): string[] {
  // No direction means the caller already picked the pane — it points
  // HERDR_PANE_ID at a fresh tab's root pane, and terminal-browser's herdr
  // adapter reads that one env var to decide where the browser lands. Passing
  // --split here instead would carve up whichever pane the agent was invoked
  // from, which is the human's.
  if (direction === null) {
    if (ratio !== null) {
      throw new Error("--ratio needs --split: a full tab has nothing to divide");
    }
    return ["open", url];
  }
  if (!SPLIT_DIRECTIONS.includes(direction as (typeof SPLIT_DIRECTIONS)[number])) {
    throw new Error(
      `invalid --split ${direction} (${SPLIT_DIRECTIONS.join(", ")})`,
    );
  }
  const args = ["open", url, "--split", direction];
  if (ratio !== null) {
    const value = Number(ratio);
    if (!Number.isFinite(value) || value < 0.2 || value > 0.95) {
      throw new Error(`invalid --ratio ${ratio} (0.2 to 0.95)`);
    }
    args.push("--size", ratio);
  }
  return args;
}

export type HerdrTab = { pane: string; tab: string };

// `herdr tab create` without --workspace lands the tab in whatever workspace
// herdr considers default, which is not necessarily ours — verified: it opened
// in another repo's workspace with that repo's cwd.
export function herdrTabCreateArgs(workspace: string, cwd: string): string[] {
  return [
    "tab",
    "create",
    "--workspace",
    workspace,
    "--cwd",
    cwd,
    "--label",
    "browser",
    "--no-focus",
  ];
}

export function parseHerdrTab(raw: string): HerdrTab {
  const root = JSON.parse(raw)?.result?.root_pane;
  const pane = root?.pane_id;
  const tab = root?.tab_id;
  if (typeof pane !== "string" || typeof tab !== "string") {
    throw new Error(`herdr tab create reported no pane: ${raw.slice(0, 200)}`);
  }
  return { pane, tab };
}

// Two browsers can hold the same url, so a fresh one is only identifiable by
// the key that was not there before it opened.
export function newcomer(before: Target[], after: Target[]): Target | undefined {
  const known = new Set(before.map((target) => target.id));
  return after.find((target) => !known.has(target.id));
}

// Only a tab this skill made carries the label, and closing a tab the human
// made would take their work with it. A label we cannot read means no close.
export function herdrTabLabel(raw: string): string | null {
  try {
    const label = JSON.parse(raw)?.result?.tab?.label;
    return typeof label === "string" ? label : null;
  } catch {
    return null;
  }
}
