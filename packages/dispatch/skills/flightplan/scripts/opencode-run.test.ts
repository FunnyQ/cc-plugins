import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonl, DEFAULT_MODEL, REVIEW_GUARD } from "./opencode-run.ts";

const SCRIPT = join(import.meta.dir, "opencode-run.ts");

let dir: string;
let fakeOpencode: string;
let argsLog: string;

// A fake `opencode` CLI: records its argv, then emits a JSONL event stream on
// stdout (the same shape `opencode run --format json` produces). Lets us assert
// the wrapper's contract (run flags, model, prompt positional, JSONL parsing)
// without the real CLI.
const FAKE = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ARGS_LOG, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: "step_start" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", part: { text: "OPENCODE SAYS: " } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "text", part: { text: "did the thing" } }) + "\\n");
// no terminal step_finish — exercises the #26855-safe parser
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "opencode-run-test-"));
  fakeOpencode = join(dir, "fake-opencode.ts");
  argsLog = join(dir, "args.json");
  await writeFile(fakeOpencode, FAKE);
  await chmod(fakeOpencode, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// OPENCODE_BIN must be a single executable; wrap the fake bun script as one.
let opencodeBin: string;
beforeAll(async () => {
  opencodeBin = join(dir, "opencode");
  await writeFile(opencodeBin, `#!/bin/sh\nexec bun ${fakeOpencode} "$@"\n`);
  await chmod(opencodeBin, 0o755);
});

const loggedArgs = async (): Promise<string[]> =>
  JSON.parse(await readFile(argsLog, "utf-8"));

describe("opencode-run delegate", () => {
  test("uses `run -m <delegate default> --format json` + prints output and a status list", async () => {
    const promptFile = join(dir, "p.txt");
    await writeFile(promptFile, "implement task UI-03");
    const res = Bun.spawnSync(
      ["bun", SCRIPT, "delegate", "--prompt-file", promptFile],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, OPENCODE_BIN: opencodeBin, ARGS_LOG: argsLog },
      },
    );
    expect(res.success).toBe(true);
    const out = res.stdout.toString();
    // JSONL text parts are concatenated by parseJsonl.
    expect(out).toContain("OPENCODE SAYS: did the thing");
    expect(out).toContain("changed files (git status --short)");

    const args = await loggedArgs();
    expect(args.slice(0, 2)).toEqual(["run", "-m"]);
    expect(args).toContain(DEFAULT_MODEL.delegate);
    expect(args).toContain("--format");
    expect(args).toContain("json");
    // delegate sends the raw prompt as the final positional (no read-only guard).
    expect(args[args.length - 1]).toBe("implement task UI-03");
  });

  test("pipes the prompt via stdin when no --prompt-file", async () => {
    const res = Bun.spawnSync(["bun", SCRIPT, "delegate"], {
      stdin: Buffer.from("do it from stdin"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_BIN: opencodeBin, ARGS_LOG: argsLog },
    });
    expect(res.success).toBe(true);
    const args = await loggedArgs();
    expect(args[args.length - 1]).toBe("do it from stdin");
  });
});

describe("opencode-run review", () => {
  test("uses the review default model, prepends the read-only guard, no status list", async () => {
    const res = Bun.spawnSync(["bun", SCRIPT, "review"], {
      stdin: Buffer.from("review the diff"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_BIN: opencodeBin, ARGS_LOG: argsLog },
    });
    expect(res.success).toBe(true);
    const out = res.stdout.toString();
    expect(out).toContain("OPENCODE SAYS: did the thing");
    expect(out).not.toContain("changed files");

    const args = await loggedArgs();
    expect(args).toContain(DEFAULT_MODEL.review);
    const message = args[args.length - 1];
    expect(message.startsWith(REVIEW_GUARD)).toBe(true);
    expect(message).toContain("review the diff");
  });
});

describe("opencode-run model resolution", () => {
  test("--model flag overrides the per-mode default", async () => {
    const res = Bun.spawnSync(
      ["bun", SCRIPT, "delegate", "--model", "acme/custom-1"],
      {
        stdin: Buffer.from("x"),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, OPENCODE_BIN: opencodeBin, ARGS_LOG: argsLog },
      },
    );
    expect(res.success).toBe(true);
    const args = await loggedArgs();
    expect(args).toContain("acme/custom-1");
    expect(args).not.toContain(DEFAULT_MODEL.delegate);
  });

  test("OPENCODE_MODEL env is used when no --model flag", async () => {
    const res = Bun.spawnSync(["bun", SCRIPT, "review"], {
      stdin: Buffer.from("x"),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_BIN: opencodeBin,
        ARGS_LOG: argsLog,
        OPENCODE_MODEL: "env/picked-model",
      },
    });
    expect(res.success).toBe(true);
    const args = await loggedArgs();
    expect(args).toContain("env/picked-model");
  });
});

describe("opencode-run errors", () => {
  test("missing binary → OPENCODE UNREACHABLE + non-zero", () => {
    const res = Bun.spawnSync(["bun", SCRIPT, "review"], {
      stdin: Buffer.from("x"),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        OPENCODE_BIN: "definitely-not-a-real-binary-xyz",
        ARGS_LOG: argsLog,
      },
    });
    expect(res.success).toBe(false);
    expect(res.stderr.toString()).toContain("OPENCODE UNREACHABLE");
  });

  test("unknown subcommand → exit 2", () => {
    const res = Bun.spawnSync(["bun", SCRIPT, "frobnicate"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    expect(res.exitCode).toBe(2);
    expect(res.stderr.toString()).toContain("Usage:");
  });

  test("empty prompt → exit 2", () => {
    const res = Bun.spawnSync(["bun", SCRIPT, "delegate"], {
      stdin: Buffer.from("   \n"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPENCODE_BIN: opencodeBin, ARGS_LOG: argsLog },
    });
    expect(res.exitCode).toBe(2);
  });
});

describe("parseJsonl", () => {
  test("concatenates text parts, ignores non-text and malformed lines", () => {
    const raw = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "text", part: { text: "Hello " } }),
      "{ not valid json",
      JSON.stringify({ type: "tool", part: { text: "ignored" } }),
      JSON.stringify({ type: "text", part: { text: "world" } }),
      JSON.stringify({ type: "step_finish" }),
    ].join("\n");
    expect(parseJsonl(raw)).toBe("Hello world");
  });

  test("empty stream → empty string", () => {
    expect(parseJsonl("")).toBe("");
  });
});
