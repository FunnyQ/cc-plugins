import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

const TASK = "/repo/docs/feat/tasks/ui/01-shell.md";
const HEADER = "# UI-01\n\n> **Required reading** (read first):\n> - x\n";

// Stands for the engine beneath the mod: the tool's answer, a file system in memory, and the linter process. A noun answering a primitive answers `{ value }`.
function world(
  on: On,
  opts: {
    files?: Record<string, string>;
    exitCode?: number;
    result?: Record<string, unknown>;
  } = {},
) {
  const files: Record<string, string> = { [TASK]: HEADER, ...opts.files };
  const reads: string[] = [];
  const runs: (readonly string[])[] = [];
  on("tool.call", () => ({ result: opts.result ?? {}, text: "ok" }) as never);
  on("fs.read", (_$, e) => {
    reads.push(e.path);
    const text = files[e.path];
    if (text === undefined) throw new Error(`ENOENT ${e.path}`);
    return { value: text } as never;
  });
  on("process.run", (_$, e) => {
    runs.push(e.argv);
    return {
      value: {
        exitCode: opts.exitCode ?? 0,
        stdout: opts.exitCode ? "❌ missing ## Goal\n" : "",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    } as never;
  });
  return { reads, runs };
}

const write = (file_path: string) =>
  ({ tool: "Write", file_path, content: HEADER }) as const;

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

test("a path outside a tasks tree is never read", async ($, on) => {
  const { reads, runs } = world(on, { files: { "/repo/a.md": HEADER } });
  await $.tool.call(write("/repo/a.md"));
  await $.tool.call(write("/repo/docs/feat/tasks/ui/notes.md"));
  expect(reads).toEqual([]);
  expect(runs).toEqual([]);
});

test("a task-shaped path without the Required-reading header is not linted", async ($, on) => {
  const { reads, runs } = world(on, { files: { [TASK]: "# just notes\n" } });
  await $.tool.call(write(TASK));
  expect(reads).toEqual([TASK]);
  expect(runs).toEqual([]);
});

test("a near-miss header label is not linted", async ($, on) => {
  const { runs } = world(on, {
    files: { [TASK]: "> **Required reading later**:\n" },
  });
  await $.tool.call(write(TASK));
  expect(runs).toEqual([]);
});

test("an edit held for review is not linted", async ($, on) => {
  const { reads } = world(on, { result: { staged: true } });
  await $.tool.call(write(TASK));
  expect(reads).toEqual([]);
});
