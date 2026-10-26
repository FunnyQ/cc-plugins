import { expect, test } from "claude-code/testing";

import { Director, mood, SPECIAL_STINT_TENTHS } from "./director";
import { CLIPS } from "./frames";

const idle = { blocked: 0, busy: 0, done: false, longestTurn: 0, idleFor: 0 };

test("mood ranks blocked over crowd over work", () => {
  expect(mood({ ...idle, blocked: 1, busy: 5 })).toBe("call");
  expect(mood({ ...idle, busy: 3 })).toBe("crowd");
  expect(mood({ ...idle, busy: 1, longestTurn: 300 })).toBe("hot");
  expect(mood({ ...idle, done: true })).toBe("celebrate");
});

test("a long idle yawns, collapses, sleeps, then wakes on work", () => {
  const d = new Director();
  const long = { ...idle, idleFor: 600 };
  expect(d.next(long, () => 0)).toBe("yawn");
  expect(d.next(long, () => 0)).toBe("collapse");
  expect(d.next(long, () => 0)).toBe("sleeping");
  expect(d.next({ ...idle, busy: 1 }, () => 0)).toBe("wake");
});

test("a click wakes a sleeping Clawd before it reacts", () => {
  const d = new Director();
  const long = { ...idle, idleFor: 600 };
  d.next(long, () => 0);
  d.next(long, () => 0);
  d.next(long, () => 0);
  d.react();
  expect(d.next(long, () => 0)).toBe("wake");
  expect(["annoyed", "panic", "dragged", "lookLeft", "lookRight"]).toContain(
    d.next(long, () => 0),
  );
});

const tenths = (clip: string) =>
  Math.round(CLIPS[clip]!.reduce((sum, f) => sum + f.ms, 0) / 100);
const runOf = (d: Director, inputs: typeof idle, random: () => number) => {
  const clip = d.next(inputs, random);
  let n = 1;
  while (d.next(inputs, random) === clip) n++;
  return { clip, n };
};

test("a base loops 20 to 40 s, hands over to a special that loops SPECIAL_STINT_TENTHS, then back to a base", () => {
  const work = { ...idle, busy: 1 };
  const low = new Director();
  const base = runOf(low, work, () => 0);
  expect(base).toEqual({
    clip: "crabWalking",
    n: Math.ceil(200 / tenths("crabWalking")),
  });
  const high = new Director();
  const longBase = runOf(high, work, () => 0.999);
  expect(longBase).toEqual({
    clip: "typing",
    n: Math.ceil(399 / tenths("typing")),
  });

  const d = new Director();
  let clip = d.next(work, () => 0);
  while (clip === "crabWalking") clip = d.next(work, () => 0);
  expect(clip).toBe("building");
  let n = 1;
  while ((clip = d.next(work, () => 0)) === "building") n++;
  expect(SPECIAL_STINT_TENTHS).toBe(80);
  expect(n).toBe(Math.ceil(80 / tenths("building")));
  expect(clip).toBe("crabWalking");
});

test("a special the mood no longer has hands back to a base", () => {
  const work = { ...idle, busy: 1 };
  const d = new Director();
  let clip = d.next(work, () => 0);
  while (clip === "crabWalking") clip = d.next(work, () => 0);
  expect(clip).toBe("building");
  expect(d.next(idle, () => 0)).toBe("follow");
});
