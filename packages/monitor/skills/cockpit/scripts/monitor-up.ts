#!/usr/bin/env bun
import { spawn } from "node:child_process";

// The cockpit channel is packaged in the plugin manifest (mcpServers + channels),
// so it's referenced by plugin coordinates, not the raw `server:<name>` form.
const CHANNEL = "plugin:monitor@q-lab-marketplace";

// Channels are still a research preview, so activating one needs the dev flag.
// GA-day change: swap `--dangerously-load-development-channels` for `--channels`
// (the CHANNEL argument stays the same).
const args = [
  "--dangerously-load-development-channels",
  CHANNEL,
  ...process.argv.slice(2),
];

const child = spawn("claude", args, {
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  console.error(`monitor-up: ${err.message}`);
  process.exit(1);
});
