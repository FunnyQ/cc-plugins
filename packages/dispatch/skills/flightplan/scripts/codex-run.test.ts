import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateHome, writeFakeBin } from "./lib/fake-bin.ts";

const SCRIPT = join(import.meta.dir, "codex-run.ts");

let dir: string;
let restoreHome: () => void;
let argsLog: string;

const FAKE = `#!/usr/bin/env bun
import { writeFileSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const stdin = readFileSync(0, "utf-8");
writeFileSync(process.env.ARGS_LOG, JSON.stringify(argv) + "\\n--STDIN--\\n" + stdin);
const oi = argv.indexOf("-o");
if (oi !== -1) writeFileSync(argv[oi + 1], "CODEX SAYS: did the thing");
`;

let codexBin: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "codex-run-test-"));
  restoreHome = isolateHome(dir);
  argsLog = join(dir, "args.json");
  codexBin = await writeFakeBin(dir, "codex", FAKE);
});

afterAll(async () => {
  restoreHome();
  await rm(dir, { recursive: true, force: true });
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
      env: envIgnoringDeveloperCodexModel(model),
    });
  }

  function envIgnoringDeveloperCodexModel(model?: string) {
    return {
      ...process.env,
      CODEX_BIN: codexBin,
      ARGS_LOG: argsLog,
      CODEX_MODEL: model ?? "",
    };
  }

  test("defaults per mode — the cheap model writes, the strong one reviews", async () => {
    for (const [mode, model] of [
      ["delegate", "gpt-6.1-sol"],
      ["review", "gpt-6-astra"],
    ]) {
      expect(spawn([mode!]).success).toBe(true);
      const logged = await loggedArgs();
      expect(logged).toContain("-m");
      expect(logged[logged.indexOf("-m") + 1]).toBe(model);
    }
  });

  test("--model overrides the default", async () => {
    expect(spawn(["review", "--model", "gpt-6.1-sol"]).success).toBe(true);
    const logged = await loggedArgs();
    expect(logged[logged.indexOf("-m") + 1]).toBe("gpt-6.1-sol");
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

  describe("with a relay config", () => {
    const configDir = () =>
      join(dir, ".config", "q-lab", "cc-plugins", "relay");
    const writeRelayConfig = async (models: unknown) => {
      await mkdir(configDir(), { recursive: true });
      await writeFile(
        join(configDir(), "config.json"),
        JSON.stringify({ models }),
      );
    };
    afterEach(async () => {
      await rm(configDir(), { recursive: true, force: true });
    });

    test("takes the relay config model over the default", async () => {
      await writeRelayConfig({
        codex: { delegate: "gpt-6.1-sol", review: "gpt-6.1-terra" },
      });
      for (const [mode, model] of [
        ["delegate", "gpt-6.1-sol"],
        ["review", "gpt-6.1-terra"],
      ]) {
        expect(spawn([mode!]).success).toBe(true);
        const logged = await loggedArgs();
        expect(logged[logged.indexOf("-m") + 1]).toBe(model);
      }
    });

    test("--model and CODEX_MODEL both beat the relay config", async () => {
      await writeRelayConfig({ codex: { delegate: "gpt-6.1-sol" } });
      expect(spawn(["delegate", "--model", "gpt-6-astra"]).success).toBe(true);
      const viaFlag = await loggedArgs();
      expect(viaFlag[viaFlag.indexOf("-m") + 1]).toBe("gpt-6-astra");

      expect(spawn(["delegate"], "gpt-5.6-terra").success).toBe(true);
      const viaEnv = await loggedArgs();
      expect(viaEnv[viaEnv.indexOf("-m") + 1]).toBe("gpt-5.6-terra");
    });

    test("cli-default omits -m so codex picks its own model", async () => {
      await writeRelayConfig({ codex: { review: "cli-default" } });
      expect(spawn(["review"]).success).toBe(true);
      expect(await loggedArgs()).not.toContain("-m");
    });

    test("an unparseable relay config fails instead of falling back", async () => {
      await mkdir(configDir(), { recursive: true });
      await writeFile(join(configDir(), "config.json"), "{ not json");
      const res = spawn(["delegate"]);
      expect(res.success).toBe(false);
      expect(res.stderr.toString()).toContain("Could not read relay config");
    });
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

  test("a failing run still removes its scratch dir, so run never calls process.exit", async () => {
    const tmp = await mkdtemp(join(dir, "tmp-"));
    const res = Bun.spawnSync(["bun", SCRIPT, "delegate"], {
      stdin: Buffer.from("   \n"),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
        CODEX_BIN: codexBin,
        ARGS_LOG: argsLog,
      },
    });
    expect(res.exitCode).toBe(2);
    expect(await readdir(tmp)).toEqual([]);
  });

  test("a whitespace-only prompt exits 2 and spawns nothing, since the no-ask contract is added only after the empty check", async () => {
    await rm(argsLog, { force: true });
    const res = Bun.spawnSync(["bun", SCRIPT, "delegate"], {
      stdin: Buffer.from("   \n"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CODEX_BIN: codexBin, ARGS_LOG: argsLog },
    });
    expect(res.exitCode).toBe(2);
    expect(await Bun.file(argsLog).exists()).toBe(false);
  });
});

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

      const stdin = (await readFile(argsLog, "utf-8")).split(
        "\n--STDIN--\n",
      )[1]!;
      expect(stdin).toContain("Nobody is watching this run");
      expect(stdin).toContain("do the thing");
    }
  });
});
