import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

// Codex reads hooks/hooks.json when `hooks` is absent, and guard's is the Claude Code mod's registration
test("the Codex manifest points at the Codex hooks file", async () => {
  const manifest = await Bun.file(
    join(root, ".codex-plugin/plugin.json"),
  ).json();
  expect(manifest.hooks).toBe("./.codex-plugin/hooks.json");
  expect(existsSync(join(root, manifest.hooks))).toBe(true);
});

// Codex edits arrive as tool_name "apply_patch", which comment-guard skips, so the Stop sweep covers them
test("the Codex hooks run the sweep and not comment-guard", async () => {
  const { hooks } = await Bun.file(
    join(root, ".codex-plugin/hooks.json"),
  ).json();
  expect(Object.keys(hooks).sort()).toEqual(["Stop", "UserPromptSubmit"]);
});
