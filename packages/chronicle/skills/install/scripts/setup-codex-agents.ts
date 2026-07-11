#!/usr/bin/env bun

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROLES = ["lawspeaker", "watcher", "runesmith"] as const;
const BEGIN = "# BEGIN chronicle codex agents";
const END = "# END chronicle codex agents";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function withoutManagedBlock(config: string): string {
  const start = config.indexOf(BEGIN);
  const finish = config.indexOf(END);
  if (start < 0 || finish < start) return config.trimEnd();
  return `${config.slice(0, start)}${config.slice(finish + END.length)}`.trimEnd();
}

function managedBlock(targetDir: string): string {
  const descriptions = {
    lawspeaker: "Orchestrate Chronicle commit analysis and execution.",
    watcher: "Analyze the current changeset without committing.",
    runesmith: "Stage explicit files and write Chronicle commits.",
  };
  return [
    BEGIN,
    ...ROLES.flatMap((role) => [
      `[agents.chronicle_${role}]`,
      `description = ${JSON.stringify(descriptions[role])}`,
      `config_file = ${JSON.stringify(join(targetDir, `${role}.toml`))}`,
      `nickname_candidates = [${JSON.stringify(`Chronicle ${role}`)}]`,
      "",
    ]),
    END,
  ].join("\n");
}

function main() {
  const pluginRootArg = argValue("--plugin-root");
  if (!pluginRootArg) {
    console.error("setup-codex-agents: --plugin-root is required");
    process.exit(1);
  }

  const pluginRoot = resolve(pluginRootArg);
  const sourceDir = join(pluginRoot, "agents-codex");
  const codexHome =
    process.env.CODEX_HOME || join(process.env.HOME || "", ".codex");
  const targetDir = join(codexHome, "agents", "chronicle");
  const configPath = join(codexHome, "config.toml");
  const dryRun = process.argv.includes("--dry-run");
  const apply = process.argv.includes("--apply");

  for (const role of ROLES) {
    const source = join(sourceDir, `${role}.toml`);
    if (!existsSync(source)) {
      console.error(`setup-codex-agents: missing ${source}`);
      process.exit(1);
    }
  }

  const current = existsSync(configPath)
    ? readFileSync(configPath, "utf8")
    : "";
  const base = withoutManagedBlock(current);
  const next = `${base}${base ? "\n\n" : ""}${managedBlock(targetDir)}\n`;

  if (dryRun || !apply) {
    process.stdout.write(next);
    return;
  }

  mkdirSync(targetDir, { recursive: true });
  for (const role of ROLES) {
    copyFileSync(
      join(sourceDir, `${role}.toml`),
      join(targetDir, `${role}.toml`),
    );
  }
  mkdirSync(dirname(configPath), { recursive: true });
  if (current !== next && existsSync(configPath)) {
    copyFileSync(configPath, `${configPath}.bak-chronicle`);
  }
  writeFileSync(configPath, next);
  console.log(`Installed Chronicle Codex agents in ${targetDir}`);
  console.log("Start a new Codex thread to load the named roles.");
}

main();
