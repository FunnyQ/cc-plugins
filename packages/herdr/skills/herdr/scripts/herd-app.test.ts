import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHerdApp, harnessArgv, type AppRunner } from "./herd-app.ts";
import { ASK_RESULT_END_MARKER } from "./ask-contract.ts";
import { runtimeFor } from "./herd.ts";

const LS = {
  terminals: [
    {
      address: "t46",
      agent: "claude-code",
      cwd: "/p/cc-plugins",
      state: "live",
      status: "working",
      where: "cc-plugins / 󰧑  main",
    },
    {
      address: "t47",
      agent: "sh",
      cwd: "/p/cc-plugins",
      state: "live",
      where: "cc-plugins / 󰧑  main",
    },
    {
      address: "t3m",
      agent: "claude-code",
      cwd: "/p/personal-assistant",
      state: "live",
      status: "idle",
      where: "personal-assistant / 󰧑  main",
    },
  ],
};

type Call = string[];

function fakeRunner(answers: (cmd: Call) => unknown): {
  run: AppRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const run: AppRunner = async (cmd) => {
    calls.push(cmd);
    const out = answers(cmd);
    return { stdout: JSON.stringify(out ?? {}), stderr: "", code: 0 };
  };
  return { run, calls };
}

const noRegistry = join(mkdtempSync(join(tmpdir(), "herd-app-")), "none.json");
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};

describe("harnessArgv", () => {
  test("passes the task as a positional prompt", () => {
    expect(harnessArgv("claude", [], "go")).toEqual(["claude", "go"]);
  });

  test("runs codex with --no-daemon so its commands stay inside hc", () => {
    expect(harnessArgv("codex", [], "go")).toEqual([
      "codex",
      "--no-daemon",
      "go",
    ]);
  });

  test("hands opencode the task through --prompt, not its project positional", () => {
    expect(harnessArgv("opencode", [], "go")).toEqual([
      "opencode",
      "--prompt",
      "go",
    ]);
  });

  test("omits the prompt when there is no task", () => {
    expect(harnessArgv("pi", ["--model", "x"])).toEqual(["pi", "--model", "x"]);
  });
});

describe("directory", () => {
  test("lists only terminals that report an agent status, split by where", async () => {
    const { run } = fakeRunner(() => LS);
    const agents = await createHerdApp(run, { selfPaneId: "t46" }).directory();
    expect(agents.map((a) => a.paneId)).toEqual(["t46", "t3m"]);
    expect(agents[1]).toMatchObject({
      type: "claude-code",
      status: "idle",
      workspaceLabel: "personal-assistant",
      tabLabel: "main",
      cwd: "/p/personal-assistant",
    });
  });
});

describe("tell", () => {
  test("never types into a shell or into itself", async () => {
    const { run, calls } = fakeRunner((cmd) =>
      cmd[1] === "ls" ? LS : cmd[1] === "get" ? { address: cmd[3], status: { state: "idle" } } : { sent: true },
    );
    const herd = createHerdApp(run, { selfPaneId: "t46" });
    await expect(
      herd.tell("cc-plugins", "hello", { registryPath: noRegistry }),
    ).rejects.toThrow();
    expect(calls.some((c) => c[1] === "send")).toBe(false);
  });

  test("sends to a matched live agent through hc send", async () => {
    const { run, calls } = fakeRunner((cmd) =>
      cmd[1] === "ls" ? LS : cmd[1] === "get" ? { address: cmd[3], status: { state: "idle" } } : { sent: true },
    );
    const res = await createHerdApp(run, { selfPaneId: "t46" }).tell(
      "personal-assistant",
      "hello there",
    );
    expect(calls.at(-1)).toEqual([
      "hc",
      "send",
      "--json",
      "--",
      "t3m",
      "hello there",
    ]);
    expect(res).toMatchObject({ target: "t3m", submitted: true });
  });

  test("spawns a known project into a new space with the chosen harness", async () => {
    const registry = join(mkdtempSync(join(tmpdir(), "herd-app-")), "r.json");
    await Bun.write(
      registry,
      JSON.stringify({
        version: 1,
        projects: { "/p/acme": { name: "acme" } },
      }),
    );
    const { run, calls } = fakeRunner((cmd) => {
      if (cmd[1] === "ls") return LS;
      if (cmd[0] === "herdr-app")
        return { space: "sp1", tab: "tb1", terminal: "t9" };
      if (cmd[1] === "get")
        return { address: "t9", cwd: "/p/acme", status: { state: "working" } };
      return {};
    });
    const res = await createHerdApp(run, { selfPaneId: "t46" }).tell(
      "acme",
      "do it",
      { registryPath: registry, spawnAgent: "codex" },
    );
    expect(calls.find((c) => c[0] === "herdr-app")).toEqual([
      "herdr-app",
      "do",
      "space.new",
      JSON.stringify({
        name: "acme",
        folder: "/p/acme",
        argv: ["codex", "--no-daemon", "do it"],
      }),
    ]);
    expect(res).toMatchObject({
      target: "t9",
      submitted: true,
      spawned: { workspaceId: "sp1", paneId: "t9", cwd: "/p/acme" },
    });
  });
});

describe("ask", () => {
  test("closes the space it spawned once the answer lands", async () => {
    const registry = join(mkdtempSync(join(tmpdir(), "herd-app-")), "r.json");
    await Bun.write(
      registry,
      JSON.stringify({ version: 1, projects: { "/p/acme": { name: "acme" } } }),
    );
    const resultDir = mkdtempSync(join(tmpdir(), "herd-app-ask-"));
    const { run, calls } = fakeRunner((cmd) => {
      if (cmd[1] === "ls") return LS;
      if (cmd[0] === "herdr-app" && cmd[2] === "space.new")
        return { space: "sp1", tab: "tb1", terminal: "t9" };
      if (cmd[1] === "send") {
        void Bun.write(
          join(resultDir, "result.md"),
          `42\n${ASK_RESULT_END_MARKER}\n`,
        );
        return { sent: true };
      }
      if (cmd[1] === "get")
        return {
          address: "t9",
          cwd: "/p/acme",
          labels: { "herdr.space": "sp1" },
          status: { state: "idle" },
        };
      return {};
    });
    const res = await createHerdApp(run, {
      selfPaneId: "t46",
      ...clock(),
    }).ask("acme", "meaning?", { registryPath: registry, resultDir });
    expect(res).toMatchObject({ pending: false, answer: "42" });
    expect(calls.at(-1)).toEqual([
      "herdr-app",
      "do",
      "space.close",
      JSON.stringify({ id: "sp1", confirmed: true }),
    ]);
  });
});

describe("runtimeFor", () => {
  test("old herdr wins when its pane env is present", () => {
    expect(runtimeFor({ HERDR_ENV: "1", HC_TERMINAL_ID: "t1" }, "spawn")).toEqual({
      kind: "herdr",
    });
  });

  test("herdr-app admits only the broker verbs", () => {
    expect(runtimeFor({ HC_TERMINAL_ID: "t1" }, "tell")).toEqual({
      kind: "app",
      self: "t1",
    });
    expect(runtimeFor({ HC_TERMINAL_ID: "t1" }, "spawn")).toHaveProperty("error");
  });

  test("refuses outside both", () => {
    expect(runtimeFor({}, "tell")).toHaveProperty("error");
  });
});

describe("send", () => {
  test("refuses a terminal that has never reported a status", async () => {
    const { run, calls } = fakeRunner((cmd) =>
      cmd[1] === "get" ? { address: "t9", status: null } : { sent: true },
    );
    const herd = createHerdApp(run, { selfPaneId: "t46" });
    await expect(herd.send("t9", "hi")).rejects.toThrow(/dialog/);
    expect(calls.some((c) => c[1] === "send")).toBe(false);
  });
});

describe("slash commands and paths", () => {
  test("types a one-line slash command as keys, since hc send wraps text in an <hc> tag", async () => {
    const { run, calls } = fakeRunner((cmd) =>
      cmd[1] === "get" ? { address: "t9", status: { state: "idle" } } : {},
    );
    await createHerdApp(run, { selfPaneId: "t46" }).send("t9", "/rc on");
    expect(calls.at(-1)).toEqual([
      "hc", "keys", "--json", "t9", "/", "r", "c", "space", "o", "n", "enter",
    ]);
  });

  test("tell opens an absolute folder no registry knows", async () => {
    const folder = mkdtempSync(join(tmpdir(), "herd-app-path-"));
    const { run, calls } = fakeRunner((cmd) => {
      if (cmd[1] === "ls") return LS;
      if (cmd[0] === "herdr-app") return { space: "sp1", tab: "tb1", terminal: "t9" };
      return {};
    });
    const res = await createHerdApp(run, { selfPaneId: "t46" }).tell(folder, "go", {
      registryPath: noRegistry,
    });
    expect(res.spawned?.cwd).toBe(folder);
    expect(JSON.parse(calls.find((c) => c[0] === "herdr-app")![3]!).folder).toBe(folder);
  });
});
