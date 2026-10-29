import { describe, expect, test } from "bun:test";
import { pickInstance, resolveBinary, type Instance } from "./instances";

const instance = (id: string, overrides: Partial<Instance> = {}): Instance => ({
  id,
  pid: 1,
  port: 2828,
  profile: `/tmp/${id}`,
  browser: "firefox",
  headless: true,
  ...overrides,
});

describe("pickInstance", () => {
  test("takes the only live instance without an id", () => {
    expect(pickInstance([instance("a")], null).id).toBe("a");
  });

  test("refuses to guess between several and names them", () => {
    expect(() => pickInstance([instance("a"), instance("b")], null)).toThrow(
      /2 instances are open — pass --id: a, b/,
    );
  });

  test("finds the named one", () => {
    expect(pickInstance([instance("a"), instance("b")], "b").id).toBe("b");
  });

  test("says when none is open", () => {
    expect(() => pickInstance([], null)).toThrow(
      "no instance is open — run `open <url>` first",
    );
  });
});

describe("resolveBinary", () => {
  test("takes the first candidate that exists", () => {
    expect(
      resolveBinary("firefox", ["/a", "/b"], {
        validate: (path) => path === "/b",
      }),
    ).toBe("/b");
  });

  test("names every path it looked for when none exists", () => {
    expect(() =>
      resolveBinary("zen", ["/Applications/Zen.app/x"], {
        validate: () => false,
      }),
    ).toThrow("no zen found; looked for /Applications/Zen.app/x");
  });
});

import {
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import {
  newProfile,
  recordInstance,
  liveInstances,
  shutdown,
  isAlive,
} from "./instances";

describe("owned lifecycle", () => {
  async function fixture(
    run: (root: string, owned: Instance) => Promise<void>,
  ) {
    const root = mkdtempSync(join(import.meta.dir, ".lifecycle-"));
    const profile = newProfile(root);
    const owned = instance(profile.id, {
      ...profile,
      pid: 2147483647,
      port: 0,
    });
    recordInstance(root, owned);
    try {
      await run(root, owned);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("removes a stale owned record and profile", async () => {
    await fixture(async (root, owned) => {
      expect(liveInstances(root)).toEqual([]);
      expect(existsSync(owned.profile)).toBe(false);
    });
  });

  test("waits for exit before deleting a profile", async () => {
    await fixture(async (root, owned) => {
      let alive = true;
      const events: string[] = [];
      await shutdown(root, owned, {
        alive: () => alive,
        details: () => ({ command: `firefox -profile ${owned.profile}`, identity: null }),
        busy: () => false,
        kill: () => {
          events.push("terminate");
        },
        sleep: async () => {
          expect(existsSync(owned.profile)).toBe(true);
          events.push("exit");
          alive = false;
        },
        timeoutMs: 30,
      });
      expect(events).toEqual(["terminate", "exit"]);
      expect(existsSync(owned.profile)).toBe(false);
    });
  });

  test("retains a live browser on bounded termination failure", async () => {
    await fixture(async (root, owned) => {
      await expect(
        shutdown(root, owned, {
          alive: () => true,
          details: () => ({ command: `firefox -profile ${owned.profile}`, identity: null }),
          busy: () => false,
          kill: () => {},
          timeoutMs: 1,
        }),
      ).rejects.toThrow("still running");
      expect(existsSync(owned.profile)).toBe(true);
      expect(existsSync(join(root, "instances", `${owned.id}.json`))).toBe(
        true,
      );
    });
  });

  test("refuses a reused PID without touching unrelated resources", async () => {
    await fixture(async (root, owned) => {
      let killed = false;
      await expect(
        shutdown(root, owned, {
          alive: () => true,
          details: () => ({ command: "unrelated --normal-profile", identity: null }),
          busy: () => false,
          kill: () => {
            killed = true;
          },
        }),
      ).rejects.toThrow("ownership");
      expect(killed).toBe(false);
      expect(existsSync(owned.profile)).toBe(true);
    });
  });

  test("rejects a changed process identity even when its argv matches", async () => {
    await fixture(async (root, owned) => {
      writeFileSync(
        join(root, "instances", `${owned.id}.owner`),
        "original-start",
      );
      let killed = false;
      await expect(
        shutdown(root, owned, {
          alive: () => true,
          details: () => ({ command: `firefox -profile ${owned.profile}`, identity: "reused-start" }),
          busy: () => false,
          kill: () => {
            killed = true;
          },
        }),
      ).rejects.toThrow("ownership");
      expect(killed).toBe(false);
      expect(existsSync(owned.profile)).toBe(true);
    });
  });

  test("surfaces cleanup failure instead of reporting a clean close", async () => {
    await fixture(async (root, owned) => {
      const owner = join(root, "instances", `${owned.id}.owner`);
      mkdirSync(owner);
      writeFileSync(join(owner, "blocked"), "keep");
      await expect(
        shutdown(root, owned, { alive: () => false, busy: () => false }),
      ).rejects.toThrow();
    });
  });

  test("retains a profile when only its launch wrapper exited", async () => {
    await fixture(async (root, owned) => {
      await expect(
        shutdown(root, owned, {
          alive: () => false,
          busy: () => true,
          timeoutMs: 1,
        }),
      ).rejects.toThrow("still running");
      expect(existsSync(owned.profile)).toBe(true);
    });
  });

  test("refuses a registry record targeting a normal user profile", async () => {
    await fixture(async (root, owned) => {
      const normal = join(root, "normal-profile");
      writeFileSync(normal, "keep");
      const forged = { ...owned, profile: normal };
      recordInstance(root, forged);
      await expect(shutdown(root, forged)).rejects.toThrow("ownership");
      expect(existsSync(normal)).toBe(true);
    });
  });

  test("prefers protocol close and preserves concurrent unrelated private state", async () => {
    await fixture(async (root, owned) => {
      const other = newProfile(root);
      let alive = true;
      await shutdown(root, owned, {
        alive: () => alive,
        busy: () => false,
        details: () => ({ command: `firefox -profile ${owned.profile}`, identity: null }),
        close: async () => {
          alive = false;
        },
        kill: () => {
          throw new Error("protocol should close first");
        },
      });
      expect(existsSync(other.profile)).toBe(true);
    });
  });
});

describe("executable discovery", () => {
  test("looks up bare names and preserves candidate order", () => {
    const looked: string[] = [];
    expect(
      resolveBinary("chrome", ["chrome", "chromium", "/opt/chrome"], {
        platform: "linux",
        lookup: (name) => {
          looked.push(name);
          return name === "chromium" ? "/bin/chromium" : null;
        },
        validate: () => true,
      }),
    ).toBe("/bin/chromium");
    expect(looked).toEqual(["chrome", "chromium"]);
  });

  test("rejects directories, missing files and Unix non-executables", () => {
    const root = mkdtempSync(join(import.meta.dir, ".discovery-"));
    try {
      const file = join(root, "程式 空間");
      const dir = join(root, "directory");
      mkdirSync(dir);
      writeFileSync(file, "test");
      chmodSync(file, 0o600);
      expect(() =>
        resolveBinary("chrome", [dir, join(root, "missing")]),
      ).toThrow("no chrome found; looked for");
      if (process.platform !== "win32") {
        expect(() =>
          resolveBinary("chrome", [file], { platform: "linux" }),
        ).toThrow(file);
        chmodSync(file, 0o700);
        expect(resolveBinary("chrome", [file], { platform: "linux" })).toBe(
          file,
        );
      }
      const exe = join(root, "chrome.exe");
      writeFileSync(exe, "test");
      expect(resolveBinary("chrome", [exe], { platform: "win32" })).toBe(exe);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("WSL refuses Windows PATH results and adds a Linux installation hint", () => {
    expect(() =>
      resolveBinary("firefox", ["firefox", "/usr/bin/firefox"], {
        platform: "linux",
        wsl: true,
        lookup: () => "/mnt/c/Firefox/firefox.exe",
        validate: (path) => path.endsWith(".exe"),
      }),
    ).toThrow(
      "no firefox found; looked for firefox, /usr/bin/firefox\nInstall a Linux build of firefox inside WSL.",
    );
  });

  test("Linux skips a Snap browser for a later candidate and names Snap when none is left", () => {
    const snap = (path: string) =>
      path === "/snap/bin/chromium" ? "/usr/bin/snap" : path;
    const options = {
      platform: "linux",
      wsl: false,
      validate: () => true,
      target: snap,
    } as const;
    expect(
      resolveBinary("chrome", ["chromium", "/opt/google/chrome/chrome"], {
        ...options,
        lookup: () => "/snap/bin/chromium",
      }),
    ).toBe("/opt/google/chrome/chrome");
    expect(() =>
      resolveBinary("chrome", ["chromium"], {
        ...options,
        lookup: () => "/snap/bin/chromium",
      }),
    ).toThrow("Snap builds of chrome are not supported");
    expect(
      resolveBinary("firefox", ["/snap/firefox/current/usr/lib/firefox/firefox", "/usr/bin/firefox"], options),
    ).toBe("/usr/bin/firefox");
  });

  test("Linux skips a shell wrapper that execs a Snap and keeps any other script", () => {
    const root = mkdtempSync(join(import.meta.dir, ".snap-wrapper-"));
    try {
      const wrapper = join(root, "firefox");
      writeFileSync(wrapper, '#!/bin/sh\nexec /snap/bin/firefox "$@"\n');
      const launcher = join(root, "chromium-browser");
      writeFileSync(launcher, '#!/bin/sh\nexec /usr/lib/chromium/chromium "$@"\n');
      const options = { platform: "linux", wsl: false, validate: () => true } as const;
      expect(() => resolveBinary("firefox", [wrapper], options)).toThrow("Snap builds of firefox are not supported");
      expect(resolveBinary("chrome", [wrapper, launcher], options)).toBe(launcher);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("WSL rejects a Linux symlink to a Windows executable", () => {
  const root = mkdtempSync(join(import.meta.dir, ".wsl-link-"));
  try {
    const exe = join(root, "chrome.exe");
    writeFileSync(exe, "MZ");
    chmodSync(exe, 0o700);
    const link = join(root, "chrome");
    if (process.platform === "win32") {
      expect(() =>
        resolveBinary("chrome", [exe], { platform: "linux", wsl: true }),
      ).toThrow("inside WSL");
    } else {
      symlinkSync(exe, link);
      expect(() =>
        resolveBinary("chrome", [link], { platform: "linux", wsl: true }),
      ).toThrow("inside WSL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real exited launch wrapper cannot authorize deletion of its live descendant profile", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".wrapper-"));
  const profile = newProfile(root);
  let wrapper: ReturnType<typeof Bun.spawn> | undefined;
  let childPid = 0;
  try {
    const pidFile = join(root, "child-pid");
    const source = `const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] }); await Bun.write(process.argv[1], String(child.pid)); child.unref();`;
    wrapper = Bun.spawn([process.execPath, "-e", source, pidFile], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const owned = instance(profile.id, {
      ...profile,
      pid: wrapper.pid,
      port: 0,
      browser: "chrome",
    });
    recordInstance(root, owned);
    await wrapper.exited;
    childPid = Number(await Bun.file(pidFile).text());
    if (process.platform === "win32")
      writeFileSync(
        join(root, "instances", `${owned.id}.owner`),
        "unverified-launcher",
      );
    await expect(shutdown(root, owned, { timeoutMs: 1 })).rejects.toThrow(
      "still running",
    );
    expect(existsSync(owned.profile)).toBe(true);
    expect(liveInstances(root).map((item) => item.id)).toEqual([owned.id]);
  } finally {
    if (childPid && isAlive(childPid)) process.kill(childPid, "SIGTERM");
    if (wrapper && wrapper.exitCode === null) {
      wrapper.kill();
      await wrapper.exited;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("a live browser under a CJK and spaced state path verifies its real process ownership", async () => {
  const root = mkdtempSync(join(import.meta.dir, ".使用者 Q-"));
  const profile = newProfile(root);
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000)", `--user-data-dir=${profile.profile}`],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  try {
    const owned = instance(profile.id, {
      ...profile,
      pid: child.pid,
      port: 0,
      browser: "chrome",
    });
    recordInstance(root, owned);
    expect(liveInstances(root).map((item) => item.id)).toEqual([owned.id]);
  } finally {
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
