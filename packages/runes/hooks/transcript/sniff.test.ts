import { expect, test } from "claude-code/testing";

import { language } from "./sniff";

test("output that parses as a JSON object or array is json", () => {
  expect(language("gh api repos/x", '{"a": 1}\n')).toBe("json");
  expect(language("jq .", "[1, 2]")).toBe("json");
  expect(language("echo", "{oops")).toBeUndefined();
  // a bare number parses as JSON but reads as plain text
  expect(language("wc -l < a", "42")).toBeUndefined();
});

test("output that opens like a unified diff is diff", () => {
  expect(language("git diff", "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b")).toBe(
    "diff",
  );
  expect(
    language("git show HEAD", "commit abc\n\ndiff --git a/x b/x"),
  ).toBeUndefined();
});

test("one file read by cat, head, tail or sed -n takes the file's language", () => {
  expect(language("cat hooks/bash.tsx", "x")).toBe("tsx");
  expect(language("head -20 src/app.rb", "x")).toBe("ruby");
  expect(language("sed -n '1,40p' lib/a.py", "x")).toBe("python");
  expect(language("tail -n 5 config.yaml", "x")).toBe("yaml");
  expect(language("cat README.md", "# hi")).toBe("markdown");
});

test("a pipeline, a chain, several files or an unknown extension stays plain", () => {
  expect(language("cat a.ts | head", "x")).toBeUndefined();
  expect(language("cd x && cat a.ts", "x")).toBeUndefined();
  expect(language("cat a.ts b.ts", "x")).toBeUndefined();
  expect(language("cat notes.txt", "x")).toBeUndefined();
  expect(language("ls -la", "total 3")).toBeUndefined();
});
