/// <reference types="bun" />
// Opens a reply's raw markdown: `bun open-raw.ts <requestId> [editor]` with the text on stdin.
import { quicklook } from "./quicklook";
import { planRaw, shellLine } from "./raw-plan";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runtimeInfo } from "../platform-cli";
import { scratchRoot } from "../platform";

const PLUGIN_ID = "q-lab.runes-raw";
const MANIFEST = `id = "${PLUGIN_ID}"
name = "runes raw reply"
version = "1.0.0"
min_herdr_version = "0.9.3"
platforms = ["linux", "macos"]

[[panes]]
id = "raw"
title = "raw reply"
placement = "popup"
width = "80%"
height = "80%"
command = ["sh", "-c", "eval \\"$RUNES_RAW_CMD\\""]
`;

const [requestId = "reply", editor = "auto"] = process.argv.slice(2);
const info = runtimeInfo();
const plan = planRaw(
  process.env,
  (cmd) => Bun.which(cmd) !== null,
  info.platform,
  editor,
);
const dir = join(scratchRoot(info), "raw");
await mkdir(dir, { recursive: true });
// .txt for the system opener: Windows and Linux often have no .md handler, and a Quick Look plugin renders .md
const out = join(
  dir,
  `${requestId.replace(/[^\w-]/g, "_")}.${plan.via === "system" ? "txt" : "md"}`,
);
await Bun.write(out, await Bun.stdin.text());

const run = (argv: string[]) => {
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return {
    ok: r.exitCode === 0,
    out: r.stdout.toString(),
    err: r.stderr.toString(),
  };
};
const fail = (what: string, err: string) => {
  console.error(`${what}: ${err.trim()}`);
  process.exit(1);
};

if (plan.via === "peek") {
  // closing a peek with its [X] leaves the editor running under the name, so the last raw view is ended first
  run(["hc", "kill", "runes-raw"]);
  const start = () =>
    run([
      "hc",
      "run",
      "--bg",
      "--rm",
      "--no-notify",
      "--name",
      "runes-raw",
      ...plan.editor,
      out,
    ]);
  let started = start();
  for (
    let i = 0;
    !started.ok && started.err.includes("name_taken") && i < 20;
    i++
  ) {
    await Bun.sleep(100);
    started = start();
  }
  if (!started.ok) fail("hc run failed", started.err);
  const { address } = JSON.parse(started.out) as { address: string };
  // herdr-app answers `no running terminal` for a moment after hc starts one, measured once
  let peek = run(["herdr-app", "do", "terminal.peek", "--terminal", address]);
  for (let i = 0; !peek.ok && i < 20; i++) {
    await Bun.sleep(100);
    peek = run(["herdr-app", "do", "terminal.peek", "--terminal", address]);
  }
  if (!peek.ok) fail("herdr-app peek failed", peek.err);
} else if (plan.via === "popup") {
  const herdr = process.env.HERDR_BIN_PATH || "herdr";
  // herdr reads the manifest live, so rewriting it on every press keeps the link current
  const pluginDir = join(
    info.home,
    ".local",
    "share",
    "q-lab",
    "runes",
    "herdr-raw",
  );
  await mkdir(pluginDir, { recursive: true });
  await Bun.write(join(pluginDir, "herdr-plugin.toml"), MANIFEST);
  if (!run([herdr, "plugin", "list"]).out.includes(PLUGIN_ID)) {
    const linked = run([herdr, "plugin", "link", pluginDir]);
    if (!linked.ok) fail("herdr plugin link failed", linked.err);
  }
  const opened = run([
    herdr,
    "plugin",
    "pane",
    "open",
    "--plugin",
    PLUGIN_ID,
    "--entrypoint",
    "raw",
    "--env",
    `RUNES_RAW_CMD=${shellLine([...plan.editor, out])}`,
  ]);
  if (!opened.ok) fail("herdr popup failed", opened.err || opened.out);
} else {
  await quicklook(out, info);
}
