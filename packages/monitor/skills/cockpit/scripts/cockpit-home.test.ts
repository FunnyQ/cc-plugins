import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { cockpitHome } from "./cockpit-home";

type EnvSnapshot = {
  cockpitHome?: string;
  home?: string;
  xdgDataHome?: string;
};

function snapshotEnv(): EnvSnapshot {
  return {
    cockpitHome: process.env.COCKPIT_HOME,
    home: process.env.HOME,
    xdgDataHome: process.env.XDG_DATA_HOME,
  };
}

function restoreEnv(snapshot: EnvSnapshot): void {
  if (snapshot.cockpitHome === undefined) delete process.env.COCKPIT_HOME;
  else process.env.COCKPIT_HOME = snapshot.cockpitHome;

  if (snapshot.home === undefined) delete process.env.HOME;
  else process.env.HOME = snapshot.home;

  if (snapshot.xdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = snapshot.xdgDataHome;
}

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "cockpit-home-"));
}

function runCockpitHome(env: Record<string, string | undefined>): string {
  const nextEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(nextEnv)) {
    if (value === undefined) delete nextEnv[key];
  }
  const helperUrl = pathToFileURL(
    join(import.meta.dir, "cockpit-home.ts"),
  ).href;
  const script = `
    import { cockpitHome } from ${JSON.stringify(helperUrl)};
    console.log(cockpitHome());
  `;
  const proc = Bun.spawnSync(["bun", "-e", script], { env: nextEnv });
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr.toString());
  }
  return proc.stdout.toString().trim();
}

describe("cockpitHome", () => {
  test("COCKPIT_HOME wins when set", () => {
    const env = snapshotEnv();
    const dir = tempHome();
    try {
      process.env.COCKPIT_HOME = join(dir, "explicit");
      process.env.XDG_DATA_HOME = join(dir, "xdg");
      process.env.HOME = join(dir, "home");

      expect(cockpitHome()).toBe(join(dir, "explicit"));
    } finally {
      restoreEnv(env);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses XDG_DATA_HOME default path when COCKPIT_HOME is unset", () => {
    const env = snapshotEnv();
    const dir = tempHome();
    try {
      expect(
        runCockpitHome({
          COCKPIT_HOME: undefined,
          XDG_DATA_HOME: join(dir, "xdg"),
          HOME: join(dir, "home"),
        }),
      ).toBe(join(dir, "xdg", "q-lab", "cockpit"));
    } finally {
      restoreEnv(env);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("migrates legacy ~/.cockpit when the new path is absent", () => {
    const env = snapshotEnv();
    const dir = tempHome();
    try {
      const home = join(dir, "home");
      const xdg = join(dir, "xdg");
      const legacy = join(home, ".cockpit");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "daemon.json"), "legacy");

      const next = runCockpitHome({
        COCKPIT_HOME: undefined,
        XDG_DATA_HOME: xdg,
        HOME: home,
      });

      expect(next).toBe(join(dir, "xdg", "q-lab", "cockpit"));
      expect(existsSync(legacy)).toBe(false);
      expect(readFileSync(join(next, "daemon.json"), "utf8")).toBe("legacy");
    } finally {
      restoreEnv(env);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not throw when neither legacy nor new path exists", () => {
    const env = snapshotEnv();
    const dir = tempHome();
    try {
      expect(() =>
        runCockpitHome({
          COCKPIT_HOME: undefined,
          XDG_DATA_HOME: join(dir, "xdg"),
          HOME: join(dir, "home"),
        }),
      ).not.toThrow();
      expect(
        runCockpitHome({
          COCKPIT_HOME: undefined,
          XDG_DATA_HOME: join(dir, "xdg"),
          HOME: join(dir, "home"),
        }),
      ).toBe(join(dir, "xdg", "q-lab", "cockpit"));
    } finally {
      restoreEnv(env);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
