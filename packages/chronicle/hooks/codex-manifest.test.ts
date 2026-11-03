import { expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

test("Codex overrides default discovery of Claude Code function hooks", async () => {
  const manifest = await Bun.file(
    join(root, ".codex-plugin/plugin.json"),
  ).json();
  expect(manifest.hooks).toBe("./.codex-plugin/hooks.json");
  const config = await Bun.file(join(root, manifest.hooks)).json();
  expect(Object.keys(config)).toEqual(["hooks"]);
  expect(Object.keys(config.hooks)).toEqual(["PreToolUse"]);
  const group = config.hooks.PreToolUse[0];
  expect(new RegExp(group.matcher).test("Bash")).toBe(true);
  expect(group.hooks[0].command).toBe(
    'bun "${PLUGIN_ROOT}/hooks/check-branch.codex.ts"',
  );
});

test("Claude Code retains its function hook registration", async () => {
  const config = await Bun.file(join(root, "hooks/hooks.json")).json();
  expect(config.modules).toEqual(["./register.ts"]);
});
