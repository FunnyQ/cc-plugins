import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { BACKENDS } from ".";
import type { InvokeOpts, Mode } from "../types";

const MODES: Mode[] = ["delegate", "review", "image"];
const OPTS: InvokeOpts[] = [
  {},
  {
    model: "m",
    effort: "high",
    dangerous: true,
    task: "t",
    promptText: "p",
    lastFile: "/tmp/raw.txt",
    out: "/tmp/out.png",
  },
];

const cases = Object.values(BACKENDS).flatMap((backend) =>
  MODES.filter((mode) => backend.supports.has(mode)).flatMap((mode) =>
    OPTS.map((opts) => ({ backend, mode, opts })),
  ),
);

describe("every backend", () => {
  it("keeps headless exec/-p/-o forms out of its live argv", () => {
    const offenders = cases.flatMap(({ backend, mode, opts }) => {
      const argv = backend.invokeLive?.(mode, opts)?.argv ?? [];
      return argv
        .filter((arg) => ["exec", "-p", "-o"].includes(arg))
        .map((arg) => `${backend.name} ${mode}: ${arg}`);
    });
    expect(offenders).toEqual([]);
  });

  describe("builds argv without spawning", () => {
    const original = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };

    beforeEach(() => {
      const refuse = () => {
        throw new Error("backend spawned a process");
      };
      Bun.spawn = refuse as unknown as typeof Bun.spawn;
      Bun.spawnSync = refuse as unknown as typeof Bun.spawnSync;
    });

    afterEach(() => {
      Bun.spawn = original.spawn;
      Bun.spawnSync = original.spawnSync;
    });

    it("in invoke and invokeLive", () => {
      for (const { backend, mode, opts } of cases) {
        expect(() => backend.invoke(mode, opts)).not.toThrow();
        expect(() => backend.invokeLive?.(mode, opts)).not.toThrow();
      }
    });
  });
});
