import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RELAY_MODEL = join(import.meta.dir, "relay-model.ts");
const RELAY_SHARED = join(
  import.meta.dir,
  "../../../../../relay/skills/relay/scripts/shared.ts",
);

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "relay-model-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(config: string | null) {
  const script = `
    import { CONFIG_PATH } from ${JSON.stringify(RELAY_SHARED)};
    import { relayModel } from ${JSON.stringify(RELAY_MODEL)};
    import { mkdirSync, writeFileSync } from "node:fs";
    import { dirname } from "node:path";
    const config = ${JSON.stringify(config)};
    if (config !== null) {
      mkdirSync(dirname(CONFIG_PATH), { recursive: true });
      writeFileSync(CONFIG_PATH, config);
    }
    const pick = (b, m) => { const v = relayModel(b, m); return v === undefined ? "undefined" : v; };
    try {
      console.log(JSON.stringify([pick("codex", "delegate"), pick("codex", "review"), pick("opencode", "delegate")]));
    } catch (error) {
      console.log(JSON.stringify({ threw: String(error) }));
    }
  `;
  const proc = Bun.spawnSync(["bun", "-e", script], {
    env: { ...process.env, HOME: home },
  });
  return JSON.parse(proc.stdout.toString());
}

describe("relayModel", () => {
  test("reads the config relay writes at its own CONFIG_PATH", () => {
    const config = JSON.stringify({
      models: { codex: { delegate: "gpt-5", review: "cli-default" } },
    });
    expect(run(config)).toEqual(["gpt-5", null, "undefined"]);
  });

  test("returns undefined when no config exists", () => {
    expect(run(null)).toEqual(["undefined", "undefined", "undefined"]);
  });

  test("throws on a malformed config rather than falling back", () => {
    expect(run("{ not json").threw).toMatch(/relay config/);
  });
});
