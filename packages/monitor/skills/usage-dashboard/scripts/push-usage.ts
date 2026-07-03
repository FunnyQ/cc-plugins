#!/usr/bin/env bun
// Background worker: push the latest Claude + Codex usage snapshot to a remote
// relay (n8n) that an external dashboard (e.g. TRMNL) polls. Spawned detached +
// throttled by statusline-collector.ts so the statusline never waits on the
// Codex usage API call or the network push. Opt-in: does nothing unless
// LLM_QUOTA_INGEST_URL is set.
import { readCodexUsageLimits, readUsageLimits } from "./api";

const INGEST_URL = process.env.LLM_QUOTA_INGEST_URL?.trim();
const INGEST_SECRET = process.env.LLM_QUOTA_INGEST_SECRET?.trim() ?? "";
const PUSH_TIMEOUT_MS = 8000;

async function main(): Promise<void> {
  if (!INGEST_URL) return;

  // readUsageLimits() reads the statusline rate-limits cache (Claude, free).
  // readCodexUsageLimits() reuses api.ts's own 5-min cache and only hits the
  // Codex usage API when that cache is stale.
  const claude = readUsageLimits();
  const codex = await readCodexUsageLimits();

  const payload = {
    capturedAt: Date.now(),
    claude,
    codex,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PUSH_TIMEOUT_MS);
  try {
    await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Auth-Token": INGEST_SECRET,
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
    // Best-effort telemetry push — never surface errors.
  } finally {
    clearTimeout(timer);
  }
}

await main();
