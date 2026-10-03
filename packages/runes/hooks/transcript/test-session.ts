import type { On } from "claude-code";
import type { Engine } from "claude-code/testing";

// session.start launches the glow worker; the kit has no store, so this stands in for the host's
export const startSession = async ($: Engine, on: On) => {
  const values = new Map<string, unknown>();
  on("store.get", (_$, e) => ({ value: values.get(e.key) }) as never);
  on("store.set", (_$, e) => {
    values.set(e.key, e.value);
    return { value: undefined } as never;
  });
  on("command.register", () => ({ value: undefined }) as never);
  on("session.start", (_$, e) => e as never);
  await $.session.start({
    cwd: "/",
    surface: "terminal",
    isInteractive: false,
  } as never);
};

// the worker runs glow off the render path, so a test polls until its result lands
export const eventually = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
};
