import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { versionGte } from "./setup";

const SCRIPT = join(import.meta.dir, "setup.ts");
const CHANNEL_SCRIPT = resolve(
  import.meta.dir,
  "..",
  "..",
  "cockpit",
  "scripts",
  "cockpit-channel.ts",
);
const COLLECTOR_SCRIPT = resolve(
  import.meta.dir,
  "..",
  "..",
  "usage-dashboard",
  "scripts",
  "statusline-collector.ts",
);

let home: string;
let dataDir: string;

// Run setup.ts as a subprocess with a controlled HOME (and CLAUDE_PLUGIN_DATA)
// so reads/writes land in a tmpdir, never the real ~/.claude. This exercises
// the actual CLI entrypoint.
function run(args: string[] = []): { code: number; stdout: string } {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: dataDir },
  });
  return {
    code: proc.exitCode ?? 0,
    stdout: proc.stdout.toString() + proc.stderr.toString(),
  };
}

function claudeJson() {
  return JSON.parse(readFileSync(join(home, ".claude.json"), "utf-8"));
}
function settingsJson() {
  return JSON.parse(
    readFileSync(join(home, ".claude", "settings.json"), "utf-8"),
  );
}
function names(dir: string): string[] {
  return readdirSync(dir);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "monitor-setup-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  dataDir = mkdtempSync(join(tmpdir(), "monitor-data-"));
  // Seed the one required HOME-dependent dashboard prerequisite so --check can
  // pass; vendor/pricing resolve to the real committed repo assets.
  writeFileSync(join(home, ".claude", "stats-cache.json"), "{}");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe("versionGte", () => {
  test("compares semver parts numerically", () => {
    expect(versionGte("2.1.150", "2.1.80")).toBe(true);
    expect(versionGte("2.1.80", "2.1.80")).toBe(true);
    expect(versionGte("2.1.79", "2.1.80")).toBe(false);
    expect(versionGte("3.0.0", "2.9.9")).toBe(true);
    expect(versionGte("2.0.5", "2.1.0")).toBe(false);
  });
});

describe("--check", () => {
  test("covers both skills: dashboard prerequisites + cockpit channel", () => {
    const { code, stdout } = run();
    expect(code).toBe(0);
    // dashboard side
    expect(stdout).toContain("✓ bun runtime");
    expect(stdout).toContain("stats-cache.json");
    expect(stdout).toContain("live usage limits (statusline collector)");
    // cockpit side
    expect(stdout).toContain("cockpit-channel script exists");
    expect(stdout).toContain("○ cockpit-channel registered");
  });

  test("fails required when a dashboard prerequisite is missing", () => {
    rmSync(join(home, ".claude", "stats-cache.json"));
    const { code, stdout } = run();
    expect(code).toBe(1);
    expect(stdout).toContain("Required checks failed");
  });
});

describe("--dry-run", () => {
  test("prints intended writes without touching files", () => {
    const { code, stdout } = run(["--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain(`Would write to ${join(home, ".claude.json")}`);
    expect(stdout).toContain("cockpit-channel");
    expect(stdout).toContain("Would set statusLine.command");
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    // settings.json was never created (only stats-cache was seeded)
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });
});

describe("--apply", () => {
  test("registers channel, wires statusline, and reports done", () => {
    const { code, stdout } = run(["--apply"]);
    expect(code).toBe(0);
    expect(stdout).toContain("✓ Registered cockpit-channel");
    expect(stdout).toContain("✓ Wired statusline collector");

    expect(claudeJson().mcpServers["cockpit-channel"]).toEqual({
      command: "bun",
      args: [CHANNEL_SCRIPT],
    });
    expect(settingsJson().statusLine.command).toBe(`bun ${COLLECTOR_SCRIPT}`);
  });

  test("preserves existing mcpServers and wraps an existing statusline", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { other: { command: "x" } } }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: "my-old-line", padding: 0 },
        theme: "dark",
      }),
    );

    expect(run(["--apply"]).code).toBe(0);

    const cj = claudeJson();
    expect(cj.mcpServers.other).toEqual({ command: "x" });
    expect(cj.mcpServers["cockpit-channel"].args).toEqual([CHANNEL_SCRIPT]);

    const sj = settingsJson();
    expect(sj.theme).toBe("dark");
    expect(sj.statusLine.command).toBe(
      `TOKEN_ATLAS_STATUSLINE_COMMAND='my-old-line' bun ${COLLECTOR_SCRIPT}`,
    );
  });

  test("backs up both files before overwriting", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: {} }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ theme: "dark" }),
    );

    run(["--apply"]);

    // channel backup is timestamped; statusline backup keeps the dashboard's
    // existing single-name convention (settings.json.bak).
    expect(names(home).some((f) => f.startsWith(".claude.json.bak-"))).toBe(
      true,
    );
    expect(names(join(home, ".claude"))).toContain("settings.json.bak");
  });

  test("is idempotent — a second apply writes nothing new", () => {
    run(["--apply"]);
    const { stdout } = run(["--apply"]);
    expect(stdout).toContain("cockpit-channel already registered");
    expect(stdout).toContain("statusline collector already wired");
  });

  test("re-check is all green after apply", () => {
    run(["--apply"]);
    const { code, stdout } = run();
    expect(code).toBe(0);
    expect(stdout).toContain("✓ cockpit-channel registered");
    expect(stdout).toContain("✓ live usage limits (statusline collector)");
  });
});

describe("single-piece flags", () => {
  test("--apply-channel wires only the channel", () => {
    run(["--apply-channel"]);
    expect(claudeJson().mcpServers["cockpit-channel"]).toBeDefined();
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  test("--apply-statusline wires only the statusline", () => {
    run(["--apply-statusline"]);
    expect(settingsJson().statusLine).toBeDefined();
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
  });
});

describe("version drift", () => {
  // An old plugin-cache path whose version segment differs from the current one.
  const OLD_COLLECTOR =
    "/h/.claude/plugins/cache/q-lab-marketplace/monitor/3.1.0/skills/usage-dashboard/scripts/statusline-collector.ts";
  const OLD_CHANNEL =
    "/h/.claude/plugins/cache/q-lab-marketplace/monitor/3.1.0/skills/cockpit/scripts/cockpit-channel.ts";

  test("--check flags a drifted statusline path with the version mismatch", () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        statusLine: {
          type: "command",
          command: `bun ${OLD_COLLECTOR}`,
          padding: 0,
        },
      }),
    );
    const { stdout } = run();
    expect(stdout).toContain("○ live usage limits");
    expect(stdout).toContain("monitor 3.1.0");
  });

  test("--apply re-points a drifted statusline to the current path", () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        statusLine: {
          type: "command",
          command: `bun ${OLD_COLLECTOR}`,
          padding: 0,
        },
      }),
    );
    run(["--apply-statusline"]);
    expect(settingsJson().statusLine.command).toBe(`bun ${COLLECTOR_SCRIPT}`);
  });

  test("--apply re-points a drifted cockpit-channel to the current path", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [OLD_CHANNEL] },
        },
      }),
    );
    run(["--apply-channel"]);
    expect(claudeJson().mcpServers["cockpit-channel"].args).toEqual([
      CHANNEL_SCRIPT,
    ]);
  });
});

describe("--migrate (re-point only, never fresh-wire)", () => {
  const OLD_COLLECTOR =
    "/h/.claude/plugins/cache/q-lab-marketplace/monitor/3.1.0/skills/usage-dashboard/scripts/statusline-collector.ts";

  test("re-points a drifted statusline but leaves an unconfigured channel alone", () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        statusLine: {
          type: "command",
          command: `bun ${OLD_COLLECTOR}`,
          padding: 0,
        },
      }),
    );
    const { stdout } = run(["--migrate"]);
    expect(stdout).toContain("Re-pointed: statusline collector");
    expect(settingsJson().statusLine.command).toBe(`bun ${COLLECTOR_SCRIPT}`);
    // Channel was never configured — migrate must NOT create it.
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
  });

  test("does nothing when nothing is configured", () => {
    const { stdout } = run(["--migrate"]);
    expect(stdout).toContain("Nothing to migrate");
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });
});

describe("--session-check (marker-gated)", () => {
  const OLD_CHANNEL =
    "/h/.claude/plugins/cache/q-lab-marketplace/monitor/3.1.0/skills/cockpit/scripts/cockpit-channel.ts";

  test("migrates a drift on first run and writes the version marker", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [OLD_CHANNEL] },
        },
      }),
    );
    const { code } = run(["--session-check"]);
    expect(code).toBe(0);
    expect(claudeJson().mcpServers["cockpit-channel"].args).toEqual([
      CHANNEL_SCRIPT,
    ]);
    expect(existsSync(join(dataDir, ".wired-version"))).toBe(true);
  });

  test("is a no-op once the marker matches the current version", () => {
    // First run reconciles and stamps the marker.
    run(["--session-check"]);
    const marker = join(dataDir, ".wired-version");
    expect(existsSync(marker)).toBe(true);
    // Now drift the channel again; a second run should NOT touch it, because the
    // marker already records this version (the gate skips the migrate).
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [OLD_CHANNEL] },
        },
      }),
    );
    run(["--session-check"]);
    expect(claudeJson().mcpServers["cockpit-channel"].args).toEqual([
      OLD_CHANNEL,
    ]);
  });

  test("never fresh-wires on a clean install", () => {
    run(["--session-check"]);
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  test("nudges the user to run /monitor:install once when nothing is wired", () => {
    const first = run(["--session-check"]);
    expect(first.stdout).toContain("/monitor:install");
    // Write-free: the nudge must not create any config.
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    // Second run is gated by the marker — no repeat nag.
    const second = run(["--session-check"]);
    expect(second.stdout).not.toContain("/monitor:install");
  });
});

describe("malformed config", () => {
  test("refuses to write when ~/.claude.json is invalid JSON", () => {
    writeFileSync(join(home, ".claude.json"), "{ not json");
    const { code, stdout } = run(["--apply-channel"]);
    expect(code).toBe(1);
    expect(stdout).toContain("Couldn't parse");
    expect(readFileSync(join(home, ".claude.json"), "utf-8")).toBe(
      "{ not json",
    );
  });
});
