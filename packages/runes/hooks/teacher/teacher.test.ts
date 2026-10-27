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
import type { Attempt } from "./attempt";

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
    record: () => {},
  });
  teacher.submit("can you checking why test is fail", Promise.resolve("s1"));
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

  teacher.submit("ok", Promise.resolve("s1"));
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
    record: () => {},
  });
  teacher.submit("could you making this more faster please", Promise.resolve("s1"));
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
    record: () => {},
  });
  teacher.submit("please making this more faster", Promise.resolve("s1"));
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
    record: () => {},
  });
  teacher.submit(prompt, Promise.resolve("s1"));
  await settle();
  teacher.submit(prompt, Promise.resolve("s1"));
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
    record: () => {},
  });
  teacher.submit(prompt, Promise.resolve("s1"));
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
    record: () => {},
  };
  teacher.work(transport);
  teacher.submit(prompt, Promise.resolve("s1"));
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
    record: () => {},
  });
  let handler: any;
  const stub = { session: { id: () => Promise.resolve("s1") } };
  teach(((_name: string, _match: unknown, h: unknown) => (handler = h)) as any);
  const typed = "typed prompt which was changed below";
  const entered = "entered prompt after the lower hook";
  await handler(stub, { text: typed }, async () => ({ text: entered }));
  await settle();
  expect(bodies.length).toBe(1);
  expect(bodies[0]).toContain(entered);
  expect(bodies[0]).not.toContain(typed);

  await handler(
    stub,
    { text: "dropped prompt with enough words" },
    async () => ({ drop: true }),
  );
  await settle();
  expect(bodies.length).toBe(1);
});

type Seen = { a: Attempt; session: Promise<string | undefined> };
const scored = (answers: unknown) => async () => ({
  ok: true,
  text: JSON.stringify({ answers }),
});
const recording = (
  post: () => Promise<{ ok: boolean; text: string }>,
  complete: () => Promise<string | undefined>,
) => {
  const seen: Seen[] = [];
  teacher.work({
    apiKey: "k",
    post,
    complete,
    redraw: () => {},
    record: (a, session) => seen.push({ a, session }),
  });
  return seen;
};
const recorded = async (seen: Seen[]) => {
  for (let i = 0; i < 100 && seen.length === 0; i++)
    await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 20));
  expect(seen.length).toBe(1);
  return seen[0]!.a;
};
const both = scored({ english: { noul: 0.95 }, improve: { noul: 0.9 } });

test("a failed Jev call records jev-failed with no scores", async () => {
  const seen = recording(async () => ({ ok: false, text: "" }), async () => "x");
  teacher.submit("record the failing jev call please", Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("jev-failed");
  expect([a.english, a.improve, a.better, a.quip]).toEqual([null, null, null, null]);
});

test("a gated prompt records its scores and no rewrite", async () => {
  const seen = recording(
    scored({ english: { noul: 0.9 }, improve: { noul: 0.1 } }),
    async () => "x",
  );
  teacher.submit("thanks that works fine for me", Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("gated");
  expect([a.english, a.improve, a.better, a.quip]).toEqual([0.9, 0.1, null, null]);
});

test("a gated prompt with a missing answer records that score as null", async () => {
  const seen = recording(scored({ english: { noul: 0.9 } }), async () => "x");
  teacher.submit("a prompt missing the improve answer", Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("gated");
  expect(a.english).toBe(0.9);
  expect(a.improve).toBe(null);
});

test("no reply from the model records no-reply", async () => {
  const seen = recording(both, async () => undefined);
  teacher.submit("the model never answering this one", Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("no-reply");
  expect([a.english, a.improve, a.better, a.quip]).toEqual([0.95, 0.9, null, null]);
});

test("a model call that throws records no-reply", async () => {
  const seen = recording(both, async () => {
    throw new Error("down");
  });
  teacher.submit("the model throwing on this one", Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("no-reply");
  expect(a.better).toBe(null);
});

test("a reply with only a quip records empty", async () => {
  const seen = recording(both, async () => "<quip>x</quip>\n");
  teacher.submit("a reply holding only the quip", Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("empty");
  expect(a.better).toBe("");
  expect(a.quip).toBe("x");
});

test("a rewrite equal to the prompt records same", async () => {
  const seen = recording(both, async () => "A rewrite equal to the prompt.");
  teacher.submit("a rewrite equal to the prompt", Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("same");
  expect(a.better).toBe("A rewrite equal to the prompt.");
  expect(a.quip).toBe(null);
});

test("a reply holding a fence records not-rewrite", async () => {
  const seen = recording(both, async () => "<quip>Wow.</quip>\nSure:\n```ts\nfast()\n```");
  teacher.submit("please making this code more fast", Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("not-rewrite");
  expect(a.better).toBe("Sure:\n```ts\nfast()\n```");
  expect(a.quip).toBe("Wow.");
});

test("a shown lesson records the rewrite, the quip, the thresholds and the system prompt", async () => {
  const seen = recording(
    both,
    async () => "<quip>Checking? Bold tense.</quip>\nCan you check the logs first?",
  );
  teacher.submit("can you checking the logs first", Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("shown");
  expect([a.english, a.improve]).toEqual([0.95, 0.9]);
  expect(a.better).toBe("Can you check the logs first?");
  expect(a.quip).toBe("Checking? Bold tense.");
  expect(a.prompt).toBe("can you checking the logs first");
  expect(a.englishMin).toBe(0.7);
  expect(a.improveMin).toBe(0.6);
  expect(a.system.startsWith("You are Clawd")).toBe(true);
});

test("record receives the very session promise submit was given", async () => {
  const seen = recording(scored({ english: { noul: 0.1 } }), async () => "x");
  const p = Promise.resolve<string | undefined>("s9");
  teacher.submit("hand the session promise through", p);
  await recorded(seen);
  expect(seen[0]!.session).toBe(p);
});

test("a recorded prompt, rewrite and quip never hold a raw secret", async () => {
  const key = "sk-abcdefghijklmnopqrstuv";
  const seen = recording(both, async () => `<quip>${key} leaked</quip>\nPlease use ${key} here.`);
  teacher.submit(`please using ${key} here`, Promise.resolve("s1"));
  const a = await recorded(seen);
  expect(a.outcome).toBe("shown");
  for (const field of [a.prompt, a.better!, a.quip!]) {
    expect(field).not.toContain(key);
    expect(field).toContain("[key]");
  }
});

test("teach captures the session id once per submit, without waiting on it", async () => {
  const seen = recording(scored({ english: { noul: 0.1 } }), async () => "x");
  const pending: Array<(id: string) => void> = [];
  let calls = 0;
  const stub = {
    session: {
      id: () => (
        calls++,
        new Promise<string>((resolve) => pending.push(resolve))
      ),
    },
  };
  let handler: any;
  teach(((_name: string, _match: unknown, h: unknown) => (handler = h)) as any);
  const one = "the first prompt for session capture";
  const two = "the second prompt for session capture";
  await handler(stub, { text: one }, async () => ({ text: one }));
  await handler(stub, { text: two }, async () => ({ text: two }));
  expect(calls).toBe(2);
  for (let i = 0; i < 100 && seen.length < 2; i++)
    await new Promise((r) => setTimeout(r, 2));
  expect(seen.length).toBe(2);
  pending[0]!("s1");
  pending[1]!("s2");
  expect(await seen[0]!.session).toBe("s1");
  expect(await seen[1]!.session).toBe("s2");
});

test("a prompt rejected before Jev records nothing", async () => {
  const seen = recording(both, async () => "x");
  teacher.submit("fix it", Promise.resolve("s1"));
  await new Promise((r) => setTimeout(r, 20));
  expect(seen.length).toBe(0);
});

test("the same prompt submitted twice records once", async () => {
  const seen = recording(scored({ english: { noul: 0.1 } }), async () => "x");
  const prompt = "the same prompt submitted twice here";
  teacher.submit(prompt, Promise.resolve("s1"));
  await recorded(seen);
  teacher.submit(prompt, Promise.resolve("s1"));
  await new Promise((r) => setTimeout(r, 20));
  expect(seen.length).toBe(1);
});
