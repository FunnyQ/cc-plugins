import { describe, expect, test } from "bun:test";

import {
  newcomer,
  cdpBase,
  parseTerminalBrowsers,
  selectTarget,
  terminalOpenArgs,
  type Target,
} from "./backends";

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
      browser("64777-1", 57768, [tab(1, "http://localhost:8899/", true, "AAA")]),
    ]);
    expect(parseTerminalBrowsers(raw)).toEqual([
      {
        id: "64777-1",
        cdpHttp: "http://127.0.0.1:57768",
        activeTargetId: "AAA",
        pane: "w5G:p2E",
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
  url: "http://localhost:8899/",
  title: "probe",
  tabs: [],
});

describe("selectTarget", () => {
  test("takes the only live target without being asked", () => {
    expect(selectTarget([target("64777-1")], null).id).toBe("64777-1");
  });

  test("refuses to guess between two, and names both", () => {
    expect(() =>
      selectTarget([target("a"), target("b")], null),
    ).toThrow(/--view/);
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
  test("splits right by default", () => {
    expect(terminalOpenArgs("http://a/", null, null)).toEqual([
      "open",
      "http://a/",
      "--split",
      "right",
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
    expect(() => terminalOpenArgs("http://a/", null, "0.05")).toThrow(/0.2/);
    expect(() => terminalOpenArgs("http://a/", null, "abc")).toThrow(/0.2/);
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
