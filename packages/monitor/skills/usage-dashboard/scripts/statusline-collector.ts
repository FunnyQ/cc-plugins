#!/usr/bin/env bun
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildRateLimitsRecord } from "./rate-limits-cache";
import { RATE_LIMITS_CACHE, TOKEN_ATLAS_CACHE_DIR } from "./paths";

const CACHE_DIR = TOKEN_ATLAS_CACHE_DIR;
const ROLLUP_NUDGE_MARKER = join(CACHE_DIR, ".rollup-nudge");
const ROLLUP_NUDGE_THROTTLE_MS = 5 * 60 * 1000;
const PUSH_NUDGE_MARKER = join(CACHE_DIR, ".push-nudge");
const PUSH_NUDGE_THROTTLE_MS = 2 * 60 * 1000;
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

// Fire a background script, at most once per throttle window. The marker file's
// mtime is the clock. Everything here is best-effort and fully detached:
// statusline rendering must never wait on, or fail because of, a nudge.
function nudge(marker: string, throttleMs: number, script: string): void {
  try {
    const last = (() => {
      try {
        return statSync(marker).mtimeMs;
      } catch {
        return 0;
      }
    })();
    if (Date.now() - last < throttleMs) return;

    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(marker, "");

    const child = spawn(process.execPath, [join(import.meta.dir, script)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Best-effort only — never let a nudge disrupt the statusline.
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

// Secondary rollup trigger: keep the usage rollup fresh even when the dashboard
// is never opened. The primary trigger is the dashboard's own update-then-read
// in api.ts.
nudge(ROLLUP_NUDGE_MARKER, ROLLUP_NUDGE_THROTTLE_MS, "rollup-update.ts");

// Tertiary trigger: push the latest Claude + Codex usage snapshot to a remote
// relay (n8n) so an external dashboard (e.g. TRMNL) can read it. Opt-in.
if (process.env.LLM_QUOTA_INGEST_URL?.trim()) {
  nudge(PUSH_NUDGE_MARKER, PUSH_NUDGE_THROTTLE_MS, "push-usage.ts");
}

process.exit(runStatusline(payload));
