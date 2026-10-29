import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSource } from "./graph-source";
import { readRecord, writeRecord } from "./daemon-record";
import {
  canReuse,
  identifyDaemon,
  openBrowser,
  openerCommands,
  parseArgs,
  planLine,
  supersede,
  validatePlanDir,
} from "./launch";

describe("parseArgs", () => {
  test("parses valid arguments", () => {
    expect(parseArgs(["--plan", "/plan", "--port", "6000"], {})).toEqual({
      ok: true,
      args: { plan: "/plan", port: 6000, open: true },
    });
  });

  test("rejects a missing plan", () => {
    expect(parseArgs([])).toEqual({
      ok: false,
      message: "--plan must be an absolute path",
    });
  });

  test("rejects a relative plan", () => {
    expect(parseArgs(["--plan", "relative/plan"])).toEqual({
      ok: false,
      message: "--plan must be an absolute path",
    });
  });

  test("rejects an out-of-range port", () => {
    expect(parseArgs(["--plan", "/plan", "--port", "65536"]).ok).toBeFalse();
  });

  test("suppresses opening the browser", () => {
    expect(parseArgs(["--plan", "/plan", "--no-open"], {})).toEqual({
      ok: true,
      args: { plan: "/plan", port: 5757, open: false },
    });
  });

  test("uses the default port", () => {
    expect(parseArgs(["--plan", "/plan"], {})).toEqual({
      ok: true,
      args: { plan: "/plan", port: 5757, open: true },
    });
  });

  test("under Claude Code the pane stands in, so the browser stays shut unless --open asks", () => {
    const claude = { CLAUDECODE: "1" };
    expect(parseArgs(["--plan", "/plan"], claude)).toMatchObject({
      args: { open: false },
    });
    expect(parseArgs(["--plan", "/plan", "--open"], claude)).toMatchObject({
      args: { open: true },
    });
    expect(parseArgs(["--plan", "/plan", "--no-open"], {})).toMatchObject({
      args: { open: false },
    });
  });
});

const scratchDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-source-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("detectSource and validatePlanDir", () => {
  for (const shape of ["tasks", "graph", "both", "none"] as const) {
    test(`detects and validates ${shape}`, () => {
      const dir = scratch();
      if (shape === "tasks" || shape === "both") mkdirSync(join(dir, "tasks"));
      if (shape === "graph" || shape === "both")
        writeFileSync(join(dir, "graph.json"), "{}");
      expect(detectSource(dir)).toBe(shape === "both" ? "tasks" : shape);
      expect(validatePlanDir(dir)).toEqual(
        shape === "none"
          ? {
              ok: false,
              message:
                "--plan must contain a tasks/ directory or a graph.json file",
            }
          : { ok: true },
      );
    });
  }

  test("requires a task directory or a graph file, not just their names", () => {
    const dir = scratch();
    writeFileSync(join(dir, "tasks"), "");
    mkdirSync(join(dir, "graph.json"));
    expect(detectSource(dir)).toBe("none");
    expect(validatePlanDir(dir)).toEqual({
      ok: false,
      message: "--plan must contain a tasks/ directory or a graph.json file",
    });
  });

  test("keeps the missing path and non-directory errors", () => {
    const dir = scratch();
    const file = join(dir, "file");
    writeFileSync(file, "");
    expect(validatePlanDir(file)).toEqual({
      ok: false,
      message: "--plan must be a directory",
    });
    expect(validatePlanDir(join(dir, "absent"))).toEqual({
      ok: false,
      message: "--plan directory does not exist",
    });
  });
});

describe("planLine", () => {
  test("names the plan the launcher served, for the dispatch mod to read back", () => {
    expect(planLine("/abs/docs/x")).toBe("flightdeck plan: /abs/docs/x");
  });
});

describe("openerCommands", () => {
  const url = "http://localhost:5757/";
  const plainLinux = () => "Linux version 6.8.0-45-generic (buildd@lcy02)";
  const wsl = [
    ["wslview", url],
    ["cmd.exe", "/c", "start", "", url],
  ];

  test("darwin opens with open", () => {
    expect(openerCommands(url, "darwin", {}, plainLinux)).toEqual([
      ["open", url],
    ]);
  });

  test("win32 opens through cmd's start builtin with an empty title", () => {
    expect(openerCommands(url, "win32", {}, plainLinux)).toEqual([
      ["cmd", "/c", "start", "", url],
    ]);
  });

  test("WSL_DISTRO_NAME marks WSL without reading /proc/version", () => {
    const read = () => {
      throw new Error("must not read /proc/version");
    };
    expect(
      openerCommands(url, "linux", { WSL_DISTRO_NAME: "Ubuntu" }, read),
    ).toEqual(wsl);
  });

  test("a Microsoft kernel in /proc/version marks WSL", () => {
    expect(
      openerCommands(
        url,
        "linux",
        {},
        () => "Linux version 5.15.0-microsoft-standard-WSL2",
      ),
    ).toEqual(wsl);
  });

  test("plain linux opens with xdg-open", () => {
    expect(openerCommands(url, "linux", {}, plainLinux)).toEqual([
      ["xdg-open", url],
    ]);
  });

  test("an unreadable /proc/version means plain linux", () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    expect(openerCommands(url, "linux", {}, read)).toEqual([["xdg-open", url]]);
  });
});

describe("openBrowser", () => {
  test("falls back from wslview to cmd.exe when the first spawn throws", () => {
    const tried: string[][] = [];
    openBrowser(
      [
        ["wslview", "u"],
        ["cmd.exe", "/c", "start", "", "u"],
      ],
      (command) => {
        tried.push(command);
        if (command[0] === "wslview") throw new Error("Executable not found");
      },
    );
    expect(tried.map((command) => command[0])).toEqual(["wslview", "cmd.exe"]);
  });

  test("logs the notice only when every opener threw", () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => errors.push(message);
    try {
      openBrowser([["a"], ["b"]], () => {
        throw new Error("Executable not found");
      });
      openBrowser([["a"]], () => {});
    } finally {
      console.error = original;
    }
    expect(errors).toEqual([
      "flightdeck notice: browser opener unavailable: Executable not found",
    ]);
  });
});

function answering(body: unknown) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json(body),
  });
}

describe("identifyDaemon", () => {
  test("an HTTP answer is not proof of a flightdeck: only a body naming itself, its pid and its plan identifies", async () => {
    const foreign = answering({ pid: 1234, plan: "/plan" });
    const wrongPid = answering({
      flightdeck: true,
      pid: "1234",
      plan: "/plan",
    });
    const ours = answering({ flightdeck: true, pid: 1234, plan: "/plan" });
    try {
      expect(await identifyDaemon(foreign.port!)).toBeNull();
      expect(await identifyDaemon(wrongPid.port!)).toBeNull();
      expect(await identifyDaemon(ours.port!)).toEqual({
        pid: 1234,
        plan: "/plan",
      });
    } finally {
      for (const server of [foreign, wrongPid, ours]) server.stop(true);
    }
  });
});

describe("supersede and canReuse", () => {
  const savedDataHome = process.env.XDG_DATA_HOME;
  afterEach(() => {
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedDataHome;
  });

  test("a recycled pid behind a port that does not identify as ours gets no SIGTERM, and its stale record is dropped", async () => {
    process.env.XDG_DATA_HOME = scratch();
    const stranger = Bun.spawn(["sleep", "30"]);
    const foreign = answering({ status: "ok" });
    try {
      const info = {
        pid: stranger.pid,
        port: foreign.port!,
        root: "/root",
        plan: "/plan",
      };
      writeRecord(info);
      expect(await supersede(info)).toBeTrue();
      await Bun.sleep(50);
      expect(stranger.signalCode).toBeNull();
      expect(readRecord()).toBeNull();
    } finally {
      stranger.kill();
      foreign.stop(true);
    }
  });

  test("a supersede waits until the old daemon's own port stops answering", async () => {
    process.env.XDG_DATA_HOME = scratch();
    const old = Bun.spawn(["sleep", "30"]);
    const oldDaemon = answering({
      flightdeck: true,
      pid: old.pid,
      plan: "/plan",
    });
    let closed = false;
    const closing = setTimeout(() => {
      oldDaemon.stop(true);
      closed = true;
    }, 700);
    try {
      const info = {
        pid: old.pid,
        port: oldDaemon.port!,
        root: "/root",
        plan: "/plan",
      };
      expect(await supersede(info)).toBeTrue();
      expect(closed).toBeTrue();
    } finally {
      clearTimeout(closing);
      old.kill();
      oldDaemon.stop(true);
    }
  });

  test("a live pid is not a live daemon: pids recycle and a hung server holds one, so reuse needs the port to answer as that very daemon", async () => {
    const foreign = answering({
      flightdeck: true,
      pid: process.pid + 1,
      plan: "/plan",
    });
    try {
      const info = {
        pid: process.pid,
        port: foreign.port!,
        root: "/root",
        plan: "/plan",
      };
      expect(
        await canReuse({ action: "reuse", info }, foreign.port!),
      ).toBeFalse();
    } finally {
      foreign.stop(true);
    }
  });
});
