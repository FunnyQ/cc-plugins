import { expect, test, type Engine } from "claude-code/testing";

import { xterm256 } from "./ansi";
import {
  CONFIG,
  eventually,
  startSession,
  find,
  within,
  ran,
} from "./test-session";

const CALL = (
  tool: "Edit" | "Write",
  input: Record<string, unknown>,
  more: Record<string, unknown> = {},
) =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "ToolUse",
    requestId: "e1",
    props: {
      tool_use_id: "e1",
      tool,
      input,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      ...more,
    },
    viewport: { columns: 60, rows: 40 },
  }) as never;

const PATCH = {
  oldStart: 9,
  oldLines: 3,
  newStart: 9,
  newLines: 3,
  lines: [" keep", "-const a = 1;", "+const a = 2;", " tail"],
};

const EDIT = (more: Record<string, unknown> = {}) =>
  CALL(
    "Edit",
    {
      file_path: "/src/a.txt",
      old_string: "const a = 1;",
      new_string: "const a = 2;",
    },
    { output: { filePath: "/src/a.txt", structuredPatch: [PATCH], ...more } },
  );

test("an Edit draws its path, its counts and each patch line numbered with its sign", async ($, on) => {
  await startSession($, on);
  const edit = EDIT();
  expect(await find($, edit, { key: "edit" })).toBeDefined();
  expect(
    await find($, edit, { type: "Text", text: /src\/a\.txt {2}\+1 −1/ }),
  ).toBeDefined();
  // a removed line takes its old number, every other line its new one
  expect(await within($, edit, "edit", /^ 9 {3}$/)).toBeDefined();
  expect(await within($, edit, "edit", /^10 - $/)).toBeDefined();
  expect(await within($, edit, "edit", /^10 \+ $/)).toBeDefined();
  expect(await within($, edit, "edit", /^const a = 2;$/)).toBeDefined();
});

test("added and removed lines sit on a tinted background", async ($, on) => {
  await startSession($, on);
  const added = (await within($, EDIT(), "edit", /^const a = 2;$/)) as {
    props?: { backgroundColor?: string };
  };
  const removed = (await within($, EDIT(), "edit", /^const a = 1;$/)) as {
    props?: { backgroundColor?: string };
  };
  const kept = (await within($, EDIT(), "edit", /^keep$/)) as {
    props?: { backgroundColor?: string };
  };
  expect(added.props?.backgroundColor).toBeDefined();
  expect(removed.props?.backgroundColor).toBeDefined();
  expect(added.props?.backgroundColor).not.toBe(removed.props?.backgroundColor);
  expect(kept.props?.backgroundColor).toBeUndefined();
});

test("two hunks are split by a divider", async ($, on) => {
  await startSession($, on);
  const second = {
    oldStart: 40,
    oldLines: 1,
    newStart: 40,
    newLines: 1,
    lines: ["-x", "+y"],
  };
  const edit = CALL(
    "Edit",
    { file_path: "/a.txt" },
    { output: { structuredPatch: [PATCH, second] } },
  );
  expect(await find($, edit, { type: "Text", text: /^├─+┤$/ })).toBeDefined();
  expect(await within($, edit, "edit", /^40 \+ $/)).toBeDefined();
});

const CREATE = (content: string) =>
  CALL(
    "Write",
    { file_path: "/new.txt", content },
    {
      output: {
        type: "create",
        filePath: "/new.txt",
        content,
        structuredPatch: [],
        originalFile: null,
      },
    },
  );

test("a Write that creates a short file draws all of it, numbered from line 1", async ($, on) => {
  await startSession($, on);
  const row = await $.ui.mount(CREATE("one\ntwo\n"));
  expect(await row.find({ key: "write" })).toBeDefined();
  expect(
    await row.find({ type: "Text", text: /new\.txt · new/ }),
  ).toBeDefined();
  expect(await row.find({ type: "Text", text: "1  " })).toBeDefined();
  expect(await row.find({ type: "Text", text: "two" })).toBeDefined();
  expect(await row.find({ key: "diff:more:row" })).toBeUndefined();
  // a new file has nothing to compare, so no line carries a sign or a tint
  expect(await row.find({ type: "Text", text: /\+/ })).toBeUndefined();
  await row.unmount();
});

test("a Write that creates a file taller than fold_lines shows its head and folds the rest", async ($, on) => {
  await startSession($, on);
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const row = await $.ui.mount(CREATE(`${lines.join("\n")}\n`));
  expect(await row.find({ type: "Text", text: "line 12" })).toBeDefined();
  expect(await row.find({ type: "Text", text: "line 13" })).toBeUndefined();
  expect((await row.find({ key: "diff:more" }))?.text.trim()).toBe(
    "▸ 8 more lines",
  );
  await row.press({ key: "diff:more" });
  expect(await row.find({ type: "Text", text: "line 20" })).toBeDefined();
  await row.press({ key: "diff:more" });
  expect(await row.find({ type: "Text", text: "line 13" })).toBeUndefined();
  await row.unmount();
});

test("a Write over an existing file draws its diff in the write rune's colour", async ($, on) => {
  await startSession($, on);
  const write = CALL(
    "Write",
    { file_path: "/a.txt", content: "const a = 2;" },
    { output: { type: "update", structuredPatch: [PATCH], originalFile: "x" } },
  );
  expect(await find($, write, { key: "write" })).toBeDefined();
  expect(await within($, write, "write", /^10 \+ $/)).toBeDefined();
  // a plus would read as a new file, so a replacement takes replace_icon
  expect(
    await find($, write, { type: "Text", text: /^\u{F11E7} {2}a\.txt/u }),
  ).toBeDefined();
  expect(await within($, write, "write", /^╰─+╯$/)).toMatchObject({
    props: { color: "#4f9a94" },
  });
});

test("a Write that changed nothing says so", async ($, on) => {
  await startSession($, on);
  const write = CALL(
    "Write",
    { file_path: "/same.txt", content: "x" },
    {
      output: {
        type: "update",
        filePath: "/same.txt",
        content: "x",
        structuredPatch: [],
        originalFile: "x",
      },
    },
  );
  expect(
    await find($, write, { type: "Text", text: "(no changes)" }),
  ).toBeDefined();
});

test("a diff taller than fold_lines folds to its head", async ($, on) => {
  await startSession($, on, {
    files: new Map([[CONFIG, "edit:\n  fold_lines: 2\n"]]),
  });
  expect(await find($, EDIT(), { key: "diff:2" })).toBeUndefined();
  expect(await find($, EDIT(), { key: "diff:more:row" })).toBeDefined();
});

test("an errored Edit draws the text the model read", async ($, on) => {
  await startSession($, on);
  const edit = CALL(
    "Edit",
    { file_path: "/a.txt" },
    { isErrored: true, output: "String to replace not found." },
  );
  expect(
    await find($, edit, { type: "Text", text: "String to replace not found." }),
  ).toBeDefined();
});

test("a known language goes through glow and its colours land on the matching lines", async ($, on) => {
  const stdins: string[] = [];
  await startSession($, on, {
    run: (e) => {
      stdins.push(e.init?.stdin ?? "");
      // glow's padding, then each code line under glow's margin and the block's indent; the blank first line is lost
      return ran(
        "\n  \n    \x1b[38;5;81mif\x1b[0m x\n        \x1b[38;5;81mreturn\x1b[0m\n  \n",
      );
    },
  });
  const edit = CALL(
    "Edit",
    { file_path: "/a.ts" },
    {
      output: {
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            lines: [" ", "+if x", " \treturn"],
          },
        ],
      },
    },
  );
  expect(
    await eventually(
      async () => (await within($, edit, "edit", /^return$/)) !== undefined,
    ),
  ).toBe(true);
  expect(stdins).toContain("```typescript\n\nif x\n    return\n```");
  expect(await within($, edit, "edit", /^if$/)).toMatchObject({
    props: { color: xterm256(81) },
  });
  // the code keeps its own indent once the block's goes
  expect(await within($, edit, "edit", /^ {4}$/)).toBeDefined();
});

test("glow output that does not line up with the patch is dropped for plain text", async ($, on) => {
  await startSession($, on, {
    run: () => ran("\n  \n    \x1b[38;5;81mone\x1b[0m\n  \n"),
  });
  const edit = CALL(
    "Edit",
    { file_path: "/a.ts" },
    {
      output: {
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 2,
            lines: ["+one", "+two"],
          },
        ],
      },
    },
  );
  await new Promise((r) => setTimeout(r, 20));
  expect(await within($, edit, "edit", /^two$/)).toBeDefined();
});

test("enabled.edit: false hands Edit to the engine and leaves Write drawn", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on, {
    files: new Map([[CONFIG, "edit:\n  enabled: false\n"]]),
  });
  expect(await find($, EDIT(), { key: "edit" })).toBeUndefined();
  expect(
    await find($, CALL("Write", { file_path: "/a", content: "" }), {
      key: "write",
    }),
  ).toBeDefined();
});

test("enabled.write: false hands Write to the engine", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on, {
    files: new Map([[CONFIG, "write:\n  enabled: false\n"]]),
  });
  expect(
    await find($, CALL("Write", { file_path: "/a", content: "" }), {
      key: "write",
    }),
  ).toBeUndefined();
  expect(await find($, EDIT(), { key: "edit" })).toBeDefined();
});

test("the engine's own result block under an Edit or Write is left empty, since the card draws it", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on);
  for (const tool of ["Edit", "Write"]) {
    const result = {
      plugin: "runes",
      surface: "terminal",
      component: "ToolResult",
      requestId: "e1",
      props: { tool_use_id: "e1", tool, output: { structuredPatch: [PATCH] } },
      viewport: { columns: 60, rows: 40 },
    } as never;
    expect(
      await find($, result, { type: "Text", text: "engine" }),
    ).toBeUndefined();
  }
});

test("the card draws at full colour, with no muted rest and no hover group", async ($, on) => {
  await startSession($, on);
  const card = await find($, EDIT(), { key: "edit" });
  expect(card?.props?.alignSelf).toBeUndefined();
  expect(await within($, EDIT(), "edit", /^╰─+╯$/)).toMatchObject({
    props: { color: "#b8954a" },
  });
});
