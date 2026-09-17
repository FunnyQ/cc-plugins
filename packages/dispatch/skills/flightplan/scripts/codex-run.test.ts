import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "codex-run.ts");

let dir: string;
let fakeCodex: string;
let argsLog: string;

// A fake `codex` CLI: records its argv + stdin, then writes a canned "last
// message" to the path after `-o`. Lets us assert the wrapper's contract
// (mode flags, stdin piping, -o capture) without the real CLI.
const FAKE = `#!/usr/bin/env bun
import { writeFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const stdin = readFileSync(0, "utf-8");
writeFileSync(process.env.ARGS_LOG, JSON.stringify(argv) + "\\n--STDIN--\\n" + stdin);
const oi = argv.indexOf("-o");
if (oi !== -1) writeFileSync(argv[oi + 1], "CODEX SAYS: did the thing");
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-run-test-"));
  fakeCodex = join(dir, "fake-codex.ts");
  argsLog = join(dir, "args.json");
  await writeFile(fakeCodex, FAKE);
  await chmod(fakeCodex, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// CODEX_BIN must be a single executable; wrap the fake bun script as one.
let codexBin: string;
beforeAll(async () => {
  codexBin = join(dir, "codex");
  await writeFile(codexBin, `#!/bin/sh\nexec bun ${fakeCodex} "$@"\n`);
  await chmod(codexBin, 0o755);
});

describe("codex-run delegate", () => {
  test("uses workspace-write + prints codex output and a diff stat", async () => {
    const promptFile = join(dir, "p.txt");
    await writeFile(promptFile, "implement task UI-03");
    const res = Bun.spawnSync(
      ["bun", SCRIPT, "delegate", "--prompt-file", promptFile],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CODEX_BIN: codexBin, ARGS_LOG: argsLog },
      },
    );
    expect(res.success).toBe(true);
    const out = res.stdout.toString();
    expect(out).toContain("CODEX SAYS: did the thing");
    expect(out).toContain("changed files (git status --short)");

    const logged = JSON.parse(
      (await readFile(argsLog, "utf-8")).split("\n--STDIN--\n")[0],
    );
    expect(logged).toContain("workspace-write");
    expect(logged.slice(0, 2)).toEqual(["exec", "-s"]);
  });

  test("pipes the prompt via stdin when no --prompt-file", async () => {
    const res = Bun.spawnSync(["bun", SCRIPT, "delegate"], {
      stdin: Buffer.from("do it from stdin"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CODEX_BIN: codexBin, ARGS_LOG: argsLog },
    });
    expect(res.success).toBe(true);
    const stdinSeen = (await readFile(argsLog, "utf-8")).split(
      "\n--STDIN--\n",
    )[1];
    expect(stdinSeen).toContain("do it from stdin");
  });
});

describe("codex-run review", () => {
  test("uses read-only and prints findings, no diff stat", async () => {
    const res = Bun.spawnSync(["bun", SCRIPT, "review"], {
      stdin: Buffer.from("review the diff"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CODEX_BIN: codexBin, ARGS_LOG: argsLog },
    });
    expect(res.success).toBe(true);
    const out = res.stdout.toString();
    expect(out).toContain("CODEX SAYS: did the thing");
    expect(out).not.toContain("changed files");

    const logged = JSON.parse(
      (await readFile(argsLog, "utf-8")).split("\n--STDIN--\n")[0],
    );
    expect(logged).toContain("read-only");
    expect(logged).not.toContain("workspace-write");
  });
});

describe("codex-run model selection", () => {
  async function loggedArgs(): Promise<string[]> {
    return JSON.parse(
      (await readFile(argsLog, "utf-8")).split("\n--STDIN--\n")[0]!,
    );
  }

  function spawn(rest: string[], model?: string) {
    return Bun.spawnSync(["bun", SCRIPT, ...rest], {
      stdin: Buffer.from("x"),
      stdout: "pipe",
      stderr: "pipe",
      // CODEX_MODEL is cleared rather than inherited: a developer who exports it
      // would otherwise see the default test pass against their own value.
      env: {
        ...process.env,
        CODEX_BIN: codexBin,
        ARGS_LOG: argsLog,
        CODEX_MODEL: model ?? "",
      },
    });
  }

  // The split is the point: the cheap model writes, the strong one reviews. A single
  // default for both modes would silently undo that on every flight.
  test("defaults per mode — sol writes, astra reviews", async () => {
    for (const [mode, model] of [
      ["delegate", "gpt-5.6-sol"],
      ["review", "gpt-6-astra"],
    ]) {
      expect(spawn([mode!]).success).toBe(true);
      const logged = await loggedArgs();
      expect(logged).toContain("-m");
      expect(logged[logged.indexOf("-m") + 1]).toBe(model);
    }
  });

  test("--model overrides the default", async () => {
    expect(spawn(["review", "--model", "gpt-5.6-sol"]).success).toBe(true);
    const logged = await loggedArgs();
    expect(logged[logged.indexOf("-m") + 1]).toBe("gpt-5.6-sol");
  });

  test("CODEX_MODEL overrides the default, and --model overrides it", async () => {
    expect(spawn(["delegate"], "gpt-6-astra").success).toBe(true);
    const viaEnv = await loggedArgs();
    expect(viaEnv[viaEnv.indexOf("-m") + 1]).toBe("gpt-6-astra");

    expect(
      spawn(["delegate", "--model", "gpt-5.6-terra"], "gpt-6-astra").success,
    ).toBe(true);
    const viaFlag = await loggedArgs();
    expect(viaFlag[viaFlag.indexOf("-m") + 1]).toBe("gpt-5.6-terra");
  });
});

describe("codex-run errors", () => {
  test("missing binary → CODEX UNREACHABLE + non-zero", () => {
    const res = Bun.spawnSync(["bun", SCRIPT, "review"], {
      stdin: Buffer.from("x"),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        CODEX_BIN: "definitely-not-a-real-binary-xyz",
        ARGS_LOG: argsLog,
      },
    });
    expect(res.success).toBe(false);
    expect(res.stderr.toString()).toContain("CODEX UNREACHABLE");
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
      env: { ...process.env, CODEX_BIN: codexBin, ARGS_LOG: argsLog },
    });
    expect(res.exitCode).toBe(2);
  });
});

// The wrappers are autopilot's headless path and nothing else calls them, so the
// contract is unconditional here — relay's --no-ask covers the live path, and
// between them no agent is left to paraphrase the rule away.
describe("codex-run unattended contract", () => {
  test("every prompt reaches the CLI carrying the no-ask contract", async () => {
    for (const mode of ["delegate", "review"]) {
      const res = Bun.spawnSync(["bun", SCRIPT, mode], {
        stdin: Buffer.from("do the thing"),
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CODEX_BIN: codexBin, ARGS_LOG: argsLog },
      });
      expect(res.success).toBe(true);

      const stdin = (await readFile(argsLog, "utf-8")).split("\n--STDIN--\n")[1]!;
      expect(stdin).toContain("Nobody is watching this run");
      expect(stdin).toContain("do the thing");
    }
  });
});
