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

// Run setup.ts as a subprocess with a controlled HOME so reads/writes land in
// a tmpdir, never the real ~/.claude. This exercises the actual CLI entrypoint.
function run(args: string[] = []): { code: number; stdout: string } {
  const proc = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { ...process.env, HOME: home },
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
  // Seed the one required HOME-dependent dashboard prerequisite so --check can
  // pass; vendor/pricing resolve to the real committed repo assets.
  writeFileSync(join(home, ".claude", "stats-cache.json"), "{}");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
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
