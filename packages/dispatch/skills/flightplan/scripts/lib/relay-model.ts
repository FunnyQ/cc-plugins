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
    throw new Error(
      `Could not read relay config (${path}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const model = config?.models?.[backend]?.[mode];
  if (typeof model !== "string") return undefined;
  return model === CLI_DEFAULT ? null : model;
}
