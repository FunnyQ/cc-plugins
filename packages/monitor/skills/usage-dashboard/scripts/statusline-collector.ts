#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildRateLimitsRecord } from "./rate-limits-cache";

const CACHE_DIR = join(homedir(), ".cache", "token-atlas");
const RATE_LIMITS_CACHE = join(CACHE_DIR, "rate-limits.json");
const STATUSLINE_COMMAND =
  process.env.TOKEN_ATLAS_STATUSLINE_COMMAND?.trim() ||
  "bunx -y ccstatusline@latest";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function cacheRateLimits(payload: string): void {
  const record = buildRateLimitsRecord(payload);
  if (!record) return;

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(RATE_LIMITS_CACHE, JSON.stringify(record, null, 2));
  } catch {
    // Statusline rendering should not fail because telemetry cache failed.
  }
}

function runStatusline(payload: string): number {
  const result = spawnSync(STATUSLINE_COMMAND, {
    input: payload,
    shell: true,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "inherit"],
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }

  if (typeof result.status === "number") {
    return result.status;
  }

  return result.error ? 1 : 0;
}

const payload = await readStdin();
cacheRateLimits(payload);
process.exit(runStatusline(payload));
