// Run: bun test packages/monitor/skills/install/scripts/statusline-decision.test.ts
import { describe, expect, test } from "bun:test";
import {
  decideStatusLine,
  migrateCollectorCommand,
  SHIM_COLLECTOR_RE,
} from "./statusline-decision";

const SHIM = "/plugin/skills/cockpit/bin/cockpit";
const COLLECTOR = `${SHIM} atlas statusline`;
const WRAP = "TOKEN_ATLAS_STATUSLINE_COMMAND='npx claude-powerline'";
const OLD_TS =
  "bun /old/monitor/3.1.0/skills/usage-dashboard/scripts/statusline-collector.ts";

describe("decideStatusLine", () => {
  test("skips only when already pointing at the exact live shim", () => {
    const d = decideStatusLine({ command: COLLECTOR }, COLLECTOR);
    expect(d).toEqual({ action: "skip" });
  });

  test("skips the live shim behind a wrapped user command", () => {
    const d = decideStatusLine({ command: `${WRAP} ${COLLECTOR}` }, COLLECTOR);
    expect(d).toEqual({ action: "skip" });
  });

  test("re-points a new-form shim at another path, keeping the wrapped prefix", () => {
    const d = decideStatusLine(
      {
        command: `${WRAP} /old/clone/skills/cockpit/bin/cockpit atlas statusline`,
        padding: 1,
      },
      COLLECTOR,
    );
    expect(d).toEqual({
      action: "write",
      command: `${WRAP} ${COLLECTOR}`,
      padding: 1,
      preserved: null,
    });
  });

  test("replaces an old-form TS collector at any path with the shim", () => {
    const d = decideStatusLine(
      { command: "bun /anywhere/statusline-collector.ts" },
      COLLECTOR,
    );
    expect(d).toEqual({
      action: "write",
      command: COLLECTOR,
      padding: 0,
      preserved: null,
    });
  });

  test("keeps the wrapped prefix byte-for-byte when replacing the old form", () => {
    const d = decideStatusLine({ command: `${WRAP} ${OLD_TS}` }, COLLECTOR);
    expect(d).toEqual({
      action: "write",
      command: `${WRAP} ${COLLECTOR}`,
      padding: 0,
      preserved: null,
    });
  });

  test("never wraps a quoted shim around the collector itself", () => {
    expect(
      decideStatusLine({ command: `'${SHIM}' atlas statusline` }, COLLECTOR),
    ).toEqual({ action: "skip" });
    expect(
      decideStatusLine(
        { command: `"/old/skills/cockpit/bin/cockpit" atlas statusline` },
        COLLECTOR,
      ),
    ).toEqual({
      action: "write",
      command: COLLECTOR,
      padding: 0,
      preserved: null,
    });
  });

  test("re-points a shim inside a user command's quoted argument, keeping the quotes", () => {
    const d = decideStatusLine(
      {
        command:
          "/opt/hud/sketchybar statusline '/old/skills/cockpit/bin/cockpit atlas statusline'",
      },
      COLLECTOR,
    );
    expect(d).toEqual({
      action: "write",
      command: `/opt/hud/sketchybar statusline '${COLLECTOR}'`,
      padding: 0,
      preserved: null,
    });
  });

  test("wires fresh when there is no existing statusLine", () => {
    const d = decideStatusLine({}, COLLECTOR);
    expect(d).toEqual({
      action: "write",
      command: COLLECTOR,
      padding: 0,
      preserved: null,
    });
  });

  test("preserves a non-collector command by wrapping it via the env var", () => {
    const d = decideStatusLine(
      { command: "starship prompt", padding: 2 },
      COLLECTOR,
    );
    expect(d).toEqual({
      action: "write",
      command: `TOKEN_ATLAS_STATUSLINE_COMMAND='starship prompt' ${COLLECTOR}`,
      padding: 2,
      preserved: "starship prompt",
    });
  });

  test("defaults padding to 0 when not a number", () => {
    const d = decideStatusLine({ command: "x", padding: "nope" }, COLLECTOR);
    expect(d.action).toBe("write");
    if (d.action === "write") expect(d.padding).toBe(0);
  });
});

describe("migrateCollectorCommand", () => {
  const CLONE = "/x/marketplaces/q-lab-marketplace/packages/monitor";
  const CLONE_SHIM = `${CLONE}/skills/cockpit/bin/cockpit atlas statusline`;
  const CLONE_TS = `bun ${CLONE}/skills/usage-dashboard/scripts/statusline-collector.ts`;

  test("rewrites the bare old form to the shim", () => {
    expect(migrateCollectorCommand(CLONE_TS, CLONE_SHIM)).toBe(
      "/x/marketplaces/q-lab-marketplace/packages/monitor/skills/cockpit/bin/cockpit atlas statusline",
    );
  });

  test("rewrites a wrapped old form, keeping the prefix byte-for-byte", () => {
    expect(migrateCollectorCommand(`${WRAP} ${CLONE_TS}`, CLONE_SHIM)).toBe(
      "TOKEN_ATLAS_STATUSLINE_COMMAND='npx claude-powerline' /x/marketplaces/q-lab-marketplace/packages/monitor/skills/cockpit/bin/cockpit atlas statusline",
    );
  });

  test("leaves the new form alone, wherever its shim lives", () => {
    expect(migrateCollectorCommand(CLONE_SHIM, CLONE_SHIM)).toBeNull();
    expect(
      migrateCollectorCommand(
        "/elsewhere/skills/cockpit/bin/cockpit atlas statusline",
        CLONE_SHIM,
      ),
    ).toBeNull();
  });

  test("replaces an absolute bun path whole, not just its `bun` tail", () => {
    expect(
      migrateCollectorCommand(
        `/home/q/.bun/bin/bun ${CLONE}/skills/usage-dashboard/scripts/statusline-collector.ts`,
        CLONE_SHIM,
      ),
    ).toBe(CLONE_SHIM);
  });

  test("replaces a quoted script and a quoted bun without leaving a quote", () => {
    expect(
      migrateCollectorCommand(
        `${WRAP} bun "${CLONE}/skills/usage-dashboard/scripts/statusline-collector.ts"`,
        CLONE_SHIM,
      ),
    ).toBe(`${WRAP} ${CLONE_SHIM}`);
    expect(
      migrateCollectorCommand(
        `"/opt/bun" '${CLONE}/skills/usage-dashboard/scripts/statusline-collector.ts'`,
        CLONE_SHIM,
      ),
    ).toBe(CLONE_SHIM);
  });

  test("keeps the quotes of a user command that takes the collector as one argument", () => {
    const HUD = "/opt/hud/sketchybar statusline";
    expect(
      migrateCollectorCommand(
        `${HUD} 'bun ${CLONE}/skills/usage-dashboard/scripts/statusline-collector.ts'`,
        CLONE_SHIM,
      ),
    ).toBe(`${HUD} '${CLONE_SHIM}'`);
    expect(
      migrateCollectorCommand(
        `${HUD} "/opt/bun ${CLONE}/skills/usage-dashboard/scripts/statusline-collector.ts"`,
        CLONE_SHIM,
      ),
    ).toBe(`${HUD} "${CLONE_SHIM}"`);
  });

  test("drops quotes that only wrapped the script path", () => {
    expect(
      migrateCollectorCommand(
        `"${CLONE}/skills/usage-dashboard/scripts/statusline-collector.ts"`,
        CLONE_SHIM,
      ),
    ).toBe(CLONE_SHIM);
  });

  test("leaves a foreign statusline-collector.ts alone", () => {
    expect(
      migrateCollectorCommand(
        "bun /home/me/bin/statusline-collector.ts",
        CLONE_SHIM,
      ),
    ).toBeNull();
  });

  test("leaves a non-collector command and an empty one alone", () => {
    expect(migrateCollectorCommand("starship prompt", CLONE_SHIM)).toBeNull();
    expect(migrateCollectorCommand("", CLONE_SHIM)).toBeNull();
  });
});

describe("SHIM_COLLECTOR_RE", () => {
  test("captures the shim path and ignores other cockpit subcommands", () => {
    expect(COLLECTOR.match(SHIM_COLLECTOR_RE)?.[1]).toBe(SHIM);
    expect(`${SHIM} atlas serve`.match(SHIM_COLLECTOR_RE)).toBeNull();
    expect(`${SHIM} atlas statuslines`.match(SHIM_COLLECTOR_RE)).toBeNull();
  });
});
