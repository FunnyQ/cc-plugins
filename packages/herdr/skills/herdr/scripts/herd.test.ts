import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_RESULT_END_MARKER } from "./ask-contract.ts";
import {
  addressOf,
  type AgentLocation,
  createHerd,
  HerdrError,
  matchAgents,
  parseArgs,
  type RunResult,
  type Runner,
} from "./herd.ts";

/** A mock runner that records argv and replies from a scripted table. */
function mockRunner(
  handler: (args: string[]) => Partial<RunResult> | undefined,
): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = async (args) => {
    calls.push(args);
    const r = handler(args) ?? {};
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      code: r.code ?? 0,
    };
  };
  return { run, calls };
}

const agentEnvelope = (agent: Record<string, unknown>) =>
  JSON.stringify({ id: "cli:agent:x", result: { agent } });

const listEnvelope = (agents: Record<string, unknown>[]) =>
  JSON.stringify({ id: "cli:agent:list", result: { agents } });

describe("list", () => {
  test("normalizes agent records", async () => {
    const { run } = mockRunner((a) =>
      a[1] === "list"
        ? {
            stdout: listEnvelope([
              {
                agent: "codex",
                agent_status: "idle",
                pane_id: "w3:p5",
                tab_id: "w3:t2",
                workspace_id: "w3",
                terminal_id: "term_1",
                cwd: "/x",
                interactive_ready: true,
                focused: false,
              },
            ]),
          }
        : undefined,
    );
    const herd = createHerd(run);
    const agents = await herd.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]).toEqual({
      name: null,
      type: "codex",
      status: "idle",
      paneId: "w3:p5",
      tabId: "w3:t2",
      workspaceId: "w3",
      terminalId: "term_1",
      cwd: "/x",
      interactiveReady: true,
      focused: false,
    });
  });
});

describe("send", () => {
  test("submits text through one agent prompt command", async () => {
    const { run, calls } = mockRunner((a) =>
      a[0] === "agent" && a[1] === "prompt"
        ? { stdout: JSON.stringify({ result: { type: "ok" } }) }
        : undefined,
    );
    const herd = createHerd(run);
    const res = await herd.send("rev-1", "do the thing");

    expect(res).toEqual({
      target: "rev-1",
      paneId: null,
      submitted: true,
      waited: false,
      status: undefined,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["agent", "prompt", "rev-1", "do the thing"]);
  });

  test("--wait settles in the same call and reports the status", async () => {
    const { run, calls } = mockRunner((a) =>
      a[0] === "agent" && a[1] === "prompt"
        ? {
            stdout: agentEnvelope({
              name: "rev-1",
              pane_id: "w9:pB",
              agent_status: "done",
            }),
          }
        : undefined,
    );
    const herd = createHerd(run);
    const res = await herd.send("rev-1", "go", {
      status: ["idle", "done"],
      timeoutMs: 120000,
    });

    expect(res).toEqual({
      target: "rev-1",
      paneId: "w9:pB",
      submitted: true,
      waited: true,
      status: "done",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "agent",
      "prompt",
      "rev-1",
      "go",
      "--wait",
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout",
      "120000",
    ]);
  });

  test("a bare timeout implies --wait, since herdr rejects --until without it", async () => {
    const { run, calls } = mockRunner(() => ({
      stdout: agentEnvelope({ pane_id: "w1:p1", agent_status: "idle" }),
    }));
    const res = await createHerd(run).send("rev-1", "go", { timeoutMs: 30000 });
    expect(res.waited).toBe(true);
    expect(calls[0]).toContain("--wait");
  });

  test("surfaces agent_prompt_stalled with its code", async () => {
    const { run } = mockRunner(() => ({
      code: 1,
      stderr: JSON.stringify({
        error: { code: "agent_prompt_stalled", message: "no lifecycle change" },
      }),
    }));
    const herd = createHerd(run);
    await expect(
      herd.send("rev-1", "go", { wait: true }),
    ).rejects.toMatchObject({ code: "agent_prompt_stalled" });
  });
});

describe("spawn", () => {
  test("generates a unique name and starts the agent no-focus", async () => {
    const { run, calls } = mockRunner((a) => {
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: "w1:pZ" } },
          }),
        };
      if (a[1] === "start")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w1:pZ",
            tab_id: "w1:t1",
            workspace_id: "w1",
            terminal_id: "term_z",
            cwd: "/repo",
            agent_status: "unknown",
          }),
        };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.spawn({
      role: "Code Reviewer!",
      agent: "codex",
      cwd: "/repo",
      env: ["MODE=review"],
      argv: ["--full-auto"],
    });

    expect(res.name).toMatch(/^code-reviewer-[0-9a-f]{4}$/);
    expect(res.paneId).toBe("w1:pZ");
    expect(res.task).toBeUndefined();

    const startCall = calls.find((c) => c[1] === "start")!;
    const splitCall = calls.find((c) => c[0] === "pane" && c[1] === "split")!;
    expect(splitCall).toContain("--no-focus");
    expect(splitCall[splitCall.indexOf("--direction") + 1]).toBe("down");
    expect(splitCall[splitCall.indexOf("--cwd") + 1]).toBe("/repo");
    expect(splitCall.filter((_, i) => splitCall[i - 1] === "--env")).toContain(
      "MODE=review",
    );
    expect(startCall[2]).toBe(res.name);
    expect(startCall[startCall.indexOf("--kind") + 1]).toBe("codex");
    expect(startCall[startCall.indexOf("--pane") + 1]).toBe("w1:pZ");
    expect(startCall).not.toContain("--env");
    expect(startCall.slice(startCall.indexOf("--") + 1)).toEqual([
      "--full-auto",
    ]);
  });

  test("regenerates when the first candidate name collides", async () => {
    const { run } = mockRunner((a) => {
      if (a[1] === "list")
        return { stdout: listEnvelope([{ name: "worker-aaaa" }]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: "w1:p1" } },
          }),
        };
      if (a[1] === "start")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w1:p1",
            tab_id: "w1:t1",
            workspace_id: "w1",
            terminal_id: "t",
            cwd: "/",
            agent_status: "unknown",
          }),
        };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.spawn({ role: "worker", agent: "claude" });
    // even in the astronomically unlikely case randHex hits "aaaa", the name must differ
    expect(res.name).not.toBe("worker-aaaa");
    expect(res.name).toMatch(/^worker-[0-9a-f]{4}$/);
  });

  test("resolves opts.tab to a pane in that tab before splitting", async () => {
    const { run, calls } = mockRunner((a) => {
      if (a[0] === "agent" && a[1] === "list")
        return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "list")
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                { pane_id: "w7:p1", tab_id: "w7:t1" },
                { pane_id: "w7:p2", tab_id: "w7:t2" },
              ],
            },
          }),
        };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({ result: { pane: { pane_id: "w7:p3" } } }),
        };
      if (a[0] === "agent" && a[1] === "start")
        return { stdout: agentEnvelope({ name: a[2], pane_id: "w7:p3" }) };
      return undefined;
    });

    await createHerd(run).spawn({
      role: "reviewer",
      agent: "codex",
      tab: "w7:t2",
    });

    expect(calls.find((c) => c[0] === "pane" && c[1] === "list")).toEqual([
      "pane",
      "list",
      "--workspace",
      "w7",
    ]);
    const splitCall = calls.find((c) => c[0] === "pane" && c[1] === "split")!;
    expect(splitCall[splitCall.indexOf("--pane") + 1]).toBe("w7:p2");
  });

  test("resolves opts.workspace to a pane in that workspace before splitting", async () => {
    const { run, calls } = mockRunner((a) => {
      if (a[0] === "agent" && a[1] === "list")
        return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "list")
        return {
          stdout: JSON.stringify({
            result: {
              panes: [{ pane_id: "w8:p1", tab_id: "w8:t1" }],
            },
          }),
        };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({ result: { pane: { pane_id: "w8:p2" } } }),
        };
      if (a[0] === "agent" && a[1] === "start")
        return { stdout: agentEnvelope({ name: a[2], pane_id: "w8:p2" }) };
      return undefined;
    });

    await createHerd(run).spawn({
      role: "worker",
      agent: "claude",
      workspace: "w8",
    });

    expect(calls.find((c) => c[0] === "pane" && c[1] === "list")).toEqual([
      "pane",
      "list",
      "--workspace",
      "w8",
    ]);
    const splitCall = calls.find((c) => c[0] === "pane" && c[1] === "split")!;
    expect(splitCall[splitCall.indexOf("--pane") + 1]).toBe("w8:p1");
  });

  test("with --task: waits then sends + submits", async () => {
    const seen: string[][] = [];
    const { run } = mockRunner((a) => {
      seen.push(a);
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: "w2:p3" } },
          }),
        };
      if (a[1] === "start")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w2:p3",
            tab_id: "w2:t1",
            workspace_id: "w2",
            terminal_id: "t",
            cwd: "/",
            agent_status: "unknown",
          }),
        };
      if (a[1] === "wait")
        return { stdout: JSON.stringify({ result: { status: "idle" } }) };
      if (a[0] === "agent" && a[1] === "prompt")
        return { stdout: JSON.stringify({ result: { type: "ok" } }) };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.spawn({
      role: "worker",
      agent: "codex",
      task: "build X",
    });
    expect(res.task).toEqual({ sent: true });
    expect(seen.some((c) => c[1] === "wait")).toBe(true);
    expect(
      seen.some(
        (c) => c[0] === "agent" && c[1] === "prompt" && c[3] === "build X",
      ),
    ).toBe(true);
    const waitCall = seen.find((c) => c[0] === "agent" && c[1] === "wait")!;
    expect(waitCall[waitCall.indexOf("--until") + 1]).toBe("idle");
  });

  test("newTab: creates a tab, starts in its root pane, restores focus", async () => {
    const seen: string[][] = [];
    const { run } = mockRunner((a) => {
      seen.push(a);
      if (a[0] === "agent" && a[1] === "list")
        return { stdout: listEnvelope([]) };
      if (a[0] === "tab" && a[1] === "list")
        return {
          stdout: JSON.stringify({
            result: {
              tabs: [
                { tab_id: "w3:t2", focused: true },
                { tab_id: "w3:t1", focused: false },
              ],
            },
          }),
        };
      if (a[0] === "tab" && a[1] === "create")
        return {
          stdout: JSON.stringify({
            result: {
              tab: { tab_id: "w3:t9" },
              root_pane: { pane_id: "w3:pShell" },
            },
          }),
        };
      if (a[0] === "agent" && a[1] === "start")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w3:pAgent",
            tab_id: "w3:t9",
            workspace_id: "w3",
            terminal_id: "t",
            cwd: "/repo",
            agent_status: "unknown",
          }),
        };
      if (a[0] === "tab" && a[1] === "focus") return { stdout: "" };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.spawn({
      role: "reviewer",
      agent: "codex",
      cwd: "/repo",
      newTab: true,
    });

    expect(res.name).toMatch(/^reviewer-[0-9a-f]{4}$/);
    expect(res.paneId).toBe("w3:pAgent");

    // The tab is labelled with the generated agent name by default.
    const createCall = seen.find((c) => c[0] === "tab" && c[1] === "create")!;
    expect(createCall[createCall.indexOf("--label") + 1]).toBe(res.name);

    const startCall = seen.find((c) => c[0] === "agent" && c[1] === "start")!;
    expect(startCall[startCall.indexOf("--kind") + 1]).toBe("codex");
    expect(startCall[startCall.indexOf("--pane") + 1]).toBe("w3:pShell");
    expect(startCall).not.toContain("--split");
    expect(
      seen.some((c) => c[0] === "tab" && c[1] === "focus" && c[2] === "w3:t2"),
    ).toBe(true);
  });

  // Shared mock for the workspace-pinning tests below: a caller spawns a new
  // tab; we only care about which --workspace lands on `tab create`.
  function newTabRunner(seen: string[][]) {
    return mockRunner((a) => {
      seen.push(a);
      if (a[0] === "agent" && a[1] === "list")
        return { stdout: listEnvelope([]) };
      if (a[0] === "tab" && a[1] === "list")
        return {
          stdout: JSON.stringify({
            result: { tabs: [{ tab_id: "wFocus:t2", focused: true }] },
          }),
        };
      if (a[0] === "tab" && a[1] === "create")
        return {
          stdout: JSON.stringify({
            result: {
              tab: { tab_id: "wX:t9" },
              root_pane: { pane_id: "wX:pShell" },
            },
          }),
        };
      if (a[0] === "agent" && a[1] === "start")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "wX:pAgent",
            tab_id: "wX:t9",
            workspace_id: "wX",
            terminal_id: "t",
            cwd: "/repo",
            agent_status: "unknown",
          }),
        };
      if (a[0] === "tab" && a[1] === "focus") return { stdout: "" };
      return undefined;
    });
  }

  test("newTab: pins --workspace to the caller's HERDR_WORKSPACE_ID by default", async () => {
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wCaller";
    try {
      const seen: string[][] = [];
      const { run } = newTabRunner(seen);
      await createHerd(run).spawn({
        role: "reviewer",
        agent: "codex",
        cwd: "/repo",
        newTab: true,
      });
      const createCall = seen.find((c) => c[0] === "tab" && c[1] === "create")!;
      expect(createCall[createCall.indexOf("--workspace") + 1]).toBe("wCaller");
    } finally {
      if (prev === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = prev;
    }
  });

  test("newTab: an explicit workspace overrides HERDR_WORKSPACE_ID", async () => {
    const prev = process.env.HERDR_WORKSPACE_ID;
    process.env.HERDR_WORKSPACE_ID = "wEnv";
    try {
      const seen: string[][] = [];
      const { run } = newTabRunner(seen);
      await createHerd(run).spawn({
        role: "reviewer",
        agent: "codex",
        cwd: "/repo",
        newTab: true,
        workspace: "wExplicit",
      });
      const createCall = seen.find((c) => c[0] === "tab" && c[1] === "create")!;
      expect(createCall[createCall.indexOf("--workspace") + 1]).toBe(
        "wExplicit",
      );
    } finally {
      if (prev === undefined) delete process.env.HERDR_WORKSPACE_ID;
      else process.env.HERDR_WORKSPACE_ID = prev;
    }
  });

  test("newTab: an explicit tabLabel overrides the default agent-name label", async () => {
    const seen: string[][] = [];
    const { run } = mockRunner((a) => {
      seen.push(a);
      if (a[0] === "agent" && a[1] === "list")
        return { stdout: listEnvelope([]) };
      if (a[0] === "tab" && a[1] === "list")
        return {
          stdout: JSON.stringify({
            result: { tabs: [{ tab_id: "w3:t2", focused: true }] },
          }),
        };
      if (a[0] === "tab" && a[1] === "create")
        return {
          stdout: JSON.stringify({
            result: {
              tab: { tab_id: "w3:t9" },
              root_pane: { pane_id: "w3:pShell" },
            },
          }),
        };
      if (a[0] === "agent" && a[1] === "start")
        return { stdout: agentEnvelope({ name: a[2], pane_id: "w3:pAgent" }) };
      if (a[0] === "tab" && a[1] === "focus") return { stdout: "" };
      return undefined;
    });
    const herd = createHerd(run);
    await herd.spawn({
      role: "reviewer",
      agent: "codex",
      newTab: true,
      tabLabel: "PR #42 review",
    });
    const createCall = seen.find((c) => c[0] === "tab" && c[1] === "create")!;
    expect(createCall[createCall.indexOf("--label") + 1]).toBe("PR #42 review");
  });

  // A pane returned by `pane split` / `tab create` is not yet at its shell
  // prompt, and `agent start --pane` rejects it with `agent_pane_busy` until it
  // is. These tests pin the retry loop that closes that window.
  const paneBusy = {
    code: 1,
    stdout: JSON.stringify({
      error: {
        code: "agent_pane_busy",
        message: "agent target w1:pZ is not an available shell",
      },
    }),
  };

  /** Fake clock + sleep: advances instantly so retry tests cost no wall time. */
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  test("retries agent start until the fresh pane reaches its shell prompt", async () => {
    let startAttempts = 0;
    const { run } = mockRunner((a) => {
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:pZ" } } }),
        };
      if (a[1] === "start") {
        startAttempts++;
        if (startAttempts < 3) return paneBusy;
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w1:pZ",
            tab_id: "w1:t1",
            workspace_id: "w1",
            terminal_id: "t",
            cwd: "/repo",
            agent_status: "idle",
          }),
        };
      }
      return undefined;
    });
    const herd = createHerd(run, fakeClock());
    const res = await herd.spawn({ role: "worker", agent: "codex" });

    expect(startAttempts).toBe(3);
    expect(res.paneId).toBe("w1:pZ");
    // The pane is split exactly once — retries re-run `agent start` only.
    expect(res.name).toMatch(/^worker-[0-9a-f]{4}$/);
  });

  test("newTab: retries agent start on the fresh tab's root pane too", async () => {
    let startAttempts = 0;
    const { run, calls } = mockRunner((a) => {
      if (a[0] === "agent" && a[1] === "list")
        return { stdout: listEnvelope([]) };
      if (a[0] === "tab" && a[1] === "list")
        return {
          stdout: JSON.stringify({
            result: { tabs: [{ tab_id: "w3:t2", focused: true }] },
          }),
        };
      if (a[0] === "tab" && a[1] === "create")
        return {
          stdout: JSON.stringify({
            result: {
              tab: { tab_id: "w3:t9" },
              root_pane: { pane_id: "w3:pShell" },
            },
          }),
        };
      if (a[0] === "agent" && a[1] === "start") {
        startAttempts++;
        if (startAttempts < 2) return paneBusy;
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w3:pAgent",
            tab_id: "w3:t9",
            workspace_id: "w3",
            terminal_id: "t",
            cwd: "/repo",
            agent_status: "idle",
          }),
        };
      }
      return undefined;
    });
    const herd = createHerd(run, fakeClock());
    const res = await herd.spawn({
      role: "reviewer",
      agent: "codex",
      newTab: true,
    });

    expect(startAttempts).toBe(2);
    expect(res.paneId).toBe("w3:pAgent");
    // One tab only — a retry must not create a second tab.
    expect(
      calls.filter((c) => c[0] === "tab" && c[1] === "create"),
    ).toHaveLength(1);
  });

  test("gives up with herdr's message when the pane never frees up", async () => {
    let startAttempts = 0;
    const { run } = mockRunner((a) => {
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:pZ" } } }),
        };
      if (a[1] === "start") {
        startAttempts++;
        return paneBusy;
      }
      return undefined;
    });
    const herd = createHerd(run, fakeClock());
    await expect(
      herd.spawn({ role: "worker", agent: "codex" }),
    ).rejects.toThrow("is not an available shell");
    expect(startAttempts).toBeGreaterThan(1);
  });

  test("does not retry errors unrelated to shell readiness", async () => {
    let startAttempts = 0;
    const { run } = mockRunner((a) => {
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:pZ" } } }),
        };
      if (a[1] === "start") {
        startAttempts++;
        return {
          code: 1,
          stdout: JSON.stringify({
            error: { code: "agent_kind_unsupported", message: "bad kind" },
          }),
        };
      }
      return undefined;
    });
    const herd = createHerd(run, fakeClock());
    await expect(herd.spawn({ role: "worker", agent: "nope" })).rejects.toThrow(
      "bad kind",
    );
    expect(startAttempts).toBe(1);
  });

  test("suppresses the shell banner in the new pane and keeps caller env", async () => {
    const seen: string[][] = [];
    const { run } = mockRunner((a) => {
      seen.push(a);
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:pZ" } } }),
        };
      if (a[1] === "start")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w1:pZ",
            agent_status: "idle",
          }),
        };
      return undefined;
    });
    const herd = createHerd(run);
    await herd.spawn({ role: "worker", agent: "codex", env: ["MODE=review"] });

    const split = seen.find((c) => c[0] === "pane" && c[1] === "split")!;
    const envs = split.filter((_, i) => split[i - 1] === "--env");
    expect(envs).toContain("Q_NO_BANNER=1");
    expect(envs).toContain("MODE=review");
  });

  test("newTab: suppresses the shell banner on tab create", async () => {
    const seen: string[][] = [];
    const { run } = newTabRunner(seen);
    const herd = createHerd(run);
    await herd.spawn({ role: "worker", agent: "codex", newTab: true });

    const create = seen.find((c) => c[0] === "tab" && c[1] === "create")!;
    const envs = create.filter((_, i) => create[i - 1] === "--env");
    expect(envs).toContain("Q_NO_BANNER=1");
  });

  test("an explicit Q_NO_BANNER from the caller wins over the default", async () => {
    const seen: string[][] = [];
    const { run } = mockRunner((a) => {
      seen.push(a);
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:pZ" } } }),
        };
      if (a[1] === "start")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w1:pZ",
            agent_status: "idle",
          }),
        };
      return undefined;
    });
    const herd = createHerd(run);
    await herd.spawn({
      role: "worker",
      agent: "codex",
      env: ["Q_NO_BANNER=0"],
    });

    const split = seen.find((c) => c[0] === "pane" && c[1] === "split")!;
    const envs = split.filter((_, i) => split[i - 1] === "--env");
    expect(envs).toEqual(["Q_NO_BANNER=0"]);
  });

  test("with --task: sends even if the idle wait errors", async () => {
    const { run } = mockRunner((a) => {
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: "w2:p3" } },
          }),
        };
      if (a[1] === "start")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w2:p3",
            tab_id: "w2:t1",
            workspace_id: "w2",
            terminal_id: "t",
            cwd: "/",
            agent_status: "unknown",
          }),
        };
      if (a[1] === "wait") return { code: 1, stderr: "timeout" };
      if (a[0] === "agent" && a[1] === "prompt")
        return { stdout: JSON.stringify({ result: { type: "ok" } }) };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.spawn({
      role: "worker",
      agent: "codex",
      task: "echo hi",
    });
    expect(res.task).toEqual({ sent: true });
  });

  test("with --task: reports agent_blocked instead of stranding the pane", async () => {
    const { run } = mockRunner((a) => {
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: "w2:p3" } },
          }),
        };
      if (a[1] === "start")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w2:p3",
            tab_id: "w2:t1",
            workspace_id: "w2",
            terminal_id: "t",
            cwd: "/",
            agent_status: "blocked",
          }),
        };
      if (a[1] === "wait") return { code: 1, stderr: "timeout" };
      if (a[0] === "agent" && a[1] === "prompt")
        return {
          code: 1,
          stderr: JSON.stringify({
            error: { code: "agent_blocked", message: "agent is blocked" },
          }),
        };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.spawn({
      role: "worker",
      agent: "codex",
      task: "echo hi",
    });
    expect(res.task).toEqual({ sent: false, reason: "agent_blocked" });
    expect(res.name).toStartWith("worker-");
  });

  test("agent_not_ready returns the live agent instead of stranding the pane", async () => {
    const { run, calls } = mockRunner((a) => {
      if (a[1] === "list") return { stdout: listEnvelope([]) };
      if (a[0] === "pane" && a[1] === "split")
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: "w2:p3" } },
          }),
        };
      if (a[1] === "start")
        return {
          code: 1,
          stderr: JSON.stringify({
            error: { code: "agent_not_ready", message: "agent is blocked" },
          }),
        };
      if (a[1] === "get")
        return {
          stdout: agentEnvelope({
            name: a[2],
            pane_id: "w2:p3",
            tab_id: "w2:t1",
            workspace_id: "w2",
            terminal_id: "t",
            cwd: "/",
            agent_status: "blocked",
          }),
        };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.spawn({
      role: "worker",
      agent: "codex",
      task: "echo hi",
    });
    expect(res.startBlocked).toBe(true);
    expect(res.paneId).toBe("w2:p3");
    expect(res.name).toStartWith("worker-");
    expect(res.task).toEqual({ sent: false, reason: "agent_not_ready" });
    // No settle wait and no prompt: both can only fail while the dialog is up.
    expect(calls.some((c) => c[1] === "wait" || c[1] === "prompt")).toBe(false);
  });
});

describe("errors", () => {
  test("surfaces herdr's structured error message + code", async () => {
    const { run } = mockRunner(() => ({
      code: 1,
      stdout: JSON.stringify({
        error: {
          code: "agent_not_found",
          message: "agent target ghost not found",
        },
      }),
    }));
    const herd = createHerd(run);
    await expect(herd.get("ghost")).rejects.toThrow(HerdrError);
    await expect(herd.get("ghost")).rejects.toThrow(
      "agent target ghost not found",
    );
  });

  test("falls back to stderr when output is not JSON", async () => {
    const { run } = mockRunner(() => ({
      code: 2,
      stderr: "herdr: usage error",
    }));
    const herd = createHerd(run);
    await expect(herd.list()).rejects.toThrow("herdr: usage error");
  });
});

describe("read", () => {
  test("returns agent read's plain text with one CLI call", async () => {
    const { run, calls } = mockRunner((a) =>
      a[1] === "read" ? { stdout: "line1\nline2\n" } : undefined,
    );
    const herd = createHerd(run);
    const text = await herd.read("rev-1", { lines: 10 });
    expect(text).toBe("line1\nline2\n");
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c[c.indexOf("--source") + 1]).toBe("visible");
    expect(c[c.indexOf("--lines") + 1]).toBe("10");
  });

  test("surfaces agent_not_idle instead of hiding it behind a pane fallback", async () => {
    const { run, calls } = mockRunner(() => ({
      code: 1,
      stderr: JSON.stringify({
        error: {
          code: "agent_not_idle",
          message: "agent must be idle to collect alternate-screen history",
        },
      }),
    }));
    const herd = createHerd(run);
    const error = await herd
      .read("rev-1", { lines: 400, source: "recent-unwrapped" })
      .catch((reason) => reason);
    expect(error).toBeInstanceOf(HerdrError);
    expect(error.code).toBe("agent_not_idle");
    expect(calls).toHaveLength(1);
  });
});

describe("keys", () => {
  test("resolves the pane then sends bare key chords (no text)", async () => {
    const { run, calls } = mockRunner((a) => {
      if (a[1] === "get")
        return { stdout: agentEnvelope({ name: "rev-1", pane_id: "w9:pB" }) };
      if (a[0] === "pane" && a[1] === "send-keys") return { stdout: "" };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.keys("rev-1", "ctrl+a", "ctrl+k");
    expect(res).toEqual({
      target: "rev-1",
      paneId: "w9:pB",
      keys: ["ctrl+a", "ctrl+k"],
    });
    expect(calls.find((c) => c[0] === "pane" && c[1] === "send-keys")).toEqual([
      "pane",
      "send-keys",
      "w9:pB",
      "ctrl+a",
      "ctrl+k",
    ]);
  });

  test("passes shift+tab through unmodified", async () => {
    const { run, calls } = mockRunner((a) => {
      if (a[1] === "get")
        return { stdout: agentEnvelope({ name: "rev-1", pane_id: "w9:pB" }) };
      if (a[0] === "pane" && a[1] === "send-keys") return { stdout: "" };
      return undefined;
    });
    const herd = createHerd(run);
    await herd.keys("rev-1", "shift+tab");
    expect(calls.find((c) => c[0] === "pane" && c[1] === "send-keys")).toEqual([
      "pane",
      "send-keys",
      "w9:pB",
      "shift+tab",
    ]);
  });

  test("rejects an empty key list", async () => {
    const { run } = mockRunner(() => undefined);
    const herd = createHerd(run);
    await expect(herd.keys("rev-1")).rejects.toThrow(HerdrError);
  });
});

describe("close", () => {
  test("resolves the pane then closes it", async () => {
    const { run, calls } = mockRunner((a) => {
      if (a[1] === "get")
        return { stdout: agentEnvelope({ name: "rev-1", pane_id: "w4:p2" }) };
      if (a[1] === "close")
        return { stdout: JSON.stringify({ result: { type: "ok" } }) };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.close("rev-1");
    expect(res).toEqual({ target: "rev-1", paneId: "w4:p2", closed: true });
    expect(calls.find((c) => c[0] === "pane" && c[1] === "close")).toEqual([
      "pane",
      "close",
      "w4:p2",
    ]);
  });
});

describe("wait", () => {
  const waitEnvelope = JSON.stringify({ result: { type: "wait_matched" } });
  const waitRunner = () =>
    mockRunner((a) => (a[1] === "wait" ? { stdout: waitEnvelope } : undefined));

  test("defaults to --until idle — readiness, not completion", async () => {
    const { run, calls } = waitRunner();
    await createHerd(run).wait("rev-1");
    expect(calls[0]).toEqual([
      "agent",
      "wait",
      "rev-1",
      "--until",
      "idle",
      "--timeout",
      "15000",
    ]);
  });

  test("accepts done, which herdr supports but the wrapper used to reject", async () => {
    const { run, calls } = waitRunner();
    await createHerd(run).wait("rev-1", { status: "done" });
    expect(calls[0].slice(3, 5)).toEqual(["--until", "done"]);
  });

  test("emits one repeated --until per status, in order", async () => {
    const { run, calls } = waitRunner();
    await createHerd(run).wait("rev-1", {
      status: ["idle", "done"],
      timeoutMs: 5000,
    });
    expect(calls[0]).toEqual([
      "agent",
      "wait",
      "rev-1",
      "--until",
      "idle",
      "--until",
      "done",
      "--timeout",
      "5000",
    ]);
  });

  test("rejects an empty status array rather than sending a bare wait", async () => {
    const { run, calls } = waitRunner();
    await expect(createHerd(run).wait("rev-1", { status: [] })).rejects.toThrow(
      HerdrError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("parseArgs", () => {
  test("a value-flag consumes a value that starts with -- (not treated as boolean)", () => {
    const { flags } = parseArgs(["--agent", "codex", "--task", "--check src"]);
    expect(flags.agent).toBe("codex");
    expect(flags.task).toBe("--check src");
  });

  test("new-tab is boolean and does not swallow the next token", () => {
    const { flags, positionals } = parseArgs([
      "reviewer",
      "--new-tab",
      "--agent",
      "codex",
    ]);
    expect(flags["new-tab"]).toBe(true);
    expect(flags.agent).toBe("codex");
    expect(positionals).toEqual(["reviewer"]);
  });

  test("a trailing value-flag with no value becomes boolean", () => {
    const { flags } = parseArgs(["--task"]);
    expect(flags.task).toBe(true);
  });

  test("collects repeated --env and everything after -- as rest", () => {
    const { env, rest } = parseArgs([
      "--env",
      "A=1",
      "--env",
      "B=2",
      "--",
      "-l",
      "--color",
    ]);
    expect(env).toEqual(["A=1", "B=2"]);
    expect(rest).toEqual(["-l", "--color"]);
  });

  test("a repeatable flag collects into an array instead of overwriting", () => {
    const { flags } = parseArgs(["--status", "idle", "--status", "done"]);
    expect(flags.status).toEqual(["idle", "done"]);
  });

  test("a repeatable flag given once stays a plain string", () => {
    const { flags } = parseArgs(["--status", "idle"]);
    expect(flags.status).toBe("idle");
  });

  test("a non-repeatable flag still takes the last value", () => {
    const { flags } = parseArgs(["--agent", "codex", "--agent", "claude"]);
    expect(flags.agent).toBe("claude");
  });
});

// --- tell -------------------------------------------------------------------

const located = (o: Partial<AgentLocation>): AgentLocation => ({
  name: null,
  type: "claude",
  status: "idle",
  paneId: "w1:p1",
  tabId: "w1:t1",
  workspaceId: "w1",
  terminalId: "term_1",
  cwd: "/x",
  focused: false,
  workspaceLabel: null,
  tabLabel: null,
  ...o,
});

/** The real fleet shape this feature was designed against: two agents share the
 *  `web-app` workspace and are told apart only by tab label. */
const FLEET: AgentLocation[] = [
  located({
    paneId: "w6E:p1",
    tabId: "w6E:t1",
    workspaceId: "w6E",
    workspaceLabel: "web-app",
    tabLabel: "main",
    cwd: "/Users/dev/Projects/web-app",
  }),
  located({
    paneId: "w6E:p4",
    tabId: "w6E:t2",
    workspaceId: "w6E",
    workspaceLabel: "web-app",
    tabLabel: "Dashboard Launcher",
    cwd: "/Users/dev/Projects/web-app",
  }),
  located({
    paneId: "w7J:p1",
    tabId: "w7J:t1",
    workspaceId: "w7J",
    workspaceLabel: "acme",
    tabLabel: "main",
    cwd: "/Users/dev/Projects/clients/acme",
  }),
  located({
    paneId: "w7P:p1",
    tabId: "w7P:t1",
    workspaceId: "w7P",
    workspaceLabel: "api-service",
    tabLabel: "main",
    cwd: "/Users/dev/Projects/api-service",
  }),
  located({
    paneId: "w7S:p1",
    tabId: "w7S:t1",
    workspaceId: "w7S",
    workspaceLabel: "cc-plugins",
    tabLabel: "main",
    cwd: "/Users/dev/Projects/cc-plugins",
    focused: true,
  }),
];

const SELF = { selfPaneId: "w7S:p1" };

describe("matchAgents", () => {
  test("a workspace label resolves to its agent", () => {
    const found = matchAgents(FLEET, "api-service", SELF);
    expect(found.map((a) => a.paneId)).toEqual(["w7P:p1"]);
  });

  test("a shared workspace label returns every candidate", () => {
    const found = matchAgents(FLEET, "web-app", SELF);
    expect(found.map((a) => a.paneId)).toEqual(["w6E:p1", "w6E:p4"]);
  });

  test("a slash narrows by tab label", () => {
    const found = matchAgents(FLEET, "web-app/dashboard", SELF);
    expect(found.map((a) => a.paneId)).toEqual(["w6E:p4"]);
  });

  test("matching is case-insensitive", () => {
    const found = matchAgents(FLEET, "API-Service", SELF);
    expect(found.map((a) => a.paneId)).toEqual(["w7P:p1"]);
  });

  test("every part may match a different field", () => {
    const found = matchAgents(FLEET, "clients/acme", SELF);
    expect(found.map((a) => a.paneId)).toEqual(["w7J:p1"]);
  });

  test("a cwd fragment matches when no label does", () => {
    const found = matchAgents(FLEET, "Projects/clients", SELF);
    expect(found.map((a) => a.paneId)).toEqual(["w7J:p1"]);
  });

  test("a pane id resolves exactly, even against identical addresses", () => {
    // Two tabs may carry the same label, which makes addressOf() identical for
    // both. The pane id is the only handle that still splits them.
    const twins = [
      located({ paneId: "w8:p1", workspaceLabel: "twin", tabLabel: "main" }),
      located({ paneId: "w8:p2", workspaceLabel: "twin", tabLabel: "main" }),
    ];
    expect(matchAgents(twins, "twin").map((a) => a.paneId)).toEqual([
      "w8:p1",
      "w8:p2",
    ]);
    expect(matchAgents(twins, "w8:p2").map((a) => a.paneId)).toEqual(["w8:p2"]);
  });

  test("an exact pane id beats the pane id it is a prefix of", () => {
    // Pane numbers are unpadded, so a substring match would return BOTH here and
    // the escape hatch would fail in exactly the busy workspace that needs it.
    const busy = [
      located({ paneId: "w6:p1", workspaceLabel: "busy" }),
      located({ paneId: "w6:p10", workspaceLabel: "busy" }),
    ];
    expect(matchAgents(busy, "w6:p1").map((a) => a.paneId)).toEqual(["w6:p1"]);
    expect(matchAgents(busy, "w6:p10").map((a) => a.paneId)).toEqual([
      "w6:p10",
    ]);
    // A genuine prefix that is nobody's id still matches both, as a fragment should.
    expect(matchAgents(busy, "w6:p").map((a) => a.paneId)).toEqual([
      "w6:p1",
      "w6:p10",
    ]);
  });

  test("the calling pane is never a candidate", () => {
    expect(matchAgents(FLEET, "cc-plugins", SELF)).toEqual([]);
  });

  test("without a self pane id nothing is excluded", () => {
    expect(matchAgents(FLEET, "cc-plugins").map((a) => a.paneId)).toEqual([
      "w7S:p1",
    ]);
  });

  test("an exact name wins over a broader substring match", () => {
    const fleet = [
      ...FLEET,
      located({ name: "acme", paneId: "w9:p1", cwd: "/elsewhere" }),
    ];
    const found = matchAgents(fleet, "acme", SELF);
    expect(found.map((a) => a.paneId)).toEqual(["w9:p1"]);
  });

  test("an empty or unmatched fragment finds nothing", () => {
    expect(matchAgents(FLEET, "  ", SELF)).toEqual([]);
    expect(matchAgents(FLEET, "nope", SELF)).toEqual([]);
  });
});

/** The three calls `directory()` joins, answered from raw CLI-shaped rows.
 *  Parameterized so each test states only the fleet it cares about, and so the
 *  workspace and tab branches stay told apart by argv[0] — `list` is argv[1] for
 *  both commands, so matching on it alone is a coincidence, not a contract. */
function directoryRunner(
  agents: Record<string, unknown>[],
  workspaces: Record<string, unknown>[] = [],
  tabs: Record<string, unknown>[] = [],
) {
  return mockRunner((a) => {
    if (a[0] === "agent" && a[1] === "prompt")
      return { stdout: JSON.stringify({ result: { type: "ok" } }) };
    if (a[0] === "agent" && a[1] === "list")
      return { stdout: listEnvelope(agents) };
    if (a[0] === "workspace" && a[1] === "list")
      return { stdout: JSON.stringify({ result: { workspaces } }) };
    if (a[0] === "tab" && a[1] === "list")
      return { stdout: JSON.stringify({ result: { tabs } }) };
    return undefined;
  });
}

/** One reachable project plus the caller's own pane. */
const fleetRunner = () =>
  directoryRunner(
    [
      {
        agent: "claude",
        agent_status: "idle",
        pane_id: "w7P:p1",
        tab_id: "w7P:t1",
        workspace_id: "w7P",
        terminal_id: "term_1",
        cwd: "/Users/dev/Projects/api-service",
        focused: false,
      },
      {
        agent: "claude",
        agent_status: "working",
        pane_id: "w7S:p1",
        tab_id: "w7S:t1",
        workspace_id: "w7S",
        terminal_id: "term_2",
        cwd: "/Users/dev/Projects/cc-plugins",
        focused: true,
      },
    ],
    [
      { workspace_id: "w7P", label: "api-service" },
      { workspace_id: "w7S", label: "cc-plugins" },
    ],
    // U+F09D1 is the glyph herdr actually prefixes tab labels with.
    [
      { tab_id: "w7P:t1", label: "\u{f09d1}  main" },
      { tab_id: "w7S:t1", label: "\u{f09d1}  main" },
    ],
  );

describe("addressOf", () => {
  test("prefers a name, then workspace/tab, then the pane id", () => {
    expect(addressOf(located({ name: "reviewer-a3f9" }))).toBe("reviewer-a3f9");
    expect(
      addressOf(located({ workspaceLabel: "web-app", tabLabel: "main" })),
    ).toBe("web-app/main");
    expect(addressOf(located({ workspaceLabel: "web-app" }))).toBe("web-app");
  });

  test("falls back to the pane id for an unlabelled workspace", () => {
    // Reachable whenever `workspace list` omits a label, so it must not throw
    // or render "null/main" into a candidate list a human has to read.
    expect(addressOf(located({ paneId: "w4:p2" }))).toBe("w4:p2");
    expect(addressOf(located({ paneId: "w4:p2", tabLabel: "main" }))).toBe(
      "w4:p2",
    );
  });
});

describe("directory", () => {
  test("joins workspace and tab labels onto each agent", async () => {
    const { run } = fleetRunner();
    const agents = await createHerd(run).directory();
    expect(agents[0]?.workspaceLabel).toBe("api-service");
    // The nerd-font glyph herdr prefixes every tab label with is stripped.
    expect(agents[0]?.tabLabel).toBe("main");
  });
});

describe("tell", () => {
  test("resolves a fragment and submits without waiting", async () => {
    const { run, calls } = fleetRunner();
    const res = await createHerd(run).tell("api-service", "reply ok", SELF);
    const prompt = calls.find((c) => c[1] === "prompt");
    expect(prompt).toEqual(["agent", "prompt", "w7P:p1", "reply ok"]);
    expect(prompt).not.toContain("--wait");
    expect(res.target).toBe("w7P:p1");
    expect(res.matched.workspaceLabel).toBe("api-service");
  });

  test("addresses a named agent by name, not pane id", async () => {
    const { run, calls } = directoryRunner([
      {
        name: "reviewer-a3f9",
        agent: "codex",
        agent_status: "idle",
        pane_id: "w2:p1",
        tab_id: "w2:t1",
        workspace_id: "w2",
        cwd: "/x",
      },
    ]);
    await createHerd(run).tell("reviewer-a3f9", "go");
    expect(calls.find((c) => c[1] === "prompt")?.[2]).toBe("reviewer-a3f9");
  });

  test("an ambiguous fragment refuses to send and names the candidates", async () => {
    const { run, calls } = directoryRunner(
      [
        {
          pane_id: "w6E:p1",
          tab_id: "w6E:t1",
          workspace_id: "w6E",
          agent_status: "idle",
          cwd: "/Users/dev/Projects/web-app",
        },
        {
          pane_id: "w6E:p4",
          tab_id: "w6E:t2",
          workspace_id: "w6E",
          agent_status: "working",
          cwd: "/Users/dev/Projects/web-app",
        },
      ],
      [{ workspace_id: "w6E", label: "web-app" }],
      [
        { tab_id: "w6E:t1", label: "main" },
        { tab_id: "w6E:t2", label: "Dashboard Launcher" },
      ],
    );
    const p = createHerd(run).tell("web-app", "hi");
    await expect(p).rejects.toThrow(/matches 2 agents/);
    await expect(p).rejects.toThrow(/Dashboard Launcher/);
    // Everything a picker needs rides along, so the retry needs no second lookup.
    await expect(p).rejects.toThrow(/\[w6E:p4\]/);
    await expect(p).rejects.toThrow(/working/);
    await expect(p).rejects.toThrow(/Projects\/web-app/);
    expect(calls.some((c) => c[1] === "prompt")).toBe(false);
  });

  test("no match refuses to send", async () => {
    const { run, calls } = fleetRunner();
    await expect(createHerd(run).tell("nope", "hi")).rejects.toThrow(
      /no agent matches/,
    );
    expect(calls.some((c) => c[1] === "prompt")).toBe(false);
  });
});

/** No live agent ever matches; `workspace create` + `agent start` stand in
 *  for a project the registry knows about but nothing has open. Pass `extra`
 *  to answer additional CLI calls a caller needs (e.g. `ask`'s `agent get` /
 *  `pane close`) without duplicating this whole table. */
function projectFallbackRunner(
  cwd: string,
  extra?: (a: string[]) => Partial<RunResult> | undefined,
) {
  return mockRunner((a) => {
    if (a[0] === "agent" && a[1] === "list")
      return {
        stdout: listEnvelope([
          {
            agent: "claude",
            agent_status: "idle",
            pane_id: "w7S:p1",
            tab_id: "w7S:t1",
            workspace_id: "w7S",
            terminal_id: "term_2",
            cwd: "/Users/dev/Projects/cc-plugins",
            focused: true,
          },
        ]),
      };
    if (a[0] === "workspace" && a[1] === "list")
      return {
        stdout: JSON.stringify({
          result: {
            workspaces: [{ workspace_id: "w7S", label: "cc-plugins" }],
          },
        }),
      };
    if (a[0] === "tab" && a[1] === "list")
      return {
        stdout: JSON.stringify({
          result: { tabs: [{ tab_id: "w7S:t1", label: "main" }] },
        }),
      };
    if (a[0] === "workspace" && a[1] === "create")
      return {
        stdout: JSON.stringify({
          result: {
            root_pane: { pane_id: "wNEW:p1", workspace_id: "wNEW" },
          },
        }),
      };
    if (a[0] === "agent" && a[1] === "start")
      return {
        stdout: agentEnvelope({
          name: a[2],
          pane_id: "wNEW:p1",
          tab_id: "wNEW:t1",
          workspace_id: "wNEW",
          terminal_id: "term_new",
          cwd,
          agent_status: "unknown",
        }),
      };
    if (a[0] === "agent" && a[1] === "wait")
      return { stdout: JSON.stringify({ result: { status: "idle" } }) };
    if (a[0] === "agent" && a[1] === "prompt")
      return { stdout: JSON.stringify({ result: { type: "ok" } }) };
    return extra?.(a);
  });
}

async function withRegistryFile(
  projects: Record<string, unknown>,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "herd-registry-"));
  const path = join(dir, "registry.json");
  await writeFile(path, JSON.stringify({ version: 1, projects }));
  try {
    await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("tell — registry/zoxide fallback", () => {
  test("no live agent, a single registry hit with nothing open there: spawns a fresh workspace", async () => {
    const cwd = "/Users/dev/Projects/diqi";
    await withRegistryFile(
      { [cwd]: { name: "diqi", sources: ["claude"] } },
      async (registryPath) => {
        const { run, calls } = projectFallbackRunner(cwd);
        const res = await createHerd(run).tell("diqi", "run tests", {
          registryPath,
        });

        expect(res.spawned).toBeDefined();
        expect(res.spawned?.workspaceId).toBe("wNEW");
        expect(res.spawned?.paneId).toBe("wNEW:p1");
        expect(res.spawned?.cwd).toBe(cwd);
        expect(res.matched.workspaceLabel).toBe("diqi");

        const createCall = calls.find(
          (c) => c[0] === "workspace" && c[1] === "create",
        )!;
        expect(createCall).toContain("--no-focus");
        expect(createCall[createCall.indexOf("--cwd") + 1]).toBe(cwd);
        expect(calls.some((c) => c[0] === "agent" && c[1] === "start")).toBe(
          true,
        );
        expect(
          calls.some(
            (c) =>
              c[0] === "agent" && c[1] === "prompt" && c[3] === "run tests",
          ),
        ).toBe(true);
      },
    );
  });

  test("no live agent, a single registry hit whose cwd is already reachable: sends, does not spawn", async () => {
    const cwd = "/Users/dev/Projects/renamed";
    const { run, calls } = mockRunner((a) => {
      if (a[0] === "agent" && a[1] === "list")
        return {
          stdout: listEnvelope([
            {
              pane_id: "w9:p1",
              tab_id: "w9:t1",
              workspace_id: "w9",
              agent_status: "idle",
              cwd,
            },
          ]),
        };
      if (a[0] === "workspace" && a[1] === "list")
        return {
          stdout: JSON.stringify({
            result: {
              workspaces: [{ workspace_id: "w9", label: "something-else" }],
            },
          }),
        };
      if (a[0] === "tab" && a[1] === "list")
        return {
          stdout: JSON.stringify({
            result: { tabs: [{ tab_id: "w9:t1", label: "main" }] },
          }),
        };
      if (a[0] === "agent" && a[1] === "prompt")
        return { stdout: JSON.stringify({ result: { type: "ok" } }) };
      return undefined;
    });

    await withRegistryFile(
      { [cwd]: { name: "diqi" } },
      async (registryPath) => {
        const res = await createHerd(run).tell("diqi", "run tests", {
          registryPath,
        });
        expect(res.spawned).toBeUndefined();
        expect(res.matched.paneId).toBe("w9:p1");
        expect(
          calls.some((c) => c[0] === "workspace" && c[1] === "create"),
        ).toBe(false);
        expect(
          calls.some(
            (c) =>
              c[0] === "agent" && c[1] === "prompt" && c[3] === "run tests",
          ),
        ).toBe(true);
      },
    );
  });

  test("an ambiguous registry match refuses to spawn and names the candidates", async () => {
    const { run, calls } = fleetRunner();
    await withRegistryFile(
      {
        "/Users/dev/Projects/diqi-web": { name: "diqi-web" },
        "/Users/dev/Projects/diqi-api": { name: "diqi-api" },
      },
      async (registryPath) => {
        const p = createHerd(run).tell("diqi", "run tests", { registryPath });
        await expect(p).rejects.toThrow(/matches 2 known projects/);
        await expect(p).rejects.toThrow(/diqi-web/);
        await expect(p).rejects.toThrow(/diqi-api/);
      },
    );
    expect(calls.some((c) => c[0] === "workspace" && c[1] === "create")).toBe(
      false,
    );
  });

  test("no live agent, no registry hit, and a too-short fragment skips zoxide too", async () => {
    const { run, calls } = fleetRunner();
    await withRegistryFile({}, async (registryPath) => {
      // "z" is below the two-character minimum, so the zoxide lookup never
      // shells out — this stays hermetic without depending on a real zoxide.
      const p = createHerd(run).tell("z", "hi", { registryPath });
      await expect(p).rejects.toThrow(/no agent matches/);
      await expect(p).rejects.toThrow(/registry and zoxide/);
    });
    expect(calls.some((c) => c[1] === "prompt")).toBe(false);
  });
});

/** Fake clock + sleep: ask/collect's poll loop advances instantly instead of
 *  costing 5s of wall time per iteration. */
function fakeAskClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

async function withResultDir(
  fn: (resultDir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "herd-ask-result-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const writeResult = (resultDir: string, answer: string) =>
  writeFile(
    join(resultDir, "result.md"),
    `${answer}\n${ASK_RESULT_END_MARKER}\n`,
  );

describe("ask", () => {
  test("a live agent that already has the answer waiting resolves on the first poll", async () => {
    await withResultDir(async (resultDir) => {
      await writeResult(resultDir, "4");
      const { run, calls } = mockRunner((a) => {
        if (a[0] === "agent" && a[1] === "list")
          return {
            stdout: listEnvelope([
              {
                pane_id: "w7P:p1",
                tab_id: "w7P:t1",
                workspace_id: "w7P",
                agent_status: "idle",
                cwd: "/Users/dev/Projects/api-service",
              },
            ]),
          };
        if (a[0] === "workspace" && a[1] === "list")
          return {
            stdout: JSON.stringify({
              result: {
                workspaces: [{ workspace_id: "w7P", label: "api-service" }],
              },
            }),
          };
        if (a[0] === "tab" && a[1] === "list")
          return {
            stdout: JSON.stringify({
              result: { tabs: [{ tab_id: "w7P:t1", label: "main" }] },
            }),
          };
        if (a[0] === "agent" && a[1] === "prompt")
          return { stdout: JSON.stringify({ result: { type: "ok" } }) };
        if (a[0] === "agent" && a[1] === "get")
          return {
            stdout: agentEnvelope({ pane_id: "w7P:p1", agent_status: "idle" }),
          };
        return undefined;
      });

      const res = await createHerd(run, fakeAskClock()).ask(
        "api-service",
        "what is 2+2?",
        { resultDir },
      );

      expect(res.pending).toBe(false);
      if (!res.pending) expect(res.answer).toBe("4");
      expect(res.matched.workspaceLabel).toBe("api-service");
      expect(res.spawned).toBeUndefined();

      const prompt = calls.find((c) => c[0] === "agent" && c[1] === "prompt")!;
      expect(prompt[2]).toBe("w7P:p1");
      expect(prompt[3]).toContain(join(resultDir, "question.md"));
      // Live agents are never closed, no matter what.
      expect(calls.some((c) => c[0] === "pane" && c[1] === "close")).toBe(
        false,
      );
    });
  });

  /** `ask` needs two more CLI calls answered than `tell`'s fallback: `agent
   *  get` for its poll loop, `pane close` for its post-success cleanup. */
  function askFallbackRunner(cwd: string) {
    return projectFallbackRunner(cwd, (a) => {
      if (a[0] === "agent" && a[1] === "get")
        return {
          stdout: agentEnvelope({ pane_id: "wNEW:p1", agent_status: "idle" }),
        };
      if (a[0] === "pane" && a[1] === "close")
        return { stdout: JSON.stringify({ result: { type: "ok" } }) };
      return undefined;
    });
  }

  test("no live agent, a registry hit: spawns, waits idle, asks, then closes the pane it spawned", async () => {
    const cwd = "/Users/dev/Projects/diqi";
    await withResultDir(async (resultDir) => {
      await writeResult(resultDir, "/Users/dev/Projects/diqi");
      await withRegistryFile(
        { [cwd]: { name: "diqi" } },
        async (registryPath) => {
          const { run, calls } = askFallbackRunner(cwd);
          const res = await createHerd(run, fakeAskClock()).ask(
            "diqi",
            "what directory are you in?",
            { resultDir, registryPath },
          );

          expect(res.pending).toBe(false);
          expect(res.spawned?.cwd).toBe(cwd);
          const closeCall = calls.find(
            (c) => c[0] === "pane" && c[1] === "close",
          );
          expect(closeCall).toBeDefined();
          expect(calls.some((c) => c[0] === "agent" && c[1] === "wait")).toBe(
            true,
          );
        },
      );
    });
  });

  test("--keep-pane skips closing a pane ask spawned itself", async () => {
    const cwd = "/Users/dev/Projects/diqi";
    await withResultDir(async (resultDir) => {
      await writeResult(resultDir, "answer");
      await withRegistryFile(
        { [cwd]: { name: "diqi" } },
        async (registryPath) => {
          const { run, calls } = askFallbackRunner(cwd);
          await createHerd(run, fakeAskClock()).ask("diqi", "q", {
            resultDir,
            registryPath,
            keepPane: true,
          });
          expect(calls.some((c) => c[0] === "pane" && c[1] === "close")).toBe(
            false,
          );
        },
      );
    });
  });

  test("settled without ever producing a valid result file is a hard failure", async () => {
    await withResultDir(async (resultDir) => {
      const { run } = mockRunner((a) => {
        if (a[0] === "agent" && a[1] === "list")
          return {
            stdout: listEnvelope([
              {
                pane_id: "w7P:p1",
                tab_id: "w7P:t1",
                workspace_id: "w7P",
                agent_status: "idle",
                cwd: "/Users/dev/Projects/api-service",
              },
            ]),
          };
        if (a[0] === "workspace" && a[1] === "list")
          return {
            stdout: JSON.stringify({
              result: {
                workspaces: [{ workspace_id: "w7P", label: "api-service" }],
              },
            }),
          };
        if (a[0] === "tab" && a[1] === "list")
          return {
            stdout: JSON.stringify({ result: { tabs: [] } }),
          };
        if (a[0] === "agent" && a[1] === "prompt")
          return { stdout: JSON.stringify({ result: { type: "ok" } }) };
        if (a[0] === "agent" && a[1] === "get")
          return {
            stdout: agentEnvelope({ pane_id: "w7P:p1", agent_status: "idle" }),
          };
        return undefined;
      });

      await expect(
        createHerd(run, fakeAskClock()).ask("api-service", "q", {
          resultDir,
          timeoutMs: 15000,
        }),
      ).rejects.toThrow(/settled without ever writing/);
    });
  });

  test("still working at the timeout returns pending with a collect command, never throws", async () => {
    await withResultDir(async (resultDir) => {
      const { run } = mockRunner((a) => {
        if (a[0] === "agent" && a[1] === "list")
          return {
            stdout: listEnvelope([
              {
                pane_id: "w7P:p1",
                tab_id: "w7P:t1",
                workspace_id: "w7P",
                agent_status: "working",
                cwd: "/Users/dev/Projects/api-service",
              },
            ]),
          };
        if (a[0] === "workspace" && a[1] === "list")
          return {
            stdout: JSON.stringify({
              result: {
                workspaces: [{ workspace_id: "w7P", label: "api-service" }],
              },
            }),
          };
        if (a[0] === "tab" && a[1] === "list")
          return { stdout: JSON.stringify({ result: { tabs: [] } }) };
        if (a[0] === "agent" && a[1] === "prompt")
          return { stdout: JSON.stringify({ result: { type: "ok" } }) };
        if (a[0] === "agent" && a[1] === "get")
          return {
            stdout: agentEnvelope({
              pane_id: "w7P:p1",
              agent_status: "working",
            }),
          };
        return undefined;
      });

      const res = await createHerd(run, fakeAskClock()).ask(
        "api-service",
        "q",
        { resultDir, timeoutMs: 15000 },
      );

      expect(res.pending).toBe(true);
      if (res.pending) {
        expect(res.resultPath).toBe(join(resultDir, "result.md"));
        expect(res.report).toContain("collect");
        expect(res.report).toContain(res.resultPath);
      }
    });
  });
});

describe("collect", () => {
  test("redeems a pending ask's answer without re-sending anything", async () => {
    await withResultDir(async (resultDir) => {
      await writeResult(resultDir, "42");
      const { run, calls } = mockRunner((a) => {
        if (a[0] === "agent" && a[1] === "get")
          return {
            stdout: agentEnvelope({ pane_id: "w7P:p1", agent_status: "idle" }),
          };
        return undefined;
      });

      const res = await createHerd(run, fakeAskClock()).collect(
        "diqi-90d4",
        join(resultDir, "result.md"),
      );

      expect(res.pending).toBe(false);
      if (!res.pending) expect(res.answer).toBe("42");
      expect(calls.some((c) => c[0] === "agent" && c[1] === "prompt")).toBe(
        false,
      );
      expect(calls.some((c) => c[0] === "pane" && c[1] === "close")).toBe(
        false,
      );
    });
  });

  test("still pending stays pending and never closes the pane", async () => {
    await withResultDir(async (resultDir) => {
      const { run, calls } = mockRunner((a) => {
        if (a[0] === "agent" && a[1] === "get")
          return {
            stdout: agentEnvelope({
              pane_id: "w7P:p1",
              agent_status: "working",
            }),
          };
        return undefined;
      });

      const res = await createHerd(run, fakeAskClock()).collect(
        "diqi-90d4",
        join(resultDir, "result.md"),
        { timeoutMs: 15000 },
      );

      expect(res.pending).toBe(true);
      expect(calls.some((c) => c[0] === "pane" && c[1] === "close")).toBe(
        false,
      );
    });
  });

  test("settled without a valid file throws, matching ask's own rule", async () => {
    await withResultDir(async (resultDir) => {
      const { run } = mockRunner((a) => {
        if (a[0] === "agent" && a[1] === "get")
          return {
            stdout: agentEnvelope({ pane_id: "w7P:p1", agent_status: "done" }),
          };
        return undefined;
      });

      await expect(
        createHerd(run, fakeAskClock()).collect(
          "diqi-90d4",
          join(resultDir, "result.md"),
          { timeoutMs: 15000 },
        ),
      ).rejects.toThrow(/settled without ever writing/);
    });
  });
});
