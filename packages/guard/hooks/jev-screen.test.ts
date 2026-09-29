import { describe, expect, test } from "bun:test";
import type { CommentBlock } from "./comment-guard.ts";
import { screenBlocks, screenNote } from "./jev-screen.ts";

const block = (
  start: number,
  lines: string[],
  added: boolean[],
): CommentBlock => ({
  start,
  lines,
  added,
  height: lines.length,
});

const WHY = block(1, ["// a", "// b", "// c"], [true, false, true]);
const WHAT = block(10, ["// x", "// y", "// z"], [false, true, false]);

type Sent = {
  state: { comment: { lines: string[] } };
  questions: Record<string, { instructions: string }>;
};

/** Answers every added line of a block with P(why) taken from `pWhy` by first line. */
function fakeJev(pWhy: Record<string, number>, sent: Sent[] = []) {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent;
    sent.push(body);
    const p = pWhy[body.state.comment.lines[0]!]!;
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((k) => [
        k,
        {
          type: "choice",
          choice: p >= 0.5 ? "why" : "what",
          probabilities: { why: p, what: 1 - p },
        },
      ]),
    );
    return new Response(JSON.stringify({ answers }));
  }) as unknown as typeof fetch;
}

describe("screenBlocks", () => {
  test("drops a block whose every added line is confidently why", async () => {
    const { kept } = await screenBlocks("a.ts", [WHY, WHAT], {
      apiKey: "k",
      fetch: fakeJev({ "// a": 0.93, "// x": 0.2 }),
    });
    expect(kept).toEqual([WHAT]);
  });

  test("keeps a block Jev leans why on but below the threshold", async () => {
    const { kept } = await screenBlocks("a.ts", [WHY], {
      apiKey: "k",
      fetch: fakeJev({ "// a": 0.79 }),
    });
    expect(kept).toEqual([WHY]);
  });

  test("asks one question per added line, naming its index", async () => {
    const sent: Sent[] = [];
    await screenBlocks("a.ts", [WHY], {
      apiKey: "k",
      fetch: fakeJev({ "// a": 0.9 }, sent),
    });
    const asked = Object.values(sent[0]!.questions).map((q) => q.instructions);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain("`comment.lines[0]`");
    expect(asked[1]).toContain("`comment.lines[2]`");
  });

  test("keeps every block without a key, and sends nothing", async () => {
    const sent: Sent[] = [];
    const { kept } = await screenBlocks("a.ts", [WHY], {
      apiKey: undefined,
      fetch: fakeJev({}, sent),
    });
    expect(kept).toEqual([WHY]);
    expect(sent).toHaveLength(0);
  });

  test("keeps every block when Jev fails", async () => {
    const failing = (async () =>
      new Response("", { status: 529 })) as unknown as typeof fetch;
    const { kept } = await screenBlocks("a.ts", [WHY, WHAT], {
      apiKey: "k",
      fetch: failing,
    });
    expect(kept).toEqual([WHY, WHAT]);
  });

  test("reports how many blocks it withdrew and how long Jev took", async () => {
    const screen = await screenBlocks("a.ts", [WHY, WHAT], {
      apiKey: "k",
      fetch: fakeJev({ "// a": 0.93, "// x": 0.2 }),
    });
    expect(screen.withdrawn).toBe(1);
    expect(screen.ms).toBeGreaterThanOrEqual(0);
    expect(screenNote("💬 comment-guard", { ...screen, ms: 231 })).toBe(
      "💬 comment-guard: Jev withdrew 1 of 2 comment block(s) as why (231 ms)",
    );
  });

  test("stays silent when it withdrew nothing", () => {
    expect(
      screenNote("💬 comment-guard", { kept: [WHY], withdrawn: 0, ms: 200 }),
    ).toBeNull();
  });
});
