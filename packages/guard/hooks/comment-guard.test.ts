import { describe, expect, test } from "bun:test";
import {
  addedCommentLines,
  formatReason,
  lineIndex,
  markersFor,
} from "./comment-guard.ts";

describe("markersFor", () => {
  test("maps each family to its markers", () => {
    expect(markersFor("a/user.rb")).toEqual(["#"]);
    expect(markersFor("a/app.ts")).toEqual(["//", "/*"]);
    expect(markersFor("a/q.sql")).toEqual(["--"]);
    expect(markersFor("a/page.html")).toEqual(["<!--"]);
  });

  test("skips prose, unknown extensions, and /docs/", () => {
    expect(markersFor("a/README.md")).toEqual([]);
    expect(markersFor("a/data.json")).toEqual([]);
    expect(markersFor("a/notes.txt")).toEqual([]);
    expect(markersFor("a/data.cfg")).toEqual([]);
    expect(markersFor("repo/docs/gen.py")).toEqual([]);
  });

  test("ignores a dot in a directory name", () => {
    expect(markersFor("/a.b/Makefile")).toEqual([]);
  });
});

describe("addedCommentLines", () => {
  const rb = ["#"];

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
    const ts = ["//", "/*"];
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
});

describe("formatReason", () => {
  test("numbers each hit from the file on disk", () => {
    const index = lineIndex("# one\nx = 1\n# two\n");
    expect(formatReason("a.rb", ["# one", "# two"], index)).toBe(
      "本次新增 2 行註解，逐行回答：這行說的是 why 還是 what？是 what 就刪掉。\n" +
        "  a.rb:1  # one\n" +
        "  a.rb:3  # two",
    );
  });

  test("repeated text claims distinct line numbers", () => {
    const index = lineIndex("-- pick\nSELECT 1;\n-- pick\nSELECT 2;\n");
    const out = formatReason("q.sql", ["-- pick", "-- pick"], index);
    expect(out).toContain("  q.sql:1  -- pick");
    expect(out).toContain("  q.sql:3  -- pick");
  });

  test("a line absent from disk reports ?", () => {
    expect(formatReason("a.rb", ["# gone"], lineIndex(""))).toContain(
      "  a.rb:?  # gone",
    );
  });
});
