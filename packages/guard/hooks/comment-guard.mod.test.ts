import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

const BLOCK = ["// one", "// two", "// three"];
const FILE = ["const a = 1;", ...BLOCK, "const b = 2;", ""].join("\n");

// Stands for the engine beneath the mod: the tool's answer, a file system in memory, and Jev. A noun answering a primitive answers `{ value }`.
function world(
  on: On,
  opts: {
    result: Record<string, unknown>;
    files?: Record<string, string>;
    jevWhy?: number;
  },
) {
  const files: Record<string, string> = { "/repo/a.ts": FILE, ...opts.files };
  const posts: string[] = [];
  mock.clock(on);
  mock.env(on, {
    GUARD_STATE_DIR: "/state",
    ...(opts.jevWhy === undefined ? {} : { TYPESAFE_API_KEY: "k" }),
  });
  on("tool.call", () => ({ result: opts.result, text: "ok" }) as never);
  on("session.id", () => ({ value: "sess/1" }) as never);
  on("fs.read", (_$, e) => {
    const text = files[e.path];
    if (text === undefined) throw new Error(`ENOENT ${e.path}`);
    return { value: text } as never;
  });
  on("fs.exists", (_$, e) => ({ value: e.path in files }) as never);
  on("fs.write", (_$, e) => {
    files[e.path] = e.text;
    return { value: undefined } as never;
  });
  on("http.fetch", (_$, e) => {
    posts.push(e.url);
    const { questions } = JSON.parse(e.init?.body ?? "{}");
    const answers = Object.fromEntries(
      Object.keys(questions).map((id) => [
        id,
        { probabilities: { why: opts.jevWhy, what: 1 - opts.jevWhy! } },
      ]),
    );
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: JSON.stringify({ answers }),
      },
    } as never;
  });
  return { files, posts };
}

const editResult = (structuredPatch: unknown[]) => ({
  filePath: "/repo/a.ts",
  oldString: "const a = 1;",
  newString: ["const a = 1;", ...BLOCK].join("\n"),
  originalFile: "const a = 1;\nconst b = 2;\n",
  structuredPatch,
  userModified: false,
  replaceAll: false,
});

const ADDING_BLOCK = [
  {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 5,
    lines: [" const a = 1;", ...BLOCK.map((l) => `+${l}`), " const b = 2;"],
  },
];

const edit = {
  tool: "Edit",
  file_path: "/repo/a.ts",
  old_string: "const a = 1;",
  new_string: ["const a = 1;", ...BLOCK].join("\n"),
} as const;

test("an Edit that adds a 3-line comment block hands the block back as context", async ($, on) => {
  const { files } = world(on, { result: editResult(ADDING_BLOCK) });
  const ran = await $.tool.call(edit);

  expect(ran.context).toHaveLength(1);
  const [reason] = ran.context!;
  expect(reason).toContain(
    "💬 comment-guard: 1 comment block(s), 3 lines, in a.ts.",
  );
  expect(reason).toContain("+ 2  // one");
  expect(reason).toContain("does it say why, or what?");

  const ledger = Object.entries(files).find(([p]) => p.startsWith("/state/"));
  expect(ledger?.[0]).toBe("/state/sess_1.reported.jsonl");
  expect(JSON.parse(ledger![1])).toEqual({ file: "/repo/a.ts", texts: BLOCK });
});

test("a second report appends to the ledger rather than replacing it", async ($, on) => {
  const { files } = world(on, { result: editResult(ADDING_BLOCK) });
  await $.tool.call(edit);
  await $.tool.call(edit);
  const ledger = Object.entries(files).find(([p]) => p.startsWith("/state/"));
  expect(ledger![1].trimEnd().split("\n")).toHaveLength(2);
});

test("an Edit that adds no comment line adds no context", async ($, on) => {
  const patch = [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      lines: [" const a = 1;", "+const c = 3;"],
    },
  ];
  world(on, { result: editResult(patch) });
  const ran = await $.tool.call(edit);
  expect(ran.context ?? []).toEqual([]);
});

test("a Write that creates a file sends no hunks, so the text path reports the block", async ($, on) => {
  world(on, {
    result: {
      type: "create",
      filePath: "/repo/a.ts",
      content: FILE,
      structuredPatch: [],
      originalFile: null,
    },
  });
  const ran = await $.tool.call({
    tool: "Write",
    file_path: "/repo/a.ts",
    content: FILE,
  });
  expect(ran.context).toHaveLength(1);
});

test("a Write that updates a file with an empty patch changed nothing and reports nothing", async ($, on) => {
  world(on, {
    result: {
      type: "update",
      filePath: "/repo/a.ts",
      content: FILE,
      structuredPatch: [],
      originalFile: FILE,
    },
  });
  const ran = await $.tool.call({
    tool: "Write",
    file_path: "/repo/a.ts",
    content: FILE,
  });
  expect(ran.context ?? []).toEqual([]);
});

test("a path outside the guard's policy is never read", async ($, on) => {
  world(on, {
    result: { ...editResult(ADDING_BLOCK), filePath: "/repo/docs/a.ts" },
    files: { "/repo/docs/a.ts": FILE },
  });
  const ran = await $.tool.call({ ...edit, file_path: "/repo/docs/a.ts" });
  expect(ran.context ?? []).toEqual([]);
});

test("Jev scoring every added line why withdraws the question", async ($, on) => {
  const { posts, files } = world(on, {
    result: editResult(ADDING_BLOCK),
    jevWhy: 0.95,
  });
  const ran = await $.tool.call(edit);
  expect(posts).toEqual(["https://api.typesafe.ai/v1/systemone"]);
  expect(ran.context ?? []).toEqual([]);
  // Still recorded: the sweep must not re-ask what Jev already cleared.
  expect(Object.keys(files).some((p) => p.startsWith("/state/"))).toBe(true);
});

test("Jev scoring a line what keeps the question", async ($, on) => {
  world(on, { result: editResult(ADDING_BLOCK), jevWhy: 0.3 });
  const ran = await $.tool.call(edit);
  expect(ran.context).toHaveLength(1);
});

test("Jev stalling past the timeout keeps the question", async ($, on) => {
  const clock = mock.clock(on);
  mock.env(on, { GUARD_STATE_DIR: "/state", TYPESAFE_API_KEY: "k" });
  on("session.id", () => ({ value: "s" }) as never);
  on("tool.call", () => ({ result: editResult(ADDING_BLOCK), text: "ok" }) as never);
  on("fs.read", (_$, e) => ({ value: e.path === "/repo/a.ts" ? FILE : "" }) as never);
  on("fs.exists", () => ({ value: false }) as never);
  on("fs.write", () => ({ value: undefined }) as never);
  on("http.fetch", () => new Promise<never>(() => {}));
  const call = $.tool.call(edit);
  await clock.advance(2_000);
  const ran = await call;
  expect(ran.context).toHaveLength(1);
});
