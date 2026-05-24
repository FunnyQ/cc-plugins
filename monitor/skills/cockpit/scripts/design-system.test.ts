// Tests for cockpit design-system: DESIGN.md frontmatter parsing and API shape.
// Run: bun test monitor/skills/cockpit/scripts/design-system.test.ts
import { describe, expect, test } from "bun:test";
import { handleDesignSystem, parseCockpitDesignSystem } from "./design-system";

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

describe("handleDesignSystem", () => {
  test("serves cockpit's checked-in DESIGN.md", async () => {
    const res = handleDesignSystem();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Night Flight");
    expect(body.colors.length).toBeGreaterThan(5);
    expect(body.components.length).toBeGreaterThan(5);
  });
});
