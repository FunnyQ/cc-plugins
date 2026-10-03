import { expect, test, type Engine } from "claude-code/testing";

import { CONFIG, startSession, find } from "./test-session";

const READ = (
  input: Record<string, unknown>,
  more: Record<string, unknown> = {},
) =>
  ({
    plugin: "runes",
    surface: "terminal",
    component: "ToolUse",
    requestId: "r1",
    props: {
      tool_use_id: "r1",
      tool: "Read",
      input,
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      ...more,
    },
    viewport: { columns: 60, rows: 40 },
  }) as never;


const TEXT = (startLine: number, numLines: number, totalLines: number, content = "") => ({
  type: "text",
  file: { filePath: "/src/a.ts", content, numLines, startLine, totalLines },
});

test("a text read draws its path from the cwd and the lines it read", async ($, on) => {
  await startSession($, on);
  const read = READ({ file_path: "/src/a.ts" }, { output: TEXT(11, 20, 259) });
  expect(await find($, read, { key: "read" })).toBeDefined();
  expect(
    await find($, read, { type: "Text", text: /src\/a\.ts/ }),
  ).toBeDefined();
  expect(
    await find($, read, { type: "Text", text: "lines 11–30 of 259" }),
  ).toBeDefined();
});

test("an empty file says so", async ($, on) => {
  await startSession($, on);
  const read = READ({ file_path: "/a" }, { output: TEXT(1, 0, 0) });
  expect(
    await find($, read, { type: "Text", text: "empty file" }),
  ).toBeDefined();
});

test("an image read draws its size", async ($, on) => {
  await startSession($, on);
  const read = READ(
    { file_path: "/shot.png" },
    {
      output: {
        type: "image",
        file: {
          base64: "",
          type: "image/png",
          originalSize: 2048,
          dimensions: { originalWidth: 800, originalHeight: 600 },
        },
      },
    },
  );
  expect(
    await find($, read, { type: "Text", text: "image · 800×600 · 2 KB" }),
  ).toBeDefined();
});

test("a running read draws its path and no detail row", async ($, on) => {
  await startSession($, on);
  const read = READ({ file_path: "/src/a.ts" }, { isRunning: true });
  expect(
    await find($, read, { type: "Text", text: /src\/a\.ts · running/ }),
  ).toBeDefined();
  expect(await find($, read, { key: "read:0" })).toBeUndefined();
});

test("an errored read draws the text the model read", async ($, on) => {
  await startSession($, on);
  const read = READ(
    { file_path: "/nope" },
    { isErrored: true, output: "File does not exist." },
  );
  expect(
    await find($, read, { type: "Text", text: "File does not exist." }),
  ).toBeDefined();
});

test("enabled.read: false hands the row to the engine", async ($, on) => {
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text key="engine">engine</Text>;
  });
  await startSession($, on, {
    files: new Map([[CONFIG, "read:\n  enabled: false\n"]]),
  });
  const read = READ({ file_path: "/a" }, { output: TEXT(1, 1, 1) });
  expect(await find($, read, { key: "read" })).toBeUndefined();
  expect(await find($, read, { type: "Text", text: "engine" })).toBeDefined();
});

test("a text read folds its content away, and the detail row unfolds it, numbered from startLine", async ($, on) => {
  const stdins: string[] = [];
  await startSession($, on, { run: (e) => (stdins.push(e.init?.stdin ?? ""), { value: { exitCode: 1, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false } }) });
  const row = await $.ui.mount(READ({ file_path: "/a.txt" }, { output: TEXT(9, 2, 40, "alpha\n\tbeta\n") }));
  expect(await row.find({ type: "Text", text: "alpha" })).toBeUndefined();
  expect((await row.find({ key: "read:toggle" }))?.text.trim()).toBe("▸ lines 9–10 of 40");
  await row.press({ key: "read:toggle" });
  expect((await row.find({ key: "read:toggle" }))?.text.trim()).toBe("▾ lines 9–10 of 40");
  expect(await row.find({ type: "Text", text: " 9  " })).toBeDefined();
  expect(await row.find({ type: "Text", text: "alpha" })).toBeDefined();
  // a tab draws as four spaces, so the row's cells stay countable
  expect(await row.find({ type: "Text", text: "    beta" })).toBeDefined();
  await row.press({ key: "read:toggle" });
  expect(await row.find({ type: "Text", text: "alpha" })).toBeUndefined();
  await row.unmount();
  // a .txt has no language, and a folded card asks glow for nothing
  expect(stdins).toEqual([]);
});

test("the card draws at full colour, with no muted rest", async ($, on) => {
  await startSession($, on);
  const read = READ({ file_path: "/a" }, { output: TEXT(1, 1, 1) });
  expect(await find($, read, { type: "Text", text: /^╰─+╯$/ })).toMatchObject({ props: { color: "#6b8fb3" } });
});

test("an unfolded card ends in a fold row that folds it again", async ($, on) => {
  await startSession($, on);
  const row = await $.ui.mount(READ({ file_path: "/a.txt" }, { output: TEXT(1, 2, 2, "alpha\nbeta\n") }));
  expect(await row.find({ key: "read:end:more" })).toBeUndefined();
  await row.press({ key: "read:toggle" });
  expect((await row.find({ key: "read:end:more" }))?.text.trim()).toBe("▾ fold");
  await row.press({ key: "read:end:more" });
  expect(await row.find({ type: "Text", text: "alpha" })).toBeUndefined();
  await row.unmount();
});
