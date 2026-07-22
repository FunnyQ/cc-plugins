import { describe, expect, test } from "bun:test";
import {
  createHerd,
  HerdrError,
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
      focused: false,
    });
  });
});

describe("send", () => {
  test("atomically writes and submits text with agent prompt", async () => {
    const { run, calls } = mockRunner((a) =>
      a[0] === "agent" && a[1] === "prompt"
        ? { stdout: JSON.stringify({ result: { type: "ok" } }) }
        : undefined,
    );
    const herd = createHerd(run);
    const res = await herd.send("rev-1", "do the thing");

    expect(res).toEqual({ target: "rev-1", paneId: null, submitted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["agent", "prompt", "rev-1", "do the thing"]);
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
  test("returns text from the JSON envelope and defaults to visible", async () => {
    const { run, calls } = mockRunner((a) =>
      a[1] === "read"
        ? {
            stdout: JSON.stringify({
              result: { read: { text: "line1\nline2\n" }, type: "pane_read" },
            }),
          }
        : undefined,
    );
    const herd = createHerd(run);
    const text = await herd.read("rev-1", { lines: 10 });
    expect(text).toBe("line1\nline2\n");
    const c = calls[0];
    expect(c[c.indexOf("--source") + 1]).toBe("visible");
    expect(c[c.indexOf("--lines") + 1]).toBe("10");
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
});
