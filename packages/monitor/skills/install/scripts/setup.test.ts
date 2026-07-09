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
import { cockpitChecks, versionGte } from "./setup";

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
    // cockpit side — channel is plugin-packaged; with no stale entry it's green
    expect(stdout).toContain("cockpit-channel script exists");
    expect(stdout).toContain("✓ no stale cockpit-channel entry");
    expect(stdout).toContain("mermaid diagram lint (happy-dom)");
  });

  test("flags a stale hand-wired cockpit-channel entry", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
    );
    const { stdout } = run();
    expect(stdout).toContain("○ no stale cockpit-channel entry");
    expect(stdout).toContain("--migrate");
  });

  test("fails required when a dashboard prerequisite is missing", () => {
    rmSync(join(home, ".claude", "stats-cache.json"));
    const { code, stdout } = run();
    expect(code).toBe(1);
    expect(stdout).toContain("Required checks failed");
  });
});

describe("cockpitChecks", () => {
  test("reports happy-dom as an optional cockpit precheck", () => {
    const checks = cockpitChecks();
    const check = checks.find(
      (c) => c.label === "mermaid diagram lint (happy-dom)",
    );

    expect(check).toBeDefined();
    expect(check?.level).toBe("optional");
  });

  test("marks happy-dom ok when it resolves from cockpit scripts", () => {
    const checks = cockpitChecks(() => "/fake/happy-dom.js");
    const check = checks.find(
      (c) => c.label === "mermaid diagram lint (happy-dom)",
    );

    expect(check?.ok).toBe(true);
  });

  test("includes a hint when happy-dom does not resolve", () => {
    const checks = cockpitChecks(() => {
      throw new Error("missing");
    });
    const check = checks.find(
      (c) => c.label === "mermaid diagram lint (happy-dom)",
    );

    expect(check?.ok).toBe(false);
    expect(check?.hint).toContain("falls back to weaker heuristics");
    expect(check?.hint).toContain("bun install");
  });
});

describe("--dry-run", () => {
  test("prints intended statusline write without touching files", () => {
    const { code, stdout } = run(["--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Would set statusLine.command");
    // no stale channel entry → nothing to remove, no .claude.json created
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    // settings.json was never created (only stats-cache was seeded)
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });

  test("previews removing a stale channel entry without writing", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
    );
    const { stdout } = run(["--dry-run"]);
    expect(stdout).toContain("Would remove the stale cockpit-channel entry");
    // still present — dry-run wrote nothing
    expect(claudeJson().mcpServers["cockpit-channel"]).toBeDefined();
  });
});

describe("--apply", () => {
  test("wires statusline, leaves no channel entry, and reports done", () => {
    const { code, stdout } = run(["--apply"]);
    expect(code).toBe(0);
    expect(stdout).toContain("✓ Wired statusline collector");

    // channel is plugin-packaged now — apply never writes one into ~/.claude.json
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(settingsJson().statusLine.command).toBe(`bun ${COLLECTOR_SCRIPT}`);
  });

  test("removes a stale channel entry but preserves other mcpServers", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "x" },
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
    );
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: "my-old-line", padding: 0 },
        theme: "dark",
      }),
    );

    const { stdout } = run(["--apply"]);
    expect(stdout).toContain("✓ Removed stale cockpit-channel");

    const cj = claudeJson();
    expect(cj.mcpServers.other).toEqual({ command: "x" });
    expect(cj.mcpServers["cockpit-channel"]).toBeUndefined();

    const sj = settingsJson();
    expect(sj.theme).toBe("dark");
    expect(sj.statusLine.command).toBe(
      `TOKEN_ATLAS_STATUSLINE_COMMAND='my-old-line' bun ${COLLECTOR_SCRIPT}`,
    );
  });

  test("backs up both files before changing them", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
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
    expect(stdout).toContain("statusline collector already wired");
    // no channel entry was ever written, so nothing to remove on either pass
    expect(stdout).not.toContain("Removed stale cockpit-channel");
  });

  test("re-check is all green after apply", () => {
    run(["--apply"]);
    const { code, stdout } = run();
    expect(code).toBe(0);
    expect(stdout).toContain("✓ no stale cockpit-channel entry");
    expect(stdout).toContain("✓ live usage limits (statusline collector)");
  });
});

describe("single-piece flags", () => {
  test("--apply-statusline wires only the statusline (no channel cleanup)", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
    );
    run(["--apply-statusline"]);
    expect(settingsJson().statusLine).toBeDefined();
    // statusline-only must not touch ~/.claude.json
    expect(claudeJson().mcpServers["cockpit-channel"]).toBeDefined();
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

  test("--apply removes a drifted cockpit-channel entry instead of re-pointing", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [OLD_CHANNEL] },
        },
      }),
    );
    run(["--apply"]);
    expect(claudeJson().mcpServers["cockpit-channel"]).toBeUndefined();
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

  test("removes a stale hand-wired channel entry", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
    );
    const { stdout } = run(["--migrate"]);
    expect(stdout).toContain("Re-pointed: cockpit-channel cleanup");
    expect(claudeJson().mcpServers["cockpit-channel"]).toBeUndefined();
  });

  test("does nothing when nothing is configured", () => {
    const { stdout } = run(["--migrate"]);
    expect(stdout).toContain("Nothing to migrate");
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });
});

describe("--session-check (marker-gated)", () => {
  test("removes a stale channel entry on first run and writes the version marker", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
    );
    const { code } = run(["--session-check"]);
    expect(code).toBe(0);
    expect(claudeJson().mcpServers["cockpit-channel"]).toBeUndefined();
    expect(existsSync(join(dataDir, ".wired-version"))).toBe(true);
  });

  test("is a no-op once the marker matches the current version", () => {
    // First run reconciles and stamps the marker.
    run(["--session-check"]);
    const marker = join(dataDir, ".wired-version");
    expect(existsSync(marker)).toBe(true);
    // Now plant a stale channel entry; a second run should NOT remove it, because
    // the marker already records this version (the gate skips the migrate).
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
    );
    run(["--session-check"]);
    expect(claudeJson().mcpServers["cockpit-channel"]).toBeDefined();
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
  test("reports a parse error and leaves an invalid ~/.claude.json untouched", () => {
    writeFileSync(join(home, ".claude.json"), "{ not json");
    const { code, stdout } = run(["--apply"]);
    expect(code).toBe(1);
    expect(stdout).toContain("Couldn't parse");
    expect(readFileSync(join(home, ".claude.json"), "utf-8")).toBe(
      "{ not json",
    );
  });
});
