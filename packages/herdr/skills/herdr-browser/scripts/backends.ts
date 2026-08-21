// Two things can own a Chromium in a Herdr pane: the official herdr-browser
// plugin, and terminal-browser. Both hand out a plain CDP endpoint, so the rest
// of the skill only needs whichever one is live reduced to a Target.

export type BackendName = "terminal" | "herdr";

export type Tab = {
  // The backend's own id for this tab, when it keeps one. terminal-browser
  // needs it to bring a tab to the front; CDP alone cannot.
  id: number | null;
  targetId: string;
  title: string;
  url: string;
  active: boolean;
};

export type Target = {
  backend: BackendName;
  id: string;
  cdpHttp: string;
  activeTargetId: string;
  pane: string | null;
  url: string;
  title: string;
  // The backend's own tab strip, in the order the user sees it. Empty means the
  // backend does not keep one, and CDP /json/list is the fallback.
  tabs: Tab[];
};

export const SPLIT_DIRECTIONS = ["right", "left", "down", "up"] as const;

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
        backend: "terminal" as const,
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

// Auto-detect is what keeps the command surface identical across backends, so
// it may only pick when the answer is not a guess.
export function chooseBackend(
  terminal: Target[],
  herdr: Target[],
  requested: BackendName | null,
): BackendName {
  if (requested) {
    return requested;
  }
  // terminal-browser costs one process to probe, the herdr plugin costs three,
  // so it is probed first and wins a tie. --backend herdr is the way past that.
  if (terminal.length > 0) {
    return "terminal";
  }
  if (herdr.length > 0) {
    return "herdr";
  }
  throw new Error(
    "no browser is live, and neither backend reports one\n" +
      "  terminal-browser: curl -fsSL https://terminal-browser.sh/install | bash\n" +
      "  herdr plugin:     herdr plugin install ogulcancelik/herdr-browser",
  );
}

// terminal-browser places by splitting the focused pane and nothing else, so a
// Herdr-only placement has to say which backend can honour it.
export function terminalOpenArgs(
  url: string,
  placement: string,
  direction: string | null,
  ratio: string | null,
): string[] {
  if (placement !== "split") {
    throw new Error(
      `terminal-browser only splits; drop --placement ${placement} or pass --backend herdr`,
    );
  }
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

// `open` is the one command that runs with nothing live, so it cannot ask
// chooseBackend — it has to fall back to whichever backend is installed.
export function openBackend(
  terminal: Target[],
  herdr: Target[],
  requested: BackendName | null,
  terminalInstalled: boolean,
): BackendName {
  if (requested) {
    return requested;
  }
  if (terminal.length > 0) {
    return "terminal";
  }
  if (herdr.length > 0) {
    return "herdr";
  }
  return terminalInstalled ? "terminal" : "herdr";
}

// Two browsers can hold the same url, so a fresh one is only identifiable by
// the key that was not there before it opened.
export function newcomer(before: Target[], after: Target[]): Target | undefined {
  const known = new Set(before.map((target) => target.id));
  return after.find((target) => !known.has(target.id));
}
