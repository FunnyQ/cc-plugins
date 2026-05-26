#!/usr/bin/env bun
import { spawn } from "node:child_process";

const args = [
  "--dangerously-load-development-channels",
  "server:cockpit-channel",
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
