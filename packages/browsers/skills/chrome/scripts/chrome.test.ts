import { describe, expect, test } from "bun:test";
import { type Page, settle } from "./cdp";
import { interacted, parseArgs } from "./chrome";

describe("parseArgs", () => {
  test("splits the command, positionals, and flags", () => {
    expect(
      parseArgs([
        "open",
        "http://a",
        "--new",
        "--headed",
        "--size",
        "800x600",
        "--id",
        "k",
      ]),
    ).toMatchObject({
      command: "open",
      args: ["http://a"],
      fresh: true,
      headed: true,
      size: "800x600",
      id: "k",
    });
  });

  test("rejects --zen, which belongs to the firefox skill", () => {
    expect(() => parseArgs(["open", "http://a", "--zen"])).toThrow(
      "chrome has no --zen: use the firefox skill",
    );
  });
});

describe("settle", () => {
  test("returns the result of a successful reply", () => {
    expect(
      settle("Page.navigate", { id: 1, result: { frameId: "f" } }),
    ).toEqual({ frameId: "f" });
  });

  // Measured on Chrome 154: an unknown method answers with code -32601.
  test("throws the method and message of a protocol error", () => {
    expect(() =>
      settle("Nope.method", {
        id: 2,
        error: { code: -32601, message: "'Nope.method' wasn't found" },
      }),
    ).toThrow("Nope.method: 'Nope.method' wasn't found");
  });
});

function fakePage(): { page: Page; emit: (method: string) => void } {
  const listeners = new Set<(method: string) => void>();
  const page: Page = {
    send: async () => ({}),
    nextEvent: (events, timeoutMs) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(listener);
          reject(new Error("timeout"));
        }, timeoutMs);
        const listener = (method: string) => {
          if (!events.includes(method)) return;
          clearTimeout(timer);
          listeners.delete(listener);
          resolve(method);
        };
        listeners.add(listener);
      }),
    close: () => {},
  };
  return { page, emit: (method) => [...listeners].forEach((l) => l(method)) };
}

describe("interacted", () => {
  test("waits for a navigation that starts while a slow click is still running", async () => {
    const { page, emit } = fakePage();
    let stoppedAt = 0;
    const slowClick = async () => {
      setTimeout(() => emit("Page.frameStartedLoading"), 80);
      setTimeout(() => {
        stoppedAt = performance.now();
        emit("Page.frameStoppedLoading");
      }, 300);
      await Bun.sleep(100);
    };
    await interacted(page, slowClick);
    expect(stoppedAt).toBeGreaterThan(0);
  });

  test("waits for a requested navigation that starts loading after the grace window", async () => {
    const { page, emit } = fakePage();
    let stoppedAt = 0;
    const click = async () => {
      setTimeout(() => emit("Page.frameRequestedNavigation"), 90);
      setTimeout(() => emit("Page.frameStartedLoading"), 250);
      setTimeout(() => {
        stoppedAt = performance.now();
        emit("Page.frameStoppedLoading");
      }, 300);
      await Bun.sleep(100);
    };
    await interacted(page, click);
    expect(stoppedAt).toBeGreaterThan(0);
  });

  test("returns soon after a click that starts no navigation", async () => {
    const { page } = fakePage();
    const started = performance.now();
    await interacted(page, () => Bun.sleep(100));
    expect(performance.now() - started).toBeLessThan(400);
  });
});

import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { launch } from "./chrome";

test("native Chrome launch passes the executable as argv and records before readiness", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "chrome-launch-"));
  const binary = "C:\\程式 空間\\Chrome\\chrome.exe";
  let provisional: any;
  try {
    const instance = await launch(parseArgs(["open", "about:blank"]), {
      input: {
        platform: "win32",
        env: { ProgramFiles: "C:\\程式 空間" },
        wsl: false,
      },
      stateDir,
      resolve: (name, candidates) => {
        expect(name).toBe("chrome");
        expect(candidates[0]).toContain("C:\\程式 空間");
        return binary;
      },
      spawn: (argv) => {
        expect(argv[0]).toBe(binary);
        const profile = argv
          .find((arg) => arg.startsWith("--user-data-dir="))!
          .slice(16);
        setTimeout(() => {
          const id = profile.slice(profile.lastIndexOf("-") + 1);
          provisional = JSON.parse(
            readFileSync(join(stateDir, "instances", `${id}.json`), "utf8"),
          );
          writeFileSync(
            join(profile, "DevToolsActivePort"),
            "9222\n/devtools/browser/test\n",
          );
        }, 1);
        return { pid: process.pid, unref() {} };
      },
    });
    expect(provisional.port).toBe(0);
    expect(instance.port).toBe(9222);
    expect(instance.profile.startsWith(stateDir)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(stateDir, "instances", `${instance.id}.json`),
          "utf8",
        ),
      ),
    ).toEqual(instance);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a port file Chrome still holds open reads as not ready yet", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "chrome-port-busy-"));
  try {
    const instance = await launch(parseArgs(["open", "about:blank"]), {
      stateDir,
      resolve: () => "chrome",
      spawn: (argv) => {
        const profile = argv
          .find((arg) => arg.startsWith("--user-data-dir="))!
          .slice(16);
        const port = join(profile, "DevToolsActivePort");
        mkdirSync(port);
        setTimeout(() => {
          rmSync(port, { recursive: true });
          writeFileSync(port, "9444\n/devtools/browser/test\n");
        }, 150);
        return { pid: process.pid, unref() {} };
      },
    });
    expect(instance.port).toBe(9444);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("launch timeout after registration reclaims its private instance and preserves a concurrent launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "chrome-timeout-"));
  const unrelatedDir = join(root, "unrelated");
  const privateDir = join(root, "private");
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let failedProfile = "";
  try {
    const unrelated = await launch(parseArgs(["open", "about:blank"]), {
      stateDir: unrelatedDir,
      resolve: () => "chrome",
      spawn: (argv) => {
        const profile = argv
          .find((arg) => arg.startsWith("--user-data-dir="))!
          .slice(16);
        writeFileSync(
          join(profile, "DevToolsActivePort"),
          "9333\n/devtools/browser/other\n",
        );
        return { pid: process.pid, unref() {} };
      },
    });
    await expect(
      launch(parseArgs(["open", "about:blank"]), {
        stateDir: privateDir,
        timeoutMs: 1,
        resolve: () => "chrome",
        spawn: (argv) => {
          const flag = argv.find((arg) => arg.startsWith("--user-data-dir="))!;
          failedProfile = flag.slice(16);
          child = Bun.spawn(
            [process.execPath, "--eval", "setInterval(() => {}, 1000)", flag],
            {
              stdio: ["ignore", "ignore", "ignore"],
            },
          );
          return child;
        },
      }),
    ).rejects.toThrow("chrome did not open DevTools within 1ms");
    expect(child).toBeDefined();
    await child!.exited;
    expect(existsSync(failedProfile)).toBe(false);
    expect(readdirSync(join(privateDir, "instances"))).toEqual([]);
    expect(existsSync(unrelated.profile)).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(unrelatedDir, "instances", `${unrelated.id}.json`),
          "utf8",
        ),
      ),
    ).toEqual(unrelated);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("spawn failure removes the fresh isolated profile", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "chrome-spawn-failure-"));
  try {
    await expect(
      launch(parseArgs(["open", "about:blank"]), {
        stateDir,
        resolve: () => "chrome",
        spawn: () => {
          throw new Error("spawn failed");
        },
      }),
    ).rejects.toThrow("spawn failed");
    expect(readdirSync(stateDir)).toEqual(["instances"]);
    expect(readdirSync(join(stateDir, "instances"))).toEqual([]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
