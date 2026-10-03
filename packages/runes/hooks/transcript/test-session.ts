import type { Hook, On } from "claude-code";
import type { Engine } from "claude-code/testing";

export const HOME = "/home/q";
export const CONFIG = `${HOME}/.config/q-lab/cc-plugins/runes/config.yaml`;

// the YAML subset the template uses; a line it cannot read fails the way bun's parser does
const fakeYaml = (text: string) => {
  const root: Record<string, unknown> = {};
  let section: Record<string, unknown> = root;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$|^\s*#.*$/, "");
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)([\w-]+):\s*(.*)$/);
    if (!m) return undefined;
    const [, indent, key, rest] = m;
    const value =
      rest === "true" ? true
      : rest === "false" ? false
      : /^\d+$/.test(rest) ? Number(rest)
      : rest.replace(/^"(.*)"$/, "$1");
    if (!indent && !rest) root[key] = section = {};
    else (indent ? section : root)[key] = value;
  }
  return root;
};

type Run = Parameters<Hook<"process.run">>;

// the kit has no store, fs, env or process; these stand in for the host's, and `run` answers every command but bun
export const fakeHost = (
  on: On,
  { files = new Map<string, string>(), run }: { files?: Map<string, string>; run?: (e: Run[1]) => unknown } = {},
) => {
  const store = new Map<string, unknown>();
  const toasts: string[] = [];
  on("store.get", (_$, e) => ({ value: store.get(e.key) }) as never);
  on("store.set", (_$, e) => {
    store.set(e.key, e.value);
    return { value: undefined } as never;
  });
  on("store.delete", (_$, e) => {
    store.delete(e.key);
    return { value: undefined } as never;
  });
  on("env.get", () => ({ value: HOME }) as never);
  on("fs.exists", (_$, e) => ({ value: files.has(e.path) }) as never);
  on("fs.read", (_$, e) => ({ value: files.get(e.path) }) as never);
  on("fs.write", (_$, e) => {
    files.set(e.path, e.text);
    return { value: undefined } as never;
  });
  on("ui.toast", (_$, e) => {
    toasts.push(e.text);
  });
  on("process.run", (_$, e, next) => {
    if (e.argv[0] !== "bun") return (run ? run(e) : next(e)) as never;
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
  return { files, store, toasts };
};

// session.start loads the config and launches the glow worker
export const startSession = async ($: Engine, on: On, opts?: Parameters<typeof fakeHost>[1]) => {
  const host = fakeHost(on, opts);
  on("session.start", (_$, e) => e as never);
  await $.session.start({
    cwd: "/",
    surface: "terminal",
    isInteractive: false,
  } as never);
  return host;
};

// the worker runs glow off the render path, so a test polls until its result lands
export const eventually = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
};
