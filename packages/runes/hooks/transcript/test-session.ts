import type { Hook, On } from "claude-code";
import type { Engine } from "claude-code/testing";

export const HOME = "/home/q";
export const CONFIG = `${HOME}/.config/q-lab/cc-plugins/runes/config.yaml`;

// the YAML subset the template uses, nested by indent; a header with no children reads as null, as bun's parser has it,
// and a line it cannot read fails the way bun's parser does
const fakeYaml = (text: string) => {
  const root: Record<string, unknown> = {};
  const stack: { indent: number; map: Record<string, unknown>; parent?: Record<string, unknown>; key?: string }[] = [
    { indent: -1, map: root },
  ];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$|^\s*#.*$/, "");
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!m) return undefined;
    const [, lead, key, rest] = m;
    const indent = lead!.length;
    while (stack.length > 1 && indent <= stack.at(-1)!.indent) stack.pop();
    const top = stack.at(-1)!;
    if (top.parent && top.key !== undefined) top.parent[top.key] = top.map;
    if (!rest) {
      top.map[key!] = null;
      stack.push({ indent, map: {}, parent: top.map, key });
      continue;
    }
    top.map[key!] =
      rest === "true" ? true
      : rest === "false" ? false
      : /^\d+$/.test(rest!) ? Number(rest)
      : rest!.replace(/^"(.*)"$/, "$1");
  }
  return root;
};

type Run = Parameters<Hook<"process.run">>;

// the kit has no store, fs, env or process; these stand in for the host's, and `run` answers every command but the YAML parse
export const fakeHost = (
  on: On,
  {
    files = new Map<string, string>(),
    run,
    env = {},
    messages = [],
  }: { files?: Map<string, string>; run?: (e: Run[1]) => unknown; env?: Record<string, string>; messages?: unknown[] } = {},
) => {
  const store = new Map<string, unknown>();
  const toasts: string[] = [];
  const registered: Record<string, unknown>[] = [];
  on("agent.register", (_$, e) => {
    registered.push(e as never);
    return { value: { agent: `runes:${e.name}` } } as never;
  });
  on("store.get", (_$, e) => ({ value: store.get(e.key) }) as never);
  on("store.set", (_$, e) => {
    store.set(e.key, e.value);
    return { value: undefined } as never;
  });
  on("store.delete", (_$, e) => {
    store.delete(e.key);
    return { value: undefined } as never;
  });
  on("env.get", (_$, e) => ({ value: env[e.name] ?? (e.name === "HOME" ? HOME : undefined) }) as never);
  on("fs.exists", (_$, e) => ({ value: files.has(e.path) }) as never);
  on("fs.read", (_$, e) => ({ value: files.get(e.path) }) as never);
  on("fs.write", (_$, e) => {
    files.set(e.path, e.text);
    return { value: undefined } as never;
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
    return { value: undefined } as never;
  });
  on("process.run", (_$, e, next) => {
    if (e.argv[0] !== "bun" || e.argv[1] !== "-e") return (run ? run(e) : next(e)) as never;
    const parsed = fakeYaml(e.init?.stdin ?? "");
    return {
      value: {
        exitCode: parsed ? 0 : 1,
        stdout: parsed ? JSON.stringify(parsed) : "",
        stderr: parsed ? "" : "SyntaxError: YAML Parse error: Unexpected token",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never;
  });
  on("command.register", () => ({ value: undefined }) as never);
  on("session.messages", () => ({ value: messages }) as never);
  return { files, store, toasts, registered };
};

export const startSession = async ($: Engine, on: On, opts?: Parameters<typeof fakeHost>[1]) => {
  const host = fakeHost(on, opts);
  on("session.start", (_$, e) => e as never);
  const beneath: string[] = [];
  for (const component of ["UserMessage", "AssistantMessage"] as const)
    on("ui.render", { component }, (_$, e) => {
      beneath.push(e.requestId);
      return { type: "Text", props: {}, children: ["engine"] } as never;
    });
  await $.session.start({
    cwd: "/",
    surface: "terminal",
    isInteractive: false,
  } as never);
  return Object.assign(host, { beneath });
};

export const eventually = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
};

type Mounted = Awaited<ReturnType<Engine["ui"]["mount"]>>;

export const find = async (
  $: Engine,
  event: never,
  query: Parameters<Mounted["find"]>[0],
) => {
  const row = await $.ui.mount(event);
  const found = await row.find(query);
  await row.unmount();
  return found;
};

type Node = { children?: unknown[] };
// find() drops an element's own hover, which sits beside its props; its children keep theirs
export const within = async ($: Engine, event: never, key: string, text: RegExp) => {
  const walk = (n: Node): Node | undefined => {
    for (const c of n.children ?? []) {
      if (typeof c !== "object" || c === null) continue;
      const own = ((c as Node).children ?? []).filter((x) => typeof x === "string");
      if (own.length && text.test(own.join(""))) return c as Node;
      const hit = walk(c as Node);
      if (hit) return hit;
    }
    return undefined;
  };
  const card = await find($, event, { key });
  return card ? walk(card) : undefined;
};

export const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false },
});
