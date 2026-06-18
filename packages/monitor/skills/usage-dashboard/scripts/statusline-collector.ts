#!/usr/bin/env bun
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildRateLimitsRecord } from "./rate-limits-cache";

const CACHE_DIR = join(homedir(), ".cache", "token-atlas");
const RATE_LIMITS_CACHE = join(CACHE_DIR, "rate-limits.json");
const ROLLUP_NUDGE_MARKER = join(CACHE_DIR, ".rollup-nudge");
const ROLLUP_NUDGE_THROTTLE_MS = 5 * 60 * 1000;
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

// Secondary rollup trigger: keep the usage rollup fresh even when the dashboard
// is never opened. Throttled via a marker-file mtime and run fully detached so it
// can never slow down or break statusline rendering. The primary trigger is still
// the dashboard's own update-then-read in api.ts.
function nudgeRollup(): void {
  try {
    const last = (() => {
      try {
        return statSync(ROLLUP_NUDGE_MARKER).mtimeMs;
      } catch {
        return 0;
      }
    })();
    if (Date.now() - last < ROLLUP_NUDGE_THROTTLE_MS) return;

    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(ROLLUP_NUDGE_MARKER, "");
    const now = new Date();
    utimesSync(ROLLUP_NUDGE_MARKER, now, now);

    const child = spawn(
      process.execPath,
      [join(import.meta.dir, "rollup-update.ts")],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
  } catch {
    // Best-effort only — never let a rollup nudge disrupt the statusline.
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
nudgeRollup();
process.exit(runStatusline(payload));
