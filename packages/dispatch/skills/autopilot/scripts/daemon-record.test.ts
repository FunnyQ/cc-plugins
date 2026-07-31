import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  readRecord,
  recordPath,
  removeRecord,
  writeRecord,
  type DaemonInfo,
} from "./daemon-record";

let dataHome: string;
let originalDataHome: string | undefined;
let originalHome: string | undefined;

beforeEach(() => {
  dataHome = mkdtempSync(join(tmpdir(), "dispatch-daemon-record-"));
  originalDataHome = process.env.XDG_DATA_HOME;
  originalHome = process.env.HOME;
  process.env.XDG_DATA_HOME = dataHome;
});

afterEach(() => {
  if (originalDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalDataHome;
  }

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  rmSync(dataHome, { recursive: true, force: true });
});

describe("daemon record", () => {
  test("round-trips a record and creates its directory", () => {
    const info: DaemonInfo = {
      pid: 1234,
      port: 5757,
      root: "/opt/flightdeck/scripts",
      plan: "/tmp/example-plan",
    };

    expect(existsSync(dirname(recordPath()))).toBe(false);
    writeRecord(info);

    expect(existsSync(dirname(recordPath()))).toBe(true);
    expect(readRecord()).toEqual(info);
  });

  test("returns null when the record is absent", () => {
    expect(readRecord()).toBeNull();
  });

  test.each(["{\"pid\":", "not json"])(
    "returns null for an invalid record",
    (contents) => {
      writeRecord({ pid: 1, port: 1, root: "/tmp", plan: "/tmp/plan" });
      writeFileSync(recordPath(), contents);

      expect(readRecord()).toBeNull();
    },
  );

  test("honors XDG_DATA_HOME", () => {
    expect(recordPath()).toBe(
      join(dataHome, "q-lab", "flightdeck", "daemon.json"),
    );
  });

  test("falls back to HOME/.local/share", () => {
    const home = join(dataHome, "home");
    delete process.env.XDG_DATA_HOME;
    process.env.HOME = home;

    expect(recordPath()).toBe(
      join(home, ".local", "share", "q-lab", "flightdeck", "daemon.json"),
    );
  });

  test("removes the record and tolerates an absent record", () => {
    writeRecord({ pid: 1, port: 1, root: "/tmp", plan: "/tmp/plan" });

    removeRecord();

    expect(existsSync(recordPath())).toBe(false);
    expect(() => removeRecord()).not.toThrow();
  });
});
