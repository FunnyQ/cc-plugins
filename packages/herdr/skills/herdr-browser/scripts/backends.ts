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
  const where = direction ?? "right";
  if (!SPLIT_DIRECTIONS.includes(where as (typeof SPLIT_DIRECTIONS)[number])) {
    throw new Error(
      `invalid --split ${where} (${SPLIT_DIRECTIONS.join(", ")})`,
    );
  }
  const args = ["open", url, "--split", where];
  if (ratio !== null) {
    const value = Number(ratio);
    if (!Number.isFinite(value) || value < 0.2 || value > 0.95) {
      throw new Error(`invalid --ratio ${ratio} (0.2 to 0.95)`);
    }
    args.push("--size", ratio);
  }
  return args;
}

// Two browsers can hold the same url, so a fresh one is only identifiable by
// the key that was not there before it opened.
export function newcomer(before: Target[], after: Target[]): Target | undefined {
  const known = new Set(before.map((target) => target.id));
  return after.find((target) => !known.has(target.id));
}
