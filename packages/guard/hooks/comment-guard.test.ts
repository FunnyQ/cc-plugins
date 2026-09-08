import { describe, expect, test } from "bun:test";
import {
  addedCommentLines,
  commentFlags,
  flaggedBlocks,
  formatReason,
  syntaxFor,
} from "./comment-guard.ts";
import type { Syntax } from "./comment-guard.ts";

const rb = syntaxFor("a/user.rb")!;
const ts = syntaxFor("a/app.ts")!;

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

  test.each([
    "a/main.rs",
    "a/lib.cpp",
    "a/lib.hpp",
    "a/A.cs",
    "a/a.mjs",
    "a/a.cts",
    "a/v.erb",
    "a/a.php",
    "a/a.swift",
    "a/A.kt",
    "a/a.dart",
    "a/a.ex",
    "a/a.hs",
    "a/a.zsh",
    "a/main.tf",
    "a/s.less",
    "a/i.svg",
  ])("covers %s", (path) => {
    expect(syntaxFor(path)).not.toBeNull();
  });

  test.each([
    "a/Rakefile",
    "a/Gemfile",
    "a/Makefile",
    "a/Dockerfile",
    "a/Dockerfile.dev",
  ])("matches %s on its name, not an extension", (path) => {
    expect(syntaxFor(path)).toEqual({ line: ["#"], block: [] });
  });

  test("skips prose, unknown extensions, and /docs/", () => {
    expect(syntaxFor("a/README.md")).toBeNull();
    expect(syntaxFor("a/data.json")).toBeNull();
    expect(syntaxFor("a/notes.txt")).toBeNull();
    expect(syntaxFor("a/data.cfg")).toBeNull();
    expect(syntaxFor("repo/docs/gen.py")).toBeNull();
  });

  test("ignores a dot in a directory name", () => {
    expect(syntaxFor("/a.b/LICENSE")).toBeNull();
    expect(syntaxFor("/a.b/Makefile")).not.toBeNull();
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
    const html = syntaxFor("a/page.html")!;
    expect(
      flagsOf("<p>x</p>\n<!--\n  one\n  two\n-->\n<p>y</p>", html),
    ).toEqual([false, true, true, true, true, false]);
  });

  test("a Lua long comment counts its full height", () => {
    const lua = syntaxFor("a/a.lua")!;
    expect(
      flagsOf("local a = 1\n--[[\n  one\n  two\n]]\nlocal b = 2", lua),
    ).toEqual([false, true, true, true, true, false]);
  });

  test("a Lua line comment does not open a long comment", () => {
    const lua = syntaxFor("a/a.lua")!;
    expect(flagsOf("-- why\nlocal a = 1", lua)).toEqual([true, false]);
  });

  test("a one-line HTML comment does not open a run", () => {
    const html = syntaxFor("a/page.html")!;
    expect(flagsOf("<!-- why -->\n<p>x</p>", html)).toEqual([true, false]);
  });

  test("a Rust doc comment run counts every line", () => {
    const rs = syntaxFor("a/main.rs")!;
    expect(flagsOf("fn a() {}\n/// one\n//! two\nfn b() {}", rs)).toEqual([
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
