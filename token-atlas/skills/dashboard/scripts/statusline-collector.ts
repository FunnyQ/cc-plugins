#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const CACHE_DIR = join(homedir(), ".cache", "token-atlas");
const RATE_LIMITS_CACHE = join(CACHE_DIR, "rate-limits.json");
const STATUSLINE_COMMAND =
  process.env.TOKEN_ATLAS_STATUSLINE_COMMAND?.trim() ||
  "bunx -y ccstatusline@latest";

type StatuslinePayload = {
  rate_limits?: unknown;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function cacheRateLimits(payload: string): void {
  let parsed: StatuslinePayload;

  try {
    parsed = JSON.parse(payload) as StatuslinePayload;
  } catch {
    return;
  }

  if (!parsed.rate_limits) {
    return;
  }

  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(
      RATE_LIMITS_CACHE,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          capturedAtEpochMs: Date.now(),
          rate_limits: parsed.rate_limits,
        },
        null,
        2,
      ),
    );
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
