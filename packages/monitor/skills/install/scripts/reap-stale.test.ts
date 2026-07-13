import { describe, expect, test } from "bun:test";
import {
  monitorCacheRoot,
  parsePsRows,
  reapStaleMonitorProcesses,
  selectStaleMonitorPids,
  type ProcRow,
} from "./reap-stale";

const CACHE = "/Users/x/.claude/plugins/cache/q-lab-marketplace/monitor";
const channel = (v: string) =>
  `bun ${CACHE}/${v}/skills/cockpit/scripts/cockpit-channel.ts`;
const server = (v: string) =>
  `bun ${CACHE}/${v}/skills/cockpit/scripts/cockpit-server.ts --no-open`;
const atlas = (v: string) =>
  `bun ${CACHE}/${v}/skills/usage-dashboard/scripts/atlas-server.ts`;

const row = (p: Partial<ProcRow>): ProcRow => ({
  pid: 100,
  ppid: 1,
  uid: 501,
  command: channel("3.18.5"),
  ...p,
});

const select = (rows: ProcRow[]) =>
  selectStaleMonitorPids(rows, {
    version: "3.19.0",
    uid: 501,
    selfPid: 999,
    cacheRoot: CACHE,
  });

describe("selectStaleMonitorPids", () => {
  test("reaps an orphaned channel from an older version", () => {
    expect(select([row({ pid: 55829, command: channel("3.18.5") })])).toEqual([
      55829,
    ]);
  });

  test("reaps a stale cockpit daemon — it self-heals", () => {
    expect(select([row({ pid: 62198, command: server("3.18.4") })])).toEqual([
      62198,
    ]);
  });

  // The usage dashboard orphans to PID 1 the same way, but it IS the page the user has
  // open in a browser, and nothing re-ensures it — the channel only respawns the cockpit
  // daemon. Reaping it after an upgrade would kill a live dashboard for good. It never
  // polled anything, so it was never part of the leak.
  test("never reaps the usage dashboard, orphaned or not", () => {
    const rows = [
      row({ pid: 90091, ppid: 1, command: atlas("3.17.0") }),
      row({ pid: 90092, ppid: 42, command: atlas("3.17.0") }),
    ];
    expect(select(rows)).toEqual([]);
  });

  // The predicate that keeps this sweep from being destructive. A user can have an
  // older session still open when a newer one starts: its channel has a real parent
  // and is doing its job. A foreign version root is NOT evidence of orphanhood.
  test("never reaps a live foreign-version channel (it has a real parent)", () => {
    const rows = [
      row({ pid: 27226, ppid: 27198, command: channel("3.18.5") }),
      row({ pid: 55829, ppid: 1, command: channel("3.18.5") }),
    ];
    expect(select(rows)).toEqual([55829]);
  });

  test("leaves the running version alone", () => {
    expect(select([row({ pid: 200, command: channel("3.19.0") })])).toEqual([]);
  });

  test("never reaps a newer-version process", () => {
    expect(select([row({ pid: 201, command: server("3.20.0") })])).toEqual([]);
  });

  test("never reaps a process from another monitor cache family", () => {
    const other = channel("3.18.0").replace(CACHE, "/tmp/other/monitor");
    expect(select([row({ pid: 202, command: other })])).toEqual([]);
  });

  test("leaves other users' processes alone", () => {
    expect(select([row({ pid: 300, uid: 502 })])).toEqual([]);
  });

  test("never reaps itself", () => {
    expect(select([row({ pid: 999 })])).toEqual([]);
  });

  test("never signals pid 1", () => {
    expect(select([row({ pid: 1, ppid: 0 })])).toEqual([]);
  });

  test("ignores processes that are not monitor scripts", () => {
    const rows = [
      row({ pid: 400, command: "bun /Users/x/some/other/cockpit-channel.ts" }),
      row({ pid: 401, command: "node server.js" }),
      row({
        pid: 402,
        command: `bun ${CACHE}/3.18.5/skills/cockpit/scripts/cockpit.ts log`,
      }),
    ];
    expect(select(rows)).toEqual([]);
  });

  test("tolerates an unparseable version in the running plugin", () => {
    const rows = [row({ pid: 500, command: channel("3.18.5") })];
    expect(
      selectStaleMonitorPids(rows, {
        version: "",
        uid: 501,
        selfPid: 999,
        cacheRoot: CACHE,
      }),
    ).toEqual([]);
  });
});

describe("reaper scope", () => {
  test("derives the shared monitor cache root from an installed script", () => {
    expect(monitorCacheRoot(`${CACHE}/3.19.0/skills/install/scripts`)).toBe(
      CACHE,
    );
  });

  test("skips the process table outside a versioned plugin-cache install", () => {
    let ran = false;
    const count = reapStaleMonitorProcesses(
      "3.19.0",
      () => {
        ran = true;
        return "";
      },
      () => {},
      "/Users/x/Projects/cc-plugins/packages/monitor/skills/install/scripts",
    );
    expect(count).toBe(0);
    expect(ran).toBe(false);
  });
});

describe("parsePsRows", () => {
  test("parses pid/ppid/uid/command from ps output", () => {
    const out = [
      `  55829     1   501 ${channel("3.18.5")}`,
      `  27226 27198   501 ${channel("3.18.5")}`,
      "",
    ].join("\n");
    expect(parsePsRows(out)).toEqual([
      { pid: 55829, ppid: 1, uid: 501, command: channel("3.18.5") },
      { pid: 27226, ppid: 27198, uid: 501, command: channel("3.18.5") },
    ]);
  });

  test("skips malformed lines rather than throwing", () => {
    expect(parsePsRows("garbage\n\n  x  y  z  cmd\n")).toEqual([]);
  });
});
