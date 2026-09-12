import { describe, expect, test } from "bun:test";
import {
  addedCommentLines,
  commentFlags,
  flaggedBlocks,
  formatReason,
  isGuardedPath,
  patchLines,
  resolveAdded,
  syntaxFor,
} from "./comment-guard.ts";
import type { Syntax } from "./comment-guard.ts";

const rb = syntaxFor("a/user.rb")!;
const ts = syntaxFor("a/app.ts")!;
const html = syntaxFor("a/page.html")!;
const lua = syntaxFor("a/a.lua")!;

const flagsOf = (text: string, syntax: Syntax) =>
  commentFlags(
    text.split("\n").map((l) => l.trim()),
    syntax,
  );

describe("syntaxFor", () => {
  test("maps each family to its comment forms", () => {
    expect(syntaxFor("a/user.rb")).toEqual({ line: ["#"], block: [] });
    expect(syntaxFor("a/app.ts")).toEqual({
      line: ["//"],
      block: [["/*", "*/"]],
    });
    expect(syntaxFor("a/q.sql")).toEqual({
      line: ["--"],
      block: [["/*", "*/"]],
    });
    expect(syntaxFor("a/page.html")).toEqual({
      line: [],
      block: [["<!--", "-->"]],
    });
    expect(syntaxFor("a/a.lua")).toEqual({
      line: ["--"],
      block: [["--[[", "]]"]],
    });
  });

  test("plain CSS has no line comment", () => {
    expect(syntaxFor("a/main.css")!.line).toEqual([]);
    expect(syntaxFor("a/main.scss")!.line).toEqual(["//"]);
  });

  test("a single-file component carries markup and script forms", () => {
    const vue = syntaxFor("a/App.vue")!;
    expect(vue.line).toEqual(["//"]);
    expect(vue.block).toEqual([
      ["/*", "*/"],
      ["<!--", "-->"],
    ]);
    expect(syntaxFor("a/App.svelte")).toEqual(vue);
    expect(syntaxFor("a/p.astro")).toEqual(vue);
  });

  test("an ERB comment is a pair, not a line marker", () => {
    expect(syntaxFor("a/v.erb")).toEqual({
      line: [],
      block: [
        ["<%#", "%>"],
        ["<!--", "-->"],
      ],
    });
  });

  test.each([
    "a/Rakefile",
    "a/Gemfile",
    "a/Makefile",
    "a/Dockerfile",
    "a/Dockerfile.dev",
    "a/Dockerfile.DEV",
    "a/MAKEFILE",
    "a/.env",
    "a/.env.local",
  ])("matches %s on its name, not an extension", (path) => {
    expect(syntaxFor(path)).toEqual({ line: ["#"], block: [] });
  });

  test("returns null for an extension it does not know", () => {
    expect(syntaxFor("a/README.md")).toBeNull();
    expect(syntaxFor("a/data.cfg")).toBeNull();
    expect(syntaxFor("/a.b/LICENSE")).toBeNull();
  });

  test("ignores a dot in a directory name", () => {
    expect(syntaxFor("/a.b/Makefile")).not.toBeNull();
  });
});

describe("isGuardedPath", () => {
  // Policy, not lookup — `syntaxFor` still answers for a `/docs/` .py file.
  test("excludes prose files and anything under /docs/", () => {
    expect(isGuardedPath("repo/docs/gen.py")).toBe(false);
    expect(isGuardedPath("a/README.md")).toBe(false);
    expect(isGuardedPath("a/notes.txt")).toBe(false);
    expect(isGuardedPath("a/data.json")).toBe(false);
    expect(isGuardedPath("a/Dockerfile.md")).toBe(false);
  });

  test("admits everything else, including files it has no syntax for", () => {
    expect(isGuardedPath("a/user.rb")).toBe(true);
    expect(isGuardedPath("a/data.cfg")).toBe(true);
    expect(syntaxFor("repo/docs/gen.py")).not.toBeNull();
  });

  test("matches docs as a path segment, not a substring", () => {
    expect(isGuardedPath("docs/gen.py")).toBe(false);
    expect(isGuardedPath("a/mydocs/gen.py")).toBe(true);
    expect(isGuardedPath("a/docsite/gen.py")).toBe(true);
  });

  test("excludes third-party and generated trees", () => {
    expect(isGuardedPath("a/vendor/chart.js")).toBe(false);
    expect(isGuardedPath("a/node_modules/x/i.js")).toBe(false);
    expect(isGuardedPath("dist/vendor/mermaid.min.js")).toBe(false);
    expect(isGuardedPath("dist/app.min.css")).toBe(false);
    expect(isGuardedPath("dist/modules/diagram.js")).toBe(true);
  });
});

describe("commentFlags", () => {
  test("a docblock counts its full height, not just the opener", () => {
    expect(flagsOf("/**\n * why\n */\nconst a = 1;", ts)).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  test("a star line outside a block is code, not a comment", () => {
    expect(flagsOf("*ptr = 0;\n  * factor;", ts)).toEqual([false, false]);
  });

  test("a one-line block comment does not open a run", () => {
    expect(flagsOf("/* why */\nconst a = 1;\n * factor;", ts)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("a trailing marker inside a string is not a comment", () => {
    expect(flagsOf('const u = "http://example.com"', ts)).toEqual([false]);
  });

  test("a language without block markers never opens one", () => {
    expect(flagsOf("# why\nx = a /* b\ny = 2", rb)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("an HTML comment counts its full height", () => {
    expect(
      flagsOf("<p>x</p>\n<!--\n  one\n  two\n-->\n<p>y</p>", html),
    ).toEqual([false, true, true, true, true, false]);
  });

  test("a Lua long comment counts its full height", () => {
    expect(
      flagsOf("local a = 1\n--[[\n  one\n  two\n]]\nlocal b = 2", lua),
    ).toEqual([false, true, true, true, true, false]);
  });

  test("a Lua line comment does not open a long comment", () => {
    expect(flagsOf("-- why\nlocal a = 1", lua)).toEqual([true, false]);
  });

  test("a one-line HTML comment does not open a run", () => {
    expect(flagsOf("<!-- why -->\n<p>x</p>", html)).toEqual([true, false]);
  });

  test("a Rust doc comment run counts every line", () => {
    expect(flagsOf("fn a() {}\n/// one\n//! two\nfn b() {}", ts)).toEqual([
      false,
      true,
      true,
      false,
    ]);
  });
});

describe("addedCommentLines", () => {
  test("Write returns every comment in the content", () => {
    const hits = addedCommentLines(
      "Write",
      { content: "# one\nx = 1\n# two" },
      rb,
    );
    expect(hits).toEqual(["# one", "# two"]);
  });

  test("Edit returns comments the old string did not have", () => {
    const hits = addedCommentLines(
      "Edit",
      {
        old_string: "def bump\n  @n += 1",
        new_string: "# Increment the counter\ndef bump\n  @n += 1",
      },
      rb,
    );
    expect(hits).toEqual(["# Increment the counter"]);
  });

  test("Edit with no new comment is silent", () => {
    expect(
      addedCommentLines(
        "Edit",
        { old_string: "  a + b", new_string: "  a + b + 0" },
        rb,
      ),
    ).toEqual([]);
  });

  test("moving an existing comment is not an addition", () => {
    const hits = addedCommentLines(
      "Edit",
      { old_string: "# why\ndef a\nend", new_string: "def a\n  # why\nend" },
      rb,
    );
    expect(hits).toEqual([]);
  });

  test("rewording a comment counts as an addition", () => {
    const hits = addedCommentLines(
      "Edit",
      { old_string: "# why", new_string: "# why, revised" },
      rb,
    );
    expect(hits).toEqual(["# why, revised"]);
  });

  test("duplicating a comment reports only the extra copy", () => {
    const hits = addedCommentLines(
      "Edit",
      { old_string: "# tag", new_string: "# tag\nx\n# tag" },
      rb,
    );
    expect(hits).toEqual(["# tag"]);
  });

  test("a trailing marker inside a string is not a comment", () => {
    expect(
      addedCommentLines(
        "Write",
        { content: 'const u = "http://example.com"' },
        ts,
      ),
    ).toEqual([]);
  });

  test("indented comments are matched and trimmed", () => {
    expect(addedCommentLines("Write", { content: "    # deep" }, rb)).toEqual([
      "# deep",
    ]);
  });

  test("a docblock contributes every line it spans", () => {
    expect(
      addedCommentLines(
        "Write",
        { content: "/**\n * why\n */\nconst a = 1;" },
        ts,
      ),
    ).toEqual(["/**", "* why", "*/"]);
  });
});

describe("flaggedBlocks", () => {
  const file = [
    "def a", // 1
    "  # one", // 2
    "  # two", // 3
    "  # three", // 4
    "  a + 1", // 5
    "end", // 6
  ].join("\n");

  test("reports a three-line block the edit added", () => {
    const blocks = flaggedBlocks(file, rb, ["# one", "# two", "# three"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.start).toBe(2);
    expect(blocks[0]!.lines).toEqual(["# one", "# two", "# three"]);
    expect(blocks[0]!.added).toEqual([true, true, true]);
  });

  test("a block reports on its final size, not the count added", () => {
    const blocks = flaggedBlocks(file, rb, ["# three"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.added).toEqual([false, false, true]);
  });

  test("a two-line block never fires", () => {
    const short = "def a\n  # one\n  # two\n  a + 1\nend";
    expect(flaggedBlocks(short, rb, ["# one", "# two"])).toEqual([]);
  });

  test("a long block nobody touched never fires", () => {
    expect(flaggedBlocks(file, rb, [])).toEqual([]);
  });

  test("the file-header block is exempt", () => {
    const headed = "#!/usr/bin/env ruby\n\n# one\n# two\n# three\n\ndef a\nend";
    expect(flaggedBlocks(headed, rb, ["# one", "# two", "# three"])).toEqual(
      [],
    );
  });

  test("the same block after the header still fires", () => {
    const headed = [
      "# head one",
      "# head two",
      "# head three",
      "def a",
      "  # one",
      "  # two",
      "  # three",
      "end",
    ].join("\n");
    const blocks = flaggedBlocks(headed, rb, ["# one", "# two", "# three"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.start).toBe(5);
  });

  test("an added line spent inside an exempt block does not mark a later twin", () => {
    const twins = [
      "# note",
      "# head two",
      "# head three",
      "def a",
      "  # note",
      "  # two",
      "  # three",
      "end",
    ].join("\n");
    // One "# note" was added; the header block consumes it, so the later block
    // has no added line of its own left to claim.
    expect(flaggedBlocks(twins, rb, ["# note"])).toEqual([]);
  });

  test("a docblock is sized by the lines it spans", () => {
    const doc = "const a = 1;\n/**\n * why\n */\nconst b = 2;";
    const blocks = flaggedBlocks(doc, ts, ["/**", "* why", "*/"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.start).toBe(2);
    expect(blocks[0]!.lines).toEqual(["/**", "* why", "*/"]);
  });

  test("adjacent runs of different markers form one block", () => {
    const mixed = "const a = 1;\n/* why */\n// more\n// still\nconst b = 2;";
    const blocks = flaggedBlocks(mixed, ts, ["// more"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines).toEqual(["/* why */", "// more", "// still"]);
  });

  test("reports every qualifying block in the file", () => {
    const two = [
      "def a",
      "  # a one",
      "  # a two",
      "  # a three",
      "end",
      "def b",
      "  # b one",
      "  # b two",
      "  # b three",
      "end",
    ].join("\n");
    const blocks = flaggedBlocks(two, rb, ["# a one", "# b three"]);
    expect(blocks.map((b) => b.start)).toEqual([2, 7]);
  });
});

describe("patchLines", () => {
  const numbers = (patch: Parameters<typeof patchLines>[0]) =>
    patchLines(patch).added.map((a) => a.n);

  test("numbers the added lines of a hunk and strips the marker", () => {
    const patch = [
      { newStart: 1, lines: ["+// probe", " export const a = 1;"] },
    ];
    expect(patchLines(patch).added).toEqual([{ n: 1, text: "// probe" }]);
  });

  test("a removed line consumes no line in the new file", () => {
    const patch = [
      { newStart: 10, lines: [" keep", "-gone", "-also gone", "+fresh"] },
    ];
    expect(numbers(patch)).toEqual([11]);
    expect(patchLines(patch).removed).toEqual(["gone", "also gone"]);
  });

  test("the no-newline annotation is not a line", () => {
    const patch = [
      {
        newStart: 1,
        lines: [" a", "\\ No newline at end of file", "+b"],
      },
    ];
    expect(numbers(patch)).toEqual([2]);
  });

  test("every hunk contributes", () => {
    const patch = [
      { newStart: 1, lines: ["+one"] },
      { newStart: 40, lines: [" ctx", "+two", "+three"] },
    ];
    expect(numbers(patch)).toEqual([1, 41, 42]);
  });

  test("an empty patch marks nothing", () => {
    expect(patchLines([])).toEqual({ added: [], removed: [] });
  });
});

describe("resolveAdded", () => {
  const patch = [{ newStart: 2, lines: [" const a = 1;", "+// why"] }];

  test("gives line numbers when the file still matches the diff", () => {
    const onDisk = ["const x = 0;", "const a = 1;", "// why", "const b = 2;"];
    expect(resolveAdded(patch, onDisk)).toEqual(new Set([3]));
  });

  // A formatter hook sharing this PostToolUse event can reflow the file in
  // parallel, which shifts every line the diff named.
  test("falls back to text when a parallel write shifted the lines", () => {
    const reflowed = ["const x =", "  0;", "const a = 1;", "// why"];
    expect(resolveAdded(patch, reflowed)).toEqual(["// why"]);
  });

  // Wrapping code in an `if` rewrites every line inside it, so the diff shows
  // the whole block removed and re-added at a deeper indent.
  test("re-indenting a block adds nothing", () => {
    const reindent = [
      {
        newStart: 2,
        lines: [
          "-  // one",
          "-  // two",
          "-  go();",
          "+  if (x) {",
          "+    // one",
          "+    // two",
          "+    go();",
          "+  }",
        ],
      },
    ];
    const after = [
      "function f() {",
      "if (x) {",
      "// one",
      "// two",
      "go();",
      "}",
    ];
    expect(resolveAdded(reindent, after)).toEqual(new Set([2, 6]));
  });

  test("rewording a moved comment is still an addition", () => {
    const reworded = [
      { newStart: 2, lines: ["-  // one", "+  // one, revised"] },
    ];
    const after = ["const a = 1;", "// one, revised"];
    expect(resolveAdded(reworded, after)).toEqual(new Set([2]));
  });

  test("adding a second copy of an existing comment still counts", () => {
    const dupe = [{ newStart: 3, lines: [" const b = 2;", "+// note"] }];
    const after = ["// note", "const a = 1;", "const b = 2;", "// note"];
    expect(resolveAdded(dupe, after)).toEqual(new Set([4]));
  });
});

describe("flaggedBlocks by line number", () => {
  // Two identical comment texts; only the second copy is new. The text path has
  // to guess and marks the first, which is the reason the diff path exists.
  const twins = [
    "const a = 1;", // 1
    "// note", // 2
    "// b", // 3
    "// c", // 4
    "const x = 2;", // 5
    "// note", // 6
    "// b", // 7
    "// c", // 8
  ].join("\n");

  test("a line number marks the copy that actually changed", () => {
    const blocks = flaggedBlocks(twins, ts, new Set([6]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.start).toBe(6);
    expect(blocks[0]!.added).toEqual([true, false, false]);
  });

  test("the text fallback marks the earlier twin instead", () => {
    const blocks = flaggedBlocks(twins, ts, ["// note"]);
    expect(blocks[0]!.start).toBe(2);
  });

  test("a line number landing on code marks nothing", () => {
    expect(flaggedBlocks(twins, ts, new Set([5]))).toEqual([]);
  });

  test("the header stays exempt under line numbers too", () => {
    const headed = "// one\n// two\n// three\nconst a = 1;";
    expect(flaggedBlocks(headed, ts, new Set([1, 2, 3]))).toEqual([]);
  });
});

describe("flaggedBlocks across a blank line", () => {
  const para = [
    "def a", // 1
    "  # one", // 2
    "  # two", // 3
    "", // 4
    "  # three", // 5
    "  # four", // 6
    "end", // 7
  ].join("\n");

  test("one blank line keeps the run open", () => {
    const blocks = flaggedBlocks(para, rb, ["# three"]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.start).toBe(2);
    expect(blocks[0]!.lines).toEqual([
      "# one",
      "# two",
      "",
      "# three",
      "# four",
    ]);
    expect(blocks[0]!.added).toEqual([false, false, false, true, false]);
  });

  test("two blanks read as a separation", () => {
    const split = "def a\n  # one\n  # two\n\n\n  # three\n  # four\nend";
    expect(flaggedBlocks(split, rb, ["# three"])).toEqual([]);
  });

  test("the bridged blank does not count toward the threshold", () => {
    const thin = "def a\n  # one\n\n  # two\nend";
    expect(flaggedBlocks(thin, rb, ["# two"])).toEqual([]);
  });

  test("a blank with no comment behind it closes the run", () => {
    const trailing = "def a\n  # one\n  # two\n  # three\n\nend";
    const blocks = flaggedBlocks(trailing, rb, ["# three"]);
    expect(blocks[0]!.lines).toEqual(["# one", "# two", "# three"]);
  });

  test("code after the blank still closes the run", () => {
    const parted = "x = 0\n# one\n# two\n\ny = 1\n# three";
    expect(flaggedBlocks(parted, rb, ["# one", "# three"])).toEqual([]);
  });
});

describe("blanks inside a block comment", () => {
  test("an empty line inside a docblock still counts toward the height", () => {
    const doc = "const a = 1;\n/*\n\n*/\nconst b = 2;";
    const blocks = flaggedBlocks(doc, ts, new Set([2, 3, 4]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.height).toBe(3);
  });

  test("a bridged blank does not count toward the height", () => {
    const para = "def a\n  # one\n  # two\n\n  # three\nend";
    expect(flaggedBlocks(para, rb, ["# three"])[0]!.height).toBe(3);
  });

  test("line numbers bridge the same way text does", () => {
    const para = "def a\n  # one\n  # two\n\n  # three\nend";
    const blocks = flaggedBlocks(para, rb, new Set([5]));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.start).toBe(2);
    expect(blocks[0]!.added).toEqual([false, false, false, true]);
    expect(formatReason("a.rb", blocks)).toContain(
      "1 comment block(s), 3 lines",
    );
  });
});

describe("main", () => {
  const HOOK = new URL("./comment-guard.ts", import.meta.url).pathname;

  const run = async (payload: unknown, onDisk: string) => {
    const dir = `/tmp/cg-main-${Math.random().toString(36).slice(2)}`;
    const path = `${dir}/app.ts`;
    await Bun.write(path, onDisk);
    const json = JSON.stringify(payload).replaceAll("<FILE>", path);
    const proc = Bun.spawn(["bun", HOOK], {
      stdin: new TextEncoder().encode(json),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    await Bun.$`rm -rf ${dir}`.quiet();
    return { exitCode, stderr };
  };

  const BLOCKED = "const a = 1;\n// one\n// two\n// three\nconst b = 2;\n";

  test("a Write that changed nothing reports nothing", async () => {
    const out = await run(
      {
        tool_name: "Write",
        tool_input: { file_path: "<FILE>", content: BLOCKED },
        tool_response: { type: "update", structuredPatch: [] },
      },
      BLOCKED,
    );
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe("");
  });

  // Claude Code sends an empty patch for a create, so the whole file is new and
  // the text path is the only one that can answer.
  test("a Write that created the file reports through the text path", async () => {
    const out = await run(
      {
        tool_name: "Write",
        tool_input: { file_path: "<FILE>", content: BLOCKED },
        tool_response: { type: "create", structuredPatch: [] },
      },
      BLOCKED,
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("1 comment block(s), 3 lines");
  });

  test("a diff reports only the block it touched", async () => {
    const file =
      "const a = 1;\n// old one\n// old two\n// old three\nconst b = 2;\n" +
      "// new one\n// new two\n// new three\n";
    const out = await run(
      {
        tool_name: "Write",
        tool_input: { file_path: "<FILE>", content: file },
        tool_response: {
          type: "update",
          structuredPatch: [
            {
              newStart: 5,
              lines: [
                " const b = 2;",
                "+// new one",
                "+// new two",
                "+// new three",
              ],
            },
          ],
        },
      },
      file,
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("1 comment block(s), 3 lines");
    expect(out.stderr).toContain("+ 6  // new one");
    expect(out.stderr).not.toContain("old one");
  });

  test("no tool_response at all still reports, as on OpenCode", async () => {
    const out = await run(
      {
        tool_name: "Write",
        tool_input: { file_path: "<FILE>", content: BLOCKED },
      },
      BLOCKED,
    );
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("1 comment block(s), 3 lines");
  });
});

describe("formatReason", () => {
  test("marks the added lines and gives the block range", () => {
    const blocks = flaggedBlocks(
      "def a\n  # one\n  # two\n  # three\nend",
      rb,
      ["# three"],
    );
    expect(formatReason("a.rb", blocks)).toBe(
      "comment-guard: 1 comment block(s), 3 lines, in a.rb.\n" +
        "Answer for every line marked +: does it say why, or what? " +
        "Delete the ones that say what.\n" +
        "  a.rb:2-4\n" +
        "    2  # one\n" +
        "    3  # two\n" +
        "  + 4  # three",
    );
  });

  test("counts the lines of every block it reports", () => {
    const two = [
      "def a",
      "  # a one",
      "  # a two",
      "  # a three",
      "end",
      "def b",
      "  # b one",
      "  # b two",
      "  # b three",
      "  # b four",
      "end",
    ].join("\n");
    const out = formatReason(
      "a.rb",
      flaggedBlocks(two, rb, ["# a one", "# b four"]),
    );
    expect(out).toContain("2 comment block(s), 7 lines, in a.rb.");
    expect(out).toContain("  a.rb:2-4");
    expect(out).toContain("  a.rb:7-10");
  });
});
