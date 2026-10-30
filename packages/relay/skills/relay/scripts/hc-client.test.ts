import { describe, expect, it } from "bun:test";
import { createHcClient, type HcRunner } from "./hc-client";

function fake(answer: (cmd: string[]) => unknown = () => ({})) {
  const calls: string[][] = [];
  const run: HcRunner = async (cmd) => {
    calls.push(cmd);
    const out = answer(cmd);
    return typeof out === "string" ? out : JSON.stringify(out);
  };
  return { run, calls };
}

describe("createHcClient", () => {
  it("places the pane in the caller's space and tab from its own labels", async () => {
    const { run } = fake(() => ({
      labels: { "herdr.space": "sp1", "herdr.tab": "tb1" },
    }));
    const client = createHcClient({ HC_TERMINAL_ID: "t46" }, run);
    expect(await client.callerLocation()).toEqual({
      workspaceId: "sp1",
      tabId: "tb1",
      paneId: "t46",
      source: "env",
    });
  });

  it("spawns a named, silent hc terminal in a new tab of that space, env riding the argv", async () => {
    const { run, calls } = fake((cmd) => {
      if (cmd[1] === "run")
        return { address: "t9", name: cmd[cmd.indexOf("--name") + 1] };
      if (cmd[0] === "herdr-app" && cmd[1] === "ls")
        return {
          spaces: [{ tabs: [{ id: "tb9", terminals: [{ terminal: "t9" }] }] }],
        };
      return {};
    });
    const client = createHcClient({ HC_TERMINAL_ID: "t46" }, run, () => "8b6f");
    const { name } = await client.spawn({
      role: "relay-codex-delegate",
      agent: "/usr/local/bin/codex",
      argv: ["-c", "check_for_update_on_startup=false"],
      env: ["RELAY_DELEGATED=1"],
      cwd: "/p/app",
      workspace: "sp1",
      newTab: true,
    });
    expect(name).toBe("relay-codex-delegate-8b6f");
    expect(calls[0]).toEqual([
      "hc",
      "run",
      "--bg",
      "--json",
      "--no-notify",
      "--rm",
      "--name",
      "relay-codex-delegate-8b6f",
      "--cwd",
      "/p/app",
      "--label",
      "herdr.space=sp1",
      "env",
      "RELAY_DELEGATED=1",
      "/usr/local/bin/codex",
      "--no-daemon",
      "-c",
      "check_for_update_on_startup=false",
    ]);
    expect(calls.at(-1)).toEqual([
      "herdr-app",
      "do",
      "tab.rename",
      JSON.stringify({ id: "tb9", name: "relay-codex-delegate-8b6f" }),
    ]);
  });

  it("reports a never-reported status as unknown, and a reported one by its state", async () => {
    const { run } = fake((cmd) =>
      cmd[3] === "a"
        ? { status: null }
        : { status: { app: "codex", state: "done" } },
    );
    const client = createHcClient({ HC_TERMINAL_ID: "t46" }, run);
    expect((await client.get("a")).status).toBe("unknown");
    expect((await client.get("b")).status).toBe("done");
  });

  it("refuses to send into a terminal still on a startup dialog, since Enter would answer it", async () => {
    const { run, calls } = fake(() => ({ status: null }));
    const client = createHcClient({ HC_TERMINAL_ID: "t46" }, run);
    await expect(client.send("a", "go")).rejects.toThrow(/startup dialog/);
    expect(calls.some((c) => c[1] === "send")).toBe(false);
  });

  it("sends text after `--`, so a leading dash stays text", async () => {
    const { run, calls } = fake(() => ({ status: { state: "idle" } }));
    await createHcClient({ HC_TERMINAL_ID: "t46" }, run).send("a", "-x go");
    expect(calls.at(-1)).toEqual(["hc", "send", "--json", "--", "a", "-x go"]);
  });

  it("maps keys, read, wait and close onto hc", async () => {
    const { run, calls } = fake((cmd) => (cmd[1] === "read" ? "screen" : {}));
    const client = createHcClient({ HC_TERMINAL_ID: "t46" }, run);
    await client.keys("a", "ctrl+a", "ctrl+k");
    expect(await client.read("a")).toBe("screen");
    await client.wait("a", { timeoutMs: 20_000 });
    await client.close("a");
    expect(calls).toEqual([
      ["hc", "keys", "a", "ctrl+a", "ctrl+k"],
      ["hc", "read", "--lines", "60", "a"],
      ["hc", "wait", "--json", "a", "--timeout", "20"],
      ["hc", "kill", "--json", "a"],
    ]);
  });
});

describe("createHcClient timing", () => {
  it("waits for herdr-app to show the new terminal before naming its tab", async () => {
    let lists = 0;
    const { run, calls } = fake((cmd) => {
      if (cmd[1] === "run") return { address: "t9" };
      if (cmd[0] === "herdr-app" && cmd[1] === "ls") {
        lists++;
        return lists < 3
          ? { spaces: [] }
          : { spaces: [{ tabs: [{ id: "tb9", terminals: [{ terminal: "t9" }] }] }] };
      }
      return {};
    });
    const client = createHcClient({ HC_TERMINAL_ID: "t46" }, run, () => "ab12", async () => {});
    await client.spawn({ role: "relay-claude-delegate", agent: "claude", workspace: "sp1" });
    expect(calls.at(-1)?.[2]).toBe("tab.rename");
  });

  it("treats a pane --rm already removed on kill as closed", async () => {
    const client = createHcClient({ HC_TERMINAL_ID: "t46" }, async () => {
      throw new Error("t9 was removed");
    });
    await expect(client.close("t9")).resolves.toBeDefined();
  });
});
