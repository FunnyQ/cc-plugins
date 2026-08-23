import { describe, expect, test } from "bun:test";

import {
  newcomer,
  cdpBase,
  parseTerminalBrowsers,
  selectTarget,
  terminalOpenArgs,
  herdrTabLabel,
  herdrTabCreateArgs,
  parseHerdrTab,
  type Target,
} from "./terminal-browser";

const browsersJson = (browsers: unknown[]) =>
  JSON.stringify({ self: { tab: "w5G:t1", pane: "w5G:p1" }, browsers });

const browser = (key: string, port: number, tabs: unknown[]) => ({
  key,
  pid: 64777,
  cdpPort: port,
  pane: { tab: "w5G:t1", pane: "w5G:p2E" },
  tabs,
});

const tab = (id: number, url: string, active: boolean, targetId: string) => ({
  id,
  url,
  title: "probe",
  active,
  targetId,
});

describe("parseTerminalBrowsers", () => {
  test("reads one browser into a target keyed by its browser key", () => {
    const raw = browsersJson([
      browser("64777-1", 57768, [
        tab(1, "http://localhost:8899/", true, "AAA"),
      ]),
    ]);
    expect(parseTerminalBrowsers(raw)).toEqual([
      {
        id: "64777-1",
        cdpHttp: "http://127.0.0.1:57768",
        activeTargetId: "AAA",
        pane: "w5G:p2E",
        hostTab: "w5G:t1",
        url: "http://localhost:8899/",
        title: "probe",
        tabs: [
          {
            id: 1,
            targetId: "AAA",
            title: "probe",
            url: "http://localhost:8899/",
            active: true,
          },
        ],
      },
    ]);
  });

  test("takes the active tab, not the first one", () => {
    const raw = browsersJson([
      browser("64777-1", 57768, [
        tab(1, "http://a/", false, "AAA"),
        tab(2, "http://b/", true, "BBB"),
      ]),
    ]);
    expect(parseTerminalBrowsers(raw)[0].activeTargetId).toBe("BBB");
    expect(parseTerminalBrowsers(raw)[0].url).toBe("http://b/");
  });

  test("falls back to the first tab when none is flagged active", () => {
    const raw = browsersJson([
      browser("64777-1", 57768, [tab(1, "http://a/", false, "AAA")]),
    ]);
    expect(parseTerminalBrowsers(raw)[0].activeTargetId).toBe("AAA");
  });

  test("drops a browser with no cdp port; it cannot be driven", () => {
    const raw = browsersJson([
      { ...browser("64777-1", 57768, []), cdpPort: null },
    ]);
    expect(parseTerminalBrowsers(raw)).toEqual([]);
  });

  test("survives no browsers at all", () => {
    expect(parseTerminalBrowsers(browsersJson([]))).toEqual([]);
  });
});

describe("cdpBase", () => {
  test("binds the loopback address, never a hostname", () => {
    expect(cdpBase(57768)).toBe("http://127.0.0.1:57768");
  });
});

const target = (id: string): Target => ({
  id,
  cdpHttp: "http://127.0.0.1:57768",
  activeTargetId: "AAA",
  pane: "w5G:p2E",
  hostTab: "w5G:t1",
  url: "http://localhost:8899/",
  title: "probe",
  tabs: [],
});

describe("selectTarget", () => {
  test("takes the only live target without being asked", () => {
    expect(selectTarget([target("64777-1")], null).id).toBe("64777-1");
  });

  test("refuses to guess between two, and names both", () => {
    expect(() => selectTarget([target("a"), target("b")], null)).toThrow(
      /--view/,
    );
  });

  test("honours an explicit id", () => {
    const targets = [target("a"), target("b")];
    expect(selectTarget(targets, "b").id).toBe("b");
  });

  test("names the unknown id rather than falling back", () => {
    expect(() => selectTarget([target("a")], "zz")).toThrow(/zz/);
  });

  test("says how to open one when nothing is live", () => {
    expect(() => selectTarget([], null)).toThrow(/open/);
  });
});

describe("terminalOpenArgs", () => {
  test("takes over the pane it is pointed at when no split is asked for", () => {
    expect(terminalOpenArgs("http://a/", null, null)).toEqual([
      "open",
      "http://a/",
    ]);
  });

  test("carries the direction and the ratio", () => {
    expect(terminalOpenArgs("http://a/", "down", "0.4")).toEqual([
      "open",
      "http://a/",
      "--split",
      "down",
      "--size",
      "0.4",
    ]);
  });

  test("rejects a direction that is not one of the four", () => {
    expect(() => terminalOpenArgs("http://a/", "sideways", null)).toThrow(
      /right, left, down, up/,
    );
  });

  test("rejects a ratio outside what terminal-browser accepts", () => {
    expect(() => terminalOpenArgs("http://a/", "right", "0.05")).toThrow(/0.2/);
    expect(() => terminalOpenArgs("http://a/", "right", "abc")).toThrow(/0.2/);
  });

  test("rejects a ratio with nothing to divide", () => {
    expect(() => terminalOpenArgs("http://a/", null, "0.4")).toThrow(/--split/);
  });
});

describe("herdrTabCreateArgs", () => {
  test("pins the tab to this workspace and cwd", () => {
    expect(herdrTabCreateArgs("w5X", "/repo")).toEqual([
      "tab",
      "create",
      "--workspace",
      "w5X",
      "--cwd",
      "/repo",
      "--label",
      "browser",
      "--no-focus",
    ]);
  });
});

describe("parseHerdrTab", () => {
  const raw = JSON.stringify({
    id: "cli:tab:create",
    result: {
      root_pane: { pane_id: "w5X:p5", tab_id: "w5X:t2" },
      tab: { tab_id: "w5X:t2", label: "browser" },
      type: "tab_created",
    },
  });

  test("reads the new tab's root pane", () => {
    expect(parseHerdrTab(raw)).toEqual({ pane: "w5X:p5", tab: "w5X:t2" });
  });

  test("fails loudly rather than opening in the caller's pane", () => {
    expect(() => parseHerdrTab("{}")).toThrow(/pane/);
    expect(() => parseHerdrTab("not json")).toThrow();
  });
});

describe("parseTerminalBrowsers tab strip", () => {
  test("keeps the strip in creation order, not CDP recency order", () => {
    const raw = browsersJson([
      browser("64777-1", 57768, [
        tab(2, "http://a/", false, "F56F"),
        tab(3, "http://b/", true, "C559"),
      ]),
    ]);
    expect(parseTerminalBrowsers(raw)[0].tabs.map((t) => t.targetId)).toEqual([
      "F56F",
      "C559",
    ]);
    expect(parseTerminalBrowsers(raw)[0].tabs[1].active).toBe(true);
  });

  test("carries the backend tab id, which activate needs and CDP does not have", () => {
    const raw = browsersJson([
      browser("64777-1", 57768, [tab(4, "http://a/", true, "F56F")]),
    ]);
    expect(parseTerminalBrowsers(raw)[0].tabs[0].id).toBe(4);
  });
});

describe("newcomer", () => {
  test("finds the key that was not there before, not the matching url", () => {
    const before = [target("64777-1")];
    const after = [target("64777-1"), target("64777-2")];
    expect(newcomer(before, after)?.id).toBe("64777-2");
  });

  test("reports nothing while the new browser has not registered yet", () => {
    const before = [target("64777-1")];
    expect(newcomer(before, before)).toBeUndefined();
  });
});

describe("herdrTabLabel", () => {
  const raw = (label: unknown) =>
    JSON.stringify({ result: { tab: { tab_id: "w5X:t4", label } } });

  test("reads the label a tab was created with", () => {
    expect(herdrTabLabel(raw("browser"))).toBe("browser");
  });

  test("is null when there is nothing to read, so nothing gets closed", () => {
    expect(herdrTabLabel(raw(undefined))).toBeNull();
    expect(herdrTabLabel("{}")).toBeNull();
    expect(herdrTabLabel("not json")).toBeNull();
  });
});
