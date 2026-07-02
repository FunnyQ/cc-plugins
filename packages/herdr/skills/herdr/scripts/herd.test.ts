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
  test("writes literal text then presses Enter, re-resolving the pane", async () => {
    const { run, calls } = mockRunner((a) => {
      if (a[0] === "agent" && a[1] === "send")
        return { stdout: JSON.stringify({ result: { type: "ok" } }) };
      if (a[0] === "agent" && a[1] === "get")
        return { stdout: agentEnvelope({ name: "rev-1", pane_id: "w9:pB" }) };
      if (a[0] === "pane" && a[1] === "send-keys") return { stdout: "" }; // prints nothing
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.send("rev-1", "do the thing");

    expect(res).toEqual({ target: "rev-1", paneId: "w9:pB", submitted: true });
    expect(calls[0]).toEqual(["agent", "send", "rev-1", "do the thing"]);
    expect(calls[1]).toEqual(["agent", "get", "rev-1"]);
    expect(calls[2]).toEqual(["pane", "send-keys", "w9:pB", "enter"]);
  });

  test("--no-submit skips the Enter and pane resolution", async () => {
    const { run, calls } = mockRunner((a) =>
      a[1] === "send"
        ? { stdout: JSON.stringify({ result: { type: "ok" } }) }
        : undefined,
    );
    const herd = createHerd(run);
    const res = await herd.send("rev-1", "draft only", { submit: false });
    expect(res).toEqual({ target: "rev-1", paneId: null, submitted: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["agent", "send", "rev-1", "draft only"]);
  });
});

describe("spawn", () => {
  test("generates a unique name and starts the agent no-focus", async () => {
    const { run, calls } = mockRunner((a) => {
      if (a[1] === "list") return { stdout: listEnvelope([]) };
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
    });

    expect(res.name).toMatch(/^code-reviewer-[0-9a-f]{4}$/);
    expect(res.paneId).toBe("w1:pZ");
    expect(res.task).toBeUndefined();

    const startCall = calls.find((c) => c[1] === "start")!;
    expect(startCall).toContain("--no-focus");
    expect(startCall).toContain("--split");
    expect(startCall[startCall.indexOf("--split") + 1]).toBe("down");
    // name is passed as the third token, cwd forwarded, agent binary after `--`
    expect(startCall[2]).toBe(res.name);
    expect(startCall[startCall.indexOf("--cwd") + 1]).toBe("/repo");
    expect(startCall.slice(startCall.indexOf("--") + 1)).toEqual(["codex"]);
  });

  test("regenerates when the first candidate name collides", async () => {
    const { run } = mockRunner((a) => {
      if (a[1] === "list")
        return { stdout: listEnvelope([{ name: "worker-aaaa" }]) };
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

  test("with --task: waits then sends + submits", async () => {
    const seen: string[][] = [];
    const { run } = mockRunner((a) => {
      seen.push(a);
      if (a[1] === "list") return { stdout: listEnvelope([]) };
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
      if (a[0] === "agent" && a[1] === "send")
        return { stdout: JSON.stringify({ result: { type: "ok" } }) };
      if (a[1] === "get")
        return { stdout: agentEnvelope({ name: a[2], pane_id: "w2:p3" }) };
      if (a[0] === "pane" && a[1] === "send-keys") return { stdout: "" };
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
        (c) => c[0] === "agent" && c[1] === "send" && c[3] === "build X",
      ),
    ).toBe(true);
    expect(
      seen.some(
        (c) => c[0] === "pane" && c[1] === "send-keys" && c[3] === "enter",
      ),
    ).toBe(true);
  });

  test("with --task: sends even if the idle wait errors (non-agent binary)", async () => {
    const { run } = mockRunner((a) => {
      if (a[1] === "list") return { stdout: listEnvelope([]) };
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
      if (a[0] === "agent" && a[1] === "send")
        return { stdout: JSON.stringify({ result: { type: "ok" } }) };
      if (a[1] === "get")
        return { stdout: agentEnvelope({ name: a[2], pane_id: "w2:p3" }) };
      if (a[0] === "pane" && a[1] === "send-keys") return { stdout: "" };
      return undefined;
    });
    const herd = createHerd(run);
    const res = await herd.spawn({
      role: "shell",
      agent: "bash",
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

  test("no-submit is boolean and does not swallow the next token", () => {
    const { flags, positionals } = parseArgs([
      "rev-1",
      "--no-submit",
      "leftover",
    ]);
    expect(flags["no-submit"]).toBe(true);
    expect(positionals).toEqual(["rev-1", "leftover"]);
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
