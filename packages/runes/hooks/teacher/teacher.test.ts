import { expect, test } from "claude-code/testing";

import { changes, isWorthAsking, needsLesson, same, teacher, titleOf, TITLES, wrapWords } from "./teacher";

test("a short prompt, a slash command, a shell escape, or a wall of text is never asked about", () => {
  expect(isWorthAsking("fix it")).toBe(false);
  expect(isWorthAsking("/runes teacher off please now")).toBe(false);
  expect(isWorthAsking("! git status --short now")).toBe(false);
  expect(isWorthAsking("word ".repeat(400))).toBe(false);
  expect(isWorthAsking("can you checking why test is fail")).toBe(true);
});

test("a lesson needs both mostly English and worth improving", () => {
  expect(needsLesson({ english: 0.7, improve: 0.6 })).toBe(true);
  expect(needsLesson({ english: 0.69, improve: 0.9 })).toBe(false);
  expect(needsLesson({ english: 0.9, improve: 0.59 })).toBe(false);
});

test("a rewrite differing only in case, spacing, or end punctuation is the same prompt", () => {
  expect(same("Can you fix the test", "can you  fix the test.")).toBe(true);
  expect(same("can you checking the test", "Can you check the test?")).toBe(
    false,
  );
});

test("a flagged prompt gets the rewrite, the latest lesson clears on the next submit", async () => {
  const bodies: string[] = [];
  let redraws = 0;
  teacher.work({
    apiKey: "k",
    post: async (_url, init) => {
      bodies.push(init.body);
      return {
        ok: true,
        text: JSON.stringify({
          answers: { english: { noul: 0.95 }, improve: { noul: 0.9 } },
        }),
      };
    },
    complete: async () => "Can you check why the test is failing?",
    redraw: () => redraws++,
  });
  teacher.submit("can you checking why test is fail");
  for (let i = 0; i < 50 && !teacher.latest(); i++)
    await new Promise((r) => setTimeout(r, 1));
  expect(teacher.lesson("can you checking why test is fail")).toBe(
    "Can you check why the test is failing?",
  );
  expect(teacher.latest()?.better).toBe(
    "Can you check why the test is failing?",
  );
  expect(redraws).toBeGreaterThan(0);
  expect(bodies[0]).toContain("can you checking why test is fail");

  teacher.submit("ok");
  expect(teacher.latest()).toBe(undefined);
  expect(teacher.lesson("can you checking why test is fail")).toBe(
    "Can you check why the test is failing?",
  );
});

test("no key asks nothing", async () => {
  let posts = 0;
  teacher.work({
    apiKey: undefined,
    post: async () => (posts++, { ok: false, text: "" }),
    complete: async () => "x",
    redraw: () => {},
  });
  teacher.submit("could you making this more faster please");
  await new Promise((r) => setTimeout(r, 5));
  expect(posts).toBe(0);
  expect(teacher.lesson("could you making this more faster please")).toBe(
    undefined,
  );
});

test("changes marks the words the rewrite added or changed, keeping spaces and matching case-blind", () => {
  const runs = changes("can u checking why the test is fail", "Can you check why the test is failing?");
  expect(runs.filter((r) => r.isChanged).map((r) => r.text.trim())).toEqual(["you", "check", "failing?"]);
  expect(runs.map((r) => r.text).join("")).toBe("Can you check why the test is failing?");
});

test("titleOf picks one of the titles per prompt, the same one on every draw", () => {
  const seen = new Set(Array.from({ length: 200 }, (_, i) => titleOf(`prompt number ${i}`)));
  expect([...seen].every((t) => TITLES.includes(t))).toBe(true);
  expect(seen.size).toBe(TITLES.length);
  expect(titleOf("can u checking")).toBe(titleOf("can u checking"));
});

test("wrapWords breaks between words, starts a line at each newline, and splits only a word wider than the line", () => {
  const text = (lines: { text: string }[][]) => lines.map((l) => l.map((r) => r.text).join(""));
  expect(text(wrapWords([{ text: "put it on top and " }, { text: "remove", bold: true }, { text: " the icon" }], 16))).toEqual([
    "put it on top",
    "and remove the",
    "icon",
  ]);
  expect(text(wrapWords([{ text: "first line\n\nAnd then" }], 20))).toEqual(["first line", "", "And then"]);
  expect(text(wrapWords([{ text: "abcdefghij" }], 4))).toEqual(["abcd", "efgh", "ij"]);
});
