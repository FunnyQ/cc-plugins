import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForApply } from "./server";
import { parseSpec } from "./spec";

export function tempRoot(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return join(tmpdir(), "q-lab", "atelier", "tune");
  return "/tmp/q-lab/atelier/tune";
}

type Args = {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
};

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: undefined, positional: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args.flags[token.slice(2)] = next;
        i++;
      } else args.flags[token.slice(2)] = true;
    } else if (args.command === undefined) args.command = token;
    else args.positional.push(token);
  }
  return args;
}

const USAGE = `usage:
  tune.ts open <spec.json> [--no-open]   start a session; prints url and dir
  tune.ts inject [--dir D]               print the loader line for a browser eval
  tune.ts wait [--dir D] [--timeout S]   block until Apply (default 540s); exit 3 on timeout
  tune.ts url [--dir D]                  print the page url
  tune.ts stop [--dir D]                 stop the session's server`;

type Session = { pid: number; port: number; nonce: string; spec: string };

function die(message: string, code: number): never {
  console.error(message);
  process.exit(code);
}

function sessionDir(flags: Args["flags"]): string {
  if (typeof flags.dir === "string") return flags.dir;
  const pointer = join(tempRoot(), "current");
  if (!existsSync(pointer))
    die("no session is open: run `tune.ts open <spec.json>` first", 1);
  return readFileSync(pointer, "utf8").trim();
}

function readSession(dir: string): Session {
  const file = join(dir, "server.json");
  if (!existsSync(file)) die(`no server record in ${dir}`, 1);
  return JSON.parse(readFileSync(file, "utf8"));
}

const pageUrl = (s: Session) => `http://127.0.0.1:${s.port}/${s.nonce}/`;

function openInBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
}

async function open(args: Args) {
  const specArg = args.positional[0];
  if (!specArg) die(USAGE, 1);
  const specPath = resolve(specArg);
  let spec;
  try {
    spec = parseSpec(JSON.parse(readFileSync(specPath, "utf8")), specPath);
  } catch (error) {
    die(`spec error: ${(error as Error).message}`, 2);
  }
  if (spec.snippet && !existsSync(spec.snippet))
    die(`spec error: snippet not found: ${spec.snippet}`, 2);

  mkdirSync(tempRoot(), { recursive: true });
  const dir = mkdtempSync(join(tempRoot(), "session-"));
  const log = openSync(join(dir, "server.log"), "a");
  const child = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "server.ts"),
      "--dir",
      dir,
      "--spec",
      specPath,
    ],
    {
      stdout: log,
      stderr: log,
      stdin: "ignore",
    },
  );
  child.unref();
  closeSync(log);

  const deadline = Date.now() + 5000;
  while (!existsSync(join(dir, "server.json"))) {
    if (child.exitCode !== null || Date.now() > deadline)
      die(`server did not start; see ${join(dir, "server.log")}`, 1);
    await Bun.sleep(50);
  }
  writeFileSync(join(tempRoot(), "current"), dir);
  const url = pageUrl(readSession(dir));
  console.log(`url: ${url}\ndir: ${dir}\nmode: ${spec.mode}`);
  if (spec.mode === "in-situ") console.log(`inject: import("${url}inject.js")`);
  else if (!args.flags["no-open"]) openInBrowser(url);
}

async function main(argv: string[]) {
  const args = parseArgs(argv);
  switch (args.command) {
    case "open":
      return open(args);
    case "inject":
      return console.log(
        `import("${pageUrl(readSession(sessionDir(args.flags)))}inject.js")`,
      );
    case "url":
      return console.log(pageUrl(readSession(sessionDir(args.flags))));
    case "wait": {
      const dir = sessionDir(args.flags);
      readSession(dir);
      const seconds = Number(args.flags.timeout ?? 540);
      const values = await waitForApply(dir, seconds * 1000);
      if (values === null)
        die(`no Apply within ${seconds}s; run wait again`, 3);
      return console.log(JSON.stringify(values));
    }
    case "stop": {
      const dir = sessionDir(args.flags);
      const { pid } = readSession(dir);
      try {
        process.kill(pid);
      } catch {}
      return console.log(`stopped ${dir}`);
    }
    default:
      die(USAGE, 1);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
