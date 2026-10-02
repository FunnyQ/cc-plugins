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
const COCKPIT_SHIM = resolve(import.meta.dir, "../../cockpit/bin/cockpit");
// The retired collector, as an older --apply wrote it into settings.json.
const COLLECTOR_COMMAND = `${COCKPIT_SHIM} atlas statusline`;
const DEFAULT_INNER = "bunx -y ccstatusline@latest";
// The removed TS collector, as a pre-migration settings.json still names it.
const TS_COLLECTOR = resolve(
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
function run(args: string[] = []): {
  code: number;
  stdout: string;
  out: string;
} {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { ...process.env, HOME: home, CLAUDE_PLUGIN_DATA: dataDir },
  });
  return {
    code: proc.exitCode ?? 0,
    stdout: proc.stdout.toString() + proc.stderr.toString(),
    // stdout alone — the hook payload must parse as JSON on its own.
    out: proc.stdout.toString(),
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
    expect(stdout).not.toContain("statusline");
    // cockpit side — channel is plugin-packaged; with no stale entry it's green
    expect(stdout).toContain("cockpit shim exists and is executable");
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
  test("previews the permission write without touching files", () => {
    const { code, stdout } = run(["--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Would add to permissions.allow");
    expect(stdout).not.toContain("statusLine");
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
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
  test("pre-approves scripts, never writes a statusLine, and reports done", () => {
    const { code, stdout } = run(["--apply"]);
    expect(code).toBe(0);
    expect(stdout).toContain("✓ Pre-approved q-lab plugin scripts");
    // channel is plugin-packaged now — apply never writes one into ~/.claude.json
    expect(existsSync(join(home, ".claude.json"))).toBe(false);
    expect(settingsJson().statusLine).toBeUndefined();
  });

  test("removes a stale channel entry but preserves other mcpServers and the statusLine", () => {
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
    expect(sj.statusLine.command).toBe("my-old-line");
  });

  test("removes a cockpit-channel entry from an older version's path", () => {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": {
            command: "bun",
            args: [
              "/h/.claude/plugins/cache/q-lab-marketplace/monitor/3.1.0/skills/cockpit/scripts/cockpit-channel.ts",
            ],
          },
        },
      }),
    );
    run(["--apply"]);
    expect(claudeJson().mcpServers["cockpit-channel"]).toBeUndefined();
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

    expect(names(home).some((f) => f.startsWith(".claude.json.bak-"))).toBe(
      true,
    );
    expect(
      names(join(home, ".claude")).some((f) => f.startsWith("settings.json.bak-")),
    ).toBe(true);
  });

  test("is idempotent — a second apply writes nothing new", () => {
    run(["--apply"]);
    const { stdout } = run(["--apply"]);
    expect(stdout).toContain("already pre-approved");
    // no channel entry was ever written, so nothing to remove on either pass
    expect(stdout).not.toContain("Removed stale cockpit-channel");
  });

  test("pre-approves the shim alongside existing Bun scripts", () => {
    run(["--apply"]);
    expect(settingsJson().permissions.allow).toContain(
      "Bash(**/q-lab-marketplace/*/skills/cockpit/bin/cockpit *)",
    );
    expect(settingsJson().permissions.allow).toContain(
      "Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts *)",
    );
  });

  test("re-check is all green after apply", () => {
    run(["--apply"]);
    const { code, stdout } = run();
    expect(code).toBe(0);
    expect(stdout).toContain("✓ no stale cockpit-channel entry");
    expect(stdout).toContain("✓ q-lab plugin scripts pre-approved");
  });
});

describe("--migrate (channel cleanup + collector unwrap, never fresh-wire)", () => {
  test("recognizes and removes a hand-wired shim channel", () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({
      mcpServers: { "cockpit-channel": { command: COCKPIT_SHIM, args: ["channel"] } },
    }));
    expect(run().stdout).toContain("○ no stale cockpit-channel entry");
    run(["--migrate"]);
    expect(claudeJson().mcpServers["cockpit-channel"]).toBeUndefined();
  });

  const OLD_COLLECTOR =
    "/h/.claude/plugins/cache/q-lab-marketplace/monitor/3.1.0/skills/usage-dashboard/scripts/statusline-collector.ts";
  const OLD_SHIM_COMMAND =
    "/h/.claude/plugins/cache/q-lab-marketplace/monitor/6.0.0/skills/cockpit/bin/cockpit atlas statusline";

  function statusLine(command: string) {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command, padding: 3 },
        theme: "dark",
      }),
    );
  }

  test("unwraps a collector at any path back to its default command, and only once", () => {
    statusLine(OLD_SHIM_COMMAND);
    const { stdout } = run(["--migrate"]);
    expect(stdout).toContain("Migrated: statusline collector removal");
    const sj = settingsJson();
    expect(sj.statusLine).toEqual({
      type: "command",
      command: DEFAULT_INNER,
      padding: 3,
    });
    expect(sj.theme).toBe("dark");
    expect(
      names(join(home, ".claude")).some((f) => f.startsWith("settings.json.bak-")),
    ).toBe(true);
    // Channel was never configured — migrate must NOT create it.
    expect(existsSync(join(home, ".claude.json"))).toBe(false);

    const after = readFileSync(join(home, ".claude", "settings.json"), "utf-8");
    expect(run(["--migrate"]).stdout).toContain("Nothing to migrate");
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).toBe(
      after,
    );
  });

  test("unwraps a wrapped collector to the command it wrapped", () => {
    statusLine(`TOKEN_ATLAS_STATUSLINE_COMMAND='npx claude-powerline' ${COLLECTOR_COMMAND}`);
    run(["--migrate"]);
    expect(settingsJson().statusLine.command).toBe("npx claude-powerline");
  });

  test("unwraps the removed TS collector too", () => {
    statusLine(`bun ${OLD_COLLECTOR}`);
    run(["--migrate"]);
    expect(settingsJson().statusLine.command).toBe(DEFAULT_INNER);
  });

  test("leaves a foreign statusline-collector.ts alone", () => {
    statusLine("bun /home/me/bin/statusline-collector.ts");
    expect(run(["--migrate"]).stdout).toContain("Nothing to migrate");
    expect(settingsJson().statusLine.command).toBe(
      "bun /home/me/bin/statusline-collector.ts",
    );
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
    expect(stdout).toContain("Migrated: cockpit-channel cleanup");
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

  test("an older session that sees a newer marker does not roll config backward", () => {
    const marker = join(dataDir, ".wired-version");
    writeFileSync(marker, "999.0.0\n");
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
    );

    run(["--session-check"]);

    expect(readFileSync(marker, "utf-8")).toBe("999.0.0\n");
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

  describe("statusline unwrap", () => {
    const SETTINGS = () => join(home, ".claude", "settings.json");

    test("unwraps a collector inside a user command's quoted argument, speaking only one JSON line", () => {
      const HUD = "/opt/hud/sketchybard statusline";
      writeFileSync(
        SETTINGS(),
        JSON.stringify({
          statusLine: { type: "command", command: `${HUD} '${COLLECTOR_COMMAND}'` },
        }),
      );

      const { code, out } = run(["--session-check"]);

      expect(code).toBe(0);
      expect(settingsJson().statusLine.command).toBe(`${HUD} '${DEFAULT_INNER}'`);
      const lines = out.split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const message = JSON.parse(lines[0]!).systemMessage as string;
      expect(message).toContain("statusline collector removal");
      expect(message).toContain(DEFAULT_INNER);
    });

    test("a second session changes nothing", () => {
      writeFileSync(
        SETTINGS(),
        JSON.stringify({
          statusLine: { type: "command", command: `bun ${TS_COLLECTOR}` },
        }),
      );
      run(["--session-check"]);
      const after = readFileSync(SETTINGS(), "utf-8");

      const second = run(["--session-check"]);

      expect(readFileSync(SETTINGS(), "utf-8")).toBe(after);
      expect(second.out).not.toContain("statusline collector");
    });

    test("leaves an unparseable settings.json byte-identical", () => {
      writeFileSync(SETTINGS(), "{ not json");
      run(["--session-check"]);
      expect(readFileSync(SETTINGS(), "utf-8")).toBe("{ not json");
      expect(names(join(home, ".claude")).some((f) => f.includes(".bak"))).toBe(false);
    });

    test("never adds a statusLine block that was absent", () => {
      writeFileSync(SETTINGS(), JSON.stringify({ theme: "dark" }));
      run(["--session-check"]);
      expect(settingsJson()).toEqual({ theme: "dark" });
    });
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

describe("--session-check drift watch (every session, read-only)", () => {
  const PERMISSIONS = [
    "Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts)",
    "Bash(bun **/q-lab-marketplace/*/skills/*/scripts/*.ts *)",
    "Bash(**/q-lab-marketplace/*/skills/cockpit/bin/cockpit *)",
  ];

  function wire(allow = PERMISSIONS) {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow } }),
    );
  }
  const unapproved = () => wire([]);
  // A current marker closes the migrate gate, so only the drift watch runs.
  const markerCurrent = () =>
    writeFileSync(join(dataDir, ".wired-version"), "999.0.0\n");

  test("a notice is a single JSON object with a systemMessage", () => {
    const { out } = run(["--session-check"]);
    const payload = JSON.parse(out.trim());
    expect(payload.systemMessage).toContain("/monitor:install");
  });

  test("says nothing when the wiring matches this install", () => {
    wire();
    const { out } = run(["--session-check"]);
    expect(out.trim()).toBe("");
  });

  test("reports a missing shim permission even when Bun is approved", () => {
    wire(PERMISSIONS.filter((p) => p.startsWith("Bash(bun ")));
    expect(run(["--session-check"]).stdout).toContain("permissions.allow");
  });

  test("says nothing about a statusLine of any kind", () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        statusLine: { type: "command", command: COLLECTOR_COMMAND },
        permissions: { allow: PERMISSIONS },
      }),
    );
    markerCurrent();
    expect(run(["--session-check"]).out.trim()).toBe("");
  });

  test("notices drift that appears within the same version, and writes nothing", () => {
    wire();
    run(["--session-check"]); // stamps the version marker + a clean drift signature
    // Same version, so the migrate gate is closed — the drift watch must still see this.
    unapproved();
    const before = readFileSync(join(home, ".claude", "settings.json"), "utf-8");

    const { stdout } = run(["--session-check"]);

    expect(stdout).toContain("permissions.allow");
    expect(stdout).toContain("/monitor:install");
    // Notice only — the same-version path never repairs.
    expect(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).toBe(
      before,
    );
  });

  test("reports every drifted piece in one notice", () => {
    unapproved();
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "cockpit-channel": { command: "bun", args: [CHANNEL_SCRIPT] },
        },
      }),
    );
    markerCurrent();

    const { out } = run(["--session-check"]);
    const message = JSON.parse(out.trim()).systemMessage as string;
    expect(message).toContain("cockpit-channel");
    expect(message).toContain("permissions.allow");
  });

  test("repeats nothing while the same drift persists", () => {
    wire();
    run(["--session-check"]);
    unapproved();
    expect(run(["--session-check"]).stdout).toContain("permissions.allow");
    expect(run(["--session-check"]).out.trim()).toBe("");
  });

  test("notices again after the drift is fixed and returns", () => {
    wire();
    run(["--session-check"]);
    unapproved();
    run(["--session-check"]);
    wire();
    run(["--session-check"]); // clean again — clears the signature
    unapproved();
    expect(run(["--session-check"]).stdout).toContain("permissions.allow");
  });

  test("names an unparseable settings.json instead of guessing past it", () => {
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    const { stdout } = run(["--session-check"]);
    expect(stdout).toContain("not valid JSON");
  });
});
