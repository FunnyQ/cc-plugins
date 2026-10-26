import { expect, test } from "claude-code/testing";

import {
  changes,
  isRewrite,
  isWorthAsking,
  keyOf,
  needsLesson,
  parseReply,
  same,
  teach,
  teacher,
  titleOf,
  TITLES,
} from "./teacher";
import { wrapWords } from "../transcript/text";

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
    complete: async () =>
      "<quip>Checking? Bold tense.</quip>\nCan you check why the test is failing?",
    redraw: () => redraws++,
  });
  teacher.submit("can you checking why test is fail");
  for (let i = 0; i < 50 && !teacher.latest(); i++)
    await new Promise((r) => setTimeout(r, 1));
  expect(teacher.lesson("can you checking why test is fail")).toBe(
    "Can you check why the test is failing?",
  );
  expect(teacher.latest()?.quip).toBe("Checking? Bold tense.");
  expect(teacher.latest()?.better).toBe(
    "Can you check why the test is failing?",
  );
  expect(teacher.title("can you checking why test is fail")).toBe(
    "Checking? Bold tense.",
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
  const runs = changes(
    "can u checking why the test is fail",
    "Can you check why the test is failing?",
  );
  expect(runs.filter((r) => r.isChanged).map((r) => r.text.trim())).toEqual([
    "you",
    "check",
    "failing?",
  ]);
  expect(runs.map((r) => r.text).join("")).toBe(
    "Can you check why the test is failing?",
  );
});

test("parseReply splits the quip off the rewrite, takes a reply without the quip tag as all rewrite, and drops an empty or too-long quip", () => {
  expect(
    parseReply(
      "<quip>“Fail” is a verb now?</quip>\nWhy is the test failing?\nFix it.",
    ),
  ).toEqual({
    better: "Why is the test failing?\nFix it.",
    quip: "“Fail” is a verb now?",
  });
  expect(parseReply("Why is the test failing?")).toEqual({
    better: "Why is the test failing?",
    quip: undefined,
  });
  expect(parseReply("<quip> </quip>\nWhy is it failing?").quip).toBe(undefined);
  expect(
    parseReply(`<quip>${"so ".repeat(20)}</quip>\nWhy is it failing?`),
  ).toEqual({
    better: "Why is it failing?",
    quip: undefined,
  });
});

test("a lesson without a quip falls back to a stock title", async () => {
  teacher.work({
    apiKey: "k",
    post: async () => ({
      ok: true,
      text: JSON.stringify({
        answers: { english: { noul: 0.95 }, improve: { noul: 0.9 } },
      }),
    }),
    complete: async () => "Please make this faster.",
    redraw: () => {},
  });
  teacher.submit("please making this more faster");
  for (let i = 0; i < 50 && !teacher.latest(); i++)
    await new Promise((r) => setTimeout(r, 1));
  expect(teacher.lesson("please making this more faster")).toBe(
    "Please make this faster.",
  );
  expect(teacher.title("please making this more faster")).toBe(
    titleOf("please making this more faster"),
  );
});

test("titleOf picks one of the titles per prompt, the same one on every draw", () => {
  const seen = new Set(
    Array.from({ length: 200 }, (_, i) => titleOf(`prompt number ${i}`)),
  );
  expect([...seen].every((t) => TITLES.includes(t))).toBe(true);
  expect(seen.size).toBe(TITLES.length);
  expect(titleOf("can u checking")).toBe(titleOf("can u checking"));
});

test("isRewrite rejects a reply far longer than the prompt or holding a fence, which answers the prompt instead of correcting it", () => {
  expect(
    isRewrite("Please make this faster.", "please making this more faster"),
  ).toBe(true);
  expect(isRewrite("x".repeat(200), "make it fast")).toBe(false);
  expect(isRewrite("Sure:\n```ts\nfast()\n```", "make it fast")).toBe(false);
});

test("keyOf strips system-reminder blocks, so a row's text and the submitted text share a key", () => {
  expect(keyOf("fix the bug\n<system-reminder>\nctx\n</system-reminder>")).toBe(
    keyOf("fix the bug"),
  );
});

test("wrapWords breaks between words, starts a line at each newline, and splits only a word wider than the line", () => {
  const text = (lines: { text: string }[][]) =>
    lines.map((l) => l.map((r) => r.text).join(""));
  expect(
    text(
      wrapWords(
        [
          { text: "put it on top and " },
          { text: "remove", bold: true },
          { text: " the icon" },
        ],
        16,
      ),
    ),
  ).toEqual(["put it on top", "and remove the", "icon"]);
  expect(text(wrapWords([{ text: "first line\n\nAnd then" }], 20))).toEqual([
    "first line",
    "",
    "And then",
  ]);
  expect(text(wrapWords([{ text: "abcdefghij" }], 4))).toEqual([
    "abcd",
    "efgh",
    "ij",
  ]);
});

const flagged = (text: string) =>
  JSON.stringify({
    answers: { english: { noul: 0.95 }, improve: { noul: 0.9 } },
  });
const settle = () => new Promise((r) => setTimeout(r, 10));

test("a prompt that was fine as written is never sent again", async () => {
  let posts = 0;
  let completes = 0;
  const prompt = "this prompt is already written fine";
  teacher.work({
    apiKey: "k",
    post: async () => (posts++, { ok: true, text: flagged(prompt) }),
    complete: async () => (completes++, prompt),
    redraw: () => {},
  });
  teacher.submit(prompt);
  await settle();
  teacher.submit(prompt);
  await settle();
  expect(posts).toBe(1);
  expect(completes).toBe(1);
});

test("two identical prompts share a lesson and the latest requestId wins", async () => {
  const prompt = "please making rows with the same text";
  teacher.work({
    apiKey: "k",
    post: async () => ({ ok: true, text: flagged(prompt) }),
    complete: async () => "Please make rows with the same text.",
    redraw: () => {},
  });
  teacher.submit(prompt);
  for (let i = 0; i < 50 && !teacher.latest(); i++) await settle();
  teacher.seen(prompt, "first");
  teacher.seen(prompt, "second");
  expect(teacher.latest()?.requestId).toBe("second");
});

test("work called again leaves no latest lesson, though the lesson itself stays", async () => {
  const prompt = "please making the latest go away";
  const transport = {
    apiKey: "k",
    post: async () => ({ ok: true, text: flagged(prompt) }),
    complete: async () => "Please make the latest go away.",
    redraw: () => {},
  };
  teacher.work(transport);
  teacher.submit(prompt);
  for (let i = 0; i < 50 && !teacher.latest(); i++) await settle();
  expect(teacher.latest()).not.toBe(undefined);
  teacher.work(transport);
  expect(teacher.latest()).toBe(undefined);
  expect(teacher.lesson(prompt)).toBe("Please make the latest go away.");
});

test("teach keys the lesson on the prompt that entered, not the one typed", async () => {
  const bodies: string[] = [];
  teacher.work({
    apiKey: "k",
    post: async (_url, init) => (
      bodies.push(init.body),
      { ok: true, text: flagged("") }
    ),
    complete: async () => "Rewritten by the teacher.",
    redraw: () => {},
  });
  let handler: any;
  teach(((_name: string, _match: unknown, h: unknown) => (handler = h)) as any);
  const typed = "typed prompt which was changed below";
  const entered = "entered prompt after the lower hook";
  await handler(undefined, { text: typed }, async () => ({ text: entered }));
  await settle();
  expect(bodies.length).toBe(1);
  expect(bodies[0]).toContain(entered);
  expect(bodies[0]).not.toContain(typed);

  await handler(
    undefined,
    { text: "dropped prompt with enough words" },
    async () => ({ drop: true }),
  );
  await settle();
  expect(bodies.length).toBe(1);
});
