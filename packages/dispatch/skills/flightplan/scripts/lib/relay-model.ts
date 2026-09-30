/**
 * The model relay's config names for one backend and mode, read without relay.
 *
 * dispatch and relay version independently, so they share relay's config path
 * and shape, never code — a change to either side of this contract is a change
 * to both (relay's `shared.ts` owns `CONFIG_PATH` and `resolveModel`):
 *
 *   ~/.config/q-lab/cc-plugins/relay/config.json
 *   { models: { <backend>: { <mode>: "<model>" | "cli-default" } } }
 *
 * `cli-default` is relay's stored choice to omit the model flag and let the CLI
 * pick; it comes back here as `null`. An unset entry comes back `undefined`.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLI_DEFAULT = "cli-default";

export function relayModel(
  backend: "codex" | "opencode",
  mode: "delegate" | "review",
): string | null | undefined {
  const path = join(
    homedir(),
    ".config",
    "q-lab",
    "cc-plugins",
    "relay",
    "config.json",
  );
  if (!existsSync(path)) return undefined;
  let config: any;
  try {
    config = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    // Relay refuses a broken config too; falling back would fly on a model nobody picked.
    throw new Error(
      `Could not read relay config (${path}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const model = config?.models?.[backend]?.[mode];
  if (typeof model !== "string") return undefined;
  return model === CLI_DEFAULT ? null : model;
}
