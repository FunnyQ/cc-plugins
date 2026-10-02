// Run: bun test packages/monitor/skills/install/scripts/statusline-decision.test.ts
import { describe, expect, test } from "bun:test";
import {
  SHIM_COLLECTOR_RE,
  unwrapCollectorCommand,
} from "./statusline-decision";

const SHIM = "/plugin/skills/cockpit/bin/cockpit";
const COLLECTOR = `${SHIM} atlas statusline`;
const WRAP = "TOKEN_ATLAS_STATUSLINE_COMMAND='npx claude-powerline'";
const DEFAULT_INNER = "bunx -y ccstatusline@latest";
const CLONE = "/x/marketplaces/q-lab-marketplace/packages/monitor";
const CLONE_TS = `bun ${CLONE}/skills/usage-dashboard/scripts/statusline-collector.ts`;

describe("unwrapCollectorCommand", () => {
  test("a bare collector becomes the command it forwarded to by default", () => {
    expect(unwrapCollectorCommand(COLLECTOR)).toBe(DEFAULT_INNER);
    expect(unwrapCollectorCommand(`'${SHIM}' atlas statusline`)).toBe(
      DEFAULT_INNER,
    );
  });

  test("a wrapped collector becomes the wrapped command, byte for byte", () => {
    expect(unwrapCollectorCommand(`${WRAP} ${COLLECTOR}`)).toBe(
      "npx claude-powerline",
    );
    expect(
      unwrapCollectorCommand(
        `TOKEN_ATLAS_STATUSLINE_COMMAND='a "b c" | d' ${COLLECTOR}`,
      ),
    ).toBe('a "b c" | d');
  });

  test("a collector inside a user command's quoted argument keeps the quotes", () => {
    const HUD = "/opt/hud/sketchybar statusline";
    expect(unwrapCollectorCommand(`${HUD} '${COLLECTOR}'`)).toBe(
      `${HUD} '${DEFAULT_INNER}'`,
    );
    expect(unwrapCollectorCommand(`${HUD} "${COLLECTOR}"`)).toBe(
      `${HUD} "${DEFAULT_INNER}"`,
    );
  });

  test("the removed monitor TS collector unwraps the same way", () => {
    expect(unwrapCollectorCommand(CLONE_TS)).toBe(DEFAULT_INNER);
    expect(unwrapCollectorCommand(`${WRAP} ${CLONE_TS}`)).toBe(
      "npx claude-powerline",
    );
  });

  test("leaves a foreign collector, another subcommand, and a plain line alone", () => {
    expect(
      unwrapCollectorCommand("bun /home/me/bin/statusline-collector.ts"),
    ).toBeNull();
    expect(unwrapCollectorCommand(`${SHIM} atlas serve`)).toBeNull();
    expect(unwrapCollectorCommand("starship prompt")).toBeNull();
    expect(unwrapCollectorCommand("")).toBeNull();
  });
});

describe("SHIM_COLLECTOR_RE", () => {
  test("captures the shim path and ignores other cockpit subcommands", () => {
    expect(COLLECTOR.match(SHIM_COLLECTOR_RE)?.[1]).toBe(SHIM);
    expect(`${SHIM} atlas serve`.match(SHIM_COLLECTOR_RE)).toBeNull();
    expect(`${SHIM} atlas statuslines`.match(SHIM_COLLECTOR_RE)).toBeNull();
  });
});
