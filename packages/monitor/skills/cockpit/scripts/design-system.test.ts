// Tests for cockpit design-system: DESIGN.md frontmatter parsing and API shape.
// Run: bun test packages/monitor/skills/cockpit/scripts/design-system.test.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  handleDesignSystem,
  parseCockpitDesignSystem,
  readProjectDesignSystem,
} from "./design-system";

// The cockpit skill root ships its own DESIGN.md — use it as the project fixture.
const COCKPIT_DIR = join(import.meta.dir, "..");

const DESIGN_MD = `---
name: Night Flight
description: fixture
colors:
  void: "oklch(14% 0.028 278)"
  aurora: "oklch(80% 0.13 195)"
typography:
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
rounded:
  sm: "6px"
spacing:
  md: "12px"
components:
  panel:
    backgroundColor: "{colors.hull}"
    textColor: "{colors.starlight}"
    note: "lit screen"
---

# Design System

## 2. Colors

**The Cold/Warm Rule.** Cool means autopilot. Warm means your turn.
`;

describe("parseCockpitDesignSystem", () => {
  test("returns visual tokens, components, and named rules", () => {
    const parsed = parseCockpitDesignSystem(DESIGN_MD);
    expect(parsed.name).toBe("Night Flight");
    expect(parsed.colors).toContainEqual({
      key: "aurora",
      name: "Aurora",
      value: "oklch(80% 0.13 195)",
    });
    expect(parsed.typography[0].fontWeight).toBe("400");
    expect(parsed.rounded[0].value).toBe("6px");
    expect(parsed.spacing[0].name).toBe("Md");
    expect(parsed.components[0].note).toBe("lit screen");
    expect(parsed.rules[0].name).toBe("The Cold/Warm Rule");
  });

  test("throws when frontmatter is missing", () => {
    expect(() => parseCockpitDesignSystem("# Design only")).toThrow(
      "frontmatter",
    );
  });
});

describe("readProjectDesignSystem", () => {
  test("reads a project's own DESIGN.md", () => {
    const parsed = readProjectDesignSystem(COCKPIT_DIR);
    expect(parsed.name).toBe("Night Flight");
    expect(parsed.colors.length).toBeGreaterThan(5);
    expect(parsed.components.length).toBeGreaterThan(5);
  });

  test("throws when the project has no design doc", () => {
    expect(() => readProjectDesignSystem(import.meta.dir)).toThrow("not found");
  });
});

describe("handleDesignSystem", () => {
  test("404s when no project is given", () => {
    expect(handleDesignSystem().status).toBe(404);
    expect(handleDesignSystem(null).status).toBe(404);
  });

  test("404s for a project outside the registry", () => {
    // A path the daemon never registered must never be read from the API.
    expect(handleDesignSystem("/nonexistent-unregistered-xyz").status).toBe(
      404,
    );
  });
});
