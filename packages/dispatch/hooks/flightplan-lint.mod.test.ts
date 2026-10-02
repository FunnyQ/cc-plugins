import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

const TASK = "/repo/docs/feat/tasks/ui/01-shell.md";

// Stands for the engine beneath the mod: the tool's answer and the linter process. A noun answering a primitive answers `{ value }`.
function world(
  on: On,
  opts: { exitCode?: number; result?: Record<string, unknown> } = {},
) {
  const runs: (readonly string[])[] = [];
  on("tool.call", () => ({ result: opts.result ?? {}, text: "ok" }) as never);
  on("process.run", (_$, e) => {
    runs.push(e.argv);
    return {
      value: {
        exitCode: opts.exitCode ?? 0,
        stdout: "",
        stderr: opts.exitCode ? "❌ missing ## Goal\n" : "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never;
  });
  return { runs };
}

const write = (file_path: string) =>
  ({ tool: "Write", file_path, content: "x" }) as const;

test("a task file with violations hands the linter output back as context", async ($, on) => {
  const { runs } = world(on, { exitCode: 1 });
  const ran = await $.tool.call(write(TASK));

  expect(runs).toHaveLength(1);
  expect(runs[0]![0]).toBe("bun");
  expect(runs[0]!.slice(-2)).toEqual(["--authoring", TASK]);
  expect(runs[0]![1]).toEndWith("/skills/flightplan/scripts/lint-task.ts");
  expect(ran.context).toEqual([
    `flightplan lint violations in ${TASK}:\n❌ missing ## Goal`,
  ]);
});

test("a clean task file adds no context", async ($, on) => {
  const { runs } = world(on, { exitCode: 0 });
  const ran = await $.tool.call(write(TASK));
  expect(runs).toHaveLength(1);
  expect(ran.context ?? []).toEqual([]);
});

test("a path outside a tasks tree spawns nothing", async ($, on) => {
  const { runs } = world(on);
  await $.tool.call(write("/repo/a.md"));
  await $.tool.call(write("/repo/docs/feat/tasks/ui/notes.md"));
  expect(runs).toEqual([]);
});

test("an edit held for review is not linted", async ($, on) => {
  const { runs } = world(on, { result: { staged: true } });
  await $.tool.call(write(TASK));
  expect(runs).toEqual([]);
});
