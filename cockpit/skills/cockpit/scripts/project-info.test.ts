// Tests for project-info (ui/04): meta/instruction file reading, DESIGN.md
// token parsing, path confinement, and the /api/project-info handler's
// registry gate.
// Run: bun test cockpit/skills/cockpit/scripts/project-info.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProjectInfo,
  handleProjectInfo,
  parseDesignTokens,
} from "./project-info";

let projectDir: string;
let cockpitHome: string;

const DESIGN_MD = `---
name: Test Theme
description: fixture
colors:
  cream: "#f4efe6"
  ink: "#1a1a1a"
  ink-soft: "#2a2622"
  worn-gold: "#b8960c"
  rule: "#1a1a1a1f"
typography:
  body:
    fontFamily: '"Noto Sans TC", sans-serif'
    fontSize: "16px"
  label:
    fontFamily: '"DM Mono", monospace'
rounded:
  sm: "6px"
  md: "8px"
  full: "9999px"
---

# Test Theme

prose body.
`;

function seedMeta(dir: string, goal = "ship it") {
  mkdirSync(join(dir, ".cockpit"), { recursive: true });
  writeFileSync(
    join(dir, ".cockpit", "project-meta.md"),
    `---\nproject_goal: ${goal}\ncreated: 2026-05-23T09:00:00Z\nowner: user\n---\n\nThe north star prose.\n`,
  );
}

beforeEach(() => {
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-info-proj-")));
  cockpitHome = realpathSync(mkdtempSync(join(tmpdir(), "cockpit-info-home-")));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(cockpitHome, { recursive: true, force: true });
});

describe("buildProjectInfo", () => {
  test("populates goal, meta prose, instruction files and tokens when all present", () => {
    seedMeta(projectDir, "win");
    writeFileSync(
      join(projectDir, "CLAUDE.md"),
      "# Project rules\n\nbe surgical.",
    );
    writeFileSync(
      join(projectDir, "AGENTS.md"),
      "# Agent rules\n\nread the room.",
    );
    writeFileSync(join(projectDir, "DESIGN.md"), DESIGN_MD);

    const info = buildProjectInfo(projectDir);
    expect(info.projectGoal).toBe("win");
    expect(info.meta).toContain("north star");
    expect(info.meta).not.toMatch(/^---/); // frontmatter stripped
    expect(info.claudeMd).toContain("be surgical");
    expect(info.agentsMd).toContain("read the room");
    expect(info.tokens).not.toBeNull();
    expect(info.tokens.colorBg).toBe("#f4efe6"); // cream → lightest/bg
    expect(info.tokens.colorFg).toBe("#1a1a1a"); // ink (not ink-soft)
    expect(info.tokens.accent).toBe("#b8960c"); // worn-gold
    expect(info.tokens.fontSans).toContain("Noto Sans TC");
    expect(info.tokens.fontMono).toContain("DM Mono");
    expect(info.tokens.radius).toBe("8px"); // rounded.md
    expect(info.tokens.radiusSm).toBe("6px");
  });

  test("tokens is null when no DESIGN.md", () => {
    seedMeta(projectDir);
    const info = buildProjectInfo(projectDir);
    expect(info.tokens).toBeNull();
  });

  test("claudeMd is null when absent", () => {
    seedMeta(projectDir);
    expect(buildProjectInfo(projectDir).claudeMd).toBeNull();
  });

  test("agentsMd is null when absent", () => {
    seedMeta(projectDir);
    expect(buildProjectInfo(projectDir).agentsMd).toBeNull();
  });

  test("missing meta is tolerated (empty goal + prose)", () => {
    const info = buildProjectInfo(projectDir);
    expect(info.projectGoal).toBe("");
    expect(info.meta).toBe("");
    expect(info.claudeMd).toBeNull();
    expect(info.agentsMd).toBeNull();
    expect(info.tokens).toBeNull();
  });
});

describe("CLAUDE.md path confinement", () => {
  test("a CLAUDE.md symlinked outside the project is rejected (null)", () => {
    seedMeta(projectDir);
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "cockpit-outside-")),
    );
    writeFileSync(join(outside, "secret.md"), "SECRET");
    symlinkSync(join(outside, "secret.md"), join(projectDir, "CLAUDE.md"));
    try {
      expect(buildProjectInfo(projectDir).claudeMd).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a CLAUDE.md symlinked to a different in-project path is rejected (null)", () => {
    seedMeta(projectDir);
    mkdirSync(join(projectDir, "docs"), { recursive: true });
    writeFileSync(join(projectDir, "docs", "elsewhere.md"), "NOT THE ROOT");
    // Symlink resolves inside the project but is not <root>/CLAUDE.md → reject.
    symlinkSync(
      join(projectDir, "docs", "elsewhere.md"),
      join(projectDir, "CLAUDE.md"),
    );
    expect(buildProjectInfo(projectDir).claudeMd).toBeNull();
  });

  test("a real CLAUDE.md directly in the project root is returned", () => {
    seedMeta(projectDir);
    writeFileSync(join(projectDir, "CLAUDE.md"), "# root rules");
    expect(buildProjectInfo(projectDir).claudeMd).toContain("root rules");
  });
});

describe("AGENTS.md path confinement", () => {
  test("an AGENTS.md symlinked outside the project is rejected (null)", () => {
    seedMeta(projectDir);
    const outside = realpathSync(
      mkdtempSync(join(tmpdir(), "cockpit-outside-")),
    );
    writeFileSync(join(outside, "secret.md"), "SECRET");
    symlinkSync(join(outside, "secret.md"), join(projectDir, "AGENTS.md"));
    try {
      expect(buildProjectInfo(projectDir).agentsMd).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a real AGENTS.md directly in the project root is returned", () => {
    seedMeta(projectDir);
    writeFileSync(join(projectDir, "AGENTS.md"), "# codex rules");
    expect(buildProjectInfo(projectDir).agentsMd).toContain("codex rules");
  });
});

describe("parseDesignTokens", () => {
  test("returns null for a DESIGN.md with no parseable frontmatter", () => {
    writeFileSync(
      join(projectDir, "DESIGN.md"),
      "# Just prose, no frontmatter\n",
    );
    expect(parseDesignTokens(projectDir)).toBeNull();
  });
});

describe("handleProjectInfo (registry gate)", () => {
  function withHome<T>(fn: () => T): T {
    const prev = process.env.COCKPIT_HOME;
    process.env.COCKPIT_HOME = cockpitHome;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.COCKPIT_HOME;
      else process.env.COCKPIT_HOME = prev;
    }
  }

  function seedRegistry() {
    writeFileSync(
      join(cockpitHome, "registry.json"),
      JSON.stringify({
        sessions: [
          {
            project: projectDir,
            sessionId: "11111111-1111-1111-1111-111111111111",
            logPath: join(projectDir, ".cockpit/logs/x.jsonl"),
            lastHeartbeat: new Date().toISOString(),
          },
        ],
      }),
    );
  }

  test("known project → 200 with info", async () => {
    seedMeta(projectDir, "registered goal");
    seedRegistry();
    const res = withHome(() =>
      handleProjectInfo(
        new Request(
          `http://x/api/project-info?project=${encodeURIComponent(projectDir)}`,
        ),
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectGoal).toBe("registered goal");
  });

  test("unknown project → 400 (not served)", async () => {
    seedRegistry();
    const res = withHome(() =>
      handleProjectInfo(
        new Request(
          `http://x/api/project-info?project=${encodeURIComponent("/etc")}`,
        ),
      ),
    );
    expect(res.status).toBe(400);
  });
});
